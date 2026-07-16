import {
  E2EError,
  canonicalizeJson,
  digestBytes,
  digestText,
  type ApproverIdentity,
  ApprovalCapabilityRecordSchema,
  ApprovalFreshnessReceiptSchema,
  ApprovalFreshnessVerifierMaterialSchema,
  WriteApprovalSubjectV2Schema,
  ReadApprovalSubjectSchema,
  type ApprovalCapabilityRecord,
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerification,
  type ApprovalFreshnessVerifierMaterial,
  type ArtifactDocument,
  type ArtifactSignature,
  ArtifactAuthorityVerifierMaterialSchema,
  type ArtifactAuthorityVerifierMaterial,
  type AppendAttemptEventInput,
  type AttemptExecutionContext,
  type AttemptEvent,
  type AttemptEventAuthorityProof,
  ATTEMPT_EVENT_PROOF_PURPOSE,
  AttemptEventVerifierMaterialSchema,
  type AttemptEventVerifierMaterial,
  type CapabilityReservation,
  type CanonicalInjectionResponse,
  type DiscoveryApprovalSubject,
  type DiscoveryCapability,
  type DiscoveryPreflightOutcome,
  type GrantDecision,
  type InjectionApprovalSubject,
  type InjectionCapability,
  type ReadApprovalSubject,
  type PrivacyUnlockGrant,
  ManualResultDraftSchema,
  ManualResultSchema,
  type ManualResult,
  type ManualResultDraft,
  type ManualResultVerification,
  type ReadCapability,
  type ReversibleWriteCapability,
  type SignedGrant,
  type SignedDiscoveryGrant,
  type SignedInjectionGrant,
  type SignedSseReadGrant,
  type SignedReadGrant,
  type SignedWriteGrant,
  type SignedWebSocketReadGrant,
  type WebSocketReadApprovalSubject,
  type WebSocketReadCapability,
  type SseReadApprovalSubject,
  type SseReadCapability,
  type WriteApprovalSubject,
  digestInjectionResponseBody,
  digestApprovalProjection,
  PrivacyReviewReceiptBindingSchema,
  PrivacyReviewReceiptSchema,
  PrivacyReviewVerifierMaterialSchema,
  type PrivacyReviewReceipt,
  type PrivacyReviewReceiptBinding,
  type PrivacyReviewVerifierMaterial,
  DecisionReceiptSchema,
  DecisionReceiptVerificationBindingSchema,
  DecisionVerifierMaterialSchema,
  DecisionSubjectSchema,
  digestDecisionSubject,
  type DecisionReceipt,
  type DecisionReceiptVerificationBinding,
  type DecisionSubject,
  type DecisionVerifierMaterial,
} from '@mutil-skills/e2e-contracts'
import { createApprovalFreshnessVerifier } from './approval-freshness-verifier.js'
import {
  registerTrustedApprovalFreshnessClient,
  type TrustedApprovalFreshnessClient,
} from './trusted-approval-freshness.js'
import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, randomUUID, sign, verify, type KeyObject,
} from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { SqliteSnapshotStore } from './sqlite-state-store.js'
import { trustWriteApprovalClient, type TrustedWriteApprovalClient } from './trusted-execution-clients.js'
import type {
  StoredWebAuthnCredential,
  WebAuthnApprovalBinding,
  WebAuthnCredentialRepository,
} from './webauthn-user-presence.js'

const MAX_READ_TTL_MS = 8 * 60 * 60 * 1000
const MAX_DISCOVERY_TTL_MS = 15 * 60 * 1000
const MAX_WRITE_TTL_MS = 15 * 60 * 1000
const MAX_INJECTION_TTL_MS = 15 * 60 * 1000
const MAX_PRIVACY_UNLOCK_TTL_MS = 15 * 60 * 1000
const MAX_INJECTION_RESPONSE_BODY_BYTES = 64 * 1024
const MAX_INJECTION_HEADER_VALUE_BYTES = 8 * 1024
const MAX_MANUAL_RESULT_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_PRIVACY_REVIEW_AGE_MS = 24 * 60 * 60 * 1000
export interface LocalApprovalAuthorityOptions {
  issuer: string
  keyId: string
  now: () => Date
  approvalIdentities?: ApproverIdentity[]
  manualIdentities?: ApproverIdentity[]
  /** 由 Authority Host 注入的 OS/SSO 会话认证器；普通调用方不能控制其返回值。 */
  authenticateApproverSession?: (
    sessionRef: string,
    expected: WebAuthnApprovalBinding | undefined,
  ) => string | undefined
}

interface EncryptedPrivateKey {
  algorithm: 'aes-256-gcm'
  iv: string
  ciphertext: string
  authTag: string
}

interface AuthorityPersistentSnapshot {
  schemaVersion: '2.1.0'
  issuer: string
  keyId: string
  identityDigest: string
  privateKeys: {
    primary: EncryptedPrivateKey; freshness: EncryptedPrivateKey; privacyReview: EncryptedPrivateKey
    decision: EncryptedPrivateKey; attempt: EncryptedPrivateKey
  }
  webAuthnCredentials: EncryptedPrivateKey
  grants: Array<[string, SignedGrant]>
  revoked: Array<[string, string]>
  uses: Array<[string, number]>
  reservations: Array<[string, CapabilityReservation]>
  completedPreflights: Array<[string, { grantId: string; subject: DiscoveryApprovalSubject; status: DiscoveryPreflightOutcome['status'] }]>
  manualResultIds: string[]
  attemptLogs: Array<[string, { chainDigest: string; events: AttemptEvent[]; lastTimestamp: number }]>
}

