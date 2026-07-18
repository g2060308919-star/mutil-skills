import { fork, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalFinalizationAcknowledgementSchema,
  ApprovalGrantSubjectSchema,
  DecisionReceiptSchema,
  DecisionSubjectSchema,
  SignedGrantSchema,
  type ApproverIdentity,
  type ApprovalFinalizationAcknowledgement,
  type ApprovalGrantSubject,
  type DecisionReceipt,
  type DecisionSubject,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
import {
  parseApprovalExecutionBinding,
  type ApprovalExecutionBinding,
} from './trusted-execution-clients.js'
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
const SAFE_ERROR_CODE = /^E2E_[A-Z0-9_]{1,252}$/

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
  finalizeApproval(input: {
    sessionId: string
    grantSubject: ApprovalGrantSubject
    finalizationId: string
    requestDigest: string
  }): Promise<{ grant: SignedGrant; approvalBinding: ApprovalExecutionBinding }>
  finalizeDecision(input: {
    sessionId: string
    decisionId: string
    decisionSubject: DecisionSubject
  }): Promise<DecisionReceipt>
  recoverApproval(input: {
    finalizationId: string
    requestDigest: string
    grantSubject: ApprovalGrantSubject
    approvalBinding: ApprovalExecutionBinding
  }): Promise<{
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
    sessionId: string
  } | undefined>
  activateGrant(input: {
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
  }): Promise<void>
  acknowledgeFinalization(input: ApprovalFinalizationAcknowledgement): Promise<void>
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
    const stateEncryptionKeyCopy = Buffer.from(options.approval.stateEncryptionKey)
    let stateEncryptionKeyBase64Url: string
    try {
      stateEncryptionKeyBase64Url = stateEncryptionKeyCopy.toString('base64url')
    } finally {
      stateEncryptionKeyCopy.fill(0)
    }
    const ready = await waitForReady(child, {
      type: 'start',
      config: {
        rpc: options.rpc,
        approval: { ...approvalConfig, stateEncryptionKeyBase64Url },
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
        sessionKeyBase64Url: sessionKey.toString('base64url'),
      },
    })
    const credential = { clientId: options.rpc.clientId, sessionKeyBase64Url: sessionKey.toString('base64url') }
    let closed = false
    const openedSessions = new Set<string>()
    const approvalSessions = new Set<string>()
    const completedApprovalSessions = new Set<string>()
    const finishedSessions = new Set<string>()
    const failedSessions = new Map<string, string>()
    const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>()
    const claimedWaits = new Set<string>()
    let terminalError: Error | undefined
    let rejectTerminalSignal!: (error: Error) => void
    const terminalSignal = new Promise<never>((_resolve, reject) => { rejectTerminalSignal = reject })
    void terminalSignal.catch(() => undefined)
    let disconnectTimeout: NodeJS.Timeout | undefined
    const clearSessionState = () => {
      openedSessions.clear()
      approvalSessions.clear()
      completedApprovalSessions.clear()
      finishedSessions.clear()
      failedSessions.clear()
      claimedWaits.clear()
    }
    const failAllWaiters = (error: Error) => {
      if (terminalError === undefined || (isCleanupFailure(error) && !isCleanupFailure(terminalError))) {
        terminalError = error
        rejectTerminalSignal(error)
      }
      for (const waiter of waiters.values()) waiter.reject(terminalError)
      waiters.clear()
      clearSessionState()
    }
    const onChildError = () => failAllWaiters(hostError('E2E_RPC_HOST_EXITED'))
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (disconnectTimeout !== undefined) clearTimeout(disconnectTimeout)
      disconnectTimeout = undefined
      if (terminalError !== undefined && isCleanupFailure(terminalError)) return
      failAllWaiters(code !== null && code !== 0
        ? cleanupAggregate({
            code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
            causes: ['E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE'],
          })
        : hostError('E2E_RPC_HOST_EXITED', { code, signal }))
    }
    const onChildDisconnect = () => {
      if (disconnectTimeout !== undefined) return
      disconnectTimeout = setTimeout(
        () => failAllWaiters(hostError('E2E_RPC_HOST_EXITED')),
        HOST_TERM_TIMEOUT_MS,
      )
    }
    const onSessionMessage = (message: unknown) => {
      if (!isObject(message)) return
      if (message.type === 'terminal-cleanup-error') {
        try {
          if (Object.keys(message).sort().join('\0') !== ['error', 'type'].join('\0')) {
            throw hostError('E2E_RPC_HOST_SHUTDOWN_RESULT_INVALID')
          }
          failAllWaiters(cleanupAggregate(parseChildCleanupFailure(message.error)))
        } catch {
          failAllWaiters(hostError('E2E_RPC_HOST_SHUTDOWN_RESULT_INVALID'))
        }
        return
      }
      if (message.type !== 'session-finished' && message.type !== 'session-failed') return
      if (typeof message.sessionId !== 'string' || !SAFE_ID.test(message.sessionId)
        || (message.type === 'session-finished'
          ? Object.keys(message).sort().join('\0') !== ['sessionId', 'type'].join('\0')
          : Object.keys(message).sort().join('\0') !== ['code', 'sessionId', 'type'].join('\0')
            || typeof message.code !== 'string' || !SAFE_ERROR_CODE.test(message.code))) {
        failAllWaiters(hostError('E2E_RPC_HOST_CONTROL_RESULT_INVALID'))
        return
      }
      if (message.type === 'session-finished') {
        finishedSessions.add(message.sessionId)
        if (approvalSessions.has(message.sessionId)) completedApprovalSessions.add(message.sessionId)
        waiters.get(message.sessionId)?.resolve()
        waiters.delete(message.sessionId)
      } else if (message.type === 'session-failed' && typeof message.code === 'string') {
        failedSessions.set(message.sessionId, message.code)
        waiters.get(message.sessionId)?.reject(hostError(message.code))
        waiters.delete(message.sessionId)
      }
    }
    child.on('message', onSessionMessage)
    child.once('error', onChildError)
    child.once('exit', onChildExit)
    child.once('disconnect', onChildDisconnect)
    const open = async (type: 'enroll-identity' | 'open-approval-session', input: unknown) => {
      if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
      if (terminalError !== undefined) throw terminalError
      const result = await callControl(child, type, input, terminalSignal)
      openedSessions.add(result.sessionId)
      if (type === 'open-approval-session') approvalSessions.add(result.sessionId)
      return result
    }
    return {
      endpoint: ready.endpoint,
      pid: child.pid!,
      credential,
      verifierMaterial: ready.verifierMaterial,
      async enrollIdentity(input) { return await open('enroll-identity', input) },
      async openApprovalSession(input) { return await open('open-approval-session', input) },
      async finalizeApproval(input) {
        if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
        if (terminalError !== undefined) throw terminalError
        if (!completedApprovalSessions.has(input.sessionId)) {
          throw hostError('E2E_APPROVAL_SESSION_INVALID')
        }
        const result = await callFinalizeControl(child, input, terminalSignal)
        completedApprovalSessions.delete(input.sessionId)
        approvalSessions.delete(input.sessionId)
        return result
      },
      async finalizeDecision(input) {
        if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
        if (terminalError !== undefined) throw terminalError
        if (!completedApprovalSessions.has(input.sessionId)) {
          throw hostError('E2E_APPROVAL_SESSION_INVALID')
        }
        const result = await callDecisionControl(child, input, terminalSignal)
        completedApprovalSessions.delete(input.sessionId)
        approvalSessions.delete(input.sessionId)
        return result
      },
      async recoverApproval(input) {
        if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
        if (terminalError !== undefined) throw terminalError
        return await callRecoverControl(child, input, terminalSignal)
      },
      async activateGrant(input) {
        if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
        if (terminalError !== undefined) throw terminalError
        await callActivateControl(child, input, terminalSignal)
      },
      async acknowledgeFinalization(input) {
        if (closed) throw hostError('E2E_RPC_HOST_CLOSED')
        if (terminalError !== undefined) throw terminalError
        await callAcknowledgeControl(child, input, terminalSignal)
      },
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
        let stopError: unknown
        try {
          await stopChild(child)
        } catch (error) {
          stopError = error
        } finally {
          if (disconnectTimeout !== undefined) clearTimeout(disconnectTimeout)
          child.off('message', onSessionMessage)
          child.off('error', onChildError)
          child.off('exit', onChildExit)
          child.off('disconnect', onChildDisconnect)
          failAllWaiters(hostError('E2E_RPC_HOST_CLOSED'))
          sessionKey.fill(0)
          credential.sessionKeyBase64Url = ''
        }
        if (stopError !== undefined) {
          if (terminalError !== undefined && isCleanupFailure(terminalError)
            && stopError !== terminalError
            && !(stopError instanceof Error && isCleanupFailure(stopError))) {
            throw new AggregateError(
              [terminalError, stopError],
              'E2E_RPC_HOST_CLEANUP_AND_STOP_FAILED',
            )
          }
          throw stopError
        }
        if (terminalError !== undefined && isCleanupFailure(terminalError)) throw terminalError
      },
    }
  } catch (error) {
    try {
      const childCleanupReported = isObject(error) && error.childCleanupReported === true
      return await aggregateStartupAndCleanupFailure(
        error,
        async () => await stopChild(child, !childCleanupReported),
      )
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

interface ChildCleanupFailure {
  code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED'
  causes: string[]
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
    const finishReject = (error: unknown) => {
      scrubStartMessageSecrets(startMessage)
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finishReject(code !== null && code !== 0
        ? Object.assign(cleanupAggregate({
            code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
            causes: ['E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE'],
          }), { code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED' })
        : hostError('E2E_RPC_HOST_EXITED', { code, signal }))
    }
    const onMessage = (message: unknown) => {
      if (!isObject(message)) return
      if (message.type === 'startup-error') {
        try { finishReject(parseStartupFailure(message)) }
        catch (error) { finishReject(error) }
        return
      }
      if (message.type !== 'ready') return
      try {
        const ready = parseReadyMessage(message)
        scrubStartMessageSecrets(startMessage)
        cleanup()
        resolve(ready)
      } catch (error) { finishReject(error) }
    }
    child.on('message', onMessage)
    child.once('error', finishReject)
    child.once('exit', onExit)
    child.send(startMessage, (error) => {
      scrubStartMessageSecrets(startMessage)
      if (error) finishReject(error)
    })
  })
}

function parseReadyMessage(message: Record<string, any>): HostReadyMessage {
  if (Object.keys(message).sort().join('\0') !== ['endpoint', 'type', 'verifierMaterial'].join('\0')
    || typeof message.endpoint !== 'string' || !isObject(message.verifierMaterial)) {
    throw hostError('E2E_RPC_HOST_START_RESULT_INVALID')
  }
  let endpoint: URL
  try { endpoint = new URL(message.endpoint) }
  catch { throw hostError('E2E_RPC_HOST_START_RESULT_INVALID') }
  const material = message.verifierMaterial
  if (endpoint.protocol !== 'http:' || (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost')
    || endpoint.username !== '' || endpoint.password !== '' || endpoint.pathname !== '/v1/authority-rpc'
    || endpoint.search !== '' || endpoint.hash !== '' || endpoint.port === ''
    || Object.keys(material).sort().join('\0') !== [
      'algorithm', 'issuer', 'keyId', 'publicKeyDigest', 'publicKeySpkiBase64Url', 'purpose', 'schemaVersion',
    ].join('\0')
    || material.schemaVersion !== '1.0.0' || material.purpose !== 'authority-rpc-response/v1'
    || material.algorithm !== 'Ed25519' || typeof material.issuer !== 'string' || !SAFE_ID.test(material.issuer)
    || typeof material.keyId !== 'string' || !SAFE_ID.test(material.keyId)
    || typeof material.publicKeyDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(material.publicKeyDigest)
    || typeof material.publicKeySpkiBase64Url !== 'string') {
    throw hostError('E2E_RPC_HOST_START_RESULT_INVALID')
  }
  const publicKey = Buffer.from(material.publicKeySpkiBase64Url, 'base64url')
  if (publicKey.byteLength === 0 || publicKey.byteLength > 16 * 1024
    || publicKey.toString('base64url') !== material.publicKeySpkiBase64Url) {
    throw hostError('E2E_RPC_HOST_START_RESULT_INVALID')
  }
  return structuredClone(message) as HostReadyMessage
}

function parseStartupFailure(message: Record<string, any>): Error {
  if (Object.keys(message).sort().join('\0') !== ['cleanup', 'code', 'type'].join('\0')
    || typeof message.code !== 'string' || !SAFE_ERROR_CODE.test(message.code) || !isObject(message.cleanup)) {
    return hostError('E2E_RPC_HOST_START_RESULT_INVALID')
  }
  const startup = Object.assign(hostError(message.code), { childCleanupReported: true })
  if (message.cleanup.ok === true
    && Object.keys(message.cleanup).join('\0') === 'ok') return startup
  if (message.cleanup.ok !== false
    || Object.keys(message.cleanup).sort().join('\0') !== ['error', 'ok'].join('\0')) {
    return hostError('E2E_RPC_HOST_START_RESULT_INVALID')
  }
  let cleanup: ChildCleanupFailure
  try { cleanup = parseChildCleanupFailure(message.cleanup.error) }
  catch { return hostError('E2E_RPC_HOST_START_RESULT_INVALID') }
  return Object.assign(new AggregateError(
    [startup, ...cleanup.causes.map((code) => hostError(code))],
    'E2E_RPC_HOST_START_AND_CLEANUP_FAILED',
  ), { childCleanupReported: true })
}

function parseChildCleanupFailure(value: unknown): ChildCleanupFailure {
  if (!isObject(value)
    || Object.keys(value).sort().join('\0') !== ['causes', 'code'].join('\0')
    || value.code !== 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED'
    || !Array.isArray(value.causes) || value.causes.length === 0 || value.causes.length > 1_000
    || value.causes.some((code) => typeof code !== 'string' || !SAFE_ERROR_CODE.test(code))) {
    throw hostError('E2E_RPC_HOST_SHUTDOWN_RESULT_INVALID')
  }
  return { code: value.code, causes: [...value.causes] }
}

function cleanupAggregate(failure: ChildCleanupFailure): AggregateError {
  return new AggregateError(
    failure.causes.map((code) => hostError(code)),
    failure.code,
  )
}

function isCleanupFailure(error: Error): boolean {
  return error instanceof AggregateError && (
    error.message === 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED'
    || error.message === 'E2E_RPC_HOST_CLEANUP_AND_STOP_FAILED'
  )
}

function scrubStartMessageSecrets(startMessage: Record<string, any>): void {
  if (!isObject(startMessage.config)) return
  if (isObject(startMessage.config.approval)) {
    startMessage.config.approval.stateEncryptionKeyBase64Url = ''
  }
  startMessage.config.sessionKeyBase64Url = ''
}

async function stopChild(child: ChildProcess, requestShutdown = true): Promise<void> {
  if (hasChildExited(child)) return
  let shutdownError: unknown
  if (requestShutdown && child.connected) {
    try { await requestChildShutdown(child) }
    catch (error) { shutdownError = error }
  }
  if (await waitForChildExit(child, HOST_STOP_TIMEOUT_MS)) {
    if (shutdownError !== undefined) throw shutdownError
    return
  }
  try { child.kill('SIGTERM') } catch { /* 继续等待或 KILL */ }
  if (await waitForChildExit(child, HOST_TERM_TIMEOUT_MS)) {
    if (shutdownError !== undefined) throw shutdownError
    return
  }
  try { child.kill('SIGKILL') } catch { /* 最后一次等待会给出稳定错误 */ }
  if (await waitForChildExit(child, HOST_KILL_TIMEOUT_MS)) {
    if (shutdownError !== undefined) throw shutdownError
    return
  }
  const stopError = hostError('E2E_RPC_HOST_STOP_TIMEOUT')
  if (shutdownError !== undefined) {
    throw new AggregateError(
      [shutdownError, stopError],
      'E2E_RPC_HOST_CLEANUP_AND_STOP_FAILED',
    )
  }
  throw stopError
}

function requestChildShutdown(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(16).toString('hex')
    const timeout = setTimeout(
      () => finishReject(hostError('E2E_RPC_HOST_SHUTDOWN_RESULT_MISSING')),
      HOST_STOP_TIMEOUT_MS,
    )
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('error', finishReject)
    }
    const finishReject = (error: unknown) => { cleanup(); reject(error) }
    const onMessage = (message: unknown) => {
      if (!isObject(message) || message.requestId !== requestId || message.type !== 'shutdown-result') return
      try {
        if (message.ok === true) {
          if (Object.keys(message).sort().join('\0') !== ['ok', 'requestId', 'type'].join('\0')) {
            throw hostError('E2E_RPC_HOST_SHUTDOWN_RESULT_INVALID')
          }
          cleanup(); resolve(); return
        }
        if (message.ok !== false
          || Object.keys(message).sort().join('\0') !== ['error', 'ok', 'requestId', 'type'].join('\0')) {
          throw hostError('E2E_RPC_HOST_SHUTDOWN_RESULT_INVALID')
        }
        throw cleanupAggregate(parseChildCleanupFailure(message.error))
      } catch (error) { finishReject(error) }
    }
    child.on('message', onMessage)
    child.once('error', finishReject)
    try {
      child.send({ type: 'shutdown', requestId }, (error) => { if (error) finishReject(error) })
    } catch (error) { finishReject(error) }
  })
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
  terminalSignal: Promise<never>,
): Promise<{ url: string; sessionId: string }> {
  return callChildControl(child, type, input, 'session-opened', terminalSignal, (message) => {
    if (Object.keys(message).sort().join('\0') !== ['requestId', 'sessionId', 'type', 'url'].join('\0')
      || typeof message.url !== 'string' || typeof message.sessionId !== 'string'
      || !SAFE_ID.test(message.sessionId) || !isUserPresenceReference(message.url)) {
      throw hostError('E2E_RPC_HOST_CONTROL_RESULT_INVALID')
    }
    return { url: message.url, sessionId: message.sessionId }
  })
}

