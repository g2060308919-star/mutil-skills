import { describe, expect, test } from 'vitest'
import {
  canonicalGrantApprovalSubjectDigest,
  digestText,
  type ReadApprovalSubject,
  type SignedReadGrant,
  type SignedWriteGrant,
  type SignedWebSocketReadGrant,
  type WebSocketReadApprovalSubject,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import {
  AuthenticatedRpcServer,
  createAuthorityReadRpcClient,
  createAuthorityExecutionRpcClients,
  createAuthorityMaintenanceRpcClient,
  createAuthorityWebSocketRpcClient,
  getTrustedExecutionClientBinding,
  isTrustedLeaseClient,
  isTrustedWriteApprovalClient,
  registerAuthorityExecutionRpcOperations,
} from '../src/index.js'

const NOW = new Date('2026-07-14T10:00:00.000Z')
const digest = digestText('authority-execution-rpc-test/v1', 'value')

test('maintenance RPC 严格绑定 reservation/lease 并返回认证响应覆盖的稳定回执摘要', async () => {
  let clock = NOW
  const approvalContext = {
    schemaVersion: '1.0.0' as const, subject: 'os-user:qa', runId: 'RUN-1', approvalType: 'execution' as const,
    subjectDigest: digest, installationDigest: digest, origin: 'http://127.0.0.1:43210',
    issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
  }
  const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now: () => clock })
  const credential = rpc.registerClient('runner-process', Buffer.alloc(32, 9), { approvalContext })
  const otherCredential = rpc.registerClient('other-runner', Buffer.alloc(32, 8), { approvalContext })
  const cleanupDigest = digestText('cleanup/v1', 'verified')
  const receiptDigest = digestText('receipt/v1', 'released')
  let leaseReads = 0
  registerAuthorityExecutionRpcOperations(rpc, {
    writeAuthority: { async verifyForSubject() { return { allowed: true } } },
    reservationAuthority: { getGrantApprovalContext() { return approvalContext }, findReservation(query) { return {
      reservationId: query.reservationId ?? 'RESERVATION-1', grantId: query.grantId,
      capabilityId: query.capabilityId, actionId: query.actionId, attemptId: query.attemptId ?? 'ATTEMPT-1',
      status: 'completed', reservedAt: NOW.toISOString(), outcomeDigest: digest,
    } }, getReservationRpcBinding() { return { clientId: 'runner-process', approvalContext } },
    async complete() { return digestText('receipt/v1', 'completed') },
    async markUnknown() { return digestText('receipt/v1', 'unknown') } },
    leaseAuthority: {
      async verifyTarget() { return true },
      async getLeaseForTarget(leaseId, fencingToken, targetFingerprint) { leaseReads += 1; return {
        leaseId, runId: leaseId === 'LEASE-OTHER-RUN' ? 'RUN-2' : 'RUN-1',
        resourceKey: 'order:100', resourceFingerprint: targetFingerprint,
        exclusive: true, status: 'released', fencingToken, acquiredAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), cleanupDigest,
      } },
      async releaseForTarget() { return receiptDigest },
      async quarantineForTarget() { return digestText('receipt/v1', 'quarantined') },
    },
  })
  const verifierMaterial = rpc.verifierMaterial
  const client = createAuthorityMaintenanceRpcClient({ credential, verifierMaterial,
    approvalBinding: { runId: 'RUN-1', installationDigest: digest, approvalType: 'execution', subjectDigest: digest },
    expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request) => rpc.handle(request), now: () => clock })
  const otherClient = createAuthorityMaintenanceRpcClient({ credential: otherCredential, verifierMaterial,
    approvalBinding: { runId: 'RUN-1', installationDigest: digest, approvalType: 'execution', subjectDigest: digest },
    expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request) => rpc.handle(request), now: () => clock })

  await expect(client.queryReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' })).resolves.toMatchObject({
      reservationId: 'RESERVATION-1', status: 'completed', outcomeDigest: digest,
    })
  await expect(client.queryReservation({ reservationId: 'RESERVATION-1', attemptId: 'ATTEMPT-1',
    grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-1' }))
    .rejects.toMatchObject({ code: 'E2E_RPC_RESERVATION_QUERY_INPUT_INVALID' })
  await expect(client.releaseLease({ leaseId: 'LEASE-1', fencingToken: 1,
    targetFingerprint: digest, cleanupDigest })).resolves.toBe(receiptDigest)
  await expect(client.completeReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' }, digest))
    .resolves.toMatch(/^sha256:[a-f0-9]{64}$/)
  await expect(client.queryLease('LEASE-1', 1, digest)).resolves.toMatchObject({
    leaseId: 'LEASE-1', fencingToken: 1, resourceFingerprint: digest, status: 'released',
  })
  await expect(client.queryLease('LEASE-OTHER-RUN', 1, digest))
    .rejects.toMatchObject({ code: 'E2E_RPC_LEASE_RUN_MISMATCH' })
  clock = new Date(NOW.getTime() + 6_000)
  await expect(client.queryReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' })).resolves.toMatchObject({ status: 'completed' })
  await expect(otherClient.queryReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' }))
    .rejects.toMatchObject({ code: 'E2E_RPC_RESERVATION_CONTEXT_MISMATCH' })

  rpc.updateClientRegistration('runner-process', { approvalContext, recoveryOnly: true })
  await expect(client.queryReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' })).resolves.toMatchObject({ status: 'completed' })
  await expect(client.completeReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' }, digest))
    .rejects.toMatchObject({ code: 'E2E_RPC_RECOVERY_OPERATION_DENIED' })
  await expect(client.releaseLease({ leaseId: 'LEASE-1', fencingToken: 1,
    targetFingerprint: digest, cleanupDigest }))
    .rejects.toMatchObject({ code: 'E2E_RPC_RECOVERY_OPERATION_DENIED' })
  const execution = createAuthorityExecutionRpcClients({ credential, verifierMaterial,
    approvalBinding: { runId: 'RUN-1', installationDigest: digest,
      approvalType: 'execution', subjectDigest: digest },
    expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request) => rpc.handle(request), now: () => clock })
  const { grant, subject } = writeGrant()
  await expect(execution.writeApproval.verifyForSubject(grant, subject)).resolves.toMatchObject({
    allowed: false, code: 'E2E_APPROVAL_CONTEXT_MISMATCH',
  })
  const readsBeforeUnauthorizedVerify = leaseReads
  await expect(execution.lease.verifyTarget('LEASE-1', 1, digest))
    .rejects.toMatchObject({ code: 'E2E_APPROVAL_CONTEXT_MISMATCH' })
  expect(leaseReads).toBe(readsBeforeUnauthorizedVerify)
  const wrongBinding = createAuthorityMaintenanceRpcClient({ credential, verifierMaterial,
    approvalBinding: { runId: 'RUN-WRONG', installationDigest: digest,
      approvalType: 'execution', subjectDigest: digest },
    expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request) => rpc.handle(request), now: () => clock })
  await expect(wrongBinding.queryReservation({ reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAP-1', actionId: 'ACTION-1' }))
    .rejects.toMatchObject({ code: 'E2E_RPC_RECOVERY_BINDING_MISMATCH' })
})

test('WebSocket Authority RPC 严格绑定协议 schema、clientId 与审批上下文，并允许同终态幂等重试', async () => {
  let clock = NOW
  const subject: WebSocketReadApprovalSubject = { schemaVersion: '1.0.0', assetId: 'ASSET-1',
    prdRevision: digest, executionDigest: digest, environment: 'test', baseOrigin: 'https://test.example.com',
    actions: [{ actionId: 'ACTION-WS-1', origin: 'https://test.example.com', path: '/events',
      maxInboundMessages: 5, maxBytes: 1024 }] }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  const approvalContext = { schemaVersion: '1.0.0' as const, subject: 'os-user:qa', runId: 'RUN-1',
    approvalType: 'execution' as const, subjectDigest, installationDigest: digest,
    origin: 'http://127.0.0.1:43210', issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 5_000).toISOString() }
  const grant: SignedWebSocketReadGrant = { grantId: 'GRANT-WS-1', issuer: 'AUTHORITY', keyId: 'KEY-1',
    proofScope: 'local-os-user', approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    approvalContext, subject, subjectDigest, issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 5_000).toISOString(), revocationSequence: 0,
    capabilities: [{ capabilityId: 'CAP-WS-1', nonce: '1'.repeat(64), transport: 'websocket', effect: 'read',
      actionId: 'ACTION-WS-1', origin: 'https://test.example.com', path: '/events',
      maxInboundMessages: 5, maxBytes: 1024, maxUses: 1 }], signature: 'A'.repeat(86) }
  const receipt = digestText('receipt/v1', 'ws-completed')
  const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now: () => clock })
  const firstCredential = rpc.registerClient('runner-1', Buffer.alloc(32, 1), { approvalContext })
  const secondCredential = rpc.registerClient('runner-2', Buffer.alloc(32, 2), { approvalContext })
  const thirdCredential = rpc.registerClient('runner-3', Buffer.alloc(32, 3), { approvalContext })
  let reserveCalls = 0
  registerAuthorityExecutionRpcOperations(rpc, {
    writeAuthority: { async verifyForSubject() { return { allowed: true } } },
    leaseAuthority: { async verifyTarget() { return true } },
    webSocketAuthority: {
      async reserveForSubject(input) { reserveCalls += 1; return { reservationId: `RESERVATION-${input.attemptId}`, grantId: input.grant.grantId,
        capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
        status: 'reserved', reservedAt: NOW.toISOString() } },
      async complete() { return receipt }, async markUnknown() { return digestText('receipt/v1', 'ws-unknown') },
    },
  })
  const verifierMaterial = rpc.verifierMaterial
  const options = { verifierMaterial, approvalBinding: { runId: 'RUN-1', installationDigest: digest,
    approvalType: 'execution' as const, subjectDigest }, expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request: Parameters<typeof rpc.handle>[0]) => rpc.handle(request), now: () => clock, ttlMs: 1 }
  const first = createAuthorityWebSocketRpcClient({ ...options, credential: firstCredential })
  const second = createAuthorityWebSocketRpcClient({ ...options, credential: secondCredential })
  const third = createAuthorityWebSocketRpcClient({ ...options, credential: thirdCredential })
  const reservation = await first.reserveForSubject({ grant, currentSubject: subject,
    capabilityId: 'CAP-WS-1', actionId: 'ACTION-WS-1', attemptId: 'ATTEMPT-WS-1' })
  await expect(second.complete(reservation.reservationId, digest))
    .rejects.toMatchObject({ code: 'E2E_RPC_RESERVATION_CONTEXT_MISMATCH' })
  await expect(first.complete(reservation.reservationId, digest)).resolves.toBe(receipt)
  const clients = [first, second, third]
  for (let index = 2; index <= 4_096; index += 1) {
    if (index % 200 === 0) clock = new Date(clock.getTime() + 2)
    const client = clients[index % clients.length]!
    const next = await client.reserveForSubject({ grant, currentSubject: subject,
      capabilityId: 'CAP-WS-1', actionId: 'ACTION-WS-1', attemptId: `ATTEMPT-WS-${index}` })
    await expect(client.complete(next.reservationId, digest)).resolves.toBe(receipt)
  }
  await expect(first.reserveForSubject({ grant, currentSubject: subject,
    capabilityId: 'CAP-WS-1', actionId: 'ACTION-WS-1', attemptId: 'ATTEMPT-WS-4097' }))
    .rejects.toMatchObject({ code: 'E2E_RPC_RESERVATION_CONTEXT_CAPACITY' })
  expect(reserveCalls).toBe(4_096)
  // 4096 个真实 authenticated RPC 终态之后，最早 tombstone 仍保持精确幂等且没有 FIFO 淘汰。
  await expect(first.complete(reservation.reservationId, digest)).resolves.toBe(receipt)
}, 20_000)
const binding = (context: SignedWriteGrant['approvalContext']) => ({
  runId: context.runId, installationDigest: context.installationDigest,
  approvalType: context.approvalType, subjectDigest: context.subjectDigest,
})

function writeGrant(): { grant: SignedWriteGrant; subject: WriteApprovalSubject } {
  const subject: WriteApprovalSubject = {
    schemaVersion: '2.0.0', assetId: 'ASSET-1', prdRevision: digest, executionDigest: digest,
    scopeDigest: digest, requirementModelDigest: digest, coveragePolicyDigest: digest, universeDigest: digest,
    caseDigest: digest, actionMapDigest: digest, policyDigest: digest, executionContractDigest: digest,
    runBundleProjectionDigest: digest, actor: 'runner', discoveryGrantId: 'DISCOVERY-1', preflightDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com',
    actions: [{ actionId: 'ACTION-1', effect: 'reversible-write', dataLeaseId: 'LEASE-1', fencingToken: 1,
      cleanupPlanDigest: digest, requests: [{ intentId: 'INTENT-1', method: 'POST',
        canonicalOrigin: 'https://test.example.com', exactPath: '/orders/1', query: [],
        payload: { kind: 'no-body' }, targetFingerprint: digest, maxRequests: 1, expectedOrder: 1 }] }],
  }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  return { subject, grant: {
    grantId: 'GRANT-1', issuer: 'AUTHORITY', keyId: 'KEY-1', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, subject, subjectDigest,
    approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:qa', runId: 'RUN-1',
      approvalType: 'execution', subjectDigest, installationDigest: digest,
      origin: 'http://127.0.0.1:43210', issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5_000).toISOString() },
    issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
    capabilities: [{ capabilityId: 'CAP-1', nonce: 'nonce', transport: 'http', effect: 'reversible-write',
      operation: 'http-request', actionId: 'ACTION-1', dataLeaseId: 'LEASE-1', fencingToken: 1,
      cleanupPlanDigest: digest, requests: subject.actions[0]!.requests, maxUses: 1 }],
    revocationSequence: 0, signature: 'A'.repeat(86),
  } }
}

