import {
  canonicalizeJson,
  digestText,
  type ReadIntent,
} from '@mutil-skills/e2e-contracts'
import { canonicalizeHttpRequest } from '@mutil-skills/e2e-gateway'
import { randomBytes } from 'node:crypto'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const HTTP_METHOD = /^[A-Z]{1,32}$/

export type GatewayChannel = 'http' | 'beacon' | 'websocket'

export interface ApprovedGatewayRequest {
  actionId: string
  capabilityId: string
  requestId?: string
  method: string
  url: string
  maxUses: number
  signedBodyDigest?: string
  headers?: Array<{ name: string; value: string }>
  redirectRequestIds?: string[]
  channel?: GatewayChannel
  bodyBase64Url?: string
  /** secret template 只传运行时解析后的 body 摘要；不得把 secret body 写入规则或 IPC 配置。 */
  resolvedBodyDigest?: string
  contentType?: string
  behavior?:
    | { kind: 'pass-through' }
    | { kind: 'http-response'; status: number; headers?: Record<string, string>; body?: string; delayMs?: number }
    | { kind: 'connection-reset' }
    | { kind: 'timeout' }
}

export interface ProjectedGatewayRule {
  ruleId: string
  stepOrdinal: number
  actionId: string
  capabilityId: string
  requestId?: string
  method: string
  url: string
  maxUses: number
  channel: GatewayChannel
  actionToken: string
  bodyDigest: string
  signedBodyDigest?: string
  requestHeaders: Record<string, string>
  redirectRequestIds: string[]
  bodyBase64Url?: string
  contentType?: string
  behavior: NonNullable<ApprovedGatewayRequest['behavior']>
}

export interface GatewayRuleProjection {
  rules: ProjectedGatewayRule[]
  readIntents: ReadIntent[]
  policyDigest: string
}

