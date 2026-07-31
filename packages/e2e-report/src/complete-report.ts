import {
  ArtifactSchemaRegistry,
  E2EError,
  type FinalReportArtifact,
  type Metric,
} from '@mutil-skills/e2e-contracts'

export interface RenderedCompleteReport {
  json: string
  markdown: string
  html: string
}

interface MarkdownFragment { readonly kind: 'markdown-fragment'; readonly value: string }
interface HtmlFragment { readonly kind: 'html-fragment'; readonly value: string }

const SECTION_TITLES = [
  '结论与不能宣称',
  'PRD、范围、执行、审批与代际摘要',
  '环境、浏览器、角色与数据租约',
  '覆盖 Universe 与指标',
  '排除、N/A、Manual、Declined 与 Blocked',
  '端到端追踪矩阵',
  '真实链路结果',
  '故障注入结果',
  'Case 详情',
  'Network Gateway 审计',
  '浏览器健康发现',
  '诊断、自愈与重试',
  '写入副作用与清理',
  '回归资产与独立执行',
  '剩余风险与建议动作',
  'Runtime 与隔离证明',
  'PRD 原文到 Oracle 语义追踪',
] as const

export function renderCompleteReport(input: unknown): RenderedCompleteReport {
  const parsed = ArtifactSchemaRegistry['final-report'].safeParse(input)
  if (!parsed.success) {
    throw reportError('E2E_REPORT_INPUT_INVALID', '完整报告只能渲染通过 final-report Schema 的事实', parsed.error)
  }
  const report = parsed.data
  validateEvidenceLinks(report)
  return {
    json: `${JSON.stringify(report, null, 2)}\n`,
    markdown: renderMarkdown(report),
    html: renderHtml(report),
  }
}