function readGrant(): { grant: SignedReadGrant; subject: ReadApprovalSubject } {
  const subject: ReadApprovalSubject = {
    schemaVersion: '2.1.0', assetId: 'ASSET-1', prdRevision: digest, scopeDigest: digest,
    requirementModelDigest: digest, coveragePolicyDigest: digest, universeDigest: digest,
    caseDigest: digest, actionMapDigest: digest, policyDigest: digest,
    executionContractDigest: digest, runBundleProjectionDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'runner',
    discoveryGrantId: 'DISCOVERY-1', preflightDigest: digest,
    requests: [],
    actions: [{ actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1, requestIds: [] }],
  }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  return { subject, grant: {
    grantId: 'READ-1', issuer: 'AUTHORITY', keyId: 'KEY-1', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, subject, subjectDigest,
    approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:qa', runId: 'RUN-1',
      approvalType: 'execution', subjectDigest, installationDigest: digest,
      origin: 'http://127.0.0.1:43210', issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5_000).toISOString() },
    issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
    capabilities: [{ capabilityId: 'CAP-READ-1', nonce: '1'.repeat(64),
      transport: 'browser-local', effect: 'read', operation: 'dom-read',
      actionId: 'ACTION-1', maxUses: 1 }],
    revocationSequence: 0, signature: 'A'.repeat(86),
  } }
}