export class LocalApprovalAuthority {
  readonly #issuer: string
  readonly #keyId: string
  readonly #now: () => Date
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject
  readonly #freshnessPrivateKey: KeyObject
  readonly #freshnessPublicKey: KeyObject
  readonly #freshnessKeyId: string
  readonly #privacyReviewPrivateKey: KeyObject
  readonly #privacyReviewPublicKey: KeyObject
  readonly #privacyReviewKeyId: string
  readonly #decisionPrivateKey: KeyObject
  readonly #decisionPublicKey: KeyObject
  readonly #decisionKeyId: string
  readonly #attemptPrivateKey: KeyObject
  readonly #attemptPublicKey: KeyObject
  readonly #attemptKeyId: string
  readonly #stateStore?: SqliteSnapshotStore
  readonly #stateEncryptionKey?: Buffer
  readonly #identityDigest: string
  readonly #authenticateApproverSession: (
    sessionRef: string,
    expected: WebAuthnApprovalBinding | undefined,
  ) => string | undefined
  readonly #stateContext = new AsyncLocalStorage<boolean>()
  #activeStateTransactions = 0
  readonly #grants = new Map<string, SignedGrant>()
  readonly #revoked = new Map<string, string>()
  readonly #uses = new Map<string, number>()
  readonly #reservations = new Map<string, CapabilityReservation>()
  readonly #completedPreflights = new Map<string, {
    grantId: string; subject: DiscoveryApprovalSubject; status: DiscoveryPreflightOutcome['status']
  }>()
  readonly #attemptLogs = new Map<string, { chainDigest: string; events: AttemptEvent[]; lastTimestamp: number }>()
  readonly #manualResultIds = new Set<string>()
  readonly #approvalIdentities = new Map<string, ApproverIdentity>()
  readonly #manualIdentities = new Map<string, ApproverIdentity>()
  readonly #webAuthnCredentials = new Map<string, StoredWebAuthnCredential>()

  private constructor(options: LocalApprovalAuthorityOptions, privateKey: KeyObject, publicKey: KeyObject,
    freshnessPrivateKey: KeyObject, freshnessPublicKey: KeyObject,
    privacyReviewPrivateKey: KeyObject, privacyReviewPublicKey: KeyObject,
    decisionPrivateKey: KeyObject, decisionPublicKey: KeyObject,
    attemptPrivateKey: KeyObject, attemptPublicKey: KeyObject,
    stateStore?: SqliteSnapshotStore, stateEncryptionKey?: Buffer) {
    this.#issuer = options.issuer
    this.#keyId = options.keyId
    this.#now = options.now
    this.#privateKey = privateKey
    this.#publicKey = publicKey
    this.#freshnessPrivateKey = freshnessPrivateKey
    this.#freshnessPublicKey = freshnessPublicKey
    this.#freshnessKeyId = `${options.keyId}:approval-freshness`
    this.#privacyReviewPrivateKey = privacyReviewPrivateKey
    this.#privacyReviewPublicKey = privacyReviewPublicKey
    this.#privacyReviewKeyId = `${options.keyId}:privacy-review`
    this.#decisionPrivateKey = decisionPrivateKey
    this.#decisionPublicKey = decisionPublicKey
    this.#decisionKeyId = `${options.keyId}:decision`
    this.#attemptPrivateKey = attemptPrivateKey
    this.#attemptPublicKey = attemptPublicKey
    this.#attemptKeyId = `${options.keyId}:attempt-event`
    this.#stateStore = stateStore
    this.#stateEncryptionKey = stateEncryptionKey
    this.#identityDigest = authorityIdentityDigest(options)
    this.#authenticateApproverSession = options.authenticateApproverSession ?? (() => undefined)
  }

  static create(options: LocalApprovalAuthorityOptions): LocalApprovalAuthority {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const freshness = generateKeyPairSync('ed25519')
    const privacyReview = generateKeyPairSync('ed25519')
    const decision = generateKeyPairSync('ed25519')
    const attempt = generateKeyPairSync('ed25519')
    const authority = new LocalApprovalAuthority(options, privateKey, publicKey,
      freshness.privateKey, freshness.publicKey, privacyReview.privateKey, privacyReview.publicKey,
      decision.privateKey, decision.publicKey, attempt.privateKey, attempt.publicKey)
    authority.#registerIdentities(options)
    return authority
  }

  static async open(options: LocalApprovalAuthorityOptions & {
    statePath: string
    stateEncryptionKey: Uint8Array
    testWorkspaceRoots: string[]
  }): Promise<LocalApprovalAuthority> {
    const stateEncryptionKey = Buffer.from(options.stateEncryptionKey)
    if (stateEncryptionKey.byteLength !== 32) {
      throw authorityError('E2E_AUTHORITY_STATE_ENCRYPTION_KEY_INVALID', 'Authority 状态加密密钥必须为 32 bytes')
    }
    const store = new SqliteSnapshotStore(options.statePath, `approval:${options.issuer}:${options.keyId}`, {
      forbiddenRoots: options.testWorkspaceRoots,
    })
    const primary = generateKeyPairSync('ed25519')
    const freshness = generateKeyPairSync('ed25519')
    const privacyReview = generateKeyPairSync('ed25519')
    const decision = generateKeyPairSync('ed25519')
    const attempt = generateKeyPairSync('ed25519')
    const initial: AuthorityPersistentSnapshot = {
      schemaVersion: '2.1.0', issuer: options.issuer, keyId: options.keyId,
      identityDigest: authorityIdentityDigest(options),
      privateKeys: {
        primary: encryptPrivateKey(primary.privateKey, stateEncryptionKey, 'primary'),
        freshness: encryptPrivateKey(freshness.privateKey, stateEncryptionKey, 'freshness'),
        privacyReview: encryptPrivateKey(privacyReview.privateKey, stateEncryptionKey, 'privacyReview'),
        decision: encryptPrivateKey(decision.privateKey, stateEncryptionKey, 'decision'),
        attempt: encryptPrivateKey(attempt.privateKey, stateEncryptionKey, 'attempt'),
      },
      webAuthnCredentials: encryptWebAuthnCredentials([], stateEncryptionKey),
      grants: [], revoked: [], uses: [], reservations: [], completedPreflights: [], manualResultIds: [], attemptLogs: [],
    }
    store.initialize(canonicalizeJson(initial))
    let snapshot: AuthorityPersistentSnapshot
    try {
      const migration = migrateAuthoritySnapshot(store.begin(), stateEncryptionKey)
      snapshot = migration.snapshot
      if (migration.migrated) store.commit(canonicalizeJson(snapshot))
      else store.rollback()
    } catch (error) {
      store.rollback()
      store.close()
      stateEncryptionKey.fill(0)
      throw error
    }
    if (snapshot.issuer !== options.issuer || snapshot.keyId !== options.keyId
      || snapshot.identityDigest !== authorityIdentityDigest(options)) {
      store.close()
      throw authorityError('E2E_AUTHORITY_STATE_IDENTITY_MISMATCH', '持久 Authority 的 issuer、keyId 或可信身份注册表不匹配')
    }
    let primaryPrivate: KeyObject
    let freshnessPrivate: KeyObject
    let privacyPrivate: KeyObject
    let decisionPrivate: KeyObject
    let attemptPrivate: KeyObject
    try {
      primaryPrivate = decryptPrivateKey(snapshot.privateKeys.primary, stateEncryptionKey, 'primary')
      freshnessPrivate = decryptPrivateKey(snapshot.privateKeys.freshness, stateEncryptionKey, 'freshness')
      privacyPrivate = decryptPrivateKey(snapshot.privateKeys.privacyReview, stateEncryptionKey, 'privacyReview')
      decisionPrivate = decryptPrivateKey(snapshot.privateKeys.decision, stateEncryptionKey, 'decision')
      attemptPrivate = decryptPrivateKey(snapshot.privateKeys.attempt, stateEncryptionKey, 'attempt')
    } catch {
      store.close()
      throw authorityError('E2E_AUTHORITY_STATE_DECRYPTION_FAILED', 'Authority 状态密钥错误或私钥密文已损坏')
    }
    const authority = new LocalApprovalAuthority(
      options, primaryPrivate, createPublicKey(primaryPrivate), freshnessPrivate, createPublicKey(freshnessPrivate),
      privacyPrivate, createPublicKey(privacyPrivate), decisionPrivate, createPublicKey(decisionPrivate),
      attemptPrivate, createPublicKey(attemptPrivate), store, stateEncryptionKey,
    )
    authority.#registerIdentities(options)
    authority.#hydrateState(snapshot)
    return authority
  }

  close(): void {
    if (this.#activeStateTransactions !== 0) throw authorityError('E2E_AUTHORITY_STATE_BUSY', 'Authority 事务进行中不能关闭')
    this.#stateStore?.close()
    this.#stateEncryptionKey?.fill(0)
  }

  createWriteExecutionClient(): TrustedWriteApprovalClient {
    const client: TrustedWriteApprovalClient = Object.freeze({
      verifyForSubject: (grant: SignedWriteGrant, currentSubject: WriteApprovalSubject) =>
        this.verifyForSubject(grant, currentSubject),
    })
    return trustWriteApprovalClient(client, { transport: 'in-process-test' })
  }

  createWebAuthnCredentialRepository(): WebAuthnCredentialRepository {
    return Object.freeze({
      list: async () => await this.#withStateRead(async () =>
        [...this.#webAuthnCredentials.values()].map((credential) => structuredClone(credential))),
      get: async (credentialId: string) => await this.#withStateRead(async () => {
        const credential = this.#webAuthnCredentials.get(credentialId)
        return credential === undefined ? undefined : structuredClone(credential)
      }),
      insert: async (candidate: StoredWebAuthnCredential) => await this.#withStateMutation(async () => {
        const credential = parseStoredWebAuthnCredential(candidate)
        if (this.#webAuthnCredentials.has(credential.id)) {
          throw authorityError('E2E_APPROVAL_CREDENTIAL_DUPLICATE', 'WebAuthn credential 已登记')
        }
        this.#webAuthnCredentials.set(credential.id, credential)
      }),
      compareAndSet: async (
        expectedCandidate: StoredWebAuthnCredential,
        nextCandidate: StoredWebAuthnCredential,
      ) => await this.#withStateMutation(async () => {
        const expected = parseStoredWebAuthnCredential(expectedCandidate)
        const next = parseStoredWebAuthnCredential(nextCandidate)
        const current = this.#webAuthnCredentials.get(expected.id)
        if (current === undefined || canonicalizeJson(current) !== canonicalizeJson(expected)
          || next.id !== expected.id || next.subject !== expected.subject
          || next.publicKey !== expected.publicKey
          || canonicalizeJson(next.transports) !== canonicalizeJson(expected.transports)
          || next.counter <= expected.counter) {
          throw authorityError(
            'E2E_APPROVAL_CREDENTIAL_STATE_CONFLICT',
            'WebAuthn credential CAS 失败或 counter 未严格递增',
          )
        }
        this.#webAuthnCredentials.set(next.id, next)
      }),
    })
  }

  async issueDiscoveryGrant(input: {
    subject: DiscoveryApprovalSubject
    approver: ApproverIdentity
    approvalSessionRef?: string
    approvalSessionBinding?: WebAuthnApprovalBinding
    ttlMs: number
  }): Promise<SignedDiscoveryGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueDiscoveryGrant(input))
    }
    const request = immutableSnapshot(input)
    this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      request.approvalSessionBinding, request.ttlMs, MAX_DISCOVERY_TTL_MS)
    validateDiscoverySubject(request.subject)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedDiscoveryGrant, 'signature'> = {
      grantId: randomUUID(), issuer: this.#issuer, keyId: this.#keyId, proofScope: 'local-os-user',
      approver: { subject: request.approver.subject, roles: [...request.approver.roles].sort() },
      subject: request.subject,
      subjectDigest: digestText('approval-subject/v1', canonicalizeJson(request.subject)),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: request.subject.actions.map((action): DiscoveryCapability => ({
        capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'), transport: 'browser-local',
        effect: 'read', actionId: action.actionId, operation: action.operation,
        targetUrl: request.subject.expectedPageIdentity.url, actor: request.subject.actor,
        expectedPageIdentityDigest: digestText(
          'expected-page-identity/v1', canonicalizeJson(request.subject.expectedPageIdentity),
        ),
        bootstrapIntentsDigest: request.subject.bootstrapIntentsDigest,
        maxUses: action.maxUses,
      })),
      revocationSequence: 0,
    }
    const grant: SignedDiscoveryGrant = {
      ...grantWithoutSignature,
      signature: signPayload(grantWithoutSignature, this.#privateKey),
    }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueReadGrant(input: {
    subject: ReadApprovalSubject
    approver: ApproverIdentity
    approvalSessionRef?: string
    approvalSessionBinding?: WebAuthnApprovalBinding
    ttlMs: number
  }): Promise<SignedReadGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueReadGrant(input))
    }
    const request = immutableSnapshot(input)
    const parsedSubject = ReadApprovalSubjectSchema.safeParse(request.subject)
    if (!parsedSubject.success) {
      throw authorityError('E2E_APPROVAL_READ_SUBJECT_INVALID', 'Read approval subject 必须满足 v2 严格契约')
    }
    const subject = parsedSubject.data
    request.subject = subject
    const preflight = this.#completedPreflights.get(subject.preflightDigest)
    const discoveryGrant = preflight ? this.#grants.get(preflight.grantId) : undefined
    const discoveryDecision = discoveryGrant ? this.#verifyGrant(discoveryGrant) : undefined
    if (!preflight || preflight.status !== 'ready' || preflight.grantId !== subject.discoveryGrantId
      || !discoveryDecision?.allowed || !sameExecutionBoundary(preflight.subject, subject)) {
      throw authorityError(
        'E2E_APPROVAL_PREFLIGHT_REQUIRED',
        'Read Grant 必须引用同一 Asset、Revision、Scope、环境和 actor 的 ready Discovery preflight',
      )
    }
    this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      request.approvalSessionBinding, request.ttlMs, MAX_READ_TTL_MS)

    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedReadGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: { subject: request.approver.subject, roles: [...request.approver.roles].sort() },
      subject,
      subjectDigest: digestText('approval-subject/v1', canonicalizeJson(subject)),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: request.subject.actions.map((action): ReadCapability => ({
        capabilityId: randomUUID(),
        nonce: randomBytes(32).toString('hex'),
        transport: 'browser-local',
        effect: 'read',
        actionId: action.actionId,
        operation: action.operation,
        maxUses: action.maxUses,
      })),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedReadGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueWriteGrant(input: {
    subject: WriteApprovalSubject
    approver: ApproverIdentity
    approvalSessionRef?: string
    approvalSessionBinding?: WebAuthnApprovalBinding
    ttlMs: number
  }): Promise<SignedWriteGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueWriteGrant(input))
    }
    const request = immutableSnapshot(input)
    validateWriteSubject(request.subject)
    const parsedSubject = WriteApprovalSubjectV2Schema.safeParse(request.subject)
    if (!parsedSubject.success) {
      throw authorityError('E2E_APPROVAL_WRITE_SUBJECT_INVALID', 'Write approval subject 必须满足 v2 严格契约')
    }
    const subject = parsedSubject.data
    request.subject = subject
    const preflight = this.#completedPreflights.get(subject.preflightDigest)
    const discoveryGrant = preflight ? this.#grants.get(preflight.grantId) : undefined
    const discoveryDecision = discoveryGrant ? this.#verifyGrant(discoveryGrant) : undefined
    if (!preflight || preflight.status !== 'ready' || preflight.grantId !== subject.discoveryGrantId
      || !discoveryDecision?.allowed || !sameExecutionBoundary(preflight.subject, subject)) {
      throw authorityError(
        'E2E_APPROVAL_PREFLIGHT_REQUIRED',
        'Write Grant 必须引用同一 Asset、Revision、Scope、环境和 actor 的 ready Discovery preflight',
      )
    }
    this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      request.approvalSessionBinding, request.ttlMs, MAX_WRITE_TTL_MS)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedWriteGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: { subject: request.approver.subject, roles: [...request.approver.roles].sort() },
      subject,
      subjectDigest: digestText('approval-subject/v1', canonicalizeJson(subject)),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): ReversibleWriteCapability => ({
        capabilityId: randomUUID(),
        nonce: randomBytes(32).toString('hex'),
        transport: 'http',
        effect: 'reversible-write',
        operation: 'http-request',
        actionId: action.actionId,
        dataLeaseId: action.dataLeaseId,
        fencingToken: action.fencingToken,
        cleanupPlanDigest: action.cleanupPlanDigest,
        requests: action.requests.map((request) => ({ ...request, query: [...request.query], payload: { ...request.payload } })),
        maxUses: 1,
      })),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedWriteGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueInjectionGrant(input: {
    subject: InjectionApprovalSubject
    approver: ApproverIdentity
    approvalSessionRef?: string
    approvalSessionBinding?: WebAuthnApprovalBinding
    ttlMs: number
  }): Promise<SignedInjectionGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueInjectionGrant(input))
    }
    this.validateApproverAndTtl(input.approver, input.approvalSessionRef,
      input.approvalSessionBinding, input.ttlMs, MAX_INJECTION_TTL_MS)
    validateInjectionSubject(input.subject)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedInjectionGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: { subject: input.approver.subject, roles: [...input.approver.roles].sort() },
      subject: input.subject,
      subjectDigest: digestText('approval-subject/v1', canonicalizeJson(input.subject)),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      capabilities: input.subject.actions.map((action): InjectionCapability => ({
        capabilityId: randomUUID(),
        nonce: randomBytes(32).toString('hex'),
        transport: 'gateway-injection',
        actionId: action.actionId,
        caseId: action.caseId,
        runId: action.runId,
        attemptSlot: action.attemptSlot,
        request: copyHttpIntent(action.request),
        response: copyInjectionResponse(action.response),
        expectedMatches: action.expectedMatches,
        expectedOrder: action.expectedOrder,
        upstreamForwarding: 'forbidden',
        maxUses: action.expectedMatches,
      })),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedInjectionGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueWebSocketReadGrant(input: {
    subject: WebSocketReadApprovalSubject
    approver: ApproverIdentity
    approvalSessionRef?: string
    approvalSessionBinding?: WebAuthnApprovalBinding
    ttlMs: number
  }): Promise<SignedWebSocketReadGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueWebSocketReadGrant(input))
    }
    this.validateApproverAndTtl(input.approver, input.approvalSessionRef,
      input.approvalSessionBinding, input.ttlMs, MAX_READ_TTL_MS)
    validateWebSocketReadSubject(input.subject)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedWebSocketReadGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: { subject: input.approver.subject, roles: [...input.approver.roles].sort() },
      subject: input.subject,
      subjectDigest: digestText('approval-subject/v1', canonicalizeJson(input.subject)),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      capabilities: input.subject.actions.map((action): WebSocketReadCapability => ({
        capabilityId: randomUUID(),
        nonce: randomBytes(32).toString('hex'),
        transport: 'websocket',
        effect: 'read',
        actionId: action.actionId,
        origin: action.origin,
        path: action.path,
        maxInboundMessages: action.maxInboundMessages,
        maxBytes: action.maxBytes,
        maxUses: 1,
      })),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedWebSocketReadGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueSseReadGrant(input: {
    subject: SseReadApprovalSubject
    approver: ApproverIdentity
    approvalSessionRef?: string
    approvalSessionBinding?: WebAuthnApprovalBinding
    ttlMs: number
  }): Promise<SignedSseReadGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueSseReadGrant(input))
    }
    this.validateApproverAndTtl(input.approver, input.approvalSessionRef,
      input.approvalSessionBinding, input.ttlMs, MAX_READ_TTL_MS)
    validateSseReadSubject(input.subject)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedSseReadGrant, 'signature'> = {
      grantId: randomUUID(), issuer: this.#issuer, keyId: this.#keyId, proofScope: 'local-os-user',
      approver: { subject: input.approver.subject, roles: [...input.approver.roles].sort() },
      subject: input.subject,
      subjectDigest: digestText('approval-subject/v1', canonicalizeJson(input.subject)),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      capabilities: input.subject.actions.map((action): SseReadCapability => ({
        capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'), transport: 'sse', effect: 'read',
        actionId: action.actionId, origin: action.origin, exactPath: action.exactPath,
        query: [...action.query], maxReconnects: action.maxReconnects, maxUses: action.maxReconnects,
      })),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedSseReadGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async verify(grant: SignedGrant): Promise<GrantDecision> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateRead(() => this.verify(grant))
    }
    return this.#verifyGrant(grant)
  }

  #verifyGrant(grant: SignedGrant): GrantDecision {
    const signatureDecision = this.#verifyGrantSignature(grant)
    if (!signatureDecision.allowed) return signatureDecision
    if (this.#revoked.has(grant.grantId)) return denied('E2E_APPROVAL_REVOKED', 'Grant 已撤销')
    if (this.#now().getTime() >= Date.parse(grant.expiresAt)) return denied('E2E_APPROVAL_EXPIRED', 'Grant 已过期')
    return { allowed: true }
  }

  #verifyGrantSignature(grant: SignedGrant): GrantDecision {
    if (grant.keyId !== this.#keyId || grant.issuer !== this.#issuer) {
      return denied('E2E_APPROVAL_KEY_UNKNOWN', 'Grant issuer 或 keyId 不受信任')
    }
    const { signature, ...payload } = grant
    if (!verify(null, Buffer.from(canonicalizeJson(payload)), this.#publicKey, Buffer.from(signature, 'base64url'))) {
      return denied('E2E_APPROVAL_SIGNATURE_INVALID', 'Grant 签名无效')
    }
    return { allowed: true }
  }

  async verifyForSubject(grant: SignedGrant, currentSubject: SignedGrant['subject']): Promise<GrantDecision> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateRead(() => this.verifyForSubject(grant, currentSubject))
    }
    const grantDecision = await this.verify(grant)
    if (!grantDecision.allowed) return grantDecision
    let currentDigest: string
    try {
      currentDigest = digestText('approval-subject/v1', canonicalizeJson(currentSubject))
    } catch {
      return denied('E2E_APPROVAL_SUBJECT_INVALID', '当前审批主题不是可确定序列化的合法输入')
    }
    if (currentDigest !== grant.subjectDigest) {
      return denied('E2E_APPROVAL_SUBJECT_MISMATCH', '旧 Grant 未绑定当前的 Revision、环境、对象和请求内容')
    }
    return { allowed: true }
  }

  async issueApprovalFreshnessReceipt(input: {
    grant: SignedGrant
    currentSubject: SignedGrant['subject']
    expectedCapabilities: ApprovalCapabilityRecord[]
    browserPreflight: {
      artifactDigest: string
      discoveryGrantId: string
      authorityPreflightDigest: string
    }
    runBundle: { artifactDigest: string; content: unknown }
  }): Promise<ApprovalFreshnessReceipt> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateRead(() => this.issueApprovalFreshnessReceipt(input))
    }
    const request = immutableSnapshot(input)
    const stored = this.#grants.get(request.grant.grantId)
    if (!stored || canonicalizeJson(stored) !== canonicalizeJson(request.grant)) {
      throw authorityError('E2E_APPROVAL_FRESHNESS_GRANT_UNKNOWN', 'Freshness receipt 只能为 Authority 当前 store 中的原始 Grant 签发')
    }
    const readSubject = ReadApprovalSubjectSchema.safeParse(request.currentSubject)
    const writeSubject = WriteApprovalSubjectV2Schema.safeParse(request.currentSubject)
    const subjectResult = readSubject.success ? readSubject : writeSubject
    const grantType = readSubject.success && isReadGrant(stored) ? 'read' as const
      : writeSubject.success && isWriteGrant(stored) ? 'reversible-write' as const : undefined
    if (!subjectResult.success || !grantType) {
      throw authorityError('E2E_APPROVAL_FRESHNESS_GRANT_KIND_UNSUPPORTED', 'freshness receipt 仅接受严格 Read 或 v2 reversible-write Grant')
    }
    const signatureDecision = this.#verifyGrantSignature(stored)
    if (!signatureDecision.allowed) throw authorityError(signatureDecision.code, signatureDecision.reason)
    if (digestText('approval-subject/v1', canonicalizeJson(subjectResult.data)) !== stored.subjectDigest) {
      throw authorityError('E2E_APPROVAL_SUBJECT_MISMATCH', '当前审批主题与 Grant 不一致')
    }
    const preflight = this.#completedPreflights.get(request.browserPreflight.authorityPreflightDigest)
    if (!preflight || preflight.status !== 'ready'
      || preflight.grantId !== request.browserPreflight.discoveryGrantId
      || subjectResult.data.discoveryGrantId !== request.browserPreflight.discoveryGrantId
      || subjectResult.data.preflightDigest !== request.browserPreflight.authorityPreflightDigest
      || !isDigest(request.browserPreflight.artifactDigest)) {
      throw authorityError('E2E_APPROVAL_FRESHNESS_PREFLIGHT_MISMATCH', 'browser-preflight 必须绑定 Authority 已完成的 ready Discovery outcome')
    }
    const expectedCapabilities = normalizeCapabilityRecords(request.expectedCapabilities)
    const actualCapabilities = normalizeCapabilityRecords(stored.capabilities.map(toApprovalCapabilityRecord))
    if (canonicalizeJson(expectedCapabilities) !== canonicalizeJson(actualCapabilities)) {
      throw authorityError('E2E_APPROVAL_FRESHNESS_CAPABILITY_MISMATCH', 'RunBundle capability records 与真实 Grant 不一致')
    }
    if (!isDigest(request.runBundle.artifactDigest)
      || digestApprovalProjection('run-bundle', request.runBundle.content)
        !== subjectResult.data.runBundleProjectionDigest) {
      throw authorityError('E2E_APPROVAL_FRESHNESS_RUN_BUNDLE_MISMATCH', '最终 RunBundle 未匹配执行前批准的完整安全投影')
    }
    const revoked = this.#revoked.has(stored.grantId)
    const expired = this.#now().getTime() >= Date.parse(stored.expiresAt)
    const status = revoked ? 'revoked' as const : expired ? 'expired' as const : 'valid' as const
    const body = {
      schemaVersion: '1.0.0' as const,
      grantType,
      grantId: stored.grantId,
      subjectDigest: stored.subjectDigest,
      runBundleDigest: request.runBundle.artifactDigest,
      executionSubjectSnapshot: subjectResult.data,
      browserPreflightArtifactDigest: request.browserPreflight.artifactDigest,
      capabilities: actualCapabilities,
      capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(actualCapabilities)),
      expiresAt: stored.expiresAt,
      checkedAt: this.#now().toISOString(),
      revocationSequence: stored.revocationSequence,
      status,
      reasonCodes: status === 'valid' ? [] : [status === 'revoked' ? 'E2E_APPROVAL_REVOKED' : 'E2E_APPROVAL_EXPIRED'],
    }
    const signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(body))
    return ApprovalFreshnessReceiptSchema.parse({
      ...body,
      authorityProof: {
        purpose: 'approval-freshness-receipt/v1', issuer: this.#issuer, keyId: this.#freshnessKeyId,
        algorithm: 'Ed25519', signedDigest,
        signature: sign(null, approvalFreshnessProofPayload(this.#issuer, this.#freshnessKeyId, signedDigest), this.#freshnessPrivateKey)
          .toString('base64url'),
      },
    })
  }

  verifyApprovalFreshnessReceipt(input: {
    receipt: ApprovalFreshnessReceipt
    currentSubject: SignedGrant['subject']
    expectedCapabilities: ApprovalCapabilityRecord[]
    browserPreflight: {
      artifactDigest: string
      discoveryGrantId: string
      authorityPreflightDigest: string
    }
    runBundle: { artifactDigest: string; content: unknown }
  }): ApprovalFreshnessVerification {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateReadSync(() => this.verifyApprovalFreshnessReceipt(input))
    }
    const parsed = ApprovalFreshnessReceiptSchema.safeParse(input.receipt)
    const readSubject = ReadApprovalSubjectSchema.safeParse(input.currentSubject)
    const writeSubject = WriteApprovalSubjectV2Schema.safeParse(input.currentSubject)
    const subject = readSubject.success ? readSubject : writeSubject
    const invalid = (): ApprovalFreshnessVerification => ({ authentic: false, current: false, allowed: false, status: 'invalid' })
    if (!parsed.success || !subject.success) return invalid()
    const receipt = parsed.data
    const proof = receipt.authorityProof
    if (proof.issuer !== this.#issuer || proof.keyId !== this.#freshnessKeyId || proof.algorithm !== 'Ed25519'
      || proof.purpose !== 'approval-freshness-receipt/v1') return invalid()
    try {
      if (!verify(null, approvalFreshnessProofPayload(proof.issuer, proof.keyId, proof.signedDigest),
        this.#freshnessPublicKey, Buffer.from(proof.signature, 'base64url'))) return invalid()
    } catch { return invalid() }
    const stored = this.#grants.get(receipt.grantId)
    const expectedGrantType = stored && isReadGrant(stored) ? 'read'
      : stored && isWriteGrant(stored) ? 'reversible-write' : undefined
    if (!stored || !expectedGrantType || receipt.grantType !== expectedGrantType
      || !this.#verifyGrantSignature(stored).allowed) return invalid()
    const now = this.#now().getTime()
    if (now < Date.parse(receipt.checkedAt)) return invalid()
    const currentStatus = this.#revoked.has(stored.grantId) ? 'revoked'
      : now >= Date.parse(stored.expiresAt) ? 'expired' : 'valid'
    if (receipt.status !== currentStatus) return invalid()
    const preflight = this.#completedPreflights.get(input.browserPreflight.authorityPreflightDigest)
    if (!preflight || preflight.status !== 'ready'
      || preflight.grantId !== input.browserPreflight.discoveryGrantId
      || input.browserPreflight.discoveryGrantId !== subject.data.discoveryGrantId
      || input.browserPreflight.authorityPreflightDigest !== subject.data.preflightDigest
      || input.browserPreflight.artifactDigest !== receipt.browserPreflightArtifactDigest) return invalid()
    let runBundleProjectionDigest: string
    try { runBundleProjectionDigest = digestApprovalProjection('run-bundle', input.runBundle.content) } catch { return invalid() }
    if (input.runBundle.artifactDigest !== receipt.runBundleDigest
      || runBundleProjectionDigest !== subject.data.runBundleProjectionDigest) return invalid()
    let expected: ApprovalCapabilityRecord[]
    try { expected = normalizeCapabilityRecords(input.expectedCapabilities) } catch { return invalid() }
    let actual: ApprovalCapabilityRecord[]
    try {
      actual = normalizeCapabilityRecords(stored.capabilities.map(toApprovalCapabilityRecord))
    } catch { return invalid() }
    const authentic = receipt.grantId === stored.grantId
      && receipt.subjectDigest === stored.subjectDigest
      && receipt.expiresAt === stored.expiresAt
      && receipt.revocationSequence === stored.revocationSequence
      && canonicalizeJson(receipt.executionSubjectSnapshot) === canonicalizeJson(subject.data)
      && canonicalizeJson(stored.subject) === canonicalizeJson(subject.data)
      && canonicalizeJson(receipt.capabilities) === canonicalizeJson(actual)
      && canonicalizeJson(expected) === canonicalizeJson(actual)
    return authentic ? { authentic: true, current: true, allowed: currentStatus === 'valid', status: currentStatus }
      : invalid()
  }

  async revoke(grantId: string, reason: string): Promise<void> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.revoke(grantId, reason))
    }
    if (!this.#grants.has(grantId)) throw authorityError('E2E_APPROVAL_GRANT_UNKNOWN', 'Grant 不存在')
    this.#revoked.set(grantId, reason)
  }

  async reserveForSubject(input: {
    grant: SignedGrant
    currentSubject: SignedGrant['subject']
    capabilityId: string
    actionId: string
    attemptId: string
    attemptContext?: AttemptExecutionContext
  }): Promise<CapabilityReservation> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.reserveForSubject(input))
    }
    const grant = immutableSnapshot<SignedGrant>(input.grant)
    const currentSubject = immutableSnapshot<SignedGrant['subject']>(input.currentSubject)
    const decision = await this.verifyForSubject(grant, currentSubject)
    if (!decision.allowed) throw authorityError(decision.code, decision.reason)
    return await this.#reserveVerified({
      grantId: grant.grantId,
      capabilityId: input.capabilityId,
      actionId: input.actionId,
      attemptId: input.attemptId,
      attemptContext: input.attemptContext,
    })
  }

  async completeDiscoveryPreflight(input: {
    grant: SignedDiscoveryGrant
    currentSubject: DiscoveryApprovalSubject
    reservationId: string
    capabilityId: string
    outcome: DiscoveryPreflightOutcome
  }): Promise<string> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.completeDiscoveryPreflight(input))
    }
    const grant = immutableSnapshot<SignedDiscoveryGrant>(input.grant)
    const currentSubject = immutableSnapshot<DiscoveryApprovalSubject>(input.currentSubject)
    const outcome = immutableSnapshot<DiscoveryPreflightOutcome>(input.outcome)
    const decision = await this.verifyForSubject(grant, currentSubject)
    if (!decision.allowed) throw authorityError(decision.code, decision.reason)
    const reservation = this.#reservations.get(input.reservationId)
    if (!reservation || reservation.grantId !== grant.grantId
      || reservation.capabilityId !== input.capabilityId || reservation.status !== 'reserved') {
      throw authorityError('E2E_APPROVAL_PREFLIGHT_RESERVATION_INVALID', 'Discovery preflight reservation 无效')
    }
    const capability = grant.capabilities.find((candidate) =>
      candidate.capabilityId === input.capabilityId && candidate.operation === 'local-navigation')
    if (!capability) {
      throw authorityError('E2E_APPROVAL_PREFLIGHT_CAPABILITY_INVALID', 'Discovery preflight capability 无效')
    }
    if (outcome.status === 'ready' && !matchesReadyPreflight(currentSubject, outcome)) {
      throw authorityError('E2E_APPROVAL_PREFLIGHT_RESULT_INVALID', 'ready preflight 与批准页面身份不一致')
    }
    const preflightDigest = digestText('browser-preflight-result/v1', canonicalizeJson({
      grantId: grant.grantId, subjectDigest: grant.subjectDigest, capabilityId: capability.capabilityId,
      ...outcome, reservationId: reservation.reservationId,
    }))
    await this.complete(reservation.reservationId, preflightDigest)
    this.#completedPreflights.set(preflightDigest, {
      grantId: grant.grantId, subject: currentSubject, status: outcome.status,
    })
    return preflightDigest
  }

  async #reserveVerified(input: {
    grantId: string
    capabilityId: string
    actionId: string
    attemptId: string
    attemptContext?: AttemptExecutionContext
  }): Promise<CapabilityReservation> {
    const grant = this.#grants.get(input.grantId)
    if (!grant) throw authorityError('E2E_APPROVAL_GRANT_UNKNOWN', 'Grant 不存在')
    const decision = await this.verify(grant)
    if (!decision.allowed) throw authorityError(decision.code, decision.reason)
    const capability = grant.capabilities.find((item) => item.capabilityId === input.capabilityId && item.actionId === input.actionId)
    if (!capability) throw authorityError('E2E_APPROVAL_CAPABILITY_UNKNOWN', 'Capability 不属于该 Grant 或 Action')
    if ('effect' in capability && capability.effect === 'reversible-write'
      && (!input.attemptContext
        || input.attemptContext.assetId !== grant.subject.assetId
        || input.attemptContext.prdRevision !== grant.subject.prdRevision
        || Object.values(input.attemptContext).some((value) => !value))) {
      throw authorityError('E2E_APPROVAL_ATTEMPT_CONTEXT_INVALID', '写 capability reservation 必须绑定完整同代 Attempt 上下文')
    }

    const key = `${grant.grantId}:${capability.capabilityId}`
    const used = this.#uses.get(key) ?? 0
    if (used >= capability.maxUses) throw authorityError('E2E_APPROVAL_CAPABILITY_EXHAUSTED', 'Capability 使用次数已耗尽')
    this.#uses.set(key, used + 1)

    const reservation: CapabilityReservation = {
      reservationId: randomUUID(),
      grantId: grant.grantId,
      capabilityId: capability.capabilityId,
      actionId: capability.actionId,
      attemptId: input.attemptId,
      ...(input.attemptContext ? { attemptContext: immutableSnapshot(input.attemptContext) } : {}),
      status: 'reserved',
      reservedAt: this.#now().toISOString(),
    }
    this.#reservations.set(reservation.reservationId, reservation)
    return { ...reservation }
  }

  async markUnknown(reservationId: string, observation: string): Promise<void> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.markUnknown(reservationId, observation))
    }
    const reservation = this.#reservations.get(reservationId)
    if (!reservation) throw authorityError('E2E_APPROVAL_RESERVATION_UNKNOWN', 'Reservation 不存在')
    if (reservation.status !== 'reserved') throw authorityError('E2E_APPROVAL_RESERVATION_FINAL', 'Reservation 已进入终态')
    reservation.status = 'unknown'
    reservation.observation = observation
  }

  async complete(reservationId: string, outcomeDigest: string): Promise<void> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.complete(reservationId, outcomeDigest))
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(outcomeDigest)) {
      throw authorityError('E2E_APPROVAL_OUTCOME_DIGEST_INVALID', 'Outcome digest 无效')
    }
    const reservation = this.#reservations.get(reservationId)
    if (!reservation) throw authorityError('E2E_APPROVAL_RESERVATION_UNKNOWN', 'Reservation 不存在')
    if (reservation.status !== 'reserved') throw authorityError('E2E_APPROVAL_RESERVATION_FINAL', 'Reservation 已进入终态')
    reservation.status = 'completed'
    reservation.outcomeDigest = outcomeDigest
  }

  getReservation(reservationId: string): CapabilityReservation | undefined {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateReadSync(() => this.getReservation(reservationId))
    }
    const reservation = this.#reservations.get(reservationId)
    return reservation ? { ...reservation } : undefined
  }

  appendAttemptEvent(input: {
    context: { assetId: string; generationId: string; prdRevision: string; runId: string; caseId: string }
    event: AppendAttemptEventInput
  }): { event: AttemptEvent; eventChainDigest: string } {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateMutationSync(() => this.appendAttemptEvent(input))
    }
    const request = immutableSnapshot(input)
    const { context, event: eventCore } = request
    if (Object.values(context).some((value) => typeof value !== 'string' || value.length === 0)
      || eventCore.caseId !== context.caseId) {
      throw authorityError('E2E_ATTEMPT_AUTHORITY_CONTEXT_INVALID', 'Attempt 事件必须绑定完整同代 run/case 上下文')
    }
    const logKey = canonicalizeJson(context)
    const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(context))
    const existing = this.#attemptLogs.get(logKey)
    const expectedSequence = (existing?.events.length ?? 0) + 1
    const expectedPrevious = existing?.chainDigest ?? initialChainDigest
    if (eventCore.sequence !== expectedSequence) {
      throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_SEQUENCE_INVALID', 'Attempt Authority 日志 sequence 必须连续')
    }
    if (eventCore.previousChainDigest !== expectedPrevious) {
      throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_CHAIN_INVALID', 'Attempt Authority 日志 previousChainDigest 不匹配')
    }
    const timestamp = Date.parse(eventCore.timestamp)
    if (!Number.isSafeInteger(eventCore.slot) || eventCore.slot < 0 || Number.isNaN(timestamp)
      || (existing && timestamp < existing.lastTimestamp)) {
      throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_EVENT_INVALID', 'Attempt Authority 事件 slot 或时间无效')
    }
    const previous = existing?.events.at(-1)
    if (!previous) {
      if (eventCore.kind !== 'started' || eventCore.slot !== 0) {
        throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_TRANSITION_INVALID', 'Attempt 日志必须从 slot 0 started 开始')
      }
    } else if (eventCore.kind === 'terminal') {
      if (previous.kind !== 'started' || previous.slot !== eventCore.slot
        || previous.attemptId !== eventCore.attemptId || previous.mode !== eventCore.result.mode) {
        throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_TRANSITION_INVALID', 'terminal 必须紧随同一 started')
      }
      if (['passed', 'failed'].includes(eventCore.result.status)
        && ![...this.#reservations.values()].some((reservation) => {
          if (reservation.reservationId !== eventCore.result.reservationId
            || reservation.outcomeDigest !== eventCore.result.outcomeDigest) return false
          if (reservation.status !== 'completed' || !reservation.outcomeDigest) return false
          const grant = this.#grants.get(reservation.grantId)
          const capability = grant?.capabilities.find((candidate) =>
            candidate.capabilityId === reservation.capabilityId
            && candidate.actionId === reservation.actionId)
          if (!grant || !capability || grant.subject.assetId !== context.assetId
            || grant.subject.prdRevision !== context.prdRevision) return false
          if (eventCore.result.effect !== 'read') {
            return reservation.attemptId === eventCore.attemptId && reservation.attemptContext !== undefined
              && canonicalizeJson(reservation.attemptContext) === canonicalizeJson(context)
              && 'effect' in capability && capability.effect === eventCore.result.effect
          }
          if (eventCore.result.mode === 'gateway-injection') {
            return reservation.attemptId.startsWith(`${eventCore.attemptId}:`)
              && capability.transport === 'gateway-injection'
              && capability.runId === context.runId
              && capability.caseId === context.caseId
          }
          return reservation.attemptId === eventCore.attemptId
            && 'effect' in capability && capability.effect === 'read'
            && 'requirementModelDigest' in grant.subject
        })) {
        throw authorityError('E2E_ATTEMPT_OUTCOME_UNATTESTED', '执行结果必须绑定同上下文的 Authority completed reservation')
      }
    } else if (previous.kind !== 'terminal' || eventCore.slot !== previous.slot + 1
      || (existing?.events.some((event) => event.kind === 'started' && event.attemptId === eventCore.attemptId) ?? false)) {
      throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_TRANSITION_INVALID', '下一 slot 必须紧随前一 terminal 且 attemptId 唯一')
    }
    const eventDigest = digestText('attempt-event/v1', canonicalizeJson(eventCore))
    const payload = canonicalizeJson({ purpose: ATTEMPT_EVENT_PROOF_PURPOSE, issuer: this.#issuer,
      keyId: this.#attemptKeyId, signedDigest: eventDigest })
    const authorityProof: AttemptEventAuthorityProof = {
      purpose: ATTEMPT_EVENT_PROOF_PURPOSE,
      issuer: this.#issuer,
      keyId: this.#attemptKeyId,
      algorithm: 'Ed25519',
      signedDigest: eventDigest,
      signature: sign(null, Buffer.from(payload), this.#attemptPrivateKey).toString('base64url'),
    }
    const event = { ...eventCore, eventDigest, authorityProof } as AttemptEvent
    const eventChainDigest = digestText('attempt-event-chain/v1', canonicalizeJson({
      previous: eventCore.previousChainDigest, event: eventDigest,
    }))
    this.#attemptLogs.set(logKey, {
      chainDigest: eventChainDigest,
      events: [...(existing?.events ?? []), event],
      lastTimestamp: timestamp,
    })
    return { event: immutableSnapshot(event), eventChainDigest }
  }

  verifyAttemptEventProof(proof: AttemptEventAuthorityProof): boolean {
    if (
      proof.purpose !== ATTEMPT_EVENT_PROOF_PURPOSE
      || proof.issuer !== this.#issuer
      || proof.keyId !== this.#attemptKeyId
      || proof.algorithm !== 'Ed25519'
      || !/^sha256:[a-f0-9]{64}$/.test(proof.signedDigest)
    ) return false
    const payload = canonicalizeJson({ purpose: ATTEMPT_EVENT_PROOF_PURPOSE, issuer: proof.issuer,
      keyId: proof.keyId, signedDigest: proof.signedDigest })
    try {
      return verify(null, Buffer.from(payload), this.#attemptPublicKey, Buffer.from(proof.signature, 'base64url'))
    } catch {
      return false
    }
  }

  get attemptEventVerifierMaterial(): AttemptEventVerifierMaterial {
    const spki = this.#attemptPublicKey.export({ type: 'spki', format: 'der' })
    return AttemptEventVerifierMaterialSchema.parse({
      schemaVersion: '1.0.0', purpose: ATTEMPT_EVENT_PROOF_PURPOSE, issuer: this.#issuer,
      keyId: this.#attemptKeyId, algorithm: 'Ed25519', publicKeySpki: spki.toString('base64url'),
      publicKeyDigest: digestBytes('attempt-event-public-key/v1', spki),
    })
  }

  signArtifactDigest(signedDigest: string): ArtifactSignature {
    if (!/^sha256:[a-f0-9]{64}$/.test(signedDigest)) {
      throw authorityError('E2E_ARTIFACT_DIGEST_INVALID', 'Artifact 摘要无效')
    }
    const signature: ArtifactSignature = {
      issuer: this.#issuer,
      keyId: this.#keyId,
      algorithm: 'Ed25519',
      signedDigest,
      signature: sign(null, artifactProofPayload(this.#issuer, this.#keyId, signedDigest), this.#privateKey)
        .toString('base64url'),
    }
    return signature
  }

  get artifactVerifierMaterial(): ArtifactAuthorityVerifierMaterial {
    const spki = this.#publicKey.export({ type: 'spki', format: 'der' })
    return ArtifactAuthorityVerifierMaterialSchema.parse({
      issuer: this.#issuer,
      keyId: this.#keyId,
      purpose: 'artifact-authority-signature/v1',
      algorithm: 'Ed25519',
      publicKeySpkiBase64: spki.toString('base64'),
      publicKeyDigest: digestBytes('artifact-authority-public-key/v1', spki),
    })
  }

  get approvalFreshnessVerifierMaterial(): ApprovalFreshnessVerifierMaterial {
    const spki = this.#freshnessPublicKey.export({ type: 'spki', format: 'der' })
    return ApprovalFreshnessVerifierMaterialSchema.parse({
      schemaVersion: '1.0.0', purpose: 'approval-freshness-receipt/v1', issuer: this.#issuer,
      keyId: this.#freshnessKeyId, algorithm: 'Ed25519', publicKeySpkiBase64: spki.toString('base64'),
      publicKeyDigest: digestBytes('approval-freshness-public-key/v1', spki),
    })
  }

  createTrustedApprovalFreshnessClient(): TrustedApprovalFreshnessClient {
    return registerTrustedApprovalFreshnessClient((receipt) => {
      if (this.#stateStore && !this.#stateContext.getStore()) {
        return this.#withStateReadSync(() => this.#isApprovalFreshnessReceiptCurrent(receipt))
      }
      return this.#isApprovalFreshnessReceiptCurrent(receipt)
    })
  }

  #isApprovalFreshnessReceiptCurrent(receipt: ApprovalFreshnessReceipt): boolean {
    const parsed = ApprovalFreshnessReceiptSchema.safeParse(receipt)
    if (!parsed.success) return false
    const material = this.approvalFreshnessVerifierMaterial
    if (!createApprovalFreshnessVerifier(material, material.publicKeyDigest)(parsed.data)) return false
    const stored = this.#grants.get(parsed.data.grantId)
    if (!stored || !this.#verifyGrantSignature(stored).allowed
      || stored.subjectDigest !== parsed.data.subjectDigest
      || stored.revocationSequence !== parsed.data.revocationSequence
      || this.#revoked.has(stored.grantId)
      || this.#now().getTime() >= Date.parse(stored.expiresAt)
      || parsed.data.status !== 'valid') return false
    return true
  }

  verifyArtifactSignature(signature: ArtifactSignature): boolean {
    if (signature.issuer !== this.#issuer || signature.keyId !== this.#keyId
      || signature.algorithm !== 'Ed25519' || !/^sha256:[a-f0-9]{64}$/.test(signature.signedDigest)) return false
    try {
      return verify(
        null,
        artifactProofPayload(signature.issuer, signature.keyId, signature.signedDigest),
        this.#publicKey,
        Buffer.from(signature.signature, 'base64url'),
      )
    } catch {
      return false
    }
  }

  verifyArtifact(artifact: ArtifactDocument): boolean {
    return artifact.signatures.length > 0 && artifact.signatures.every((signature) =>
      signature.signedDigest === artifact.contentDigest && this.verifyArtifactSignature(signature))
  }

  issueDecisionReceipt(input: {
    kind: 'scope' | 'lineage' | 'coverage-disposition'
    decisionId: string
    decisionStatus: 'approved' | 'rejected'
    decisionSubject: DecisionSubject
    approver: ApproverIdentity
  }): DecisionReceipt {
    const request = immutableSnapshot(input)
    const subject = DecisionSubjectSchema.parse(request.decisionSubject)
    if (subject.kind !== request.kind) {
      throw authorityError('E2E_DECISION_SUBJECT_KIND_MISMATCH', 'Decision subject kind 与请求 kind 不一致')
    }
    const requiredRole = request.kind === 'coverage-disposition'
      ? 'coverage-approver'
      : `${request.kind}-approver`
    const registered = this.#manualIdentities.get(request.approver.subject)
    if (!matchesRegisteredIdentity(request.approver, registered) || !request.approver.roles.includes(requiredRole)) {
      throw authorityError('E2E_DECISION_APPROVER_UNTRUSTED', `决定审批人必须是登记的 ${requiredRole}`)
    }
    const unsigned = {
      schemaVersion: '1.0.0' as const,
      kind: request.kind,
      decisionId: request.decisionId,
      decisionStatus: request.decisionStatus,
      decisionSubjectDigest: digestDecisionSubject(subject),
      checkedAt: this.#now().toISOString(),
      nonce: randomBytes(32).toString('hex'),
      approver: { subject: request.approver.subject, roles: [...request.approver.roles].sort() },
      issuer: this.#issuer,
      keyId: this.#decisionKeyId,
      purpose: `${request.kind}-decision-receipt/v1` as const,
      algorithm: 'Ed25519' as const,
    }
    const signedDigest = digestText('decision-receipt-binding/v1', canonicalizeJson(unsigned))
    return DecisionReceiptSchema.parse({
      ...unsigned,
      signedDigest,
      signature: sign(null, decisionReceiptProofPayload(unsigned.purpose, this.#issuer,
        this.#decisionKeyId, signedDigest), this.#decisionPrivateKey).toString('base64url'),
    })
  }

  verifyDecisionReceipt(receipt: DecisionReceipt, binding: DecisionReceiptVerificationBinding): boolean {
    const material = this.decisionVerifierMaterial
    return createDecisionReceiptVerifier(material, material.publicKeyDigest, this.#now)(receipt, binding)
  }

  get decisionVerifierMaterial(): DecisionVerifierMaterial {
    const spki = this.#decisionPublicKey.export({ type: 'spki', format: 'der' })
    return DecisionVerifierMaterialSchema.parse({
      schemaVersion: '1.0.0', issuer: this.#issuer, keyId: this.#decisionKeyId,
      purpose: 'decision-receipt/v1', algorithm: 'Ed25519',
      publicKeySpkiBase64: spki.toString('base64'),
      publicKeyDigest: digestBytes('decision-receipt-public-key/v1', spki),
    })
  }

  issuePrivacyReviewReceipt(input: Omit<PrivacyReviewReceiptBinding, 'checkedAt'>): PrivacyReviewReceipt {
    const binding = PrivacyReviewReceiptBindingSchema.parse({ ...immutableSnapshot(input), checkedAt: this.#now().toISOString() })
    const registered = this.#manualIdentities.get(binding.approver.subject)
    if (!matchesRegisteredIdentity(binding.approver, registered)
      || !binding.approver.roles.includes('privacy-approver')) {
      throw authorityError('E2E_PRIVACY_REVIEW_APPROVER_UNTRUSTED', '隐私复核人必须是登记的 privacy-approver')
    }
    const signedDigest = digestText('privacy-review-receipt-binding/v1', canonicalizeJson(binding))
    return PrivacyReviewReceiptSchema.parse({
      ...binding, schemaVersion: '1.0.0', issuer: this.#issuer, keyId: this.#privacyReviewKeyId,
      purpose: 'privacy-review-receipt/v1', algorithm: 'Ed25519', signedDigest,
      signature: sign(null, privacyReviewProofPayload(this.#issuer, this.#privacyReviewKeyId, signedDigest),
        this.#privacyReviewPrivateKey).toString('base64url'),
    })
  }

  verifyPrivacyReviewReceipt(receipt: PrivacyReviewReceipt, binding: PrivacyReviewReceiptBinding): boolean {
    return createPrivacyReviewVerifier(this.privacyReviewVerifierMaterial,
      this.privacyReviewVerifierMaterial.publicKeyDigest, this.#now)(receipt, binding)
  }

  get privacyReviewVerifierMaterial(): PrivacyReviewVerifierMaterial {
    const spki = this.#privacyReviewPublicKey.export({ type: 'spki', format: 'der' })
    return PrivacyReviewVerifierMaterialSchema.parse({
      schemaVersion: '1.0.0', issuer: this.#issuer, keyId: this.#privacyReviewKeyId,
      purpose: 'privacy-review-receipt/v1', algorithm: 'Ed25519',
      publicKeySpkiBase64: spki.toString('base64'), publicKeyDigest: digestBytes('privacy-review-public-key/v1', spki),
    })
  }

  async issuePrivacyUnlockGrant(input: {
    runId: string
    quarantineKeyId: string
    approver: ApproverIdentity
    ttlMs: number
  }): Promise<PrivacyUnlockGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issuePrivacyUnlockGrant(input))
    }
    if (!input.approver.roles.includes('privacy-approver')) {
      throw authorityError('E2E_PRIVACY_APPROVER_ROLE_REQUIRED', '隐私解锁需要 privacy-approver 角色')
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > MAX_PRIVACY_UNLOCK_TTL_MS) {
      throw authorityError('E2E_PRIVACY_UNLOCK_TTL_INVALID', '隐私解锁 TTL 必须在 1ms 到 15 分钟之间')
    }
    if (!input.runId || !input.quarantineKeyId) {
      throw authorityError('E2E_PRIVACY_UNLOCK_SCOPE_INVALID', '隐私解锁必须绑定 Run ID 和 Quarantine key ID')
    }
    const issuedAt = this.#now()
    const payload: Omit<PrivacyUnlockGrant, 'signature'> = {
      grantId: randomUUID(), issuer: this.#issuer, keyId: this.#keyId, proofScope: 'local-os-user',
      runId: input.runId, quarantineKeyId: input.quarantineKeyId,
      approver: { subject: input.approver.subject, roles: [...input.approver.roles].sort() },
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
    }
    return { ...payload, signature: signPayload(payload, this.#privateKey) }
  }

  verifyPrivacyUnlockGrant(grant: PrivacyUnlockGrant): boolean {
    const issuedAt = Date.parse(grant.issuedAt)
    const expiresAt = Date.parse(grant.expiresAt)
    const now = this.#now().getTime()
    if (
      grant.issuer !== this.#issuer
      || grant.keyId !== this.#keyId
      || grant.proofScope !== 'local-os-user'
      || !grant.approver.roles.includes('privacy-approver')
      || Number.isNaN(issuedAt) || Number.isNaN(expiresAt)
      || now < issuedAt || now >= expiresAt
    ) return false
    const { signature, ...payload } = grant
    try {
      return verify(null, Buffer.from(canonicalizeJson(payload)), this.#publicKey, Buffer.from(signature, 'base64url'))
    } catch {
      return false
    }
  }

  async issueManualResult(input: { draft: ManualResultDraft }): Promise<ManualResult> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueManualResult(input))
    }
    const parsed = ManualResultDraftSchema.safeParse(input.draft)
    if (!parsed.success) {
      throw authorityError('E2E_MANUAL_RESULT_SCHEMA_INVALID', 'ManualResult 草稿不满足严格契约')
    }
    const draft = parsed.data
    if (!matchesRegisteredIdentity(draft.executor, this.#manualIdentities.get(draft.executor.subject))
      || !matchesRegisteredIdentity(draft.reviewer, this.#manualIdentities.get(draft.reviewer.subject))) {
      throw authorityError('E2E_MANUAL_IDENTITY_UNTRUSTED', '执行者或复核者不在 Authority 可信主体登记中')
    }
    const now = this.#now().getTime()
    const finishedAt = Date.parse(draft.finishedAt)
    const expiresAt = Date.parse(draft.expiresAt)
    if (finishedAt > now || expiresAt <= now || expiresAt - finishedAt > MAX_MANUAL_RESULT_VALIDITY_MS) {
      throw authorityError('E2E_MANUAL_RESULT_VALIDITY_INVALID', 'ManualResult 必须已完成、尚未过期且有效期不超过 30 天')
    }
    if (this.#manualResultIds.has(draft.manualResultId)) {
      throw authorityError('E2E_MANUAL_RESULT_DUPLICATE', '同一 ManualResult ID 不得重复签发')
    }
    const signedDigest = digestText('manual-result/v1', canonicalizeJson(draft))
    const authorityProof = {
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user' as const,
      algorithm: 'Ed25519' as const,
      signedDigest,
      signature: sign(null, manualResultProofPayload(signedDigest), this.#privateKey).toString('base64url'),
    }
    const result = ManualResultSchema.parse({ ...draft, authorityProof })
    this.#manualResultIds.add(result.manualResultId)
    return result
  }

  verifyManualResult(candidate: ManualResult): ManualResultVerification {
    const parsed = ManualResultSchema.safeParse(candidate)
    if (!parsed.success) {
      return { valid: false, code: 'E2E_MANUAL_RESULT_SCHEMA_INVALID', impact: 'safety-blocked' }
    }
    const result = parsed.data
    const { authorityProof, ...draft } = result
    if (
      authorityProof.issuer !== this.#issuer
      || authorityProof.keyId !== this.#keyId
      || authorityProof.proofScope !== 'local-os-user'
      || authorityProof.algorithm !== 'Ed25519'
    ) return { valid: false, code: 'E2E_MANUAL_RESULT_AUTHORITY_UNKNOWN', impact: 'safety-blocked' }
    const expectedDigest = digestText('manual-result/v1', canonicalizeJson(draft))
    if (authorityProof.signedDigest !== expectedDigest) {
      return { valid: false, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked' }
    }
    try {
      if (!verify(
        null,
        manualResultProofPayload(authorityProof.signedDigest),
        this.#publicKey,
        Buffer.from(authorityProof.signature, 'base64url'),
      )) return { valid: false, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked' }
    } catch {
      return { valid: false, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked' }
    }
    const now = this.#now().getTime()
    if (now < Date.parse(result.finishedAt)) {
      return { valid: false, code: 'E2E_MANUAL_RESULT_NOT_YET_VALID', impact: 'incomplete' }
    }
    if (now >= Date.parse(result.expiresAt)) {
      return { valid: false, code: 'E2E_MANUAL_RESULT_EXPIRED', impact: 'incomplete' }
    }
    return { valid: true }
  }

  #registerIdentities(options: LocalApprovalAuthorityOptions): void {
    for (const identity of options.manualIdentities ?? []) {
      if (!identity.subject || this.#manualIdentities.has(identity.subject)) {
        throw authorityError('E2E_MANUAL_IDENTITY_REGISTRY_INVALID', '人工验收可信主体登记存在空值或重复')
      }
      this.#manualIdentities.set(identity.subject, {
        subject: identity.subject, roles: [...new Set(identity.roles)].sort(),
      })
    }
    for (const identity of options.approvalIdentities ?? []) {
      if (!identity.subject || this.#approvalIdentities.has(identity.subject)) {
        throw authorityError('E2E_APPROVAL_IDENTITY_REGISTRY_INVALID', '执行审批可信主体登记存在空值或重复')
      }
      this.#approvalIdentities.set(identity.subject, {
        subject: identity.subject, roles: [...new Set(identity.roles)].sort(),
      })
    }
  }

  async #withStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#stateStore || this.#stateContext.getStore()) return await operation()
    return await this.#stateStore.runExclusive(async () => {
      this.#hydrateState(parseAuthoritySnapshot(this.#stateStore!.begin()))
      this.#activeStateTransactions += 1
      try {
        return await this.#stateContext.run(true, async () => {
          const result = await operation()
          this.#stateStore!.commit(canonicalizeJson(this.#persistentSnapshot()))
          return result
        })
      } catch (error) {
        this.#stateStore!.rollback()
        throw error
      } finally {
        this.#activeStateTransactions -= 1
      }
    })
  }

  #withStateMutationSync<T>(operation: () => T): T {
    if (!this.#stateStore || this.#stateContext.getStore()) return operation()
    return this.#stateStore.runExclusiveSync(() => {
      this.#hydrateState(parseAuthoritySnapshot(this.#stateStore!.begin()))
      this.#activeStateTransactions += 1
      try {
        return this.#stateContext.run(true, () => {
          const result = operation()
          this.#stateStore!.commit(canonicalizeJson(this.#persistentSnapshot()))
          return result
        })
      } catch (error) {
        this.#stateStore!.rollback()
        throw error
      } finally {
        this.#activeStateTransactions -= 1
      }
    })
  }

  async #withStateRead<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#stateStore || this.#stateContext.getStore()) return await operation()
    return await this.#stateStore.runExclusive(async () => {
      this.#hydrateState(parseAuthoritySnapshot(this.#stateStore!.begin()))
      this.#activeStateTransactions += 1
      try {
        return await this.#stateContext.run(true, operation)
      } finally {
        this.#stateStore!.rollback()
        this.#activeStateTransactions -= 1
      }
    })
  }

  #withStateReadSync<T>(operation: () => T): T {
    if (!this.#stateStore || this.#stateContext.getStore()) return operation()
    return this.#stateStore.runExclusiveSync(() => {
      this.#hydrateState(parseAuthoritySnapshot(this.#stateStore!.begin()))
      this.#activeStateTransactions += 1
      try {
        return this.#stateContext.run(true, operation)
      } finally {
        this.#stateStore!.rollback()
        this.#activeStateTransactions -= 1
      }
    })
  }

  #persistentSnapshot(): AuthorityPersistentSnapshot {
    return {
      schemaVersion: '2.1.0', issuer: this.#issuer, keyId: this.#keyId, identityDigest: this.#identityDigest,
      privateKeys: {
        primary: encryptPrivateKey(this.#privateKey, this.#stateEncryptionKey!, 'primary'),
        freshness: encryptPrivateKey(this.#freshnessPrivateKey, this.#stateEncryptionKey!, 'freshness'),
        privacyReview: encryptPrivateKey(this.#privacyReviewPrivateKey, this.#stateEncryptionKey!, 'privacyReview'),
        decision: encryptPrivateKey(this.#decisionPrivateKey, this.#stateEncryptionKey!, 'decision'),
        attempt: encryptPrivateKey(this.#attemptPrivateKey, this.#stateEncryptionKey!, 'attempt'),
      },
      webAuthnCredentials: encryptWebAuthnCredentials(
        [...this.#webAuthnCredentials.values()],
        this.#stateEncryptionKey!,
      ),
      grants: [...this.#grants.entries()], revoked: [...this.#revoked.entries()], uses: [...this.#uses.entries()],
      reservations: [...this.#reservations.entries()], completedPreflights: [...this.#completedPreflights.entries()],
      manualResultIds: [...this.#manualResultIds], attemptLogs: [...this.#attemptLogs.entries()],
    }
  }

  #hydrateState(snapshot: AuthorityPersistentSnapshot): void {
    if (snapshot.issuer !== this.#issuer || snapshot.keyId !== this.#keyId
      || snapshot.identityDigest !== this.#identityDigest) {
      throw authorityError('E2E_AUTHORITY_STATE_IDENTITY_MISMATCH', '持久 Authority snapshot 与当前实例不匹配')
    }
    replaceMap(this.#grants, snapshot.grants)
    replaceMap(this.#revoked, snapshot.revoked)
    replaceMap(this.#uses, snapshot.uses)
    replaceMap(this.#reservations, snapshot.reservations)
    replaceMap(this.#completedPreflights, snapshot.completedPreflights)
    this.#manualResultIds.clear()
    for (const id of snapshot.manualResultIds) this.#manualResultIds.add(id)
    replaceMap(this.#attemptLogs, snapshot.attemptLogs)
    replaceMap(
      this.#webAuthnCredentials,
      decryptWebAuthnCredentials(snapshot.webAuthnCredentials, this.#stateEncryptionKey!)
        .map((credential) => [credential.id, credential]),
    )
  }

  private validateApproverAndTtl(
    approver: ApproverIdentity,
    approvalSessionRef: string | undefined,
    approvalSessionBinding: WebAuthnApprovalBinding | undefined,
    ttlMs: number,
    maximum: number,
  ): void {
    const authenticatedSubject = approvalSessionRef
      ? this.#authenticateApproverSession(approvalSessionRef, approvalSessionBinding)
      : undefined
    if ((approvalSessionBinding !== undefined && approvalSessionBinding.subject !== approver.subject)
      || authenticatedSubject !== approver.subject
      || !matchesRegisteredIdentity(approver, this.#approvalIdentities.get(approver.subject))
      || !approver.roles.includes('e2e-approver')) {
      throw authorityError('E2E_APPROVAL_APPROVER_UNTRUSTED', '审批人必须通过 Authority 会话认证且是登记的 e2e-approver')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximum) {
      throw authorityError('E2E_APPROVAL_TTL_INVALID', `Grant TTL 必须在 1ms 到 ${maximum}ms 之间`)
    }
  }
}

function authorityIdentityDigest(options: LocalApprovalAuthorityOptions): string {
  const normalize = (identities: ApproverIdentity[] | undefined) => [...(identities ?? [])]
    .map((identity) => ({ subject: identity.subject, roles: [...new Set(identity.roles)].sort() }))
    .sort((left, right) => left.subject.localeCompare(right.subject))
  return digestText('authority-identity-registry/v1', canonicalizeJson({
    approvalIdentities: normalize(options.approvalIdentities), manualIdentities: normalize(options.manualIdentities),
  }))
}

function encryptPrivateKey(
  key: KeyObject,
  encryptionKey: Buffer,
  keyName: string,
): EncryptedPrivateKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(Buffer.from(`e2e-authority-private-key/v1:${keyName}`))
  const plaintext = key.export({ type: 'pkcs8', format: 'der' })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64') }
}

function decryptPrivateKey(value: EncryptedPrivateKey, encryptionKey: Buffer, keyName: string): KeyObject {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(`e2e-authority-private-key/v1:${keyName}`))
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ])
  return createPrivateKey({ key: plaintext, type: 'pkcs8', format: 'der' })
}

function parseAuthoritySnapshot(value: string): AuthorityPersistentSnapshot {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 不是合法 JSON')
  }
  return parseCurrentAuthoritySnapshot(parsed)
}

function migrateAuthoritySnapshot(
  value: string,
  stateEncryptionKey: Buffer,
): { snapshot: AuthorityPersistentSnapshot; migrated: boolean } {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 不是合法 JSON')
  }
  if (!isPlainSnapshot(parsed)) {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 结构无效')
  }
  if (parsed.schemaVersion === '2.1.0') {
    return { snapshot: parseCurrentAuthoritySnapshot(parsed), migrated: false }
  }
  if (parsed.schemaVersion !== '2.0.0' || !hasExactSnapshotKeys(parsed, false)
    || !hasAuthoritySnapshotFields(parsed, false)) {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 版本未知或旧结构无效')
  }
  const migrated = {
    ...parsed,
    schemaVersion: '2.1.0',
    webAuthnCredentials: encryptWebAuthnCredentials([], stateEncryptionKey),
  }
  return { snapshot: parseCurrentAuthoritySnapshot(migrated), migrated: true }
}

function parseCurrentAuthoritySnapshot(parsed: unknown): AuthorityPersistentSnapshot {
  if (!isPlainSnapshot(parsed) || parsed.schemaVersion !== '2.1.0'
    || !hasExactSnapshotKeys(parsed, true) || !hasAuthoritySnapshotFields(parsed, true)) {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 结构无效')
  }
  return parsed as unknown as AuthorityPersistentSnapshot
}

function hasAuthoritySnapshotFields(candidate: Record<string, unknown>, withCredentials: boolean): boolean {
  const privateKeys = candidate.privateKeys as Record<string, unknown> | undefined
  return !(typeof candidate.issuer !== 'string'
    || typeof candidate.keyId !== 'string' || typeof candidate.identityDigest !== 'string'
    || !privateKeys || Object.keys(privateKeys).sort().join('\0')
      !== ['attempt', 'decision', 'freshness', 'primary', 'privacyReview'].join('\0')
    || Object.values(privateKeys).some((key) =>
      typeof key !== 'object' || key === null || (key as EncryptedPrivateKey).algorithm !== 'aes-256-gcm'
      || typeof (key as EncryptedPrivateKey).iv !== 'string'
      || typeof (key as EncryptedPrivateKey).ciphertext !== 'string'
      || typeof (key as EncryptedPrivateKey).authTag !== 'string')
    || (withCredentials && !isEncryptedBlob(candidate.webAuthnCredentials))
    || !Array.isArray(candidate.grants) || !Array.isArray(candidate.revoked) || !Array.isArray(candidate.uses)
    || !Array.isArray(candidate.reservations) || !Array.isArray(candidate.completedPreflights)
    || !Array.isArray(candidate.manualResultIds) || !Array.isArray(candidate.attemptLogs))
}

function hasExactSnapshotKeys(candidate: Record<string, unknown>, withCredentials: boolean): boolean {
  const keys = [
    'attemptLogs', 'completedPreflights', 'grants', 'identityDigest', 'issuer', 'keyId', 'manualResultIds',
    'privateKeys', 'reservations', 'revoked', 'schemaVersion', 'uses',
    ...(withCredentials ? ['webAuthnCredentials'] : []),
  ].sort()
  return Object.keys(candidate).sort().join('\0') === keys.join('\0')
}

function isPlainSnapshot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function encryptWebAuthnCredentials(
  credentials: StoredWebAuthnCredential[],
  encryptionKey: Buffer,
): EncryptedPrivateKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(Buffer.from('e2e-authority-webauthn-credentials/v1'))
  const plaintext = Buffer.from(canonicalizeJson(
    credentials.map(parseStoredWebAuthnCredential).sort((left, right) => left.id.localeCompare(right.id)),
  ))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  plaintext.fill(0)
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

function decryptWebAuthnCredentials(
  encrypted: EncryptedPrivateKey,
  encryptionKey: Buffer,
): StoredWebAuthnCredential[] {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(encrypted.iv, 'base64'))
    decipher.setAAD(Buffer.from('e2e-authority-webauthn-credentials/v1'))
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ])
    try {
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
      if (!Array.isArray(parsed)) throw new Error('not an array')
      const credentials = parsed.map(parseStoredWebAuthnCredential)
      if (new Set(credentials.map((credential) => credential.id)).size !== credentials.length) {
        throw new Error('duplicate credential')
      }
      return credentials
    } finally {
      plaintext.fill(0)
    }
  } catch (cause) {
    throw authorityError(
      'E2E_AUTHORITY_STATE_DECRYPTION_FAILED',
      `Authority WebAuthn credential 密文损坏: ${cause instanceof Error ? cause.message : 'unknown'}`,
    )
  }
}

function isEncryptedBlob(value: unknown): value is EncryptedPrivateKey {
  return typeof value === 'object' && value !== null
    && (value as EncryptedPrivateKey).algorithm === 'aes-256-gcm'
    && typeof (value as EncryptedPrivateKey).iv === 'string'
    && typeof (value as EncryptedPrivateKey).ciphertext === 'string'
    && typeof (value as EncryptedPrivateKey).authTag === 'string'
}

function parseStoredWebAuthnCredential(value: unknown): StoredWebAuthnCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw authorityError('E2E_APPROVAL_CREDENTIAL_STATE_INVALID', 'WebAuthn credential state 结构无效')
  }
  const candidate = value as Partial<StoredWebAuthnCredential>
  const transports = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']
  let publicKey: Buffer
  try { publicKey = Buffer.from(candidate.publicKey ?? '', 'base64url') } catch { publicKey = Buffer.alloc(0) }
  if (Object.keys(value).sort().join('\0') !== ['counter', 'id', 'publicKey', 'subject', 'transports'].join('\0')
    || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 4096
    || typeof candidate.publicKey !== 'string' || publicKey.byteLength === 0
    || publicKey.toString('base64url') !== candidate.publicKey
    || typeof candidate.counter !== 'number' || !Number.isSafeInteger(candidate.counter) || candidate.counter < 0
    || !Array.isArray(candidate.transports) || candidate.transports.some((item) => !transports.includes(item))
    || new Set(candidate.transports).size !== candidate.transports.length
    || typeof candidate.subject !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(candidate.subject)) {
    throw authorityError('E2E_APPROVAL_CREDENTIAL_STATE_INVALID', 'WebAuthn credential state 字段无效')
  }
  return structuredClone(candidate) as StoredWebAuthnCredential
}

function replaceMap<K, V>(target: Map<K, V>, entries: Array<[K, V]>): void {
  target.clear()
  for (const [key, value] of entries) target.set(key, value)
}

function immutableSnapshot<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T
}

function sameExecutionBoundary(discovery: DiscoveryApprovalSubject, execution: {
  assetId: string; prdRevision: string; scopeDigest: string; environment: string; baseOrigin: string; actor: string
}): boolean {
  return discovery.assetId === execution.assetId
    && discovery.prdRevision === execution.prdRevision
    && discovery.scopeDigest === execution.scopeDigest
    && discovery.environment === execution.environment
    && discovery.baseOrigin === execution.baseOrigin
    && discovery.actor === execution.actor
}

function matchesReadyPreflight(
  subject: DiscoveryApprovalSubject,
  outcome: DiscoveryPreflightOutcome,
): boolean {
  const observed = outcome.observedIdentity
  if (!observed) return false
  return canonicalUrl(observed.url) === canonicalUrl(subject.expectedPageIdentity.url)
    && observed.title === subject.expectedPageIdentity.title
    && observed.headings.includes(subject.expectedPageIdentity.heading)
    && observed.role === subject.actor
    && subject.expectedPageIdentity.ariaSignals.every((signal) => (observed.ariaSignals ?? []).includes(signal))
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return value
  }
}

