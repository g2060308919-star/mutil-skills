import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'
import { PageIdentityPolicySchema, PageLocatorCandidateSchema } from './e2e-flow.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const TextSchema = z.string().min(1).max(64 * 1024)
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]))

const PageScopeSchema = z.object({
  page: z.enum(['current', 'popup']),
  pageId: SafeIdSchema.optional(),
  frame: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('main') }).strict(),
    z.object({ kind: z.literal('name'), value: TextSchema.max(512) }).strict(),
    z.object({ kind: z.literal('url'), value: z.string().url().max(2_048) }).strict(),
  ]),
}).strict().superRefine((scope, context) => {
  if (scope.page === 'popup' && scope.pageId === undefined) context.addIssue({
    code: 'custom', path: ['pageId'], message: 'popup scope 必须声明稳定 pageId',
  })
})

const TimeoutPolicySchema = z.object({
  timeoutMs: z.number().int().positive().max(3_600_000),
  retry: z.enum(['none', 'read-only-max-2']),
}).strict()

const ActionBase = {
  actionId: SafeIdSchema,
  effect: z.enum(['read', 'reversible-write']),
  pageScope: PageScopeSchema,
  locatorCandidates: z.array(PageLocatorCandidateSchema).max(32),
  timeout: TimeoutPolicySchema,
}

export const DeclarativeBrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...ActionBase, kind: z.literal('navigate'), url: z.string().url().max(2_048) }).strict(),
  z.object({ ...ActionBase, kind: z.literal('click') }).strict(),
  z.object({ ...ActionBase, kind: z.literal('fill'), value: TextSchema }).strict(),
  z.object({ ...ActionBase, kind: z.literal('select'), values: z.array(TextSchema.max(2_048)).min(1).max(100) }).strict(),
  z.object({ ...ActionBase, kind: z.literal('check'), checked: z.boolean() }).strict(),
  z.object({ ...ActionBase, kind: z.literal('press'), key: TextSchema.max(128) }).strict(),
  z.object({ ...ActionBase, kind: z.literal('wait-for'), state: z.enum(['visible', 'hidden', 'attached', 'detached']) }).strict(),
  z.object({ ...ActionBase, kind: z.literal('assert-only') }).strict(),
])

const OracleBase = {
  oracleId: SafeIdSchema,
  actionId: SafeIdSchema,
  deadlineMs: z.number().int().positive().max(3_600_000),
  evidenceKinds: z.array(z.enum(['screenshot', 'dom', 'url', 'network', 'console'])).min(1).max(16),
}
const ElementOracleBase = { ...OracleBase, locatorCandidates: z.array(PageLocatorCandidateSchema).min(1).max(32) }
const ComparatorSchema = z.enum(['equals', 'contains', 'matches'])
const NetworkOracleSchema = z.object({
  ...OracleBase,
  kind: z.literal('network'),
  request: z.object({
    method: z.string().regex(/^[A-Z]+$/),
    urlPattern: TextSchema.max(2_048),
    bodyDigest: DigestSchema.optional(),
  }).strict(),
  response: z.object({
    status: z.number().int().min(100).max(599),
    bodyDigest: DigestSchema.optional(),
  }).strict(),
}).strict()
const DownloadOracleSchema = z.object({
  ...OracleBase,
  kind: z.literal('download'),
  fileName: TextSchema.max(512),
  mediaType: TextSchema.max(512).optional(),
  contentDigest: DigestSchema.optional(),
  structuredContent: JsonValueSchema.optional(),
}).strict()
const ConsoleOracleSchema = z.object({
  ...OracleBase,
  kind: z.literal('console'),
  severity: z.enum(['warning', 'error']),
  allowlist: z.array(TextSchema.max(2_048)).max(100),
  expectedCount: z.number().int().nonnegative().max(10_000),
}).strict()
const CompositeLeafSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), locatorCandidates: z.array(PageLocatorCandidateSchema).min(1).max(32),
    comparator: ComparatorSchema, expected: TextSchema }).strict(),
  z.object({ kind: z.literal('absence'), locatorCandidates: z.array(PageLocatorCandidateSchema).min(1).max(32) }).strict(),
  z.object({ kind: z.literal('url'), comparator: ComparatorSchema, expected: TextSchema.max(2_048) }).strict(),
  z.object({ kind: z.literal('element-state'), locatorCandidates: z.array(PageLocatorCandidateSchema).min(1).max(32),
    state: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked']), expected: z.boolean() }).strict(),
])
const CompositeOracleSchema = z.object({
  ...OracleBase,
  kind: z.literal('composite'),
  operator: z.enum(['and', 'or']),
  conditions: z.array(CompositeLeafSchema).min(2).max(32),
}).strict()

