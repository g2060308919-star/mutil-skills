import { describe, expect, it } from 'vitest'
import type { SanitizerPolicy } from '@mutil-skills/e2e-contracts'
import { createSanitizerAttestationVerifier, LocalSanitizerAuthority } from '../src/index.js'

const policy: SanitizerPolicy = {
  schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.2.0', scannerVersion: '1.1.0',
  network: { formatVersions: ['network-json/1'], approvedPaths: ['/api'], queryFields: [], requestHeaderFields: [],
    responseHeaderFields: [], requestBodyFields: [], responseBodyFields: [] },
  dom: { formatVersions: ['dom-tree/1'], allowedTags: ['main'], allowedAttributes: [], assertionTextClassification: 'public' },
  console: { formatVersions: ['console-json/1'], allowedObjectFields: [], primitiveArgumentClassification: 'public' },
  screenshot: { formatVersions: ['png/1'] }, video: { formatVersions: ['webm/1'] },
  trace: { formatVersions: ['playwright-trace/1'] }, maxInputBytes: 100_000,
  requireManualReviewFor: ['contact'],
}

describe('LocalSanitizerAuthority', () => {
  it('只给真实 sanitizer 的实际 output 签专用 attestation，跨进程可验', () => {
    const local = LocalSanitizerAuthority.create({ issuer: 'SANITIZER', keyId: 'KEY-1', policy })
    const result = local.sanitizeDom({ evidenceId: 'E-1', relativePath: 'evidence/e-1.json',
      raw: Buffer.from(JSON.stringify({ format: 'dom-tree/1', roots: [{ tag: 'main', text: 'ok', assertionRelevant: true }] })) })
    expect(result.status).toBe('publishable')
    if (result.status !== 'publishable') throw new Error('expected publishable')
    const verify = createSanitizerAttestationVerifier(local.verifierMaterial, local.verifierMaterial.publicKeyDigest)
    const { schemaVersion: _, issuer: _i, keyId: _k, purpose: _p, algorithm: _a, signedDigest: _d, signature: _s,
      ...binding } = result.attestation
    expect(verify(result.attestation, binding)).toBe(true)
    expect(verify({ ...result.attestation, policyDigest: `sha256:${'0'.repeat(64)}` },
      { ...binding, policyDigest: `sha256:${'0'.repeat(64)}` })).toBe(false)
    expect(verify({ ...result.attestation, purpose: 'artifact-authority-signature/v1' } as never, binding)).toBe(false)
    expect(verify(result.attestation, { ...binding, relativePath: 'evidence/other.json' })).toBe(false)
    expect(verify(result.attestation, { ...binding, sanitizedBytesDigest: `sha256:${'0'.repeat(64)}` })).toBe(false)
  })

  it('review-required 截图保留 pending record 并签实际遮罩输出；create 后替换 adapter 无效', () => {
    const adapter = {
      version: '2.0.0', supportedFormats: ['png/1'], sanitize: () => ({ bytes: Buffer.from('masked'),
        maskVerification: { verified: true, failedMaskIds: [] as string[] },
        ocr: { performed: true, engineVersion: '1.0.0', text: 'safe', regions: ['full'] },
        frames: { strategy: 'not-applicable' as const, inspectedFrames: [] as number[] },
        canaries: [{ canaryId: 'visual-canary', expectedClassification: 'contact' as const, detected: true }] }),
    }
    const local = LocalSanitizerAuthority.create({ issuer: 'SANITIZER', keyId: 'KEY-1', policy, visualAdapter: adapter })
    adapter.sanitize = () => { throw new Error('caller replaced adapter') }
    const result = local.sanitizeVisual({ evidenceId: 'SHOT-1', relativePath: 'evidence/shot.png', evidenceType: 'screenshot',
      raw: Buffer.from(JSON.stringify({ format: 'png/1', mediaBase64: Buffer.from('raw-secret').toString('base64'),
        width: 10, height: 10, masks: [{ maskId: 'm', target: 'coordinates', x: 0, y: 0, width: 1, height: 1 }] })) })
    expect(result.status).toBe('review-required')
    if (result.status !== 'review-required') throw new Error('expected review-required')
    expect(result.bytes.toString()).toBe('masked')
    expect(result.record.manualReview).toMatchObject({ required: true, status: 'pending' })
    expect(result.attestation.outputDigest).toBe(result.record.outputDigest)
  })

  it('blocked 结果没有 attestation，且拒绝 key substitution', () => {
    const local = LocalSanitizerAuthority.create({ issuer: 'SANITIZER', keyId: 'KEY-1', policy })
    const blocked = local.sanitizeDom({ evidenceId: 'E-1', relativePath: 'evidence/e-1.json', raw: Buffer.from('bad') })
    expect(blocked.status).toBe('blocked')
    expect('attestation' in blocked).toBe(false)
    const other = LocalSanitizerAuthority.create({ issuer: 'SANITIZER', keyId: 'KEY-1', policy })
    expect(createSanitizerAttestationVerifier(other.verifierMaterial, local.verifierMaterial.publicKeyDigest)
      ({} as never, {} as never)).toBe(false)
  })
})
