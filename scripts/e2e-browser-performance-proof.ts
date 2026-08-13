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
  samples: BrowserPerformanceSample[]; budgetMs: number; stableResources: boolean
  journeyCaseCounts: number[]; concurrentRuns: number; concurrentFailures: number
  soakIterations: number; soakFailures: number; soakRssGrowthBytes: number }) {
  if (input.warmupSamples < 3 || input.samples.length < 20) throw new Error('E2E_BROWSER_PERFORMANCE_SAMPLE_COUNT_INVALID')
  const durations = input.samples.filter((item) => item.passed).map((item) => item.durationMs)
  const round = (value: number) => Math.round(value * 1_000) / 1_000
  const percentile = (rank: number) => round(nearestRankPercentile(durations, rank))
  const coverageComplete = canonicalizeJson([...new Set(input.journeyCaseCounts)].sort((a, b) => a - b))
      === canonicalizeJson([10, 50, 100])
    && input.concurrentRuns >= 4 && input.concurrentFailures === 0
    && input.soakIterations >= 100 && input.soakFailures === 0
  const passed = input.samples.every((item) => item.passed) && percentile(95) <= input.budgetMs
    && coverageComplete
  const body = { schemaVersion: 'browser-performance-proof/v1' as const,
    runnerIdentity: input.runnerIdentity, stableResources: input.stableResources,
    warmupSamples: input.warmupSamples, sampleCount: input.samples.length,
    p50Ms: percentile(50), p95Ms: percentile(95), p99Ms: percentile(99), budgetMs: input.budgetMs,
    peakRssBytes: Math.max(...input.samples.map((item) => item.peakRssBytes)),
    peakProfileBytes: Math.max(...input.samples.map((item) => item.profileBytes)),
    peakTraceBytes: Math.max(...input.samples.map((item) => item.traceBytes)),
    failures: input.samples.filter((item) => !item.passed).length,
    journeyCaseCounts: input.journeyCaseCounts, concurrentRuns: input.concurrentRuns,
    concurrentFailures: input.concurrentFailures, soakIterations: input.soakIterations,
    soakFailures: input.soakFailures, soakRssGrowthBytes: input.soakRssGrowthBytes,
    passed, gateEligible: input.stableResources && passed }
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
  const caseCounts = [10, 50, 100]
  let concurrentFailures = 0
  let soakFailures = 0
  let soakRssGrowthBytes = 0
  try {
    for (let index = 0; index < warmupSamples + sampleCount; index += 1) {
      const profile = await mkdtemp(join(tmpdir(), 'mutil-e2e-browser-perf-'))
      const tracePath = join(profile, 'journey-trace.zip')
      const startedAt = performance.now(); let passed = false
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true })
      try {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
        const page = context.pages()[0] ?? await context.newPage(); await page.goto(origin)
        const cases = caseCounts[index % caseCounts.length]!
        passed = await exerciseCases(page, cases, `sample-${index}`)
        await context.tracing.stop({ path: tracePath })
      } finally {
        await context.close()
        if (index >= warmupSamples) samples.push({ durationMs: performance.now() - startedAt,
          peakRssBytes: Math.round(process.resourceUsage().maxRSS * 1024),
          profileBytes: await directoryBytes(profile), traceBytes: (await lstat(tracePath)).size, passed })
        await rm(profile, { recursive: true, force: true })
      }
    }
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    try {
      const concurrent = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const context = await browser.newContext(); const page = await context.newPage()
        try { await page.goto(origin); return await exerciseCases(page, 10, `concurrent-${index}`) }
        finally { await context.close() }
      }))
      concurrentFailures = concurrent.filter((passed) => !passed).length
      const context = await browser.newContext(); const page = await context.newPage(); await page.goto(origin)
      const beforeRss = Math.round(process.resourceUsage().maxRSS * 1024)
      try { if (!await exerciseCases(page, 100, 'soak')) soakFailures += 1 }
      catch { soakFailures += 1 }
      soakRssGrowthBytes = Math.max(0, Math.round(process.resourceUsage().maxRSS * 1024) - beforeRss)
      await context.close()
    } finally { await browser.close() }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  return summarizeBrowserPerformance({ runnerIdentity: process.env.E2E_BROWSER_PERFORMANCE_RUNNER_ID
    ?? `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}-system-chrome`,
  warmupSamples, samples, budgetMs, stableResources: process.env.E2E_BROWSER_PERFORMANCE_STABLE_RUNNER === '1',
  journeyCaseCounts: caseCounts, concurrentRuns: 4, concurrentFailures,
  soakIterations: 100, soakFailures, soakRssGrowthBytes })
}

async function exerciseCases(page: import('playwright').Page, cases: number, prefix: string): Promise<boolean> {
  for (let index = 0; index < cases; index += 1) {
    const value = `${prefix}-${index}`
    await page.getByLabel('名称').fill(value)
    await page.getByRole('button', { name: '保存' }).click()
    if (await page.locator('#result').textContent() !== value) return false
  }
  return true
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
