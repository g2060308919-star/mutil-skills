import {
  canonicalizeJson,
  digestBytes,
  digestText,
} from '@mutil-skills/e2e-contracts'
import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

const MAX_RPC_BYTES = 1024 * 1024
const MAX_RPC_TTL_MS = 30_000
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface AuthenticatedRpcCredential {
  clientId: string
  sessionKeyBase64Url: string
}

export interface AuthenticatedRpcVerifierMaterial {
  schemaVersion: '1.0.0'
  issuer: string
  keyId: string
  purpose: 'authority-rpc-response/v1'
  algorithm: 'Ed25519'
  publicKeySpkiBase64Url: string
  publicKeyDigest: string
}

export interface AuthenticatedRpcRequest {
  schemaVersion: '1.0.0'
  clientId: string
  requestId: string
  nonce: string
  operation: string
  payload: unknown
  payloadDigest: string
  issuedAt: string
  expiresAt: string
  authentication: { algorithm: 'HMAC-SHA256'; mac: string }
}

export interface AuthenticatedRpcResponse {
  schemaVersion: '1.0.0'
  requestId: string
  nonce: string
  operation: string
  requestDigest: string
  status: 'ok' | 'error'
  result?: unknown
  errorCode?: string
  respondedAt: string
  issuer: string
  keyId: string
  purpose: 'authority-rpc-response/v1'
  algorithm: 'Ed25519'
  signedDigest: string
  signature: string
}

export type AuthenticatedRpcOperation = (payload: unknown) => Promise<unknown>

export class AuthenticatedRpcServer {
  readonly #issuer: string
  readonly #keyId: string
  readonly #now: () => Date
  readonly #privateKey: KeyObject
  readonly #publicKeySpki: Buffer
  readonly #credentials = new Map<string, Buffer>()
  readonly #operations = new Map<string, AuthenticatedRpcOperation>()
  readonly #consumed = new Map<string, number>()

  private constructor(input: { issuer: string; keyId: string; now: () => Date },
    privateKey: KeyObject, publicKey: KeyObject) {
    if (!SAFE_ID.test(input.issuer) || !SAFE_ID.test(input.keyId)) throw rpcError('E2E_RPC_SERVER_ID_INVALID')
    this.#issuer = input.issuer
    this.#keyId = input.keyId
    this.#now = input.now
    this.#privateKey = privateKey
    this.#publicKeySpki = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))
  }

  static create(input: { issuer: string; keyId: string; now?: () => Date }): AuthenticatedRpcServer {
    const keys = generateKeyPairSync('ed25519')
    return new AuthenticatedRpcServer({ ...input, now: input.now ?? (() => new Date()) },
      keys.privateKey, keys.publicKey)
  }

