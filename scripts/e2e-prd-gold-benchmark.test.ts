import { describe, expect, test } from 'vitest'
import { prdGoldCorpus } from '../fixtures/e2e-prd-gold/corpus.js'
import { runPrdGoldBenchmark } from './e2e-prd-gold-benchmark.js'

describe('versioned PRD Gold corpus benchmark', () => {
  test('首批 corpus 覆盖 20 份人工语义样本和至少 100 个义务', () => {
    expect(prdGoldCorpus.entries).toHaveLength(20)
    expect(prdGoldCorpus.entries.reduce((sum, entry) => sum + entry.gold.obligations.length, 0))
      .toBeGreaterThanOrEqual(100)
    expect(new Set(prdGoldCorpus.entries.map((entry) => entry.category)).size).toBe(20)
  })

  test('固定候选输出机器可读、全样本且全绿的 proof', () => {
    const proof = runPrdGoldBenchmark('2026-08-12T00:00:00.000Z')
    expect(proof).toMatchObject({
      repeatCount: 1,
      denominators: { obligations: 100, negativeEdgeObligations: 40 },
      aggregate: { meanScore: 1, worstScore: 1, variance: 0, irreproducibilityRate: 0 },
      gate: { passed: true, zeroToleranceViolations: [], qualityViolations: [] },
    })
  })
})
