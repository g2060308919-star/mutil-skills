import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { canBindLoopback, createRuntimeTestRoots, listenOnLoopback, startGatewayProxyHostForTest } from './fixtures.js'
import { assertInjectionProjection } from '../src/gateway-proxy-host.js'
import { signGatewayIpcEnvelope, verifyGatewayIpcEnvelope } from '../src/gateway-proxy-ipc.js'
import {
  assertGatewayModePolicy,
  projectGatewayRules,
  selectProjectedRuleForBrowser,
} from '../src/gateway-rule-projector.js'
import { GATEWAY_MAX_REQUEST_BODY_BYTES, projectedBodyMatches } from '../src/gateway-request-body-policy.js'
import {
  digestInjectionResponseBody,
  digestText,
  type CapabilityReservation,
  type SignedInjectionGrant,
  type SignedSseReadGrant,
  type SignedWebSocketReadGrant,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import { InjectionGateway, ProtocolGuard, ReversibleWriteGateway, digestJsonHttpPayload } from '@mutil-skills/e2e-gateway'
import { generateCACertificate } from 'mockttp'

const handles: Array<{ close(): Promise<void> }> = []
const loopbackAvailable = await canBindLoopback()
afterEach(async () => { await Promise.allSettled(handles.splice(0).reverse().map(async (item) => await item.close())) })

test('Gateway IPC 拒绝错误 MAC、乱序和重放 envelope', () => {
  const key = randomBytes(32)
  try {
    const envelope = signGatewayIpcEnvelope({
      schemaVersion: '1.0.0', direction: 'child-request', requestId: 'REQ-1', sequence: 1,
      operation: 'authorize', payload: { ruleId: 'RULE-1' },
    }, key)
    expect(verifyGatewayIpcEnvelope(envelope, key, { direction: 'child-request', sequence: 1 })).toEqual(envelope)
    expect(() => verifyGatewayIpcEnvelope(envelope, key, { direction: 'child-request', sequence: 2 }))
      .toThrowError(/E2E_GATEWAY_IPC_INVALID/)
    const tamperedMac = `${envelope.mac[0] === 'A' ? 'B' : 'A'}${envelope.mac.slice(1)}`
    expect(() => verifyGatewayIpcEnvelope({ ...envelope, mac: tamperedMac }, key, {
      direction: 'child-request', sequence: 1,
    })).toThrowError(/E2E_GATEWAY_IPC_INVALID/)
  } finally { key.fill(0) }
})

test('规则投影绑定完整 URL/body 且 digest 不含随机动作 token', () => {
  const input = {
    runId: 'RUN-PROJECTION',
    approvedRequests: [{
      actionId: 'ACTION-1', capabilityId: 'CAP-1', method: 'POST',
      url: 'https://example.test/api?q=1', maxUses: 1,
      bodyBase64Url: Buffer.from('{"ok":true}').toString('base64url'),
    }],
  }
  const first = projectGatewayRules(input)
  const second = projectGatewayRules(input)
  expect(first.policyDigest).toBe(second.policyDigest)
  expect(first.rules[0]!.actionToken).not.toBe(second.rules[0]!.actionToken)
  expect(first.rules[0]).toMatchObject({ method: 'POST', url: 'https://example.test/api?q=1' })
  expect(() => projectGatewayRules({ ...input, approvedRequests: [{
    ...input.approvedRequests[0]!, url: 'https://user:pass@example.test/api',
  }] })).toThrowError(/E2E_GATEWAY_URL_INVALID/)
})

test('规则投影拒绝真重复与 correlation 冲突，但允许同 URL 的有序不同 body', () => {
  const base = {
    actionId: 'ACTION-MULTI', capabilityId: 'CAP-MULTI', method: 'POST',
    url: 'https://example.test/write', maxUses: 1,
  }
  const firstBody = Buffer.from('{"step":1}').toString('base64url')
  const secondBody = Buffer.from('{"step":2}').toString('base64url')
  expect(() => projectGatewayRules({ runId: 'RUN-DUP', approvedRequests: [base, base] }))
    .toThrowError(/E2E_GATEWAY_POLICY_DUPLICATE/)
  expect(() => projectGatewayRules({ runId: 'RUN-CONFLICT', approvedRequests: [
    base, { ...base, behavior: { kind: 'timeout' as const } },
  ] })).toThrowError(/E2E_GATEWAY_POLICY_CORRELATION_CONFLICT/)

  const projected = projectGatewayRules({ runId: 'RUN-MULTI', approvedRequests: [
    { ...base, bodyBase64Url: firstBody }, { ...base, bodyBase64Url: secondBody },
  ] })
  expect(projected.rules).toHaveLength(2)
  for (const rule of projected.rules) {
    expect(selectProjectedRuleForBrowser(projected.rules, {
      ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal, actionId: rule.actionId,
      capabilityId: rule.capabilityId, method: rule.method, url: rule.url,
      channel: rule.channel, bodyDigest: rule.bodyDigest,
    })).toBe(rule)
  }
  const second = projected.rules[1]!
  expect(() => selectProjectedRuleForBrowser(projected.rules, {
    ruleId: second.ruleId, stepOrdinal: second.stepOrdinal, actionId: second.actionId,
    capabilityId: second.capabilityId, method: second.method, url: second.url,
    channel: second.channel, bodyDigest: projected.rules[0]!.bodyDigest,
  })).toThrowError(/E2E_GATEWAY_BROWSER_CORRELATION_DENIED/)
})

test('real/injection session policy 互斥，injection 禁止任何 pass-through', () => {
  const pass = projectGatewayRules({ runId: 'RUN-MODE-PASS', approvedRequests: [{
    actionId: 'ACTION-PASS', capabilityId: 'CAP-PASS', method: 'GET',
    url: 'https://example.test/read', maxUses: 1,
  }] }).rules
  const inject = projectGatewayRules({ runId: 'RUN-MODE-INJECT', approvedRequests: [{
    actionId: 'ACTION-INJECT', capabilityId: 'CAP-INJECT', method: 'GET',
    url: 'https://example.test/read', maxUses: 1,
    behavior: { kind: 'http-response', status: 503 },
  }] }).rules
  expect(() => assertGatewayModePolicy('injection', pass)).toThrowError(/E2E_GATEWAY_MODE_POLICY_INVALID/)
  expect(() => assertGatewayModePolicy('real-environment', inject)).toThrowError(/E2E_GATEWAY_MODE_POLICY_INVALID/)
  expect(() => assertGatewayModePolicy('real-environment', pass)).not.toThrow()
  expect(() => assertGatewayModePolicy('injection', inject)).not.toThrow()
})

test('injection projected rule 在 Authority reserve/complete 前绑定签名 capability request/response', () => {
  const target = 'https://secure.example.test/api/injected'
  const payload = '{"query":"one"}'
  const gateway = createInjectionGateway(target, payload, '{"error":"injected"}')
  const approved = {
    actionId: 'ACTION-INJECT', capabilityId: 'CAP-INJECT', method: 'POST', url: target, maxUses: 1,
    bodyBase64Url: Buffer.from(payload).toString('base64url'), contentType: 'application/json',
    behavior: {
      kind: 'http-response' as const, status: 503,
      headers: { 'content-type': 'application/json' }, body: '{"error":"injected"}',
    },
  }
  const rules = projectGatewayRules({ runId: 'RUN-HTTPS', approvedRequests: [approved] }).rules
  expect(() => assertInjectionProjection(gateway, rules)).not.toThrow()
  const mismatch = projectGatewayRules({ runId: 'RUN-HTTPS', approvedRequests: [{
    ...approved, behavior: { ...approved.behavior, status: 429 },
  }] }).rules
  expect(() => assertInjectionProjection(gateway, mismatch))
    .toThrowError(/E2E_GATEWAY_INJECTION_PROJECTION_MISMATCH/)
  expect(gateway.getCompletedReservations()).toEqual([])
})

test('body policy 在 token 匹配前拒绝超限 Content-Length 与无长度 chunked body', () => {
  const oversized = Buffer.alloc(GATEWAY_MAX_REQUEST_BODY_BYTES + 1)
  const small = Buffer.from('payload')
  try {
    expect(projectedBodyMatches({
      headers: { 'content-length': String(oversized.byteLength) }, actualBody: Buffer.alloc(0),
    })).toBe(false)
    expect(projectedBodyMatches({
      headers: { 'transfer-encoding': 'chunked' }, actualBody: small,
    })).toBe(false)
    expect(projectedBodyMatches({ headers: {}, actualBody: small })).toBe(false)
  } finally { oversized.fill(0); small.fill(0) }
})

test.each(['partial', 'symlink'] as const)('CA generation 对 %s state fail closed', async (variant) => {
  const roots = await createRuntimeTestRoots()
  const authorityRoot = join(roots.home, '.mutil-skills', 'e2e', 'authority')
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
  const generation = join(authorityRoot, 'gateway-ca')
  if (variant === 'partial') {
    await mkdir(generation, { mode: 0o700 })
    await writeFile(join(generation, 'key.pem'), 'partial', { mode: 0o600 })
  } else {
    const outside = join(roots.root, 'outside-ca')
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, generation)
  }
  await expect(startGatewayProxyHostForTest({
    runId: `RUN-CA-${variant}`, mode: 'real-environment', approvedRequests: [], authorityRoot,
  })).rejects.toMatchObject({ code: 'E2E_GATEWAY_CA_STATE_INVALID' })
})