function signPayload(payload: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalizeJson(payload)), privateKey).toString('base64url')
}

function manualResultProofPayload(signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ purpose: 'manual-result-authority-proof/v1', signedDigest }))
}

function artifactProofPayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: 'artifact-authority-signature/v1', issuer, keyId, signedDigest,
  }))
}

function approvalFreshnessProofPayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: 'approval-freshness-receipt/v1', issuer, keyId, signedDigest,
  }))
}

function privacyReviewProofPayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ purpose: 'privacy-review-receipt/v1', issuer, keyId, signedDigest }))
}

function decisionReceiptProofPayload(
  purpose: string,
  issuer: string,
  keyId: string,
  signedDigest: string,
): Buffer {
  return Buffer.from(canonicalizeJson({ purpose, issuer, keyId, signedDigest }))
}

export function createDecisionReceiptVerifier(
  candidateMaterial: DecisionVerifierMaterial,
  expectedPublicKeyDigest: string,
  now: () => Date,
): (receipt: DecisionReceipt, binding: DecisionReceiptVerificationBinding) => boolean {
  const parsed = DecisionVerifierMaterialSchema.safeParse(candidateMaterial)
  if (!parsed.success || parsed.data.publicKeyDigest !== expectedPublicKeyDigest) return () => false
  let publicKey: KeyObject
  try {
    const spki = Buffer.from(parsed.data.publicKeySpkiBase64, 'base64')
    if (digestBytes('decision-receipt-public-key/v1', spki) !== parsed.data.publicKeyDigest) return () => false
    publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
  } catch { return () => false }
  const material = parsed.data
  return (candidate, expectedCandidate) => {
    const receipt = DecisionReceiptSchema.safeParse(candidate)
    const expected = DecisionReceiptVerificationBindingSchema.safeParse(expectedCandidate)
    if (!receipt.success || !expected.success) return false
    const value = receipt.data
    const requiredRole = value.kind === 'coverage-disposition'
      ? 'coverage-approver'
      : `${value.kind}-approver`
    if (value.issuer !== material.issuer || value.keyId !== material.keyId
      || value.purpose !== `${value.kind}-decision-receipt/v1` || value.algorithm !== material.algorithm
      || !value.approver.roles.includes(requiredRole)
      || value.kind !== expected.data.kind || value.decisionId !== expected.data.decisionId
      || value.decisionStatus !== expected.data.decisionStatus
      || value.decisionSubjectDigest !== expected.data.decisionSubjectDigest
      || Date.parse(value.checkedAt) > now().getTime()) return false
    const { signedDigest, signature, ...unsigned } = value
    const expectedSignedDigest = digestText('decision-receipt-binding/v1', canonicalizeJson(unsigned))
    if (signedDigest !== expectedSignedDigest) return false
    try {
      return verify(null, decisionReceiptProofPayload(value.purpose, value.issuer, value.keyId, signedDigest),
        publicKey, Buffer.from(signature, 'base64url'))
    } catch { return false }
  }
}

