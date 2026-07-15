import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const NonEmptyTextSchema = z.string().min(1).max(16 * 1024)
const ApproverSchema = z.object({
  subject: SafeIdSchema,
  roles: z.array(SafeIdSchema).min(1).max(64),
}).strict()

const IncludedRequirementSchema = z.object({
  reqId: SafeIdSchema,
  sourceRefs: z.array(NonEmptyTextSchema).min(1),
}).strict()
const ExclusionSchema = z.object({
  reqId: SafeIdSchema,
  rationale: NonEmptyTextSchema,
  decisionId: SafeIdSchema,
}).strict()
const AmbiguitySchema = z.object({
  ambiguityId: SafeIdSchema,
  question: NonEmptyTextSchema,
  status: z.enum(['resolved', 'pending']),
  decisionId: SafeIdSchema.optional(),
  resolution: NonEmptyTextSchema.optional(),
}).strict().superRefine((ambiguity, context) => {
  if (ambiguity.status === 'resolved' && (!ambiguity.decisionId || !ambiguity.resolution)) {
    context.addIssue({ code: 'custom', message: 'resolved ambiguity 必须绑定 decisionId 与 resolution' })
  }
  if (ambiguity.status === 'pending' && ambiguity.resolution !== undefined) {
    context.addIssue({ code: 'custom', message: 'pending ambiguity 不得提前写入 resolution' })
  }
})
const DependencySchema = z.object({
  dependencyId: SafeIdSchema,
  status: z.enum(['available', 'blocked']),
  digest: DigestSchema,
}).strict()
const SectionChangeSchema = z.object({
  sectionId: SafeIdSchema,
  kind: z.enum(['added', 'changed', 'removed']),
  digest: DigestSchema,
}).strict()

const LineageEntityKindSchema = z.enum([
  'requirement', 'rule', 'flow', 'node', 'obligation', 'case', 'step', 'action',
])
const UniqueLineageIdsSchema = z.array(SafeIdSchema).max(100_000)
  .refine((values) => new Set(values).size === values.length, 'lineage ID 必须唯一')

export const EntityLineageMappingSchema = z.object({
  entityKind: LineageEntityKindSchema,
  semanticKey: NonEmptyTextSchema,
  disposition: z.enum(['preserved', 'created', 'deprecated', 'split', 'merged']),
  previousIds: UniqueLineageIdsSchema,
  currentIds: UniqueLineageIdsSchema,
  confidence: z.number().min(0).max(1),
  confirmation: z.enum(['deterministic-exact', 'authority-confirmed']),
  rationale: NonEmptyTextSchema,
  sourceRefs: z.array(NonEmptyTextSchema).min(1).max(10_000),
}).strict().superRefine((mapping, context) => {
  const previous = mapping.previousIds
  const current = mapping.currentIds
  const exact = mapping.confirmation === 'deterministic-exact'
  const issue = (message: string, path: string) => context.addIssue({ code: 'custom', message, path: [path] })
  if (mapping.disposition === 'preserved'
    && (previous.length !== 1 || current.length !== 1 || previous[0] !== current[0])) {
    issue('preserved 必须一对一保持相同稳定 ID', 'disposition')
  }
  if (mapping.disposition === 'created' && (previous.length !== 0 || current.length !== 1)) {
    issue('created 必须仅包含一个新 ID', 'disposition')
  }
  if (mapping.disposition === 'deprecated' && (previous.length !== 1 || current.length !== 0)) {
    issue('deprecated 必须仅包含一个旧 ID', 'disposition')
  }
  if (mapping.disposition === 'split' && (previous.length !== 1 || current.length < 2)) {
    issue('split 必须由一个旧 ID 拆为至少两个新 ID', 'disposition')
  }
  if (mapping.disposition === 'merged' && (previous.length < 2 || current.length !== 1)) {
    issue('merged 必须由至少两个旧 ID 合为一个新 ID', 'disposition')
  }
  if (['split', 'merged'].includes(mapping.disposition) && exact) {
    issue('split/merged 禁止 Core 自动确认，必须经 Authority 明确确认', 'confirmation')
  }
  if (exact && mapping.confidence !== 1) {
    issue('deterministic-exact 的 confidence 必须为 1', 'confidence')
  }
  if (mapping.disposition !== 'preserved'
    && previous.some((id) => current.includes(id))) {
    issue('非 preserved 映射不得复用旧 ID', 'currentIds')
  }
})

export const EntityLineageMappingsSchema = z.array(EntityLineageMappingSchema).max(100_000)
  .superRefine((mappings, context) => {
    const keys = mappings.map((mapping) => `${mapping.entityKind}\0${mapping.semanticKey}`)
    const sorted = [...keys].sort()
    if (keys.some((key, index) => key !== sorted[index])) {
      context.addIssue({ code: 'custom', message: 'lineageMappings 必须按 entityKind/semanticKey 排序' })
    }
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'entityKind/semanticKey 映射必须唯一' })
    }
    const previousIds = mappings.flatMap((mapping) => mapping.previousIds)
    const currentIds = mappings.flatMap((mapping) => mapping.currentIds)
    if (new Set(previousIds).size !== previousIds.length) {
      context.addIssue({ code: 'custom', message: '旧实体 ID 不得出现在多个 lineage 映射中' })
    }
    if (new Set(currentIds).size !== currentIds.length) {
      context.addIssue({ code: 'custom', message: '新实体 ID 不得出现在多个 lineage 映射中' })
    }
  })