describe.skipIf(!loopbackAvailable)(
  '真实 loopback transport（默认 sandbox 不可用时跳过，不计为功能通过）',
  () => {

test('动作 token、完整 URL 与 maxUses 共同约束转发，页面直连语义流量不能复用授权', async () => {
  let reached = 0
  const upstream = createServer((_request, response) => { reached += 1; response.end('ok') })
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `http://127.0.0.1:${address.port}/once`
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-SEC', mode: 'real-environment',
    approvedRequests: [{ actionId: 'ACTION-1', capabilityId: 'CAP-1', method: 'GET', url: target, maxUses: 1 }],
  })
  handles.push(gateway)

  expect((await gateway.requestThroughProxy(target, { actionId: 'ACTION-1', capabilityId: 'CAP-1' })).status).toBe(200)
  expect((await gateway.requestThroughProxy(target, { actionId: 'ACTION-1', capabilityId: 'CAP-1' })).status).toBe(403)
  expect((await gateway.requestThroughProxy(target, {
    actionId: 'ACTION-1', capabilityId: 'CAP-1', channel: 'service-worker',
  })).status).toBe(403)
  expect(reached).toBe(1)
})

test('畸形或重复动作 token fail closed 且不消耗合法 maxUses', async () => {
  let reached = 0
  const upstream = createServer((_request, response) => { reached += 1; response.end('ok') })
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `http://127.0.0.1:${address.port}/token`
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-TOKEN', mode: 'real-environment',
    approvedRequests: [{ actionId: 'ACTION-TOKEN', capabilityId: 'CAP-TOKEN', method: 'GET', url: target, maxUses: 1 }],
  })
  handles.push(gateway)
  const correlation = { actionId: 'ACTION-TOKEN', capabilityId: 'CAP-TOKEN' }
  expect((await gateway.requestWithTokenHeaders(target, correlation, ['malformed'])).status).toBe(403)
  expect((await gateway.requestWithTokenHeaders(target, correlation, ['$VALID', 'duplicate'])).status).toBe(403)
  expect(reached).toBe(0)
  expect((await gateway.requestThroughProxy(target, correlation)).status).toBe(200)
  expect(reached).toBe(1)
})