function renderMarkdown(report: FinalReportArtifact): string {
  const content = report.content
  const realCases = content.caseDetails.filter((item) => item.executionMode === 'real-environment')
  const injectionCases = content.caseDetails.filter((item) => item.executionMode === 'browser-injection')
  const sections = [
    markdownSection(SECTION_TITLES[0], [
      `**最终状态：${cell(content.verdict)}**`,
      `- 理由：${content.reasonCodes.map(cell).join('、')}`,
      `- 业务失败（已观测）：${content.businessFailuresObserved.map(cell).join('、') || '无'}`,
      `- 建议性 Case 失败：${content.advisoryFailures.map(cell).join('、') || '无'}`,
      '- 不能宣称：',
      ...list(content.cannotClaim),
    ]),
    markdownSection(SECTION_TITLES[1], [
      `- PRD：${cell(content.summaries.prdId)} · ${text(content.summaries.prdTitle)}`,
      `- PRD Revision：${report.prdRevision}`,
      `- Scope digest：${content.summaries.scopeDigest}`,
      `- Execution Contract digest：${content.summaries.executionContractDigest}`,
      `- Approval grants：${content.summaries.approvalGrantDigests.join('、') || '无'}`,
      `- 审批保证：${approvalAssuranceLabel(content.approvalAssurance)}`,
      `- Generation：${cell(report.generationId)} · ${content.summaries.generationDigest}`,
      '',
      table(['审批类型', '状态', '保证', 'Subject digest', 'Grant digests'], content.approvals.map((item) => [
        approvalLabel(item.kind), item.status, approvalAssuranceLabel(item),
        item.subjectDigest, item.grantDigests.join('、') || '无',
      ])),
    ]),
    markdownSection(SECTION_TITLES[2], [
      `- 环境：${cell(content.environment.environmentId)}`,
      `- Origin：${content.environment.origins.map(text).join('、')}`,
      `- 浏览器：${cell(content.environment.browser.name)} ${text(content.environment.browser.version)} (${cell(content.environment.browser.channel)})`,
      '',
      table(['角色', '状态'], content.environment.roles.map((item) => [item.roleId, item.status])),
      '',
      table(['Lease', '状态', '资源指纹'], content.environment.dataLeases.map((item) => [item.leaseId, item.status, item.resourceFingerprint])),
    ]),
    markdownSection(SECTION_TITLES[3], [
      `- Universe digest：${content.coverageUniverse.universeDigest}`,
      '',
      table(['COV', '标题', '必要性', '处置', 'Case'], content.coverageUniverse.obligations.map((item) => [
        item.obligationId, item.title, item.necessity, item.disposition, item.caseIds.join('、') || '无',
      ])),
      '',
      table(['指标', '值'], metricEntries(content.metrics).map(([label, metric]) => [label, formatMetric(metric)])),
    ]),
    markdownSection(SECTION_TITLES[4], [
      table(['类别', 'ID', '标题', '状态', '理由'], content.dispositions.map((item) => [
        item.kind, item.id, item.title, item.status, item.reason,
      ])),
      '',
      '手工验收结果：',
      table(['Manual result', '保证', 'Digest'], content.manualResults.map((item) => [
        item.id, approvalAssuranceLabel(item), item.digest,
      ])),
    ]),
    markdownSection(SECTION_TITLES[5], [
      table(['REQ', 'RULE', 'COV', 'CASE', 'STEP', 'EVIDENCE'], content.traceabilityMatrix.map((item) => [
        item.reqId, item.ruleId, item.obligationId, item.caseId, item.stepId,
        markdownLink(item.evidencePath, item.evidenceId),
      ])),
    ]),
    markdownSection(SECTION_TITLES[6], [caseSummaryTable(realCases)]),
    markdownSection(SECTION_TITLES[7], [
      `> 证明边界：${text(content.injectionBoundary)}`,
      '',
      caseSummaryTable(injectionCases),
    ]),
    markdownSection(SECTION_TITLES[8], content.caseDetails.flatMap((item) => [
      `### ${cell(item.caseId)} · ${text(item.title)}`,
      '',
      `- 模式：${cell(item.executionMode)}；必要性：${cell(item.necessity)}；状态：${cell(item.status)}`,
      `- 前置：${item.preconditions.map(text).join('；') || '无'}`,
      '',
      table(['STEP', 'Action', 'Expected', 'Actual', 'Oracle', '状态', '证据'], item.steps.map((step) => [
        step.stepId, step.action, step.expected, step.actual, step.oracle, step.status,
        markdownEvidenceLinks(step.evidenceLinks),
      ])),
      '',
    ])),
    markdownSection(SECTION_TITLES[9], [
      `- 状态：${cell(content.gatewayAudit.status)}；forwarded=${content.gatewayAudit.forwarded}；blocked=${content.gatewayAudit.blocked}；injected=${content.gatewayAudit.injected}`,
      `- Audit digest：${content.gatewayAudit.digest}`,
      findingTable(content.gatewayAudit.findings),
    ]),
    markdownSection(SECTION_TITLES[10], [findingTable(content.browserHealth)]),
    markdownSection(SECTION_TITLES[11], content.diagnostics.flatMap((item) => [
      `### ${cell(item.caseId)} · ${cell(item.category)}`,
      '',
      `- Selected attempt：${item.selectedAttemptId ? cell(item.selectedAttemptId) : '无'}`,
      `- 说明：${text(item.rationale)}`,
      table(['Attempt', '状态', '变更摘要', '副作用'], item.attempts.map((attempt) => [
        attempt.attemptId, attempt.status, attempt.changeDigest ?? '无', attempt.sideEffectState,
      ])),
      '',
    ])),
    markdownSection(SECTION_TITLES[12], [
      table(['Action', 'Effect', '状态', '验证', 'Cleanup', '摘要'], content.sideEffects.map((item) => [
        item.actionId, item.effect, item.status, item.verification, item.cleanupStatus, item.digest,
      ])),
    ]),
    markdownSection(SECTION_TITLES[13], [
      `- 测试域：${cell(content.regressionDetails.testDomain)}`,
      `- 执行 Profile：${cell(content.regressionDetails.executionProfile)}`,
      `- Generation：${cell(content.regressionDetails.generationId)}`,
      `- Manifest digest：${content.regressionDetails.manifestDigest}`,
      `- Case：${content.regressionDetails.caseIds.map(cell).join('、') || '无'}`,
      `- 独立执行：${cell(content.regressionDetails.command)}`,
      `- Compiler Input：${content.regressionDetails.trustedCompiler.compilerInputDigest}`,
      `- Compiler：${cell(content.regressionDetails.trustedCompiler.compilerVersion)} · ${content.regressionDetails.trustedCompiler.compilerDigest}`,
      `- Template：${cell(content.regressionDetails.trustedCompiler.templateVersion)} · ${content.regressionDetails.trustedCompiler.templateDigest}`,
      `- Source Set：${content.regressionDetails.trustedCompiler.sourceSetDigest}`,
      `- Discovery：${content.regressionDetails.trustedCompiler.discoverySignedDigest}`,
      `- 固定 Launcher 执行：${content.regressionDetails.trustedCompiler.executionDigest}`,
      `- Toolchain：Node ${cell(content.regressionDetails.trustedCompiler.nodeVersion)} · Playwright ${cell(content.regressionDetails.trustedCompiler.playwrightVersion)} · CLI ${content.regressionDetails.trustedCompiler.playwrightCliDigest}`,
    ]),
    markdownSection(SECTION_TITLES[14], [
      findingTable(content.risks),
      '',
      ...list(content.recommendations),
    ]),
    markdownSection(SECTION_TITLES[15], [
      `- Runtime：${cell(content.runtimeProvenance.runtimeVersion)}`,
      `- Runtime installation：${content.runtimeProvenance.runtimeInstallationDigest}`,
      `- Protocol / Contracts / Engine：${cell(content.runtimeProvenance.protocolVersion)} / ${cell(content.runtimeProvenance.contractsVersion)} / ${cell(content.runtimeProvenance.engineVersion)}`,
      `- Playwright：${cell(content.runtimeProvenance.playwrightVersion)}`,
      `- Chromium：${content.runtimeProvenance.chromiumDigest}`,
      `- Gateway policy：${content.runtimeProvenance.gatewayPolicyDigest}`,
      `- Authority：${content.runtimeProvenance.authorityPublicKeyDigest}`,
      `- Authority 状态保护：${content.runtimeProvenance.authorityStateProtectionLevel}`,
      `- Project identity：${content.runtimeProvenance.projectIdentityDigest}`,
      `- Source revision：${content.runtimeProvenance.sourceRevisionDigest}`,
      `- Isolation proof：${content.runtimeProvenance.isolationProofDigest}`,
      `- 源码仓库独立：${content.runtimeProvenance.sourceRepositoryIndependent ? '是' : '否'}`,
    ]),
    markdownSection(SECTION_TITLES[16], [
      table(['CLAUSE', '来源区间', 'PRD 原文', '处置', 'REQ', 'RULE', 'ORACLE'],
        content.semanticTraceability.map((item) => [
          item.clauseId,
          `${item.sourceId}:${item.sourceSpan.startLine}:${item.sourceSpan.startColumn}-${item.sourceSpan.endLine}:${item.sourceSpan.endColumn}`,
          item.originalText, item.disposition, item.requirementId ?? '无', item.ruleId ?? '无', item.oracleId ?? '无',
        ])),
    ]),
  ]
  return [
    `# ${text(content.title)}`,
    '',
    `- Asset ID：${cell(report.assetId)}`,
    `- Generation：${cell(report.generationId)}`,
    '',
    ...sections,
    '',
  ].join('\n')
}

