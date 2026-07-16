import {
  E2EError,
  canonicalizeJson,
  type CanonicalHttpRequest,
  type GatewayAuditSummary,
  type GatewayDecision,
  type ReadIntent,
} from '@mutil-skills/e2e-contracts'
import type { GatewayPublicationAuditRecorder } from './publication-audit.js'

export interface RawHttpRequest {
  method: string
  url: string
}

export function canonicalizeHttpRequest(input: RawHttpRequest): CanonicalHttpRequest {
  const snapshot = snapshotRawHttpRequest(input)
  if (/%(?![a-fA-F0-9]{2})/.test(snapshot.url)) throw requestError('E2E_GATEWAY_URL_INVALID', 'URL 包含无效 percent encoding')
  let url: URL
  try {
    url = new URL(snapshot.url)
  } catch (cause) {
    throw requestError('E2E_GATEWAY_URL_INVALID', 'URL 无法解析', cause)
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw requestError('E2E_GATEWAY_SCHEME_DENIED', '只允许 HTTP(S)')
  if (url.username || url.password) throw requestError('E2E_GATEWAY_CREDENTIALS_DENIED', 'URL 不得包含 userinfo')
  if (url.hash) throw requestError('E2E_GATEWAY_FRAGMENT_DENIED', 'URL 不得包含 fragment')

  return {
    method: snapshot.method.toUpperCase(),
    origin: url.origin,
    path: normalizePercentEncoding(url.pathname),
    query: [...url.searchParams.entries()],
  }
}

export class ReadOnlyGateway {
  #stage: 'bootstrap' | 'case'
  readonly #intents: ReadIntent[]
  readonly #approvedActionIds: Set<string>
  readonly #uses = new Map<string, number>()
  readonly #audit: GatewayAuditSummary = { received: 0, forwarded: 0, blocked: 0, byIntent: {} }
  readonly #recorder?: GatewayPublicationAuditRecorder

  constructor(input: {
    stage: 'bootstrap' | 'case'
    intents: Array<ReadIntent | (Omit<ReadIntent, 'actionId'> & { actionId?: undefined })>
    recorder?: GatewayPublicationAuditRecorder
  }) {
    this.#stage = input.stage
    if (input.recorder && input.intents.some((intent) => intent.actionId === undefined)) {
      throw requestError('E2E_GATEWAY_ACTION_ID_REQUIRED', 'Publication audit 要求每个 ReadIntent 绑定 actionId')
    }
    this.#intents = input.intents.map((intent) => ({
      ...intent,
      actionId: intent.actionId ?? '',
      methods: [...intent.methods],
      query: [...intent.query],
    }))
    this.#approvedActionIds = new Set(this.#intents.map((intent) => intent.actionId).filter(Boolean))
    this.#recorder = input.recorder
  }

  switchToCaseStage(): void {
    this.#stage = 'case'
  }

  decide(raw: RawHttpRequest, currentActionId?: string): GatewayDecision {
    if (this.#recorder && !currentActionId) {
      throw requestError('E2E_GATEWAY_CURRENT_ACTION_ID_REQUIRED', 'Publication audit 要求调用方传入 approved currentActionId')
    }
    if (this.#recorder && !this.#approvedActionIds.has(currentActionId!)) {
      throw requestError('E2E_GATEWAY_CURRENT_ACTION_ID_NOT_APPROVED', 'currentActionId 未绑定到已批准 ReadIntent')
    }
    this.#audit.received += 1
    const rawSnapshot = snapshotRawHttpRequest(raw)
    let request: CanonicalHttpRequest
    try {
      request = canonicalizeHttpRequest(rawSnapshot)
    } catch (error) {
      this.#audit.blocked += 1
      this.record(currentActionId, 'blocked', rawSnapshot)
      return { decision: 'block', code: error instanceof E2EError ? error.code : 'E2E_GATEWAY_REQUEST_INVALID', reason: String(error) }
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return this.block('E2E_GATEWAY_METHOD_NOT_READ_ONLY', '只读 Gateway 拒绝非 GET/HEAD 请求', request, currentActionId)
    }

    const intent = this.#intents.find((candidate) =>
      candidate.stage === this.#stage
      && candidate.methods.includes(request.method as 'GET' | 'HEAD')
      && candidate.origin === request.origin
      && candidate.exactPath === request.path
      && canonicalizeJson(candidate.query) === canonicalizeJson(request.query),
    )
    if (!intent) {
      return this.block('E2E_GATEWAY_INTENT_NOT_FOUND', '请求不匹配当前阶段的已批准 intent', request, currentActionId)
    }

    if (currentActionId !== undefined && intent.actionId !== currentActionId) {
      return this.block('E2E_GATEWAY_ACTION_ID_MISMATCH', '请求 intent 与 approved currentActionId 不一致', request, currentActionId)
    }

    const used = this.#uses.get(intent.intentId) ?? 0
    if (used >= intent.maxRequests) {
      return this.block('E2E_GATEWAY_MAX_REQUESTS_EXCEEDED', 'Intent 请求次数已耗尽', request, currentActionId)
    }
    this.#uses.set(intent.intentId, used + 1)
    this.#audit.forwarded += 1
    this.#audit.byIntent[intent.intentId] = (this.#audit.byIntent[intent.intentId] ?? 0) + 1
    this.record(currentActionId ?? intent.actionId, 'forwarded', request)
    return { decision: 'forward', intentId: intent.intentId, request }
  }

  getAuditSummary(): GatewayAuditSummary {
    return { ...this.#audit, byIntent: { ...this.#audit.byIntent } }
  }

  private block(code: string, reason: string, request: CanonicalHttpRequest, currentActionId?: string): GatewayDecision {
    this.#audit.blocked += 1
    this.record(currentActionId, 'blocked', request)
    return { decision: 'block', code, reason, request }
  }

  private record(
    currentActionId: string | undefined,
    decision: 'forwarded' | 'blocked',
    request: CanonicalHttpRequest | RawHttpRequest,
  ): void {
    if (!this.#recorder) return
    this.#recorder.recordReadDecision({ actionId: currentActionId!, decision, request })
  }
}

function normalizePercentEncoding(path: string): string {
  return path.replace(/%([a-fA-F0-9]{2})/g, (_, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : `%${hex.toUpperCase()}`
  })
}

function snapshotRawHttpRequest(input: RawHttpRequest): RawHttpRequest {
  const method = input.method
  const url = input.url
  if (typeof method !== 'string' || typeof url !== 'string') {
    throw requestError('E2E_GATEWAY_REQUEST_INVALID', '请求 method 和 URL 必须为字符串')
  }
  return { method, url }
}

function requestError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false, cause })
}
