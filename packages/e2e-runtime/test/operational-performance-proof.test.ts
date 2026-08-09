import { describe, expect, test } from 'vitest'
import { createOperationalPerformanceProof, OPERATIONAL_PERFORMANCE_PHASES } from '../src/operational-performance-proof.js'

const samples = Array.from({ length: 20 }, (_, index) => ({ ok: true, durationMs: index + 1 }))
const phases = Object.fromEntries(OPERATIONAL_PERFORMANCE_PHASES.map((name) => [name, {
  budgetMs: 25, samples,
}]))
const runner = { runnerId: 'stable-01', stableResources: true, platform: 'darwin', arch: 'arm64', node: 'v24',
  cpuModel: 'Apple M1 Pro', cpuCount: 10, totalMemoryBytes: 17_179_869_184,
  baselineDigest: `sha256:${'1'.repeat(64)}` }

describe('Runtime 非功能性能证明', () => {
  test('汇总启动、更新、并发、诊断和证据保留的 p95 门禁', () => {
    const proof = createOperationalPerformanceProof({ runner, sampleCount: 20, phases,
      flakyRate: 0, diagnosticRate: 100, artifactRetentionVerified: true })
    expect(proof).toMatchObject({ passed: true, gateEligible: true,
      phases: { 'runtime-module-cold-start': { p50Ms: 10, p95Ms: 19, maxMs: 20 } } })
  })
  test('开发机或任何非功能事实失败都不能获得门禁资格', () => {
    const proof = createOperationalPerformanceProof({ runner: { ...runner, stableResources: false },
      sampleCount: 20, phases, flakyRate: 1, diagnosticRate: 99, artifactRetentionVerified: false })
    expect(proof).toMatchObject({ passed: false, gateEligible: false,
      gateIneligibleReasons: ['UNSTABLE_RUNNER', 'OPERATIONAL_BASELINE_FAILED'] })
  })
})