test('重定向二跳与 Beacon 都重新执行完整 URL policy', async () => {
  const upstream = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.statusCode = 302
      response.setHeader('location', '/second-hop')
      response.end()
      return
    }
    response.end(request.url === '/beacon' ? 'beacon' : 'unexpected')
  })
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const base = `http://127.0.0.1:${address.port}`
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-REDIRECT', mode: 'real-environment', approvedRequests: [
      { actionId: 'ACTION-REDIRECT', capabilityId: 'CAP-REDIRECT', method: 'GET', url: `${base}/redirect`, maxUses: 1 },
      { actionId: 'ACTION-BEACON', capabilityId: 'CAP-BEACON', method: 'GET', url: `${base}/beacon`, maxUses: 1, channel: 'beacon' },
    ],
  })
  handles.push(gateway)
  expect((await gateway.requestThroughProxy(`${base}/redirect`, {
    actionId: 'ACTION-REDIRECT', capabilityId: 'CAP-REDIRECT',
  })).status).toBe(302)
  expect((await gateway.requestThroughProxy(`${base}/second-hop`, {
    actionId: 'ACTION-REDIRECT', capabilityId: 'CAP-REDIRECT',
  })).status).toBe(403)
  expect((await gateway.requestThroughProxy(`${base}/beacon`, {
    actionId: 'ACTION-BEACON', capabilityId: 'CAP-BEACON', channel: 'beacon',
  })).body).toBe('beacon')
})

