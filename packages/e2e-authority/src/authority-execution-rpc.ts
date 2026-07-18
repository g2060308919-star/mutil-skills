import {
  canonicalizeJson,
  canonicalGrantApprovalSubjectDigest,
  CanonicalApprovalContextSchema,
  DiscoveryApprovalSubjectSchema,
  InjectionApprovalSubjectSchema,
  ReadApprovalSubjectSchema,
  SseReadApprovalSubjectSchema,
  SignedGrantSchema,
  WebSocketReadApprovalSubjectSchema,
  WriteApprovalSubjectV2Schema,
  type AttemptExecutionContext,
  type CapabilityReservation,
  type GrantDecision,
  type SignedWriteGrant,
  type SignedDiscoveryGrant,
  type SignedReadGrant,
  type SignedInjectionGrant,
  type SignedSseReadGrant,
  type SignedWebSocketReadGrant,
  type SignedGrant,
  type DiscoveryApprovalSubject,
  type DiscoveryPreflightOutcome,
  type ReadApprovalSubject,
  type InjectionApprovalSubject,
  type SseReadApprovalSubject,
  type WebSocketReadApprovalSubject,
  type WriteApprovalSubject,
  type DataLease,
  digestText,
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
const RESERVATION_QUERY_OPERATION = 'reservation.query.v1'
const RESERVATION_COMPLETE_OPERATION = 'reservation.complete.v1'
const RESERVATION_UNKNOWN_OPERATION = 'reservation.markUnknown.v1'
const LEASE_QUERY_OPERATION = 'lease.query.v1'
const LEASE_RELEASE_OPERATION = 'lease.release.v1'
const LEASE_QUARANTINE_OPERATION = 'lease.quarantine.v1'
const INJECTION_RESERVE_OPERATION = 'injection.reserveForSubject.v1'
const INJECTION_COMPLETE_OPERATION = 'injection.complete.v1'
const INJECTION_UNKNOWN_OPERATION = 'injection.markUnknown.v1'
const WEBSOCKET_RESERVE_OPERATION = 'websocket.read.reserveForSubject.v1'
const WEBSOCKET_COMPLETE_OPERATION = 'websocket.read.complete.v1'
const WEBSOCKET_UNKNOWN_OPERATION = 'websocket.read.markUnknown.v1'
const SSE_RESERVE_OPERATION = 'sse.read.reserveForSubject.v1'
const SSE_COMPLETE_OPERATION = 'sse.read.complete.v1'
const SSE_UNKNOWN_OPERATION = 'sse.read.markUnknown.v1'
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface AuthorityExecutionRpcHostDependencies {
  writeAuthority: {
    verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject): Promise<GrantDecision>
  }
  leaseAuthority: {
    verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean>
    getLeaseForTarget?(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<DataLease>
    releaseForTarget?(input: LeaseReleaseInput): Promise<string>
    quarantineForTarget?(input: LeaseQuarantineInput): Promise<string>
  }
  gatewayAuthority?: GatewayWriteAuthorityRpcHost
  readAuthority?: ProtocolReservationAuthority<SignedReadGrant, ReadApprovalSubject>
  discoveryAuthority?: DiscoveryAuthorityRpcClient
  reservationAuthority?: ReservationMaintenanceAuthority
  injectionAuthority?: ProtocolReservationAuthority<SignedInjectionGrant, InjectionApprovalSubject>
  webSocketAuthority?: ProtocolReservationAuthority<SignedWebSocketReadGrant, WebSocketReadApprovalSubject>
  sseAuthority?: ProtocolReservationAuthority<SignedSseReadGrant, SseReadApprovalSubject>
}

export interface ReservationMaintenanceQuery {
  reservationId?: string; attemptId?: string
  grantId: string; capabilityId: string; actionId: string
}
export interface ReservationMaintenanceAuthority {
  findReservation(query: ReservationMaintenanceQuery): CapabilityReservation | undefined
  getGrantApprovalContext(grantId: string): ReturnType<typeof CanonicalApprovalContextSchema.parse> | undefined
  getReservationRpcBinding(reservationId: string): RpcReservationOwnerBinding | undefined
  complete(reservationId: string, outcomeDigest: string): Promise<string>
  markUnknown(reservationId: string, observation: string): Promise<string>
}
export interface LeaseReleaseInput {
  leaseId: string; fencingToken: number; targetFingerprint: string; cleanupDigest: string
}
export interface LeaseQuarantineInput {
  leaseId: string; fencingToken: number; targetFingerprint: string; reason: string
}
export interface AuthorityMaintenanceRpcClient {
  queryReservation(query: ReservationMaintenanceQuery): Promise<CapabilityReservation | undefined>
  completeReservation(query: ReservationMaintenanceQuery, outcomeDigest: string): Promise<string>
  markReservationUnknown(query: ReservationMaintenanceQuery, observation: string): Promise<string>
  queryLease(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<DataLease>
  releaseLease(input: LeaseReleaseInput): Promise<string>
  quarantineLease(input: LeaseQuarantineInput): Promise<string>
}

interface ProtocolReservationAuthority<G extends SignedGrant, S> {
  reserveForSubject(input: { grant: G; currentSubject: S; capabilityId: string; actionId: string; attemptId: string
    rpcOwnerBinding?: RpcReservationOwnerBinding }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<string>
  markUnknown(reservationId: string, observation: string): Promise<string>
  getReservationRpcBinding?(reservationId: string): RpcReservationOwnerBinding | undefined
}

interface RpcReservationOwnerBinding {
  clientId: string
  approvalContext: ReturnType<typeof CanonicalApprovalContextSchema.parse>
}

interface GatewayWriteAuthorityRpcHost extends ProtocolReservationAuthority<SignedWriteGrant, WriteApprovalSubject> {
  verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject): Promise<GrantDecision>
  reserveForSubject(input: {
    grant: SignedWriteGrant; currentSubject: WriteApprovalSubject; capabilityId: string; actionId: string
    attemptId: string; attemptContext?: AttemptExecutionContext
    rpcOwnerBinding?: RpcReservationOwnerBinding
  }): Promise<CapabilityReservation>
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
  const reservationContexts = new ReservationContextRegistry()
  rpc.registerOperation(WRITE_VERIFY_OPERATION, async (payload, rpcContext) => {
    const input = parseWriteVerifyInput(payload)
    const contextDecision = verifyRegisteredApprovalContext(input.grant, rpcContext)
    if (contextDecision) return contextDecision
    return parseGrantDecision(await dependencies.writeAuthority.verifyForSubject(input.grant, input.currentSubject))
  })
  rpc.registerOperation(LEASE_VERIFY_OPERATION, async (payload, rpcContext) => {
    const input = parseLeaseVerifyInput(payload)
    const runId = registeredApprovalContext(rpcContext, 'execution').runId
    if (!dependencies.leaseAuthority.getLeaseForTarget) {
      throw executionRpcError('E2E_RPC_LEASE_OWNER_BINDING_UNAVAILABLE')
    }
    const lease = parseDataLease(await dependencies.leaseAuthority.getLeaseForTarget(
      input.leaseId, input.fencingToken, input.targetFingerprint,
    ), input)
    requireLeaseRunBinding(lease, runId)
    const verified = await dependencies.leaseAuthority.verifyTarget(
      input.leaseId, input.fencingToken, input.targetFingerprint,
    )
    if (typeof verified !== 'boolean') throw executionRpcError('E2E_RPC_LEASE_VERIFY_RESULT_INVALID')
    return { verified }
  })
  if (dependencies.reservationAuthority) {
    rpc.registerOperation(RESERVATION_QUERY_OPERATION, async (payload, rpcContext) => {
      const { query, recoveryBinding } = parseRpcReservationQueryInput(payload)
      requireRecoveryBinding(rpcContext, recoveryBinding)
      requireMaintenanceGrantContext(dependencies.reservationAuthority!, query.grantId,
        rpcContext, undefined)
      const reservation = dependencies.reservationAuthority!.findReservation(query)
      requireMaintenanceGrantContext(dependencies.reservationAuthority!, query.grantId,
        rpcContext, reservation)
      return { reservation: reservation === undefined ? null : parseQueriedReservation(reservation, query) }
    })
    rpc.registerOperation(RESERVATION_COMPLETE_OPERATION, async (payload, rpcContext) => {
      const input = parseRpcReservationCompleteInput(payload)
      requireRecoveryBinding(rpcContext, input.recoveryBinding)
      rejectRecoveryOnlyOperation(rpcContext)
      requireMaintenanceGrantContext(dependencies.reservationAuthority!, input.query.grantId,
        rpcContext, undefined)
      const reservation = requireReservationBinding(dependencies.reservationAuthority!, input.query)
      requireMaintenanceGrantContext(dependencies.reservationAuthority!, input.query.grantId,
        rpcContext, reservation)
      return { receiptDigest: parseReceiptDigest(
        await dependencies.reservationAuthority!.complete(reservation.reservationId, input.outcomeDigest),
        'E2E_RPC_RESERVATION_COMPLETE_RESULT_INVALID',
      ) }
    })
    rpc.registerOperation(RESERVATION_UNKNOWN_OPERATION, async (payload, rpcContext) => {
      const input = parseRpcReservationUnknownInput(payload)
      requireRecoveryBinding(rpcContext, input.recoveryBinding)
      requireMaintenanceGrantContext(dependencies.reservationAuthority!, input.query.grantId,
        rpcContext, undefined)
      const reservation = requireReservationBinding(dependencies.reservationAuthority!, input.query)
      requireMaintenanceGrantContext(dependencies.reservationAuthority!, input.query.grantId,
        rpcContext, reservation)
      return { receiptDigest: parseReceiptDigest(
        await dependencies.reservationAuthority!.markUnknown(reservation.reservationId, input.observation),
        'E2E_RPC_RESERVATION_UNKNOWN_RESULT_INVALID',
      ) }
    })
  }
  if (dependencies.leaseAuthority.getLeaseForTarget && dependencies.leaseAuthority.releaseForTarget
    && dependencies.leaseAuthority.quarantineForTarget) {
    rpc.registerOperation(LEASE_QUERY_OPERATION, async (payload, rpcContext) => {
      const parsed = parseRpcLeaseBindingInput(payload)
      requireRecoveryBinding(rpcContext, parsed.recoveryBinding)
      const input = parsed.input
      const lease = parseDataLease(await dependencies.leaseAuthority.getLeaseForTarget!(
        input.leaseId, input.fencingToken, input.targetFingerprint,
      ), input)
      requireLeaseRunBinding(lease, registeredRecoveryApprovalContext(rpcContext).runId)
      return { lease }
    })
    rpc.registerOperation(LEASE_RELEASE_OPERATION, async (payload, rpcContext) => {
      const parsed = parseRpcLeaseReleaseInput(payload)
      requireRecoveryBinding(rpcContext, parsed.recoveryBinding)
      rejectRecoveryOnlyOperation(rpcContext)
      const input = parsed.input
      requireLeaseRunBinding(parseDataLease(await dependencies.leaseAuthority.getLeaseForTarget!(
        input.leaseId, input.fencingToken, input.targetFingerprint,
      ), input), registeredRecoveryApprovalContext(rpcContext).runId)
      const receiptDigest = await dependencies.leaseAuthority.releaseForTarget!(input)
      return { receiptDigest: parseReceiptDigest(receiptDigest, 'E2E_RPC_LEASE_RELEASE_RESULT_INVALID') }
    })
    rpc.registerOperation(LEASE_QUARANTINE_OPERATION, async (payload, rpcContext) => {
      const parsed = parseRpcLeaseQuarantineInput(payload)
      requireRecoveryBinding(rpcContext, parsed.recoveryBinding)
      const input = parsed.input
      requireLeaseRunBinding(parseDataLease(await dependencies.leaseAuthority.getLeaseForTarget!(
        input.leaseId, input.fencingToken, input.targetFingerprint,
      ), input), registeredRecoveryApprovalContext(rpcContext).runId)
      const receiptDigest = await dependencies.leaseAuthority.quarantineForTarget!(input)
      return { receiptDigest: parseReceiptDigest(receiptDigest, 'E2E_RPC_LEASE_QUARANTINE_RESULT_INVALID') }
    })
  }
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
      const owner = rpcReservationOwner(rpcContext, input.grant.approvalContext)
      const slot = reserveReservationOwnerCapacity(dependencies.gatewayAuthority!, reservationContexts)
      try {
        const reservation = parseCapabilityReservation(await dependencies.gatewayAuthority!.reserveForSubject({
          ...input, rpcOwnerBinding: owner,
        }), input)
        recordReservationOwner(dependencies.gatewayAuthority!, reservation.reservationId,
          owner, reservationContexts, slot)
        return reservation
      } catch (error) { slot?.release(); throw error }
    })
    rpc.registerOperation(GATEWAY_COMPLETE_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayCompleteInput(payload)
      requireReservationOwner(dependencies.gatewayAuthority!, reservationContexts,
        input.reservationId, rpcContext)
      await dependencies.gatewayAuthority!.complete(input.reservationId, input.outcomeDigest)
      finalizeReservationOwner(dependencies.gatewayAuthority!, reservationContexts,
        input.reservationId, rpcContext, 'completed', digestText(
          'authority-rpc-terminal-tombstone/v1', canonicalizeJson(input),
        ))
      return { completed: true }
    })
    rpc.registerOperation(GATEWAY_UNKNOWN_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayUnknownInput(payload)
      requireReservationOwner(dependencies.gatewayAuthority!, reservationContexts,
        input.reservationId, rpcContext)
      await dependencies.gatewayAuthority!.markUnknown(input.reservationId, input.observation)
      finalizeReservationOwner(dependencies.gatewayAuthority!, reservationContexts,
        input.reservationId, rpcContext, 'unknown', digestText(
          'authority-rpc-terminal-tombstone/v1', canonicalizeJson(input),
        ))
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
      const owner = rpcReservationOwner(rpcContext, input.grant.approvalContext)
      const slot = reserveReservationOwnerCapacity(dependencies.readAuthority!, reservationContexts)
      try {
        const reservation = parseCapabilityReservation(
          await dependencies.readAuthority!.reserveForSubject({ ...input, rpcOwnerBinding: owner }), input,
        )
        recordReservationOwner(dependencies.readAuthority!, reservation.reservationId,
          owner, reservationContexts, slot)
        return reservation
      } catch (error) { slot?.release(); throw error }
    })
    rpc.registerOperation(READ_COMPLETE_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayCompleteInput(payload)
      requireReservationOwner(dependencies.readAuthority!, reservationContexts,
        input.reservationId, rpcContext)
      await dependencies.readAuthority!.complete(input.reservationId, input.outcomeDigest)
      const result = { completed: true as const }
      finalizeReservationOwner(dependencies.readAuthority!, reservationContexts,
        input.reservationId, rpcContext, 'completed',
        digestText('authority-rpc-terminal-tombstone/v1', canonicalizeJson(input)))
      return result
    })
    rpc.registerOperation(READ_UNKNOWN_OPERATION, async (payload, rpcContext) => {
      const input = parseGatewayUnknownInput(payload)
      requireReservationOwner(dependencies.readAuthority!, reservationContexts,
        input.reservationId, rpcContext)
      await dependencies.readAuthority!.markUnknown(input.reservationId, input.observation)
      const result = { markedUnknown: true as const }
      finalizeReservationOwner(dependencies.readAuthority!, reservationContexts,
        input.reservationId, rpcContext, 'unknown',
        digestText('authority-rpc-terminal-tombstone/v1', canonicalizeJson(input)))
      return result
    })
  }
  if (dependencies.injectionAuthority) registerProtocolReservationOperations(rpc, {
    reserveOperation: INJECTION_RESERVE_OPERATION, completeOperation: INJECTION_COMPLETE_OPERATION,
    unknownOperation: INJECTION_UNKNOWN_OPERATION, authority: dependencies.injectionAuthority,
    parseReserve: (value) => parseProtocolReserveInput(value, InjectionApprovalSubjectSchema, 'injection'),
    contexts: reservationContexts,
  })
  if (dependencies.webSocketAuthority) registerProtocolReservationOperations(rpc, {
    reserveOperation: WEBSOCKET_RESERVE_OPERATION, completeOperation: WEBSOCKET_COMPLETE_OPERATION,
    unknownOperation: WEBSOCKET_UNKNOWN_OPERATION, authority: dependencies.webSocketAuthority,
    parseReserve: (value) => parseProtocolReserveInput(value, WebSocketReadApprovalSubjectSchema, 'websocket'),
    contexts: reservationContexts,
  })
  if (dependencies.sseAuthority) registerProtocolReservationOperations(rpc, {
    reserveOperation: SSE_RESERVE_OPERATION, completeOperation: SSE_COMPLETE_OPERATION,
    unknownOperation: SSE_UNKNOWN_OPERATION, authority: dependencies.sseAuthority,
    parseReserve: (value) => parseProtocolReserveInput(value, SseReadApprovalSubjectSchema, 'sse'),
    contexts: reservationContexts,
  })
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
  allowExpired = false,
) {
  const registration = rpcContext.registration
  const recoveryOnly = isPlainObject(registration) && registration.recoveryOnly === true
  const candidate = isPlainObject(registration)
    && hasExactKeys(registration, ['approvalContext', ...(recoveryOnly ? ['recoveryOnly'] : [])])
    ? CanonicalApprovalContextSchema.safeParse(registration.approvalContext)
    : undefined
  const current = candidate?.success ? candidate.data : undefined
  const now = Date.parse(rpcContext.now)
  if (!current || current.approvalType !== approvalType
    || !Number.isFinite(now) || Date.parse(current.issuedAt) > now
    || (!allowExpired && (recoveryOnly || Date.parse(current.expiresAt) <= now))) {
    throw executionRpcError('E2E_APPROVAL_CONTEXT_MISMATCH')
  }
  return current
}

