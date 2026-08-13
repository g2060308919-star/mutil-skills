import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  canonicalizeJson, digestCleanupPlanDefinition, digestRuntimeIsolationPolicy, digestText,
  type ExecutionOutcomeReceipt,
} from '@mutil-skills/e2e-contracts'
import {
  AuthenticatedRpcServer, createAuthorityExecutionRpcClients,
} from '@mutil-skills/e2e-authority'
import {
  createControlledWriteLauncher,
  createProductionWriteRuntimeSession,
  createProductionControlledWriteLauncher,
  LocalRuntimeIsolationAuthority,
  LocalCleanupPlanRegistry,
  startControlledWriteBridge,
  type ControlledWriteBridgeHandle,
  type ControlledWriteBridgeRequest,
  type ControlledWriteBridgeProof,
} from '../src/index.js'
import { createTestWriteRuntimeSession } from '../src/production-isolation.js'

const handles: ControlledWriteBridgeHandle[] = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

const action: ControlledWriteBridgeRequest = {
  actionId: 'ACTION-APPROVE', buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
  dataLeaseId: 'LEASE-1', cleanupPlanId: 'CLEANUP-1',
}
const cleanupPlanDefinition = {
  schemaVersion: '1.0.0' as const, cleanupPlanId: action.cleanupPlanId, actionId: action.actionId,
  leaseId: action.dataLeaseId, executorId: 'EXECUTOR-TEST', cleanupRequestIntentIds: ['INTENT-CLEANUP'],
  verificationProbes: [{ probeId: 'PROBE-CLEAN', kind: 'resource-state' as const,
    expectedDigest: digestText('bridge-test/v1', 'clean') }], timeoutMs: 30_000,
}
const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlanDefinition)
const approvedRequests = [{ intentId: 'INTENT-WRITE', method: 'POST',
  canonicalOrigin: 'https://test.example.com', exactPath: '/api/write', query: [] as Array<[string, string]>,
  payload: { kind: 'json' as const, digest: digestText('bridge-test/v1', 'payload') },
  targetFingerprint: digestText('bridge-test/v1', 'target'), maxRequests: 1, expectedOrder: 1 }]
const approvalContext = {
  schemaVersion: '1.0.0' as const, subject: 'local:user', runId: 'RUN-1', approvalType: 'execution' as const,
  subjectDigest: digestText('bridge-test/v1', 'subject'), installationDigest: digestText('bridge-test/v1', 'install'),
  origin: 'http://127.0.0.1:43210', issuedAt: '2026-07-14T10:00:00.000Z',
  expiresAt: '2026-07-14T10:01:00.000Z',
}

const evidenceIds = ['EVIDENCE-1']
const receiptBinding = {
  schemaVersion: '1.0.0' as const,
  attemptContext: { assetId: 'ASSET-1', generationId: 'GEN-1',
    prdRevision: digestText('bridge-test/v1', 'prd'), runId: 'RUN-1', caseId: 'CASE-1' },
  grantId: 'GRANT-1', capabilityId: 'CAPABILITY-1', actionId: action.actionId,
  attemptId: 'ATTEMPT-1', reservationId: 'RESERVATION-1', effect: 'reversible-write' as const,
  capability: { capabilityId: 'CAPABILITY-1', nonce: 'nonce', transport: 'http' as const,
    effect: 'reversible-write' as const, operation: 'http-request' as const, actionId: action.actionId,
    dataLeaseId: action.dataLeaseId, fencingToken: 1, cleanupPlanDigest,
    requests: approvedRequests, maxUses: 1 as const },
  status: 'passed' as const, effectObservation: 'applied' as const,
  runnerResultDigest: digestText('controlled-reversible-write-outcome/v1', canonicalizeJson({ status: 'passed' })),
  gateway: { executionSessionId: 'SESSION-1', policyDigest: digestText('bridge-test/v1', 'policy'),
    approvedRequestSetDigest: digestText('execution-outcome-approved-request-set/v1',
      canonicalizeJson(approvedRequests)), received: 1, forwarded: 1, blocked: 0 },
  cleanup: { cleanupPlanId: action.cleanupPlanId,
    cleanupPlanDigest, leaseId: action.dataLeaseId,
    status: 'verified-clean' as const, resultDigest: digestText('bridge-test/v1', 'cleanup-result'),
    leaseReceiptDigest: digestText('bridge-test/v1', 'lease') },
  evidenceIds,
  evidenceSetDigest: digestText('execution-outcome-evidence-set/v1', canonicalizeJson(evidenceIds)),
  completedAt: '2026-07-14T10:00:00.000Z',
}
const executionOutcomeReceipt: ExecutionOutcomeReceipt = {
  ...receiptBinding, issuer: 'gateway', keyId: 'gateway-key', purpose: 'execution-outcome-receipt/v1',
  algorithm: 'Ed25519',
  signedDigest: digestText('execution-outcome-receipt-binding/v1', canonicalizeJson(receiptBinding)),
  signature: 'trusted-signature',
}
const proof: ControlledWriteBridgeProof = {
  status: 'passed', effectObservation: 'applied', cleanupStatus: 'verified-clean',
  authorityReceiptDigest: executionOutcomeReceipt.signedDigest,
  leaseReceiptDigest: executionOutcomeReceipt.cleanup.leaseReceiptDigest,
  gatewayAuditDigest: digestText('bridge-test/v1', 'gateway'),
  evidenceIds, executionOutcomeReceipt,
}
const verifyExecutionOutcomeReceipt = (candidate: unknown) =>
  (candidate as { signature?: unknown })?.signature === 'trusted-signature'

