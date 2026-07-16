import { describe, expect, test } from 'vitest'
import { renderPartitionedExecutionReport } from '../src/index.js'

describe('renderPartitionedExecutionReport', () => {
  test('keeps real and injection results separate and states the injection proof boundary', () => {
    const report = renderPartitionedExecutionReport({
      assetId: 'PRODUCT-PRD-1', prdRevision: `sha256:${'a'.repeat(64)}`, generationId: 'GEN-1',
      realResults: [{ caseId: 'CASE-REAL', title: '真实列表', status: 'passed' }],
      injectionResults: [{ caseId: 'CASE-INJECT', title: '500 <script>', status: 'passed' }],
      injectionBoundary: '仅证明前端面对已签名模拟响应时的行为，不证明真实后端故障行为。',
    })

    expect(report.markdown).toContain('## 真实环境结果')
    expect(report.markdown).toContain('## Gateway 故障注入结果')
    expect(report.markdown).toContain('不证明真实后端故障行为')
    expect(report.html).toContain('500 &lt;script&gt;')
    expect(report.html).not.toContain('<script>')
  })
})
