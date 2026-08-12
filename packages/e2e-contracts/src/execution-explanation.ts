import { z } from 'zod'
import { FinalVerdictSchema } from './verdict.js'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Reason = z.string().regex(/^E2E_[A-Z0-9_]+$/)

export const TimelineEventV1Schema = z.object({
  eventId: Id, sequence: z.number().int().positive(),
  phase: z.enum(['clause', 'requirement', 'case', 'action', 'approval', 'chrome', 'oracle',
    'evidence', 'cleanup', 'healing', 'cancel', 'verdict']),
  caseId: Id.optional(), actionId: Id.optional(), oracleId: Id.optional(), attemptId: Id.optional(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'blocked', 'cancelled', 'not-executed']),
  reasonCode: Reason.optional(), pageIdentity: z.string().min(1).max(8_192).optional(),
  frameIdentity: z.string().min(1).max(2_048).optional(), waitReason: Reason.optional(),
  deadlineAt: z.string().datetime().optional(), at: z.string().datetime(),
}).strict()

export const FailureExplanationV1Schema = z.object({
  failureId: Id, responsibility: z.enum(['product', 'environment', 'runtime', 'test-asset', 'external']),
  reasonCode: Reason, firstAttemptId: Id, finalAttemptId: Id, safeToRetry: z.boolean(),
  preservedAssets: z.array(Id).max(1_000).default([]), invalidatedAssets: z.array(Id).max(1_000).default([]),
  nextLegalEdge: z.string().min(1).max(128), remediation: z.array(z.string().min(1).max(4_096)).max(100),
}).strict()

export const ClaimClassificationV1Schema = z.object({
  claimId: Id, component: z.enum(['browser-product', 'backend', 'database', 'idp', 'gateway', 'runtime']),
  status: z.enum(['observed', 'verified', 'inferred', 'not-executed', 'unsupported']),
  evidenceIds: z.array(Id).max(10_000), reason: z.string().min(1).max(8_192),
}).strict().superRefine((value, context) => {
  if (value.status === 'verified' && value.evidenceIds.length === 0) context.addIssue({
    code: 'custom', path: ['evidenceIds'], message: 'verified claim 必须绑定 Evidence',
  })
})

export const ExecutionExplanationV1Schema = z.object({
  schemaVersion: z.literal('execution-explanation/v1'), runId: Id,
  verdict: z.union([FinalVerdictSchema, z.literal('cancelled')]),
  timeline: z.array(TimelineEventV1Schema).max(1_000_000),
  failures: z.array(FailureExplanationV1Schema).max(100_000),
  claims: z.array(ClaimClassificationV1Schema).max(100_000), lineageDigest: Digest,
}).strict().superRefine((value, context) => {
  const ordered = value.timeline.every((event, index) => index === 0
    || event.sequence > value.timeline[index - 1]!.sequence)
  if (!ordered) context.addIssue({ code: 'custom', path: ['timeline'], message: 'Timeline sequence 必须严格递增' })
  const failedOracle = value.timeline.some((event) => event.phase === 'oracle' && event.status !== 'passed')
  const incompleteClaim = value.claims.some((claim) => claim.status !== 'verified')
  if (value.verdict === 'accepted' && (failedOracle || incompleteClaim)) context.addIssue({
    code: 'custom', path: ['verdict'], message: 'accepted 只能来自全部 Oracle 和 claim 的有效 verified 事实',
  })
})

export type TimelineEventV1 = z.infer<typeof TimelineEventV1Schema>
export type FailureExplanationV1 = z.infer<typeof FailureExplanationV1Schema>
export type ClaimClassificationV1 = z.infer<typeof ClaimClassificationV1Schema>
export type ExecutionExplanationV1 = z.infer<typeof ExecutionExplanationV1Schema>