test('HTTPS 注入由 InjectionGateway 决策并由本次 CA/SPKI 解密，不接触上游', async () => {
  const target = 'https://secure.example.test/api/injected'
  const payload = '{"query":"one"}'
  const responseBody = '{"error":"injected"}'
  const injectionGateway = createInjectionGateway(target, payload, responseBody)
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-HTTPS', mode: 'injection',
    approvedRequests: [{
      actionId: 'ACTION-INJECT', capabilityId: 'CAP-INJECT', method: 'POST', url: target, maxUses: 1,
      bodyBase64Url: Buffer.from(payload).toString('base64url'),
      contentType: 'application/json',
      behavior: {
        kind: 'http-response', status: 503, headers: { 'content-type': 'application/json' }, body: responseBody,
      },
    }],
    policyObjects: { injectionGateway },
  })
  handles.push(gateway)
  const wrong = await generateCACertificate({ subject: { commonName: 'wrong local CA' } })
  const roots = await createRuntimeTestRoots()
  const wrongCaPath = join(roots.root, 'wrong-ca.pem')
  await writeFile(wrongCaPath, wrong.cert, { mode: 0o600 })
  wrong.key = ''
  wrong.cert = ''
  await expect(gateway.requestThroughProxy(target, {
    actionId: 'ACTION-INJECT', capabilityId: 'CAP-INJECT',
  }, wrongCaPath)).rejects.toBeDefined()
  await expect(gateway.requestThroughProxy(target, {
    actionId: 'ACTION-INJECT', capabilityId: 'CAP-INJECT',
  })).resolves.toMatchObject({ status: 503, body: responseBody })
  expect(gateway.auditSummary()).toMatchObject({ injected: 1, forwarded: 0, blocked: 0 })
  expect((await gateway.finalize()).capabilityReservations).toEqual([
    expect.objectContaining({
      capabilityId: 'CAP-INJECT', actionId: 'ACTION-INJECT', status: 'completed', consumed: true,
    }),
  ])
})

test('无转发前 frame bridge 时真实 WebSocket 即使命中 capability 也拒绝且不接触上游', async () => {
  let proxyAuthorization: string | undefined
  const upstream = createServer()
  upstream.on('upgrade', (request, socket) => {
    proxyAuthorization = request.headers['proxy-authorization'] as string | undefined
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', '',
    ].join('\r\n'))
  })
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `ws://127.0.0.1:${address.port}/events`
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-WS', mode: 'real-environment',
    approvedRequests: [{
      actionId: 'ACTION-WS', capabilityId: 'CAP-WS', method: 'GET', url: target,
      maxUses: 1, channel: 'websocket',
    }],
    policyObjects: { protocolGuard: createWebSocketProtocolGuard(target) },
  })
  handles.push(gateway)
  expect((await gateway.openWebSocketThroughProxy(target, {
    actionId: 'ACTION-WS', capabilityId: 'CAP-WS',
  })).status).toBe(501)
  expect(proxyAuthorization).toBeUndefined()
  expect((await gateway.openWebSocketThroughProxy(target, {
    actionId: 'ACTION-WS', capabilityId: 'CAP-WS',
  })).status).toBe(403)
})

