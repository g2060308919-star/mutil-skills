import {
  ArtifactSchemaRegistry,
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  digestApprovalProjection,
  deriveExecutionResultId,
  digestCleanupPlanDefinition,
  digestArtifactContent,
  digestBytes,
  digestText,
  type ArtifactDocument,
} from '@mutil-skills/e2e-contracts'
import { appendAttemptEvent, buildCompleteGeneration } from '@mutil-skills/e2e-engine'
import { LocalGatewayAuditSigner } from '@mutil-skills/e2e-gateway'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { addFixtureInjectionResult, completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { projectionFixture } from './trusted-action-runner.test.js'
import {
  RuntimeFinalizationMaterialSealer,
  runtimeProductionSanitizerPolicyDigest,
} from '../src/runtime-finalization-material-sealer.js'
import {
  ProductionFinalizationMaterialProvider,
  createPersistedRuntimeFinalizationMaterial,
} from '../src/production-finalization-material-provider.js'
import type { RegressionPublicationResult } from '../src/regression-publisher.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { injectionOutput, realWriteOutput } from './runtime-write-fixtures.js'
import { runtimeWriteProjectionFixture } from './runtime-write-projector.test.js'

describe('RuntimeFinalizationMaterialSealer', () => {
  test('只从冻结资产、可信执行事实和 Quarantine 生成 25 类可追踪事实', async () => {
    const fixture = completeGenerationFixture()
    const built = buildCompleteGeneration(fixture)
    const facts = built.artifacts.filter((artifact) =>
      !['final-report', 'generation-manifest'].includes(artifact.artifactType))
    const frozenArtifacts = Object.fromEntries(facts.filter((artifact) => ![
      'approval-grants', 'manual-results', 'data-leases', 'browser-preflight', 'run-bundle',
      'workflow-events', 'browser-results', 'gateway-audit', 'browser-evidence', 'diagnosis',
      'cleanup-results',
    ].includes(artifact.artifactType)).map((artifact) => [artifact.artifactType,
      artifact.artifactType === 'project-policy' ? withEvidencePolicy(artifact) : artifact]))
    const customPolicy = structuredClone(frozenArtifacts['project-policy']) as ArtifactDocument
    customPolicy.artifactId = 'CUSTOM-PROJECT-POLICY-ID'
    customPolicy.signatures = []
    customPolicy.contentDigest = digestArtifactContent(
      `artifact-content/${customPolicy.schemaVersion}/${customPolicy.artifactType}`,
      customPolicy,
    )
    frozenArtifacts['project-policy'] = customPolicy
    const projection = projectionFixture()
    const dom = Buffer.from(JSON.stringify({
      format: 'dom-tree/1', roots: [{ tag: 'main', text: 'Home', assertionRelevant: true }],
    }))
    const stored = new Map<string, Buffer>([['raw/ATTEMPT-1/dom.bin', dom]])
    const workflow = (fixture.drafts['workflow-events'].content as any).attemptCases[0]
    const grants = (fixture.drafts['approval-grants'].content as any).grants
    const authority = {
      ...fixture.authority,
      stateProtectionLevel: 'local-crash-integrity' as const,
      artifactVerifierMaterial: { publicKeyDigest: digestText('test/v1', 'artifact') },
      approvalFreshnessVerifierMaterial: { kind: 'test' }, decisionVerifierMaterial: { kind: 'test' },
      privacyReviewVerifierMaterial: { kind: 'test' }, attemptEventVerifierMaterial: { kind: 'test' },
      signDigest: fixture.authority.signArtifactDigest,
      verifySignature: (signature: any) => fixture.authority.verifyArtifactSignature(signature, signature.signedDigest),
      issueApprovalFreshnessReceipt: vi.fn(async () => grants[0]),
      appendAttemptEvent: vi.fn(({ event }: any) => event.sequence === 1
        ? { event: workflow.events[0], eventChainDigest: workflow.events[1].previousChainDigest }
        : { event: workflow.events[1], eventChainDigest: workflow.selection.eventChainDigest }),
      close: vi.fn(), credentialCount: 1,
    }
    const preparedSnapshot = snapshot({ frozenArtifacts, projection, fixture, dom })
    ;(preparedSnapshot.trustedExecutionFacts['browser-preflight'] as any).gatewayPolicyDigest =
      digestText('test/v1', 'preflight-gateway-policy')
    const material = await new RuntimeFinalizationMaterialSealer({
      quarantine: {
        readEvidence: async ({ relativePath }: any) => Buffer.from(stored.get(relativePath)!),
        writeEvidence: async ({ relativePath, plaintext }: any) => {
          if (stored.has(relativePath)) throw new Error('duplicate')
          stored.set(relativePath, Buffer.from(plaintext))
          return {} as never
        },
      },
      authority: authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    }).seal(preparedSnapshot)

    expect(material.artifacts).toHaveLength(25)
    expect(new Set(material.artifacts.map(({ artifact }) => artifact.artifactType)).size).toBe(25)
    const resolvedActionMap = material.artifacts.find(({ artifact }) =>
      artifact.artifactType === 'browser-action-map')!.artifact.content as any
    const resolvedRunBundle = material.artifacts.find(({ artifact }) =>
      artifact.artifactType === 'run-bundle')!.artifact.content as any
    expect(resolvedRunBundle.allInputRefs).toContainEqual({
      artifactId: 'CUSTOM-PROJECT-POLICY-ID',
      digest: expect.stringMatching(/^sha256:/),
    })
    for (const capability of resolvedActionMap.actions[0].capabilities) {
      expect(capability.capabilityId).toBe(resolvedRunBundle.signedCapabilities.find((item: any) =>
        item.actionId === resolvedActionMap.actions[0].actionId
        && item.operation === capability.operation)?.capabilityId)
    }
    const browserPreflight = material.artifacts.find(({ artifact }) =>
      artifact.artifactType === 'browser-preflight')!.artifact.content as any
    const executedGatewayAudit = fixture.drafts['gateway-audit'].content as any
    expect(browserPreflight.gatewayChecks).toContainEqual({
      id: executedGatewayAudit.gatewayInstance.instanceId,
      digest: executedGatewayAudit.policyDigest,
    })
    expect(material.provenance.gatewayPolicyDigest).toBe(executedGatewayAudit.policyDigest)
    expect(material.provenance.isolationProofDigest).toBe(digestText(
      'runtime-isolation-proof/v1', canonicalizeJson(browserPreflight.sandboxChecks),
    ))
    expect(material.artifacts.find(({ artifact }) => artifact.artifactType === 'approval-grants')?.artifact.createdAt)
      .toBe(grants[0].checkedAt)
    expect(material.evidence).toEqual([expect.objectContaining({
      evidenceId: 'EVIDENCE-ACTION-1', quarantinePath: 'sanitized/EVIDENCE-ACTION-1.json',
    })])
    expect(stored.get('sanitized/EVIDENCE-ACTION-1.json')?.toString()).not.toContain('Bearer ')
    expect(authority.issueApprovalFreshnessReceipt).toHaveBeenCalledOnce()
    expect(authority.appendAttemptEvent).toHaveBeenCalledTimes(2)
  })

  test('缺少任何外部语义资产时阻止最终化，不补空资产', async () => {
    const fixture = completeGenerationFixture()
    const projection = projectionFixture()
    const sealer = new RuntimeFinalizationMaterialSealer({
      quarantine: {} as never, authority: fixture.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    })
    await expect(sealer.seal(snapshot({ frozenArtifacts: {}, projection, fixture, dom: Buffer.alloc(0) })))
      .rejects.toMatchObject({ code: expect.stringContaining('EXTERNAL_ARTIFACT_MISSING') })
  })

  test('write 缺少可信 finalization facts 时稳定阻断，不以空 lease/cleanup 伪装', async () => {
    const fixture = completeGenerationFixture()
    const projection = projectionFixture()
    const candidate = snapshot({ frozenArtifacts: {}, projection, fixture, dom: Buffer.alloc(0) })
    candidate.executionResults!.realEnvironment['ACTION-WRITE-1'] = realWriteOutput() as never
    const sealer = new RuntimeFinalizationMaterialSealer({
      quarantine: {} as never, authority: fixture.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    })
    await expect(sealer.seal(candidate)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_FINALIZATION_WRITE_FACTS_MISSING',
    })
  })

  test('injection 缺少独立 signed publication audit 时稳定阻断且不覆盖 real domain', async () => {
    const fixture = completeGenerationFixture()
    const projection = projectionFixture()
    const candidate = snapshot({ frozenArtifacts: {}, projection, fixture, dom: Buffer.alloc(0) })
    candidate.executionResults!.realEnvironment['ACTION-WRITE-1'] = realWriteOutput() as never
    candidate.executionResults!.gatewayInjection['ACTION-INJECT-1'] = injectionOutput() as never
    const sealer = new RuntimeFinalizationMaterialSealer({
      quarantine: {} as never, authority: fixture.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    })
    await expect(sealer.seal(candidate)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_FINALIZATION_INJECTION_SIGNED_AUDIT_MISSING',
    })
  })

  test('reversible-write 只从 signed outcome、冻结 lease/cleanup 与 Quarantine 组装 material', async () => {
    const prepared = writeSnapshot()
    const material = await new RuntimeFinalizationMaterialSealer({
      quarantine: prepared.quarantine as never,
      authority: prepared.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    }).seal(prepared.snapshot)

    const artifact = (type: string) => material.artifacts.find((item) => item.artifact.artifactType === type)!.artifact
    expect((artifact('data-leases').content as any).leases).toEqual([
      expect.objectContaining({ leaseId: 'LEASE-1', status: 'released' }),
    ])
    expect((artifact('cleanup-results').content as any).leaseResults).toEqual([
      expect.objectContaining({ leaseId: 'LEASE-1', status: 'verified-clean', plan: expect.any(Object) }),
    ])
    expect((artifact('browser-results').content as any).caseResults[0]).toMatchObject({
      effect: 'reversible-write', cleanupRef: 'LEASE-1',
      executionOutcomeReceipts: [{ actionId: 'ACTION-1', evidenceIds: ['EVIDENCE-ACTION-1'] }],
    })
    expect(material.execution.realEnvironmentResults).toHaveLength(1)
    expect(material.execution.injectionResults).toEqual([])
    expect(material.cleanup).toEqual([
      expect.objectContaining({ leaseId: 'LEASE-1', status: 'verified-clean' }),
    ])
  })

  test('full-playwright 的十三项签名原始证据可通过正式 finalization，发布证据仍使用净化 ID', async () => {
    const sessionId = 'SESSION-WRITE-1'
    const rawEvidenceIds = [
      ...(['BEFORE', 'AFTER', 'CLEANUP'] as const).flatMap((stage) =>
        ['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `${stage}-${kind}`)),
      `GATEWAY-${sessionId}`,
    ]
    const prepared = writeSnapshot({ capabilityMode: 'full-playwright', receiptEvidenceIds: rawEvidenceIds })
    const material = await sealPrepared(prepared)
    const browserResults = material.artifacts.find(({ artifact }) =>
      artifact.artifactType === 'browser-results')!.artifact.content as any

    expect(browserResults.caseResults[0].executionOutcomeReceipts[0].evidenceIds).toEqual(rawEvidenceIds)
    expect(browserResults.caseResults[0].evidenceRefs).toEqual(['EVIDENCE-ACTION-1'])
    expect(material.evidence).toEqual([expect.objectContaining({ evidenceId: 'EVIDENCE-ACTION-1' })])
  })

  test('finalization 双向拒绝 full-playwright 单证据降级与 HTTP 写冒充十三项证据', async () => {
    const fullIds = [
      ...(['BEFORE', 'AFTER', 'CLEANUP'] as const).flatMap((stage) =>
        ['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `${stage}-${kind}`)),
      'GATEWAY-SESSION-WRITE-1',
    ]
    await expect(sealPrepared(writeSnapshot({ capabilityMode: 'full-playwright' })))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_FINALIZATION_WRITE_OUTCOME_BINDING_INVALID' })
    await expect(sealPrepared(writeSnapshot({ receiptEvidenceIds: fullIds })))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_FINALIZATION_WRITE_OUTCOME_BINDING_INVALID' })
  })

  test('finalization 拒绝同 capabilityId 下 receipt 替换 transport/operation 的完整 capability', async () => {
    const fullIds = [
      ...(['BEFORE', 'AFTER', 'CLEANUP'] as const).flatMap((stage) =>
        ['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `${stage}-${kind}`)),
      'GATEWAY-SESSION-WRITE-1',
    ]
    await expect(sealPrepared(writeSnapshot({ capabilityMode: 'full-playwright',
      receiptCapabilityMode: 'http', receiptEvidenceIds: fullIds })))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_FINALIZATION_WRITE_OUTCOME_BINDING_INVALID' })
  })

  test('冻结 run-bundle 的 generation envelope 被 browser-preflight 继承', async () => {
    const seed = writeSnapshot()
    const seedMaterial = await sealPrepared(seed)
    const seedRunBundle = seedMaterial.artifacts.find(({ artifact }) =>
      artifact.artifactType === 'run-bundle')!.artifact
    const prepared = writeSnapshot()
    const frozen = structuredClone(seedRunBundle) as any
    frozen.createdAt = '2026-07-17T00:00:00.000Z'
    frozen.signatures = []
    frozen.contentDigest = digestArtifactContent(
      `artifact-content/${frozen.schemaVersion}/${frozen.artifactType}`, frozen,
    )
    frozen.signatures = [(prepared.authority.signArtifactDigest as Function)(frozen.contentDigest)]
    prepared.snapshot.frozenArtifacts['run-bundle'] = ArtifactSchemaRegistry['run-bundle'].parse(frozen)

    const material = await sealPrepared(prepared)
    const artifact = (type: string) => material.artifacts.find(({ artifact }) =>
      artifact.artifactType === type)!.artifact
    expect(artifact('browser-preflight').createdAt).toBe(artifact('run-bundle').createdAt)
    expect(artifact('browser-preflight').engineVersion).toBe(artifact('run-bundle').engineVersion)
  })

  test('同一 Case 的 real baseline 与独立 injection 被封存为双 result、双 Gateway session 和独立净化证据', async () => {
    const prepared = dualDomainWriteSnapshot()
    const material = await sealPrepared(prepared)
    const artifact = (type: string) => material.artifacts
      .find((item) => item.artifact.artifactType === type)!.artifact.content as any
    const realResultId = deriveExecutionResultId('CASE-1', 'real-environment')
    const injectionResultId = deriveExecutionResultId('CASE-1', 'gateway-injection')

    expect(artifact('browser-results').caseResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ resultId: realResultId, caseId: 'CASE-1', mode: 'real-environment', status: 'passed' }),
      expect.objectContaining({ resultId: injectionResultId, baselineResultId: realResultId,
        caseId: 'CASE-1', mode: 'gateway-injection', status: 'failed' }),
    ]))
    expect(artifact('gateway-audit').sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ resultId: realResultId, domain: 'real-environment' }),
      expect.objectContaining({ resultId: injectionResultId, domain: 'gateway-injection',
        grant: expect.objectContaining({ grantId: 'GRANT-INJECTION-1' }) }),
    ]))
    expect(material.execution.injectionResults).toEqual([
      expect.objectContaining({ resultId: injectionResultId, baselineResultId: realResultId, status: 'failed' }),
    ])
    expect(material.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: 'EVIDENCE-INJECTION-ACTION-1',
        quarantinePath: 'sanitized/EVIDENCE-INJECTION-ACTION-1.json' }),
    ]))
    expect(prepared.stored.get('sanitized/EVIDENCE-INJECTION-ACTION-1.json')?.toString())
      .toContain('gateway injection failed')

    prepared.snapshot.trustedExecutionFacts['finalization-material'] = material
    const provider = new ProductionFinalizationMaterialProvider({
      quarantine: { readEvidence: async ({ relativePath }: { relativePath: string }) =>
        Buffer.from(prepared.stored.get(relativePath)!) },
      projectCompilerInput: () => Object.freeze({}), authority: prepared.authority,
      privacyReviewVerifier: prepared.fixture.privacyReviewVerifier,
      regressionDiscoveryVerifier: prepared.fixture.regressionDiscoveryVerifier,
    } as never)
    const published = regressionPublication(prepared.fixture)
    const providerMaterial = await provider.prepare({
      projectRoot: '/project', snapshot: prepared.snapshot, attemptId: 'FINALIZE-DUAL-1',
      requestDigest: digestText('write-sealer/finalize/v1', 'dual'), recovery: false,
    })
    const bound = providerMaterial.bind({ regression: published, fencingToken: 11 })
    const trustedExecution = (bound.semanticDrafts['browser-results']!.content as any).trustedCompilerExecution
    expect(trustedExecution.caseResults).toEqual([{ caseId: 'CASE-1', status: 'passed' }])

    const passedInjection = dualDomainWriteSnapshot('passed')
    const passedMaterial = await sealPrepared(passedInjection)
    passedInjection.snapshot.trustedExecutionFacts['finalization-material'] = passedMaterial
    const passedProvider = new ProductionFinalizationMaterialProvider({
      quarantine: { readEvidence: async ({ relativePath }: { relativePath: string }) =>
        Buffer.from(passedInjection.stored.get(relativePath)!) },
      projectCompilerInput: () => Object.freeze({}), authority: passedInjection.authority,
      privacyReviewVerifier: passedInjection.fixture.privacyReviewVerifier,
      regressionDiscoveryVerifier: passedInjection.fixture.regressionDiscoveryVerifier,
    } as never)
    const passedPrepared = await passedProvider.prepare({
      projectRoot: '/project', snapshot: passedInjection.snapshot, attemptId: 'FINALIZE-DUAL-2',
      requestDigest: digestText('write-sealer/finalize/v1', 'dual-passed'), recovery: false,
    })
    const passedBound = passedPrepared.bind({
      regression: regressionPublication(passedInjection.fixture), fencingToken: 11,
    })
    expect((passedBound.semanticDrafts['browser-results']!.content as any).trustedCompilerExecution)
      .toEqual(trustedExecution)
    expect(passedPrepared.compilerInput).toEqual(providerMaterial.compilerInput)

    const reportFixture = completeGenerationFixture()
    addFixtureInjectionResult(reportFixture)
    const complete = await buildFromPersistedDualMaterial(reportFixture)
    const report = complete.artifacts.find((item) => item.artifactType === 'final-report')!.content as any
    expect(complete.terminalVerdict).toBe('accepted')
    expect(report.realResults).toEqual([expect.objectContaining({ id: realResultId })])
    expect(report.injectionResults).toEqual([expect.objectContaining({ id: injectionResultId })])
    expect(report.advisoryFailures).toEqual([injectionResultId])
    expect(report.businessFailuresObserved).toEqual([])
    expect(report.metrics.injectionPassRate).toEqual({
      status: 'value', numerator: 0, denominator: 1, percentage: 0,
    })
    await providerMaterial.release()
    await passedPrepared.release()
  })

  test('injection evidence 被交换到 real resultId 域时 fail closed', async () => {
    const prepared = dualDomainWriteSnapshot()
    const facts = prepared.snapshot.trustedExecutionFacts['quarantined-evidence'] as any
    const realResultId = deriveExecutionResultId('CASE-1', 'real-environment')
    const injectionResultId = deriveExecutionResultId('CASE-1', 'gateway-injection')
    facts.gatewayInjection[injectionResultId] = structuredClone(facts.realEnvironment[realResultId])

    await expect(sealPrepared(prepared)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_FINALIZATION_INJECTION_EVIDENCE_ATTEMPT_MISMATCH',
    })
  })

  test('manual procedure 没有 Authority 签发的可信结果时明确阻断', async () => {
    const prepared = writeSnapshot()
    const artifact = structuredClone(prepared.snapshot.frozenArtifacts['execution-contract']!) as any
    artifact.content.manualProcedures = [{
      manualProcedureId: 'MANUAL-1', instructionDigest: digestText('write-sealer/v1', 'manual'),
    }]
    artifact.contentDigest = ''
    artifact.signatures = []
    artifact.contentDigest = digestArtifactContent(
      `artifact-content/${artifact.schemaVersion}/${artifact.artifactType}`, artifact,
    )
    prepared.snapshot.frozenArtifacts['execution-contract'] = ArtifactSchemaRegistry['execution-contract'].parse(artifact)
    await expect(new RuntimeFinalizationMaterialSealer({
      quarantine: prepared.quarantine as never, authority: prepared.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1',
    }).seal(prepared.snapshot)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_FINALIZATION_MANUAL_RESULTS_MISSING',
    })
  })

  test('Authority 验签且全链绑定的 manual result 被封存，过期或验签失败则阻断', async () => {
    const prepared = writeSnapshot()
    const manual = addTrustedManualResult(prepared)
    const verifyManualResult = vi.fn(() => ({ valid: true as const }))
    prepared.authority.verifyManualResult = verifyManualResult
    const material = await new RuntimeFinalizationMaterialSealer({
      quarantine: prepared.quarantine as never, authority: prepared.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1', now: () => new Date('2026-07-18T00:03:00.000Z'),
    }).seal(prepared.snapshot)
    const artifact = material.artifacts.find((entry) => entry.artifact.artifactType === 'manual-results')!.artifact
    const sealedManual = {
      ...manual,
      authorityProof: {
        ...manual.authorityProof,
        approvalAssurance: {
          approvalMode: 'webauthn',
          identityVerified: true,
          separationOfDutiesVerified: true,
        },
      },
    }
    expect((artifact.content as any).results).toEqual([sealedManual])
    expect(verifyManualResult).toHaveBeenCalledWith(sealedManual)

    const invalid = writeSnapshot()
    addTrustedManualResult(invalid)
    invalid.authority.verifyManualResult = vi.fn(() => ({
      valid: false as const, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked' as const,
    }))
    await expect(new RuntimeFinalizationMaterialSealer({
      quarantine: invalid.quarantine as never, authority: invalid.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1', now: () => new Date('2026-07-18T00:03:00.000Z'),
    }).seal(invalid.snapshot)).rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID' })

    const expired = writeSnapshot()
    addTrustedManualResult(expired)
    expired.authority.verifyManualResult = vi.fn(() => ({ valid: true as const }))
    await expect(new RuntimeFinalizationMaterialSealer({
      quarantine: expired.quarantine as never, authority: expired.authority as never,
      runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
      playwrightVersion: '1.61.1', now: () => new Date('2026-07-18T02:00:00.000Z'),
    }).seal(expired.snapshot)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_MANUAL_RESULT_BINDING_INVALID',
    })
  })
})

