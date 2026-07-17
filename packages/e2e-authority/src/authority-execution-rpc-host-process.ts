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
import type { SqliteStateDirectoryIdentity } from './sqlite-state-store.js'
import type { CanonicalApprovalContext } from '@mutil-skills/e2e-contracts'

interface HostConfig {
  rpc: { issuer: string; keyId: string; clientId: string }
  approval: {
    issuer: string; keyId: string; statePath: string; stateEncryptionKeyBase64Url: string
    testWorkspaceRoots: string[]
    expectedStateDirectory?: SqliteStateDirectoryIdentity
    approvalIdentities?: Array<{ subject: string; roles: string[] }>
    manualIdentities?: Array<{ subject: string; roles: string[] }>
  }
  lease: {
    statePath: string
    testWorkspaceRoots: string[]
    expectedStateDirectory?: SqliteStateDirectoryIdentity
  }
  userPresence?: {
    installationDigest: string
    ttlMs: number
    assets: {
      indexHtmlBase64Url: string
      approvalJavaScriptBase64Url: string
      simpleWebAuthnBrowserBase64Url: string
    }
  }
  clock: { kind: 'system' } | { kind: 'fixed-test-only'; now: string }
  testOnlyApprovalContext?: CanonicalApprovalContext
  sessionKeyBase64Url: string
}

type EncodedApprovalAssets = NonNullable<HostConfig['userPresence']>['assets']

let approvalAuthority: LocalApprovalAuthority | undefined
let leaseAuthority: LocalLeaseAuthority | undefined
let httpHandle: Awaited<ReturnType<typeof startAuthenticatedRpcLoopbackServer>> | undefined
let executionRpc: AuthenticatedRpcServer | undefined
let webAuthnAuthority: WebAuthnUserPresenceAuthority | undefined
const approvalServers = new Map<string, WebAuthnApprovalServerHandle>()
let hostConfig: HostConfig | undefined
let started = false

process.on('message', async (message: unknown) => {
  if (!isObject(message)) return
  if (message.type === 'shutdown') {
    await shutdown()
    process.disconnect()
    return
  }
  if (message.type === 'enroll-identity' || message.type === 'open-approval-session') {
    await handleUserPresenceControl(message)
    return
  }
  if (message.type !== 'start' || started) return
  started = true
  try {
    const config = parseConfig(message.config)
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
          const receipt = await webAuthnAuthority?.authenticateSession(sessionId)
          if (receipt !== undefined) {
            if (executionRpc === undefined) throw rpcHostError('E2E_RPC_HOST_START_FAILED')
            executionRpc.updateClientRegistration(config.rpc.clientId, {
              approvalContext: { schemaVersion: '1.0.0', ...receipt },
            })
          }
          return receipt
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
    rpc.registerClient(config.rpc.clientId, sessionKey, config.testOnlyApprovalContext === undefined
      ? null : { approvalContext: config.testOnlyApprovalContext })
    sessionKey.fill(0)
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: approvalAuthority,
      leaseAuthority: leaseAuthority.createExecutionClient(),
      gatewayAuthority: approvalAuthority,
    })
    httpHandle = await startAuthenticatedRpcLoopbackServer(rpc)
    sendToParent({ type: 'ready', endpoint: httpHandle.endpoint, verifierMaterial: rpc.verifierMaterial })
  } catch (error) {
    sendToParent({ type: 'error', code: safeCode(error) })
    await shutdown()
    process.disconnect()
  }
})

process.once('disconnect', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })

async function shutdown(): Promise<void> {
  webAuthnAuthority?.revokePendingSessions()
  const servers = [...approvalServers.values()]
  approvalServers.clear()
  await Promise.allSettled(servers.map(async (server) => await server.close()))
  const handle = httpHandle
  httpHandle = undefined
  await handle?.close()
  approvalAuthority?.close()
  leaseAuthority?.close()
  approvalAuthority = undefined
  leaseAuthority = undefined
  executionRpc = undefined
  webAuthnAuthority = undefined
  hostConfig = undefined
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
    void server.completion.then(async (result) => {
      if (result.completed) sendToParent({ type: 'session-finished', sessionId: server.sessionId })
      else sendToParent({ type: 'session-failed', sessionId: server.sessionId, code: result.code })
      approvalServers.delete(server.sessionId)
      await server.close().catch(() => undefined)
    })
    sendToParent({ type: 'session-opened', requestId, url: server.url, sessionId: server.sessionId })
  } catch (error) {
    sendToParent({ type: 'control-error', requestId, code: safeCode(error) })
  }
}

function sendToParent(message: Record<string, unknown>): void {
  if (!process.connected || process.send === undefined) return
  try { process.send(message, () => undefined) } catch { /* parent 已退出，shutdown 会清理 session */ }
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

function parseConfig(value: unknown): HostConfig {
  if (!isObject(value) || !isObject(value.rpc) || !isObject(value.approval) || !isObject(value.lease)
    || !isObject(value.clock) || typeof value.sessionKeyBase64Url !== 'string') {
    throw rpcHostError('E2E_RPC_HOST_CONFIG_INVALID')
  }
  return structuredClone(value) as unknown as HostConfig
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