function renderHtml(report: FinalReportArtifact): string {
  const content = report.content
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">',
    `<title>${html(content.title)}</title>`,
    `<style>${REPORT_STYLE}</style>`,
    '</head><body>',
    '<header class="report-header">',
    `<p class="eyebrow">PRD 驱动 E2E 验收 · ${html(content.verdict)}</p>`,
    `<h1>${html(content.title)}</h1>`,
    `<p class="identity">Asset ID：${html(report.assetId)}<br>Generation：${html(report.generationId)}</p>`,
    '</header>',
    renderCaseControls(report),
    '<main>',
    ...SECTION_TITLES.map((title, index) => `<section><h2>${html(title)}</h2>${htmlSection(index, report)}</section>`),
    '</main>',
    `<script>${REPORT_SCRIPT}</script>`,
    '</body></html>',
  ].join('')
}

function htmlSection(index: number, report: FinalReportArtifact): string {
  const content = report.content
  if (index === 0) return `<p><strong>最终状态：${html(content.verdict)}</strong></p><p>理由：${content.reasonCodes.map(html).join('、')}</p><p>业务失败（已观测）：${content.businessFailuresObserved.map(html).join('、') || '无'}</p><p>建议性 Case 失败：${content.advisoryFailures.map(html).join('、') || '无'}</p><h3>不能宣称</h3>${htmlList(content.cannotClaim)}`
  if (index === 1) return `${htmlList([
    `PRD：${content.summaries.prdId} · ${content.summaries.prdTitle}`,
    `PRD Revision：${report.prdRevision}`,
    `Scope digest：${content.summaries.scopeDigest}`,
    `Execution Contract digest：${content.summaries.executionContractDigest}`,
    `Approval grants：${content.summaries.approvalGrantDigests.join('、') || '无'}`,
    `审批保证：${approvalAssuranceLabel(content.approvalAssurance)}`,
    `Generation：${report.generationId} · ${content.summaries.generationDigest}`,
  ])}${htmlTable(['审批类型', '状态', '保证', 'Subject digest', 'Grant digests'], content.approvals.map((item) => [approvalLabel(item.kind), item.status, approvalAssuranceLabel(item), item.subjectDigest, item.grantDigests.join('、') || '无']))}`
  if (index === 2) return `${htmlList([
    `环境：${content.environment.environmentId}`,
    `Origin：${content.environment.origins.join('、')}`,
    `浏览器：${content.environment.browser.name} ${content.environment.browser.version}`,
  ])}${htmlTable(['角色', '状态'], content.environment.roles.map((item) => [item.roleId, item.status]))}${htmlTable(['Lease', '状态', '资源指纹'], content.environment.dataLeases.map((item) => [item.leaseId, item.status, item.resourceFingerprint]))}`
  if (index === 3) return `<p>Universe digest：${html(content.coverageUniverse.universeDigest)}</p>${htmlTable(['COV', '标题', '必要性', '处置', 'Case'], content.coverageUniverse.obligations.map((item) => [item.obligationId, item.title, item.necessity, item.disposition, item.caseIds.join('、') || '无']))}${htmlTable(['指标', '值'], metricEntries(content.metrics).map(([label, metric]) => [label, formatMetric(metric)]))}`
  if (index === 4) return `${htmlTable(['类别', 'ID', '标题', '状态', '理由'], content.dispositions.map((item) => [item.kind, item.id, item.title, item.status, item.reason]))}<h3>手工验收结果</h3>${htmlTable(['Manual result', '保证', 'Digest'], content.manualResults.map((item) => [item.id, approvalAssuranceLabel(item), item.digest]))}`
  if (index === 5) return htmlTable(['REQ', 'RULE', 'COV', 'CASE', 'STEP', 'EVIDENCE'], content.traceabilityMatrix.map((item) => [item.reqId, item.ruleId, item.obligationId, item.caseId, item.stepId, htmlEvidenceLink(item.evidencePath, item.evidenceId)]))
  if (index === 6 || index === 7) {
    const mode = index === 6 ? 'real-environment' : 'browser-injection'
    const boundary = index === 7 ? `<p><strong>证明边界：</strong>${html(content.injectionBoundary)}</p>` : ''
    return `${boundary}${htmlCaseSummary(content.caseDetails.filter((item) => item.executionMode === mode))}`
  }
  if (index === 8) return content.caseDetails.length === 0
    ? '<p class="empty-state">无 Case</p>'
    : content.caseDetails.map((item) => `<details class="case-detail" data-case data-case-status="${html(item.status)}" data-case-mode="${html(item.executionMode)}" data-case-search="${html(`${item.caseId} ${item.title} ${item.status} ${item.executionMode}`.toLocaleLowerCase('zh-CN'))}"><summary>${html(item.caseId)} · ${html(item.title)} · ${html(item.status)}</summary><div class="case-body"><p>模式：${html(item.executionMode)}；必要性：${html(item.necessity)}；状态：${html(item.status)}</p><p><strong>前置：</strong>${item.preconditions.length === 0 ? '无' : item.preconditions.map(html).join('；')}</p><div class="table-scroll">${htmlTable(['STEP', 'Action', 'Expected', 'Actual', 'Oracle', '状态', '证据'], item.steps.map((step) => [step.stepId, step.action, step.expected, step.actual, step.oracle, step.status, htmlEvidenceLinks(step.evidenceLinks)]))}</div></div></details>`).join('')
  if (index === 9) return `<p>状态：${html(content.gatewayAudit.status)}；forwarded=${content.gatewayAudit.forwarded}；blocked=${content.gatewayAudit.blocked}；injected=${content.gatewayAudit.injected}</p>${htmlFindingTable(content.gatewayAudit.findings)}`
  if (index === 10) return htmlFindingTable(content.browserHealth)
  if (index === 11) return content.diagnostics.map((item) => `<article><h3>${html(item.caseId)} · ${html(item.category)}</h3><p>${html(item.rationale)}</p>${htmlTable(['Attempt', '状态', '变更摘要', '副作用'], item.attempts.map((attempt) => [attempt.attemptId, attempt.status, attempt.changeDigest ?? '无', attempt.sideEffectState]))}</article>`).join('')
  if (index === 12) return htmlTable(['Action', 'Effect', '状态', '验证', 'Cleanup', '摘要'], content.sideEffects.map((item) => [item.actionId, item.effect, item.status, item.verification, item.cleanupStatus, item.digest]))
  if (index === 13) return htmlList([
    `测试域：${content.regressionDetails.testDomain}`,
    `执行 Profile：${content.regressionDetails.executionProfile}`,
    `Generation：${content.regressionDetails.generationId}`,
    `Manifest digest：${content.regressionDetails.manifestDigest}`,
    `Case：${content.regressionDetails.caseIds.join('、') || '无'}`,
    `独立执行：${content.regressionDetails.command}`,
    `Compiler Input：${content.regressionDetails.trustedCompiler.compilerInputDigest}`,
    `Compiler：${content.regressionDetails.trustedCompiler.compilerVersion} · ${content.regressionDetails.trustedCompiler.compilerDigest}`,
    `Template：${content.regressionDetails.trustedCompiler.templateVersion} · ${content.regressionDetails.trustedCompiler.templateDigest}`,
    `Source Set：${content.regressionDetails.trustedCompiler.sourceSetDigest}`,
    `Discovery：${content.regressionDetails.trustedCompiler.discoverySignedDigest}`,
    `固定 Launcher 执行：${content.regressionDetails.trustedCompiler.executionDigest}`,
    `Toolchain：Node ${content.regressionDetails.trustedCompiler.nodeVersion} · Playwright ${content.regressionDetails.trustedCompiler.playwrightVersion} · CLI ${content.regressionDetails.trustedCompiler.playwrightCliDigest}`,
  ])
  if (index === 14) return `${htmlFindingTable(content.risks)}<h3>建议动作</h3>${htmlList(content.recommendations)}`
  if (index === 16) return htmlTable(['CLAUSE', '来源区间', 'PRD 原文', '处置', 'REQ', 'RULE', 'ORACLE'],
    content.semanticTraceability.map((item) => [item.clauseId,
      `${item.sourceId}:${item.sourceSpan.startLine}:${item.sourceSpan.startColumn}-${item.sourceSpan.endLine}:${item.sourceSpan.endColumn}`,
      item.originalText, item.disposition, item.requirementId ?? '无', item.ruleId ?? '无', item.oracleId ?? '无']))
  return htmlList([
    `Runtime：${content.runtimeProvenance.runtimeVersion}`,
    `Runtime installation：${content.runtimeProvenance.runtimeInstallationDigest}`,
    `Protocol / Contracts / Engine：${content.runtimeProvenance.protocolVersion} / ${content.runtimeProvenance.contractsVersion} / ${content.runtimeProvenance.engineVersion}`,
    `Playwright：${content.runtimeProvenance.playwrightVersion}`,
    `Chromium：${content.runtimeProvenance.chromiumDigest}`,
    `Gateway policy：${content.runtimeProvenance.gatewayPolicyDigest}`,
    `Authority：${content.runtimeProvenance.authorityPublicKeyDigest}`,
    `Authority 状态保护：${content.runtimeProvenance.authorityStateProtectionLevel}`,
    `Project identity：${content.runtimeProvenance.projectIdentityDigest}`,
    `Source revision：${content.runtimeProvenance.sourceRevisionDigest}`,
    `Isolation proof：${content.runtimeProvenance.isolationProofDigest}`,
    `源码仓库独立：${content.runtimeProvenance.sourceRepositoryIndependent ? '是' : '否'}`,
  ])
}

