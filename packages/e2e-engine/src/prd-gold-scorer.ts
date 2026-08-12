import { z } from 'zod'
import {
  PrdGoldBenchmarkProofV1Schema,
  canonicalizeJson,
  computePrdGoldBenchmarkProofDigest,
  digestText,
  type PrdGoldBenchmarkProofBodyV1,
} from '@mutil-skills/e2e-contracts'

const SafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
const SemanticIdsSchema = z.array(SafeIdSchema).max(100_000).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({
    code: 'custom', message: '语义标识必须唯一',
  })
})
const ClassificationSchema = z.object({
  semanticId: SafeIdSchema,
  disposition: z.enum(['ambiguous', 'excluded', 'not-applicable', 'manual', 'unsupported']),
}).strict()
const CandidateBodySchema = z.object({
  requirements: SemanticIdsSchema,
  rules: SemanticIdsSchema,
  obligations: SemanticIdsSchema,
  negativeEdgeObligations: SemanticIdsSchema,
  oracles: SemanticIdsSchema,
  classifications: z.array(ClassificationSchema).max(100_000),
  cases: SemanticIdsSchema,
  dataNeeds: SemanticIdsSchema,
  cleanup: SemanticIdsSchema,
  emptyLinkIds: SemanticIdsSchema.optional(),
}).strict()
const CandidateSchema = CandidateBodySchema.superRefine((candidate, context) => {
  const obligations = new Set(candidate.obligations)
  for (const [index, id] of candidate.negativeEdgeObligations.entries()) {
    if (!obligations.has(id)) context.addIssue({
      code: 'custom', path: ['negativeEdgeObligations', index],
      message: '负向/边界义务必须同时存在于 obligations',
    })
  }
})
const GoldSchema = CandidateBodySchema.omit({ emptyLinkIds: true }).superRefine((candidate, context) => {
  const obligations = new Set(candidate.obligations)
  for (const [index, id] of candidate.negativeEdgeObligations.entries()) {
    if (!obligations.has(id)) context.addIssue({
      code: 'custom', path: ['negativeEdgeObligations', index],
      message: '负向/边界义务必须同时存在于 obligations',
    })
  }
})

export const PrdGoldCorpusSchema = z.object({
  schemaVersion: z.literal('prd-gold-corpus/v1'),
  corpusVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  adjudicationVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  entries: z.array(z.object({
    entryId: SafeIdSchema,
    category: SafeIdSchema,
    prd: z.string().min(1).max(100_000),
    sourceSpans: z.array(z.object({
      clauseId: SafeIdSchema,
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    }).strict()).min(1).max(10_000),
    actors: SemanticIdsSchema,
    preconditions: z.array(z.string().min(1).max(10_000)).max(10_000),
    adjudications: z.array(z.object({
      semanticId: SafeIdSchema,
      kind: z.enum(['requirement', 'rule', 'obligation', 'case', 'oracle', 'data-need', 'cleanup',
        'classification']),
      statement: z.string().min(1).max(10_000),
    }).strict()).min(1).max(100_000),
    gold: GoldSchema,
    samples: z.array(z.object({
      sample: z.number().int().nonnegative(),
      candidate: CandidateSchema,
    }).strict()).min(1).max(100),
  }).strict()).min(1).max(1000),
}).strict().superRefine((corpus, context) => {
  const entryIds = corpus.entries.map((entry) => entry.entryId)
  if (new Set(entryIds).size !== entryIds.length) context.addIssue({
    code: 'custom', path: ['entries'], message: 'Gold entryId 必须唯一',
  })
  const reference = corpus.entries[0]?.samples.map((sample) => sample.sample).sort((a, b) => a - b)
  for (const [index, entry] of corpus.entries.entries()) {
    const samples = entry.samples.map((sample) => sample.sample).sort((a, b) => a - b)
    if (canonicalizeJson(samples) !== canonicalizeJson(reference)) context.addIssue({
      code: 'custom', path: ['entries', index, 'samples'], message: '所有 Gold 条目必须包含相同重复样本序号',
    })
    const adjudicated = new Set(entry.adjudications.map((item) => item.semanticId))
    const expected = [...entry.gold.requirements, ...entry.gold.rules, ...entry.gold.obligations,
      ...entry.gold.oracles, ...entry.gold.cases, ...entry.gold.dataNeeds, ...entry.gold.cleanup,
      ...entry.gold.classifications.map((item) => item.semanticId)]
    for (const semanticId of expected) if (!adjudicated.has(semanticId)) context.addIssue({
      code: 'custom', path: ['entries', index, 'adjudications'],
      message: `Gold 语义缺少人工裁决说明: ${semanticId}`,
    })
  }
})

