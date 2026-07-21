import { describe, expect, test } from 'vitest'
import { completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { GenerationAssembler } from '../src/generation-assembler.js'
import { RuntimeExecutionBatch } from '../src/runtime-execution-batch.js'

describe('GenerationAssembler', () => {
  test('将 Host 收集事实与 semantic drafts 一一绑定后交给唯一 builder 裁决', () => {
    const fixture = completeGenerationFixture()
    const browserEvidence = fixture.drafts['browser-evidence']
    const regression = fixture.drafts['regression-manifest']
    const evidenceRecord = (browserEvidence.content as any).artifacts[0]
    const evidenceFile = browserEvidence.files![0]!
    const attestation = (regression.content as any).listResult.attestation
    const verifierMaterial = {
      schemaVersion: '1.0.0' as const, issuer: attestation.issuer, keyId: attestation.keyId,
      purpose: 'regression-discovery-attestation/v2' as const, algorithm: 'Ed25519' as const,
      publicKeySpkiBase64: 'cHVibGljLWtleQ==', publicKeyDigest: `sha256:${'b'.repeat(64)}`,
    }
    ;(regression.content as any).discoveryVerifierMaterial = verifierMaterial
    const regressionFile = regression.files![0]!
    const assembler = new GenerationAssembler({
      reportPresentation: fixture.reportPresentation,
      gatewayVerifier: fixture.gatewayVerifier,
      sanitizerVerifier: fixture.sanitizerVerifier,
      privacyReviewVerifier: fixture.privacyReviewVerifier,
      regressionDiscoveryVerifier: fixture.regressionDiscoveryVerifier,
      attemptProofVerifier: fixture.attemptProofVerifier,
      executionOutcomeVerifier: fixture.executionOutcomeVerifier,
      verdictDependencies: fixture.verdictDependencies,
    })
    const built = assembler.finalize({
      context: fixture.context,
      semanticDrafts: fixture.drafts,
      execution: new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-1' }),
      gatewayAudit: fixture.drafts['gateway-audit'].content as any,
      evidence: [{ evidenceId: evidenceRecord.evidenceId, relativePath: evidenceFile.relativePath,
        bytes: Buffer.from(evidenceFile.base64, 'base64') }],
      cleanup: (fixture.drafts['cleanup-results'].content as any).leaseResults,
      regression: {
        compilerInputDigest: attestation.compilerInputDigest,
        sourceSetDigest: attestation.sourceSetDigest,
        discoveryAttestation: attestation,
        caseIds: (regression.content as any).listResult.caseIds,
        files: [{ relativePath: regressionFile.relativePath, bytes: Buffer.from(regressionFile.base64, 'base64') }],
        isolationProof: { backend: 'linux-bwrap', proofDigest: `sha256:${'a'.repeat(64)}` },
        verifierMaterial,
      },
      provenance: fixture.provenance,
      authorities: fixture.authority,
    })
    expect(built.artifacts).toHaveLength(27)
  })

  test('拒绝未与 manifest 签名内容绑定的 Discovery 公钥材料', () => {
    const fixture = completeGenerationFixture()
    const regression = fixture.drafts['regression-manifest']
    const browserEvidence = fixture.drafts['browser-evidence']
    const evidenceRecord = (browserEvidence.content as any).artifacts[0]
    const evidenceFile = browserEvidence.files![0]!
    const regressionFile = regression.files![0]!
    const attestation = (regression.content as any).listResult.attestation
    const verifierMaterial = {
      schemaVersion: '1.0.0' as const, issuer: attestation.issuer, keyId: attestation.keyId,
      purpose: 'regression-discovery-attestation/v2' as const, algorithm: 'Ed25519' as const,
      publicKeySpkiBase64: 'cHVibGljLWtleQ==', publicKeyDigest: `sha256:${'b'.repeat(64)}`,
    }
    ;(regression.content as any).discoveryVerifierMaterial = verifierMaterial
    const assembler = new GenerationAssembler({ ...fixture,
      reportPresentation: fixture.reportPresentation } as any)
    expect(() => assembler.finalize({
      context: fixture.context, semanticDrafts: fixture.drafts,
      execution: new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-1' }),
      gatewayAudit: fixture.drafts['gateway-audit'].content as any,
      evidence: [{ evidenceId: evidenceRecord.evidenceId, relativePath: evidenceFile.relativePath,
        bytes: Buffer.from(evidenceFile.base64, 'base64') }],
      cleanup: (fixture.drafts['cleanup-results'].content as any).leaseResults,
      regression: { discoveryAttestation: attestation,
        compilerInputDigest: attestation.compilerInputDigest, sourceSetDigest: attestation.sourceSetDigest,
        caseIds: (regression.content as any).listResult.caseIds,
        files: [{ relativePath: regressionFile.relativePath, bytes: Buffer.from(regressionFile.base64, 'base64') }],
        isolationProof: { backend: 'linux-bwrap', proofDigest: `sha256:${'a'.repeat(64)}` },
        verifierMaterial: { ...verifierMaterial, publicKeyDigest: `sha256:${'c'.repeat(64)}` } },
      provenance: fixture.provenance, authorities: fixture.authority,
    } as any)).toThrow(/E2E_GENERATION_ASSEMBLER_REGRESSION_UNBOUND/)
  })

  test('任一 evidence bytes 与批准 draft 不一致时 fail closed', () => {
    const fixture = completeGenerationFixture()
    const assembler = new GenerationAssembler({ ...fixture,
      reportPresentation: fixture.reportPresentation } as any)
    expect(() => assembler.finalize({
      context: fixture.context, semanticDrafts: fixture.drafts,
      execution: new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-1' }),
      gatewayAudit: fixture.drafts['gateway-audit'].content as any,
      evidence: [{ evidenceId: 'EVIDENCE-1', relativePath: 'evidence/case-1.json', bytes: Buffer.from('tampered') }],
      cleanup: [], regression: {} as any, provenance: fixture.provenance, authorities: fixture.authority,
    })).toThrow(/E2E_GENERATION_ASSEMBLER_EVIDENCE_UNBOUND/)
  })
})
