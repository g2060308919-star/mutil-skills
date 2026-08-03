import { describe, expect, test, vi } from 'vitest'
import { createTargetContractFact } from '../src/target-contract.js'
import {
  authorizeTargetProbe,
  runTargetProbe,
  selectTargetProbePolicy,
} from '../src/target-probe.js'

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
      strategy: 'resource-closure', attempt: 1,
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

  test('保留资源超时前的 DOM、页面文本、console、失败请求与资源闭合诊断', async () => {
    const fact = await runTargetProbe(authorizeTargetProbe(async () => ({
      status: 'environment-blocked',
      reasonCode: 'E2E_TARGET_PROBE_PENDING_SCRIPT',
      observedUrl: 'http://localhost:3000/orders',
      observedTitle: '订单',
      identityMatched: false,
      diagnostics: {
        strategy: 'resource-closure',
        attempt: 1,
        domPresent: true,
        visibleTextSummary: '订单页面正在加载',
        consoleErrors: ['ReferenceError: bootstrap is not defined'],
        failedRequests: [{
          method: 'GET', url: 'http://localhost:3000/bootstrap.js',
          resourceType: 'script', errorText: 'net::ERR_FAILED',
        }],
        pendingResources: [{ url: 'http://localhost:3000/bootstrap.js', resourceType: 'script' }],
        persistentConnections: [],
        advisories: [],
        resourceSummary: {
          observedCount: 3, approvedCount: 2, pendingCount: 1,
          persistentConnectionCount: 0, closureComplete: false,
        },
      },
    })), {
      runId: 'RUN-1', target: targetFact(), probedAt: '2026-08-02T00:00:00.000Z',
    })

    expect(fact.diagnostics).toMatchObject({
      strategy: 'resource-closure', domPresent: true,
      consoleErrors: ['ReferenceError: bootstrap is not defined'],
      resourceSummary: { pendingCount: 1, closureComplete: false },
    })
  })

  test('只读预览首次使用应用就绪，闭包失败重试按策略升级且不重复原探测', () => {
    expect(selectTargetProbePolicy({ previewReadonlyOnly: true })).toEqual({
      strategy: 'application-ready', attempt: 1,
    })
    expect(selectTargetProbePolicy({
      previewReadonlyOnly: true,
      previous: blockedProbe('E2E_TARGET_PROBE_RESOURCE_CLOSURE_LIMIT', 1),
    })).toEqual({ strategy: 'dom-identity', attempt: 2 })
    expect(selectTargetProbePolicy({
      previewReadonlyOnly: false,
      previous: blockedProbe('E2E_TARGET_PROBE_RESOURCE_CLOSURE_LIMIT', 1),
    })).toEqual({ strategy: 'application-ready', attempt: 2 })
  })
})

function blockedProbe(reasonCode: string, attempt: number) {
  return {
    reasonCode,
    diagnostics: {
      strategy: 'resource-closure' as const, attempt, domPresent: true,
      visibleTextSummary: '加载中', consoleErrors: [], failedRequests: [],
      pendingResources: [], persistentConnections: [], advisories: [],
      resourceSummary: {
        observedCount: 2, approvedCount: 1, pendingCount: 1,
        persistentConnectionCount: 0, closureComplete: false,
      },
    },
  }
}

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
