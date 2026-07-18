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
import { AuthorityExecutionControlQueue } from './authority-execution-control-queue.js'
import { registerAuthenticatedRpcClientFromConfig } from './authority-rpc-session-key.js'
import {
  parseAuthorityExecutionIncomingEnvelope,
  parseAuthorityExecutionHostConfig,
  parseManualResultRoleFinalizationInput,
  parseManualResultRoleRecoveryInput,
  type AuthorityExecutionHostConfig as HostConfig,
} from './authority-execution-rpc-host-ipc.js'
import {
  ApprovalFinalizationAcknowledgementSchema,
  ApprovalGrantSubjectSchema,
  DecisionSubjectSchema,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
  digestDecisionSubject,
  SignedGrantSchema,
  type ApprovalGrantSubject,
  type CanonicalApprovalContext,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
import {
  parseApprovalExecutionBinding,
  type ApprovalExecutionBinding,
} from './trusted-execution-clients.js'

type EncodedApprovalAssets = NonNullable<HostConfig['userPresence']>['assets']

let approvalAuthority: LocalApprovalAuthority | undefined
let leaseAuthority: LocalLeaseAuthority | undefined
let httpHandle: Awaited<ReturnType<typeof startAuthenticatedRpcLoopbackServer>> | undefined
let executionRpc: AuthenticatedRpcServer | undefined
let webAuthnAuthority: WebAuthnUserPresenceAuthority | undefined
const approvalServers = new Map<string, WebAuthnApprovalServerHandle>()
const approvalControls = new Map<string, {
  runId: string
  approvalType: WebAuthnApprovalType
  subjectDigest: string
  installationDigest: string
  completed: boolean
}>()
let hostConfig: HostConfig | undefined
let started = false
const controlQueue = new AuthorityExecutionControlQueue()

process.on('message', async (incoming: unknown) => {
  const message = parseAuthorityExecutionIncomingEnvelope(incoming)
  if (message === undefined) return
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
    await controlQueue.run(async () => await handleFinalizeApproval(message))
    return
  }
  if (message.type === 'finalize-decision') {
    await controlQueue.run(async () => await handleFinalizeDecision(message))
    return
  }
  if (message.type === 'prepare-manual-result') {
    await controlQueue.run(async () => await handlePrepareManualResult(message))
    return
  }
  if (message.type === 'finalize-manual-result-role') {
    await controlQueue.run(async () => await handleFinalizeManualResultRole(message))
    return
  }
  if (message.type === 'recover-manual-result-role') {
    await controlQueue.run(async () => await handleRecoverManualResultRole(message))
    return
  }
  if (message.type === 'recover-approval') {
    await controlQueue.run(async () => await handleRecoverApproval(message))
    return
  }
  if (message.type === 'activate-grant') {
    await controlQueue.run(async () => await handleActivateGrant(message))
    return
  }
  if (message.type === 'activate-recovery-grant') {
    await controlQueue.run(async () => await handleActivateRecoveryGrant(message))
    return
  }
  if (message.type === 'ack-finalization') {
    await controlQueue.run(async () => await handleAcknowledgeFinalization(message))
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
        authenticateManualApproverSession: async (sessionId, _expected) => {
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
    registerAuthenticatedRpcClientFromConfig(rpc, config)
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: approvalAuthority,
      leaseAuthority,
      gatewayAuthority: approvalAuthority,
      readAuthority: approvalAuthority,
      discoveryAuthority: approvalAuthority,
      reservationAuthority: approvalAuthority,
      injectionAuthority: approvalAuthority,
      webSocketAuthority: approvalAuthority,
      sseAuthority: approvalAuthority,
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
      process.exitCode = 1
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
  await controlQueue.drain()
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
      ? parseEnrollmentInput(message.input, hostConfig.approval.approvalIdentities,
        hostConfig.approval.manualIdentities)
      : parseApprovalInput(message.input, hostConfig.userPresence.installationDigest)
    const server = await startWebAuthnApprovalServer({
      authority: webAuthnAuthority,
      assets,
      ttlMs: hostConfig.userPresence.ttlMs,
      session: control,
    })
    approvalServers.set(server.sessionId, server)
    if (control.kind === 'approval') {
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

async function handlePrepareManualResult(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    if (!approvalAuthority || !isObject(message.input)
      || Object.keys(message.input).sort().join('\0') !== ['draft', 'finalizationId', 'requestDigest'].join('\0')
      || typeof message.input.finalizationId !== 'string' || typeof message.input.requestDigest !== 'string') {
      throw rpcHostError('E2E_MANUAL_RESULT_PREPARE_INPUT_INVALID')
    }
    const result = await approvalAuthority.prepareManualResult({ draft: message.input.draft,
      finalizationId: message.input.finalizationId, requestDigest: message.input.requestDigest })
    sendToParent({ type: 'manual-result-prepared', requestId, result })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleRecoverManualResultRole(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    const input = parseManualResultRoleRecoveryInput(message.input)
    if (!approvalAuthority || input === undefined) {
      throw rpcHostError('E2E_MANUAL_RESULT_FINALIZATION_INVALID')
    }
    const result = await approvalAuthority.recoverManualResultRole(input)
    sendToParent({ type: 'manual-result-role-recovered', requestId, result: result ?? null })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleFinalizeManualResultRole(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    const input = parseManualResultRoleFinalizationInput(message.input)
    if (!approvalAuthority || input === undefined) {
      throw rpcHostError('E2E_MANUAL_RESULT_FINALIZATION_INVALID')
    }
    const result = await approvalAuthority.finalizeManualResultRole(input)
    approvalControls.delete(input.approvalSessionRef)
    sendToParent({ type: 'manual-result-role-finalized', requestId, result })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleFinalizeDecision(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    if (!isObject(message.input)
      || Object.keys(message.input).sort().join('\0')
        !== ['decisionId', 'decisionSubject', 'sessionId'].join('\0')
      || typeof message.input.sessionId !== 'string'
      || typeof message.input.decisionId !== 'string') {
      throw rpcHostError('E2E_APPROVAL_DECISION_INPUT_INVALID')
    }
    const subject = DecisionSubjectSchema.parse(message.input.decisionSubject)
    const pending = approvalControls.get(message.input.sessionId)
    if (!pending || !pending.completed || !approvalAuthority || !hostConfig?.userPresence
      || !['scope', 'lineage'].includes(pending.approvalType)
      || pending.approvalType !== subject.kind
      || pending.subjectDigest !== digestDecisionSubject(subject)
      || pending.installationDigest !== hostConfig.userPresence.installationDigest) {
      throw rpcHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    }
    const requiredRole = `${subject.kind}-approver`
    const approvers = hostConfig.approval.manualIdentities?.filter((identity) =>
      identity.roles.includes(requiredRole)) ?? []
    if (approvers.length !== 1) throw rpcHostError('E2E_APPROVAL_DECISION_APPROVER_UNAVAILABLE')
    const receipt = approvalAuthority.issueDecisionReceipt({
      kind: subject.kind,
      decisionId: message.input.decisionId,
      decisionStatus: 'approved',
      decisionSubject: subject,
      approver: approvers[0]!,
    })
    approvalControls.delete(message.input.sessionId)
    sendToParent({ type: 'decision-finalized', requestId, result: receipt })
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
    try { registerApprovalGrant(executionRpc, hostConfig, grant.approvalContext) }
    catch {
      throw rpcHostError('E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED')
    }
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
    const approvalBinding = parseApprovalExecutionBinding(message.input.approvalBinding)
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
    try { registerApprovalGrant(executionRpc, hostConfig, context) }
    catch {
      throw rpcHostError('E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED')
    }
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
    const approvalBinding = parseApprovalExecutionBinding(message.input.approvalBinding)
    const context = await approvalAuthority.activatePersistedGrant({
      grant: parsed.data as SignedGrant, approvalBinding,
    })
    registerApprovalGrant(executionRpc, hostConfig, context)
    sendToParent({ type: 'grant-activated', requestId, result: { activated: true } })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleActivateRecoveryGrant(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    if (!isObject(message.input)
      || Object.keys(message.input).sort().join('\0') !== ['approvalBinding', 'grant'].join('\0')
      || !approvalAuthority || !executionRpc || !hostConfig) throw rpcHostError('E2E_APPROVAL_GRANT_INVALID')
    const parsed = SignedGrantSchema.safeParse(message.input.grant)
    if (!parsed.success) throw rpcHostError('E2E_APPROVAL_GRANT_INVALID')
    const approvalBinding = parseApprovalExecutionBinding(message.input.approvalBinding)
    if (approvalBinding.approvalType !== 'execution') throw rpcHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    const context = await approvalAuthority.activatePersistedGrantForRecovery({
      grant: parsed.data as SignedGrant, approvalBinding,
    })
    registerApprovalGrant(executionRpc, hostConfig, context, true)
    sendToParent({ type: 'recovery-grant-activated', requestId, result: { activated: true } })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

async function handleAcknowledgeFinalization(message: Record<string, any>): Promise<void> {
  const requestId = parseControlRequestId(message)
  if (requestId === undefined) return
  try {
    const acknowledgement = ApprovalFinalizationAcknowledgementSchema.safeParse(message.input)
    if (!acknowledgement.success || !approvalAuthority) {
      throw rpcHostError('E2E_APPROVAL_FINALIZATION_INVALID')
    }
    await approvalAuthority.acknowledgeFinalizedGrant(acknowledgement.data)
    sendToParent({ type: 'finalization-acknowledged', requestId, result: { acknowledged: true } })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

function parseControlRequestId(message: Record<string, any>): string | undefined {
  return typeof message.requestId === 'string' && /^[a-f0-9]{32}$/.test(message.requestId)
    ? message.requestId : undefined
}

function registerApprovalGrant(
  rpc: AuthenticatedRpcServer,
  config: HostConfig,
  context: CanonicalApprovalContext,
  recoveryOnly = false,
): void {
  rpc.updateClientRegistration(config.rpc.clientId, {
    approvalContext: context,
    ...(recoveryOnly ? { recoveryOnly: true } : {}),
  })
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
  manualIdentities: HostConfig['approval']['manualIdentities'],
): { kind: 'enrollment'; subject: string } {
  if (!isObject(value) || Object.keys(value).join('\0') !== 'subject'
    || typeof value.subject !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.subject)) {
    throw rpcHostError('E2E_APPROVAL_ENROLLMENT_INPUT_INVALID')
  }
  const isApprovalIdentity = identities?.some((identity) => identity.subject === value.subject
    && identity.roles.includes('e2e-approver')) === true
  const isManualIdentity = manualIdentities?.some((identity) => identity.subject === value.subject
    && (identity.roles.includes('e2e-manual-executor')
      || identity.roles.includes('e2e-manual-reviewer'))) === true
  if (!isApprovalIdentity && !isManualIdentity) {
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
  const approvalTypes: WebAuthnApprovalType[] = [
    'scope', 'lineage', 'discovery', 'execution', 'privacy', 'manual-executor', 'manual-reviewer',
  ]
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
  if (isObject(error) && (error.code === 'EPERM' || error.code === 'EACCES')) {
    return 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED'
  }
  if (isObject(error) && typeof error.code === 'string' && /^E2E_[A-Z0-9_]{1,252}$/.test(error.code)) {
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
