import { LocalApprovalAuthority } from './local-approval-authority.js'
import { LocalLeaseAuthority } from './local-lease-authority.js'
import { AuthenticatedRpcServer, startAuthenticatedRpcLoopbackServer } from './authenticated-rpc.js'
import { registerAuthorityExecutionRpcOperations } from './authority-execution-rpc.js'
import {
  startWebAuthnApprovalServer,
  type WebAuthnApprovalServerHandle,
} from './webauthn-approval-server.js'
import {
  createWebAuthnUserPresenceAuthority,
  type WebAuthnApprovalType,
  type WebAuthnUserPresenceAuthority,
} from './webauthn-user-presence.js'
import {
  authorityHostCleanupFailurePayload,
  closeAuthorityExecutionRpcHostResources,
} from './authority-execution-rpc-host-lifecycle.js'
import {
  parseAuthorityExecutionHostConfig,
  type AuthorityExecutionHostConfig as HostConfig,
} from './authority-execution-rpc-host-ipc.js'
import {
  ApprovalGrantSubjectSchema,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
  SignedGrantSchema,
  type ApprovalGrantSubject,
  type CanonicalApprovalContext,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
import type { TrustedApprovalExecutionBinding } from './trusted-execution-clients.js'

type EncodedApprovalAssets = NonNullable<HostConfig['userPresence']>['assets']

let approvalAuthority: LocalApprovalAuthority | undefined
let leaseAuthority: LocalLeaseAuthority | undefined
let httpHandle: Awaited<ReturnType<typeof startAuthenticatedRpcLoopbackServer>> | undefined
let executionRpc: AuthenticatedRpcServer | undefined
let webAuthnAuthority: WebAuthnUserPresenceAuthority | undefined
const approvalServers = new Map<string, WebAuthnApprovalServerHandle>()
const approvalControls = new Map<string, {
  runId: string
  approvalType: 'discovery' | 'execution'
  subjectDigest: string
  installationDigest: string
  completed: boolean
}>()
let hostConfig: HostConfig | undefined
let started = false
let controlTail = Promise.resolve()

process.on('message', async (message: unknown) => {
  if (!isObject(message)) return
  if (message.type === 'shutdown') {
    const requestId = parseControlRequestId(message)
    if (requestId === undefined) return
    try {
      await shutdown()
      await sendToParentAndWait({ type: 'shutdown-result', requestId, ok: true })
    } catch (error) {
      await sendToParentAndWait({
        type: 'shutdown-result', requestId, ok: false, error: authorityHostCleanupFailurePayload(error),
      })
    } finally {
      if (process.connected) process.disconnect()
    }
    return
  }
  if (message.type === 'enroll-identity' || message.type === 'open-approval-session') {
    await handleUserPresenceControl(message)
    return
  }
  if (message.type === 'finalize-approval') {
    await serializeControl(async () => await handleFinalizeApproval(message))
    return
  }
  if (message.type === 'recover-approval') {
    await serializeControl(async () => await handleRecoverApproval(message))
    return
  }
  if (message.type === 'activate-grant') {
    await serializeControl(async () => await handleActivateGrant(message))
    return
  }
  if (message.type !== 'start' || started) return
  started = true
  try {
    const config = parseAuthorityExecutionHostConfig(message.config)
    hostConfig = config
    const fixedNow = config.clock.kind === 'fixed-test-only' ? config.clock.now : undefined
    const now = fixedNow === undefined ? () => new Date() : () => new Date(fixedNow)
    const stateEncryptionKey = decode32(config.approval.stateEncryptionKeyBase64Url)
    config.approval.stateEncryptionKeyBase64Url = ''
    try {
      approvalAuthority = await LocalApprovalAuthority.open({
        issuer: config.approval.issuer, keyId: config.approval.keyId, now,
        statePath: config.approval.statePath,
        stateEncryptionKey,
        ...(config.approval.expectedStateDirectory === undefined
          ? {} : { expectedStateDirectory: config.approval.expectedStateDirectory }),
        testWorkspaceRoots: config.approval.testWorkspaceRoots,
        approvalIdentities: config.approval.approvalIdentities,
        manualIdentities: config.approval.manualIdentities,
        authenticateApproverSession: async (sessionId, _expected) => {
          return await webAuthnAuthority?.authenticateSession(sessionId)
        },
      })
    } finally { stateEncryptionKey.fill(0) }
    leaseAuthority = await LocalLeaseAuthority.open({
      now, statePath: config.lease.statePath, testWorkspaceRoots: config.lease.testWorkspaceRoots,
      ...(config.lease.expectedStateDirectory === undefined
        ? {} : { expectedStateDirectory: config.lease.expectedStateDirectory }),
    })
    if (config.userPresence !== undefined) {
      webAuthnAuthority = createWebAuthnUserPresenceAuthority({
        now,
        credentialRepository: approvalAuthority.createWebAuthnCredentialRepository(),
      })
    }
    const rpc = AuthenticatedRpcServer.create({ issuer: config.rpc.issuer, keyId: config.rpc.keyId, now })
    executionRpc = rpc
    const sessionKey = decode32(config.sessionKeyBase64Url)
    config.sessionKeyBase64Url = ''
    rpc.registerClient(config.rpc.clientId, sessionKey)
    sessionKey.fill(0)
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: approvalAuthority,
      leaseAuthority: leaseAuthority.createExecutionClient(),
      gatewayAuthority: approvalAuthority,
    })
    httpHandle = await startAuthenticatedRpcLoopbackServer(rpc)
    sendToParent({ type: 'ready', endpoint: httpHandle.endpoint, verifierMaterial: rpc.verifierMaterial })
  } catch (error) {
    let cleanup: { ok: true } | {
      ok: false
      error: ReturnType<typeof authorityHostCleanupFailurePayload>
    }
    try { await shutdown(); cleanup = { ok: true } }
    catch (cleanupError) {
      cleanup = { ok: false, error: authorityHostCleanupFailurePayload(cleanupError) }
    }
    try {
      await sendToParentAndWait({ type: 'startup-error', code: safeCode(error), cleanup })
    } finally {
      if (process.connected) process.disconnect()
    }
  }
})

