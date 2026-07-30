import { z } from 'zod'
import { AssetIdSchema } from './common.js'
import { ManualResultSchema } from './manual-result.js'
import { assertExecutionResultIdentities } from './execution-result-identity.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const ReasonCodeSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

export const CaseVerdictStatusSchema = z.enum([
  'passed', 'failed', 'input-blocked', 'environment-blocked', 'safety-blocked',
  'automation-blocked', 'pending-decision', 'not-executed-user-declined', 'manual-required',
])

export const MetricSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('value'), numerator: z.number().int().nonnegative(),
    denominator: z.number().int().positive(), percentage: z.number().min(0).max(100),
  }).strict(),
  z.object({
    status: z.literal('not-applicable'), numerator: z.literal(0), denominator: z.literal(0),
    reason: z.string().min(1).max(1024),
  }).strict(),
]).superRefine((metric, context) => {
  if (metric.status !== 'value') return
  if (metric.numerator > metric.denominator) {
    context.addIssue({ code: 'custom', message: 'numerator cannot exceed denominator', path: ['numerator'] })
  }
  const expected = metric.numerator / metric.denominator * 100
  if (Math.abs(metric.percentage - expected) > 1e-9) {
    context.addIssue({ code: 'custom', message: 'percentage must equal numerator/denominator', path: ['percentage'] })
  }
})

const ObligationSchema = z.object({
  obligationId: SafeIdSchema,
  necessity: z.enum(['required', 'advisory']),
  disposition: z.enum(['automated', 'manual', 'not-applicable']),
  caseIds: z.array(SafeIdSchema).max(256).optional(),
  manualProcedureId: SafeIdSchema.optional(),
  notApplicableRationale: z.string().min(1).max(4096).optional(),
}).strict().superRefine((obligation, context) => {
  if (obligation.caseIds && new Set(obligation.caseIds).size !== obligation.caseIds.length) {
    context.addIssue({ code: 'custom', message: 'caseIds must be unique', path: ['caseIds'] })
  }
  if (obligation.disposition === 'automated' && (!obligation.caseIds || obligation.caseIds.length === 0)) {
    context.addIssue({ code: 'custom', message: 'automated obligation requires caseIds', path: ['caseIds'] })
  }
  if (obligation.disposition === 'manual' && obligation.manualProcedureId === undefined) {
    context.addIssue({ code: 'custom', message: 'manual obligation requires manualProcedureId', path: ['manualProcedureId'] })
  }
  if (obligation.disposition === 'not-applicable' && obligation.notApplicableRationale === undefined) {
    context.addIssue({ code: 'custom', message: 'not-applicable obligation requires rationale', path: ['notApplicableRationale'] })
  }
  if (obligation.disposition !== 'automated' && obligation.caseIds !== undefined) {
    context.addIssue({ code: 'custom', message: 'only automated obligations may reference cases', path: ['caseIds'] })
  }
})

const AttemptSelectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('valid'), attemptId: SafeIdSchema, eventChainDigest: DigestSchema }).strict(),
  z.object({ status: z.literal('invalid'), reasonCode: ReasonCodeSchema }).strict(),
  z.object({ status: z.literal('not-started') }).strict(),
])

const CaseResultSchema = z.object({
  resultId: SafeIdSchema,
  caseId: SafeIdSchema,
  runId: SafeIdSchema,
  obligationIds: z.array(SafeIdSchema).min(1).max(256),
  status: CaseVerdictStatusSchema,
  executionMode: z.enum(['real-environment', 'gateway-injection']),
  baselineResultId: SafeIdSchema.optional(),
  attemptSelection: AttemptSelectionSchema,
}).strict().superRefine((result, context) => {
  if (new Set(result.obligationIds).size !== result.obligationIds.length) {
    context.addIssue({ code: 'custom', message: 'obligationIds must be unique', path: ['obligationIds'] })
  }
  if (['passed', 'failed'].includes(result.status) && result.attemptSelection.status !== 'valid') {
    context.addIssue({ code: 'custom', message: 'terminal business result requires valid attempt selection', path: ['attemptSelection'] })
  }
  if (result.attemptSelection.status === 'invalid' && result.status !== 'safety-blocked') {
    context.addIssue({ code: 'custom', message: 'invalid attempt selection must be safety-blocked', path: ['status'] })
  }
})

const GatewayAuditSchema = z.object({
  status: z.enum(['valid', 'incomplete', 'invalid']),
  required: z.boolean(),
  reasonCodes: z.array(ReasonCodeSchema).max(256),
}).strict().superRefine((audit, context) => {
  if (audit.status === 'valid' && audit.reasonCodes.length > 0) {
    context.addIssue({ code: 'custom', message: 'valid gateway audit cannot contain failure reasons', path: ['reasonCodes'] })
  }
  if (audit.status !== 'valid' && audit.reasonCodes.length === 0) {
    context.addIssue({ code: 'custom', message: 'failed gateway audit requires reasonCodes', path: ['reasonCodes'] })
  }
})

