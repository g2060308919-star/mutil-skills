import {
  E2EError,
  canonicalizeJson,
  approvalApproverSubject,
  digestBytes,
  digestCanonicalGrantApprovalSubject,
  digestText,
  type ApproverIdentity,
  type ApprovalApprover,
  ApprovalCapabilityRecordSchema,
  ApprovalFinalizationAcknowledgementSchema,
  ApprovalGrantSubjectSchema,
  ApprovalFreshnessReceiptSchema,
  ApprovalFreshnessVerifierMaterialSchema,
  LegacyDiscoveryApprovalSubjectV10Schema,
  LegacyReadApprovalSubjectV20Schema,
  LegacyWriteApprovalSubjectV23Schema,
  LegacyWriteHttpIntentV23Schema,
  WriteApprovalSubjectV2Schema,
  WriteHttpIntentSchema,
  ReadApprovalSubjectSchema,
  type ApprovalCapabilityRecord,
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerification,
  type ApprovalFreshnessVerifierMaterial,
  type ApprovalFinalizationAcknowledgement,
  type ArtifactDocument,
  type ArtifactSignature,
  ArtifactAuthorityVerifierMaterialSchema,
  type ArtifactAuthorityVerifierMaterial,
  type AppendAttemptEventInput,
  type AttemptExecutionContext,
  type AttemptEvent,
  AttemptEventSchema,
  type AttemptEventAuthorityProof,
  ATTEMPT_EVENT_PROOF_PURPOSE,
  AttemptEventVerifierMaterialSchema,
  type AttemptEventVerifierMaterial,
  type CapabilityReservation,
  type CanonicalApprovalContext,
  DiscoveryApprovalSubjectSchema,
  InjectionApprovalSubjectSchema,
  WebSocketReadApprovalSubjectSchema,
  SseReadApprovalSubjectSchema,
  type ApprovalGrantSubject,
  CanonicalApprovalContextSchema,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
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
  ManualResultUserPresenceProofSchema,
  type ManualResult,
  type ManualResultDraft,
  type ManualResultUserPresenceProof,
  type ManualResultVerification,
  type ReadCapability,
  type ReversibleWriteCapability,
  type SignedGrant,
  SignedGrantSchema,
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
  randomBytes, randomUUID, sign, timingSafeEqual, verify, type KeyObject,
} from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  SqliteSnapshotStore,
  type SqliteStateDirectoryIdentity,
} from './sqlite-state-store.js'
import {
  AuthorityStateAnchor,
  authoritySnapshotMac,
  type AuthorityStateAnchorProvider,
  type AuthorityStateAnchorPoint,
  type TrustedMonotonicAuthorityStateAnchor,
} from './authority-state-anchor.js'
import {
  parseApprovalExecutionBinding,
  trustWriteApprovalClient,
  type ApprovalExecutionBinding,
  type TrustedWriteApprovalClient,
} from './trusted-execution-clients.js'
import type {
  StoredWebAuthnApprovalReceipt,
  StoredWebAuthnCredential,
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
const MAX_PENDING_MANUAL_RESULTS = 10_000
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
    expected: { approvalType: 'discovery' | 'execution'; subjectDigest: string },
  ) => StoredWebAuthnApprovalReceipt | undefined | Promise<StoredWebAuthnApprovalReceipt | undefined>
  /** Manual 双角色签署的独立 OS/WebAuthn 会话认证边界。 */
  authenticateManualApproverSession?: (
    sessionRef: string,
    expected: {
      approvalType: 'manual-executor' | 'manual-reviewer'
      subjectDigest: string
      runId: string
      installationDigest: string
    },
  ) => StoredWebAuthnApprovalReceipt | undefined | Promise<StoredWebAuthnApprovalReceipt | undefined>
}

interface PendingManualResult {
  draft: ManualResultDraft
  draftDigest: string
  preparationFinalizationId: string
  preparationRequestDigest: string
  executorPresence?: ManualResultUserPresenceProof
  executorFinalizationId?: string
  executorRequestDigest?: string
  reviewerFinalizationId?: string
  reviewerRequestDigest?: string
  issuedResult?: ManualResult
}

interface EncryptedPrivateKey {
  algorithm: 'aes-256-gcm'
  iv: string
  ciphertext: string
  authTag: string
}

interface DecryptedAuthorityPrivateKeys {
  primary: KeyObject
  freshness: KeyObject
  privacyReview: KeyObject
  decision: KeyObject
  attempt: KeyObject
}

interface AuthorityPersistentSnapshot {
  schemaVersion: '2.8.0'
  stateRevision: number
  stateDigest: string
  stateMac: string
  issuer: string
  keyId: string
  identityDigest: string
  privateKeys: {
    primary: EncryptedPrivateKey; freshness: EncryptedPrivateKey; privacyReview: EncryptedPrivateKey
    decision: EncryptedPrivateKey; attempt: EncryptedPrivateKey
  }
  webAuthnCredentials: EncryptedPrivateKey
  webAuthnReceipts: EncryptedPrivateKey
  grants: Array<[string, SignedGrant]>
  grantFinalizations: Array<[string, StoredGrantFinalization]>
  acknowledgedFinalizations: Array<[string, StoredAcknowledgedFinalization]>
  revoked: Array<[string, string]>
  uses: Array<[string, number]>
  reservations: Array<[string, CapabilityReservation]>
  reservationRpcBindings: Array<[string, ReservationRpcOwnerBinding]>
  completedPreflights: Array<[string, { grantId: string; subject: DiscoveryApprovalSubject; status: DiscoveryPreflightOutcome['status'] }]>
  manualResultIds: string[]
  pendingManualResults: Array<[string, PendingManualResult]>
  attemptLogs: Array<[string, { chainDigest: string; events: AttemptEvent[]; lastTimestamp: number }]>
}

export interface ReservationRpcOwnerClaim {
  clientId: string
  approvalContext: CanonicalApprovalContext
}

export interface ReservationRpcOwnerBinding extends ReservationRpcOwnerClaim {
  signedDigest: string
  signature: string
}

interface StoredGrantFinalization {
  requestDigest: string
  grantId: string
  approvalSessionRef: string
  subject: ApprovalGrantSubject
  approvalBinding: ApprovalExecutionBinding
}

interface StoredAcknowledgedFinalization {
  requestDigest: string
  grantId: string
  approvalBinding: ApprovalExecutionBinding
  expiresAt: string
}

const MAX_GRANT_FINALIZATIONS = 1_024
const MAX_RESERVATION_RECORDS = 16_384

/**
 * Discovery preflight receipt 的 canonical digest。Runtime 只能用它预计算待提交
 * receipt；最终是否完成仍以 Authority 持久状态为准。
 */
