import { getLocal, type CompletedRequest, type Mockttp } from 'mockttp'
import { Server as NetServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { ProjectedGatewayRule } from './gateway-rule-projector.js'
import {
  signGatewayIpcEnvelope,
  verifyGatewayIpcEnvelope,
  type GatewayIpcEnvelope,
} from './gateway-proxy-ipc.js'
import {
  sseUnsupportedDisposition,
  websocketUnsupportedDisposition,
} from './gateway-websocket-transport.js'
import { GATEWAY_MAX_REQUEST_BODY_BYTES, projectedBodyMatches } from './gateway-request-body-policy.js'

interface ChildConfig {
  caKeyPath: string
  caCertPath: string
  rules: ProjectedGatewayRule[]
}

let sessionKey: Buffer | undefined
let proxy: Mockttp | undefined
let parentSequence = 0
let childSequence = 0
let closed = false
let accepting = true
const inFlightRequests = new Set<string>()
const pending = new Map<string, {
  sequence: number
  operation: string
  resolve(value: unknown): void
  reject(error: Error): void
}>()
const remainingUses = new Map<string, number>()

void readBootstrapKey().then((key) => {
  sessionKey = key
  process.on('message', onMessage)
  process.once('disconnect', () => { void shutdown('E2E_GATEWAY_PARENT_DISCONNECTED') })
  process.once('SIGTERM', () => { void shutdown('E2E_GATEWAY_SIGTERM').finally(() => process.exit(process.exitCode ?? 0)) })
}).catch(() => { process.exitCode = 1 })

async function onMessage(value: unknown): Promise<void> {
  if (!sessionKey || closed) return
  try {
    if (isPotentialResponse(value)) {
      const envelope = verifyGatewayIpcEnvelope(value, sessionKey, { direction: 'parent-response' })
      const waiter = pending.get(envelope.requestId)
      if (!waiter || waiter.sequence !== envelope.sequence || waiter.sequence > childSequence) return
      pending.delete(envelope.requestId)
      const response = parseIpcResponsePayload(envelope.payload)
      if (!response.ok) waiter.reject(gatewayChildError(response.code))
      else waiter.resolve(parseParentOperationResult(waiter.operation, response.result))
      return
    }
    const request = verifyGatewayIpcEnvelope(value, sessionKey, {
      direction: 'parent-request', sequence: parentSequence + 1,
    })
    parentSequence = request.sequence
    try {
      const result = await handleParentRequest(request.operation, request.payload)
      send(signGatewayIpcEnvelope({
        schemaVersion: '1.0.0', direction: 'child-response', requestId: request.requestId,
        sequence: request.sequence, operation: request.operation, payload: { ok: true, result },
      }, sessionKey))
      if (request.operation === 'shutdown') setImmediate(() => { void shutdown('E2E_GATEWAY_SHUTDOWN') })
    } catch (error) {
      send(signGatewayIpcEnvelope({
        schemaVersion: '1.0.0', direction: 'child-response', requestId: request.requestId,
        sequence: request.sequence, operation: request.operation,
        payload: { ok: false, code: safeCode(error) },
      }, sessionKey))
    }
  } catch {
    process.exitCode = 1
    await shutdown('E2E_GATEWAY_IPC_INVALID')
  }
}

async function handleParentRequest(operation: string, payload: unknown): Promise<unknown> {
  if (operation === 'start') {
    if (proxy) throw gatewayChildError('E2E_GATEWAY_ALREADY_STARTED')
    const config = parseChildConfig(payload)
    proxy = getLocal({
      https: { keyPath: config.caKeyPath, certPath: config.caCertPath },
      cors: false, http2: false, socks: false, passthrough: [], suggestChanges: false,
      maxBodySize: GATEWAY_MAX_REQUEST_BODY_BYTES, recordTraffic: false,
    })
    await startOnLoopback(proxy)
    await registerRules(proxy, config.rules)
    return { endpoint: `http://127.0.0.1:${proxy.port}` }
  }
  if (operation === 'freeze') {
    if (payload !== null) throw gatewayChildError('E2E_GATEWAY_IPC_PAYLOAD_INVALID')
    accepting = false
    const current = proxy
    if (current) {
      await waitForDrain()
      proxy = undefined
      await current.stop()
    }
    return { frozen: true }
  }
  if (operation === 'shutdown') {
    if (payload !== null) throw gatewayChildError('E2E_GATEWAY_IPC_PAYLOAD_INVALID')
    const current = proxy
    proxy = undefined
    await current?.stop()
    return { closed: true }
  }
  throw gatewayChildError('E2E_GATEWAY_IPC_OPERATION_UNKNOWN')
}

async function registerRules(server: Mockttp, rules: ProjectedGatewayRule[]): Promise<void> {
  await server.on('response', (response) => { inFlightRequests.delete(response.id) })
  await server.on('abort', (request) => { inFlightRequests.delete(request.id) })
  await server.on<{ downstreamAborted?: boolean }>('rule-event', (event) => {
    if (event.eventType !== 'passthrough-abort') return
    inFlightRequests.delete(event.requestId)
    void callParent('transport-unknown', {
      requestId: event.requestId,
      observation: event.eventData.downstreamAborted === true
        ? 'gateway-downstream-aborted-during-write'
        : 'gateway-upstream-transport-unknown',
    }).catch(() => { void shutdown('E2E_GATEWAY_PARENT_DISCONNECTED') })
  })
  for (const rule of rules) {
    remainingUses.set(rule.ruleId, rule.maxUses)
    if (rule.channel === 'websocket') {
      const builder = server.forAnyWebSocket().matching(async (request) => await ruleMatches(request, rule))
        .times(rule.maxUses)
      // Mockttp 只能在 frame 已转发后发出观察事件；pass-through 与 injection behavior
      // 全部统一 fail closed，避免任何未经过逐帧/Injection policy 的 WebSocket 行为。
      const disposition = websocketUnsupportedDisposition(rule.behavior.kind)
      await builder.thenRejectConnection(disposition.status, disposition.code)
      continue
    }
    const builder = server.forAnyRequest()
      .matching(async (request) => await ruleMatches(request, rule))
      .times(rule.maxUses)
    if (rule.behavior.kind === 'pass-through') {
      await builder.thenPassThrough({
        transformRequest: { updateHeaders: strippedHeaders() },
        beforeResponse: async (response, request) => {
          await callParent('transport-complete', {
            ruleId: rule.ruleId, requestId: request.id, status: response.statusCode,
          })
        },
      })
    } else if (rule.behavior.kind === 'http-response') {
      if (rule.behavior.delayMs) builder.delay(rule.behavior.delayMs)
      await builder.thenReply(rule.behavior.status, rule.behavior.body ?? '', rule.behavior.headers)
    } else if (rule.behavior.kind === 'connection-reset') await builder.thenResetConnection()
    else await builder.thenTimeout()
  }
  await server.forAnyRequest().matching(async (request) => {
    if (!accepting || !isSseRequest(request)) return false
    inFlightRequests.add(request.id)
    await callParent('default-deny', snapshotRequest(request))
    return true
  }).thenCallback(() => {
    const disposition = sseUnsupportedDisposition()
    return {
      statusCode: disposition.status,
      body: disposition.code,
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    }
  })
  await server.forUnmatchedRequest().thenCallback(async (request) => {
    if (!accepting) return { statusCode: 503, body: 'E2E_GATEWAY_FROZEN' }
    inFlightRequests.add(request.id)
    await callParent('default-deny', snapshotRequest(request))
    return { statusCode: 403, body: 'E2E_GATEWAY_DEFAULT_DENY', headers: { 'content-type': 'text/plain' } }
  })
  await server.forAnyWebSocket().matching(async (request) => {
    if (!accepting) return true
    inFlightRequests.add(request.id)
    await callParent('default-deny', snapshotRequest(request))
    return true
  }).thenRejectConnection(403, 'E2E_GATEWAY_DEFAULT_DENY')
  await server.on('abort', (request) => {
    void callParent('transport-unknown', {
      requestId: request.id, observation: 'proxy-request-aborted',
    }).catch(() => { void shutdown('E2E_GATEWAY_PARENT_DISCONNECTED') })
  })
}

async function ruleMatches(request: CompletedRequest, rule: ProjectedGatewayRule): Promise<boolean> {
  if (!accepting) return false
  inFlightRequests.add(request.id)
  if (rule.channel !== 'websocket' && isSseRequest(request)) return false
  const token = request.headers['x-mutil-e2e-action-token']
  const actionId = request.headers['x-mutil-e2e-action-id']
  const capabilityId = request.headers['x-mutil-e2e-capability-id']
  const contentType = singleHeader(request.headers['content-type'])
  const expectedToken = rule.actionToken
  const observedUrl = rule.channel === 'websocket'
    ? normalizeWebSocketProxyUrl(request.url, rule.url)
    : request.url
  if (typeof token !== 'string' || token !== expectedToken || actionId !== rule.actionId
    || capabilityId !== rule.capabilityId || request.method.toUpperCase() !== rule.method
    || observedUrl !== rule.url || !projectedBodyMatches({
      headers: request.headers,
      ...(rule.bodyBase64Url === undefined
        ? { expectedBodyDigest: rule.bodyDigest }
        : { expectedBodyBase64Url: rule.bodyBase64Url }),
      actualBody: request.body.buffer,
    }) || Object.entries(rule.requestHeaders).some(([name, value]) => singleHeader(request.headers[name]) !== value)) return false
  const available = remainingUses.get(rule.ruleId) ?? 0
  if (available < 1) return false
  // 在首个 await 之前同步 claim，避免并发 matcher 同时穿透 maxUses。
  remainingUses.set(rule.ruleId, available - 1)
  const result = await callParent('authorize', {
    ruleId: rule.ruleId,
    requestId: request.id,
    channel: rule.channel,
    method: request.method,
    url: observedUrl,
    bodyBase64Url: request.body.buffer.toString('base64url'),
    ...(contentType === undefined ? {} : { contentType }),
  })
  return isRecord(result) && result.allowed === true
}

function normalizeWebSocketProxyUrl(observed: string, approved: string): string {
  try {
    const candidate = new URL(observed)
    const expected = new URL(approved)
    if (expected.protocol === 'ws:' && candidate.protocol === 'http:') candidate.protocol = 'ws:'
    else if (expected.protocol === 'wss:' && candidate.protocol === 'https:') candidate.protocol = 'wss:'
    return candidate.href
  } catch {
    return observed
  }
}

function isSseRequest(request: Pick<CompletedRequest, 'headers' | 'method'>): boolean {
  const accept = singleHeader(request.headers.accept)
  return request.method.toUpperCase() === 'GET'
    && accept !== undefined
    && accept.split(',').some((part) => part.trim().split(';', 1)[0]?.toLowerCase() === 'text/event-stream')
}

async function waitForDrain(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (inFlightRequests.size > 0) {
    if (Date.now() >= deadline) throw gatewayChildError('E2E_GATEWAY_DRAIN_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function snapshotRequest(request: CompletedRequest): Record<string, unknown> {
  const actionId = singleHeader(request.headers['x-mutil-e2e-action-id'])
  const capabilityId = singleHeader(request.headers['x-mutil-e2e-capability-id'])
  return {
    method: request.method,
    url: request.url,
    ...(actionId === undefined ? {} : { actionId }),
    ...(capabilityId === undefined ? {} : { capabilityId }),
  }
}

async function callParent(operation: string, payload: unknown, wait = true): Promise<unknown> {
  if (!sessionKey || closed) throw gatewayChildError('E2E_GATEWAY_PARENT_DISCONNECTED')
  const requestId = randomUUID()
  const sequence = ++childSequence
  const envelope = signGatewayIpcEnvelope({
    schemaVersion: '1.0.0', direction: 'child-request', requestId, sequence, operation, payload,
  }, sessionKey)
  if (!wait) {
    send(envelope)
    return undefined
  }
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      reject(gatewayChildError('E2E_GATEWAY_PARENT_TIMEOUT'))
    }, 5_000)
    pending.set(requestId, {
      sequence,
      operation,
      resolve(value) { clearTimeout(timeout); resolve(value) },
      reject(error) { clearTimeout(timeout); reject(error) },
    })
    send(envelope)
  })
}