function renderCaseControls(report: FinalReportArtifact): string {
  const statuses = [...new Set(report.content.caseDetails.map((item) => item.status))].sort()
  const modes = [...new Set(report.content.caseDetails.map((item) => item.executionMode))].sort()
  const options = (values: string[]) => values.map((value) => `<option value="${html(value)}">${html(value)}</option>`).join('')
  return [
    '<section class="report-controls" aria-labelledby="filter-title">',
    '<h2 id="filter-title">Case 筛选与打印</h2>',
    '<div class="control-row">',
    '<div><label for="case-search">搜索 CASE-ID、标题或状态</label><input id="case-search" type="search" autocomplete="off"></div>',
    `<div><label for="case-status">状态</label><select id="case-status"><option value="">全部状态</option>${options(statuses)}</select></div>`,
    `<div><label for="case-mode">执行模式</label><select id="case-mode"><option value="">全部模式</option>${options(modes)}</select></div>`,
    '<div class="control-actions"><button id="case-reset" type="button">重置筛选</button><button id="report-print" type="button">打印报告</button></div>',
    '</div>',
    `<p id="case-filter-status" role="status" aria-live="polite">显示 ${report.content.caseDetails.length} / ${report.content.caseDetails.length} 个 Case</p>`,
    '</section>',
  ].join('')
}

