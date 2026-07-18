import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const AttemptContextSchema = z.object({
  assetId: SafeIdSchema, generationId: SafeIdSchema, prdRevision: DigestSchema,
  runId: SafeIdSchema, caseId: SafeIdSchema,
}).strict()
const HttpIntentSchema = z.object({
  intentId: SafeIdSchema,
  method: z.string().min(1).max(32).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  canonicalOrigin: z.string().url(),
  exactPath: z.string().min(1).max(4096).regex(/^\//),
  query: z.array(z.tuple([z.string().max(4096), z.string().max(4096)])).max(10_000),
  payload: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('no-body') }).strict(),
    z.object({ kind: z.literal('json'), digest: DigestSchema }).strict(),
    z.object({ kind: z.literal('binary'), digest: DigestSchema }).strict(),
    z.object({ kind: z.literal('template'), templateDigest: DigestSchema }).strict(),
  ]),
  targetFingerprint: DigestSchema,
  maxRequests: z.number().int().positive(),
  expectedOrder: z.number().int().positive(),
}).strict()
const ReversibleWriteCapabilitySnapshotSchema = z.object({
  capabilityId: SafeIdSchema,
  nonce: z.string().min(1).max(4096),
  transport: z.literal('http'),
  effect: z.literal('reversible-write'),
  operation: z.literal('http-request'),
  actionId: SafeIdSchema,
  dataLeaseId: SafeIdSchema,
  fencingToken: z.number().int().positive(),
  cleanupPlanDigest: DigestSchema,
  requests: z.array(HttpIntentSchema).min(1).max(10_000),
  maxUses: z.literal(1),
}).strict()

const ExecutionOutcomeBindingBaseSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  attemptContext: AttemptContextSchema,
  grantId: SafeIdSchema,
  capabilityId: SafeIdSchema,
  actionId: SafeIdSchema,
  attemptId: SafeIdSchema,
  reservationId: SafeIdSchema,
  capability: ReversibleWriteCapabilitySnapshotSchema,
  effect: z.literal('reversible-write'),
  status: z.enum(['passed', 'failed', 'environment-blocked', 'safety-blocked']),
  effectObservation: z.enum(['proven-not-applied', 'applied', 'unknown']),
  runnerResultDigest: DigestSchema,
  gateway: z.object({
    executionSessionId: SafeIdSchema,
    policyDigest: DigestSchema,
    approvedRequestSetDigest: DigestSchema,
    received: z.number().int().nonnegative(), forwarded: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }).strict(),
  cleanup: z.object({
    cleanupPlanId: SafeIdSchema, cleanupPlanDigest: DigestSchema,
    leaseId: SafeIdSchema, status: z.enum(['verified-clean', 'failed', 'unknown']),
    resultDigest: DigestSchema, leaseReceiptDigest: DigestSchema,
  }).strict(),
  evidenceIds: z.array(SafeIdSchema).min(1).max(100_000)
    .refine((values) => new Set(values).size === values.length, 'evidenceIds 必须唯一'),
  evidenceSetDigest: DigestSchema,
  completedAt: z.string().datetime({ offset: true }),
}).strict()

function refineExecutionOutcome(value: z.infer<typeof ExecutionOutcomeBindingBaseSchema>, context: z.RefinementCtx): void {
  const expectedEvidenceSetDigest = digestText('execution-outcome-evidence-set/v1', canonicalizeJson(
    [...value.evidenceIds].sort(),
  ))
  if (value.evidenceSetDigest !== expectedEvidenceSetDigest) {
    context.addIssue({ code: 'custom', message: 'evidenceSetDigest 未绑定 evidenceIds', path: ['evidenceSetDigest'] })
  }
  const expectedRequestSetDigest = digestText(
    'execution-outcome-approved-request-set/v1', canonicalizeJson(value.capability.requests),
  )
  if (value.gateway.approvedRequestSetDigest !== expectedRequestSetDigest) {
    context.addIssue({ code: 'custom', message: 'approvedRequestSetDigest 未绑定完整批准请求集合',
      path: ['gateway', 'approvedRequestSetDigest'] })
  }
  if (value.capability.capabilityId !== value.capabilityId
    || value.capability.actionId !== value.actionId
    || value.capability.dataLeaseId !== value.cleanup.leaseId
    || value.capability.cleanupPlanDigest !== value.cleanup.cleanupPlanDigest) {
    context.addIssue({ code: 'custom', message: 'Capability snapshot 与 outcome 顶层/cleanup binding 不一致',
      path: ['capability'] })
  }
  if (value.status === 'passed' && (value.effectObservation !== 'applied'
    || value.cleanup.status !== 'verified-clean' || value.gateway.forwarded === 0)) {
    context.addIssue({ code: 'custom', message: 'passed outcome 必须证明写已应用、Gateway 已转发且 cleanup verified-clean' })
  }
}

export const ExecutionOutcomeBindingSchema = ExecutionOutcomeBindingBaseSchema.superRefine(refineExecutionOutcome)

export const ExecutionOutcomeReceiptSchema = ExecutionOutcomeBindingBaseSchema.extend({
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('execution-outcome-receipt/v1'),
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(4096),
}).strict().superRefine((value, context) => {
  refineExecutionOutcome(value, context)
  const { issuer: _issuer, keyId: _keyId, purpose: _purpose, algorithm: _algorithm,
    signedDigest: _signedDigest, signature: _signature, ...binding } = value
  const expected = digestParsedExecutionOutcomeBinding(binding)
  if (value.signedDigest !== expected) {
    context.addIssue({ code: 'custom', message: 'signedDigest 未绑定完整 ExecutionOutcome', path: ['signedDigest'] })
  }
})

export const ExecutionOutcomeVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'), issuer: SafeIdSchema, keyId: SafeIdSchema,
  purpose: z.literal('execution-outcome-receipt/v1'), algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024), publicKeyDigest: DigestSchema,
}).strict()

export function digestExecutionOutcomeBinding(binding: ExecutionOutcomeBinding): string {
  return digestParsedExecutionOutcomeBinding(ExecutionOutcomeBindingSchema.parse(binding))
}

function digestParsedExecutionOutcomeBinding(binding: z.infer<typeof ExecutionOutcomeBindingBaseSchema>): string {
  return digestText('execution-outcome-receipt-binding/v1', canonicalizeJson(binding))
}

export type ExecutionOutcomeBinding = z.infer<typeof ExecutionOutcomeBindingSchema>
export type ExecutionOutcomeReceipt = z.infer<typeof ExecutionOutcomeReceiptSchema>
export type ExecutionOutcomeVerifierMaterial = z.infer<typeof ExecutionOutcomeVerifierMaterialSchema>
