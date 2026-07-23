import { describe, expect, test } from 'vitest'
import {
  digestText,
  type BrowserLocalReversibleWriteCapability,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from './approval-authority.fixture.js'

const NOW = new Date('2026-07-22T10:00:00.000Z')
const digest = (value: string) => digestText('authority-browser-local-test/v1', value)
const programDigest = digest('program')
const cleanupProgramDigest = digest('cleanup-program')
const cleanupPlanDigest = digest('cleanup-plan')
const request = {
  intentId: 'INTENT-1', method: 'POST', canonicalOrigin: 'https://test.example.com', exactPath: '/todos',
  query: [['source', 'playwright']] as Array<[string, string]>,
  payload: { kind: 'json' as const, digest: digest('payload') },
  targetFingerprint: digest('target'), maxRequests: 1, expectedOrder: 1,
}
const attemptContext = {
  assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digest('revision'),
  runId: 'RUN-TEST', caseId: 'CASE-1',
}
let discoveryAttemptSequence = 0

async function browserLocalSubject(authority: ReturnType<typeof LocalApprovalAuthority.create>): Promise<WriteApprovalSubject> {
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'ASSET-1', prdRevision: digest('revision'),
    scopeDigest: digest('scope'), environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'qa',
    expectedPageIdentity: { url: 'https://test.example.com/todos', title: 'Todos', heading: 'Todos', ariaSignals: ['main'] },
    bootstrapIntentsDigest: digest('bootstrap'), requests: [],
    actions: [{ actionId: 'DISCOVERY-1', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [] }],
  }
  const discovery = await authority.issueDiscoveryGrant({
    subject: discoverySubject, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
  })
  const reservation = await authority.reserveForSubject({
    grant: discovery, currentSubject: discoverySubject, capabilityId: discovery.capabilities[0]!.capabilityId,
    actionId: 'DISCOVERY-1', attemptId: `ATTEMPT-DISCOVERY-${++discoveryAttemptSequence}`,
  })
  const preflightDigest = await authority.completeDiscoveryPreflight({
    grant: discovery, currentSubject: discoverySubject, reservationId: reservation.reservationId,
    capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'https://test.example.com/todos', title: 'Todos',
      headings: ['Todos'], role: 'qa', ariaSignals: ['main'] } },
  })
  return {
    schemaVersion: '2.0.0', assetId: 'ASSET-1', prdRevision: digest('revision'), executionDigest: digest('execution'),
    scopeDigest: digest('scope'), requirementModelDigest: digest('requirements'), coveragePolicyDigest: digest('coverage'),
    universeDigest: digest('universe'), caseDigest: digest('case'), actionMapDigest: digest('actions'),
    policyDigest: digest('policy'), executionContractDigest: digest('contract'),
    runBundleProjectionDigest: digest('bundle'), actor: 'qa', discoveryGrantId: discovery.grantId, preflightDigest,
    environment: 'test', baseOrigin: 'https://test.example.com',
    actions: [{
      actionId: 'ACTION-1', transport: 'browser-local', operation: 'full-playwright', effect: 'reversible-write',
      programDigest, cleanupProgramDigest, dataLeaseId: 'LEASE-1', fencingToken: 7, cleanupPlanDigest,
      requests: [request],
    }],
  }
}

async function issueBrowserLocalGrant(authority: ReturnType<typeof LocalApprovalAuthority.create>) {
  const subject = await browserLocalSubject(authority)
  const grant = await authority.issueWriteGrant({
    subject, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
  })
  return { subject, grant, capability: grant.capabilities[0]! as BrowserLocalReversibleWriteCapability }
}

