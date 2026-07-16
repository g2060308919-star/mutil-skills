import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ApproverIdentity } from '@mutil-skills/e2e-contracts'
import type {
  AuthenticatedRpcCredential,
  AuthenticatedRpcHttpHandle,
  AuthenticatedRpcVerifierMaterial,
} from './authenticated-rpc.js'

const HOST_START_TIMEOUT_MS = 10_000
const HOST_STOP_TIMEOUT_MS = 5_000
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

export interface AuthorityExecutionRpcHostOptions {
  rpc: { issuer: string; keyId: string; clientId: string }
  approval: {
    issuer: string
    keyId: string
    statePath: string
    stateEncryptionKey: Uint8Array
    testWorkspaceRoots: string[]
    approvalIdentities?: ApproverIdentity[]
    manualIdentities?: ApproverIdentity[]
  }
  lease: { statePath: string; testWorkspaceRoots: string[] }
  clock?: { kind: 'system' } | { kind: 'fixed-test-only'; now: string }
}

export interface AuthorityExecutionRpcProcessHandle extends AuthenticatedRpcHttpHandle {
  pid: number
  credential: AuthenticatedRpcCredential
  verifierMaterial: AuthenticatedRpcVerifierMaterial
}

export async function startAuthorityExecutionRpcHostProcess(
  options: AuthorityExecutionRpcHostOptions,
): Promise<AuthorityExecutionRpcProcessHandle> {
  validateOptions(options)
  const sessionKey = randomBytes(32)
  const sourceMode = import.meta.url.endsWith('.ts')
  const modulePath = fileURLToPath(new URL(
    sourceMode ? './authority-execution-rpc-host-process.ts' : './authority-execution-rpc-host-process.js',
    import.meta.url,
  ))
  const child = fork(modulePath, [], {
    execArgv: sourceMode ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    serialization: 'json',
  })
  try {
    const { stateEncryptionKey: _stateEncryptionKey, ...approvalConfig } = options.approval
    const ready = await waitForReady(child, {
      type: 'start',
      config: {
        rpc: options.rpc,
        approval: { ...approvalConfig,
          stateEncryptionKeyBase64Url: Buffer.from(options.approval.stateEncryptionKey).toString('base64url') },
        lease: options.lease,
        clock: options.clock ?? { kind: 'system' },
        sessionKeyBase64Url: sessionKey.toString('base64url'),
      },
    })
    const credential = { clientId: options.rpc.clientId, sessionKeyBase64Url: sessionKey.toString('base64url') }
    let closed = false
    return {
      endpoint: ready.endpoint,
      pid: child.pid!,
      credential,
      verifierMaterial: ready.verifierMaterial,
      async close() {
        if (closed) return
        closed = true
        try { await stopChild(child) }
        finally {
          sessionKey.fill(0)
          credential.sessionKeyBase64Url = ''
        }
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    sessionKey.fill(0)
    throw error
  }
}

interface HostReadyMessage {
  type: 'ready'
  endpoint: string
  verifierMaterial: AuthenticatedRpcVerifierMaterial
}

function waitForReady(child: ChildProcess, startMessage: Record<string, any>): Promise<HostReadyMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finishReject(hostError('E2E_RPC_HOST_START_TIMEOUT')), HOST_START_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('error', finishReject)
      child.off('exit', onExit)
    }
    const finishReject = (error: unknown) => { cleanup(); reject(error) }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finishReject(hostError('E2E_RPC_HOST_EXITED', { code, signal }))
    }
    const onMessage = (message: unknown) => {
      if (!isObject(message)) return
      if (message.type === 'error' && typeof message.code === 'string') {
        finishReject(hostError(message.code))
        return
      }
      if (message.type !== 'ready' || typeof message.endpoint !== 'string' || !isObject(message.verifierMaterial)) return
      cleanup()
      resolve(message as unknown as HostReadyMessage)
    }
    child.on('message', onMessage)
    child.once('error', finishReject)
    child.once('exit', onExit)
    child.send(startMessage, (error) => { if (error) finishReject(error) })
  })
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(hostError('E2E_RPC_HOST_STOP_TIMEOUT'))
    }, HOST_STOP_TIMEOUT_MS)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.send({ type: 'shutdown' }, (error) => {
      if (error) { clearTimeout(timeout); reject(error) }
    })
  })
}

function validateOptions(options: AuthorityExecutionRpcHostOptions): void {
  if (!SAFE_ID.test(options.rpc.issuer) || !SAFE_ID.test(options.rpc.keyId) || !SAFE_ID.test(options.rpc.clientId)
    || !SAFE_ID.test(options.approval.issuer) || !SAFE_ID.test(options.approval.keyId)
    || Buffer.from(options.approval.stateEncryptionKey).byteLength !== 32
    || !options.approval.statePath || !options.lease.statePath
    || options.approval.testWorkspaceRoots.length === 0 || options.lease.testWorkspaceRoots.length === 0
    || (options.clock?.kind === 'fixed-test-only' && !isCanonicalInstant(options.clock.now))) {
    throw hostError('E2E_RPC_HOST_CONFIG_INVALID')
  }
}

function isCanonicalInstant(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hostError(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code })
}