function isUserPresenceReference(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === 'localhost' && url.port !== ''
      && url.username === '' && url.password === '' && url.pathname === '/'
      && url.search === '' && /^#[A-Za-z0-9_-]{43}$/.test(url.hash)
  } catch { return false }
}

function callFinalizeControl(
  child: ChildProcess,
  input: {
    sessionId: string
    grantSubject: ApprovalGrantSubject
    finalizationId: string
    requestDigest: string
  },
  terminalSignal: Promise<never>,
): Promise<{ grant: SignedGrant; approvalBinding: ApprovalExecutionBinding }> {
  const parsedSubject = ApprovalGrantSubjectSchema.parse(input.grantSubject)
  validateFinalizationControl(input.finalizationId, input.requestDigest)
  return callChildControl(child, 'finalize-approval', {
    sessionId: input.sessionId, grantSubject: parsedSubject,
    finalizationId: input.finalizationId, requestDigest: input.requestDigest,
  }, 'approval-finalized', terminalSignal, (message) => {
    if (Object.keys(message).sort().join('\0') !== ['requestId', 'result', 'type'].join('\0')
      || !isObject(message.result)) throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
    return parseFinalizedApproval(message.result)
  })
}

function callDecisionControl(
  child: ChildProcess,
  input: { sessionId: string; decisionId: string; decisionSubject: DecisionSubject },
  terminalSignal: Promise<never>,
): Promise<DecisionReceipt> {
  if (!SAFE_ID.test(input.sessionId) || !SAFE_ID.test(input.decisionId)) {
    throw hostError('E2E_APPROVAL_DECISION_INPUT_INVALID')
  }
  const subject = DecisionSubjectSchema.parse(input.decisionSubject)
  return callChildControl(child, 'finalize-decision', {
    sessionId: input.sessionId, decisionId: input.decisionId, decisionSubject: subject,
  }, 'decision-finalized', terminalSignal, (message) => {
    if (Object.keys(message).sort().join('\0') !== ['requestId', 'result', 'type'].join('\0')) {
      throw hostError('E2E_APPROVAL_DECISION_RESULT_INVALID')
    }
    const parsed = DecisionReceiptSchema.safeParse(message.result)
    if (!parsed.success) throw hostError('E2E_APPROVAL_DECISION_RESULT_INVALID')
    return parsed.data
  })
}