export type PrdGoldCorpus = z.input<typeof PrdGoldCorpusSchema>

export function scorePrdGoldBenchmark(
  rawCorpus: PrdGoldCorpus,
  options: { generatorContextDigest: string; scorerVersion: string; generatedAt: string },
): z.infer<typeof PrdGoldBenchmarkProofV1Schema> {
  const corpus = PrdGoldCorpusSchema.parse(rawCorpus)
  const sampleNumbers = corpus.entries[0]!.samples.map((sample) => sample.sample).sort((a, b) => a - b)
  const samples = sampleNumbers.map((sample) => {
    const pairs = corpus.entries.map((entry) => ({
      gold: entry.gold,
      candidate: entry.samples.find((item) => item.sample === sample)!.candidate,
    }))
    return { sample, metrics: scoreSample(pairs) }
  })
  const scores = samples.map(({ metrics }) => overallScore(metrics))
  const meanScore = mean(scores)
  const fingerprints = samples.map(({ sample }) => digestText('prd-gold-sample/v1', canonicalizeJson(
    corpus.entries.map((entry) => entry.samples.find((item) => item.sample === sample)!.candidate),
  )))
  const zeroToleranceViolations = samples.flatMap(({ sample, metrics }) => [
    ...(metrics.unsupportedHallucinationRate === 0 ? [] : [`sample:${sample}:hallucination`]),
    ...(metrics.unexplainedEmptyLinks === 0 ? [] : [`sample:${sample}:empty-link`]),
  ])
  const minimumSampleScore = 1
  const qualityViolations = samples.flatMap(({ sample, metrics }) => overallScore(metrics) >= minimumSampleScore
    ? [] : [`sample:${sample}:score-below-minimum`])
  const denominators = {
    requirements: count(corpus, 'requirements'),
    rules: count(corpus, 'rules'),
    obligations: count(corpus, 'obligations'),
    negativeEdgeObligations: count(corpus, 'negativeEdgeObligations'),
    oracles: count(corpus, 'oracles'),
    classifications: corpus.entries.reduce((sum, entry) => sum + entry.gold.classifications.length, 0),
  }
  const body: PrdGoldBenchmarkProofBodyV1 = {
    schemaVersion: 'prd-gold-benchmark-proof/v1',
    corpusDigest: digestText('prd-gold-corpus/v1', canonicalizeJson(corpus)),
    generatorContextDigest: options.generatorContextDigest,
    scorerVersion: options.scorerVersion,
    adjudicationVersion: corpus.adjudicationVersion,
    repeatCount: sampleNumbers.length,
    denominators,
    samples,
    aggregate: {
      meanScore,
      worstScore: Math.min(...scores),
      variance: mean(scores.map((score) => (score - meanScore) ** 2)),
      irreproducibilityRate: fingerprints.filter((value) => value !== fingerprints[0]).length / fingerprints.length,
    },
    gate: {
      passed: zeroToleranceViolations.length === 0 && qualityViolations.length === 0,
      zeroToleranceViolations,
      qualityViolations,
      minimumSampleScore,
      thresholdRule: 'reference-corpus-v1: safety violations = 0; every checked-in reference sample score = 1',
    },
    generatedAt: options.generatedAt,
  }
  return PrdGoldBenchmarkProofV1Schema.parse({
    ...body,
    proofDigest: computePrdGoldBenchmarkProofDigest(body),
  })
}

