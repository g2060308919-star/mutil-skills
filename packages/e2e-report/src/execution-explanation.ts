import { ExecutionExplanationV1Schema, type ExecutionExplanationV1 } from '@mutil-skills/e2e-contracts'

export function renderExecutionExplanation(input: unknown): { json: string; markdown: string; html: string } {
  const value = ExecutionExplanationV1Schema.parse(input)
  return { json: `${JSON.stringify(value, null, 2)}\n`, markdown: markdown(value), html: html(value) }
}

function markdown(value: ExecutionExplanationV1): string {
  return ['# E2E 执行解释', '', `- Run：${value.runId}`, `- Verdict：${value.verdict}`, '',
    '## 可信声明', '', '| 组件 | 状态 | 原因 |', '| --- | --- | --- |',
    ...value.claims.map((claim) => `| ${claim.component} | ${claim.status} | ${claim.reason} |`), '',
    '## Timeline', '', ...value.timeline.map((event) =>
      `- ${event.sequence}. ${event.phase} · ${event.status}${event.reasonCode ? ` · ${event.reasonCode}` : ''}`), '',
    '## 失败与修复', '', ...(value.failures.length === 0 ? ['- 无'] : value.failures.map((failure) =>
      `- ${failure.reasonCode}（${failure.responsibility}）：${failure.remediation.join('；')}`)), ''].join('\n')
}

function html(value: ExecutionExplanationV1): string {
  const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>E2E 执行解释</title></head><body><main><h1>E2E 执行解释</h1><p>Run：${escaped(value.runId)} · Verdict：${value.verdict}</p><h2>可信声明</h2><ul>${value.claims.map((claim) => `<li>${claim.component}：${claim.status} — ${escaped(claim.reason)}</li>`).join('')}</ul><h2>Timeline</h2><ol>${value.timeline.map((event) => `<li>${event.phase} · ${event.status}${event.reasonCode ? ` · ${event.reasonCode}` : ''}</li>`).join('')}</ol></main></body></html>\n`
}
