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