describe('LocalApprovalAuthority browser-local write grants', () => {
  test('签发原样冻结 full-playwright capability，并拒绝 subject 或 capability 任一边界漂移', async () => {
    const authority = LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-1', now: () => NOW })
    const { subject, grant, capability } = await issueBrowserLocalGrant(authority)

    expect(capability).toMatchObject({
      transport: 'browser-local', operation: 'full-playwright', effect: 'reversible-write',
      actionId: 'ACTION-1', programDigest, cleanupProgramDigest, dataLeaseId: 'LEASE-1', fencingToken: 7,
      cleanupPlanDigest, requests: [request], maxUses: 1,
    })
    expect(await authority.verifyForSubject(grant, subject)).toEqual({ allowed: true })

    const action = subject.actions[0]!
    const changedSubjects = [
      { ...subject, actions: [{ ...action, programDigest: digest('changed-program') }] },
      { ...subject, actions: [{ ...action, cleanupProgramDigest: digest('changed-cleanup-program') }] },
      { ...subject, actions: [{ ...action, transport: 'http' }] },
      { ...subject, actions: [{ ...action, operation: 'http-request' }] },
      { ...subject, actions: [{ ...action, dataLeaseId: 'LEASE-2' }] },
      { ...subject, actions: [{ ...action, fencingToken: 8 }] },
      { ...subject, actions: [{ ...action, cleanupPlanDigest: digest('changed-cleanup-plan') }] },
      { ...subject, actions: [{ ...action, requests: [{ ...request, exactPath: '/other' }] }] },
    ] as unknown as WriteApprovalSubject[]
    for (const currentSubject of changedSubjects) {
      expect(await authority.verifyForSubject(grant, currentSubject)).toMatchObject({
        allowed: false, code: expect.stringMatching(/^E2E_APPROVAL_(SUBJECT_MISMATCH|SUBJECT_INVALID)$/),
      })
    }

    const changedCapabilities = [
      { ...capability, programDigest: digest('tampered-program') },
      { ...capability, cleanupProgramDigest: digest('tampered-cleanup') },
      { ...capability, transport: 'http' as const, operation: 'http-request' as const },
      { ...capability, dataLeaseId: 'LEASE-OTHER' },
      { ...capability, fencingToken: 8 },
      { ...capability, cleanupPlanDigest: digest('tampered-plan') },
      { ...capability, requests: [{ ...request, method: 'DELETE' }] },
    ] as unknown as typeof grant.capabilities
    for (const changedCapability of changedCapabilities) {
      expect(await authority.verify({ ...grant, capabilities: [changedCapability] })).toMatchObject({
        allowed: false, code: 'E2E_APPROVAL_SIGNATURE_INVALID',
      })
    }
  })

  test('browser-local reservation 只能消费一次，并保留 complete 与 unknown 终态', async () => {
    const authority = LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-1', now: () => NOW })
    const first = await issueBrowserLocalGrant(authority)
    const reserved = await authority.reserveForSubject({
      grant: first.grant, currentSubject: first.subject, capabilityId: first.capability.capabilityId,
      actionId: first.capability.actionId, attemptId: 'ATTEMPT-1', attemptContext,
    })
    await authority.markUnknown(reserved.reservationId, 'browser process disconnected')
    expect(authority.getReservation(reserved.reservationId)).toMatchObject({ status: 'unknown' })
    await expect(authority.reserveForSubject({
      grant: first.grant, currentSubject: first.subject, capabilityId: first.capability.capabilityId,
      actionId: first.capability.actionId, attemptId: 'ATTEMPT-2', attemptContext,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_CAPABILITY_EXHAUSTED' })

    const second = await issueBrowserLocalGrant(authority)
    const completed = await authority.reserveForSubject({
      grant: second.grant, currentSubject: second.subject, capabilityId: second.capability.capabilityId,
      actionId: second.capability.actionId, attemptId: 'ATTEMPT-3', attemptContext,
    })
    await authority.complete(completed.reservationId, digest('outcome'))
    expect(authority.getReservation(completed.reservationId)).toMatchObject({
      status: 'completed', outcomeDigest: digest('outcome'),
    })
  })
})
