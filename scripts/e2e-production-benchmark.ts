import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, cpus, homedir, platform, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRODUCTION_BENCHMARK_PHASES,
  createProductionPerformanceProof,
  type ProductionBenchmarkSample,
} from '../packages/e2e-runtime/src/production-performance-proof.js'

const worker = fileURLToPath(new URL('./e2e-production-benchmark-worker.ts', import.meta.url))
const budgets = {
  compiler: 500,
  'requirement-graph': 300,
  'coverage-audit': 500,
  'case-schedule': 200,
  'checkpoint-finalization': 500,
  'engine-verdict': 500,
  'report-render': 2_000,
  'artifact-publication': 3_000,
} as const

const phaseResults = []
for (const phase of PRODUCTION_BENCHMARK_PHASES) {
  phaseResults.push(await runWorker(phase))
}
const fixtureDigest = phaseResults[0]!.fixtureDigest
const fixtureCounts = phaseResults[0]!.fixtureCounts
if (phaseResults.some((result) => result.fixtureDigest !== fixtureDigest
  || JSON.stringify(result.fixtureCounts) !== JSON.stringify(fixtureCounts))) {
  throw new Error('E2E_PRODUCTION_BENCHMARK_FIXTURE_DRIFT')
}
const stableResources = process.env.E2E_PRODUCTION_BENCHMARK_STABLE_RUNNER === '1'
const runnerId = process.env.E2E_PRODUCTION_BENCHMARK_RUNNER_ID
  ?? `local-${platform()}-${arch()}-node${process.versions.node.split('.')[0]}`
const proof = createProductionPerformanceProof({
  fixtureDigest,
  fixtureCounts,
  warmupSamples: phaseResults[0]!.warmupSamples,
  sampleCount: phaseResults[0]!.sampleCount,
  runner: {
    runnerId,
    stableResources,
    platform: platform(),
    arch: arch(),
    node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unknown-cpu',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  phases: Object.fromEntries(phaseResults.map((result) => [result.phase, {
    budgetMs: budgets[result.phase],
    samples: result.samples,
  }])),
})
const outputPath = resolve(process.env.E2E_PRODUCTION_BENCHMARK_OUTPUT
  ?? join(homedir(), '.mutil-skills', 'e2e', 'proofs', 'production-performance-proof.json'))
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({
  ok: proof.passed,
  gateEligible: proof.gateEligible,
  outputPath,
  proofDigest: proof.proofDigest,
})}\n`)
if (!proof.passed) process.exitCode = 1

interface WorkerResult {
  phase: typeof PRODUCTION_BENCHMARK_PHASES[number]
  fixtureDigest: string
  fixtureCounts: { requirements: 500; rules: 2000; obligations: 5000; cases: 1000 }
  warmupSamples: number
  sampleCount: number
  samples: ProductionBenchmarkSample[]
}

async function runWorker(phase: WorkerResult['phase']): Promise<WorkerResult> {
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(process.execPath, ['--import', 'tsx', worker, phase], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, output, stderr) => {
      if (error) rejectPromise(new Error(
        `E2E_PRODUCTION_BENCHMARK_WORKER_FAILED:${phase}:${stderr.slice(0, 2_000)}`,
        { cause: error },
      ))
      else resolvePromise(output)
    })
  })
  const lines = stdout.trim().split('\n')
  const parsed = JSON.parse(lines.at(-1) ?? '{}') as WorkerResult
  if (parsed.phase !== phase || !Array.isArray(parsed.samples)) {
    throw new Error(`E2E_PRODUCTION_BENCHMARK_WORKER_RESULT_INVALID:${phase}`)
  }
  return parsed
}
