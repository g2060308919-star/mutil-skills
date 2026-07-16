import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'
import { digestText, type WriteApprovalSubject } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, LocalLeaseAuthority } from '@mutil-skills/e2e-authority'
import { LocalArtifactStore, computeVerdict } from '@mutil-skills/e2e-engine'
import {
  LocalGatewayAuditSigner, LocalGatewayAuditVerifier, ReversibleWriteGateway,
  digestJsonHttpPayload, verifyGatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import {
  PlaywrightPageAdapter, createTestWriteRuntimeSession, runReversibleWriteCase,
} from '@mutil-skills/e2e-playwright-runtime'
import { renderReadOnlyReport } from '@mutil-skills/e2e-report'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Spec §29 审批边界系统 E2E', () => {
  test('场景 7：target、payload、environment 或 Revision 变化均使旧 Grant 在浏览器动作前失效', async () => {
    const now = () => new Date('2026-07-12T10:00:00.000Z')
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'approval-system-7', now,
      approvalIdentities: [{ subject: 'os-user:approval', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'approval-session'
        ? createGoldenApprovalReceipt('os-user:approval', 'RUN-SCENARIO-7', expected,
          '2026-07-12T09:59:00.000Z') : undefined,
    })
    const leaseAuthority = new LocalLeaseAuthority({ now })
    const lease = await leaseAuthority.acquire({
      runId: 'RUN-SCENARIO-7', resourceKey: 'order:100', resourceFingerprint: digest('target-v1'),
      exclusive: true, ttlMs: 60_000,
    })
    const activeLease = await leaseAuthority.activate(lease.leaseId)
    const approved = await prepareWriteSubject(authority, {
      revision: digest('revision-v1'), environment: 'test', targetFingerprint: digest('target-v1'),
      payload: { decision: 'approve-v1' }, leaseId: activeLease.leaseId, fencingToken: activeLease.fencingToken,
    })
    const grant = await authority.issueWriteGrant({
      subject: approved, approver: { subject: 'os-user:approval', roles: ['e2e-approver'] },
      approvalSessionRef: 'approval-session', ttlMs: 60_000,
    })
    const signer = LocalGatewayAuditSigner.create({ issuer: 'approval-gateway', keyId: 'approval-gateway-key',
      instanceId: 'GATEWAY-SCENARIO-7', version: '1.0.0' })
    const verifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
    const recorder = signer.createRecorder(digest('gateway-policy'))
    const changedSubjects: WriteApprovalSubject[] = [
      { ...approved, prdRevision: digest('revision-v2') },
      { ...approved, environment: 'staging' },
      { ...approved, actions: [{ ...approved.actions[0]!, requests: [{ ...approved.actions[0]!.requests[0]!,
        targetFingerprint: digest('target-v2') }] }] },
      { ...approved, actions: [{ ...approved.actions[0]!, requests: [{ ...approved.actions[0]!.requests[0]!,
        payload: { kind: 'json', digest: digestJsonHttpPayload({ decision: 'approve-v2' }) } }] }] },
    ]
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutablePath(), headless: true,
    })
    const results = []
    const gatewayDecisions = []
    try {
      const page = await browser.newPage()
      for (const [index, currentSubject] of changedSubjects.entries()) {
        const decision = await authority.verifyForSubject(grant, currentSubject)
        expect(decision).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SUBJECT_MISMATCH' })
        const gateway = new ReversibleWriteGateway({
          grant, currentSubject, capability: grant.capabilities[0]!,
          attemptId: `ATTEMPT-SCENARIO-7-${index + 1}`, authority, leaseAuthority, recorder,
          attemptContext: { assetId: 'PRODUCT-PRD-APPROVAL', generationId: 'GEN-SCENARIO-7',
            prdRevision: currentSubject.prdRevision, runId: 'RUN-SCENARIO-7', caseId: 'CASE-SCENARIO-7' },
        })
        results.push(await runReversibleWriteCase({
          caseId: 'CASE-SCENARIO-7', actionId: 'ACTION-WRITE', url: 'http://fixture.test/orders/100',
          buttonName: '批准', beforeText: '待审核', afterText: '已批准',
          expectedIdentity: { title: '订单', heading: '订单 100' },
          authorization: { grant, currentSubject, authority: authority.createWriteExecutionClient() },
          lease: {
            leaseId: activeLease.leaseId, fencingToken: activeLease.fencingToken,
            targetFingerprint: digest('target-v1'), authority: leaseAuthority.createExecutionClient(),
          },
          runtime: createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
            authorityTransport: 'in-process-test' }),
          gatewayAudit: () => gateway.getAuditSummary(), page: new PlaywrightPageAdapter(page),
        }))
        gatewayDecisions.push(await gateway.decide({
          method: 'POST', url: 'http://fixture.test/api/orders/100/approve',
          body: Buffer.from(JSON.stringify({ decision: 'approve-v1' })), contentType: 'application/json',
        }))
      }
    } finally {
      await browser.close()
    }
    const gatewayAudit = recorder.finalize()
    expect(verifyGatewayPublicationAudit(gatewayAudit, verifier)).toBe(true)
    const published = await publishSafetyBlocked({
      authority, generationId: 'GEN-SCENARIO-7', reasonCode: 'E2E_APPROVAL_SUBJECT_MISMATCH',
      details: { results, gatewayDecisions }, gatewayAudit, gatewayVerifier: verifier,
    })

    expect(results).toHaveLength(4)
    expect(results.every((result) => result.status === 'safety-blocked' && result.evidence.length === 0)).toBe(true)
    expect(gatewayDecisions.every((decision) => decision.decision === 'block'
      && decision.code === 'E2E_APPROVAL_SUBJECT_MISMATCH')).toBe(true)
    expect(gatewayAudit.signedCounters).toMatchObject({ forwarded: 0, blocked: 4 })
    expect(published.terminalVerdict).toBe('safety-blocked')
  }, 30_000)

  test('场景 8：笼统同意不能为生产或不可逆写入签发 capability', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'approval-system-8', now: () => new Date('2026-07-12T10:00:00.000Z'),
      approvalIdentities: [{ subject: 'os-user:blanket-consent', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'blanket-session'
        ? createGoldenApprovalReceipt('os-user:blanket-consent', 'RUN-SCENARIO-8', expected,
          '2026-07-12T09:59:00.000Z') : undefined,
    })
    const blanketApprover = { subject: 'os-user:blanket-consent', roles: ['e2e-approver'] }
    const base = legacyWriteSubject({
      revision: digest('revision-production'), environment: 'test', targetFingerprint: digest('target-production'),
      payload: { decision: 'delete' }, leaseId: 'LEASE-PRODUCTION', fencingToken: 1,
    })
    const production = { ...base, environment: 'production' } as unknown as WriteApprovalSubject
    const irreversible = {
      ...base, actions: [{ ...base.actions[0]!, effect: 'irreversible-write' }],
    } as unknown as WriteApprovalSubject
    const rejectedCodes: string[] = []
    const signer = LocalGatewayAuditSigner.create({ issuer: 'approval-gateway', keyId: 'approval-gateway-key-8',
      instanceId: 'GATEWAY-SCENARIO-8', version: '1.0.0' })
    const verifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
    const recorder = signer.createRecorder(digest('gateway-policy-production-deny'))
    for (const candidate of [production, irreversible]) {
      try {
        await authority.issueWriteGrant({
          subject: candidate, approver: blanketApprover,
          approvalSessionRef: 'blanket-session', ttlMs: 60_000,
        })
      } catch (error) {
        rejectedCodes.push((error as { code?: string }).code ?? 'UNKNOWN')
      }
    }
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutablePath(), headless: true,
    })
    try {
      const page = await browser.newPage()
      expect(page.url()).toBe('about:blank')
    } finally {
      await browser.close()
    }
    const published = await publishSafetyBlocked({
      authority, generationId: 'GEN-SCENARIO-8', reasonCode: 'E2E_APPROVAL_WRITE_SCOPE_INVALID',
      details: { rejectedCodes, browserNavigation: 'not-started', gatewayForwarded: 0 },
      gatewayAudit: recorder.finalize(), gatewayVerifier: verifier,
    })

    expect(rejectedCodes).toEqual(['E2E_APPROVAL_WRITE_SCOPE_INVALID', 'E2E_APPROVAL_WRITE_SCOPE_INVALID'])
    expect(published.terminalVerdict).toBe('safety-blocked')
  }, 30_000)
})

