export const WEBSOCKET_BRIDGE_UNAVAILABLE = 'E2E_GATEWAY_WEBSOCKET_BRIDGE_UNAVAILABLE'

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