type Gold = z.infer<typeof GoldSchema>
type Candidate = z.infer<typeof CandidateSchema>
type Metrics = z.infer<typeof PrdGoldBenchmarkProofV1Schema>['samples'][number]['metrics']

function scoreSample(pairs: Array<{ gold: Gold; candidate: Candidate }>): Metrics {
  const requirements = setScore(pairs, 'requirements')
  const rules = setScore(pairs, 'rules')
  const obligations = setScore(pairs, 'obligations')
  const negative = setScore(pairs, 'negativeEdgeObligations')
  const oracles = setScore(pairs, 'oracles')
  const expectedClassifications = pairs.flatMap(({ gold }) => gold.classifications)
  const actualClassifications = pairs.flatMap(({ candidate }) => candidate.classifications)
  const expectedClassificationKeys = new Set(expectedClassifications.map(classificationKey))
  const correctClassifications = actualClassifications.filter((value) =>
    expectedClassificationKeys.has(classificationKey(value))).length
  const unsupportedPredictions = pairs.reduce((sum, pair) => sum
    + extraCount(pair.gold.requirements, pair.candidate.requirements)
    + extraCount(pair.gold.rules, pair.candidate.rules)
    + extraCount(pair.gold.obligations, pair.candidate.obligations)
    + extraCount(pair.gold.oracles, pair.candidate.oracles), 0)
  const predictedSemantics = pairs.reduce((sum, pair) => sum + pair.candidate.requirements.length
    + pair.candidate.rules.length + pair.candidate.obligations.length + pair.candidate.oracles.length, 0)
  return {
    requirementRecall: requirements.recall,
    requirementPrecision: requirements.precision,
    ruleRecall: rules.recall,
    rulePrecision: rules.precision,
    obligationRecall: obligations.recall,
    obligationPrecision: obligations.precision,
    negativeEdgeRecall: negative.recall,
    oracleCorrectness: oracles.recall,
    classificationAccuracy: rate(correctClassifications, expectedClassifications.length),
    unsupportedHallucinationRate: rate(unsupportedPredictions, predictedSemantics),
    unexplainedEmptyLinks: pairs.reduce((sum, pair) => sum + (pair.candidate.emptyLinkIds?.length ?? 0), 0),
  }
}

function setScore(pairs: Array<{ gold: Gold; candidate: Candidate }>, field: keyof Pick<Gold,
  'requirements' | 'rules' | 'obligations' | 'negativeEdgeObligations' | 'oracles'>): {
    recall: number; precision: number
  } {
  let expected = 0; let actual = 0; let correct = 0
  for (const pair of pairs) {
    const gold = new Set(pair.gold[field])
    expected += gold.size
    actual += pair.candidate[field].length
    correct += pair.candidate[field].filter((id) => gold.has(id)).length
  }
  return { recall: rate(correct, expected), precision: rate(correct, actual) }
}

function classificationKey(value: z.infer<typeof ClassificationSchema>): string {
  return `${value.semanticId}\u0000${value.disposition}`
}
function extraCount(expected: string[], actual: string[]): number {
  const expectedSet = new Set(expected)
  return actual.filter((value) => !expectedSet.has(value)).length
}
function count(corpus: z.output<typeof PrdGoldCorpusSchema>, field: keyof Pick<Gold,
  'requirements' | 'rules' | 'obligations' | 'negativeEdgeObligations' | 'oracles'>): number {
  return corpus.entries.reduce((sum, entry) => sum + entry.gold[field].length, 0)
}
function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}
function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
function overallScore(metric: Metrics): number {
  const values = [metric.requirementRecall, metric.requirementPrecision, metric.ruleRecall,
    metric.rulePrecision, metric.obligationRecall, metric.obligationPrecision,
    metric.negativeEdgeRecall, metric.oracleCorrectness, metric.classificationAccuracy,
    1 - metric.unsupportedHallucinationRate]
  return mean(values)
}
