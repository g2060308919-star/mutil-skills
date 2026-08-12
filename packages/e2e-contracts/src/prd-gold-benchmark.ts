import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const RateSchema = z.number().min(0).max(1)
const MetricSchema = z.object({
  requirementRecall: RateSchema, requirementPrecision: RateSchema,
  ruleRecall: RateSchema, rulePrecision: RateSchema,
  obligationRecall: RateSchema, obligationPrecision: RateSchema,
  negativeEdgeRecall: RateSchema, oracleCorrectness: RateSchema,
  classificationAccuracy: RateSchema, unsupportedHallucinationRate: RateSchema,
  unexplainedEmptyLinks: z.number().int().nonnegative(),
}).strict()

const ProofBodySchema = z.object({
  schemaVersion: z.literal('prd-gold-benchmark-proof/v1'),
  corpusDigest: DigestSchema,
  generatorContextDigest: DigestSchema,
  scorerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  adjudicationVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  repeatCount: z.number().int().positive().max(100),
  denominators: z.object({
    requirements: z.number().int().positive(), rules: z.number().int().positive(),
    obligations: z.number().int().positive(), negativeEdgeObligations: z.number().int().positive(),
    oracles: z.number().int().positive(), classifications: z.number().int().positive(),
  }).strict(),
  samples: z.array(z.object({ sample: z.number().int().nonnegative(), metrics: MetricSchema }).strict()).min(1).max(100),
  aggregate: z.object({ meanScore: RateSchema, worstScore: RateSchema,
    variance: z.number().nonnegative().max(1), irreproducibilityRate: RateSchema }).strict(),
  gate: z.object({ passed: z.boolean(), zeroToleranceViolations: z.array(z.string().min(1)).max(10_000),
    thresholdRule: z.string().min(1).max(4096) }).strict(),
  generatedAt: z.string().datetime(),
}).strict()

export type PrdGoldBenchmarkProofBodyV1 = z.infer<typeof ProofBodySchema>

export function computePrdGoldBenchmarkProofDigest(body: PrdGoldBenchmarkProofBodyV1): string {
  return digestText('prd-gold-benchmark-proof/v1', canonicalizeJson(body))
}

export const PrdGoldBenchmarkProofV1Schema = ProofBodySchema.extend({ proofDigest: DigestSchema })
  .strict().superRefine((proof, context) => {
    const { proofDigest, ...body } = proof
    if (proofDigest !== computePrdGoldBenchmarkProofDigest(body)) context.addIssue({
      code: 'custom', path: ['proofDigest'], message: 'Gold benchmark proof 摘要未绑定全部事实',
    })
    if (proof.samples.length !== proof.repeatCount
      || new Set(proof.samples.map((sample) => sample.sample)).size !== proof.samples.length) context.addIssue({
      code: 'custom', path: ['samples'], message: '样本必须完整覆盖 repeatCount 且序号唯一',
    })
    const scores = proof.samples.map((sample) => score(sample.metrics))
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length
    const worst = Math.min(...scores)
    const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length
    if (!close(proof.aggregate.meanScore, mean) || !close(proof.aggregate.worstScore, worst)
      || !close(proof.aggregate.variance, variance)) context.addIssue({
      code: 'custom', path: ['aggregate'], message: '聚合必须由全部样本重算，不能挑选最佳结果',
    })
    const zeroTolerance = proof.samples.flatMap((sample) => [
      ...(sample.metrics.unsupportedHallucinationRate === 0 ? [] : [`sample:${sample.sample}:hallucination`]),
      ...(sample.metrics.unexplainedEmptyLinks === 0 ? [] : [`sample:${sample.sample}:empty-link`]),
    ])
    if (canonicalizeJson(zeroTolerance) !== canonicalizeJson(proof.gate.zeroToleranceViolations)
      || proof.gate.passed !== (zeroTolerance.length === 0)) context.addIssue({
      code: 'custom', path: ['gate'], message: '安全不变量必须零容忍且驱动门禁结论',
    })
  })

function score(metric: z.infer<typeof MetricSchema>): number {
  const values = [metric.requirementRecall, metric.requirementPrecision, metric.ruleRecall,
    metric.rulePrecision, metric.obligationRecall, metric.obligationPrecision,
    metric.negativeEdgeRecall, metric.oracleCorrectness, metric.classificationAccuracy,
    1 - metric.unsupportedHallucinationRate]
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
function close(left: number, right: number): boolean { return Math.abs(left - right) <= 1e-12 }