function sealPrepared(prepared: ReturnType<typeof writeSnapshot>) {
  return new RuntimeFinalizationMaterialSealer({
    quarantine: prepared.quarantine as never, authority: prepared.authority as never,
    runtimeVersion: '0.1.0', contractsVersion: '0.1.0', engineVersion: '0.1.0',
    playwrightVersion: '1.61.1',
  }).seal(prepared.snapshot)
}

async function buildFromPersistedDualMaterial(
  fixture: ReturnType<typeof completeGenerationFixture>,
) {
  const factBuild = buildCompleteGeneration(fixture)
  const artifacts = factBuild.artifacts.filter((artifact) =>
    !['final-report', 'generation-manifest'].includes(artifact.artifactType))
  const evidenceDraft = fixture.drafts['browser-evidence']
  const evidenceFiles = evidenceDraft.files ?? []
  const evidenceRecords = (evidenceDraft.content as any).artifacts as Array<{
    evidenceId: string; relativePath: string; byteLength: number; digest: string
  }>
  const evidenceBytes = new Map(evidenceFiles.map((file) => [file.relativePath, Buffer.from(file.base64, 'base64')]))
  const material = createPersistedRuntimeFinalizationMaterial({
    runId: fixture.context.generationId, attemptId: 'ATTEMPT-1',
    artifacts: artifacts.map((artifact) => ({ artifact,
      relativePath: fixture.drafts[artifact.artifactType as keyof typeof fixture.drafts].relativePath })),
    execution: { runId: fixture.context.generationId, attemptId: 'ATTEMPT-1',
      realEnvironmentResults: [realWriteOutput({ caseId: 'CASE-1', actionId: 'ACTION-1' })],
      injectionResults: [injectionOutput({ actionId: 'ACTION-1', attemptId: 'ATTEMPT-INJECTION-1', status: 'failed' })] },
    gatewayAudit: fixture.drafts['gateway-audit'].content,
    evidence: evidenceRecords.map((record) => ({
      evidenceId: record.evidenceId, relativePath: record.relativePath,
      quarantinePath: `sanitized/${record.evidenceId}.bin`, byteLength: record.byteLength, digest: record.digest,
    })),
    cleanup: ((fixture.drafts['cleanup-results'].content as any).leaseResults),
    provenance: fixture.provenance, reportPresentation: fixture.reportPresentation,
    verifierMaterials: {
      artifactAuthority: {}, approvalFreshness: {}, decision: {}, privacyReview: {},
      attemptEvent: {}, gatewayAudit: {}, sanitizer: {}, executionOutcome: {},
    },
  })
  const snapshot: RuntimeRunSnapshot = {
    schemaVersion: '1.4.0', runId: fixture.context.generationId, assetId: fixture.context.assetId,
    projectIdentityDigest: fixture.provenance.projectIdentityDigest,
    runtimeInstallationDigest: fixture.provenance.runtimeInstallationDigest, runRevision: 1,
    workflow: { current: 'finalizing', sequence: 1, eventChainDigest: digestText('test/v1', 'finalizing') },
    artifactDigests: {}, frozenArtifacts: {}, trustedExecutionFacts: { 'finalization-material': material },
    writeAttempts: {}, executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {}, createdAt: fixture.context.createdAt, updatedAt: fixture.context.createdAt,
  }
  const provider = new ProductionFinalizationMaterialProvider({
    quarantine: { readEvidence: async ({ relativePath }: { relativePath: string }) => {
      const evidenceId = relativePath.slice('sanitized/'.length, -'.bin'.length)
      const record = evidenceRecords.find((candidate) => candidate.evidenceId === evidenceId)
      if (!record) throw new Error(`missing evidence ${evidenceId}`)
      return Buffer.from(evidenceBytes.get(record.relativePath)!)
    } },
    projectCompilerInput: () => Object.freeze({}), authority: fixture.authority,
    gatewayVerifier: fixture.gatewayVerifier, sanitizerVerifier: fixture.sanitizerVerifier,
    privacyReviewVerifier: fixture.privacyReviewVerifier,
    regressionDiscoveryVerifier: () => true,
    attemptProofVerifier: fixture.attemptProofVerifier, executionOutcomeVerifier: () => true,
  } as never)
  const prepared = await provider.prepare({ projectRoot: '/project', snapshot,
    attemptId: 'FINALIZE-DUAL-MATERIAL', requestDigest: digestText('test/v1', 'dual-material'), recovery: false })
  const regression = regressionPublication(fixture)
  const attestation = structuredClone(regression.discoveryAttestation) as any
  attestation.isolation.stdoutDigest = digestText(
    'playwright-list-result/v1', canonicalizeJson(regression.caseIds),
  )
  const { issuer: _issuer, keyId: _keyId, purpose: _purpose, algorithm: _algorithm,
    signedDigest: _signedDigest, signature: _signature, ...subject } = attestation
  attestation.signedDigest = digestText('regression-discovery-subject/v2', canonicalizeJson(subject))
  attestation.signature = 'fixture-provider-signature'
  regression.discoveryAttestation = attestation
  const bound = prepared.bind({ regression, fencingToken: 11 })
  if (!bound.reportPresentation || !bound.verifiers) throw new Error('bound material incomplete')
  const authority = {
    signArtifactDigest: bound.authorities.signArtifactDigest.bind(bound.authorities),
    verifyArtifactSignature: bound.authorities.verifyArtifactSignature.bind(bound.authorities),
    verifyApprovalFreshnessReceipt: bound.authorities.verifyApprovalFreshnessReceipt.bind(bound.authorities),
    verifyDecisionReceipt: bound.authorities.verifyDecisionReceipt.bind(bound.authorities),
  }
  const complete = buildCompleteGeneration({
    context: bound.context, provenance: bound.provenance, drafts: bound.semanticDrafts,
    authority, reportPresentation: bound.reportPresentation, ...bound.verifiers,
  })
  await prepared.release()
  return complete
}

