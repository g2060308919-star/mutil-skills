import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const TimestampSchema = z.string().datetime()

const OwnedResourceMarkerCoreSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runtimeInstallationDigest: DigestSchema,
  projectIdentityDigest: DigestSchema,
  runId: SafeIdSchema,
  attemptId: SafeIdSchema,
  ownerNonce: SafeIdSchema,
}).strict()

export const RuntimeOwnedResourceMarkerSchema = OwnedResourceMarkerCoreSchema.extend({
  markerDigest: DigestSchema,
}).strict().superRefine((marker, context) => {
  const { markerDigest: _markerDigest, ...core } = marker
  if (marker.markerDigest !== digestText(
    'runtime-owned-resource-marker/v1', canonicalizeJson(core),
  )) context.addIssue({ code: 'custom', path: ['markerDigest'], message: 'owner marker digest 不闭合' })
})

export type RuntimeOwnedResourceMarker = z.infer<typeof RuntimeOwnedResourceMarkerSchema>

const RecoveryOperationSchema = z.object({
  operationId: SafeIdSchema,
  receiptDigest: DigestSchema.optional(),
}).strict()

const RecoveryProgressSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  markUnknown: RecoveryOperationSchema.optional(),
  quarantine: RecoveryOperationSchema,
}).strict()

const WriteAttemptBaseSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  attemptId: SafeIdSchema,
  requestId: SafeIdSchema,
  requestDigest: DigestSchema,
  actionId: SafeIdSchema,
  lease: z.object({
    leaseId: SafeIdSchema,
    fencingToken: z.number().int().positive(),
    targetFingerprintDigest: DigestSchema,
  }).strict(),
  executionFencingToken: z.number().int().positive(),
  ownerMarker: RuntimeOwnedResourceMarkerSchema,
  preparedAt: TimestampSchema,
  recordRevision: z.number().int().positive(),
  recordDigest: DigestSchema,
  recovery: RecoveryProgressSchema.optional(),
})

const ReservationSchema = z.object({
  reservationId: SafeIdSchema,
  observedAt: TimestampSchema,
}).strict()

const PreparedOutcomeSchema = z.object({
  outcomeDigest: DigestSchema,
  receiptDigest: DigestSchema,
  preparedAt: TimestampSchema,
}).strict()

const CommittedOutcomeSchema = PreparedOutcomeSchema.extend({
  committedAt: TimestampSchema,
}).strict()

export const RuntimeWriteAttemptRecordSchema = z.discriminatedUnion('state', [
  WriteAttemptBaseSchema.extend({ state: z.literal('prepared') }).strict(),
  WriteAttemptBaseSchema.extend({
    state: z.literal('reservation-observed'), reservation: ReservationSchema,
  }).strict(),
  WriteAttemptBaseSchema.extend({
    state: z.literal('outcome-prepared'), reservation: ReservationSchema, outcome: PreparedOutcomeSchema,
  }).strict(),
  WriteAttemptBaseSchema.extend({
    state: z.literal('outcome-committed'), reservation: ReservationSchema, outcome: CommittedOutcomeSchema,
  }).strict(),
  WriteAttemptBaseSchema.extend({
    state: z.literal('effect-unknown'),
    reservation: ReservationSchema.optional(),
    outcome: PreparedOutcomeSchema.optional(),
    effectUnknown: z.object({
      reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
      observedAt: TimestampSchema,
    }).strict(),
  }).strict(),
]).superRefine((record, context) => {
  const { recordDigest: _recordDigest, ...core } = record
  if (record.recordDigest !== digestText(
    'runtime-write-attempt-record/v1', canonicalizeJson(core),
  )) context.addIssue({ code: 'custom', path: ['recordDigest'], message: 'WriteAttempt record digest 不闭合' })
  if (record.ownerMarker.attemptId !== record.attemptId) context.addIssue({
    code: 'custom', path: ['ownerMarker', 'attemptId'], message: 'owner marker 与 attempt 不一致',
  })
})

export type RuntimeWriteAttemptRecord = z.infer<typeof RuntimeWriteAttemptRecordSchema>
export type RuntimeWriteAttemptState = RuntimeWriteAttemptRecord['state']
export type UnsealedRuntimeWriteAttemptRecord = RuntimeWriteAttemptRecord extends infer Record
  ? Record extends RuntimeWriteAttemptRecord ? Omit<Record, 'recordDigest'> : never
  : never

export function createRuntimeOwnedResourceMarker(
  input: Omit<z.input<typeof OwnedResourceMarkerCoreSchema>, 'schemaVersion'>,
): RuntimeOwnedResourceMarker {
  const core = OwnedResourceMarkerCoreSchema.parse({ schemaVersion: '1.0.0', ...input })
  return RuntimeOwnedResourceMarkerSchema.parse({
    ...core,
    markerDigest: digestText('runtime-owned-resource-marker/v1', canonicalizeJson(core)),
  })
}

export function sealRuntimeWriteAttemptRecord(
  input: UnsealedRuntimeWriteAttemptRecord,
): RuntimeWriteAttemptRecord {
  return RuntimeWriteAttemptRecordSchema.parse({
    ...input,
    recordDigest: digestText('runtime-write-attempt-record/v1', canonicalizeJson(input)),
  })
}

export function parseRuntimeWriteAttemptRecord(input: unknown): RuntimeWriteAttemptRecord {
  return RuntimeWriteAttemptRecordSchema.parse(input)
}