export function projectGatewayRules(input: {
  runId: string
  approvedRequests: ApprovedGatewayRequest[]
}): GatewayRuleProjection {
  if (!SAFE_ID.test(input.runId) || !Array.isArray(input.approvedRequests) || input.approvedRequests.length > 10_000) {
    throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
  }
  const seen = new Set<string>()
  const correlations = new Set<string>()
  const requestIds = new Set<string>()
  const actionTokens = new Set<string>()
  const rules = input.approvedRequests.map((candidate, index): ProjectedGatewayRule => {
    if (!candidate || !SAFE_ID.test(candidate.actionId) || !SAFE_ID.test(candidate.capabilityId)
      || !HTTP_METHOD.test(candidate.method) || !Number.isSafeInteger(candidate.maxUses)
      || candidate.maxUses < 1 || candidate.maxUses > 100_000) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    const hasRequestClosure = candidate.requestId !== undefined || candidate.signedBodyDigest !== undefined
      || candidate.headers !== undefined || candidate.redirectRequestIds !== undefined
    if (hasRequestClosure && (!candidate.requestId || !SAFE_ID.test(candidate.requestId)
      || !candidate.signedBodyDigest || !/^sha256:[a-f0-9]{64}$/.test(candidate.signedBodyDigest)
      || !Array.isArray(candidate.headers) || !Array.isArray(candidate.redirectRequestIds))) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    if (candidate.requestId !== undefined) {
      if (requestIds.has(candidate.requestId)) throw gatewayProjectionError('E2E_GATEWAY_POLICY_DUPLICATE')
      requestIds.add(candidate.requestId)
    }
    const requestHeaders = normalizeApprovedHeaders(candidate.headers ?? [])
    const redirectRequestIds = [...(candidate.redirectRequestIds ?? [])]
    if (new Set(redirectRequestIds).size !== redirectRequestIds.length
      || redirectRequestIds.some((requestId) => !SAFE_ID.test(requestId))) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    const channel = candidate.channel ?? 'http'
    if (!['http', 'beacon', 'websocket'].includes(channel)) throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    const normalizedUrl = normalizeTargetUrl(candidate.url, channel)
    const identity = canonicalizeJson({ candidate: {
      ...candidate, url: normalizedUrl, channel, headers: Object.entries(requestHeaders), redirectRequestIds,
    } })
    if (seen.has(identity)) throw gatewayProjectionError('E2E_GATEWAY_POLICY_DUPLICATE')
    seen.add(identity)
    if (candidate.bodyBase64Url !== undefined) {
      const body = Buffer.from(candidate.bodyBase64Url, 'base64url')
      try {
        if (body.byteLength > 1024 * 1024 || body.toString('base64url') !== candidate.bodyBase64Url) {
          throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
        }
      } finally { body.fill(0) }
    }
    if (candidate.resolvedBodyDigest !== undefined && (!/^sha256:[a-f0-9]{64}$/.test(candidate.resolvedBodyDigest)
      || candidate.bodyBase64Url !== undefined)) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    if (candidate.contentType !== undefined && (candidate.bodyBase64Url === undefined
      && candidate.resolvedBodyDigest === undefined
      || Buffer.byteLength(candidate.contentType) > 8 * 1024 || /[\r\n\0]/.test(candidate.contentType))) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    const behavior = snapshotBehavior(candidate.behavior)
    const bodyDigest = candidate.resolvedBodyDigest
      ?? digestText('gateway-request-body/v1', candidate.bodyBase64Url ?? '')
    const correlation = canonicalizeJson({
      actionId: candidate.actionId, capabilityId: candidate.capabilityId, method: candidate.method,
      url: normalizedUrl, channel, bodyDigest,
      ...(candidate.requestId === undefined ? {} : { requestId: candidate.requestId }),
    })
    if (correlations.has(correlation)) throw gatewayProjectionError('E2E_GATEWAY_POLICY_CORRELATION_CONFLICT')
    correlations.add(correlation)
    let actionToken: string
    do { actionToken = randomBytes(32).toString('base64url') } while (actionTokens.has(actionToken))
    actionTokens.add(actionToken)
    return {
      ruleId: digestText('gateway-projected-rule/v1', identity),
      stepOrdinal: index + 1,
      actionId: candidate.actionId,
      capabilityId: candidate.capabilityId,
      ...(candidate.requestId === undefined ? {} : { requestId: candidate.requestId }),
      method: candidate.method,
      url: normalizedUrl,
      maxUses: candidate.maxUses,
      channel,
      actionToken,
      bodyDigest,
      ...(candidate.signedBodyDigest === undefined ? {} : { signedBodyDigest: candidate.signedBodyDigest }),
      requestHeaders,
      redirectRequestIds,
      ...(candidate.bodyBase64Url === undefined ? {} : { bodyBase64Url: candidate.bodyBase64Url }),
      ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
      behavior,
    }
  })
  const readIntents = rules.flatMap((rule): ReadIntent[] => {
    if (rule.channel === 'websocket' || !['GET', 'HEAD'].includes(rule.method) || rule.behavior.kind !== 'pass-through') return []
    const canonical = canonicalizeHttpRequest({ method: rule.method, url: rule.url })
    return [{
      intentId: rule.requestId ?? rule.capabilityId,
      actionId: rule.actionId,
      stage: 'case',
      methods: [rule.method as 'GET' | 'HEAD'],
      origin: canonical.origin,
      exactPath: canonical.path,
      query: canonical.query,
      maxRequests: rule.maxUses,
    }]
  })
  const publicRules = rules.map(({ actionToken: _secret, ...rule }) => rule)
  return {
    rules,
    readIntents,
    policyDigest: digestText('gateway-proxy-policy/v1', canonicalizeJson({ runId: input.runId, rules: publicRules })),
  }
}

export function assertGatewayModePolicy(
  mode: 'real-environment' | 'injection',
  rules: ProjectedGatewayRule[],
): void {
  const valid = mode === 'real-environment'
    ? rules.every((rule) => rule.behavior.kind === 'pass-through')
    : rules.every((rule) => rule.behavior.kind !== 'pass-through' && rule.channel !== 'websocket')
  if (!valid) throw gatewayProjectionError('E2E_GATEWAY_MODE_POLICY_INVALID')
}

