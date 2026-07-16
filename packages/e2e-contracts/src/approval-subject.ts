import { z } from 'zod'
import { AssetIdSchema, canonicalizeJson, digestCanonicalGrantApprovalSubject, digestText } from './common.js'
import { ReadApprovalSubjectSchema, WriteApprovalSubjectV2Schema } from './approval-freshness.js'
import type { CanonicalApprovalContext } from './approval.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const EnvironmentSchema = z.enum(['local', 'test', 'staging', 'production'])
const LimitedTextSchema = z.string().min(1).max(16 * 1024)
const CanonicalOriginSchema = z.string().url().refine((value) => {
  try { return new URL(value).origin === value } catch { return false }
}, 'origin must be canonical')
const AbsoluteUrlSchema = z.string().url().refine((value) => {
  try { return new URL(value).href === value } catch { return false }
}, 'URL must be canonical')
const ExactPathSchema = z.string().min(1).max(8 * 1024).regex(/^\//)
const QuerySchema = z.array(z.tuple([z.string().max(8 * 1024), z.string().max(8 * 1024)])).max(1_000)

const ReadActionSchema = z.object({
  actionId: SafeIdSchema,
  operation: z.enum(['dom-read', 'screenshot', 'local-navigation']),
  maxUses: z.literal(1),
}).strict()

export const DiscoveryApprovalSubjectSchema = z.object({
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

const CanonicalInjectionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http-response'),
    status: z.number().int(),
    headers: z.array(z.object({
      name: z.string().min(1).max(256).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
      value: z.string(),
    }).strict()).max(1_000),
    body: InjectionResponseBodySchema,
    delayMs: z.number().int(),
  }).strict(),
  z.object({
    kind: z.enum(['connection-reset', 'timeout']),
    status: z.literal('not-applicable'),
    headers: z.tuple([]),
    body: z.object({ kind: z.literal('no-body') }).strict(),
    delayMs: z.number().int(),
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
    request: HttpIntentSchema,
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
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
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

export type ApprovalGrantSubject = z.infer<typeof ApprovalGrantSubjectSchema>

export function canonicalGrantApprovalType(subject: unknown): 'discovery' | 'execution' {
  const parsed = ApprovalGrantSubjectSchema.parse(subject)
  return DiscoveryApprovalSubjectSchema.safeParse(parsed).success ? 'discovery' : 'execution'
}

export function canonicalGrantApprovalSubjectDigest(subject: unknown): string {
  const parsed = ApprovalGrantSubjectSchema.parse(subject) as ApprovalGrantSubject
  const approvalType = DiscoveryApprovalSubjectSchema.safeParse(parsed).success ? 'discovery' : 'execution'
  return digestCanonicalGrantApprovalSubject(approvalType, parsed)
}

function uniqueActions(value: { actions: Array<{ actionId: string }> }, context: z.RefinementCtx): void {
  if (new Set(value.actions.map((action) => action.actionId)).size !== value.actions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'actionId must be unique', path: ['actions'] })
  }
}
