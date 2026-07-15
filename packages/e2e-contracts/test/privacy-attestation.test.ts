import { describe, expect, it } from 'vitest'
import {
  PrivacyReviewReceiptSchema, SanitizerAttestationSchema, generateArtifactJsonSchemas, parseArtifactDocument,
} from '../src/index.js'

const d = `sha256:${'a'.repeat(64)}`
const attestation = {
  schemaVersion: '1.0.0', issuer: 'SANITIZER', keyId: 'SANITIZER-1', purpose: 'sanitizer-attestation/v1', algorithm: 'Ed25519',
  evidenceId: 'E-1', relativePath: 'evidence/e-1.bin', evidenceType: 'dom', sanitizerVersion: '1.0.0',
  recordDigest: d, outputDigest: d, policyDigest: d, fileDigest: d, sanitizedBytesDigest: d,
  signedDigest: d, signature: 'signature',
}

describe('专用隐私证明契约', () => {
  it('拒绝通用 ArtifactSignature 冒充 sanitizer attestation', () => {
    expect(SanitizerAttestationSchema.safeParse({ issuer: 'x', keyId: 'x', algorithm: 'Ed25519', signedDigest: d, signature: 'x' }).success).toBe(false)
    expect(SanitizerAttestationSchema.parse(attestation)).toEqual(attestation)
    expect(SanitizerAttestationSchema.safeParse({ ...attestation, purpose: 'artifact-authority-signature/v1' }).success).toBe(false)
  })

  it('PrivacyReviewReceipt 必须绑定文件、proof、policy、决定和复核人', () => {
    const receipt = { schemaVersion: '1.0.0', issuer: 'AUTHORITY', keyId: 'PRIVACY-1', purpose: 'privacy-review-receipt/v1',
      algorithm: 'Ed25519', evidenceId: 'E-1', relativePath: 'evidence/e-1.bin', fileDigest: d,
      outputDigest: d, sanitizerProofDigest: d, policyDigest: d, decision: 'approved',
      checkedAt: '2026-07-12T00:00:00.000Z', approver: { subject: 'alice', roles: ['privacy-approver'] },
      signedDigest: d, signature: 'signature' }
    expect(PrivacyReviewReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(PrivacyReviewReceiptSchema.safeParse({ ...receipt, purpose: 'artifact-authority-signature/v1' }).success).toBe(false)
  })

  it('browser-evidence v1 必须迁移，v2 不允许 not-required 伪人工签名', () => {
    const base = { artifactId: 'A', artifactType: 'browser-evidence', schemaVersion: '1.0.0', engineVersion: '1.0.0',
      assetId: 'asset', prdRevision: d, generationId: 'gen', createdAt: '2026-07-12T00:00:00.000Z', contentDigest: d, dependencies: [],
      graph: { defines: [], references: [] }, signatures: [], content: { evidencePolicyDigest: d, artifacts: [],
        caseCoverage: [], sanitizerProofs: [], privacyReviews: [] } }
    expect(() => parseArtifactDocument(base)).toThrow()
    expect(() => parseArtifactDocument({ ...base, schemaVersion: '2.0.0' })).not.toThrow()
    const invalid = { ...base, schemaVersion: '2.0.0', content: { ...base.content, privacyReviews: [{
      evidenceId: 'E-1', status: 'not-required', derivationDigest: d, authoritySignature: attestation,
    }] } }
    expect(() => parseArtifactDocument(invalid)).toThrow()
  })

  it('运行时生成的 browser-evidence JSON Schema 暴露 v2 专用 attestation 与 receipt 联合', () => {
    const schema: any = generateArtifactJsonSchemas()['browser-evidence']
    expect(schema.properties.schemaVersion.const).toBe('2.0.0')
    const content = schema.properties.content.properties
    expect(content.sanitizerProofs.items.required).toEqual(expect.arrayContaining(['record', 'attestation']))
    expect(content.privacyReviews.items.anyOf).toHaveLength(3)
  })
})