export function selectProjectedRuleForBrowser(
  rules: ProjectedGatewayRule[],
  input: {
    ruleId: string; stepOrdinal: number; actionId: string; capabilityId: string
    method: string; url: string; channel: GatewayChannel; bodyDigest: string
    requestId?: string; signedBodyDigest?: string
  },
): ProjectedGatewayRule {
  const canonicalUrl = normalizeTargetUrl(input.url, input.channel)
  const matches = rules.filter((rule) => rule.ruleId === input.ruleId
    && rule.stepOrdinal === input.stepOrdinal && rule.actionId === input.actionId
    && rule.capabilityId === input.capabilityId && rule.method === input.method.toUpperCase()
    && rule.url === canonicalUrl && rule.channel === input.channel && rule.bodyDigest === input.bodyDigest
    && rule.requestId === input.requestId && rule.signedBodyDigest === input.signedBodyDigest)
  if (matches.length !== 1) throw gatewayProjectionError('E2E_GATEWAY_BROWSER_CORRELATION_DENIED')
  return matches[0]!
}

function normalizeApprovedHeaders(headers: Array<{ name: string; value: string }>): Record<string, string> {
  const normalized: Record<string, string> = {}
  const forbidden = new Set([
    'api-key', 'authorization', 'connection', 'content-length', 'cookie', 'host', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'x-api-key', 'x-auth-token',
  ])
  for (const header of headers) {
    if (!header || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(header.name)
      || forbidden.has(header.name)
      || /(^|-)(?:auth|credential|csrf|secret|session|token)(?:-|$)/.test(header.name)
      || Buffer.byteLength(header.value, 'utf8') > 8 * 1024
      || /[\0-\x08\x0a-\x1f\x7f]/.test(header.value)
      || Object.hasOwn(normalized, header.name)) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    normalized[header.name] = header.value
  }
  return normalized
}

function normalizeTargetUrl(value: string, channel: GatewayChannel): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8 * 1024 || /[\\\0]/.test(value)) {
    throw gatewayProjectionError('E2E_GATEWAY_URL_INVALID')
  }
  let url: URL
  try { url = new URL(value) } catch { throw gatewayProjectionError('E2E_GATEWAY_URL_INVALID') }
  const protocols = channel === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:']
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) {
    throw gatewayProjectionError('E2E_GATEWAY_URL_INVALID')
  }
  return url.href
}

function snapshotBehavior(value: ApprovedGatewayRequest['behavior']): NonNullable<ApprovedGatewayRequest['behavior']> {
  if (value === undefined) return { kind: 'pass-through' }
  if (value.kind === 'pass-through' || value.kind === 'connection-reset' || value.kind === 'timeout') return { kind: value.kind }
  if (value.kind !== 'http-response' || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || (value.delayMs !== undefined && (!Number.isInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 30_000))
    || (value.body !== undefined && Buffer.byteLength(value.body) > 64 * 1024)) {
    throw gatewayProjectionError('E2E_GATEWAY_INJECTION_INVALID')
  }
  const headers = value.headers ?? {}
  const allowed = new Set(['content-type', 'retry-after', 'cache-control'])
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!allowed.has(name.toLowerCase()) || Buffer.byteLength(headerValue) > 8 * 1024 || /[\r\n\0]/.test(headerValue)) {
      throw gatewayProjectionError('E2E_GATEWAY_INJECTION_INVALID')
    }
  }
  return {
    kind: 'http-response', status: value.status,
    ...(Object.keys(headers).length === 0 ? {} : { headers: { ...headers } }),
    ...(value.body === undefined ? {} : { body: value.body }),
    ...(value.delayMs === undefined ? {} : { delayMs: value.delayMs }),
  }
}

function gatewayProjectionError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
