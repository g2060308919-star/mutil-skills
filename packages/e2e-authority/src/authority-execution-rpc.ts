import {
  canonicalizeJson,
  canonicalGrantApprovalSubjectDigest,
  CanonicalApprovalContextSchema,
  WriteApprovalSubjectV2Schema,
  type AttemptExecutionContext,
  type CapabilityReservation,
  type GrantDecision,
  type SignedWriteGrant,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import {
  AuthenticatedRpcClient,
  type AuthenticatedRpcCredential,
  type AuthenticatedRpcServer,
  type AuthenticatedRpcTransport,
  type AuthenticatedRpcVerifierMaterial,
  type AuthenticatedRpcOperationContext,
} from './authenticated-rpc.js'
import {
  trustLeaseClient,
  trustWriteApprovalClient,
  type TrustedApprovalExecutionBinding,
  type TrustedLeaseClient,
  type TrustedWriteApprovalClient,
} from './trusted-execution-clients.js'

const WRITE_VERIFY_OPERATION = 'write.verifyForSubject.v1'
const LEASE_VERIFY_OPERATION = 'lease.verifyTarget.v1'
const GATEWAY_VERIFY_OPERATION = 'gateway.write.verifyForSubject.v2'
const GATEWAY_RESERVE_OPERATION = 'gateway.write.reserveForSubject.v1'
const GATEWAY_COMPLETE_OPERATION = 'gateway.write.complete.v1'
const GATEWAY_UNKNOWN_OPERATION = 'gateway.write.markUnknown.v1'
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface AuthorityExecutionRpcHostDependencies {
  writeAuthority: {
    verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject): Promise<GrantDecision>
  }
  leaseAuthority: {
    verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean>
  }
  gatewayAuthority?: GatewayWriteAuthorityRpcClient
}

export interface GatewayWriteAuthorityRpcClient {
  verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject): Promise<GrantDecision>
  reserveForSubject(input: {
    grant: SignedWriteGrant
    currentSubject: WriteApprovalSubject
    capabilityId: string
    actionId: string
    attemptId: string
    attemptContext?: AttemptExecutionContext
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<void>
  markUnknown(reservationId: string, observation: string): Promise<void>
}

export interface AuthorityExecutionRpcClientOptions {
  credential: AuthenticatedRpcCredential
  verifierMaterial: AuthenticatedRpcVerifierMaterial
  expectedPublicKeyDigest: string
  transport: AuthenticatedRpcTransport
  now?: () => Date
  ttlMs?: number
  approvalBinding: TrustedApprovalExecutionBinding
}

export function registerAuthorityExecutionRpcOperations(
  rpc: AuthenticatedRpcServer,
  dependencies: AuthorityExecutionRpcHostDependencies,
): void {
  rpc.registerOperation(WRITE_VERIFY_OPERATION, async (payload, rpcContext) => {
    const input = parseWriteVerifyInput(payload)
    const contextDecision = verifyRegisteredApprovalContext(input.grant, rpcContext)
    if (contextDecision) return contextDecision
    return parseGrantDecision(await dependencies.writeAuthority.verifyForSubject(input.grant, input.currentSubject))
  })
  rpc.registerOperation(LEASE_VERIFY_OPERATION, async (payload) => {
    const input = parseLeaseVerifyInput(payload)
    const verified = await dependencies.leaseAuthority.verifyTarget(
      input.leaseId, input.fencingToken, input.targetFingerprint,
    )
    if (typeof verified !== 'boolean') throw executionRpcError('E2E_RPC_LEASE_VERIFY_RESULT_INVALID')
    return { verified }
  })
  if (dependencies.gatewayAuthority) {
    rpc.registerOperation(GATEWAY_VERIFY_OPERATION, async (payload, rpcContext) => {
      const input = parseWriteVerifyInput(payload)
      const contextDecision = verifyRegisteredApprovalContext(input.grant, rpcContext)
      if (contextDecision) return contextDecision
      return parseGrantDecision(await dependencies.gatewayAuthority!
        .verifyForSubject(input.grant, input.currentSubject))
    })
    rpc.registerOperation(GATEWAY_RESERVE_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayReserveInput(payload)
      const contextDecision = verifyRegisteredApprovalContext(input.grant, rpcContext)
      if (contextDecision) throw executionRpcError(contextDecision.code)
      return parseCapabilityReservation(await dependencies.gatewayAuthority!.reserveForSubject(input), input)
    })
    rpc.registerOperation(GATEWAY_COMPLETE_OPERATION, async (payload) => {
      const input = parseGatewayCompleteInput(payload)
      await dependencies.gatewayAuthority!.complete(input.reservationId, input.outcomeDigest)
      return { completed: true }
    })
    rpc.registerOperation(GATEWAY_UNKNOWN_OPERATION, async (payload) => {
      const input = parseGatewayUnknownInput(payload)
      await dependencies.gatewayAuthority!.markUnknown(input.reservationId, input.observation)
      return { markedUnknown: true }
    })
  }
}