function regressionPublication(
  fixture: ReturnType<typeof completeGenerationFixture>,
): RegressionPublicationResult {
  const draft = fixture.drafts['regression-manifest']
  const content = draft.content as any
  const verifierKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })
  return {
    compilerInputDigest: content.listResult.attestation.compilerInputDigest,
    sourceSetDigest: content.listResult.attestation.sourceSetDigest,
    discoveryAttestation: content.listResult.attestation,
    caseIds: content.listResult.caseIds,
    files: draft.files!.map((file) => ({
      relativePath: file.relativePath, bytes: Buffer.from(file.base64, 'base64'),
    })),
    isolationProof: { backend: 'linux-bwrap' as const,
      proofDigest: digestText('write-sealer/regression/v1', 'isolation') },
    verifierMaterial: {
      schemaVersion: '1.0.0', issuer: 'fixture-discovery',
      keyId: 'fixture-discovery-key', purpose: 'regression-discovery-attestation/v2',
      algorithm: 'Ed25519',
      publicKeySpkiBase64: verifierKey.toString('base64'),
      publicKeyDigest: digestBytes('regression-discovery-public-key/v1', verifierKey),
    },
  }
}

function dualDomainWriteSnapshot(
  injectionStatus: 'passed' | 'failed' = 'failed',
): ReturnType<typeof writeSnapshot> {
  const prepared = writeSnapshot()
  const runId = prepared.snapshot.runId
  const prdRevision = prepared.snapshot.artifactDigests['prd-source']!
  const actionId = 'ACTION-1'
  const caseId = 'CASE-1'
  const attemptId = 'ATTEMPT-INJECTION-1'
  const request = {
    intentId: 'INTENT-INJECTION-1', method: 'GET', canonicalOrigin: 'https://test.example.com',
    exactPath: '/injection', query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const },
    targetFingerprint: 'not-applicable' as const, maxRequests: 1, expectedOrder: 1,
  }
  const response = {
    kind: 'http-response' as const, status: 503, headers: [{ name: 'content-type' as const, value: 'text/plain' }],
    body: { kind: 'no-body' as const }, delayMs: 0,
  }
  const subject = {
    schemaVersion: '1.0.0' as const, assetId: 'ASSET-1', prdRevision,
    executionDigest: digestText('write-sealer/injection/v1', 'execution'), environment: 'test' as const,
    baseOrigin: 'https://test.example.com', actions: [{ actionId, caseId, runId, attemptSlot: 1,
      request, response, expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden' as const }],
  }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  const capability = {
    capabilityId: 'CAPABILITY-INJECTION-1', nonce: 'a'.repeat(64), transport: 'gateway-injection' as const,
    actionId, caseId, runId, attemptSlot: 1, request, response,
    expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden' as const, maxUses: 1,
  }
  const grant = {
    grantId: 'GRANT-INJECTION-1', issuer: 'injection-authority', keyId: 'injection-authority-key',
    proofScope: 'local-os-user' as const, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject, subjectDigest, approvalContext: {
      schemaVersion: '1.0.0' as const, subject: 'os-user:qa', runId, approvalType: 'execution' as const,
      subjectDigest, installationDigest: prepared.snapshot.runtimeInstallationDigest,
      origin: 'http://127.0.0.1:43210', issuedAt: '2026-07-18T00:00:00.000Z',
      expiresAt: '2026-07-18T00:10:00.000Z',
    }, issuedAt: '2026-07-18T00:00:00.000Z', expiresAt: '2026-07-18T00:10:00.000Z',
    capabilities: [capability], revocationSequence: 0, signature: 'A'.repeat(86),
  }
  const gatewaySigner = LocalGatewayAuditSigner.create({
    issuer: 'injection-gateway', keyId: 'injection-gateway-key',
    instanceId: 'INJECTION-GATEWAY-1', version: '1.0.0',
  })
  const gatewayPolicyDigest = digestText('write-sealer/injection/v1', 'gateway-policy')
  const outcomeDigest = digestText('write-sealer/injection/v1', 'outcome')
  const reservationId = 'RESERVATION-INJECTION-1'
  const recorder = gatewaySigner.createRecorder(gatewayPolicyDigest)
  recorder.recordInjectionDecision({ actionId, request: { method: 'GET', url: 'https://test.example.com/injection' } })
  recorder.recordCapabilityReservation({ reservation: {
    reservationId, grantId: grant.grantId, capabilityId: capability.capabilityId,
    actionId, attemptId, attemptContext: { assetId: 'ASSET-1', generationId: runId,
      prdRevision, runId, caseId }, status: 'completed', outcomeDigest,
    reservedAt: '2026-07-18T00:00:00.000Z',
  }, consumed: true })
  const gatewayAudit = recorder.finalize()
  const dom = Buffer.from(canonicalizeJson({
    format: 'dom-tree/1', roots: [{ tag: 'main', text: 'gateway injection failed', assertionRelevant: true }],
  }))
  prepared.stored.set(`raw/${attemptId}/dom.bin`, dom)
  const finalizationFacts = {
    executionGrant: grant as unknown as Record<string, unknown>,
    gatewayAudit: gatewayAudit as unknown as Record<string, unknown>,
    gatewayAuditVerifierMaterial: gatewaySigner.exportVerifierMaterial() as unknown as Record<string, unknown>,
    browserMeasurements: {}, isolationMeasurements: {},
  }
  const injection = injectionOutput({
    resultId: deriveExecutionResultId(caseId, 'gateway-injection'),
    baselineResultId: deriveExecutionResultId(caseId, 'real-environment'),
    attemptId, caseId, actionId, status: injectionStatus,
    resultDigest: digestText('write-sealer/injection/v1', `${injectionStatus}-result`),
    completedReservationIds: [reservationId], finalizationFacts,
  })
  const realResultId = deriveExecutionResultId(caseId, 'real-environment')
  const injectionResultId = deriveExecutionResultId(caseId, 'gateway-injection')
  const realFacts = prepared.snapshot.trustedExecutionFacts['finalization-execution-facts']
  const realEvidence = prepared.snapshot.trustedExecutionFacts['quarantined-evidence']
  prepared.snapshot.trustedExecutionFacts['finalization-execution-facts'] = {
    schemaVersion: '2.0.0', realEnvironment: { [realResultId]: realFacts },
    gatewayInjection: { [injectionResultId]: finalizationFacts },
  }
  prepared.snapshot.trustedExecutionFacts['quarantined-evidence'] = {
    schemaVersion: '2.0.0', realEnvironment: { [realResultId]: realEvidence },
    gatewayInjection: { [injectionResultId]: {
      schemaVersion: '1.0.0', runId, attemptId, records: [
        { evidenceType: 'screenshot', quarantinePath: `raw/${attemptId}/screenshot.bin`,
          plaintextDigest: digestBytes('quarantine-plaintext/v1', Buffer.alloc(0)), byteLength: 0 },
        { evidenceType: 'dom', quarantinePath: `raw/${attemptId}/dom.bin`,
          plaintextDigest: digestBytes('quarantine-plaintext/v1', dom), byteLength: dom.byteLength },
      ],
    } },
  }
  prepared.snapshot.executionResults!.gatewayInjection[actionId] = injection as never
  return prepared
}

function withEvidencePolicy(artifact: ArtifactDocument): ArtifactDocument {
  const candidate = structuredClone(artifact) as any
  candidate.content.evidencePolicy.digest = runtimeProductionSanitizerPolicyDigest()
  candidate.signatures = []
  candidate.contentDigest = digestArtifactContent(
    `artifact-content/${candidate.schemaVersion}/${candidate.artifactType}`, candidate,
  )
  return ArtifactSchemaRegistry['project-policy'].parse(candidate)
}

function addTrustedManualResult(prepared: ReturnType<typeof writeSnapshot>) {
  const rebind = (type: 'coverage-universe' | 'test-cases' | 'execution-contract', mutate: (content: any) => void) => {
    const candidate = structuredClone(prepared.snapshot.frozenArtifacts[type]!) as any
    mutate(candidate.content)
    candidate.signatures = []
    candidate.contentDigest = ''
    candidate.contentDigest = digestArtifactContent(
      `artifact-content/${candidate.schemaVersion}/${candidate.artifactType}`, candidate,
    )
    prepared.snapshot.frozenArtifacts[type] = ArtifactSchemaRegistry[type].parse(candidate) as ArtifactDocument
    prepared.snapshot.artifactDigests[type] = candidate.contentDigest
  }
  const manualProcedureId = 'MANUAL-1'
  const obligationId = 'COV-MANUAL-1'
  const caseId = 'CASE-MANUAL-1'
  const instructionDigest = digestText('write-sealer/v1', 'manual-instructions')
  rebind('coverage-universe', (content) => {
    const obligation = structuredClone(content.obligations[0])
    Object.assign(obligation, { obligationId, scenario: '人工核验关键结果',
      disposition: { kind: 'manual', manualProcedureId, blocking: true } })
    content.obligations.push(obligation)
  })
  rebind('test-cases', (content) => {
    const candidate = structuredClone(content.cases[0])
    Object.assign(candidate, { caseId, obligationIds: [obligationId], title: '人工核验关键结果',
      effect: 'read', cleanupPlanId: 'not-applicable', retryPolicy: 'none' })
    candidate.steps = candidate.steps.map((step: any, index: number) => ({
      ...step, stepId: `STEP-MANUAL-${index + 1}`,
    }))
    content.cases.push(candidate)
  })
  rebind('execution-contract', (content) => {
    content.manualProcedures.push({ manualProcedureId, instructionDigest })
  })
  const model = prepared.snapshot.frozenArtifacts['requirement-model']!
  const draft = {
    schemaVersion: '1.0.0' as const, manualResultId: 'MANUAL-RESULT-1',
    runId: prepared.snapshot.runId, assetId: prepared.snapshot.assetId,
    prdRevision: prepared.snapshot.artifactDigests['prd-source']!, generationId: prepared.snapshot.runId,
    runtimeInstallationDigest: prepared.snapshot.runtimeInstallationDigest, manualProcedureId,
    caseIds: [caseId], obligationIds: [obligationId], requirementModelDigest: model.contentDigest,
    executor: { subject: 'os-user:executor', roles: ['e2e-manual-executor'] },
    reviewer: { subject: 'os-user:reviewer', roles: ['e2e-manual-reviewer'] },
    startedAt: '2026-07-18T00:00:00.000Z', finishedAt: '2026-07-18T00:01:00.000Z',
    outcome: 'passed' as const, steps: [{ stepId: 'STEP-MANUAL-1', instructionDigest,
      outcome: 'passed' as const, observation: '符合预期',
      evidenceDigests: [digestText('write-sealer/v1', 'manual-evidence')] }],
    evidenceDigests: [digestText('write-sealer/v1', 'manual-evidence')],
    expiresAt: '2026-07-18T01:00:00.000Z',
  }
  const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
  const result = {
    ...draft,
    authorityProof: {
      issuer: 'write-sealer-authority', keyId: 'write-sealer-manual-key',
      proofScope: 'local-os-user' as const, algorithm: 'Ed25519' as const,
      signedDigest: digestText('manual-result/v2', canonicalizeJson(draft)), signature: 'signature',
      executorPresence: { role: 'executor' as const, approvalType: 'manual-executor' as const,
        requiredRole: 'e2e-manual-executor' as const, subject: draft.executor.subject,
        sessionId: 'SESSION-EXECUTOR', runId: draft.runId,
        installationDigest: draft.runtimeInstallationDigest, draftDigest,
        origin: 'http://localhost:43101', issuedAt: '2026-07-18T00:01:00.000Z', expiresAt: draft.expiresAt },
      reviewerPresence: { role: 'reviewer' as const, approvalType: 'manual-reviewer' as const,
        requiredRole: 'e2e-manual-reviewer' as const, subject: draft.reviewer.subject,
        sessionId: 'SESSION-REVIEWER', runId: draft.runId,
        installationDigest: draft.runtimeInstallationDigest, draftDigest,
        origin: 'http://localhost:43102', issuedAt: '2026-07-18T00:02:00.000Z', expiresAt: draft.expiresAt },
    },
  }
  prepared.snapshot.trustedExecutionFacts['manual-results-by-id'] = { [result.manualResultId]: result }
  return result
}

function snapshot(input: {
  frozenArtifacts: Record<string, ArtifactDocument>
  projection: ReturnType<typeof projectionFixture>
  fixture: ReturnType<typeof completeGenerationFixture>
  dom: Buffer
}): RuntimeRunSnapshot {
  const gatewayAudit = input.fixture.drafts['gateway-audit'].content
  return {
    schemaVersion: '1.4.0', runId: 'GEN-1', assetId: 'ASSET-1',
    projectIdentityDigest: digestText('test/v1', 'project'),
    runtimeInstallationDigest: digestText('test/v1', 'runtime'), runRevision: 1,
    workflow: { current: 'diagnosing', sequence: 10, eventChainDigest: digestText('test/v1', 'workflow') },
    artifactDigests: { 'prd-source': input.fixture.context.prdRevision },
    frozenArtifacts: input.frozenArtifacts,
    trustedExecutionFacts: {
      'signed-discovery-grant': input.projection.trustedExecutionFacts['signed-discovery-grant'],
      'signed-execution-grant': input.projection.grant,
      'browser-preflight': {
        runId: 'GEN-1', discoveryGrantId: (input.projection.trustedExecutionFacts['signed-discovery-grant'] as any).grantId,
        reservationId: 'RES-PREFLIGHT', preflightDigest: digestText('test/v1', 'preflight'), status: 'ready',
        observedIdentityDigest: digestText('test/v1', 'identity'),
        browserMeasurementDigest: digestText('test/v1', 'browser'),
        browserClosureDigest: digestText('test/v1', 'closure'),
        browserExecutableDigest: digestText('test/v1', 'executable'),
        gatewaySessionMeasurementDigest: digestText('test/v1', 'gateway-session'),
        gatewayPolicyDigest: (gatewayAudit as any).policyDigest,
        gatewayAuditDigest: digestText('test/v1', 'preflight-audit'),
        canaryProofDigest: digestText('test/v1', 'canary'),
        authorityOutcomeDigest: digestText('test/v1', 'authority-outcome'),
        authorityReceiptDigest: digestText('test/v1', 'authority-receipt'),
      },
      'finalization-execution-facts': {
        gatewayAudit,
        gatewayAuditVerifierMaterial: { issuer: 'test' },
        browserMeasurements: {}, isolationMeasurements: {},
      },
      'quarantined-evidence': {
        schemaVersion: '1.0.0', runId: 'GEN-1', attemptId: 'ATTEMPT-1', records: [
          { evidenceType: 'screenshot', quarantinePath: 'raw/ATTEMPT-1/screenshot.bin',
            plaintextDigest: digestBytes('quarantine-plaintext/v1', Buffer.alloc(0)), byteLength: 0 },
          { evidenceType: 'dom', quarantinePath: 'raw/ATTEMPT-1/dom.bin',
            plaintextDigest: digestBytes('quarantine-plaintext/v1', input.dom), byteLength: input.dom.byteLength },
        ],
      },
    },
    writeAttempts: {},
    executionResults: { readEnvironment: { 'ACTION-1': {
      attemptId: 'ATTEMPT-1', caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed',
      result: { caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed', expected: ['Home'],
        actual: ['Home'], evidence: [], reservationIds: ['RESERVATION-1'],
        outcomeDigest: digestText('test/v1', 'outcome') },
      gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} },
      gatewayAuditDigest: digestText('test/v1', 'audit'),
    } }, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {}, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }
}

