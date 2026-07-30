import {
  WriteApprovalSubjectV2Schema,
  E2EError,
  type ApprovalGrantSubject,
  type DataLease,
} from '@mutil-skills/e2e-contracts'
import type { LocalLeaseAuthority } from './local-lease-authority.js'

export async function provisionWriteApprovalLeases(input: {
  leaseAuthority: Pick<LocalLeaseAuthority, 'requireActiveBoundBatch'>
  subject: ApprovalGrantSubject
  runId: string
}): Promise<DataLease[]> {
  const parsed = WriteApprovalSubjectV2Schema.safeParse(input.subject)
  if (!parsed.success) return []
  const requestsByLease = new Map<string, {
    leaseId: string
    runId: string
    resourceKey: string
    resourceFingerprint: string
    exclusive: true
    ttlMs: 1
    fencingToken: number
  }>()
  for (const action of parsed.data.actions) {
    const fingerprints = [...new Set(action.requests.map((request) => request.targetFingerprint))]
    if (fingerprints.length !== 1) throw provisioningError('E2E_APPROVAL_LEASE_TARGET_AMBIGUOUS')
    const request = {
      leaseId: action.dataLeaseId,
      runId: input.runId,
      resourceKey: action.resourceKey,
      resourceFingerprint: fingerprints[0]!,
      exclusive: true as const,
      // 审批阶段不延长租期；ttlMs 只为满足统一绑定结构，Authority 不会使用它创建 Lease。
      ttlMs: 1 as const,
      fencingToken: action.fencingToken,
    }
    const existing = requestsByLease.get(request.leaseId)
    if (existing !== undefined
      && (existing.runId !== request.runId
        || existing.resourceKey !== request.resourceKey
        || existing.resourceFingerprint !== request.resourceFingerprint
        || existing.fencingToken !== request.fencingToken)) {
      throw provisioningError('E2E_APPROVAL_LEASE_BINDING_AMBIGUOUS')
    }
    requestsByLease.set(request.leaseId, request)
  }
  return await input.leaseAuthority.requireActiveBoundBatch([...requestsByLease.values()])
}

function provisioningError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