const REPORT_STYLE = `
:root{color-scheme:light;--ink:#17202a;--muted:#52606d;--line:#c8cdd2;--surface:#f5f7f8;--accent:#1f4b63;--focus:#b44c16}
*{box-sizing:border-box}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;max-width:72rem;margin:0 auto;padding:0 1rem 4rem;color:var(--ink);background:#fff;line-height:1.55}
.report-header{border-top:.5rem solid var(--accent);padding:2rem 0 1.25rem}.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.02em}.identity{color:var(--muted)}
h1{font-size:clamp(1.75rem,4vw,2.75rem);line-height:1.15;margin:.5rem 0}h2{margin-top:2.5rem;border-bottom:2px solid var(--accent);padding-bottom:.35rem}h3{margin-top:1.5rem}
a{color:#0b5f8a;text-underline-offset:.15em}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
table{border-collapse:collapse;width:100%;font-size:.9375rem}th,td{border:1px solid var(--line);padding:.625rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:var(--surface)}
.table-scroll{overflow-x:auto}.report-controls{margin:1rem 0 2rem;padding:1rem;border:1px solid var(--line);background:var(--surface)}.report-controls h2{margin-top:0;border:0;font-size:1.125rem}
.control-row{display:grid;grid-template-columns:minmax(14rem,2fr) minmax(10rem,1fr) minmax(10rem,1fr) auto;gap:1rem;align-items:end}.control-row label{display:block;font-weight:650;margin-bottom:.25rem}.control-row input,.control-row select{width:100%;min-height:2.5rem;border:1px solid #8b969f;background:#fff;padding:.5rem}.control-actions{display:flex;gap:.5rem}.control-actions button{min-height:2.5rem;border:1px solid var(--accent);background:#fff;color:var(--accent);padding:.5rem .75rem;font-weight:650;cursor:pointer}.control-actions button:last-child{background:var(--accent);color:#fff}
.case-detail{border:1px solid var(--line);margin:.75rem 0;background:#fff}.case-detail summary{cursor:pointer;font-weight:700;padding:.75rem;background:var(--surface)}.case-body{padding:0 .75rem 1rem}.case-detail[hidden]{display:none}
.evidence-screenshot{margin:.25rem 0}.evidence-screenshot img{display:block;max-width:min(100%,48rem);height:auto;border:1px solid var(--line)}.evidence-screenshot figcaption{margin-top:.25rem}
@media(max-width:48rem){body{padding-inline:.75rem}.control-row{grid-template-columns:1fr}.control-actions{flex-wrap:wrap}table{font-size:.8125rem}th,td{padding:.4rem}}
@media print{body{max-width:none;padding:0;color:#000}.report-controls{display:none!important}a{color:#000;text-decoration:none}section{break-inside:avoid}details{break-inside:avoid}details>.case-body{display:block!important}h2{break-after:avoid}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`

