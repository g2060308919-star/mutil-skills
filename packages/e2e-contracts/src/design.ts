import { z } from 'zod'
import { CoverageDispositionDecisionReceiptSchema } from './decision-receipt.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const NonEmptyStringSchema = z.string().min(1)

export const RuleCategorySchema = z.enum(['business', 'permission', 'validation', 'state', 'error', 'visual'])

export const RuleSchema = z.object({
  ruleId: NonEmptyStringSchema,
  contractNodeIds: z.array(NonEmptyStringSchema).min(1)
    .refine((values) => new Set(values).size === values.length, 'contractNodeId 必须唯一').optional(),
  category: RuleCategorySchema,
  statement: NonEmptyStringSchema,
  sourceRefs: z.array(NonEmptyStringSchema).min(1),
  certainty: z.enum(['explicit', 'confirmed-inference']),
  oracleIds: z.array(NonEmptyStringSchema).length(1),
}).strict()

export const RequirementSchema = z.object({
  reqId: NonEmptyStringSchema,
  contractNodeIds: z.array(NonEmptyStringSchema).min(1)
    .refine((values) => new Set(values).size === values.length, 'contractNodeId 必须唯一').optional(),
  revision: z.number().int().positive(),
  title: NonEmptyStringSchema,
  actors: z.array(NonEmptyStringSchema).min(1),
  entities: z.array(NonEmptyStringSchema).min(1),
  preconditions: z.array(NonEmptyStringSchema),
  rules: z.array(RuleSchema).min(1),
  states: z.array(z.object({ stateId: NonEmptyStringSchema, title: NonEmptyStringSchema }).strict()),
  transitions: z.array(z.object({
    transitionId: NonEmptyStringSchema,
    from: NonEmptyStringSchema,
    action: NonEmptyStringSchema,
    to: NonEmptyStringSchema,
  }).strict()),
  observableOutcomes: z.array(z.object({
    oracleId: NonEmptyStringSchema,
    ruleId: NonEmptyStringSchema,
    statement: NonEmptyStringSchema,
    sourceRefs: z.array(NonEmptyStringSchema).min(1),
    contractAcceptanceCriteria: z.array(z.object({
      nodeId: NonEmptyStringSchema,
      criterionIndex: z.number().int().nonnegative(),
    }).strict()).min(1).refine((values) => new Set(values.map((value) =>
      `${value.nodeId}:${value.criterionIndex}`)).size === values.length,
    '同一 Oracle 的契约验收条件引用必须唯一').optional(),
  }).strict()).min(1),
  applicability: z.array(z.object({
    dimension: NonEmptyStringSchema,
    value: NonEmptyStringSchema,
    required: z.boolean(),
  }).strict()),
  sourceRefs: z.array(NonEmptyStringSchema).min(1),
  status: z.enum(['active', 'deprecated']),
}).strict().superRefine((requirement, context) => {
  const ruleIds = requirement.rules.map((rule) => rule.ruleId)
  if (new Set(ruleIds).size !== ruleIds.length) {
    context.addIssue({ code: 'custom', path: ['rules'], message: '同一 Requirement 的 Rule ID 必须唯一' })
  }
  const oracleIds = new Set(requirement.observableOutcomes.map((oracle) => oracle.oracleId))
  if (oracleIds.size !== requirement.observableOutcomes.length) {
    context.addIssue({ code: 'custom', path: ['observableOutcomes'], message: '同一 Requirement 的 Oracle ID 必须唯一' })
  }
  requirement.rules.forEach((rule, ruleIndex) => rule.oracleIds.forEach((oracleId, oracleIndex) => {
    if (!oracleIds.has(oracleId)) context.addIssue({
      code: 'custom', path: ['rules', ruleIndex, 'oracleIds', oracleIndex],
      message: 'Rule oracleId 必须引用同一 Requirement 的 observableOutcome',
    })
  }))
  const ruleIdSet = new Set(ruleIds)
  requirement.observableOutcomes.forEach((oracle, oracleIndex) => {
    if (!ruleIdSet.has(oracle.ruleId)) context.addIssue({
      code: 'custom', path: ['observableOutcomes', oracleIndex, 'ruleId'],
      message: 'Oracle ruleId 必须引用同一 Requirement 的 Rule',
    })
    const owner = requirement.rules.find((rule) => rule.ruleId === oracle.ruleId)
    if (!owner?.oracleIds.includes(oracle.oracleId)) context.addIssue({
      code: 'custom', path: ['observableOutcomes', oracleIndex],
      message: 'Rule 与 Oracle 必须一对一双向绑定',
    })
  })
})

