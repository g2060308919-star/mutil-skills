import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type {
  WebAuthnApprovalType,
  WebAuthnUserPresenceAuthority,
} from './webauthn-user-presence.js'

const MAX_BODY_BYTES = 64 * 1024

export interface WebAuthnApprovalAssets {
  indexHtml: Uint8Array
  approvalJavaScript: Uint8Array
  simpleWebAuthnBrowser: Uint8Array
}

type ApprovalSessionInput =
  | { kind: 'enrollment'; subject: string }
  | {
      kind: 'approval'
      runId: string
      approvalType: WebAuthnApprovalType
      subjectDigest: string
      installationDigest: string
    }

export interface WebAuthnApprovalServerHandle {
  origin: string
  url: string
  sessionId: string
  completion: Promise<{ completed: true } | { completed: false; code: string }>
  close(): Promise<void>
}

export async function startWebAuthnApprovalServer(options: {
  authority: WebAuthnUserPresenceAuthority
  assets: WebAuthnApprovalAssets
  ttlMs: number
  session: ApprovalSessionInput
}): Promise<WebAuthnApprovalServerHandle> {
  validateAssets(options.assets)
  const bearer = randomBytes(32)
  const bearerFragment = bearer.toString('base64url')
  let origin = ''
  let sessionId = ''
  let sessionPayload = Buffer.alloc(0)
  let submitted = false
  let closed = false
  let settled = false
  let expiryTimer: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined
  let settleCompletion!: (result: { completed: true } | { completed: false; code: string }) => void
  const completion = new Promise<{ completed: true } | { completed: false; code: string }>((resolve) => {
    settleCompletion = resolve
  })
  const settle = (result: { completed: true } | { completed: false; code: string }): boolean => {
    if (settled) return false
    settled = true
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = undefined
    bearer.fill(0)
    settleCompletion(result)
    return true
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      authority: options.authority,
      assets: options.assets,
      get origin() { return origin },
      get sessionId() { return sessionId },
      get sessionPayload() { return sessionPayload },
      bearer,
      get submitted() { return submitted },
      markSubmitted() { submitted = true },
      settle,
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw approvalServerError('E2E_APPROVAL_SERVER_BIND_FAILED')
  }
  origin = `http://localhost:${address.port}`
  try {
    const session = options.session.kind === 'enrollment'
      ? await options.authority.beginEnrollment({
          subject: options.session.subject, origin, ttlMs: options.ttlMs,
        })
      : await options.authority.beginApproval({
          runId: options.session.runId,
          approvalType: options.session.approvalType,
          subjectDigest: options.session.subjectDigest,
          installationDigest: options.session.installationDigest,
          origin,
          ttlMs: options.ttlMs,
        })
    sessionId = session.sessionId
    const fragmentPayload = JSON.parse(JSON.stringify({
      kind: options.session.kind,
      sessionId: session.sessionId,
      challenge: session.challenge,
      expiresAt: session.expiresAt,
      summary: session.summary,
      options: session.options,
    })) as unknown
    sessionPayload = Buffer.from(canonicalizeJson(fragmentPayload))
    const closeServer = async () => {
      if (closing !== undefined) return await closing
      closing = (async () => {
        if (closed) return
        closed = true
        server.closeAllConnections()
        if (!server.listening) return
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
        })
      })()
      return await closing
    }
    expiryTimer = setTimeout(() => {
      options.authority.revokeSession(sessionId)
      if (settle({ completed: false, code: 'E2E_APPROVAL_SESSION_EXPIRED' })) {
        sessionPayload.fill(0)
        void closeServer()
      }
    }, options.ttlMs)
    expiryTimer.unref()
    return {
      origin,
      sessionId,
      completion,
      url: `${origin}/#${bearerFragment}`,
      async close() {
        options.authority.revokeSession(sessionId)
        settle({ completed: false, code: 'E2E_APPROVAL_SESSION_CANCELLED' })
        sessionPayload.fill(0)
        await closeServer()
      },
    }
  } catch (error) {
    bearer.fill(0)
    sessionPayload.fill(0)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
}

