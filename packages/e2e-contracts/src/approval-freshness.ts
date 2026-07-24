import { z } from 'zod'
import {
  AssetIdSchema,
  canonicalizeJson,
  digestCanonicalGrantApprovalSubject,
  digestText,
} from './common.js'
import {
  ReadHttpRequestSetSchema,
  refineReadHttpActionReferences,
  validateReadHttpActionReferences,
  validateReadHttpRequestSet,
  type ReadHttpRequestReferences,
} from './read-http-request.js'
import { RuntimeHttpHeaderSchema } from './runtime-http-action.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const BoundedStringSchema = (maximumBytes: number) => z.string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes)
const CanonicalOriginSchema = BoundedStringSchema(8 * 1024).refine((value) => {
  try { return new URL(value).origin === value } catch { return false }
})
const ExactPathSchema = BoundedStringSchema(8 * 1024).refine((value) => value.startsWith('/'))
const QueryPartSchema = BoundedStringSchema(8 * 1024)

const LegacyReadActionSchema = z.object({
  actionId: SafeIdSchema,
  operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  maxUses: z.number().int().positive().max(100_000),
}).strict()

export const LegacyReadApprovalSubjectV20Schema = z.object({
  schemaVersion: z.literal('2.0.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  scopeDigest: DigestSchema,
  requirementModelDigest: DigestSchema,
  coveragePolicyDigest: DigestSchema,
  universeDigest: DigestSchema,
  caseDigest: DigestSchema,
  actionMapDigest: DigestSchema,
  policyDigest: DigestSchema,
  executionContractDigest: DigestSchema,
  runBundleProjectionDigest: DigestSchema,
  environment: z.enum(['local', 'test', 'staging', 'production']),
  baseOrigin: CanonicalOriginSchema,
  actor: SafeIdSchema,
  discoveryGrantId: SafeIdSchema,
  preflightDigest: DigestSchema,
  actions: z.array(LegacyReadActionSchema).min(1).max(100_000),
}).strict().superRefine((subject, context) => {
  const ids = subject.actions.map((action) => `${action.actionId}\0${action.operation}`)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Read approval actionId 必须唯一', path: ['actions'] })
  }
})

export const ReadApprovalSubjectSchema = z.object({
  schemaVersion: z.literal('2.1.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  scopeDigest: DigestSchema,
  requirementModelDigest: DigestSchema,
  coveragePolicyDigest: DigestSchema,
  universeDigest: DigestSchema,
  caseDigest: DigestSchema,
  actionMapDigest: DigestSchema,
  policyDigest: DigestSchema,
  executionContractDigest: DigestSchema,
  runBundleProjectionDigest: DigestSchema,
  environment: z.enum(['local', 'test', 'staging', 'production']),
  baseOrigin: CanonicalOriginSchema,
  actor: SafeIdSchema,
  discoveryGrantId: SafeIdSchema,
  preflightDigest: DigestSchema,
  requests: ReadHttpRequestSetSchema,
  actions: z.array(z.object({
    actionId: SafeIdSchema,
    operation: z.enum(['dom-read', 'screenshot', 'local-navigation', 'http-request']),
    maxUses: z.number().int().positive().max(100_000),
    requestIds: z.array(SafeIdSchema).max(1_000),
  }).strict()).min(1).max(100_000),
}).strict().superRefine((subject, context) => {
  refineReadHttpActionReferences(subject.actions, subject.requests, context)
})

export function migrateReadApprovalSubjectV20ToV21(
  candidate: unknown,
  requestCandidates: unknown,
  references: ReadHttpRequestReferences,
) {
  const legacy = LegacyReadApprovalSubjectV20Schema.parse(candidate)
  const requests = validateReadHttpRequestSet(requestCandidates)
  const mapped = validateReadHttpActionReferences(
    legacy.actions.map((action) => action.actionId), requests, references,
  )
  return ReadApprovalSubjectSchema.parse({
    ...legacy,
    schemaVersion: '2.1.0',
    requests,
    actions: legacy.actions.map((action) => {
      const requestIds = mapped[action.actionId]!
      return {
        ...action,
        operation: requestIds.length > 0 ? 'http-request' as const : action.operation,
        requestIds,
      }
    }),
  })
}

const CanonicalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('json'), digest: DigestSchema }).strict(),
  z.object({ kind: z.literal('binary'), digest: DigestSchema }).strict(),
  z.object({ kind: z.literal('template'), templateDigest: DigestSchema }).strict(),
])