test('并发写入只放行一次，响应仅记录 transport observation，cleanup 后才完成 signed outcome', async () => {
  let reached = 0
  const upstream = createServer((_request, response) => {
    reached += 1
    setTimeout(() => response.end('written'), 25)
  })
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `http://127.0.0.1:${address.port}/write`
  const authority = createWriteAuthority()
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-WRITE', mode: 'real-environment',
    approvedRequests: [{ actionId: 'ACTION-WRITE', capabilityId: 'CAP-WRITE', method: 'POST', url: target, maxUses: 1 }],
    policyObjects: {
      factory: ({ signer, recorder }) => ({
        writeGateways: { 'CAP-WRITE': createWriteGateway(target, authority, signer, recorder, 'RUN-WRITE') },
      }),
    },
  })
  handles.push(gateway)
  const statuses = await Promise.all([1, 2].map(async () => (await gateway.requestThroughProxy(target, {
    actionId: 'ACTION-WRITE', capabilityId: 'CAP-WRITE',
  })).status))
  expect(statuses.sort()).toEqual([200, 403])
  expect(reached).toBe(1)
  expect(authority.reserved).toBe(1)
  expect(authority.completed).toBe(0)
  await gateway.finalizeWriteOutcome('CAP-WRITE', {
    status: 'passed', effectObservation: 'applied', runnerResultDigest: digestText('test/v1', 'runner'),
    cleanupPlanId: 'CLEANUP-1', cleanup: {
      status: 'verified-clean', resultDigest: digestText('test/v1', 'cleanup'),
      leaseReceiptDigest: digestText('test/v1', 'lease'),
    },
    evidenceIds: ['EVIDENCE-1'], completedAt: '2026-07-17T00:01:00.000Z',
  })
  expect(authority.completed).toBe(1)
  expect(authority.unknown).toBe(0)
})

test('上游连接结果未知与 child close 都将未完成 reservation 标 unknown', async () => {
  const upstream = createServer((request) => request.socket.destroy())
  await listenOnLoopback(upstream)
  handles.push({ close: async () => await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve())
  }) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const target = `http://127.0.0.1:${address.port}/unknown`
  const authority = createWriteAuthority()
  const gateway = await startGatewayProxyHostForTest({
    runId: 'RUN-UNKNOWN', mode: 'real-environment',
    approvedRequests: [{ actionId: 'ACTION-WRITE', capabilityId: 'CAP-WRITE', method: 'POST', url: target, maxUses: 1 }],
    policyObjects: {
      factory: ({ signer, recorder }) => ({
        writeGateways: { 'CAP-WRITE': createWriteGateway(target, authority, signer, recorder, 'RUN-UNKNOWN') },
      }),
    },
  })
  await expect(gateway.requestThroughProxy(target, {
    actionId: 'ACTION-WRITE', capabilityId: 'CAP-WRITE',
  })).resolves.toMatchObject({ status: 502 })
  await waitUntil(() => authority.unknown === 1)
  await gateway.close()
  expect(authority.unknown).toBe(1)
})
  },
)

test.each(['quic', 'udp', 'file', 'custom-scheme', 'unknown'] as const)(
  'ProtocolGuard 默认拒绝 %s 通道',
  (channel) => {
    expect(ProtocolGuard.denyForbiddenChannelForHost(channel, 'TEST-CORRELATION')).toMatchObject({
      decision: 'block', code: 'E2E_GATEWAY_PROTOCOL_FORBIDDEN',
    })
  },
)

