interface RpcClientRegistrar {
  registerClient(clientId: string, sessionKey?: Uint8Array): unknown
}

interface RpcSessionKeyConfig {
  rpc: { clientId: string }
  sessionKeyBase64Url: string
}

/** Decodes the one-shot child credential and guarantees that its bytes are scrubbed after registration. */
export function registerAuthenticatedRpcClientFromConfig(
  rpc: RpcClientRegistrar,
  config: RpcSessionKeyConfig,
): void {
  const sessionKey = decode32(config.sessionKeyBase64Url)
  config.sessionKeyBase64Url = ''
  try {
    rpc.registerClient(config.rpc.clientId, sessionKey)
  } finally {
    sessionKey.fill(0)
  }
}

function decode32(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    throw Object.assign(new Error('E2E_RPC_HOST_KEY_INVALID'), { code: 'E2E_RPC_HOST_KEY_INVALID' })
  }
  return bytes
}
