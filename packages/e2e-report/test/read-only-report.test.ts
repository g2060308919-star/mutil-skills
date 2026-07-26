import { describe, expect, test } from 'vitest'
import type { VerdictResult } from '@mutil-skills/e2e-contracts'
import { renderReadOnlyReport } from '../src/index.js'

const verdict: VerdictResult = {
  verdictRuleVersion: '1.0.0',
  verdict: 'incomplete',
  reasonCodes: ['VERDICT_REQUIRED_CASE_INCOMPLETE'],
  cannotClaim: ['不能宣称本次验收范围已全部通过'],
  businessFailuresObserved: [],
  advisoryFailures: [],
  metrics: {
    clauseDispositionCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    requirementDesignCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    ruleCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    oracleCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    caseDesignCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    criticalNodeCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    roleCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    stateTransitionCoverage: { status: 'not-applicable', numerator: 0, denominator: 0, reason: '没有状态转换' },
    scenarioCategoryCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
    automationDispositionCoverage: { status: 'value', numerator: 1, denominator: 2, percentage: 50 },
    executionCoverage: { status: 'value', numerator: 1, denominator: 2, percentage: 50 },
    realPassRate: { status: 'not-applicable', numerator: 0, denominator: 0, reason: '没有已执行的必要 Case' },
    injectionPassRate: { status: 'not-applicable', numerator: 0, denominator: 0, reason: '没有注入 Case' },
    evidenceCompleteness: { status: 'value', numerator: 1, denominator: 2, percentage: 50 },
    cleanupSuccess: { status: 'not-applicable', numerator: 0, denominator: 0, reason: '没有清理任务' },
    blockingRate: { status: 'value', numerator: 1, denominator: 2, percentage: 50 },
  },
}

describe('renderReadOnlyReport', () => {
  test('renders the Engine verdict to Markdown and safe offline HTML', () => {
    const report = renderReadOnlyReport({
      assetId: 'PRODUCT/PRD-1',
      prdRevision: `sha256:${'a'.repeat(64)}`,
      generationId: 'GENERATION-1',
      title: '<script>alert(1)</script> 订单验收',
      verdict,
      cases: [{ caseId: 'CASE-1', title: '展示订单', status: 'input-blocked', evidenceLinks: ['evidence/CASE-1.png'] }],
    })

    expect(report.markdown).toContain('最终状态：incomplete')
    expect(report.markdown).toContain('不能宣称本次验收范围已全部通过')
    expect(report.markdown).toContain('执行覆盖率：50.00%（1/2）')
    expect(report.markdown).toContain('真实链路通过率：不适用（没有已执行的必要 Case）')
    expect(report.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(report.html).not.toContain('<script>alert(1)</script>')
    expect(report.html).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/)
    expect(report.html).toContain('href="evidence/CASE-1.png"')
    expect(report.markdown).toContain('[evidence/CASE-1.png](evidence/CASE-1.png)')
    expect(() => renderReadOnlyReport({
      assetId: 'ASSET-1', prdRevision: `sha256:${'a'.repeat(64)}`, generationId: 'GEN-1', title: 'unsafe', verdict,
      cases: [{ caseId: 'CASE-1', title: 'case', status: 'passed', evidenceLinks: ['../outside.txt'] }],
    })).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_EVIDENCE_LINK_INVALID' }))
  })
})