export function createPrivacyReviewVerifier(
  candidateMaterial: PrivacyReviewVerifierMaterial,
  expectedPublicKeyDigest: string,
  now: () => Date,
): (receipt: PrivacyReviewReceipt, binding: PrivacyReviewReceiptBinding) => boolean {
  const parsed = PrivacyReviewVerifierMaterialSchema.safeParse(candidateMaterial)
  if (!parsed.success || parsed.data.publicKeyDigest !== expectedPublicKeyDigest) return () => false
  let publicKey: KeyObject
  try {
    const spki = Buffer.from(parsed.data.publicKeySpkiBase64, 'base64')
    if (digestBytes('privacy-review-public-key/v1', spki) !== parsed.data.publicKeyDigest) return () => false
    publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
  } catch { return () => false }
  const material = parsed.data
  return (candidate, expectedBinding) => {
    const receipt = PrivacyReviewReceiptSchema.safeParse(candidate)
    const binding = PrivacyReviewReceiptBindingSchema.safeParse(expectedBinding)
    if (!receipt.success || !binding.success) return false
    const { schemaVersion: _schemaVersion, issuer, keyId, purpose, algorithm,
      signedDigest, signature, ...actualBinding } = receipt.data
    if (issuer !== material.issuer || keyId !== material.keyId || purpose !== material.purpose
      || algorithm !== material.algorithm || canonicalizeJson(actualBinding) !== canonicalizeJson(binding.data)) return false
    const checkedAt = Date.parse(actualBinding.checkedAt)
    const timestamp = now().getTime()
    if (checkedAt > timestamp || timestamp - checkedAt > MAX_PRIVACY_REVIEW_AGE_MS) return false
    const expectedDigest = digestText('privacy-review-receipt-binding/v1', canonicalizeJson(binding.data))
    if (signedDigest !== expectedDigest) return false
    try {
      return verify(null, privacyReviewProofPayload(issuer, keyId, signedDigest), publicKey,
        Buffer.from(signature, 'base64url'))
    } catch { return false }
  }
}