function digest(value: string): string {
  return digestText('approval-system/v1', value)
}

async function prepareWriteSubject(authority: LocalApprovalAuthority, input: {
  revision: string
  environment: 'local' | 'test' | 'staging'
  targetFingerprint: string
  payload: unknown
  leaseId: string
  fencingToken: number
}): Promise<WriteApprovalSubject> {
  const scopeDigest = digest('scope')
  const discoverySubject = {
    schemaVersion: '1.0.0' as const, assetId: 'PRODUCT-PRD-APPROVAL', prdRevision: input.revision,
    scopeDigest, environment: input.environment, baseOrigin: 'http://fixture.test', actor: 'operator',
    expectedPageIdentity: { url: 'http://fixture.test/orders/100', title: '订单', heading: '订单 100', ariaSignals: ['main'] },
    bootstrapIntentsDigest: digest('bootstrap'),
    actions: [{ actionId: 'ACTION-DISCOVERY', operation: 'local-navigation' as const, maxUses: 1 }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject,
    approver: { subject: 'os-user:approval', roles: ['e2e-approver'] }, approvalSessionRef: 'approval-session', ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant: discovery, currentSubject: discoverySubject,
    capabilityId: discovery.capabilities[0]!.capabilityId, actionId: 'ACTION-DISCOVERY', attemptId: 'ATTEMPT-DISCOVERY' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery, currentSubject: discoverySubject,
    reservationId: reservation.reservationId, capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'http://fixture.test/orders/100', title: '订单',
      headings: ['订单 100'], role: 'operator', ariaSignals: ['main'] } } })
  const projection = digest('projection')
  return {
    schemaVersion: '2.0.0', assetId: 'PRODUCT-PRD-APPROVAL', prdRevision: input.revision,
    executionDigest: digest('execution'), environment: input.environment, baseOrigin: 'http://fixture.test',
    scopeDigest, requirementModelDigest: projection, coveragePolicyDigest: projection, universeDigest: projection,
    caseDigest: projection, actionMapDigest: projection, policyDigest: projection,
    executionContractDigest: projection, runBundleProjectionDigest: projection, actor: 'operator',
    discoveryGrantId: discovery.grantId, preflightDigest,
    actions: [{
      actionId: 'ACTION-WRITE', effect: 'reversible-write', dataLeaseId: input.leaseId,
      fencingToken: input.fencingToken, cleanupPlanDigest: digest('cleanup'),
      requests: [{
        intentId: 'INTENT-WRITE', method: 'POST', canonicalOrigin: 'http://fixture.test',
        exactPath: '/api/orders/100/approve', query: [],
        payload: { kind: 'json', digest: digestJsonHttpPayload(input.payload) },
        targetFingerprint: input.targetFingerprint, maxRequests: 1, expectedOrder: 1,
      }],
    }],
  }
}

