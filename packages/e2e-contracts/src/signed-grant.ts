import { z } from 'zod'
import {
  DiscoveryApprovalSubjectSchema,
  InjectionHttpIntentSchema,
  InjectionApprovalSubjectSchema,
  SseReadApprovalSubjectSchema,
  WebSocketReadApprovalSubjectSchema,
  CanonicalApprovalContextSchema,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
} from './approval-subject.js'
import {
  ReadApprovalSubjectSchema,
  WriteApprovalSubjectV2Schema,
  WriteHttpIntentSchema,
} from './approval-freshness.js'
import { digestInjectionResponseBody } from './approval.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const NonceSchema = z.string().regex(/^[a-f0-9]{64}$/)
const SignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
const BoundedStringSchema = (maximumBytes: number) => z.string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes)
const CanonicalOriginSchema = BoundedStringSchema(8 * 1024).refine((value) => {
  try { return new URL(value).origin === value } catch { return false }
})
const ExactPathSchema = BoundedStringSchema(8 * 1024).refine((value) => value.startsWith('/'))
const QueryPartSchema = BoundedStringSchema(8 * 1024)
const QuerySchema = z.array(z.tuple([QueryPartSchema, QueryPartSchema])).max(1_000)
const RolesSchema = z.array(SafeIdSchema).min(1).max(1_000)
  .refine((roles) => new Set(roles).size === roles.length)

const ApproverSchema = z.object({ subject: SafeIdSchema, roles: RolesSchema }).strict()
const InjectionResponseBodySchema = z.union([
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('utf8'), value: BoundedStringSchema(64 * 1024), digest: DigestSchema })
    .strict().refine((body) => body.digest === digestInjectionResponseBody(body.value)),
])
const InjectionResponseSchema = z.union([
  z.object({
    kind: z.literal('http-response'), status: z.number().int().min(100).max(599),
    headers: z.array(z.object({
      name: z.enum(['content-type', 'retry-after', 'cache-control']),
      value: BoundedStringSchema(8 * 1024).refine((value) => !/[\r\n\0]/.test(value)),
    }).strict()).max(3),
    body: InjectionResponseBodySchema, delayMs: z.number().int().nonnegative().max(30_000),
  }).strict().refine((response) => new Set(response.headers.map((header) => header.name)).size === response.headers.length),
  z.object({
    kind: z.enum(['connection-reset', 'timeout']), status: z.literal('not-applicable'),
    headers: z.tuple([]), body: z.object({ kind: z.literal('no-body') }).strict(),
    delayMs: z.number().int().nonnegative().max(30_000),
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
  issuedAt: z.string().datetime().max(64),
  expiresAt: z.string().datetime().max(64),
  revocationSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  signature: SignatureSchema,
}).strict()

const DiscoveryCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('browser-local'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  targetUrl: BoundedStringSchema(8 * 1024).refine((value) => {
    try { return Boolean(new URL(value)) } catch { return false }
  }), actor: SafeIdSchema, expectedPageIdentityDigest: DigestSchema,
  bootstrapIntentsDigest: DigestSchema, maxUses: z.literal(1),
}).strict()
const ReadCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('browser-local'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  maxUses: z.number().int().positive().max(100_000),
}).strict()
const WriteCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('http'),
  effect: z.literal('reversible-write'), operation: z.literal('http-request'), actionId: SafeIdSchema,
  dataLeaseId: SafeIdSchema,
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cleanupPlanDigest: DigestSchema,
  requests: z.array(WriteHttpIntentSchema).min(1).max(1_000), maxUses: z.literal(1),
}).strict()
const InjectionCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('gateway-injection'),
  actionId: SafeIdSchema, caseId: SafeIdSchema, runId: SafeIdSchema,
  attemptSlot: z.number().int().positive().max(99), request: InjectionHttpIntentSchema,
  response: InjectionResponseSchema, expectedMatches: z.number().int().positive().max(100_000),
  expectedOrder: z.number().int().positive().max(100_000), upstreamForwarding: z.literal('forbidden'),
  maxUses: z.number().int().positive().max(100_000),
}).strict()
const WebSocketCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('websocket'), effect: z.literal('read'),
  actionId: SafeIdSchema, origin: CanonicalOriginSchema, path: ExactPathSchema,
  maxInboundMessages: z.number().int().positive().max(1_000),
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024), maxUses: z.literal(1),
}).strict()
const SseCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('sse'), effect: z.literal('read'),
  actionId: SafeIdSchema, origin: CanonicalOriginSchema, exactPath: ExactPathSchema, query: QuerySchema,
  maxReconnects: z.number().int().positive().max(100), maxUses: z.number().int().positive().max(100),
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
