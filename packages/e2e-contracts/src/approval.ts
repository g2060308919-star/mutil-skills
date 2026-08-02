import type {
  DiscoveryApprovalSubjectV11,
  LegacyDiscoveryApprovalSubjectV10,
} from './approval-subject.js'
import type {
  LegacyReadApprovalSubjectV20,
  ReadApprovalSubjectV21,
} from './approval-freshness.js'
import type {
  CanonicalDiscoveryCapability,
  CanonicalReadCapability,
} from './signed-grant.js'

export type CanonicalDiscoveryApprovalSubject = DiscoveryApprovalSubjectV11
/** 当前签发与执行协议只接受 canonical v1.1 subject。 */
export type DiscoveryApprovalSubject = CanonicalDiscoveryApprovalSubject
/** 仅供历史状态读取/迁移入口使用；迁移完成前不得进入签发、验签或执行接口。 */
export type DiscoveryApprovalSubjectMigrationInput =
  | LegacyDiscoveryApprovalSubjectV10
  | CanonicalDiscoveryApprovalSubject
export type DiscoveryCapability = CanonicalDiscoveryCapability

export interface CanonicalApprovalContext {
  schemaVersion: '1.0.0'
  subject: string
  runId: string
  approvalType: 'discovery' | 'execution'
  subjectDigest: string
  installationDigest: string
  origin: string
  issuedAt: string
  expiresAt: string
}

export interface SignedDiscoveryGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  approver: ApprovalApprover
  approvalContext: CanonicalApprovalContext
  subject: DiscoveryApprovalSubject
  subjectDigest: string
  issuedAt: string
  expiresAt: string
  capabilities: DiscoveryCapability[]
  revocationSequence: number
  signature: string
}

export interface DiscoveryPreflightOutcome {
  status: 'ready' | 'input-blocked' | 'environment-blocked' | 'safety-blocked'
  reasonCode?: string
  observedIdentity?: {
    url: string
    title: string
    headings: string[]
    role?: string
    ariaSignals?: string[]
  }
  pageIdentityEvaluation?: {
    policyDigest: string
    matched: boolean
    urlMatched: boolean
    actualUrl: string
    matchedSignalCount: number
    requiredSignalCount: number
    signals: Array<{ kind: string; matched: boolean }>
  }
}

export type CanonicalReadApprovalSubject = ReadApprovalSubjectV21
/** 当前签发与执行协议只接受 canonical v2.1 subject。 */
export type ReadApprovalSubject = CanonicalReadApprovalSubject
/** 仅供历史状态读取/迁移入口使用；迁移完成前不得进入签发、验签或执行接口。 */
export type ReadApprovalSubjectMigrationInput = LegacyReadApprovalSubjectV20 | CanonicalReadApprovalSubject
export type ReadCapability = CanonicalReadCapability

export interface ApproverIdentity {
  subject: string
  roles: string[]
}

/** 本地确认只证明当前 OS caller 明确确认，不代表已验证自然人身份。 */
export interface LocalCallerApprover {
  kind: 'local-caller'
}

export type ApprovalApprover = ApproverIdentity | LocalCallerApprover

export function approvalApproverSubject(approver: ApprovalApprover): string {
  return 'kind' in approver ? 'local-caller' : approver.subject
}

export interface SignedReadGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  approver: ApprovalApprover
  approvalContext: CanonicalApprovalContext
  subject: ReadApprovalSubject
  subjectDigest: string
  issuedAt: string
  expiresAt: string
  capabilities: ReadCapability[]
  revocationSequence: number
  signature: string
}

export type CanonicalPayload =
  | { kind: 'no-body' }
  | { kind: 'json'; digest: string }
  | { kind: 'binary'; digest: string }
  | { kind: 'template'; templateDigest: string }

export interface HttpIntent {
  intentId: string
  method: string
  canonicalOrigin: string
  exactPath: string
  query: Array<[string, string]>
  payload: CanonicalPayload
  headers?: Array<{ name: string; value: string }>
  targetFingerprint: string
  maxRequests: number
  expectedOrder: number
}

export interface HttpWriteApprovalAction {
  actionId: string
  effect: 'reversible-write'
  dataLeaseId: string
  resourceKey: string
  fencingToken: number
  cleanupPlanDigest: string
  requests: HttpIntent[]
}

export interface BrowserLocalWriteApprovalAction {
  actionId: string
  transport: 'browser-local'
  operation: 'full-playwright'
  effect: 'reversible-write'
  programDigest: string
  cleanupProgramDigest: string
  dataLeaseId: string
  resourceKey: string
  fencingToken: number
  cleanupPlanDigest: string
  requests: HttpIntent[]
}

export interface WriteApprovalSubject {
  schemaVersion: '1.0.0' | '2.0.0'
  assetId: string
  prdRevision: string
  executionDigest: string
  scopeDigest?: string
  requirementModelDigest?: string
  coveragePolicyDigest?: string
  universeDigest?: string
  caseDigest?: string
  actionMapDigest?: string
  policyDigest?: string
  executionContractDigest?: string
  runBundleProjectionDigest?: string
  actor?: string
  discoveryGrantId?: string
  preflightDigest?: string
  environment: 'local' | 'test' | 'staging'
  baseOrigin: string
  actions: Array<HttpWriteApprovalAction | BrowserLocalWriteApprovalAction>
}

