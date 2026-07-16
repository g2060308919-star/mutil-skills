import { describe, expect, test } from 'vitest'
import {
  ArtifactEnvelopeSchema,
  E2EError,
  canonicalizeJson,
  digestArtifactContent,
  digestBytes,
  digestRecords,
  digestText,
} from '../src/index.js'

const digest = `sha256:${'a'.repeat(64)}`

describe('canonical E2E artifact primitives', () => {
  test('canonicalizes object keys while preserving array order', () => {
    expect(canonicalizeJson({ z: 1, nested: { b: true, a: '值' }, items: [3, 1, 2] })).toBe(
      '{"items":[3,1,2],"nested":{"a":"值","b":true},"z":1}',
    )
  })

  test('rejects values that are not valid deterministic JSON', () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrowError(E2EError)
    expect(() => canonicalizeJson({ value: undefined })).toThrowError(E2EError)
  })

  test('normalizes Unicode and line endings before hashing text', () => {
    expect(digestText('normalized-prd', 'Cafe\u0301\r\n第二行\r')).toBe(
      digestText('normalized-prd', 'Café\n第二行\n'),
    )
  })

  test('binds byte digests to their domain and length', () => {
    const content = new TextEncoder().encode('same bytes')

    expect(digestBytes('prd', content)).not.toBe(digestBytes('attachment', content))
    expect(digestBytes('prd', content)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('composes records without ambiguous field boundaries', () => {
    const left = digestRecords([
      { domain: 'a', digest: digestText('a', 'bc'), length: 2 },
      { domain: 'd', digest: digestText('d', 'e'), length: 1 },
    ])
    const right = digestRecords([
      { domain: 'ab', digest: digestText('ab', 'c'), length: 1 },
      { domain: 'd', digest: digestText('d', 'e'), length: 1 },
    ])

    expect(left).not.toBe(right)
  })

  test('excludes self digest and signatures from artifact content hashing', () => {
    const artifact = {
      artifactId: 'ARTIFACT-1',
      contentDigest: digestText('old', 'value'),
      signatures: [{ signature: 'old-signature' }],
      payload: { value: 1 },
    }

    expect(digestArtifactContent('project-policy/v1', artifact)).toBe(
      digestArtifactContent('project-policy/v1', {
        ...artifact,
        contentDigest: digestText('new', 'value'),
        signatures: [{ signature: 'new-signature' }],
      }),
    )
  })
})

describe('ArtifactEnvelopeSchema', () => {
  const validEnvelope = {
    artifactId: 'ARTIFACT-1',
    artifactType: 'project-policy',
    schemaVersion: '1.0.0',
    engineVersion: '0.1.0',
    assetId: 'PRODUCT/PRD-1',
    prdRevision: digest,
    generationId: 'GENERATION-1',
    createdAt: '2026-07-11T10:00:00.000Z',
    contentDigest: digest,
    signatures: [],
    dependencies: [],
  }

  test('accepts a strict valid envelope', () => {
    expect(ArtifactEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope)
  })

  test('rejects unknown fields and malformed digests', () => {
    expect(() => ArtifactEnvelopeSchema.parse({ ...validEnvelope, unexpected: true })).toThrow()
    expect(() => ArtifactEnvelopeSchema.parse({ ...validEnvelope, contentDigest: 'abc' })).toThrow()
  })
})

describe('E2EError', () => {
  test('preserves a stable code, category, retryability, and references', () => {
    const error = new E2EError({
      code: 'E2E_ARTIFACT_INVALID',
      category: 'artifact',
      message: 'Artifact 无效',
      retryable: false,
      refs: ['ARTIFACT-1'],
    })

    expect(error).toMatchObject({
      name: 'E2EError',
      code: 'E2E_ARTIFACT_INVALID',
      category: 'artifact',
      retryable: false,
      refs: ['ARTIFACT-1'],
    })
  })
})
