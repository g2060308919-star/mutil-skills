import { describe, expect, test } from 'vitest'
import { E2EReleaseProofV1Schema, computeE2EReleaseProofDigest } from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('E2EReleaseProofV1', () => {
  test('拒绝把 skipped Golden 或非 gateEligible Host 证明包装成正式发布证明', () => {
    expect(E2EReleaseProofV1Schema.safeParse(proof({ skippedTests: 1 })).success).toBe(false)
    expect(E2EReleaseProofV1Schema.safeParse(proof({ hostGateEligible: false })).success).toBe(false)
  })

  test('拒绝篡改 tarball digest 或 release proof digest', () => {
    expect(E2EReleaseProofV1Schema.safeParse(proof({ proofDigest: digest('f') })).success).toBe(false)
  })
})

function proof(options: { skippedTests?: number; hostGateEligible?: boolean; proofDigest?: string } = {}) {
  const body = {
    schemaVersion: 'e2e-release-proof/v1' as const, mode: 'pack' as const, revision: 'abc123', worktreeClean: true,
    phases: [{ phase: 'environment/build', status: 'passed' as const, startedAt: '2026-08-12T00:00:00.000Z',
      finishedAt: '2026-08-12T00:00:01.000Z', evidenceDigest: digest('a') }],
    tarballs: [{ packageName: '@mutil-skills/e2e-runtime', version: '0.8.0', fileName: 'runtime.tgz',
      digest: digest('b') }],
    packageClosure: ['@mutil-skills/e2e-runtime'],
    golden: { workspace: 'passed' as const, registry: 'not-applicable' as const },
    skippedTests: options.skippedTests ?? 0,
    hostProof: { proofDigest: digest('c'), gateEligible: options.hostGateEligible ?? true },
    startedAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:00:02.000Z',
    conclusion: { gateEligible: true, reasonCodes: [] },
  }
  return { ...body, proofDigest: options.proofDigest ?? computeE2EReleaseProofDigest(body) }
}
