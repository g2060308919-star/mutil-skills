import { describe, expect, it } from 'vitest'
import {
  computeRegressionSourceSetDigest,
  digestArtifactContent,
  RegressionDiscoveryAttestationSchema,
  RegressionDiscoverySubjectSchema,
  parseArtifactDocument,
} from '../src/index.js'

const d = `sha256:${'a'.repeat(64)}`
const sourceFiles = [{ relativePath: 'regression/tests/generated.spec.ts', digest: d, byteLength: 12,
  mediaType: 'text/typescript' as const }]
const subject = {
  schemaVersion: '2.0.0', testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
  assetId: 'PRODUCT/PRD-1', generationId: 'GEN-1', prdRevision: d,
  compilerVersion: '4.0.0', templateVersion: '3.0.0', contractsVersion: '2.0.0',
  environmentId: 'TEST', approvalDigest: d, policyDigest: d,
  templateDigest: d, compilerInputDigest: d,
  sourceFiles,
  caseMappings: [{ caseId: 'CASE-1', relativePath: 'regression/tests/generated.spec.ts', testTitle: '首页可见' }],
  toolchain: { nodeVersion: '24.18.0', playwrightVersion: '1.61.1', compilerDigest: d, playwrightCliDigest: d },
  isolation: {
    command: ['node', '@playwright/test/cli', 'test', '--list', '--reporter=json'],
    exitCode: 0, stdoutDigest: d,
  },
  discoveredCaseIds: ['CASE-1'], blockedCases: [],
  sourceSetDigest: computeRegressionSourceSetDigest(sourceFiles),
}

describe('RegressionDiscoveryAttestation 严格契约', () => {
  it('绑定源码、映射、工具链、隔离 list 事实和代际，拒绝未知字段', () => {
    expect(RegressionDiscoverySubjectSchema.parse(subject)).toEqual(subject)
    expect(RegressionDiscoverySubjectSchema.safeParse({ ...subject, callerCaseIds: ['CASE-FAKE'] }).success).toBe(false)
    expect(RegressionDiscoverySubjectSchema.safeParse({ ...subject,
      blockedCases: [{ caseId: 'CASE-1', reasonCode: 'E2E_BLOCKED' }] }).success).toBe(false)
  })

  it('专用 purpose 不能由通用 Artifact 签名替代', () => {
    const attestation = { ...subject, issuer: 'DISCOVERY', keyId: 'DISCOVERY-1',
      purpose: 'regression-discovery-attestation/v2', algorithm: 'Ed25519', signedDigest: d, signature: 'proof' }
    expect(RegressionDiscoveryAttestationSchema.parse(attestation)).toEqual(attestation)
    expect(RegressionDiscoveryAttestationSchema.safeParse({ ...attestation,
      purpose: 'artifact-authority-signature/v1' }).success).toBe(false)
  })

  it('regression-manifest v1 必须迁移，v2 必须携带专用证明', () => {
    const base = { artifactId: 'A', artifactType: 'regression-manifest', schemaVersion: '1.0.0', engineVersion: '1.0.0',
      assetId: 'PRODUCT/PRD-1', prdRevision: d, generationId: 'GEN-1', createdAt: '2026-07-12T00:00:00.000Z',
      contentDigest: d, dependencies: [], graph: { defines: [], references: [] }, signatures: [],
      content: { testDomain: subject.testDomain, executionProfile: subject.executionProfile,
        templateDigest: d, toolchain: subject.toolchain, sourceFiles: subject.sourceFiles,
        caseMappings: subject.caseMappings, blockedCases: [], deprecatedCases: [],
        listResult: { caseIds: ['CASE-1'], digest: d } } }
    expect(() => parseArtifactDocument(base)).toThrow()
    expect(() => parseArtifactDocument({ ...base, schemaVersion: '2.0.0' })).toThrow()
  })

  it('本代发布 manifest 可携带并绑定 Discovery 公钥材料，供独立进程复验', () => {
    const attestation = { ...subject, issuer: 'DISCOVERY', keyId: 'DISCOVERY-1',
      purpose: 'regression-discovery-attestation/v2', algorithm: 'Ed25519', signedDigest: d, signature: 'proof' }
    const discoveryVerifierMaterial = {
      schemaVersion: '1.0.0', issuer: 'DISCOVERY', keyId: 'DISCOVERY-1',
      purpose: 'regression-discovery-attestation/v2', algorithm: 'Ed25519',
      publicKeySpkiBase64: 'cHVibGljLWtleQ==', publicKeyDigest: d,
    }
    const candidate = {
      artifactId: 'A', artifactType: 'regression-manifest', schemaVersion: '2.0.0', engineVersion: '1.0.0',
      assetId: 'PRODUCT/PRD-1', prdRevision: d, generationId: 'GEN-1', createdAt: '2026-07-12T00:00:00.000Z',
      dependencies: [], graph: { defines: [], references: [] }, signatures: [],
      content: { testDomain: subject.testDomain, executionProfile: subject.executionProfile,
        templateDigest: d, toolchain: subject.toolchain, sourceFiles: subject.sourceFiles,
        caseMappings: subject.caseMappings, blockedCases: [], deprecatedCases: [],
        discoveryVerifierMaterial,
        listResult: { caseIds: ['CASE-1'], digest: d, attestation } },
    }
    const valid = { ...candidate,
      contentDigest: digestArtifactContent('artifact-content/2.0.0/regression-manifest', candidate) }

    expect(parseArtifactDocument(valid).content).toMatchObject({ discoveryVerifierMaterial })
    const mismatched = structuredClone(valid)
    mismatched.content.discoveryVerifierMaterial.keyId = 'DISCOVERY-OTHER'
    mismatched.contentDigest = digestArtifactContent('artifact-content/2.0.0/regression-manifest', mismatched)
    expect(() => parseArtifactDocument(mismatched)).toThrow()
  })
})
