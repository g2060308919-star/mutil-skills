import { createServer } from 'node:http'
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { canBindLoopback, createRuntimeTestRoots, listenOnLoopback, startGatewayProxyHostForTest } from './fixtures.js'
import {
  authorizeRuntimeWriteProduction,
  createRuntimeWriteOwnedResourceLifecycle,
} from '../src/runtime-write-production.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { digestText } from '@mutil-skills/e2e-contracts'
import { startGatewayProxyHostWithTestControl } from '../src/gateway-proxy-host.js'

const handles: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  const closing = handles.splice(0).reverse().map(async (handle) => await handle.close())
  await Promise.allSettled(closing)
})

const loopbackAvailable = await canBindLoopback()
if (process.env.E2E_REQUIRED_TEST_CAPABILITIES?.split(',').includes('loopback') && !loopbackAvailable) {
  throw new Error('E2E_HOST_CAPABILITY_NOT_EXECUTED:loopback')
}

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

test('同一 Gateway 可分别证明 program 与 cleanup 两个受控浏览器生命周期', async () => {
  const roots = await createRuntimeTestRoots()
  const authorityRoot = join(roots.home, '.mutil-skills', 'e2e', 'authority')
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
  const started = await startGatewayProxyHostWithTestControl({
    runId: 'RUN-TWO-BROWSER-CANARIES', mode: 'real-environment', approvedRequests: [], authorityRoot,
  })
  handles.push(started.handle)
  const executeThroughControlledBrowser = async (request: {
    url: string
    correlation?: { actionId: string; capabilityId: string }
  }) => {
    const response = await started.requestThroughProxy(request.url, request.correlation ?? {
      actionId: 'UNAPPROVED-CANARY', capabilityId: 'UNAPPROVED-CANARY',
    })
    return { status: response.status }
  }
  for (const label of ['program', 'cleanup']) {
    await expect(started.browserBinding.runCanary({
      browserMeasurementDigest: digestText('gateway-two-browser-canary/v1', label),
      executeThroughControlledBrowser,
    })).resolves.toMatchObject({ approved: true, denied: true })
  }
})

test('生产 Gateway 在 spawn 前登记 marker descriptor，正常关闭后才完成 tombstone', async () => {
  const roots = await createRuntimeTestRoots()
  const marker = createRuntimeOwnedResourceMarker({
    runtimeInstallationDigest: digestText('gateway-owned-test/v1', 'runtime'),
    projectIdentityDigest: digestText('gateway-owned-test/v1', 'project'),
    runId: 'RUN-GATEWAY-OWNED', attemptId: 'ATTEMPT-1', ownerNonce: 'OWNER-1',
  })
  const gatewayOwnerRoot = join(roots.home, '.mutil-skills', 'e2e', 'state', marker.runId, 'gateway')
  await mkdir(gatewayOwnerRoot, { recursive: true, mode: 0o700 })
  const canonicalMarkerPath = join(await realpath(gatewayOwnerRoot),
    `session-${marker.markerDigest.slice(7, 31)}.owner.json`)
  let activeRecord: any
  const complete = vi.fn(async (input: any) => ({
    ...activeRecord, revision: 2, status: 'cleaned' as const,
    cleanupReceiptDigest: input.cleanupReceiptDigest,
  }))
  const register = vi.fn(async (record: any) => {
    expect(record.descriptor.markerPath).toBe(canonicalMarkerPath)
    await expect(access(canonicalMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    activeRecord = { ...record, revision: 1, status: 'active' as const }
    return activeRecord
  })
  const lifecycle = createRuntimeWriteOwnedResourceLifecycle(authorizeRuntimeWriteProduction({
    recovery: { recover: vi.fn() }, ownedResources: { register, complete }, prepareCleanup: vi.fn(),
  }), marker)
  const authorityRoot = join(roots.home, '.mutil-skills', 'e2e', 'authority')
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
  const started = await startGatewayProxyHostWithTestControl({
    runId: marker.runId, mode: 'real-environment', approvedRequests: [],
    authorityRoot,
    ownedResource: { markerPath: canonicalMarkerPath, lifecycle },
  })
  const gateway = started.handle
  expect(register).toHaveBeenCalledOnce()
  const active = JSON.parse(await readFile(canonicalMarkerPath, 'utf8'))
  expect(active).toMatchObject({
    phase: 'listening', pid: gateway.pid, endpoint: gateway.endpoint,
    ownerMarker: marker, descriptorDigest: expect.stringMatching(/^sha256:/),
  })
  await gateway.close()
  await expect(access(canonicalMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({
    expectedRevision: 1, ownerMarkerDigest: marker.markerDigest,
    cleanupReceiptDigest: expect.stringMatching(/^sha256:/),
  }))
})
  },
)
