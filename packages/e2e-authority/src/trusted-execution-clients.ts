import type {
  GrantDecision,
  SignedWriteGrant,
  WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'

export interface TrustedWriteApprovalClient {
  verifyForSubject(grant: SignedWriteGrant, currentSubject: WriteApprovalSubject): Promise<GrantDecision>
}

export interface TrustedLeaseClient {
  verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean>
}

export type TrustedExecutionClientBinding =
  | { transport: 'in-process-test' }
  | { transport: 'authenticated-rpc'; authorityPublicKeyDigest: string }

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
