import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import {
  claimTrustedCompilerReadLauncherSession,
  getTrustedCompilerRunBinding,
  type TrustedCompilerRunSession,
} from './trusted-compiler-execution.js'
import {
  runReadOnlyCase,
  type BrowserPageAdapter,
  type ReadOnlyCaseResult,
  type RunReadOnlyCaseInput,
} from './read-only-runner.js'
import {
  registerTrustedCompilerControlledReadBridge,
  type TrustedCompilerControlledReadBridgeHandle,
} from './trusted-read-bridge-capability.js'

const MAX_REQUEST_BYTES = 32 * 1024

export interface ControlledReadBridgeRequest {
  actionId: string
  target: string
  expected: string
}

export interface ControlledReadCaseConfiguration {
  action: ControlledReadBridgeRequest
  runnerInput: RunReadOnlyCaseInput
}

export interface ControlledReadExecution {
  request: ControlledReadBridgeRequest
  result: ReadOnlyCaseResult
  evidence: { screenshot: Uint8Array; dom: Uint8Array }
}

export interface ControlledReadBridgeSnapshot {
  plannedActionIds: string[]
  executions: ControlledReadExecution[]
  complete: boolean
  halt?: {
    status: 'input-blocked' | 'environment-blocked' | 'safety-blocked'
    actionId: string
    reasonCode: string
  }
}

export type ControlledReadLauncher = (request: ControlledReadBridgeRequest) => Promise<ControlledReadExecution>

const launchers = new WeakMap<ControlledReadLauncher, TrustedCompilerRunSession>()

export function createTrustedCompilerControlledReadLauncher(
  configurations: ControlledReadCaseConfiguration[],
  session: TrustedCompilerRunSession,
): ControlledReadLauncher {
  const binding = getTrustedCompilerRunBinding(session)
  if (!binding || binding.executionProfile !== 'trusted-read-only') {
    throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_COMPILER_SESSION_REQUIRED')
  }
  if (!claimTrustedCompilerReadLauncherSession(session)) {
    throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_COMPILER_SESSION_ALREADY_CLAIMED')
  }
  const byActionId = new Map<string, ControlledReadCaseConfiguration>()
  for (const configuration of configurations) {
    validateRequest(configuration.action)
    const caseBinding = binding.caseActions.find((item) => item.caseId === configuration.runnerInput.caseId)
    if (!caseBinding?.actionIds.includes(configuration.action.actionId)
      || configuration.runnerInput.actionId !== configuration.action.actionId
      || configuration.runnerInput.expectedText !== configuration.action.expected
      || byActionId.has(configuration.action.actionId)) {
      throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_COMPILER_BINDING_MISMATCH')
    }
    byActionId.set(configuration.action.actionId, configuration)
  }
  if (byActionId.size === 0) throw readBridgeError('E2E_CONTROLLED_READ_ACTIONS_EMPTY')
  if (canonicalizeJson([...byActionId.keys()].sort()) !== canonicalizeJson(binding.actionIds)
    || canonicalizeJson([...new Set([...byActionId.values()].map((item) => item.runnerInput.caseId))].sort())
      !== canonicalizeJson(binding.caseIds)) {
    throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_COMPILER_BINDING_MISMATCH')
  }
  const launcher: ControlledReadLauncher = async (request) => {
    const configuration = byActionId.get(request.actionId)
    if (!configuration || canonicalizeJson(request) !== canonicalizeJson(configuration.action)) {
      throw readBridgeError('E2E_CONTROLLED_READ_ACTION_BINDING_MISMATCH')
    }
    const capture = new ReadEvidenceCapture(configuration.runnerInput.page)
    const result = await runReadOnlyCase({ ...configuration.runnerInput, page: capture })
    const evidence = result.status === 'input-blocked' || result.status === 'environment-blocked'
      || result.status === 'safety-blocked'
      ? capture.takeAvailable()
      : capture.take()
    return { request: structuredClone(request), result, evidence }
  }
  launchers.set(launcher, session)
  return launcher
}