function registeredRecoveryApprovalContext(rpcContext: AuthenticatedRpcOperationContext) {
  return registeredApprovalContext(rpcContext, 'execution', true)
}

function requireRecoveryBinding(
  rpcContext: AuthenticatedRpcOperationContext,
  recoveryBinding: ApprovalExecutionBinding,
): void {
  if (!sameRecoveryBinding(registeredRecoveryApprovalContext(rpcContext), recoveryBinding)) {
    throw executionRpcError('E2E_RPC_RECOVERY_BINDING_MISMATCH')
  }
}

function rejectRecoveryOnlyOperation(rpcContext: AuthenticatedRpcOperationContext): void {
  if (isPlainObject(rpcContext.registration) && rpcContext.registration.recoveryOnly === true) {
    throw executionRpcError('E2E_RPC_RECOVERY_OPERATION_DENIED')
  }
}

function rpcReservationOwner(
  rpcContext: AuthenticatedRpcOperationContext,
  expected: ReturnType<typeof CanonicalApprovalContextSchema.parse>,
): RpcReservationOwnerBinding {
  const context = registeredApprovalContext(rpcContext, 'execution')
  if (canonicalizeJson(context) !== canonicalizeJson(expected)) {
    throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
  }
  return { clientId: rpcContext.clientId, approvalContext: context }
}