function verifyRegisteredApprovalContext(
  grant: SignedWriteGrant,
  rpcContext: AuthenticatedRpcOperationContext,
): Extract<GrantDecision, { allowed: false }> | undefined {
  const registration = rpcContext.registration
  const candidate = isPlainObject(registration) && hasExactKeys(registration, ['approvalContext'])
    ? CanonicalApprovalContextSchema.safeParse(registration.approvalContext)
    : undefined
  const current = candidate?.success ? candidate.data : undefined
  const now = Date.parse(rpcContext.now)
  if (!current || current.approvalType !== 'execution'
    || canonicalizeJson(current) !== canonicalizeJson(grant.approvalContext)
    || current.subjectDigest !== grant.subjectDigest
    || current.subject !== grant.approver.subject
    || !Number.isFinite(now)
    || Date.parse(current.issuedAt) > now
    || Date.parse(current.expiresAt) <= now) {
    return { allowed: false, code: 'E2E_APPROVAL_CONTEXT_MISMATCH',
      reason: 'Grant approvalContext 与 RPC Host 注册的当前可信执行上下文不一致或已失效' }
  }
  return undefined
}

export function createAuthorityExecutionRpcClients(options: AuthorityExecutionRpcClientOptions): {
  writeApproval: TrustedWriteApprovalClient
  lease: TrustedLeaseClient
  gatewayAuthority: GatewayWriteAuthorityRpcClient
  destroy(): void
} {
  const approvalBinding = parseApprovalExecutionBinding(options.approvalBinding)
  const rpc = AuthenticatedRpcClient.create(options)
  const binding = {
    transport: 'authenticated-rpc' as const,
    authorityPublicKeyDigest: rpc.authorityPublicKeyDigest,
    approvalBinding,
  }
  const writeApproval = trustWriteApprovalClient(Object.freeze({
    async verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject): Promise<GrantDecision> {
      return parseGrantDecision(await rpc.call(WRITE_VERIFY_OPERATION, { grant, currentSubject }))
    },
  }), binding)
  const lease = trustLeaseClient(Object.freeze({
    async verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean> {
      const input = parseLeaseVerifyInput({ leaseId, fencingToken, targetFingerprint })
      return parseLeaseVerifyResult(await rpc.call(LEASE_VERIFY_OPERATION, input))
    },
  }), binding)
  const gatewayAuthority: GatewayWriteAuthorityRpcClient = Object.freeze({
    async verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject) {
      const input = parseWriteVerifyInput({ grant, currentSubject })
      return parseGrantDecision(await rpc.call(GATEWAY_VERIFY_OPERATION, input))
    },
    async reserveForSubject(input: {
      grant: SignedWriteGrant; currentSubject: WriteApprovalSubject; capabilityId: string
      actionId: string; attemptId: string; attemptContext?: AttemptExecutionContext
    }) {
      const parsed = parseGatewayReserveInput(input)
      return parseCapabilityReservation(await rpc.call(GATEWAY_RESERVE_OPERATION, parsed), parsed)
    },
    async complete(reservationId: string, outcomeDigest: string) {
      const input = parseGatewayCompleteInput({ reservationId, outcomeDigest })
      parseAck(await rpc.call(GATEWAY_COMPLETE_OPERATION, input), 'completed', 'E2E_RPC_GATEWAY_COMPLETE_RESULT_INVALID')
    },
    async markUnknown(reservationId: string, observation: string) {
      const input = parseGatewayUnknownInput({ reservationId, observation })
      parseAck(await rpc.call(GATEWAY_UNKNOWN_OPERATION, input), 'markedUnknown',
        'E2E_RPC_GATEWAY_UNKNOWN_RESULT_INVALID')
    },
  })
  return { writeApproval, lease, gatewayAuthority, destroy: () => rpc.destroy() }
}

