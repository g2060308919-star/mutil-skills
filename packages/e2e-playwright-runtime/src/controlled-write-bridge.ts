import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  ExecutionOutcomeReceiptSchema,
  ExecutionOutcomeVerifierMaterialSchema,
  canonicalizeJson,
  digestText,
  type ExecutionOutcomeReceipt,
  type ExecutionOutcomeVerifierMaterial,
} from '@mutil-skills/e2e-contracts'
import type { ReversibleWriteCompilerAction } from '@mutil-skills/e2e-contracts'
import { getTrustedExecutionClientBinding } from '@mutil-skills/e2e-authority'
import type { CleanupExecutionResult, LocalCleanupPlanRegistry } from './cleanup-plan-registry.js'
import { getWriteRuntimeSessionBinding } from './production-isolation.js'
import {
  claimTrustedCompilerWriteLauncherSession,
  getTrustedCompilerRunBinding,
  type TrustedCompilerRunSession,
} from './trusted-compiler-execution.js'
import {
  runReversibleWriteCase,
  type ReversibleWriteCaseResult,
  type RunReversibleWriteCaseInput,
} from './write-runner.js'
import {
  registerTrustedCompilerControlledWriteBridge,
  type TrustedCompilerControlledWriteBridgeHandle,
} from './trusted-write-bridge-capability.js'
export type { TrustedCompilerControlledWriteBridgeHandle } from './trusted-write-bridge-capability.js'

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const MAX_REQUEST_BYTES = 32 * 1024

export interface ControlledWriteBridgeRequest extends Omit<ReversibleWriteCompilerAction, 'kind'> {}

export interface ControlledWriteBridgeProof {
  status: 'passed'
  effectObservation: 'applied'
  cleanupStatus: 'verified-clean'
  authorityReceiptDigest: string
  leaseReceiptDigest: string
  gatewayAuditDigest: string
  evidenceIds: string[]
  executionOutcomeReceipt: ExecutionOutcomeReceipt
}

export type ExecutionOutcomeReceiptVerifier = (candidate: unknown) => boolean

export interface ControlledWriteLifecycle {
  finalizeExecution(input: {
    result: ReversibleWriteCaseResult
    outcomeDigest: string
    cleanup: { status: 'verified-clean' | 'failed' | 'unknown'; leaseReceiptDigest: string }
  }): Promise<{
    executionOutcomeReceipt: ExecutionOutcomeReceipt
    gatewayAuditDigest: string
  }>
}

export interface ControlledWriteCaseConfiguration {
  action: ControlledWriteBridgeRequest
  cleanupPlanDigest: string
  runnerInput: RunReversibleWriteCaseInput
  lifecycle: ControlledWriteLifecycle
}

export type ControlledWriteLauncher = (
  request: ControlledWriteBridgeRequest,
) => Promise<ControlledWriteBridgeProof>

const trustedCompilerLaunchers = new WeakMap<ControlledWriteLauncher, TrustedCompilerRunSession>()

export function createControlledWriteLauncher(
  configurations: ControlledWriteCaseConfiguration[],
  cleanupPlans: LocalCleanupPlanRegistry,
): ControlledWriteLauncher {
  const byActionId = new Map<string, ControlledWriteCaseConfiguration>()
  for (const configuration of configurations) {
    validateConfiguration(configuration, cleanupPlans)
    if (byActionId.has(configuration.action.actionId)) {
      throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTION_DUPLICATE')
    }
    byActionId.set(configuration.action.actionId, configuration)
  }
  if (byActionId.size === 0) throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTIONS_EMPTY')

  return async (request) => {
    const configuration = byActionId.get(request.actionId)
    if (!configuration || canonicalizeJson(request) !== canonicalizeJson(configuration.action)) {
      throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTION_BINDING_MISMATCH')
    }

    const result = await runReversibleWriteCase(configuration.runnerInput)
    const outcomeDigest = digestText('controlled-reversible-write-outcome/v1', canonicalizeJson(result))
    let cleanup: CleanupExecutionResult
    let cleanupFailure: unknown
    try {
      cleanup = await cleanupPlans.execute({
        cleanupPlanId: configuration.action.cleanupPlanId,
        cleanupPlanDigest: configuration.cleanupPlanDigest,
        actionId: configuration.action.actionId,
        leaseId: configuration.action.dataLeaseId,
        execution: { result, outcomeDigest },
      })
    } catch (error) {
      cleanupFailure = error
      cleanup = { status: 'unknown',
        resultDigest: digestText('controlled-write-cleanup-failure-result/v1', errorCode(error)),
        leaseReceiptDigest: digestText('controlled-write-cleanup-failure/v1', errorCode(error)) }
    }
    const finalized = await configuration.lifecycle.finalizeExecution({ result, outcomeDigest, cleanup })
    if (cleanupFailure !== undefined) throw controlledWriteError('E2E_CONTROLLED_WRITE_CLEANUP_FAILED')

    if (result.status !== 'passed' || result.effectObservation !== 'applied') {
      throw controlledWriteError(`E2E_CONTROLLED_WRITE_CASE_NOT_PASSED:${result.reasonCode ?? result.status}`)
    }
    if (cleanup.status !== 'verified-clean') {
      throw controlledWriteError(`E2E_CONTROLLED_WRITE_CLEANUP_NOT_VERIFIED:${cleanup.status}`)
    }
    const proof = {
      status: 'passed' as const,
      effectObservation: 'applied' as const,
      cleanupStatus: 'verified-clean' as const,
      authorityReceiptDigest: finalized.executionOutcomeReceipt.signedDigest,
      leaseReceiptDigest: cleanup.leaseReceiptDigest,
      gatewayAuditDigest: finalized.gatewayAuditDigest,
      evidenceIds: [...finalized.executionOutcomeReceipt.evidenceIds],
      executionOutcomeReceipt: finalized.executionOutcomeReceipt,
    }
    validateProofShape(proof)
    validateProofBindings(proof, request, outcomeDigest, cleanup, configuration.cleanupPlanDigest)
    return proof
  }
}

