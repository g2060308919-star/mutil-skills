import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, expect as playwrightExpect, type APIRequestContext, type BrowserContext } from '@playwright/test'
import { canonicalizeJson, digestBytes, digestText } from '@mutil-skills/e2e-contracts'
import { LocalExecutionOutcomeVerifier, LocalGatewayAuditSigner, LocalGatewayAuditVerifier,
  verifyGatewayPublicationAudit, type GatewayPublicationAudit } from '@mutil-skills/e2e-gateway'
import { runFullPlaywrightCase, type FullPlaywrightEvidenceStage } from '@mutil-skills/e2e-playwright-runtime'
import { readyFixture } from '../packages/e2e-playwright-runtime/test/full-playwright-runner.fixture.js'
import { startGatewayProxyHostForRuntime } from '../packages/e2e-runtime/src/gateway-proxy-host.js'
import { projectGatewayRules } from '../packages/e2e-runtime/src/gateway-rule-projector.js'
import { RuntimeFullPlaywrightTraceRecorder } from '../packages/e2e-runtime/src/runtime-browser-wiring.js'

let origin = ''
const targetDigest = digestText('full-playwright-runner-test/v1', 'target')
let applicationState: 'clean' | 'dirty' = 'clean'
const receivedApiBodies: string[] = []
let server: ReturnType<typeof createServer>

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'POST' && url.pathname === '/api') {
      const body = await readRequestBody(request)
      receivedApiBodies.push(body)
      if (body !== canonicalizeJson({ enabled: true, name: 'Ada' })) {
        response.writeHead(400); response.end(); return
      }
      applicationState = 'dirty'; response.writeHead(204); response.end(); return
    }
    if (request.method === 'POST' && url.pathname === '/reset') {
      applicationState = 'clean'; response.writeHead(204); response.end(); return
    }
    if (url.pathname === '/popup' || url.pathname === '/extra') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<title>${url.pathname.slice(1)}</title><main>${url.pathname}</main>`); return
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Local</title></head><body>
      <main aria-label="main"><h1>Local</h1><label>Name <input aria-label="Name"></label>
      <label>Enabled <input aria-label="Enabled" type="checkbox"></label>
      <a href="/popup" target="_blank">Details</a><div id="row">row</div><button id="remove">Remove</button>
      <output id="state">${applicationState}</output></main>
      <script>document.querySelector('[aria-label=Name]').addEventListener('keydown', event => event.preventDefault())</script>
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('E2E_GOLDEN_DYNAMIC_PORT_REQUIRED')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

test('真实 production Gateway child + Chromium proxy 闭合 document transport 与签名发布', async () => {
  const home = await mkdtemp(join(tmpdir(), 'e2e-full-production-gateway-'))
  await mkdir(join(home, 'authority'), { recursive: true, mode: 0o700 })
  const approvedRequests = [{ actionId: 'ACTION-PRODUCTION-GOLDEN', capabilityId: 'CAP-PRODUCTION-GOLDEN',
    requestId: 'DOCUMENT-PRODUCTION-GOLDEN', method: 'GET', url: `${origin}/extra`, maxUses: 1,
    signedBodyDigest: digestText('runtime-http-signed-payload/v1', canonicalizeJson({ kind: 'no-body' })),
    headers: [], redirectRequestIds: [], channel: 'http' as const, behavior: { kind: 'pass-through' as const } }]
  const rule = projectGatewayRules({ runId: 'RUN-PRODUCTION-GOLDEN', approvedRequests }).rules[0]!
  const gateway = await startGatewayProxyHostForRuntime({ runId: 'RUN-PRODUCTION-GOLDEN',
    mode: 'real-environment', authorityRoot: join(home, 'authority'), approvedRequests })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true,
      proxy: { server: gateway.handle.endpoint, bypass: '<-loopback>' },
      args: [`--ignore-certificate-errors-spki-list=${gateway.handle.caSpkiFingerprint}`] })
    const context = await browser.newContext()
    await context.route('**/*', async (route) => {
      const request = route.request()
      if (request.method() !== 'GET' || request.url() !== `${origin}/extra`) {
        await route.abort('blockedbyclient'); return
      }
      await gateway.browserBinding.continueCorrelatedRequest({
        requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
        method: rule.method, url: rule.url, channel: 'http', bodyDigest: rule.bodyDigest,
        actionId: rule.actionId, capabilityId: rule.capabilityId,
        signedBodyDigest: rule.signedBodyDigest!, headers: { ...rule.requestHeaders },
      }, { continueWithHeaders: async (headers) => await route.continue({
        headers: { ...request.headers(), ...headers },
      }) })
    })
    const page = await context.newPage()
    await page.goto(`${origin}/extra`)
    await playwrightExpect(page.locator('main')).toHaveText('/extra')
    await gateway.handle.freeze()
    const publication = await gateway.handle.finalize()
    expect(gateway.handle.auditSummary()).toMatchObject({ received: 1, forwarded: 1, blocked: 0,
      byIntent: { 'DOCUMENT-PRODUCTION-GOLDEN': 1 } })
    expect(publication.signedCounters.digest).toMatch(/^sha256:/)
    await context.close()
  } finally {
    await browser?.close()
    await gateway.handle.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('真实 Chromium：受控完整 Playwright program 与独立 cleanup session 闭合', async () => {
  const traceStateRoot = await mkdtemp(join(tmpdir(), 'e2e-full-playwright-traces-'))
  const programBrowser = await chromium.launch({ headless: true })
  const cleanupBrowser = await chromium.launch({ headless: true })
  expect(programBrowser).not.toBe(cleanupBrowser)
  const programContext = await programBrowser.newContext()
  const cleanupContext = await cleanupBrowser.newContext()
  const programPage = await programContext.newPage()
  const cleanupPage = await cleanupContext.newPage()
  const programRequest = await playwrightRequest(programContext)
  const cleanupRequest = await playwrightRequest(cleanupContext)
  const programTrace = new RuntimeFullPlaywrightTraceRecorder({ context: programContext,
    stateRoot: traceStateRoot, attemptId: 'ATTEMPT-GOLDEN', lifecycle: 'program' })
  const cleanupTrace = new RuntimeFullPlaywrightTraceRecorder({ context: cleanupContext,
    stateRoot: traceStateRoot, attemptId: 'ATTEMPT-GOLDEN', lifecycle: 'cleanup' })
  await Promise.all([programTrace.start(), cleanupTrace.start()])
  const counts = { received: 0, forwarded: 0, blocked: 0, byIntent: {} as Record<string, number> }
  const signer = LocalGatewayAuditSigner.create({ issuer: 'GOLDEN-GATEWAY', keyId: 'GOLDEN-KEY',
    instanceId: 'GOLDEN-GW', version: '1.0.0' })
  const recorder = signer.createRecorder(digestText('full-playwright-runner-test/v1', 'gateway-policy'))
  let publicationAudit: GatewayPublicationAudit | undefined
  const allowed = new Map([
    ['GET /', { id: 'DOCUMENT', max: 3 }], ['GET /popup', { id: 'POPUP', max: 1 }],
    ['GET /extra', { id: 'EXTRA', max: 1 }], ['GET /favicon.ico', { id: 'FAVICON', max: 2 }],
    ['POST /api', { id: 'API', max: 1 }], ['POST /reset', { id: 'RESET', max: 1 }],
  ])
  const authorize = (method: string, rawUrl: string) => {
    counts.received += 1
    const key = `${method.toUpperCase()} ${new URL(rawUrl).pathname}`
    const rule = allowed.get(key)
    const used = rule ? counts.byIntent[rule.id] ?? 0 : 0
    const forwarded = Boolean(rule && used < rule.max)
    recorder.recordReadDecision({ actionId: 'ACTION-1', executionSessionId: 'GW-SESSION-1',
      decision: forwarded ? 'forwarded' : 'blocked', request: { method, url: rawUrl } })
    if (!forwarded || !rule) { counts.blocked += 1; return false }
    counts.forwarded += 1; counts.byIntent[rule.id] = used + 1; return true
  }
  const routeContext = async (context: BrowserContext) => context.route('**/*', async (route) => {
    const request = route.request()
    if (authorize(request.method(), request.url())) await route.continue()
    else await route.abort('blockedbyclient')
  })
  await routeContext(programContext)
  await routeContext(cleanupContext)
  const controlledRequest = (request: APIRequestContext) => new Proxy(request, {
    get(target, property, receiver) {
      if (property === 'post') return async (url: string, options?: Parameters<APIRequestContext['post']>[1]) => {
        if (!authorize('POST', url)) throw new Error('E2E_GATEWAY_BROWSER_REQUEST_DENIED')
        return await target.post(url, options)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const controlledBrowser = new Proxy(programBrowser, {
    get(target, property, receiver) {
      if (property === 'newContext') return async (...args: Parameters<typeof programBrowser.newContext>) => {
        const context = await target.newContext(...args); await routeContext(context); return context
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const state: Record<string, unknown> = {}
  const source = [
    `await page.goto('${origin}/')`,
    "await page.getByLabel('Name').fill('Ada')", "await page.getByLabel('Name').press('Enter')",
    "await page.getByLabel('Enabled').check()",
    "await expect(page.getByLabel('Name')).toHaveValue('Ada')",
    "await expect(page.getByLabel('Enabled')).toBeChecked()",
    "const popupReady = context.waitForEvent('page')", "await page.getByRole('link', { name: 'Details' }).click()",
    'const popup = await popupReady', "await expect(popup).toHaveTitle('popup')", "await page.locator('#row').dblclick()",
    "await page.locator('#remove').hover()", 'const extra = await browser.newContext()',
    'const extraPage = await extra.newPage()', `await extraPage.goto('${origin}/extra')`,
    "await expect(extraPage).toHaveTitle('extra')", 'await extra.close()',
    `const response = await request.post('${origin}/api', { data: { enabled: true, name: 'Ada' } })`,
    'await expect(response.ok()).toBeTruthy()',
    "await checkpoint({ checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1', actual: true })",
    'state.programCompleted = true',
  ].join('\n')
  const cleanupSource = [
    `const reset = await request.post('${origin}/reset')`, 'await expect(reset.ok()).toBeTruthy()',
    `await page.goto('${origin}/')`, "await expect(page.locator('#state')).toHaveText('clean')",
    'await page.reload()', "await expect(page.locator('#state')).toHaveText('clean')",
    "return 'verified-clean'",
  ].join('\n')
  const rawCapture = async (stage: FullPlaywrightEvidenceStage) => {
    const page = stage === 'cleanup' ? cleanupPage : programPage
    const screenshot = await page.screenshot()
    const dom = await page.content()
    const url = page.url()
    return [
      { evidenceId: `${stage.toUpperCase()}-SHOT`, stage, kind: 'screenshot' as const,
        byteLength: screenshot.byteLength, digest: digestBytes('runtime-evidence/screenshot/v1', screenshot) },
      { evidenceId: `${stage.toUpperCase()}-DOM`, stage, kind: 'dom' as const,
        byteLength: Buffer.byteLength(dom), digest: digestText('runtime-evidence/dom/v1', dom) },
      { evidenceId: `${stage.toUpperCase()}-URL`, stage, kind: 'url' as const,
        byteLength: Buffer.byteLength(url), digest: digestText('runtime-evidence/url/v1', url) },
      await (stage === 'cleanup' ? cleanupTrace : programTrace).capture(stage, stage === 'before'),
    ]
  }
  const jsonBody = canonicalizeJson({ enabled: true, name: 'Ada' })
  const requests = [
    ['DOCUMENT', 'GET', '/', 3], ['POPUP', 'GET', '/popup', 1], ['EXTRA', 'GET', '/extra', 1],
    ['FAVICON', 'GET', '/favicon.ico', 2], ['API', 'POST', '/api', 1], ['RESET', 'POST', '/reset', 1],
  ].map(([intentId, method, exactPath, maxRequests], index) => ({ intentId: String(intentId), method: String(method),
    canonicalOrigin: origin, exactPath: String(exactPath), query: [] as Array<[string, string]>,
    payload: intentId === 'API'
      ? { kind: 'json' as const, digest: digestText('http-json-payload/v1', jsonBody) }
      : { kind: 'no-body' as const }, targetFingerprint: targetDigest, maxRequests: Number(maxRequests),
    expectedOrder: index + 1 }))
  try {
    const fixture = await readyFixture({ source, cleanupSource, networkRequests: requests,
      networkRequestBodies: [{ intentId: 'API', kind: 'json', canonicalJson: jsonBody }],
      programBindings: { page: programPage, context: programContext, browser: controlledBrowser,
        request: controlledRequest(programRequest), expect: playwrightExpect, testInfo: { title: 'Golden' }, state },
      cleanupBindings: { page: cleanupPage, context: cleanupContext, browser: cleanupBrowser,
        request: controlledRequest(cleanupRequest), expect: playwrightExpect, testInfo: { title: 'Golden cleanup' }, state },
      capture: rawCapture, finalizeGateway: () => {
        publicationAudit = recorder.finalize()
        return { executionSessionId: 'GW-SESSION-1', policyDigest: publicationAudit.policyDigest,
          summary: counts, auditDigest: publicationAudit.signedCounters.digest }
      }, issueOutcome: (binding) => signer.issueExecutionOutcomeReceipt(binding) })
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', effectObservation: 'applied',
      cleanup: { status: 'verified-clean' } })
    expect(applicationState).toBe('clean')
    expect(counts.blocked).toBe(0)
    expect(counts.byIntent).toMatchObject({ DOCUMENT: 3, POPUP: 1, EXTRA: 1, API: 1, RESET: 1 })
    expect(receivedApiBodies).toContain(jsonBody)
    expect(LocalExecutionOutcomeVerifier.create(signer.exportExecutionOutcomeVerifierMaterial())
      .verifyReceipt(result.outcome)).toBe(true)
    expect(publicationAudit).toBeDefined()
    expect(verifyGatewayPublicationAudit(publicationAudit!,
      LocalGatewayAuditVerifier.create(signer.exportVerifierMaterial()))).toBe(true)
    expect(result.evidence.some((item) => item.kind === 'gateway-audit')).toBe(true)
  } finally {
    await programRequest.dispose(); await cleanupRequest.dispose()
    await programContext.close(); await cleanupContext.close()
    await programBrowser.close(); await cleanupBrowser.close()
    await rm(traceStateRoot, { recursive: true, force: true })
  }
})

async function playwrightRequest(context: BrowserContext): Promise<APIRequestContext> {
  return context.request
}

async function readRequestBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
