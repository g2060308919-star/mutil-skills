import { describe, expect, test } from 'vitest'
import {
  PRODUCTION_BENCHMARK_PHASES,
  createProductionPerformanceProof,
} from '../src/production-performance-proof.js'

const fixtureCounts = { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 } as const
const runner = {
  runnerId: 'stable-macos-arm64-01', stableResources: true,
  platform: 'darwin', arch: 'arm64', node: 'v24.18.0',
  cpuModel: 'Apple M4', cpuCount: 10, totalMemoryBytes: 32 * 1024 ** 3,
}

describe('production module performance proof', () => {
  test('固定生产阶段、预热、20 个样本及 p50/p95/p99、内存、产物和失败率', () => {
    const phases = Object.fromEntries(PRODUCTION_BENCHMARK_PHASES.map((name, phaseIndex) => [name, {
      budgetMs: 100,
      samples: Array.from({ length: 20 }, (_, sampleIndex) => ({
        ok: true as const,
        durationMs: sampleIndex + 1 + phaseIndex,
        peakRssBytes: 100_000 + sampleIndex,
        outputBytes: 10_000 + sampleIndex,
      })),
    }]))

    const proof = createProductionPerformanceProof({
      fixtureDigest: `sha256:${'a'.repeat(64)}`,
      fixtureCounts,
      warmupSamples: 3,
      sampleCount: 20,
      runner,
      phases,
    })

    expect(Object.keys(proof.phases)).toEqual([...PRODUCTION_BENCHMARK_PHASES])
    expect(proof.phases.compiler).toMatchObject({
      samples: 20, successfulSamples: 20, failures: 0, failureRate: 0,
      p50Ms: 10, p95Ms: 19, p99Ms: 20, maxMs: 20,
      peakRssBytes: 100_019,
      outputBytes: { p50: 10_009, p95: 10_018, p99: 10_019, max: 10_019 },
      budgetMs: 100, budgetPassed: true,
    })
    expect(proof).toMatchObject({ schemaVersion: '2.0.0', passed: true, gateEligible: true })
    expect(proof.proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('保留失败率和超预算事实，不生成伪全绿证明', () => {
    const samples = Array.from({ length: 20 }, (_, index) => index === 19
      ? { ok: false as const, durationMs: 50, peakRssBytes: 200, outputBytes: 0,
          reasonCode: 'E2E_BENCHMARK_SAMPLE_FAILED' }
      : { ok: true as const, durationMs: 10, peakRssBytes: 100, outputBytes: 10 })
    const phases = Object.fromEntries(PRODUCTION_BENCHMARK_PHASES.map((name) => [name, {
      budgetMs: name === 'engine-verdict' ? 5 : 100,
      samples,
    }]))

    const proof = createProductionPerformanceProof({
      fixtureDigest: `sha256:${'b'.repeat(64)}`,
      fixtureCounts,
      warmupSamples: 3,
      sampleCount: 20,
      runner: { ...runner, runnerId: 'local-uncontrolled', stableResources: false },
      phases,
    })

    expect(proof.passed).toBe(false)
    expect(proof.gateEligible).toBe(false)
    expect(proof.phases.compiler).toMatchObject({ failures: 1, failureRate: 5, budgetPassed: true })
    expect(proof.phases['engine-verdict']).toMatchObject({ failures: 1, budgetPassed: false })
  })

  test('拒绝缺阶段、规模漂移、样本不足和 runner 信息缺失', () => {
    const validSamples = Array.from({ length: 20 }, () => ({
      ok: true as const, durationMs: 1, peakRssBytes: 1, outputBytes: 1,
    }))
    const phases = Object.fromEntries(PRODUCTION_BENCHMARK_PHASES.map((name) => [name, {
      budgetMs: 10, samples: validSamples,
    }]))
    const base = {
      fixtureDigest: `sha256:${'c'.repeat(64)}`,
      fixtureCounts,
      warmupSamples: 3,
      sampleCount: 20,
      runner,
      phases,
    }

    expect(() => createProductionPerformanceProof({
      ...base, phases: Object.fromEntries(Object.entries(phases).slice(1)),
    })).toThrow(/E2E_PRODUCTION_BENCHMARK_PHASE_SET_INVALID/)
    expect(() => createProductionPerformanceProof({
      ...base, fixtureCounts: { ...fixtureCounts, cases: 999 } as never,
    })).toThrow(/E2E_PRODUCTION_BENCHMARK_FIXTURE_INVALID/)
    expect(() => createProductionPerformanceProof({
      ...base, sampleCount: 19,
    })).toThrow(/E2E_PRODUCTION_BENCHMARK_SAMPLE_COUNT_INVALID/)
    expect(() => createProductionPerformanceProof({
      ...base, runner: { ...runner, runnerId: '' },
    })).toThrow(/E2E_PRODUCTION_BENCHMARK_RUNNER_INVALID/)
  })
})