export const RequirementModelSchema = z.object({
  modelRevision: z.number().int().positive(),
  requirements: z.array(RequirementSchema).min(1),
  coupledDimensions: z.array(NonEmptyStringSchema),
  applicabilityRules: z.array(NonEmptyStringSchema),
  modelDecisionDigest: DigestSchema,
}).strict().superRefine((model, context) => {
  const requirementIds = model.requirements.map((requirement) => requirement.reqId)
  const ruleIds = model.requirements.flatMap((requirement) => requirement.rules.map((rule) => rule.ruleId))
  const oracleIds = model.requirements.flatMap((requirement) =>
    requirement.observableOutcomes.map((oracle) => oracle.oracleId))
  if (new Set(requirementIds).size !== requirementIds.length) {
    context.addIssue({ code: 'custom', path: ['requirements'], message: 'Requirement ID 必须全局唯一' })
  }
  if (new Set(ruleIds).size !== ruleIds.length) {
    context.addIssue({ code: 'custom', path: ['requirements'], message: 'Rule ID 必须全局唯一' })
  }
  if (new Set(oracleIds).size !== oracleIds.length) {
    context.addIssue({ code: 'custom', path: ['requirements'], message: 'Oracle ID 必须全局唯一' })
  }
})

export const InteractionNodeSchema = z.object({
  nodeId: NonEmptyStringSchema,
  reqId: NonEmptyStringSchema,
  kind: z.enum(['entry', 'page', 'action', 'decision', 'state', 'feedback', 'exit']),
  title: NonEmptyStringSchema,
  effect: z.enum(['read', 'reversible-write', 'irreversible', 'unknown']),
  hasOracle: z.boolean(),
}).strict()

export const CoveragePolicySchema = z.object({
  policyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  ruleScenarios: z.record(RuleCategorySchema, z.array(NonEmptyStringSchema).min(1)),
  pairwiseSeed: z.number().int().nonnegative(),
}).strict()

export const CoverageDispositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('automated'), caseIds: z.array(NonEmptyStringSchema).min(1) }).strict(),
  z.object({ kind: z.literal('manual'), manualProcedureId: NonEmptyStringSchema, blocking: z.boolean() }).strict(),
  z.object({
    kind: z.literal('not-applicable'),
    policyCode: NonEmptyStringSchema,
    rationale: NonEmptyStringSchema,
    decisionGrantId: NonEmptyStringSchema,
    decisionReceipt: CoverageDispositionDecisionReceiptSchema,
  }).strict(),
])

export type RequirementModel = z.infer<typeof RequirementModelSchema>
export type InteractionNode = z.infer<typeof InteractionNodeSchema>
export type CoveragePolicy = z.infer<typeof CoveragePolicySchema>
export type CoverageDisposition = z.infer<typeof CoverageDispositionSchema>
export type RuleCategory = z.infer<typeof RuleCategorySchema>

export type CoverageObligationKind = 'actor' | 'critical-node' | 'rule' | 'transition'

export interface CoverageObligationCandidate {
  obligationId: string
  kind: CoverageObligationKind
  reqId: string
  clauseIds: string[]
  ruleIds: string[]
  oracleIds: string[]
  nodeIds: string[]
  actor: string | 'not-applicable'
  transitionId: string | 'not-applicable'
  scenario: string
  necessity: 'required' | 'advisory'
  applicabilityRuleId: string
}

export interface CoverageObligation extends CoverageObligationCandidate {
  disposition: CoverageDisposition
}

export type CoverageDispositionDraft =
  | CoverageDisposition
  | { kind: 'not-applicable'; policyCode: string; rationale: string; decisionGrantId?: string;
      decisionReceipt?: z.infer<typeof CoverageDispositionDecisionReceiptSchema> }

export interface CoverageUniverse {
  coveragePolicyDigest: string
  pairwiseSeed: number
  obligations: CoverageObligation[]
  universeDigest: string
}
