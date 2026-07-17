import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { afterEach, describe, expect, test } from 'vitest'
import { canBindLoopback, listenOnLoopback, startGatewayProxyHostForTest } from './fixtures.js'

const handles: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  const closing = handles.splice(0).reverse().map(async (handle) => await handle.close())
  await Promise.allSettled(closing)
})

const loopbackAvailable = await canBindLoopback()

describe.skipIf(!loopbackAvailable)(
  '真实 loopback transport（默认 sandbox 不可用时跳过，不计为功能通过）',
  () => {

test('真实代理只转发已批准且相关的请求，未匹配流量默认拒绝', async () => {
  const seenHeaders: Array<string | undefined> = []
  const upstream = createServer((request, response) => {
    seenHeaders.push(request.headers['x-mutil-e2e-action-token'] as string | undefined)
    response.end(request.url === '/allowed' ? 'allowed' : 'unexpected')
  })
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `http://127.0.0.1:${address.port}/allowed`

  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-1',
    mode: 'real-environment',
    approvedRequests: [{
      actionId: 'ACTION-1', capabilityId: 'CAP-1', method: 'GET', url: target, maxUses: 1,
    }],
  })
  handles.push(gateway)

  await expect(gateway.requestThroughProxy(target, {
    actionId: 'ACTION-1', capabilityId: 'CAP-1',
  })).resolves.toMatchObject({ status: 200, body: 'allowed' })
  await expect(gateway.requestThroughProxy(`http://127.0.0.1:${address.port}/denied`, {
    actionId: 'ACTION-1', capabilityId: 'CAP-1',
  })).resolves.toMatchObject({ status: 403, body: 'E2E_GATEWAY_DEFAULT_DENY' })
  expect(seenHeaders).toEqual([undefined])
  expect(gateway.auditSummary()).toMatchObject({ received: 2, forwarded: 1, blocked: 1 })
  expect((await gateway.finalize()).signedCounters).toMatchObject({ forwarded: 1, blocked: 1, injected: 0 })
})

test('Gateway 在独立子进程运行，CA 只写入受限 Authority root', async () => {
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-CA', mode: 'real-environment', approvedRequests: [],
  })
  handles.push(gateway)
  expect(gateway.pid).not.toBe(process.pid)
  expect(gateway.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(gateway.caSpkiFingerprint).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  expect((await stat(gateway.caCertPath)).mode & 0o777).toBe(0o600)
  expect(await readFile(gateway.caCertPath, 'utf8')).toContain('BEGIN CERTIFICATE')
})
  },
)
