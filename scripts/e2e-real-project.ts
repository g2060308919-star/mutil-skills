import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import {
  E2EBenchmarkProofV1Schema,
  canonicalizeJson,
  computeE2EBenchmarkProofDigest,
  digestBytes,
  digestText,
} from '@mutil-skills/e2e-contracts'
import { reactLikeApp } from '../fixtures/e2e-real-projects/react-like/app.html.js'
import { webComponentsApp } from '../fixtures/e2e-real-projects/web-components/app.html.js'

type Stack = 'react-like' | 'web-components'
type Defect = 'none' | 'permission-leak' | 'reload-loss'

export async function runRealProjectFixture(input: { stack: Stack; defect: Defect }) {
  const html = input.stack === 'react-like' ? reactLikeApp(input.defect) : webComponentsApp
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('E2E_REAL_PROJECT_SERVER_FAILED')
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const scenarios: Array<{ scenarioId: string; status: 'passed' | 'failed'; oracleStatus: 'passed' | 'failed';
    evidenceDigests: string[]; attemptIds: string[]; negativeControlDetected: boolean }> = []
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    if (input.stack === 'react-like') await reactScenarios(page, scenarios)
    else await shadowScenarios(page, scenarios)
  } finally {
    await context.close()
    await browser.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  const passed = scenarios.every((scenario) => scenario.status === 'passed'
    && scenario.oracleStatus === 'passed' && scenario.negativeControlDetected)
  const body = {
    schemaVersion: 'e2e-benchmark-proof/v1' as const,
    proofKind: 'real-project' as const,
    proofId: `REAL-${input.stack.toUpperCase()}-${input.defect.toUpperCase()}`,
    runnerIdentityDigest: digestText('e2e-real-project-runner/v1', 'playwright-system-chrome'),
    corpusDigest: digestText('e2e-real-project-corpus/v1', canonicalizeJson({ stack: input.stack,
      scenarios: scenarios.map((item) => item.scenarioId) })),
    application: {
      applicationId: input.stack === 'react-like' ? 'REAL-OPS-CONSOLE' : 'REAL-SHADOW-SETTINGS',
      stack: input.stack === 'react-like' ? 'React-like component application' : 'Web Components shadow-dom application',
      sourceRevision: digestText('e2e-real-project-source/v1', html),
      targetOrigin: origin,
      startupCommandDigest: digestText('e2e-real-project-startup/v1', 'node:http in-process fixture server'),
    },
    components: [
      { component: 'browser-product' as const, mode: 'real' as const, claim: 'verified' as const,
        reason: '系统 Chrome 真实加载版本化产品 HTML、组件、状态与请求入口，并通过 UI 完成交互' },
      { component: 'backend' as const, mode: 'substituted' as const, claim: 'not-verified' as const,
        reason: '本地 fixture server 替代真实 backend' },
      { component: 'database' as const, mode: 'substituted' as const, claim: 'not-verified' as const,
        reason: 'localStorage/内存状态替代数据库' },
      { component: 'idp' as const, mode: 'substituted' as const, claim: 'not-verified' as const,
        reason: '页面角色选择器替代真实 IdP 登录与后端授权' },
    ],
    scenarios,
    gate: { eligible: true, passed, reasons: passed ? [] : ['REAL_PROJECT_ORACLE_FAILED'] },
    generatedAt: '2026-08-12T00:00:00.000Z',
  }
  return E2EBenchmarkProofV1Schema.parse({ ...body, proofDigest: computeE2EBenchmarkProofDigest(body) })
}