function recordReservationOwner(
  authority: Pick<ProtocolReservationAuthority<SignedGrant, unknown>, 'getReservationRpcBinding'>,
  reservationId: string,
  owner: RpcReservationOwnerBinding,
  contexts: ReservationContextRegistry,
  slot?: ReservationContextCapacitySlot,
): void {
  const persisted = authority.getReservationRpcBinding?.(reservationId)
  if (persisted !== undefined) {
    requireSameReservationOwner(persisted, owner)
    slot?.release()
    return
  }
  if (slot === undefined) throw executionRpcError('E2E_RPC_RESERVATION_OWNER_BINDING_UNAVAILABLE')
  slot.commit(reservationId, owner.clientId, canonicalizeJson(owner.approvalContext))
}

function reserveReservationOwnerCapacity(
  _authority: Pick<ProtocolReservationAuthority<SignedGrant, unknown>, 'getReservationRpcBinding'>,
  contexts: ReservationContextRegistry,
): ReservationContextCapacitySlot {
  return contexts.reserveSlot()
}

function requireReservationOwner(
  authority: Pick<ProtocolReservationAuthority<SignedGrant, unknown>, 'getReservationRpcBinding'>,
  contexts: ReservationContextRegistry,
  reservationId: string,
  rpcContext: AuthenticatedRpcOperationContext,
): void {
  if (isPlainObject(rpcContext.registration) && rpcContext.registration.recoveryOnly === true) {
    throw executionRpcError('E2E_APPROVAL_CONTEXT_MISMATCH')
  }
  const registered = registeredRecoveryApprovalContext(rpcContext)
  const persisted = authority.getReservationRpcBinding?.(reservationId)
  if (persisted !== undefined) {
    if (persisted.clientId !== rpcContext.clientId
      || canonicalizeJson(persisted.approvalContext) !== canonicalizeJson(registered)) {
      throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
    }
    return
  }
  const owner = { clientId: rpcContext.clientId, approvalContext: registered }
  contexts.require(reservationId, owner.clientId, canonicalizeJson(owner.approvalContext))
}

