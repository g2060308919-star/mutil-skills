import { describe, expect, test } from 'vitest'
import {
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  digestApprovalProjection,
  digestArtifactContent,
  digestCleanupPlanDefinition,
  digestOracleCheckpointValue,
  digestText,
  type ArtifactDocument,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import {
  projectRuntimeFullPlaywrightCases,
  projectRuntimeFullPlaywrightSnapshot,
} from '../src/runtime-full-playwright-projector.js'
import {
  authorizeRuntimeFullPlaywrightExecutor,
  executeRuntimeFullPlaywrightCases,
  executeRuntimeFullPlaywright,
} from '../src/trusted-action-runner.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'

const d = (value: string) => digestText('runtime-full-playwright-projector-test/v1', value)

export function runtimeFullPlaywrightProjectionFixture(): RuntimeRunSnapshot {
  const source = "await page.goto('https://test.example.com/app')\nawait checkpoint({ checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1', actual: true })\nstate.changed = true"
  const cleanupSource = "await page.goto('https://test.example.com/reset')\nreturn 'verified-clean'"
  const requests = [
    { intentId: 'DOCUMENT', method: 'GET', canonicalOrigin: 'https://test.example.com', exactPath: '/app',
      query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const },
      targetFingerprint: d('target'), maxRequests: 1, expectedOrder: 1 },
    { intentId: 'RESET', method: 'GET', canonicalOrigin: 'https://test.example.com', exactPath: '/reset',
      query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const },
      targetFingerprint: d('target'), maxRequests: 1, expectedOrder: 2 },
  ]
  const program = {
    schemaVersion: 'full-playwright/v1' as const, caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
    source, sourceDigest: computeFullPlaywrightSourceDigest(source), cleanupSource,
    cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource), dataLeaseId: 'LEASE-1',
    cleanupPlanId: 'CLEANUP-1', timeoutMs: 30_000,
    oracleCheckpoints: [{ checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1',
      expectedJson: 'true', expectedDigest: digestOracleCheckpointValue('true') }],
    networkRequests: requests,
  }
  const cleanupPlan = {
    schemaVersion: '2.0.0' as const, transport: 'browser-local' as const, cleanupPlanId: 'CLEANUP-1',
    actionId: 'ACTION-1', leaseId: 'LEASE-1', executorId: 'FULL-PLAYWRIGHT' as const,
    cleanupProgramDigest: program.cleanupSourceDigest, cleanupRequestIntentIds: ['RESET'],
    verificationProbes: [{ probeId: 'PROBE-1', kind: 'browser-observation' as const,
      expectedDigest: d('clean') }], timeoutMs: 30_000,
  }
  const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan)
  const testCasesContent = { cases: [{
    caseId: 'CASE-1', revision: 1, obligationIds: ['OBL-1'], title: 'Full browser action', actor: 'qa',
    necessity: 'required', preconditions: [], dataNeedIds: ['LEASE-1'], steps: [{ stepId: 'STEP-1', ordinal: 0,
      semanticAction: 'exercise', semanticTarget: 'app', oracles: [{ oracleId: 'ORACLE-1', statement: 'clean' }],
      evidenceKinds: ['screenshot', 'dom', 'trace', 'gateway-audit'] }], mode: 'real-environment',
    effect: 'reversible-write', evidenceLevel: 'E2', cleanupPlanId: 'CLEANUP-1', timeoutMs: 30_000,
    retryPolicy: 'verified-not-applied-max-1', status: 'active',
  }], caseSetDigest: d('case-set') }
  const executionContent = {
    executionProfile: 'full-playwright' as const, environment: 'test', baseOrigin: 'https://test.example.com',
    browserMatrix: [{ browserId: 'chromium', channel: 'stable', viewportId: 'desktop' }], identities: [],
    caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }], readHttpRequests: [], actionIntents: [{ actionId: 'ACTION-1',
      effect: 'reversible-write' as const, intentDigest: program.sourceDigest, requestIds: [] }],
    writeCleanupPlans: [cleanupPlan], fullPlaywrightPrograms: [program],
    dataNeeds: [{ leaseId: 'LEASE-1', resourceKey: 'app:fixture',
      resourceFingerprint: d('target'), mode: 'write' as const }],
    manualProcedures: [], evidencePolicyDigest: d('evidence'), runtimeIsolation: null, unresolvedItems: [],
  }
  const actionMapContent = {
    executionProfile: 'full-playwright' as const, actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://test.example.com', assertionDigest: d('page') }],
    fullPlaywrightPrograms: [program], actions: [{ caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
      pageIdentityId: 'PAGE-1', locatorCandidates: [], playwrightAction: 'full-playwright/v1', waits: [],
      oracleIds: ['ORACLE-1'], effect: 'reversible-write' as const,
      capabilities: [{ operation: 'full-playwright' as const, capabilityId: 'CAP-FULL' }], requestIds: [] }],
    unmappedSteps: [], discoveredRisks: [],
  }
  const testCases = artifact('test-cases', '1.0.0', testCasesContent)
  const execution = artifact('execution-contract', '1.1.0', executionContent)
  const actionMap = artifact('browser-action-map', '2.1.0', actionMapContent)
  const capability = {
    capabilityId: 'CAP-FULL', nonce: '1'.repeat(64), transport: 'browser-local' as const,
    effect: 'reversible-write' as const, operation: 'full-playwright' as const, actionId: 'ACTION-1',
    programDigest: program.sourceDigest, cleanupProgramDigest: program.cleanupSourceDigest,
    dataLeaseId: 'LEASE-1', fencingToken: 1, cleanupPlanDigest, requests, maxUses: 1 as const,
  }
  const runBundleContent = {
    runId: 'RUN-1', allInputRefs: [{ artifactId: testCases.artifactId, digest: testCases.contentDigest }],
    schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
    attemptPlans: [{ caseId: 'CASE-1', slots: 1 }], signedCapabilities: [{ capabilityId: 'CAP-FULL',
      actionId: 'ACTION-1', operation: 'full-playwright', effect: 'reversible-write', maxUses: 1,
      digest: digestText('approval-capability/v1', canonicalizeJson(capability)) }], secretRefs: [],
    runtimePolicyDigest: d('runtime'), runtimeIsolationPolicyDigest: 'not-applicable',
  }
  const runBundle = artifact('run-bundle', '2.0.0', runBundleContent)
  const subject = {
    schemaVersion: '2.0.0' as const, assetId: 'ASSET-1', prdRevision: d('prd'), executionDigest: d('execution'),
    scopeDigest: d('scope'), requirementModelDigest: d('requirements'), coveragePolicyDigest: d('coverage'),
    universeDigest: d('universe'), caseDigest: digestApprovalProjection('test-cases', testCasesContent),
    actionMapDigest: digestApprovalProjection('browser-action-map', actionMapContent), policyDigest: d('policy'),
    executionContractDigest: digestApprovalProjection('execution-contract', executionContent),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundleContent), environment: 'test' as const,
    baseOrigin: 'https://test.example.com', actor: 'qa', discoveryGrantId: 'DISCOVERY-1',
    preflightDigest: d('preflight'), actions: [{ actionId: 'ACTION-1', transport: 'browser-local' as const,
      operation: 'full-playwright' as const, effect: 'reversible-write' as const,
      programDigest: program.sourceDigest, cleanupProgramDigest: program.cleanupSourceDigest,
      dataLeaseId: 'LEASE-1', resourceKey: 'app:fixture', fencingToken: 1,
      cleanupPlanDigest, requests }],
  }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  const grant: SignedWriteGrant = {
    grantId: 'GRANT-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['approver'] }, subject, subjectDigest,
    approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:qa', runId: 'RUN-1',
      approvalType: 'execution', subjectDigest, installationDigest: d('installation'),
      origin: 'http://127.0.0.1:43210', issuedAt: '2026-07-22T00:00:00.000Z',
      expiresAt: '2026-07-22T01:00:00.000Z' }, issuedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-07-22T01:00:00.000Z', capabilities: [capability], revocationSequence: 0,
    signature: 'A'.repeat(86),
  }
  return {
    schemaVersion: '1.6.0', runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('project'),
    runtimeInstallationDigest: d('installation'), workflow: 'approved' as never, artifactDigests: {},
    frozenArtifacts: { 'test-cases': testCases, 'execution-contract': execution,
      'browser-action-map': actionMap, 'run-bundle': runBundle },
    trustedExecutionFacts: { 'signed-execution-grant': grant }, executionResults: {
      realEnvironment: {}, gatewayInjection: {},
    }, requestResponses: {}, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
  }
}

