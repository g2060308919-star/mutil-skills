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
  method: string
  url: string
  maxUses: number
  channel?: GatewayChannel
  bodyBase64Url?: string
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
  method: string
  url: string
  maxUses: number
  channel: GatewayChannel
  actionToken: string
  bodyDigest: string
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
  const rules = input.approvedRequests.map((candidate, index): ProjectedGatewayRule => {
    if (!candidate || !SAFE_ID.test(candidate.actionId) || !SAFE_ID.test(candidate.capabilityId)
      || !HTTP_METHOD.test(candidate.method) || !Number.isSafeInteger(candidate.maxUses)
      || candidate.maxUses < 1 || candidate.maxUses > 100_000) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    const channel = candidate.channel ?? 'http'
    if (!['http', 'beacon', 'websocket'].includes(channel)) throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    const normalizedUrl = normalizeTargetUrl(candidate.url, channel)
    const identity = canonicalizeJson({ candidate: { ...candidate, url: normalizedUrl, channel } })
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
    if (candidate.contentType !== undefined && (candidate.bodyBase64Url === undefined
      || Buffer.byteLength(candidate.contentType) > 8 * 1024 || /[\r\n\0]/.test(candidate.contentType))) {
      throw gatewayProjectionError('E2E_GATEWAY_POLICY_INVALID')
    }
    const behavior = snapshotBehavior(candidate.behavior)
    const bodyDigest = digestText('gateway-request-body/v1', candidate.bodyBase64Url ?? '')
    const correlation = canonicalizeJson({
      actionId: candidate.actionId, capabilityId: candidate.capabilityId, method: candidate.method,
      url: normalizedUrl, channel, bodyDigest,
    })
    if (correlations.has(correlation)) throw gatewayProjectionError('E2E_GATEWAY_POLICY_CORRELATION_CONFLICT')
    correlations.add(correlation)
    return {
      ruleId: digestText('gateway-projected-rule/v1', identity),
      stepOrdinal: index + 1,
      actionId: candidate.actionId,
      capabilityId: candidate.capabilityId,
      method: candidate.method,
      url: normalizedUrl,
      maxUses: candidate.maxUses,
      channel,
      actionToken: randomBytes(32).toString('base64url'),
      bodyDigest,
      ...(candidate.bodyBase64Url === undefined ? {} : { bodyBase64Url: candidate.bodyBase64Url }),
      ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
      behavior,
    }
  })
  const readIntents = rules.flatMap((rule): ReadIntent[] => {
    if (rule.channel === 'websocket' || !['GET', 'HEAD'].includes(rule.method) || rule.behavior.kind !== 'pass-through') return []
    const canonical = canonicalizeHttpRequest({ method: rule.method, url: rule.url })
    return [{
      intentId: rule.capabilityId,
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
  },
): ProjectedGatewayRule {
  const canonicalUrl = normalizeTargetUrl(input.url, input.channel)
  const matches = rules.filter((rule) => rule.ruleId === input.ruleId
    && rule.stepOrdinal === input.stepOrdinal && rule.actionId === input.actionId
    && rule.capabilityId === input.capabilityId && rule.method === input.method.toUpperCase()
    && rule.url === canonicalUrl && rule.channel === input.channel && rule.bodyDigest === input.bodyDigest)
  if (matches.length !== 1) throw gatewayProjectionError('E2E_GATEWAY_BROWSER_CORRELATION_DENIED')
  return matches[0]!
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
