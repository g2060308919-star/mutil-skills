import {
  canonicalizeJson,
  digestBytes,
  digestRuntimeIsolationPolicy,
  digestText,
  type ProductionIsolationBackend,
  type RuntimeIsolationPolicy,
} from '@mutil-skills/e2e-contracts'
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_ATTESTATION_TTL_MS = 5 * 60 * 1000
const MAX_CLOCK_AGE_MS = 30_000
const MIN_MEMORY_BYTES = 64 * 1024 * 1024
const MIN_DISK_BYTES = 16 * 1024 * 1024

export interface RuntimeIsolationClaims {
  schemaVersion: '1.0.0'
  isolationSessionId: string
  runId: string
  assetId: string
  generationId: string
  prdRevision: string
  caseIds: string[]
  backend: { kind: ProductionIsolationBackend; instanceId: string; version: string }
  identity: { dedicatedLowPrivilegeUser: true; uid: number; orchestratorUid: number }
  filesystem: {
    sourceDigest: string
    sourceReadOnly: true
    temporaryHome: true
    hostCredentialsMounted: false
  }
  network: {
    defaultDeny: true
    gatewayEndpoint: string
    allowedEndpoints: string[]
    quicDisabled: true
    remoteDebuggingDisabled: true
  }
  process: { arbitrarySubprocesses: false; allowedExecutableDigests: string[] }
  browser: { sandboxEnabled: true; ephemeralProfile: true; downloadsDisabled: true }
  limits: { cpuTimeMs: number; memoryBytes: number; diskBytes: number; wallTimeMs: number }
  authorityRpcPublicKeyDigest: string
  checkedAt: string
  expiresAt: string
}

export interface RuntimeIsolationAttestation extends RuntimeIsolationClaims {
  issuer: string
  keyId: string
  purpose: 'runtime-isolation-attestation/v1'
  algorithm: 'Ed25519'
  signedDigest: string
  signature: string
}

export interface RuntimeIsolationVerifierMaterial {
  schemaVersion: '1.0.0'
  issuer: string
  keyId: string
  purpose: 'runtime-isolation-attestation/v1'
  algorithm: 'Ed25519'
  publicKeySpkiBase64Url: string
  publicKeyDigest: string
}

export interface TrustedWriteRuntimeSession {}

export type WriteRuntimeSessionBinding =
  | {
      mode: 'trusted-compiler'
      sandboxHealthy: true
      gatewayConnected: true
      authorityTransport: 'in-process-test' | 'authenticated-rpc'
      authorityRpcPublicKeyDigest?: string
      runId: string
      sourceDigest: string
    }
  | {
      mode: 'test-only'
      sandboxHealthy: boolean
      gatewayConnected: boolean
      authorityTransport: 'in-process-test' | 'authenticated-rpc'
      authorityRpcPublicKeyDigest?: string
    }
  | {
      mode: 'production-isolated'
      sandboxHealthy: true
      gatewayConnected: true
      authorityTransport: 'authenticated-rpc'
      authorityRpcPublicKeyDigest: string
      isolationSessionId: string
      runId: string
      sourceDigest: string
      gatewayEndpoint: string
      attestationDigest: string
    }

const trustedSessions = new WeakMap<object, WriteRuntimeSessionBinding>()

export class LocalRuntimeIsolationAuthority {
  readonly #issuer: string
  readonly #keyId: string
  readonly #now: () => Date
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject

  private constructor(input: { issuer: string; keyId: string; now: () => Date },
    privateKey: KeyObject, publicKey: KeyObject) {
    if (!SAFE_ID.test(input.issuer) || !SAFE_ID.test(input.keyId)) {
      throw isolationError('E2E_RUNTIME_ISOLATION_AUTHORITY_INVALID')
    }
    this.#issuer = input.issuer
    this.#keyId = input.keyId
    this.#now = input.now
    this.#privateKey = privateKey
    this.#publicKey = publicKey
  }

  static create(input: { issuer: string; keyId: string; now: () => Date }): LocalRuntimeIsolationAuthority {
    const keys = generateKeyPairSync('ed25519')
    return new LocalRuntimeIsolationAuthority(input, keys.privateKey, keys.publicKey)
  }

