import { describe, expect, it } from 'vitest'
import type { PageIdentityPolicy, PageIdentitySignal } from '@mutil-skills/e2e-contracts'
import { evaluatePageIdentity } from '../src/page-identity-policy.js'

function policy(overrides: Partial<PageIdentityPolicy> = {}): PageIdentityPolicy {
  return {
    schemaVersion: '1.0.0',
    url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
    signals: [
      { kind: 'test-id', value: 'orders-page' },
      { kind: 'visible-text', value: '待处理订单', exact: true },
    ],
    match: { mode: 'all' },
    ...overrides,
  }
}

describe('page identity policy evaluator', () => {
  it('matches URL origin/path and every required business signal', async () => {
    const result = await evaluatePageIdentity({
      currentUrl: () => 'http://localhost:3000/orders/100?tab=detail',
      evaluateSignal: async (signal) => ({ matched: true, actual: signalLabel(signal) }),
    }, policy())

    expect(result).toEqual({
      matched: true,
      url: {
        expectedOrigin: 'http://localhost:3000',
        expectedPathPattern: '/orders/**',
        actual: 'http://localhost:3000/orders/100?tab=detail',
        matched: true,
      },
      signals: [
        { kind: 'test-id', expected: 'orders-page', actual: 'test-id:orders-page', matched: true },
        { kind: 'visible-text', expected: '待处理订单', actual: 'visible-text:待处理订单', matched: true },
      ],
      matchedSignalCount: 2,
      requiredSignalCount: 2,
    })
  })

  it('supports at-least without allowing a wrong URL to pass', async () => {
    const partial = await evaluatePageIdentity({
      currentUrl: () => 'http://localhost:3000/orders',
      evaluateSignal: async (signal) => ({
        matched: signal.kind === 'test-id', actual: signal.kind === 'test-id' ? 'present' : 'missing',
      }),
    }, policy({ match: { mode: 'at-least', count: 1 } }))
    expect(partial.matched).toBe(true)
    expect(partial.matchedSignalCount).toBe(1)

    const wrongOrigin = await evaluatePageIdentity({
      currentUrl: () => 'http://localhost:4000/orders',
      evaluateSignal: async () => ({ matched: true, actual: 'present' }),
    }, policy({ match: { mode: 'at-least', count: 1 } }))
    expect(wrongOrigin.matched).toBe(false)
    expect(wrongOrigin.url.matched).toBe(false)
  })

  it('treats a signal query error as a failed signal with a bounded diagnostic', async () => {
    const result = await evaluatePageIdentity({
      currentUrl: () => 'http://localhost:3000/orders',
      evaluateSignal: async (signal) => {
        if (signal.kind === 'visible-text') throw new Error('locator timed out with private DOM details')
        return { matched: true, actual: 'present' }
      },
    }, policy())
    expect(result.matched).toBe(false)
    expect(result.signals[1]).toEqual({
      kind: 'visible-text', expected: '待处理订单', actual: 'query-error', matched: false,
    })
  })
})

function signalLabel(signal: PageIdentitySignal): string {
  if (signal.kind === 'role') return `role:${signal.role}:${signal.name}`
  if (signal.kind === 'css-visible') return `css-visible:${signal.selector}`
  return `${signal.kind}:${signal.value}`
}
