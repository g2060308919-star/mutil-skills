import { describe, expect, test } from 'vitest'
import { digestText, type ReadApprovalSubject } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from './approval-authority.fixture.js'

const digest = digestText('test/v1', 'value')

function subject(preflight: { discoveryGrantId: string; preflightDigest: string }): ReadApprovalSubject {
  return {
    schemaVersion: '2.1.0',
    assetId: 'PRODUCT/PRD-1',
    prdRevision: digest,
    scopeDigest: digest,
    requirementModelDigest: digest,
    coveragePolicyDigest: digest,
    universeDigest: digest,
    caseDigest: digest,
    actionMapDigest: digest,
    policyDigest: digest,
    executionContractDigest: digest,
    runBundleProjectionDigest: digest,
    environment: 'test',
    baseOrigin: 'https://test.example.com',
    actor: 'auditor',
    ...preflight,
    requests: [],
    actions: [{ actionId: 'ACTION-READ-1', operation: 'dom-read', maxUses: 1, requestIds: [] }],
  }
}

async function readyPreflight(authority: LocalApprovalAuthority): Promise<{
  discoveryGrantId: string; preflightDigest: string
}> {
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'PRODUCT/PRD-1', prdRevision: digest, scopeDigest: digest,
    environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'auditor',
    expectedPageIdentity: {
      url: 'https://test.example.com/orders', title: '订单', heading: '订单列表', ariaSignals: ['main:订单列表'],
    },
    bootstrapIntentsDigest: digest,
    requests: [],
    actions: [{
      actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [],
    }],
  }
  const grant = await authority.issueDiscoveryGrant({
    subject: discoverySubject, approver: { subject: 'os-user:zhangxudong', roles: ['e2e-approver'] }, ttlMs: 60_000,
  })
  const capability = grant.capabilities[0]!
  const reservation = await authority.reserveForSubject({
    grant, currentSubject: discoverySubject, capabilityId: capability.capabilityId,
    actionId: capability.actionId, attemptId: 'ATTEMPT-PREFLIGHT',
  })
  const preflightDigest = await authority.completeDiscoveryPreflight({
    grant, currentSubject: discoverySubject, reservationId: reservation.reservationId,
    capabilityId: capability.capabilityId,
    outcome: {
      status: 'ready', observedIdentity: {
        url: discoverySubject.expectedPageIdentity.url, title: '订单', headings: ['订单列表'],
        role: 'auditor', ariaSignals: ['main:订单列表'],
      },
    },
  })
  return { discoveryGrantId: grant.grantId, preflightDigest }
}

describe('LocalApprovalAuthority', () => {
  test('signs and verifies a local read grant with an explicit proof scope', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority',
      keyId: 'local-key-1',
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const preflight = await readyPreflight(authority)
    await expect(authority.issueReadGrant({
      subject: { ...subject(preflight), schemaVersion: '1.0.0' } as any,
      approver: { subject: 'os-user:zhangxudong', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_READ_SUBJECT_INVALID' })
    const grant = await authority.issueReadGrant({
      subject: subject(preflight),
      approver: { subject: 'os-user:zhangxudong', roles: ['e2e-approver'] },
      ttlMs: 60_000,
    })

    expect(await authority.verify(grant)).toMatchObject({ allowed: true })
    expect(grant.proofScope).toBe('local-os-user')
    expect(grant.capabilities[0]).toMatchObject({ actionId: 'ACTION-READ-1', maxUses: 1 })
  })

  test('rejects tampered, expired, revoked, and unknown-key grants', async () => {
    let now = new Date('2026-07-11T10:00:00.000Z')
    const authority = LocalApprovalAuthority.create({ issuer: 'local-authority', keyId: 'local-key-1', now: () => now })
    const preflight = await readyPreflight(authority)
    const grant = await authority.issueReadGrant({
      subject: subject(preflight),
      approver: { subject: 'os-user:zhangxudong', roles: ['e2e-approver'] },
      ttlMs: 1_000,
    })

    expect(await authority.verify({ ...grant, keyId: 'unknown-key' })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_KEY_UNKNOWN' })
    expect(await authority.verify({ ...grant, subject: { ...grant.subject, baseOrigin: 'https://evil.example.com' } })).toMatchObject({
      allowed: false,
      code: 'E2E_APPROVAL_SIGNATURE_INVALID',
    })
    now = new Date('2026-07-11T10:00:02.000Z')
    expect(await authority.verify(grant)).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_EXPIRED' })
    now = new Date('2026-07-11T10:00:00.500Z')
    await authority.revoke(grant.grantId, 'user revoked')
    expect(await authority.verify(grant)).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_REVOKED' })
  })

  test('allows only one concurrent reservation for a one-use capability', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority',
      keyId: 'local-key-1',
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const preflight = await readyPreflight(authority)
    const grant = await authority.issueReadGrant({
      subject: subject(preflight),
      approver: { subject: 'os-user:zhangxudong', roles: ['e2e-approver'] },
      ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const results = await Promise.allSettled([
      authority.reserveForSubject({ grant, currentSubject: grant.subject, capabilityId: capability.capabilityId, actionId: capability.actionId, attemptId: 'ATTEMPT-1' }),
      authority.reserveForSubject({ grant, currentSubject: grant.subject, capabilityId: capability.capabilityId, actionId: capability.actionId, attemptId: 'ATTEMPT-2' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
})
