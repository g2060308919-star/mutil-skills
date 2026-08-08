import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PRODUCTION_BENCHMARK_PHASES } from '../packages/e2e-runtime/src/production-performance-proof.js'
import { createProductionBenchmarkWorkload } from './e2e-production-benchmark-workload.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('production E2E benchmark workload', () => {
  test('以固定规模真实调用八个生产模块，而不是数组/string 合成替身', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-production-benchmark-test-'))
    roots.push(root)
    const workload = await createProductionBenchmarkWorkload({ artifactRoot: root })

    expect(workload.fixtureCounts).toEqual({
      requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000,
    })
    expect(workload.fixtureDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    for (const [ordinal, phase] of PRODUCTION_BENCHMARK_PHASES.entries()) {
      const result = await workload.run(phase, ordinal)
      expect(result.outputBytes, phase).toBeGreaterThan(0)
      expect(result.facts, phase).toMatchObject({
        requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000,
      })
    }
    await workload.close()
  }, 30_000)
})