function finalizeReservationOwner(
  authority: Pick<ProtocolReservationAuthority<SignedGrant, unknown>, 'getReservationRpcBinding'>,
  contexts: ReservationContextRegistry,
  reservationId: string,
  rpcContext: AuthenticatedRpcOperationContext,
  terminal: 'completed' | 'unknown',
  receiptDigest: string,
): void {
  if (authority.getReservationRpcBinding?.(reservationId) !== undefined) return
  const context = registeredRecoveryApprovalContext(rpcContext)
  contexts.finalize(reservationId, rpcContext.clientId, canonicalizeJson(context), terminal, receiptDigest)
}

function requireSameReservationOwner(
  stored: RpcReservationOwnerBinding,
  candidate: RpcReservationOwnerBinding,
): void {
  if (stored.clientId !== candidate.clientId
    || canonicalizeJson(stored.approvalContext) !== canonicalizeJson(candidate.approvalContext)) {
    throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
  }
}

function sameRecoveryBinding(
  context: ReturnType<typeof CanonicalApprovalContextSchema.parse>,
  binding: ApprovalExecutionBinding,
): boolean {
  return context.runId === binding.runId
    && context.installationDigest === binding.installationDigest
    && context.approvalType === binding.approvalType
    && context.subjectDigest === binding.subjectDigest
}

