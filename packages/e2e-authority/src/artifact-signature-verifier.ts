import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  ArtifactAuthorityVerifierMaterialSchema,
  ArtifactSignatureSchema,
  canonicalizeJson,
  digestBytes,
  type ArtifactAuthorityVerifierMaterial,
  type ArtifactSignature,
} from '@mutil-skills/e2e-contracts'

export function createArtifactSignatureVerifier(
  candidate: ArtifactAuthorityVerifierMaterial,
  expectedPublicKeyDigest: string,
): (signature: ArtifactSignature) => boolean {
  const material = ArtifactAuthorityVerifierMaterialSchema.safeParse(candidate)
  if (!material.success || material.data.publicKeyDigest !== expectedPublicKeyDigest) return () => false
  let publicKey: KeyObject
  try {
    const spki = Buffer.from(material.data.publicKeySpkiBase64, 'base64')
    if (spki.toString('base64') !== material.data.publicKeySpkiBase64
      || digestBytes('artifact-authority-public-key/v1', spki) !== expectedPublicKeyDigest) return () => false
    publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'ed25519') return () => false
  } catch { return () => false }
  return (candidateSignature) => {
    const signature = ArtifactSignatureSchema.safeParse(candidateSignature)
    if (!signature.success || signature.data.issuer !== material.data.issuer
      || signature.data.keyId !== material.data.keyId || signature.data.algorithm !== material.data.algorithm) return false
    try {
      return verify(null, Buffer.from(canonicalizeJson({
        purpose: material.data.purpose,
        issuer: signature.data.issuer,
        keyId: signature.data.keyId,
        signedDigest: signature.data.signedDigest,
      })), publicKey, Buffer.from(signature.data.signature, 'base64url'))
    } catch { return false }
  }
}
