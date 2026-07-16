import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ApproverIdentity } from '@mutil-skills/e2e-contracts'
import type { WebAuthnApprovalAssets } from './webauthn-approval-server.js'
import type { WebAuthnApprovalType } from './webauthn-user-presence.js'
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
  userPresence?: {
    installationDigest: string
    assets: WebAuthnApprovalAssets
  }
  clock?: { kind: 'system' } | { kind: 'fixed-test-only'; now: string }
  process?: { cwd: string; env: Record<string, string> }
}

export interface AuthorityExecutionRpcProcessHandle extends AuthenticatedRpcHttpHandle {
  pid: number
  credential: AuthenticatedRpcCredential
  verifierMaterial: AuthenticatedRpcVerifierMaterial
  enrollIdentity(input: { subject: string }): Promise<{ url: string; sessionId: string }>
  openApprovalSession(input: {
    runId: string
    approvalType: WebAuthnApprovalType
    subjectDigest: string
    installationDigest: string
  }): Promise<{ url: string; sessionId: string }>
  waitForSession(sessionId: string): Promise<void>
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
    ...(options.process === undefined ? {} : { cwd: options.process.cwd, env: options.process.env }),
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
        ...(options.userPresence === undefined ? {} : {
          userPresence: {
            installationDigest: options.userPresence.installationDigest,
            assets: {
              indexHtmlBase64Url: Buffer.from(options.userPresence.assets.indexHtml).toString('base64url'),
              approvalJavaScriptBase64Url:
                Buffer.from(options.userPresence.assets.approvalJavaScript).toString('base64url'),
              simpleWebAuthnBrowserBase64Url:
                Buffer.from(options.userPresence.assets.simpleWebAuthnBrowser).toString('base64url'),
            },
          },
        }),
        clock: options.clock ?? { kind: 'system' },
        sessionKeyBase64Url: sessionKey.toString('base64url'),
      },
    })
    const credential = { clientId: options.rpc.clientId, sessionKeyBase64Url: sessionKey.toString('base64url') }
    let closed = false
    const openedSessions = new Set<string>()
    const finishedSessions = new Set<string>()
    const failedSessions = new Map<string, string>()
    const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>()
    const onSessionMessage = (message: unknown) => {
      if (!isObject(message) || typeof message.sessionId !== 'string') return
      if (message.type === 'session-finished') {
        finishedSessions.add(message.sessionId)
        waiters.get(message.sessionId)?.resolve()
        waiters.delete(message.sessionId)
      } else if (message.type === 'session-failed' && typeof message.code === 'string') {
        failedSessions.set(message.sessionId, message.code)
        waiters.get(message.sessionId)?.reject(hostError(message.code))
        waiters.delete(message.sessionId)
      }
    }
    child.on('message', onSessionMessage)
    const open = async (type: 'enroll-identity' | 'open-approval-session', input: unknown) => {
      if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
      const result = await callControl(child, type, input)
      openedSessions.add(result.sessionId)
      return result
    }
    return {
      endpoint: ready.endpoint,
      pid: child.pid!,
      credential,
      verifierMaterial: ready.verifierMaterial,
      async enrollIdentity(input) { return await open('enroll-identity', input) },
      async openApprovalSession(input) { return await open('open-approval-session', input) },
      async waitForSession(sessionId) {
        if (!openedSessions.has(sessionId)) throw hostError('E2E_APPROVAL_SESSION_INVALID')
        if (finishedSessions.has(sessionId)) return
        const failed = failedSessions.get(sessionId)
        if (failed !== undefined) throw hostError(failed)
        await new Promise<void>((resolve, reject) => waiters.set(sessionId, { resolve, reject }))
      },
      async close() {
        if (closed) return
        closed = true
        try { await stopChild(child) }
        finally {
          child.off('message', onSessionMessage)
          for (const waiter of waiters.values()) waiter.reject(hostError('E2E_RPC_HOST_CLOSED'))
          waiters.clear()
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

function callControl(
  child: ChildProcess,
  type: 'enroll-identity' | 'open-approval-session',
  input: unknown,
): Promise<{ url: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(16).toString('hex')
    const timeout = setTimeout(() => finishReject(hostError('E2E_RPC_HOST_CONTROL_TIMEOUT')), HOST_START_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('error', finishReject)
      child.off('exit', onExit)
    }
    const finishReject = (error: unknown) => { cleanup(); reject(error) }
    const onExit = () => finishReject(hostError('E2E_RPC_HOST_EXITED'))
    const onMessage = (message: unknown) => {
      if (!isObject(message) || message.requestId !== requestId) return
      if (message.type === 'control-error' && typeof message.code === 'string') {
        finishReject(hostError(message.code))
        return
      }
      if (message.type !== 'session-opened' || typeof message.url !== 'string'
        || typeof message.sessionId !== 'string') return
      cleanup()
      resolve({ url: message.url, sessionId: message.sessionId })
    }
    child.on('message', onMessage)
    child.once('error', finishReject)
    child.once('exit', onExit)
    child.send({ type, requestId, input }, (error) => { if (error) finishReject(error) })
  })
}

function validateOptions(options: AuthorityExecutionRpcHostOptions): void {
  if (!SAFE_ID.test(options.rpc.issuer) || !SAFE_ID.test(options.rpc.keyId) || !SAFE_ID.test(options.rpc.clientId)
    || !SAFE_ID.test(options.approval.issuer) || !SAFE_ID.test(options.approval.keyId)
    || Buffer.from(options.approval.stateEncryptionKey).byteLength !== 32
    || !options.approval.statePath || !options.lease.statePath
    || options.approval.testWorkspaceRoots.length === 0 || options.lease.testWorkspaceRoots.length === 0
    || (options.clock?.kind === 'fixed-test-only' && !isCanonicalInstant(options.clock.now))
    || (options.userPresence !== undefined && (
      !/^sha256:[a-f0-9]{64}$/.test(options.userPresence.installationDigest)
      || options.userPresence.assets.indexHtml.byteLength === 0
      || options.userPresence.assets.approvalJavaScript.byteLength === 0
      || options.userPresence.assets.simpleWebAuthnBrowser.byteLength === 0
    ))
    || (options.process !== undefined && (
      !options.process.cwd
      || Object.keys(options.process.env).sort().join('\0') !== ['HOME', 'LANG', 'PATH', 'TMPDIR'].join('\0')
      || options.process.env.LANG !== 'C.UTF-8'
      || Object.values(options.process.env).some((value) => typeof value !== 'string')
    ))) {
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
