import { E2EError, VerdictResultSchema, type Metric, type VerdictResult } from '@mutil-skills/e2e-contracts'

export interface ReadOnlyReportInput {
  assetId: string
  prdRevision: string
  generationId: string
  title: string
  verdict: VerdictResult
  cases: Array<{
    caseId: string
    title: string
    status: string
    evidenceLinks: string[]
  }>
}

export interface RenderedReport {
  markdown: string
  html: string
}

export function renderReadOnlyReport(input: ReadOnlyReportInput): RenderedReport {
  const parsedVerdict = VerdictResultSchema.safeParse(input.verdict)
  if (!parsedVerdict.success) {
    throw reportError('E2E_REPORT_VERDICT_INVALID', '报告只能渲染通过严格 Schema 的 Engine Verdict')
  }
  const verdict = parsedVerdict.data
  const cases = input.cases.map((testCase) => ({
    ...testCase,
    evidenceLinks: testCase.evidenceLinks.map(validateEvidenceLink),
  }))
  const safeMarkdownTitle = escapeMarkdownHtml(input.title)
  const metricRows = reportMetrics(verdict)
  const cannotClaim = verdict.cannotClaim.length === 0
    ? '- 无'
    : verdict.cannotClaim.map((claim) => `- ${escapeMarkdownHtml(claim)}`).join('\n')
  const caseRows = cases.map((testCase) =>
    `| ${escapeTable(testCase.caseId)} | ${escapeTable(testCase.title)} | ${escapeTable(testCase.status)} | ${testCase.evidenceLinks.map(markdownLink).join('<br>')} |`,
  ).join('\n')
  const markdown = [
    `# ${safeMarkdownTitle}`,
    '',
    `**最终状态：${verdict.verdict}**`,
    '',
    '## 不能宣称',
    '',
    cannotClaim,
    '',
    '## 资产身份',
    '',
    `- Asset ID：${escapeMarkdownHtml(input.assetId)}`,
    `- PRD Revision：${escapeMarkdownHtml(input.prdRevision)}`,
    `- Generation：${escapeMarkdownHtml(input.generationId)}`,
    '',
    '## 指标',
    '',
    ...metricRows.map(([label, value]) => `- ${label}：${value}`),
    '',
    '## Case',
    '',
    '| CASE-ID | 标题 | 状态 | 证据 |',
    '| --- | --- | --- | --- |',
    caseRows,
    '',
  ].join('\n')

  const htmlCases = cases.map((testCase) =>
    `<tr><td>${escapeHtml(testCase.caseId)}</td><td>${escapeHtml(testCase.title)}</td><td>${escapeHtml(testCase.status)}</td><td>${testCase.evidenceLinks.map(htmlLink).join('<br>')}</td></tr>`,
  ).join('')
  const htmlClaims = verdict.cannotClaim.length === 0
    ? '<li>无</li>'
    : verdict.cannotClaim.map((claim) => `<li>${escapeHtml(claim)}</li>`).join('')
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;max-width:1080px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left}</style>',
    '</head><body>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p><strong>最终状态：${escapeHtml(verdict.verdict)}</strong></p>`,
    `<h2>不能宣称</h2><ul>${htmlClaims}</ul>`,
    '<h2>资产身份</h2><ul>',
    `<li>Asset ID：${escapeHtml(input.assetId)}</li>`,
    `<li>PRD Revision：${escapeHtml(input.prdRevision)}</li>`,
    `<li>Generation：${escapeHtml(input.generationId)}</li></ul>`,
    `<h2>指标</h2><ul>${metricRows.map(([label, value]) => `<li>${escapeHtml(label)}：${escapeHtml(value)}</li>`).join('')}</ul>`,
    `<h2>Case</h2><table><thead><tr><th>CASE-ID</th><th>标题</th><th>状态</th><th>证据</th></tr></thead><tbody>${htmlCases}</tbody></table>`,
    '</body></html>',
  ].join('')

  return { markdown, html }
}

function reportMetrics(verdict: VerdictResult): Array<[string, string]> {
  const metrics = verdict.metrics
  return [
    ['需求设计覆盖率', formatMetric(metrics.requirementDesignCoverage)],
    ['规则覆盖率', formatMetric(metrics.ruleCoverage)],
    ['关键节点覆盖率', formatMetric(metrics.criticalNodeCoverage)],
    ['角色覆盖率', formatMetric(metrics.roleCoverage)],
    ['状态转换覆盖率', formatMetric(metrics.stateTransitionCoverage)],
    ['场景类别覆盖率', formatMetric(metrics.scenarioCategoryCoverage)],
    ['自动化处置覆盖率', formatMetric(metrics.automationDispositionCoverage)],
    ['执行覆盖率', formatMetric(metrics.executionCoverage)],
    ['真实链路通过率', formatMetric(metrics.realPassRate)],
    ['注入通过率', formatMetric(metrics.injectionPassRate)],
    ['证据完整率', formatMetric(metrics.evidenceCompleteness)],
    ['清理成功率', formatMetric(metrics.cleanupSuccess)],
    ['阻塞率', formatMetric(metrics.blockingRate)],
  ]
}

function validateEvidenceLink(link: string): string {
  const segments = link.split('/')
  if (link.length < 1 || link.length > 4096 || link.startsWith('/') || link.includes('\\')
    || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment))) {
    throw reportError('E2E_REPORT_EVIDENCE_LINK_INVALID', '证据链接必须是 generation 内安全相对路径')
  }
  return link
}

function markdownLink(link: string): string {
  return `[${escapeTable(link)}](${link})`
}

function htmlLink(link: string): string {
  return `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`
}

function formatMetric(metric: Metric): string {
  if (metric.status === 'not-applicable') return `不适用（${metric.reason}）`
  return `${metric.percentage.toFixed(2)}%（${metric.numerator}/${metric.denominator}）`
}

function escapeMarkdownHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeTable(value: string): string {
  return escapeMarkdownHtml(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function reportError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false })
}
