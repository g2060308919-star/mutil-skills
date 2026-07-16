import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server'
import { E2EError, canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { randomBytes, randomUUID } from 'node:crypto'

const RP_ID = 'localhost'
const MAX_SESSION_TTL_MS = 5 * 60 * 1000
const DIGEST = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const SUPPORTED_ALGORITHMS = [-7, -257] as const
const AUTHORITY_CONSTRUCTION_KEY = Object.freeze({})

export type WebAuthnApprovalType = 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy'

export interface StoredWebAuthnCredential {
  id: string
  publicKey: string
  counter: number
  transports: AuthenticatorTransportFuture[]
  subject: string
}

export interface WebAuthnCredentialRepository {
  list(): Promise<StoredWebAuthnCredential[]>
  get(credentialId: string): Promise<StoredWebAuthnCredential | undefined>
  insert(credential: StoredWebAuthnCredential): Promise<void>
  compareAndSet(expected: StoredWebAuthnCredential, next: StoredWebAuthnCredential): Promise<void>
}

export interface WebAuthnApprovalBinding {
  subject: string
  runId: string
  approvalType: WebAuthnApprovalType
  subjectDigest: string
  installationDigest: string
  origin: string
}

interface RegistrationVerificationResult {
  verified: boolean
  credential?: {
    id: string
    publicKey: Uint8Array
    counter: number
    transports?: AuthenticatorTransportFuture[]
  }
}

interface AuthenticationVerificationResult {
  verified: boolean
  newCounter: number
}

interface RegistrationVerificationInput {
  response: unknown
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: typeof RP_ID
  requireUserVerification: true
  supportedAlgorithmIDs: readonly [-7, -257]
}

interface AuthenticationVerificationInput {
  response: unknown
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: typeof RP_ID
  credential: WebAuthnCredential
  requireUserVerification: true
}

interface WebAuthnAuthorityDependencies {
  now(): Date
  credentialRepository: WebAuthnCredentialRepository
}

interface PendingEnrollment {
  kind: 'enrollment'
  sessionId: string
  challenge: string
  subject: string
  origin: string
  expiresAt: number
  summary: string
}

interface PendingApproval {
  kind: 'approval'
  sessionId: string
  challenge: string
  runId: string
  approvalType: WebAuthnApprovalType
  subjectDigest: string
  installationDigest: string
  origin: string
  expiresAt: number
  summary: string
}

type PendingSession = PendingEnrollment | PendingApproval

interface WebAuthnApprovalReceipt extends WebAuthnApprovalBinding {
  issuedAt: string
  expiresAt: string
}

export interface WebAuthnEnrollmentSession {
  sessionId: string
  challenge: string
  expiresAt: string
  summary: string
  options: PublicKeyCredentialCreationOptionsJSON
}

export interface WebAuthnApprovalSession {
  sessionId: string
  challenge: string
  expiresAt: string
  summary: string
  options: PublicKeyCredentialRequestOptionsJSON
}

/**
 * Authority-owned user-presence state. Production callers create it with
 * {@link createWebAuthnUserPresenceAuthority}; test seams are deliberately not
 * re-exported from the package entrypoint.
 */
export class WebAuthnUserPresenceAuthority {
  readonly #now: () => Date
  readonly #randomBytes: (size: number) => Uint8Array
  readonly #credentials: WebAuthnCredentialRepository
  readonly #verifyRegistration: (input: RegistrationVerificationInput) => Promise<RegistrationVerificationResult>
  readonly #verifyAuthentication: (input: AuthenticationVerificationInput) => Promise<AuthenticationVerificationResult>
  readonly #pending = new Map<string, PendingSession>()
  readonly #consumed = new Set<string>()
  readonly #authenticatedSessions = new Map<string, WebAuthnApprovalReceipt>()

  constructor(constructionKey: object, dependencies: WebAuthnAuthorityDependencies) {
    if (constructionKey !== AUTHORITY_CONSTRUCTION_KEY) {
      throw approvalError(
        'E2E_APPROVAL_AUTHORITY_CONSTRUCTION_INVALID',
        'WebAuthn Authority 只能通过受控 production/test factory 创建',
      )
    }
    this.#now = dependencies.now
    this.#randomBytes = randomBytes
    this.#credentials = dependencies.credentialRepository
    this.#verifyRegistration = verifyRegistrationWithSimpleWebAuthn
    this.#verifyAuthentication = verifyAuthenticationWithSimpleWebAuthn
  }

  async beginEnrollment(input: {
    subject: string
    origin: string
    ttlMs: number
  }): Promise<WebAuthnEnrollmentSession> {
    validateSubject(input.subject)
    validateSessionBoundary(input.origin, input.ttlMs)
    const challenge = this.#challenge()
    const sessionId = randomUUID()
    const expiresAt = this.#now().getTime() + input.ttlMs
    const summary = canonicalizeJson({ action: 'enroll-identity', subject: input.subject })
    const credentials = await this.#credentials.list()
    const options = await generateRegistrationOptions({
      rpName: 'Mutil Skills E2E Runtime',
      rpID: RP_ID,
      userName: input.subject,
      userDisplayName: input.subject,
      userID: Buffer.from(digestText('e2e-webauthn-user-id/v1', input.subject).slice('sha256:'.length), 'hex'),
      challenge,
      timeout: input.ttlMs,
      attestationType: 'none',
      authenticatorSelection: { userVerification: 'required' },
      supportedAlgorithmIDs: [...SUPPORTED_ALGORITHMS],
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports],
      })),
    })
    this.#pending.set(sessionId, {
      kind: 'enrollment', sessionId, challenge, subject: input.subject,
      origin: input.origin, expiresAt, summary,
    })
    return { sessionId, challenge, expiresAt: new Date(expiresAt).toISOString(), summary, options }
  }

  async completeEnrollment(input: {
    sessionId: string
    challenge: string
    response: unknown
  }): Promise<void> {
    const pending = this.#consume(input.sessionId, 'enrollment')
    this.#requireChallenge(pending, input.challenge)
    let verification: RegistrationVerificationResult
    try {
      verification = await this.#verifyRegistration({
        response: input.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      })
    } catch (cause) {
      throw approvalError('E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE', 'WebAuthn 注册验证失败', cause)
    }
    if (!verification.verified || verification.credential === undefined) {
      throw approvalError('E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE', 'WebAuthn 注册未证明用户在场')
    }
    await this.#credentials.insert({
      id: verification.credential.id,
      publicKey: Buffer.from(verification.credential.publicKey).toString('base64url'),
      counter: verification.credential.counter,
      transports: [...(verification.credential.transports ?? [])],
      subject: pending.subject,
    })
  }

  async beginApproval(input: {
    runId: string
    approvalType: WebAuthnApprovalType
    subjectDigest: string
    installationDigest: string
    origin: string
    ttlMs: number
  }): Promise<WebAuthnApprovalSession> {
    if (!SAFE_ID.test(input.runId) || !DIGEST.test(input.subjectDigest)
      || !DIGEST.test(input.installationDigest)) {
      throw approvalError('E2E_APPROVAL_SESSION_INVALID', '审批 session 绑定字段无效')
    }
    validateSessionBoundary(input.origin, input.ttlMs)
    const credentials = await this.#credentials.list()
    if (credentials.length === 0) {
      throw approvalError('E2E_APPROVAL_IDENTITY_NOT_ENROLLED', '尚未登记 WebAuthn identity')
    }
    const challenge = this.#challenge()
    const sessionId = randomUUID()
    const expiresAt = this.#now().getTime() + input.ttlMs
    const summary = canonicalizeJson({
      action: 'approve', runId: input.runId, approvalType: input.approvalType,
      subjectDigest: input.subjectDigest, installationDigest: input.installationDigest,
    })
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      challenge,
      timeout: input.ttlMs,
      userVerification: 'required',
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports],
      })),
    })
    this.#pending.set(sessionId, {
      kind: 'approval', sessionId, challenge, runId: input.runId,
      approvalType: input.approvalType, subjectDigest: input.subjectDigest,
      installationDigest: input.installationDigest, origin: input.origin,
      expiresAt, summary,
    })
    return { sessionId, challenge, expiresAt: new Date(expiresAt).toISOString(), summary, options }
  }

  async completeApproval(input: {
    sessionId: string
    challenge: string
    credentialId: string
    response: unknown
  }): Promise<void> {
    const pending = this.#consume(input.sessionId, 'approval')
    this.#requireChallenge(pending, input.challenge)
    const stored = await this.#credentials.get(input.credentialId)
    if (stored === undefined || stored.id !== input.credentialId) {
      throw approvalError('E2E_APPROVAL_CREDENTIAL_UNKNOWN', 'WebAuthn credential 未登记')
    }
    let verification: AuthenticationVerificationResult
    try {
      verification = await this.#verifyAuthentication({
        response: input.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: RP_ID,
        credential: toWebAuthnCredential(stored),
        requireUserVerification: true,
      })
    } catch (cause) {
      throw approvalError('E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE', 'WebAuthn 认证验证失败', cause)
    }
    if (!verification.verified || !Number.isSafeInteger(verification.newCounter)
      || verification.newCounter <= stored.counter) {
      throw approvalError('E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE', 'WebAuthn 认证未证明用户在场')
    }
    await this.#credentials.compareAndSet(stored, { ...stored, counter: verification.newCounter })
    this.#authenticatedSessions.set(pending.sessionId, {
      subject: stored.subject,
      runId: pending.runId,
      approvalType: pending.approvalType,
      subjectDigest: pending.subjectDigest,
      installationDigest: pending.installationDigest,
      origin: pending.origin,
      issuedAt: this.#now().toISOString(),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    })
  }

  authenticateSession(sessionId: string, expected: WebAuthnApprovalBinding): string | undefined {
    const receipt = this.#authenticatedSessions.get(sessionId)
    if (receipt === undefined) return undefined
    this.#authenticatedSessions.delete(sessionId)
    if (this.#now().getTime() > Date.parse(receipt.expiresAt)) {
      throw approvalError('E2E_APPROVAL_SESSION_EXPIRED', 'WebAuthn approval receipt 已过期')
    }
    const actualBinding: WebAuthnApprovalBinding = {
      subject: receipt.subject,
      runId: receipt.runId,
      approvalType: receipt.approvalType,
      subjectDigest: receipt.subjectDigest,
      installationDigest: receipt.installationDigest,
      origin: receipt.origin,
    }
    if (canonicalizeJson(actualBinding) !== canonicalizeJson(expected)) {
      throw approvalError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'WebAuthn approval receipt 与当前审批绑定不一致')
    }
    return receipt.subject
  }

  revokePendingSessions(): void {
    for (const sessionId of this.#pending.keys()) this.#consumed.add(sessionId)
    this.#pending.clear()
    this.#authenticatedSessions.clear()
  }

  revokeSession(sessionId: string): void {
    if (this.#pending.delete(sessionId)) this.#consumed.add(sessionId)
  }

  #consume<T extends PendingSession['kind']>(
    sessionId: string,
    kind: T,
  ): Extract<PendingSession, { kind: T }> {
    if (this.#consumed.has(sessionId)) {
      throw approvalError('E2E_APPROVAL_SESSION_CONSUMED', 'WebAuthn session 已消费或撤销')
    }
    const pending = this.#pending.get(sessionId)
    if (pending === undefined || pending.kind !== kind) {
      throw approvalError('E2E_APPROVAL_SESSION_INVALID', 'WebAuthn session 不存在或类型错误')
    }
    this.#pending.delete(sessionId)
    this.#consumed.add(sessionId)
    if (this.#now().getTime() > pending.expiresAt) {
      throw approvalError('E2E_APPROVAL_SESSION_EXPIRED', 'WebAuthn session 已过期')
    }
    return pending as Extract<PendingSession, { kind: T }>
  }

  #requireChallenge(pending: PendingSession, challenge: string): void {
    if (challenge !== pending.challenge) {
      throw approvalError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'WebAuthn challenge 未绑定当前 session')
    }
  }

  #challenge(): string {
    const bytes = Buffer.from(this.#randomBytes(32))
    if (bytes.byteLength !== 32) {
      throw approvalError('E2E_APPROVAL_SESSION_INVALID', 'WebAuthn challenge 熵源返回长度无效')
    }
    return bytes.toString('base64url')
  }
}

