import { z } from 'zod'
import {
  AssetIdSchema,
  canonicalizeJson,
  digestCanonicalGrantApprovalSubject,
  digestText,
} from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

export const ReadApprovalSubjectSchema = z.object({
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
  baseOrigin: z.string().url(),
  actor: SafeIdSchema,
  discoveryGrantId: SafeIdSchema,
  preflightDigest: DigestSchema,
  actions: z.array(z.object({
    actionId: SafeIdSchema,
    operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
    maxUses: z.number().int().positive(),
  }).strict()).min(1).max(100_000),
}).strict().superRefine((subject, context) => {
  const ids = subject.actions.map((action) => `${action.actionId}\0${action.operation}`)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Read approval actionId 必须唯一', path: ['actions'] })
  }
})

const CanonicalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('json'), digest: DigestSchema }).strict(),
  z.object({ kind: z.literal('binary'), digest: DigestSchema }).strict(),
])

const HttpIntentSchema = z.object({
  intentId: SafeIdSchema, method: z.string().min(1).max(32), canonicalOrigin: z.string().url(),
  exactPath: z.string().startsWith('/'), query: z.array(z.tuple([z.string(), z.string()])).max(1_000),
  payload: CanonicalPayloadSchema, targetFingerprint: DigestSchema, maxRequests: z.number().int().positive(),
  expectedOrder: z.number().int().positive(),
}).strict()

export const WriteApprovalSubjectV2Schema = z.object({
  schemaVersion: z.literal('2.0.0'), assetId: AssetIdSchema, prdRevision: DigestSchema,
  executionDigest: DigestSchema, scopeDigest: DigestSchema, requirementModelDigest: DigestSchema,
  coveragePolicyDigest: DigestSchema, universeDigest: DigestSchema, caseDigest: DigestSchema,
  actionMapDigest: DigestSchema, policyDigest: DigestSchema, executionContractDigest: DigestSchema,
  runBundleProjectionDigest: DigestSchema, environment: z.enum(['local', 'test', 'staging']),
  baseOrigin: z.string().url(), actor: SafeIdSchema, discoveryGrantId: SafeIdSchema, preflightDigest: DigestSchema,
  actions: z.array(z.object({
    actionId: SafeIdSchema, effect: z.literal('reversible-write'), dataLeaseId: SafeIdSchema,
    fencingToken: z.number().int().positive(), cleanupPlanDigest: DigestSchema,
    requests: z.array(HttpIntentSchema).min(1).max(1_000),
  }).strict()).min(1).max(100_000),
}).strict()

const ReadCapabilityRecordSchema = z.object({
  capabilityId: SafeIdSchema,
  actionId: SafeIdSchema,
  operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  effect: z.literal('read'),
  maxUses: z.number().int().positive(),
  digest: DigestSchema,
}).strict()

const WriteCapabilityRecordSchema = z.object({
  capabilityId: SafeIdSchema, actionId: SafeIdSchema, operation: z.literal('http-request'),
  effect: z.literal('reversible-write'), maxUses: z.literal(1), digest: DigestSchema,
}).strict()

export const ApprovalCapabilityRecordSchema = z.discriminatedUnion('operation', [
  ReadCapabilityRecordSchema, WriteCapabilityRecordSchema,
])

const CommonReceiptBody = {
  schemaVersion: z.literal('1.0.0'),
  grantId: SafeIdSchema,
  subjectDigest: DigestSchema,
  runBundleDigest: DigestSchema,
  browserPreflightArtifactDigest: DigestSchema,
  capabilities: z.array(ApprovalCapabilityRecordSchema).min(1).max(100_000),
  capabilitySetDigest: DigestSchema,
  expiresAt: z.string().datetime(),
  checkedAt: z.string().datetime(),
  revocationSequence: z.number().int().nonnegative(),
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
export type WriteApprovalSubjectV2 = z.infer<typeof WriteApprovalSubjectV2Schema>
export type ApprovalFreshnessReceipt = z.infer<typeof ApprovalFreshnessReceiptSchema>
export type ApprovalFreshnessVerifierMaterial = z.infer<typeof ApprovalFreshnessVerifierMaterialSchema>
export type ApprovalFreshnessReceiptBody = z.infer<typeof ApprovalFreshnessReceiptBodySchema>
export type ApprovalFreshnessVerification =
  | { authentic: true; current: true; allowed: boolean; status: ApprovalFreshnessReceipt['status'] }
  | { authentic: false; current: false; allowed: false; status: 'invalid' }
