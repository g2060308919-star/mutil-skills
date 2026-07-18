import { z } from 'zod'
import { RuntimeHttpHeaderSchema } from './runtime-http-action.js'
import { AssetIdSchema, canonicalizeJson, digestCanonicalGrantApprovalSubject, digestText } from './common.js'
import {
  LegacyReadApprovalSubjectV20Schema,
  ReadApprovalSubjectSchema,
  WriteApprovalSubjectV2Schema,
} from './approval-freshness.js'
import type { CanonicalApprovalContext } from './approval.js'
import { digestInjectionResponseBody } from './approval.js'
import {
  ReadHttpRequestSetSchema,
  refineReadHttpActionReferences,
  validateReadHttpActionReferences,
  validateReadHttpRequestSet,
  type ReadHttpRequestReferences,
} from './read-http-request.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const EnvironmentSchema = z.enum(['local', 'test', 'staging', 'production'])
const BoundedStringSchema = (minimum: number, maximumBytes: number) => z.string().min(minimum)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes)
const LimitedTextSchema = BoundedStringSchema(1, 16 * 1024)
const CanonicalOriginSchema = BoundedStringSchema(1, 8 * 1024).refine((value) => {
  try { return new URL(value).origin === value } catch { return false }
}, 'origin must be canonical')
const AbsoluteUrlSchema = BoundedStringSchema(1, 16 * 1024).refine((value) => {
  try { return new URL(value).href === value } catch { return false }
}, 'URL must be canonical')
const ExactPathSchema = BoundedStringSchema(1, 8 * 1024).refine((value) => value.startsWith('/'))
const QueryPartSchema = BoundedStringSchema(0, 8 * 1024)
const QuerySchema = z.array(z.tuple([QueryPartSchema, QueryPartSchema])).max(1_000)

const ReadActionSchema = z.object({
  actionId: SafeIdSchema,
  operation: z.enum(['dom-read', 'screenshot', 'local-navigation', 'http-request']),
  maxUses: z.literal(1),
}).strict()

export const LegacyDiscoveryApprovalSubjectV10Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  scopeDigest: DigestSchema,
  environment: EnvironmentSchema,
  baseOrigin: CanonicalOriginSchema,
  actor: SafeIdSchema,
  expectedPageIdentity: z.object({
    url: AbsoluteUrlSchema,
    title: LimitedTextSchema,
    heading: LimitedTextSchema,
    ariaSignals: z.array(LimitedTextSchema).max(1_000),
  }).strict(),
  bootstrapIntentsDigest: DigestSchema,
  actions: z.array(ReadActionSchema).min(1).max(100_000),
}).strict().superRefine(uniqueActions)

export const DiscoveryApprovalSubjectSchema = z.object({
  schemaVersion: z.literal('1.1.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  scopeDigest: DigestSchema,
  environment: EnvironmentSchema,
  baseOrigin: CanonicalOriginSchema,
  actor: SafeIdSchema,
  expectedPageIdentity: z.object({
    url: AbsoluteUrlSchema,
    title: LimitedTextSchema,
    heading: LimitedTextSchema,
    ariaSignals: z.array(LimitedTextSchema).max(1_000),
  }).strict(),
  bootstrapIntentsDigest: DigestSchema,
  requests: ReadHttpRequestSetSchema,
  actions: z.array(ReadActionSchema.extend({
    requestIds: z.array(SafeIdSchema).max(1_000),
  }).strict()).min(1).max(100_000),
}).strict().superRefine((subject, context) => {
  refineReadHttpActionReferences(subject.actions, subject.requests, context)
})

export function migrateDiscoveryApprovalSubjectV10ToV11(
  candidate: unknown,
  requestCandidates: unknown,
  references: ReadHttpRequestReferences,
) {
  const legacy = LegacyDiscoveryApprovalSubjectV10Schema.parse(candidate)
  const requests = validateReadHttpRequestSet(requestCandidates)
  const mapped = validateReadHttpActionReferences(
    legacy.actions.map((action) => action.actionId), requests, references,
  )
  return DiscoveryApprovalSubjectSchema.parse({
    ...legacy,
    schemaVersion: '1.1.0',
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

export type DiscoveryApprovalSubjectV11 = z.infer<typeof DiscoveryApprovalSubjectSchema>
export type LegacyDiscoveryApprovalSubjectV10 = z.infer<typeof LegacyDiscoveryApprovalSubjectV10Schema>

const CanonicalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('json'), digest: DigestSchema }).strict(),
  z.object({ kind: z.literal('binary'), digest: DigestSchema }).strict(),
  z.object({ kind: z.literal('template'), templateDigest: DigestSchema }).strict(),
])

export const InjectionHttpIntentSchema = z.object({
  intentId: SafeIdSchema,
  method: z.string().regex(/^[A-Z]{3,16}$/),
  canonicalOrigin: CanonicalOriginSchema,
  exactPath: ExactPathSchema,
  query: QuerySchema,
  payload: CanonicalPayloadSchema,
  headers: z.array(RuntimeHttpHeaderSchema).max(128).optional(),
  targetFingerprint: z.union([DigestSchema, z.literal('not-applicable')]),
  maxRequests: z.number().int().positive().max(1_000),
  expectedOrder: z.number().int().nonnegative().max(100_000),
}).strict()