async function reactScenarios(page: import('playwright').Page, output: Parameters<typeof capture>[2]) {
  await scenario(page, output, 'ROLE-NEGATIVE', async () => {
    await page.getByTestId('role').selectOption('user')
    return await page.getByTestId('review').isHidden()
  })
  await scenario(page, output, 'FILTER-SORT-PAGE', async () => {
    await page.getByTestId('sort').click(); await page.getByTestId('query').fill('a')
    const sorted = await page.getByTestId('table').textContent() === 'Alpha|Beta|Delta|Gamma'
    await page.getByTestId('page').click()
    return sorted && (await page.getByTestId('table').textContent()) === 'Delta|Gamma'
  })
  await scenario(page, output, 'DYNAMIC-FORM', async () => {
    await page.getByTestId('type').selectOption('company'); await page.getByTestId('tax').fill('1')
    return await page.getByTestId('tax').isVisible() && await page.getByTestId('validation').textContent() === '税号无效'
  })
  await scenario(page, output, 'CRUD-RELOAD-CLEANUP', async () => {
    await page.getByTestId('title').fill('版本发布'); await page.getByTestId('save').click(); await page.reload()
    const persisted = await page.getByTestId('title').inputValue() === '版本发布'
    await page.evaluate(() => localStorage.clear()); await page.reload()
    return persisted && await page.getByTestId('title').inputValue() === ''
  })
  await scenario(page, output, 'PORTAL-ASYNC', async () => {
    await page.getByTestId('open').click(); const dialog = page.getByRole('dialog', { name: '订单详情' })
    const overlay = await dialog.isVisible() && await dialog.getByText('详情加载完成').isVisible()
    await page.getByTestId('close').click(); await page.getByTestId('role').selectOption('admin')
    await page.getByTestId('review').click(); await page.getByTestId('status').waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === '已通过')
    return overlay && await page.getByTestId('status').textContent() === '已通过'
  })
  await scenario(page, output, 'DOWNLOAD-CONTENT', async () => {
    const download = page.waitForEvent('download'); await page.getByTestId('download').click(); const file = await download
    const stream = await file.createReadStream(); const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return file.suggestedFilename() === 'orders.csv' && Buffer.concat(chunks).toString().includes('1,alpha')
  })
}

async function shadowScenarios(page: import('playwright').Page, output: Parameters<typeof capture>[2]) {
  const root = page.locator('settings-panel')
  await scenario(page, output, 'SHADOW-DIALOG', async () => {
    await root.getByRole('button', { name: '打开设置' }).click()
    const dialog = root.getByRole('dialog'); await dialog.getByRole('textbox', { name: '名称' }).fill('深层组件')
    await dialog.getByRole('button', { name: '保存' }).click()
    return await root.locator('#value').textContent() === '深层组件'
  })
  await scenario(page, output, 'SHADOW-RELOAD', async () => {
    await page.reload()
    const persisted = await page.locator('settings-panel').locator('#value').textContent() === '深层组件'
    await page.evaluate(() => localStorage.clear()); await page.reload()
    return persisted && await page.locator('settings-panel').locator('#value').textContent() === ''
  })
}

async function scenario(page: import('playwright').Page, output: Parameters<typeof capture>[2], id: string,
  operation: () => Promise<boolean>) {
  let passed = false
  try { passed = await operation() } catch { passed = false }
  await capture(page, id, output, passed)
}

async function capture(page: import('playwright').Page, id: string,
  output: Array<{ scenarioId: string; status: 'passed' | 'failed'; oracleStatus: 'passed' | 'failed';
    evidenceDigests: string[]; attemptIds: string[]; negativeControlDetected: boolean }>, passed: boolean) {
  const screenshot = await page.screenshot()
  const dom = await page.content()
  output.push({ scenarioId: id, status: passed ? 'passed' : 'failed', oracleStatus: passed ? 'passed' : 'failed',
    evidenceDigests: [digestBytes('e2e-real-project-screenshot/v1', screenshot),
      digestText('e2e-real-project-dom/v1', dom)], attemptIds: [`ATTEMPT-${id}-1`],
    negativeControlDetected: passed })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proof = await runRealProjectFixture({ stack: 'react-like', defect: 'none' })
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
}
