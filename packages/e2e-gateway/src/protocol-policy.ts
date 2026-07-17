import {
  E2EError,
  canonicalizeJson,
  digestText,
  type CapabilityReservation,
  type GrantDecision,
  type InjectionGatewayDecision,
  type SignedSseReadGrant,
  type SignedWebSocketReadGrant,
  type SseReadCapability,
  type WebSocketReadCapability,
} from '@mutil-skills/e2e-contracts'
import { canonicalizeHttpRequest } from './read-policy.js'
import type { RawWriteHttpRequest } from './write-policy.js'

type ForbiddenChannel =
  | 'service-worker' | 'webrtc' | 'quic' | 'udp' | 'ftp' | 'file'
  | 'custom-scheme' | 'download' | 'unknown'

type HttpProtocolRequest<Channel extends 'http' | 'beacon' | 'iframe' | 'sse'> =
  RawWriteHttpRequest & { channel: Channel; correlationId: string }

export type ProtocolRequest =
  | HttpProtocolRequest<'http'>
  | HttpProtocolRequest<'beacon'>
  | HttpProtocolRequest<'iframe'>
  | HttpProtocolRequest<'sse'>
  | { channel: ForbiddenChannel; correlationId: string; url?: string }
  | { channel: 'websocket-handshake'; correlationId: string; connectionId: string; url: string }
  | { channel: 'websocket-client-frame'; correlationId: string; connectionId: string; byteLength: number }
  | { channel: 'websocket-inbound-frame'; correlationId: string; connectionId: string; byteLength: number }

export type ProtocolDecision =
  | InjectionGatewayDecision
  | { decision: 'accept-websocket'; capabilityId: string; connectionId: string; correlationId: string }
  | { decision: 'accept-frame'; connectionId: string; correlationId: string }