function setup() {
  const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now: () => NOW })
  const credential = rpc.registerClient('runner-process', Buffer.alloc(32, 9), {
    approvalContext: writeGrant().grant.approvalContext,
  })
  const verifierMaterial = rpc.verifierMaterial
  return { rpc, credential, verifierMaterial, approvalContext: writeGrant().grant.approvalContext }
}

test('服务端使用注册时的可信上下文拒绝跨 Run、跨安装、错类型、错 origin 与过期回放', async () => {
  const base = writeGrant().grant.approvalContext
  const mutations = [
    { ...base, runId: 'RUN-2' },
    { ...base, installationDigest: digestText('authority-execution-rpc-test/v1', 'other-install') },
    { ...base, approvalType: 'discovery' as const },
    { ...base, origin: 'http://127.0.0.1:43211' },
    { ...base, issuedAt: new Date(NOW.getTime() + 1_000).toISOString(), expiresAt: new Date(NOW.getTime() + 2_000).toISOString() },
    { ...base, issuedAt: new Date(NOW.getTime() - 10_000).toISOString(), expiresAt: NOW.toISOString() },
  ]
  for (const approvalContext of mutations) {
    const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now: () => NOW })
    const credential = rpc.registerClient('runner-process', Buffer.alloc(32, 9), { approvalContext })
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: { async verifyForSubject() { return { allowed: true } } },
      leaseAuthority: { async verifyTarget() { return true } },
    })
    const verifierMaterial = rpc.verifierMaterial
    const clients = createAuthorityExecutionRpcClients({ credential, verifierMaterial,
      approvalBinding: binding(base),
      expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
      transport: (request) => rpc.handle(request), now: () => NOW })
    const { grant, subject } = writeGrant()
    await expect(clients.writeApproval.verifyForSubject(grant, subject)).resolves.toMatchObject({
      allowed: false,
      code: 'E2E_APPROVAL_CONTEXT_MISMATCH',
    })
  }
})

