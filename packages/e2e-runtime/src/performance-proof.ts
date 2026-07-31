import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { performance } from 'node:perf_hooks'
import { arch, cpus, platform, totalmem } from 'node:os'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const PHASE = /^[a-z][a-z0-9-]{0,63}$/

export interface PerformanceProof {
  schemaVersion: '1.0.0'
  fixtureDigest: string
  fixtureCounts: {
    requirements: 500
    rules: 2000
    obligations: 5000
    cases: 1000
  }
  environment: {
    platform: string
    arch: string
    node: string
    cpuCount: number
    totalMemoryBytes: number
  }
  phases: Record<string, {
    samples: number
    p50Ms: number
    p95Ms: number
    maxMs: number
    peakRssBytes: number
    budgetMs: number
    budgetPassed: true
  }>
  proofDigest: string
}

export interface CreatePerformanceProofInput {
  fixtureDigest: string
  fixtureCounts: PerformanceProof['fixtureCounts']
  samples: number
  phases: Record<string, {
    budgetMs: number
    operation: () => void | Promise<void>
  }>
  clock?: () => number
  rss?: () => number
  environment?: PerformanceProof['environment']
}

export async function createPerformanceProof(
  input: CreatePerformanceProofInput,
): Promise<PerformanceProof> {
  if (!DIGEST.test(input.fixtureDigest) || input.samples < 10 || input.samples > 1_000) {
    throw proofError('E2E_PERFORMANCE_SAMPLE_COUNT_INVALID', '性能证明至少需要 10 个有效样本')
  }
  if (canonicalizeJson(input.fixtureCounts) !== canonicalizeJson({
    requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000,
  })) {
    throw proofError('E2E_PERFORMANCE_FIXTURE_COUNTS_INVALID', '规模 fixture 数量与批准基线不一致')
  }
  const phaseEntries = Object.entries(input.phases)
  if (phaseEntries.length === 0 || phaseEntries.some(([name, phase]) =>
    !PHASE.test(name) || !Number.isFinite(phase.budgetMs) || phase.budgetMs <= 0)) {
    throw proofError('E2E_PERFORMANCE_PHASE_INVALID', '性能阶段或预算无效')
  }
  const clock = input.clock ?? (() => performance.now())
  const rss = input.rss ?? (() => process.memoryUsage().rss)
  const phases: PerformanceProof['phases'] = {}
  for (const [name, phase] of phaseEntries) {
    const durations: number[] = []
    let peakRssBytes = 0
    for (let sample = 0; sample < input.samples; sample += 1) {
      const startedAt = clock()
      await phase.operation()
      const duration = clock() - startedAt
      const currentRss = rss()
      if (!Number.isFinite(duration) || duration < 0 || !Number.isSafeInteger(currentRss) || currentRss < 0) {
        throw proofError('E2E_PERFORMANCE_MEASUREMENT_INVALID', '性能测量返回无效值')
      }
      durations.push(duration)
      peakRssBytes = Math.max(peakRssBytes, currentRss)
    }
    const p50Ms = nearestRankPercentile(durations, 50)
    const p95Ms = nearestRankPercentile(durations, 95)
    if (p95Ms > phase.budgetMs) throw proofError(
      'E2E_PERFORMANCE_BUDGET_EXCEEDED',
      `${name} p95 ${p95Ms}ms 超过预算 ${phase.budgetMs}ms`,
    )
    phases[name] = {
      samples: durations.length,
      p50Ms,
      p95Ms,
      maxMs: Math.max(...durations),
      peakRssBytes,
      budgetMs: phase.budgetMs,
      budgetPassed: true,
    }
  }
  const draft = {
    schemaVersion: '1.0.0' as const,
    fixtureDigest: input.fixtureDigest,
    fixtureCounts: input.fixtureCounts,
    environment: input.environment ?? {
      platform: platform(),
      arch: arch(),
      node: process.version,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    phases,
  }
  return {
    ...draft,
    proofDigest: digestText('e2e-performance-proof/v1', canonicalizeJson(draft)),
  }
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0 || !Number.isFinite(percentile) || percentile <= 0 || percentile > 100
    || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw proofError('E2E_PERFORMANCE_PERCENTILE_INPUT_INVALID', '百分位输入无效')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(percentile / 100 * sorted.length)
  return sorted[Math.max(0, rank - 1)]!
}

function proofError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'automation', message, retryable: false })
}
