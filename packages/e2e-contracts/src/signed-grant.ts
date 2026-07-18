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

export const DiscoveryBrowserCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('browser-local'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  targetUrl: BoundedStringSchema(8 * 1024).refine((value) => {
    try { return Boolean(new URL(value)) } catch { return false }
  }), actor: SafeIdSchema, expectedPageIdentityDigest: DigestSchema,
  bootstrapIntentsDigest: DigestSchema, maxUses: z.literal(1),
}).strict()
export const ReadHttpCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('http'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.literal('http-request'),
  requestIds: z.array(SafeIdSchema).min(1).max(1_000)
    .refine((values) => new Set(values).size === values.length),
  maxUses: z.number().int().positive().max(100_000),
}).strict()
export const DiscoveryCapabilitySchema = z.discriminatedUnion('transport', [
  DiscoveryBrowserCapabilitySchema, ReadHttpCapabilitySchema,
])
export const ReadBrowserCapabilitySchema = z.object({
  capabilityId: SafeIdSchema, nonce: NonceSchema, transport: z.literal('browser-local'), effect: z.literal('read'),
  actionId: SafeIdSchema, operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  maxUses: z.number().int().positive().max(100_000),
}).strict()
export const ReadCapabilitySchema = z.discriminatedUnion('transport', [
  ReadBrowserCapabilitySchema, ReadHttpCapabilitySchema,
])
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
  if ('requests' in grant.subject) {
    const knownRequestIds = new Set(grant.subject.requests.map((request) => request.requestId))
    const subjectActions = new Map(grant.subject.actions.map((action) => [
      `${action.actionId}\0${action.operation}`, action,
    ]))
    const capabilityCounts = new Map<string, number>()
    const capabilityIds = new Set<string>()
    for (const [capabilityIndex, capability] of grant.capabilities.entries()) {
      if (capabilityIds.has(capability.capabilityId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'capabilityId 必须唯一', path: ['capabilities', capabilityIndex, 'capabilityId'],
        })
      }
      capabilityIds.add(capability.capabilityId)
      const operation = 'operation' in capability ? capability.operation : undefined
      const actionKey = `${capability.actionId}\0${operation ?? ''}`
      const action = subjectActions.get(actionKey)
      capabilityCounts.set(actionKey, (capabilityCounts.get(actionKey) ?? 0) + 1)
      if (!('effect' in capability) || capability.effect !== 'read' || !('operation' in capability)
        || action === undefined || capability.operation !== action.operation
        || capability.maxUses !== action.maxUses) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'read capability 必须精确绑定 subject action 的 operation 与 maxUses',
          path: ['capabilities', capabilityIndex],
        })
        continue
      }
      const approved = action.requestIds
      if (approved.length > 0) {
        if (!('requestIds' in capability)
          || approved.length !== capability.requestIds.length
          || approved.some((requestId, index) => requestId !== capability.requestIds[index])
          || capability.requestIds.some((requestId) => !knownRequestIds.has(requestId))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'HTTP read capability 必须精确引用 subject 已签名请求',
            path: ['capabilities', capabilityIndex, 'requestIds'],
          })
        }
      } else if ('requestIds' in capability) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '无 HTTP 请求的 action 不得签发 HTTP capability',
          path: ['capabilities', capabilityIndex, 'requestIds'],
        })
      }
    }
    for (const [actionKey] of subjectActions) {
      if (capabilityCounts.get(actionKey) !== 1) context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '每个 subject action 必须且只能由一个 capability 覆盖', path: ['capabilities'],
      })
    }
  }
})

export type CanonicalDiscoveryBrowserCapability = z.infer<typeof DiscoveryBrowserCapabilitySchema>
export type CanonicalReadHttpCapability = z.infer<typeof ReadHttpCapabilitySchema>
export type CanonicalDiscoveryCapability = z.infer<typeof DiscoveryCapabilitySchema>
export type CanonicalReadBrowserCapability = z.infer<typeof ReadBrowserCapabilitySchema>
export type CanonicalReadCapability = z.infer<typeof ReadCapabilitySchema>
