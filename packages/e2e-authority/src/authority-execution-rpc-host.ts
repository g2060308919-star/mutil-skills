import { fork, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CanonicalApprovalContextSchema,
  type ApproverIdentity,
  type CanonicalApprovalContext,
} from '@mutil-skills/e2e-contracts'
import type { WebAuthnApprovalAssets } from './webauthn-approval-server.js'
import type { WebAuthnApprovalType } from './webauthn-user-presence.js'
import type { SqliteStateDirectoryIdentity } from './sqlite-state-store.js'
import type {
  AuthenticatedRpcCredential,
  AuthenticatedRpcHttpHandle,
  AuthenticatedRpcVerifierMaterial,
} from './authenticated-rpc.js'

const HOST_START_TIMEOUT_MS = 10_000
const HOST_STOP_TIMEOUT_MS = 5_000
const HOST_TERM_TIMEOUT_MS = 1_000
const HOST_KILL_TIMEOUT_MS = 1_000
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

export interface AuthorityExecutionRpcHostOptions {
  rpc: { issuer: string; keyId: string; clientId: string }
  approval: {
    issuer: string
    keyId: string
    statePath: string
    stateEncryptionKey: Uint8Array
    expectedStateDirectory?: SqliteStateDirectoryIdentity
    testWorkspaceRoots: string[]
    approvalIdentities?: ApproverIdentity[]
    manualIdentities?: ApproverIdentity[]
  }
  lease: {
    statePath: string
    testWorkspaceRoots: string[]
    expectedStateDirectory?: SqliteStateDirectoryIdentity
  }
  userPresence?: {
    installationDigest: string
    assets: WebAuthnApprovalAssets
    ttlMs?: number
  }
  clock?: { kind: 'system' } | { kind: 'fixed-test-only'; now: string }
  /** 仅限固定时钟测试/Golden：生产环境的绑定必须由 WebAuthn 完成事件建立。 */
  testOnlyApprovalContext?: CanonicalApprovalContext
  process?: {
    cwd: string
    env: Record<string, string>
    pinnedStateDirectory?: {
      fd: number
      identity: SqliteStateDirectoryIdentity
      pythonExecutable: string
      wrapperPath: string
    }
  }
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
  const sourceExecArguments = sourceMode
    ? ['--import', createRequire(import.meta.url).resolve('tsx')]
    : []
  const pinned = options.process?.pinnedStateDirectory
  const child: ChildProcess = pinned === undefined
    ? fork(modulePath, [], {
        execArgv: sourceExecArguments,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        serialization: 'json',
        ...(options.process === undefined ? {} : { cwd: options.process.cwd, env: options.process.env }),
      })
    : spawn(pinned.pythonExecutable, [
        pinned.wrapperPath,
        '3',
        pinned.identity.device,
        pinned.identity.inode,
        pinned.identity.realPath,
        process.execPath,
        ...sourceExecArguments,
        modulePath,
      ], {
        cwd: options.process!.cwd,
        env: options.process!.env,
        stdio: ['ignore', 'ignore', 'inherit', pinned.fd, 'ipc'],
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
        ...(options.userPresence === undefined ? {} : {
          userPresence: {
            installationDigest: options.userPresence.installationDigest,
            ttlMs: options.userPresence.ttlMs ?? 5 * 60 * 1000,
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
        ...(options.testOnlyApprovalContext === undefined
          ? {} : { testOnlyApprovalContext: options.testOnlyApprovalContext }),
        sessionKeyBase64Url: sessionKey.toString('base64url'),
      },
    })
    const credential = { clientId: options.rpc.clientId, sessionKeyBase64Url: sessionKey.toString('base64url') }
    let closed = false
    const openedSessions = new Set<string>()
    const finishedSessions = new Set<string>()
    const failedSessions = new Map<string, string>()
    const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>()
    const claimedWaits = new Set<string>()
    let terminalError: Error | undefined
    const clearSessionState = () => {
      openedSessions.clear()
      finishedSessions.clear()
      failedSessions.clear()
      claimedWaits.clear()
    }
    const failAllWaiters = (error: Error) => {
      if (terminalError === undefined) terminalError = error
      for (const waiter of waiters.values()) waiter.reject(terminalError)
      waiters.clear()
      clearSessionState()
    }
    const onChildTerminated = () => failAllWaiters(hostError('E2E_RPC_HOST_EXITED'))
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
    child.once('error', onChildTerminated)
    child.once('exit', onChildTerminated)
    child.once('disconnect', onChildTerminated)
    const open = async (type: 'enroll-identity' | 'open-approval-session', input: unknown) => {
      if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
      if (terminalError !== undefined) throw terminalError
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
        if (terminalError !== undefined) throw terminalError
        if (!openedSessions.has(sessionId)) throw hostError('E2E_APPROVAL_SESSION_INVALID')
        if (claimedWaits.has(sessionId)) throw hostError('E2E_APPROVAL_SESSION_WAIT_DUPLICATE')
        claimedWaits.add(sessionId)
        if (finishedSessions.has(sessionId)) {
          openedSessions.delete(sessionId)
          finishedSessions.delete(sessionId)
          claimedWaits.delete(sessionId)
          return
        }
        const failed = failedSessions.get(sessionId)
        if (failed !== undefined) {
          openedSessions.delete(sessionId)
          failedSessions.delete(sessionId)
          claimedWaits.delete(sessionId)
          throw hostError(failed)
        }
        try {
          await new Promise<void>((resolve, reject) => waiters.set(sessionId, { resolve, reject }))
        } finally {
          waiters.delete(sessionId)
          openedSessions.delete(sessionId)
          finishedSessions.delete(sessionId)
          failedSessions.delete(sessionId)
          claimedWaits.delete(sessionId)
        }
      },
      async close() {
        if (closed) return
        closed = true
        try {
          await stopChild(child)
        }
        finally {
          child.off('message', onSessionMessage)
          child.off('error', onChildTerminated)
          child.off('exit', onChildTerminated)
          child.off('disconnect', onChildTerminated)
          failAllWaiters(hostError('E2E_RPC_HOST_CLOSED'))
          sessionKey.fill(0)
          credential.sessionKeyBase64Url = ''
        }
      },
    }
  } catch (error) {
    try {
      return await aggregateStartupAndCleanupFailure(error, async () => await stopChild(child))
    } finally { sessionKey.fill(0) }
  }
}

