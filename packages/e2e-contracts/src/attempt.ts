import type { ExecutionEffect, ExecutionMode, RetryPolicy } from './diagnosis.js'
import type { CaseVerdictStatus } from './verdict.js'
import type { EffectObservation } from './verification.js'
import { z } from 'zod'
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const NonEmptyTextSchema = z.string().min(1).max(16 * 1024)

export const ATTEMPT_EVENT_PROOF_PURPOSE = 'attempt-event-authority-proof/v2' as const

export const AttemptEventVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  purpose: z.literal(ATTEMPT_EVENT_PROOF_PURPOSE),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  algorithm: z.literal('Ed25519'),
  publicKeySpki: NonEmptyTextSchema,
  publicKeyDigest: DigestSchema,
}).strict()
export type AttemptEventVerifierMaterial = z.infer<typeof AttemptEventVerifierMaterialSchema>

export interface AttemptTerminalSnapshot {
  status: CaseVerdictStatus
  mode: ExecutionMode
  effect: ExecutionEffect
  effectObservation: EffectObservation
  reservationSafeToVoid: boolean
  reservationId?: string
  outcomeDigest?: string
}

export interface AttemptEventAuthorityProof {
  purpose: typeof ATTEMPT_EVENT_PROOF_PURPOSE
  issuer: string
  keyId: string
  algorithm: 'Ed25519'
  signedDigest: string
  signature: string
}

export interface PersistedAttemptSelection {
  status: 'selected'
  attemptId: string
  slot: number
  eventChainDigest: string
}

export interface PersistedAttemptCase {
  caseId: string
  retryPolicy: RetryPolicy
  initialChainDigest: string
  events: AttemptEvent[]
  selection: PersistedAttemptSelection
}

interface AttemptEventCommon {
  sequence: number
  caseId: string
  slot: number
  attemptId: string
  timestamp: string
  previousChainDigest: string
  eventDigest: string
  authorityProof: AttemptEventAuthorityProof
}

export type AttemptEvent =
  | (AttemptEventCommon & { kind: 'started'; mode: ExecutionMode })
  | (AttemptEventCommon & { kind: 'terminal'; result: AttemptTerminalSnapshot })

export type AppendAttemptEventInput =
  | (Omit<Extract<AttemptEvent, { kind: 'started' }>, 'eventDigest' | 'authorityProof'>)
  | (Omit<Extract<AttemptEvent, { kind: 'terminal' }>, 'eventDigest' | 'authorityProof'>)

export type FinalAttemptSelection =
  | {
      status: 'selected'
      attemptId: string
      slot: number
      result: AttemptTerminalSnapshot
      eventChainDigest: string
    }
  | { status: 'safety-blocked'; reasonCodes: string[]; eventChainDigest: string }

export interface SelectFinalAttemptInput {
  caseId: string
  retryPolicy: RetryPolicy
  initialChainDigest: string
  events: AttemptEvent[]
  verifyAuthorityProof: (proof: AttemptEventAuthorityProof) => boolean
}

const ExecutionModeSchema = z.enum(['real-environment', 'gateway-injection'])
const ExecutionEffectSchema = z.enum(['read', 'reversible-write', 'irreversible-write'])
const EffectObservationSchema = z.enum(['not-applicable', 'proven-not-applied', 'applied', 'unknown'])
const RetryPolicySchema = z.enum(['none', 'read-automation-max-2', 'verified-not-applied-max-1'])

export const AttemptEventAuthorityProofSchema = z.object({
  purpose: z.literal(ATTEMPT_EVENT_PROOF_PURPOSE), issuer: SafeIdSchema, keyId: SafeIdSchema,
  algorithm: z.literal('Ed25519'), signedDigest: DigestSchema, signature: NonEmptyTextSchema,
}).strict()
const AttemptTerminalBaseSchema = z.object({
  mode: ExecutionModeSchema, effect: ExecutionEffectSchema,
  effectObservation: EffectObservationSchema, reservationSafeToVoid: z.boolean(),
})
export const AttemptTerminalSnapshotSchema = z.union([
  AttemptTerminalBaseSchema.extend({
    status: z.enum(['passed', 'failed']), reservationId: SafeIdSchema, outcomeDigest: DigestSchema,
  }).strict(),
  AttemptTerminalBaseSchema.extend({
    status: z.enum(['input-blocked', 'environment-blocked', 'safety-blocked', 'automation-blocked',
      'pending-decision', 'not-executed-user-declined', 'manual-required']),
    reservationId: SafeIdSchema.optional(), outcomeDigest: DigestSchema.optional(),
  }).strict(),
])
const AttemptEventCommonSchema = z.object({
  sequence: z.number().int().positive(), caseId: SafeIdSchema, slot: z.number().int().nonnegative().max(99),
  attemptId: SafeIdSchema, timestamp: z.string().datetime(), previousChainDigest: DigestSchema,
  eventDigest: DigestSchema, authorityProof: AttemptEventAuthorityProofSchema,
})
export const AttemptEventSchema = z.discriminatedUnion('kind', [
  AttemptEventCommonSchema.extend({ kind: z.literal('started'), mode: ExecutionModeSchema }).strict(),
  AttemptEventCommonSchema.extend({ kind: z.literal('terminal'), result: AttemptTerminalSnapshotSchema }).strict(),
])
export const PersistedAttemptCaseSchema = z.object({
  caseId: SafeIdSchema, retryPolicy: RetryPolicySchema, initialChainDigest: DigestSchema,
  events: z.array(AttemptEventSchema).min(2).max(200),
  selection: z.object({ status: z.literal('selected'), attemptId: SafeIdSchema,
    slot: z.number().int().nonnegative().max(99), eventChainDigest: DigestSchema }).strict(),
}).strict()
export const WorkflowEventsV2ContentSchema = z.object({
  runId: SafeIdSchema,
  attemptCases: z.array(PersistedAttemptCaseSchema).max(100_000),
  workflowDigest: DigestSchema,
}).strict()
