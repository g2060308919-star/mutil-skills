import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  ApprovalFreshnessReceiptSchema,
  ApprovalFreshnessVerifierMaterialSchema,
  canonicalizeJson,
  digestBytes,
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerifierMaterial,
} from '@mutil-skills/e2e-contracts'

export function createApprovalFreshnessVerifier(
  candidate: ApprovalFreshnessVerifierMaterial,
  expectedPublicKeyDigest: string,
): (receipt: ApprovalFreshnessReceipt) => boolean {
  const material = ApprovalFreshnessVerifierMaterialSchema.safeParse(candidate)
  if (!material.success || material.data.publicKeyDigest !== expectedPublicKeyDigest) return () => false
  let publicKey: KeyObject
  try {
    const spki = Buffer.from(material.data.publicKeySpkiBase64, 'base64')
    if (spki.toString('base64') !== material.data.publicKeySpkiBase64
      || digestBytes('approval-freshness-public-key/v1', spki) !== expectedPublicKeyDigest) return () => false
    publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'ed25519') return () => false
  } catch { return () => false }
  return (candidateReceipt) => {
    const receipt = ApprovalFreshnessReceiptSchema.safeParse(candidateReceipt)
    if (!receipt.success) return false
    const proof = receipt.data.authorityProof
    if (proof.purpose !== material.data.purpose || proof.issuer !== material.data.issuer
      || proof.keyId !== material.data.keyId || proof.algorithm !== material.data.algorithm) return false
    try {
      return verify(null, Buffer.from(canonicalizeJson({
        purpose: proof.purpose, issuer: proof.issuer, keyId: proof.keyId, signedDigest: proof.signedDigest,
      })), publicKey, Buffer.from(proof.signature, 'base64url'))
    } catch { return false }
  }
}