  get verifierMaterial(): RuntimeIsolationVerifierMaterial {
    const spki = Buffer.from(this.#publicKey.export({ type: 'spki', format: 'der' }))
    return { schemaVersion: '1.0.0', issuer: this.#issuer, keyId: this.#keyId,
      purpose: 'runtime-isolation-attestation/v1', algorithm: 'Ed25519',
      publicKeySpkiBase64Url: spki.toString('base64url'),
      publicKeyDigest: digestBytes('runtime-isolation-public-key/v1', spki) }
  }

  issue(candidate: RuntimeIsolationClaims): RuntimeIsolationAttestation {
    const claims = parseClaims(candidate, this.#now(), 'E2E_RUNTIME_ISOLATION_CLAIMS_INVALID')
    const body = { ...claims, issuer: this.#issuer, keyId: this.#keyId,
      purpose: 'runtime-isolation-attestation/v1' as const, algorithm: 'Ed25519' as const }
    const signedDigest = digestText('runtime-isolation-attestation-binding/v1', canonicalizeJson(body))
    return { ...body, signedDigest,
      signature: sign(null, signaturePayload(body.purpose, body.issuer, body.keyId, signedDigest),
        this.#privateKey).toString('base64url') }
  }
}

export function createTestWriteRuntimeSession(input: {
  sandboxHealthy: boolean
  gatewayConnected: boolean
  authorityTransport: 'in-process-test' | 'authenticated-rpc'
  authorityRpcPublicKeyDigest?: string
}): TrustedWriteRuntimeSession {
  if (typeof input.sandboxHealthy !== 'boolean' || typeof input.gatewayConnected !== 'boolean'
    || !['in-process-test', 'authenticated-rpc'].includes(input.authorityTransport)
    || (input.authorityTransport === 'authenticated-rpc'
      && (!input.authorityRpcPublicKeyDigest || !DIGEST.test(input.authorityRpcPublicKeyDigest)))) {
    throw isolationError('E2E_RUNTIME_TEST_SESSION_INVALID')
  }
  const session = Object.freeze({})
  trustedSessions.set(session, structuredClone({ mode: 'test-only' as const, ...input }))
  return session
}

export function createProductionWriteRuntimeSession(input: {
  attestation: RuntimeIsolationAttestation
  verifierMaterial: RuntimeIsolationVerifierMaterial
  expectedPublicKeyDigest: string
  now: () => Date
  expected: {
    runId: string
    assetId: string
    generationId: string
    prdRevision: string
    caseIds: string[]
    runtimeIsolationPolicy: RuntimeIsolationPolicy
    runtimeIsolationPolicyDigest: string
  }
}): TrustedWriteRuntimeSession {
  const { publicKey, material } = parseVerifierMaterial(input.verifierMaterial, input.expectedPublicKeyDigest)
  const attestation = parseAttestation(input.attestation, input.now())
  let approvedPolicyDigest: string
  try {
    approvedPolicyDigest = digestRuntimeIsolationPolicy(input.expected.runtimeIsolationPolicy)
  } catch {
    throw isolationError('E2E_RUNTIME_ISOLATION_POLICY_INVALID')
  }
  if (input.expected.runtimeIsolationPolicyDigest !== approvedPolicyDigest) {
    throw isolationError('E2E_RUNTIME_ISOLATION_POLICY_DIGEST_INVALID')
  }
  const policy = input.expected.runtimeIsolationPolicy
  if (policy.isolationAuthorityPublicKeyDigest !== input.expectedPublicKeyDigest) {
    throw isolationError('E2E_RUNTIME_ISOLATION_POLICY_KEY_INVALID')
  }
  if (attestation.issuer !== material.issuer || attestation.keyId !== material.keyId
    || attestation.purpose !== material.purpose || attestation.algorithm !== material.algorithm) {
    throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_BINDING_INVALID')
  }
  const { signedDigest, signature, ...body } = attestation
  const expectedDigest = digestText('runtime-isolation-attestation-binding/v1', canonicalizeJson(body))
  if (signedDigest !== expectedDigest) throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_INVALID')
  const signatureBytes = decodeCanonicalBase64Url(signature, 'E2E_RUNTIME_ISOLATION_SIGNATURE_INVALID')
  if (signatureBytes.byteLength !== 64
    || !verify(null, signaturePayload(attestation.purpose, attestation.issuer, attestation.keyId, signedDigest),
      publicKey, signatureBytes)) throw isolationError('E2E_RUNTIME_ISOLATION_SIGNATURE_INVALID')
  const expectedEndpoints = policy.allowedEndpoints.map(canonicalEndpoint).sort()
  if (attestation.runId !== input.expected.runId || attestation.assetId !== input.expected.assetId
    || attestation.generationId !== input.expected.generationId
    || attestation.prdRevision !== input.expected.prdRevision
    || canonicalizeJson(attestation.caseIds) !== canonicalizeJson([...input.expected.caseIds].sort())
    || attestation.filesystem.sourceDigest !== policy.sourceDigest
    || attestation.authorityRpcPublicKeyDigest !== policy.authorityRpcPublicKeyDigest
    || attestation.network.gatewayEndpoint !== canonicalEndpoint(policy.gatewayEndpoint)
    || canonicalizeJson(attestation.network.allowedEndpoints) !== canonicalizeJson(expectedEndpoints)
    || canonicalizeJson(attestation.process.allowedExecutableDigests)
      !== canonicalizeJson(policy.allowedExecutableDigests)
    || !policy.allowedBackends.includes(attestation.backend.kind)
    || canonicalizeJson(attestation.limits) !== canonicalizeJson(policy.limits)) {
    throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_BINDING_INVALID')
  }
  const session = Object.freeze({})
  trustedSessions.set(session, {
    mode: 'production-isolated', sandboxHealthy: true, gatewayConnected: true,
    authorityTransport: 'authenticated-rpc',
    authorityRpcPublicKeyDigest: attestation.authorityRpcPublicKeyDigest,
    isolationSessionId: attestation.isolationSessionId, runId: attestation.runId,
    sourceDigest: attestation.filesystem.sourceDigest,
    gatewayEndpoint: attestation.network.gatewayEndpoint, attestationDigest: signedDigest,
  })
  return session
}

export function getWriteRuntimeSessionBinding(value: unknown): WriteRuntimeSessionBinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const binding = trustedSessions.get(value)
  return binding ? structuredClone(binding) : undefined
}

/** 同包可信执行前复验专用；不从 package root 导出。 */
export function registerTrustedCompilerWriteRuntimeSession(
  session: object,
  binding: Extract<WriteRuntimeSessionBinding, { mode: 'trusted-compiler' }>,
): void {
  if (trustedSessions.has(session)) throw isolationError('E2E_RUNTIME_TRUSTED_COMPILER_SESSION_DUPLICATE')
  trustedSessions.set(session, structuredClone(binding))
}

/** 同包固定 launcher 在 session 消费后调用；不从 package root 导出。 */
export function revokeTrustedCompilerWriteRuntimeSession(session: object): void {
  trustedSessions.delete(session)
}

function parseAttestation(value: unknown, now: Date): RuntimeIsolationAttestation {
  if (!isPlainObject(value)) throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_INVALID')
  const proofKeys = ['algorithm', 'issuer', 'keyId', 'purpose', 'signature', 'signedDigest']
  const claimKeys = runtimeClaimKeys()
  if (!hasExactKeys(value, [...claimKeys, ...proofKeys])
    || typeof value.issuer !== 'string' || !SAFE_ID.test(value.issuer)
    || typeof value.keyId !== 'string' || !SAFE_ID.test(value.keyId)
    || value.purpose !== 'runtime-isolation-attestation/v1' || value.algorithm !== 'Ed25519'
    || typeof value.signedDigest !== 'string' || !DIGEST.test(value.signedDigest)
    || typeof value.signature !== 'string') throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_INVALID')
  const claims = Object.fromEntries(claimKeys.map((key) => [key, value[key]]))
  try {
    return { ...parseClaims(claims, now, 'E2E_RUNTIME_ISOLATION_ATTESTATION_INVALID'),
      issuer: value.issuer, keyId: value.keyId, purpose: value.purpose, algorithm: value.algorithm,
      signedDigest: value.signedDigest, signature: value.signature }
  } catch (error) {
    if (isErrorCode(error, 'E2E_RUNTIME_ISOLATION_ATTESTATION_EXPIRED')) throw error
    throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_INVALID')
  }
}

function parseClaims(value: unknown, now: Date, code: string): RuntimeIsolationClaims {
  if (!isPlainObject(value) || !hasExactKeys(value, runtimeClaimKeys())) throw isolationError(code)
  const checkedAt = typeof value.checkedAt === 'string' ? Date.parse(value.checkedAt) : Number.NaN
  const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : Number.NaN
  const nowMs = now.getTime()
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    throw isolationError('E2E_RUNTIME_ISOLATION_ATTESTATION_EXPIRED')
  }
  if (value.schemaVersion !== '1.0.0' || !safeId(value.isolationSessionId) || !safeId(value.runId)
    || !safeId(value.assetId) || !safeId(value.generationId) || typeof value.prdRevision !== 'string'
    || !DIGEST.test(value.prdRevision) || !safeIdArray(value.caseIds)
    || !validBackend(value.backend) || !validIdentity(value.identity) || !validFilesystem(value.filesystem)
    || !validNetwork(value.network) || !validProcess(value.process) || !validBrowser(value.browser)
    || !validLimits(value.limits) || typeof value.authorityRpcPublicKeyDigest !== 'string'
    || !DIGEST.test(value.authorityRpcPublicKeyDigest)
    || !canonicalInstant(value.checkedAt) || !canonicalInstant(value.expiresAt)
    || checkedAt > nowMs || nowMs - checkedAt > MAX_CLOCK_AGE_MS
    || expiresAt - checkedAt <= 0 || expiresAt - checkedAt > MAX_ATTESTATION_TTL_MS) throw isolationError(code)
  return structuredClone(value) as unknown as RuntimeIsolationClaims
}

function parseVerifierMaterial(value: unknown, expectedDigest: string): {
  material: RuntimeIsolationVerifierMaterial
  publicKey: KeyObject
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ['algorithm', 'issuer', 'keyId', 'publicKeyDigest',
    'publicKeySpkiBase64Url', 'purpose', 'schemaVersion']) || value.schemaVersion !== '1.0.0'
    || !safeId(value.issuer) || !safeId(value.keyId) || value.purpose !== 'runtime-isolation-attestation/v1'
    || value.algorithm !== 'Ed25519' || typeof value.publicKeyDigest !== 'string'
    || !DIGEST.test(expectedDigest) || value.publicKeyDigest !== expectedDigest
    || typeof value.publicKeySpkiBase64Url !== 'string') {
    throw isolationError('E2E_RUNTIME_ISOLATION_MATERIAL_INVALID')
  }
  const spki = decodeCanonicalBase64Url(value.publicKeySpkiBase64Url,
    'E2E_RUNTIME_ISOLATION_MATERIAL_INVALID')
  if (digestBytes('runtime-isolation-public-key/v1', spki) !== value.publicKeyDigest) {
    throw isolationError('E2E_RUNTIME_ISOLATION_MATERIAL_INVALID')
  }
  try {
    const publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    return { material: structuredClone(value) as unknown as RuntimeIsolationVerifierMaterial, publicKey }
  } catch { throw isolationError('E2E_RUNTIME_ISOLATION_MATERIAL_INVALID') }
}