function requireLeaseRunBinding(lease: DataLease, runId: string): void {
  if (lease.runId !== runId) throw executionRpcError('E2E_RPC_LEASE_RUN_MISMATCH')
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
      parseAck(await rpc.call(GATEWAY_COMPLETE_OPERATION, input), 'completed',
        'E2E_RPC_GATEWAY_COMPLETE_RESULT_INVALID')
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
      parseAck(await rpc.call(READ_COMPLETE_OPERATION, input), 'completed',
        'E2E_RPC_READ_COMPLETE_RESULT_INVALID')
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

export function createAuthorityMaintenanceRpcClient(
  options: AuthorityExecutionRpcClientOptions,
): AuthorityMaintenanceRpcClient & { destroy(): void } {
  const recoveryBinding = parseRpcApprovalBinding(options.approvalBinding, 'execution')
  const rpc = AuthenticatedRpcClient.create(options)
  return Object.freeze({
    async queryReservation(query: ReservationMaintenanceQuery) {
      const parsed = parseReservationQuery(query)
      const result = await rpc.call(RESERVATION_QUERY_OPERATION, { ...parsed, recoveryBinding })
      if (!isPlainObject(result) || !hasExactKeys(result, ['reservation'])) {
        throw executionRpcError('E2E_RPC_RESERVATION_QUERY_RESULT_INVALID')
      }
      if (result.reservation === null) return undefined
      return parseQueriedReservation(result.reservation, parsed)
    },
    async completeReservation(query: ReservationMaintenanceQuery, outcomeDigest: string) {
      const parsed = parseReservationCompleteInput({ ...query, outcomeDigest })
      return parseReceiptResult(await rpc.call(RESERVATION_COMPLETE_OPERATION,
        { ...parsed.query, outcomeDigest: parsed.outcomeDigest, recoveryBinding }),
      'E2E_RPC_RESERVATION_COMPLETE_RESULT_INVALID')
    },
    async markReservationUnknown(query: ReservationMaintenanceQuery, observation: string) {
      const parsed = parseReservationUnknownInput({ ...query, observation })
      return parseReceiptResult(await rpc.call(RESERVATION_UNKNOWN_OPERATION,
        { ...parsed.query, observation: parsed.observation, recoveryBinding }),
      'E2E_RPC_RESERVATION_UNKNOWN_RESULT_INVALID')
    },
    async queryLease(leaseId: string, fencingToken: number, targetFingerprint: string) {
      const input = parseLeaseBindingInput({ leaseId, fencingToken, targetFingerprint })
      const result = await rpc.call(LEASE_QUERY_OPERATION, { ...input, recoveryBinding })
      if (!isPlainObject(result) || !hasExactKeys(result, ['lease'])) {
        throw executionRpcError('E2E_RPC_LEASE_QUERY_RESULT_INVALID')
      }
      return parseDataLease(result.lease, input)
    },
    async releaseLease(input: LeaseReleaseInput) {
      return parseReceiptResult(await rpc.call(LEASE_RELEASE_OPERATION,
        { ...parseLeaseReleaseInput(input), recoveryBinding }),
        'E2E_RPC_LEASE_RELEASE_RESULT_INVALID')
    },
    async quarantineLease(input: LeaseQuarantineInput) {
      return parseReceiptResult(await rpc.call(LEASE_QUARANTINE_OPERATION,
        { ...parseLeaseQuarantineInput(input), recoveryBinding }),
        'E2E_RPC_LEASE_QUARANTINE_RESULT_INVALID')
    },
    destroy: () => rpc.destroy(),
  })
}

export interface ProtocolReservationRpcClient<G extends SignedGrant, S> {
  reserveForSubject(input: {
    grant: G; currentSubject: S; capabilityId: string; actionId: string; attemptId: string
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<string>
  markUnknown(reservationId: string, observation: string): Promise<string>
}

export function createAuthorityInjectionRpcClient(options: AuthorityExecutionRpcClientOptions) {
  return createProtocolReservationRpcClient<SignedInjectionGrant, InjectionApprovalSubject>(options, {
    reserveOperation: INJECTION_RESERVE_OPERATION, completeOperation: INJECTION_COMPLETE_OPERATION,
    unknownOperation: INJECTION_UNKNOWN_OPERATION,
    parseReserve: (value) => parseProtocolReserveInput(value, InjectionApprovalSubjectSchema, 'injection'),
  })
}

export function createAuthorityWebSocketRpcClient(options: AuthorityExecutionRpcClientOptions) {
  return createProtocolReservationRpcClient<SignedWebSocketReadGrant, WebSocketReadApprovalSubject>(options, {
    reserveOperation: WEBSOCKET_RESERVE_OPERATION, completeOperation: WEBSOCKET_COMPLETE_OPERATION,
    unknownOperation: WEBSOCKET_UNKNOWN_OPERATION,
    parseReserve: (value) => parseProtocolReserveInput(value, WebSocketReadApprovalSubjectSchema, 'websocket'),
  })
}

export function createAuthoritySseRpcClient(options: AuthorityExecutionRpcClientOptions) {
  return createProtocolReservationRpcClient<SignedSseReadGrant, SseReadApprovalSubject>(options, {
    reserveOperation: SSE_RESERVE_OPERATION, completeOperation: SSE_COMPLETE_OPERATION,
    unknownOperation: SSE_UNKNOWN_OPERATION,
    parseReserve: (value) => parseProtocolReserveInput(value, SseReadApprovalSubjectSchema, 'sse'),
  })
}

function createProtocolReservationRpcClient<G extends SignedGrant, S>(
  options: AuthorityExecutionRpcClientOptions,
  config: {
    reserveOperation: string; completeOperation: string; unknownOperation: string
    parseReserve(value: unknown): { grant: G; currentSubject: S; capabilityId: string; actionId: string; attemptId: string }
  },
): ProtocolReservationRpcClient<G, S> & { destroy(): void } {
  const approvalBinding = parseRpcApprovalBinding(options.approvalBinding, 'execution')
  const rpc = AuthenticatedRpcClient.create(options)
  return Object.freeze({
    async reserveForSubject(input: {
      grant: G; currentSubject: S; capabilityId: string; actionId: string; attemptId: string
    }) {
      const parsed = config.parseReserve(input)
      return parseCapabilityReservation(await rpc.call(config.reserveOperation, parsed), parsed)
    },
    async complete(reservationId: string, outcomeDigest: string) {
      return parseReceiptResult(await rpc.call(config.completeOperation,
        parseGatewayCompleteInput({ reservationId, outcomeDigest })),
      'E2E_RPC_PROTOCOL_COMPLETE_RESULT_INVALID')
    },
    async markUnknown(reservationId: string, observation: string) {
      return parseReceiptResult(await rpc.call(config.unknownOperation,
        parseGatewayUnknownInput({ reservationId, observation })),
      'E2E_RPC_PROTOCOL_UNKNOWN_RESULT_INVALID')
    },
    destroy: () => rpc.destroy(),
  })
}

function registerProtocolReservationOperations<G extends SignedGrant, S>(
  rpc: AuthenticatedRpcServer,
  config: {
    reserveOperation: string; completeOperation: string; unknownOperation: string
    authority: ProtocolReservationAuthority<G, S>
    parseReserve(value: unknown): { grant: G; currentSubject: S; capabilityId: string; actionId: string; attemptId: string }
    contexts: ReservationContextRegistry
  },
): void {
  rpc.registerOperation(config.reserveOperation, async (payload, rpcContext) => {
    const input = config.parseReserve(payload)
    requireRegisteredApprovalContext(input.grant, rpcContext, 'execution')
    const owner = rpcReservationOwner(rpcContext, input.grant.approvalContext)
    const slot = reserveReservationOwnerCapacity(config.authority, config.contexts)
    try {
      const reservation = parseCapabilityReservation(await config.authority.reserveForSubject({
        ...input, rpcOwnerBinding: owner,
      }), input)
      recordReservationOwner(config.authority, reservation.reservationId, owner, config.contexts, slot)
      return reservation
    } catch (error) { slot?.release(); throw error }
  })
  rpc.registerOperation(config.completeOperation, async (payload, rpcContext) => {
    const input = parseGatewayCompleteInput(payload)
    requireReservationOwner(config.authority, config.contexts, input.reservationId, rpcContext)
    const receipt = await config.authority.complete(input.reservationId, input.outcomeDigest)
    const result = terminalReceiptResult(receipt, 'completed', input)
    finalizeReservationOwner(config.authority, config.contexts, input.reservationId,
      rpcContext, 'completed', result.receiptDigest)
    return result
  })
  rpc.registerOperation(config.unknownOperation, async (payload, rpcContext) => {
    const input = parseGatewayUnknownInput(payload)
    requireReservationOwner(config.authority, config.contexts, input.reservationId, rpcContext)
    const receipt = await config.authority.markUnknown(input.reservationId, input.observation)
    const result = terminalReceiptResult(receipt, 'unknown', input)
    finalizeReservationOwner(config.authority, config.contexts, input.reservationId,
      rpcContext, 'unknown', result.receiptDigest)
    return result
  })
}

interface ReservationContextCapacitySlot {
  commit(reservationId: string, clientId: string, approvalContext: string): void
  release(): void
}

class ReservationContextRegistry {
  static readonly MAX_RECORDS = 4_096
  readonly #active = new Map<string, { clientId: string; approvalContext: string }>()
  readonly #tombstones = new Map<string, {
    clientId: string; approvalContext: string; terminal: 'completed' | 'unknown'; receiptDigest: string
  }>()
  #reservedSlots = 0

  reserveSlot(): ReservationContextCapacitySlot {
    if (this.#active.size + this.#tombstones.size + this.#reservedSlots
      >= ReservationContextRegistry.MAX_RECORDS) {
      throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_CAPACITY')
    }
    this.#reservedSlots += 1
    let active = true
    return Object.freeze({
      commit: (reservationId: string, clientId: string, approvalContext: string) => {
        if (!active) throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_SLOT_INVALID')
        const existing = this.#active.get(reservationId) ?? this.#tombstones.get(reservationId)
        if (existing) throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
        active = false
        this.#reservedSlots -= 1
        this.#active.set(reservationId, { clientId, approvalContext })
      },
      release: () => {
        if (!active) return
        active = false
        this.#reservedSlots -= 1
      },
    })
  }

  require(reservationId: string, clientId: string, approvalContext: string): void {
    const existing = this.#active.get(reservationId) ?? this.#tombstones.get(reservationId)
    if (!existing || existing.clientId !== clientId || existing.approvalContext !== approvalContext) {
      throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
    }
  }

  finalize(reservationId: string, clientId: string, approvalContext: string,
    terminal: 'completed' | 'unknown', receiptDigest: string): void {
    const existing = this.#tombstones.get(reservationId)
    if (existing && (existing.clientId !== clientId || existing.approvalContext !== approvalContext
      || existing.terminal !== terminal || existing.receiptDigest !== receiptDigest)) {
      throw executionRpcError('E2E_RPC_RESERVATION_TERMINAL_MISMATCH')
    }
    this.#active.delete(reservationId)
    if (!existing) this.#tombstones.set(reservationId, { clientId, approvalContext, terminal, receiptDigest })
  }
}

function parseProtocolReserveInput<G extends SignedGrant, S>(
  value: unknown,
  subjectSchema: { safeParse(value: unknown): { success: boolean; data?: S } },
  protocol: string,
): { grant: G; currentSubject: S; capabilityId: string; actionId: string; attemptId: string } {
  if (!isPlainObject(value) || !hasExactKeys(
    value, ['actionId', 'attemptId', 'capabilityId', 'currentSubject', 'grant'],
  )) throw executionRpcError(`E2E_RPC_${protocol.toUpperCase()}_RESERVE_INPUT_INVALID`)
  const grant = SignedGrantSchema.safeParse(value.grant)
  const subject = subjectSchema.safeParse(value.currentSubject)
  if (!grant.success || !subject.success || subject.data === undefined
    || grant.data.approvalContext.approvalType !== 'execution'
    || canonicalizeJson(grant.data.subject) !== canonicalizeJson(subject.data)
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)) {
    throw executionRpcError(`E2E_RPC_${protocol.toUpperCase()}_RESERVE_INPUT_INVALID`)
  }
  return { grant: grant.data as G, currentSubject: subject.data,
    capabilityId: value.capabilityId, actionId: value.actionId, attemptId: value.attemptId }
}

function terminalReceiptResult(
  receipt: string,
  terminal: 'completed' | 'unknown',
  input: { reservationId: string; outcomeDigest?: string; observation?: string },
): { receiptDigest: string } {
  void terminal
  void input
  return { receiptDigest: parseReceiptDigest(receipt, 'E2E_RPC_RESERVATION_RECEIPT_INVALID') }
}

function parseReceiptResult(value: unknown, code: string): string {
  if (!isPlainObject(value) || !hasExactKeys(value, ['receiptDigest'])) throw executionRpcError(code)
  return parseReceiptDigest(value.receiptDigest, code)
}

function parseReceiptDigest(value: unknown, code: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw executionRpcError(code)
  return value
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

function parseReservationQuery(value: unknown): ReservationMaintenanceQuery {
  if (!isPlainObject(value)) throw executionRpcError('E2E_RPC_RESERVATION_QUERY_INPUT_INVALID')
  const hasReservationId = Object.hasOwn(value, 'reservationId')
  const hasAttemptId = Object.hasOwn(value, 'attemptId')
  if (hasReservationId === hasAttemptId
    || !hasExactKeys(value, ['actionId', 'capabilityId', 'grantId', hasReservationId ? 'reservationId' : 'attemptId'])
    || typeof value.grantId !== 'string' || !SAFE_ID.test(value.grantId)
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)) {
    throw executionRpcError('E2E_RPC_RESERVATION_QUERY_INPUT_INVALID')
  }
  const stableId = hasReservationId ? value.reservationId : value.attemptId
  if (typeof stableId !== 'string' || !SAFE_ID.test(stableId)) {
    throw executionRpcError('E2E_RPC_RESERVATION_QUERY_INPUT_INVALID')
  }
  return { grantId: value.grantId, capabilityId: value.capabilityId, actionId: value.actionId,
    ...(hasReservationId ? { reservationId: stableId } : { attemptId: stableId }) }
}

function parseRpcReservationQueryInput(value: unknown): {
  query: ReservationMaintenanceQuery; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'recoveryBinding')) {
    throw executionRpcError('E2E_RPC_RESERVATION_QUERY_INPUT_INVALID')
  }
  const { recoveryBinding, ...query } = value
  return { query: parseReservationQuery(query),
    recoveryBinding: parseRpcApprovalBinding(recoveryBinding, 'execution') }
}