interface RequestContext {
  authority: WebAuthnUserPresenceAuthority
  assets: WebAuthnApprovalAssets
  readonly origin: string
  readonly sessionId: string
  readonly sessionPayload: Uint8Array
  bearer: Uint8Array
  readonly submitted: boolean
  markSubmitted(): void
  settle(result: { completed: true } | { completed: false; code: string }): boolean
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  setSecurityHeaders(response)
  if (!isLoopbackApprovalClientAddress(request.socket.remoteAddress)) {
    respond(response, 403, 'loopback required')
    return
  }
  let url: URL
  try { url = new URL(request.url ?? '/', context.origin) } catch {
    respond(response, 400, 'invalid request')
    return
  }
  if (request.method === 'GET') {
    if (url.pathname === '/') {
      respondBytes(response, 200, 'text/html; charset=utf-8', context.assets.indexHtml)
      return
    }
    if (url.pathname === '/approval.js') {
      respondBytes(response, 200, 'text/javascript; charset=utf-8', context.assets.approvalJavaScript)
      return
    }
    if (url.pathname === '/simplewebauthn-browser.js') {
      respondBytes(response, 200, 'text/javascript; charset=utf-8', context.assets.simpleWebAuthnBrowser)
      return
    }
    if (url.pathname === '/session') {
      if (!hasBearer(request, context.bearer)) {
        respond(response, 401, 'authentication required')
        return
      }
      respondBytes(response, 200, 'application/json; charset=utf-8', context.sessionPayload)
      return
    }
    respond(response, 404, 'not found')
    return
  }
  if (request.method !== 'POST' || url.pathname !== '/submit') {
    respond(response, 405, 'method not allowed')
    return
  }
  if (!hasBearer(request, context.bearer)) {
    respond(response, 401, 'authentication required')
    return
  }
  if (request.headers.origin !== context.origin) {
    respond(response, 403, 'origin rejected')
    return
  }
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    respond(response, 415, 'json required')
    return
  }
  if (context.submitted) {
    respond(response, 409, 'session consumed')
    return
  }
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    request.resume()
    respond(response, 413, 'body too large')
    return
  }
  let body: Buffer
  try {
    body = await readBoundedBody(request)
  } catch {
    respond(response, 413, 'body too large')
    return
  }
  try {
    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
      if (!isPlainObject(parsed)) throw new Error('body is not an object')
      payload = parsed
    } catch {
      respond(response, 400, 'invalid json')
      return
    }
    if (payload.sessionId !== context.sessionId || typeof payload.challenge !== 'string') {
      respond(response, 400, 'session binding rejected')
      return
    }
    context.markSubmitted()
    try {
      if (Object.hasOwn(payload, 'credentialId')) {
        if (!hasExactKeys(payload, ['challenge', 'credentialId', 'response', 'sessionId'])
          || typeof payload.credentialId !== 'string') {
          throw approvalServerError('E2E_APPROVAL_SUBMISSION_INVALID')
        }
        await context.authority.completeApproval({
          sessionId: context.sessionId,
          challenge: payload.challenge,
          credentialId: payload.credentialId,
          response: payload.response,
        })
      } else {
        if (!hasExactKeys(payload, ['challenge', 'response', 'sessionId'])) {
          throw approvalServerError('E2E_APPROVAL_SUBMISSION_INVALID')
        }
        await context.authority.completeEnrollment({
          sessionId: context.sessionId,
          challenge: payload.challenge,
          response: payload.response,
        })
      }
      context.settle({ completed: true })
      respondBytes(response, 204, 'text/plain; charset=utf-8', Buffer.alloc(0))
    } catch (error) {
      const code = safeErrorCode(error)
      context.settle({ completed: false, code })
      respond(response, code === 'E2E_APPROVAL_SESSION_EXPIRED' ? 410 : 403, code)
    }
  } finally {
    body.fill(0)
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const source = Buffer.isBuffer(chunk) ? chunk : undefined
      const bytes = Buffer.from(chunk)
      try {
        size += bytes.byteLength
        if (size > MAX_BODY_BYTES) {
          bytes.fill(0)
          throw approvalServerError('E2E_APPROVAL_BODY_TOO_LARGE')
        }
        chunks.push(bytes)
      } finally {
        source?.fill(0)
      }
    }
    return Buffer.concat(chunks)
  } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  )
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}

function respond(response: ServerResponse, status: number, body: string): void {
  respondBytes(response, status, 'text/plain; charset=utf-8', Buffer.from(body))
}

function respondBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Uint8Array,
): void {
  response.statusCode = status
  response.setHeader('content-type', contentType)
  response.setHeader('content-length', String(body.byteLength))
  response.end(body)
}

function hasBearer(request: IncomingMessage, bearer: Uint8Array): boolean {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  return sameBearer(authorization.slice('Bearer '.length), bearer)
}

function sameBearer(candidate: string | null | undefined, expected: Uint8Array): boolean {
  if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false
  const actualBytes = Buffer.from(candidate, 'base64url')
  const expectedBytes = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)
  return actualBytes.byteLength === 32 && actualBytes.toString('base64url') === candidate
    && expectedBytes.byteLength === 32 && timingSafeEqual(actualBytes, expectedBytes)
}

export function isLoopbackApprovalClientAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

function validateAssets(assets: WebAuthnApprovalAssets): void {
  if (assets.indexHtml.byteLength === 0 || assets.approvalJavaScript.byteLength === 0
    || assets.simpleWebAuthnBrowser.byteLength === 0) {
    throw approvalServerError('E2E_APPROVAL_ASSET_INVALID')
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(error.code)) return error.code
  return 'E2E_APPROVAL_SUBMISSION_FAILED'
}

function approvalServerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