function parseIpcResponsePayload(value: unknown): { ok: true; result: unknown } | { ok: false; code: string } {
  if (!isRecord(value)) throw gatewayChildError('E2E_GATEWAY_IPC_RESPONSE_INVALID')
  if (value.ok === true && hasExactKeys(value, ['ok', 'result'])) return { ok: true, result: value.result }
  if (value.ok === false && hasExactKeys(value, ['code', 'ok'])
    && typeof value.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(value.code)) return { ok: false, code: value.code }
  throw gatewayChildError('E2E_GATEWAY_IPC_RESPONSE_INVALID')
}

function parseParentOperationResult(operation: string, value: unknown): unknown {
  if (operation === 'authorize' && isRecord(value) && hasExactKeys(value, ['allowed'])
    && typeof value.allowed === 'boolean') return { allowed: value.allowed }
  if (operation === 'default-deny' && isRecord(value) && hasExactKeys(value, ['recorded'])
    && value.recorded === true) return { recorded: true }
  if (operation === 'transport-complete' && isRecord(value) && hasExactKeys(value, ['completed'])
    && value.completed === true) return { completed: true }
  if (operation === 'transport-unknown' && isRecord(value) && hasExactKeys(value, ['markedUnknown'])
    && value.markedUnknown === true) return { markedUnknown: true }
  throw gatewayChildError('E2E_GATEWAY_IPC_RESPONSE_INVALID')
}