function runtimeClaimKeys(): string[] {
  return ['assetId', 'authorityRpcPublicKeyDigest', 'backend', 'browser', 'caseIds', 'checkedAt', 'expiresAt',
    'filesystem', 'generationId', 'identity', 'isolationSessionId', 'limits', 'network', 'prdRevision',
    'process', 'runId', 'schemaVersion']
}

function validBackend(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['instanceId', 'kind', 'version'])
    && ['linux-bwrap', 'kubernetes', 'macos-app-sandbox'].includes(String(value.kind))
    && safeId(value.instanceId) && typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version)
}

function validIdentity(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['dedicatedLowPrivilegeUser', 'orchestratorUid', 'uid'])
    && value.dedicatedLowPrivilegeUser === true && typeof value.uid === 'number'
    && Number.isSafeInteger(value.uid) && value.uid > 0
    && typeof value.orchestratorUid === 'number' && Number.isSafeInteger(value.orchestratorUid)
    && value.orchestratorUid >= 0 && value.uid !== value.orchestratorUid
}

function validFilesystem(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value,
    ['hostCredentialsMounted', 'sourceDigest', 'sourceReadOnly', 'temporaryHome'])
    && typeof value.sourceDigest === 'string' && DIGEST.test(value.sourceDigest)
    && value.sourceReadOnly === true && value.temporaryHome === true && value.hostCredentialsMounted === false
}