function normalizeCapabilityRecords(records: ApprovalCapabilityRecord[]): ApprovalCapabilityRecord[] {
  const parsed = records.map((record) => ApprovalCapabilityRecordSchema.parse(record))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
  if (new Set(parsed.map((record) => record.capabilityId)).size !== parsed.length
    || new Set(parsed.map((record) => `${record.actionId}\0${record.operation}`)).size !== parsed.length) {
    throw authorityError('E2E_APPROVAL_FRESHNESS_CAPABILITY_DUPLICATE', 'Freshness capability/action-operation 必须唯一')
  }
  return parsed
}

function toApprovalCapabilityRecord(
  capability: SignedGrant['capabilities'][number],
): ApprovalCapabilityRecord {
  if (!('operation' in capability) || !('effect' in capability)) {
    throw authorityError('E2E_APPROVAL_FRESHNESS_GRANT_KIND_UNSUPPORTED', 'Capability 类型不支持 freshness')
  }
  return ApprovalCapabilityRecordSchema.parse({
    capabilityId: capability.capabilityId, actionId: capability.actionId,
    operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
    digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
  })
}

function isReadGrant(grant: SignedGrant): grant is SignedReadGrant {
  return ReadApprovalSubjectSchema.safeParse(grant.subject).success
    && grant.capabilities.every((capability) => 'operation' in capability && capability.transport === 'browser-local')
}