  registerClient(clientId: string, sessionKey?: Uint8Array): AuthenticatedRpcCredential {
    if (!SAFE_ID.test(clientId) || this.#credentials.has(clientId)) throw rpcError('E2E_RPC_CLIENT_DUPLICATE')
    const key = sessionKey ? Buffer.from(sessionKey) : randomBytes(32)
    if (key.byteLength !== 32) throw rpcError('E2E_RPC_SESSION_KEY_INVALID')
    this.#credentials.set(clientId, Buffer.from(key))
    return { clientId, sessionKeyBase64Url: key.toString('base64url') }
  }

  registerOperation(operation: string, handler: AuthenticatedRpcOperation): void {
    if (!SAFE_ID.test(operation) || this.#operations.has(operation) || typeof handler !== 'function') {
      throw rpcError('E2E_RPC_OPERATION_INVALID')
    }
    this.#operations.set(operation, handler)
  }

  get verifierMaterial(): AuthenticatedRpcVerifierMaterial {
    return {
      schemaVersion: '1.0.0', issuer: this.#issuer, keyId: this.#keyId,
      purpose: 'authority-rpc-response/v1', algorithm: 'Ed25519',
      publicKeySpkiBase64Url: this.#publicKeySpki.toString('base64url'),
      publicKeyDigest: digestBytes('authority-rpc-public-key/v1', this.#publicKeySpki),
    }
  }

  async handle(candidate: unknown): Promise<AuthenticatedRpcResponse> {
    const request = parseRequest(candidate)
    const now = this.#now().getTime()
    this.#pruneConsumed(now)
    const issuedAt = Date.parse(request.issuedAt)
    const expiresAt = Date.parse(request.expiresAt)
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || issuedAt > now || expiresAt <= now || expiresAt - issuedAt > MAX_RPC_TTL_MS) {
      throw rpcError('E2E_RPC_REQUEST_EXPIRED')
    }
    const replayKey = `${request.clientId}\0${request.requestId}\0${request.nonce}`
    if (this.#consumed.has(replayKey)) throw rpcError('E2E_RPC_REQUEST_REPLAYED')
    const key = this.#credentials.get(request.clientId)
    if (!key) throw rpcError('E2E_RPC_CLIENT_UNKNOWN')
    const expectedPayloadDigest = digestText('authority-rpc-payload/v1', canonicalizeJson(request.payload))
    if (request.payloadDigest !== expectedPayloadDigest) throw rpcError('E2E_RPC_PAYLOAD_DIGEST_INVALID')
    const unsigned = requestWithoutAuthentication(request)
    const expectedMac = requestMac(key, unsigned)
    const suppliedMac = decodeCanonicalBase64Url(request.authentication.mac, 'E2E_RPC_REQUEST_MAC_INVALID')
    if (expectedMac.byteLength !== suppliedMac.byteLength || !timingSafeEqual(expectedMac, suppliedMac)) {
      throw rpcError('E2E_RPC_REQUEST_MAC_INVALID')
    }
    this.#consumed.set(replayKey, expiresAt)
    const handler = this.#operations.get(request.operation)
    if (!handler) return this.#signResponse(request, 'error', undefined, 'E2E_RPC_OPERATION_UNKNOWN')
    try {
      return this.#signResponse(request, 'ok', await handler(structuredClone(request.payload)))
    } catch (error) {
      return this.#signResponse(request, 'error', undefined, safeErrorCode(error))
    }
  }

  #signResponse(request: AuthenticatedRpcRequest, status: 'ok' | 'error', result?: unknown,
    errorCode?: string): AuthenticatedRpcResponse {
    const body = {
      schemaVersion: '1.0.0' as const, requestId: request.requestId, nonce: request.nonce,
      operation: request.operation, requestDigest: digestRequest(request), status,
      ...(status === 'ok' ? { result: result ?? null } : { errorCode: errorCode ?? 'E2E_RPC_OPERATION_FAILED' }),
      respondedAt: this.#now().toISOString(), issuer: this.#issuer, keyId: this.#keyId,
      purpose: 'authority-rpc-response/v1' as const, algorithm: 'Ed25519' as const,
    }
    const signedDigest = digestText('authority-rpc-response-binding/v1', canonicalizeJson(body))
    return { ...body, signedDigest,
      signature: sign(null, responseSignaturePayload(body.purpose, body.issuer, body.keyId, signedDigest),
        this.#privateKey).toString('base64url') }
  }

  #pruneConsumed(now: number): void {
    for (const [key, expiresAt] of this.#consumed) if (expiresAt <= now) this.#consumed.delete(key)
  }
}

export type AuthenticatedRpcTransport = (request: AuthenticatedRpcRequest) => Promise<unknown>

export class AuthenticatedRpcClient {
  readonly #clientId: string
  readonly #sessionKey: Buffer
  readonly #material: AuthenticatedRpcVerifierMaterial
  readonly #publicKey: KeyObject
  readonly #transport: AuthenticatedRpcTransport
  readonly #now: () => Date
  readonly #ttlMs: number

  private constructor(input: {
    credential: AuthenticatedRpcCredential
    verifierMaterial: AuthenticatedRpcVerifierMaterial
    expectedPublicKeyDigest: string
    transport: AuthenticatedRpcTransport
    now: () => Date
    ttlMs: number
  }, publicKey: KeyObject) {
    this.#clientId = input.credential.clientId
    this.#sessionKey = decodeCanonicalBase64Url(input.credential.sessionKeyBase64Url,
      'E2E_RPC_SESSION_KEY_INVALID')
    this.#material = structuredClone(input.verifierMaterial)
    this.#publicKey = publicKey
    this.#transport = input.transport
    this.#now = input.now
    this.#ttlMs = input.ttlMs
  }

  static create(input: {
    credential: AuthenticatedRpcCredential
    verifierMaterial: AuthenticatedRpcVerifierMaterial
    expectedPublicKeyDigest: string
    transport: AuthenticatedRpcTransport
    now?: () => Date
    ttlMs?: number
  }): AuthenticatedRpcClient {
    validateMaterial(input.verifierMaterial, input.expectedPublicKeyDigest)
    if (!SAFE_ID.test(input.credential.clientId)) throw rpcError('E2E_RPC_CLIENT_ID_INVALID')
    const key = decodeCanonicalBase64Url(input.credential.sessionKeyBase64Url, 'E2E_RPC_SESSION_KEY_INVALID')
    if (key.byteLength !== 32) throw rpcError('E2E_RPC_SESSION_KEY_INVALID')
    const spki = decodeCanonicalBase64Url(input.verifierMaterial.publicKeySpkiBase64Url,
      'E2E_RPC_PUBLIC_KEY_INVALID')
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    } catch { throw rpcError('E2E_RPC_PUBLIC_KEY_INVALID') }
    const ttlMs = input.ttlMs ?? 5_000
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_RPC_TTL_MS) {
      throw rpcError('E2E_RPC_TTL_INVALID')
    }
    return new AuthenticatedRpcClient({ ...input, now: input.now ?? (() => new Date()), ttlMs }, publicKey)
  }

