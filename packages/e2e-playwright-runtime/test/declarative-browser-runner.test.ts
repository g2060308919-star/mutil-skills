import { describe, expect, test, vi } from 'vitest'
import { runDeclarativeBrowserCase } from '../src/declarative-browser-runner.js'

describe('runDeclarativeBrowserCase', () => {
  test('执行 locator 动作并重跑该动作绑定的全部 Oracle', async () => {
    const locator = {
      first() { return this },
      click: vi.fn(async () => {}),
      textContent: vi.fn(async () => '处理完成'),
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
      isChecked: vi.fn(async () => false),
    }
    const page = {
      url: vi.fn(() => 'https://example.test/orders'),
      getByTestId: vi.fn(() => locator),
      screenshot: vi.fn(async () => Buffer.from('png')),
      evaluate: vi.fn(async () => ({ format: 'dom-tree/1', roots: [] })),
    }

    const result = await runDeclarativeBrowserCase({
      page: page as never,
      testCase: {
        caseId: 'CASE-1', executionLane: 'trusted-read-only',
        pageIdentityPolicy: {
          schemaVersion: '1.0.0', url: { origin: 'https://example.test', pathPattern: '/orders' },
          signals: [{ kind: 'test-id', value: 'orders-page' }], match: { mode: 'all' },
        },
        actions: [{ kind: 'click', actionId: 'ACTION-1', effect: 'read',
          pageScope: { page: 'current', frame: { kind: 'main' } },
          locatorCandidates: [{ kind: 'test-id', value: 'submit' }],
          timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' } }],
        oracles: [
          { kind: 'text', oracleId: 'ORACLE-TEXT', actionId: 'ACTION-1',
            locatorCandidates: [{ kind: 'test-id', value: 'status' }], comparator: 'contains',
            expected: '完成', deadlineMs: 5_000, evidenceKinds: ['dom'] },
          { kind: 'url', oracleId: 'ORACLE-URL', actionId: 'ACTION-1', comparator: 'equals',
            expected: 'https://example.test/orders', deadlineMs: 5_000, evidenceKinds: ['url'] },
        ], dataNeeds: [], cleanupIntents: [],
      },
      evaluatePageIdentity: vi.fn(async () => ({ matched: true,
        url: { expectedOrigin: 'https://example.test', expectedPathPattern: '/orders',
          actual: 'https://example.test/orders', matched: true },
        signals: [], matchedSignalCount: 1, requiredSignalCount: 1 })),
    })

    expect(locator.click).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 'passed', caseId: 'CASE-1', actionId: 'ACTION-1',
      oracleResults: [{ oracleId: 'ORACLE-TEXT', passed: true }, { oracleId: 'ORACLE-URL', passed: true }] })
    expect(result.evidence.map((item) => item.kind)).toEqual(['screenshot', 'dom'])
  })

  test('页面身份变化时在动作前 fail closed', async () => {
    const click = vi.fn(async () => {})
    const result = await runDeclarativeBrowserCase({
      page: { getByTestId: () => ({ click, first() { return this } }) } as never,
      testCase: {
        caseId: 'CASE-1', executionLane: 'trusted-read-only',
        pageIdentityPolicy: { schemaVersion: '1.0.0', url: { origin: 'https://example.test', pathPattern: '/' },
          signals: [{ kind: 'test-id', value: 'home' }], match: { mode: 'all' } },
        actions: [{ kind: 'click', actionId: 'ACTION-1', effect: 'read',
          pageScope: { page: 'current', frame: { kind: 'main' } },
          locatorCandidates: [{ kind: 'test-id', value: 'submit' }],
          timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' } }],
        oracles: [{ kind: 'url', oracleId: 'ORACLE-1', actionId: 'ACTION-1', comparator: 'equals',
          expected: 'https://example.test/', deadlineMs: 5_000, evidenceKinds: ['url'] }],
        dataNeeds: [], cleanupIntents: [],
      },
      evaluatePageIdentity: vi.fn(async () => ({ matched: false,
        url: { expectedOrigin: 'https://example.test', expectedPathPattern: '/',
          actual: 'https://example.test/changed', matched: false },
        signals: [], matchedSignalCount: 0, requiredSignalCount: 1 })),
    })

    expect(result).toMatchObject({ status: 'environment-blocked',
      reasonCode: 'E2E_RUNTIME_PAGE_IDENTITY_CHANGED', oracleResults: [] })
    expect(click).not.toHaveBeenCalled()
  })

  test('download 同时验证 media type、内容摘要与结构化内容', async () => {
    const body = Buffer.from(JSON.stringify({ ok: true, rows: [1, 2] }))
    const stream = await import('node:stream').then(({ Readable }) => Readable.from([body]))
    const listeners = new Map<string, Array<(value: unknown) => void>>()
    const page = {
      url: () => 'https://example.test/export',
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      }),
      waitForEvent: vi.fn(async () => ({
        suggestedFilename: () => 'orders.json', url: () => 'https://example.test/orders.json',
        createReadStream: async () => stream,
      })),
      screenshot: vi.fn(async () => Buffer.from('png')),
      evaluate: vi.fn(async () => ({ format: 'dom-tree/1', roots: [] })),
    }
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(body).digest('hex')}`
    const testCase = {
      caseId: 'CASE-DOWNLOAD', executionLane: 'trusted-read-only' as const,
      pageIdentityPolicy: { schemaVersion: '1.0.0' as const,
        url: { origin: 'https://example.test', pathPattern: '/export' },
        signals: [{ kind: 'test-id' as const, value: 'export-page' }], match: { mode: 'all' as const } },
      actions: [{ kind: 'assert-only' as const, actionId: 'ACTION-DOWNLOAD', effect: 'read' as const,
        pageScope: { page: 'current' as const, frame: { kind: 'main' as const } },
        locatorCandidates: [], timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' as const } }],
      oracles: [{ kind: 'download' as const, oracleId: 'ORACLE-DOWNLOAD', actionId: 'ACTION-DOWNLOAD',
        fileName: 'orders.json', mediaType: 'application/json', contentDigest: digest,
        structuredContent: { ok: false, rows: [1, 2] }, deadlineMs: 5_000, evidenceKinds: ['network' as const] }],
      dataNeeds: [], cleanupIntents: [],
    }
    const run = runDeclarativeBrowserCase({ page: page as never, testCase,
      evaluatePageIdentity: async () => ({ matched: true,
        url: { expectedOrigin: 'https://example.test', expectedPathPattern: '/export',
          actual: 'https://example.test/export', matched: true },
        signals: [], matchedSignalCount: 1, requiredSignalCount: 1 }),
      runAction: async (_action, operation) => {
        for (const listener of listeners.get('response') ?? []) listener({
          url: () => 'https://example.test/orders.json',
          headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
        })
        await operation()
      } })

    await expect(run).resolves.toMatchObject({ status: 'failed',
      oracleResults: [{ oracleId: 'ORACLE-DOWNLOAD', passed: false }] })
  })

  test('AbortSignal 能立即中断 eventually 等待并返回独立取消 reason', async () => {
    const controller = new AbortController()
    const never = new Promise<void>(() => {})
    let waiting!: () => void
    const waitStarted = new Promise<void>((resolve) => { waiting = resolve })
    const locator = { first() { return this }, waitFor: vi.fn(async () => { waiting(); await never }),
      count: vi.fn(async () => 1), textContent: vi.fn(async () => 'pending') }
    const page = { url: () => 'https://example.test/orders', getByTestId: () => locator,
      screenshot: vi.fn(async () => Buffer.from('png')),
      evaluate: vi.fn(async () => ({ format: 'dom-tree/1', roots: [] })) }
    const run = runDeclarativeBrowserCase({ page: page as never, signal: controller.signal,
      evaluatePageIdentity: async () => ({ matched: true,
        url: { expectedOrigin: 'https://example.test', expectedPathPattern: '/orders',
          actual: 'https://example.test/orders', matched: true }, signals: [],
        matchedSignalCount: 1, requiredSignalCount: 1 }),
      testCase: { caseId: 'CASE-CANCEL', executionLane: 'trusted-read-only',
        pageIdentityPolicy: { schemaVersion: '1.0.0',
          url: { origin: 'https://example.test', pathPattern: '/orders' },
          signals: [{ kind: 'test-id', value: 'orders-page' }], match: { mode: 'all' } },
        actions: [{ kind: 'assert-only', actionId: 'ACTION-WAIT', effect: 'read',
          pageScope: { page: 'current', frame: { kind: 'main' } }, locatorCandidates: [],
          timeout: { timeoutMs: 60_000, retry: 'read-only-max-2' } }],
        oracles: [{ kind: 'eventually', oracleId: 'ORACLE-WAIT', actionId: 'ACTION-WAIT',
          locatorCandidates: [{ kind: 'test-id', value: 'status' }], observation: 'text',
          comparator: 'equals', expected: 'done', deadlineMs: 60_000, evidenceKinds: ['dom'] }],
        dataNeeds: [], cleanupIntents: [] } })
    await waitStarted
    controller.abort()
    await expect(run).resolves.toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_BROWSER_EXECUTOR_CANCELLED_DURING_ACTION' })
  })
})
