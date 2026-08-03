import {
  RuntimeStatusResultSchema,
  type RuntimeStatusResult,
} from '@mutil-skills/e2e-contracts'

export interface RenderedRunStatus {
  json: string
  markdown: string
  html: string
}

type SemanticCase = NonNullable<RuntimeStatusResult['semanticCases']>[number]

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
    ...cases.flatMap(markdownCaseDetails),
    ...markdownAcceptanceReview(status),
    ...markdownTargetProbe(status),
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
      `<p>Oracle：${item.oracleIds.length}</p>`,
      ...htmlCaseDetails(item), '</article>',
    ].join('')),
    ...(cases.length === 0 ? ['<p>尚未生成 Semantic Case。</p>'] : []),
    '</div>',
    ...htmlAcceptanceReview(status),
    ...htmlTargetProbe(status),
    '<h2>修复建议</h2><ul>',
    ...(status.remediation?.map((item) => `<li>${escapeHtml(item)}</li>`) ?? ['<li>无</li>']),
    '</ul></main></body></html>\n',
  ].join('')
}

function markdownTargetProbe(status: RuntimeStatusResult): string[] {
  const probe = status.targetProbe
  if (probe === undefined || probe.status === 'ready') return []
  const diagnostics = probe.diagnostics
  return [
    '## 目标探测诊断',
    '',
    `- 失败命令：probe-target`,
    `- Runtime 错误码：${text(probe.reasonCode ?? 'E2E_TARGET_PROBE_BLOCKED')}`,
    `- 页面 URL：${text(probe.observedUrl)}`,
    `- 页面标题：${text(probe.observedTitle || '未取得')}`,
    `- DOM：${diagnostics?.domPresent === true ? '已生成' : '未确认'}`,
    `- 可见文本摘要：${text(diagnostics?.visibleTextSummary || '无')}`,
    `- 探测策略：${text(diagnostics?.strategy ?? '未知')}`,
    `- Attempt：${diagnostics?.attempt ?? 0}`,
    `- 业务动作：未执行`,
    `- closureComplete：${diagnostics?.resourceSummary.closureComplete ?? false}`,
    `- 资源计数：observed=${diagnostics?.resourceSummary.observedCount ?? 0} / approved=${diagnostics?.resourceSummary.approvedCount ?? 0} / pending=${diagnostics?.resourceSummary.pendingCount ?? 0} / persistent=${diagnostics?.resourceSummary.persistentConnectionCount ?? 0}`,
    `- Console Error：${diagnostics?.consoleErrors.map(text).join('；') || '无'}`,
    `- Failed Request：${diagnostics?.failedRequests.map((item) => text(`${item.method} ${item.url} (${item.resourceType}: ${item.errorText})`)).join('；') || '无'}`,
    `- Pending Resource：${diagnostics?.pendingResources.map((item) => text(`${item.resourceType}:${item.url}`)).join('；') || '无'}`,
    `- Persistent Connection：${diagnostics?.persistentConnections.map((item) => text(`${item.resourceType}:${item.url}`)).join('；') || '无'}`,
    `- Advisory：${diagnostics?.advisories.map(text).join('；') || '无'}`,
    `- 已验证摘要：${Object.entries(status.verifiedDigests).map(([key, value]) => text(`${key}=${value}`)).join('；') || '无'}`,
    '',
  ]
}