function parseReservationCompleteInput(value: unknown): {
  query: ReservationMaintenanceQuery; outcomeDigest: string
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'outcomeDigest')) {
    throw executionRpcError('E2E_RPC_RESERVATION_COMPLETE_INPUT_INVALID')
  }
  const { outcomeDigest, ...queryValue } = value
  let query: ReservationMaintenanceQuery
  try { query = parseReservationQuery(queryValue) } catch {
    throw executionRpcError('E2E_RPC_RESERVATION_COMPLETE_INPUT_INVALID')
  }
  if (typeof outcomeDigest !== 'string' || !DIGEST.test(outcomeDigest)) {
    throw executionRpcError('E2E_RPC_RESERVATION_COMPLETE_INPUT_INVALID')
  }
  return { query, outcomeDigest }
}

function parseRpcReservationCompleteInput(value: unknown): {
  query: ReservationMaintenanceQuery; outcomeDigest: string; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'recoveryBinding')) {
    throw executionRpcError('E2E_RPC_RESERVATION_COMPLETE_INPUT_INVALID')
  }
  const { recoveryBinding, ...input } = value
  return { ...parseReservationCompleteInput(input),
    recoveryBinding: parseRpcApprovalBinding(recoveryBinding, 'execution') }
}

function parseReservationUnknownInput(value: unknown): {
  query: ReservationMaintenanceQuery; observation: string
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'observation')) {
    throw executionRpcError('E2E_RPC_RESERVATION_UNKNOWN_INPUT_INVALID')
  }
  const { observation, ...queryValue } = value
  let query: ReservationMaintenanceQuery
  try { query = parseReservationQuery(queryValue) } catch {
    throw executionRpcError('E2E_RPC_RESERVATION_UNKNOWN_INPUT_INVALID')
  }
  if (typeof observation !== 'string' || observation.length < 1 || observation.length > 16 * 1024) {
    throw executionRpcError('E2E_RPC_RESERVATION_UNKNOWN_INPUT_INVALID')
  }
  return { query, observation }
}