function legacyWriteSubject(input: {
  revision: string
  environment: 'local' | 'test' | 'staging'
  targetFingerprint: string
  payload: unknown
  leaseId: string
  fencingToken: number
}): WriteApprovalSubject {
  return {
    schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-APPROVAL', prdRevision: input.revision,
    executionDigest: digest('execution'), environment: input.environment, baseOrigin: 'http://fixture.test',
    actions: [{ actionId: 'ACTION-WRITE', effect: 'reversible-write', dataLeaseId: input.leaseId,
      fencingToken: input.fencingToken, cleanupPlanDigest: digest('cleanup'), requests: [{
        intentId: 'INTENT-WRITE', method: 'POST', canonicalOrigin: 'http://fixture.test',
        exactPath: '/api/orders/100/approve', query: [],
        payload: { kind: 'json', digest: digestJsonHttpPayload(input.payload) },
        targetFingerprint: input.targetFingerprint, maxRequests: 1, expectedOrder: 1,
      }] }],
  }
}

async function publishSafetyBlocked(input: {
  authority: LocalApprovalAuthority
  generationId: string
  reasonCode: string
  details: unknown
  gatewayAudit: ReturnType<ReturnType<LocalGatewayAuditSigner['createRecorder']>['finalize']>
  gatewayVerifier: LocalGatewayAuditVerifier
}): Promise<NonNullable<Awaited<ReturnType<LocalArtifactStore['readActive']>>>> {
  const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-system-approval-'))
  tempDirectories.push(workspace)
  const revision = digest(input.generationId)
  const verdict = computeVerdict({
    schemaVersion: '2.0.0', assetId: 'PRODUCT-PRD-APPROVAL', generationId: input.generationId,
    verdictRuleVersion: '2.0.0', policyDigest: revision, universeDigest: revision, prdRevision: revision,
    requirementModelDigest: revision,
    obligations: [{ obligationId: 'COV-APPROVAL', necessity: 'required', disposition: 'automated', caseIds: ['CASE-APPROVAL'] }],
    caseResults: [{
      caseId: 'CASE-APPROVAL', runId: `RUN-${input.generationId}`, obligationIds: ['COV-APPROVAL'],
      status: 'safety-blocked', executionMode: 'real-environment', attemptSelection: { status: 'not-started' },
    }],
    manualResults: [], pendingDecisionIds: [], safetyFindings: [input.reasonCode], artifactFindings: [],
    migrationFindings: [], environmentFindings: [], automationFindings: [],
    gatewayAudit: { status: 'invalid', required: true, reasonCodes: [input.reasonCode] },
    evidenceAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    cleanupAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    coverageFacts: {
      requirementDesign: { covered: 1, total: 1 }, rules: { covered: 1, total: 1 },
      criticalNodes: { covered: 1, total: 1 }, roles: { covered: 1, total: 1 },
      stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 1, total: 1 },
    },
  })
  const report = renderReadOnlyReport({
    assetId: 'PRODUCT-PRD-APPROVAL', prdRevision: revision, generationId: input.generationId,
    title: '审批阻断报告', verdict,
    cases: [{ caseId: 'CASE-APPROVAL', title: '审批门禁', status: 'safety-blocked', evidenceLinks: [] }],
  })
  const store = new LocalArtifactStore(workspace, {
    auditStagedGeneration: async (staged) => {
      expect(staged.terminalVerdict).toBe('safety-blocked')
      const persisted = JSON.parse(Buffer.from(await staged.readFile('approval/blocked.json')).toString('utf8'))
      expect(persisted).toMatchObject({ reasonCode: input.reasonCode, accepted: false })
      expect(verifyGatewayPublicationAudit(persisted.gatewayAudit, input.gatewayVerifier)).toBe(true)
      expect(persisted.gatewayAudit.signedCounters.digest).toBe(input.gatewayAudit.signedCounters.digest)
    },
    signDigest: (value) => input.authority.signArtifactDigest(value),
    verifySignature: (signature) => input.authority.verifyArtifactSignature(signature),
  })
  await store.publish({
    assetId: 'PRODUCT-PRD-APPROVAL', generationId: input.generationId, terminalVerdict: verdict.verdict,
    files: {
      'approval/blocked.json': JSON.stringify({ reasonCode: input.reasonCode, accepted: false,
        details: input.details, gatewayAudit: input.gatewayAudit }), 'run/report.md': report.markdown,
      'run/report.html': report.html,
    },
  })
  const active = await store.readActive('PRODUCT-PRD-APPROVAL')
  if (!active) throw new Error('active generation missing')
  return active
}