function parseApprovalExecutionBinding(value: unknown): TrustedApprovalExecutionBinding {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['approvalType', 'installationDigest', 'runId', 'subjectDigest'])
    || typeof value.runId !== 'string' || !SAFE_ID.test(value.runId)
    || value.approvalType !== 'execution'
    || typeof value.installationDigest !== 'string' || !DIGEST.test(value.installationDigest)
    || typeof value.subjectDigest !== 'string' || !DIGEST.test(value.subjectDigest)) {
    throw executionRpcError('E2E_RPC_APPROVAL_BINDING_INVALID')
  }
  return structuredClone(value) as TrustedApprovalExecutionBinding
}

function parseWriteVerifyInput(value: unknown): {
  grant: SignedWriteGrant
  currentSubject: WriteApprovalSubject
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ['currentSubject', 'grant'])) {
    throw executionRpcError('E2E_RPC_WRITE_VERIFY_INPUT_INVALID')
  }
  const currentSubject = WriteApprovalSubjectV2Schema.safeParse(value.currentSubject)
  const grant = parseSignedWriteGrant(value.grant)
  if (!currentSubject.success || !grant) throw executionRpcError('E2E_RPC_WRITE_VERIFY_INPUT_INVALID')
  return { grant, currentSubject: currentSubject.data }
}

function parseSignedWriteGrant(value: unknown): SignedWriteGrant | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ['approvalContext', 'approver', 'capabilities', 'expiresAt', 'grantId', 'issuedAt',
    'issuer', 'keyId', 'proofScope', 'revocationSequence', 'signature', 'subject', 'subjectDigest'])) return undefined
  const subject = WriteApprovalSubjectV2Schema.safeParse(value.subject)
  const approvalContext = CanonicalApprovalContextSchema.safeParse(value.approvalContext)
  if (!subject.success || typeof value.grantId !== 'string' || !SAFE_ID.test(value.grantId)
    || typeof value.issuer !== 'string' || !SAFE_ID.test(value.issuer)
    || typeof value.keyId !== 'string' || !SAFE_ID.test(value.keyId) || value.proofScope !== 'local-os-user'
    || !isApprover(value.approver) || typeof value.subjectDigest !== 'string' || !DIGEST.test(value.subjectDigest)
    || !approvalContext.success || approvalContext.data.approvalType !== 'execution'
    || approvalContext.data.subject !== (value.approver as { subject: string }).subject
    || approvalContext.data.subjectDigest !== value.subjectDigest
    || canonicalGrantApprovalSubjectDigest(subject.data) !== value.subjectDigest
    || typeof value.issuedAt !== 'string' || !isCanonicalInstant(value.issuedAt)
    || typeof value.expiresAt !== 'string' || !isCanonicalInstant(value.expiresAt)
    || !Array.isArray(value.capabilities) || value.capabilities.length < 1 || value.capabilities.length > 100_000
    || !value.capabilities.every(isWriteCapability)
    || typeof value.revocationSequence !== 'number' || !Number.isSafeInteger(value.revocationSequence)
    || value.revocationSequence < 0 || typeof value.signature !== 'string' || value.signature.length < 1
    || value.signature.length > 16 * 1024) return undefined
  return structuredClone(value) as unknown as SignedWriteGrant
}

function isApprover(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['roles', 'subject'])
    && typeof value.subject === 'string' && SAFE_ID.test(value.subject)
    && Array.isArray(value.roles) && value.roles.length <= 100
    && value.roles.every((role) => typeof role === 'string' && SAFE_ID.test(role))
}