function parseRpcReservationUnknownInput(value: unknown): {
  query: ReservationMaintenanceQuery; observation: string; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'recoveryBinding')) {
    throw executionRpcError('E2E_RPC_RESERVATION_UNKNOWN_INPUT_INVALID')
  }
  const { recoveryBinding, ...input } = value
  return { ...parseReservationUnknownInput(input),
    recoveryBinding: parseRpcApprovalBinding(recoveryBinding, 'execution') }
}

function requireReservationBinding(
  authority: ReservationMaintenanceAuthority,
  query: ReservationMaintenanceQuery,
): CapabilityReservation {
  const reservation = authority.findReservation(query)
  if (!reservation) throw executionRpcError('E2E_RPC_RESERVATION_NOT_FOUND')
  return parseQueriedReservation(reservation, query)
}

function requireMaintenanceGrantContext(
  authority: ReservationMaintenanceAuthority,
  grantId: string,
  rpcContext: AuthenticatedRpcOperationContext,
  reservation: CapabilityReservation | undefined,
): void {
  const registered = registeredRecoveryApprovalContext(rpcContext)
  const grantContext = authority.getGrantApprovalContext(grantId)
  if (!grantContext || canonicalizeJson(grantContext) !== canonicalizeJson(registered)) {
    throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
  }
  if (reservation !== undefined) {
    const owner = authority.getReservationRpcBinding(reservation.reservationId)
    if (owner === undefined) throw executionRpcError('E2E_RPC_RESERVATION_RECOVERY_UNAUTHORIZED')
    if (owner.clientId !== rpcContext.clientId
      || canonicalizeJson(owner.approvalContext) !== canonicalizeJson(registered)) {
      throw executionRpcError('E2E_RPC_RESERVATION_CONTEXT_MISMATCH')
    }
  }
}

function parseQueriedReservation(value: unknown, expected: ReservationMaintenanceQuery): CapabilityReservation {
  if (!isPlainObject(value)) throw executionRpcError('E2E_RPC_RESERVATION_QUERY_RESULT_INVALID')
  const optional = ['attemptContext', 'observation', 'outcomeDigest'].filter((key) => Object.hasOwn(value, key))
  if (!hasExactKeys(value, ['actionId', 'attemptId', 'capabilityId', 'grantId', 'reservationId', 'reservedAt',
    'status', ...optional])
    || typeof value.reservationId !== 'string' || !SAFE_ID.test(value.reservationId)
    || typeof value.grantId !== 'string' || !SAFE_ID.test(value.grantId)
    || typeof value.capabilityId !== 'string' || !SAFE_ID.test(value.capabilityId)
    || typeof value.actionId !== 'string' || !SAFE_ID.test(value.actionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || typeof value.reservedAt !== 'string' || !isCanonicalInstant(value.reservedAt)
    || !['reserved', 'completed', 'unknown'].includes(value.status as string)
    || (Object.hasOwn(value, 'attemptContext') && !parseAttemptContext(value.attemptContext))
    || (value.status === 'reserved' && (Object.hasOwn(value, 'observation') || Object.hasOwn(value, 'outcomeDigest')))
    || (value.status === 'completed' && (typeof value.outcomeDigest !== 'string' || !DIGEST.test(value.outcomeDigest)
      || Object.hasOwn(value, 'observation')))
    || (value.status === 'unknown' && (typeof value.observation !== 'string' || value.observation.length < 1
      || value.observation.length > 16 * 1024 || Object.hasOwn(value, 'outcomeDigest')))) {
    throw executionRpcError('E2E_RPC_RESERVATION_QUERY_RESULT_INVALID')
  }
  const reservation = structuredClone(value) as unknown as CapabilityReservation
  if (reservation.grantId !== expected.grantId || reservation.capabilityId !== expected.capabilityId
    || reservation.actionId !== expected.actionId
    || (expected.reservationId !== undefined && reservation.reservationId !== expected.reservationId)
    || (expected.attemptId !== undefined && reservation.attemptId !== expected.attemptId)) {
    throw executionRpcError('E2E_RPC_RESERVATION_QUERY_BINDING_INVALID')
  }
  return reservation
}

function parseLeaseBindingInput(value: unknown): {
  leaseId: string; fencingToken: number; targetFingerprint: string
} {
  return parseLeaseVerifyInput(value)
}

function parseRpcLeaseBindingInput(value: unknown): {
  input: ReturnType<typeof parseLeaseBindingInput>; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'recoveryBinding')) {
    throw executionRpcError('E2E_RPC_LEASE_VERIFY_INPUT_INVALID')
  }
  const { recoveryBinding, ...input } = value
  return { input: parseLeaseBindingInput(input),
    recoveryBinding: parseRpcApprovalBinding(recoveryBinding, 'execution') }
}