async function shutdown(reason: string): Promise<void> {
  if (closed) return
  closed = true
  const current = proxy
  proxy = undefined
  for (const waiter of pending.values()) waiter.reject(gatewayChildError(reason))
  pending.clear()
  try { await current?.stop() }
  catch { process.exitCode = 1 }
  finally {
    sessionKey?.fill(0)
    sessionKey = undefined
    remainingUses.clear()
    inFlightRequests.clear()
    if (process.connected) process.disconnect()
  }
}

async function startOnLoopback(server: Mockttp): Promise<void> {
  const original = NetServer.prototype.listen
  NetServer.prototype.listen = function (this: NetServer, ...args: unknown[]): NetServer {
    if (typeof args[0] === 'number') {
      const [port, callback] = args
      return Reflect.apply(original, this, [{ port, host: '127.0.0.1' }, callback].filter(Boolean)) as NetServer
    }
    return Reflect.apply(original, this, args) as NetServer
  } as typeof NetServer.prototype.listen
  try { await server.start() }
  finally { NetServer.prototype.listen = original }
}

async function readBootstrapKey(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const key = Buffer.concat(chunks)
  for (const chunk of chunks) chunk.fill(0)
  if (key.byteLength !== 32) { key.fill(0); throw gatewayChildError('E2E_GATEWAY_SESSION_KEY_INVALID') }
  return key
}