function validNetwork(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ['allowedEndpoints', 'defaultDeny', 'gatewayEndpoint',
    'quicDisabled', 'remoteDebuggingDisabled']) || value.defaultDeny !== true || value.quicDisabled !== true
    || value.remoteDebuggingDisabled !== true || typeof value.gatewayEndpoint !== 'string'
    || !Array.isArray(value.allowedEndpoints) || value.allowedEndpoints.length < 1
    || value.allowedEndpoints.length > 32 || value.allowedEndpoints.some((item) => typeof item !== 'string')) return false
  try {
    const gateway = canonicalEndpoint(value.gatewayEndpoint)
    const allowed = value.allowedEndpoints.map(canonicalEndpoint)
    return allowed.includes(gateway) && new Set(allowed).size === allowed.length
      && canonicalizeJson(allowed) === canonicalizeJson([...allowed].sort())
  } catch { return false }
}

function validProcess(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['allowedExecutableDigests', 'arbitrarySubprocesses'])
    && value.arbitrarySubprocesses === false && Array.isArray(value.allowedExecutableDigests)
    && value.allowedExecutableDigests.length >= 1 && value.allowedExecutableDigests.length <= 32
    && value.allowedExecutableDigests.every((item) => typeof item === 'string' && DIGEST.test(item))
    && new Set(value.allowedExecutableDigests).size === value.allowedExecutableDigests.length
    && canonicalizeJson(value.allowedExecutableDigests) === canonicalizeJson([...value.allowedExecutableDigests].sort())
}

