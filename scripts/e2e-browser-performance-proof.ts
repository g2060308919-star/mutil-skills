import { createServer } from 'node:http'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { nearestRankPercentile } from '../packages/e2e-runtime/src/performance-proof.js'

interface BrowserPerformanceSample {
  durationMs: number; peakRssBytes: number; profileBytes: number; traceBytes: number; passed: boolean
}

export function summarizeBrowserPerformance(input: { runnerIdentity: string; warmupSamples: number;
  samples: BrowserPerformanceSample[]; budgetMs: number; stableResources: boolean }) {
  if (input.warmupSamples < 3 || input.samples.length < 20) throw new Error('E2E_BROWSER_PERFORMANCE_SAMPLE_COUNT_INVALID')
  const durations = input.samples.filter((item) => item.passed).map((item) => item.durationMs)
  const round = (value: number) => Math.round(value * 1_000) / 1_000
  const percentile = (rank: number) => round(nearestRankPercentile(durations, rank))
  const body = { schemaVersion: 'browser-performance-proof/v1' as const,
    runnerIdentity: input.runnerIdentity, stableResources: input.stableResources,
    warmupSamples: input.warmupSamples, sampleCount: input.samples.length,
    p50Ms: percentile(50), p95Ms: percentile(95), p99Ms: percentile(99), budgetMs: input.budgetMs,
    peakRssBytes: Math.max(...input.samples.map((item) => item.peakRssBytes)),
    peakProfileBytes: Math.max(...input.samples.map((item) => item.profileBytes)),
    peakTraceBytes: Math.max(...input.samples.map((item) => item.traceBytes)),
    failures: input.samples.filter((item) => !item.passed).length,
    passed: input.samples.every((item) => item.passed) && percentile(95) <= input.budgetMs,
    gateEligible: input.stableResources }
  return { ...body, proofDigest: digestText('browser-performance-proof/v1', canonicalizeJson(body)) }
}

export async function runBrowserPerformanceProof() {
  const warmupSamples = count(process.env.E2E_BROWSER_PERFORMANCE_WARMUPS ?? '3', 3)
  const sampleCount = count(process.env.E2E_BROWSER_PERFORMANCE_SAMPLES ?? '20', 20)
  const budgetMs = Number(process.env.E2E_BROWSER_PERFORMANCE_BUDGET_MS ?? '5000')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<main><label>名称<input aria-label="名称"></label><button>保存</button><p id="result"></p><script>document.querySelector("button").onclick=()=>{result.textContent=document.querySelector("input").value}</script></main>')
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('E2E_BROWSER_PERFORMANCE_SERVER_FAILED')
  const origin = `http://127.0.0.1:${address.port}`
  const samples: BrowserPerformanceSample[] = []
  try {
    for (let index = 0; index < warmupSamples + sampleCount; index += 1) {
      const profile = await mkdtemp(join(tmpdir(), 'mutil-e2e-browser-perf-'))
      const tracePath = join(profile, 'journey-trace.zip')
      const startedAt = performance.now(); let passed = false
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true })
      try {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
        const page = context.pages()[0] ?? await context.newPage(); await page.goto(origin)
        await page.getByLabel('名称').fill(`sample-${index}`); await page.getByRole('button', { name: '保存' }).click()
        passed = await page.locator('#result').textContent() === `sample-${index}`
        await context.tracing.stop({ path: tracePath })
      } finally {
        await context.close()
        if (index >= warmupSamples) samples.push({ durationMs: performance.now() - startedAt,
          peakRssBytes: Math.round(process.resourceUsage().maxRSS * 1024),
          profileBytes: await directoryBytes(profile), traceBytes: (await lstat(tracePath)).size, passed })
        await rm(profile, { recursive: true, force: true })
      }
    }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  return summarizeBrowserPerformance({ runnerIdentity: process.env.E2E_BROWSER_PERFORMANCE_RUNNER_ID
    ?? `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}-system-chrome`,
  warmupSamples, samples, budgetMs, stableResources: process.env.E2E_BROWSER_PERFORMANCE_STABLE_RUNNER === '1' })
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? await directoryBytes(child) : entry.isFile() ? (await lstat(child)).size : 0
  }
  return total
}

function count(value: string, minimum: number): number {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 100) throw new Error('E2E_BROWSER_PERFORMANCE_SAMPLE_COUNT_INVALID')
  return parsed
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proof = await runBrowserPerformanceProof(); process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
  if (!proof.passed) process.exitCode = 1
}
