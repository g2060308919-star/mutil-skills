import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const LimitedTextSchema = z.string().min(1).max(64 * 1024)
const ReasonCodeSchema = z.string().regex(/^E2E_[A-Z0-9_]+$/)

export const PageIdentityRoleSchema = z.enum([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
  'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo',
  'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure',
  'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader',
  'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong',
  'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
])

export const SourceRoleSchema = z.enum([
  'requirements-source',
  'target-application',
  'supporting-reference',
  'fixture-source',
])

const UrlIdentitySchema = z.object({
  origin: z.string().url().max(2_048).superRefine((value, context) => {
    const url = new URL(value)
    if (url.origin !== value.replace(/\/$/, '')) context.addIssue({
      code: 'custom', message: 'page identity origin 只能包含 scheme、host 与 port',
    })
  }),
  pathPattern: z.string().min(1).max(2_048).regex(/^\/(?:[^\s?#]*)$/),
}).strict()

const PageIdentitySignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('test-id'), value: LimitedTextSchema.max(512) }).strict(),
  z.object({
    kind: z.literal('role'),
    role: PageIdentityRoleSchema,
    name: LimitedTextSchema.max(512),
  }).strict(),
  z.object({
    kind: z.literal('css-visible'),
    selector: z.string().min(1).max(512).superRefine(validateDeclarativeCssSelector),
  }).strict(),
  z.object({ kind: z.literal('visible-text'), value: LimitedTextSchema.max(2_048), exact: z.boolean() }).strict(),
  z.object({ kind: z.literal('title'), value: LimitedTextSchema.max(2_048), exact: z.boolean() }).strict(),
  z.object({ kind: z.literal('heading'), value: LimitedTextSchema.max(2_048), exact: z.boolean() }).strict(),
])

export const PageIdentityPolicySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  url: UrlIdentitySchema,
  signals: z.array(PageIdentitySignalSchema).min(1).max(32),
  match: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('all') }).strict(),
    z.object({ mode: z.literal('at-least'), count: z.number().int().positive().max(32) }).strict(),
  ]),
}).strict().superRefine((policy, context) => {
  if (!policy.signals.some((signal) => ['test-id', 'role', 'css-visible'].includes(signal.kind))) {
    context.addIssue({
      code: 'custom', path: ['signals'],
      message: '页面身份除 URL 外至少需要一个 test-id、role 或受限 CSS 业务信号',
    })
  }
  if (policy.match.mode === 'at-least' && policy.match.count > policy.signals.length) {
    context.addIssue({
      code: 'custom', path: ['match', 'count'], message: 'at-least count 不能超过 signals 数量',
    })
  }
})

export const TargetContractSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  targetUrl: z.string().url().max(2_048),
  baseOrigin: z.string().url().max(2_048),
  environmentLabel: z.string().min(1).max(128),
  pageIdentityPolicy: PageIdentityPolicySchema,
  allowedNavigationOrigins: z.array(z.string().url().max(2_048)).min(1).max(16),
}).strict().superRefine((contract, context) => {
  const target = new URL(contract.targetUrl)
  if (target.origin !== contract.baseOrigin.replace(/\/$/, '')) context.addIssue({
    code: 'custom', path: ['baseOrigin'], message: 'baseOrigin 必须来自 targetUrl',
  })
  if (contract.pageIdentityPolicy.url.origin !== target.origin) context.addIssue({
    code: 'custom', path: ['pageIdentityPolicy', 'url', 'origin'],
    message: '页面身份 origin 必须与 targetUrl 一致',
  })
  if (!contract.allowedNavigationOrigins.includes(target.origin)) context.addIssue({
    code: 'custom', path: ['allowedNavigationOrigins'], message: '导航 origin 必须包含目标 origin',
  })
})

export const ExecutionLaneSchema = z.enum([
  'preview-readonly',
  'real-reversible-write',
  'injection-simulated',
])

const FixturePreconditionSchema = z.object({
  kind: z.enum(['business-state', 'storage-state-ref', 'data-record']),
  statement: LimitedTextSchema,
}).strict()

const DataLeaseIntentSchema = z.object({
  leaseKey: SafeIdSchema,
  scope: SafeIdSchema,
  expiresAfterSeconds: z.number().int().min(30).max(86_400),
}).strict()

const CleanupIntentSchema = z.object({
  kind: z.enum(['browser-ui', 'gateway-api']),
  statement: LimitedTextSchema,
}).strict()

const OracleIntentSchema = z.object({ statement: LimitedTextSchema }).strict()

export const FixtureContractSchema = z.object({
  actorRef: SafeIdSchema,
  preconditions: z.array(FixturePreconditionSchema).max(1_000),
  seedStrategy: z.enum(['pre-existing', 'gateway-api', 'browser-ui', 'injection']),
  dataLease: DataLeaseIntentSchema.optional(),
  cleanup: CleanupIntentSchema.optional(),
  reloadVerification: z.array(OracleIntentSchema).min(1).max(1_000).optional(),
}).strict()

export const PageLocatorCandidateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('test-id'), value: LimitedTextSchema.max(512) }).strict(),
  z.object({
    kind: z.literal('role'), role: PageIdentityRoleSchema, name: LimitedTextSchema.max(512),
  }).strict(),
  z.object({
    kind: z.literal('css'), selector: z.string().min(1).max(512).superRefine(validateDeclarativeCssSelector),
  }).strict(),
  z.object({ kind: z.literal('text'), value: LimitedTextSchema.max(2_048), exact: z.boolean() }).strict(),
])

export const E2ECaseExecutionFieldsSchema = z.object({
  executionLane: ExecutionLaneSchema,
  fixture: FixtureContractSchema,
  locatorCandidates: z.array(PageLocatorCandidateSchema).max(1_000),
  pageIdentityPolicy: PageIdentityPolicySchema,
}).strict()