function validBrowser(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['downloadsDisabled', 'ephemeralProfile', 'sandboxEnabled'])
    && value.downloadsDisabled === true && value.ephemeralProfile === true && value.sandboxEnabled === true
}

function validLimits(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['cpuTimeMs', 'diskBytes', 'memoryBytes', 'wallTimeMs'])
    && positiveInteger(value.cpuTimeMs) && positiveInteger(value.wallTimeMs)
    && positiveInteger(value.memoryBytes) && value.memoryBytes >= MIN_MEMORY_BYTES
    && positiveInteger(value.diskBytes) && value.diskBytes >= MIN_DISK_BYTES
    && value.cpuTimeMs <= value.wallTimeMs && value.wallTimeMs <= 24 * 60 * 60 * 1000
}

function canonicalEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw isolationError('E2E_RUNTIME_ISOLATION_ENDPOINT_INVALID')
  }
  return url.origin
}

function signaturePayload(purpose: string, issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ purpose, issuer, keyId, algorithm: 'Ed25519', signedDigest }))
}

function decodeCanonicalBase64Url(value: string, code: string): Buffer {
  if (typeof value !== 'string') throw isolationError(code)
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw isolationError(code)
  return bytes
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function safeId(value: unknown): value is string { return typeof value === 'string' && SAFE_ID.test(value) }
function safeIdArray(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 100_000
    && value.every(safeId) && new Set(value).size === value.length
    && canonicalizeJson(value) === canonicalizeJson([...value].sort())
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code
}
function isolationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
