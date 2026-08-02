import {
  RuntimeStatusResultSchema,
  type RuntimeStatusResult,
} from '@mutil-skills/e2e-contracts'

export interface RenderedRunStatus {
  json: string
  markdown: string
  html: string
}

export function renderRunStatus(input: unknown): RenderedRunStatus {
  const status = RuntimeStatusResultSchema.parse(input)
  return {
    json: `${JSON.stringify(status, null, 2)}\n`,
    markdown: markdown(status),
    html: htmlDocument(status),
  }
}

function markdown(status: RuntimeStatusResult): string {
  const classification = classify(status)
  const cases = status.semanticCases ?? []
  return [
    '# E2E 运行状态',
    '',
    '> 中间状态（非最终结论）。环境阻断不等于业务失败，未执行不等于通过。',
    '',
    `- Run：\`${status.runId}\``,
    `- 阶段：${status.stage ?? status.state}`,
    `- 执行状态：${classification.executionStatus}`,
    `- 阻断类别：${classification.blocker}`,
    `- 最终结论：${classification.verdict}`,
    '',
    '## Semantic Cases',
    '',
    '| Case | 标题 | Lane | Binding | Oracle |',
    '| --- | --- | --- | --- | ---: |',
    ...cases.map((item) => `| ${cell(item.caseId)} | ${cell(item.title)} | ${cell(item.executionLane ?? '未声明')} | ${cell(bindingLabel(item.bindingStatus))} | ${item.oracleIds.length} |`),
    ...(cases.length === 0 ? ['| - | 尚未生成 | - | 未执行 | 0 |'] : []),
    '',
    '## 修复建议',
    '',
    ...(status.remediation?.map((item) => `- ${text(item)}`) ?? ['- 无']),
    '',
  ].join('\n')
}

function htmlDocument(status: RuntimeStatusResult): string {
  const classification = classify(status)
  const cases = status.semanticCases ?? []
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<title>E2E 运行状态</title>',
    `<style>${STYLE}</style></head><body>`,
    '<main><p class="eyebrow">中间状态（非最终结论）</p>',
    '<h1>E2E 运行状态</h1>',
    '<p class="notice">环境阻断不等于业务失败；未执行不等于通过。</p>',
    '<dl>',
    pair('Run', status.runId),
    pair('阶段', status.stage ?? status.state),
    pair('执行状态', classification.executionStatus),
    pair('阻断类别', classification.blocker),
    pair('最终结论', classification.verdict),
    '</dl><h2>Semantic Cases</h2><div class="cases">',
    ...cases.map((item) => [
      '<article>', `<h3>${escapeHtml(item.caseId)} · ${escapeHtml(item.title)}</h3>`,
      `<p>Lane：${escapeHtml(item.executionLane ?? '未声明')}</p>`,
      `<p>Binding：${escapeHtml(bindingLabel(item.bindingStatus))}</p>`,
      `<p>Oracle：${item.oracleIds.length}</p>`, '</article>',
    ].join('')),
    ...(cases.length === 0 ? ['<p>尚未生成 Semantic Case。</p>'] : []),
    '</div><h2>修复建议</h2><ul>',
    ...(status.remediation?.map((item) => `<li>${escapeHtml(item)}</li>`) ?? ['<li>无</li>']),
    '</ul></main></body></html>\n',
  ].join('')
}

function classify(status: RuntimeStatusResult): {
  executionStatus: '已通过' | '业务失败' | '未执行' | '已阻断'
  blocker: string
  verdict: '已验收' | '已拒绝' | '不完整' | '尚未生成'
} {
  const condition = status.condition
  if (condition?.kind === 'terminal') return {
    executionStatus: condition.verdict === 'accepted' ? '已通过'
      : condition.verdict === 'rejected' ? '业务失败' : '未执行',
    blocker: '无',
    verdict: condition.verdict === 'accepted' ? '已验收'
      : condition.verdict === 'rejected' ? '已拒绝' : '不完整',
  }
  if (condition?.kind === 'blocked-retryable' || condition?.kind === 'blocked-requires-change') {
    return {
      executionStatus: '已阻断', blocker: blockerLabel(condition.reasonCode), verdict: '尚未生成',
    }
  }
  return { executionStatus: '未执行', blocker: '无', verdict: '尚未生成' }
}

function blockerLabel(reasonCode: string): string {
  if (/PAGE|BROWSER|TARGET|ENVIRONMENT/.test(reasonCode)) return `环境阻断（${reasonCode}）`
  if (/INPUT|REQUIRED|MISSING/.test(reasonCode)) return `输入阻断（${reasonCode}）`
  if (/ARTIFACT/.test(reasonCode)) return `资产阻断（${reasonCode}）`
  if (/SAFETY|SECURITY/.test(reasonCode)) return `安全阻断（${reasonCode}）`
  return `自动化阻断（${reasonCode}）`
}

function bindingLabel(value: 'pending' | 'ready' | 'blocked'): string {
  return value === 'ready' ? '已就绪' : value === 'blocked' ? '已阻断' : '未执行'
}

function pair(label: string, value: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
}

function cell(value: string): string {
  return text(value).replaceAll('|', '\\|')
}

function text(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll('\n', ' ')
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const STYLE = 'body{margin:0;background:#f5f7fb;color:#172033;font:15px system-ui,sans-serif}main{max-width:960px;margin:auto;padding:40px}.eyebrow{color:#52627a;text-transform:uppercase}.notice,article,dl{background:#fff;border:1px solid #dfe5ee;border-radius:12px;padding:16px}dl{display:grid;grid-template-columns:160px 1fr;gap:8px}dt{font-weight:700}.cases{display:grid;gap:12px}h1,h2,h3{line-height:1.2}'