const InjectionResponseBodySchema = z.union([
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({ kind: z.literal('utf8'), value: z.string(), digest: DigestSchema }).strict()
    .refine((body) => Buffer.byteLength(body.value, 'utf8') <= 64 * 1024
      && body.digest === digestInjectionResponseBody(body.value)),
])

const CanonicalInjectionResponseSchema = z.union([
  z.object({
    kind: z.literal('http-response'),
    status: z.number().int().min(100).max(599),
    headers: z.array(z.object({
      name: z.enum(['content-type', 'retry-after', 'cache-control']),
      value: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 8 * 1024
        && !/[\r\n\0]/.test(value)),
    }).strict()).max(3).refine((headers) => new Set(headers.map((header) => header.name)).size === headers.length),
    body: InjectionResponseBodySchema,
    delayMs: z.number().int().min(0).max(30_000),
  }).strict(),
  z.object({
    kind: z.enum(['connection-reset', 'timeout']),
    status: z.literal('not-applicable'),
    headers: z.tuple([]),
    body: z.object({ kind: z.literal('no-body') }).strict(),
    delayMs: z.number().int().min(0).max(30_000),
  }).strict(),
])

export const InjectionApprovalSubjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  executionDigest: DigestSchema,
  environment: z.enum(['local', 'test']),
  baseOrigin: CanonicalOriginSchema,
  actions: z.array(z.object({
    actionId: SafeIdSchema,
    caseId: SafeIdSchema,
    runId: SafeIdSchema,
    attemptSlot: z.number().int().positive().max(99),
    request: InjectionHttpIntentSchema,
    response: CanonicalInjectionResponseSchema,
    expectedMatches: z.number().int().positive().max(100_000),
    expectedOrder: z.number().int().positive().max(100_000),
    upstreamForwarding: z.literal('forbidden'),
  }).strict()).min(1).max(100_000),
}).strict().superRefine(uniqueActions)

export const WebSocketReadApprovalSubjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  executionDigest: DigestSchema,
  environment: EnvironmentSchema,
  baseOrigin: CanonicalOriginSchema,
  actions: z.array(z.object({
    actionId: SafeIdSchema,
    origin: CanonicalOriginSchema,
    path: ExactPathSchema,
    maxInboundMessages: z.number().int().positive().max(1_000),
    maxBytes: z.number().int().positive().max(10 * 1024 * 1024),
  }).strict()).min(1).max(100_000),
}).strict().superRefine(uniqueActions)

export const SseReadApprovalSubjectSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  executionDigest: DigestSchema,
  environment: EnvironmentSchema,
  baseOrigin: CanonicalOriginSchema,
  actions: z.array(z.object({
    actionId: SafeIdSchema,
    origin: CanonicalOriginSchema,
    exactPath: ExactPathSchema,
    query: QuerySchema,
    maxReconnects: z.number().int().positive().max(100),
  }).strict()).min(1).max(100_000),
}).strict().superRefine(uniqueActions)

export const ApprovalGrantSubjectSchema = z.union([
  DiscoveryApprovalSubjectSchema,
  ReadApprovalSubjectSchema,
  WriteApprovalSubjectV2Schema,
  InjectionApprovalSubjectSchema,
  WebSocketReadApprovalSubjectSchema,
  SseReadApprovalSubjectSchema,
])

export const CanonicalApprovalContextSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  subject: SafeIdSchema,
  runId: SafeIdSchema,
  approvalType: z.enum(['discovery', 'execution']),
  subjectDigest: DigestSchema,
  installationDigest: DigestSchema,
  origin: CanonicalOriginSchema,
  issuedAt: z.string().datetime().max(64),
  expiresAt: z.string().datetime().max(64),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'approval context expiry must follow issue time' })
  }
})

export function canonicalApprovalContextDigest(context: CanonicalApprovalContext): string {
  return digestText(
    'e2e-canonical-approval-context/v1',
    canonicalizeJson(CanonicalApprovalContextSchema.parse(context)),
  )
}

export type CanonicalApprovalGrantSubject = z.infer<typeof ApprovalGrantSubjectSchema>
/** 当前签发与执行协议只接受 canonical subject。 */
export type ApprovalGrantSubject = CanonicalApprovalGrantSubject
/** 仅用于读取历史持久状态；进入 canonical digest、签发或执行前必须显式迁移。 */
export type ApprovalGrantSubjectMigrationInput = CanonicalApprovalGrantSubject
  | z.infer<typeof LegacyDiscoveryApprovalSubjectV10Schema>
  | z.infer<typeof LegacyReadApprovalSubjectV20Schema>

export function canonicalGrantApprovalType(subject: unknown): 'discovery' | 'execution' {
  const parsed = ApprovalGrantSubjectSchema.parse(subject)
  return DiscoveryApprovalSubjectSchema.safeParse(parsed).success ? 'discovery' : 'execution'
}

export function canonicalGrantApprovalSubjectDigest(subject: unknown): string {
  const parsed = ApprovalGrantSubjectSchema.parse(subject) as CanonicalApprovalGrantSubject
  const approvalType = DiscoveryApprovalSubjectSchema.safeParse(parsed).success ? 'discovery' : 'execution'
  return digestCanonicalGrantApprovalSubject(approvalType, parsed)
}

function uniqueActions(value: { actions: Array<{ actionId: string }> }, context: z.RefinementCtx): void {
  if (new Set(value.actions.map((action) => action.actionId)).size !== value.actions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'actionId must be unique', path: ['actions'] })
  }
}