/**
 * 生产入口只接受签名隔离证明创建的运行会话，以及绑定同一 Authority 公钥的 RPC 客户端。
 * 测试专用 session 即使其健康字段为 true，也不能进入此入口。
 */
export function createProductionControlledWriteLauncher(
  configurations: ControlledWriteCaseConfiguration[],
  cleanupPlans: LocalCleanupPlanRegistry,
): ControlledWriteLauncher {
  for (const configuration of configurations) {
    const runtime = getWriteRuntimeSessionBinding(configuration.runnerInput.runtime)
    const approval = getTrustedExecutionClientBinding(configuration.runnerInput.authorization.authority)
    const lease = getTrustedExecutionClientBinding(configuration.runnerInput.lease.authority)
    if (runtime?.mode !== 'production-isolated' || runtime.authorityTransport !== 'authenticated-rpc'
      || approval?.transport !== 'authenticated-rpc' || lease?.transport !== 'authenticated-rpc'
      || approval.authorityPublicKeyDigest !== runtime.authorityRpcPublicKeyDigest
      || lease.authorityPublicKeyDigest !== runtime.authorityRpcPublicKeyDigest) {
      throw controlledWriteError('E2E_CONTROLLED_WRITE_PRODUCTION_ISOLATION_REQUIRED')
    }
  }
  return createControlledWriteLauncher(configurations, cleanupPlans)
}

/** 可信编译 Profile：要求执行前 Source Set 复验会话，不要求 production isolation attestation。 */
export function createTrustedCompilerControlledWriteLauncher(
  configurations: ControlledWriteCaseConfiguration[],
  cleanupPlans: LocalCleanupPlanRegistry,
  session: TrustedCompilerRunSession,
): ControlledWriteLauncher {
  const binding = getTrustedCompilerRunBinding(session)
  if (!binding || binding.executionProfile !== 'trusted-reversible-write') {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_TRUSTED_COMPILER_SESSION_REQUIRED')
  }
  if (!claimTrustedCompilerWriteLauncherSession(session)) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_TRUSTED_COMPILER_SESSION_ALREADY_CLAIMED')
  }
  for (const configuration of configurations) {
    if (configuration.runnerInput.runtime !== session
      || !binding.caseIds.includes(configuration.runnerInput.caseId)
      || !binding.actionIds.includes(configuration.action.actionId)
      || configuration.runnerInput.actionId !== configuration.action.actionId) {
      throw controlledWriteError('E2E_CONTROLLED_WRITE_TRUSTED_COMPILER_BINDING_MISMATCH')
    }
  }
  const launcher = createControlledWriteLauncher(configurations, cleanupPlans)
  trustedCompilerLaunchers.set(launcher, session)
  return launcher
}

export interface ControlledWriteBridgeHandle {
  endpoint: string
  runGate: string
  close(): Promise<void>
}

