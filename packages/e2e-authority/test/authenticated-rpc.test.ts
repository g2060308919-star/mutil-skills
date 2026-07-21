import { describe, expect, test } from 'vitest'
import {
  AuthenticatedRpcClient,
  AuthenticatedRpcServer,
  createAuthenticatedRpcHttpTransport,
  startAuthenticatedRpcLoopbackServer,
  type AuthenticatedRpcRequest,
  type AuthenticatedRpcResponse,
  type AuthenticatedRpcTransport,
} from '../src/index.js'

const NOW = new Date('2026-07-14T10:00:00.000Z')

function setup(input: { serverNow?: () => Date; clientNow?: () => Date; ttlMs?: number } = {}) {
  const server = AuthenticatedRpcServer.create({
    issuer: 'local-authority', keyId: 'authority-rpc-1', now: input.serverNow ?? (() => NOW),
  })
  const credential = server.registerClient('runner-1', Buffer.alloc(32, 7))
  const material = server.verifierMaterial
  const client = AuthenticatedRpcClient.create({
    credential,
    verifierMaterial: material,
    expectedPublicKeyDigest: material.publicKeyDigest,
    transport: (request) => server.handle(request),
    now: input.clientNow ?? (() => NOW),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  })
  return { server, credential, material, client }
}