function isWriteGrant(grant: SignedGrant): grant is SignedWriteGrant {
  return WriteApprovalSubjectV2Schema.safeParse(grant.subject).success
    && grant.capabilities.every((capability) =>
      'operation' in capability && capability.operation === 'http-request'
      && 'effect' in capability && capability.effect === 'reversible-write')
}

function isDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value)
}

function matchesRegisteredIdentity(candidate: ApproverIdentity, registered: ApproverIdentity | undefined): boolean {
  if (!registered) return false
  const candidateRoles = [...new Set(candidate.roles)].sort()
  return candidate.subject === registered.subject
    && candidateRoles.length === registered.roles.length
    && candidateRoles.every((role, index) => role === registered.roles[index])
}

function denied(code: string, reason: string): GrantDecision {
  return { allowed: false, code, reason }
}

function authorityError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'decision', message, retryable: false })
}

function validateDiscoverySubject(subject: DiscoveryApprovalSubject): void {
  let baseOrigin: URL
  let pageUrl: URL
  try {
    baseOrigin = new URL(subject.baseOrigin)
    pageUrl = new URL(subject.expectedPageIdentity.url)
  } catch {
    throw authorityError('E2E_APPROVAL_DISCOVERY_SCOPE_INVALID', 'Discovery URL 无法解析')
  }
  const actionsValid = Array.isArray(subject.actions) && subject.actions.length > 0
    && new Set(subject.actions.map((action) => action.actionId)).size === subject.actions.length
    && subject.actions.every((action) => /^[A-Za-z0-9._:-]{1,256}$/.test(action.actionId)
      && ['dom-read', 'screenshot', 'local-navigation'].includes(action.operation)
      && Number.isSafeInteger(action.maxUses) && action.maxUses === 1)
  const identity = subject.expectedPageIdentity
  if (
    subject.schemaVersion !== '1.0.0'
    || !/^[A-Za-z0-9._:/-]{1,256}$/.test(subject.assetId)
    || !['local', 'test', 'staging', 'production'].includes(subject.environment)
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(subject.actor)
    || !/^sha256:[a-f0-9]{64}$/.test(subject.prdRevision)
    || !/^sha256:[a-f0-9]{64}$/.test(subject.scopeDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(subject.bootstrapIntentsDigest)
    || !['http:', 'https:'].includes(baseOrigin.protocol)
    || baseOrigin.pathname !== '/' || baseOrigin.search || baseOrigin.hash || baseOrigin.username || baseOrigin.password
    || pageUrl.origin !== baseOrigin.origin || pageUrl.username || pageUrl.password || pageUrl.hash
    || identity.title.trim() === '' || identity.heading.trim() === ''
    || !Array.isArray(identity.ariaSignals) || identity.ariaSignals.some((signal) => signal.trim() === '')
    || !actionsValid
  ) {
    throw authorityError(
      'E2E_APPROVAL_DISCOVERY_SCOPE_INVALID',
      'Discovery Grant 必须绑定同 origin 页面、actor、Scope、bootstrap 和有界只读动作',
    )
  }
}

function validateWriteSubject(subject: WriteApprovalSubject): void {
  const allowedEnvironment = ['local', 'test', 'staging'].includes(subject.environment)
  const reversibleOnly = Array.isArray(subject.actions)
    && subject.actions.length > 0
    && subject.actions.every((action) => action.effect === 'reversible-write')
  if (!allowedEnvironment || !reversibleOnly) {
    throw authorityError(
      'E2E_APPROVAL_WRITE_SCOPE_INVALID',
      '写 Grant 仅允许 local/test/staging 环境中的 reversible-write；production 与不可逆写永久拒绝',
    )
  }
}

function validateInjectionSubject(subject: InjectionApprovalSubject): void {
  if (!['local', 'test'].includes(subject.environment) || !Array.isArray(subject.actions) || subject.actions.length === 0) {
    throw authorityError('E2E_APPROVAL_INJECTION_SCOPE_INVALID', '故障注入只允许 local/test 且必须包含精确 action')
  }
  const orderedActions = [...subject.actions].sort((left, right) => left.expectedOrder - right.expectedOrder)
  for (const [index, action] of orderedActions.entries()) {
    if (
      action.expectedOrder !== index + 1
      || action.upstreamForwarding !== 'forbidden'
      || !Number.isSafeInteger(action.attemptSlot) || action.attemptSlot < 1
      || !Number.isSafeInteger(action.expectedMatches) || action.expectedMatches < 1
      || action.request.maxRequests !== action.expectedMatches
      || action.request.canonicalOrigin !== subject.baseOrigin
      || action.request.targetFingerprint !== 'not-applicable'
      || !action.request.exactPath.startsWith('/')
      || /[*?\\]/.test(action.request.exactPath)
      || action.request.method !== action.request.method.toUpperCase()
    ) {
      throw authorityError('E2E_APPROVAL_INJECTION_SCOPE_INVALID', '注入 action 的次数、目标或零转发约束无效')
    }
    validateInjectionResponse(action.response)
  }
}

function validateInjectionResponse(response: CanonicalInjectionResponse): void {
  if (!Number.isSafeInteger(response.delayMs) || response.delayMs < 0 || response.delayMs > 30_000) {
    throw authorityError('E2E_APPROVAL_INJECTION_RESPONSE_INVALID', '注入延迟必须在 0 到 30000ms 之间')
  }
  if (response.kind === 'http-response') {
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
      throw authorityError('E2E_APPROVAL_INJECTION_RESPONSE_INVALID', 'HTTP 注入状态码无效')
    }
    const names = new Set<string>()
    const allowedHeaders = new Set(['content-type', 'retry-after', 'cache-control'])
    for (const header of response.headers) {
      if (
        header.name !== header.name.toLowerCase()
        || names.has(header.name)
        || !allowedHeaders.has(header.name)
        || /[\r\n\0]/.test(header.value)
        || Buffer.byteLength(header.value, 'utf8') > MAX_INJECTION_HEADER_VALUE_BYTES
      ) {
        throw authorityError('E2E_APPROVAL_INJECTION_RESPONSE_INVALID', '注入响应 header 不在安全 allowlist 或存在重复')
      }
      names.add(header.name)
    }
    if (response.body.kind === 'utf8') {
      if (
        response.body.digest !== digestInjectionResponseBody(response.body.value)
        || Buffer.byteLength(response.body.value, 'utf8') > MAX_INJECTION_RESPONSE_BODY_BYTES
      ) {
        throw authorityError('E2E_APPROVAL_INJECTION_RESPONSE_INVALID', '注入响应 body 摘要不匹配或超过 64KiB')
      }
    }
    return
  }
  if (response.status !== 'not-applicable' || response.headers.length !== 0 || response.body.kind !== 'no-body') {
    throw authorityError('E2E_APPROVAL_INJECTION_RESPONSE_INVALID', 'reset/timeout 注入不能携带 HTTP 响应字段')
  }
}

