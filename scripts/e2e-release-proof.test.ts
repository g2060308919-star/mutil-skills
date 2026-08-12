import { describe, expect, test } from 'vitest'
import * as proofModule from './e2e-release-proof.mjs'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('buildReleaseProof', () => {
  test('完整发布事实产生可复验的 gateEligible proof', () => {
    const build = (proofModule as Record<string, unknown>).buildReleaseProof as (input: unknown) => any
    expect(build).toBeTypeOf('function')
    const proof = build(input())
    expect(proof.conclusion).toEqual({ gateEligible: true, reasonCodes: [] })
    expect(proof.proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('缺失 tarball、存在 skip 或 Host 未证明时 fail closed', () => {
    const build = (proofModule as Record<string, unknown>).buildReleaseProof as (input: unknown) => any
    expect(build).toBeTypeOf('function')
    expect(build({ ...input(), tarballs: [] }).conclusion.gateEligible).toBe(false)
    expect(build({ ...input(), skippedTests: 1 }).conclusion.reasonCodes).toContain('E2E_RELEASE_GOLDEN_SKIPPED')
    expect(build({ ...input(), hostProof: { proofDigest: digest('c'), gateEligible: false } })
      .conclusion.reasonCodes).toContain('E2E_RELEASE_HOST_UNVERIFIED')
  })
})

function input() {
  return {
    mode: 'pack', revision: 'abc123', worktreeClean: true,
    phases: [{ phase: 'environment/build', status: 'passed', startedAt: '2026-08-12T00:00:00.000Z',
      finishedAt: '2026-08-12T00:00:01.000Z', evidenceDigest: digest('a') }],
    tarballs: [{ packageName: '@mutil-skills/e2e-runtime', version: '0.8.0', fileName: 'runtime.tgz', digest: digest('b') }],
    packageClosure: ['@mutil-skills/e2e-runtime'], golden: { workspace: 'passed', registry: 'not-applicable' },
    skippedTests: 0, hostProof: { proofDigest: digest('c'), gateEligible: true },
    startedAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:00:02.000Z',
  }
}