function createInjectionGateway(target: string, payloadText: string, responseBody: string): InjectionGateway {
  const url = new URL(target)
  const response = {
    kind: 'http-response' as const,
    status: 503,
    headers: [{ name: 'content-type' as const, value: 'application/json' }],
    body: { kind: 'utf8' as const, value: responseBody, digest: digestInjectionResponseBody(responseBody) },
    delayMs: 0,
  }
  const capability = {
    capabilityId: 'CAP-INJECT', nonce: 'nonce', transport: 'gateway-injection' as const,
    actionId: 'ACTION-INJECT', caseId: 'CASE-INJECT', runId: 'RUN-HTTPS', attemptSlot: 1,
    request: {
      intentId: 'INTENT-INJECT', method: 'POST', canonicalOrigin: url.origin,
      exactPath: url.pathname, query: [] as Array<[string, string]>,
      payload: { kind: 'json' as const, digest: digestJsonHttpPayload(JSON.parse(payloadText)) },
      targetFingerprint: 'not-applicable', maxRequests: 1, expectedOrder: 1,
    },
    response, expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden' as const, maxUses: 1,
  }
  const digest = digestText('test/v1', 'injection-subject')
  const grant: SignedInjectionGrant = {
    grantId: 'GRANT-INJECT', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: digest,
      executionDigest: digest, environment: 'test', baseOrigin: url.origin, actions: [],
    },
    subjectDigest: digest,
    approvalContext: {
      schemaVersion: '1.0.0', subject: 'os-user:qa', runId: 'RUN-HTTPS', approvalType: 'execution',
      subjectDigest: digest, installationDigest: digest, origin: 'http://127.0.0.1:43210',
      issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:10:00.000Z',
    },
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:10:00.000Z',
    capabilities: [capability], revocationSequence: 0, signature: 'signature',
  }
  let reservation = 0
  const authority = {
    verify: async () => ({ allowed: true as const }),
    reserveForSubject: async (input: { grant: SignedInjectionGrant; capabilityId: string; actionId: string; attemptId: string }): Promise<CapabilityReservation> => ({
      reservationId: `RES-${++reservation}`, grantId: input.grant.grantId,
      capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
      status: 'reserved', reservedAt: '2026-07-17T00:00:00.000Z',
    }),
    complete: async () => undefined,
    markUnknown: async () => undefined,
  }
  return new InjectionGateway({
    stage: 'case', grant, attemptId: 'ATTEMPT-1', authority,
    bootstrapIntents: [], caseReadIntents: [],
  })
}

function createWebSocketProtocolGuard(target: string): ProtocolGuard {
  const url = new URL(target)
  const digest = digestText('test/v1', 'ws-subject')
  const context = {
    schemaVersion: '1.0.0' as const, subject: 'os-user:qa', runId: 'RUN-WS', approvalType: 'execution' as const,
    subjectDigest: digest, installationDigest: digest, origin: 'http://127.0.0.1:43210',
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:10:00.000Z',
  }
  const websocket: SignedWebSocketReadGrant = {
    grantId: 'GRANT-WS', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: digest, executionDigest: digest,
      environment: 'test', baseOrigin: 'http://127.0.0.1', actions: [],
    },
    subjectDigest: digest, approvalContext: context,
    issuedAt: context.issuedAt, expiresAt: context.expiresAt,
    capabilities: [{
      capabilityId: 'CAP-WS', nonce: 'nonce', transport: 'websocket', effect: 'read',
      actionId: 'ACTION-WS', origin: url.origin, path: url.pathname,
      maxInboundMessages: 2, maxBytes: 1024, maxUses: 1,
    }],
    revocationSequence: 0, signature: 'signature',
  }
  const sse: SignedSseReadGrant = {
    grantId: 'GRANT-SSE', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: digest, executionDigest: digest,
      environment: 'test', baseOrigin: 'http://127.0.0.1', actions: [],
    },
    subjectDigest: digest, approvalContext: context,
    issuedAt: context.issuedAt, expiresAt: context.expiresAt,
    capabilities: [{
      capabilityId: 'CAP-SSE', nonce: 'nonce', transport: 'sse', effect: 'read',
      actionId: 'ACTION-SSE', origin: 'http://127.0.0.1', exactPath: '/sse', query: [],
      maxReconnects: 1, maxUses: 1,
    }],
    revocationSequence: 0, signature: 'signature',
  }
  let reservation = 0
  const authority = {
    verify: async () => ({ allowed: true as const }),
    reserveForSubject: async (input: { grant: { grantId: string }; capabilityId: string; actionId: string; attemptId: string }): Promise<CapabilityReservation> => ({
      reservationId: `RES-WS-${++reservation}`, grantId: input.grant.grantId,
      capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
      status: 'reserved', reservedAt: '2026-07-17T00:00:00.000Z',
    }),
    complete: async () => undefined,
  }
  return new ProtocolGuard({
    downstream: { decide: async () => ({ decision: 'block' as const, code: 'E2E_GATEWAY_DENIED', reason: 'denied' }) },
    sse: { grant: sse, capabilityId: 'CAP-SSE', authority },
    allowedIframeOrigins: [],
    websocket: { grant: websocket, capabilityId: 'CAP-WS', authority },
  })
}

