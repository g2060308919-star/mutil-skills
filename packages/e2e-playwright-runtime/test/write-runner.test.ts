import { describe, expect, test } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import {
  AuthenticatedRpcServer,
  LocalApprovalAuthority,
  LocalLeaseAuthority,
  createAuthorityExecutionRpcClients,
  registerAuthorityExecutionRpcOperations,
} from '@mutil-skills/e2e-authority'
import {
  runReversibleWriteCase,
  createTestWriteRuntimeSession,
  type RunReversibleWriteCaseInput,
  type WriteBrowserPageAdapter,
} from '../src/index.js'

const inProcessRuntime = () => createTestWriteRuntimeSession({
  sandboxHealthy: true, gatewayConnected: true, authorityTransport: 'in-process-test',
})
const rpcRuntime = (authorityRpcPublicKeyDigest: string) => createTestWriteRuntimeSession({
  sandboxHealthy: true, gatewayConnected: true, authorityTransport: 'authenticated-rpc',
  authorityRpcPublicKeyDigest,
})

function fakePage(): WriteBrowserPageAdapter & { actions: string[] } {
  const actions: string[] = []
  return {
    actions,
    async goto(url) { actions.push(`goto:${url}`) },
    async identity() { return { url: 'https://test.example.com/orders/100', title: '订单审批', headings: ['订单 100'] } },
    async containsText(text) { return text === '待审核' || text === '已批准' },
    async waitForText(text) { actions.push(`wait:${text}`); return text === '已批准' },
    async clickButton(name) { actions.push(`click:${name}`) },
    async screenshot() { return new Uint8Array([1, 2, 3]) },
    async domSnapshot() { return '<main><h1>订单 100</h1><span>已批准</span></main>' },
  }
}

const targetFingerprint = digestText('write-runner-test/v1', 'target')
const now = () => new Date('2026-07-11T10:00:00.000Z')

async function trustedContext(input: { authorizationAllowed: boolean; leaseAllowed: boolean }): Promise<{
  authorization: RunReversibleWriteCaseInput['authorization']
  lease: RunReversibleWriteCaseInput['lease']
  rpcHostAuthorities: { approval: LocalApprovalAuthority; lease: LocalLeaseAuthority }
}> {
  const leaseAuthority = new LocalLeaseAuthority({ now })
  const acquired = await leaseAuthority.acquire({
    runId: 'RUN-1', resourceKey: 'order:100', resourceFingerprint: targetFingerprint,
    exclusive: true, ttlMs: 60_000,
  })
  const active = await leaseAuthority.activate(acquired.leaseId)
  const authority = LocalApprovalAuthority.create({
    issuer: 'AUTHORITY', keyId: 'KEY-1', now,
    approvalIdentities: [{ subject: 'os-user:test', roles: ['e2e-approver'] }],
    authenticateApproverSession: (sessionRef, expected) => sessionRef === 'test-session' ? {
      subject: 'os-user:test', runId: 'RUN-1', approvalType: expected.approvalType,
      subjectDigest: expected.subjectDigest, installationDigest: `sha256:${'a'.repeat(64)}`,
      origin: 'http://127.0.0.1:43210', issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    } : undefined,
  })
  const prdRevision = digestText('write-runner-test/v1', 'prd')
  const scopeDigest = digestText('write-runner-test/v1', 'scope')
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'ASSET-1', prdRevision, scopeDigest,
    environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'operator',
    expectedPageIdentity: { url: 'https://test.example.com/orders/100', title: '订单审批', heading: '订单 100', ariaSignals: ['main'] },
    bootstrapIntentsDigest: digestText('write-runner-test/v1', 'bootstrap'),
    requests: [],
    actions: [{
      actionId: 'ACTION-DISCOVERY', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [],
    }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject,
    approver: { subject: 'os-user:test', roles: ['e2e-approver'] }, approvalSessionRef: 'test-session', ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant: discovery, currentSubject: discoverySubject,
    capabilityId: discovery.capabilities[0]!.capabilityId, actionId: 'ACTION-DISCOVERY', attemptId: 'ATTEMPT-DISCOVERY' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery, currentSubject: discoverySubject,
    reservationId: reservation.reservationId, capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'https://test.example.com/orders/100', title: '订单审批',
      headings: ['订单 100'], role: 'operator', ariaSignals: ['main'] } } })
  const projectionDigest = digestText('write-runner-test/v1', 'projection')
  const grant = await authority.issueWriteGrant({
    subject: {
      schemaVersion: '2.0.0', assetId: 'ASSET-1', prdRevision,
      executionDigest: digestText('write-runner-test/v1', 'execution'), environment: 'test',
      baseOrigin: 'https://test.example.com', scopeDigest, requirementModelDigest: projectionDigest,
      coveragePolicyDigest: projectionDigest, universeDigest: projectionDigest, caseDigest: projectionDigest,
      actionMapDigest: projectionDigest, policyDigest: projectionDigest, executionContractDigest: projectionDigest,
      runBundleProjectionDigest: projectionDigest, actor: 'operator', discoveryGrantId: discovery.grantId,
      preflightDigest, actions: [{
        actionId: 'ACTION-APPROVE', effect: 'reversible-write', dataLeaseId: active.leaseId,
        fencingToken: active.fencingToken, cleanupPlanDigest: digestText('write-runner-test/v1', 'cleanup'),
        requests: [{ intentId: 'INTENT-WRITE', method: 'POST', canonicalOrigin: 'https://test.example.com',
          exactPath: '/orders/100', query: [], payload: { kind: 'no-body' }, targetFingerprint,
          maxRequests: 1, expectedOrder: 1 }],
      }],
    },
    approver: { subject: 'os-user:test', roles: ['e2e-approver'] },
    approvalSessionRef: 'test-session', ttlMs: 60_000,
  })
  if (!input.authorizationAllowed) await authority.revoke(grant.grantId, 'test revocation')
  if (!input.leaseAllowed) await leaseAuthority.quarantine(active.leaseId, 'test quarantine')
  return { authorization: { grant, currentSubject: grant.subject,
      authority: authority.createWriteExecutionClient(grant.approvalContext) },
    lease: { leaseId: active.leaseId, fencingToken: active.fencingToken, targetFingerprint,
      authority: leaseAuthority.createExecutionClient() },
    rpcHostAuthorities: { approval: authority, lease: leaseAuthority } }
}

