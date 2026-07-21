import {
  ApprovalExecutionBindingSchema,
  E2EError,
  type ApprovalExecutionBinding,
  type AttemptExecutionContext,
  type CapabilityReservation,
  type GrantDecision,
  type SignedWriteGrant,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'

export type { ApprovalExecutionBinding } from '@mutil-skills/e2e-contracts'

export interface TrustedWriteApprovalClient {
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

export interface TrustedLeaseClient {
  verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean>
}

/** Strictly parses the four-field execution binding; parsing alone does not confer client trust. */
export function parseApprovalExecutionBinding(value: unknown): ApprovalExecutionBinding {
  const parsed = ApprovalExecutionBindingSchema.safeParse(value)
  if (!parsed.success) bindingInvalid()
  return structuredClone(parsed.data)
}

function bindingInvalid(): never {
  throw new E2EError({
    code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH', category: 'safety',
    message: 'Runtime approval binding 必须是严格的四字段结构', retryable: false,
  })
}

export type TrustedExecutionClientBinding =
  | { transport: 'in-process-test'; approvalBinding?: ApprovalExecutionBinding }
  | { transport: 'authenticated-rpc'; authorityPublicKeyDigest: string;
      approvalBinding?: ApprovalExecutionBinding }

const trustedWriteApprovalClients = new WeakMap<object, TrustedExecutionClientBinding>()
const trustedLeaseClients = new WeakMap<object, TrustedExecutionClientBinding>()

export function isTrustedWriteApprovalClient(value: unknown): value is TrustedWriteApprovalClient {
  return typeof value === 'object' && value !== null && trustedWriteApprovalClients.has(value)
}

export function isTrustedLeaseClient(value: unknown): value is TrustedLeaseClient {
  return typeof value === 'object' && value !== null && trustedLeaseClients.has(value)
}

export function getTrustedExecutionClientBinding(value: unknown): TrustedExecutionClientBinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const binding = trustedWriteApprovalClients.get(value) ?? trustedLeaseClients.get(value)
  return binding ? structuredClone(binding) : undefined
}

/** @internal 仅供本包内部登记测试内进程或认证 RPC 客户端的实际来源。 */
export function trustWriteApprovalClient<T extends TrustedWriteApprovalClient>(
  client: T,
  binding: TrustedExecutionClientBinding,
): T {
  trustedWriteApprovalClients.set(client, structuredClone(binding))
  return client
}

/** @internal 仅供本包内部登记测试内进程或认证 RPC 客户端的实际来源。 */
export function trustLeaseClient<T extends TrustedLeaseClient>(client: T, binding: TrustedExecutionClientBinding): T {
  trustedLeaseClients.set(client, structuredClone(binding))
  return client
}
