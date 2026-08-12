import { z } from 'zod'

export interface LocatorCandidate {
  strategy: 'role' | 'label' | 'test-id' | 'css'
  value: string
}

export interface ExplicitWaitCondition {
  kind: 'visible' | 'attached' | 'response' | 'url' | 'text'
  timeoutMs: number
}

export type HealingMutation =
  | { kind: 'locator-candidate'; before: LocatorCandidate[]; after: LocatorCandidate[] }
  | { kind: 'locator-scope'; before: LocatorCandidate; after: LocatorCandidate }
  | { kind: 'wait-condition'; before: ExplicitWaitCondition; after: ExplicitWaitCondition }
  | { kind: 'equivalent-action'; before: string; after: string }
  | { kind: 'page-identity-nonrequirement-signal'; before: { name: string; value: string }; after: { name: string; value: string } }
  | { kind: 'evidence-capture-point'; before: string[]; after: string[] }
  | { kind: 'injection-technical-matcher'; before: string; after: string }

export interface HealingProposal {
  proposalId: string
  actionId: string
  baseRevision: number
  caseTimeoutMs: number
  semanticDigestBefore: string
  semanticDigestAfter: string
  approvalSubjectDigestBefore: string
  approvalSubjectDigestAfter: string
  mutations: HealingMutation[]
}

export interface HealingReviewContext {
  currentSemanticDigest: string
  currentApprovalSubjectDigest: string
  protectedPageIdentitySignals: string[]
}

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const LocatorCandidateSchema = z.object({
  strategy: z.enum(['role', 'label', 'test-id', 'css']), value: z.string().min(1).max(2_048),
}).strict()
const ExplicitWaitConditionSchema = z.object({
  kind: z.enum(['visible', 'attached', 'response', 'url', 'text']),
  timeoutMs: z.number().int().positive().max(3_600_000),
}).strict()
const HealingMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('locator-candidate'), before: z.array(LocatorCandidateSchema).min(1).max(10),
    after: z.array(LocatorCandidateSchema).min(1).max(10) }).strict(),
  z.object({ kind: z.literal('locator-scope'), before: LocatorCandidateSchema,
    after: LocatorCandidateSchema }).strict(),
  z.object({ kind: z.literal('wait-condition'), before: ExplicitWaitConditionSchema,
    after: ExplicitWaitConditionSchema }).strict(),
  z.object({ kind: z.literal('equivalent-action'), before: z.string().min(1).max(256),
    after: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('page-identity-nonrequirement-signal'),
    before: z.object({ name: z.string().min(1).max(128), value: z.string().max(2_048) }).strict(),
    after: z.object({ name: z.string().min(1).max(128), value: z.string().max(2_048) }).strict() }).strict(),
  z.object({ kind: z.literal('evidence-capture-point'), before: z.array(SafeIdSchema).max(20),
    after: z.array(SafeIdSchema).max(20) }).strict(),
  z.object({ kind: z.literal('injection-technical-matcher'), before: z.string().min(1).max(8 * 1024),
    after: z.string().min(1).max(8 * 1024) }).strict(),
])

export const HealingProposalSchema = z.object({
  proposalId: SafeIdSchema, actionId: SafeIdSchema,
  baseRevision: z.number().int().positive(), caseTimeoutMs: z.number().int().positive().max(3_600_000),
  semanticDigestBefore: DigestSchema, semanticDigestAfter: DigestSchema,
  approvalSubjectDigestBefore: DigestSchema, approvalSubjectDigestAfter: DigestSchema,
  mutations: z.array(HealingMutationSchema).min(1).max(20),
}).strict()

/** Runtime 产品入口只接受候选意图；所有 revision/digest 均由可信快照派生。 */
export const RuntimeHealingCandidateSchema = HealingProposalSchema.pick({
  proposalId: true,
  actionId: true,
  caseTimeoutMs: true,
  mutations: true,
}).strict()

export type RuntimeHealingCandidate = z.infer<typeof RuntimeHealingCandidateSchema>

export const RuntimeHealingAuditFactSchema = z.object({
  schemaVersion: z.literal('runtime-healing-audit/v1'),
  proposalId: SafeIdSchema,
  caseId: SafeIdSchema,
  actionId: SafeIdSchema,
  firstAttemptId: SafeIdSchema,
  finalAttemptId: SafeIdSchema.optional(),
  firstEvidenceDigest: DigestSchema,
  requiredOracleIds: z.array(SafeIdSchema).min(1).max(10_000),
  replayedOracleIds: z.array(SafeIdSchema).max(10_000).optional(),
  revision: z.number().int().min(2),
  changeDigest: DigestSchema,
  status: z.enum(['awaiting-execution-approval', 'awaiting-replay', 'accepted', 'rejected']),
}).strict().superRefine((fact, context) => {
  const terminal = fact.status === 'accepted' || fact.status === 'rejected'
  if (terminal !== (fact.finalAttemptId !== undefined)) context.addIssue({
    code: 'custom', path: ['finalAttemptId'], message: '修复终态必须且只能绑定 final Attempt',
  })
  if (terminal !== (fact.replayedOracleIds !== undefined)) context.addIssue({
    code: 'custom', path: ['replayedOracleIds'], message: '修复终态必须且只能记录重跑 Oracle',
  })
  if (fact.finalAttemptId !== undefined && fact.finalAttemptId === fact.firstAttemptId) context.addIssue({
    code: 'custom', path: ['finalAttemptId'], message: '修复必须创建新的 Attempt',
  })
  if (fact.status === 'accepted'
    && [...new Set(fact.requiredOracleIds)].sort().join('\0')
      !== [...new Set(fact.replayedOracleIds ?? [])].sort().join('\0')) context.addIssue({
    code: 'custom', path: ['replayedOracleIds'], message: 'accepted 修复必须重跑全部相关 Oracle',
  })
})

export type RuntimeHealingAuditFact = z.infer<typeof RuntimeHealingAuditFactSchema>

export type HealingReview =
  | {
      accepted: true
      reasonCodes: []
      nextRevision: number
      actionMapDigest: string
      requiresReapproval: boolean
    }
  | { accepted: false; reasonCodes: string[] }