function callRecoverControl(
  child: ChildProcess,
  input: {
    finalizationId: string
    requestDigest: string
    grantSubject: ApprovalGrantSubject
    approvalBinding: ApprovalExecutionBinding
  },
  terminalSignal: Promise<never>,
): Promise<{
  grant: SignedGrant
  approvalBinding: ApprovalExecutionBinding
  sessionId: string
} | undefined> {
  validateFinalizationControl(input.finalizationId, input.requestDigest)
  return callChildControl(child, 'recover-approval', {
    finalizationId: input.finalizationId,
    requestDigest: input.requestDigest,
    grantSubject: ApprovalGrantSubjectSchema.parse(input.grantSubject),
    approvalBinding: parseApprovalExecutionBinding(input.approvalBinding),
  }, 'approval-recovered', terminalSignal, (message) => {
    if (Object.keys(message).sort().join('\0') !== ['requestId', 'result', 'type'].join('\0')
      || !isObject(message.result) || typeof message.result.found !== 'boolean') {
      throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
    }
    if (!message.result.found) {
      if (Object.keys(message.result).join('\0') !== 'found') {
        throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
      }
      return undefined
    }
    if (Object.keys(message.result).sort().join('\0')
      !== ['approvalBinding', 'found', 'grant', 'sessionId'].join('\0')
      || typeof message.result.sessionId !== 'string' || !SAFE_ID.test(message.result.sessionId)) {
      throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
    }
    return {
      ...parseFinalizedApproval({
        grant: message.result.grant,
        approvalBinding: message.result.approvalBinding,
      }),
      sessionId: message.result.sessionId,
    }
  })
}

