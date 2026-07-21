import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const target = 'https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-card/'
const outputPath = process.env.E2E_W3C_REPORT
  ?? '/private/tmp/e2e-w3c-functional-smoke/report.json'
const screenshotPath = process.env.E2E_W3C_SCREENSHOT
  ?? '/private/tmp/e2e-w3c-functional-smoke/expanded.png'
const executablePath = process.env.E2E_CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sourcePath = fileURLToPath(import.meta.url)
const profile = await mkdtemp(join(tmpdir(), 'e2e-w3c-profile-'))
await Promise.all([mkdir(dirname(outputPath), { recursive: true }), mkdir(dirname(screenshotPath), { recursive: true })])

const report = {
  schemaVersion: '1.0.0',
  probe: 'w3c-disclosure-card',
  probeSourceSha256: sha256(await readFile(sourcePath)),
  target,
  startedAt: new Date().toISOString(),
  browser: { product: 'Google Chrome', executablePath },
  isolation: { temporaryProfileCreated: true, profileRemoved: false },
  checks: [],
  cleanup: { status: 'pending' },
}

let context
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    args: ['--disable-background-networking'],
  })
  report.browser.version = context.browser()?.version() ?? 'unknown'
  const page = context.pages()[0] ?? await context.newPage()
  const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  report.targetResponse = {
    status: response?.status(),
    etag: response?.headers().etag,
    lastModified: response?.headers()['last-modified'],
  }
  const title = await page.title()
  const heading = (await page.locator('h1').first().textContent())?.trim()
  report.checks.push({
    id: 'identity',
    passed: response?.status() === 200
      && title === 'Example Disclosure (Show/Hide) Card | APG | WAI | W3C'
      && heading === 'Example Disclosure (Show/Hide) Card',
    title,
    heading,
    responseStatus: response?.status(),
  })

  const buttons = page.getByRole('button', { name: /Details$/ })
  const buttonCount = await buttons.count()
  const button = buttons.first()
  const buttonLabelIds = await button.getAttribute('aria-labelledby')
  const controls = await button.getAttribute('aria-controls')
  const beforeExpanded = await button.getAttribute('aria-expanded')
  const controlled = controls ? page.locator(`#${controls}`) : undefined
  const beforeHeight = controlled
    ? await controlled.evaluate((element) => element.getBoundingClientRect().height) : undefined
  report.checks.push({
    id: 'initial-collapsed', passed: buttonCount >= 1 && beforeExpanded === 'false' && Boolean(controls),
    buttonCount, buttonLabelIds, controls, beforeExpanded, beforeHeight,
  })

  const buttonHandle = await button.elementHandle()
  if (!buttonHandle) throw new Error('W3C disclosure button unavailable')
  await button.click()
  await page.waitForFunction((element) => element.getAttribute('aria-expanded') === 'true', buttonHandle)
  await page.waitForTimeout(1_000)
  const afterExpanded = await button.getAttribute('aria-expanded')
  const afterHeight = controlled
    ? await controlled.evaluate((element) => element.getBoundingClientRect().height) : undefined
  const afterText = controlled ? normalizeText(await controlled.textContent()).slice(0, 240) : undefined
  report.checks.push({
    id: 'expand', passed: afterExpanded === 'true' && Boolean(afterText)
      && Number(afterHeight) > Number(beforeHeight),
    afterExpanded, afterHeight, afterText,
  })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  report.screenshotSha256 = sha256(await readFile(screenshotPath))

  await button.click()
  await page.waitForFunction((element) => element.getAttribute('aria-expanded') === 'false', buttonHandle)
  await page.waitForTimeout(1_000)
  const cleanupExpanded = await button.getAttribute('aria-expanded')
  const cleanupHeight = controlled
    ? await controlled.evaluate((element) => element.getBoundingClientRect().height) : undefined
  report.cleanup = {
    status: cleanupExpanded === 'false' && Number(cleanupHeight) <= Number(beforeHeight)
      ? 'verified-clean' : 'failed',
    cleanupExpanded,
    cleanupHeight,
  }
  report.verdict = report.checks.every((check) => check.passed)
    && report.cleanup.status === 'verified-clean' ? 'passed' : 'failed'
} catch (error) {
  report.verdict = 'environment-blocked'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
} finally {
  report.finishedAt = new Date().toISOString()
  if (context) {
    await Promise.race([
      context.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
  await rm(profile, { recursive: true, force: true })
  report.isolation.profileRemoved = true
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}

process.stdout.write(`${JSON.stringify(report)}\n`)
if (report.verdict !== 'passed') process.exitCode = 1

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeText(value) {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}
