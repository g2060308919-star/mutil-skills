import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { nearestRankPercentile } from './performance-proof.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/

export const PRODUCTION_BENCHMARK_PHASES = [
  'compiler',
  'requirement-graph',
  'coverage-audit',
  'case-schedule',
  'checkpoint-finalization',
  'engine-verdict',
  'report-render',
  'artifact-publication',
] as const

export type ProductionBenchmarkPhase = typeof PRODUCTION_BENCHMARK_PHASES[number]

export interface ProductionBenchmarkRunner {
  runnerId: string
  stableResources: boolean
  platform: string
  arch: string
  node: string
  cpuModel: string
  cpuCount: number
  totalMemoryBytes: number
}

export type ProductionBenchmarkSample = {
  ok: true
  durationMs: number
  peakRssBytes: number
  outputBytes: number
} | {
  ok: false
  durationMs: number
  peakRssBytes: number
  outputBytes: number
  reasonCode: string
}

interface Distribution {
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}

export interface ProductionPerformanceProof {
  schemaVersion: '2.0.0'
  fixtureDigest: string
  fixtureCounts: { requirements: 500; rules: 2000; obligations: 5000; cases: 1000 }
  warmupSamples: number
  sampleCount: number
  runner: ProductionBenchmarkRunner
  phases: Record<ProductionBenchmarkPhase, {
    samples: number
    successfulSamples: number
    failures: number
    failureRate: number
    failureReasonCodes: string[]
    p50Ms: number | null
    p95Ms: number | null
    p99Ms: number | null
    maxMs: number | null
    peakRssBytes: number
    outputBytes: Distribution
    budgetMs: number
    budgetPassed: boolean
  }>
  passed: boolean
  gateEligible: boolean
  proofDigest: string
}

export interface CreateProductionPerformanceProofInput {
  fixtureDigest: string
  fixtureCounts: ProductionPerformanceProof['fixtureCounts']
  warmupSamples: number
  sampleCount: number
  runner: ProductionBenchmarkRunner
  phases: Record<string, {
    budgetMs: number
    samples: ProductionBenchmarkSample[]
  }>
}

export function createProductionPerformanceProof(
  input: CreateProductionPerformanceProofInput,
): ProductionPerformanceProof {
  validateInput(input)
  const phases = {} as ProductionPerformanceProof['phases']
  for (const name of PRODUCTION_BENCHMARK_PHASES) {
    const phase = input.phases[name]!
    const successful = phase.samples.filter((sample): sample is Extract<ProductionBenchmarkSample, { ok: true }> =>
      sample.ok)
    const durations = successful.map((sample) => sample.durationMs)
    const outputBytes = successful.map((sample) => sample.outputBytes)
    const failures = phase.samples.length - successful.length
    const p95Ms = percentileOrNull(durations, 95)
    phases[name] = {
      samples: phase.samples.length,
      successfulSamples: successful.length,
      failures,
      failureRate: round(failures / phase.samples.length * 100),
      failureReasonCodes: [...new Set(phase.samples
        .filter((sample): sample is Extract<ProductionBenchmarkSample, { ok: false }> => !sample.ok)
        .map((sample) => sample.reasonCode))].sort(),
      p50Ms: percentileOrNull(durations, 50),
      p95Ms,
      p99Ms: percentileOrNull(durations, 99),
      maxMs: durations.length === 0 ? null : Math.max(...durations),
      peakRssBytes: Math.max(...phase.samples.map((sample) => sample.peakRssBytes)),
      outputBytes: distribution(outputBytes),
      budgetMs: phase.budgetMs,
      budgetPassed: p95Ms !== null && p95Ms <= phase.budgetMs,
    }
  }
  const passed = PRODUCTION_BENCHMARK_PHASES.every((name) =>
    phases[name].failures === 0 && phases[name].budgetPassed)
  const draft = {
    schemaVersion: '2.0.0' as const,
    fixtureDigest: input.fixtureDigest,
    fixtureCounts: input.fixtureCounts,
    warmupSamples: input.warmupSamples,
    sampleCount: input.sampleCount,
    runner: input.runner,
    phases,
    passed,
    gateEligible: input.runner.stableResources,
  }
  return {
    ...draft,
    proofDigest: digestText('e2e-production-performance-proof/v2', canonicalizeJson(draft)),
  }
}

function validateInput(input: CreateProductionPerformanceProofInput): void {
  if (!DIGEST.test(input.fixtureDigest)
    || canonicalizeJson(input.fixtureCounts) !== canonicalizeJson({
      requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000,
    })) {
    throw performanceError('E2E_PRODUCTION_BENCHMARK_FIXTURE_INVALID')
  }
  if (!Number.isInteger(input.warmupSamples) || input.warmupSamples < 3
    || input.sampleCount < 20 || input.sampleCount > 1_000) {
    throw performanceError('E2E_PRODUCTION_BENCHMARK_SAMPLE_COUNT_INVALID')
  }
  const runner = input.runner
  if (runner.runnerId.trim() === '' || runner.platform.trim() === '' || runner.arch.trim() === ''
    || runner.node.trim() === '' || runner.cpuModel.trim() === ''
    || !Number.isSafeInteger(runner.cpuCount) || runner.cpuCount < 1
    || !Number.isSafeInteger(runner.totalMemoryBytes) || runner.totalMemoryBytes < 1) {
    throw performanceError('E2E_PRODUCTION_BENCHMARK_RUNNER_INVALID')
  }
  const phaseNames = Object.keys(input.phases)
  if (canonicalizeJson(phaseNames.sort()) !== canonicalizeJson([...PRODUCTION_BENCHMARK_PHASES].sort())) {
    throw performanceError('E2E_PRODUCTION_BENCHMARK_PHASE_SET_INVALID')
  }
  for (const name of PRODUCTION_BENCHMARK_PHASES) {
    const phase = input.phases[name]!
    if (!Number.isFinite(phase.budgetMs) || phase.budgetMs <= 0
      || phase.samples.length !== input.sampleCount
      || phase.samples.some((sample) => !validSample(sample))) {
      throw performanceError('E2E_PRODUCTION_BENCHMARK_SAMPLE_INVALID')
    }
  }
}

function validSample(sample: ProductionBenchmarkSample): boolean {
  return Number.isFinite(sample.durationMs) && sample.durationMs >= 0
    && Number.isSafeInteger(sample.peakRssBytes) && sample.peakRssBytes >= 0
    && Number.isSafeInteger(sample.outputBytes) && sample.outputBytes >= 0
    && (sample.ok || /^[A-Z][A-Z0-9_]{2,127}$/.test(sample.reasonCode))
}

function distribution(values: number[]): Distribution {
  return {
    p50: percentileOrNull(values, 50),
    p95: percentileOrNull(values, 95),
    p99: percentileOrNull(values, 99),
    max: values.length === 0 ? null : Math.max(...values),
  }
}

function percentileOrNull(values: number[], percentile: number): number | null {
  return values.length === 0 ? null : round(nearestRankPercentile(values, percentile))
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function performanceError(code: string): E2EError {
  return new E2EError({ code, category: 'automation', retryable: false, message: code })
}
