import { z } from 'zod'
import { CoverageDispositionDecisionReceiptSchema } from './decision-receipt.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const NonEmptyStringSchema = z.string().min(1)

export const RuleCategorySchema = z.enum(['business', 'permission', 'validation', 'state', 'error', 'visual'])

export const RuleSchema = z.object({
  ruleId: NonEmptyStringSchema,
  category: RuleCategorySchema,
  statement: NonEmptyStringSchema,
  sourceRefs: z.array(NonEmptyStringSchema).min(1),
  certainty: z.enum(['explicit', 'confirmed-inference']),
}).strict()

export const RequirementSchema = z.object({
  reqId: NonEmptyStringSchema,
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
    statement: NonEmptyStringSchema,
  }).strict()).min(1),
  applicability: z.array(z.object({
    dimension: NonEmptyStringSchema,
    value: NonEmptyStringSchema,
    required: z.boolean(),
  }).strict()),
  sourceRefs: z.array(NonEmptyStringSchema).min(1),
  status: z.enum(['active', 'deprecated']),
}).strict()

export const RequirementModelSchema = z.object({
  modelRevision: z.number().int().positive(),
  requirements: z.array(RequirementSchema).min(1),
  coupledDimensions: z.array(NonEmptyStringSchema),
  applicabilityRules: z.array(NonEmptyStringSchema),
  modelDecisionDigest: DigestSchema,
}).strict()

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
  ruleIds: string[]
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