function callActivateControl(
  child: ChildProcess,
  input: { grant: SignedGrant; approvalBinding: ApprovalExecutionBinding },
  terminalSignal: Promise<never>,
): Promise<void> {
  const parsedGrant = SignedGrantSchema.safeParse(input.grant)
  if (!parsedGrant.success) throw hostError('E2E_APPROVAL_GRANT_INVALID')
  return callChildControl(child, 'activate-grant', {
    grant: parsedGrant.data,
    approvalBinding: parseApprovalExecutionBinding(input.approvalBinding),
  }, 'grant-activated', terminalSignal, (message) => {
    if (Object.keys(message).sort().join('\0') !== ['requestId', 'result', 'type'].join('\0')
      || !isObject(message.result)
      || Object.keys(message.result).join('\0') !== 'activated'
      || message.result.activated !== true) throw hostError('E2E_APPROVAL_ACTIVATE_RESULT_INVALID')
  })
}

function callAcknowledgeControl(
  child: ChildProcess,
  input: ApprovalFinalizationAcknowledgement,
  terminalSignal: Promise<never>,
): Promise<void> {
  const acknowledgement = ApprovalFinalizationAcknowledgementSchema.safeParse(input)
  if (!acknowledgement.success) throw hostError('E2E_APPROVAL_FINALIZATION_INVALID')
  return callChildControl(child, 'ack-finalization', {
    ...acknowledgement.data,
  }, 'finalization-acknowledged', terminalSignal, (message) => {
    if (Object.keys(message).sort().join('\0') !== ['requestId', 'result', 'type'].join('\0')
      || !isObject(message.result) || Object.keys(message.result).join('\0') !== 'acknowledged'
      || message.result.acknowledged !== true) throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
  })
}