const REPORT_SCRIPT = `
(()=>{
  const search=document.getElementById('case-search');
  const status=document.getElementById('case-status');
  const mode=document.getElementById('case-mode');
  const reset=document.getElementById('case-reset');
  const print=document.getElementById('report-print');
  const output=document.getElementById('case-filter-status');
  const cases=Array.from(document.querySelectorAll('[data-case]'));
  const apply=()=>{
    const query=search.value.trim().toLocaleLowerCase('zh-CN');
    let visible=0;
    for(const item of cases){
      const matchesText=query===''||item.dataset.caseSearch.includes(query);
      const matchesStatus=status.value===''||item.dataset.caseStatus===status.value;
      const matchesMode=mode.value===''||item.dataset.caseMode===mode.value;
      item.hidden=!(matchesText&&matchesStatus&&matchesMode);
      if(!item.hidden)visible+=1;
    }
    output.textContent='显示 '+visible+' / '+cases.length+' 个 Case';
  };
  search.addEventListener('input',apply);status.addEventListener('change',apply);mode.addEventListener('change',apply);
  reset.addEventListener('click',()=>{search.value='';status.value='';mode.value='';apply();search.focus();});
  print.addEventListener('click',()=>window.print());
  let previouslyClosed=[];
  window.addEventListener('beforeprint',()=>{previouslyClosed=cases.filter(item=>!item.open);for(const item of cases)item.open=true;});
  window.addEventListener('afterprint',()=>{for(const item of previouslyClosed)item.open=false;previouslyClosed=[];});
  apply();
})();
`