describe('Runtime full Playwright strict projector', () => {
  test('唯一 frozen action/program/grant/cleanup/lease/request/source-set 严格闭合', () => {
    const projected = projectRuntimeFullPlaywrightSnapshot(runtimeFullPlaywrightProjectionFixture())
    expect(projected).toMatchObject({ caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
      targetFingerprint: d('target'), sourceSetDigest: expect.stringMatching(/^sha256:/) })
    expect(projected.program.networkRequests.map((request) => request.intentId)).toEqual(['DOCUMENT', 'RESET'])
    expect(Object.isFrozen(projected.program)).toBe(true)
  })

  test('投影每个 scheduled full-playwright Case 且不合并身份', () => {
    const projections = projectRuntimeFullPlaywrightCases(multiCaseFixture())
    expect(projections.map((item) => item.caseId)).toEqual(['CASE-1', 'CASE-2', 'CASE-3'])
    expect(projections.map((item) => item.actionId)).toEqual(['ACTION-1', 'ACTION-2', 'ACTION-3'])
    expect(new Set(projections.map((item) => item.sourceSetDigest)).size).toBe(3)
  })

  test.each([
    ['profile', (snapshot: RuntimeRunSnapshot) => {
      ;(snapshot.frozenArtifacts['execution-contract']!.content as any).executionProfile = 'trusted-reversible-write'
    }],
    ['source', (snapshot: RuntimeRunSnapshot) => {
      ;(snapshot.frozenArtifacts['browser-action-map']!.content as any).fullPlaywrightPrograms[0].source += '\n// drift'
    }],
    ['cleanup', (snapshot: RuntimeRunSnapshot) => {
      ;(snapshot.frozenArtifacts['execution-contract']!.content as any).writeCleanupPlans[0].cleanupProgramDigest = d('drift')
    }],
    ['request', (snapshot: RuntimeRunSnapshot) => {
      ;((snapshot.trustedExecutionFacts['signed-execution-grant'] as SignedWriteGrant)
        .capabilities[0] as any).requests[0].exactPath = '/other'
    }],
    ['authority key/context', (snapshot: RuntimeRunSnapshot) => {
      ;(snapshot.trustedExecutionFacts['signed-execution-grant'] as SignedWriteGrant)
        .approvalContext.installationDigest = d('other-installation')
    }],
  ])('拒绝 %s 漂移', (_name, mutate) => {
    const snapshot = runtimeFullPlaywrightProjectionFixture()
    mutate(snapshot)
    expect(() => projectRuntimeFullPlaywrightSnapshot(snapshot)).toThrow(/E2E_RUNTIME_FULL_PLAYWRIGHT_/)
  })

  test('只有显式 full-playwright profile 路由 branded full runner', async () => {
    const snapshot = runtimeFullPlaywrightProjectionFixture()
    const calls: string[] = []
    const capability = authorizeRuntimeFullPlaywrightExecutor(async ({ projection }) => {
      calls.push(projection.program.sourceDigest)
      return runtimeOutput(projection.caseId, projection.actionId)
    })
    await expect(executeRuntimeFullPlaywright(capability, { snapshot, attemptId: 'ATTEMPT-1' }))
      .resolves.toMatchObject({ status: 'passed', actionId: 'ACTION-1' })
    expect(calls).toEqual([projectRuntimeFullPlaywrightSnapshot(snapshot).program.sourceDigest])

    ;(snapshot.frozenArtifacts['browser-action-map']!.content as any).executionProfile = 'trusted-reversible-write'
    await expect(executeRuntimeFullPlaywright(capability, { snapshot, attemptId: 'ATTEMPT-2' }))
      .rejects.toThrow(/E2E_RUNTIME_FULL_PLAYWRIGHT_/)
  })

  test('按 schedule 顺序执行三个独立 projection 并返回三个结果', async () => {
    const snapshot = multiCaseFixture()
    const calls: string[] = []
    const capability = authorizeRuntimeFullPlaywrightExecutor(async ({ projection }) => {
      calls.push(projection.caseId)
      return runtimeOutput(projection.caseId, projection.actionId)
    })
    const outputs = await executeRuntimeFullPlaywrightCases(capability, {
      snapshot, attemptIds: ['ATTEMPT-1', 'ATTEMPT-2', 'ATTEMPT-3'],
    })
    expect(outputs.map((item) => item.caseId)).toEqual(['CASE-1', 'CASE-2', 'CASE-3'])
    expect(calls).toEqual(['CASE-1', 'CASE-2', 'CASE-3'])
  })
})

