import { describe, expect, test, vi } from 'vitest'
import { createTargetContractFact } from '../src/target-contract.js'
import { authorizeTargetProbe, runTargetProbe } from '../src/target-probe.js'

describe('Target Probe', () => {
  test('只使用 opaque 受控浏览器 capability，产物永远标记为非权威诊断', async () => {
    const backend = vi.fn(async () => ({
      status: 'ready' as const,
      observedUrl: 'http://localhost:3000/orders',
      observedTitle: '订单',
      identityMatched: true,
    }))
    const fact = await runTargetProbe(authorizeTargetProbe(backend), {
      runId: 'RUN-1', target: targetFact(), probedAt: '2026-08-02T00:00:00.000Z',
    })

    expect(backend).toHaveBeenCalledWith({
      runId: 'RUN-1', contract: targetFact().contract,
    })
    expect(fact).toMatchObject({
      trust: 'untrusted-diagnostic', status: 'ready', identityMatched: true,
      targetContractDigest: targetFact().contractDigest,
    })
    expect(fact).not.toHaveProperty('evidence')
  })

  test('拒绝伪造 capability 和跨 origin 观测', async () => {
    await expect(runTargetProbe({} as never, {
      runId: 'RUN-1', target: targetFact(), probedAt: '2026-08-02T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'E2E_TARGET_PROBE_CAPABILITY_INVALID' })
    await expect(runTargetProbe(authorizeTargetProbe(async () => ({
      status: 'ready', observedUrl: 'https://evil.example/orders', observedTitle: '伪造',
      identityMatched: true,
    })), {
      runId: 'RUN-1', target: targetFact(), probedAt: '2026-08-02T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'E2E_TARGET_PROBE_ORIGIN_MISMATCH' })
  })
})

function targetFact() {
  return createTargetContractFact({
    schemaVersion: '1.0.0', targetUrl: 'http://localhost:3000/orders',
    baseOrigin: 'http://localhost:3000', environmentLabel: 'local',
    pageIdentityPolicy: {
      schemaVersion: '1.0.0', url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
      signals: [{ kind: 'test-id', value: 'orders-page' }], match: { mode: 'all' },
    },
    allowedNavigationOrigins: ['http://localhost:3000'],
  })
}