function validateWebSocketReadSubject(subject: WebSocketReadApprovalSubject): void {
  if (!Array.isArray(subject.actions) || subject.actions.length === 0) {
    throw authorityError('E2E_APPROVAL_WEBSOCKET_SCOPE_INVALID', 'WebSocket read Grant 必须包含至少一个精确 action')
  }
  const targets = new Set<string>()
  for (const action of subject.actions) {
    let origin: URL
    try {
      origin = new URL(action.origin)
    } catch {
      throw authorityError('E2E_APPROVAL_WEBSOCKET_SCOPE_INVALID', 'WebSocket origin 无法解析')
    }
    const target = `${action.origin}${action.path}`
    if (
      !action.actionId
      || !['ws:', 'wss:'].includes(origin.protocol)
      || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
      || !action.path.startsWith('/') || action.path.length > 8 * 1024 || /[*?\\#]/.test(action.path)
      || !Number.isSafeInteger(action.maxInboundMessages) || action.maxInboundMessages < 1 || action.maxInboundMessages > 1_000
      || !Number.isSafeInteger(action.maxBytes) || action.maxBytes < 1 || action.maxBytes > 10 * 1024 * 1024
      || targets.has(target)
    ) {
      throw authorityError('E2E_APPROVAL_WEBSOCKET_SCOPE_INVALID', 'WebSocket 必须是唯一精确只读目标且消息/字节上限有效')
    }
    targets.add(target)
  }
}

function validateSseReadSubject(subject: SseReadApprovalSubject): void {
  if (!Array.isArray(subject.actions) || subject.actions.length === 0) {
    throw authorityError('E2E_APPROVAL_SSE_SCOPE_INVALID', 'SSE read Grant 必须包含至少一个精确 action')
  }
  const targets = new Set<string>()
  for (const action of subject.actions) {
    let origin: URL
    try {
      origin = new URL(action.origin)
    } catch {
      throw authorityError('E2E_APPROVAL_SSE_SCOPE_INVALID', 'SSE origin 无法解析')
    }
    const target = `${action.origin}${action.exactPath}?${canonicalizeJson(action.query)}`
    if (
      !action.actionId
      || !['http:', 'https:'].includes(origin.protocol)
      || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
      || !action.exactPath.startsWith('/') || action.exactPath.length > 8 * 1024 || /[*?\\#]/.test(action.exactPath)
      || !Number.isSafeInteger(action.maxReconnects) || action.maxReconnects < 1 || action.maxReconnects > 100
      || targets.has(target)
    ) {
      throw authorityError('E2E_APPROVAL_SSE_SCOPE_INVALID', 'SSE 必须是唯一精确 GET 目标且重连上限有效')
    }
    targets.add(target)
  }
}

function copyHttpIntent(intent: InjectionApprovalSubject['actions'][number]['request']): InjectionCapability['request'] {
  return { ...intent, query: [...intent.query], payload: { ...intent.payload } }
}

function copyInjectionResponse(response: CanonicalInjectionResponse): CanonicalInjectionResponse {
  if (response.kind !== 'http-response') {
    return { ...response, headers: [], body: { kind: 'no-body' } }
  }
  return {
    ...response,
    headers: response.headers.map((header) => ({ ...header })),
    body: { ...response.body },
  }
}