function createWriteAuthority() {
  return {
    reserved: 0,
    completed: 0,
    unknown: 0,
    verifyForSubject: async () => ({ allowed: true as const }),
    reserveForSubject: async function (input: {
      grant: SignedWriteGrant; capabilityId: string; actionId: string; attemptId: string
    }): Promise<CapabilityReservation> {
      this.reserved += 1
      return {
        reservationId: 'RES-WRITE', grantId: input.grant.grantId, capabilityId: input.capabilityId,
        actionId: input.actionId, attemptId: input.attemptId, status: 'reserved',
        reservedAt: '2026-07-17T00:00:00.000Z',
        attemptContext: {
          assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digestText('test/v1', 'prd'),
          runId: input.grant.approvalContext.runId, caseId: 'CASE-1',
        },
      }
    },
    complete: async function () {
      this.completed += 1
      return digestText('test-authority-terminal/v1', 'completed')
    },
    markUnknown: async function () {
      this.unknown += 1
      return digestText('test-authority-terminal/v1', 'unknown')
    },
  }
}

function createWriteGateway(
  target: string,
  authority: ReturnType<typeof createWriteAuthority>,
  signer: import('@mutil-skills/e2e-gateway').LocalGatewayAuditSigner,
  recorder: import('@mutil-skills/e2e-gateway').TrustedGatewayPublicationAuditRecorder,
  runId: string,
): ReversibleWriteGateway {
  const url = new URL(target)
  const digest = digestText('test/v1', 'write-subject')
  const attemptContext = {
    assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digestText('test/v1', 'prd'),
    runId, caseId: 'CASE-1',
  }
  const capability = {
    capabilityId: 'CAP-WRITE', nonce: 'nonce', transport: 'http' as const,
    effect: 'reversible-write' as const, operation: 'http-request' as const, actionId: 'ACTION-WRITE',
    dataLeaseId: 'LEASE-1', fencingToken: 1, cleanupPlanDigest: digestText('test/v1', 'cleanup-plan'),
    requests: [{
      intentId: 'INTENT-WRITE', method: 'POST', canonicalOrigin: url.origin, exactPath: url.pathname,
      query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const },
      targetFingerprint: digestText('test/v1', 'target-1'), maxRequests: 1, expectedOrder: 1,
    }],
    maxUses: 1 as const,
  }
  const grant: SignedWriteGrant = {
    grantId: 'GRANT-WRITE', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '2.0.0', assetId: 'ASSET-1', prdRevision: digestText('test/v1', 'prd'),
      executionDigest: digest, environment: 'test', baseOrigin: url.origin,
      actions: [{
        actionId: capability.actionId, effect: 'reversible-write', dataLeaseId: capability.dataLeaseId,
        fencingToken: capability.fencingToken, cleanupPlanDigest: capability.cleanupPlanDigest,
        requests: capability.requests,
      }],
    },
    subjectDigest: digest,
    approvalContext: {
      schemaVersion: '1.0.0', subject: 'os-user:qa', runId: attemptContext.runId, approvalType: 'execution',
      subjectDigest: digest, installationDigest: digest, origin: 'http://127.0.0.1:43210',
      issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:10:00.000Z',
    },
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:10:00.000Z',
    capabilities: [capability], revocationSequence: 0, signature: 'signature',
  }
  return new ReversibleWriteGateway({
    grant, currentSubject: grant.subject, capability, attemptId: 'ATTEMPT-1', attemptContext,
    authority,
    leaseAuthority: { verifyTarget: async () => true }, recorder, outcomeSigner: signer,
  })
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