export function computeDiscoveryPreflightDigest(input: {
  grant: SignedDiscoveryGrant
  capabilityId: string
  reservationId: string
  outcome: DiscoveryPreflightOutcome
}): string {
  return digestText('browser-preflight-result/v1', canonicalizeJson({
    grantId: input.grant.grantId,
    subjectDigest: input.grant.subjectDigest,
    capabilityId: input.capabilityId,
    ...immutableSnapshot(input.outcome),
    reservationId: input.reservationId,
  }))
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
  readonly #stateAnchor?: AuthorityStateAnchorProvider
  readonly #identityDigest: string
  readonly #authenticateApproverSession: (
    sessionRef: string,
    expected: { approvalType: 'discovery' | 'execution'; subjectDigest: string },
  ) => StoredWebAuthnApprovalReceipt | undefined | Promise<StoredWebAuthnApprovalReceipt | undefined>
  readonly #authenticateManualApproverSession: (
    sessionRef: string,
    expected: {
      approvalType: 'manual-executor' | 'manual-reviewer'
      subjectDigest: string
      runId: string
      installationDigest: string
    },
  ) => StoredWebAuthnApprovalReceipt | undefined | Promise<StoredWebAuthnApprovalReceipt | undefined>
  readonly #stateContext = new AsyncLocalStorage<boolean>()
  readonly #localApprovalContext = new AsyncLocalStorage<{
    expected: { approvalType: 'discovery' | 'execution'; subjectDigest: string }
    binding: ApprovalExecutionBinding
  }>()
  readonly #localManualContext = new AsyncLocalStorage<boolean>()
  #activeStateTransactions = 0
  readonly #grants = new Map<string, SignedGrant>()
  readonly #grantFinalizations = new Map<string, StoredGrantFinalization>()
  readonly #acknowledgedFinalizations = new Map<string, StoredAcknowledgedFinalization>()
  readonly #revoked = new Map<string, string>()
  readonly #uses = new Map<string, number>()
  readonly #reservations = new Map<string, CapabilityReservation>()
  readonly #reservationRpcBindings = new Map<string, ReservationRpcOwnerBinding>()
  readonly #completedPreflights = new Map<string, {
    grantId: string; subject: DiscoveryApprovalSubject; status: DiscoveryPreflightOutcome['status']
  }>()
  readonly #attemptLogs = new Map<string, { chainDigest: string; events: AttemptEvent[]; lastTimestamp: number }>()
  readonly #manualResultIds = new Set<string>()
  readonly #pendingManualResults = new Map<string, PendingManualResult>()
  readonly #approvalIdentities = new Map<string, ApproverIdentity>()
  readonly #manualIdentities = new Map<string, ApproverIdentity>()
  readonly #webAuthnCredentials = new Map<string, StoredWebAuthnCredential>()
  readonly #webAuthnReceipts = new Map<string, StoredWebAuthnApprovalReceipt>()
  #closed = false

  private constructor(options: LocalApprovalAuthorityOptions, privateKey: KeyObject, publicKey: KeyObject,
    freshnessPrivateKey: KeyObject, freshnessPublicKey: KeyObject,
    privacyReviewPrivateKey: KeyObject, privacyReviewPublicKey: KeyObject,
    decisionPrivateKey: KeyObject, decisionPublicKey: KeyObject,
    attemptPrivateKey: KeyObject, attemptPublicKey: KeyObject,
    stateStore?: SqliteSnapshotStore, stateEncryptionKey?: Buffer,
    stateAnchor?: AuthorityStateAnchorProvider) {
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
    this.#stateAnchor = stateAnchor
    this.#identityDigest = authorityIdentityDigest(options)
    this.#authenticateApproverSession = options.authenticateApproverSession ?? (() => undefined)
    this.#authenticateManualApproverSession = options.authenticateManualApproverSession ?? (() => undefined)
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
    expectedStateDirectory?: SqliteStateDirectoryIdentity
    /**
     * 可选的独立可信单调 provider；所有权随 open 转移并在 Authority.close() 时关闭。
     * 未提供时只启用同 UID 本地 crash/integrity anchor，不能声明抵抗整体状态回滚。
     */
    trustedStateAnchor?: TrustedMonotonicAuthorityStateAnchor
  }): Promise<LocalApprovalAuthority> {
    const stateEncryptionKey = Buffer.from(options.stateEncryptionKey)
    if (stateEncryptionKey.byteLength !== 32) {
      stateEncryptionKey.fill(0)
      throw authorityError('E2E_AUTHORITY_STATE_ENCRYPTION_KEY_INVALID', 'Authority 状态加密密钥必须为 32 bytes')
    }
    let store: SqliteSnapshotStore
    try {
      store = new SqliteSnapshotStore(options.statePath, `approval:${options.issuer}:${options.keyId}`, {
        forbiddenRoots: options.testWorkspaceRoots,
        ...(options.expectedStateDirectory === undefined
          ? {} : { expectedStateDirectory: options.expectedStateDirectory }),
      })
    } catch (error) {
      stateEncryptionKey.fill(0)
      throw error
    }
    let stateAnchor: AuthorityStateAnchorProvider
    try {
      if (options.trustedStateAnchor !== undefined
        && options.trustedStateAnchor.securityLevel !== 'trusted-monotonic') {
        throw authorityError(
          'E2E_AUTHORITY_TRUSTED_ANCHOR_LEVEL_INVALID',
          'trustedStateAnchor 必须由独立信任域实现并声明 trusted-monotonic',
        )
      }
      stateAnchor = options.trustedStateAnchor ?? new AuthorityStateAnchor(
        options.statePath, `approval:${options.issuer}:${options.keyId}`, stateEncryptionKey)
    } catch (error) {
      throwWithAuthorityCleanup(error, store, options.trustedStateAnchor, stateEncryptionKey)
    }
    try {
      const primary = generateKeyPairSync('ed25519')
    const freshness = generateKeyPairSync('ed25519')
    const privacyReview = generateKeyPairSync('ed25519')
    const decision = generateKeyPairSync('ed25519')
    const attempt = generateKeyPairSync('ed25519')
    const initial = {
      schemaVersion: '2.6.0', issuer: options.issuer, keyId: options.keyId,
      identityDigest: authorityIdentityDigest(options),
      privateKeys: {
        primary: encryptPrivateKey(primary.privateKey, stateEncryptionKey, 'primary'),
        freshness: encryptPrivateKey(freshness.privateKey, stateEncryptionKey, 'freshness'),
        privacyReview: encryptPrivateKey(privacyReview.privateKey, stateEncryptionKey, 'privacyReview'),
        decision: encryptPrivateKey(decision.privateKey, stateEncryptionKey, 'decision'),
        attempt: encryptPrivateKey(attempt.privateKey, stateEncryptionKey, 'attempt'),
      },
      webAuthnCredentials: encryptWebAuthnCredentials([], stateEncryptionKey),
      webAuthnReceipts: encryptWebAuthnReceipts([], stateEncryptionKey),
      grants: [], grantFinalizations: [], acknowledgedFinalizations: [],
      revoked: [], uses: [], reservations: [], reservationRpcBindings: [], completedPreflights: [],
      manualResultIds: [], attemptLogs: [],
    }
    store.initialize(canonicalizeJson(initial))
    let loaded: {
      snapshot: AuthorityPersistentSnapshot
      migrated: boolean
      privateKeys: DecryptedAuthorityPrivateKeys
    }
      try {
        const versioned = store.beginVersioned()
        loaded = loadAuthoritySnapshot(versioned.snapshot, stateEncryptionKey, versioned.revision)
        if (loaded.migrated) {
          if (stateAnchor.read() !== undefined) {
            throw authorityError('E2E_AUTHORITY_STATE_ROLLBACK_DETECTED', '旧 Authority DB 与既有单调 anchor 冲突')
          }
          store.commit(canonicalizeJson(loaded.snapshot))
          stateAnchor.initialize(anchorPoint(loaded.snapshot))
        } else {
          store.rollback()
          verifyAuthorityStateAnchor(stateAnchor, loaded.snapshot)
        }
      } catch (error) {
        store.rollback()
        throw error
      }
      const snapshot = loaded.snapshot
      if (snapshot.issuer !== options.issuer || snapshot.keyId !== options.keyId
        || snapshot.identityDigest !== authorityIdentityDigest(options)) {
        throw authorityError('E2E_AUTHORITY_STATE_IDENTITY_MISMATCH', '持久 Authority 的 issuer、keyId 或可信身份注册表不匹配')
      }
      const {
        primary: primaryPrivate,
        freshness: freshnessPrivate,
        privacyReview: privacyPrivate,
        decision: decisionPrivate,
        attempt: attemptPrivate,
      } = loaded.privateKeys
      const authority = new LocalApprovalAuthority(
        options, primaryPrivate, createPublicKey(primaryPrivate), freshnessPrivate, createPublicKey(freshnessPrivate),
        privacyPrivate, createPublicKey(privacyPrivate), decisionPrivate, createPublicKey(decisionPrivate),
        attemptPrivate, createPublicKey(attemptPrivate), store, stateEncryptionKey, stateAnchor,
      )
      authority.#registerIdentities(options)
      authority.#hydrateState(snapshot)
      return authority
    } catch (error) {
      throwWithAuthorityCleanup(error, store, stateAnchor, stateEncryptionKey)
    }
  }

  close(): void {
    if (this.#closed) return
    if (this.#activeStateTransactions !== 0) throw authorityError('E2E_AUTHORITY_STATE_BUSY', 'Authority 事务进行中不能关闭')
    this.#closed = true
    const errors = cleanupAuthorityResources(this.#stateStore, this.#stateAnchor, this.#stateEncryptionKey)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'E2E_AUTHORITY_CLOSE_FAILED')
  }

  get stateProtectionLevel(): 'ephemeral' | AuthorityStateAnchorProvider['securityLevel'] {
    return this.#stateAnchor?.securityLevel ?? 'ephemeral'
  }

  createWriteExecutionClient(approvalContext: CanonicalApprovalContext): TrustedWriteApprovalClient {
    const trustedContext = CanonicalApprovalContextSchema.parse(approvalContext)
    const client: TrustedWriteApprovalClient = Object.freeze({
      verifyForSubject: async (grant: SignedWriteGrant, currentSubject: WriteApprovalSubject) => {
        const mismatch = approvalContextMismatch(grant, trustedContext, this.#now())
        return mismatch ?? await this.verifyForSubject(grant, currentSubject)
      },
      reserveForSubject: async (input: {
        grant: SignedWriteGrant; currentSubject: WriteApprovalSubject; capabilityId: string
        actionId: string; attemptId: string; attemptContext?: AttemptExecutionContext
      }) => {
        const mismatch = approvalContextMismatch(input.grant, trustedContext, this.#now())
        if (mismatch) throw authorityError(mismatch.code, mismatch.reason)
        return await this.reserveForSubject(input)
      },
      complete: async (reservationId: string, outcomeDigest: string) => {
        await this.complete(reservationId, outcomeDigest)
      },
      markUnknown: async (reservationId: string, observation: string) => {
        await this.markUnknown(reservationId, observation)
      },
    })
    return trustWriteApprovalClient(client, { transport: 'in-process-test',
      approvalBinding: {
        runId: trustedContext.runId, installationDigest: trustedContext.installationDigest,
        approvalType: trustedContext.approvalType, subjectDigest: trustedContext.subjectDigest,
      } })
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
        this.#assertCredentialCas(expected, next)
        this.#webAuthnCredentials.set(next.id, next)
      }),
      completeAuthentication: async (
        expectedCandidate: StoredWebAuthnCredential,
        nextCandidate: StoredWebAuthnCredential,
        sessionId: string,
        receiptCandidate: StoredWebAuthnApprovalReceipt,
      ) => await this.#withStateMutation(async () => {
        const expected = parseStoredWebAuthnCredential(expectedCandidate)
        const next = parseStoredWebAuthnCredential(nextCandidate)
        const receipt = parseStoredWebAuthnApprovalReceipt(receiptCandidate)
        this.#assertCredentialCas(expected, next)
        if (!/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId) || this.#webAuthnReceipts.has(sessionId)) {
          throw authorityError('E2E_APPROVAL_SESSION_CONSUMED', 'WebAuthn receipt session 已存在或无效')
        }
        this.#webAuthnCredentials.set(next.id, next)
        this.#webAuthnReceipts.set(sessionId, receipt)
      }),
      takeApprovalReceipt: async (sessionId: string) => await this.#withStateMutation(async () => {
        const receipt = this.#webAuthnReceipts.get(sessionId)
        if (receipt === undefined) return undefined
        this.#webAuthnReceipts.delete(sessionId)
        return structuredClone(receipt)
      }),
    })
  }

  async finalizeApprovalGrant(input: {
    subject: ApprovalGrantSubject
    approvalSessionRef: string
    ttlMs: number
    finalizationId: string
    requestDigest: string
    approvalBinding: ApprovalExecutionBinding
  }): Promise<SignedGrant> {
    if (!this.#stateStore) {
      throw authorityError(
        'E2E_APPROVAL_PERSISTENCE_REQUIRED',
        '生产 WebAuthn Grant 签发必须使用持久 Authority transaction',
      )
    }
    if (!this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.finalizeApprovalGrant(input))
    }
    const subject = ApprovalGrantSubjectSchema.parse(immutableSnapshot(input.subject))
    const approvalBinding = parseApprovalExecutionBinding(input.approvalBinding)
    validateFinalizationIdentity(input.finalizationId, input.requestDigest)
    this.#pruneExpiredFinalizations()
    const expectedFinalization: Omit<StoredGrantFinalization, 'grantId' | 'approvalSessionRef'> = {
      requestDigest: input.requestDigest,
      subject,
      approvalBinding,
    }
    const existing = this.#grantFinalizations.get(input.finalizationId)
    if (existing !== undefined) {
      if (existing.requestDigest !== expectedFinalization.requestDigest
        || existing.approvalSessionRef !== input.approvalSessionRef
        || canonicalizeJson(existing.subject) !== canonicalizeJson(expectedFinalization.subject)
        || canonicalizeJson(existing.approvalBinding) !== canonicalizeJson(expectedFinalization.approvalBinding)) {
        throw authorityError('E2E_APPROVAL_FINALIZATION_MISMATCH', 'finalizationId 已绑定不同请求或 Grant subject')
      }
      const existingGrant = this.#grants.get(existing.grantId)
      if (existingGrant === undefined) {
        throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', 'finalization outbox 引用了不存在的 Grant')
      }
      return structuredClone(existingGrant)
    }
    if (this.#acknowledgedFinalizations.has(input.finalizationId)) {
      throw authorityError(
        'E2E_APPROVAL_FINALIZATION_MISMATCH',
        'finalizationId 已被已确认 tombstone 占用',
      )
    }
    const common = { approvalSessionRef: input.approvalSessionRef, ttlMs: input.ttlMs }
    const discovery = DiscoveryApprovalSubjectSchema.safeParse(subject)
    const read = ReadApprovalSubjectSchema.safeParse(subject)
    const write = WriteApprovalSubjectV2Schema.safeParse(subject)
    const injection = InjectionApprovalSubjectSchema.safeParse(subject)
    const webSocket = WebSocketReadApprovalSubjectSchema.safeParse(subject)
    const sse = SseReadApprovalSubjectSchema.safeParse(subject)
    const grant = discovery.success ? await this.issueDiscoveryGrant({ subject: discovery.data, ...common })
      : read.success ? await this.issueReadGrant({ subject: read.data, ...common })
      : write.success ? await this.issueWriteGrant({ subject: write.data, ...common })
      : injection.success ? await this.issueInjectionGrant({ subject: injection.data, ...common })
      : webSocket.success ? await this.issueWebSocketReadGrant({ subject: webSocket.data, ...common })
      : sse.success ? await this.issueSseReadGrant({ subject: sse.data, ...common })
      : undefined
    if (grant === undefined) {
      throw authorityError('E2E_APPROVAL_SUBJECT_INVALID', 'Grant subject 不属于严格 canonical union')
    }
    if (!sameApprovalExecutionBinding(grant.approvalContext, approvalBinding)) {
      throw authorityError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'WebAuthn receipt 与 Runtime 可信绑定不一致')
    }
    if (this.#finalizationEntryCount() >= MAX_GRANT_FINALIZATIONS) {
      throw authorityError(
        'E2E_APPROVAL_FINALIZATION_CAPACITY_EXCEEDED',
        'finalization outbox 已达到安全上限',
      )
    }
    this.#grantFinalizations.set(input.finalizationId, {
      ...expectedFinalization,
      grantId: grant.grantId,
      approvalSessionRef: input.approvalSessionRef,
    })
    return grant
  }

  async finalizeLocalApprovalGrant(input: {
    subject: ApprovalGrantSubject
    ttlMs: number
    finalizationId: string
    requestDigest: string
    approvalBinding: ApprovalExecutionBinding
  }): Promise<SignedGrant> {
    const subject = ApprovalGrantSubjectSchema.parse(immutableSnapshot(input.subject))
    const binding = parseApprovalExecutionBinding(input.approvalBinding)
    const expected = {
      approvalType: canonicalGrantApprovalType(subject),
      subjectDigest: canonicalGrantApprovalSubjectDigest(subject),
    }
    if (expected.approvalType !== binding.approvalType
      || expected.subjectDigest !== binding.subjectDigest) {
      throw authorityError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', '本地确认与 Grant subject 绑定不一致')
    }
    return await this.#localApprovalContext.run({ expected, binding }, async () => await this.finalizeApprovalGrant({
      ...input,
      subject,
      approvalBinding: binding,
      approvalSessionRef: `LOCAL-${input.finalizationId}`,
    }))
  }

  async recoverFinalizedGrant(input: {
    finalizationId: string
    requestDigest: string
    subject: ApprovalGrantSubject
    approvalBinding: ApprovalExecutionBinding
  }): Promise<{ grant: SignedGrant; approvalSessionRef: string } | undefined> {
    if (!this.#stateStore) throw authorityError('E2E_APPROVAL_PERSISTENCE_REQUIRED', '恢复 Grant 需要持久 Authority')
    return await this.#withStateMutation(async () => {
      validateFinalizationIdentity(input.finalizationId, input.requestDigest)
      this.#pruneExpiredFinalizations()
      const subject = ApprovalGrantSubjectSchema.parse(immutableSnapshot(input.subject))
      const approvalBinding = parseApprovalExecutionBinding(input.approvalBinding)
      const existing = this.#grantFinalizations.get(input.finalizationId)
      if (existing === undefined) {
        const acknowledged = this.#acknowledgedFinalizations.get(input.finalizationId)
        if (acknowledged === undefined) return undefined
        const acknowledgedGrant = this.#grants.get(acknowledged.grantId)
        if (acknowledgedGrant === undefined) {
          throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', 'tombstone Grant 不存在')
        }
        if (acknowledged.requestDigest !== input.requestDigest
          || canonicalizeJson(acknowledgedGrant.subject) !== canonicalizeJson(subject)
          || canonicalizeJson(acknowledged.approvalBinding) !== canonicalizeJson(approvalBinding)) {
          throw authorityError('E2E_APPROVAL_FINALIZATION_MISMATCH', 'finalization recovery 与 tombstone 不一致')
        }
        return undefined
      }
      if (existing.requestDigest !== input.requestDigest
        || canonicalizeJson(existing.subject) !== canonicalizeJson(subject)
        || canonicalizeJson(existing.approvalBinding) !== canonicalizeJson(approvalBinding)) {
        throw authorityError('E2E_APPROVAL_FINALIZATION_MISMATCH', 'finalization recovery 与既有 outbox 不一致')
      }
      const grant = this.#grants.get(existing.grantId)
      if (grant === undefined) throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', 'outbox Grant 不存在')
      return { grant: structuredClone(grant), approvalSessionRef: existing.approvalSessionRef }
    })
  }

  async acknowledgeFinalizedGrant(input: ApprovalFinalizationAcknowledgement): Promise<void> {
    if (!this.#stateStore) throw authorityError('E2E_APPROVAL_PERSISTENCE_REQUIRED', '确认 Grant 需要持久 Authority')
    const parsedInput = ApprovalFinalizationAcknowledgementSchema.safeParse(immutableSnapshot(input))
    if (!parsedInput.success) {
      throw authorityError('E2E_APPROVAL_FINALIZATION_INVALID', 'finalization ack 结构无效')
    }
    await this.#withStateMutation(async () => {
      const input = parsedInput.data
      validateFinalizationIdentity(input.finalizationId, input.requestDigest)
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.grantId)) {
        throw authorityError('E2E_APPROVAL_FINALIZATION_INVALID', 'grantId 无效')
      }
      const approvalBinding = parseApprovalExecutionBinding(input.approvalBinding)
      this.#pruneExpiredFinalizations()
      const acknowledged = this.#acknowledgedFinalizations.get(input.finalizationId)
      if (acknowledged !== undefined) {
        if (acknowledged.requestDigest !== input.requestDigest || acknowledged.grantId !== input.grantId
          || canonicalizeJson(acknowledged.approvalBinding) !== canonicalizeJson(approvalBinding)) {
          throw authorityError('E2E_APPROVAL_FINALIZATION_MISMATCH', 'finalization ack 与 tombstone 不一致')
        }
        return
      }
      const existing = this.#grantFinalizations.get(input.finalizationId)
      if (existing === undefined) {
        throw authorityError('E2E_APPROVAL_FINALIZATION_MISMATCH', 'finalization ack 没有对应 outbox 或 tombstone')
      }
      if (existing.requestDigest !== input.requestDigest || existing.grantId !== input.grantId
        || canonicalizeJson(existing.approvalBinding) !== canonicalizeJson(approvalBinding)) {
        throw authorityError('E2E_APPROVAL_FINALIZATION_MISMATCH', 'finalization ack 与 outbox 不一致')
      }
      const grant = this.#grants.get(existing.grantId)
      if (grant === undefined) throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', 'outbox Grant 不存在')
      this.#acknowledgedFinalizations.set(input.finalizationId, {
        requestDigest: existing.requestDigest,
        grantId: existing.grantId,
        approvalBinding: existing.approvalBinding,
        expiresAt: grant.expiresAt,
      })
      this.#grantFinalizations.delete(input.finalizationId)
    })
  }

  #finalizationEntryCount(): number {
    return this.#grantFinalizations.size + this.#acknowledgedFinalizations.size
  }

  #pruneExpiredFinalizations(): void {
    const now = this.#now().getTime()
    for (const [finalizationId, entry] of this.#grantFinalizations) {
      const grant = this.#grants.get(entry.grantId)
      if (grant === undefined || Date.parse(grant.expiresAt) <= now) {
        this.#grantFinalizations.delete(finalizationId)
      }
    }
    for (const [finalizationId, entry] of this.#acknowledgedFinalizations) {
      if (Date.parse(entry.expiresAt) <= now) this.#acknowledgedFinalizations.delete(finalizationId)
    }
  }

  /** Verifies the persisted signed Grant and binding before returning context for ephemeral RPC activation. */
  async activatePersistedGrant(input: {
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
  }): Promise<CanonicalApprovalContext> {
    if (!this.#stateStore) throw authorityError('E2E_APPROVAL_PERSISTENCE_REQUIRED', '激活 Grant 需要持久 Authority')
    return await this.#withStateRead(async () => {
      const parsed = SignedGrantSchema.safeParse(immutableSnapshot(input.grant))
      if (!parsed.success) throw authorityError('E2E_APPROVAL_GRANT_INVALID', 'SignedGrant 结构无效')
      const grant = parsed.data as SignedGrant
      const approvalBinding = parseApprovalExecutionBinding(input.approvalBinding)
      if (!sameApprovalExecutionBinding(grant.approvalContext, approvalBinding)) {
        throw authorityError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'SignedGrant 与 Runtime 可信绑定不一致')
      }
      const stored = this.#grants.get(grant.grantId)
      if (stored === undefined || canonicalizeJson(stored) !== canonicalizeJson(grant)) {
        throw authorityError(
          'E2E_APPROVAL_GRANT_STATE_MISMATCH',
          'SignedGrant 与当前 Authority 持久存储态不一致',
        )
      }
      const decision = this.#verifyGrant(grant)
      if (!decision.allowed) throw authorityError(decision.code, decision.reason)
      return structuredClone(grant.approvalContext)
    })
  }

  /**
   * 仅供 crash recovery 激活 maintenance RPC。允许已过期/已撤销 Grant，但仍要求：
   * schema、签名、持久化 Grant 全量字节与 execution binding 完全一致。
   */
  async activatePersistedGrantForRecovery(input: {
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
  }): Promise<CanonicalApprovalContext> {
    if (!this.#stateStore) throw authorityError('E2E_APPROVAL_PERSISTENCE_REQUIRED', '恢复激活 Grant 需要持久 Authority')
    return await this.#withStateRead(async () => {
      const parsed = SignedGrantSchema.safeParse(immutableSnapshot(input.grant))
      if (!parsed.success) throw authorityError('E2E_APPROVAL_GRANT_INVALID', 'SignedGrant 结构无效')
      const grant = parsed.data as SignedGrant
      const approvalBinding = parseApprovalExecutionBinding(input.approvalBinding)
      if (!sameApprovalExecutionBinding(grant.approvalContext, approvalBinding)) {
        throw authorityError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'SignedGrant 与 Runtime 可信绑定不一致')
      }
      const stored = this.#grants.get(grant.grantId)
      if (stored === undefined || canonicalizeJson(stored) !== canonicalizeJson(grant)) {
        throw authorityError('E2E_APPROVAL_GRANT_STATE_MISMATCH', 'SignedGrant 与当前 Authority 持久存储态不一致')
      }
      const signatureDecision = this.#verifyGrantSignature(grant)
      if (!signatureDecision.allowed) throw authorityError(signatureDecision.code, signatureDecision.reason)
      return structuredClone(grant.approvalContext)
    })
  }

  #assertCredentialCas(expected: StoredWebAuthnCredential, next: StoredWebAuthnCredential): void {
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
  }

  async issueDiscoveryGrant(input: {
    subject: DiscoveryApprovalSubject
    approver?: ApproverIdentity
    approvalSessionRef?: string
    ttlMs: number
  }): Promise<SignedDiscoveryGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueDiscoveryGrant(input))
    }
    const request = immutableSnapshot(input)
    const parsedSubject = DiscoveryApprovalSubjectSchema.safeParse(request.subject)
    if (!parsedSubject.success) {
      throw authorityError('E2E_APPROVAL_DISCOVERY_SCOPE_INVALID', 'Discovery subject 必须满足严格 canonical contract')
    }
    const subject = parsedSubject.data
    validateDiscoverySubject(subject)
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const approval = await this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      { approvalType: 'discovery', subjectDigest },
      request.ttlMs, MAX_DISCOVERY_TTL_MS)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedDiscoveryGrant, 'signature'> = {
      grantId: randomUUID(), issuer: this.#issuer, keyId: this.#keyId, proofScope: 'local-os-user',
      approver: approval.approver,
      approvalContext: approval.context,
      subject,
      subjectDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): DiscoveryCapability => action.operation === 'http-request'
        ? {
            capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'), transport: 'http',
            effect: 'read', actionId: action.actionId, operation: 'http-request',
            requestIds: action.requestIds, maxUses: action.maxUses,
          }
        : {
            capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'), transport: 'browser-local',
            effect: 'read', actionId: action.actionId, operation: action.operation,
            targetUrl: subject.expectedPageIdentity.url, actor: subject.actor,
            expectedPageIdentityDigest: digestText(
              'expected-page-identity/v1', canonicalizeJson(subject.expectedPageIdentity),
            ),
            bootstrapIntentsDigest: subject.bootstrapIntentsDigest,
            maxUses: action.maxUses,
          }),
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
    approver?: ApproverIdentity
    approvalSessionRef?: string
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
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const approval = await this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      { approvalType: 'execution', subjectDigest },
      request.ttlMs, MAX_READ_TTL_MS)

    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedReadGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: approval.approver,
      approvalContext: approval.context,
      subject,
      subjectDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): ReadCapability => action.operation === 'http-request'
        ? {
            capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'), transport: 'http',
            effect: 'read', actionId: action.actionId, operation: 'http-request',
            requestIds: action.requestIds, maxUses: action.maxUses,
          }
        : {
            capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'),
            transport: 'browser-local', effect: 'read', actionId: action.actionId,
            operation: action.operation, maxUses: action.maxUses,
          }),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedReadGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueWriteGrant(input: {
    subject: WriteApprovalSubject
    approver?: ApproverIdentity
    approvalSessionRef?: string
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
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const approval = await this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      { approvalType: 'execution', subjectDigest },
      request.ttlMs, MAX_WRITE_TTL_MS)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedWriteGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: approval.approver,
      approvalContext: approval.context,
      subject,
      subjectDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): ReversibleWriteCapability => {
        const common = {
          capabilityId: randomUUID(), nonce: randomBytes(32).toString('hex'),
          effect: 'reversible-write' as const, actionId: action.actionId,
          dataLeaseId: action.dataLeaseId, fencingToken: action.fencingToken,
          cleanupPlanDigest: action.cleanupPlanDigest, requests: immutableSnapshot(action.requests), maxUses: 1 as const,
        }
        return 'transport' in action
          ? { ...common, transport: action.transport, operation: action.operation,
              programDigest: action.programDigest, cleanupProgramDigest: action.cleanupProgramDigest }
          : { ...common, transport: 'http', operation: 'http-request' }
      }),
      revocationSequence: 0,
    }
    const signature = signPayload(grantWithoutSignature, this.#privateKey)
    const grant: SignedWriteGrant = { ...grantWithoutSignature, signature }
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  async issueInjectionGrant(input: {
    subject: InjectionApprovalSubject
    approver?: ApproverIdentity
    approvalSessionRef?: string
    ttlMs: number
  }): Promise<SignedInjectionGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueInjectionGrant(input))
    }
    const request = immutableSnapshot(input)
    validateRawInjectionResponses(request.subject)
    const parsedSubject = InjectionApprovalSubjectSchema.safeParse(request.subject)
    if (!parsedSubject.success) {
      throw authorityError('E2E_APPROVAL_INJECTION_SCOPE_INVALID', 'Injection subject 必须满足严格 canonical contract')
    }
    const subject = parsedSubject.data
    validateInjectionSubject(subject)
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const approval = await this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      { approvalType: 'execution', subjectDigest },
      request.ttlMs, MAX_INJECTION_TTL_MS)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedInjectionGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: approval.approver,
      approvalContext: approval.context,
      subject,
      subjectDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): InjectionCapability => ({
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
    approver?: ApproverIdentity
    approvalSessionRef?: string
    ttlMs: number
  }): Promise<SignedWebSocketReadGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueWebSocketReadGrant(input))
    }
    const request = immutableSnapshot(input)
    const parsedSubject = WebSocketReadApprovalSubjectSchema.safeParse(request.subject)
    if (!parsedSubject.success) {
      throw authorityError('E2E_APPROVAL_WEBSOCKET_SCOPE_INVALID', 'WebSocket subject 必须满足严格 canonical contract')
    }
    const subject = parsedSubject.data
    validateWebSocketReadSubject(subject)
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const approval = await this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      { approvalType: 'execution', subjectDigest },
      request.ttlMs, MAX_READ_TTL_MS)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedWebSocketReadGrant, 'signature'> = {
      grantId: randomUUID(),
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user',
      approver: approval.approver,
      approvalContext: approval.context,
      subject,
      subjectDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): WebSocketReadCapability => ({
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
    approver?: ApproverIdentity
    approvalSessionRef?: string
    ttlMs: number
  }): Promise<SignedSseReadGrant> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.issueSseReadGrant(input))
    }
    const request = immutableSnapshot(input)
    const parsedSubject = SseReadApprovalSubjectSchema.safeParse(request.subject)
    if (!parsedSubject.success) {
      throw authorityError('E2E_APPROVAL_SSE_SCOPE_INVALID', 'SSE subject 必须满足严格 canonical contract')
    }
    const subject = parsedSubject.data
    validateSseReadSubject(subject)
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    const approval = await this.validateApproverAndTtl(request.approver, request.approvalSessionRef,
      { approvalType: 'execution', subjectDigest },
      request.ttlMs, MAX_READ_TTL_MS)
    const issuedAt = this.#now()
    const grantWithoutSignature: Omit<SignedSseReadGrant, 'signature'> = {
      grantId: randomUUID(), issuer: this.#issuer, keyId: this.#keyId, proofScope: 'local-os-user',
      approver: approval.approver,
      approvalContext: approval.context,
      subject,
      subjectDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.ttlMs).toISOString(),
      capabilities: subject.actions.map((action): SseReadCapability => ({
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
    const context = CanonicalApprovalContextSchema.safeParse(grant.approvalContext)
    const now = this.#now().getTime()
    if (!context.success
      || context.data.approvalType !== canonicalGrantApprovalType(grant.subject)
      || context.data.subject !== approvalApproverSubject(grant.approver)
      || context.data.subjectDigest !== grant.subjectDigest
      || Date.parse(context.data.issuedAt) > now
      || Date.parse(context.data.expiresAt) <= now
      || Date.parse(grant.issuedAt) < Date.parse(context.data.issuedAt)
      || Date.parse(grant.expiresAt) > Date.parse(context.data.expiresAt)) {
      return denied('E2E_APPROVAL_CONTEXT_MISMATCH', 'Grant approvalContext 无效、错绑或已超出有效时间边界')
    }
    let currentDigest: string
    try {
      const parsed = ApprovalGrantSubjectSchema.parse(currentSubject)
      if (canonicalGrantApprovalType(parsed) !== canonicalGrantApprovalType(grant.subject)) throw new Error('type mismatch')
      currentDigest = canonicalGrantApprovalSubjectDigest(parsed)
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
    if (canonicalGrantApprovalSubjectDigest(subjectResult.data) !== stored.subjectDigest) {
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
    rpcOwnerBinding?: ReservationRpcOwnerClaim
  }): Promise<CapabilityReservation> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.reserveForSubject(input))
    }
    const grant = immutableSnapshot<SignedGrant>(input.grant)
    const currentSubject = immutableSnapshot<SignedGrant['subject']>(input.currentSubject)
    if (canonicalGrantApprovalType(grant.subject) === 'discovery') {
      const prior = [...this.#reservations.values()].filter((reservation) => {
        if (reservation.attemptId !== input.attemptId) return false
        const priorGrant = this.#grants.get(reservation.grantId)
        return priorGrant !== undefined && canonicalGrantApprovalType(priorGrant.subject) === 'discovery'
      })
      if (prior.length > 1) throw authorityError(
        'E2E_APPROVAL_DISCOVERY_RESERVATION_AMBIGUOUS',
        'Discovery attemptId 已绑定多个 reservation，拒绝推测恢复',
      )
      const existing = prior[0]
      if (existing !== undefined) {
        const storedGrant = this.#grants.get(existing.grantId)
        if (existing.grantId !== grant.grantId
          || existing.capabilityId !== input.capabilityId
          || existing.actionId !== input.actionId
          || storedGrant === undefined
          || canonicalizeJson(storedGrant) !== canonicalizeJson(grant)
          || canonicalizeJson(grant.subject) !== canonicalizeJson(currentSubject)) {
          throw authorityError(
            'E2E_APPROVAL_DISCOVERY_RESERVATION_REPLAY_MISMATCH',
            'Discovery reservation 重试与原 grant/capability/action/subject 绑定不一致',
          )
        }
        this.#requireSameRpcOwnerBinding(existing.reservationId, input.rpcOwnerBinding)
        return immutableSnapshot(existing)
      }
    }
    const decision = await this.verifyForSubject(grant, currentSubject)
    if (!decision.allowed) throw authorityError(decision.code, decision.reason)
    return await this.#reserveVerified({
      grantId: grant.grantId,
      capabilityId: input.capabilityId,
      actionId: input.actionId,
      attemptId: input.attemptId,
      attemptContext: input.attemptContext,
      rpcOwnerBinding: input.rpcOwnerBinding,
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
    const reservation = this.#reservations.get(input.reservationId)
    if (!reservation || reservation.grantId !== grant.grantId
      || reservation.capabilityId !== input.capabilityId) {
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
    const preflightDigest = computeDiscoveryPreflightDigest({
      grant, capabilityId: capability.capabilityId, reservationId: reservation.reservationId, outcome,
    })
    const completed = this.#completedPreflights.get(preflightDigest)
    const storedGrant = this.#grants.get(grant.grantId)
    if (reservation.status === 'completed'
      && reservation.outcomeDigest === preflightDigest
      && completed?.grantId === grant.grantId
      && completed.status === outcome.status
      && canonicalizeJson(completed.subject) === canonicalizeJson(currentSubject)
      && storedGrant !== undefined
      && canonicalizeJson(storedGrant) === canonicalizeJson(grant)) {
      return preflightDigest
    }
    const decision = await this.verifyForSubject(grant, currentSubject)
    if (!decision.allowed) throw authorityError(decision.code, decision.reason)
    if (reservation.status !== 'reserved') {
      throw authorityError('E2E_APPROVAL_PREFLIGHT_RESERVATION_INVALID', 'Discovery preflight reservation 无效')
    }
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
    rpcOwnerBinding?: ReservationRpcOwnerClaim
  }): Promise<CapabilityReservation> {
    const grant = this.#grants.get(input.grantId)
    if (!grant) throw authorityError('E2E_APPROVAL_GRANT_UNKNOWN', 'Grant 不存在')
    const rpcOwnerClaim = input.rpcOwnerBinding === undefined
      ? undefined : parseReservationRpcOwnerClaim(input.rpcOwnerBinding, grant.approvalContext)
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
    if (this.#reservations.size >= MAX_RESERVATION_RECORDS) {
      throw authorityError(
        'E2E_APPROVAL_RESERVATION_CAPACITY_EXCEEDED',
        'Authority reservation/tombstone 已达到持久安全上限；必须由受信运维归档后再继续',
      )
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
    if (rpcOwnerClaim !== undefined) {
      this.#reservationRpcBindings.set(reservation.reservationId,
        this.#issueReservationRpcOwnerBinding(reservation.reservationId, rpcOwnerClaim))
    }
    return { ...reservation }
  }

  getReservationRpcBinding(reservationId: string): ReservationRpcOwnerBinding | undefined {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateReadSync(() => this.getReservationRpcBinding(reservationId))
    }
    const binding = this.#reservationRpcBindings.get(reservationId)
    return binding === undefined ? undefined : immutableSnapshot(binding)
  }

  #requireSameRpcOwnerBinding(
    reservationId: string,
    input: ReservationRpcOwnerClaim | undefined,
  ): void {
    const existing = this.#reservationRpcBindings.get(reservationId)
    if (existing === undefined && input === undefined) return
    if (existing === undefined || input === undefined
      || existing.clientId !== input.clientId
      || canonicalizeJson(existing.approvalContext) !== canonicalizeJson(
        parseReservationRpcOwnerClaim(input, existing.approvalContext).approvalContext)) {
      throw authorityError('E2E_APPROVAL_RESERVATION_RPC_OWNER_MISMATCH', 'Reservation RPC owner 绑定不一致')
    }
  }

  #issueReservationRpcOwnerBinding(
    reservationId: string,
    claim: ReservationRpcOwnerClaim,
  ): ReservationRpcOwnerBinding {
    const signedDigest = reservationRpcOwnerDigest(reservationId, claim)
    return {
      ...immutableSnapshot(claim), signedDigest,
      signature: sign(null, reservationRpcOwnerProofPayload(this.#issuer, this.#decisionKeyId, signedDigest),
        this.#decisionPrivateKey).toString('base64url'),
    }
  }

  async markUnknown(reservationId: string, observation: string): Promise<string> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.markUnknown(reservationId, observation))
    }
    const reservation = this.#reservations.get(reservationId)
    if (!reservation) throw authorityError('E2E_APPROVAL_RESERVATION_UNKNOWN', 'Reservation 不存在')
    if (typeof observation !== 'string' || observation.length < 1 || observation.length > 16 * 1024) {
      throw authorityError('E2E_APPROVAL_OBSERVATION_INVALID', 'Observation 无效')
    }
    if (reservation.status === 'unknown' && reservation.observation === observation) {
      return reservationTerminalReceipt(reservation, 'unknown')
    }
    if (reservation.status !== 'reserved') {
      throw authorityError('E2E_APPROVAL_RESERVATION_FINAL', 'Reservation 终态与本次 observation 不一致')
    }
    reservation.status = 'unknown'
    reservation.observation = observation
    return reservationTerminalReceipt(reservation, 'unknown')
  }

  async complete(reservationId: string, outcomeDigest: string): Promise<string> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.complete(reservationId, outcomeDigest))
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(outcomeDigest)) {
      throw authorityError('E2E_APPROVAL_OUTCOME_DIGEST_INVALID', 'Outcome digest 无效')
    }
    const reservation = this.#reservations.get(reservationId)
    if (!reservation) throw authorityError('E2E_APPROVAL_RESERVATION_UNKNOWN', 'Reservation 不存在')
    if (reservation.status === 'completed' && reservation.outcomeDigest === outcomeDigest) {
      return reservationTerminalReceipt(reservation, 'completed')
    }
    if (reservation.status !== 'reserved') {
      throw authorityError('E2E_APPROVAL_RESERVATION_FINAL', 'Reservation 终态与本次 outcome 不一致')
    }
    reservation.status = 'completed'
    reservation.outcomeDigest = outcomeDigest
    return reservationTerminalReceipt(reservation, 'completed')
  }

  getReservation(reservationId: string): CapabilityReservation | undefined {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateReadSync(() => this.getReservation(reservationId))
    }
    const reservation = this.#reservations.get(reservationId)
    return reservation ? { ...reservation } : undefined
  }

  getGrantApprovalContext(grantId: string): CanonicalApprovalContext | undefined {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateReadSync(() => this.getGrantApprovalContext(grantId))
    }
    const grant = this.#grants.get(grantId)
    return grant ? immutableSnapshot(grant.approvalContext) : undefined
  }

  findReservation(query: {
    reservationId?: string
    attemptId?: string
    grantId: string
    capabilityId: string
    actionId: string
  }): CapabilityReservation | undefined {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return this.#withStateReadSync(() => this.findReservation(query))
    }
    const usesReservationId = query.reservationId !== undefined && query.attemptId === undefined
    const usesAttemptId = query.attemptId !== undefined && query.reservationId === undefined
    if ((!usesReservationId && !usesAttemptId)
      || ![query.grantId, query.capabilityId, query.actionId].every((value) => typeof value === 'string' && value.length > 0)) {
      throw authorityError('E2E_APPROVAL_RESERVATION_QUERY_INVALID', 'Reservation 查询必须指定且仅指定 reservationId 或 attemptId')
    }
    const matches = [...this.#reservations.values()].filter((reservation) =>
      (usesReservationId ? reservation.reservationId === query.reservationId : reservation.attemptId === query.attemptId)
      && reservation.grantId === query.grantId
      && reservation.capabilityId === query.capabilityId
      && reservation.actionId === query.actionId)
    if (matches.length > 1) {
      throw authorityError('E2E_APPROVAL_RESERVATION_QUERY_AMBIGUOUS', '稳定 attempt 查询命中多个 Reservation')
    }
    return matches[0] ? immutableSnapshot(matches[0]) : undefined
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
    const persistedAtSequence = existing?.events[eventCore.sequence - 1]
    if (persistedAtSequence !== undefined) {
      const { eventDigest, authorityProof, ...persistedCore } = persistedAtSequence
      if (canonicalizeJson(persistedCore) !== canonicalizeJson(eventCore)) {
        throw authorityError('E2E_ATTEMPT_AUTHORITY_LOG_REPLAY_MISMATCH',
          'Attempt 事件 sequence 已存在但内容不同')
      }
      return { event: immutableSnapshot(persistedAtSequence),
        eventChainDigest: digestText('attempt-event-chain/v1', canonicalizeJson({
          previous: persistedAtSequence.previousChainDigest, event: eventDigest,
        })) }
    }
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
        && !reservationAttestsTerminal(context, eventCore, this.#reservations, this.#grants)) {
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

  issueLocalDecisionReceipt(input: {
    kind: 'scope' | 'lineage' | 'coverage-disposition'
    decisionId: string
    decisionStatus: 'approved' | 'rejected'
    decisionSubject: DecisionSubject
  }): DecisionReceipt {
    const request = immutableSnapshot(input)
    const subject = DecisionSubjectSchema.parse(request.decisionSubject)
    if (subject.kind !== request.kind) {
      throw authorityError('E2E_DECISION_SUBJECT_KIND_MISMATCH', 'Decision subject kind 与请求 kind 不一致')
    }
    const unsigned = {
      schemaVersion: '1.0.0' as const,
      kind: request.kind,
      decisionId: request.decisionId,
      decisionStatus: request.decisionStatus,
      decisionSubjectDigest: digestDecisionSubject(subject),
      checkedAt: this.#now().toISOString(),
      nonce: randomBytes(32).toString('hex'),
      approver: { kind: 'local-caller' as const },
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

  async prepareManualResult(input: {
    draft: ManualResultDraft
    finalizationId: string
    requestDigest: string
  }): Promise<{
    manualResultId: string
    draftDigest: string
    nextRole: 'executor'
  }> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.prepareManualResult(input))
    }
    const parsed = ManualResultDraftSchema.safeParse(input.draft)
    if (!parsed.success) {
      throw authorityError('E2E_MANUAL_RESULT_SCHEMA_INVALID', 'ManualResult 草稿不满足严格契约')
    }
    const draft = parsed.data
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.finalizationId)
      || !/^sha256:[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw authorityError('E2E_MANUAL_RESULT_PREPARE_INPUT_INVALID', 'ManualResult preparation 绑定无效')
    }
    if (!this.#localManualContext.getStore()
      && (!matchesRegisteredIdentity(draft.executor, this.#manualIdentities.get(draft.executor.subject))
        || !matchesRegisteredIdentity(draft.reviewer, this.#manualIdentities.get(draft.reviewer.subject)))) {
      throw authorityError('E2E_MANUAL_IDENTITY_UNTRUSTED', '执行者或复核者不在 Authority 可信主体登记中')
    }
    this.#requireCurrentManualDraft(draft)
    // 热路径保持 O(1)。只有 ID 冲突或容量边界才做一次有界全表清理，
    // 避免批量 prepare 退化为 O(n²) 并形成 CPU DoS。
    const draftDigest = manualResultDraftDigest(draft)
    const existingPending = this.#pendingManualResults.get(draft.manualResultId)
    if (existingPending !== undefined && existingPending.draftDigest === draftDigest
      && existingPending.preparationFinalizationId === input.finalizationId
      && existingPending.preparationRequestDigest === input.requestDigest) {
      return { manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor' }
    }
    if (this.#pendingManualResults.has(draft.manualResultId)
      || this.#pendingManualResults.size >= MAX_PENDING_MANUAL_RESULTS) {
      this.#pruneExpiredPendingManualResults()
    }
    if (this.#manualResultIds.has(draft.manualResultId)
      || this.#pendingManualResults.has(draft.manualResultId)) {
      throw authorityError('E2E_MANUAL_RESULT_DUPLICATE', '同一 ManualResult ID 不得重复签发')
    }
    if (this.#pendingManualResults.size >= MAX_PENDING_MANUAL_RESULTS) {
      throw authorityError('E2E_MANUAL_RESULT_CAPACITY_EXHAUSTED', '待签人工结果已达到持久上限')
    }
    this.#pendingManualResults.set(draft.manualResultId, { draft, draftDigest,
      preparationFinalizationId: input.finalizationId,
      preparationRequestDigest: input.requestDigest })
    return { manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor' }
  }

  async prepareLocalManualResult(input: {
    draft: ManualResultDraft
    finalizationId: string
    requestDigest: string
  }) {
    return await this.#localManualContext.run(true, async () => await this.prepareManualResult(input))
  }

  async finalizeLocalManualResultRole(input: {
    manualResultId: string
    draftDigest: string
    role: 'executor' | 'reviewer'
    confirmationId: string
    finalizationId: string
    requestDigest: string
  }) {
    return await this.#localManualContext.run(true, async () => await this.finalizeManualResultRole({
      ...input, approvalSessionRef: input.confirmationId,
    }))
  }

  async finalizeManualResultRole(input: {
    manualResultId: string
    draftDigest: string
    role: 'executor' | 'reviewer'
    approvalSessionRef: string
    finalizationId: string
    requestDigest: string
  }): Promise<{
    status: 'awaiting-reviewer'
    manualResultId: string
    draftDigest: string
    nextRole: 'reviewer'
  } | { status: 'issued'; result: ManualResult }> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.finalizeManualResultRole(input))
    }
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.manualResultId)
      || !/^sha256:[a-f0-9]{64}$/.test(input.draftDigest)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.approvalSessionRef)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.finalizationId)
      || !/^sha256:[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw authorityError('E2E_MANUAL_RESULT_FINALIZATION_INVALID', 'ManualResult 签署请求字段无效')
    }
    const pending = this.#pendingManualResults.get(input.manualResultId)
    if (pending === undefined || pending.draftDigest !== input.draftDigest) {
      throw authorityError('E2E_MANUAL_RESULT_PENDING_NOT_FOUND', '待签 ManualResult 不存在或草稿摘要不匹配')
    }
    const recovered = recoverPendingManualRole(pending, input)
    if (recovered !== undefined) return recovered
    this.#requireCurrentManualDraft(pending.draft)
    const expectedRole = pending.executorPresence === undefined ? 'executor' : 'reviewer'
    if (input.role !== expectedRole) {
      throw authorityError('E2E_MANUAL_RESULT_ROLE_ORDER_INVALID', 'ManualResult 必须由 executor 后 reviewer 顺序签署')
    }
    const actor = input.role === 'executor' ? pending.draft.executor : pending.draft.reviewer
    const approvalType = input.role === 'executor' ? 'manual-executor' : 'manual-reviewer'
    const requiredRole = input.role === 'executor' ? 'e2e-manual-executor' : 'e2e-manual-reviewer'
    const local = this.#localManualContext.getStore() === true
    const now = this.#now().getTime()
    let presence: ManualResultUserPresenceProof
    if (local) {
      const issuedAt = this.#now()
      presence = ManualResultUserPresenceProofSchema.parse({
        role: input.role, approvalType, requiredRole, subject: 'local-caller',
        sessionId: input.approvalSessionRef, runId: pending.draft.runId,
        installationDigest: pending.draft.runtimeInstallationDigest,
        draftDigest: pending.draftDigest, origin: 'http://localhost:1',
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(Math.min(Date.parse(pending.draft.expiresAt),
          issuedAt.getTime() + 10 * 60_000)).toISOString(),
      })
    } else {
      const receipt = await this.#authenticateManualApproverSession(input.approvalSessionRef, {
        approvalType, subjectDigest: pending.draftDigest,
        runId: pending.draft.runId, installationDigest: pending.draft.runtimeInstallationDigest,
      })
      const registered = receipt === undefined ? undefined : this.#manualIdentities.get(receipt.subject)
      if (receipt === undefined || receipt.approvalType !== approvalType
        || receipt.subject !== actor.subject || receipt.subjectDigest !== pending.draftDigest
        || receipt.runId !== pending.draft.runId
        || receipt.installationDigest !== pending.draft.runtimeInstallationDigest
        || now < Date.parse(receipt.issuedAt) || now >= Date.parse(receipt.expiresAt)
        || !matchesRegisteredIdentity(actor, registered) || !registered?.roles.includes(requiredRole)) {
        throw authorityError(
          'E2E_MANUAL_RESULT_SESSION_BINDING_MISMATCH',
          'WebAuthn receipt 未与 ManualResult 草稿、Run、安装、角色及登记身份精确绑定',
        )
      }
      presence = {
        role: input.role, approvalType, requiredRole, subject: receipt.subject,
        sessionId: input.approvalSessionRef, runId: receipt.runId,
        installationDigest: receipt.installationDigest, draftDigest: pending.draftDigest,
        origin: receipt.origin, issuedAt: receipt.issuedAt, expiresAt: receipt.expiresAt,
      }
    }
    if (input.role === 'executor') {
      const response = {
        status: 'awaiting-reviewer', manualResultId: input.manualResultId,
        draftDigest: pending.draftDigest, nextRole: 'reviewer',
      } as const
      this.#pendingManualResults.set(input.manualResultId, { ...pending, executorPresence: presence,
        executorFinalizationId: input.finalizationId, executorRequestDigest: input.requestDigest })
      return response
    }
    if (pending.executorPresence === undefined
      || (!local && pending.executorPresence.subject === presence.subject)
      || pending.executorPresence.sessionId === presence.sessionId
      || now >= Date.parse(pending.executorPresence.expiresAt)) {
      throw authorityError('E2E_MANUAL_RESULT_DUAL_CONTROL_INVALID', 'executor 与 reviewer 必须是不同主体和不同会话')
    }
    const authorityBinding = {
      draft: pending.draft,
      approvalAssurance: local
        ? { approvalMode: 'local-confirmation' as const, identityVerified: false,
            separationOfDutiesVerified: false }
        : { approvalMode: 'webauthn' as const, identityVerified: true,
            separationOfDutiesVerified: true },
      executorPresence: pending.executorPresence,
      reviewerPresence: presence,
    }
    const signedDigest = digestText('manual-result/v2', canonicalizeJson(authorityBinding))
    const authorityProof = {
      issuer: this.#issuer,
      keyId: this.#keyId,
      proofScope: 'local-os-user' as const,
      algorithm: 'Ed25519' as const,
      signedDigest,
      signature: sign(null, manualResultProofPayload(signedDigest), this.#privateKey).toString('base64url'),
      executorPresence: pending.executorPresence,
      reviewerPresence: presence,
      approvalAssurance: authorityBinding.approvalAssurance,
    }
    const result = ManualResultSchema.parse({ ...pending.draft, authorityProof })
    this.#pendingManualResults.set(result.manualResultId, { ...pending,
      reviewerFinalizationId: input.finalizationId, reviewerRequestDigest: input.requestDigest,
      issuedResult: result })
    this.#manualResultIds.add(result.manualResultId)
    return { status: 'issued', result }
  }

  async recoverManualResultRole(input: {
    manualResultId: string
    draftDigest: string
    role: 'executor' | 'reviewer'
    finalizationId: string
    requestDigest: string
  }): Promise<{
    status: 'awaiting-reviewer'; manualResultId: string; draftDigest: string; nextRole: 'reviewer'
  } | { status: 'issued'; result: ManualResult } | undefined> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withStateMutation(() => this.recoverManualResultRole(input))
    }
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.manualResultId)
      || !/^sha256:[a-f0-9]{64}$/.test(input.draftDigest)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.finalizationId)
      || !/^sha256:[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw authorityError('E2E_MANUAL_RESULT_FINALIZATION_INVALID', 'ManualResult 恢复请求字段无效')
    }
    const pending = this.#pendingManualResults.get(input.manualResultId)
    if (pending === undefined || pending.draftDigest !== input.draftDigest) return undefined
    this.#requireCurrentManualDraft(pending.draft)
    return recoverPendingManualRole(pending, input)
  }

  async issueManualResult(_input: { draft: ManualResultDraft }): Promise<ManualResult> {
    throw authorityError(
      'E2E_MANUAL_RESULT_USER_PRESENCE_REQUIRED',
      'ManualResult 必须通过 prepareManualResult 与两个独立 WebAuthn session 签署',
    )
  }

  verifyManualResult(candidate: ManualResult): ManualResultVerification {
    const legacyWebAuthnProof = isPlainSnapshot(candidate)
      && isPlainSnapshot(candidate.authorityProof)
      && !Object.hasOwn(candidate.authorityProof, 'approvalAssurance')
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
    const expectedDraftDigest = manualResultDraftDigest(draft)
    if (authorityProof.executorPresence.draftDigest !== expectedDraftDigest
      || authorityProof.reviewerPresence.draftDigest !== expectedDraftDigest) {
      return { valid: false, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked' }
    }
    const expectedDigest = digestText('manual-result/v2', canonicalizeJson({
      draft,
      ...(legacyWebAuthnProof ? {} : { approvalAssurance: authorityProof.approvalAssurance }),
      executorPresence: authorityProof.executorPresence,
      reviewerPresence: authorityProof.reviewerPresence,
    }))
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

  #requireCurrentManualDraft(draft: ManualResultDraft): void {
    const now = this.#now().getTime()
    const finishedAt = Date.parse(draft.finishedAt)
    const expiresAt = Date.parse(draft.expiresAt)
    if (finishedAt > now || expiresAt <= now || expiresAt - finishedAt > MAX_MANUAL_RESULT_VALIDITY_MS) {
      throw authorityError('E2E_MANUAL_RESULT_VALIDITY_INVALID', 'ManualResult 必须已完成、尚未过期且有效期不超过 30 天')
    }
  }

  #pruneExpiredPendingManualResults(): void {
    const now = this.#now().getTime()
    for (const [manualResultId, pending] of this.#pendingManualResults) {
      const executorExpiresAt = pending.executorPresence === undefined
        ? Number.POSITIVE_INFINITY : Date.parse(pending.executorPresence.expiresAt)
      if (pending.issuedResult === undefined
        && (Date.parse(pending.draft.expiresAt) <= now || executorExpiresAt <= now)) {
        this.#pendingManualResults.delete(manualResultId)
      }
    }
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
      const versioned = this.#stateStore!.beginVersioned()
      const current = parseAuthoritySnapshot(versioned.snapshot, this.#issuer,
        this.#decisionKeyId, this.#decisionPublicKey, this.#stateEncryptionKey!, versioned.revision)
      verifyAuthorityStateAnchor(this.#stateAnchor!, current)
      this.#hydrateState(current)
      this.#activeStateTransactions += 1
      try {
        return await this.#stateContext.run(true, async () => {
          const result = await operation()
          const next = this.#persistentSnapshot(versioned.revision + 1)
          this.#stateStore!.commit(canonicalizeJson(next))
          this.#stateAnchor!.compareAndAdvance(anchorPoint(current), anchorPoint(next))
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
      const versioned = this.#stateStore!.beginVersioned()
      const current = parseAuthoritySnapshot(versioned.snapshot, this.#issuer,
        this.#decisionKeyId, this.#decisionPublicKey, this.#stateEncryptionKey!, versioned.revision)
      verifyAuthorityStateAnchor(this.#stateAnchor!, current)
      this.#hydrateState(current)
      this.#activeStateTransactions += 1
      try {
        return this.#stateContext.run(true, () => {
          const result = operation()
          const next = this.#persistentSnapshot(versioned.revision + 1)
          this.#stateStore!.commit(canonicalizeJson(next))
          this.#stateAnchor!.compareAndAdvance(anchorPoint(current), anchorPoint(next))
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
      const versioned = this.#stateStore!.beginVersioned()
      const current = parseAuthoritySnapshot(versioned.snapshot, this.#issuer,
        this.#decisionKeyId, this.#decisionPublicKey, this.#stateEncryptionKey!, versioned.revision)
      verifyAuthorityStateAnchor(this.#stateAnchor!, current)
      this.#hydrateState(current)
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
      const versioned = this.#stateStore!.beginVersioned()
      const current = parseAuthoritySnapshot(versioned.snapshot, this.#issuer,
        this.#decisionKeyId, this.#decisionPublicKey, this.#stateEncryptionKey!, versioned.revision)
      verifyAuthorityStateAnchor(this.#stateAnchor!, current)
      this.#hydrateState(current)
      this.#activeStateTransactions += 1
      try {
        return this.#stateContext.run(true, operation)
      } finally {
        this.#stateStore!.rollback()
        this.#activeStateTransactions -= 1
      }
    })
  }

  #persistentSnapshot(revision: number): AuthorityPersistentSnapshot {
    return signAuthoritySnapshot({
      schemaVersion: '2.8.0', issuer: this.#issuer, keyId: this.#keyId, identityDigest: this.#identityDigest,
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
      webAuthnReceipts: encryptWebAuthnReceipts(
        [...this.#webAuthnReceipts.entries()],
        this.#stateEncryptionKey!,
      ),
      grants: [...this.#grants.entries()], grantFinalizations: [...this.#grantFinalizations.entries()],
      acknowledgedFinalizations: [...this.#acknowledgedFinalizations.entries()],
      revoked: [...this.#revoked.entries()], uses: [...this.#uses.entries()],
      reservations: [...this.#reservations.entries()],
      reservationRpcBindings: [...this.#reservationRpcBindings.entries()],
      completedPreflights: [...this.#completedPreflights.entries()],
      manualResultIds: [...this.#manualResultIds],
      pendingManualResults: [...this.#pendingManualResults.entries()],
      attemptLogs: [...this.#attemptLogs.entries()],
    }, revision, this.#stateEncryptionKey!)
  }

  #hydrateState(snapshot: AuthorityPersistentSnapshot): void {
    if (snapshot.issuer !== this.#issuer || snapshot.keyId !== this.#keyId
      || snapshot.identityDigest !== this.#identityDigest) {
      throw authorityError('E2E_AUTHORITY_STATE_IDENTITY_MISMATCH', '持久 Authority snapshot 与当前实例不匹配')
    }
    replaceMap(this.#grants, snapshot.grants)
    replaceMap(this.#grantFinalizations, snapshot.grantFinalizations)
    replaceMap(this.#acknowledgedFinalizations, snapshot.acknowledgedFinalizations)
    replaceMap(this.#revoked, snapshot.revoked)
    replaceMap(this.#uses, snapshot.uses)
    replaceMap(this.#reservations, snapshot.reservations)
    replaceMap(this.#reservationRpcBindings, snapshot.reservationRpcBindings)
    replaceMap(this.#completedPreflights, snapshot.completedPreflights)
    this.#manualResultIds.clear()
    for (const id of snapshot.manualResultIds) this.#manualResultIds.add(id)
    replaceMap(this.#pendingManualResults, snapshot.pendingManualResults)
    replaceMap(this.#attemptLogs, snapshot.attemptLogs)
    replaceMap(
      this.#webAuthnCredentials,
      decryptWebAuthnCredentials(snapshot.webAuthnCredentials, this.#stateEncryptionKey!)
        .map((credential) => [credential.id, credential]),
    )
    replaceMap(
      this.#webAuthnReceipts,
      decryptWebAuthnReceipts(snapshot.webAuthnReceipts, this.#stateEncryptionKey!),
    )
  }

  private async validateApproverAndTtl(
    claimedApprover: ApproverIdentity | undefined,
    approvalSessionRef: string | undefined,
    expected: { approvalType: 'discovery' | 'execution'; subjectDigest: string },
    ttlMs: number,
    maximum: number,
  ): Promise<{ approver: ApprovalApprover; context: CanonicalApprovalContext }> {
    if (claimedApprover !== undefined
      && (!matchesRegisteredIdentity(claimedApprover, this.#approvalIdentities.get(claimedApprover.subject))
        || !claimedApprover.roles.includes('e2e-approver'))) {
      throw authorityError(
        'E2E_APPROVAL_APPROVER_UNTRUSTED',
        '审批人必须通过 Authority 会话认证且是登记的 e2e-approver',
      )
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximum) {
      throw authorityError('E2E_APPROVAL_TTL_INVALID', `Grant TTL 必须在 1ms 到 ${maximum}ms 之间`)
    }
    const local = this.#localApprovalContext.getStore()
    if (local !== undefined) {
      if (claimedApprover !== undefined
        || local.expected.approvalType !== expected.approvalType
        || local.expected.subjectDigest !== expected.subjectDigest) {
        throw authorityError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', '本地确认与实际 Grant subject 不一致')
      }
      const issuedAt = this.#now()
      return {
        approver: { kind: 'local-caller' },
        context: CanonicalApprovalContextSchema.parse({
          schemaVersion: '1.0.0', subject: 'local-caller', runId: local.binding.runId,
          approvalType: expected.approvalType, subjectDigest: expected.subjectDigest,
          installationDigest: local.binding.installationDigest, origin: 'http://localhost',
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
        }),
      }
    }
    const receipt = approvalSessionRef
      ? await this.#authenticateApproverSession(approvalSessionRef, expected)
      : undefined
    if (receipt === undefined) {
      throw authorityError('E2E_APPROVAL_APPROVER_UNTRUSTED', '审批人必须通过 Authority 会话认证且是登记的 e2e-approver')
    }
    const context = CanonicalApprovalContextSchema.safeParse({ schemaVersion: '1.0.0', ...receipt })
    const registered = context.success ? this.#approvalIdentities.get(context.data.subject) : undefined
    if (!context.success
      || (claimedApprover !== undefined && context.data.subject !== claimedApprover.subject)
      || context.data.approvalType !== expected.approvalType
      || context.data.subjectDigest !== expected.subjectDigest
      || this.#now().getTime() > Date.parse(context.data.expiresAt)) {
      throw authorityError('E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'WebAuthn approval receipt 与实际 Grant/可信 Run 上下文不一致')
    }
    if (registered === undefined || !registered.roles.includes('e2e-approver')) {
      throw authorityError(
        'E2E_APPROVAL_APPROVER_UNTRUSTED',
        'WebAuthn receipt subject 必须属于 Authority 登记的 e2e-approver',
      )
    }
    return {
      approver: { subject: registered.subject, roles: [...registered.roles] },
      context: context.data,
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

function approvalContextMismatch(
  grant: SignedGrant,
  current: CanonicalApprovalContext,
  now: Date,
): Extract<GrantDecision, { allowed: false }> | undefined {
  if (current.approvalType !== canonicalGrantApprovalType(grant.subject)
    || canonicalizeJson(current) !== canonicalizeJson(grant.approvalContext)
    || current.subject !== approvalApproverSubject(grant.approver)
    || current.subjectDigest !== grant.subjectDigest
    || Date.parse(current.issuedAt) > now.getTime()
    || Date.parse(current.expiresAt) <= now.getTime()) {
    return { allowed: false, code: 'E2E_APPROVAL_CONTEXT_MISMATCH',
      reason: 'Grant approvalContext 与当前可信执行上下文不一致或已失效' }
  }
  return undefined
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
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64') }
  } finally { plaintext.fill(0) }
}

function decryptPrivateKey(value: EncryptedPrivateKey, encryptionKey: Buffer, keyName: string): KeyObject {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(`e2e-authority-private-key/v1:${keyName}`))
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ])
  try {
    const key = createPrivateKey({ key: plaintext, type: 'pkcs8', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('unexpected key type')
    return key
  } finally { plaintext.fill(0) }
}

function parseAuthoritySnapshot(
  value: string,
  issuer: string,
  decisionKeyId: string,
  decisionPublicKey: KeyObject,
  stateEncryptionKey: Buffer,
  revision: number,
): AuthorityPersistentSnapshot {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 不是合法 JSON')
  }
  const snapshot = parseCurrentAuthoritySnapshot(parsed)
  verifyAuthoritySnapshotProof(snapshot, revision, stateEncryptionKey)
  validateReservationRpcBindingCryptography(snapshot, issuer, decisionKeyId, decisionPublicKey)
  return snapshot
}

function signAuthoritySnapshot(
  candidate: Record<string, unknown>,
  revision: number,
  stateEncryptionKey: Buffer,
): AuthorityPersistentSnapshot {
  if (!Number.isSafeInteger(revision) || revision < 1) corruptSnapshot()
  const { stateRevision: _revision, stateDigest: _digest, stateMac: _mac, ...unsigned } = candidate
  const stateDigest = digestText('authority-state-snapshot/v1', canonicalizeJson(unsigned))
  return parseCurrentAuthoritySnapshot({ ...unsigned, stateRevision: revision, stateDigest,
    stateMac: authoritySnapshotMac(stateEncryptionKey, { revision, snapshotDigest: stateDigest }) })
}

function verifyAuthoritySnapshotProof(
  snapshot: AuthorityPersistentSnapshot,
  revision: number,
  stateEncryptionKey: Buffer,
): void {
  const { stateRevision, stateDigest, stateMac, ...unsigned } = snapshot
  const expectedDigest = digestText('authority-state-snapshot/v1', canonicalizeJson(unsigned))
  const expectedMac = Buffer.from(authoritySnapshotMac(stateEncryptionKey, {
    revision: stateRevision, snapshotDigest: stateDigest,
  }), 'base64url')
  const actualMac = Buffer.from(stateMac, 'base64url')
  if (stateRevision !== revision || stateDigest !== expectedDigest
    || actualMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(actualMac, expectedMac)) {
    throw authorityError('E2E_AUTHORITY_STATE_AUTHENTICATION_FAILED', 'Authority snapshot 摘要、MAC 或 SQLite revision 不闭合')
  }
}

function verifyAuthorityStateAnchor(
  anchor: AuthorityStateAnchorProvider,
  snapshot: AuthorityPersistentSnapshot,
): void {
  const high = anchor.read()
  if (high === undefined) {
    throw authorityError('E2E_AUTHORITY_STATE_ANCHOR_MISSING', '当前 Authority snapshot 缺少单调 anchor')
  }
  if (high.revision !== snapshot.stateRevision || high.snapshotDigest !== snapshot.stateDigest) {
    throw authorityError('E2E_AUTHORITY_STATE_ROLLBACK_DETECTED', 'Authority SQLite 状态与外部单调高水位不精确闭合')
  }
}

function anchorPoint(snapshot: AuthorityPersistentSnapshot): AuthorityStateAnchorPoint {
  return { revision: snapshot.stateRevision, snapshotDigest: snapshot.stateDigest }
}

function cleanupAuthorityResources(
  store: SqliteSnapshotStore | undefined,
  anchor: AuthorityStateAnchorProvider | undefined,
  key: Buffer | undefined,
): unknown[] {
  const errors: unknown[] = []
  try { store?.close() } catch (error) { errors.push(error) }
  try { anchor?.close() } catch (error) { errors.push(error) }
  key?.fill(0)
  return errors
}

function throwWithAuthorityCleanup(
  cause: unknown,
  store: SqliteSnapshotStore | undefined,
  anchor: AuthorityStateAnchorProvider | undefined,
  key: Buffer | undefined,
): never {
  const errors = cleanupAuthorityResources(store, anchor, key)
  if (errors.length > 0) throw new AggregateError([cause, ...errors], 'E2E_AUTHORITY_OPEN_CLEANUP_FAILED')
  throw cause
}

function loadAuthoritySnapshot(
  value: string,
  stateEncryptionKey: Buffer,
  revision: number,
): {
  snapshot: AuthorityPersistentSnapshot
  migrated: boolean
  privateKeys: DecryptedAuthorityPrivateKeys
} {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 不是合法 JSON')
  }
  if (!isPlainSnapshot(parsed)) {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 结构无效')
  }
  const policy = authoritySnapshotPolicy(parsed.schemaVersion)
  const version = policy.schemaVersion
  parseAuthoritySnapshotStructure(parsed, policy)
  const encryptedKeys = parsed.privateKeys as AuthorityPersistentSnapshot['privateKeys']
  let privateKeys: DecryptedAuthorityPrivateKeys
  try {
    privateKeys = {
      primary: decryptPrivateKey(encryptedKeys.primary, stateEncryptionKey, 'primary'),
      freshness: decryptPrivateKey(encryptedKeys.freshness, stateEncryptionKey, 'freshness'),
      privacyReview: decryptPrivateKey(encryptedKeys.privacyReview, stateEncryptionKey, 'privacyReview'),
      decision: decryptPrivateKey(encryptedKeys.decision, stateEncryptionKey, 'decision'),
      attempt: decryptPrivateKey(encryptedKeys.attempt, stateEncryptionKey, 'attempt'),
    }
  } catch {
    throw authorityError('E2E_AUTHORITY_STATE_DECRYPTION_FAILED', 'Authority 状态密钥错误或私钥密文已损坏')
  }
  validateSnapshotCryptography(parsed, privateKeys)
  if (policy.hasCredentials) {
    decryptWebAuthnCredentials(parsed.webAuthnCredentials as EncryptedPrivateKey, stateEncryptionKey)
  }
  if (policy.hasReceipts) {
    decryptWebAuthnReceipts(parsed.webAuthnReceipts as EncryptedPrivateKey, stateEncryptionKey)
    if (version === '2.8.0') {
      const snapshot = parsed as unknown as AuthorityPersistentSnapshot
      verifyAuthoritySnapshotProof(snapshot, revision, stateEncryptionKey)
      return { snapshot, migrated: false, privateKeys }
    }
    if (version === '2.7.0') {
      verifyAuthoritySnapshotProof(parsed as unknown as AuthorityPersistentSnapshot, revision, stateEncryptionKey)
    }
    const writeCompatible = policy.hasApprovalContext && policy.writeContract === 'legacy-v23'
      ? migrateLegacyWriteGrants(parsed)
      : parsed
    const migrationSource = migrateLegacyReservationOwners(writeCompatible)
    return {
      snapshot: signAuthoritySnapshot({
        ...migrationSource,
        schemaVersion: '2.8.0',
        ...(version === '2.2.0' ? { grantFinalizations: [] } : {}),
        ...(version === '2.2.0' || version === '2.3.0' ? { acknowledgedFinalizations: [] } : {}),
        reservationRpcBindings: [],
        pendingManualResults: [],
      }, revision + 1, stateEncryptionKey),
      migrated: true,
      privateKeys,
    }
  }
  const snapshot = signAuthoritySnapshot({
    ...parsed,
    schemaVersion: '2.8.0',
    grants: [],
    grantFinalizations: [],
    acknowledgedFinalizations: [],
    revoked: (parsed.grants as Array<[string, unknown]>).map(([grantId]) =>
      [grantId, 'legacy-approval-context-migration'] as [string, string]),
    uses: [],
    reservations: [],
    reservationRpcBindings: [],
    completedPreflights: [],
    attemptLogs: [],
    pendingManualResults: [],
    ...(version === '2.0.0'
      ? { webAuthnCredentials: encryptWebAuthnCredentials([], stateEncryptionKey) }
      : {}),
    webAuthnReceipts: encryptWebAuthnReceipts([], stateEncryptionKey),
  }, revision + 1, stateEncryptionKey)
  return { snapshot, migrated: true, privateKeys }
}

function migrateLegacyWriteGrants(snapshot: Record<string, unknown>): Record<string, unknown> {
  const incompatibleGrantIds = new Set<string>()
  for (const [grantId, grant] of snapshot.grants as Array<[string, Record<string, unknown>]>) {
    if (validateStoredGrantSubject(grant.subject, 'legacy-v23') !== 'write') continue
    const capabilities = grant.capabilities as Array<Record<string, unknown>>
    if (!validateStoredWriteSubject(grant.subject, 'current')
      || capabilities.some((capability) => !validateStoredWriteRequests(capability.requests, 'current'))) {
      incompatibleGrantIds.add(grantId)
    }
  }
  if (incompatibleGrantIds.size === 0) return snapshot

  const removedCapabilityKeys = new Set(
    (snapshot.grants as Array<[string, SignedGrant]>)
      .filter(([grantId]) => incompatibleGrantIds.has(grantId))
      .flatMap(([grantId, grant]) => grant.capabilities.map((capability) =>
        `${grantId}:${capability.capabilityId}`)),
  )
  const removedReservationIds = new Set(
    (snapshot.reservations as Array<[string, { grantId: string }]>)
      .filter(([, reservation]) => incompatibleGrantIds.has(reservation.grantId))
      .map(([reservationId]) => reservationId),
  )
  const referencesRemovedReservation = (log: { events: AttemptEvent[] }): boolean =>
    log.events.some((event) => event.kind === 'terminal'
      && event.result.reservationId !== undefined
      && removedReservationIds.has(event.result.reservationId))

  return {
    ...snapshot,
    grants: (snapshot.grants as Array<[string, unknown]>)
      .filter(([grantId]) => !incompatibleGrantIds.has(grantId)),
    ...(Array.isArray(snapshot.grantFinalizations) ? {
      grantFinalizations: (snapshot.grantFinalizations as Array<[string, StoredGrantFinalization]>)
        .filter(([, finalization]) => !incompatibleGrantIds.has(finalization.grantId)),
    } : {}),
    revoked: [
      ...(snapshot.revoked as Array<[string, string]>)
        .filter(([grantId]) => !incompatibleGrantIds.has(grantId)),
      ...[...incompatibleGrantIds].map((grantId) =>
        [grantId, 'legacy-write-method-migration'] as [string, string]),
    ],
    uses: (snapshot.uses as Array<[string, number]>)
      .filter(([key]) => !removedCapabilityKeys.has(key)),
    reservations: (snapshot.reservations as Array<[string, { grantId: string }]>)
      .filter(([, reservation]) => !incompatibleGrantIds.has(reservation.grantId)),
    ...(Array.isArray(snapshot.reservationRpcBindings) ? {
      reservationRpcBindings: (snapshot.reservationRpcBindings as Array<[string, unknown]>)
        .filter(([reservationId]) => !removedReservationIds.has(reservationId)),
    } : {}),
    completedPreflights: (snapshot.completedPreflights as Array<[string, { grantId: string }]>)
      .filter(([, preflight]) => !incompatibleGrantIds.has(preflight.grantId)),
    attemptLogs: (snapshot.attemptLogs as AuthorityPersistentSnapshot['attemptLogs'])
      .filter(([, log]) => !referencesRemovedReservation(log)),
  }
}

function migrateLegacyReservationOwners(snapshot: Record<string, unknown>): Record<string, unknown> {
  const reservations = (snapshot.reservations as Array<[string, Record<string, unknown>]>).map(
    ([reservationId, reservation]) => reservation.status === 'reserved'
      ? [reservationId, {
        ...reservation,
        status: 'unknown',
        observation: 'legacy-reservation-owner-migration-effect-unknown',
      }] as [string, Record<string, unknown>]
      : [reservationId, reservation] as [string, Record<string, unknown>],
  )
  return { ...snapshot, reservations, reservationRpcBindings: [] }
}

function parseCurrentAuthoritySnapshot(parsed: unknown): AuthorityPersistentSnapshot {
  if (!isPlainSnapshot(parsed) || parsed.schemaVersion !== '2.8.0') {
    throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 结构无效')
  }
  parseAuthoritySnapshotStructure(parsed, authoritySnapshotPolicy('2.8.0'))
  return parsed as unknown as AuthorityPersistentSnapshot
}

type AuthoritySnapshotVersion = '2.0.0' | '2.1.0' | '2.2.0' | '2.3.0' | '2.4.0' | '2.5.0' | '2.6.0' | '2.7.0' | '2.8.0'
type StoredWriteContract = 'legacy-v23' | 'current'

interface AuthoritySnapshotPolicy {
  schemaVersion: AuthoritySnapshotVersion
  hasCredentials: boolean
  hasReceipts: boolean
  hasApprovalContext: boolean
  hasGrantFinalizations: boolean
  hasAcknowledgedFinalizations: boolean
  hasReservationRpcBindings: boolean
  authenticatedReservationRpcBindings: boolean
  authenticatedSnapshot: boolean
  hasPendingManualResults: boolean
  writeContract: StoredWriteContract
}

function authoritySnapshotPolicy(version: unknown): AuthoritySnapshotPolicy {
  switch (version) {
    case '2.0.0': return {
      schemaVersion: version, hasCredentials: false, hasReceipts: false, hasApprovalContext: false,
      hasGrantFinalizations: false, hasAcknowledgedFinalizations: false, writeContract: 'legacy-v23',
      hasReservationRpcBindings: false, authenticatedReservationRpcBindings: false,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.1.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: false, hasApprovalContext: false,
      hasGrantFinalizations: false, hasAcknowledgedFinalizations: false, writeContract: 'legacy-v23',
      hasReservationRpcBindings: false, authenticatedReservationRpcBindings: false,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.2.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: false, hasAcknowledgedFinalizations: false, writeContract: 'legacy-v23',
      hasReservationRpcBindings: false, authenticatedReservationRpcBindings: false,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.3.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: true, hasAcknowledgedFinalizations: false, writeContract: 'legacy-v23',
      hasReservationRpcBindings: false, authenticatedReservationRpcBindings: false,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.4.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: true, hasAcknowledgedFinalizations: true, writeContract: 'current',
      hasReservationRpcBindings: false, authenticatedReservationRpcBindings: false,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.5.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: true, hasAcknowledgedFinalizations: true, writeContract: 'current',
      hasReservationRpcBindings: true, authenticatedReservationRpcBindings: false,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.6.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: true, hasAcknowledgedFinalizations: true, writeContract: 'current',
      hasReservationRpcBindings: true, authenticatedReservationRpcBindings: true,
      authenticatedSnapshot: false, hasPendingManualResults: false,
    }
    case '2.7.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: true, hasAcknowledgedFinalizations: true, writeContract: 'current',
      hasReservationRpcBindings: true, authenticatedReservationRpcBindings: true,
      authenticatedSnapshot: true, hasPendingManualResults: false,
    }
    case '2.8.0': return {
      schemaVersion: version, hasCredentials: true, hasReceipts: true, hasApprovalContext: true,
      hasGrantFinalizations: true, hasAcknowledgedFinalizations: true, writeContract: 'current',
      hasReservationRpcBindings: true, authenticatedReservationRpcBindings: true,
      authenticatedSnapshot: true, hasPendingManualResults: true,
    }
    default:
      throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 版本未知或旧结构无效')
  }
}

function parseAuthoritySnapshotStructure(
  candidate: Record<string, unknown>,
  policy: AuthoritySnapshotPolicy,
): void {
  const privateKeys = candidate.privateKeys as Record<string, unknown> | undefined
  if (!hasExactSnapshotKeys(
    candidate, policy,
  )
    || typeof candidate.issuer !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(candidate.issuer)
    || typeof candidate.keyId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(candidate.keyId)
    || typeof candidate.identityDigest !== 'string' || !isDigest(candidate.identityDigest)
    || (policy.authenticatedSnapshot && (
      typeof candidate.stateRevision !== 'number' || !Number.isSafeInteger(candidate.stateRevision)
      || candidate.stateRevision < 1 || typeof candidate.stateDigest !== 'string'
      || !isDigest(candidate.stateDigest) || typeof candidate.stateMac !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(candidate.stateMac)))
    || !privateKeys || Object.keys(privateKeys).sort().join('\0')
      !== ['attempt', 'decision', 'freshness', 'primary', 'privacyReview'].join('\0')
    || Object.values(privateKeys).some((key) => !isEncryptedBlob(key))
    || (policy.hasCredentials && !isEncryptedBlob(candidate.webAuthnCredentials))
    || (policy.hasReceipts && !isEncryptedBlob(candidate.webAuthnReceipts))
    || !Array.isArray(candidate.grants) || !Array.isArray(candidate.revoked) || !Array.isArray(candidate.uses)
    || !Array.isArray(candidate.reservations) || candidate.reservations.length > MAX_RESERVATION_RECORDS
    || !Array.isArray(candidate.completedPreflights)
    || (policy.hasReservationRpcBindings && !Array.isArray(candidate.reservationRpcBindings))
    || (policy.hasPendingManualResults && (!Array.isArray(candidate.pendingManualResults)
      || candidate.pendingManualResults.length > MAX_PENDING_MANUAL_RESULTS))
    || !Array.isArray(candidate.manualResultIds) || !Array.isArray(candidate.attemptLogs)) {
    corruptSnapshot()
  }
  const grants = parseUniqueTuples(candidate.grants, 'grant', (key, value) => {
    if (!isPlainSnapshot(value) || value.grantId !== key) corruptSnapshot()
    validateStoredGrantStructure(value, policy)
  })
  const grantMap = new Map(grants.map(([key, value]) => [key, value as unknown as SignedGrant]))
  let finalizationIds = new Set<string>()
  if (policy.hasGrantFinalizations) {
    const grantFinalizations = candidate.grantFinalizations
    const acknowledgedFinalizations = candidate.acknowledgedFinalizations
    if (!Array.isArray(grantFinalizations)
      || (policy.hasAcknowledgedFinalizations && !Array.isArray(acknowledgedFinalizations))
      || grantFinalizations.length
        + (Array.isArray(acknowledgedFinalizations) ? acknowledgedFinalizations.length : 0)
          > MAX_GRANT_FINALIZATIONS) corruptSnapshot()
    const parsedFinalizations = parseUniqueTuples(
      grantFinalizations as unknown[], 'grant finalization', (key, value) => {
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(key) || !isPlainSnapshot(value)
        || Object.keys(value).sort().join('\0')
          !== ['approvalBinding', 'approvalSessionRef', 'grantId', 'requestDigest', 'subject'].join('\0')
        || typeof value.requestDigest !== 'string' || !isDigest(value.requestDigest)
        || typeof value.grantId !== 'string' || !grantMap.has(value.grantId)
        || typeof value.approvalSessionRef !== 'string'
        || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.approvalSessionRef)) corruptSnapshot()
      validateStoredGrantSubject(value.subject, policy.writeContract)
      let binding: ApprovalExecutionBinding
      try { binding = parseApprovalExecutionBinding(value.approvalBinding) }
      catch { return corruptSnapshot() }
      const grant = grantMap.get(value.grantId as string)!
      if (canonicalizeJson(value.subject) !== canonicalizeJson(grant.subject)
        || !sameApprovalExecutionBinding(grant.approvalContext, binding)) corruptSnapshot()
      },
    )
    finalizationIds = new Set(parsedFinalizations.map(([key]) => key))
  }
  if (policy.hasAcknowledgedFinalizations) {
    parseUniqueTuples(candidate.acknowledgedFinalizations as unknown[], 'acknowledged finalization', (key, value) => {
      if (finalizationIds.has(key) || !/^[A-Za-z0-9._:-]{1,256}$/.test(key) || !isPlainSnapshot(value)
        || Object.keys(value).sort().join('\0')
          !== ['approvalBinding', 'expiresAt', 'grantId', 'requestDigest'].join('\0')
        || typeof value.requestDigest !== 'string' || !isDigest(value.requestDigest)
        || typeof value.grantId !== 'string' || !grantMap.has(value.grantId)
        || typeof value.expiresAt !== 'string' || !isCanonicalInstant(value.expiresAt)) corruptSnapshot()
      let binding: ApprovalExecutionBinding
      try { binding = parseApprovalExecutionBinding(value.approvalBinding) }
      catch { return corruptSnapshot() }
      const grant = grantMap.get(value.grantId as string)!
      if (value.expiresAt !== grant.expiresAt
        || !sameApprovalExecutionBinding(grant.approvalContext, binding)) corruptSnapshot()
    })
  }
  parseUniqueTuples(candidate.revoked, 'revocation', (key, reason) => {
    const migratedTombstone = reason === 'legacy-approval-context-migration'
      || reason === 'legacy-write-method-migration'
    if ((!grantMap.has(key) && !migratedTombstone)
      || typeof reason !== 'string' || reason.length === 0 || reason.length > 16 * 1024) {
      corruptSnapshot()
    }
  })
  const uses = parseUniqueTuples(candidate.uses, 'use', (key, count) => {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
      || ![...grantMap.values()].some((grant) => grant.capabilities.some((capability) =>
        `${grant.grantId}:${capability.capabilityId}` === key))) corruptSnapshot()
  })
  const useMap = new Map(uses.map(([key, count]) => [key, count as number]))
  const reservations = parseUniqueTuples(candidate.reservations, 'reservation', (key, value) => {
    validateStoredReservation(key, value, grantMap)
  })
  const reservationMap = new Map(reservations.map(([key, value]) =>
    [key, value as unknown as CapabilityReservation]))
  const reservationCounts = new Map<string, number>()
  for (const reservation of reservationMap.values()) {
    const key = `${reservation.grantId}:${reservation.capabilityId}`
    reservationCounts.set(key, (reservationCounts.get(key) ?? 0) + 1)
  }
  for (const grant of grantMap.values()) {
    for (const capability of grant.capabilities) {
      const key = `${grant.grantId}:${capability.capabilityId}`
      const count = reservationCounts.get(key) ?? 0
      if ((useMap.get(key) ?? 0) !== count || count > capability.maxUses) corruptSnapshot()
    }
  }
  if (policy.hasReservationRpcBindings) {
    parseUniqueTuples(candidate.reservationRpcBindings as unknown[], 'reservation RPC binding', (key, value) => {
      const reservation = reservationMap.get(key)
      const grant = reservation === undefined ? undefined : grantMap.get(reservation.grantId)
      if (grant === undefined) corruptSnapshot()
      try {
        if (policy.authenticatedReservationRpcBindings) {
          parseReservationRpcOwnerBinding(key, value, grant.approvalContext)
        } else {
          parseReservationRpcOwnerClaim(value, grant.approvalContext)
        }
      }
      catch { corruptSnapshot() }
    })
  }
  parseUniqueTuples(candidate.completedPreflights, 'preflight', (key, value) => {
    validateStoredPreflight(key, value, grantMap)
  })
  if (candidate.manualResultIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(id))
    || new Set(candidate.manualResultIds).size !== candidate.manualResultIds.length) corruptSnapshot()
  if (policy.hasPendingManualResults) {
    const issued = new Set(candidate.manualResultIds as string[])
    parseUniqueTuples(candidate.pendingManualResults as unknown[], 'pending manual result', (key, value) => {
      const pending = parsePendingManualResult(value)
      if (pending.draft.manualResultId !== key
        || issued.has(key) !== (pending.issuedResult !== undefined)) corruptSnapshot()
    })
  }
  parseUniqueTuples(candidate.attemptLogs, 'attempt log', (key, value) =>
    validateStoredAttemptLog(key, value, grantMap, reservationMap))
}

function hasExactSnapshotKeys(
  candidate: Record<string, unknown>,
  policy: AuthoritySnapshotPolicy,
): boolean {
  const keys = [
    'attemptLogs', 'completedPreflights', 'grants', 'identityDigest', 'issuer', 'keyId', 'manualResultIds',
    'privateKeys', 'reservations', 'revoked', 'schemaVersion', 'uses',
    ...(policy.hasCredentials ? ['webAuthnCredentials'] : []),
    ...(policy.hasReceipts ? ['webAuthnReceipts'] : []),
    ...(policy.hasGrantFinalizations ? ['grantFinalizations'] : []),
    ...(policy.hasAcknowledgedFinalizations ? ['acknowledgedFinalizations'] : []),
    ...(policy.hasReservationRpcBindings ? ['reservationRpcBindings'] : []),
    ...(policy.hasPendingManualResults ? ['pendingManualResults'] : []),
    ...(policy.authenticatedSnapshot ? ['stateDigest', 'stateMac', 'stateRevision'] : []),
  ].sort()
  return Object.keys(candidate).sort().join('\0') === keys.join('\0')
}

function isPlainSnapshot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function parseUniqueTuples(
  value: unknown[],
  _name: string,
  validate: (key: string, entry: unknown) => void,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = []
  const keys = new Set<string>()
  for (const tuple of value) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string'
      || !tuple[0] || tuple[0].length > 16 * 1024 || keys.has(tuple[0])) corruptSnapshot()
    keys.add(tuple[0])
    validate(tuple[0], tuple[1])
    entries.push([tuple[0], tuple[1]])
  }
  return entries
}

type StoredGrantKind = 'discovery' | 'read' | 'write' | 'injection' | 'websocket' | 'sse'

function validateStoredGrantStructure(grant: Record<string, unknown>, policy: AuthoritySnapshotPolicy): void {
  requireExactKeys(grant, [
    ...(policy.hasApprovalContext ? ['approvalContext'] : []),
    'approver', 'capabilities', 'expiresAt', 'grantId', 'issuedAt', 'issuer', 'keyId', 'proofScope',
    'revocationSequence', 'signature', 'subject', 'subjectDigest',
  ])
  if (typeof grant.grantId !== 'string' || typeof grant.issuer !== 'string' || typeof grant.keyId !== 'string'
    || grant.proofScope !== 'local-os-user' || typeof grant.subjectDigest !== 'string' || !isDigest(grant.subjectDigest)
    || typeof grant.issuedAt !== 'string' || !isCanonicalInstant(grant.issuedAt)
    || typeof grant.expiresAt !== 'string' || !isCanonicalInstant(grant.expiresAt)
    || Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)
    || typeof grant.revocationSequence !== 'number' || !Number.isSafeInteger(grant.revocationSequence)
    || grant.revocationSequence < 0 || !isCanonicalBase64Url(grant.signature, 64)
    || !isPlainSnapshot(grant.approver)) corruptSnapshot()
  const localCaller = grant.approver.kind === 'local-caller'
  if (localCaller) requireExactKeys(grant.approver, ['kind'])
  else {
    requireExactKeys(grant.approver, ['roles', 'subject'])
    if (typeof grant.approver.subject !== 'string' || !Array.isArray(grant.approver.roles)
      || grant.approver.roles.some((role) => typeof role !== 'string')
      || new Set(grant.approver.roles).size !== grant.approver.roles.length) corruptSnapshot()
  }
  const kind = validateStoredGrantSubject(grant.subject, policy.writeContract)
  const context = policy.hasApprovalContext ? CanonicalApprovalContextSchema.safeParse(grant.approvalContext) : undefined
  const expectedSubjectDigest = policy.hasApprovalContext
    ? digestCanonicalGrantApprovalSubject(kind === 'discovery' ? 'discovery' : 'execution', grant.subject)
    : digestText('approval-subject/v1', canonicalizeJson(grant.subject))
  if ((policy.hasApprovalContext && (!context?.success
    || context.data.subject !== (localCaller ? 'local-caller' : grant.approver.subject)
    || context.data.approvalType !== (kind === 'discovery' ? 'discovery' : 'execution')
    || context.data.subjectDigest !== grant.subjectDigest))
    || expectedSubjectDigest !== grant.subjectDigest
    || !Array.isArray(grant.capabilities) || grant.capabilities.length === 0) corruptSnapshot()
  const keySets: Record<StoredGrantKind, string[]> = {
    discovery: ['actionId', 'actor', 'bootstrapIntentsDigest', 'capabilityId', 'effect', 'expectedPageIdentityDigest',
      'maxUses', 'nonce', 'operation', 'targetUrl', 'transport'],
    read: ['actionId', 'capabilityId', 'effect', 'maxUses', 'nonce', 'operation', 'transport'],
    write: ['actionId', 'capabilityId', 'cleanupPlanDigest', 'dataLeaseId', 'effect', 'fencingToken', 'maxUses',
      'nonce', 'operation', 'requests', 'transport'],
    injection: ['actionId', 'attemptSlot', 'capabilityId', 'caseId', 'expectedMatches', 'expectedOrder', 'maxUses',
      'nonce', 'request', 'response', 'runId', 'transport', 'upstreamForwarding'],
    websocket: ['actionId', 'capabilityId', 'effect', 'maxBytes', 'maxInboundMessages', 'maxUses', 'nonce',
      'origin', 'path', 'transport'],
    sse: ['actionId', 'capabilityId', 'effect', 'exactPath', 'maxReconnects', 'maxUses', 'nonce', 'origin',
      'query', 'transport'],
  }
  for (const capability of grant.capabilities) {
    if (!isPlainSnapshot(capability)) corruptSnapshot()
    const capabilityKeys = (kind === 'discovery' || kind === 'read') && capability.transport === 'http'
      ? ['actionId', 'capabilityId', 'effect', 'maxUses', 'nonce', 'operation', 'requestIds', 'transport']
      : keySets[kind]
    requireExactKeys(capability, capabilityKeys)
    if (typeof capability.capabilityId !== 'string' || typeof capability.actionId !== 'string'
      || typeof capability.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(capability.nonce)
      || typeof capability.maxUses !== 'number' || !Number.isSafeInteger(capability.maxUses)
      || capability.maxUses < 1) corruptSnapshot()
  }
  const capabilities = grant.capabilities as Array<Record<string, unknown>>
  if (kind === 'write' && capabilities.some((capability) =>
    !validateStoredWriteRequests(capability.requests, policy.writeContract))) corruptSnapshot()
  if (new Set(capabilities.map((item) => item.capabilityId)).size !== capabilities.length) corruptSnapshot()
}

function validateStoredGrantSubject(
  value: unknown,
  writeContract: StoredWriteContract = 'current',
): StoredGrantKind {
  const discovery = DiscoveryApprovalSubjectSchema.safeParse(value)
  if (discovery.success) return 'discovery'
  const legacyDiscovery = LegacyDiscoveryApprovalSubjectV10Schema.safeParse(value)
  if (legacyDiscovery.success) return 'discovery'
  const read = ReadApprovalSubjectSchema.safeParse(value)
  if (read.success) return 'read'
  const legacyRead = LegacyReadApprovalSubjectV20Schema.safeParse(value)
  if (legacyRead.success) return 'read'
  if (validateStoredWriteSubject(value, writeContract)) return 'write'
  if (!isPlainSnapshot(value) || !Array.isArray(value.actions) || value.actions.length === 0) corruptSnapshot()
  try {
    const first = value.actions[0]
    if (!isPlainSnapshot(first)) corruptSnapshot()
    if ('response' in first) {
      requireExactKeys(value, ['actions', 'assetId', 'baseOrigin', 'environment', 'executionDigest', 'prdRevision', 'schemaVersion'])
      validateInjectionSubject(value as unknown as InjectionApprovalSubject)
      return 'injection'
    }
    if ('path' in first) {
      requireExactKeys(value, ['actions', 'assetId', 'baseOrigin', 'environment', 'executionDigest', 'prdRevision', 'schemaVersion'])
      validateWebSocketReadSubject(value as unknown as WebSocketReadApprovalSubject)
      return 'websocket'
    }
    if ('exactPath' in first) {
      requireExactKeys(value, ['actions', 'assetId', 'baseOrigin', 'environment', 'executionDigest', 'prdRevision', 'schemaVersion'])
      validateSseReadSubject(value as unknown as SseReadApprovalSubject)
      return 'sse'
    }
  } catch { corruptSnapshot() }
  return corruptSnapshot()
}

function validateStoredWriteSubject(value: unknown, contract: StoredWriteContract): boolean {
  const schema = contract === 'legacy-v23'
    ? LegacyWriteApprovalSubjectV23Schema
    : WriteApprovalSubjectV2Schema
  return schema.safeParse(value).success
}

function validateStoredWriteRequests(value: unknown, contract: StoredWriteContract): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) return false
  const schema = contract === 'legacy-v23' ? LegacyWriteHttpIntentV23Schema : WriteHttpIntentSchema
  return value.every((request) => schema.safeParse(request).success)
}

function validateStoredReservation(
  key: string,
  value: unknown,
  grants: Map<string, SignedGrant>,
): void {
  if (!isPlainSnapshot(value)) corruptSnapshot()
  requireAllowedAndRequiredKeys(value,
    ['actionId', 'attemptId', 'capabilityId', 'grantId', 'reservationId', 'reservedAt', 'status'],
    ['attemptContext', 'observation', 'outcomeDigest'])
  if (value.reservationId !== key || typeof value.grantId !== 'string' || typeof value.capabilityId !== 'string'
    || typeof value.actionId !== 'string' || typeof value.attemptId !== 'string'
    || !['reserved', 'completed', 'unknown'].includes(String(value.status))
    || typeof value.reservedAt !== 'string' || !isCanonicalInstant(value.reservedAt)) corruptSnapshot()
  const grant = grants.get(value.grantId)
  if (!grant?.capabilities.some((capability) => capability.capabilityId === value.capabilityId
    && capability.actionId === value.actionId)) corruptSnapshot()
  if (value.attemptContext !== undefined) {
    if (!isPlainSnapshot(value.attemptContext)) corruptSnapshot()
    requireExactKeys(value.attemptContext, ['assetId', 'caseId', 'generationId', 'prdRevision', 'runId'])
    if (Object.values(value.attemptContext).some((item) => typeof item !== 'string' || item.length === 0)) corruptSnapshot()
  }
  if (value.observation !== undefined && typeof value.observation !== 'string') corruptSnapshot()
  if (value.outcomeDigest !== undefined && (typeof value.outcomeDigest !== 'string' || !isDigest(value.outcomeDigest))) {
    corruptSnapshot()
  }
  if ((value.status === 'reserved' && (value.observation !== undefined || value.outcomeDigest !== undefined))
    || (value.status === 'completed' && (typeof value.outcomeDigest !== 'string'
      || !isDigest(value.outcomeDigest) || value.observation !== undefined))
    || (value.status === 'unknown' && (typeof value.observation !== 'string'
      || value.observation.length < 1 || value.observation.length > 16 * 1024
      || value.outcomeDigest !== undefined))) corruptSnapshot()
}

function validateStoredPreflight(key: string, value: unknown, grants: Map<string, SignedGrant>): void {
  if (!isDigest(key) || !isPlainSnapshot(value)) corruptSnapshot()
  requireExactKeys(value, ['grantId', 'status', 'subject'])
  if (typeof value.grantId !== 'string' || !grants.has(value.grantId)
    || !['ready', 'input-blocked', 'environment-blocked', 'safety-blocked'].includes(String(value.status))) {
    corruptSnapshot()
  }
  if (validateStoredGrantSubject(value.subject) !== 'discovery') corruptSnapshot()
}

function validateStoredAttemptLog(
  key: string,
  value: unknown,
  grants: Map<string, SignedGrant>,
  reservations: Map<string, CapabilityReservation>,
): void {
  let context: unknown
  try { context = JSON.parse(key) } catch { corruptSnapshot() }
  if (!isPlainSnapshot(context)) corruptSnapshot()
  requireExactKeys(context, ['assetId', 'caseId', 'generationId', 'prdRevision', 'runId'])
  if (Object.values(context).some((item) => typeof item !== 'string' || item.length === 0)
    || canonicalizeJson(context) !== key || !isPlainSnapshot(value)) corruptSnapshot()
  requireExactKeys(value, ['chainDigest', 'events', 'lastTimestamp'])
  if (typeof value.chainDigest !== 'string' || !isDigest(value.chainDigest) || !Array.isArray(value.events)
    || value.events.length === 0 || typeof value.lastTimestamp !== 'number' || !Number.isSafeInteger(value.lastTimestamp)) {
    corruptSnapshot()
  }
  const events = value.events.map((event) => {
    const parsed = AttemptEventSchema.safeParse(event)
    if (!parsed.success) corruptSnapshot()
    return parsed.data
  })
  const typedContext = context as unknown as AttemptExecutionContext
  let expectedPrevious = digestText('attempt-chain-initial/v2', canonicalizeJson(typedContext))
  let lastTimestamp = -Infinity
  const startedAttemptIds = new Set<string>()
  for (const [index, event] of events.entries()) {
    const timestamp = Date.parse(event.timestamp)
    if (event.sequence !== index + 1 || event.caseId !== typedContext.caseId
      || event.previousChainDigest !== expectedPrevious || !Number.isFinite(timestamp)
      || timestamp < lastTimestamp) corruptSnapshot()
    const previous = events[index - 1]
    if (index === 0) {
      if (event.kind !== 'started' || event.slot !== 0) corruptSnapshot()
    } else if (event.kind === 'terminal') {
      if (previous?.kind !== 'started' || previous.slot !== event.slot
        || previous.attemptId !== event.attemptId || previous.mode !== event.result.mode
        || (['passed', 'failed'].includes(event.result.status)
          && !reservationAttestsTerminal(typedContext, event, reservations, grants))) corruptSnapshot()
    } else if (previous?.kind !== 'terminal' || event.slot !== previous.slot + 1
      || startedAttemptIds.has(event.attemptId)) corruptSnapshot()
    if (event.kind === 'started') startedAttemptIds.add(event.attemptId)
    expectedPrevious = digestText('attempt-event-chain/v1', canonicalizeJson({
      previous: event.previousChainDigest,
      event: event.eventDigest,
    }))
    lastTimestamp = timestamp
  }
  if (expectedPrevious !== value.chainDigest || lastTimestamp !== value.lastTimestamp) corruptSnapshot()
}

function reservationAttestsTerminal(
  context: AttemptExecutionContext,
  event: Extract<AppendAttemptEventInput | AttemptEvent, { kind: 'terminal' }>,
  reservations: Map<string, CapabilityReservation>,
  grants: Map<string, SignedGrant>,
): boolean {
  return [...reservations.values()].some((reservation) => {
    if (reservation.reservationId !== event.result.reservationId
      || reservation.outcomeDigest !== event.result.outcomeDigest
      || reservation.status !== 'completed' || !reservation.outcomeDigest) return false
    const grant = grants.get(reservation.grantId)
    const capability = grant?.capabilities.find((candidate) =>
      candidate.capabilityId === reservation.capabilityId && candidate.actionId === reservation.actionId)
    if (!grant || !capability || grant.subject.assetId !== context.assetId
      || grant.subject.prdRevision !== context.prdRevision) return false
    if (event.result.effect !== 'read') {
      return reservation.attemptId === event.attemptId && reservation.attemptContext !== undefined
        && canonicalizeJson(reservation.attemptContext) === canonicalizeJson(context)
        && 'effect' in capability && capability.effect === event.result.effect
    }
    if (event.result.mode === 'gateway-injection') {
      return reservation.attemptId.startsWith(`${event.attemptId}:`)
        && capability.transport === 'gateway-injection'
        && capability.runId === context.runId && capability.caseId === context.caseId
    }
    return reservation.attemptId === event.attemptId
      && 'effect' in capability && capability.effect === 'read'
      && 'requirementModelDigest' in grant.subject
  })
}

function validateSnapshotCryptography(
  snapshot: Record<string, unknown>,
  keys: DecryptedAuthorityPrivateKeys,
): void {
  const publicKey = createPublicKey(keys.primary)
  for (const tuple of snapshot.grants as Array<[string, SignedGrant]>) {
    const grant = tuple[1]
    if (grant.issuer !== snapshot.issuer || grant.keyId !== snapshot.keyId) corruptSnapshot()
    const { signature, ...payload } = grant
    try {
      if (!verify(null, Buffer.from(canonicalizeJson(payload)), publicKey, Buffer.from(signature, 'base64url'))) {
        corruptSnapshot()
      }
    } catch { corruptSnapshot() }
  }
  const attemptPublicKey = createPublicKey(keys.attempt)
  for (const [, log] of snapshot.attemptLogs as AuthorityPersistentSnapshot['attemptLogs']) {
    for (const event of log.events) {
      const { authorityProof, eventDigest, ...eventCore } = event
      if (digestText('attempt-event/v1', canonicalizeJson(eventCore)) !== eventDigest
        || authorityProof.signedDigest !== eventDigest) corruptSnapshot()
      const payload = canonicalizeJson({ purpose: ATTEMPT_EVENT_PROOF_PURPOSE, issuer: authorityProof.issuer,
        keyId: authorityProof.keyId, signedDigest: eventDigest })
      try {
        if (!verify(null, Buffer.from(payload), attemptPublicKey, Buffer.from(authorityProof.signature, 'base64url'))) {
          corruptSnapshot()
        }
      } catch { corruptSnapshot() }
    }
  }
  if (snapshot.schemaVersion === '2.6.0' || snapshot.schemaVersion === '2.7.0'
    || snapshot.schemaVersion === '2.8.0') {
    validateReservationRpcBindingCryptography(
      snapshot as unknown as AuthorityPersistentSnapshot,
      snapshot.issuer as string,
      `${snapshot.keyId as string}:decision`,
      createPublicKey(keys.decision),
    )
  }
}

function validateReservationRpcBindingCryptography(
  snapshot: AuthorityPersistentSnapshot,
  issuer: string,
  decisionKeyId: string,
  decisionPublicKey: KeyObject,
): void {
  const grants = new Map(snapshot.grants)
  const reservations = new Map(snapshot.reservations)
  for (const [reservationId, raw] of snapshot.reservationRpcBindings) {
    const reservation = reservations.get(reservationId)
    const grant = reservation === undefined ? undefined : grants.get(reservation.grantId)
    if (!grant) corruptSnapshot()
    const binding = parseReservationRpcOwnerBinding(reservationId, raw, grant.approvalContext)
    try {
      if (!verify(null, reservationRpcOwnerProofPayload(issuer, decisionKeyId, binding.signedDigest),
        decisionPublicKey, Buffer.from(binding.signature, 'base64url'))) corruptSnapshot()
    } catch { corruptSnapshot() }
  }
}

function requireExactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) corruptSnapshot()
}

function requireAllowedAndRequiredKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): void {
  const keys = Object.keys(value)
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) corruptSnapshot()
}

function isCanonicalBase64Url(value: unknown, byteLength: number): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes.byteLength === byteLength && bytes.toString('base64url') === value
}

function isCanonicalBase64(value: unknown, byteLength?: number): boolean {
  if (typeof value !== 'string') return false
  const bytes = Buffer.from(value, 'base64')
  return (byteLength === undefined || bytes.byteLength === byteLength) && bytes.toString('base64') === value
}

function isCanonicalInstant(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isCanonicalOrigin(value: string): boolean {
  try { return new URL(value).origin === value } catch { return false }
}

function corruptSnapshot(): never {
  throw authorityError('E2E_AUTHORITY_STATE_CORRUPT', '持久 Authority snapshot 结构或认证内容无效')
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

function encryptWebAuthnReceipts(
  entries: Array<[string, StoredWebAuthnApprovalReceipt]>,
  encryptionKey: Buffer,
): EncryptedPrivateKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(Buffer.from('e2e-authority-webauthn-receipts/v1'))
  const normalized = entries
    .map(([sessionId, receipt]) => [sessionId, parseStoredWebAuthnApprovalReceipt(receipt)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  if (new Set(normalized.map(([sessionId]) => sessionId)).size !== normalized.length) corruptSnapshot()
  const plaintext = Buffer.from(canonicalizeJson(normalized))
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      algorithm: 'aes-256-gcm', iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
    }
  } finally { plaintext.fill(0) }
}

function decryptWebAuthnReceipts(
  encrypted: EncryptedPrivateKey,
  encryptionKey: Buffer,
): Array<[string, StoredWebAuthnApprovalReceipt]> {
  let plaintext: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(encrypted.iv, 'base64'))
    decipher.setAAD(Buffer.from('e2e-authority-webauthn-receipts/v1'))
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ])
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
    if (!Array.isArray(parsed)) corruptSnapshot()
    return parseUniqueTuples(parsed, 'WebAuthn receipt', (sessionId, receipt) => {
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) corruptSnapshot()
      parseStoredWebAuthnApprovalReceipt(receipt)
    }).map(([sessionId, receipt]) => [sessionId, parseStoredWebAuthnApprovalReceipt(receipt)])
  } catch (error) {
    if (error instanceof E2EError) throw error
    throw authorityError('E2E_AUTHORITY_STATE_DECRYPTION_FAILED', 'Authority WebAuthn receipt 密文损坏')
  } finally { plaintext?.fill(0) }
}

function parseStoredWebAuthnApprovalReceipt(value: unknown): StoredWebAuthnApprovalReceipt {
  if (!isPlainSnapshot(value)) corruptSnapshot()
  requireExactKeys(value, [
    'approvalType', 'expiresAt', 'installationDigest', 'issuedAt', 'origin', 'runId', 'subject', 'subjectDigest',
  ])
  if (typeof value.subject !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.subject)
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.runId)
    || !['scope', 'lineage', 'discovery', 'execution', 'privacy',
      'manual-executor', 'manual-reviewer'].includes(String(value.approvalType))
    || typeof value.subjectDigest !== 'string' || !isDigest(value.subjectDigest)
    || typeof value.installationDigest !== 'string' || !isDigest(value.installationDigest)
    || typeof value.origin !== 'string' || !isCanonicalOrigin(value.origin)
    || typeof value.issuedAt !== 'string' || !isCanonicalInstant(value.issuedAt)
    || typeof value.expiresAt !== 'string' || !isCanonicalInstant(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) corruptSnapshot()
  return structuredClone(value) as unknown as StoredWebAuthnApprovalReceipt
}

function parsePendingManualResult(value: unknown): PendingManualResult {
  if (!isPlainSnapshot(value)) corruptSnapshot()
  requireAllowedAndRequiredKeys(value, [
    'draft', 'draftDigest', 'preparationFinalizationId', 'preparationRequestDigest',
  ], [
    'executorPresence', 'executorFinalizationId', 'executorRequestDigest',
    'reviewerFinalizationId', 'reviewerRequestDigest', 'issuedResult',
  ])
  const draft = ManualResultDraftSchema.safeParse(value.draft)
  if (!draft.success || typeof value.draftDigest !== 'string'
    || value.draftDigest !== manualResultDraftDigest(draft.data)
    || typeof value.preparationFinalizationId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.preparationFinalizationId)
    || typeof value.preparationRequestDigest !== 'string'
    || !isDigest(value.preparationRequestDigest)) corruptSnapshot()
  const base = { draft: draft.data, draftDigest: value.draftDigest,
    preparationFinalizationId: value.preparationFinalizationId,
    preparationRequestDigest: value.preparationRequestDigest }
  if (value.executorPresence === undefined) {
    if (value.executorFinalizationId !== undefined || value.executorRequestDigest !== undefined
      || value.reviewerFinalizationId !== undefined || value.reviewerRequestDigest !== undefined
      || value.issuedResult !== undefined) corruptSnapshot()
    return base
  }
  const presence = ManualResultUserPresenceProofSchema.safeParse(value.executorPresence)
  if (!presence.success || presence.data.role !== 'executor'
    || presence.data.approvalType !== 'manual-executor'
    || presence.data.requiredRole !== 'e2e-manual-executor'
    || (presence.data.subject !== draft.data.executor.subject
      && presence.data.subject !== 'local-caller')
    || presence.data.runId !== draft.data.runId
    || presence.data.installationDigest !== draft.data.runtimeInstallationDigest
    || presence.data.draftDigest !== value.draftDigest
    || typeof value.executorFinalizationId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.executorFinalizationId)
    || typeof value.executorRequestDigest !== 'string'
    || !isDigest(value.executorRequestDigest)) corruptSnapshot()
  const executor = { ...base, executorPresence: presence.data,
    executorFinalizationId: value.executorFinalizationId,
    executorRequestDigest: value.executorRequestDigest }
  if (value.issuedResult === undefined) {
    if (value.reviewerFinalizationId !== undefined || value.reviewerRequestDigest !== undefined) corruptSnapshot()
    return executor
  }
  const issued = ManualResultSchema.safeParse(value.issuedResult)
  if (!issued.success || issued.data.manualResultId !== draft.data.manualResultId
    || typeof value.reviewerFinalizationId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.reviewerFinalizationId)
    || typeof value.reviewerRequestDigest !== 'string' || !isDigest(value.reviewerRequestDigest)) corruptSnapshot()
  return { ...executor, reviewerFinalizationId: value.reviewerFinalizationId,
    reviewerRequestDigest: value.reviewerRequestDigest, issuedResult: issued.data }
}

function recoverPendingManualRole(
  pending: PendingManualResult,
  input: { role: 'executor' | 'reviewer'; finalizationId: string; requestDigest: string },
): {
  status: 'awaiting-reviewer'; manualResultId: string; draftDigest: string; nextRole: 'reviewer'
} | { status: 'issued'; result: ManualResult } | undefined {
  if (input.role === 'executor' && pending.executorFinalizationId !== undefined) {
    if (pending.executorFinalizationId !== input.finalizationId
      || pending.executorRequestDigest !== input.requestDigest) {
      throw authorityError('E2E_MANUAL_RESULT_FINALIZATION_REPLAY_MISMATCH',
        'executor finalizationId/requestDigest 已绑定不同请求')
    }
    return { status: 'awaiting-reviewer', manualResultId: pending.draft.manualResultId,
      draftDigest: pending.draftDigest, nextRole: 'reviewer' }
  }
  if (input.role === 'reviewer' && pending.reviewerFinalizationId !== undefined) {
    if (pending.reviewerFinalizationId !== input.finalizationId
      || pending.reviewerRequestDigest !== input.requestDigest || pending.issuedResult === undefined) {
      throw authorityError('E2E_MANUAL_RESULT_FINALIZATION_REPLAY_MISMATCH',
        'reviewer finalizationId/requestDigest 已绑定不同请求')
    }
    return { status: 'issued', result: pending.issuedResult }
  }
  return undefined
}

function isEncryptedBlob(value: unknown): value is EncryptedPrivateKey {
  if (!isPlainSnapshot(value)
    || Object.keys(value).sort().join('\0') !== ['algorithm', 'authTag', 'ciphertext', 'iv'].join('\0')) return false
  const blob = value as unknown as EncryptedPrivateKey
  return blob.algorithm === 'aes-256-gcm'
    && isCanonicalBase64(blob.iv, 12)
    && isCanonicalBase64(blob.ciphertext)
    && Buffer.from(blob.ciphertext, 'base64').byteLength > 0
    && isCanonicalBase64(blob.authTag, 16)
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

function validateFinalizationIdentity(finalizationId: string, requestDigest: string): void {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(finalizationId) || !/^sha256:[a-f0-9]{64}$/.test(requestDigest)) {
    throw authorityError('E2E_APPROVAL_FINALIZATION_INVALID', 'finalizationId 或 requestDigest 无效')
  }
}

function sameApprovalExecutionBinding(
  context: CanonicalApprovalContext,
  binding: ApprovalExecutionBinding,
): boolean {
  return context.runId === binding.runId
    && context.installationDigest === binding.installationDigest
    && context.approvalType === binding.approvalType
    && context.subjectDigest === binding.subjectDigest
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

function manualResultDraftDigest(draft: ManualResultDraft): string {
  return digestText('manual-result-draft/v1', canonicalizeJson(draft))
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
      || (!('kind' in value.approver) && !value.approver.roles.includes(requiredRole))
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
    && grant.capabilities.every((capability) => 'operation' in capability
      && 'effect' in capability && capability.effect === 'read'
      && (capability.transport === 'browser-local' || capability.transport === 'http'))
}

function isWriteGrant(grant: SignedGrant): grant is SignedWriteGrant {
  return WriteApprovalSubjectV2Schema.safeParse(grant.subject).success
    && grant.capabilities.every((capability) =>
      'operation' in capability && 'effect' in capability && capability.effect === 'reversible-write'
      && ((capability.transport === 'http' && capability.operation === 'http-request')
        || (capability.transport === 'browser-local' && capability.operation === 'full-playwright')))
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

function reservationTerminalReceipt(
  reservation: CapabilityReservation,
  terminalStatus: 'completed' | 'unknown',
): string {
  return digestText('authority-reservation-terminal-receipt/v1', canonicalizeJson({
    reservationId: reservation.reservationId,
    grantId: reservation.grantId,
    capabilityId: reservation.capabilityId,
    actionId: reservation.actionId,
    attemptId: reservation.attemptId,
    terminalStatus,
    ...(terminalStatus === 'completed'
      ? { outcomeDigest: reservation.outcomeDigest }
      : { observation: reservation.observation }),
  }))
}

function parseReservationRpcOwnerClaim(
  value: unknown,
  expectedApprovalContext: CanonicalApprovalContext,
): ReservationRpcOwnerClaim {
  if (!isPlainSnapshot(value)) throw invalidReservationRpcOwnerBinding()
  if (Object.keys(value).sort().join('\0') !== ['approvalContext', 'clientId'].join('\0')) {
    throw invalidReservationRpcOwnerBinding()
  }
  const context = CanonicalApprovalContextSchema.safeParse(value.approvalContext)
  if (typeof value.clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.clientId)
    || !context.success
    || canonicalizeJson(context.data) !== canonicalizeJson(expectedApprovalContext)) {
    throw invalidReservationRpcOwnerBinding()
  }
  return { clientId: value.clientId, approvalContext: context.data }
}

function parseReservationRpcOwnerBinding(
  reservationId: string,
  value: unknown,
  expectedApprovalContext: CanonicalApprovalContext,
): ReservationRpcOwnerBinding {
  if (!isPlainSnapshot(value)
    || Object.keys(value).sort().join('\0')
      !== ['approvalContext', 'clientId', 'signature', 'signedDigest'].join('\0')) {
    throw invalidReservationRpcOwnerBinding()
  }
  const claim = parseReservationRpcOwnerClaim({
    clientId: value.clientId,
    approvalContext: value.approvalContext,
  }, expectedApprovalContext)
  if (typeof value.signedDigest !== 'string' || !isDigest(value.signedDigest)
    || value.signedDigest !== reservationRpcOwnerDigest(reservationId, claim)
    || !isCanonicalBase64Url(value.signature, 64)) throw invalidReservationRpcOwnerBinding()
  return { ...claim, signedDigest: value.signedDigest, signature: value.signature as string }
}

function reservationRpcOwnerDigest(reservationId: string, claim: ReservationRpcOwnerClaim): string {
  return digestText('authority-reservation-rpc-owner/v1', canonicalizeJson({
    reservationId,
    clientId: claim.clientId,
    approvalContext: claim.approvalContext,
  }))
}

function reservationRpcOwnerProofPayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: 'authority-reservation-rpc-owner/v1', issuer, keyId, signedDigest,
  }))
}

function invalidReservationRpcOwnerBinding(): E2EError {
  return authorityError('E2E_APPROVAL_RESERVATION_RPC_OWNER_INVALID', 'Reservation RPC owner 绑定无效')
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
      && ['dom-read', 'screenshot', 'local-navigation', 'http-request'].includes(action.operation)
      && Number.isSafeInteger(action.maxUses) && action.maxUses === 1)
  const identity = subject.expectedPageIdentity
  if (
    subject.schemaVersion !== '1.1.0'
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

function validateRawInjectionResponses(subject: unknown): void {
  if (!isPlainSnapshot(subject) || !Array.isArray(subject.actions)) return
  for (const action of subject.actions) {
    if (!isPlainSnapshot(action) || !isPlainSnapshot(action.response)) continue
    const response = action.response
    if (!Number.isSafeInteger(response.delayMs)) invalidInjectionResponse()
    if (response.kind === 'http-response') {
      if (!Number.isSafeInteger(response.status) || !Array.isArray(response.headers)
        || !isPlainSnapshot(response.body)
        || (response.body.kind !== 'no-body'
          && (response.body.kind !== 'utf8' || typeof response.body.value !== 'string'
            || typeof response.body.digest !== 'string'))) invalidInjectionResponse()
    } else {
      if ((response.kind !== 'connection-reset' && response.kind !== 'timeout')
        || response.status !== 'not-applicable' || !Array.isArray(response.headers)
        || !isPlainSnapshot(response.body)) invalidInjectionResponse()
    }
    validateInjectionResponse(response as unknown as CanonicalInjectionResponse)
  }
}

function invalidInjectionResponse(): never {
  throw authorityError('E2E_APPROVAL_INJECTION_RESPONSE_INVALID', '注入响应结构或生产边界无效')
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
