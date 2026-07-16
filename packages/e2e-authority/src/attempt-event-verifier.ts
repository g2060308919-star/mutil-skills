import { createPublicKey, verify } from 'node:crypto'
import {
  ATTEMPT_EVENT_PROOF_PURPOSE,
  AttemptEventVerifierMaterialSchema,
  canonicalizeJson,
  digestBytes,
  type AttemptEventAuthorityProof,
  type AttemptEventVerifierMaterial,
} from '@mutil-skills/e2e-contracts'

export function createAttemptEventProofVerifier(candidate: AttemptEventVerifierMaterial):
(proof: AttemptEventAuthorityProof) => boolean {
  const material = AttemptEventVerifierMaterialSchema.parse(candidate)
  const der = Buffer.from(material.publicKeySpki, 'base64url')
  if (digestBytes('attempt-event-public-key/v1', der) !== material.publicKeyDigest) {
    throw new Error('E2E_ATTEMPT_VERIFIER_KEY_DIGEST_INVALID')
  }
  const key = createPublicKey({ key: der, type: 'spki', format: 'der' })
  return (proof) => {
    if (proof.purpose !== ATTEMPT_EVENT_PROOF_PURPOSE || proof.issuer !== material.issuer
      || proof.keyId !== material.keyId || proof.algorithm !== 'Ed25519'
      || !/^sha256:[a-f0-9]{64}$/.test(proof.signedDigest)) return false
    try {
      return verify(null, Buffer.from(canonicalizeJson({ purpose: proof.purpose, issuer: proof.issuer,
        keyId: proof.keyId, signedDigest: proof.signedDigest })), key, Buffer.from(proof.signature, 'base64url'))
    } catch { return false }
  }
}
