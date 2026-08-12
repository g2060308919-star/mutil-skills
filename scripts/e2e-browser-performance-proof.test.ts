import { describe, expect, test } from 'vitest'
import { summarizeBrowserPerformance } from './e2e-browser-performance-proof.js'

describe('真实 Chrome 性能 proof', () => {
  test('记录固定 runner、样本、warmup、p50/p95/p99 与资源峰值', () => {
    const proof = summarizeBrowserPerformance({ runnerIdentity: 'stable-test-runner', warmupSamples: 3,
      samples: Array.from({ length: 20 }, (_, index) => ({ durationMs: index + 1, peakRssBytes: 100 + index,
        profileBytes: 10 + index, traceBytes: 20 + index, passed: true })), budgetMs: 25,
      stableResources: true, journeyCaseCounts: [10, 50, 100], concurrentRuns: 4,
      concurrentFailures: 0, soakIterations: 100, soakFailures: 0, soakRssGrowthBytes: 12 })
    expect(proof).toMatchObject({ schemaVersion: 'browser-performance-proof/v1', sampleCount: 20,
      p50Ms: 10, p95Ms: 19, p99Ms: 20, peakRssBytes: 119, passed: true, gateEligible: true,
      journeyCaseCounts: [10, 50, 100], concurrentRuns: 4, concurrentFailures: 0,
      soakIterations: 100, soakFailures: 0, soakRssGrowthBytes: 12 })
  })

  test('缺少 10/50/100、并发或 Soak 证明时不得通过', () => {
    const input = { runnerIdentity: 'stable-test-runner', warmupSamples: 3,
      samples: Array.from({ length: 20 }, () => ({ durationMs: 1, peakRssBytes: 1,
        profileBytes: 1, traceBytes: 1, passed: true })), budgetMs: 25, stableResources: true,
      journeyCaseCounts: [10, 50], concurrentRuns: 1, concurrentFailures: 0,
      soakIterations: 10, soakFailures: 0, soakRssGrowthBytes: 0 }
    expect(summarizeBrowserPerformance(input)).toMatchObject({ passed: false, gateEligible: false })
  })
})