test('生产式 Host 在消费 WebAuthn receipt 后可用父进程已知的非秘密绑定创建执行客户端', async () => {
  const { grant, subject } = writeGrant()
  const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now: () => NOW })
  const credential = rpc.registerClient('runner-process', Buffer.alloc(32, 9))
  registerAuthorityExecutionRpcOperations(rpc, {
    writeAuthority: { async verifyForSubject() { return { allowed: true } } },
    leaseAuthority: { async verifyTarget() { return true } },
  })
  const verifierMaterial = rpc.verifierMaterial
  const clients = createAuthorityExecutionRpcClients({ credential, verifierMaterial,
    approvalBinding: binding(grant.approvalContext),
    expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request) => rpc.handle(request), now: () => NOW })

  await expect(clients.writeApproval.verifyForSubject(grant, subject)).resolves.toMatchObject({
    allowed: false, code: 'E2E_APPROVAL_CONTEXT_MISMATCH',
  })
  rpc.updateClientRegistration('runner-process', { approvalContext: grant.approvalContext })
  await expect(clients.writeApproval.verifyForSubject(grant, subject)).resolves.toEqual({ allowed: true })
})

test('read complete 必须使用创建 reservation 时完全相同的已认证审批上下文', async () => {
  const { grant, subject } = readGrant()
  const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now: () => NOW })
  const credential = rpc.registerClient('runner-process', Buffer.alloc(32, 9), {
    approvalContext: grant.approvalContext,
  })
  const completed: string[] = []
  const unknown: string[] = []
  registerAuthorityExecutionRpcOperations(rpc, {
    writeAuthority: { async verifyForSubject() {
      return { allowed: false, code: 'E2E_UNUSED', reason: 'unused' }
    } },
    leaseAuthority: { async verifyTarget() { return false } },
    readAuthority: {
      async reserveForSubject(input) { return {
        reservationId: 'RESERVATION-READ-1', grantId: input.grant.grantId,
        capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
        status: 'reserved', reservedAt: NOW.toISOString(),
      } },
      async complete(reservationId) { completed.push(reservationId); return digestText('receipt/v1', 'read-complete') },
      async markUnknown(reservationId) { unknown.push(reservationId); return digestText('receipt/v1', 'read-unknown') },
    },
  })
  const verifierMaterial = rpc.verifierMaterial
  const client = createAuthorityReadRpcClient({
    credential, verifierMaterial, approvalBinding: binding(grant.approvalContext),
    expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
    transport: (request) => rpc.handle(request), now: () => NOW,
  })
  const reservation = await client.reserveForSubject({
    grant, currentSubject: subject, capabilityId: 'CAP-READ-1',
    actionId: 'ACTION-1', attemptId: 'ATTEMPT-READ-1',
  })
  rpc.updateClientRegistration('runner-process', {
    approvalContext: { ...grant.approvalContext, runId: 'RUN-OTHER' },
  })
  await expect(client.complete(reservation.reservationId, digest)).rejects.toMatchObject({
    code: 'E2E_RPC_RESERVATION_CONTEXT_MISMATCH',
  })
  await expect(client.markUnknown(reservation.reservationId, 'cross-run')).rejects.toMatchObject({
    code: 'E2E_RPC_RESERVATION_CONTEXT_MISMATCH',
  })
  expect(completed).toEqual([])
  expect(unknown).toEqual([])

  rpc.updateClientRegistration('runner-process', { approvalContext: grant.approvalContext })
  await client.complete(reservation.reservationId, digest)
  expect(completed).toEqual(['RESERVATION-READ-1'])
})

