import { describe, expect, test } from 'vitest'
import {
  createPerformanceProof,
  nearestRankPercentile,
} from '../src/performance-proof.js'

describe('E2E performance proof', () => {
  test('uses deterministic nearest-rank percentiles', () => {
    expect(nearestRankPercentile([1, 2, 3, 4, 100], 50)).toBe(3)
    expect(nearestRankPercentile([1, 2, 3, 4, 100], 95)).toBe(100)
    expect(nearestRankPercentile([10, 1, 3, 2], 95)).toBe(10)
  })

  test('binds exact large fixture counts, phase samples, budgets, and proof digest', async () => {
    let tick = 0
    const proof = await createPerformanceProof({
      fixtureDigest: `sha256:${'a'.repeat(64)}`,
      fixtureCounts: { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 },
      samples: 10,
      phases: {
        compile: { budgetMs: 100, operation: () => { tick += 1 } },
        render: { budgetMs: 200, operation: () => { tick += 1 } },
      },
      clock: (() => {
        let now = 0
        return () => { now += 2; return now }
      })(),
      rss: () => 64 * 1024 * 1024,
      environment: {
        platform: 'test', arch: 'test', node: 'v24.0.0',
        cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3,
      },
    })
    expect(tick).toBe(20)
    expect(proof.fixtureCounts).toEqual({
      requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000,
    })
    expect(proof.phases.compile).toMatchObject({
      samples: 10, p50Ms: 2, p95Ms: 2, maxMs: 2,
      peakRssBytes: 64 * 1024 * 1024, budgetMs: 100, budgetPassed: true,
    })
    expect(proof.proofDigest).toMatch(/^sha256:/)
  })

  test('rejects undersampled or budget-failing proofs', async () => {
    await expect(createPerformanceProof({
      fixtureDigest: `sha256:${'b'.repeat(64)}`,
      fixtureCounts: { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 },
      samples: 9,
      phases: { compile: { budgetMs: 1, operation: () => undefined } },
    })).rejects.toMatchObject({ code: 'E2E_PERFORMANCE_SAMPLE_COUNT_INVALID' })

    await expect(createPerformanceProof({
      fixtureDigest: `sha256:${'c'.repeat(64)}`,
      fixtureCounts: { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 },
      samples: 10,
      phases: { compile: { budgetMs: 1, operation: () => undefined } },
      clock: (() => { let now = 0; return () => { now += 5; return now } })(),
    })).rejects.toMatchObject({ code: 'E2E_PERFORMANCE_BUDGET_EXCEEDED' })
  })
})
