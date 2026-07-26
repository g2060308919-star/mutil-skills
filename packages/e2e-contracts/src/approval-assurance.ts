import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const UniqueSafeIdsSchema = z.array(SafeIdSchema).max(256)
  .refine((values) => new Set(values).size === values.length, '值必须唯一')

export const ApprovalModeSchema = z.enum(['local-confirmation', 'webauthn'])
export const ApprovalAssuranceSchema = z.object({
  approvalMode: ApprovalModeSchema,
  identityVerified: z.boolean(),
  separationOfDutiesVerified: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.approvalMode === 'local-confirmation'
    && (value.identityVerified || value.separationOfDutiesVerified)) {
    context.addIssue({ code: 'custom', message: '本地确认不得声明身份验证或职责分离' })
  }
})

export const RiskTierSchema = z.enum(['local', 'test', 'staging', 'production'])
export const ApprovalTypeSchema = z.enum([
  'scope', 'lineage', 'discovery', 'execution', 'privacy',
  'manual-executor', 'manual-reviewer',
])
export const ApprovalEffectSchema = z.enum([
  'read', 'reversible-write', 'irreversible-write', 'injection', 'privacy-unlock', 'manual',
])

const SemanticIdSchema = z.string().min(1).max(256)
const SemanticOracleSchema = z.object({
  oracleId: SemanticIdSchema,
  ruleId: SemanticIdSchema,
  statement: z.string().min(1).max(64 * 1024),
  sourceRefs: z.array(z.string().min(1).max(4 * 1024)).min(1).max(1_000),
}).strict()

const SemanticClauseBaseSchema = z.object({
  clauseId: SemanticIdSchema,
  sourceId: SemanticIdSchema,
  kind: z.enum([
    'functional', 'validation', 'state', 'error', 'visual', 'permission',
    'non-functional', 'out-of-scope', 'context',
  ]),
  sourceSpan: z.object({
    startLine: z.number().int().positive(), startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(), endColumn: z.number().int().positive(),
  }).strict(),
  originalText: z.string().min(1).max(1024 * 1024),
  normalizedText: z.string().min(1).max(1024 * 1024),
})

const SemanticClauseSchema = z.discriminatedUnion('disposition', [
  SemanticClauseBaseSchema.extend({
    disposition: z.literal('modeled'),
    requirementIds: z.array(SemanticIdSchema).min(1).max(1_000),
  }).strict(),
  SemanticClauseBaseSchema.extend({
    disposition: z.literal('excluded'), reason: z.string().min(1).max(64 * 1024),
    decisionId: SemanticIdSchema,
  }).strict(),
  SemanticClauseBaseSchema.extend({
    disposition: z.literal('not-applicable'), reason: z.string().min(1).max(64 * 1024),
    decisionId: SemanticIdSchema,
  }).strict(),
  SemanticClauseBaseSchema.extend({
    disposition: z.literal('ambiguous'), ambiguityId: SemanticIdSchema,
  }).strict(),
])

export const PrdSemanticReviewSchema = z.object({
  prd: z.object({
    sourceRef: z.string().min(1).max(4 * 1024),
    normalizedText: z.string().min(1).max(1024 * 1024),
    normalizedDigest: DigestSchema,
    byteLength: z.number().int().positive().max(16 * 1024 * 1024),
  }).strict(),
  clauses: z.array(SemanticClauseSchema).min(1).max(100_000),
  requirements: z.array(z.object({
    reqId: SemanticIdSchema,
    title: z.string().min(1).max(64 * 1024),
    sourceRefs: z.array(z.string().min(1).max(4 * 1024)).min(1).max(1_000),
    rules: z.array(z.object({
      ruleId: SemanticIdSchema,
      statement: z.string().min(1).max(64 * 1024),
      sourceRefs: z.array(z.string().min(1).max(4 * 1024)).min(1).max(1_000),
      oracleMapping: z.enum(['explicit', 'requirement-level']),
      oracles: z.array(SemanticOracleSchema).min(1).max(1_000),
    }).strict()).min(1).max(10_000),
  }).strict()).min(1).max(10_000),
  reviewDigest: DigestSchema,
}).strict()

export const LocalApprovalSummarySchema = z.object({
  runId: SafeIdSchema,
  approvalType: ApprovalTypeSchema,
  environmentId: SafeIdSchema,
  riskTier: RiskTierSchema,
  origins: z.array(z.string().url()).max(256)
    .refine((values) => new Set(values).size === values.length, 'Origin 必须唯一'),
  methods: z.array(z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])).max(16)
    .refine((values) => new Set(values).size === values.length, 'HTTP method 必须唯一'),
  actionCount: z.number().int().nonnegative().max(100_000),
  effects: z.array(z.union([ApprovalEffectSchema, z.literal('unknown')])).max(16)
    .refine((values) => new Set(values).size === values.length, 'effect 必须唯一'),
  maxUses: z.number().int().nonnegative().max(100_000),
  secretRefs: UniqueSafeIdsSchema,
  dataLeaseRefs: UniqueSafeIdsSchema,
  cleanupRefs: UniqueSafeIdsSchema,
  injectionClassifications: UniqueSafeIdsSchema,
  subjectDigest: DigestSchema,
  expiresAt: z.string().datetime({ offset: true }),
  semanticReview: PrdSemanticReviewSchema.optional(),
}).strict()

export const OpenApprovalResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('approved'), approvalMode: ApprovalModeSchema,
    receiptDigest: DigestSchema,
  }).strict(),
  z.object({
    status: z.literal('confirmation-required'), approvalMode: z.literal('local-confirmation'),
    confirmationId: SafeIdSchema, subjectDigest: DigestSchema,
    expiresAt: z.string().datetime({ offset: true }), summary: LocalApprovalSummarySchema,
  }).strict(),
  z.object({
    status: z.literal('webauthn-required'), approvalMode: z.literal('webauthn'),
    sessionId: SafeIdSchema,
    url: z.string().url().refine((value) => {
      const url = new URL(value)
      return url.protocol === 'http:' && url.hostname === 'localhost' && url.origin !== 'null'
    }, 'WebAuthn approval URL 必须是 localhost HTTP URL'),
  }).strict(),
])

export function approvalAssuranceForMode(mode: ApprovalMode): ApprovalAssurance {
  return ApprovalAssuranceSchema.parse(mode === 'local-confirmation'
    ? { approvalMode: mode, identityVerified: false, separationOfDutiesVerified: false }
    : { approvalMode: mode, identityVerified: true, separationOfDutiesVerified: true })
}

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>
export type ApprovalAssurance = z.infer<typeof ApprovalAssuranceSchema>
export type RiskTier = z.infer<typeof RiskTierSchema>
export type ApprovalType = z.infer<typeof ApprovalTypeSchema>
export type ApprovalEffect = z.infer<typeof ApprovalEffectSchema>
export type LocalApprovalSummary = z.infer<typeof LocalApprovalSummarySchema>
export type PrdSemanticReview = z.infer<typeof PrdSemanticReviewSchema>
export type OpenApprovalResult = z.infer<typeof OpenApprovalResultSchema>
