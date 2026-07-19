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
  effects: z.array(ApprovalEffectSchema).max(16)
    .refine((values) => new Set(values).size === values.length, 'effect 必须唯一'),
  maxUses: z.number().int().nonnegative().max(100_000),
  secretRefs: UniqueSafeIdsSchema,
  dataLeaseRefs: UniqueSafeIdsSchema,
  cleanupRefs: UniqueSafeIdsSchema,
  injectionClassifications: UniqueSafeIdsSchema,
  subjectDigest: DigestSchema,
  expiresAt: z.string().datetime({ offset: true }),
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
export type OpenApprovalResult = z.infer<typeof OpenApprovalResultSchema>