function callChildControl<T>(
  child: ChildProcess,
  type: string,
  input: unknown,
  resultType: string,
  terminalSignal: Promise<never>,
  parse: (message: Record<string, any>) => T,
): Promise<T> {
  const control = new Promise<T>((resolve, reject) => {
    const requestId = randomBytes(16).toString('hex')
    const timeout = setTimeout(() => finishReject(hostError('E2E_RPC_HOST_CONTROL_TIMEOUT')), HOST_START_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('error', finishReject)
    }
    const finishReject = (error: unknown) => { cleanup(); reject(error) }
    const onMessage = (message: unknown) => {
      if (!isObject(message) || message.requestId !== requestId) return
      if (message.type === 'control-error') {
        if (Object.keys(message).sort().join('\0') !== ['code', 'requestId', 'type'].join('\0')
          || typeof message.code !== 'string' || !SAFE_ERROR_CODE.test(message.code)) {
          finishReject(hostError('E2E_RPC_HOST_CONTROL_RESULT_INVALID')); return
        }
        finishReject(hostError(message.code)); return
      }
      if (message.type !== resultType) return
      try { const result = parse(message); cleanup(); resolve(result) }
      catch (error) { finishReject(error) }
    }
    child.on('message', onMessage)
    child.once('error', finishReject)
    child.send({ type, requestId, input }, (error) => { if (error) finishReject(error) })
  })
  return Promise.race([control, terminalSignal])
}