async function rpcTrustedContext(): Promise<Awaited<ReturnType<typeof trustedContext>> & {
  expectedAuthorityRpcPublicKeyDigest: string
}> {
  const trusted = await trustedContext({ authorizationAllowed: true, leaseAllowed: true })
  const rpc = AuthenticatedRpcServer.create({ issuer: 'authority-host', keyId: 'rpc-key-1', now })
  const credential = rpc.registerClient('runner-process', Buffer.alloc(32, 11), {
    approvalContext: trusted.authorization.grant.approvalContext,
  })
  registerAuthorityExecutionRpcOperations(rpc, {
    writeAuthority: trusted.rpcHostAuthorities.approval,
    leaseAuthority: trusted.rpcHostAuthorities.lease,
  })
  const material = rpc.verifierMaterial
  const clients = createAuthorityExecutionRpcClients({ credential, verifierMaterial: material,
    approvalBinding: {
      runId: trusted.authorization.grant.approvalContext.runId,
      installationDigest: trusted.authorization.grant.approvalContext.installationDigest,
      approvalType: trusted.authorization.grant.approvalContext.approvalType,
      subjectDigest: trusted.authorization.grant.approvalContext.subjectDigest,
    },
    expectedPublicKeyDigest: material.publicKeyDigest, transport: (request) => rpc.handle(request), now })
  return {
    authorization: { ...trusted.authorization, authority: clients.writeApproval },
    lease: { ...trusted.lease, authority: clients.lease },
    rpcHostAuthorities: trusted.rpcHostAuthorities,
    expectedAuthorityRpcPublicKeyDigest: material.publicKeyDigest,
  }
}