describe('Authenticated Authority RPC', () => {
  test('replay cache 同时限制每 client 与全局容量，并在 TTL 后精确回收计数', async () => {
    let clock = NOW
    const server = AuthenticatedRpcServer.create({
      issuer: 'local-authority', keyId: 'authority-rpc-capacity', now: () => clock,
    })
    server.registerOperation('echo.capacity', async () => ({ ok: true }))
    const material = server.verifierMaterial
    const createClient = (clientId: string, fill: number) => {
      const credential = server.registerClient(clientId, Buffer.alloc(32, fill))
      return AuthenticatedRpcClient.create({ credential, verifierMaterial: material,
        expectedPublicKeyDigest: material.publicKeyDigest,
        transport: (request) => server.handle(request), now: () => clock, ttlMs: 5_000 })
    }
    const first = createClient('capacity-1', 1)
    const second = createClient('capacity-2', 2)
    const third = createClient('capacity-3', 3)

    for (let index = 0; index < 1_024; index += 1) await first.call('echo.capacity', { index })
    await expect(first.call('echo.capacity', { overflow: true }))
      .rejects.toMatchObject({ code: 'E2E_RPC_REPLAY_CACHE_CAPACITY' })
    for (let index = 0; index < 1_024; index += 1) await second.call('echo.capacity', { index })
    await expect(third.call('echo.capacity', { globalOverflow: true }))
      .rejects.toMatchObject({ code: 'E2E_RPC_REPLAY_CACHE_CAPACITY' })

    clock = new Date(NOW.getTime() + 5_001)
    await expect(third.call('echo.capacity', { afterExpiry: true })).resolves.toEqual({ ok: true })
  }, 15_000)

  test('请求由独立会话密钥认证，响应由固定 Authority Ed25519 公钥认证', async () => {
    const { server, client, material } = setup()
    server.registerOperation('echo.read', async (payload) => ({ accepted: true, payload }))

    await expect(client.call('echo.read', { actionId: 'ACTION-1' })).resolves.toEqual({
      accepted: true, payload: { actionId: 'ACTION-1' },
    })
    expect(client.authorityPublicKeyDigest).toBe(material.publicKeyDigest)
    expect(client.authorityIdentity).toEqual({ issuer: 'local-authority', keyId: 'authority-rpc-1' })
  })

  test('显式销毁 Server/Client 后拒绝继续使用长期会话密钥', async () => {
    const { server, client } = setup()
    server.registerOperation('echo.read', async (payload) => payload)
    client.destroy()
    await expect(client.call('echo.read', {})).rejects.toMatchObject({ code: 'E2E_RPC_DESTROYED' })
    server.destroy()
    await expect(server.handle({})).rejects.toMatchObject({ code: 'E2E_RPC_DESTROYED' })
  })

  test('拒绝未知客户端、payload 篡改、非法 nonce 与相同请求重放', async () => {
    const { server, credential, material } = setup()
    server.registerOperation('echo.read', async (payload) => payload)
    let captured: AuthenticatedRpcRequest | undefined
    const captureTransport: AuthenticatedRpcTransport = async (request) => {
      captured = structuredClone(request)
      return server.handle(request)
    }
    const client = AuthenticatedRpcClient.create({ credential, verifierMaterial: material,
      expectedPublicKeyDigest: material.publicKeyDigest, transport: captureTransport, now: () => NOW })
    await client.call('echo.read', { value: 1 })
    const request = captured!

    await expect(server.handle(request)).rejects.toMatchObject({ code: 'E2E_RPC_REQUEST_REPLAYED' })
    await expect(server.handle({ ...request, requestId: 'another-request', clientId: 'unknown-client' }))
      .rejects.toMatchObject({ code: 'E2E_RPC_CLIENT_UNKNOWN' })
    await expect(server.handle({ ...request, requestId: 'payload-tamper', payload: { value: 2 } }))
      .rejects.toMatchObject({ code: 'E2E_RPC_PAYLOAD_DIGEST_INVALID' })
    await expect(server.handle({ ...request, requestId: 'nonce-invalid', nonce: 'not/canonical/base64' }))
      .rejects.toMatchObject({ code: 'E2E_RPC_REQUEST_INVALID' })
  })

  test('拒绝过期、未来签发和超过 30 秒有效期的请求', async () => {
    const serverNow = new Date(NOW.getTime() + 10_000)
    const { server, credential, material } = setup({ serverNow: () => serverNow })
    let captured: AuthenticatedRpcRequest | undefined
    const client = AuthenticatedRpcClient.create({ credential, verifierMaterial: material,
      expectedPublicKeyDigest: material.publicKeyDigest,
      transport: async (request) => { captured = request; return server.handle(request) },
      now: () => NOW, ttlMs: 5_000 })

    await expect(client.call('missing', {})).rejects.toMatchObject({ code: 'E2E_RPC_REQUEST_EXPIRED' })
    expect(captured).toBeDefined()
    const future = { ...captured!, requestId: 'future-request', issuedAt: new Date(serverNow.getTime() + 1).toISOString(),
      expiresAt: new Date(serverNow.getTime() + 1_001).toISOString() }
    await expect(server.handle(future)).rejects.toMatchObject({ code: 'E2E_RPC_REQUEST_EXPIRED' })
    const tooLong = { ...captured!, requestId: 'too-long-request', issuedAt: serverNow.toISOString(),
      expiresAt: new Date(serverNow.getTime() + 30_001).toISOString() }
    await expect(server.handle(tooLong)).rejects.toMatchObject({ code: 'E2E_RPC_REQUEST_EXPIRED' })
  })

  test('操作失败也返回已签名错误，并保留安全错误码', async () => {
    const { server, client } = setup()
    server.registerOperation('lease.verify', async () => {
      throw Object.assign(new Error('denied'), { code: 'E2E_LEASE_TARGET_MISMATCH' })
    })

    await expect(client.call('lease.verify', {})).rejects.toMatchObject({ code: 'E2E_LEASE_TARGET_MISMATCH' })
  })

  test('拒绝响应结果、绑定字段、签名及字段类型篡改', async () => {
    const variants: Array<{
      mutate(response: AuthenticatedRpcResponse): unknown
      code: string
    }> = [
      { mutate: (response) => ({ ...response, result: { value: 2 } }), code: 'E2E_RPC_RESPONSE_DIGEST_INVALID' },
      { mutate: (response) => ({ ...response, operation: 'other.read' }), code: 'E2E_RPC_RESPONSE_BINDING_INVALID' },
      { mutate: (response) => ({ ...response, signature: response.signature.replace(/^./, response.signature[0] === 'A' ? 'B' : 'A') }),
        code: 'E2E_RPC_RESPONSE_SIGNATURE_INVALID' },
      { mutate: (response) => ({ ...response, signedDigest: 7 }), code: 'E2E_RPC_RESPONSE_INVALID' },
    ]

    for (const variant of variants) {
      const { server, credential, material } = setup()
      server.registerOperation('echo.read', async () => ({ value: 1 }))
      const client = AuthenticatedRpcClient.create({ credential, verifierMaterial: material,
        expectedPublicKeyDigest: material.publicKeyDigest,
        transport: async (request) => variant.mutate(await server.handle(request)), now: () => NOW })
      await expect(client.call('echo.read', {})).rejects.toMatchObject({ code: variant.code })
    }
  })

  test('客户端固定 Authority 公钥摘要，拒绝替换公钥或伪造 verifier material', () => {
    const first = setup()
    const second = setup()
    expect(() => AuthenticatedRpcClient.create({ credential: first.credential,
      verifierMaterial: second.material, expectedPublicKeyDigest: first.material.publicKeyDigest,
      transport: (request) => second.server.handle(request) }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RPC_VERIFIER_MATERIAL_INVALID' }))
    expect(() => AuthenticatedRpcClient.create({ credential: first.credential,
      verifierMaterial: { ...first.material, publicKeySpkiBase64Url: second.material.publicKeySpkiBase64Url },
      expectedPublicKeyDigest: first.material.publicKeyDigest,
      transport: (request) => first.server.handle(request) }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RPC_PUBLIC_KEY_DIGEST_INVALID' }))
  })

  test('真实 loopback HTTP 只通过精确端点传输认证请求', async ({ skip }) => {
    const { server, credential, material } = setup()
    server.registerOperation('echo.read', async (payload) => payload)
    let handle
    try { handle = await startAuthenticatedRpcLoopbackServer(server) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    try {
      const client = AuthenticatedRpcClient.create({ credential, verifierMaterial: material,
        expectedPublicKeyDigest: material.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(handle.endpoint), now: () => NOW })
      await expect(client.call('echo.read', { over: 'http' })).resolves.toEqual({ over: 'http' })
      expect(() => createAuthenticatedRpcHttpTransport(handle.endpoint.replace('/v1/authority-rpc', '/wrong')))
        .toThrowError(expect.objectContaining({ code: 'E2E_RPC_ENDPOINT_INVALID' }))
    } finally { await handle.close() }
  })
})
