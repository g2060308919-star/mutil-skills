import { z } from 'zod'
import {
  DiscoveryApprovalSubjectSchema,
  InjectionApprovalSubjectSchema,
  SseReadApprovalSubjectSchema,
  WebSocketReadApprovalSubjectSchema,
  CanonicalApprovalContextSchema,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
} from './approval-subject.js'
import { ReadApprovalSubjectSchema, WriteApprovalSubjectV2Schema } from './approval-freshness.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const NonceSchema = z.string().regex(/^[a-f0-9]{64}$/)
const SignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
const CanonicalOriginSchema = z.string().url().refine((value) => {
  try { return new URL(value).origin === value } catch { return false }
})
const ExactPathSchema = z.string().min(1).max(8 * 1024).regex(/^\//)
const QuerySchema = z.array(z.tuple([z.string().max(8 * 1024), z.string().max(8 * 1024)])).max(1_000)
const RolesSchema = z.array(SafeIdSchema).min(1).max(1_000)
  .refine((roles) => new Set(roles).size === roles.length)

const ApproverSchema = z.object({ subject: SafeIdSchema, roles: RolesSchema }).strict()
const CanonicalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('json'), digest: DigestSchema }).strict(),
  z.object({ kind: z.literal('binary'), digest: DigestSchema }).strict(),
])
const HttpIntentSchema = z.object({
  intentId: SafeIdSchema,
  method: z.string().regex(/^[A-Z]{3,16}$/),
  canonicalOrigin: CanonicalOriginSchema,
  exactPath: ExactPathSchema,
  query: QuerySchema,
  payload: CanonicalPayloadSchema,
  targetFingerprint: z.union([DigestSchema, z.literal('not-applicable')]),
  maxRequests: z.number().int().positive().max(1_000),
  expectedOrder: z.number().int().nonnegative().max(100_000),
}).strict()
const InjectionResponseBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('utf8'), value: z.string(), digest: DigestSchema }).strict(),
])
const InjectionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http-response'), status: z.number().int(),
    headers: z.array(z.object({ name: z.string().min(1).max(256), value: z.string() }).strict()).max(1_000),
    body: InjectionResponseBodySchema, delayMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.enum(['connection-reset', 'timeout']), status: z.literal('not-applicable'),
    headers: z.tuple([]), body: z.object({ kind: z.literal('no-body') }).strict(),
    delayMs: z.number().int().nonnegative(),
  }).strict(),
])

const GrantBaseSchema = z.object({
  grantId: SafeIdSchema,
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  proofScope: z.literal('local-os-user'),
  approver: ApproverSchema,
  approvalContext: CanonicalApprovalContextSchema,
  subjectDigest: DigestSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revocationSequence: z.number().int().nonnegative(),
  signature: SignatureSchema,
}).strict()

const DiscoveryCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('browser-local'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  targetUrl: z.string().url(), actor: SafeIdSchema, expectedPageIdentityDigest: DigestSchema,
  bootstrapIntentsDigest: DigestSchema, maxUses: z.number().int().positive(),
}).strict()
const ReadCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('browser-local'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  maxUses: z.number().int().positive(),
}).strict()
const WriteCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('http'),
  effect: z.literal('reversible-write'), operation: z.literal('http-request'), actionId: SafeIdSchema,
  dataLeaseId: SafeIdSchema, fencingToken: z.number().int().positive(), cleanupPlanDigest: DigestSchema,
  requests: z.array(HttpIntentSchema).min(1).max(1_000), maxUses: z.literal(1),
}).strict()
const InjectionCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('gateway-injection'),
  actionId: SafeIdSchema, caseId: SafeIdSchema, runId: SafeIdSchema,
  attemptSlot: z.number().int().positive().max(99), request: HttpIntentSchema,
  response: InjectionResponseSchema, expectedMatches: z.number().int().positive(),
  expectedOrder: z.number().int().positive(), upstreamForwarding: z.literal('forbidden'),
  maxUses: z.number().int().positive(),
}).strict()
const WebSocketCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('websocket'), effect: z.literal('read'),
  actionId: SafeIdSchema, origin: CanonicalOriginSchema, path: ExactPathSchema,
  maxInboundMessages: z.number().int().positive(), maxBytes: z.number().int().positive(), maxUses: z.literal(1),
}).strict()
const SseCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('sse'), effect: z.literal('read'),
  actionId: SafeIdSchema, origin: CanonicalOriginSchema, exactPath: ExactPathSchema, query: QuerySchema,
  maxReconnects: z.number().int().positive(), maxUses: z.number().int().positive(),
}).strict()

export const SignedGrantSchema = z.union([
  GrantBaseSchema.extend({
    subject: DiscoveryApprovalSubjectSchema,
    capabilities: z.array(DiscoveryCapabilitySchema).min(1).max(100_000),
  }),
  GrantBaseSchema.extend({
    subject: ReadApprovalSubjectSchema,
    capabilities: z.array(ReadCapabilitySchema).min(1).max(100_000),
  }),
  GrantBaseSchema.extend({
    subject: WriteApprovalSubjectV2Schema,
    capabilities: z.array(WriteCapabilitySchema).min(1).max(100_000),
  }),
  GrantBaseSchema.extend({
    subject: InjectionApprovalSubjectSchema,
    capabilities: z.array(InjectionCapabilitySchema).min(1).max(100_000),
  }),
  GrantBaseSchema.extend({
    subject: WebSocketReadApprovalSubjectSchema,
    capabilities: z.array(WebSocketCapabilitySchema).min(1).max(100_000),
  }),
  GrantBaseSchema.extend({
    subject: SseReadApprovalSubjectSchema,
    capabilities: z.array(SseCapabilitySchema).min(1).max(100_000),
  }),
]).superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)
    || grant.subjectDigest !== canonicalGrantApprovalSubjectDigest(grant.subject)
    || grant.approvalContext.subject !== grant.approver.subject
    || grant.approvalContext.subjectDigest !== grant.subjectDigest
    || grant.approvalContext.approvalType !== canonicalGrantApprovalType(grant.subject)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'grant binding is inconsistent' })
  }
})
