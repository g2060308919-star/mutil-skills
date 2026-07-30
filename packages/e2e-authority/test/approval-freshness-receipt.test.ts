import { describe, expect, test } from 'vitest'
import {
  canonicalizeJson, digestApprovalProjection, digestText, type ApprovalCapabilityRecord, type ReadApprovalSubject,
  projectScopeDecisionSubject,
} from '@mutil-skills/e2e-contracts'
import { verifyTrustedApprovalFreshnessCurrent } from '../src/index.js'
import { LocalApprovalAuthority } from './approval-authority.fixture.js'

const d = (value: string) => digestText('test/v1', value)

async function readyReadGrant(now: () => Date) {
  const authority = LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-1', now,
    manualIdentities: [{ subject: 'scope-alice', roles: ['scope-approver'] }] })
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'USER',
    expectedPageIdentity: { url: 'https://example.test/', title: 'Home', heading: 'Home', ariaSignals: ['main'] },
    bootstrapIntentsDigest: d('bootstrap'),
    requests: [],
    actions: [{
      actionId: 'DISCOVERY-NAV', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [],
    }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject,
    approver: { subject: 'alice', roles: ['e2e-approver'] }, ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant: discovery, currentSubject: discoverySubject,
    capabilityId: discovery.capabilities[0]!.capabilityId, actionId: 'DISCOVERY-NAV', attemptId: 'ATTEMPT-0' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery,
    currentSubject: discoverySubject, reservationId: reservation.reservationId,
    capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'https://example.test/', title: 'Home',
      headings: ['Home'], role: 'USER', ariaSignals: ['main'] } } })
  const runBundle = { runId: 'RUN-1', allInputRefs: [{ artifactId: 'A', digest: d('input') }],
    schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
    attemptPlans: [{ caseId: 'CASE-1', slots: 1 }], signedCapabilities: [
      { capabilityId: 'PENDING-DOM', actionId: 'ACTION-1', operation: 'dom-read',
        effect: 'read', maxUses: 1, digest: d('pending-dom') },
      { capabilityId: 'PENDING-HTTP', actionId: 'ACTION-1', operation: 'http-request',
        effect: 'read', maxUses: 1, digest: d('pending-http') },
    ],
    secretRefs: ['SECRET-1'], runtimePolicyDigest: d('runtime'),
    runtimeIsolationPolicyDigest: 'not-applicable' }
  const subject: ReadApprovalSubject = {
    schemaVersion: '2.1.0', assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage'), universeDigest: d('universe'),
    caseDigest: d('cases'), actionMapDigest: d('actions'), policyDigest: d('policy'),
    executionContractDigest: d('execution-contract'),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundle), environment: 'test',
    baseOrigin: 'https://example.test', actor: 'USER', discoveryGrantId: discovery.grantId, preflightDigest,
    requests: [{ requestId: 'REQUEST-1', method: 'GET', url: 'https://example.test/api/orders',
      headers: [], bodyDigest: d('empty-body'), redirectPolicy: { mode: 'deny' } }],
    actions: [
      { actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1, requestIds: [] },
      { actionId: 'ACTION-1', operation: 'http-request', maxUses: 1, requestIds: ['REQUEST-1'] },
    ],
  }
  const grant = await authority.issueReadGrant({ subject,
    approver: { subject: 'alice', roles: ['e2e-approver'] }, ttlMs: 30_000 })
  const capabilities: ApprovalCapabilityRecord[] = grant.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId, actionId: capability.actionId,
    operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
    digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
  }))
  runBundle.signedCapabilities = capabilities
  const browserPreflight = { artifactDigest: d('browser-preflight-artifact'),
    discoveryGrantId: discovery.grantId, authorityPreflightDigest: preflightDigest }
  return { authority, grant, subject, capabilities, browserPreflight,
    runBundle: { artifactDigest: d('run-bundle'), content: runBundle } }
}

