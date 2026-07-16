import { describe, expect, it } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import { createPrivacyReviewVerifier, LocalApprovalAuthority } from '../src/index.js'

const d = (x: string) => digestText('test/v1', x)
const binding = { evidenceId: 'E-1', relativePath: 'evidence/e-1.bin', fileDigest: d('file'),
  outputDigest: d('output'), sanitizerProofDigest: d('proof'), policyDigest: d('policy'),
  decision: 'approved' as const, approver: { subject: 'alice', roles: ['privacy-approver'] } }

describe('专用 PrivacyReview receipt', () => {
  const now = () => new Date('2026-07-12T01:00:00.000Z')
  const authority = () => LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-1', now,
    manualIdentities: [{ subject: 'alice', roles: ['privacy-approver'] }] })

  it('只给登记的 privacy-approver 签发并可跨进程验签', () => {
    const local = authority()
    const receipt = local.issuePrivacyReviewReceipt(binding)
    const verify = createPrivacyReviewVerifier(local.privacyReviewVerifierMaterial,
      local.privacyReviewVerifierMaterial.publicKeyDigest, now)
    const expected = { ...binding, checkedAt: now().toISOString() }
    expect(verify(receipt, expected)).toBe(true)
    expect(verify({ ...receipt, decision: 'rejected' }, { ...expected, decision: 'rejected' })).toBe(false)
    expect(() => local.issuePrivacyReviewReceipt({ ...binding, approver: { subject: 'mallory', roles: ['privacy-approver'] } })).toThrowError(/登记/)
  })

  it('拒绝 stale、key substitution 和普通 Artifact signature', () => {
    const local = authority()
    const receipt = local.issuePrivacyReviewReceipt(binding)
    const other = authority()
    expect(createPrivacyReviewVerifier(other.privacyReviewVerifierMaterial,
      local.privacyReviewVerifierMaterial.publicKeyDigest, now)(receipt, { ...binding, checkedAt: now().toISOString() })).toBe(false)
    expect(local.verifyPrivacyReviewReceipt({ ...receipt,
      signature: local.signArtifactDigest(receipt.signedDigest).signature }, { ...binding, checkedAt: now().toISOString() })).toBe(false)
  })
})