export async function startTrustedCompilerControlledReadBridge(input: {
  session: TrustedCompilerRunSession
  actions: ControlledReadBridgeRequest[]
  launch: ControlledReadLauncher
}): Promise<TrustedCompilerControlledReadBridgeHandle> {
  if (launchers.get(input.launch) !== input.session) {
    throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_LAUNCHER_BINDING_REQUIRED')
  }
  const sessionBinding = getTrustedCompilerRunBinding(input.session)
  if (!sessionBinding) throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_COMPILER_SESSION_REQUIRED')
  const actions = new Map<string, ControlledReadBridgeRequest>()
  for (const action of input.actions) {
    validateRequest(action)
    if (actions.has(action.actionId)) throw readBridgeError('E2E_CONTROLLED_READ_ACTION_DUPLICATE')
    actions.set(action.actionId, structuredClone(action))
  }
  if (actions.size === 0) throw readBridgeError('E2E_CONTROLLED_READ_ACTIONS_EMPTY')
  if (canonicalizeJson([...actions.keys()].sort()) !== canonicalizeJson(sessionBinding.actionIds)) {
    throw readBridgeError('E2E_CONTROLLED_READ_TRUSTED_COMPILER_BINDING_MISMATCH')
  }
  const runGate = randomBytes(32).toString('base64url')
  const consumed = new Set<string>()
  const capturedExecutions = new Map<string, ControlledReadExecution>()
  let halt: ControlledReadBridgeSnapshot['halt']
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      if (!isLoopback(request.socket.remoteAddress)) throw httpError(403, 'E2E_CONTROLLED_READ_REMOTE_DENIED')
      if (request.method !== 'POST' || request.url !== '/v1/read-assertion') {
        throw httpError(404, 'E2E_CONTROLLED_READ_ROUTE_NOT_FOUND')
      }
      if (request.headers.authorization !== `Bearer ${runGate}`) {
        throw httpError(401, 'E2E_CONTROLLED_READ_RUN_GATE_INVALID')
      }
      const body = await readJsonBody(request)
      validateRequest(body)
      if (halt) throw httpError(409, 'E2E_CONTROLLED_READ_RUN_HALTED')
      const expected = actions.get(body.actionId)
      if (!expected || canonicalizeJson(body) !== canonicalizeJson(expected)) {
        throw httpError(409, 'E2E_CONTROLLED_READ_ACTION_BINDING_MISMATCH')
      }
      if (consumed.has(body.actionId)) throw httpError(409, 'E2E_CONTROLLED_READ_RUN_GATE_CONSUMED')
      consumed.add(body.actionId)
      const execution = await input.launch(body)
      if (execution.result.actionId !== body.actionId
        || canonicalizeJson(execution.request) !== canonicalizeJson(body)) {
        throw httpError(500, 'E2E_CONTROLLED_READ_RESULT_BINDING_INVALID')
      }
      capturedExecutions.set(body.actionId, immutableExecution(execution))
      if (execution.result.status === 'input-blocked' || execution.result.status === 'environment-blocked'
        || execution.result.status === 'safety-blocked') {
        halt = {
          status: execution.result.status,
          actionId: body.actionId,
          reasonCode: execution.result.reasonCode ?? 'E2E_RUNTIME_REASON_UNKNOWN',
        }
      }
      response.statusCode = 200
      response.end(JSON.stringify({ status: execution.result.status, reasonCode: execution.result.reasonCode }))
    } catch (error) {
      response.statusCode = statusOf(error)
      response.end(JSON.stringify({ code: codeOf(error) }))
    }
  })
  await listenLoopback(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw readBridgeError('E2E_CONTROLLED_READ_BRIDGE_ADDRESS_INVALID')
  }
  const endpoint = `http://127.0.0.1:${address.port}/v1/read-assertion`
  const handle = Object.freeze({
    close: () => closeServer(server),
    snapshot: () => immutableSnapshot(actions, capturedExecutions, halt),
    executions: () => {
      if (capturedExecutions.size !== actions.size) {
        throw readBridgeError('E2E_CONTROLLED_READ_RESULTS_INCOMPLETE')
      }
      return [...actions.keys()].map((actionId) => immutableExecution(capturedExecutions.get(actionId)!))
    },
  })
  registerTrustedCompilerControlledReadBridge(handle, { session: input.session, endpoint, runGate })
  return handle
}

