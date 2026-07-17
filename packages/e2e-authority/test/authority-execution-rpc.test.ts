import { describe, expect, test } from 'vitest'
import {
  canonicalGrantApprovalSubjectDigest,
  digestText,
  type SignedWriteGrant,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import {
  AuthenticatedRpcServer,
  createAuthorityExecutionRpcClients,
  getTrustedExecutionClientBinding,
  isTrustedLeaseClient,
  isTrustedWriteApprovalClient,
  registerAuthorityExecutionRpcOperations,
} from '../src/index.js'

const NOW = new Date('2026-07-14T10:00:00.000Z')
const digest = digestText('authority-execution-rpc-test/v1', 'value')
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
    revocationSequence: 0, signature: 'signature',
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

describe('Authority execution RPC clients', () => {
  test('只暴露固定的 Write/Lease operation，并登记为绑定公钥摘要的跨进程可信客户端', async () => {
    const { rpc, credential, verifierMaterial, approvalContext } = setup()
    const calls: string[] = []
    registerAuthorityExecutionRpcOperations(rpc, {
      writeAuthority: { async verifyForSubject() { calls.push('write'); return { allowed: true } } },
      leaseAuthority: { async verifyTarget() { calls.push('lease'); return true } },
      gatewayAuthority: {
        async verifyForSubject() { calls.push('gateway-verify'); return { allowed: true } },
        async reserveForSubject(input) { calls.push('gateway-reserve'); return {
          reservationId: 'RESERVATION-1', grantId: input.grant.grantId, capabilityId: input.capabilityId,
          actionId: input.actionId, attemptId: input.attemptId, attemptContext: input.attemptContext,
          status: 'reserved', reservedAt: NOW.toISOString(),
        } },
        async complete() { calls.push('gateway-complete') },
        async markUnknown() { calls.push('gateway-unknown') },
      },
    })
    const clients = createAuthorityExecutionRpcClients({ credential, verifierMaterial,
      approvalBinding: binding(approvalContext),
      expectedPublicKeyDigest: verifierMaterial.publicKeyDigest, transport: (request) => rpc.handle(request), now: () => NOW })
    const { grant, subject } = writeGrant()

    await expect(clients.writeApproval.verifyForSubject(grant, subject)).resolves.toEqual({ allowed: true })
    await expect(clients.lease.verifyTarget('LEASE-1', 1, digest)).resolves.toBe(true)
    await expect(clients.gatewayAuthority.verifyForSubject(grant, grant.subject)).resolves.toEqual({ allowed: true })
    const reservation = await clients.gatewayAuthority.reserveForSubject({
      grant, currentSubject: subject, capabilityId: 'CAP-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1',
      attemptContext: { assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digest,
        runId: 'RUN-1', caseId: 'CASE-1' },
    })
    expect(reservation).toMatchObject({ reservationId: 'RESERVATION-1', status: 'reserved' })
    await clients.gatewayAuthority.complete(reservation.reservationId, digest)
    await clients.gatewayAuthority.markUnknown('RESERVATION-2', 'upstream-disconnected')
    expect(calls).toEqual(['write', 'lease', 'gateway-verify', 'gateway-reserve', 'gateway-complete', 'gateway-unknown'])
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
