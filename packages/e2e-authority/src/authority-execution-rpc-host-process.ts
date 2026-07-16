import { LocalApprovalAuthority } from './local-approval-authority.js'
import { LocalLeaseAuthority } from './local-lease-authority.js'
import { AuthenticatedRpcServer, startAuthenticatedRpcLoopbackServer } from './authenticated-rpc.js'
import { registerAuthorityExecutionRpcOperations } from './authority-execution-rpc.js'

interface HostConfig {
  rpc: { issuer: string; keyId: string; clientId: string }
  approval: {
    issuer: string; keyId: string; statePath: string; stateEncryptionKeyBase64Url: string
    testWorkspaceRoots: string[]
    approvalIdentities?: Array<{ subject: string; roles: string[] }>
    manualIdentities?: Array<{ subject: string; roles: string[] }>
  }
  lease: { statePath: string; testWorkspaceRoots: string[] }
  clock: { kind: 'system' } | { kind: 'fixed-test-only'; now: string }
  sessionKeyBase64Url: string
}

let approvalAuthority: LocalApprovalAuthority | undefined
let leaseAuthority: LocalLeaseAuthority | undefined
let httpHandle: Awaited<ReturnType<typeof startAuthenticatedRpcLoopbackServer>> | undefined
let started = false

process.on('message', async (message: unknown) => {
  if (!isObject(message)) return
  if (message.type === 'shutdown') {
    await shutdown()
    process.disconnect()
    return
  }
  if (message.type !== 'start' || started) return
  started = true
  try {
    const config = parseConfig(message.config)
    const fixedNow = config.clock.kind === 'fixed-test-only' ? config.clock.now : undefined
    const now = fixedNow === undefined ? () => new Date() : () => new Date(fixedNow)
    const stateEncryptionKey = decode32(config.approval.stateEncryptionKeyBase64Url)
    try {
      approvalAuthority = await LocalApprovalAuthority.open({
        issuer: config.approval.issuer, keyId: config.approval.keyId, now,
        statePath: config.approval.statePath,
        stateEncryptionKey,
        testWorkspaceRoots: config.approval.testWorkspaceRoots,
        approvalIdentities: config.approval.approvalIdentities,
        manualIdentities: config.approval.manualIdentities,
      })
    } finally { stateEncryptionKey.fill(0) }
    leaseAuthority = await LocalLeaseAuthority.open({
      now, statePath: config.lease.statePath, testWorkspaceRoots: config.lease.testWorkspaceRoots,
    })
    const rpc = AuthenticatedRpcServer.create({ issuer: config.rpc.issuer, keyId: config.rpc.keyId, now })
    const sessionKey = decode32(config.sessionKeyBase64Url)
    rpc.registerClient(config.rpc.clientId, sessionKey)
    sessionKey.fill(0)
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: approvalAuthority.createWriteExecutionClient(),
      leaseAuthority: leaseAuthority.createExecutionClient(),
      gatewayAuthority: approvalAuthority,
    })
    httpHandle = await startAuthenticatedRpcLoopbackServer(rpc)
    process.send?.({ type: 'ready', endpoint: httpHandle.endpoint, verifierMaterial: rpc.verifierMaterial })
  } catch (error) {
    process.send?.({ type: 'error', code: safeCode(error) })
    await shutdown()
    process.disconnect()
  }
})

process.once('disconnect', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })

async function shutdown(): Promise<void> {
  const handle = httpHandle
  httpHandle = undefined
  await handle?.close()
  approvalAuthority?.close()
  leaseAuthority?.close()
  approvalAuthority = undefined
  leaseAuthority = undefined
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
