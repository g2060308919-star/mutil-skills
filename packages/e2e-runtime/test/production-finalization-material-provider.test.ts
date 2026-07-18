import { describe, expect, test, vi } from 'vitest'
import { completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { buildCompleteGeneration } from '@mutil-skills/e2e-engine'
import { digestBytes } from '@mutil-skills/e2e-contracts'
import {
  ProductionFinalizationMaterialProvider,
  createPersistedRuntimeFinalizationMaterial,
} from '../src/production-finalization-material-provider.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'

describe('ProductionFinalizationMaterialProvider', () => {
  test('只从持久 trusted material 与 Quarantine 重建，不接受空事实或 caller drafts', async () => {
    const fixture = completeGenerationFixture()
    const built = buildCompleteGeneration(fixture)
    const factArtifacts = built.artifacts.filter((artifact) =>
      !['final-report', 'generation-manifest'].includes(artifact.artifactType))
    const evidence = fixture.drafts['browser-evidence'].files![0]!
    const evidenceBytes = Buffer.from(evidence.base64, 'base64')
    const material = createPersistedRuntimeFinalizationMaterial({
      runId: fixture.context.generationId,
      attemptId: 'ATTEMPT-1',
      artifacts: factArtifacts.map((artifact) => ({
        artifact,
        relativePath: fixture.drafts[artifact.artifactType as keyof typeof fixture.drafts].relativePath,
      })),
      execution: { runId: fixture.context.generationId, attemptId: 'ATTEMPT-1',
        realEnvironmentResults: [], injectionResults: [] },
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
      },
    })
    const snapshot = finalizingSnapshot(material, fixture.provenance)
    const readEvidence = vi.fn(async () => Buffer.from(evidenceBytes))
    const compilerInput = Object.freeze({})
    const provider = new ProductionFinalizationMaterialProvider({
      quarantine: { readEvidence },
      projectCompilerInput: vi.fn(() => compilerInput),
      authority: fixture.authority,
      gatewayVerifier: fixture.gatewayVerifier,
      sanitizerVerifier: fixture.sanitizerVerifier,
      privacyReviewVerifier: fixture.privacyReviewVerifier,
      attemptProofVerifier: fixture.attemptProofVerifier,
    } as never)

    const prepared = await provider.prepare({ projectRoot: '/project', snapshot,
      attemptId: 'FINALIZE-1', requestDigest: digestBytes('request/v1', Buffer.from('finalize')), recovery: false })

    expect(prepared.compilerInput).toBe(compilerInput)
    expect(readEvidence).toHaveBeenCalledWith({ runId: 'GEN-1', relativePath: 'sanitized/EVIDENCE-1.bin' })
    const bound = prepared.bind({ regression: regressionResult(fixture), fencingToken: 11 })
    expect(Object.keys(bound.semanticDrafts)).toHaveLength(25)
    expect(bound.evidence[0]?.bytes).toEqual(evidenceBytes)
    expect(bound.context).toMatchObject({ generationId: 'GEN-1', fencingToken: 11 })
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
  }
}