export const E2ECaseExecutionSchema = E2ECaseExecutionFieldsSchema.superRefine((execution, context) => {
  const fixture = execution.fixture
  if (execution.executionLane === 'real-reversible-write') {
    if (fixture.seedStrategy === 'injection') context.addIssue({
      code: 'custom', path: ['fixture', 'seedStrategy'], message: '真实写 lane 禁止 injection fixture',
    })
    if (fixture.dataLease === undefined) context.addIssue({
      code: 'custom', path: ['fixture', 'dataLease'], message: '真实写 lane 必须声明 DataLease',
    })
    if (fixture.cleanup === undefined) context.addIssue({
      code: 'custom', path: ['fixture', 'cleanup'], message: '真实写 lane 必须声明 Cleanup',
    })
    if (fixture.reloadVerification === undefined) context.addIssue({
      code: 'custom', path: ['fixture', 'reloadVerification'], message: '真实写 lane 必须声明 Reload Oracle',
    })
  }
  if (execution.executionLane === 'injection-simulated' && fixture.seedStrategy !== 'injection') {
    context.addIssue({
      code: 'custom', path: ['fixture', 'seedStrategy'], message: 'injection lane 必须使用 injection fixture',
    })
  }
  if (execution.executionLane === 'preview-readonly'
    && (fixture.dataLease !== undefined || fixture.cleanup !== undefined)) {
    context.addIssue({
      code: 'custom', path: ['fixture'], message: '只读预览 lane 不接受写 Lease 或 Cleanup',
    })
  }
})

export const RunHandleSchema = z.object({
  assetId: SafeIdSchema,
  runId: SafeIdSchema,
  revision: z.number().int().nonnegative(),
  generationDigest: DigestSchema,
}).strict()

export const RunStageSchema = z.enum([
  'requirements',
  'target-probe',
  'planning',
  'acceptance-review',
  'execution-approval',
  'preflight',
  'compiled',
  'execution',
  'finalization',
  'completed',
])

export const RunConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('awaiting-user'), decisionId: SafeIdSchema }).strict(),
  z.object({ kind: z.literal('running'), attemptId: SafeIdSchema }).strict(),
  z.object({
    kind: z.literal('blocked-retryable'), reasonCode: ReasonCodeSchema, resumeStage: RunStageSchema,
  }).strict(),
  z.object({
    kind: z.literal('blocked-requires-change'), reasonCode: ReasonCodeSchema, resumeStage: RunStageSchema,
  }).strict(),
  z.object({
    kind: z.literal('terminal'), verdict: z.enum(['accepted', 'rejected', 'incomplete']),
  }).strict(),
])

const AcceptanceReviewLinkSchema = z.object({
  clauseId: SafeIdSchema,
  sourceSpan: z.object({
    sourceId: SafeIdSchema,
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
  }).strict(),
  sourceText: LimitedTextSchema,
  disposition: z.enum(['modeled', 'excluded', 'not-applicable', 'ambiguous']),
  requirementIds: z.array(SafeIdSchema).max(10_000),
  ruleIds: z.array(SafeIdSchema).max(10_000),
  oracleIds: z.array(SafeIdSchema).max(10_000),
  caseIds: z.array(SafeIdSchema).max(1_000),
}).strict()

export const AcceptanceReviewSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runId: SafeIdSchema,
  contractProjectionDigest: DigestSchema,
  compilerDigest: DigestSchema,
  links: z.array(AcceptanceReviewLinkSchema).min(1).max(100_000),
  includedClauseIds: z.array(SafeIdSchema).max(100_000),
  excludedClauseIds: z.array(SafeIdSchema).max(100_000),
  unresolvedItems: z.array(LimitedTextSchema).max(10_000),
  reviewDigest: DigestSchema,
}).strict()

export function normalizeTargetUrl(raw: string): string {
  const value = raw.trim()
  if (/[：／？＃]/u.test(value)) throw new Error('目标 URL 含全角标点，请使用 ASCII 标点')
  const candidate = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[^\s]*)?$/u.test(value)
    ? `http://${value}`
    : value
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    throw new Error('目标 URL 必须包含 scheme；仅 localhost/127.0.0.1 可自动使用 http')
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch (cause) {
    throw new Error('目标 URL 无法解析', { cause })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('目标 URL scheme 只允许 http 或 https')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('目标 URL 禁止内嵌认证信息')
  return parsed.toString()
}

function validateDeclarativeCssSelector(selector: string, context: z.RefinementCtx): void {
  if (/\bscript\b|\/\/|::|:has\s*\(|,|[{};<>`\n\r]|javascript:|xpath/i.test(selector)) {
    context.addIssue({ code: 'custom', message: 'selector 超出受限声明式 CSS 子集' })
  }
}

export type SourceRole = z.infer<typeof SourceRoleSchema>
export type PageIdentityPolicy = z.infer<typeof PageIdentityPolicySchema>
export type PageIdentitySignal = z.infer<typeof PageIdentitySignalSchema>
export type TargetContract = z.infer<typeof TargetContractSchema>
export type ExecutionLane = z.infer<typeof ExecutionLaneSchema>
export type FixtureContract = z.infer<typeof FixtureContractSchema>
export type E2ECaseExecution = z.infer<typeof E2ECaseExecutionSchema>
export type RunHandle = z.infer<typeof RunHandleSchema>
export type RunStage = z.infer<typeof RunStageSchema>
export type RunCondition = z.infer<typeof RunConditionSchema>
export type AcceptanceReview = z.infer<typeof AcceptanceReviewSchema>
