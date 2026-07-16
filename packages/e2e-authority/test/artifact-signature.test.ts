import { describe, expect, test } from 'vitest'
import type { ArtifactDocument } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('Artifact Authority 签名', () => {
  const authority = LocalApprovalAuthority.create({
    issuer: 'local-authority', keyId: 'artifact-key', now: () => new Date('2026-07-11T10:00:00.000Z'),
  })

  test('签名绑定 contentDigest，并可供 generation 审计直接验签', () => {
    const signature = authority.signArtifactDigest(digest('a'))
    const artifact = {
      artifactId: 'ARTIFACT-1', artifactType: 'prd-manifest', contentDigest: digest('a'),
      signatures: [signature],
    } as ArtifactDocument
    expect(authority.verifyArtifactSignature(signature)).toBe(true)
    expect(authority.verifyArtifact(artifact)).toBe(true)
    expect(authority.verifyArtifact({ ...artifact, contentDigest: digest('b') } as ArtifactDocument)).toBe(false)
    expect(authority.verifyArtifactSignature({ ...signature, signedDigest: digest('b') })).toBe(false)
  })
})