function parseLeaseReleaseInput(value: unknown): LeaseReleaseInput {
  if (!isPlainObject(value) || !hasExactKeys(value,
    ['cleanupDigest', 'fencingToken', 'leaseId', 'targetFingerprint'])) {
    throw executionRpcError('E2E_RPC_LEASE_RELEASE_INPUT_INVALID')
  }
  const binding = parseLeaseBindingInput({ leaseId: value.leaseId, fencingToken: value.fencingToken,
    targetFingerprint: value.targetFingerprint })
  if (typeof value.cleanupDigest !== 'string' || !DIGEST.test(value.cleanupDigest)) {
    throw executionRpcError('E2E_RPC_LEASE_RELEASE_INPUT_INVALID')
  }
  return { ...binding, cleanupDigest: value.cleanupDigest }
}

function parseRpcLeaseReleaseInput(value: unknown): {
  input: LeaseReleaseInput; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'recoveryBinding')) {
    throw executionRpcError('E2E_RPC_LEASE_RELEASE_INPUT_INVALID')
  }
  const { recoveryBinding, ...input } = value
  return { input: parseLeaseReleaseInput(input),
    recoveryBinding: parseRpcApprovalBinding(recoveryBinding, 'execution') }
}

function parseLeaseQuarantineInput(value: unknown): LeaseQuarantineInput {
  if (!isPlainObject(value) || !hasExactKeys(value,
    ['fencingToken', 'leaseId', 'reason', 'targetFingerprint'])) {
    throw executionRpcError('E2E_RPC_LEASE_QUARANTINE_INPUT_INVALID')
  }
  const binding = parseLeaseBindingInput({ leaseId: value.leaseId, fencingToken: value.fencingToken,
    targetFingerprint: value.targetFingerprint })
  if (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 16 * 1024) {
    throw executionRpcError('E2E_RPC_LEASE_QUARANTINE_INPUT_INVALID')
  }
  return { ...binding, reason: value.reason }
}

function parseRpcLeaseQuarantineInput(value: unknown): {
  input: LeaseQuarantineInput; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'recoveryBinding')) {
    throw executionRpcError('E2E_RPC_LEASE_QUARANTINE_INPUT_INVALID')
  }
  const { recoveryBinding, ...input } = value
  return { input: parseLeaseQuarantineInput(input),
    recoveryBinding: parseRpcApprovalBinding(recoveryBinding, 'execution') }
}

function parseDataLease(value: unknown, expected: {
  leaseId: string; fencingToken: number; targetFingerprint: string
}): DataLease {
  if (!isPlainObject(value)) throw executionRpcError('E2E_RPC_LEASE_QUERY_RESULT_INVALID')
  const optional = ['cleanupDigest', 'quarantineReason'].filter((key) => Object.hasOwn(value, key))
  if (!hasExactKeys(value, ['acquiredAt', 'exclusive', 'expiresAt', 'fencingToken', 'leaseId',
    'resourceFingerprint', 'resourceKey', 'runId', 'status', ...optional])
    || typeof value.leaseId !== 'string' || !SAFE_ID.test(value.leaseId)
    || typeof value.runId !== 'string' || !SAFE_ID.test(value.runId)
    || typeof value.resourceKey !== 'string' || value.resourceKey.length < 1 || value.resourceKey.length > 16 * 1024
    || typeof value.resourceFingerprint !== 'string' || !DIGEST.test(value.resourceFingerprint)
    || typeof value.exclusive !== 'boolean'
    || typeof value.fencingToken !== 'number' || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 0
    || typeof value.acquiredAt !== 'string' || !isCanonicalInstant(value.acquiredAt)
    || typeof value.expiresAt !== 'string' || !isCanonicalInstant(value.expiresAt)
    || !['tentative', 'active', 'quarantined', 'released'].includes(value.status as string)
    || (Object.hasOwn(value, 'cleanupDigest') && (typeof value.cleanupDigest !== 'string' || !DIGEST.test(value.cleanupDigest)))
    || (Object.hasOwn(value, 'quarantineReason') && (typeof value.quarantineReason !== 'string'
      || value.quarantineReason.length < 1 || value.quarantineReason.length > 16 * 1024))
    || (value.status === 'released' && !Object.hasOwn(value, 'cleanupDigest'))
    || (value.status === 'quarantined' && !Object.hasOwn(value, 'quarantineReason'))) {
    throw executionRpcError('E2E_RPC_LEASE_QUERY_RESULT_INVALID')
  }
  const lease = structuredClone(value) as unknown as DataLease
  if (lease.leaseId !== expected.leaseId || lease.fencingToken !== expected.fencingToken
    || lease.resourceFingerprint !== expected.targetFingerprint) {
    throw executionRpcError('E2E_RPC_LEASE_QUERY_BINDING_INVALID')
  }
  return lease
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

function parseRpcGatewayCompleteInput(value: unknown): {
  reservationId: string; outcomeDigest: string; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ['outcomeDigest', 'recoveryBinding', 'reservationId'])) {
    throw executionRpcError('E2E_RPC_GATEWAY_COMPLETE_INPUT_INVALID')
  }
  return {
    ...parseGatewayCompleteInput({ reservationId: value.reservationId, outcomeDigest: value.outcomeDigest }),
    recoveryBinding: parseRpcApprovalBinding(value.recoveryBinding, 'execution'),
  }
}

function parseGatewayUnknownInput(value: unknown): { reservationId: string; observation: string } {
  if (!isPlainObject(value) || !hasExactKeys(value, ['observation', 'reservationId'])
    || typeof value.reservationId !== 'string' || !SAFE_ID.test(value.reservationId)
    || typeof value.observation !== 'string' || value.observation.length < 1 || value.observation.length > 16 * 1024) {
    throw executionRpcError('E2E_RPC_GATEWAY_UNKNOWN_INPUT_INVALID')
  }
  return { reservationId: value.reservationId, observation: value.observation }
}

function parseRpcGatewayUnknownInput(value: unknown): {
  reservationId: string; observation: string; recoveryBinding: ApprovalExecutionBinding
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ['observation', 'recoveryBinding', 'reservationId'])) {
    throw executionRpcError('E2E_RPC_GATEWAY_UNKNOWN_INPUT_INVALID')
  }
  return {
    ...parseGatewayUnknownInput({ reservationId: value.reservationId, observation: value.observation }),
    recoveryBinding: parseRpcApprovalBinding(value.recoveryBinding, 'execution'),
  }
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