describe('runReversibleWriteCase', () => {
  test('rejects caller-injected verifier objects even when they always return true', async () => {
    const page = fakePage()
    const trusted = await trustedContext({ authorizationAllowed: true, leaseAllowed: true })
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      authorization: { ...trusted.authorization,
        authority: { async verifyForSubject() { return { allowed: true as const } } } as any },
      lease: { ...trusted.lease,
        authority: { async verifyTarget() { return true } } as any },
      runtime: inProcessRuntime(),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({
      status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_TRUSTED_AUTHORITY_CLIENT_REQUIRED',
    })
    expect(page.actions).toEqual([])
  })

  test('fails closed before page access without an active verified lease', async () => {
    const page = fakePage()
    const trusted = await trustedContext({ authorizationAllowed: true, leaseAllowed: false })
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      ...trusted,
      runtime: inProcessRuntime(),
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({ status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_ACTIVE_LEASE_REQUIRED' })
    expect(page.actions).toEqual([])
  })

  test('fails closed before page access when Authority rejects the current write subject', async () => {
    const page = fakePage()
    const trusted = await trustedContext({ authorizationAllowed: false, leaseAllowed: true })
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      ...trusted,
      runtime: inProcessRuntime(),
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({ status: 'safety-blocked', reasonCode: 'E2E_APPROVAL_REVOKED' })
    expect(page.actions).toEqual([])
  })

  test('fails closed before verifier calls when signed capability does not bind the exact Lease target', async () => {
    const page = fakePage()
    const trusted = await trustedContext({ authorizationAllowed: true, leaseAllowed: true })
    const mismatched = trusted.authorization
    ;(mismatched.grant.capabilities[0] as any).dataLeaseId = 'LEASE-OTHER'
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      authorization: mismatched, lease: trusted.lease,
      runtime: inProcessRuntime(),
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} }, page,
    })

    expect(result).toMatchObject({ status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_WRITE_LEASE_BINDING_MISMATCH' })
    expect(page.actions).toEqual([])
  })

  test('executes one controlled write and captures browser plus gateway evidence', async () => {
    const page = fakePage()
    const trusted = await trustedContext({ authorizationAllowed: true, leaseAllowed: true })
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      ...trusted,
      runtime: inProcessRuntime(),
      gatewayAudit: () => ({ received: 1, forwarded: 1, blocked: 0, byIntent: { 'INTENT-APPROVE': 1 } }), page,
    })

    expect(result).toMatchObject({ status: 'passed', expected: ['状态从“待审核”变为“已批准”'] })
    expect(page.actions).toEqual([
      'goto:https://test.example.com/orders/100', 'click:批准订单', 'wait:已批准',
    ])
    expect(result.evidence).toHaveLength(3)
  })

  test('生产 RPC 模式拒绝内进程客户端和错误的 Authority 公钥摘要', async () => {
    const inProcess = await trustedContext({ authorizationAllowed: true, leaseAllowed: true })
    const firstPage = fakePage()
    const first = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' }, ...inProcess,
      runtime: rpcRuntime(digestText('write-runner-test/v1', 'wrong-rpc-key')),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page: firstPage,
    })
    expect(first).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_RUNTIME_AUTHORITY_TRANSPORT_MISMATCH' })
    expect(firstPage.actions).toEqual([])

    const rpc = await rpcTrustedContext()
    const secondPage = fakePage()
    const second = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      authorization: rpc.authorization, lease: rpc.lease,
      runtime: rpcRuntime(digestText('write-runner-test/v1', 'substituted-rpc-key')),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page: secondPage,
    })
    expect(second).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_RUNTIME_AUTHORITY_TRANSPORT_MISMATCH' })
    expect(secondPage.actions).toEqual([])
  })

  test('固定 Authority RPC 公钥摘要后通过跨进程客户端执行', async () => {
    const rpc = await rpcTrustedContext()
    const page = fakePage()
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' },
      authorization: rpc.authorization, lease: rpc.lease,
      runtime: rpcRuntime(rpc.expectedAuthorityRpcPublicKeyDigest),
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    })
    expect(result).toMatchObject({ status: 'passed' })
  })

  test('拒绝调用方自报 sandbox/gateway 健康布尔值', async () => {
    const trusted = await trustedContext({ authorizationAllowed: true, leaseAllowed: true })
    const page = fakePage()
    const result = await runReversibleWriteCase({
      caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: 'https://test.example.com/orders/100',
      buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
      expectedIdentity: { title: '订单审批', heading: '订单 100' }, ...trusted,
      runtime: { sandboxHealthy: true, gatewayConnected: true } as any,
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} }, page,
    })
    expect(result).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_RUNTIME_TRUSTED_SESSION_REQUIRED' })
    expect(page.actions).toEqual([])
  })
})
