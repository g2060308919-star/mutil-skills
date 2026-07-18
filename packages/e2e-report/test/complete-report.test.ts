import { describe, expect, test } from 'vitest'
import { deriveExecutionResultId } from '@mutil-skills/e2e-contracts'
import * as reportModule from '../src/index.js'
import { finalReportFixture as finalReport } from './final-report.fixture.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('renderCompleteReport', () => {
  test('从 final-report artifact 生成固定顺序的 JSON、Markdown 和离线 HTML', () => {
    const render = (reportModule as unknown as {
      renderCompleteReport(input: unknown): { json: string; markdown: string; html: string }
    }).renderCompleteReport

    expect(render).toBeTypeOf('function')
    const report = render(finalReport)
    const headings = [
      '结论与不能宣称', 'PRD、范围、执行、审批与代际摘要', '环境、浏览器、角色与数据租约',
      '覆盖 Universe 与指标', '排除、N/A、Manual、Declined 与 Blocked', '端到端追踪矩阵',
      '真实链路结果', '故障注入结果', 'Case 详情', 'Network Gateway 审计', '浏览器健康发现',
      '诊断、自愈与重试', '写入副作用与清理', '回归资产与独立执行', '剩余风险与建议动作',
      'Runtime 与隔离证明',
    ]
    let previous = -1
    for (const heading of headings) {
      const index = report.markdown.indexOf(`## ${heading}`)
      expect(index, heading).toBeGreaterThan(previous)
      previous = index
      expect(report.html).toContain(`>${heading}</h2>`)
    }
    expect(JSON.parse(report.json)).toEqual(finalReport)
    expect(report.markdown).toContain('不能宣称全部必要 Case 已可靠执行')
    expect(report.markdown).toContain('不适用（无状态转换）')
    expect(report.markdown).toContain('COV-1')
    expect(report.markdown).toContain('范围审批')
    expect(report.markdown).toContain('测试域：prd-e2e-trusted-compiler')
    expect(report.markdown).toContain('执行 Profile：trusted-read-only')
    expect(report.html).toContain('执行审批')
    expect(report.html).toContain('测试域：prd-e2e-trusted-compiler')
    expect(report.html).toContain('执行 Profile：trusted-read-only')
    expect(report.html).toContain('业务失败（已观测）')
    expect(report.markdown).toContain('REQ-1')
    expect(report.markdown).toContain('evidence/CASE-REAL-1.png')
    expect(report.markdown).toContain('Runtime installation：sha256:')
    expect(report.markdown).toContain('源码仓库独立：是')
    expect(report.markdown).not.toMatch(/\/(?:Users|home|private|tmp)\//)
    expect(report.html).not.toMatch(/\/(?:Users|home|private|tmp)\//)
  })

  test('HTML 支持可访问筛选、原生展开与打印，且不加载远程资源', () => {
    const render = (reportModule as unknown as {
      renderCompleteReport(input: unknown): { json: string; markdown: string; html: string }
    }).renderCompleteReport
    const report = render(finalReport)

    expect(report.html).toContain('id="case-search"')
    expect(report.html).toContain('for="case-search"')
    expect(report.html).toContain('id="case-status"')
    expect(report.html).toContain('id="case-mode"')
    expect(report.html).toContain('aria-live="polite"')
    expect(report.html).toContain('<details')
    expect(report.html).toContain('<summary>')
    expect(report.html).toContain('data-case-status="passed"')
    expect(report.html).toContain('data-case-mode="real-environment"')
    expect(report.html).toContain('@media print')
    expect(report.html).toContain('window.print()')
    expect(report.html).toContain('beforeprint')
    expect(report.html).toContain('Content-Security-Policy')
    expect(report.html).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)=["']https?:/i)
    expect(report.html).not.toContain('<script>alert(1)</script>')
    expect(report.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('Case expected/actual/oracle 等不可信文本在 Markdown 和 HTML 中统一转义', () => {
    const render = (reportModule as unknown as {
      renderCompleteReport(input: unknown): { markdown: string; html: string }
    }).renderCompleteReport
    const malicious = structuredClone(finalReport)
    malicious.content.caseDetails[0]!.steps[0]!.actual = '<img src=x onerror=alert(1)>'
    malicious.content.caseDetails[0]!.steps[0]!.expected = '| 伪造表格 |'

    const report = render(malicious)
    expect(report.html).not.toContain('<img src=x onerror=alert(1)>')
    expect(report.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(report.markdown).not.toContain('| <img src=x onerror=alert(1)> |')
    expect(report.markdown).toContain('\\| 伪造表格 \\|')
  })

  test('不安全 evidence link fail-closed，JSON 往返渲染保持稳定', () => {
    const render = (reportModule as unknown as {
      renderCompleteReport(input: unknown): { json: string; markdown: string; html: string }
    }).renderCompleteReport
    const first = render(finalReport)
    expect(render(JSON.parse(first.json))).toEqual(first)

    const unsafe = structuredClone(finalReport)
    unsafe.content.caseDetails[0]!.steps[0]!.evidenceLinks = ['javascript:alert(1)']
    expect(() => render(unsafe)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))
  })

  test('拒绝结果分区、追踪链或回归摘要自相矛盾的 final-report', () => {
    const render = (reportModule as unknown as { renderCompleteReport(input: unknown): unknown }).renderCompleteReport
    const inconsistent = structuredClone(finalReport)
    inconsistent.content.realResults = [{ id: 'CASE-INJECT-1', digest: digest('e') }]
    inconsistent.content.regressionDetails.manifestDigest = digest('0')
    inconsistent.content.traceabilityMatrix[0]!.stepId = 'STEP-NOT-IN-CASE'

    expect(() => render(inconsistent)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))

    const legacyShape = structuredClone(finalReport)
    legacyShape.schemaVersion = '1.0.0'
    expect(() => render(legacyShape)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))

    const duplicateApproval = structuredClone(finalReport)
    duplicateApproval.content.approvals[1]!.kind = 'scope'
    expect(() => render(duplicateApproval)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))

    const brokenUniverse = structuredClone(finalReport)
    brokenUniverse.content.coverageUniverse.obligations[0]!.caseIds = ['CASE-NOT-FOUND']
    expect(() => render(brokenUniverse)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))
  })

  test('拒绝没有同 Case 已通过真实基线的注入结果', () => {
    const render = (reportModule as unknown as { renderCompleteReport(input: unknown): unknown }).renderCompleteReport
    const missingBaseline = structuredClone(finalReport)
    delete missingBaseline.content.caseDetails[1]!.baselineResultId
    expect(() => render(missingBaseline)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))

    const wrongCase = structuredClone(finalReport)
    wrongCase.content.caseDetails[1]!.caseId = 'CASE-OTHER'
    expect(() => render(wrongCase)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))
  })

  test('手工 Case 可进入报告，但不得被冒充为可独立执行的自动化回归 Case', () => {
    const render = (reportModule as unknown as { renderCompleteReport(input: unknown): { markdown: string } }).renderCompleteReport
    const withManualCase = structuredClone(finalReport)
    withManualCase.content.caseDetails.push({
      resultId: 'MANUAL-1', caseId: 'CASE-MANUAL-1', title: '人工视觉复核', executionMode: 'manual',
      necessity: 'required', status: 'passed',
      preconditions: ['复核人员已授权'], steps: [],
    })

    expect(render(withManualCase).markdown).toContain('CASE-MANUAL-1')
    withManualCase.content.regressionDetails.caseIds.push('CASE-MANUAL-1')
    expect(() => render(withManualCase)).toThrowError(expect.objectContaining({ code: 'E2E_REPORT_INPUT_INVALID' }))
  })

  test('在 1000 Case 性能基线下 5 秒内完成三种报告渲染', () => {
    const render = (reportModule as unknown as {
      renderCompleteReport(input: unknown): { json: string; markdown: string; html: string }
    }).renderCompleteReport
    const largeReport = structuredClone(finalReport)
    const cases = Array.from({ length: 1_000 }, (_, index) => {
      const ordinal = index + 1
      return {
        resultId: deriveExecutionResultId(`CASE-LOAD-${ordinal}`, 'real-environment'),
        caseId: `CASE-LOAD-${ordinal}`, title: `性能基线 ${ordinal}`, executionMode: 'real-environment',
        necessity: 'required', status: 'passed', preconditions: ['基线前置'],
        steps: [{
          stepId: `STEP-LOAD-${ordinal}`, action: '打开页面', expected: '页面可见', actual: '页面可见',
          oracle: 'heading', status: 'passed', evidenceLinks: [`evidence/CASE-LOAD-${ordinal}.png`],
        }],
      }
    })
    largeReport.content.caseDetails = cases
    largeReport.content.realResults = cases.map((item) => ({ id: item.resultId, digest: digest('e') }))
    largeReport.content.injectionResults = []
    largeReport.content.regressionDetails.caseIds = cases.map((item) => item.caseId)
    largeReport.content.coverageUniverse.obligations = cases.map((item, index) => ({
      obligationId: `COV-LOAD-${index + 1}`, title: item.title, necessity: 'required',
      disposition: 'automated', caseIds: [item.caseId],
    }))
    largeReport.content.traceabilityMatrix = cases.map((item, index) => ({
      reqId: 'REQ-1', ruleId: 'RULE-1', obligationId: `COV-LOAD-${index + 1}`, caseId: item.caseId,
      stepId: item.steps[0]!.stepId, evidenceId: `EVIDENCE-LOAD-${index + 1}`,
      evidencePath: item.steps[0]!.evidenceLinks[0]!,
    }))

    const startedAt = performance.now()
    const rendered = render(largeReport)
    const durationMs = performance.now() - startedAt

    expect(durationMs).toBeLessThan(5_000)
    expect(rendered.json).toContain('CASE-LOAD-1000')
    expect(rendered.markdown).toContain('CASE-LOAD-1000')
    expect(rendered.html).toContain('CASE-LOAD-1000')
  }, 10_000)
})