function parseChildConfig(value: unknown): ChildConfig {
  if (!isRecord(value) || !hasExactKeys(value, ['caCertPath', 'caKeyPath', 'rules'])
    || value.caKeyPath !== 'key.pem' || value.caCertPath !== 'cert.pem'
    || !Array.isArray(value.rules) || value.rules.length > 10_000
    || !value.rules.every(isProjectedRule)) throw gatewayChildError('E2E_GATEWAY_CONFIG_INVALID')
  return structuredClone(value) as unknown as ChildConfig
}

function isProjectedRule(value: unknown): value is ProjectedGatewayRule {
  if (!isRecord(value)) return false
  const optional = new Set(['bodyBase64Url', 'contentType', 'requestId', 'signedBodyDigest'])
  const required = ['actionId', 'actionToken', 'behavior', 'bodyDigest', 'capabilityId', 'channel', 'maxUses',
    'method', 'redirectRequestIds', 'requestHeaders', 'ruleId', 'stepOrdinal', 'url']
  if (!required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.has(key))
    || !isSafeId(value.ruleId) || !isSafeId(value.actionId) || !isSafeId(value.capabilityId)
    || typeof value.actionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.actionToken)
    || typeof value.bodyDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.bodyDigest)
    || (value.requestId !== undefined && !isSafeId(value.requestId))
    || (value.signedBodyDigest !== undefined
      && (typeof value.signedBodyDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.signedBodyDigest)))
    || !isRecord(value.requestHeaders)
    || !Object.entries(value.requestHeaders).every(([name, headerValue]) =>
      /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(name) && typeof headerValue === 'string'
      && Buffer.byteLength(headerValue, 'utf8') <= 8 * 1024 && !/[\0-\x08\x0a-\x1f\x7f]/.test(headerValue))
    || !Array.isArray(value.redirectRequestIds) || value.redirectRequestIds.some((requestId) => !isSafeId(requestId))
    || typeof value.method !== 'string' || !/^[A-Z]{1,32}$/.test(value.method)
    || typeof value.url !== 'string' || value.url.length > 8 * 1024
    || !['http', 'beacon', 'websocket'].includes(value.channel)
    || !Number.isSafeInteger(value.maxUses) || value.maxUses < 1 || value.maxUses > 100_000
    || !Number.isSafeInteger(value.stepOrdinal) || value.stepOrdinal < 1 || value.stepOrdinal > 10_000
    || (value.bodyBase64Url !== undefined && !isCanonicalBase64Url(value.bodyBase64Url, 1024 * 1024))
    || (value.contentType !== undefined && (typeof value.contentType !== 'string'
      || value.contentType.length > 8 * 1024 || /[\r\n\0]/.test(value.contentType)))
    || !isProjectedBehavior(value.behavior)) return false
  try {
    const url = new URL(value.url)
    return url.href === value.url && !url.username && !url.password && !url.hash
      && (value.channel === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)
  } catch { return false }
}