function isWriteCapability(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ['actionId', 'capabilityId', 'cleanupPlanDigest', 'dataLeaseId',
    'effect', 'fencingToken', 'maxUses', 'nonce', 'operation', 'requests', 'transport'])
    && typeof value.actionId === 'string' && SAFE_ID.test(value.actionId)
    && typeof value.capabilityId === 'string' && SAFE_ID.test(value.capabilityId)
    && typeof value.dataLeaseId === 'string' && SAFE_ID.test(value.dataLeaseId)
    && typeof value.nonce === 'string' && value.nonce.length >= 1 && value.nonce.length <= 16 * 1024
    && value.transport === 'http' && value.effect === 'reversible-write' && value.operation === 'http-request'
    && typeof value.fencingToken === 'number' && Number.isSafeInteger(value.fencingToken) && value.fencingToken > 0
    && typeof value.cleanupPlanDigest === 'string' && DIGEST.test(value.cleanupPlanDigest)
    && Array.isArray(value.requests) && value.requests.length >= 1 && value.requests.length <= 1_000
    && value.maxUses === 1
}

function parseLeaseVerifyInput(value: unknown): {
  leaseId: string
  fencingToken: number
  targetFingerprint: string
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ['fencingToken', 'leaseId', 'targetFingerprint'])
    || typeof value.leaseId !== 'string' || !SAFE_ID.test(value.leaseId)
    || typeof value.fencingToken !== 'number' || !Number.isSafeInteger(value.fencingToken) || value.fencingToken <= 0
    || typeof value.targetFingerprint !== 'string' || !DIGEST.test(value.targetFingerprint)) {
    throw executionRpcError('E2E_RPC_LEASE_VERIFY_INPUT_INVALID')
  }
  return { leaseId: value.leaseId, fencingToken: value.fencingToken, targetFingerprint: value.targetFingerprint }
}

function parseGatewayReserveInput(value: unknown): {
  grant: SignedWriteGrant
  currentSubject: WriteApprovalSubject
  capabilityId: string
  actionId: string
  attemptId: string
  attemptContext?: AttemptExecutionContext
} {
  if (!isPlainObject(value)) throw executionRpcError('E2E_RPC_GATEWAY_RESERVE_INPUT_INVALID')
  const hasContext = Object.hasOwn(value, 'attemptContext')
  const keys = ['actionId', 'attemptId', 'capabilityId', 'currentSubject', 'grant',
    ...(hasContext ? ['attemptContext'] : [])]
  const grant = parseSignedWriteGrant(value.grant)
  const subject = WriteApprovalSubjectV2Schema.safeParse(value.currentSubject)
  const context = hasContext ? parseAttemptContext(value.attemptContext) : undefined
  if (!hasExactKeys(value, keys) || !grant || !subject.success
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || (hasContext && !context)) throw executionRpcError('E2E_RPC_GATEWAY_RESERVE_INPUT_INVALID')
  return { grant, currentSubject: subject.data, capabilityId: value.capabilityId,
    actionId: value.actionId, attemptId: value.attemptId, ...(context ? { attemptContext: context } : {}) }
}

function parseGatewayCompleteInput(value: unknown): { reservationId: string; outcomeDigest: string } {
  if (!isPlainObject(value) || !hasExactKeys(value, ['outcomeDigest', 'reservationId'])
    || typeof value.reservationId !== 'string' || !SAFE_ID.test(value.reservationId)
    || typeof value.outcomeDigest !== 'string' || !DIGEST.test(value.outcomeDigest)) {
    throw executionRpcError('E2E_RPC_GATEWAY_COMPLETE_INPUT_INVALID')
  }
  return { reservationId: value.reservationId, outcomeDigest: value.outcomeDigest }
}

function parseGatewayUnknownInput(value: unknown): { reservationId: string; observation: string } {
  if (!isPlainObject(value) || !hasExactKeys(value, ['observation', 'reservationId'])
    || typeof value.reservationId !== 'string' || !SAFE_ID.test(value.reservationId)
    || typeof value.observation !== 'string' || value.observation.length < 1 || value.observation.length > 16 * 1024) {
    throw executionRpcError('E2E_RPC_GATEWAY_UNKNOWN_INPUT_INVALID')
  }
  return { reservationId: value.reservationId, observation: value.observation }
}

