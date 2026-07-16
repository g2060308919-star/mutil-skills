import type { RenderedReport } from './read-only-report.js'

interface ModeResult {
  caseId: string
  title: string
  status: string
}

export interface PartitionedExecutionReportInput {
  assetId: string
  prdRevision: string
  generationId: string
  realResults: ModeResult[]
  injectionResults: ModeResult[]
  injectionBoundary: string
}

export function renderPartitionedExecutionReport(input: PartitionedExecutionReportInput): RenderedReport {
  const markdown = [
    '# E2E 执行模式分区报告',
    '',
    `- Asset ID：${escapeMarkdown(input.assetId)}`,
    `- PRD Revision：${escapeMarkdown(input.prdRevision)}`,
    `- Generation：${escapeMarkdown(input.generationId)}`,
    '',
    '## 真实环境结果',
    '',
    markdownTable(input.realResults),
    '',
    '## Gateway 故障注入结果',
    '',
    `> 证明边界：${escapeMarkdown(input.injectionBoundary)}`,
    '',
    markdownTable(input.injectionResults),
    '',
  ].join('\n')
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>E2E 执行模式分区报告</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:1080px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left}</style>',
    '</head><body><h1>E2E 执行模式分区报告</h1><ul>',
    `<li>Asset ID：${escapeHtml(input.assetId)}</li><li>PRD Revision：${escapeHtml(input.prdRevision)}</li>`,
    `<li>Generation：${escapeHtml(input.generationId)}</li></ul>`,
    `<h2>真实环境结果</h2>${htmlTable(input.realResults)}`,
    '<h2>Gateway 故障注入结果</h2>',
    `<p><strong>证明边界：</strong>${escapeHtml(input.injectionBoundary)}</p>${htmlTable(input.injectionResults)}`,
    '</body></html>',
  ].join('')
  return { markdown, html }
}

function markdownTable(results: ModeResult[]): string {
  const rows = results.length === 0
    ? '| — | 无 | not-applicable |'
    : results.map((result) => `| ${escapeCell(result.caseId)} | ${escapeCell(result.title)} | ${escapeCell(result.status)} |`).join('\n')
  return ['| CASE-ID | 标题 | 状态 |', '| --- | --- | --- |', rows].join('\n')
}

function htmlTable(results: ModeResult[]): string {
  const rows = results.length === 0
    ? '<tr><td>—</td><td>无</td><td>not-applicable</td></tr>'
    : results.map((result) => `<tr><td>${escapeHtml(result.caseId)}</td><td>${escapeHtml(result.title)}</td><td>${escapeHtml(result.status)}</td></tr>`).join('')
  return `<table><thead><tr><th>CASE-ID</th><th>标题</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>`
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeCell(value: string): string {
  return escapeMarkdown(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