export function createWebAuthnUserPresenceAuthority(input: {
  now(): Date
  credentialRepository: WebAuthnCredentialRepository
}): WebAuthnUserPresenceAuthority {
  return new WebAuthnUserPresenceAuthority(AUTHORITY_CONSTRUCTION_KEY, input)
}

async function verifyRegistrationWithSimpleWebAuthn(
  input: RegistrationVerificationInput,
): Promise<RegistrationVerificationResult> {
  const result = await verifyRegistrationResponse({
    response: input.response as RegistrationResponseJSON,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    requireUserVerification: true,
    supportedAlgorithmIDs: [...SUPPORTED_ALGORITHMS],
  })
  if (!result.verified) return { verified: false }
  return {
    verified: true,
    credential: {
      id: result.registrationInfo.credential.id,
      publicKey: result.registrationInfo.credential.publicKey,
      counter: result.registrationInfo.credential.counter,
      transports: input.response && typeof input.response === 'object'
        && 'response' in input.response && input.response.response && typeof input.response.response === 'object'
        && 'transports' in input.response.response && Array.isArray(input.response.response.transports)
        ? input.response.response.transports as AuthenticatorTransportFuture[]
        : [],
    },
  }
}

async function verifyAuthenticationWithSimpleWebAuthn(
  input: AuthenticationVerificationInput,
): Promise<AuthenticationVerificationResult> {
  const result = await verifyAuthenticationResponse({
    response: input.response as AuthenticationResponseJSON,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    credential: input.credential,
    requireUserVerification: true,
  })
  return { verified: result.verified, newCounter: result.authenticationInfo.newCounter }
}

function toWebAuthnCredential(stored: StoredWebAuthnCredential): WebAuthnCredential {
  return {
    id: stored.id,
    publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
    counter: stored.counter,
    transports: [...stored.transports],
  }
}

function validateSubject(subject: string): void {
  if (!SAFE_ID.test(subject)) {
    throw approvalError('E2E_APPROVAL_SESSION_INVALID', 'WebAuthn subject 无效')
  }
}

function validateSessionBoundary(origin: string, ttlMs: number): void {
  let parsed: URL
  try { parsed = new URL(origin) } catch {
    throw approvalError('E2E_APPROVAL_SESSION_INVALID', 'WebAuthn origin 无效')
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== RP_ID || parsed.origin !== origin
    || parsed.port === '' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
    throw approvalError('E2E_APPROVAL_SESSION_INVALID', 'WebAuthn session 必须绑定 localhost 随机端口且 TTL 不超过五分钟')
  }
}

function approvalError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'decision', message: `${code}: ${message}`, retryable: false, cause })
}