const WriteHttpIntentTailShape = {
  canonicalOrigin: CanonicalOriginSchema,
  exactPath: ExactPathSchema,
  query: z.array(z.tuple([QueryPartSchema, QueryPartSchema])).max(1_000),
  payload: CanonicalPayloadSchema, targetFingerprint: DigestSchema,
  headers: z.array(RuntimeHttpHeaderSchema).max(128).optional(),
  maxRequests: z.number().int().positive().max(1_000),
  expectedOrder: z.number().int().positive().max(100_000),
}

/** Historical Write intent accepted by Authority snapshot 2.3 and earlier. */
export const LegacyWriteHttpIntentV23Schema = z.object({
  intentId: SafeIdSchema,
  method: z.string().min(1).max(32),
  ...WriteHttpIntentTailShape,
}).strict()

export const WriteHttpIntentSchema = z.object({
  intentId: SafeIdSchema,
  method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/),
  ...WriteHttpIntentTailShape,
}).strict()

export const MAX_WRITE_HTTP_INTENTS = 1_000
export const WriteHttpIntentSetSchema = z.array(WriteHttpIntentSchema).max(MAX_WRITE_HTTP_INTENTS)

const WriteApprovalSubjectV2Shape = {
  schemaVersion: z.literal('2.0.0'), assetId: AssetIdSchema, prdRevision: DigestSchema,
  executionDigest: DigestSchema, scopeDigest: DigestSchema, requirementModelDigest: DigestSchema,
  coveragePolicyDigest: DigestSchema, universeDigest: DigestSchema, caseDigest: DigestSchema,
  actionMapDigest: DigestSchema, policyDigest: DigestSchema, executionContractDigest: DigestSchema,
  runBundleProjectionDigest: DigestSchema, environment: z.enum(['local', 'test', 'staging']),
  baseOrigin: CanonicalOriginSchema, actor: SafeIdSchema,
  discoveryGrantId: SafeIdSchema, preflightDigest: DigestSchema,
}

const WriteActionShape = {
  actionId: SafeIdSchema, effect: z.literal('reversible-write'), dataLeaseId: SafeIdSchema,
  resourceKey: SafeIdSchema,
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), cleanupPlanDigest: DigestSchema,
}

const LegacyWriteActionShape = {
  actionId: SafeIdSchema, effect: z.literal('reversible-write'), dataLeaseId: SafeIdSchema,
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), cleanupPlanDigest: DigestSchema,
}

const HttpWriteApprovalActionSchema = z.object({
  ...WriteActionShape,
  requests: WriteHttpIntentSetSchema.min(1),
}).strict()

export const BrowserLocalWriteApprovalActionSchema = z.object({
  ...WriteActionShape,
  transport: z.literal('browser-local'),
  operation: z.literal('full-playwright'),
  programDigest: DigestSchema,
  cleanupProgramDigest: DigestSchema,
  requests: WriteHttpIntentSetSchema,
}).strict()

/** Historical Write subject accepted by Authority snapshot 2.3 and earlier. */
export const LegacyWriteApprovalSubjectV23Schema = z.object({
  ...WriteApprovalSubjectV2Shape,
  actions: z.array(z.object({
    ...LegacyWriteActionShape,
    requests: z.array(LegacyWriteHttpIntentV23Schema).min(1).max(MAX_WRITE_HTTP_INTENTS),
  }).strict()).min(1).max(100_000),
}).strict()

export const WriteApprovalSubjectV2Schema = z.object({
  ...WriteApprovalSubjectV2Shape,
  actions: z.array(z.union([
    HttpWriteApprovalActionSchema,
    BrowserLocalWriteApprovalActionSchema,
  ])).min(1).max(100_000),
}).strict()

const ApprovalCapabilityRecordBaseShape = {
  capabilityId: SafeIdSchema,
  actionId: SafeIdSchema,
  digest: DigestSchema,
}

const ReadCapabilityRecordSchema = z.object({
  ...ApprovalCapabilityRecordBaseShape,
  operation: z.enum(['dom-read', 'screenshot', 'local-navigation', 'http-request']),
  effect: z.literal('read'),
  maxUses: z.number().int().positive().max(100_000),
}).strict()

const HttpWriteCapabilityRecordSchema = z.object({
  ...ApprovalCapabilityRecordBaseShape,
  operation: z.literal('http-request'),
  effect: z.literal('reversible-write'),
  maxUses: z.literal(1),
}).strict()

const FullPlaywrightWriteCapabilityRecordSchema = z.object({
  ...ApprovalCapabilityRecordBaseShape,
  operation: z.literal('full-playwright'),
  effect: z.literal('reversible-write'),
  maxUses: z.literal(1),
}).strict()

export const ApprovalCapabilityRecordSchema = z.union([
  ReadCapabilityRecordSchema,
  HttpWriteCapabilityRecordSchema,
  FullPlaywrightWriteCapabilityRecordSchema,
])

