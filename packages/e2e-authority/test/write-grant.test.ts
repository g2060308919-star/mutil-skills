import { describe, expect, test } from 'vitest'
import { SignedGrantSchema, digestText, type WriteApprovalSubject } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, testApprovalReceipt } from './approval-authority.fixture.js'
import { LocalApprovalAuthority as RuntimeApprovalAuthority } from '../src/index.js'

const digest = digestText('test/v1', 'value')
const attemptContext = {
  assetId: 'PRODUCT-PRD-1', generationId: 'GEN-1', prdRevision: digest, runId: 'RUN-1', caseId: 'CASE-1',
}

async function subject(authority: RuntimeApprovalAuthority, input: {
  approver?: { subject: string; roles: string[] }; approvalSessionRef?: string
} = {}): Promise<WriteApprovalSubject> {
  const approver = input.approver ?? { subject: 'os-user:qa', roles: ['e2e-approver'] }
  const discoverySubject = {
    schemaVersion: '1.0.0' as const, assetId: 'PRODUCT-PRD-1', prdRevision: digest, scopeDigest: digest,
    environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'qa',
    expectedPageIdentity: { url: 'https://test.example.com/orders/100', title: 'Order', heading: 'Order 100', ariaSignals: ['main'] },
    bootstrapIntentsDigest: digest,
    actions: [{ actionId: 'ACTION-DISCOVERY', operation: 'local-navigation' as const, maxUses: 1 }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject, approver,
    ...(input.approvalSessionRef ? { approvalSessionRef: input.approvalSessionRef } : {}), ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant: discovery, currentSubject: discoverySubject,
    capabilityId: discovery.capabilities[0]!.capabilityId, actionId: 'ACTION-DISCOVERY', attemptId: 'ATTEMPT-DISCOVERY' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery, currentSubject: discoverySubject,
    reservationId: reservation.reservationId, capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'https://test.example.com/orders/100', title: 'Order',
      headings: ['Order 100'], role: 'qa', ariaSignals: ['main'] } } })
  return {
    schemaVersion: '2.0.0',
    assetId: 'PRODUCT-PRD-1',
    prdRevision: digest,
    executionDigest: digest,
    scopeDigest: digest, requirementModelDigest: digest, coveragePolicyDigest: digest, universeDigest: digest,
    caseDigest: digest, actionMapDigest: digest, policyDigest: digest, executionContractDigest: digest,
    runBundleProjectionDigest: digest, actor: 'qa', discoveryGrantId: discovery.grantId, preflightDigest,
    environment: 'test',
    baseOrigin: 'https://test.example.com',
    actions: [{
      actionId: 'ACTION-APPROVE-1',
      effect: 'reversible-write',
      dataLeaseId: 'LEASE-1',
      fencingToken: 7,
      cleanupPlanDigest: digest,
      requests: [
        {
          intentId: 'INTENT-LOAD', method: 'GET', canonicalOrigin: 'https://test.example.com', exactPath: '/api/orders/100',
          query: [], payload: { kind: 'no-body' }, targetFingerprint: digest, maxRequests: 1, expectedOrder: 1,
        },
        {
          intentId: 'INTENT-APPROVE', method: 'POST', canonicalOrigin: 'https://test.example.com', exactPath: '/api/orders/100/approve',
          query: [], payload: { kind: 'json', digest }, targetFingerprint: digest, maxRequests: 1, expectedOrder: 2,
        },
      ],
    }],
  }
}