function immutableSnapshot(
  actions: Map<string, ControlledReadBridgeRequest>,
  capturedExecutions: Map<string, ControlledReadExecution>,
  halt: ControlledReadBridgeSnapshot['halt'],
): ControlledReadBridgeSnapshot {
  return {
    plannedActionIds: [...actions.keys()],
    executions: [...actions.keys()].flatMap((actionId) => {
      const execution = capturedExecutions.get(actionId)
      return execution ? [immutableExecution(execution)] : []
    }),
    complete: capturedExecutions.size === actions.size,
    ...(halt ? { halt: structuredClone(halt) } : {}),
  }
}

class ReadEvidenceCapture implements BrowserPageAdapter {
  #screenshot?: Uint8Array
  #dom?: Uint8Array

  constructor(private readonly page: BrowserPageAdapter) {}

  goto(url: string): Promise<void> { return this.page.goto(url) }
  identity() { return this.page.identity() }
  containsText(text: string): Promise<boolean> { return this.page.containsText(text) }
  async screenshot(): Promise<Uint8Array> {
    const bytes = await this.page.screenshot()
    this.#screenshot = Uint8Array.from(bytes)
    return Uint8Array.from(bytes)
  }
  async domSnapshot(): Promise<string> {
    const value = await this.page.domSnapshot()
    this.#dom = Uint8Array.from(Buffer.from(value, 'utf8'))
    return value
  }
  take(): { screenshot: Uint8Array; dom: Uint8Array } {
    if (!this.#screenshot || !this.#dom) throw readBridgeError('E2E_CONTROLLED_READ_EVIDENCE_INCOMPLETE')
    return { screenshot: Uint8Array.from(this.#screenshot), dom: Uint8Array.from(this.#dom) }
  }

  takeAvailable(): { screenshot: Uint8Array; dom: Uint8Array } {
    return {
      screenshot: this.#screenshot ? Uint8Array.from(this.#screenshot) : new Uint8Array(),
      dom: this.#dom ? Uint8Array.from(this.#dom) : new Uint8Array(),
    }
  }
}

function immutableExecution(execution: ControlledReadExecution): ControlledReadExecution {
  return {
    request: structuredClone(execution.request),
    result: structuredClone(execution.result),
    evidence: {
      screenshot: Uint8Array.from(execution.evidence.screenshot),
      dom: Uint8Array.from(execution.evidence.dom),
    },
  }
}

function validateRequest(value: unknown): asserts value is ControlledReadBridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== ['actionId', 'expected', 'target'].join('\0')) {
    throw readBridgeError('E2E_CONTROLLED_READ_ACTION_INVALID')
  }
  const request = value as Record<string, unknown>
  if (![request.actionId, request.target, request.expected]
    .every((item) => typeof item === 'string' && item.length > 0 && item.length <= 16 * 1024)) {
    throw readBridgeError('E2E_CONTROLLED_READ_ACTION_INVALID')
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw httpError(413, 'E2E_CONTROLLED_READ_BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch {
    throw httpError(400, 'E2E_CONTROLLED_READ_BODY_INVALID')
  }
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function isLoopback(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function httpError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(code), { status, code })
}

function statusOf(error: unknown): number {
  return typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status : 500
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : error instanceof Error ? error.message : 'E2E_CONTROLLED_READ_INTERNAL'
}

function readBridgeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