  get authorityPublicKeyDigest(): string { return this.#material.publicKeyDigest }
  get authorityIdentity(): { issuer: string; keyId: string } {
    return { issuer: this.#material.issuer, keyId: this.#material.keyId }
  }

  async call(operation: string, payload: unknown): Promise<unknown> {
    if (!SAFE_ID.test(operation)) throw rpcError('E2E_RPC_OPERATION_INVALID')
    const issuedAt = this.#now()
    const unsigned = {
      schemaVersion: '1.0.0' as const, clientId: this.#clientId, requestId: randomUUID(),
      nonce: randomBytes(32).toString('base64url'), operation, payload: structuredClone(payload),
      payloadDigest: digestText('authority-rpc-payload/v1', canonicalizeJson(payload)),
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + this.#ttlMs).toISOString(),
    }
    const request: AuthenticatedRpcRequest = { ...unsigned,
      authentication: { algorithm: 'HMAC-SHA256', mac: requestMac(this.#sessionKey, unsigned).toString('base64url') } }
    const response = parseResponse(await this.#transport(request))
    this.#verifyResponse(response, request)
    if (response.status === 'error') throw rpcError(response.errorCode ?? 'E2E_RPC_OPERATION_FAILED')
    return structuredClone(response.result)
  }

  #verifyResponse(response: AuthenticatedRpcResponse, request: AuthenticatedRpcRequest): void {
    if (response.requestId !== request.requestId || response.nonce !== request.nonce
      || response.operation !== request.operation || response.requestDigest !== digestRequest(request)
      || response.issuer !== this.#material.issuer || response.keyId !== this.#material.keyId
      || response.purpose !== this.#material.purpose || response.algorithm !== this.#material.algorithm) {
      throw rpcError('E2E_RPC_RESPONSE_BINDING_INVALID')
    }
    const { signedDigest, signature, ...body } = response
    const expectedDigest = digestText('authority-rpc-response-binding/v1', canonicalizeJson(body))
    if (signedDigest !== expectedDigest) throw rpcError('E2E_RPC_RESPONSE_DIGEST_INVALID')
    const signatureBytes = decodeCanonicalBase64Url(signature, 'E2E_RPC_RESPONSE_SIGNATURE_INVALID')
    if (!verify(null, responseSignaturePayload(response.purpose, response.issuer, response.keyId, signedDigest),
      this.#publicKey, signatureBytes)) throw rpcError('E2E_RPC_RESPONSE_SIGNATURE_INVALID')
  }
}

export interface AuthenticatedRpcHttpHandle {
  endpoint: string
  close(): Promise<void>
}

export async function startAuthenticatedRpcLoopbackServer(
  rpc: AuthenticatedRpcServer,
): Promise<AuthenticatedRpcHttpHandle> {
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    try {
      if (!isLoopback(request.socket.remoteAddress)) throw httpError(403, 'E2E_RPC_REMOTE_DENIED')
      if (request.method !== 'POST' || request.url !== '/v1/authority-rpc') {
        throw httpError(404, 'E2E_RPC_ROUTE_NOT_FOUND')
      }
      response.end(JSON.stringify(await rpc.handle(await readJson(request))))
    } catch (error) {
      response.statusCode = httpStatus(error)
      response.end(JSON.stringify({ code: safeErrorCode(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw rpcError('E2E_RPC_SERVER_ADDRESS_INVALID')
  }
  return { endpoint: `http://127.0.0.1:${address.port}/v1/authority-rpc`, close: () => closeServer(server) }
}

export function createAuthenticatedRpcHttpTransport(endpoint: string): AuthenticatedRpcTransport {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1/authority-rpc'
    || url.username || url.password || url.search || url.hash) throw rpcError('E2E_RPC_ENDPOINT_INVALID')
  return async (request) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request) })
    const body = await response.json() as unknown
    if (!response.ok) throw rpcError(isPlainObject(body) && typeof body.code === 'string'
      ? body.code : 'E2E_RPC_HTTP_FAILED')
    return body
  }
}

function requestWithoutAuthentication(request: AuthenticatedRpcRequest): Omit<AuthenticatedRpcRequest, 'authentication'> {
  const { authentication: _authentication, ...unsigned } = request
  return unsigned
}

function requestMac(key: Uint8Array, unsigned: Omit<AuthenticatedRpcRequest, 'authentication'>): Buffer {
  return createHmac('sha256', key).update(Buffer.from(canonicalizeJson(unsigned))).digest()
}

function digestRequest(request: AuthenticatedRpcRequest): string {
  return digestText('authority-rpc-request/v1', canonicalizeJson(request))
}

function responseSignaturePayload(purpose: string, issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ purpose, issuer, keyId, algorithm: 'Ed25519', signedDigest }))
}

function parseRequest(candidate: unknown): AuthenticatedRpcRequest {
  if (!isPlainObject(candidate) || !hasExactKeys(candidate, ['authentication', 'clientId', 'expiresAt', 'issuedAt',
    'nonce', 'operation', 'payload', 'payloadDigest', 'requestId', 'schemaVersion'])) throw rpcError('E2E_RPC_REQUEST_INVALID')
  const auth = candidate.authentication
  if (!isPlainObject(auth) || !hasExactKeys(auth, ['algorithm', 'mac'])
    || auth.algorithm !== 'HMAC-SHA256' || typeof auth.mac !== 'string'
    || candidate.schemaVersion !== '1.0.0' || typeof candidate.clientId !== 'string'
    || typeof candidate.requestId !== 'string' || typeof candidate.nonce !== 'string'
    || typeof candidate.operation !== 'string' || typeof candidate.payloadDigest !== 'string'
    || typeof candidate.issuedAt !== 'string' || typeof candidate.expiresAt !== 'string'
    || !SAFE_ID.test(candidate.clientId) || !SAFE_ID.test(candidate.requestId)
    || !SAFE_ID.test(candidate.operation) || !DIGEST.test(candidate.payloadDigest)
    || !isCanonicalInstant(candidate.issuedAt) || !isCanonicalInstant(candidate.expiresAt)
    || !isCanonicalBase64UrlBytes(candidate.nonce, 32)
    || !isCanonicalBase64UrlBytes(auth.mac, 32)) throw rpcError('E2E_RPC_REQUEST_INVALID')
  return structuredClone(candidate) as unknown as AuthenticatedRpcRequest
}

function parseResponse(candidate: unknown): AuthenticatedRpcResponse {
  if (!isPlainObject(candidate)) throw rpcError('E2E_RPC_RESPONSE_INVALID')
  const status = candidate.status
  const keys = status === 'ok'
    ? ['algorithm', 'issuer', 'keyId', 'nonce', 'operation', 'purpose', 'requestDigest', 'requestId',
      'respondedAt', 'result', 'schemaVersion', 'signature', 'signedDigest', 'status']
    : ['algorithm', 'errorCode', 'issuer', 'keyId', 'nonce', 'operation', 'purpose', 'requestDigest',
      'requestId', 'respondedAt', 'schemaVersion', 'signature', 'signedDigest', 'status']
  if (!hasExactKeys(candidate, keys) || candidate.schemaVersion !== '1.0.0'
    || (status !== 'ok' && status !== 'error')
    || typeof candidate.requestId !== 'string' || !SAFE_ID.test(candidate.requestId)
    || typeof candidate.nonce !== 'string' || !isCanonicalBase64UrlBytes(candidate.nonce, 32)
    || typeof candidate.operation !== 'string' || !SAFE_ID.test(candidate.operation)
    || typeof candidate.requestDigest !== 'string' || !DIGEST.test(candidate.requestDigest)
    || typeof candidate.respondedAt !== 'string' || !isCanonicalInstant(candidate.respondedAt)
    || typeof candidate.issuer !== 'string' || !SAFE_ID.test(candidate.issuer)
    || typeof candidate.keyId !== 'string' || !SAFE_ID.test(candidate.keyId)
    || candidate.purpose !== 'authority-rpc-response/v1' || candidate.algorithm !== 'Ed25519'
    || typeof candidate.signedDigest !== 'string' || !DIGEST.test(candidate.signedDigest)
    || typeof candidate.signature !== 'string' || !isCanonicalBase64UrlBytes(candidate.signature, 64)
    || (status === 'error' && (typeof candidate.errorCode !== 'string' || !SAFE_ID.test(candidate.errorCode)))) {
    throw rpcError('E2E_RPC_RESPONSE_INVALID')
  }
  return structuredClone(candidate) as unknown as AuthenticatedRpcResponse
}

function validateMaterial(material: AuthenticatedRpcVerifierMaterial, expectedDigest: string): void {
  if (!isPlainObject(material) || material.schemaVersion !== '1.0.0'
    || material.purpose !== 'authority-rpc-response/v1' || material.algorithm !== 'Ed25519'
    || !SAFE_ID.test(material.issuer) || !SAFE_ID.test(material.keyId)
    || material.publicKeyDigest !== expectedDigest || !DIGEST.test(expectedDigest)) {
    throw rpcError('E2E_RPC_VERIFIER_MATERIAL_INVALID')
  }
  const spki = decodeCanonicalBase64Url(material.publicKeySpkiBase64Url, 'E2E_RPC_PUBLIC_KEY_INVALID')
  if (digestBytes('authority-rpc-public-key/v1', spki) !== material.publicKeyDigest) {
    throw rpcError('E2E_RPC_PUBLIC_KEY_DIGEST_INVALID')
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_RPC_BYTES) throw httpError(413, 'E2E_RPC_REQUEST_TOO_LARGE')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw httpError(400, 'E2E_RPC_REQUEST_INVALID') }
}

function decodeCanonicalBase64Url(value: string, code: string): Buffer {
  if (typeof value !== 'string') throw rpcError(code)
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw rpcError(code)
  return bytes
}

function isCanonicalBase64UrlBytes(value: string, expectedBytes: number): boolean {
  try { return decodeCanonicalBase64Url(value, 'E2E_RPC_ENCODING_INVALID').byteLength === expectedBytes }
  catch { return false }
}

function isCanonicalInstant(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function rpcError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function httpError(status: number, code: string): Error & { code: string; status: number } {
  return Object.assign(rpcError(code), { status })
}

function safeErrorCode(error: unknown): string {
  const code = isObjectWithProperties(error) && typeof error.code === 'string'
    ? error.code : 'E2E_RPC_OPERATION_FAILED'
  return SAFE_ID.test(code) ? code : 'E2E_RPC_OPERATION_FAILED'
}

function httpStatus(error: unknown): number {
  const status = isObjectWithProperties(error) ? error.status : undefined
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400
}

function isObjectWithProperties(value: unknown): value is { code?: unknown; status?: unknown } {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
