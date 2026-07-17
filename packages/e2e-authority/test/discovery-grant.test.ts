import { describe, expect, test } from 'vitest'
import {
  digestText, type DiscoveryApprovalSubject, type ReadApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from './approval-authority.fixture.js'

const digest = (value: string) => digestText('discovery-test/v1', value)

function subject(): DiscoveryApprovalSubject {
  return {
    schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision: digest('prd'), scopeDigest: digest('scope'),
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'auditor',
    expectedPageIdentity: {
      url: 'https://test.example.com/orders', title: '订单', heading: '订单列表',
      ariaSignals: ['main:订单列表'],
    },
    bootstrapIntentsDigest: digest('bootstrap-intents'),
    actions: [{ actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation', maxUses: 1 }],
  }
}

function readSubject(
  discovery: DiscoveryApprovalSubject,
  discoveryGrantId: string,
  preflightDigest: string,
): ReadApprovalSubject {
  return {
    schemaVersion: '2.0.0', assetId: discovery.assetId, prdRevision: discovery.prdRevision,
    scopeDigest: discovery.scopeDigest, requirementModelDigest: digest('model'),
    coveragePolicyDigest: digest('coverage'), universeDigest: digest('universe'),
    caseDigest: digest('case'), actionMapDigest: digest('actions'), policyDigest: digest('policy'),
    executionContractDigest: digest('execution'), runBundleProjectionDigest: digest('run-bundle'),
    environment: discovery.environment, baseOrigin: discovery.baseOrigin, actor: discovery.actor,
    discoveryGrantId, preflightDigest,
    actions: [{ actionId: 'ACTION-READ', operation: 'dom-read', maxUses: 1 }],
  }
}

describe('LocalApprovalAuthority discovery grants', () => {
  test('只签发绑定 Scope、actor、页面身份和 bootstrap 的短期只读 capability', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'discovery-key', now: () => new Date('2026-07-12T10:00:00.000Z'),
    })
    const grant = await authority.issueDiscoveryGrant({
      subject: subject(), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(await authority.verifyForSubject(grant, subject())).toEqual({ allowed: true })
    expect(grant.capabilities).toEqual([expect.objectContaining({
      actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation', effect: 'read', maxUses: 1,
    })])
    expect(await authority.verifyForSubject(grant, {
      ...subject(), actor: 'ordinary-user',
    })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SUBJECT_MISMATCH' })
    expect(await authority.verifyForSubject(grant, {
      ...subject(), expectedPageIdentity: { ...subject().expectedPageIdentity, url: 'https://test.example.com/login' },
    })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SUBJECT_MISMATCH' })

    await expect(authority.reserveForSubject({
      grant, currentSubject: { ...subject(), actor: 'ordinary-user' },
      capabilityId: grant.capabilities[0]!.capabilityId, actionId: 'ACTION-PREFLIGHT', attemptId: 'ATTEMPT-DENIED',
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SUBJECT_MISMATCH' })
    const reservation = await authority.reserveForSubject({
      grant, currentSubject: subject(), capabilityId: grant.capabilities[0]!.capabilityId,
      actionId: 'ACTION-PREFLIGHT', attemptId: 'ATTEMPT-PREFLIGHT',
    })
    expect(reservation).toMatchObject({ status: 'reserved', actionId: 'ACTION-PREFLIGHT' })
    await expect(authority.reserveForSubject({
      grant, currentSubject: subject(), capabilityId: grant.capabilities[0]!.capabilityId,
      actionId: 'ACTION-PREFLIGHT', attemptId: 'ATTEMPT-PREFLIGHT',
    })).resolves.toEqual(reservation)
    await expect(authority.reserveForSubject({
      grant, currentSubject: subject(), capabilityId: grant.capabilities[0]!.capabilityId,
      actionId: 'ACTION-CHANGED', attemptId: 'ATTEMPT-PREFLIGHT',
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_DISCOVERY_RESERVATION_REPLAY_MISMATCH' })
    await expect(authority.reserveForSubject({
      grant, currentSubject: subject(), capabilityId: grant.capabilities[0]!.capabilityId,
      actionId: 'ACTION-PREFLIGHT', attemptId: 'ATTEMPT-NEW',
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_CAPABILITY_EXHAUSTED' })
  })

  test('签发入口只读取一次 subject，Getter 不能在校验后换 target', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'discovery-key', now: () => new Date('2026-07-12T10:00:00.000Z'),
    })
    const approved = subject()
    let identityReads = 0
    const changingSubject = new Proxy(approved, {
      get(target, property, receiver) {
        if (property === 'expectedPageIdentity') {
          identityReads += 1
          return identityReads === 1
            ? target.expectedPageIdentity
            : { ...target.expectedPageIdentity, url: 'https://evil.example.com/orders' }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const grant = await authority.issueDiscoveryGrant({
      subject: changingSubject, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(grant.subject.expectedPageIdentity.url).toBe('https://test.example.com/orders')
    expect(grant.capabilities[0]!.targetUrl).toBe('https://test.example.com/orders')
  })

  test('拒绝写操作、空 actor、跨 origin 页面和过长 TTL', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'discovery-key', now: () => new Date('2026-07-12T10:00:00.000Z'),
    })
    const invalidSubjects = [
      { ...subject(), actor: '' },
      { ...subject(), expectedPageIdentity: { ...subject().expectedPageIdentity, url: 'https://evil.example.com/orders' } },
      { ...subject(), actions: [{ actionId: 'ACTION-WRITE', operation: 'write' as 'local-navigation', maxUses: 1 }] },
    ]
    for (const candidate of invalidSubjects) {
      await expect(authority.issueDiscoveryGrant({
        subject: candidate, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_DISCOVERY_SCOPE_INVALID' })
    }
    await expect(authority.issueDiscoveryGrant({
      subject: subject(), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 8 * 60 * 60 * 1000 + 1,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_TTL_INVALID' })
  })

  test('没有同主体且 ready 的已完成 Discovery preflight 时拒绝签发 Read Grant', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'discovery-key', now: () => new Date('2026-07-12T10:00:00.000Z'),
    })
    const discovery = subject()
    await expect(authority.issueReadGrant({
      subject: readSubject(discovery, 'GRANT-NOT-COMPLETED', digest('preflight')),
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    } as never)).rejects.toMatchObject({ code: 'E2E_APPROVAL_PREFLIGHT_REQUIRED' })
  })

  test('失败 preflight 或换 Revision/actor 均不能签发 Read Grant', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'discovery-key', now: () => new Date('2026-07-12T10:00:00.000Z'),
    })
    const discovery = subject()
    const grant = await authority.issueDiscoveryGrant({
      subject: discovery, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const reservation = await authority.reserveForSubject({
      grant, currentSubject: discovery, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-BLOCKED',
    })
    const blockedDigest = await authority.completeDiscoveryPreflight({
      grant, currentSubject: discovery, reservationId: reservation.reservationId,
      capabilityId: capability.capabilityId,
      outcome: { status: 'input-blocked', reasonCode: 'E2E_RUNTIME_ROLE_MISMATCH' },
    })
    await expect(authority.issueReadGrant({
      subject: readSubject(discovery, grant.grantId, blockedDigest),
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_PREFLIGHT_REQUIRED' })

    const readyGrant = await authority.issueDiscoveryGrant({
      subject: discovery, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const readyCapability = readyGrant.capabilities[0]!
    const readyReservation = await authority.reserveForSubject({
      grant: readyGrant, currentSubject: discovery, capabilityId: readyCapability.capabilityId,
      actionId: readyCapability.actionId, attemptId: 'ATTEMPT-READY',
    })
    const readyDigest = await authority.completeDiscoveryPreflight({
      grant: readyGrant, currentSubject: discovery, reservationId: readyReservation.reservationId,
      capabilityId: readyCapability.capabilityId,
      outcome: { status: 'ready', observedIdentity: {
        url: discovery.expectedPageIdentity.url, title: '订单', headings: ['订单列表'],
        role: 'auditor', ariaSignals: ['main:订单列表'],
      } },
    })
    await expect(authority.completeDiscoveryPreflight({
      grant: readyGrant, currentSubject: discovery,
      reservationId: readyReservation.reservationId,
      capabilityId: readyCapability.capabilityId,
      outcome: { status: 'ready', observedIdentity: {
        url: discovery.expectedPageIdentity.url, title: '订单', headings: ['订单列表'],
        role: 'auditor', ariaSignals: ['main:订单列表'],
      } },
    })).resolves.toBe(readyDigest)
    await expect(authority.completeDiscoveryPreflight({
      grant: readyGrant, currentSubject: discovery,
      reservationId: readyReservation.reservationId,
      capabilityId: readyCapability.capabilityId,
      outcome: { status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH' },
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_PREFLIGHT_RESERVATION_INVALID' })
    await expect(authority.issueReadGrant({
      subject: { ...readSubject(discovery, readyGrant.grantId, readyDigest), prdRevision: digest('changed-prd') },
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_PREFLIGHT_REQUIRED' })
    await expect(authority.issueReadGrant({
      subject: { ...readSubject(discovery, readyGrant.grantId, readyDigest), actor: 'ordinary-user' },
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_PREFLIGHT_REQUIRED' })

    const approvedRead = readSubject(discovery, readyGrant.grantId, readyDigest)
    let revisionReads = 0
    const changingRead = new Proxy(approvedRead, {
      get(target, property, receiver) {
        if (property === 'prdRevision') {
          revisionReads += 1
          return revisionReads === 1 ? target.prdRevision : digest('changed-after-check')
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const readGrant = await authority.issueReadGrant({
      subject: changingRead, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    expect(readGrant.subject.prdRevision).toBe(discovery.prdRevision)
  })

  test('已完成 preflight 的精确恢复不受随后 grant 过期影响', async () => {
    let now = new Date('2026-07-12T10:00:00.000Z')
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'discovery-key', now: () => now,
    })
    const discovery = subject()
    const grant = await authority.issueDiscoveryGrant({
      subject: discovery, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const reservation = await authority.reserveForSubject({
      grant, currentSubject: discovery, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-EXPIRY-RECOVERY',
    })
    const input = {
      grant, currentSubject: discovery, reservationId: reservation.reservationId,
      capabilityId: capability.capabilityId,
      outcome: { status: 'ready' as const, observedIdentity: {
        url: discovery.expectedPageIdentity.url, title: '订单', headings: ['订单列表'],
        role: 'auditor', ariaSignals: ['main:订单列表'],
      } },
    }
    const digest = await authority.completeDiscoveryPreflight(input)
    now = new Date('2026-07-12T10:02:00.000Z')
    await expect(authority.completeDiscoveryPreflight(input)).resolves.toBe(digest)
  })
})