async function readyWriteGrant(now: () => Date) {
  const authority = LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-1', now })
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'OPERATOR',
    expectedPageIdentity: { url: 'https://example.test/orders/1', title: 'Order', heading: 'Order 1', ariaSignals: ['main'] },
    bootstrapIntentsDigest: d('bootstrap'),
    requests: [],
    actions: [{
      actionId: 'DISCOVERY-NAV', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [],
    }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject,
    approver: { subject: 'alice', roles: ['e2e-approver'] }, ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant: discovery, currentSubject: discoverySubject,
    capabilityId: discovery.capabilities[0]!.capabilityId, actionId: 'DISCOVERY-NAV', attemptId: 'ATTEMPT-0' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery,
    currentSubject: discoverySubject, reservationId: reservation.reservationId,
    capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'https://example.test/orders/1', title: 'Order',
      headings: ['Order 1'], role: 'OPERATOR', ariaSignals: ['main'] } } })
  const runBundle = { runId: 'RUN-WRITE-1', allInputRefs: [{ artifactId: 'A', digest: d('input') }],
    schedule: [{ ordinal: 0, caseId: 'CASE-WRITE-1', stepIds: ['STEP-WRITE-1'], actionIds: ['ACTION-WRITE-1'] }],
    attemptPlans: [{ caseId: 'CASE-WRITE-1', slots: 1 }], signedCapabilities: [{ capabilityId: 'PENDING',
      actionId: 'ACTION-WRITE-1', operation: 'http-request', effect: 'reversible-write', maxUses: 1, digest: d('pending') }],
    secretRefs: ['SECRET-1'], runtimePolicyDigest: d('runtime'),
    runtimeIsolationPolicyDigest: 'not-applicable' }
  const subject = {
    schemaVersion: '2.0.0' as const, assetId: 'ASSET-1', prdRevision: d('prd'), executionDigest: d('execution'),
    scopeDigest: d('scope'), requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage'),
    universeDigest: d('universe'), caseDigest: d('cases'), actionMapDigest: d('actions'), policyDigest: d('policy'),
    executionContractDigest: d('execution-contract'), runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundle),
    environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'OPERATOR',
    discoveryGrantId: discovery.grantId, preflightDigest,
    actions: [{ actionId: 'ACTION-WRITE-1', effect: 'reversible-write' as const, dataLeaseId: 'LEASE-1',
      resourceKey: 'order:1', fencingToken: 7, cleanupPlanDigest: d('cleanup'), requests: [{ intentId: 'INTENT-WRITE-1', method: 'POST',
        canonicalOrigin: 'https://example.test', exactPath: '/api/orders/1/approve', query: [],
        payload: { kind: 'json' as const, digest: d('payload') }, targetFingerprint: d('resource'),
        maxRequests: 1, expectedOrder: 1 }] }],
  }
  const grant = await authority.issueWriteGrant({ subject,
    approver: { subject: 'alice', roles: ['e2e-approver'] }, ttlMs: 30_000 })
  const capabilities: ApprovalCapabilityRecord[] = grant.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId, actionId: capability.actionId, operation: capability.operation,
    effect: capability.effect, maxUses: capability.maxUses,
    digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
  }))
  runBundle.signedCapabilities = capabilities
  return { authority, grant, subject, capabilities,
    browserPreflight: { artifactDigest: d('browser-preflight-artifact'),
      discoveryGrantId: discovery.grantId, authorityPreflightDigest: preflightDigest },
    runBundle: { artifactDigest: d('run-bundle'), content: runBundle } }
}

