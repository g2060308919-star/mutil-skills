import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  PRODUCTION_BENCHMARK_PHASES,
  type ProductionBenchmarkPhase,
  type ProductionBenchmarkSample,
} from '../packages/e2e-runtime/src/production-performance-proof.js'
import { createProductionBenchmarkWorkload } from './e2e-production-benchmark-workload.js'

const phase = process.argv[2] as ProductionBenchmarkPhase
if (!PRODUCTION_BENCHMARK_PHASES.includes(phase)) {
  throw new Error('E2E_PRODUCTION_BENCHMARK_PHASE_INVALID')
}
const warmupSamples = parseCount(process.env.E2E_PRODUCTION_BENCHMARK_WARMUPS ?? '3', 3)
const sampleCount = parseCount(process.env.E2E_PRODUCTION_BENCHMARK_SAMPLES ?? '20', 20)
const root = await mkdtemp(join(tmpdir(), `mutil-e2e-benchmark-${phase}-`))

try {
  const workload = await createProductionBenchmarkWorkload({ artifactRoot: root })
  for (let index = 0; index < warmupSamples; index += 1) {
    await workload.run(phase, index)
  }
  const samples: ProductionBenchmarkSample[] = []
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now()
    try {
      const result = await workload.run(phase, warmupSamples + index)
      samples.push({
        ok: true,
        durationMs: performance.now() - startedAt,
        peakRssBytes: peakRssBytes(),
        outputBytes: result.outputBytes,
      })
    } catch (error) {
      samples.push({
        ok: false,
        durationMs: performance.now() - startedAt,
        peakRssBytes: peakRssBytes(),
        outputBytes: 0,
        reasonCode: reasonCode(error),
      })
    }
  }
  await workload.close()
  process.stdout.write(`${JSON.stringify({
    phase,
    fixtureDigest: workload.fixtureDigest,
    fixtureCounts: workload.fixtureCounts,
    warmupSamples,
    sampleCount,
    samples,
  })}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}

function peakRssBytes(): number {
  // Node 在所有支持平台把 resourceUsage().maxRSS 表示为 KiB。
  return Math.round(process.resourceUsage().maxRSS * 1024)
}

function parseCount(value: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 1_000) {
    throw new Error('E2E_PRODUCTION_BENCHMARK_SAMPLE_COUNT_INVALID')
  }
  return parsed
}

function reasonCode(error: unknown): string {
  const candidate = error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code)
    : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(candidate)
    ? candidate
    : 'E2E_PRODUCTION_BENCHMARK_SAMPLE_FAILED'
}