function markdownSection(title: string, lines: string[]): string {
  return [`## ${title}`, '', ...lines, ''].join('\n')
}

function list(values: string[]): string[] {
  return values.length === 0 ? ['- 无'] : values.map((value) => `- ${text(value)}`)
}

function table(headers: string[], rows: Array<Array<string | MarkdownFragment>>): string {
  const safeRows = rows.length === 0 ? [headers.map(() => '无')] : rows
  const render = (value: string | MarkdownFragment) => typeof value === 'string' ? cell(value) : value.value
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.map(render).join(' | ')} |`),
  ].join('\n')
}

function caseSummaryTable(cases: FinalReportArtifact['content']['caseDetails']): string {
  return table(['CASE', '标题', '模式', '必要性', '状态'], cases.map((item) => [
    item.caseId, item.title, item.executionMode, item.necessity, item.status,
  ]))
}

function findingTable(findings: Array<{ code: string; severity: string; ref: string }>): string {
  return table(['Code', 'Severity', 'Ref'], findings.map((item) => [item.code, item.severity, item.ref]))
}

function metricEntries(metrics: FinalReportArtifact['content']['metrics']): Array<[string, Metric]> {
  return [
    ['PRD 条款处置覆盖', metrics.clauseDispositionCoverage],
    ['需求设计覆盖', metrics.requirementDesignCoverage], ['规则覆盖', metrics.ruleCoverage],
    ['Oracle 覆盖', metrics.oracleCoverage], ['Case 设计覆盖', metrics.caseDesignCoverage],
    ['关键节点覆盖', metrics.criticalNodeCoverage], ['角色覆盖', metrics.roleCoverage],
    ['状态转换覆盖', metrics.stateTransitionCoverage], ['场景类别覆盖', metrics.scenarioCategoryCoverage],
    ['自动化处置覆盖', metrics.automationDispositionCoverage], ['执行覆盖', metrics.executionCoverage],
    ['真实链路通过率', metrics.realPassRate], ['注入通过率', metrics.injectionPassRate],
    ['证据完整率', metrics.evidenceCompleteness], ['清理成功率', metrics.cleanupSuccess],
    ['阻塞率', metrics.blockingRate],
  ]
}

function formatMetric(metric: Metric): string {
  return metric.status === 'not-applicable'
    ? `不适用（${text(metric.reason)}）`
    : `${metric.percentage.toFixed(2)}%（${metric.numerator}/${metric.denominator}）`
}

function approvalLabel(kind: 'scope' | 'lineage' | 'execution'): string {
  if (kind === 'scope') return '范围审批'
  return kind === 'lineage' ? '谱系审批' : '执行审批'
}

function approvalAssuranceLabel(value: {
  approvalMode: 'local-confirmation' | 'webauthn'
  identityVerified: boolean
  separationOfDutiesVerified: boolean
}): string {
  return value.approvalMode === 'local-confirmation'
    ? '本地确认（不验证身份/职责分离）'
    : 'WebAuthn（已验证身份/职责分离）'
}

function htmlCaseSummary(cases: FinalReportArtifact['content']['caseDetails']): string {
  return htmlTable(['CASE', '标题', '模式', '必要性', '状态'], cases.map((item) => [
    item.caseId, item.title, item.executionMode, item.necessity, item.status,
  ]))
}

function htmlFindingTable(findings: Array<{ code: string; severity: string; ref: string }>): string {
  return htmlTable(['Code', 'Severity', 'Ref'], findings.map((item) => [item.code, item.severity, item.ref]))
}

function htmlTable(headers: string[], rows: Array<Array<string | HtmlFragment>>): string {
  const safeRows = rows.length === 0 ? [headers.map(() => '无')] : rows
  const render = (value: string | HtmlFragment) => typeof value === 'string' ? html(value) : value.value
  return `<table><thead><tr>${headers.map((header) => `<th scope="col">${html(header)}</th>`).join('')}</tr></thead><tbody>${safeRows.map((row) => `<tr>${row.map((value) => `<td>${render(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

function htmlList(values: string[]): string {
  const entries = values.length === 0 ? ['无'] : values
  return `<ul>${entries.map((value) => `<li>${html(value)}</li>`).join('')}</ul>`
}

function markdownLink(path: string, label: string): MarkdownFragment {
  const safeTarget = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return { kind: 'markdown-fragment', value: `[${cell(label)}](<${safeTarget}>)` }
}

function markdownEvidenceLinks(links: string[]): string | MarkdownFragment {
  if (links.length === 0) return '无'
  return { kind: 'markdown-fragment', value: links.map((link) => markdownLink(link, link).value).join('<br>') }
}

function htmlEvidenceLink(path: string, label: string): HtmlFragment {
  if (path.endsWith('.png')) return {
    kind: 'html-fragment',
    value: `<figure class="evidence-screenshot"><img src="${html(path)}" alt="验收截图 ${html(label)}" loading="lazy"><figcaption><a href="${html(path)}">${html(label)}</a></figcaption></figure>`,
  }
  if (path.endsWith('.zip') && path.toLocaleLowerCase('en-US').includes('trace')) return {
    kind: 'html-fragment',
    value: `<a href="${html(path)}" download>下载 Playwright Trace</a>`,
  }
  return { kind: 'html-fragment', value: `<a href="${html(path)}">${html(label)}</a>` }
}

function htmlEvidenceLinks(links: string[]): string | HtmlFragment {
  if (links.length === 0) return '无'
  return { kind: 'html-fragment', value: links.map((link) => htmlEvidenceLink(link, link).value).join('<br>') }
}

function validateEvidenceLinks(report: FinalReportArtifact): void {
  const links = [
    ...report.content.traceabilityMatrix.map((item) => item.evidencePath),
    ...report.content.caseDetails.flatMap((item) => item.steps.flatMap((step) => step.evidenceLinks)),
  ]
  for (const link of links) {
    if (link.startsWith('/') || link.includes('\\') || link.includes(':') || link.split('/').includes('..')) {
      throw reportError('E2E_REPORT_EVIDENCE_LINK_INVALID', '证据链接必须是 generation 内安全相对路径')
    }
  }
}

function text(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function cell(value: string): string {
  return text(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function reportError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false, cause })
}
