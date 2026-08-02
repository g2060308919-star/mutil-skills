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
})

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
      bindingStatus: 'blocked', blockerReasonCode: 'E2E_RUNTIME_PAGE_MISMATCH' }],
    remediation: ['修复页面身份后重试'],
    preflightBlocker: { status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
      blockedAt: '2026-08-02T00:00:00.000Z', attemptCount: 1, resumeState: 'preflight-readonly' },
  }
}
