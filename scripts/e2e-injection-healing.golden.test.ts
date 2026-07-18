import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'
import {
  canonicalizeJson,
  digestInjectionResponseBody,
  digestText,
  type AttemptEvent,
  type AppendAttemptEventInput,
  type AttemptTerminalSnapshot,
  type InjectionGatewayDecision,
  type ProtocolDecision,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import {
  LocalArtifactStore,
  classifyFailure,
  reviewHealingProposal,
  selectFinalAttempt,
} from '@mutil-skills/e2e-engine'
import {
  InjectionGateway,
  ProtocolGuard,
  ReadOnlyGateway,
  digestJsonHttpPayload,
  evaluateInjectionSafety,
} from '@mutil-skills/e2e-gateway'
import { PlaywrightPageAdapter, runBrowserPreflight, runReadOnlyCase } from '@mutil-skills/e2e-playwright-runtime'
import { renderPartitionedExecutionReport } from '@mutil-skills/e2e-report'

const servers: Server[] = []
const tempDirectories: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PRD-driven injection and healing golden path', () => {
  test('partitions real and injected results while proving zero upstream mutation and traceable locator healing', async () => {
    let upstreamMutationHits = 0
    const fixture = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/real') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(realPage())
        return
      }
      if (request.method === 'GET' && request.url === '/injection-500') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(injection500Page())
        return
      }
      if (request.method === 'GET' && request.url === '/injection-timeout') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(injectionTimeoutPage())
        return
      }
      if (request.method === 'GET' && request.url === '/escape') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(escapePage())
        return
      }
      if (request.method === 'POST' && request.url === '/api/orders/search?mode=full') {
        upstreamMutationHits += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'real-upstream-response' }))
        return
      }
      if (request.method === 'POST' && request.url === '/api/orders/timeout') {
        upstreamMutationHits += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'unexpected-real-timeout-response' }))
        return
      }
      response.writeHead(404).end('not found')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const prdRevision = digestText('prd-revision/v1', 'injection-healing-golden')
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
      approvalIdentities: [
        { subject: 'os-user:injection-golden', roles: ['e2e-approver'] },
        { subject: 'os-user:golden', roles: ['e2e-approver'] },
      ],
      authenticateApproverSession: (sessionRef, expected) => {
        const subject = {
          'injection-session': 'os-user:injection-golden',
          'golden-session': 'os-user:golden',
        }[sessionRef]
        return subject === undefined
          ? undefined
          : createGoldenApprovalReceipt(subject, 'RUN-INJECTION-HEALING', expected)
      },
    })
    const realGateway = new ReadOnlyGateway({
      stage: 'bootstrap', intents: [{
        intentId: 'INTENT-REAL-DOCUMENT', stage: 'bootstrap', methods: ['GET'], origin: fixtureOrigin,
        exactPath: '/real', query: [], maxRequests: 2,
      }],
    })
    const realProxyPort = await createProxy(fixturePort, async (request) => realGateway.decide(request))
    const realBrowser = await launchChrome(realProxyPort)
    let realResult
    try {
      const page = await realBrowser.newPage()
      const discoverySubject = {
        schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-PRD-1', prdRevision,
        scopeDigest: prdRevision, environment: 'test' as const, baseOrigin: fixtureOrigin, actor: 'auditor',
        expectedPageIdentity: {
          url: `${fixtureOrigin}/real`, title: '订单搜索', heading: '订单搜索', ariaSignals: ['main:订单搜索'],
        },
        bootstrapIntentsDigest: prdRevision,
        requests: [],
        actions: [{ actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
      }
      const discoveryGrant = await authority.issueDiscoveryGrant({
        subject: discoverySubject,
        approver: { subject: 'os-user:injection-golden', roles: ['e2e-approver'] },
        approvalSessionRef: 'injection-session', ttlMs: 60_000,
      })
      const preflight = await runBrowserPreflight({
        authorization: { grant: discoveryGrant, currentSubject: discoverySubject, authority },
        runtime: { sandboxHealthy: true, gatewayConnected: true },
        gatewayAudit: () => realGateway.getAuditSummary(), page: new PlaywrightPageAdapter(page),
        actionId: 'ACTION-PREFLIGHT', attemptId: 'ATTEMPT-PREFLIGHT-REAL-READ',
      })
      if (preflight.status !== 'ready' || !preflight.preflightDigest) throw new Error('Discovery preflight 未 ready')
      const realReadGrant = await authority.issueReadGrant({
        subject: {
          schemaVersion: '2.1.0', assetId: 'PRODUCT-PRD-1', prdRevision,
          scopeDigest: prdRevision, requirementModelDigest: prdRevision, coveragePolicyDigest: prdRevision,
          universeDigest: prdRevision, caseDigest: prdRevision, actionMapDigest: prdRevision,
          policyDigest: prdRevision, executionContractDigest: prdRevision,
          runBundleProjectionDigest: prdRevision, environment: 'test', baseOrigin: fixtureOrigin, actor: 'auditor',
          discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
          requests: [],
          actions: [
            { actionId: 'ACTION-REAL-READ', operation: 'local-navigation', maxUses: 1, requestIds: [] },
            { actionId: 'ACTION-REAL-READ', operation: 'dom-read', maxUses: 1, requestIds: [] },
            { actionId: 'ACTION-REAL-READ', operation: 'screenshot', maxUses: 1, requestIds: [] },
          ],
        },
        approver: { subject: 'os-user:injection-golden', roles: ['e2e-approver'] },
        approvalSessionRef: 'injection-session', ttlMs: 60_000,
      })
      realResult = await runReadOnlyCase({
        caseId: 'CASE-REAL-BASELINE', actionId: 'ACTION-REAL-READ', url: `${fixtureOrigin}/real`,
        expectedIdentity: { title: '订单搜索', heading: '订单搜索' }, expectedText: '真实服务正常',
        authorization: { grant: realReadGrant, currentSubject: realReadGrant.subject, authority },
        attemptId: 'ATTEMPT-REAL-READ', runtime: { sandboxHealthy: true, gatewayConnected: true },
        gatewayAudit: () => realGateway.getAuditSummary(), page: new PlaywrightPageAdapter(page),
      })
    } finally {
      await realBrowser.close()
    }

    const requestPayload = { query: 'order-100' }
    const responseBody = JSON.stringify({ error: 'UPSTREAM_FAILURE' })
    const injectionGrant = await authority.issueInjectionGrant({
      subject: {
        schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision,
        executionDigest: digestText('execution/v1', 'CASE-INJECT-500'), environment: 'test', baseOrigin: fixtureOrigin,
        actions: [{
          actionId: 'ACTION-INJECT-500', caseId: 'CASE-INJECT-500', runId: 'RUN-INJECT-1', attemptSlot: 1,
          request: {
            intentId: 'INTENT-INJECT-500', method: 'POST', canonicalOrigin: fixtureOrigin,
            exactPath: '/api/orders/search', query: [['mode', 'full']],
            payload: { kind: 'json', digest: digestJsonHttpPayload(requestPayload) },
            targetFingerprint: 'not-applicable', maxRequests: 1, expectedOrder: 1,
          },
          response: {
            kind: 'http-response', status: 500, headers: [{ name: 'content-type', value: 'application/json' }],
            body: { kind: 'utf8', value: responseBody, digest: digestInjectionResponseBody(responseBody) }, delayMs: 0,
          },
          expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden',
        }],
      },
      approver: { subject: 'os-user:golden', roles: ['e2e-approver'] },
      approvalSessionRef: 'golden-session', ttlMs: 60_000,
    })
    const injectionGateway = new InjectionGateway({
      stage: 'bootstrap', grant: injectionGrant, attemptId: 'ATTEMPT-1', authority,
      bootstrapIntents: [{
        intentId: 'INTENT-INJECTION-DOCUMENT', stage: 'bootstrap', methods: ['GET'], origin: fixtureOrigin,
        exactPath: '/injection-500', query: [], maxRequests: 1,
      }],
      caseReadIntents: [],
    })
    const injectionDecisions: Array<{ method: string; url: string; decision: string; code?: string }> = []
    const injectionProxyPort = await createProxy(
      fixturePort,
      async (request) => injectionGateway.decide(request),
      injectionDecisions,
    )
    const injectionBrowser = await launchChrome(injectionProxyPort)
    const events: AttemptEvent[] = []
    const attemptContext = {
      assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-INJECTION-1', prdRevision,
      runId: 'RUN-INJECT-1', caseId: 'CASE-INJECT-500',
    }
    let eventChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(attemptContext))
    let healingReview
    let finalAttempt
    let screenshotBytes = 0
    try {
      const page = await injectionBrowser.newPage()
      await page.goto(`${fixtureOrigin}/injection-500`, { waitUntil: 'domcontentloaded' })
      expect(await page.title()).toBe('订单故障演练')
      expect(await page.locator('h1').textContent()).toBe('订单搜索')
      expect(await page.getByText('订单 180', { exact: true }).count()).toBe(0)
      await page.locator('#virtual-list').evaluate((element) => {
        element.scrollTop = 180 * 32
        element.dispatchEvent(new Event('scroll'))
      })
      await page.getByText('订单 180', { exact: true }).waitFor({ state: 'visible' })
      expect(await page.locator('#virtual-window > [data-order-id]').count()).toBeLessThanOrEqual(8)
      injectionGateway.switchToCaseStage()

      eventChainDigest = appendSigned(events, eventChainDigest, authority, attemptContext, {
        kind: 'started', sequence: 1, caseId: 'CASE-INJECT-500', slot: 0, attemptId: 'ATTEMPT-0',
        mode: 'gateway-injection', timestamp: '2026-07-11T10:00:01.000Z',
      })
      let locatorFailed = false
      try {
        await page.getByRole('button', { name: '审核订单' }).click({ timeout: 250 })
      } catch {
        locatorFailed = true
      }
      expect(locatorFailed).toBe(true)
      const attempt0: AttemptTerminalSnapshot = {
        status: 'automation-blocked', mode: 'gateway-injection', effect: 'read',
        effectObservation: 'not-applicable', reservationSafeToVoid: false,
      }
      eventChainDigest = appendSigned(events, eventChainDigest, authority, attemptContext, {
        kind: 'terminal', sequence: 2, caseId: 'CASE-INJECT-500', slot: 0, attemptId: 'ATTEMPT-0',
        timestamp: '2026-07-11T10:00:02.000Z', result: attempt0,
      })
      expect(classifyFailure({ findings: [{
        category: 'automation-binding-evidence', code: 'LOCATOR_NOT_FOUND',
        observation: '旧 role locator 未命中 Portal 中按钮', evidenceRefs: ['dom:portal-root'],
      }] })).toMatchObject({ status: 'automation-blocked' })

      const semanticDigest = digestText('semantic/v1', '点击查询后展示服务暂不可用')
      const approvalSubjectDigest = injectionGrant.subjectDigest
      healingReview = reviewHealingProposal({
        proposalId: 'HEAL-LOCATOR-1', actionId: 'ACTION-INJECT-500', baseRevision: 1, caseTimeoutMs: 5_000,
        semanticDigestBefore: semanticDigest, semanticDigestAfter: semanticDigest,
        approvalSubjectDigestBefore: approvalSubjectDigest, approvalSubjectDigestAfter: approvalSubjectDigest,
        mutations: [{
          kind: 'locator-candidate', before: [{ strategy: 'role', value: 'button:审核订单' }],
          after: [{ strategy: 'test-id', value: 'search-orders' }],
        }],
      }, {
        currentSemanticDigest: semanticDigest, currentApprovalSubjectDigest: approvalSubjectDigest,
        protectedPageIdentitySignals: ['订单搜索'],
      })
      expect(healingReview).toMatchObject({ accepted: true, requiresReapproval: false, nextRevision: 2 })

      eventChainDigest = appendSigned(events, eventChainDigest, authority, attemptContext, {
        kind: 'started', sequence: 3, caseId: 'CASE-INJECT-500', slot: 1, attemptId: 'ATTEMPT-1',
        mode: 'gateway-injection', timestamp: '2026-07-11T10:00:03.000Z',
      })
      await page.getByTestId('search-orders').click()
      await page.getByText('服务暂不可用', { exact: true }).waitFor({ state: 'visible' })
      const injectionReservation = injectionGateway.getCompletedReservations()[0]
      if (!injectionReservation?.outcomeDigest) throw new Error('注入 reservation 未完成')
      const attempt1: AttemptTerminalSnapshot = {
        status: 'passed', mode: 'gateway-injection', effect: 'read',
        effectObservation: 'not-applicable', reservationSafeToVoid: false,
        reservationId: injectionReservation.reservationId, outcomeDigest: injectionReservation.outcomeDigest,
      }
      eventChainDigest = appendSigned(events, eventChainDigest, authority, attemptContext, {
        kind: 'terminal', sequence: 4, caseId: 'CASE-INJECT-500', slot: 1, attemptId: 'ATTEMPT-1',
        timestamp: '2026-07-11T10:00:04.000Z', result: attempt1,
      })
      screenshotBytes = (await page.screenshot({ fullPage: true })).byteLength
      finalAttempt = selectFinalAttempt({
        caseId: 'CASE-INJECT-500', retryPolicy: 'read-automation-max-2',
        initialChainDigest: digestText('attempt-chain-initial/v2', canonicalizeJson(attemptContext)), events,
        verifyAuthorityProof: (proof) => authority.verifyAttemptEventProof(proof),
      })
    } finally {
      await injectionBrowser.close()
    }

    const timeoutPayload = { query: 'slow-order' }
    const timeoutGrant = await authority.issueInjectionGrant({
      subject: {
        schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision,
        executionDigest: digestText('execution/v1', 'CASE-INJECT-TIMEOUT'), environment: 'test', baseOrigin: fixtureOrigin,
        actions: [{
          actionId: 'ACTION-INJECT-TIMEOUT', caseId: 'CASE-INJECT-TIMEOUT', runId: 'RUN-INJECT-2', attemptSlot: 1,
          request: {
            intentId: 'INTENT-INJECT-TIMEOUT', method: 'POST', canonicalOrigin: fixtureOrigin,
            exactPath: '/api/orders/timeout', query: [],
            payload: { kind: 'json', digest: digestJsonHttpPayload(timeoutPayload) },
            targetFingerprint: 'not-applicable', maxRequests: 1, expectedOrder: 1,
          },
          response: {
            kind: 'timeout', status: 'not-applicable', headers: [], body: { kind: 'no-body' }, delayMs: 1_000,
          },
          expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden',
        }],
      },
      approver: { subject: 'os-user:golden', roles: ['e2e-approver'] },
      approvalSessionRef: 'golden-session', ttlMs: 60_000,
    })
    const timeoutGateway = new InjectionGateway({
      stage: 'bootstrap', grant: timeoutGrant, attemptId: 'CASE-INJECT-TIMEOUT', authority,
      bootstrapIntents: [{
        intentId: 'INTENT-TIMEOUT-DOCUMENT', stage: 'bootstrap', methods: ['GET'], origin: fixtureOrigin,
        exactPath: '/injection-timeout', query: [], maxRequests: 1,
      }],
      caseReadIntents: [],
    })
    const timeoutProxyPort = await createProxy(fixturePort, async (request) => timeoutGateway.decide(request))
    const timeoutBrowser = await launchChrome(timeoutProxyPort)
    let timeoutStatus = 'not-executed'
    try {
      const page = await timeoutBrowser.newPage()
      await page.goto(`${fixtureOrigin}/injection-timeout`, { waitUntil: 'domcontentloaded' })
      timeoutGateway.switchToCaseStage()
      await page.getByRole('button', { name: '查询慢订单' }).click()
      await page.getByText('请求超时', { exact: true }).waitFor({ state: 'visible' })
      timeoutStatus = 'passed'
    } finally {
      await timeoutBrowser.close()
    }

    const escapeReadGateway = new ReadOnlyGateway({
      stage: 'bootstrap', intents: [{
        intentId: 'INTENT-ESCAPE-DOCUMENT', stage: 'bootstrap', methods: ['GET'], origin: fixtureOrigin,
        exactPath: '/escape', query: [], maxRequests: 1,
      }],
    })
    const sseGrant = await authority.issueSseReadGrant({
      subject: {
        schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision,
        executionDigest: digestText('execution/v1', 'CASE-PROTOCOL-ESCAPE'), environment: 'test', baseOrigin: fixtureOrigin,
        actions: [{
          actionId: 'ACTION-SSE-UNUSED', origin: fixtureOrigin, exactPath: '/events-unused', query: [], maxReconnects: 1,
        }],
      },
      approver: { subject: 'os-user:golden', roles: ['e2e-approver'] },
      approvalSessionRef: 'golden-session', ttlMs: 60_000,
    })
    const protocolGuard = new ProtocolGuard({
      downstream: { decide: (request) => escapeReadGateway.decide(request) },
      sse: { grant: sseGrant, capabilityId: sseGrant.capabilities[0]!.capabilityId, authority },
      allowedIframeOrigins: [],
    })
    const escapeDecisions: Array<{ channel: string; decision: string; code?: string }> = []
    const escapeProxyPort = await createEscapeProxy(fixturePort, protocolGuard, escapeDecisions)
    const escapeBrowser = await launchChrome(escapeProxyPort, [`--unsafely-treat-insecure-origin-as-secure=${fixtureOrigin}`])
    let escapeStatus = 'not-executed'
    try {
      const page = await escapeBrowser.newPage()
      await page.goto(`${fixtureOrigin}/escape`, { waitUntil: 'domcontentloaded' })
      const browserObservations = await page.evaluate(async (origin) => {
        let serviceWorker = 'unsupported'
        if ('serviceWorker' in navigator) {
          try {
            await navigator.serviceWorker.register('/sw.js')
            serviceWorker = 'unexpected-success'
          } catch {
            serviceWorker = 'blocked'
          }
        }
        const beaconQueued = navigator.sendBeacon('/escape/beacon', 'escape-probe')
        const websocket = await new Promise<string>((resolve) => {
          const socket = new WebSocket(origin.replace('http://', 'ws://') + '/escape/ws')
          const timer = setTimeout(() => resolve('timeout'), 1_000)
          socket.addEventListener('open', () => { clearTimeout(timer); resolve('unexpected-open') })
          socket.addEventListener('error', () => { clearTimeout(timer); resolve('blocked') })
        })
        return { serviceWorker, beaconQueued, websocket }
      }, fixtureOrigin)
      await page.waitForTimeout(300)
      expect(browserObservations.serviceWorker).toBe('blocked')
      expect(browserObservations.websocket).toBe('blocked')
      escapeStatus = 'passed'
    } finally {
      await escapeBrowser.close()
    }

    const injectionAudit = injectionGateway.getAuditSummary()
    const injectionSafety = evaluateInjectionSafety({ audit: injectionAudit, expectedMatches: 1 })
    const timeoutAudit = timeoutGateway.getAuditSummary()
    const timeoutSafety = evaluateInjectionSafety({ audit: timeoutAudit, expectedMatches: 1 })
    const report = renderPartitionedExecutionReport({
      assetId: 'PRODUCT-PRD-1', prdRevision, generationId: 'GENERATION-INJECTION-1',
      realResults: [{ caseId: 'CASE-REAL-BASELINE', title: '真实服务只读基线', status: realResult.status }],
      injectionResults: [
        { caseId: 'CASE-INJECT-500', title: 'HTTP 500 与 locator 自愈', status: finalAttempt!.status === 'selected' ? finalAttempt!.result.status : 'safety-blocked' },
        { caseId: 'CASE-INJECT-TIMEOUT', title: '请求超时处理', status: timeoutStatus },
        { caseId: 'CASE-PROTOCOL-ESCAPE', title: 'Service Worker、Beacon、WebSocket 逃逸阻断', status: escapeStatus },
      ],
      injectionBoundary: '仅证明前端面对已签名模拟响应时的行为，不证明真实后端故障行为。',
    })
    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-injection-golden-'))
    tempDirectories.push(workspace)
    const store = new LocalArtifactStore(workspace, {
      auditStagedGeneration: async (input) => {
        expect(input.files.length).toBe(5)
      },
      signDigest: (digest) => authority.signArtifactDigest(digest),
      verifySignature: (signature) => authority.verifyArtifactSignature(signature),
    })
    await store.publish({
      assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-INJECTION-1', terminalVerdict: 'accepted',
      files: {
        'requirements/model.json': JSON.stringify({ prdRevision }),
        'approval/injection-grant.json': JSON.stringify(injectionGrant),
        'run/results.json': JSON.stringify({
          realResults: [realResult], injectionResults: [
            { finalAttempt, injectionSafety }, { timeoutStatus, timeoutSafety }, { escapeStatus, escapeDecisions },
          ],
          injectionAudit, timeoutAudit, upstreamMutationHits, healingReview, events, screenshotBytes,
        }),
        'run/report.md': report.markdown,
        'run/report.html': report.html,
      },
    })

    const active = await store.readActive('PRODUCT-PRD-1')
    expect(realResult.status).toBe('passed')
    expect(finalAttempt).toMatchObject({ status: 'selected', slot: 1, result: { status: 'passed' } })
    expect(injectionSafety, JSON.stringify(injectionDecisions)).toEqual({ status: 'passed', reasonCodes: [] })
    expect(timeoutStatus).toBe('passed')
    expect(timeoutSafety).toEqual({ status: 'passed', reasonCodes: [] })
    expect(timeoutAudit).toMatchObject({ matched: 1, injectionTargetForwarded: 0, blocked: 0 })
    expect(escapeStatus).toBe('passed')
    expect(escapeDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'service-worker', decision: 'block', code: 'E2E_GATEWAY_PROTOCOL_FORBIDDEN' }),
      expect.objectContaining({ channel: 'beacon', decision: 'block' }),
      expect.objectContaining({ channel: 'websocket-handshake', decision: 'block', code: 'E2E_GATEWAY_WEBSOCKET_TARGET_DENIED' }),
    ]))
    expect(injectionAudit).toMatchObject({ matched: 1, injectionTargetForwarded: 0, blocked: 0 })
    expect(upstreamMutationHits).toBe(0)
    expect(screenshotBytes).toBeGreaterThan(0)
    expect(active).toMatchObject({ generationId: 'GENERATION-INJECTION-1', terminalVerdict: 'accepted' })
    expect(await readFile(join(active!.generationPath, 'run/report.md'), 'utf8')).toContain('## Gateway 故障注入结果')
  }, 60_000)

  test('signed injection matcher 未命中时真实浏览器请求被 safety-blocked 且不触达上游', async () => {
    let upstreamMutationHits = 0
    const fixture = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/injection-mismatch') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(injectionMismatchPage())
        return
      }
      if (request.method === 'POST') {
        upstreamMutationHits += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'unexpected-upstream-hit' }))
        return
      }
      response.writeHead(404).end('not found')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const prdRevision = digestText('prd-revision/v1', 'injection-matcher-miss-golden')
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
      approvalIdentities: [{ subject: 'os-user:injection-golden', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'injection-session'
        ? createGoldenApprovalReceipt('os-user:injection-golden', 'RUN-INJECT-MATCHER-MISS', expected)
        : undefined,
    })
    const expectedPayload = { query: 'order-100' }
    const responseBody = JSON.stringify({ error: 'UPSTREAM_FAILURE' })
    const injectionGrant = await authority.issueInjectionGrant({
      subject: {
        schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision,
        executionDigest: digestText('execution/v1', 'CASE-INJECT-MATCHER-MISS'),
        environment: 'test', baseOrigin: fixtureOrigin,
        actions: [{
          actionId: 'ACTION-INJECT-MATCHER-MISS', caseId: 'CASE-INJECT-MATCHER-MISS',
          runId: 'RUN-INJECT-MATCHER-MISS', attemptSlot: 1,
          request: {
            intentId: 'INTENT-INJECT-MATCHER-MISS', method: 'POST', canonicalOrigin: fixtureOrigin,
            exactPath: '/api/orders/search', query: [['mode', 'full']],
            payload: { kind: 'json', digest: digestJsonHttpPayload(expectedPayload) },
            targetFingerprint: 'not-applicable', maxRequests: 1, expectedOrder: 1,
          },
          response: {
            kind: 'http-response', status: 500,
            headers: [{ name: 'content-type', value: 'application/json' }],
            body: { kind: 'utf8', value: responseBody, digest: digestInjectionResponseBody(responseBody) },
            delayMs: 0,
          },
          expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden',
        }],
      },
      approver: { subject: 'os-user:injection-golden', roles: ['e2e-approver'] },
      approvalSessionRef: 'injection-session', ttlMs: 60_000,
    })
    const gateway = new InjectionGateway({
      stage: 'bootstrap', grant: injectionGrant, attemptId: 'ATTEMPT-MATCHER-MISS', authority,
      bootstrapIntents: [{
        intentId: 'INTENT-MISMATCH-DOCUMENT', stage: 'bootstrap', methods: ['GET'], origin: fixtureOrigin,
        exactPath: '/injection-mismatch', query: [], maxRequests: 1,
      }],
      caseReadIntents: [],
    })
    const decisions: Array<{ method: string; url: string; decision: string; code?: string }> = []
    const proxyPort = await createProxy(fixturePort, async (request) => gateway.decide(request), decisions)
    const browser = await launchChrome(proxyPort)
    let browserObservation = 'not-executed'
    try {
      const page = await browser.newPage()
      await page.goto(`${fixtureOrigin}/injection-mismatch`, { waitUntil: 'domcontentloaded' })
      gateway.switchToCaseStage()
      await page.getByRole('button', { name: '发送不匹配请求' }).click()
      await page.getByText('网关已阻断', { exact: true }).waitFor({ state: 'visible' })
      browserObservation = 'gateway-blocked'
    } finally {
      await browser.close()
    }

    const audit = gateway.getAuditSummary()
    const safety = evaluateInjectionSafety({ audit, expectedMatches: 1 })
    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-injection-matcher-miss-'))
    tempDirectories.push(workspace)
    const store = new LocalArtifactStore(workspace, {
      auditStagedGeneration: async ({ files }) => { expect(files.length).toBe(3) },
      signDigest: (digest) => authority.signArtifactDigest(digest),
      verifySignature: (signature) => authority.verifyArtifactSignature(signature),
    })
    await store.publish({
      assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-INJECTION-MATCHER-MISS',
      terminalVerdict: safety.status,
      files: {
        'approval/injection-grant.json': JSON.stringify(injectionGrant),
        'run/gateway-audit.json': JSON.stringify(audit),
        'run/safety-result.json': JSON.stringify({ browserObservation, safety, decisions, upstreamMutationHits }),
      },
    })
    const active = await store.readActive('PRODUCT-PRD-1')

    expect(browserObservation).toBe('gateway-blocked')
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'block', code: 'E2E_GATEWAY_INJECTION_INTENT_NOT_FOUND' }),
    ]))
    expect(audit).toMatchObject({ matched: 0, blocked: 1, injectionTargetForwarded: 0 })
    expect(safety).toEqual({
      status: 'safety-blocked',
      reasonCodes: ['E2E_INJECTION_MATCH_COUNT_INVALID', 'E2E_INJECTION_BLOCKED_REQUESTS_PRESENT'],
    })
    expect(upstreamMutationHits).toBe(0)
    expect(active).toMatchObject({
      generationId: 'GENERATION-INJECTION-MATCHER-MISS', terminalVerdict: 'safety-blocked',
    })
  }, 30_000)
})

