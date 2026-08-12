import { describe, expect, test } from 'vitest'
import { PrdGoldBenchmarkProofV1Schema, computePrdGoldBenchmarkProofDigest } from '../src/index.js'

const d = (value: string) => `sha256:${value.repeat(64)}`

describe('PRD Gold benchmark proof', () => {
  test('绑定固定 corpus、生成上下文、重复样本、分母、平均/最差/方差且拒绝挑最好结果', () => {
    const body = { schemaVersion: 'prd-gold-benchmark-proof/v1' as const,
      corpusDigest: d('1'), generatorContextDigest: d('2'), scorerVersion: '1.0.0',
      adjudicationVersion: '1.0.0', repeatCount: 3,
      denominators: { requirements: 10, rules: 12, obligations: 20, negativeEdgeObligations: 8, oracles: 20,
        classifications: 6 }, samples: [0, 1, 2].map((sample) => ({ sample,
        metrics: { requirementRecall: 1, requirementPrecision: 1, ruleRecall: 1, rulePrecision: 1,
          obligationRecall: 1, obligationPrecision: 1, negativeEdgeRecall: 1, oracleCorrectness: 1,
          classificationAccuracy: 1, unsupportedHallucinationRate: 0, unexplainedEmptyLinks: 0 } })),
      aggregate: { meanScore: 1, worstScore: 1, variance: 0, irreproducibilityRate: 0 },
      gate: { passed: true, zeroToleranceViolations: [], qualityViolations: [], minimumSampleScore: 1,
        thresholdRule: 'baseline-v1' },
      generatedAt: '2026-08-12T00:00:00.000Z' }
    const proof = { ...body, proofDigest: computePrdGoldBenchmarkProofDigest(body) }
    expect(PrdGoldBenchmarkProofV1Schema.safeParse(proof).success).toBe(true)
    expect(PrdGoldBenchmarkProofV1Schema.safeParse({ ...proof,
      aggregate: { ...proof.aggregate, worstScore: 0.9 } }).success).toBe(false)
  })
})