process.once('disconnect', () => {
  void shutdown().catch(() => { process.exitCode = 1 })
})
process.once('SIGTERM', () => {
  void (async () => {
    try { await shutdown() }
    catch (error) {
      process.exitCode = 1
      await sendToParentAndWait({
        type: 'terminal-cleanup-error', error: authorityHostCleanupFailurePayload(error),
      })
    } finally { process.exit(process.exitCode ?? 0) }
  })()
})

async function shutdown(): Promise<void> {
  await controlTail.catch(() => undefined)
  const servers = [...approvalServers.values()]
  approvalServers.clear()
  approvalControls.clear()
  const resources = {
    webAuthnAuthority,
    approvalServers: servers,
    httpHandle,
    executionRpc,
    approvalAuthority,
    leaseAuthority,
  }
  httpHandle = undefined
  approvalAuthority = undefined
  leaseAuthority = undefined
  executionRpc = undefined
  webAuthnAuthority = undefined
  hostConfig = undefined
  await closeAuthorityExecutionRpcHostResources(resources)
}

async function handleUserPresenceControl(message: Record<string, any>): Promise<void> {
  const requestId = typeof message.requestId === 'string' && /^[a-f0-9]{32}$/.test(message.requestId)
    ? message.requestId
    : undefined
  if (requestId === undefined) return
  try {
    if (!started || webAuthnAuthority === undefined || hostConfig?.userPresence === undefined) {
      throw rpcHostError('E2E_APPROVAL_AUTHORITY_NOT_CONFIGURED')
    }
    const assets = decodeApprovalAssets(hostConfig.userPresence.assets)
    const control = message.type === 'enroll-identity'
      ? parseEnrollmentInput(message.input, hostConfig.approval.approvalIdentities)
      : parseApprovalInput(message.input, hostConfig.userPresence.installationDigest)
    const server = await startWebAuthnApprovalServer({
      authority: webAuthnAuthority,
      assets,
      ttlMs: hostConfig.userPresence.ttlMs,
      session: control,
    })
    approvalServers.set(server.sessionId, server)
    if (control.kind === 'approval' && (control.approvalType === 'discovery' || control.approvalType === 'execution')) {
      approvalControls.set(server.sessionId, {
        runId: control.runId, approvalType: control.approvalType,
        subjectDigest: control.subjectDigest, installationDigest: control.installationDigest,
        completed: false,
      })
    }
    void server.completion.then(async (result) => {
      if (result.completed) {
        const pending = approvalControls.get(server.sessionId)
        if (pending) pending.completed = true
        sendToParent({ type: 'session-finished', sessionId: server.sessionId })
      }
      else {
        approvalControls.delete(server.sessionId)
        sendToParent({ type: 'session-failed', sessionId: server.sessionId, code: result.code })
      }
      approvalServers.delete(server.sessionId)
      await server.close().catch(() => undefined)
    })
    sendToParent({ type: 'session-opened', requestId, url: server.url, sessionId: server.sessionId })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleFinalizeApproval(message: Record<string, any>): Promise<void> {
  const requestId = typeof message.requestId === 'string' && /^[a-f0-9]{32}$/.test(message.requestId)
    ? message.requestId : undefined
  if (requestId === undefined) return
  try {
    if (!isObject(message.input)
      || Object.keys(message.input).sort().join('\0')
        !== ['finalizationId', 'grantSubject', 'requestDigest', 'sessionId'].join('\0')
      || typeof message.input.sessionId !== 'string'
      || typeof message.input.finalizationId !== 'string'
      || typeof message.input.requestDigest !== 'string') throw rpcHostError('E2E_APPROVAL_FINALIZE_INPUT_INVALID')
    const parsedSubject = ApprovalGrantSubjectSchema.safeParse(message.input.grantSubject)
    if (!parsedSubject.success) throw rpcHostError('E2E_APPROVAL_FINALIZE_INPUT_INVALID')
    const subject = parsedSubject.data
    const pending = approvalControls.get(message.input.sessionId)
    if (!pending || !pending.completed || !approvalAuthority || !hostConfig?.userPresence) {
      throw rpcHostError('E2E_APPROVAL_SESSION_INVALID')
    }
    if (canonicalGrantApprovalType(subject) !== pending.approvalType
      || canonicalGrantApprovalSubjectDigest(subject) !== pending.subjectDigest
      || pending.installationDigest !== hostConfig.userPresence.installationDigest) {
      throw rpcHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    }
    if (executionRpc === undefined) throw rpcHostError('E2E_RPC_HOST_START_FAILED')
    const approvalBinding = {
      runId: pending.runId, installationDigest: pending.installationDigest,
      approvalType: pending.approvalType, subjectDigest: pending.subjectDigest,
    }
    const grant = await approvalAuthority.finalizeApprovalGrant({
      subject,
      approvalSessionRef: message.input.sessionId,
      ttlMs: Math.min(60_000, hostConfig.userPresence.ttlMs),
      finalizationId: message.input.finalizationId,
      requestDigest: message.input.requestDigest,
      approvalBinding,
    })
    registerApprovalGrant(executionRpc, hostConfig, grant.approvalContext)
    approvalControls.delete(message.input.sessionId)
    sendToParent({ type: 'approval-finalized', requestId, result: { grant, approvalBinding } })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleRecoverApproval(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    if (!isObject(message.input)
      || Object.keys(message.input).sort().join('\0')
        !== ['approvalBinding', 'finalizationId', 'grantSubject', 'requestDigest'].join('\0')
      || typeof message.input.finalizationId !== 'string'
      || typeof message.input.requestDigest !== 'string') throw rpcHostError('E2E_APPROVAL_FINALIZE_INPUT_INVALID')
    if (!approvalAuthority || !executionRpc || !hostConfig) throw rpcHostError('E2E_RPC_HOST_START_FAILED')
    const subject = ApprovalGrantSubjectSchema.parse(message.input.grantSubject)
    const approvalBinding = parseApprovalBinding(message.input.approvalBinding)
    const recovered = await approvalAuthority.recoverFinalizedGrant({
      finalizationId: message.input.finalizationId,
      requestDigest: message.input.requestDigest,
      subject,
      approvalBinding,
    })
    if (recovered === undefined) {
      sendToParent({ type: 'approval-recovered', requestId, result: { found: false } })
      return
    }
    const context = await approvalAuthority.activatePersistedGrant({ grant: recovered.grant, approvalBinding })
    registerApprovalGrant(executionRpc, hostConfig, context)
    sendToParent({ type: 'approval-recovered', requestId, result: {
      found: true, grant: recovered.grant, approvalBinding, sessionId: recovered.approvalSessionRef,
    } })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleActivateGrant(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    if (!isObject(message.input)
      || Object.keys(message.input).sort().join('\0') !== ['approvalBinding', 'grant'].join('\0')
      || !approvalAuthority || !executionRpc || !hostConfig) throw rpcHostError('E2E_APPROVAL_GRANT_INVALID')
    const parsed = SignedGrantSchema.safeParse(message.input.grant)
    if (!parsed.success) throw rpcHostError('E2E_APPROVAL_GRANT_INVALID')
    const approvalBinding = parseApprovalBinding(message.input.approvalBinding)
    const context = await approvalAuthority.activatePersistedGrant({
      grant: parsed.data as SignedGrant, approvalBinding,
    })
    registerApprovalGrant(executionRpc, hostConfig, context)
    sendToParent({ type: 'grant-activated', requestId, result: { activated: true } })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function serializeControl<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlTail.then(operation, operation)
  controlTail = result.then(() => undefined, () => undefined)
  return await result
}

function parseControlRequestId(message: Record<string, any>): string | undefined {
  return typeof message.requestId === 'string' && /^[a-f0-9]{32}$/.test(message.requestId)
    ? message.requestId : undefined
}

function parseApprovalBinding(value: unknown): TrustedApprovalExecutionBinding {
  if (!isObject(value)
    || Object.keys(value).sort().join('\0')
      !== ['approvalType', 'installationDigest', 'runId', 'subjectDigest'].join('\0')
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.runId)
    || (value.approvalType !== 'discovery' && value.approvalType !== 'execution')
    || typeof value.subjectDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.subjectDigest)
    || typeof value.installationDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.installationDigest)) {
    throw rpcHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
  }
  return structuredClone(value) as TrustedApprovalExecutionBinding
}

function registerApprovalGrant(
  rpc: AuthenticatedRpcServer,
  config: HostConfig,
  context: CanonicalApprovalContext,
): void {
  rpc.updateClientRegistration(config.rpc.clientId, { approvalContext: context })
}

function sendToParent(message: Record<string, unknown>): void {
  if (!process.connected || process.send === undefined) return
  try { process.send(message, () => undefined) } catch { /* parent 已退出，shutdown 会清理 session */ }
}

function sendToParentAndWait(message: Record<string, unknown>): Promise<void> {
  if (!process.connected || process.send === undefined) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 250)
    const finish = () => { clearTimeout(timeout); resolve() }
    try { process.send!(message, finish) }
    catch { finish() }
  })
}