function isProjectedBehavior(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (['pass-through', 'connection-reset', 'timeout'].includes(value.kind)) return hasExactKeys(value, ['kind'])
  if (value.kind !== 'http-response'
    || Object.keys(value).some((key) => !['body', 'delayMs', 'headers', 'kind', 'status'].includes(key))
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || (value.body !== undefined && (typeof value.body !== 'string' || Buffer.byteLength(value.body) > 64 * 1024))
    || (value.delayMs !== undefined && (!Number.isInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 30_000))) return false
  if (value.headers === undefined) return true
  if (!isRecord(value.headers)) return false
  return Object.entries(value.headers).every(([name, headerValue]) =>
    ['content-type', 'retry-after', 'cache-control'].includes(name.toLowerCase())
      && typeof headerValue === 'string' && Buffer.byteLength(headerValue) <= 8 * 1024
      && !/[\r\n\0]/.test(headerValue))
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
}

function isCanonicalBase64Url(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string') return false
  const bytes = Buffer.from(value, 'base64url')
  try { return bytes.byteLength <= maximum && bytes.toString('base64url') === value }
  finally { bytes.fill(0) }
}

function strippedHeaders(): Record<string, undefined> {
  return {
    'x-mutil-e2e-action-token': undefined,
    'x-mutil-e2e-action-id': undefined,
    'x-mutil-e2e-capability-id': undefined,
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isPotentialResponse(value: unknown): boolean {
  return isRecord(value) && value.direction === 'parent-response'
}

function send(message: GatewayIpcEnvelope): void {
  if (!process.connected) throw gatewayChildError('E2E_GATEWAY_PARENT_DISCONNECTED')
  process.send!(message)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeCode(error: unknown): string {
  if (isRecord(error) && error.code === 'EPERM') return 'E2E_GATEWAY_LOOPBACK_UNAVAILABLE'
  return isRecord(error) && typeof error.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'E2E_GATEWAY_INTERNAL_ERROR'
}

function gatewayChildError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
