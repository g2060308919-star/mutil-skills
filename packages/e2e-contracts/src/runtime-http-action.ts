import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const BoundedTextSchema = z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 64 * 1024)
const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/)

const forbiddenHeaders = new Set([
  'api-key', 'authorization', 'connection', 'content-length', 'cookie', 'host', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'x-api-key', 'x-auth-token',
])

export const RuntimeHttpHeaderSchema = z.object({
  name: HeaderNameSchema,
  value: z.string().max(8 * 1024).refine((value) => !/[\r\n\0]/.test(value)),
}).strict().superRefine((header, context) => {
  if (forbiddenHeaders.has(header.name)
    || /(^|-)(?:auth|credential|csrf|secret|session|token)(?:-|$)/.test(header.name)) {
    context.addIssue({ code: 'custom', message: 'HTTP header 不得承载凭据或 hop-by-hop 字段' })
  }
})

export const RuntimeHttpBodySegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: BoundedTextSchema }).strict(),
  z.object({ kind: z.literal('secretRef'), secretRef: SafeIdSchema }).strict(),
])

export const RuntimeHttpBodySchema = z.union([
  z.object({ kind: z.literal('no-body') }).strict(),
  z.object({
    kind: z.literal('segments'),
    contentType: z.string().min(1).max(8 * 1024).refine((value) => !/[\r\n\0]/.test(value)),
    segments: z.array(RuntimeHttpBodySegmentSchema).min(1).max(128),
    templateDigest: DigestSchema,
  }).strict().superRefine((body, context) => {
    const expected = digestRuntimeHttpBodyTemplate({
      kind: body.kind, contentType: body.contentType, segments: body.segments,
    })
    if (body.templateDigest !== expected) {
      context.addIssue({ code: 'custom', message: 'templateDigest 与固定 body segments 不一致', path: ['templateDigest'] })
    }
  }),
])

const CanonicalHttpUrlSchema = z.string().min(1).max(8 * 1024).refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
      && url.href === value
  } catch { return false }
}, 'URL 必须是无凭据、无 fragment 的 canonical HTTP(S) URL')

const RuntimeHttpRequestBaseSchema = z.object({
  requestId: SafeIdSchema,
  intentId: SafeIdSchema,
  method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/),
  url: CanonicalHttpUrlSchema,
  headers: z.array(RuntimeHttpHeaderSchema).max(128),
  body: RuntimeHttpBodySchema,
  expectedStatus: z.number().int().min(100).max(599),
  expectedResponseBodyDigest: DigestSchema,
}).strict()

export const RuntimeFixedHttpRequestSchema = RuntimeHttpRequestBaseSchema.superRefine((request, context) => {
  const names = request.headers.map((header) => header.name)
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', message: 'HTTP header name 必须唯一', path: ['headers'] })
  }
})

export const RuntimeHttpReadProbeSchema = z.object({
  requestId: SafeIdSchema,
  intentId: SafeIdSchema,
  method: z.enum(['GET', 'HEAD']),
  url: CanonicalHttpUrlSchema,
  headers: z.array(RuntimeHttpHeaderSchema).max(128),
  expectedStatus: z.number().int().min(100).max(599),
  expectedResponseBodyDigest: DigestSchema,
}).strict().superRefine((probe, context) => {
  const names = probe.headers.map((header) => header.name)
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', message: 'HTTP header name 必须唯一', path: ['headers'] })
  }
})

export const RuntimeWriteHttpActionSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  caseId: SafeIdSchema,
  stepId: SafeIdSchema,
  actionId: SafeIdSchema,
  writeRequest: RuntimeFixedHttpRequestSchema,
  effectProbe: RuntimeHttpReadProbeSchema,
  cleanupPlanId: SafeIdSchema,
}).strict().superRefine((action, context) => {
  if (action.writeRequest.method === 'GET' || action.writeRequest.method === 'HEAD') {
    context.addIssue({ code: 'custom', message: 'writeRequest 必须是非 GET/HEAD 方法', path: ['writeRequest', 'method'] })
  }
  if (action.writeRequest.requestId === action.effectProbe.requestId
    || action.writeRequest.intentId === action.effectProbe.intentId) {
    context.addIssue({ code: 'custom', message: 'write 与 effect probe 的 requestId/intentId 必须不同' })
  }
})

export function digestRuntimeHttpBodyTemplate(value: {
  kind: 'segments'
  contentType: string
  segments: Array<z.infer<typeof RuntimeHttpBodySegmentSchema>>
}): string {
  return digestText('runtime-http-body-template/v1', canonicalizeJson(value))
}

export function digestRuntimeHttpResponseBody(value: Uint8Array): string {
  return digestText('runtime-http-response-body/v1', Buffer.from(value).toString('base64url'))
}

export function digestRuntimeWriteHttpAction(value: RuntimeWriteHttpAction): string {
  return digestText('runtime-write-http-action/v1', canonicalizeJson(RuntimeWriteHttpActionSchema.parse(value)))
}

export type RuntimeHttpBodySegment = z.infer<typeof RuntimeHttpBodySegmentSchema>
export type RuntimeHttpBody = z.infer<typeof RuntimeHttpBodySchema>
export type RuntimeFixedHttpRequest = z.infer<typeof RuntimeFixedHttpRequestSchema>
export type RuntimeHttpReadProbe = z.infer<typeof RuntimeHttpReadProbeSchema>
export type RuntimeWriteHttpAction = z.infer<typeof RuntimeWriteHttpActionSchema>
