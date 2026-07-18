import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const HeaderNameSchema = z.string().min(1).max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/)
const HeaderValueSchema = z.string().refine((value) =>
  Buffer.byteLength(value, 'utf8') <= 8 * 1024 && !/[\0-\x08\x0a-\x1f\x7f]/.test(value))

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'api-key', 'authorization', 'connection', 'content-length', 'cookie', 'host', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'x-api-key', 'x-auth-token',
])

export const ReadHttpHeaderSchema = z.object({
  name: HeaderNameSchema.refine((name) => !FORBIDDEN_REQUEST_HEADERS.has(name)
    && !/(^|-)(?:auth|credential|csrf|secret|session|token)(?:-|$)/.test(name)),
  value: HeaderValueSchema,
}).strict()

export const ReadHttpRedirectPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('deny') }).strict(),
  z.object({
    mode: z.literal('follow-approved'),
    maxHops: z.number().int().positive().max(10),
    requestIds: z.array(SafeIdSchema).min(1).max(10)
      .refine((values) => new Set(values).size === values.length, 'redirect requestId 必须唯一'),
  }).strict(),
])

const CanonicalHttpUrlSchema = z.string().min(1).max(16 * 1024).refine((value) => {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === '' && parsed.hash === ''
      && parsed.href === value
  } catch {
    return false
  }
}, 'URL 必须是无凭据、无 fragment 的规范 http/https URL')

export const ReadHttpRequestSchema = z.object({
  requestId: SafeIdSchema,
  method: z.enum(['GET', 'HEAD', 'OPTIONS']),
  url: CanonicalHttpUrlSchema,
  headers: z.array(ReadHttpHeaderSchema).max(256).superRefine((headers, context) => {
    for (let index = 1; index < headers.length; index += 1) {
      if (headers[index - 1]!.name >= headers[index]!.name) {
        context.addIssue({
          code: 'custom', path: [index, 'name'],
          message: 'header 名称必须唯一并按字节升序排列',
        })
      }
    }
  }),
  bodyDigest: DigestSchema,
  redirectPolicy: ReadHttpRedirectPolicySchema,
}).strict()

export const ReadHttpRequestSetSchema = z.array(ReadHttpRequestSchema).max(100_000)
  .superRefine((requests, context) => {
    const ids = new Set(requests.map((request) => request.requestId))
    if (ids.size !== requests.length) {
      context.addIssue({ code: 'custom', message: 'E2E_READ_HTTP_REQUEST_ID_DUPLICATE' })
      return
    }
    for (const [requestIndex, request] of requests.entries()) {
      if (request.redirectPolicy.mode !== 'follow-approved') continue
      for (const [referenceIndex, requestId] of request.redirectPolicy.requestIds.entries()) {
        if (!ids.has(requestId) || requestId === request.requestId) {
          context.addIssue({
            code: 'custom', path: [requestIndex, 'redirectPolicy', 'requestIds', referenceIndex],
            message: 'E2E_READ_HTTP_REDIRECT_REQUEST_UNKNOWN',
          })
        }
      }
    }
  })

export type ReadHttpHeader = z.infer<typeof ReadHttpHeaderSchema>
export type ReadHttpRedirectPolicy = z.infer<typeof ReadHttpRedirectPolicySchema>
export type ReadHttpRequest = z.infer<typeof ReadHttpRequestSchema>
export type ReadHttpRequestReferences = Record<string, string[]>

export function validateReadHttpRequestSet(candidate: unknown): ReadHttpRequest[] {
  return ReadHttpRequestSetSchema.parse(candidate)
}

export function validateReadHttpActionReferences(
  actionIds: string[],
  requests: ReadHttpRequest[],
  references: ReadHttpRequestReferences,
): ReadHttpRequestReferences {
  const expected = [...new Set(actionIds)].sort()
  const actual = Object.keys(references).sort()
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error('E2E_READ_HTTP_MIGRATION_MAPPING')
  }
  const knownRequests = new Set(requests.map((request) => request.requestId))
  const normalized: ReadHttpRequestReferences = {}
  const referenceCounts = new Map<string, number>()
  const actionIdCounts = new Map<string, number>()
  for (const actionId of actionIds) actionIdCounts.set(actionId, (actionIdCounts.get(actionId) ?? 0) + 1)
  for (const actionId of expected) {
    const requestIds = references[actionId]
    if (!Array.isArray(requestIds) || new Set(requestIds).size !== requestIds.length
      || requestIds.some((requestId) => !knownRequests.has(requestId))) {
      throw new Error('E2E_READ_HTTP_REQUEST_REFERENCE_UNKNOWN')
    }
    if (requestIds.length > 0 && actionIdCounts.get(actionId) !== 1) {
      throw new Error('E2E_READ_HTTP_MIGRATION_MAPPING')
    }
    normalized[actionId] = [...requestIds]
    for (const requestId of requestIds) {
      referenceCounts.set(requestId, (referenceCounts.get(requestId) ?? 0) + 1)
    }
  }
  if ([...knownRequests].some((requestId) => referenceCounts.get(requestId) !== 1)) {
    throw new Error('E2E_READ_HTTP_REQUEST_REFERENCE_CARDINALITY')
  }
  return normalized
}

export function refineReadHttpActionReferences(
  actions: Array<{ actionId: string; operation: string; requestIds: string[] }>,
  requests: ReadHttpRequest[],
  context: z.RefinementCtx,
): void {
  const knownRequests = new Set(requests.map((request) => request.requestId))
  const referenceCounts = new Map<string, number>()
  if (new Set(actions.map((action) => `${action.actionId}\0${action.operation}`)).size !== actions.length) {
    context.addIssue({ code: 'custom', message: 'actionId 与 operation 组合必须唯一', path: ['actions'] })
  }
  actions.forEach((action, actionIndex) => {
    if (new Set(action.requestIds).size !== action.requestIds.length) {
      context.addIssue({ code: 'custom', message: 'requestId 引用必须唯一', path: ['actions', actionIndex, 'requestIds'] })
    }
    if ((action.operation === 'http-request') !== (action.requestIds.length > 0)) {
      context.addIssue({
        code: 'custom', message: '仅 http-request action 可以且必须引用 requestId',
        path: ['actions', actionIndex, 'requestIds'],
      })
    }
    action.requestIds.forEach((requestId, requestIndex) => {
      if (!knownRequests.has(requestId)) {
        context.addIssue({
          code: 'custom', message: 'E2E_READ_HTTP_REQUEST_REFERENCE_UNKNOWN',
          path: ['actions', actionIndex, 'requestIds', requestIndex],
        })
      }
      referenceCounts.set(requestId, (referenceCounts.get(requestId) ?? 0) + 1)
    })
  })
  for (const requestId of knownRequests) {
    if (referenceCounts.get(requestId) !== 1) {
      context.addIssue({
        code: 'custom', message: 'E2E_READ_HTTP_REQUEST_REFERENCE_CARDINALITY', path: ['actions'],
      })
    }
  }
}