export const ScopeDecisionSubjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  kind: z.literal('scope'),
  includedReqCandidates: z.array(IncludedRequirementSchema).max(100_000),
  exclusions: z.array(ExclusionSchema).max(100_000),
  ambiguities: z.array(AmbiguitySchema).max(100_000),
  dependencies: z.array(DependencySchema).max(100_000),
  visualScope: z.object({ required: z.boolean(), refs: z.array(SafeIdSchema) }).strict(),
  browserScope: z.object({
    browserIds: z.array(SafeIdSchema).min(1),
    viewportIds: z.array(SafeIdSchema).min(1),
  }).strict(),
}).strict()

export const LineageDecisionSubjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  kind: z.literal('lineage'),
  previousRevision: DigestSchema,
  currentRevision: DigestSchema,
  sectionChanges: z.array(SectionChangeSchema).max(10_000),
  lineageMappings: EntityLineageMappingsSchema,
  impactedEntityIds: z.array(SafeIdSchema).max(100_000)
    .refine((values) => new Set(values).size === values.length, 'ID 必须唯一'),
}).strict()

export const CoverageDispositionDecisionSubjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  kind: z.literal('coverage-disposition'),
  obligationId: SafeIdSchema,
  requirementModelDigest: DigestSchema,
  coveragePolicyDigest: DigestSchema,
  disposition: z.literal('not-applicable'),
  policyCode: SafeIdSchema,
  rationale: NonEmptyTextSchema,
}).strict()

export const DecisionSubjectSchema = z.discriminatedUnion('kind', [
  ScopeDecisionSubjectSchema,
  LineageDecisionSubjectSchema,
  CoverageDispositionDecisionSubjectSchema,
])

const DecisionReceiptBaseSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  decisionId: SafeIdSchema,
  decisionStatus: z.enum(['approved', 'rejected']),
  decisionSubjectDigest: DigestSchema,
  checkedAt: z.string().datetime({ offset: true }),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  approver: ApproverSchema,
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(4096),
})

export const ScopeDecisionReceiptSchema = DecisionReceiptBaseSchema.extend({
  kind: z.literal('scope'),
  purpose: z.literal('scope-decision-receipt/v1'),
}).strict()

export const LineageDecisionReceiptSchema = DecisionReceiptBaseSchema.extend({
  kind: z.literal('lineage'),
  purpose: z.literal('lineage-decision-receipt/v1'),
}).strict()

export const CoverageDispositionDecisionReceiptSchema = DecisionReceiptBaseSchema.extend({
  kind: z.literal('coverage-disposition'),
  purpose: z.literal('coverage-disposition-decision-receipt/v1'),
}).strict()

export const DecisionReceiptSchema = z.discriminatedUnion('kind', [
  ScopeDecisionReceiptSchema,
  LineageDecisionReceiptSchema,
  CoverageDispositionDecisionReceiptSchema,
])

export const DecisionReceiptVerificationBindingSchema = z.object({
  kind: z.enum(['scope', 'lineage', 'coverage-disposition']),
  decisionId: SafeIdSchema,
  decisionStatus: z.enum(['approved', 'rejected']),
  decisionSubjectDigest: DigestSchema,
}).strict()

export const DecisionVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('decision-receipt/v1'),
  algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024),
  publicKeyDigest: DigestSchema,
}).strict()

const ScopeProjectionInputSchema = ScopeDecisionSubjectSchema.omit({ schemaVersion: true, kind: true })
  .extend({ scopeDecision: z.unknown().optional() }).strict()
const LineageProjectionInputSchema = LineageDecisionSubjectSchema.omit({ schemaVersion: true, kind: true })
  .extend({ lineageReview: z.unknown().optional() }).strict()

export function projectScopeDecisionSubject(candidate: unknown): ScopeDecisionSubject {
  const { scopeDecision: _decision, ...facts } = ScopeProjectionInputSchema.parse(candidate)
  return ScopeDecisionSubjectSchema.parse({ schemaVersion: '1.0.0', kind: 'scope', ...facts })
}

export function projectLineageDecisionSubject(candidate: unknown): LineageDecisionSubject {
  const { lineageReview: _decision, ...facts } = LineageProjectionInputSchema.parse(candidate)
  return LineageDecisionSubjectSchema.parse({ schemaVersion: '1.0.0', kind: 'lineage', ...facts })
}

export function projectCoverageDispositionDecisionSubject(
  candidate: unknown,
): CoverageDispositionDecisionSubject {
  return CoverageDispositionDecisionSubjectSchema.parse({
    schemaVersion: '1.0.0', kind: 'coverage-disposition', ...candidate as Record<string, unknown>,
  })
}

export function digestDecisionSubject(candidate: DecisionSubject): string {
  const subject = DecisionSubjectSchema.parse(candidate)
  return digestText(`${subject.kind}-decision-subject/v1`, canonicalizeJson(subject))
}

export type ScopeDecisionSubject = z.infer<typeof ScopeDecisionSubjectSchema>
export type LineageDecisionSubject = z.infer<typeof LineageDecisionSubjectSchema>
export type CoverageDispositionDecisionSubject = z.infer<typeof CoverageDispositionDecisionSubjectSchema>
export type EntityLineageMapping = z.infer<typeof EntityLineageMappingSchema>
export type DecisionSubject = z.infer<typeof DecisionSubjectSchema>
export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>
export type DecisionReceiptVerificationBinding = z.infer<typeof DecisionReceiptVerificationBindingSchema>
export type DecisionVerifierMaterial = z.infer<typeof DecisionVerifierMaterialSchema>
