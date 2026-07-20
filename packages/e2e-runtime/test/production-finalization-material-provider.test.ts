import { describe, expect, test, vi } from 'vitest'
import { addFixtureInjectionResult, completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { buildCompleteGeneration } from '@mutil-skills/e2e-engine'
import { digestArtifactContent, digestBytes } from '@mutil-skills/e2e-contracts'
import { LocalGatewayAuditSigner } from '@mutil-skills/e2e-gateway'
import {
  ProductionFinalizationMaterialProvider,
  createPersistedRuntimeFinalizationMaterial,
} from '../src/production-finalization-material-provider.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { injectionOutput } from './runtime-write-fixtures.js'

describe('ProductionFinalizationMaterialProvider', () => {
  test('只从持久 trusted material 与 Quarantine 重建，不接受空事实或 caller drafts', async () => {
    const fixture = completeGenerationFixture()
    addFixtureInjectionResult(fixture)
    const built = buildCompleteGeneration(fixture)
    const factArtifacts = built.artifacts.filter((artifact) =>
      !['final-report', 'generation-manifest'].includes(artifact.artifactType))
    const persistedArtifacts = factArtifacts.map((artifact) => {
      if (artifact.artifactType !== 'project-policy') return artifact
      const candidate = { ...structuredClone(artifact), engineVersion: '9.9.9', signatures: [] }
      const contentDigest = digestArtifactContent(
        `artifact-content/${candidate.schemaVersion}/${candidate.artifactType}`, candidate,
      )
      return { ...candidate, contentDigest, signatures: [fixture.authority.signArtifactDigest(contentDigest)] }
    })
    const evidence = fixture.drafts['browser-evidence'].files![0]!
    const evidenceBytes = Buffer.from(evidence.base64, 'base64')
    const executionOutcomeSigner = LocalGatewayAuditSigner.create({
      issuer: 'gateway-test', keyId: 'gateway-test-key', instanceId: 'gateway-test-instance', version: '0.1.0',
    })
    const material = createPersistedRuntimeFinalizationMaterial({
      runId: fixture.context.generationId,
      attemptId: 'ATTEMPT-1',
      artifacts: persistedArtifacts.map((artifact) => ({
        artifact,
        relativePath: fixture.drafts[artifact.artifactType as keyof typeof fixture.drafts].relativePath,
      })),
      execution: { runId: fixture.context.generationId, attemptId: 'ATTEMPT-1',
        realEnvironmentResults: [{
          caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed', effectObservation: 'applied',
          resultDigest: digestBytes('test/write-result/v1', Buffer.from('result')),
          gatewayCommit: {
            reservationId: 'RESERVATION-1',
            reservationReceiptDigest: digestBytes('test/reservation/v1', Buffer.from('reservation')),
            outcomeReceiptDigest: digestBytes('test/outcome/v1', Buffer.from('outcome')),
            committed: true,
          },
          cleanup: {
            status: 'verified-clean',
            resultDigest: digestBytes('test/cleanup/v1', Buffer.from('cleanup')),
            leaseReceiptDigest: digestBytes('test/lease/v1', Buffer.from('lease')),
          },
        }], injectionResults: [injectionOutput({
          actionId: 'ACTION-1', attemptId: 'ATTEMPT-INJECTION-1', status: 'failed',
        })] },
      gatewayAudit: fixture.drafts['gateway-audit'].content,
      evidence: [{ evidenceId: 'EVIDENCE-1', relativePath: evidence.relativePath,
        quarantinePath: 'sanitized/EVIDENCE-1.bin', byteLength: evidenceBytes.byteLength,
        digest: digestBytes(`generation-file:${evidence.relativePath}`, evidenceBytes) }],
      cleanup: (fixture.drafts['cleanup-results'].content as { leaseResults: [] }).leaseResults,
      provenance: fixture.provenance,
      reportPresentation: fixture.reportPresentation,
      verifierMaterials: {
        artifactAuthority: { kind: 'runtime-authority' }, approvalFreshness: { kind: 'runtime-authority' },
        decision: { kind: 'runtime-authority' }, gatewayAudit: { kind: 'persisted-test' },
        sanitizer: { kind: 'persisted-test' }, privacyReview: { kind: 'runtime-authority' },
        attemptEvent: { kind: 'runtime-authority' }, regressionDiscovery: { kind: 'finalizer-owned' },
        executionOutcome: executionOutcomeSigner.exportExecutionOutcomeVerifierMaterial(),
      },
    })
    const snapshot = finalizingSnapshot(material, fixture.provenance)
    snapshot.updatedAt = '2026-07-19T12:34:56.000Z'
    const readEvidence = vi.fn(async () => Buffer.from(evidenceBytes))
    const compilerInput = Object.freeze({})
    const provider = new ProductionFinalizationMaterialProvider({
      quarantine: { readEvidence },
      projectCompilerInput: vi.fn(() => compilerInput),
      authority: { ...fixture.authority, verifySignature: () => true },
      gatewayVerifier: fixture.gatewayVerifier,
      sanitizerVerifier: fixture.sanitizerVerifier,
      privacyReviewVerifier: fixture.privacyReviewVerifier,
      attemptProofVerifier: fixture.attemptProofVerifier,
    } as never)

    const prepared = await provider.prepare({ projectRoot: '/project', snapshot,
      attemptId: 'FINALIZE-1', requestDigest: digestBytes('request/v1', Buffer.from('finalize')), recovery: false })

    expect(prepared.compilerInput).toBe(compilerInput)
    expect(readEvidence).toHaveBeenCalledWith({ runId: 'GEN-1', relativePath: 'sanitized/EVIDENCE-1.bin' })
    const regression = regressionResult(fixture)
    const bound = prepared.bind({ regression, fencingToken: 11 })
    expect(Object.keys(bound.semanticDrafts)).toHaveLength(25)
    expect(bound.evidence[0]?.bytes).toEqual(evidenceBytes)
    const browserPreflight = factArtifacts.find((artifact) => artifact.artifactType === 'browser-preflight')!
    expect(bound.context).toMatchObject({
      generationId: 'GEN-1', fencingToken: 11,
      engineVersion: browserPreflight.engineVersion,
      createdAt: browserPreflight.createdAt,
    })
    expect(Object.keys(bound.authorities).sort()).toEqual([
      'signArtifactDigest', 'verifyApprovalFreshnessReceipt',
      'verifyArtifactSignature', 'verifyDecisionReceipt',
    ])
    expect((bound.semanticDrafts['regression-manifest']!.content as any).discoveryVerifierMaterial)
      .toEqual(regressionVerifierMaterial())
    expect((bound.semanticDrafts['regression-manifest']!.content as any).listResult.digest)
      .toBe(regression.discoveryAttestation.isolation.stdoutDigest)
    expect((bound.semanticDrafts['browser-results']!.content as any).trustedCompilerExecution.caseResults)
      .toEqual([{ caseId: 'CASE-1', status: 'passed' }])
    expect(bound.verifiers?.executionOutcomeVerifier).toBeTypeOf('function')
    expect(bound.verifiers?.executionOutcomeVerifier?.({} as never)).toBe(false)
    await prepared.release()
    expect(bound.evidence[0]?.bytes).toEqual(Buffer.alloc(evidenceBytes.byteLength))
  })

  test('缺失持久 trusted material 时 fail closed', async () => {
    const fixture = completeGenerationFixture()
    const provider = new ProductionFinalizationMaterialProvider({
      quarantine: { readEvidence: vi.fn() }, projectCompilerInput: vi.fn(), authority: fixture.authority,
      gatewayVerifier: fixture.gatewayVerifier, sanitizerVerifier: fixture.sanitizerVerifier,
      privacyReviewVerifier: fixture.privacyReviewVerifier, attemptProofVerifier: fixture.attemptProofVerifier,
    } as never)
    await expect(provider.prepare({ projectRoot: '/project', snapshot: finalizingSnapshot(undefined),
      attemptId: 'FINALIZE-1', requestDigest: digestBytes('request/v1', Buffer.from('missing')), recovery: false }))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_FINALIZATION_MATERIAL_MISSING' })
  })
})

function finalizingSnapshot(
  material: unknown,
  provenance?: ReturnType<typeof completeGenerationFixture>['provenance'],
): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.3.0', runId: 'GEN-1', assetId: 'ASSET-1',
    projectIdentityDigest: provenance?.projectIdentityDigest ?? `sha256:${'a'.repeat(64)}`,
    runtimeInstallationDigest: provenance?.runtimeInstallationDigest ?? `sha256:${'b'.repeat(64)}`,
    runRevision: 1,
    workflow: { current: 'finalizing', sequence: 1, eventChainDigest: `sha256:${'c'.repeat(64)}` },
    artifactDigests: {}, frozenArtifacts: {},
    trustedExecutionFacts: material === undefined ? {} : { 'finalization-material': material },
    writeAttempts: {}, executionResults: { realEnvironment: {}, gatewayInjection: {} }, requestResponses: {},
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }
}

function regressionResult(fixture: ReturnType<typeof completeGenerationFixture>) {
  const draft = fixture.drafts['regression-manifest']
  const content = draft.content as any
  return {
    compilerInputDigest: content.listResult.attestation.compilerInputDigest,
    sourceSetDigest: content.listResult.attestation.sourceSetDigest,
    discoveryAttestation: content.listResult.attestation,
    caseIds: content.listResult.caseIds,
    files: draft.files!.map((file) => ({ relativePath: file.relativePath,
      bytes: Buffer.from(file.base64, 'base64') })),
    isolationProof: { backend: 'linux-bwrap' as const, proofDigest: `sha256:${'d'.repeat(64)}` },
    verifierMaterial: regressionVerifierMaterial(),
  }
}

function regressionVerifierMaterial() {
  return {
    schemaVersion: '1.0.0' as const,
    issuer: 'DISCOVERY', keyId: 'DISCOVERY-1', purpose: 'regression-discovery-attestation/v2' as const,
    algorithm: 'Ed25519' as const, publicKeySpkiBase64: 'cHVibGljLWtleQ==',
    publicKeyDigest: `sha256:${'e'.repeat(64)}`,
  }
}
