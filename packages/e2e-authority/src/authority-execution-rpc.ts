import {
  canonicalizeJson,
  canonicalGrantApprovalSubjectDigest,
  CanonicalApprovalContextSchema,
  DiscoveryApprovalSubjectSchema,
  ReadApprovalSubjectSchema,
  SignedGrantSchema,
  WriteApprovalSubjectV2Schema,
  type AttemptExecutionContext,
  type CapabilityReservation,
  type GrantDecision,
  type SignedWriteGrant,
  type SignedDiscoveryGrant,
  type SignedReadGrant,
  type SignedGrant,
  type DiscoveryApprovalSubject,
  type DiscoveryPreflightOutcome,
  type ReadApprovalSubject,
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
  parseApprovalExecutionBinding,
  trustLeaseClient,
  trustWriteApprovalClient,
  type ApprovalExecutionBinding,
  type TrustedLeaseClient,
  type TrustedWriteApprovalClient,
} from './trusted-execution-clients.js'

const WRITE_VERIFY_OPERATION = 'write.verifyForSubject.v1'
const LEASE_VERIFY_OPERATION = 'lease.verifyTarget.v1'
const GATEWAY_VERIFY_OPERATION = 'gateway.write.verifyForSubject.v2'
const GATEWAY_RESERVE_OPERATION = 'gateway.write.reserveForSubject.v1'
const GATEWAY_COMPLETE_OPERATION = 'gateway.write.complete.v1'
const GATEWAY_UNKNOWN_OPERATION = 'gateway.write.markUnknown.v1'
const DISCOVERY_RESERVE_OPERATION = 'discovery.reserveForSubject.v1'
const DISCOVERY_COMPLETE_OPERATION = 'discovery.completePreflight.v1'
const READ_RESERVE_OPERATION = 'read.reserveForSubject.v1'
const READ_COMPLETE_OPERATION = 'read.complete.v1'
const READ_UNKNOWN_OPERATION = 'read.markUnknown.v1'
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
  readAuthority?: ReadAuthorityRpcClient
  discoveryAuthority?: DiscoveryAuthorityRpcClient
}