function parseFinalizedApproval(
  value: Record<string, any>,
): { grant: SignedGrant; approvalBinding: ApprovalExecutionBinding } {
  if (Object.keys(value).sort().join('\0') !== ['approvalBinding', 'grant'].join('\0')
    || !isObject(value.grant)) {
    throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
  }
  const grant = SignedGrantSchema.safeParse(value.grant)
  let approvalBinding: ApprovalExecutionBinding
  try { approvalBinding = parseApprovalExecutionBinding(value.approvalBinding) }
  catch { throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID') }
  if (!grant.success
    || approvalBinding.runId !== grant.data.approvalContext.runId
    || approvalBinding.installationDigest !== grant.data.approvalContext.installationDigest
    || approvalBinding.approvalType !== grant.data.approvalContext.approvalType
    || approvalBinding.subjectDigest !== grant.data.approvalContext.subjectDigest) {
    throw hostError('E2E_APPROVAL_FINALIZE_RESULT_INVALID')
  }
  return { grant: structuredClone(grant.data) as SignedGrant, approvalBinding }
}

function validateFinalizationControl(finalizationId: string, requestDigest: string): void {
  if (!SAFE_ID.test(finalizationId) || !/^sha256:[a-f0-9]{64}$/.test(requestDigest)) {
    throw hostError('E2E_APPROVAL_FINALIZATION_INVALID')
  }
}

function validateOptions(options: AuthorityExecutionRpcHostOptions): void {
  if (!SAFE_ID.test(options.rpc.issuer) || !SAFE_ID.test(options.rpc.keyId) || !SAFE_ID.test(options.rpc.clientId)
    || !SAFE_ID.test(options.approval.issuer) || !SAFE_ID.test(options.approval.keyId)
    || options.approval.stateEncryptionKey.byteLength !== 32
    || !options.approval.statePath || !options.lease.statePath
    || options.approval.testWorkspaceRoots.length === 0 || options.lease.testWorkspaceRoots.length === 0
    || (options.clock?.kind === 'fixed-test-only' && !isCanonicalInstant(options.clock.now))
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
