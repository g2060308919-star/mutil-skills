import { describe, expect, it } from 'vitest'
import {
  E2ECaseExecutionSchema,
  PageIdentityPolicySchema,
  RunConditionSchema,
  RunHandleSchema,
  SourceRoleSchema,
  normalizeTargetUrl,
} from '../src/e2e-flow.js'

const digest = `sha256:${'a'.repeat(64)}`

describe('E2E flow contracts', () => {
  it('normalizes only explicit local host targets that omit a scheme', () => {
    expect(normalizeTargetUrl('localhost:3000/orders')).toBe('http://localhost:3000/orders')
    expect(normalizeTargetUrl('127.0.0.1:4173')).toBe('http://127.0.0.1:4173/')
    expect(normalizeTargetUrl('https://example.test/orders')).toBe('https://example.test/orders')
    expect(() => normalizeTargetUrl('localhost：3000')).toThrowError(/全角标点/)
    expect(() => normalizeTargetUrl('example.test/orders')).toThrowError(/scheme/)
  })

  it('requires URL binding plus a stable business signal for page identity', () => {
    expect(PageIdentityPolicySchema.safeParse({
      schemaVersion: '1.0.0',
      url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
      signals: [{ kind: 'visible-text', value: '确定', exact: false }],
      match: { mode: 'all' },
    }).success).toBe(false)

    expect(PageIdentityPolicySchema.parse({
      schemaVersion: '1.0.0',
      url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
      signals: [
        { kind: 'test-id', value: 'orders-page' },
        { kind: 'visible-text', value: '待处理订单', exact: true },
      ],
      match: { mode: 'at-least', count: 1 },
    }).signals).toHaveLength(2)
  })

  it.each([
    'script[data-run="x"]',
    '//main/h1',
    'main::before',
    'main:has(button)',
    'main, body',
  ])('rejects selector syntax outside the declarative CSS subset: %s', (selector) => {
    const parsed = PageIdentityPolicySchema.safeParse({
      schemaVersion: '1.0.0',
      url: { origin: 'https://example.test', pathPattern: '/orders' },
      signals: [
        { kind: 'test-id', value: 'orders-page' },
        { kind: 'css-visible', selector },
      ],
      match: { mode: 'all' },
    })
    expect(parsed.success).toBe(false)
  })

  it('requires lease, cleanup and reload proof for real reversible writes', () => {
    const incomplete = E2ECaseExecutionSchema.safeParse({
      executionLane: 'real-reversible-write',
      fixture: {
        actorRef: 'actor-1',
        preconditions: [],
        seedStrategy: 'browser-ui',
      },
      locatorCandidates: [],
      pageIdentityPolicy: {
        schemaVersion: '1.0.0',
        url: { origin: 'https://example.test', pathPattern: '/orders' },
        signals: [{ kind: 'test-id', value: 'orders-page' }],
        match: { mode: 'all' },
      },
    })
    expect(incomplete.success).toBe(false)

    const complete = E2ECaseExecutionSchema.parse({
      executionLane: 'real-reversible-write',
      fixture: {
        actorRef: 'actor-1',
        preconditions: [{ kind: 'business-state', statement: '订单存在且未审批' }],
        seedStrategy: 'browser-ui',
        dataLease: { leaseKey: 'order-100', scope: 'order', expiresAfterSeconds: 900 },
        cleanup: { kind: 'browser-ui', statement: '删除测试订单' },
        reloadVerification: [{ statement: '刷新后测试订单不存在' }],
      },
      locatorCandidates: [{ kind: 'test-id', value: 'approve-order' }],
      pageIdentityPolicy: {
        schemaVersion: '1.0.0',
        url: { origin: 'https://example.test', pathPattern: '/orders/**' },
        signals: [{ kind: 'test-id', value: 'orders-page' }],
        match: { mode: 'all' },
      },
    })
    expect(complete.executionLane).toBe('real-reversible-write')
  })

  it('keeps simulated fixtures out of real execution lanes', () => {
    const parsed = E2ECaseExecutionSchema.safeParse({
      executionLane: 'injection-simulated',
      fixture: {
        actorRef: 'actor-1',
        preconditions: [],
        seedStrategy: 'pre-existing',
      },
      locatorCandidates: [],
      pageIdentityPolicy: {
        schemaVersion: '1.0.0',
        url: { origin: 'https://example.test', pathPattern: '/' },
        signals: [{ kind: 'test-id', value: 'home-page' }],
        match: { mode: 'all' },
      },
    })
    expect(parsed.success).toBe(false)
  })

  it('binds public operations to a complete run handle and structured condition', () => {
    const handle = RunHandleSchema.parse({
      assetId: 'ASSET-1', runId: 'RUN-1', revision: 3, generationDigest: digest,
    })
    expect(handle.revision).toBe(3)
    expect(RunHandleSchema.safeParse({ ...handle, generationDigest: undefined }).success).toBe(false)
    expect(RunConditionSchema.parse({
      kind: 'blocked-retryable', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', resumeStage: 'preflight',
    }).kind).toBe('blocked-retryable')
    expect(SourceRoleSchema.options).toEqual([
      'requirements-source', 'target-application', 'supporting-reference', 'fixture-source',
    ])
  })
})