const CommonReceiptBody = {
  schemaVersion: z.literal('1.0.0'),
  grantId: SafeIdSchema,
  subjectDigest: DigestSchema,
  runBundleDigest: DigestSchema,
  browserPreflightArtifactDigest: DigestSchema,
  capabilities: z.array(ApprovalCapabilityRecordSchema).min(1).max(100_000),
  capabilitySetDigest: DigestSchema,
  expiresAt: z.string().datetime().max(64),
  checkedAt: z.string().datetime().max(64),
  revocationSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['valid', 'expired', 'revoked', 'denied']),
  reasonCodes: z.array(SafeIdSchema).max(100),
}

const ApprovalFreshnessReceiptBodySchema = z.discriminatedUnion('grantType', [
  z.object({ ...CommonReceiptBody, grantType: z.literal('read'),
    executionSubjectSnapshot: ReadApprovalSubjectSchema }).strict(),
  z.object({ ...CommonReceiptBody, grantType: z.literal('reversible-write'),
    executionSubjectSnapshot: WriteApprovalSubjectV2Schema }).strict(),
])

export const ApprovalFreshnessAuthorityProofSchema = z.object({
  purpose: z.literal('approval-freshness-receipt/v1'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(16 * 1024),
}).strict()

export const ApprovalFreshnessVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  purpose: z.literal('approval-freshness-receipt/v1'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024),
  publicKeyDigest: DigestSchema,
}).strict()

export const ApprovalFreshnessReceiptSchema = z.discriminatedUnion('grantType', [
  z.object({ ...CommonReceiptBody, grantType: z.literal('read'),
    executionSubjectSnapshot: ReadApprovalSubjectSchema,
    authorityProof: ApprovalFreshnessAuthorityProofSchema }).strict(),
  z.object({ ...CommonReceiptBody, grantType: z.literal('reversible-write'),
    executionSubjectSnapshot: WriteApprovalSubjectV2Schema,
    authorityProof: ApprovalFreshnessAuthorityProofSchema }).strict(),
]).superRefine((receipt, context) => {
  const { authorityProof, ...body } = receipt
  const subjectDigest = digestCanonicalGrantApprovalSubject('execution', receipt.executionSubjectSnapshot)
  const capabilitySetDigest = digestText('approval-capability-set/v1', canonicalizeJson(receipt.capabilities))
  const signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(body))
  if (receipt.subjectDigest !== subjectDigest) {
    context.addIssue({ code: 'custom', message: 'receipt subjectDigest 与快照不一致', path: ['subjectDigest'] })
  }
  if (receipt.capabilitySetDigest !== capabilitySetDigest) {
    context.addIssue({ code: 'custom', message: 'receipt capabilitySetDigest 与记录不一致', path: ['capabilitySetDigest'] })
  }
  if (authorityProof.signedDigest !== signedDigest) {
    context.addIssue({ code: 'custom', message: 'freshness proof 未绑定完整 receipt', path: ['authorityProof', 'signedDigest'] })
  }
  const ids = receipt.capabilities.map((capability) => capability.capabilityId)
  const actions = receipt.capabilities.map((capability) => `${capability.actionId}\0${capability.operation}`)
  if (new Set(ids).size !== ids.length || new Set(actions).size !== actions.length) {
    context.addIssue({ code: 'custom', message: 'receipt capability 与 action/operation 必须唯一', path: ['capabilities'] })
  }
  if ((receipt.status === 'valid') !== (receipt.reasonCodes.length === 0)) {
    context.addIssue({ code: 'custom', message: 'valid receipt 不得有原因，invalid receipt 必须有原因', path: ['reasonCodes'] })
  }
})

export type ApprovalCapabilityRecord = z.infer<typeof ApprovalCapabilityRecordSchema>
export type ReadApprovalSubjectV21 = z.infer<typeof ReadApprovalSubjectSchema>
export type LegacyReadApprovalSubjectV20 = z.infer<typeof LegacyReadApprovalSubjectV20Schema>
export type WriteApprovalSubjectV2 = z.infer<typeof WriteApprovalSubjectV2Schema>
export type ApprovalFreshnessReceipt = z.infer<typeof ApprovalFreshnessReceiptSchema>
export type ApprovalFreshnessVerifierMaterial = z.infer<typeof ApprovalFreshnessVerifierMaterialSchema>
export type ApprovalFreshnessReceiptBody = z.infer<typeof ApprovalFreshnessReceiptBodySchema>
export type ApprovalFreshnessVerification =
  | { authentic: true; current: true; allowed: boolean; status: ApprovalFreshnessReceipt['status'] }
  | { authentic: false; current: false; allowed: false; status: 'invalid' }