describe('LocalApprovalAuthority approval freshness receipt', () => {
  test('reversible-write receipt 绑定 v2 审批投影、HTTP capability、租约与清理计划', async () => {
    const fixture = await readyWriteGrant(() => new Date('2026-07-12T00:00:00.000Z'))
    const receipt = await fixture.authority.issueApprovalFreshnessReceipt({
      grant: fixture.grant, currentSubject: fixture.subject, expectedCapabilities: fixture.capabilities,
      browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle,
    })
    expect(receipt).toMatchObject({ grantType: 'reversible-write', status: 'valid',
      executionSubjectSnapshot: { schemaVersion: '2.0.0', actions: [{ dataLeaseId: 'LEASE-1', fencingToken: 7 }] },
      capabilities: [{ operation: 'http-request', effect: 'reversible-write', maxUses: 1 }],
    })
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt,
      currentSubject: fixture.subject, expectedCapabilities: fixture.capabilities,
      browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle,
    })).toMatchObject({ authentic: true, current: true, allowed: true })
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt,
      currentSubject: { ...fixture.subject, actions: [{ ...fixture.subject.actions[0]!, dataLeaseId: 'LEASE-2' }] },
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle,
    })).toMatchObject({ authentic: false })
  })

  test('签发专用 receipt，并从当前 store/clock/subject/capability/preflight 动态复验', async () => {
    let current = new Date('2026-07-12T00:00:00.000Z')
    const fixture = await readyReadGrant(() => current)
    const receipt = await fixture.authority.issueApprovalFreshnessReceipt({
      grant: fixture.grant, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle,
    })
    const valid = () => fixture.authority.verifyApprovalFreshnessReceipt({ receipt,
      currentSubject: fixture.subject, expectedCapabilities: fixture.capabilities,
      browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle })
    expect(valid()).toMatchObject({ authentic: true, current: true, allowed: true, status: 'valid' })
    expect(receipt.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'http-request', effect: 'read' }),
    ]))

    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt,
      currentSubject: { ...fixture.subject, actor: 'ADMIN' }, expectedCapabilities: fixture.capabilities,
      browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle })).toMatchObject({ authentic: false })
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt, currentSubject: fixture.subject,
      expectedCapabilities: [{ ...fixture.capabilities[0]!, digest: d('forged') }],
      browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle })).toMatchObject({ authentic: false })
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities,
      browserPreflight: { ...fixture.browserPreflight, authorityPreflightDigest: d('wrong') },
      runBundle: fixture.runBundle })).toMatchObject({ authentic: false })
    const changedBundle = structuredClone(fixture.runBundle)
    changedBundle.content.attemptPlans[0]!.slots = 99
    changedBundle.artifactDigest = d('changed-run-bundle')
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: changedBundle })).toMatchObject({ authentic: false })

    current = new Date(receipt.expiresAt)
    expect(valid()).toMatchObject({ authentic: false })
  })

  test('旧 receipt 在发布前撤销后立即失效，且其他 Authority/key 不可替换', async () => {
    const fixture = await readyReadGrant(() => new Date('2026-07-12T00:00:00.000Z'))
    const receipt = await fixture.authority.issueApprovalFreshnessReceipt({
      grant: fixture.grant, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle,
    })
    const other = LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-2',
      now: () => new Date('2026-07-12T00:00:00.000Z') })
    expect(other.verifyApprovalFreshnessReceipt({ receipt, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle })).toMatchObject({ authentic: false })
    const compilerClient = fixture.authority.createTrustedApprovalFreshnessClient()
    expect(verifyTrustedApprovalFreshnessCurrent(compilerClient, receipt)).toBe(true)
    await fixture.authority.revoke(fixture.grant.grantId, 'withdrawn')
    expect(verifyTrustedApprovalFreshnessCurrent(compilerClient, receipt)).toBe(false)
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle })).toMatchObject({ authentic: false })
    const revokedReceipt = await fixture.authority.issueApprovalFreshnessReceipt({
      grant: fixture.grant, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle,
    })
    expect(revokedReceipt).toMatchObject({ status: 'revoked', reasonCodes: ['E2E_APPROVAL_REVOKED'] })
    expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt: revokedReceipt,
      currentSubject: fixture.subject, expectedCapabilities: fixture.capabilities,
      browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle })).toMatchObject({
      authentic: true, current: true, allowed: false, status: 'revoked',
    })
  })

  test('普通 Artifact 签名、metadata 和 receipt tamper 都不能冒充 freshness proof', async () => {
    const fixture = await readyReadGrant(() => new Date('2026-07-12T00:00:00.000Z'))
    const receipt = await fixture.authority.issueApprovalFreshnessReceipt({
      grant: fixture.grant, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle,
    })
    const generic = fixture.authority.signArtifactDigest(receipt.authorityProof.signedDigest)
    expect(generic.keyId).not.toBe(receipt.authorityProof.keyId)
    expect(generic.signature).not.toBe(receipt.authorityProof.signature)
    const candidates = [
      { ...receipt, metadata: { approved: true } },
      { ...receipt, subjectDigest: d('tampered') },
      { ...receipt, authorityProof: { ...receipt.authorityProof, signature: generic.signature } },
    ]
    for (const candidate of candidates) {
      expect(fixture.authority.verifyApprovalFreshnessReceipt({ receipt: candidate as typeof receipt,
        currentSubject: fixture.subject, expectedCapabilities: fixture.capabilities,
        browserPreflight: fixture.browserPreflight, runBundle: fixture.runBundle })).toMatchObject({ authentic: false })
    }
  })

  test('freshness 专用签名不能替换 Scope DecisionReceipt 签名', async () => {
    const fixture = await readyReadGrant(() => new Date('2026-07-12T00:00:00.000Z'))
    const freshness = await fixture.authority.issueApprovalFreshnessReceipt({
      grant: fixture.grant, currentSubject: fixture.subject,
      expectedCapabilities: fixture.capabilities, browserPreflight: fixture.browserPreflight,
      runBundle: fixture.runBundle,
    })
    const decisionSubject = projectScopeDecisionSubject({ includedReqCandidates: [], exclusions: [], ambiguities: [],
      dependencies: [], visualScope: { required: false, refs: [] },
      browserScope: { browserIds: ['chrome'], viewportIds: ['desktop'] },
      clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'excluded', reason: '测试处置',
        decisionId: 'SCOPE-1' }] })
    const decision = fixture.authority.issueDecisionReceipt({ kind: 'scope', decisionId: 'SCOPE-1',
      decisionStatus: 'approved', decisionSubject,
      approver: { subject: 'scope-alice', roles: ['scope-approver'] } })
    expect(fixture.authority.verifyDecisionReceipt({ ...decision,
      signature: freshness.authorityProof.signature }, {
      kind: 'scope', decisionId: 'SCOPE-1', decisionStatus: 'approved',
      decisionSubjectDigest: decision.decisionSubjectDigest,
    })).toBe(false)
  })
})
