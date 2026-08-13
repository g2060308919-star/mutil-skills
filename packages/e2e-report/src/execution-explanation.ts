import {
  ArtifactSchemaRegistry,
  ExecutionExplanationV1Schema,
  canonicalizeJson,
  digestText,
  type ExecutionExplanationV1,
} from '@mutil-skills/e2e-contracts'

export function projectExecutionExplanation(input: unknown): ExecutionExplanationV1 {
  const report = ArtifactSchemaRegistry['final-report'].parse(input)
  const timeline: ExecutionExplanationV1['timeline'] = []
  let sequence = 0
  const at = report.createdAt
  const push = (event: Omit<ExecutionExplanationV1['timeline'][number], 'eventId' | 'sequence' | 'at'>) => {
    sequence += 1
    timeline.push({ eventId: `TIMELINE-${sequence}`, sequence, at, ...event })
  }
  for (const row of report.content.semanticTraceability) {
    push({ phase: 'clause', status: row.disposition === 'modeled' ? 'passed' : 'not-executed' })
    if (row.requirementId !== undefined) push({ phase: 'requirement', status: 'passed' })
  }
  const evidenceIds = new Set(report.content.traceabilityMatrix.map((row) => row.evidenceId))
  for (const testCase of report.content.caseDetails) {
    push({ phase: 'case', caseId: testCase.caseId,
      status: status(testCase.status) })
    for (const step of testCase.steps) {
      push({ phase: 'action', caseId: testCase.caseId, actionId: step.stepId,
        status: status(step.status) })
      push({ phase: 'oracle', caseId: testCase.caseId, actionId: step.stepId,
        status: step.oracle === 'passed' ? 'passed' : step.oracle === 'not-evaluated' ? 'not-executed' : 'failed' })
    }
  }
  push({ phase: 'cleanup', status: report.content.sideEffects.some((item) =>
    !['verified-clean', 'not-applicable'].includes(item.cleanupStatus)) ? 'failed' : 'passed' })
  push({ phase: 'verdict', status: report.content.verdict === 'accepted' ? 'passed'
    : report.content.verdict === 'rejected' ? 'failed' : 'blocked' })
  const claims: ExecutionExplanationV1['claims'] = [{
    claimId: 'CLAIM-BROWSER-PRODUCT', component: 'browser-product',
    status: evidenceIds.size > 0 && report.content.realResults.length > 0 ? 'verified' : 'not-executed',
    evidenceIds: [...evidenceIds], reason: evidenceIds.size > 0
      ? '真实浏览器 Case、Oracle 与 Evidence 已进入同一 active generation'
      : '未发现可绑定的真实浏览器 Evidence',
  }]
  for (const component of ['backend', 'database', 'idp'] as const) {
    const boundary = report.content.cannotClaim.find((item) =>
      item.toLowerCase().includes(component))
    if (boundary !== undefined) claims.push({
      claimId: `CLAIM-${component.toUpperCase()}`, component, status: 'not-executed', evidenceIds: [],
      reason: boundary,
    })
  }
  claims.push({ claimId: 'CLAIM-GATEWAY', component: 'gateway',
    status: report.content.gatewayAudit.status === 'valid' ? 'verified' : 'not-executed',
    evidenceIds: report.content.gatewayAudit.status === 'valid' ? ['GATEWAY-AUDIT'] : [],
    reason: `Gateway 审计状态：${report.content.gatewayAudit.status}` })
  claims.push({ claimId: 'CLAIM-RUNTIME', component: 'runtime', status: 'verified',
    evidenceIds: ['RUNTIME-PROVENANCE'], reason: '最终报告包含绑定当前 generation 的 Runtime provenance' })
  const failures: ExecutionExplanationV1['failures'] = report.content.reasonCodes
    .filter((reasonCode) => reasonCode.startsWith('E2E_')).map((reasonCode, index) => ({
      failureId: `FAILURE-${index + 1}`, responsibility: 'product', reasonCode,
      firstAttemptId: report.content.diagnostics[0]?.attempts[0]?.attemptId ?? 'ATTEMPT-NOT-EXECUTED',
      finalAttemptId: report.content.diagnostics[0]?.selectedAttemptId ?? 'ATTEMPT-NOT-EXECUTED',
      safeToRetry: false, preservedAssets: [], invalidatedAssets: [],
      nextLegalEdge: report.content.verdict === 'accepted' ? 'render-report' : 'create-new-run',
      remediation: report.content.recommendations,
    }))
  const body = { schemaVersion: 'execution-explanation/v1' as const, runId: report.generationId,
    verdict: report.content.verdict, timeline, failures, claims }
  return ExecutionExplanationV1Schema.parse({ ...body,
    lineageDigest: digestText('execution-explanation-lineage/v1', canonicalizeJson({
      reportDigest: report.contentDigest, timeline, failures, claims,
    })) })
}

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

function status(value: string): ExecutionExplanationV1['timeline'][number]['status'] {
  if (value === 'passed') return 'passed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  if (value === 'not-executed' || value === 'unable') return 'not-executed'
  return 'blocked'
}