function htmlTargetProbe(status: RuntimeStatusResult): string[] {
  const probe = status.targetProbe
  if (probe === undefined || probe.status === 'ready') return []
  const diagnostics = probe.diagnostics
  return [
    '<h2>目标探测诊断</h2><article><dl>',
    pair('失败命令', 'probe-target'),
    pair('Runtime 错误码', probe.reasonCode ?? 'E2E_TARGET_PROBE_BLOCKED'),
    pair('页面 URL', probe.observedUrl),
    pair('页面标题', probe.observedTitle || '未取得'),
    pair('DOM', diagnostics?.domPresent === true ? '已生成' : '未确认'),
    pair('可见文本摘要', diagnostics?.visibleTextSummary || '无'),
    pair('探测策略', diagnostics?.strategy ?? '未知'),
    pair('Attempt', String(diagnostics?.attempt ?? 0)),
    pair('业务动作', '未执行'),
    pair('closureComplete', String(diagnostics?.resourceSummary.closureComplete ?? false)),
    pair('资源计数', `observed=${diagnostics?.resourceSummary.observedCount ?? 0} / approved=${diagnostics?.resourceSummary.approvedCount ?? 0} / pending=${diagnostics?.resourceSummary.pendingCount ?? 0} / persistent=${diagnostics?.resourceSummary.persistentConnectionCount ?? 0}`),
    pair('Console Error', diagnostics?.consoleErrors.join('；') || '无'),
    pair('Failed Request', diagnostics?.failedRequests.map((item) => `${item.method} ${item.url} (${item.resourceType}: ${item.errorText})`).join('；') || '无'),
    pair('Pending Resource', diagnostics?.pendingResources.map((item) => `${item.resourceType}:${item.url}`).join('；') || '无'),
    pair('Persistent Connection', diagnostics?.persistentConnections.map((item) => `${item.resourceType}:${item.url}`).join('；') || '无'),
    pair('Advisory', diagnostics?.advisories.join('；') || '无'),
    '</dl></article>',
  ]
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

function markdownCaseDetails(item: SemanticCase): string[] {
  const fixture = item.fixture
  const signals = item.pageIdentityPolicy?.signals.map(identitySignalLabel) ?? []
  const locators = item.locatorCandidates?.map(locatorLabel) ?? []
  if (fixture === undefined && signals.length === 0 && locators.length === 0) return []
  return [
    `### ${text(item.caseId)} 执行契约`,
    '',
    ...(fixture === undefined ? [] : [
      `- Fixture：${text(fixture.seedStrategy)}`,
      `- Actor：${text(fixture.actorRef)}`,
      `- 前置条件：${fixture.preconditions.map((entry) => text(entry.statement)).join('；') || '无'}`,
      `- DataLease：${fixture.dataLease === undefined ? '无' : text(`${fixture.dataLease.leaseKey} / ${fixture.dataLease.scope}`)}`,
      `- Cleanup：${fixture.cleanup === undefined ? '无' : text(`${fixture.cleanup.kind} / ${fixture.cleanup.statement}`)}`,
      `- Reload Oracle：${fixture.reloadVerification?.map((entry) => text(entry.statement)).join('；') ?? '无'}`,
    ]),
    `- 页面身份：${signals.map(text).join('；') || '未声明'}`,
    `- Locator 候选：${locators.map(text).join('；') || '未声明'}`,
    '',
  ]
}

function htmlCaseDetails(item: SemanticCase): string[] {
  const fixture = item.fixture
  const signals = item.pageIdentityPolicy?.signals.map(identitySignalLabel).join('；') ?? '未声明'
  const locators = item.locatorCandidates?.map(locatorLabel).join('；') ?? '未声明'
  return [
    ...(fixture === undefined ? [] : [
      `<p>Fixture：${escapeHtml(fixture.seedStrategy)}</p>`,
      `<p>Actor：${escapeHtml(fixture.actorRef)}</p>`,
      `<p>Cleanup：${escapeHtml(fixture.cleanup === undefined ? '无' : `${fixture.cleanup.kind} / ${fixture.cleanup.statement}`)}</p>`,
      `<p>Reload Oracle：${escapeHtml(fixture.reloadVerification?.map((entry) => entry.statement).join('；') ?? '无')}</p>`,
    ]),
    `<p>页面身份：${escapeHtml(signals)}</p>`,
    `<p>Locator 候选：${escapeHtml(locators)}</p>`,
  ]
}

function markdownAcceptanceReview(status: RuntimeStatusResult): string[] {
  const review = status.acceptanceReview
  if (review === undefined) return []
  const catalog = review.semanticCatalog
  const requirementById = new Map(catalog.requirements.map((item) => [item.reqId, item]))
  const ruleById = new Map(catalog.rules.map((item) => [item.ruleId, item]))
  const oracleById = new Map(catalog.oracles.map((item) => [item.oracleId, item]))
  const caseById = new Map(catalog.cases.map((item) => [item.caseId, item]))
  return [
    '## PRD 语义确认',
    '',
    `- 状态：${status.acceptanceReviewConfirmation?.status === 'confirmed' ? '已确认' : '待确认'}`,
    `- Review Digest：\`${review.reviewDigest}\``,
    '',
    ...review.links.flatMap((link) => [
      `### ${text(link.clauseId)} · ${text(link.sourceText)}`,
      '',
      `- PRD 原文位置：${text(link.sourceSpan.sourceId)}:${link.sourceSpan.startLine}:${link.sourceSpan.startColumn}`,
      `- 处置：${text(link.disposition)}`,
      `- Requirement：${link.requirementIds.map((id) => text(`${id} / ${requirementById.get(id)?.title ?? '缺失'}`)).join('；') || '无'}`,
      `- Rule：${link.ruleIds.map((id) => text(`${id} / ${ruleById.get(id)?.statement ?? '缺失'}`)).join('；') || '无'}`,
      `- Oracle：${link.oracleIds.map((id) => text(`${id} / ${oracleById.get(id)?.statement ?? '缺失'}`)).join('；') || '无'}`,
      `- Case：${link.caseIds.map((id) => text(`${id} / ${caseById.get(id)?.title ?? '缺失'}`)).join('；') || '无'}`,
      '',
    ]),
  ]
}

function htmlAcceptanceReview(status: RuntimeStatusResult): string[] {
  const review = status.acceptanceReview
  if (review === undefined) return []
  const catalog = review.semanticCatalog
  const requirementById = new Map(catalog.requirements.map((item) => [item.reqId, item]))
  const ruleById = new Map(catalog.rules.map((item) => [item.ruleId, item]))
  const oracleById = new Map(catalog.oracles.map((item) => [item.oracleId, item]))
  const caseById = new Map(catalog.cases.map((item) => [item.caseId, item]))
  return [
    '<h2>PRD 语义确认</h2>',
    `<p>状态：${status.acceptanceReviewConfirmation?.status === 'confirmed' ? '已确认' : '待确认'}</p>`,
    ...review.links.map((link) => [
      '<article>',
      `<h3>${escapeHtml(link.clauseId)} · ${escapeHtml(link.sourceText)}</h3>`,
      `<p>Requirement：${escapeHtml(link.requirementIds.map((id) => `${id} / ${requirementById.get(id)?.title ?? '缺失'}`).join('；') || '无')}</p>`,
      `<p>Rule：${escapeHtml(link.ruleIds.map((id) => `${id} / ${ruleById.get(id)?.statement ?? '缺失'}`).join('；') || '无')}</p>`,
      `<p>Oracle：${escapeHtml(link.oracleIds.map((id) => `${id} / ${oracleById.get(id)?.statement ?? '缺失'}`).join('；') || '无')}</p>`,
      `<p>Case：${escapeHtml(link.caseIds.map((id) => `${id} / ${caseById.get(id)?.title ?? '缺失'}`).join('；') || '无')}</p>`,
      '</article>',
    ].join('')),
  ]
}

function identitySignalLabel(signal: NonNullable<SemanticCase['pageIdentityPolicy']>['signals'][number]): string {
  if (signal.kind === 'role') return `role:${signal.role}/${signal.name}`
  if (signal.kind === 'css-visible') return `css:${signal.selector}`
  return `${signal.kind}:${signal.value}`
}

function locatorLabel(locator: NonNullable<SemanticCase['locatorCandidates']>[number]): string {
  if (locator.kind === 'role') return `role:${locator.role}/${locator.name}`
  if (locator.kind === 'css') return `css:${locator.selector}`
  return `${locator.kind}:${locator.value}`
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
