import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'
import { E2ECaseExecutionFieldsSchema, E2ECaseExecutionSchema } from './e2e-flow.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const TextSchema = z.string().min(1).max(64 * 1024)

const DeclarativeActionSchema = z.object({
  actionKey: SafeIdSchema,
  kind: z.enum(['navigate', 'interact', 'full-playwright']),
  effect: z.enum(['read', 'reversible-write']),
  statement: TextSchema,
}).strict()

const DeclarativeOracleSchema = z.object({
  oracleKey: SafeIdSchema,
  actionKey: SafeIdSchema,
  contractNodeId: SafeIdSchema,
  acceptanceCriterion: TextSchema,
}).strict()

const DeclarativeCaseFieldsSchema = z.object({
  caseKey: SafeIdSchema,
  title: TextSchema,
  actor: SafeIdSchema,
  contractNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
  actions: z.array(DeclarativeActionSchema).min(1).max(10_000),
  oracles: z.array(DeclarativeOracleSchema).min(1).max(10_000),
  failurePolicy: z.enum(['stop-required', 'continue']),
}).strict()

const DeclarativeCaseSchema = DeclarativeCaseFieldsSchema.superRefine((testCase, context) => {
  refineDeclarativeCase(testCase, context)
})

function refineDeclarativeCase(
  testCase: z.infer<typeof DeclarativeCaseFieldsSchema>,
  context: z.RefinementCtx,
): void {
  unique(testCase.contractNodeIds, context, ['contractNodeIds'], 'contractNodeId')
  const actionKeys = testCase.actions.map((action) => action.actionKey)
  unique(actionKeys, context, ['actions'], 'actionKey')
  unique(testCase.oracles.map((oracle) => oracle.oracleKey), context, ['oracles'], 'oracleKey')
  const actionSet = new Set(actionKeys)
  const nodeSet = new Set(testCase.contractNodeIds)
  testCase.oracles.forEach((oracle, index) => {
    if (!actionSet.has(oracle.actionKey)) context.addIssue({
      code: 'custom', path: ['oracles', index, 'actionKey'],
      message: 'oracle actionKey 必须引用同一 Case 的 action',
    })
    if (!nodeSet.has(oracle.contractNodeId)) context.addIssue({
      code: 'custom', path: ['oracles', index, 'contractNodeId'],
      message: 'oracle contractNodeId 必须属于同一 Case 的契约节点',
    })
  })
}

export const DeclarativePrdRunDesignSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  cases: z.array(DeclarativeCaseSchema).min(1).max(1_000),
}).strict().superRefine((design, context) => {
  unique(design.cases.map((testCase) => testCase.caseKey), context, ['cases'], 'caseKey')
})

const DeclarativeCaseV2Schema = z.object({
  ...DeclarativeCaseFieldsSchema.shape,
  ...E2ECaseExecutionFieldsSchema.shape,
}).strict().superRefine((testCase, context) => {
  refineDeclarativeCase(testCase, context)
  const execution = E2ECaseExecutionSchema.safeParse({
    executionLane: testCase.executionLane,
    fixture: testCase.fixture,
    locatorCandidates: testCase.locatorCandidates,
    pageIdentityPolicy: testCase.pageIdentityPolicy,
  })
  if (!execution.success) execution.error.issues.forEach((issue) => context.addIssue(issue))
})

export const DeclarativePrdRunDesignV2Schema = z.object({
  schemaVersion: z.literal('2.0.0'),
  cases: z.array(DeclarativeCaseV2Schema).min(1).max(1_000),
}).strict().superRefine((design, context) => {
  unique(design.cases.map((testCase) => testCase.caseKey), context, ['cases'], 'caseKey')
})

export const AnyDeclarativePrdRunDesignSchema = z.union([
  DeclarativePrdRunDesignSchema,
  DeclarativePrdRunDesignV2Schema,
])

const CompiledActionSchema = DeclarativeActionSchema.omit({ kind: true }).extend({
  actionId: SafeIdSchema,
  kind: DeclarativeActionSchema.shape.kind,
}).strict()

const CompiledOracleSchema = z.object({
  oracleId: SafeIdSchema,
  oracleKey: SafeIdSchema,
  actionId: SafeIdSchema,
  contractNodeId: SafeIdSchema,
  acceptanceCriterion: TextSchema,
}).strict()

const CompiledCaseSchema = z.object({
  queueOrdinal: z.number().int().nonnegative().max(999),
  caseId: SafeIdSchema,
  caseKey: SafeIdSchema,
  title: TextSchema,
  actor: SafeIdSchema,
  contractNodeIds: z.array(SafeIdSchema).min(1).max(10_000),
  actions: z.array(CompiledActionSchema).min(1).max(10_000),
  oracles: z.array(CompiledOracleSchema).min(1).max(10_000),
  failurePolicy: z.enum(['stop-required', 'continue']),
}).strict()

const CompiledPrdRunPlanDraftSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  contractProjectionDigest: DigestSchema,
  cases: z.array(CompiledCaseSchema).min(1).max(1_000),
}).strict()

export function digestCompiledPrdRunPlan(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return digestText('compiled-prd-run/v1', canonicalizeJson(value))
  }
  const { compilerDigest: _ignored, ...material } = value as Record<string, unknown>
  return digestText('compiled-prd-run/v1', canonicalizeJson(material))
}

export const CompiledPrdRunPlanSchema = CompiledPrdRunPlanDraftSchema.extend({
  compilerDigest: DigestSchema,
}).strict().superRefine((plan, context) => {
  if (plan.compilerDigest !== digestCompiledPrdRunPlan(plan)) context.addIssue({
    code: 'custom', path: ['compilerDigest'], message: 'compilerDigest 与规范化计划不匹配',
  })
  unique(plan.cases.map((testCase) => testCase.caseId), context, ['cases'], 'caseId')
  plan.cases.forEach((testCase, index) => {
    if (testCase.queueOrdinal !== index) context.addIssue({
      code: 'custom', path: ['cases', index, 'queueOrdinal'],
      message: 'queueOrdinal 必须从零连续递增',
    })
  })
})

function unique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
): void {
  if (new Set(values).size !== values.length) context.addIssue({
    code: 'custom', path, message: `${label} 必须唯一`,
  })
}

export type DeclarativePrdRunDesign = z.infer<typeof DeclarativePrdRunDesignSchema>
export type DeclarativePrdRunDesignV2 = z.infer<typeof DeclarativePrdRunDesignV2Schema>
export type AnyDeclarativePrdRunDesign = z.infer<typeof AnyDeclarativePrdRunDesignSchema>
export type CompiledPrdRunPlan = z.infer<typeof CompiledPrdRunPlanSchema>