function writeSnapshot(options: {
  receiptEvidenceIds?: string[]
  capabilityMode?: 'http' | 'full-playwright'
  receiptCapabilityMode?: 'grant' | 'http'
} = {}): {
  snapshot: RuntimeRunSnapshot
  quarantine: { readEvidence(input: { relativePath: string }): Promise<Uint8Array>; writeEvidence(input: {
    relativePath: string; plaintext: Uint8Array
  }): Promise<unknown> }
  authority: Record<string, unknown>
  stored: Map<string, Buffer>
  fixture: ReturnType<typeof completeGenerationFixture>
} {
  const fixture = completeGenerationFixture()
  const built = buildCompleteGeneration(fixture)
  const base = runtimeWriteProjectionFixture()
  const runId = 'RUN-1'
  const prdRevision = base.frozenArtifacts['execution-contract']!.prdRevision
  const rebind = (candidate: ArtifactDocument, content: unknown = candidate.content): ArtifactDocument => {
    const document = structuredClone(candidate) as any
    Object.assign(document, {
      assetId: 'ASSET-1', generationId: runId, prdRevision, engineVersion: '0.1.0',
      createdAt: '2026-07-18T00:00:00.000Z', content, signatures: [], contentDigest: '',
    })
    document.contentDigest = digestArtifactContent(
      `artifact-content/${document.schemaVersion}/${document.artifactType}`, document,
    )
    return ArtifactSchemaRegistry[document.artifactType as keyof typeof ArtifactSchemaRegistry].parse(document) as ArtifactDocument
  }
  const excluded = new Set([
    'approval-grants', 'manual-results', 'data-leases', 'browser-preflight', 'run-bundle',
    'workflow-events', 'browser-results', 'gateway-audit', 'browser-evidence', 'diagnosis',
    'cleanup-results', 'final-report', 'generation-manifest',
  ])
  const frozenArtifacts = Object.fromEntries(built.artifacts
    .filter((artifact) => !excluded.has(artifact.artifactType))
    .map((artifact) => [artifact.artifactType, rebind(artifact)])) as Record<string, ArtifactDocument>
  for (const type of ['test-cases', 'execution-contract', 'browser-action-map'] as const) {
    frozenArtifacts[type] = rebind(base.frozenArtifacts[type]!)
  }
  const evidencePolicyDigest = runtimeProductionSanitizerPolicyDigest()
  const gatewayPolicyDigest = digestText('write-sealer/v1', 'gateway-policy')
  const projectPolicy = structuredClone(frozenArtifacts['project-policy']!.content) as any
  projectPolicy.environments = [{ environmentId: 'test', baseOrigin: 'https://test.example.com' }]
  projectPolicy.originPolicies = [{ origin: 'https://test.example.com', allowRead: true, allowWrite: true }]
  projectPolicy.evidencePolicy.digest = evidencePolicyDigest
  projectPolicy.runtimePolicy.digest = gatewayPolicyDigest
  frozenArtifacts['project-policy'] = rebind(frozenArtifacts['project-policy']!, projectPolicy)
  const grant = structuredClone(base.trustedExecutionFacts['signed-execution-grant']) as any
  const executionContent = structuredClone(frozenArtifacts['execution-contract']!.content) as any
  executionContent.evidencePolicyDigest = evidencePolicyDigest
  if (options.capabilityMode === 'full-playwright') {
    const fixed = grant.capabilities[0]
    const source = "state.programCompleted = true"
    const cleanupSource = "return 'verified-clean'"
    const program = {
      schemaVersion: 'full-playwright/v1', caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
      source, sourceDigest: computeFullPlaywrightSourceDigest(source), cleanupSource,
      cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource),
      dataLeaseId: fixed.dataLeaseId, cleanupPlanId: 'CLEANUP-1', timeoutMs: 30_000,
      networkRequests: [], networkRequestBodies: [],
    }
    const fullCleanupPlan = {
      schemaVersion: '2.0.0', transport: 'browser-local', cleanupPlanId: 'CLEANUP-1',
      actionId: 'ACTION-1', leaseId: fixed.dataLeaseId, executorId: 'FULL-PLAYWRIGHT',
      cleanupProgramDigest: program.cleanupSourceDigest, cleanupRequestIntentIds: [],
      verificationProbes: [{ probeId: 'PROBE-CLEAN-1', kind: 'browser-observation',
        expectedDigest: digestText('write-sealer/v1', 'clean-observation') }], timeoutMs: 30_000,
    }
    executionContent.executionProfile = 'full-playwright'
    executionContent.fullPlaywrightPrograms = [program]
    executionContent.writeHttpActions = []
    executionContent.writeCleanupPlans = [fullCleanupPlan]
    executionContent.actionIntents[0].intentDigest = program.sourceDigest
    delete executionContent.actionIntents[0].runtimeHttpActionDigest

    const actionMapContent = structuredClone(frozenArtifacts['browser-action-map']!.content) as any
    actionMapContent.executionProfile = 'full-playwright'
    actionMapContent.fullPlaywrightPrograms = [program]
    actionMapContent.actions[0].playwrightAction = 'full-playwright/v1'
    actionMapContent.actions[0].capabilities = [{ operation: 'full-playwright', capabilityId: fixed.capabilityId }]
    delete actionMapContent.actions[0].runtimeHttpActionDigest
    frozenArtifacts['browser-action-map'] = rebind(frozenArtifacts['browser-action-map']!, actionMapContent)

    const cleanupPlanDigest = digestCleanupPlanDefinition(fullCleanupPlan as never)
    grant.capabilities = [{ capabilityId: fixed.capabilityId, nonce: fixed.nonce,
      transport: 'browser-local', effect: 'reversible-write', operation: 'full-playwright',
      actionId: fixed.actionId, programDigest: program.sourceDigest,
      cleanupProgramDigest: program.cleanupSourceDigest,
      dataLeaseId: fixed.dataLeaseId, fencingToken: fixed.fencingToken,
      cleanupPlanDigest, requests: fixed.requests, maxUses: 1 }]
    const action = grant.subject.actions[0]
    grant.subject.actions = [{ actionId: action.actionId, effect: action.effect,
      dataLeaseId: action.dataLeaseId, resourceKey: action.resourceKey, fencingToken: action.fencingToken,
      cleanupPlanDigest, transport: 'browser-local', operation: 'full-playwright',
      programDigest: program.sourceDigest, cleanupProgramDigest: program.cleanupSourceDigest,
      requests: action.requests }]
  }
  frozenArtifacts['execution-contract'] = rebind(frozenArtifacts['execution-contract']!, executionContent)

  if (options.capabilityMode === 'full-playwright') {
    grant.subject.executionContractDigest = digestApprovalProjection('execution-contract', executionContent)
    grant.subject.actionMapDigest = digestApprovalProjection(
      'browser-action-map', frozenArtifacts['browser-action-map']!.content,
    )
    grant.subjectDigest = canonicalGrantApprovalSubjectDigest(grant.subject)
    grant.approvalContext.subjectDigest = grant.subjectDigest
  }
  const capability = grant.capabilities[0]
  const receiptCapability = options.receiptCapabilityMode === 'http'
    ? { capabilityId: capability.capabilityId, nonce: capability.nonce,
      transport: 'http', effect: 'reversible-write', operation: 'http-request',
      actionId: capability.actionId, dataLeaseId: capability.dataLeaseId,
      fencingToken: capability.fencingToken, cleanupPlanDigest: capability.cleanupPlanDigest,
      requests: capability.requests, maxUses: 1 }
    : capability
  const cleanupPlan = executionContent.writeCleanupPlans[0]
  const resultDigest = digestText('write-sealer/v1', 'runner-result')
  const cleanup = {
    status: 'verified-clean' as const,
    resultDigest: digestText('write-sealer/v1', 'cleanup-result'),
    leaseReceiptDigest: digestText('write-sealer/v1', 'lease-release'),
  }
  const evidenceId = 'EVIDENCE-ACTION-1'
  const receiptEvidenceIds = options.receiptEvidenceIds ?? [evidenceId]
  const gatewaySigner = LocalGatewayAuditSigner.create({
    issuer: 'write-gateway', keyId: 'write-gateway-key', instanceId: 'WRITE-GATEWAY-1', version: '1.0.0',
  })
  const receipt = gatewaySigner.issueExecutionOutcomeReceipt({
    schemaVersion: '1.0.0',
    attemptContext: { assetId: 'ASSET-1', generationId: runId, prdRevision,
      runId, caseId: 'CASE-1' },
    grantId: grant.grantId, capabilityId: capability.capabilityId,
    actionId: 'ACTION-1', attemptId: 'ATTEMPT-1', reservationId: 'RESERVATION-WRITE-1',
    capability: receiptCapability, effect: 'reversible-write', status: 'passed', effectObservation: 'applied',
    runnerResultDigest: resultDigest,
    gateway: {
      executionSessionId: 'SESSION-WRITE-1', policyDigest: gatewayPolicyDigest,
      approvedRequestSetDigest: digestText(
        'execution-outcome-approved-request-set/v1', canonicalizeJson(capability.requests)),
      received: 4, forwarded: 4, blocked: 0,
    },
    cleanup: { cleanupPlanId: cleanupPlan.cleanupPlanId,
      cleanupPlanDigest: digestCleanupPlanDefinition(cleanupPlan), leaseId: cleanupPlan.leaseId,
      ...cleanup },
    evidenceIds: receiptEvidenceIds,
    evidenceSetDigest: digestText('execution-outcome-evidence-set/v1', canonicalizeJson([...receiptEvidenceIds].sort())),
    completedAt: '2026-07-18T00:00:00.000Z',
  })
  const recorder = gatewaySigner.createRecorder(gatewayPolicyDigest)
  for (const [index, request] of capability.requests.entries()) recorder.recordReadDecision({
    actionId: 'ACTION-1', executionSessionId: 'SESSION-WRITE-1', decision: 'forwarded',
    request: { method: request.method, url: `${request.canonicalOrigin}${request.exactPath}` },
  })
  recorder.recordCapabilityReservation({ reservation: {
    reservationId: receipt.reservationId, grantId: receipt.grantId,
    capabilityId: receipt.capabilityId, actionId: receipt.actionId, attemptId: receipt.attemptId,
    attemptContext: receipt.attemptContext, status: 'completed', outcomeDigest: receipt.signedDigest,
    reservedAt: '2026-07-18T00:00:00.000Z',
  }, consumed: true })
  const gatewayAudit = recorder.finalize()
  const dom = Buffer.from(canonicalizeJson({
    format: 'dom-tree/1', roots: [{ tag: 'main', text: 'write completed', assertionRelevant: true }],
  }))
  const stored = new Map<string, Buffer>([['raw/ATTEMPT-1/dom.bin', dom]])
  const grants = (fixture.drafts['approval-grants'].content as any).grants
  const attemptKeys = generateKeyPairSync('ed25519')
  const attemptSpki = attemptKeys.publicKey.export({ type: 'spki', format: 'der' })
  const signAttemptProof = (signedDigest: string) => ({
    purpose: 'attempt-event-authority-proof/v2' as const,
    issuer: 'write-sealer-authority', keyId: 'write-sealer-attempt-key', algorithm: 'Ed25519' as const,
    signedDigest, signature: sign(null, Buffer.from(canonicalizeJson({
      purpose: 'attempt-event-authority-proof/v2', issuer: 'write-sealer-authority',
      keyId: 'write-sealer-attempt-key', signedDigest,
    })), attemptKeys.privateKey).toString('base64url'),
  })
  const authority = {
    ...fixture.authority,
    stateProtectionLevel: 'local-crash-integrity' as const,
    artifactVerifierMaterial: { publicKeyDigest: digestText('test/v1', 'artifact') },
    approvalFreshnessVerifierMaterial: { kind: 'test' }, decisionVerifierMaterial: { kind: 'test' },
    privacyReviewVerifierMaterial: { kind: 'test' }, attemptEventVerifierMaterial: {
      schemaVersion: '1.0.0', purpose: 'attempt-event-authority-proof/v2', issuer: 'write-sealer-authority',
      keyId: 'write-sealer-attempt-key', algorithm: 'Ed25519', publicKeySpki: attemptSpki.toString('base64url'),
      publicKeyDigest: digestBytes('attempt-event-public-key/v1', attemptSpki),
    },
    signDigest: fixture.authority.signArtifactDigest,
    verifySignature: (signature: any) => fixture.authority.verifyArtifactSignature(signature, signature.signedDigest),
    issueApprovalFreshnessReceipt: vi.fn(async () => grants[0]),
    appendAttemptEvent: vi.fn(({ event }: any) => appendAttemptEvent(event, signAttemptProof)),
    close: vi.fn(), credentialCount: 1,
  }
  const discovery = structuredClone(projectionFixture().trustedExecutionFacts['signed-discovery-grant']) as any
  const writeResult: any = realWriteOutput({
    caseId: 'CASE-1', actionId: 'ACTION-1', resultDigest,
    gatewayCommit: {
      reservationId: receipt.reservationId,
      reservationReceiptDigest: digestText('write-sealer/v1', 'reservation-receipt'),
      outcomeReceiptDigest: receipt.signedDigest, committed: true,
    },
    cleanup,
    finalizationFacts: {
      gatewayAudit, cleanup, executionOutcomeReceipt: receipt,
      executionOutcomeVerifierMaterial: gatewaySigner.exportExecutionOutcomeVerifierMaterial(),
      gatewayAuditVerifierMaterial: gatewaySigner.exportVerifierMaterial(),
      browserMeasurements: {}, isolationMeasurements: {},
    },
  })
  return {
    snapshot: {
      schemaVersion: '1.4.0', runId, assetId: 'ASSET-1',
      projectIdentityDigest: digestText('write-sealer/v1', 'project'),
      runtimeInstallationDigest: base.runtimeInstallationDigest, runRevision: 1,
      workflow: { current: 'diagnosing', sequence: 10,
        eventChainDigest: digestText('write-sealer/v1', 'workflow') },
      artifactDigests: { 'prd-source': prdRevision }, frozenArtifacts,
      trustedExecutionFacts: {
        'signed-discovery-grant': discovery, 'signed-execution-grant': grant,
        'browser-preflight': {
          runId, discoveryGrantId: discovery.grantId, reservationId: 'RES-PREFLIGHT',
          preflightDigest: digestText('write-sealer/v1', 'preflight'), status: 'ready',
          observedIdentityDigest: digestText('write-sealer/v1', 'identity'),
          browserMeasurementDigest: digestText('write-sealer/v1', 'browser'),
          browserClosureDigest: digestText('write-sealer/v1', 'closure'),
          browserExecutableDigest: digestText('write-sealer/v1', 'executable'),
          gatewaySessionMeasurementDigest: digestText('write-sealer/v1', 'gateway-session'),
          gatewayPolicyDigest, gatewayAuditDigest: digestText('write-sealer/v1', 'preflight-audit'),
          canaryProofDigest: digestText('write-sealer/v1', 'canary'),
          authorityOutcomeDigest: digestText('write-sealer/v1', 'authority-outcome'),
          authorityReceiptDigest: digestText('write-sealer/v1', 'authority-receipt'),
        },
        'finalization-execution-facts': writeResult.finalizationFacts,
        'quarantined-evidence': {
          schemaVersion: '1.0.0', runId, attemptId: 'ATTEMPT-1', records: [
            { evidenceType: 'screenshot', quarantinePath: 'raw/ATTEMPT-1/screenshot.bin',
              plaintextDigest: digestBytes('quarantine-plaintext/v1', Buffer.alloc(0)), byteLength: 0 },
            { evidenceType: 'dom', quarantinePath: 'raw/ATTEMPT-1/dom.bin',
              plaintextDigest: digestBytes('quarantine-plaintext/v1', dom), byteLength: dom.byteLength },
          ],
        },
      },
      writeAttempts: {}, executionResults: {
        readEnvironment: {}, realEnvironment: { 'ACTION-1': writeResult as never }, gatewayInjection: {},
      },
      requestResponses: {}, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    },
    quarantine: {
      readEvidence: async ({ relativePath }) => Buffer.from(stored.get(relativePath)!),
      writeEvidence: async ({ relativePath, plaintext }) => {
        if (stored.has(relativePath)) throw new Error('duplicate')
        stored.set(relativePath, Buffer.from(plaintext)); return {}
      },
    },
    authority, stored, fixture,
  }
}
