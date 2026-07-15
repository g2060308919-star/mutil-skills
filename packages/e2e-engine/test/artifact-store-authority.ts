import { canonicalizeJson, type ArtifactSignature } from '@mutil-skills/e2e-contracts'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import type { ArtifactStoreAuthority } from '../src/index.js'

export function createArtifactStoreAuthority(): ArtifactStoreAuthority {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    async auditStagedGeneration(input): Promise<void> {
      if (input.files.length === 0 || input.files.some((file) => file.byteLength < 0)) {
        throw new Error('测试 generation 审计失败')
      }
    },
    signDigest(signedDigest): ArtifactSignature {
      return {
        issuer: 'test-authority', keyId: 'test-key', algorithm: 'Ed25519', signedDigest,
        signature: sign(null, Buffer.from(canonicalizeJson({ signedDigest })), privateKey).toString('base64url'),
      }
    },
    verifySignature(signature): boolean {
      try {
        return signature.issuer === 'test-authority' && signature.keyId === 'test-key'
          && verify(null, Buffer.from(canonicalizeJson({ signedDigest: signature.signedDigest })),
            publicKey, Buffer.from(signature.signature, 'base64url'))
      } catch {
        return false
      }
    },
  }
}
