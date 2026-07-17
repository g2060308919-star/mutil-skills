import { describe, expect, test, vi } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { projectionFixture } from './trusted-action-runner.test.js'
import { ControlledBrowserHost, type BrowserHostDriver } from '../src/browser-host.js'
import { TrustedActionRunner, TrustedReadActionProjector } from '../src/trusted-action-runner.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('read-only Runtime vertical flow', () => {
  test('executes a projected action through trusted Browser/Gateway/Authority seams without loading generated source', async () => {
    const roots = await createRuntimeTestRoots()
    const projection = projectionFixture()
    const action = new TrustedReadActionProjector().project(projection)
    const counters = { received: 0, forwarded: 0, blocked: 0, injected: 0, byIntent: {} }
    const driver = fakeReadDriver()
    const gateway = fakeGateway(counters)
    const browser = await new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId: 'RUN-1', installation: browserInstallation(), gateway: gateway as never,
    })
    const completed: string[] = []
    const flow = await new TrustedActionRunner().executeReadOnly({
      action, grant: projection.grant, currentSubject: projection.currentSubject,
      authority: {
        async reserveForSubject(input) {
          return {
            reservationId: `RES-${input.capabilityId}`, grantId: projection.grant.grantId,
            capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
            status: 'reserved' as const, reservedAt: '2026-07-17T00:00:00.000Z',
          }
        },
        async complete(reservationId) { completed.push(reservationId) },
        async markUnknown() {},
      },
      browser, gateway: gateway.handle as never, attemptId: 'ATTEMPT-1',
    })

    expect(flow.result).toMatchObject({ caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed' })
    expect(flow.evidence?.screenshot.byteLength).toBeGreaterThan(0)
    expect(Buffer.from(flow.evidence?.dom ?? []).toString('utf8')).toContain('待审核订单')
    expect(counters.forwarded).toBeGreaterThan(0)
    expect(counters.blocked).toBeGreaterThan(0)
    expect(completed).toHaveLength(3)
    expect([]).toEqual([]) // Runtime authoritative path never loads generated source files.
    await browser.close()
  })

  test('rejects a structurally identical but non-projector action', async () => {
    const projection = projectionFixture()
    const action = new TrustedReadActionProjector().project(projection)
    await expect(new TrustedActionRunner().executeReadOnly({
      action: structuredClone(action), grant: projection.grant, currentSubject: projection.currentSubject,
      authority: {} as never, browser: {} as never, gateway: {} as never, attemptId: 'ATTEMPT-1',
    })).rejects.toThrow(/E2E_RUNTIME_READ_ACTION_UNTRUSTED/)
  })
})

function browserInstallation() {
  return {
    root: '/browser', executablePath: '/browser/chromium-1234/chrome',
    manifest: {
      runtimeInstallationDigest: digest('i'), closureDigest: digest('b'), executableDigest: digest('e'),
    },
  } as never
}

function fakeGateway(counters: { received: number; forwarded: number; blocked: number }) {
  const measurement = { gatewaySessionMeasurementDigest: digest('g') }
  const handle = {
    endpoint: 'http://127.0.0.1:43111',
    caSpkiFingerprint: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=', measurement,
    auditSummary: () => ({ ...counters, injected: 0, byIntent: {} }),
  }
  return {
    handle,
    browserBinding: {
      gatewaySessionMeasurementDigest: digest('g'),
      async continueCorrelatedRequest(_input: unknown, continuation: { continueWithHeaders(headers: Record<string, string>): Promise<void> }) {
        counters.received += 1; counters.forwarded += 1
        await continuation.continueWithHeaders({ 'x-trusted': '1' })
      },
      async runCanary(input: any) {
        expect((await input.executeThroughControlledBrowser({
          url: 'http://canary.test/approved',
          correlation: {
            ruleId: digest('1'), stepOrdinal: 1, method: 'GET', channel: 'http', bodyDigest: digest('2'),
            actionId: 'CANARY', capabilityId: 'CANARY-CAP',
          },
        })).status).toBe(204)
        expect((await input.executeThroughControlledBrowser({ url: 'http://canary.test/denied' })).status).toBe(403)
        counters.blocked += 1
        return { approved: true, denied: true, proofDigest: digest('c') }
      },
    },
  }
}

function fakeReadDriver(): BrowserHostDriver {
  let interceptor: ((request: any) => Promise<void>) | undefined
  let profile = ''
  let currentUrl = 'about:blank'
  const context: any = {
    async newCDPSession() {
      return {
        async send() { return { documents: [], strings: ['待审核订单'] } },
        async detach() {},
      }
    },
  }
  const navigate = async (url: string) => {
    let trusted = false
    await interceptor!({
      url, method: 'GET', headers: {}, isNavigationRequest: true, isMainFrame: true, resourceType: 'document',
      continueWithHeaders: async (headers: Record<string, string>) => { trusted = headers['x-trusted'] === '1' },
      abort: async () => undefined,
    })
    currentUrl = url
    return trusted
  }
  const locator = (selector: string): any => ({
    first: () => locator(selector),
    count: async () => 1,
    getAttribute: async () => selector === 'html' ? 'auditor' : null,
    textContent: async () => '订单列表',
    allTextContents: async () => ['订单列表'],
  })
  const page: any = {
    async goto(url: string) { await navigate(url); return undefined },
    url: () => currentUrl,
    title: async () => '订单',
    locator,
    getByText: () => ({ count: async () => 1 }),
    screenshot: async () => new Uint8Array([1, 2, 3]),
    context: () => context,
  }
  return {
    page, context,
    async launch(profileDir) { profile = profileDir },
    async actualCommandLine() {
      return [
        'chromium', '--disable-quic', '--disable-extensions', '--disable-background-networking',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-server=http://127.0.0.1:43111', '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--ignore-certificate-errors-spki-list=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
        `--user-data-dir=${profile}`,
      ]
    },
    async installRequestInterceptor(handler) { interceptor = handler },
    async requestThroughPage(url) { return { status: await navigate(url) ? 204 : 403 } },
    async close() {},
    isClosed: () => true,
  }
}