function multiCaseFixture(): RuntimeRunSnapshot {
  const snapshot = runtimeFullPlaywrightProjectionFixture()
  const testCases = snapshot.frozenArtifacts['test-cases']!
  const execution = snapshot.frozenArtifacts['execution-contract']!
  const actionMap = snapshot.frozenArtifacts['browser-action-map']!
  const runBundle = snapshot.frozenArtifacts['run-bundle']!
  const testContent = testCases.content as any
  const executionContent = execution.content as any
  const actionContent = actionMap.content as any
  const runContent = runBundle.content as any
  const grant = snapshot.trustedExecutionFacts['signed-execution-grant'] as SignedWriteGrant

  for (const ordinal of [2, 3]) {
    const caseId = `CASE-${ordinal}`
    const actionId = `ACTION-${ordinal}`
    const stepId = `STEP-${ordinal}`
    const leaseId = `LEASE-${ordinal}`
    const cleanupPlanId = `CLEANUP-${ordinal}`
    const capabilityId = `CAP-FULL-${ordinal}`
    const program = structuredClone(executionContent.fullPlaywrightPrograms[0])
    Object.assign(program, { caseId, actionId, stepId, dataLeaseId: leaseId, cleanupPlanId })
    testContent.cases.push({
      ...structuredClone(testContent.cases[0]), caseId, cleanupPlanId, dataNeedIds: [leaseId],
      steps: [{ ...structuredClone(testContent.cases[0].steps[0]), stepId }],
    })
    const cleanupPlan = {
      ...structuredClone(executionContent.writeCleanupPlans[0]),
      cleanupPlanId, actionId, leaseId,
    }
    executionContent.fullPlaywrightPrograms.push(program)
    executionContent.writeCleanupPlans.push(cleanupPlan)
    executionContent.caseQueue.push({ ordinal: ordinal - 1, caseId })
    executionContent.actionIntents.push({
      ...structuredClone(executionContent.actionIntents[0]), actionId, intentDigest: program.sourceDigest,
    })
    executionContent.dataNeeds.push({
      ...structuredClone(executionContent.dataNeeds[0]), leaseId, resourceKey: `app:fixture:${ordinal}`,
    })
    actionContent.fullPlaywrightPrograms.push(structuredClone(program))
    actionContent.actions.push({
      ...structuredClone(actionContent.actions[0]), caseId, actionId, stepId,
      capabilities: [{ operation: 'full-playwright', capabilityId }],
    })
    const capability = {
      ...structuredClone(grant.capabilities[0] as any),
      capabilityId, actionId, dataLeaseId: leaseId,
      cleanupPlanDigest: digestCleanupPlanDefinition(cleanupPlan),
    }
    grant.capabilities.push(capability)
    grant.subject.actions.push({
      ...structuredClone(grant.subject.actions[0] as any), actionId, dataLeaseId: leaseId,
      resourceKey: `app:fixture:${ordinal}`, cleanupPlanDigest: capability.cleanupPlanDigest,
    })
    runContent.schedule.push({ ordinal: ordinal - 1, caseId, stepIds: [stepId], actionIds: [actionId] })
    runContent.attemptPlans.push({ caseId, slots: 1 })
    runContent.signedCapabilities.push({
      capabilityId, actionId, operation: 'full-playwright', effect: 'reversible-write', maxUses: 1,
      digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
    })
  }
  for (const document of [testCases, execution, actionMap, runBundle]) {
    document.contentDigest = digestArtifactContent(
      `artifact-content/${document.schemaVersion}/${document.artifactType}`,
      document,
    )
  }
  grant.subject.caseDigest = digestApprovalProjection('test-cases', testContent)
  grant.subject.executionContractDigest = digestApprovalProjection('execution-contract', executionContent)
  grant.subject.actionMapDigest = digestApprovalProjection('browser-action-map', actionContent)
  grant.subject.runBundleProjectionDigest = digestApprovalProjection('run-bundle', runContent)
  grant.subjectDigest = canonicalGrantApprovalSubjectDigest(grant.subject)
  grant.approvalContext.subjectDigest = grant.subjectDigest
  return snapshot
}

function runtimeOutput(caseId: string, actionId: string) {
  return { caseId, actionId, status: 'passed' as const, effectObservation: 'applied' as const,
    resultDigest: d('result'), gatewayCommit: { reservationId: 'RESERVATION-1',
      reservationReceiptDigest: d('reservation'), outcomeReceiptDigest: d('outcome'), committed: true as const },
    cleanup: { status: 'verified-clean' as const, resultDigest: d('cleanup'), leaseReceiptDigest: d('lease') } }
}

function artifact(type: string, schemaVersion: string, content: unknown): ArtifactDocument {
  const document: Record<string, unknown> = {
    artifactId: `ART-${type}`, artifactType: type, schemaVersion, engineVersion: '0.1.0', assetId: 'ASSET-1',
    prdRevision: d('prd'), generationId: 'GEN-1', createdAt: '2026-07-22T00:00:00.000Z',
    contentDigest: d('placeholder'), signatures: [], dependencies: [], graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}