function appendSigned(
  events: AttemptEvent[],
  previousChainDigest: string,
  authority: LocalApprovalAuthority,
  context: { assetId: string; generationId: string; prdRevision: string; runId: string; caseId: string },
  core: Omit<AppendAttemptEventInput, 'previousChainDigest'>,
): string {
  const appended = authority.appendAttemptEvent({ context, event: { ...core, previousChainDigest } as AppendAttemptEventInput })
  events.push(appended.event)
  return appended.eventChainDigest
}

async function createProxy(
  fixturePort: number,
  decide: (request: { method: string; url: string; body: Buffer; contentType?: string }) => Promise<InjectionGatewayDecision>,
  decisionLog?: Array<{ method: string; url: string; decision: string; code?: string }>,
): Promise<number> {
  const proxy = createServer(async (request, response) => {
    const body = await readBody(request)
    const contentTypeHeader = request.headers['content-type']
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
    const decision = await decide({
      method: request.method ?? 'GET', url: request.url ?? '', body,
      ...(contentType === undefined ? {} : { contentType }),
    })
    decisionLog?.push({
      method: request.method ?? 'GET', url: request.url ?? '', decision: decision.decision,
      ...(decision.decision === 'block' ? { code: decision.code } : {}),
    })
    if (decision.decision === 'block') {
      response.writeHead(403).end(decision.code)
      return
    }
    if (decision.decision === 'inject') {
      await applyInjection(decision, response)
      return
    }
    const target = new URL(request.url!)
    const forwarded = httpRequest({
      hostname: '127.0.0.1', port: fixturePort, path: `${target.pathname}${target.search}`,
      method: request.method, headers: { ...request.headers, host: `fixture.test:${fixturePort}`, 'content-length': body.byteLength },
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 500, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', (error) => response.writeHead(502).end(error.message))
    forwarded.end(body)
  })
  return await listen(proxy)
}

async function createEscapeProxy(
  fixturePort: number,
  guard: ProtocolGuard,
  decisionLog: Array<{ channel: string; decision: string; code?: string }>,
): Promise<number> {
  let correlation = 0
  const proxy = createServer(async (request, response) => {
    const body = await readBody(request)
    const target = new URL(request.url!)
    const channel = target.pathname === '/sw.js'
      ? 'service-worker' as const
      : target.pathname === '/escape/beacon'
        ? 'beacon' as const
        : 'http' as const
    const decision = channel === 'service-worker'
      ? await guard.decide({ channel, correlationId: `ESCAPE-${++correlation}`, url: request.url })
      : await guard.decide({
          channel, correlationId: `ESCAPE-${++correlation}`, method: request.method ?? 'GET', url: request.url ?? '', body,
          ...(typeof request.headers['content-type'] === 'string' ? { contentType: request.headers['content-type'] } : {}),
        })
    recordProtocolDecision(decisionLog, channel, decision)
    if (decision.decision !== 'forward') {
      const code = decision.decision === 'block' ? decision.code : 'E2E_GATEWAY_ESCAPE_UNEXPECTED_DECISION'
      response.writeHead(403).end(code)
      return
    }
    const forwarded = httpRequest({
      hostname: '127.0.0.1', port: fixturePort, path: `${target.pathname}${target.search}`,
      method: request.method, headers: { ...request.headers, host: `fixture.test:${fixturePort}`, 'content-length': body.byteLength },
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 500, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', (error) => response.writeHead(502).end(error.message))
    forwarded.end(body)
  })
  proxy.on('upgrade', async (request, socket) => {
    const decision = await guard.decide({
      channel: 'websocket-handshake', correlationId: `ESCAPE-${++correlation}`,
      connectionId: `WS-${correlation}`, url: request.url ?? '',
    })
    recordProtocolDecision(decisionLog, 'websocket-handshake', decision)
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })
  proxy.on('connect', async (request, socket) => {
    const decision = await guard.decide({
      channel: 'websocket-handshake', correlationId: `ESCAPE-${++correlation}`,
      connectionId: `WS-CONNECT-${correlation}`, url: `ws://${request.url ?? 'invalid-target'}/`,
    })
    recordProtocolDecision(decisionLog, 'websocket-handshake', decision)
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })
  return await listen(proxy)
}

function recordProtocolDecision(
  log: Array<{ channel: string; decision: string; code?: string }>,
  channel: string,
  decision: ProtocolDecision,
): void {
  log.push({
    channel, decision: decision.decision,
    ...(decision.decision === 'block' ? { code: decision.code } : {}),
  })
}

async function applyInjection(
  decision: Extract<InjectionGatewayDecision, { decision: 'inject' }>,
  response: Parameters<Parameters<typeof createServer>[0]>[1],
): Promise<void> {
  const injection = decision.response
  if (injection.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, injection.delayMs))
  if (injection.kind === 'connection-reset' || injection.kind === 'timeout') {
    response.destroy()
    return
  }
  for (const header of injection.headers) response.setHeader(header.name, header.value)
  response.writeHead(injection.status)
  response.end(injection.body.kind === 'utf8' ? injection.body.value : undefined)
}

async function launchChrome(proxyPort: number, extraArgs: string[] = []) {
  return await chromium.launch({
    executablePath: resolveChromeExecutablePath(), headless: true,
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-features=NetworkTimeServiceQuerying',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      ...extraArgs,
    ],
  })
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}

function realPage(): string {
  return '<!doctype html><html data-e2e-role="auditor"><head><title>订单搜索</title><link rel="icon" href="data:,"></head><body><main><h1>订单搜索</h1><p>真实服务正常</p></main></body></html>'
}

function injection500Page(): string {
  return `<!doctype html><html><head><title>订单故障演练</title><link rel="icon" href="data:,"></head><body>
    <main><h1>订单搜索</h1>
      <div id="virtual-list" aria-label="虚拟订单列表" style="height:160px;overflow:auto;position:relative">
        <div style="height:6400px"></div>
        <div id="virtual-window" style="position:absolute;left:0;right:0;top:0"></div>
      </div>
      <p id="status">等待查询</p>
    </main>
    <div id="portal-root"></div><script>
      const list = document.querySelector('#virtual-list'); const virtualWindow = document.querySelector('#virtual-window');
      const rowHeight = 32; const totalRows = 200; const visibleRows = 8;
      function renderVirtualOrders() {
        const start = Math.max(0, Math.min(totalRows - visibleRows, Math.floor(list.scrollTop / rowHeight)));
        virtualWindow.style.transform = 'translateY(' + (start * rowHeight) + 'px)';
        virtualWindow.replaceChildren(...Array.from({length: visibleRows}, (_, offset) => {
          const orderId = start + offset; const row = document.createElement('div');
          row.dataset.orderId = String(orderId); row.style.height = rowHeight + 'px'; row.textContent = '订单 ' + orderId;
          return row;
        }));
      }
      list.addEventListener('scroll', renderVirtualOrders); renderVirtualOrders();
      const button = document.createElement('button'); button.dataset.testid = 'search-orders'; button.textContent = '查询订单';
      document.querySelector('#portal-root').append(button);
      button.addEventListener('click', async () => {
        const response = await fetch('/api/orders/search?mode=full', {
          method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({query: 'order-100'})
        });
        document.querySelector('#status').textContent = response.ok ? '查询成功' : '服务暂不可用';
      });
    </script></body></html>`
}

function injectionTimeoutPage(): string {
  return `<!doctype html><html><head><title>订单超时演练</title><link rel="icon" href="data:,"></head><body><main>
    <h1>订单超时演练</h1><p id="status">等待查询</p><button>查询慢订单</button>
    <script>document.querySelector('button').addEventListener('click', async () => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 250);
      try {
        await fetch('/api/orders/timeout', {
          method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({query: 'slow-order'}), signal: controller.signal
        });
        document.querySelector('#status').textContent = '意外成功';
      } catch { document.querySelector('#status').textContent = '请求超时'; }
      finally { clearTimeout(timer); }
    });</script></main></body></html>`
}

function injectionMismatchPage(): string {
  return `<!doctype html><html><head><title>注入匹配失败演练</title><link rel="icon" href="data:,"></head><body><main>
    <h1>注入匹配失败演练</h1><p id="status">等待请求</p><button>发送不匹配请求</button>
    <script>document.querySelector('button').addEventListener('click', async () => {
      const response = await fetch('/api/orders/search?mode=wrong', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({query: 'wrong-order'})
      });
      document.querySelector('#status').textContent = response.status === 403 ? '网关已阻断' : '意外触达上游';
    });</script></main></body></html>`
}

function escapePage(): string {
  return '<!doctype html><html><head><title>协议逃逸演练</title><link rel="icon" href="data:,"></head><body><main><h1>协议逃逸演练</h1><p>所有探针必须由第二层 Gateway 阻断</p></main></body></html>'
}
