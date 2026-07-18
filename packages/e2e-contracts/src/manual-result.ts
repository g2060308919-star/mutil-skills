import { z } from 'zod'
import { AssetIdSchema, canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const ActorSchema = z.object({
  subject: z.string().min(1).max(256),
  roles: z.array(z.string().min(1).max(128)).min(1).max(32),
}).strict()
const OutcomeSchema = z.enum(['passed', 'failed', 'unable'])

export const ManualStepResultSchema = z.object({
  stepId: SafeIdSchema,
  instructionDigest: DigestSchema,
  outcome: OutcomeSchema,
  observation: z.string().min(1).max(16 * 1024),
  evidenceDigests: z.array(DigestSchema).min(1).max(256),
}).strict()

const ManualResultDraftObjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  manualResultId: SafeIdSchema,
  runId: SafeIdSchema,
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  generationId: SafeIdSchema,
  runtimeInstallationDigest: DigestSchema,
  manualProcedureId: SafeIdSchema,
  caseIds: z.array(SafeIdSchema).min(1).max(256),
  obligationIds: z.array(SafeIdSchema).min(1).max(256),
  requirementModelDigest: DigestSchema,
  executor: ActorSchema,
  reviewer: ActorSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  outcome: OutcomeSchema,
  steps: z.array(ManualStepResultSchema).min(1).max(10_000),
  evidenceDigests: z.array(DigestSchema).min(1).max(10_000),
  expiresAt: z.string().datetime(),
}).strict()