export const DeclarativeOracleObservationSchema = z.discriminatedUnion('kind', [
  z.object({ ...ElementOracleBase, kind: z.literal('text'), comparator: z.enum(['equals', 'contains', 'matches']),
    expected: TextSchema }).strict(),
  z.object({ ...ElementOracleBase, kind: z.literal('absence') }).strict(),
  z.object({ ...OracleBase, kind: z.literal('url'), comparator: z.enum(['equals', 'contains', 'matches']),
    expected: TextSchema.max(2_048) }).strict(),
  z.object({ ...ElementOracleBase, kind: z.literal('element-state'),
    state: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked']), expected: z.boolean() }).strict(),
  z.object({ ...ElementOracleBase, kind: z.literal('eventually'), observation: z.enum(['text', 'absence', 'element-state']),
    comparator: z.enum(['equals', 'contains', 'matches']).optional(), expected: JsonValueSchema }).strict(),
  z.object({ ...OracleBase, kind: z.literal('reload-state'), observation: z.enum(['text', 'url', 'element-state']),
    locatorCandidates: z.array(PageLocatorCandidateSchema).max(32), expected: JsonValueSchema }).strict(),
  NetworkOracleSchema,
  DownloadOracleSchema,
  ConsoleOracleSchema,
  CompositeOracleSchema,
])

const DataNeedSchema = z.object({
  dataNeedId: SafeIdSchema, kind: z.enum(['fixture', 'secret', 'record']), ref: SafeIdSchema,
}).strict()
const CleanupIntentSchema = z.object({
  cleanupIntentId: SafeIdSchema, actionId: SafeIdSchema,
  strategy: z.enum(['browser-ui', 'gateway-api']), statement: TextSchema,
  reloadOracleId: SafeIdSchema,
}).strict()

const DeclarativeExecutionCaseSchema = z.object({
  caseId: SafeIdSchema,
  executionLane: z.enum(['trusted-read-only', 'trusted-reversible-write', 'full-playwright']),
  pageIdentityPolicy: PageIdentityPolicySchema,
  actions: z.array(DeclarativeBrowserActionSchema).min(1).max(10_000),
  oracles: z.array(DeclarativeOracleObservationSchema).min(1).max(10_000),
  dataNeeds: z.array(DataNeedSchema).max(10_000),
  cleanupIntents: z.array(CleanupIntentSchema).max(10_000),
}).strict().superRefine((testCase, context) => {
  unique(testCase.actions.map((action) => action.actionId), context, ['actions'], 'actionId')
  unique(testCase.oracles.map((oracle) => oracle.oracleId), context, ['oracles'], 'oracleId')
  unique(testCase.dataNeeds.map((item) => item.dataNeedId), context, ['dataNeeds'], 'dataNeedId')
  unique(testCase.cleanupIntents.map((item) => item.cleanupIntentId), context, ['cleanupIntents'], 'cleanupIntentId')
  const actionIds = new Set(testCase.actions.map((action) => action.actionId))
  const oracleIds = new Set(testCase.oracles.map((oracle) => oracle.oracleId))
  testCase.oracles.forEach((oracle, index) => {
    if (!actionIds.has(oracle.actionId)) context.addIssue({ code: 'custom', path: ['oracles', index, 'actionId'],
      message: 'Oracle 必须引用同一 Case 的 actionId' })
  })
  testCase.cleanupIntents.forEach((cleanup, index) => {
    if (!actionIds.has(cleanup.actionId)) context.addIssue({ code: 'custom', path: ['cleanupIntents', index, 'actionId'],
      message: 'Cleanup 必须引用同一 Case 的 actionId' })
    if (!oracleIds.has(cleanup.reloadOracleId)) context.addIssue({ code: 'custom',
      path: ['cleanupIntents', index, 'reloadOracleId'], message: 'Cleanup 必须引用同一 Case 的 Reload Oracle' })
  })
  const writeActionIds = new Set(testCase.actions.filter((action) => action.effect === 'reversible-write')
    .map((action) => action.actionId))
  if (writeActionIds.size > 0) {
    if (testCase.executionLane !== 'trusted-reversible-write' && testCase.executionLane !== 'full-playwright') {
      context.addIssue({ code: 'custom', path: ['executionLane'], message: '写动作必须使用可信写 lane' })
    }
    if (testCase.dataNeeds.length === 0) context.addIssue({ code: 'custom', path: ['dataNeeds'],
      message: '写动作必须声明 DataLease 数据需求' })
    for (const actionId of writeActionIds) if (!testCase.cleanupIntents.some((item) => item.actionId === actionId)) {
      context.addIssue({ code: 'custom', path: ['cleanupIntents'], message: `写动作 ${actionId} 必须声明 Cleanup` })
    }
  }
})

export const DeclarativeExecutionBindingV1Schema = z.object({
  schemaVersion: z.literal('declarative-execution-binding/v1'),
  planCompilerDigest: DigestSchema,
  targetProbeDigest: DigestSchema,
  cases: z.array(DeclarativeExecutionCaseSchema).min(1).max(1_000),
}).strict().superRefine((binding, context) => {
  unique(binding.cases.map((testCase) => testCase.caseId), context, ['cases'], 'caseId')
})

export type DeclarativeExecutionBindingV1 = z.infer<typeof DeclarativeExecutionBindingV1Schema>
export type DeclarativeBrowserAction = z.infer<typeof DeclarativeBrowserActionSchema>
export type DeclarativeOracleObservation = z.infer<typeof DeclarativeOracleObservationSchema>
export type NormalizedDeclarativeExecutionBindingV1 = DeclarativeExecutionBindingV1 & { bindingDigest: string }

export function normalizeDeclarativeExecutionBinding(input: unknown): NormalizedDeclarativeExecutionBindingV1 {
  const parsed = DeclarativeExecutionBindingV1Schema.parse(input)
  const normalized: DeclarativeExecutionBindingV1 = {
    ...parsed,
    cases: [...parsed.cases].sort(byId('caseId')).map((testCase) => ({
      ...testCase,
      actions: [...testCase.actions].sort(byId('actionId')),
      oracles: [...testCase.oracles].sort(byId('oracleId')),
      dataNeeds: [...testCase.dataNeeds].sort(byId('dataNeedId')),
      cleanupIntents: [...testCase.cleanupIntents].sort(byId('cleanupIntentId')),
    })),
  }
  return { ...normalized, bindingDigest: digestText(
    'declarative-execution-binding/v1', canonicalizeJson(normalized),
  ) }
}

function byId<Key extends string>(key: Key) {
  return (left: Record<Key, string>, right: Record<Key, string>) => left[key].localeCompare(right[key])
}

function unique(values: readonly string[], context: z.RefinementCtx, path: Array<string | number>, label: string) {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path, message: `${label} 必须唯一` })
}