describe('Authority execution RPC clients', () => {
  test('只暴露固定的 Write/Lease operation，并登记为绑定公钥摘要的跨进程可信客户端', async () => {
    const { rpc, credential, verifierMaterial, approvalContext } = setup()
    const calls: string[] = []
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: { async verifyForSubject() { calls.push('write'); return { allowed: true } } },
      leaseAuthority: {
        async verifyTarget() { calls.push('lease'); return true },
        async getLeaseForTarget(leaseId, fencingToken, targetFingerprint) { return {
          leaseId, runId: 'RUN-1', resourceKey: 'order:1', resourceFingerprint: targetFingerprint,
          exclusive: true, status: 'active' as const, fencingToken, acquiredAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        } },
      },
      gatewayAuthority: {
        async verifyForSubject() { calls.push('gateway-verify'); return { allowed: true } },
        async reserveForSubject(input) { calls.push('gateway-reserve'); return {
          reservationId: `RESERVATION-${input.attemptId}`, grantId: input.grant.grantId, capabilityId: input.capabilityId,
          actionId: input.actionId, attemptId: input.attemptId,
          ...(input.attemptContext === undefined ? {} : { attemptContext: input.attemptContext }),
          status: 'reserved', reservedAt: NOW.toISOString(),
        } },
        async complete() { calls.push('gateway-complete'); return digestText('receipt/v1', 'gateway-complete') },
        async markUnknown() { calls.push('gateway-unknown'); return digestText('receipt/v1', 'gateway-unknown') },
      },
    })
    const clients = createAuthorityExecutionRpcClients({ credential, verifierMaterial,
      approvalBinding: binding(approvalContext),
      expectedPublicKeyDigest: verifierMaterial.publicKeyDigest, transport: (request) => rpc.handle(request), now: () => NOW })
    const { grant, subject } = writeGrant()
    const otherCredential = rpc.registerClient('runner-process-other', Buffer.alloc(32, 6), {
      approvalContext: grant.approvalContext,
    })
    const otherClients = createAuthorityExecutionRpcClients({ credential: otherCredential, verifierMaterial,
      approvalBinding: binding(approvalContext), expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
      transport: (request) => rpc.handle(request), now: () => NOW })

    await expect(clients.writeApproval.verifyForSubject(grant, subject)).resolves.toEqual({ allowed: true })
    await expect(clients.lease.verifyTarget('LEASE-1', 1, digest)).resolves.toBe(true)
    await expect(clients.gatewayAuthority.verifyForSubject(grant, grant.subject)).resolves.toEqual({ allowed: true })
    const reservation = await clients.gatewayAuthority.reserveForSubject({
      grant, currentSubject: subject, capabilityId: 'CAP-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1',
      attemptContext: { assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digest,
        runId: 'RUN-1', caseId: 'CASE-1' },
    })
    expect(reservation).toMatchObject({ reservationId: 'RESERVATION-ATTEMPT-1', status: 'reserved' })
    await expect(otherClients.gatewayAuthority.complete(reservation.reservationId, digest))
      .rejects.toMatchObject({ code: 'E2E_RPC_RESERVATION_CONTEXT_MISMATCH' })
    await clients.gatewayAuthority.complete(reservation.reservationId, digest)
    const unknownReservation = await clients.gatewayAuthority.reserveForSubject({
      grant, currentSubject: subject, capabilityId: 'CAP-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-2',
    })
    await clients.gatewayAuthority.markUnknown(unknownReservation.reservationId, 'upstream-disconnected')
    expect(calls).toEqual(['write', 'lease', 'gateway-verify', 'gateway-reserve', 'gateway-complete',
      'gateway-reserve', 'gateway-unknown'])
    expect(isTrustedWriteApprovalClient(clients.writeApproval)).toBe(true)
    expect(isTrustedLeaseClient(clients.lease)).toBe(true)
    expect(getTrustedExecutionClientBinding(clients.writeApproval)).toEqual({
      transport: 'authenticated-rpc', authorityPublicKeyDigest: verifierMaterial.publicKeyDigest,
      approvalBinding: binding(approvalContext),
    })
    expect(getTrustedExecutionClientBinding(clients.lease)).toEqual({
      transport: 'authenticated-rpc', authorityPublicKeyDigest: verifierMaterial.publicKeyDigest,
      approvalBinding: binding(approvalContext),
    })
  })

  test('Host 严格拒绝多余字段和非法 Lease 参数，客户端严格拒绝异常响应结果', async () => {
    const first = setup()
    registerAuthorityExecutionRpcOperations(first.rpc, {
      writeAuthority: { async verifyForSubject() { return { allowed: true } } },
      leaseAuthority: { async verifyTarget() { return true } },
    })
    const firstClients = createAuthorityExecutionRpcClients({ credential: first.credential,
      approvalBinding: binding(first.approvalContext),
      verifierMaterial: first.verifierMaterial, expectedPublicKeyDigest: first.verifierMaterial.publicKeyDigest,
      transport: (request) => first.rpc.handle(request), now: () => NOW })
    await expect(firstClients.lease.verifyTarget('', 0, 'bad-digest')).rejects.toMatchObject({
      code: 'E2E_RPC_LEASE_VERIFY_INPUT_INVALID',
    })

    const second = setup()
    second.rpc.registerOperation('write.verifyForSubject.v1', async () => ({ allowed: 'yes' }))
    second.rpc.registerOperation('lease.verifyTarget.v1', async () => ({ verified: 'yes' }))
    const secondClients = createAuthorityExecutionRpcClients({ credential: second.credential,
      approvalBinding: binding(second.approvalContext),
      verifierMaterial: second.verifierMaterial, expectedPublicKeyDigest: second.verifierMaterial.publicKeyDigest,
      transport: (request) => second.rpc.handle(request), now: () => NOW })
    const { grant, subject } = writeGrant()
    await expect(secondClients.writeApproval.verifyForSubject(grant, subject)).rejects.toMatchObject({
      code: 'E2E_RPC_WRITE_VERIFY_RESULT_INVALID',
    })
    await expect(secondClients.lease.verifyTarget('LEASE-1', 1, digest)).rejects.toMatchObject({
      code: 'E2E_RPC_LEASE_VERIFY_RESULT_INVALID',
    })
  })

  test('普通结构对象不能伪装成可信客户端', () => {
    expect(isTrustedWriteApprovalClient({ async verifyForSubject() { return { allowed: true } } })).toBe(false)
    expect(isTrustedLeaseClient({ async verifyTarget() { return true } })).toBe(false)
  })

  test('拒绝 Host 返回错绑 reservation 或伪造有状态操作确认', async () => {
    const reservationServer = setup()
    reservationServer.rpc.registerOperation('gateway.write.reserveForSubject.v1', async (payload: any) => ({
      reservationId: 'RESERVATION-OTHER', grantId: payload.grant.grantId,
      capabilityId: payload.capabilityId, actionId: 'ACTION-OTHER', attemptId: payload.attemptId,
      ...(payload.attemptContext ? { attemptContext: payload.attemptContext } : {}),
      status: 'reserved', reservedAt: NOW.toISOString(),
    }))
    const reservationClients = createAuthorityExecutionRpcClients({ credential: reservationServer.credential,
      approvalBinding: binding(reservationServer.approvalContext),
      verifierMaterial: reservationServer.verifierMaterial,
      expectedPublicKeyDigest: reservationServer.verifierMaterial.publicKeyDigest,
      transport: (request) => reservationServer.rpc.handle(request), now: () => NOW })
    const { grant, subject } = writeGrant()
    await expect(reservationClients.gatewayAuthority.reserveForSubject({
      grant, currentSubject: subject, capabilityId: 'CAP-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1',
    })).rejects.toMatchObject({ code: 'E2E_RPC_GATEWAY_RESERVATION_BINDING_INVALID' })

    const ackServer = setup()
    ackServer.rpc.registerOperation('gateway.write.complete.v1', async () => ({ completed: false }))
    const ackClients = createAuthorityExecutionRpcClients({ credential: ackServer.credential,
      approvalBinding: binding(ackServer.approvalContext),
      verifierMaterial: ackServer.verifierMaterial, expectedPublicKeyDigest: ackServer.verifierMaterial.publicKeyDigest,
      transport: (request) => ackServer.rpc.handle(request), now: () => NOW })
    await expect(ackClients.gatewayAuthority.complete('RESERVATION-1', digest)).rejects.toMatchObject({
      code: 'E2E_RPC_GATEWAY_COMPLETE_RESULT_INVALID',
    })
  })
})