async function aggregateStartupAndCleanupFailure(
  startupError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup()
  } catch (cleanupError) {
    throw new AggregateError(
      [startupError, cleanupError],
      'E2E_RPC_HOST_START_AND_CLEANUP_FAILED',
    )
  }
  throw startupError
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
      child.off('disconnect', onDisconnect)
    }
    const finishReject = (error: unknown) => {
      scrubStartMessageSecrets(startMessage)
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finishReject(hostError('E2E_RPC_HOST_EXITED', { code, signal }))
    }
    const onDisconnect = () => finishReject(hostError('E2E_RPC_HOST_EXITED'))
    const onMessage = (message: unknown) => {
      if (!isObject(message)) return
      if (message.type === 'error' && typeof message.code === 'string') {
        finishReject(hostError(message.code))
        return
      }
      if (message.type !== 'ready' || typeof message.endpoint !== 'string' || !isObject(message.verifierMaterial)) return
      scrubStartMessageSecrets(startMessage)
      cleanup()
      resolve(message as unknown as HostReadyMessage)
    }
    child.on('message', onMessage)
    child.once('error', finishReject)
    child.once('exit', onExit)
    child.once('disconnect', onDisconnect)
    child.send(startMessage, (error) => {
      scrubStartMessageSecrets(startMessage)
      if (error) finishReject(error)
    })
  })
}