export interface ProtocolAuthorityClient {
  verify(grant: SignedWebSocketReadGrant): Promise<GrantDecision>
  reserveForSubject(input: {
    grant: SignedWebSocketReadGrant; currentSubject: SignedWebSocketReadGrant['subject']
    capabilityId: string; actionId: string; attemptId: string
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<void>
}

export interface SseAuthorityClient {
  verify(grant: SignedSseReadGrant): Promise<GrantDecision>
  reserveForSubject(input: {
    grant: SignedSseReadGrant; currentSubject: SignedSseReadGrant['subject']
    capabilityId: string; actionId: string; attemptId: string
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<void>
}

export interface HttpGatewayDelegate {
  decide(request: RawWriteHttpRequest): Promise<InjectionGatewayDecision> | InjectionGatewayDecision
}

interface WebSocketConnection {
  reservation: CapabilityReservation
  messages: number
  bytes: number
  violated: boolean
}

export class ProtocolGuard {
  readonly #downstream: HttpGatewayDelegate
  readonly #sse: { grant: SignedSseReadGrant; capability: SseReadCapability; authority: SseAuthorityClient }
  #sseUses = 0
  readonly #allowedIframeOrigins: Set<string>
  readonly #websocket?: {
    grant: SignedWebSocketReadGrant
    capability: WebSocketReadCapability
    authority: ProtocolAuthorityClient
  }
  readonly #connections = new Map<string, WebSocketConnection>()

  static denyForbiddenChannelForHost(
    channel: ForbiddenChannel,
    correlationId: string,
  ): ProtocolDecision {
    if (!correlationId) return block('E2E_GATEWAY_CORRELATION_ID_REQUIRED', '所有浏览器网络事件必须携带 correlation ID')
    return block('E2E_GATEWAY_PROTOCOL_FORBIDDEN', `通道 ${channel} 在首期永久拒绝`)
  }

  constructor(input: {
    downstream: HttpGatewayDelegate
    sse: { grant: SignedSseReadGrant; capabilityId: string; authority: SseAuthorityClient }
    allowedIframeOrigins: string[]
    websocket?: { grant: SignedWebSocketReadGrant; capabilityId: string; authority: ProtocolAuthorityClient }
  }) {
    this.#downstream = input.downstream
    const sseCapability = input.sse.grant.capabilities.find((item) => item.capabilityId === input.sse.capabilityId)
    if (!sseCapability) throw protocolError('E2E_GATEWAY_SSE_CAPABILITY_UNKNOWN', 'SSE capability 不属于签名 Grant')
    this.#sse = { grant: input.sse.grant, capability: sseCapability, authority: input.sse.authority }
    this.#allowedIframeOrigins = new Set(input.allowedIframeOrigins.map(canonicalOrigin))
    if (input.websocket) {
      const capability = input.websocket.grant.capabilities.find((item) => item.capabilityId === input.websocket!.capabilityId)
      if (!capability) throw protocolError('E2E_GATEWAY_WEBSOCKET_CAPABILITY_UNKNOWN', 'WebSocket capability 不属于签名 Grant')
      this.#websocket = { grant: input.websocket.grant, capability, authority: input.websocket.authority }
    }
  }

  async decide(request: ProtocolRequest): Promise<ProtocolDecision> {
    if (!request.correlationId) return block('E2E_GATEWAY_CORRELATION_ID_REQUIRED', '所有浏览器网络事件必须携带 correlation ID')
    if (request.channel === 'sse') return await this.decideSse(request)
    if (request.channel === 'iframe') {
      let origin: string
      try {
        origin = canonicalizeHttpRequest(request).origin
      } catch {
        return block('E2E_GATEWAY_IFRAME_URL_INVALID', 'iframe URL 无法安全规范化')
      }
      if (!this.#allowedIframeOrigins.has(origin)) {
        return block('E2E_GATEWAY_IFRAME_ORIGIN_DENIED', 'iframe origin 未被独立授权')
      }
      return await this.#downstream.decide(request)
    }
    if (request.channel === 'http' || request.channel === 'beacon') {
      return await this.#downstream.decide(request)
    }
    if (request.channel === 'websocket-handshake') return await this.openWebSocket(request)
    if (request.channel === 'websocket-client-frame') {
      return block('E2E_GATEWAY_WEBSOCKET_CLIENT_FRAME_DENIED', '首期 WebSocket 只允许只读入站消息，拒绝所有客户端业务帧')
    }
    if (request.channel === 'websocket-inbound-frame') return this.acceptInboundFrame(request)
    return block('E2E_GATEWAY_PROTOCOL_FORBIDDEN', `通道 ${request.channel} 在首期永久拒绝`)
  }

  async closeWebSocket(connectionId: string): Promise<void> {
    const connection = this.#connections.get(connectionId)
    if (!connection || !this.#websocket) {
      throw protocolError('E2E_GATEWAY_WEBSOCKET_CONNECTION_UNKNOWN', 'WebSocket connection 不存在')
    }
    const outcomeDigest = digestText('websocket-read-outcome/v1', canonicalizeJson({
      connectionId,
      messages: connection.messages,
      bytes: connection.bytes,
      violated: connection.violated,
    }))
    await this.#websocket.authority.complete(connection.reservation.reservationId, outcomeDigest)
    this.#connections.delete(connectionId)
  }

  private async decideSse(request: HttpProtocolRequest<'sse'>): Promise<ProtocolDecision> {
    let canonical
    try {
      canonical = canonicalizeHttpRequest(request)
    } catch (error) {
      return block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_SSE_URL_INVALID', String(error))
    }
    const capability = this.#sse.capability
    if (
      canonical.method !== 'GET'
      || canonical.origin !== capability.origin
      || canonical.path !== capability.exactPath
      || canonicalizeJson(canonical.query) !== canonicalizeJson(capability.query)
    ) {
      return block('E2E_GATEWAY_SSE_TARGET_DENIED', 'SSE 请求不匹配签名 read capability')
    }
    if (this.#sseUses >= capability.maxReconnects) {
      return block('E2E_GATEWAY_MAX_REQUESTS_EXCEEDED', 'SSE 重连次数已耗尽')
    }
    const grantDecision = await this.#sse.authority.verify(this.#sse.grant)
    if (!grantDecision.allowed) return block(grantDecision.code, grantDecision.reason)
    try {
      const reservation = await this.#sse.authority.reserveForSubject({
        grant: this.#sse.grant, currentSubject: this.#sse.grant.subject,
        capabilityId: capability.capabilityId,
        actionId: capability.actionId,
        attemptId: `${request.correlationId}:SSE-${this.#sseUses + 1}`,
      })
      await this.#sse.authority.complete(
        reservation.reservationId,
        digestText('sse-read-outcome/v1', canonicalizeJson({ request: canonical, reconnect: this.#sseUses + 1 })),
      )
    } catch (error) {
      return block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_AUTHORITY_FAILURE', String(error))
    }
    this.#sseUses += 1
    return { decision: 'forward', intentId: capability.capabilityId, request: canonical }
  }

  private async openWebSocket(request: Extract<ProtocolRequest, { channel: 'websocket-handshake' }>): Promise<ProtocolDecision> {
    if (this.#connections.has(request.connectionId)) {
      return block('E2E_GATEWAY_WEBSOCKET_CONNECTION_EXISTS', 'WebSocket connectionId 已存在')
    }
    if (!this.#websocket || !matchesWebSocketTarget(request.url, this.#websocket.capability)) {
      return block('E2E_GATEWAY_WEBSOCKET_TARGET_DENIED', 'WebSocket origin/path 未获得签名只读 capability')
    }
    const grantDecision = await this.#websocket.authority.verify(this.#websocket.grant)
    if (!grantDecision.allowed) return block(grantDecision.code, grantDecision.reason)
    try {
      const reservation = await this.#websocket.authority.reserveForSubject({
        grant: this.#websocket.grant, currentSubject: this.#websocket.grant.subject,
        capabilityId: this.#websocket.capability.capabilityId,
        actionId: this.#websocket.capability.actionId,
        attemptId: `${request.correlationId}:${request.connectionId}`,
      })
      this.#connections.set(request.connectionId, { reservation, messages: 0, bytes: 0, violated: false })
    } catch (error) {
      return block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_AUTHORITY_FAILURE', String(error))
    }
    return {
      decision: 'accept-websocket', capabilityId: this.#websocket.capability.capabilityId,
      connectionId: request.connectionId, correlationId: request.correlationId,
    }
  }

  private acceptInboundFrame(
    request: Extract<ProtocolRequest, { channel: 'websocket-inbound-frame' }>,
  ): ProtocolDecision {
    const connection = this.#connections.get(request.connectionId)
    if (!connection || !this.#websocket) {
      return block('E2E_GATEWAY_WEBSOCKET_CONNECTION_UNKNOWN', 'WebSocket connection 不存在')
    }
    if (!Number.isSafeInteger(request.byteLength) || request.byteLength < 0) {
      return block('E2E_GATEWAY_WEBSOCKET_FRAME_INVALID', 'WebSocket frame 大小无效')
    }
    const messages = connection.messages + 1
    const bytes = connection.bytes + request.byteLength
    if (
      connection.violated
      || messages > this.#websocket.capability.maxInboundMessages
      || bytes > this.#websocket.capability.maxBytes
    ) {
      connection.violated = true
      return block('E2E_GATEWAY_WEBSOCKET_LIMIT_EXCEEDED', 'WebSocket 入站消息数或字节数超过签名上限')
    }
    connection.messages = messages
    connection.bytes = bytes
    return { decision: 'accept-frame', connectionId: request.connectionId, correlationId: request.correlationId }
  }
}

function matchesWebSocketTarget(urlText: string, capability: WebSocketReadCapability): boolean {
  if (/[\\]/.test(urlText)) return false
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    return false
  }
  return ['ws:', 'wss:'].includes(url.protocol)
    && !url.username && !url.password && !url.hash && !url.search
    && url.origin === capability.origin
    && url.pathname === capability.path
}

function canonicalOrigin(origin: string): string {
  return canonicalizeHttpRequest({ method: 'GET', url: `${origin}/` }).origin
}

function block(code: string, reason: string): ProtocolDecision {
  return { decision: 'block', code, reason }
}

function protocolError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
