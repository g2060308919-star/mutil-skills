import { afterEach, describe, expect, test } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { renderCompleteReport } from '@mutil-skills/e2e-report'
import { finalReportFixture } from '../packages/e2e-report/test/final-report.fixture.js'

let browser: Browser | undefined

afterEach(async () => {
  await browser?.close()
  browser = undefined
})

describe('完整 E2E 报告真实浏览器交互', () => {
  test('离线报告可通过键盘筛选、展开、重置并进入打印媒体', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const consoleProblems: string[] = []
    const externalRequests: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text())
    })
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })

    const report = renderCompleteReport(finalReportFixture)
    await page.setContent(report.html, { waitUntil: 'domcontentloaded' })

    expect(await page.locator('h1').textContent()).toContain('订单验收报告')
    expect(await page.getByLabel('搜索 CASE-ID、标题或状态').isVisible()).toBe(true)
    expect(await page.locator('[data-case]').count()).toBe(2)

    await page.getByLabel('搜索 CASE-ID、标题或状态').fill('CASE-REAL-1')
    expect(await page.locator('#case-filter-status').textContent()).toBe('显示 1 / 2 个 Case')
    expect(await page.locator('[data-case]:visible').count()).toBe(1)
    expect(await page.locator('[data-case]:visible').getAttribute('data-case-status')).toBe('passed')

    await page.locator('[data-case]:visible summary').press('Enter')
    expect(await page.locator('[data-case]:visible').getAttribute('open')).toBe('')

    await page.getByRole('button', { name: '重置筛选' }).click()
    expect(await page.locator('#case-filter-status').textContent()).toBe('显示 2 / 2 个 Case')
    expect(await page.getByLabel('搜索 CASE-ID、标题或状态').evaluate((element) => element === document.activeElement)).toBe(true)

    await page.getByLabel('状态', { exact: true }).selectOption('safety-blocked')
    expect(await page.locator('[data-case]:visible').getAttribute('data-case-mode')).toBe('browser-injection')

    await page.emulateMedia({ media: 'print' })
    expect(await page.locator('.report-controls').evaluate((element) => getComputedStyle(element).display)).toBe('none')
    expect((await page.screenshot({ fullPage: true })).byteLength).toBeGreaterThan(10_000)
    expect(consoleProblems).toEqual([])
    expect(externalRequests).toEqual([])
  })
})