function scrubStartMessageSecrets(startMessage: Record<string, any>): void {
  if (!isObject(startMessage.config)) return
  if (isObject(startMessage.config.approval)) {
    startMessage.config.approval.stateEncryptionKeyBase64Url = ''
  }
  startMessage.config.sessionKeyBase64Url = ''
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (hasChildExited(child)) return
  if (child.connected) {
    try { child.send({ type: 'shutdown' }, () => undefined) } catch { /* 继续 TERM/KILL 回收 */ }
  }
  if (await waitForChildExit(child, HOST_STOP_TIMEOUT_MS)) return
  try { child.kill('SIGTERM') } catch { /* 继续等待或 KILL */ }
  if (await waitForChildExit(child, HOST_TERM_TIMEOUT_MS)) return
  try { child.kill('SIGKILL') } catch { /* 最后一次等待会给出稳定错误 */ }
  if (await waitForChildExit(child, HOST_KILL_TIMEOUT_MS)) return
  throw hostError('E2E_RPC_HOST_STOP_TIMEOUT')
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasChildExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timeout = setTimeout(() => finish(hasChildExited(child)), timeoutMs)
    child.once('exit', onExit)
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
      child.off('disconnect', onDisconnect)
    }
    const finishReject = (error: unknown) => { cleanup(); reject(error) }
    const onExit = () => finishReject(hostError('E2E_RPC_HOST_EXITED'))
    const onDisconnect = () => finishReject(hostError('E2E_RPC_HOST_EXITED'))
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
    child.once('disconnect', onDisconnect)
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
    || (options.testOnlyApprovalContext !== undefined && (
      options.clock?.kind !== 'fixed-test-only'
      || !CanonicalApprovalContextSchema.safeParse(options.testOnlyApprovalContext).success
    ))
    || (options.userPresence !== undefined && (
      !/^sha256:[a-f0-9]{64}$/.test(options.userPresence.installationDigest)
      || (options.userPresence.ttlMs !== undefined && (
        !Number.isSafeInteger(options.userPresence.ttlMs)
        || options.userPresence.ttlMs < 1 || options.userPresence.ttlMs > 5 * 60 * 1000
      ))
      || options.userPresence.assets.indexHtml.byteLength === 0
      || options.userPresence.assets.approvalJavaScript.byteLength === 0
      || options.userPresence.assets.simpleWebAuthnBrowser.byteLength === 0
    ))
    || (options.process !== undefined && (
      !options.process.cwd
      || Object.keys(options.process.env).sort().join('\0') !== ['HOME', 'LANG', 'PATH', 'TMPDIR'].join('\0')
      || options.process.env.LANG !== 'C.UTF-8'
      || Object.values(options.process.env).some((value) => typeof value !== 'string')
      || (options.process.pinnedStateDirectory !== undefined && (
        !Number.isSafeInteger(options.process.pinnedStateDirectory.fd)
        || options.process.pinnedStateDirectory.fd < 0
        || !isAbsolute(options.process.pinnedStateDirectory.pythonExecutable)
        || !isAbsolute(options.process.pinnedStateDirectory.wrapperPath)
        || !isStateDirectoryIdentity(options.process.pinnedStateDirectory.identity)
        || options.approval.statePath !== 'approval.sqlite'
        || options.lease.statePath !== 'lease.sqlite'
        || !sameStateDirectoryIdentity(
          options.approval.expectedStateDirectory,
          options.process.pinnedStateDirectory.identity,
        )
        || !sameStateDirectoryIdentity(
          options.lease.expectedStateDirectory,
          options.process.pinnedStateDirectory.identity,
        )
      ))
    ))) {
    throw hostError('E2E_RPC_HOST_CONFIG_INVALID')
  }
}

function isStateDirectoryIdentity(value: SqliteStateDirectoryIdentity | undefined): value is SqliteStateDirectoryIdentity {
  return value !== undefined && isAbsolute(value.realPath)
    && /^\d+$/.test(value.device) && /^\d+$/.test(value.inode)
}

function sameStateDirectoryIdentity(
  left: SqliteStateDirectoryIdentity | undefined,
  right: SqliteStateDirectoryIdentity,
): boolean {
  return left !== undefined && left.realPath === right.realPath
    && left.device === right.device && left.inode === right.inode
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
