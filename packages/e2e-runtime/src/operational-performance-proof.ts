import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { nearestRankPercentile } from './performance-proof.js'

export const OPERATIONAL_PERFORMANCE_PHASES = [
  'runtime-module-cold-start', 'tuf-update-cold', 'tuf-update-warm',
  'concurrent-run-resolution', 'diagnostic-classification', 'artifact-retention-lifecycle',
] as const
export type OperationalPerformancePhase = typeof OPERATIONAL_PERFORMANCE_PHASES[number]

export interface OperationalPerformanceProof {
  schemaVersion: '1.0.0'
  runner: { runnerId: string; stableResources: boolean; platform: string; arch: string; node: string
    cpuModel: string; cpuCount: number; totalMemoryBytes: number; baselineDigest: string }
  sampleCount: number
  phases: Record<OperationalPerformancePhase, {
    samples: number; failures: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null
    budgetMs: number; budgetPassed: boolean; baselineDeltaPercent: number
    reasonCodes: string[]; sampleDigest: string
  }>
  flakyRate: number
  diagnosticRate: number
  artifactRetentionVerified: boolean
  passed: boolean
  gateEligible: boolean
  gateIneligibleReasons: string[]
  proofDigest: string
}

export function createOperationalPerformanceProof(input: {
  runner: OperationalPerformanceProof['runner']
  sampleCount: number
  phases: Record<string, { budgetMs: number; samples: Array<{
    ok: boolean; durationMs: number; reasonCode?: string
  }> }>
  flakyRate: number
  diagnosticRate: number
  artifactRetentionVerified: boolean
}): OperationalPerformanceProof {
  if (!Number.isInteger(input.sampleCount) || input.sampleCount < 20
    || Object.keys(input.phases).sort().join(',') !== [...OPERATIONAL_PERFORMANCE_PHASES].sort().join(',')) {
    throw proofError('E2E_OPERATIONAL_PROOF_INPUT_INVALID')
  }
  if (!input.runner.runnerId || !input.runner.platform || !input.runner.arch || !input.runner.node
    || !input.runner.cpuModel || !Number.isInteger(input.runner.cpuCount) || input.runner.cpuCount <= 0
    || !Number.isInteger(input.runner.totalMemoryBytes) || input.runner.totalMemoryBytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(input.runner.baselineDigest)
    || !Number.isFinite(input.flakyRate) || input.flakyRate < 0 || input.flakyRate > 100
    || !Number.isFinite(input.diagnosticRate) || input.diagnosticRate < 0 || input.diagnosticRate > 100) {
    throw proofError('E2E_OPERATIONAL_PROOF_INPUT_INVALID')
  }
  const phases = {} as OperationalPerformanceProof['phases']
  for (const name of OPERATIONAL_PERFORMANCE_PHASES) {
    const phase = input.phases[name]!
    if (!Number.isFinite(phase.budgetMs) || phase.budgetMs <= 0 || phase.samples.length !== input.sampleCount
      || phase.samples.some((sample) => !Number.isFinite(sample.durationMs) || sample.durationMs < 0
        || !sample.ok && !/^[A-Z][A-Z0-9_]{2,127}$/.test(sample.reasonCode ?? ''))) {
      throw proofError('E2E_OPERATIONAL_PROOF_SAMPLE_INVALID')
    }
    const successful = phase.samples.filter((sample) => sample.ok).map((sample) => sample.durationMs)
    const p95Ms = percentile(successful, 95)
    phases[name] = {
      samples: phase.samples.length,
      failures: phase.samples.length - successful.length,
      p50Ms: percentile(successful, 50), p95Ms,
      maxMs: successful.length === 0 ? null : round(Math.max(...successful)),
      budgetMs: phase.budgetMs, budgetPassed: p95Ms !== null && p95Ms <= phase.budgetMs,
      baselineDeltaPercent: p95Ms === null ? 100 : round((p95Ms / phase.budgetMs - 1) * 100),
      reasonCodes: [...new Set(phase.samples.flatMap((sample) => sample.reasonCode ? [sample.reasonCode] : []))].sort(),
      sampleDigest: digestText(`e2e-operational-samples/${name}/v1`, canonicalizeJson(phase.samples)),
    }
  }
  const passed = Object.values(phases).every((phase) => phase.failures === 0 && phase.budgetPassed)
    && input.flakyRate === 0 && input.diagnosticRate === 100 && input.artifactRetentionVerified
  const gateIneligibleReasons = [
    ...(!input.runner.stableResources ? ['UNSTABLE_RUNNER'] : []),
    ...(!passed ? ['OPERATIONAL_BASELINE_FAILED'] : []),
  ]
  const draft = { schemaVersion: '1.0.0' as const, runner: input.runner, sampleCount: input.sampleCount,
    phases, flakyRate: input.flakyRate, diagnosticRate: input.diagnosticRate,
    artifactRetentionVerified: input.artifactRetentionVerified, passed,
    gateEligible: passed && input.runner.stableResources, gateIneligibleReasons }
  return { ...draft, proofDigest: digestText('e2e-operational-performance-proof/v1', canonicalizeJson(draft)) }
}

function percentile(values: number[], rank: number): number | null {
  return values.length === 0 ? null : round(nearestRankPercentile(values, rank))
}
function round(value: number): number { return Math.round(value * 1_000) / 1_000 }
function proofError(code: string): E2EError {
  return new E2EError({ code, category: 'automation', retryable: false, message: code })
}