describe('受控可恢复写桥', () => {
  test('生产 launcher 拒绝 test-only runtime，即使调用方自报全部健康', () => {
    const cleanupPlans = LocalCleanupPlanRegistry.create()
    cleanupPlans.register({ definition: cleanupPlanDefinition, execute: async () => ({
      status: 'verified-clean', resultDigest: proof.executionOutcomeReceipt.cleanup.resultDigest,
      leaseReceiptDigest: proof.leaseReceiptDigest,
    }) })
    expect(() => createProductionControlledWriteLauncher([{
      action, cleanupPlanDigest,
      runnerInput: {
        caseId: 'CASE-1', actionId: action.actionId, url: 'https://test.example.com/orders/100',
        buttonName: action.buttonName, beforeText: action.beforeText, afterText: action.afterText,
        expectedIdentity: { title: '订单审批', heading: '订单 100' },
        authorization: { grant: { capabilities: [{ actionId: action.actionId, effect: 'reversible-write',
          cleanupPlanDigest }] } as any, currentSubject: {} as any, authority: {} as any },
        lease: { leaseId: action.dataLeaseId, fencingToken: 1,
          targetFingerprint: digestText('bridge-test/v1', 'target'), authority: {} as any },
        runtime: createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
          authorityTransport: 'in-process-test' }),
        gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page: {} as any,
      },
      lifecycle: { finalizeExecution: async () => ({ executionOutcomeReceipt, gatewayAuditDigest: proof.gatewayAuditDigest }) },
    }], cleanupPlans)).toThrowError(expect.objectContaining({
      code: 'E2E_CONTROLLED_WRITE_PRODUCTION_ISOLATION_REQUIRED',
    }))
  })

  test('生产 launcher 只接受签名隔离会话与同公钥 Authority RPC 客户端', () => {
    const now = () => new Date('2026-07-14T10:00:00.000Z')
    const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now })
    const credential = rpc.registerClient('isolated-runner', Buffer.alloc(32, 13), { approvalContext })
    const rpcMaterial = rpc.verifierMaterial
    const clients = createAuthorityExecutionRpcClients({ credential, verifierMaterial: rpcMaterial,
      approvalBinding: { runId: approvalContext.runId,
        installationDigest: approvalContext.installationDigest,
        approvalType: approvalContext.approvalType, subjectDigest: approvalContext.subjectDigest },
      expectedPublicKeyDigest: rpcMaterial.publicKeyDigest, transport: (request) => rpc.handle(request), now })
    const isolation = LocalRuntimeIsolationAuthority.create({
      issuer: 'isolation-authority', keyId: 'isolation-key-1', now,
    })
    const sourceDigest = digestText('bridge-test/v1', 'source')
    const limits = { cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024,
      diskBytes: 128 * 1024 * 1024, wallTimeMs: 60_000 }
    const allowedEndpoints = ['http://127.0.0.1:4100', 'http://127.0.0.1:4200']
    const attestation = isolation.issue({
      schemaVersion: '1.0.0', isolationSessionId: 'ISOLATION-1', runId: 'RUN-1',
      assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: receiptBinding.attemptContext.prdRevision,
      caseIds: ['CASE-1'], backend: { kind: 'linux-bwrap', instanceId: 'BWRAP-1', version: '1.0.0' },
      identity: { dedicatedLowPrivilegeUser: true, uid: 65534, orchestratorUid: 501 },
      filesystem: { sourceDigest, sourceReadOnly: true, temporaryHome: true, hostCredentialsMounted: false },
      network: { defaultDeny: true, gatewayEndpoint: allowedEndpoints[0]!, allowedEndpoints,
        quicDisabled: true, remoteDebuggingDisabled: true },
      process: { arbitrarySubprocesses: false,
        allowedExecutableDigests: [digestText('bridge-test/v1', 'node')] },
      browser: { sandboxEnabled: true, ephemeralProfile: true, downloadsDisabled: true }, limits,
      authorityRpcPublicKeyDigest: rpcMaterial.publicKeyDigest, checkedAt: now().toISOString(),
      expiresAt: new Date(now().getTime() + 30_000).toISOString(),
    })
    const material = isolation.verifierMaterial
    const runtimeIsolationPolicy = {
      schemaVersion: '1.0.0' as const, sourceDigest, allowedBackends: ['linux-bwrap' as const],
      gatewayEndpoint: allowedEndpoints[0]!, allowedEndpoints,
      allowedExecutableDigests: [digestText('bridge-test/v1', 'node')], limits,
      authorityRpcPublicKeyDigest: rpcMaterial.publicKeyDigest,
      isolationAuthorityPublicKeyDigest: material.publicKeyDigest,
    }
    const runtime = createProductionWriteRuntimeSession({ attestation, verifierMaterial: material,
      expectedPublicKeyDigest: material.publicKeyDigest, now,
      expected: { runId: 'RUN-1', assetId: 'ASSET-1', generationId: 'GEN-1',
        prdRevision: receiptBinding.attemptContext.prdRevision, caseIds: ['CASE-1'],
        runtimeIsolationPolicy,
        runtimeIsolationPolicyDigest: digestRuntimeIsolationPolicy(runtimeIsolationPolicy) } })
    const cleanupPlans = LocalCleanupPlanRegistry.create()
    cleanupPlans.register({ definition: cleanupPlanDefinition, execute: async () => ({
      status: 'verified-clean', resultDigest: proof.executionOutcomeReceipt.cleanup.resultDigest,
      leaseReceiptDigest: proof.leaseReceiptDigest,
    }) })
    expect(createProductionControlledWriteLauncher([{
      action, cleanupPlanDigest,
      runnerInput: {
        caseId: 'CASE-1', actionId: action.actionId, url: 'https://test.example.com/orders/100',
        buttonName: action.buttonName, beforeText: action.beforeText, afterText: action.afterText,
        expectedIdentity: { title: '订单审批', heading: '订单 100' },
        authorization: { grant: { capabilities: [{ actionId: action.actionId, effect: 'reversible-write',
          cleanupPlanDigest }] } as any, currentSubject: {} as any, authority: clients.writeApproval },
        lease: { leaseId: action.dataLeaseId, fencingToken: 1,
          targetFingerprint: digestText('bridge-test/v1', 'target'), authority: clients.lease },
        runtime, gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page: {} as any,
      },
      lifecycle: { finalizeExecution: async () => ({ executionOutcomeReceipt, gatewayAuditDigest: proof.gatewayAuditDigest }) },
    }], cleanupPlans)).toBeTypeOf('function')
  })

  test('只接受 loopback Bearer RunGate、精确动作，并且每个动作只能成功一次', async ({ skip }) => {
    const launch = vi.fn(async () => proof)
    let handle: ControlledWriteBridgeHandle
    try {
      handle = await startControlledWriteBridge({ actions: [action], launch, verifyExecutionOutcomeReceipt })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    handles.push(handle)

    const unauthorized = await fetch(handle.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
    })
    expect(unauthorized.status).toBe(401)

    const mismatched = await fetch(handle.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.runGate}` },
      body: JSON.stringify({ ...action, afterText: '伪造状态' }),
    })
    expect(mismatched.status).toBe(409)

    const accepted = await fetch(handle.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.runGate}` },
      body: JSON.stringify(action),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual(proof)

    const replay = await fetch(handle.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.runGate}` },
      body: JSON.stringify(action),
    })
    expect(replay.status).toBe(409)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  test('launcher 在 Runner 安全阻断时仍执行 cleanup，且绝不返回 passed 证明', async () => {
    const finalizeExecution = vi.fn(async () => ({
      executionOutcomeReceipt: proof.executionOutcomeReceipt,
      gatewayAuditDigest: proof.gatewayAuditDigest,
    }))
    const cleanup = vi.fn(async () => ({ status: 'verified-clean' as const,
      resultDigest: proof.executionOutcomeReceipt.cleanup.resultDigest,
      leaseReceiptDigest: proof.leaseReceiptDigest }))
    const cleanupPlans = LocalCleanupPlanRegistry.create()
    cleanupPlans.register({ definition: cleanupPlanDefinition, execute: cleanup })
    const launch = createControlledWriteLauncher([{
      action, cleanupPlanDigest,
      runnerInput: {
        caseId: 'CASE-1', actionId: action.actionId, url: 'https://test.example.com/orders/100',
        buttonName: action.buttonName, beforeText: action.beforeText, afterText: action.afterText,
        expectedIdentity: { title: '订单审批', heading: '订单 100' },
        authorization: { grant: { capabilities: [{ actionId: action.actionId, effect: 'reversible-write',
          cleanupPlanDigest }] } as any, currentSubject: {} as any, authority: {} as any },
        lease: { leaseId: action.dataLeaseId, fencingToken: 1,
          targetFingerprint: digestText('bridge-test/v1', 'target'), authority: {} as any },
        runtime: createTestWriteRuntimeSession({ sandboxHealthy: false, gatewayConnected: false,
          authorityTransport: 'in-process-test' }),
        gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} },
        page: {} as any,
      },
      lifecycle: { finalizeExecution },
    }], cleanupPlans)

    await expect(launch(action)).rejects.toThrow(/E2E_CONTROLLED_WRITE_CASE_NOT_PASSED/)
    expect(finalizeExecution).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('桥拒绝 launcher 伪造的不完整证明，并永久消费动作以阻断不明副作用重试', async ({ skip }) => {
    const launch = vi.fn()
      .mockResolvedValueOnce({ ...proof, evidenceIds: [] })
      .mockResolvedValueOnce(proof)
    let handle: ControlledWriteBridgeHandle
    try {
      handle = await startControlledWriteBridge({ actions: [action], launch, verifyExecutionOutcomeReceipt })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    handles.push(handle)
    const request = () => fetch(handle.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.runGate}` },
      body: JSON.stringify(action),
    })
    expect((await request()).status).toBe(500)
    expect((await request()).status).toBe(409)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  test('cleanup 抛错时仍以 unknown 调用终态回写，并拒绝生成通过证明', async () => {
    const finalizeExecution = vi.fn(async () => ({
      executionOutcomeReceipt: proof.executionOutcomeReceipt,
      gatewayAuditDigest: proof.gatewayAuditDigest,
    }))
    const cleanupPlans = LocalCleanupPlanRegistry.create()
    cleanupPlans.register({ definition: cleanupPlanDefinition,
      execute: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } })
    const launch = createControlledWriteLauncher([{
      action, cleanupPlanDigest,
      runnerInput: {
        caseId: 'CASE-1', actionId: action.actionId, url: 'https://test.example.com/orders/100',
        buttonName: action.buttonName, beforeText: action.beforeText, afterText: action.afterText,
        expectedIdentity: { title: '订单审批', heading: '订单 100' },
        authorization: { grant: { capabilities: [{ actionId: action.actionId, effect: 'reversible-write',
          cleanupPlanDigest }] } as any, currentSubject: {} as any, authority: {} as any },
        lease: { leaseId: action.dataLeaseId, fencingToken: 1,
          targetFingerprint: digestText('bridge-test/v1', 'target'), authority: {} as any },
        runtime: createTestWriteRuntimeSession({ sandboxHealthy: false, gatewayConnected: false,
          authorityTransport: 'in-process-test' }),
        gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page: {} as any,
      },
      lifecycle: { finalizeExecution },
    }], cleanupPlans)
    await expect(launch(action)).rejects.toThrow('E2E_CONTROLLED_WRITE_CLEANUP_FAILED')
    expect(finalizeExecution).toHaveBeenCalledWith(expect.objectContaining({
      cleanup: expect.objectContaining({ status: 'unknown' }),
    }))
  })

  test('桥拒绝签名无效或与动作不一致的 ExecutionOutcomeReceipt', async ({ skip }) => {
    const forged = { ...proof, executionOutcomeReceipt: {
      ...proof.executionOutcomeReceipt, signature: 'forged-signature',
    } }
    let handle: ControlledWriteBridgeHandle
    try {
      handle = await startControlledWriteBridge({
        actions: [action], launch: async () => forged, verifyExecutionOutcomeReceipt,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    handles.push(handle)
    const response = await fetch(handle.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.runGate}` },
      body: JSON.stringify(action),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'E2E_CONTROLLED_WRITE_OUTCOME_SIGNATURE_INVALID' })
  })
})
