import { expect, test, vi } from 'vitest'
import { registerAuthenticatedRpcClientFromConfig } from '../src/authority-rpc-session-key.js'

test('zeroizes the decoded child session key when client registration throws', () => {
  let observedKey: Uint8Array | undefined
  const rpc = {
    registerClient: vi.fn((_clientId: string, sessionKey?: Uint8Array) => {
      observedKey = sessionKey
      throw new Error('registration failed')
    }),
  }
  const config = {
    rpc: { clientId: 'runner' },
    sessionKeyBase64Url: Buffer.alloc(32, 9).toString('base64url'),
  }

  expect(() => registerAuthenticatedRpcClientFromConfig(rpc, config)).toThrow('registration failed')
  expect(config.sessionKeyBase64Url).toBe('')
  expect(observedKey).toBeDefined()
  expect([...observedKey!]).toEqual(new Array(32).fill(0))
})

test.each([
  Buffer.alloc(31, 7).toString('base64url'),
  `${Buffer.alloc(32, 7).toString('base64url')}=`,
])('zeroizes temporary decoded bytes when the child session key is invalid', (invalidKey) => {
  const fill = vi.spyOn(Buffer.prototype, 'fill')
  try {
    const config = {
      rpc: { clientId: 'runner' },
      sessionKeyBase64Url: invalidKey,
    }

    expect(() => registerAuthenticatedRpcClientFromConfig({ registerClient: vi.fn() }, config))
      .toThrow('E2E_RPC_HOST_KEY_INVALID')
    expect(fill.mock.instances.some((bytes) => [31, 32].includes(bytes.byteLength)
      && [...bytes].every((byte) => byte === 0))).toBe(true)
  } finally {
    fill.mockRestore()
  }
})
