import { describe, expect, test } from 'vitest'
import { renderRunStatus } from '../src/run-status.js'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('run status renderer', () => {
  test('一份事实同源渲染 JSON/Markdown/HTML，明确阻断不是业务失败', () => {
    const rendered = renderRunStatus(statusFixture())

    expect(JSON.parse(rendered.json)).toMatchObject({
      condition: { kind: 'blocked-retryable', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH' },
    })
    expect(rendered.markdown).toContain('中间状态（非最终结论）')
    expect(rendered.markdown).toContain('环境阻断')
    expect(rendered.markdown).toContain('未执行')
    expect(rendered.markdown).toContain('gateway-api')
    expect(rendered.markdown).toContain('orders-page')
    expect(rendered.markdown).not.toContain('业务失败\n')
    expect(rendered.html).toContain('<!doctype html>')
    expect(rendered.html).toContain('环境阻断')
    expect(rendered.html).not.toMatch(/https?:\/\/(?:cdn|unpkg|jsdelivr)/)
  })

  test('HTML 转义业务文本且不执行状态内容', () => {
    const status = statusFixture() as any
    status.semanticCases[0].title = '<img src=x onerror=alert(1)>'
    const rendered = renderRunStatus(status)
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(rendered.html).not.toContain('<img src=x')
  })

  test('可视化展示 PRD 原文到 Requirement、Rule、Oracle、Case 的真实语义', () => {
    const status = statusFixture() as any
    status.acceptanceReview = acceptanceReviewFixture()
    status.acceptanceReviewConfirmation = { status: 'required' }

    const rendered = renderRunStatus(status)
    for (const expected of ['用户可以下单', '用户下单', '提交有效订单后创建订单', '订单可见', '下单']) {
      expect(rendered.markdown).toContain(expected)
      expect(rendered.html).toContain(expected)
    }
  })

  test('目标阻断时展示页面快照、资源分类、恢复动作并明确业务 Case 未执行', () => {
    const status = statusFixture() as any
    status.condition = { kind: 'blocked-retryable',
      reasonCode: 'E2E_TARGET_PROBE_RESOURCE_TIMEOUT', resumeStage: 'target-probe' }
    status.stage = 'target-probe'
    status.targetProbe = {
      schemaVersion: '1.0.0', trust: 'untrusted-diagnostic', runId: 'RUN-1',
      targetContractDigest: d('6'), status: 'environment-blocked',
      reasonCode: 'E2E_TARGET_PROBE_RESOURCE_TIMEOUT',
      observedUrl: 'http://localhost:3000/orders', observedTitle: '订单预览',
      identityMatched: false, probedAt: '2026-08-03T00:00:00.000Z', diagnosticDigest: d('7'),
      diagnostics: {
        strategy: 'resource-closure', attempt: 1, domPresent: true,
        visibleTextSummary: '订单工作台正在加载',
        consoleErrors: ['[pageerror] bootstrap failed'],
        failedRequests: [{ method: 'GET', url: 'http://localhost:3000/app.js',
          resourceType: 'script', errorText: 'net::ERR_FAILED' }],
        pendingResources: [{ url: 'http://localhost:3000/hmr', resourceType: 'fetch' }],
        persistentConnections: [{ url: 'ws://localhost:3000/hmr', resourceType: 'websocket' }],
        advisories: ['E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION'],
        resourceSummary: { observedCount: 4, approvedCount: 2, pendingCount: 1,
          persistentConnectionCount: 1, closureComplete: false },
      },
    }
    status.remediation = ['对同一 Run 执行 retry，自动切换 application-ready 策略。']

    const rendered = renderRunStatus(status)
    for (const expected of [
      '目标探测诊断', '订单预览', '订单工作台正在加载', 'bootstrap failed',
      'closureComplete', 'application-ready', 'ws://localhost:3000/hmr',
      'E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION',
    ]) {
      expect(rendered.markdown).toContain(expected)
      expect(rendered.html).toContain(expected)
    }
    expect(rendered.markdown).toContain('业务动作：未执行')
    expect(rendered.markdown).toContain('Attempt：1')
    expect(rendered.html).toContain('<dt>业务动作</dt><dd>未执行</dd>')
    expect(rendered.html).toContain('<dt>Attempt</dt><dd>1</dd>')
  })
})

function acceptanceReviewFixture() {
  return {
    schemaVersion: '1.0.0', runId: 'RUN-1', contractProjectionDigest: d('a'), compilerDigest: d('b'),
    links: [{ clauseId: 'CLAUSE-1', sourceSpan: { sourceId: 'PRD', startLine: 1,
      startColumn: 1, endLine: 1, endColumn: 8 }, sourceText: '用户可以下单', disposition: 'modeled',
    requirementIds: ['REQ-1'], ruleIds: ['RULE-1'], oracleIds: ['ORACLE-1'], caseIds: ['CASE-1'] }],
    semanticCatalog: {
      requirements: [{ reqId: 'REQ-1', title: '用户下单', actors: ['USER'],
        preconditions: ['已登录'], contractNodeIds: ['NODE-1'] }],
      rules: [{ ruleId: 'RULE-1', reqId: 'REQ-1', category: 'business',
        statement: '提交有效订单后创建订单', certainty: 'explicit', oracleIds: ['ORACLE-1'] }],
      oracles: [{ oracleId: 'ORACLE-1', reqId: 'REQ-1', ruleId: 'RULE-1', statement: '订单可见' }],
      obligations: [{ obligationId: 'OBL-1', reqId: 'REQ-1', scenario: '提交有效订单',
        necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'] }],
      cases: [{ caseId: 'CASE-1', title: '下单', actor: 'USER', contractNodeIds: ['NODE-1'],
        actions: [{ actionId: 'ACTION-1', statement: '点击提交', effect: 'reversible-write' }],
        oracles: [{ oracleId: 'CASE-ORACLE-1', acceptanceCriterion: '订单可见' }] }],
    },
    includedClauseIds: ['CLAUSE-1'], excludedClauseIds: [], unresolvedItems: [], reviewDigest: d('c'),
  }
}

function statusFixture() {
  return {
    runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('1'),
    runtimeInstallationDigest: d('2'), generationId: 'RUN-1', prdRevision: d('3'),
    workflow: { current: 'preflight-readonly', sequence: 6, eventChainDigest: d('4') },
    artifactDigests: { 'prd-source': d('3') }, state: 'preflight-readonly',
    nextEdge: { command: 'run-preflight', from: 'preflight-readonly', expectedState: 'preflight-readonly' },
    verifiedDigests: { runtimeInstallation: d('2'), workflowEventChain: d('4') },
    minimumMissingInput: ['browser-preflight-retry:E2E_RUNTIME_PAGE_MISMATCH'],
    handle: { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('5') },
    stage: 'preflight', condition: { kind: 'blocked-retryable',
      reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', resumeStage: 'preflight' },
    preservedAssets: ['prd-source', 'compiled-prd-run'], invalidatedAssets: [],
    semanticCases: [{ caseId: 'CASE-1', title: '创建订单', actor: 'USER',
      contractNodeIds: ['REQ-1'], oracleIds: ['ORACLE-1'], executionLane: 'real-reversible-write',
      fixture: { actorRef: 'USER', preconditions: [{ kind: 'business-state', statement: '存在测试订单' }],
        seedStrategy: 'gateway-api', dataLease: { leaseKey: 'LEASE-1', scope: 'order', expiresAfterSeconds: 600 },
        cleanup: { kind: 'gateway-api', statement: '删除测试订单' },
        reloadVerification: [{ statement: '刷新后测试订单不存在' }] },
      pageIdentityPolicy: { schemaVersion: '1.0.0',
        url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
        signals: [{ kind: 'test-id', value: 'orders-page' }], match: { mode: 'all' } },
      locatorCandidates: [{ kind: 'test-id', value: 'create-order' }],
      bindingStatus: 'blocked', blockerReasonCode: 'E2E_RUNTIME_PAGE_MISMATCH' }],
    remediation: ['修复页面身份后重试'],
    preflightBlocker: { status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
      blockedAt: '2026-08-02T00:00:00.000Z', attemptCount: 1, resumeState: 'preflight-readonly' },
  }
}
