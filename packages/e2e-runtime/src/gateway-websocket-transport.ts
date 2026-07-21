export const WEBSOCKET_BRIDGE_UNAVAILABLE = 'E2E_GATEWAY_WEBSOCKET_BRIDGE_UNAVAILABLE'
export const SSE_BRIDGE_UNAVAILABLE = 'E2E_GATEWAY_SSE_BRIDGE_UNAVAILABLE'

/**
 * Mockttp 的 WebSocket message event 是转发后事件，不能充当转发前 policy hook。
 * 在受控逐帧 bridge 落地前，pass-through 唯一安全 disposition 是不 reserve 并拒绝。
 */
export function websocketUnsupportedDisposition(
  _behavior: 'pass-through' | 'http-response' | 'connection-reset' | 'timeout',
): {
  selectMatchedRule: true
  reserveCapability: false
  auditDecision: 'blocked'
  status: 501
  code: typeof WEBSOCKET_BRIDGE_UNAVAILABLE
} {
  return {
    selectMatchedRule: true,
    reserveCapability: false,
    auditDecision: 'blocked',
    status: 501,
    code: WEBSOCKET_BRIDGE_UNAVAILABLE,
  }
}

/**
 * SSE 是长连接 HTTP，但 reservation 只有在真实 stream close/abort 后才能 complete/unknown。
 * 在该终态桥落地前，即使 URL 命中普通 GET rule，也必须在连接上游前拒绝。
 */
export function sseUnsupportedDisposition(): {
  status: 501
  code: typeof SSE_BRIDGE_UNAVAILABLE
  reserveCapability: false
  auditDecision: 'blocked'
} {
  return {
    status: 501,
    code: SSE_BRIDGE_UNAVAILABLE,
    reserveCapability: false,
    auditDecision: 'blocked',
  }
}