export const ManualResultUserPresenceProofSchema = z.object({
  role: z.enum(['executor', 'reviewer']),
  approvalType: z.enum(['manual-executor', 'manual-reviewer']),
  requiredRole: z.enum(['e2e-manual-executor', 'e2e-manual-reviewer']),
  subject: SafeIdSchema,
  sessionId: SafeIdSchema,
  runId: SafeIdSchema,
  installationDigest: DigestSchema,
  draftDigest: DigestSchema,
  origin: z.string().url().refine((value) => {
    const origin = new URL(value)
    return origin.protocol === 'http:' && origin.hostname === 'localhost'
      && origin.port !== '' && origin.origin === value
  }, 'manual user-presence origin must be an exact localhost origin'),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((proof, context) => {
  const expected = proof.role === 'executor'
    ? { approvalType: 'manual-executor', requiredRole: 'e2e-manual-executor' }
    : { approvalType: 'manual-reviewer', requiredRole: 'e2e-manual-reviewer' }
  if (proof.approvalType !== expected.approvalType) context.addIssue({
    code: 'custom', path: ['approvalType'], message: 'manual approval type does not match role',
  })
  if (proof.requiredRole !== expected.requiredRole) context.addIssue({
    code: 'custom', path: ['requiredRole'], message: 'manual required role does not match role',
  })
  if (Date.parse(proof.expiresAt) <= Date.parse(proof.issuedAt)) context.addIssue({
    code: 'custom', path: ['expiresAt'], message: 'manual user-presence proof must expire after issuance',
  })
})

export const ManualResultAuthorityProofSchema = z.object({
  issuer: z.string().min(1).max(256),
  keyId: z.string().min(1).max(256),
  proofScope: z.literal('local-os-user'),
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(16 * 1024),
  executorPresence: ManualResultUserPresenceProofSchema,
  reviewerPresence: ManualResultUserPresenceProofSchema,
}).strict()

export const ManualResultDraftSchema = ManualResultDraftObjectSchema.superRefine(validateManualResult)
export const ManualResultSchema = ManualResultDraftObjectSchema.extend({
  authorityProof: ManualResultAuthorityProofSchema,
}).strict().superRefine((result, context) => {
  validateManualResult(result, context)
  validateManualResultAuthorityProof(result, context)
})

function validateManualResult(
  result: z.infer<typeof ManualResultDraftObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (!result.executor.roles.includes('e2e-manual-executor')) {
    context.addIssue({ code: 'custom', message: 'executor role required', path: ['executor', 'roles'] })
  }
  if (!result.reviewer.roles.includes('e2e-manual-reviewer')) {
    context.addIssue({ code: 'custom', message: 'reviewer role required', path: ['reviewer', 'roles'] })
  }
  if (result.executor.subject === result.reviewer.subject) {
    context.addIssue({ code: 'custom', message: 'executor and reviewer must differ', path: ['reviewer', 'subject'] })
  }
  const startedAt = Date.parse(result.startedAt)
  const finishedAt = Date.parse(result.finishedAt)
  const expiresAt = Date.parse(result.expiresAt)
  if (finishedAt < startedAt) {
    context.addIssue({ code: 'custom', message: 'finishedAt must not precede startedAt', path: ['finishedAt'] })
  }
  if (expiresAt <= finishedAt) {
    context.addIssue({ code: 'custom', message: 'expiresAt must follow finishedAt', path: ['expiresAt'] })
  }
  assertUnique(result.obligationIds, ['obligationIds'], context)
  assertUnique(result.caseIds, ['caseIds'], context)
  assertUnique(result.steps.map((step) => step.stepId), ['steps'], context)
  assertUnique(result.evidenceDigests, ['evidenceDigests'], context)
  const evidence = new Set(result.evidenceDigests)
  if (result.steps.some((step) => step.evidenceDigests.some((digest) => !evidence.has(digest)))) {
    context.addIssue({ code: 'custom', message: 'step evidence must be included in result evidence', path: ['evidenceDigests'] })
  }
  const stepOutcomes = result.steps.map((step) => step.outcome)
  const aggregatedOutcome = stepOutcomes.includes('failed')
    ? 'failed'
    : stepOutcomes.includes('unable') ? 'unable' : 'passed'
  const consistent = result.outcome === aggregatedOutcome
  if (!consistent) context.addIssue({ code: 'custom', message: 'result outcome contradicts step outcomes', path: ['outcome'] })
}

function validateManualResultAuthorityProof(
  result: z.infer<typeof ManualResultDraftObjectSchema> & {
    authorityProof: z.infer<typeof ManualResultAuthorityProofSchema>
  },
  context: z.RefinementCtx,
): void {
  const { authorityProof, ...draft } = result
  const expectedDraftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
  const roles = [
    { key: 'executorPresence' as const, actor: result.executor, role: 'executor',
      approvalType: 'manual-executor', requiredRole: 'e2e-manual-executor' },
    { key: 'reviewerPresence' as const, actor: result.reviewer, role: 'reviewer',
      approvalType: 'manual-reviewer', requiredRole: 'e2e-manual-reviewer' },
  ] as const
  for (const binding of roles) {
    const proof = authorityProof[binding.key]
    if (proof.role !== binding.role || proof.approvalType !== binding.approvalType
      || proof.requiredRole !== binding.requiredRole || proof.subject !== binding.actor.subject
      || !binding.actor.roles.includes(binding.requiredRole)
      || proof.runId !== result.runId || proof.installationDigest !== result.runtimeInstallationDigest
      || proof.draftDigest !== expectedDraftDigest) {
      context.addIssue({
        code: 'custom', path: ['authorityProof', binding.key],
        message: 'manual user-presence proof is not exactly bound to the result draft and actor role',
      })
    }
  }
  if (authorityProof.executorPresence.sessionId === authorityProof.reviewerPresence.sessionId) {
    context.addIssue({
      code: 'custom', path: ['authorityProof', 'reviewerPresence', 'sessionId'],
      message: 'executor and reviewer must use distinct user-presence sessions',
    })
  }
}

function assertUnique(values: string[], path: Array<string | number>, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'values must be unique', path })
  }
}

export type ManualStepResult = z.infer<typeof ManualStepResultSchema>
export type ManualResultDraft = z.infer<typeof ManualResultDraftSchema>
export type ManualResultAuthorityProof = z.infer<typeof ManualResultAuthorityProofSchema>
export type ManualResultUserPresenceProof = z.infer<typeof ManualResultUserPresenceProofSchema>
export type ManualResult = z.infer<typeof ManualResultSchema>

export type ManualResultVerification =
  | { valid: true }
  | { valid: false; code: string; impact: 'safety-blocked' | 'incomplete' }