function parseAttemptContext(value: unknown): AttemptExecutionContext | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ['assetId', 'caseId', 'generationId', 'prdRevision', 'runId'])
    || typeof value.assetId !== 'string' || !SAFE_ID.test(value.assetId)
    || typeof value.generationId !== 'string' || !SAFE_ID.test(value.generationId)
    || typeof value.prdRevision !== 'string' || !DIGEST.test(value.prdRevision)
    || typeof value.runId !== 'string' || !SAFE_ID.test(value.runId)
    || typeof value.caseId !== 'string' || !SAFE_ID.test(value.caseId)) return undefined
  return { assetId: value.assetId, generationId: value.generationId, prdRevision: value.prdRevision,
    runId: value.runId, caseId: value.caseId }
}

function parseCapabilityReservation(value: unknown, expected: {
  grant: SignedWriteGrant; capabilityId: string; actionId: string; attemptId: string
  attemptContext?: AttemptExecutionContext
}): CapabilityReservation {
  if (!isPlainObject(value)) throw executionRpcError('E2E_RPC_GATEWAY_RESERVATION_RESULT_INVALID')
  const optional = ['attemptContext', 'observation', 'outcomeDigest'].filter((key) => Object.hasOwn(value, key))
  if (!hasExactKeys(value, ['actionId', 'attemptId', 'capabilityId', 'grantId', 'reservationId', 'reservedAt',
    'status', ...optional]) || typeof value.reservationId !== 'string' || !SAFE_ID.test(value.reservationId)
    || typeof value.grantId !== 'string' || !SAFE_ID.test(value.grantId)
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || value.status !== 'reserved' || typeof value.reservedAt !== 'string' || !isCanonicalInstant(value.reservedAt)
    || (Object.hasOwn(value, 'attemptContext') && !parseAttemptContext(value.attemptContext))
    || Object.hasOwn(value, 'observation') || Object.hasOwn(value, 'outcomeDigest')) {
    throw executionRpcError('E2E_RPC_GATEWAY_RESERVATION_RESULT_INVALID')
  }
  const reservation = structuredClone(value) as unknown as CapabilityReservation
  if (reservation.grantId !== expected.grant.grantId || reservation.capabilityId !== expected.capabilityId
    || reservation.actionId !== expected.actionId || reservation.attemptId !== expected.attemptId
    || canonicalizeJson(reservation.attemptContext ?? null) !== canonicalizeJson(expected.attemptContext ?? null)) {
    throw executionRpcError('E2E_RPC_GATEWAY_RESERVATION_BINDING_INVALID')
  }
  return reservation
}

function parseAck(value: unknown, field: 'completed' | 'markedUnknown', code: string): void {
  if (!isPlainObject(value) || !hasExactKeys(value, [field]) || value[field] !== true) {
    throw executionRpcError(code)
  }
}

function parseGrantDecision(value: unknown): GrantDecision {
  if (!isPlainObject(value)) throw executionRpcError('E2E_RPC_WRITE_VERIFY_RESULT_INVALID')
  if (hasExactKeys(value, ['allowed']) && value.allowed === true) return { allowed: true }
  if (hasExactKeys(value, ['allowed', 'code', 'reason']) && value.allowed === false
    && typeof value.code === 'string' && SAFE_ID.test(value.code)
    && typeof value.reason === 'string' && value.reason.length >= 1 && value.reason.length <= 16 * 1024) {
    return { allowed: false, code: value.code, reason: value.reason }
  }
  throw executionRpcError('E2E_RPC_WRITE_VERIFY_RESULT_INVALID')
}

function parseLeaseVerifyResult(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, ['verified']) || typeof value.verified !== 'boolean') {
    throw executionRpcError('E2E_RPC_LEASE_VERIFY_RESULT_INVALID')
  }
  return value.verified
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

function executionRpcError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