export interface HttpReversibleWriteCapability {
  capabilityId: string
  nonce: string
  transport: 'http'
  effect: 'reversible-write'
  operation: 'http-request'
  actionId: string
  dataLeaseId: string
  fencingToken: number
  cleanupPlanDigest: string
  requests: HttpIntent[]
  maxUses: 1
}

export interface BrowserLocalReversibleWriteCapability {
  capabilityId: string
  nonce: string
  transport: 'browser-local'
  effect: 'reversible-write'
  operation: 'full-playwright'
  actionId: string
  programDigest: string
  cleanupProgramDigest: string
  dataLeaseId: string
  fencingToken: number
  cleanupPlanDigest: string
  requests: HttpIntent[]
  maxUses: 1
}

export type ReversibleWriteCapability =
  | HttpReversibleWriteCapability
  | BrowserLocalReversibleWriteCapability

export interface SignedWriteGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  approver: ApprovalApprover
  approvalContext: CanonicalApprovalContext
  subject: WriteApprovalSubject
  subjectDigest: string
  issuedAt: string
  expiresAt: string
  capabilities: ReversibleWriteCapability[]
  revocationSequence: number
  signature: string
}

export type InjectionResponseBody =
  | { kind: 'no-body' }
  | { kind: 'utf8'; value: string; digest: string }

export type CanonicalInjectionResponse =
  | {
      kind: 'http-response'
      status: number
      headers: Array<{ name: string; value: string }>
      body: InjectionResponseBody
      delayMs: number
    }
  | {
      kind: 'connection-reset' | 'timeout'
      status: 'not-applicable'
      headers: []
      body: { kind: 'no-body' }
      delayMs: number
    }

export interface InjectionApprovalSubject {
  schemaVersion: '1.0.0'
  assetId: string
  prdRevision: string
  executionDigest: string
  environment: 'local' | 'test'
  baseOrigin: string
  actions: Array<{
    actionId: string
    caseId: string
    runId: string
    attemptSlot: number
    request: HttpIntent
    response: CanonicalInjectionResponse
    expectedMatches: number
    expectedOrder: number
    upstreamForwarding: 'forbidden'
  }>
}

export interface InjectionCapability {
  capabilityId: string
  nonce: string
  transport: 'gateway-injection'
  actionId: string
  caseId: string
  runId: string
  attemptSlot: number
  request: HttpIntent
  response: CanonicalInjectionResponse
  expectedMatches: number
  expectedOrder: number
  upstreamForwarding: 'forbidden'
  maxUses: number
}

export interface SignedInjectionGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  approver: ApprovalApprover
  approvalContext: CanonicalApprovalContext
  subject: InjectionApprovalSubject
  subjectDigest: string
  issuedAt: string
  expiresAt: string
  capabilities: InjectionCapability[]
  revocationSequence: number
  signature: string
}

export interface WebSocketReadApprovalSubject {
  schemaVersion: '1.0.0'
  assetId: string
  prdRevision: string
  executionDigest: string
  environment: 'local' | 'test' | 'staging' | 'production'
  baseOrigin: string
  actions: Array<{
    actionId: string
    origin: string
    path: string
    maxInboundMessages: number
    maxBytes: number
  }>
}

export interface WebSocketReadCapability {
  capabilityId: string
  nonce: string
  transport: 'websocket'
  effect: 'read'
  actionId: string
  origin: string
  path: string
  maxInboundMessages: number
  maxBytes: number
  maxUses: 1
}

export interface SignedWebSocketReadGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  approver: ApprovalApprover
  approvalContext: CanonicalApprovalContext
  subject: WebSocketReadApprovalSubject
  subjectDigest: string
  issuedAt: string
  expiresAt: string
  capabilities: WebSocketReadCapability[]
  revocationSequence: number
  signature: string
}

export interface SseReadApprovalSubject {
  schemaVersion: '1.0.0'
  assetId: string
  prdRevision: string
  executionDigest: string
  environment: 'local' | 'test' | 'staging' | 'production'
  baseOrigin: string
  actions: Array<{
    actionId: string
    origin: string
    exactPath: string
    query: Array<[string, string]>
    maxReconnects: number
  }>
}

export interface SseReadCapability {
  capabilityId: string
  nonce: string
  transport: 'sse'
  effect: 'read'
  actionId: string
  origin: string
  exactPath: string
  query: Array<[string, string]>
  maxReconnects: number
  maxUses: number
}

export interface SignedSseReadGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  approver: ApprovalApprover
  approvalContext: CanonicalApprovalContext
  subject: SseReadApprovalSubject
  subjectDigest: string
  issuedAt: string
  expiresAt: string
  capabilities: SseReadCapability[]
  revocationSequence: number
  signature: string
}

export function digestInjectionResponseBody(value: string): string {
  return digestText('injection-response-body/v1', value)
}

export type SignedGrant = SignedDiscoveryGrant | SignedReadGrant | SignedWriteGrant | SignedInjectionGrant | SignedWebSocketReadGrant | SignedSseReadGrant
export type ActionCapability = ReadCapability | ReversibleWriteCapability | InjectionCapability | WebSocketReadCapability | SseReadCapability

export type GrantDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string }

export interface AttemptExecutionContext {
  assetId: string
  generationId: string
  prdRevision: string
  runId: string
  caseId: string
}

export interface CapabilityReservation {
  reservationId: string
  grantId: string
  capabilityId: string
  actionId: string
  attemptId: string
  attemptContext?: AttemptExecutionContext
  status: 'reserved' | 'completed' | 'unknown'
  reservedAt: string
  observation?: string
  outcomeDigest?: string
}
import { digestText } from './common.js'