function parseEnrollmentInput(
  value: unknown,
  identities: HostConfig['approval']['approvalIdentities'],
): { kind: 'enrollment'; subject: string } {
  if (!isObject(value) || Object.keys(value).join('\0') !== 'subject'
    || typeof value.subject !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.subject)) {
    throw rpcHostError('E2E_APPROVAL_ENROLLMENT_INPUT_INVALID')
  }
  if (!identities?.some((identity) => identity.subject === value.subject
    && identity.roles.includes('e2e-approver'))) {
    throw rpcHostError('E2E_APPROVAL_ENROLLMENT_SUBJECT_UNTRUSTED')
  }
  return { kind: 'enrollment', subject: value.subject }
}

function parseApprovalInput(
  value: unknown,
  installationDigest: string,
): {
  kind: 'approval'
  runId: string
  approvalType: WebAuthnApprovalType
  subjectDigest: string
  installationDigest: string
} {
  const approvalTypes: WebAuthnApprovalType[] = ['scope', 'lineage', 'discovery', 'execution', 'privacy']
  if (!isObject(value)
    || Object.keys(value).sort().join('\0')
      !== ['approvalType', 'installationDigest', 'runId', 'subjectDigest'].join('\0')
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.runId)
    || !approvalTypes.includes(value.approvalType)
    || typeof value.subjectDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.subjectDigest)
    || value.installationDigest !== installationDigest) {
    throw rpcHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
  }
  return {
    kind: 'approval', runId: value.runId, approvalType: value.approvalType,
    subjectDigest: value.subjectDigest, installationDigest,
  }
}

function decodeApprovalAssets(value: EncodedApprovalAssets) {
  return {
    indexHtml: decodeBounded(value.indexHtmlBase64Url, 256 * 1024),
    approvalJavaScript: decodeBounded(value.approvalJavaScriptBase64Url, 256 * 1024),
    simpleWebAuthnBrowser: decodeBounded(value.simpleWebAuthnBrowserBase64Url, 2 * 1024 * 1024),
  }
}

function decodeBounded(value: string, maximum: number): Buffer {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength === 0 || bytes.byteLength > maximum || bytes.toString('base64url') !== value) {
    throw rpcHostError('E2E_APPROVAL_ASSET_INVALID')
  }
  return bytes
}

function decode32(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    throw rpcHostError('E2E_RPC_HOST_KEY_INVALID')
  }
  return bytes
}

function safeCode(error: unknown): string {
  if (isObject(error) && typeof error.code === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(error.code)) {
    return error.code
  }
  return 'E2E_RPC_HOST_START_FAILED'
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rpcHostError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