export async function startTrustedCompilerControlledWriteBridge(input: {
  session: TrustedCompilerRunSession
  actions: ControlledWriteBridgeRequest[]
  launch: ControlledWriteLauncher
  verifyExecutionOutcomeReceipt: ExecutionOutcomeReceiptVerifier
  executionOutcomeVerifierMaterial: ExecutionOutcomeVerifierMaterial
}): Promise<TrustedCompilerControlledWriteBridgeHandle> {
  if (trustedCompilerLaunchers.get(input.launch) !== input.session) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_TRUSTED_LAUNCHER_BINDING_REQUIRED')
  }
  const material = ExecutionOutcomeVerifierMaterialSchema.parse(input.executionOutcomeVerifierMaterial)
  const raw = await startControlledWriteBridge(input)
  const handle = Object.freeze({ close: () => raw.close() })
  registerTrustedCompilerControlledWriteBridge(handle, {
    session: input.session, endpoint: raw.endpoint, runGate: raw.runGate,
    executionOutcomeVerifierMaterial: structuredClone(material),
  })
  return handle
}

export async function startControlledWriteBridge(input: {
  actions: ControlledWriteBridgeRequest[]
  launch: ControlledWriteLauncher
  verifyExecutionOutcomeReceipt: ExecutionOutcomeReceiptVerifier
}): Promise<ControlledWriteBridgeHandle> {
  const actions = new Map<string, ControlledWriteBridgeRequest>()
  for (const action of input.actions) {
    validateAction(action)
    if (actions.has(action.actionId)) throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTION_DUPLICATE')
    actions.set(action.actionId, immutableSnapshot(action))
  }
  if (actions.size === 0) throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTIONS_EMPTY')
  const runGate = randomBytes(32).toString('base64url')
  const consumed = new Set<string>()
  const inFlight = new Set<string>()
  const orderedActionIds = [...actions.keys()]
  let nextActionIndex = 0
  let terminalFailure = false
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      if (!isLoopback(request.socket.remoteAddress)) throw httpError(403, 'E2E_CONTROLLED_WRITE_REMOTE_DENIED')
      if (request.method !== 'POST' || request.url !== '/v1/reversible-write') {
        throw httpError(404, 'E2E_CONTROLLED_WRITE_ROUTE_NOT_FOUND')
      }
      if (request.headers.authorization !== `Bearer ${runGate}`) {
        throw httpError(401, 'E2E_CONTROLLED_WRITE_RUN_GATE_INVALID')
      }
      const body = await readJsonBody(request)
      validateAction(body)
      const expected = actions.get(body.actionId)
      if (!expected || canonicalizeJson(body) !== canonicalizeJson(expected)) {
        throw httpError(409, 'E2E_CONTROLLED_WRITE_ACTION_BINDING_MISMATCH')
      }
      if (consumed.has(body.actionId) || inFlight.has(body.actionId)) {
        throw httpError(409, 'E2E_CONTROLLED_WRITE_RUN_GATE_CONSUMED')
      }
      if (terminalFailure) throw httpError(409, 'E2E_CONTROLLED_WRITE_BRIDGE_TERMINAL')
      if (orderedActionIds[nextActionIndex] !== body.actionId) {
        throw httpError(409, 'E2E_CONTROLLED_WRITE_ACTION_OUT_OF_ORDER')
      }
      consumed.add(body.actionId)
      inFlight.add(body.actionId)
      try {
        const proof = await input.launch(body)
        validateProofShape(proof)
        if (!input.verifyExecutionOutcomeReceipt(proof.executionOutcomeReceipt)) {
          throw controlledWriteError('E2E_CONTROLLED_WRITE_OUTCOME_SIGNATURE_INVALID')
        }
        validateProofActionBinding(proof, body)
        nextActionIndex += 1
        response.statusCode = 200
        response.end(JSON.stringify(proof))
      } catch (error) {
        terminalFailure = true
        throw error
      } finally {
        inFlight.delete(body.actionId)
      }
    } catch (error) {
      const status = statusOf(error)
      response.statusCode = status
      response.end(JSON.stringify({ code: codeOf(error) }))
    }
  })
  await listenLoopback(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw controlledWriteError('E2E_CONTROLLED_WRITE_BRIDGE_ADDRESS_INVALID')
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/reversible-write`,
    runGate,
    close: () => closeServer(server),
  }
}

function validateConfiguration(
  configuration: ControlledWriteCaseConfiguration,
  cleanupPlans: LocalCleanupPlanRegistry,
): void {
  validateAction(configuration.action)
  const runner = configuration.runnerInput
  if (runner.actionId !== configuration.action.actionId
    || runner.buttonName !== configuration.action.buttonName
    || runner.beforeText !== configuration.action.beforeText
    || runner.afterText !== configuration.action.afterText
    || runner.lease.leaseId !== configuration.action.dataLeaseId) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_RUNNER_BINDING_MISMATCH')
  }
  const capability = runner.authorization.grant.capabilities.find((candidate) =>
    candidate.actionId === runner.actionId && candidate.effect === 'reversible-write')
  if (!DIGEST_PATTERN.test(configuration.cleanupPlanDigest)
    || !capability || capability.cleanupPlanDigest !== configuration.cleanupPlanDigest) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_CLEANUP_BINDING_MISMATCH')
  }
  try {
    cleanupPlans.assertBinding({ cleanupPlanId: configuration.action.cleanupPlanId,
      cleanupPlanDigest: configuration.cleanupPlanDigest, actionId: configuration.action.actionId,
      leaseId: configuration.action.dataLeaseId })
  } catch {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_CLEANUP_PLAN_UNREGISTERED')
  }
}

function validateAction(candidate: unknown): asserts candidate is ControlledWriteBridgeRequest {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTION_INVALID')
  }
  const value = candidate as Record<string, unknown>
  const keys = ['actionId', 'afterText', 'beforeText', 'buttonName', 'cleanupPlanId', 'dataLeaseId']
  if (Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
    || keys.some((key) => typeof value[key] !== 'string' || value[key] === '')) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_ACTION_INVALID')
  }
}

function validateProofShape(proof: ControlledWriteBridgeProof): void {
  const parsedReceipt = ExecutionOutcomeReceiptSchema.safeParse(proof.executionOutcomeReceipt)
  if (proof.status !== 'passed' || proof.effectObservation !== 'applied'
    || proof.cleanupStatus !== 'verified-clean'
    || !DIGEST_PATTERN.test(proof.authorityReceiptDigest)
    || !DIGEST_PATTERN.test(proof.leaseReceiptDigest)
    || !DIGEST_PATTERN.test(proof.gatewayAuditDigest)
    || !Array.isArray(proof.evidenceIds) || proof.evidenceIds.length === 0
    || proof.evidenceIds.some((id) => typeof id !== 'string' || id.length === 0)
    || !parsedReceipt.success
    || proof.authorityReceiptDigest !== parsedReceipt.data.signedDigest
    || proof.leaseReceiptDigest !== parsedReceipt.data.cleanup.leaseReceiptDigest
    || canonicalizeJson(proof.evidenceIds) !== canonicalizeJson(parsedReceipt.data.evidenceIds)
    || parsedReceipt.data.status !== 'passed'
    || parsedReceipt.data.effectObservation !== 'applied'
    || parsedReceipt.data.cleanup.status !== 'verified-clean') {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_PROOF_INCOMPLETE')
  }
}

function validateProofActionBinding(
  proof: ControlledWriteBridgeProof,
  action: ControlledWriteBridgeRequest,
): void {
  const receipt = proof.executionOutcomeReceipt
  if (receipt.actionId !== action.actionId
    || receipt.cleanup.leaseId !== action.dataLeaseId
    || receipt.cleanup.cleanupPlanId !== action.cleanupPlanId) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_OUTCOME_ACTION_MISMATCH')
  }
}

function validateProofBindings(
  proof: ControlledWriteBridgeProof,
  action: ControlledWriteBridgeRequest,
  runnerResultDigest: string,
  cleanup: CleanupExecutionResult,
  cleanupPlanDigest: string,
): void {
  validateProofActionBinding(proof, action)
  const receipt = proof.executionOutcomeReceipt
  if (receipt.runnerResultDigest !== runnerResultDigest
    || receipt.cleanup.cleanupPlanDigest !== cleanupPlanDigest
    || receipt.cleanup.status !== cleanup.status
    || receipt.cleanup.resultDigest !== cleanup.resultDigest
    || receipt.cleanup.leaseReceiptDigest !== cleanup.leaseReceiptDigest) {
    throw controlledWriteError('E2E_CONTROLLED_WRITE_OUTCOME_BINDING_MISMATCH')
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > MAX_REQUEST_BYTES) throw httpError(413, 'E2E_CONTROLLED_WRITE_REQUEST_TOO_LARGE')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw httpError(400, 'E2E_CONTROLLED_WRITE_REQUEST_INVALID')
  }
}

function immutableSnapshot<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function controlledWriteError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function httpError(status: number, code: string): Error {
  return Object.assign(controlledWriteError(code), { status })
}

function statusOf(error: unknown): number {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status : 500
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : 'E2E_CONTROLLED_WRITE_INTERNAL_ERROR'
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : 'unknown'
}