export interface ReadAuthorityRpcClient {
  reserveForSubject(input: {
    grant: SignedReadGrant; currentSubject: ReadApprovalSubject
    capabilityId: string; actionId: string; attemptId: string
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<void>
  markUnknown(reservationId: string, observation: string): Promise<void>
}

export interface DiscoveryAuthorityRpcClient {
  reserveForSubject(input: {
    grant: SignedDiscoveryGrant; currentSubject: DiscoveryApprovalSubject
    capabilityId: string; actionId: string; attemptId: string
  }): Promise<CapabilityReservation>
  completeDiscoveryPreflight(input: {
    grant: SignedDiscoveryGrant; currentSubject: DiscoveryApprovalSubject
    reservationId: string; capabilityId: string; outcome: DiscoveryPreflightOutcome
  }): Promise<string>
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
  approvalBinding: ApprovalExecutionBinding
}

export function registerAuthorityExecutionRpcOperations(
  rpc: AuthenticatedRpcServer,
  dependencies: AuthorityExecutionRpcHostDependencies,
): void {
  const readReservationApprovalContexts = new Map<string, string>()
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
  if (dependencies.discoveryAuthority) {
    rpc.registerOperation(DISCOVERY_RESERVE_OPERATION, async (payload, rpcContext) => {
      const input = parseDiscoveryReserveInput(payload)
      requireRegisteredApprovalContext(input.grant, rpcContext, 'discovery')
      return parseCapabilityReservation(await dependencies.discoveryAuthority!.reserveForSubject(input), input)
    })
    rpc.registerOperation(DISCOVERY_COMPLETE_OPERATION, async (payload, rpcContext) => {
      const input = parseDiscoveryCompleteInput(payload)
      requireRegisteredApprovalContext(input.grant, rpcContext, 'discovery')
      const preflightDigest = await dependencies.discoveryAuthority!.completeDiscoveryPreflight(input)
      if (typeof preflightDigest !== 'string' || !DIGEST.test(preflightDigest)) {
        throw executionRpcError('E2E_RPC_DISCOVERY_COMPLETE_RESULT_INVALID')
      }
      return { preflightDigest }
    })
  }
  if (dependencies.readAuthority) {
    rpc.registerOperation(READ_RESERVE_OPERATION, async (payload, rpcContext) => {
      const input = parseReadReserveInput(payload)
      requireRegisteredApprovalContext(input.grant, rpcContext, 'execution')
      const reservation = parseCapabilityReservation(
        await dependencies.readAuthority!.reserveForSubject(input), input,
      )
      const approvalContext = canonicalizeJson(input.grant.approvalContext)
      const existing = readReservationApprovalContexts.get(reservation.reservationId)
      if (existing !== undefined && existing !== approvalContext) {
        throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
      }
      readReservationApprovalContexts.set(reservation.reservationId, approvalContext)
      return reservation
    })
    rpc.registerOperation(READ_COMPLETE_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayCompleteInput(payload)
      const registered = registeredApprovalContext(rpcContext, 'execution')
      if (readReservationApprovalContexts.get(input.reservationId) !== canonicalizeJson(registered)) {
        throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
      }
      await dependencies.readAuthority!.complete(input.reservationId, input.outcomeDigest)
      return { completed: true }
    })
    rpc.registerOperation(READ_UNKNOWN_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayUnknownInput(payload)
      const registered = registeredApprovalContext(rpcContext, 'execution')
      if (readReservationApprovalContexts.get(input.reservationId) !== canonicalizeJson(registered)) {
        throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
      }
      await dependencies.readAuthority!.markUnknown(input.reservationId, input.observation)
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

function requireRegisteredApprovalContext(
  grant: SignedGrant,
  rpcContext: AuthenticatedRpcOperationContext,
  approvalType: 'discovery' | 'execution',
): void {
  const current = registeredApprovalContext(rpcContext, approvalType)
  if (canonicalizeJson(current) !== canonicalizeJson(grant.approvalContext)
    || current.subjectDigest !== grant.subjectDigest
    || current.subject !== grant.approver.subject) {
    throw executionRpcError('E2E_APPROVAL_CONTEXT_MISMATCH')
  }
}

function registeredApprovalContext(
  rpcContext: AuthenticatedRpcOperationContext,
  approvalType: 'discovery' | 'execution',
) {
  const registration = rpcContext.registration
  const candidate = isPlainObject(registration) && hasExactKeys(registration, ['approvalContext'])
    ? CanonicalApprovalContextSchema.safeParse(registration.approvalContext)
    : undefined
  const current = candidate?.success ? candidate.data : undefined
  const now = Date.parse(rpcContext.now)
  if (!current || current.approvalType !== approvalType
    || !Number.isFinite(now) || Date.parse(current.issuedAt) > now
    || Date.parse(current.expiresAt) <= now) {
    throw executionRpcError('E2E_APPROVAL_CONTEXT_MISMATCH')
  }
  return current
}

export function createAuthorityExecutionRpcClients(options: AuthorityExecutionRpcClientOptions): {
  writeApproval: TrustedWriteApprovalClient
  lease: TrustedLeaseClient
  gatewayAuthority: GatewayWriteAuthorityRpcClient
  destroy(): void
} {
  const approvalBinding = parseExecutionRpcApprovalBinding(options.approvalBinding)
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

export function createAuthorityReadRpcClient(
  options: AuthorityExecutionRpcClientOptions,
): ReadAuthorityRpcClient & { destroy(): void } {
  parseRpcApprovalBinding(options.approvalBinding, 'execution')
  const rpc = AuthenticatedRpcClient.create(options)
  return Object.freeze({
    async reserveForSubject(input: {
      grant: SignedReadGrant; currentSubject: ReadApprovalSubject; capabilityId: string
      actionId: string; attemptId: string
    }) {
      const parsed = parseReadReserveInput(input)
      return parseCapabilityReservation(await rpc.call(READ_RESERVE_OPERATION, parsed), parsed)
    },
    async complete(reservationId: string, outcomeDigest: string) {
      const input = parseGatewayCompleteInput({ reservationId, outcomeDigest })
      parseAck(await rpc.call(READ_COMPLETE_OPERATION, input), 'completed', 'E2E_RPC_READ_COMPLETE_RESULT_INVALID')
    },
    async markUnknown(reservationId: string, observation: string) {
      const input = parseGatewayUnknownInput({ reservationId, observation })
      parseAck(await rpc.call(READ_UNKNOWN_OPERATION, input), 'markedUnknown',
        'E2E_RPC_READ_UNKNOWN_RESULT_INVALID')
    },
    destroy: () => rpc.destroy(),
  })
}

export function createAuthorityDiscoveryRpcClient(
  options: AuthorityExecutionRpcClientOptions,
): DiscoveryAuthorityRpcClient & { destroy(): void } {
  parseRpcApprovalBinding(options.approvalBinding, 'discovery')
  const rpc = AuthenticatedRpcClient.create(options)
  return Object.freeze({
    async reserveForSubject(input: {
      grant: SignedDiscoveryGrant; currentSubject: DiscoveryApprovalSubject; capabilityId: string
      actionId: string; attemptId: string
    }) {
      const parsed = parseDiscoveryReserveInput(input)
      return parseCapabilityReservation(await rpc.call(DISCOVERY_RESERVE_OPERATION, parsed), parsed)
    },
    async completeDiscoveryPreflight(input: {
      grant: SignedDiscoveryGrant; currentSubject: DiscoveryApprovalSubject
      reservationId: string; capabilityId: string; outcome: DiscoveryPreflightOutcome
    }) {
      const parsed = parseDiscoveryCompleteInput(input)
      const result = await rpc.call(DISCOVERY_COMPLETE_OPERATION, parsed)
      if (!isPlainObject(result) || !hasExactKeys(result, ['preflightDigest'])
        || typeof result.preflightDigest !== 'string' || !DIGEST.test(result.preflightDigest)) {
        throw executionRpcError('E2E_RPC_DISCOVERY_COMPLETE_RESULT_INVALID')
      }
      return result.preflightDigest
    },
    destroy: () => rpc.destroy(),
  })
}

function parseRpcApprovalBinding(
  value: unknown,
  approvalType: 'discovery' | 'execution',
): ApprovalExecutionBinding {
  try {
    const binding = parseApprovalExecutionBinding(value)
    if (binding.approvalType !== approvalType) throw new Error(`${approvalType} binding required`)
    return binding
  } catch { throw executionRpcError('E2E_RPC_APPROVAL_BINDING_INVALID') }
}

function parseExecutionRpcApprovalBinding(value: unknown): ApprovalExecutionBinding {
  try {
    const binding = parseApprovalExecutionBinding(value)
    if (binding.approvalType !== 'execution') throw new Error('execution binding required')
    return binding
  } catch { throw executionRpcError('E2E_RPC_APPROVAL_BINDING_INVALID') }
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

function parseReadReserveInput(value: unknown): {
  grant: SignedReadGrant; currentSubject: ReadApprovalSubject
  capabilityId: string; actionId: string; attemptId: string
} {
  if (!isPlainObject(value) || !hasExactKeys(
    value, ['actionId', 'attemptId', 'capabilityId', 'currentSubject', 'grant'],
  )) throw executionRpcError('E2E_RPC_READ_RESERVE_INPUT_INVALID')
  const grant = SignedGrantSchema.safeParse(value.grant)
  const subject = ReadApprovalSubjectSchema.safeParse(value.currentSubject)
  if (!grant.success || !subject.success || !('caseDigest' in grant.data.subject)
    || grant.data.approvalContext.approvalType !== 'execution'
    || canonicalizeJson(grant.data.subject) !== canonicalizeJson(subject.data)
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)) {
    throw executionRpcError('E2E_RPC_READ_RESERVE_INPUT_INVALID')
  }
  return { grant: grant.data as SignedReadGrant, currentSubject: subject.data,
    capabilityId: value.capabilityId, actionId: value.actionId, attemptId: value.attemptId }
}

function parseDiscoveryReserveInput(value: unknown): {
  grant: SignedDiscoveryGrant; currentSubject: DiscoveryApprovalSubject
  capabilityId: string; actionId: string; attemptId: string
} {
  if (!isPlainObject(value) || !hasExactKeys(
    value, ['actionId', 'attemptId', 'capabilityId', 'currentSubject', 'grant'],
  )) throw executionRpcError('E2E_RPC_DISCOVERY_RESERVE_INPUT_INVALID')
  const grant = SignedGrantSchema.safeParse(value.grant)
  const subject = DiscoveryApprovalSubjectSchema.safeParse(value.currentSubject)
  if (!grant.success || !subject.success || !('expectedPageIdentity' in grant.data.subject)
    || grant.data.approvalContext.approvalType !== 'discovery'
    || canonicalizeJson(grant.data.subject) !== canonicalizeJson(subject.data)
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)) {
    throw executionRpcError('E2E_RPC_DISCOVERY_RESERVE_INPUT_INVALID')
  }
  return { grant: grant.data as SignedDiscoveryGrant, currentSubject: subject.data,
    capabilityId: value.capabilityId, actionId: value.actionId, attemptId: value.attemptId }
}

function parseDiscoveryCompleteInput(value: unknown): {
  grant: SignedDiscoveryGrant; currentSubject: DiscoveryApprovalSubject
  reservationId: string; capabilityId: string; outcome: DiscoveryPreflightOutcome
} {
  if (!isPlainObject(value) || !hasExactKeys(
    value, ['capabilityId', 'currentSubject', 'grant', 'outcome', 'reservationId'],
  )) throw executionRpcError('E2E_RPC_DISCOVERY_COMPLETE_INPUT_INVALID')
  const base = parseDiscoveryReserveInput({
    grant: value.grant, currentSubject: value.currentSubject,
    capabilityId: value.capabilityId, actionId: 'PREFLIGHT-COMPLETE', attemptId: 'PREFLIGHT-COMPLETE',
  })
  const outcome = parseDiscoveryOutcome(value.outcome)
  if (!outcome || typeof value.reservationId !== 'string' || !SAFE_ID.test(value.reservationId)) {
    throw executionRpcError('E2E_RPC_DISCOVERY_COMPLETE_INPUT_INVALID')
  }
  return { grant: base.grant, currentSubject: base.currentSubject,
    capabilityId: base.capabilityId, reservationId: value.reservationId, outcome }
}

function parseDiscoveryOutcome(value: unknown): DiscoveryPreflightOutcome | undefined {
  if (!isPlainObject(value) || typeof value.status !== 'string'
    || !['ready', 'input-blocked', 'environment-blocked', 'safety-blocked'].includes(value.status)) return undefined
  const allowedKeys = ['status', ...(Object.hasOwn(value, 'reasonCode') ? ['reasonCode'] : []),
    ...(Object.hasOwn(value, 'observedIdentity') ? ['observedIdentity'] : [])]
  if (!hasExactKeys(value, allowedKeys)
    || (Object.hasOwn(value, 'reasonCode') && (typeof value.reasonCode !== 'string' || !SAFE_ID.test(value.reasonCode)))) return undefined
  if (Object.hasOwn(value, 'observedIdentity')) {
    const identity = value.observedIdentity
    if (!isPlainObject(identity)) return undefined
    const keys = ['headings', 'title', 'url', ...(Object.hasOwn(identity, 'role') ? ['role'] : []),
      ...(Object.hasOwn(identity, 'ariaSignals') ? ['ariaSignals'] : [])]
    if (!hasExactKeys(identity, keys) || typeof identity.url !== 'string' || typeof identity.title !== 'string'
      || !Array.isArray(identity.headings) || !identity.headings.every((item) => typeof item === 'string')
      || (Object.hasOwn(identity, 'role') && typeof identity.role !== 'string')
      || (Object.hasOwn(identity, 'ariaSignals') && (!Array.isArray(identity.ariaSignals)
        || !identity.ariaSignals.every((item) => typeof item === 'string')))) return undefined
  }
  return structuredClone(value) as unknown as DiscoveryPreflightOutcome
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
  grant: SignedGrant; capabilityId: string; actionId: string; attemptId: string
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