const CompletionAuditSchema = z.object({
  status: z.enum(['complete', 'incomplete', 'invalid']),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  reasonCodes: z.array(ReasonCodeSchema).max(256),
}).strict().superRefine((audit, context) => {
  if (audit.complete > audit.total) context.addIssue({ code: 'custom', message: 'complete exceeds total', path: ['complete'] })
  if (audit.status === 'complete' && audit.complete !== audit.total) {
    context.addIssue({ code: 'custom', message: 'complete audit requires complete=total', path: ['status'] })
  }
  if (audit.status === 'complete' && audit.reasonCodes.length > 0) {
    context.addIssue({ code: 'custom', message: 'complete audit cannot contain failure reasons', path: ['reasonCodes'] })
  }
  if (audit.status === 'incomplete' && audit.complete >= audit.total) {
    context.addIssue({ code: 'custom', message: 'incomplete audit requires complete<total', path: ['status'] })
  }
  if (audit.status !== 'complete' && audit.reasonCodes.length === 0) {
    context.addIssue({ code: 'custom', message: 'failed audit requires reasonCodes', path: ['reasonCodes'] })
  }
})

export const VerdictInputSchema = z.object({
  schemaVersion: z.literal('2.1.0'),
  assetId: AssetIdSchema,
  generationId: SafeIdSchema,
  verdictRuleVersion: SemverSchema,
  policyDigest: DigestSchema,
  universeDigest: DigestSchema,
  prdRevision: DigestSchema,
  requirementModelDigest: DigestSchema,
  obligations: z.array(ObligationSchema).max(100_000),
  caseResults: z.array(CaseResultSchema).max(100_000),
  manualResults: z.array(ManualResultSchema).max(100_000),
  pendingDecisionIds: z.array(SafeIdSchema).max(10_000),
  safetyFindings: z.array(ReasonCodeSchema).max(10_000),
  artifactFindings: z.array(ReasonCodeSchema).max(10_000),
  migrationFindings: z.array(ReasonCodeSchema).max(10_000),
  environmentFindings: z.array(ReasonCodeSchema).max(10_000),
  automationFindings: z.array(ReasonCodeSchema).max(10_000),
  gatewayAudit: GatewayAuditSchema,
  evidenceAudit: CompletionAuditSchema,
  cleanupAudit: CompletionAuditSchema,
  coverageFacts: z.object({
    prdClauses: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    requirementDesign: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    rules: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    oracles: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    cases: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    criticalNodes: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    roles: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    stateTransitions: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    scenarioCategories: z.object({ covered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  }).strict().superRefine((facts, context) => {
    Object.entries(facts).forEach(([key, fact]) => {
      if (fact.covered > fact.total) context.addIssue({ code: 'custom', message: 'covered exceeds total', path: [key, 'covered'] })
    })
  }),
}).strict().superRefine((input, context) => {
  unique(input.obligations.map((item) => item.obligationId), ['obligations'], context)
  try {
    assertExecutionResultIdentities(input.caseResults.map((item) => ({
      resultId: item.resultId, caseId: item.caseId, mode: item.executionMode,
      status: item.status, ...(item.baselineResultId ? { baselineResultId: item.baselineResultId } : {}),
    })))
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '执行结果身份无效', path: ['caseResults'] })
  }
  unique(input.manualResults.map((item) => item.manualResultId), ['manualResults'], context)
  unique(input.pendingDecisionIds, ['pendingDecisionIds'], context)
})

export const FinalVerdictSchema = z.enum([
  'accepted', 'rejected', 'incomplete', 'pending-decision', 'safety-blocked',
  'artifact-blocked', 'migration-required', 'environment-blocked', 'automation-blocked',
])

export const VerdictResultSchema = z.object({
  verdictRuleVersion: SemverSchema,
  verdict: FinalVerdictSchema,
  reasonCodes: z.array(ReasonCodeSchema).min(1),
  cannotClaim: z.array(z.string().min(1).max(4096)),
  businessFailuresObserved: z.array(SafeIdSchema),
  advisoryFailures: z.array(SafeIdSchema),
  metrics: z.object({
    clauseDispositionCoverage: MetricSchema,
    requirementDesignCoverage: MetricSchema,
    ruleCoverage: MetricSchema,
    oracleCoverage: MetricSchema,
    caseDesignCoverage: MetricSchema,
    criticalNodeCoverage: MetricSchema,
    roleCoverage: MetricSchema,
    stateTransitionCoverage: MetricSchema,
    scenarioCategoryCoverage: MetricSchema,
    automationDispositionCoverage: MetricSchema,
    executionCoverage: MetricSchema,
    realPassRate: MetricSchema,
    injectionPassRate: MetricSchema,
    evidenceCompleteness: MetricSchema,
    cleanupSuccess: MetricSchema,
    blockingRate: MetricSchema,
  }).strict(),
}).strict()

function unique(values: string[], path: Array<string | number>, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'values must be unique', path })
}

export type CaseVerdictStatus = z.infer<typeof CaseVerdictStatusSchema>
export type Metric = z.infer<typeof MetricSchema>
export type VerdictInput = z.infer<typeof VerdictInputSchema>
export type FinalVerdict = z.infer<typeof FinalVerdictSchema>
export type VerdictResult = z.infer<typeof VerdictResultSchema>