describe('LocalApprovalAuthority write grants', () => {
  test('拒绝 v1 写主题，以及没有同边界 ready Discovery preflight 的 v2 写主题', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const approved = await subject(authority)
    const legacy = { schemaVersion: '1.0.0', assetId: approved.assetId, prdRevision: approved.prdRevision,
      executionDigest: approved.executionDigest, environment: approved.environment,
      baseOrigin: approved.baseOrigin, actions: approved.actions } as WriteApprovalSubject
    await expect(authority.issueWriteGrant({ subject: legacy,
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_WRITE_SUBJECT_INVALID' })
    await expect(authority.issueWriteGrant({ subject: { ...approved, discoveryGrantId: 'DISCOVERY-UNKNOWN',
      preflightDigest: digestText('test/v1', 'unknown-preflight') },
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_PREFLIGHT_REQUIRED' })
  })

  test('登记身份仍必须来自 Authority Host 认证的当前会话，知道 subject/roles 不能冒充', async () => {
    const authority = RuntimeApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
      approvalIdentities: [
        { subject: 'os-user:victim', roles: ['e2e-approver'] },
        { subject: 'os-user:attacker', roles: ['e2e-approver'] },
      ],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'attacker-session'
        ? testApprovalReceipt('os-user:attacker', expected)
        : undefined,
    })

    await expect(authority.issueWriteGrant({
      subject: await subject(authority, { approver: { subject: 'os-user:attacker', roles: ['e2e-approver'] },
        approvalSessionRef: 'attacker-session' }), approver: { subject: 'os-user:victim', roles: ['e2e-approver'] },
      approvalSessionRef: 'attacker-session', ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' })
  })

  test('拒绝调用方自报 e2e-approver，只有可信身份登记中的角色可以签发 Grant', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })

    await expect(authority.issueWriteGrant({
      subject: await subject(authority), approver: { subject: 'os-user:forged', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_APPROVER_UNTRUSTED' })
  })

  test('binds every request, target, lease, and cleanup plan into the signature', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueWriteGrant({
      subject: await subject(authority), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(await authority.verify(grant)).toMatchObject({ allowed: true })
    expect(grant.capabilities[0]?.requests).toHaveLength(2)
    expect(await authority.verify({
      ...grant,
      subject: { ...grant.subject, actions: [{ ...grant.subject.actions[0]!, fencingToken: 8 }] },
    })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SIGNATURE_INVALID' })
  })

  test('a boundary-valid issued Write Grant round-trips through the shared SignedGrant contract', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const approved = await subject(authority)
    const boundary = {
      ...approved,
      actions: [{
        ...approved.actions[0]!,
        requests: approved.actions[0]!.requests.map((request, index) =>
          index === 0 ? { ...request, method: 'X' } : { ...request, method: 'X'.repeat(32) }),
      }],
    }
    const issued = await authority.issueWriteGrant({
      subject: boundary, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(SignedGrantSchema.parse(issued)).toEqual(issued)
  })

  test('旧 Grant 与当前 target、payload、environment 或 Revision 任一不同时均失效', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const approved = await subject(authority)
    const grant = await authority.issueWriteGrant({
      subject: approved, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const changed = [
      { ...approved, prdRevision: digestText('test/v1', 'new-revision') },
      { ...approved, environment: 'staging' as const },
      {
        ...approved,
        actions: [{ ...approved.actions[0]!, requests: approved.actions[0]!.requests.map((request, index) =>
          index === 1 ? { ...request, targetFingerprint: digestText('test/v1', 'new-target') } : request) }],
      },
      {
        ...approved,
        actions: [{ ...approved.actions[0]!, requests: approved.actions[0]!.requests.map((request, index) =>
          index === 1 ? { ...request, payload: { kind: 'json' as const, digest: digestText('test/v1', 'new-payload') } } : request) }],
      },
    ]

    expect(await authority.verifyForSubject(grant, approved)).toEqual({ allowed: true })
    for (const currentSubject of changed) {
      expect(await authority.verifyForSubject(grant, currentSubject)).toMatchObject({
        allowed: false, code: 'E2E_APPROVAL_SUBJECT_MISMATCH',
      })
    }
  })

  test('keeps an unknown write reservation consumed and prevents replay', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueWriteGrant({
      subject: await subject(authority), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const reservation = await authority.reserveForSubject({
      grant, currentSubject: grant.subject, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-1', attemptContext,
    })
    await authority.markUnknown(reservation.reservationId, 'upstream response lost')

    await expect(authority.reserveForSubject({
      grant, currentSubject: grant.subject, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-2', attemptContext,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_CAPABILITY_EXHAUSTED' })
    expect(authority.getReservation(reservation.reservationId)).toMatchObject({ status: 'unknown' })
  })

  test('records the verified outcome digest when a write reservation completes', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueWriteGrant({
      subject: await subject(authority), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const reservation = await authority.reserveForSubject({
      grant, currentSubject: grant.subject, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-1', attemptContext,
    })
    await authority.complete(reservation.reservationId, digest)

    expect(authority.getReservation(reservation.reservationId)).toMatchObject({
      status: 'completed', outcomeDigest: digest,
    })
    await expect(authority.markUnknown(reservation.reservationId, 'late ambiguity'))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_RESERVATION_FINAL' })
  })

  test('allows only one concurrent reservation for a single-use write capability', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueWriteGrant({
      subject: await subject(authority), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const results = await Promise.allSettled(['ATTEMPT-1', 'ATTEMPT-2'].map((attemptId) => authority.reserveForSubject({
      grant, currentSubject: grant.subject, capabilityId: capability.capabilityId, actionId: capability.actionId, attemptId,
      attemptContext,
    })))

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  test('permanently rejects production or non-reversible write subjects at runtime', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const approved = await subject(authority)
    const production = { ...approved, environment: 'production' } as unknown as WriteApprovalSubject
    const irreversible = {
      ...approved,
      actions: [{ ...approved.actions[0]!, effect: 'irreversible-write' }],
    } as unknown as WriteApprovalSubject

    await expect(authority.issueWriteGrant({
      subject: production, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_WRITE_SCOPE_INVALID', retryable: false })
    await expect(authority.issueWriteGrant({
      subject: irreversible, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_WRITE_SCOPE_INVALID', retryable: false })
  })
})
