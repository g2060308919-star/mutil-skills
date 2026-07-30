import { describe, expect, test } from 'vitest'
import { digestText, type WriteApprovalSubjectV2 } from '@mutil-skills/e2e-contracts'
import { LocalLeaseAuthority } from '../src/local-lease-authority.js'
import { provisionWriteApprovalLeases } from '../src/write-lease-provisioning.js'

const digest = (value: string) => digestText('write-lease-provisioning-test/v1', value)

describe('write approval Lease provisioning', () => {
  test('同一状态链的多个 Action 可以共享同一个已预留 Lease', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-24T00:00:00.000Z') })
    const targetFingerprint = digest('target')
    const [lease] = await authority.acquireBoundBatch([{
      leaseId: 'LEASE-SHARED', runId: 'RUN-SHARED', resourceKey: 'order:shared',
      resourceFingerprint: targetFingerprint, exclusive: true, ttlMs: 60_000,
    }])
    const subject = writeSubject(targetFingerprint, lease!.fencingToken)

    await expect(provisionWriteApprovalLeases({
      leaseAuthority: authority, subject, runId: 'RUN-SHARED',
    })).resolves.toEqual([lease])
  })

  test('共享 leaseId 的 Action 不能声明不同资源绑定', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-24T00:00:00.000Z') })
    const subject = writeSubject(digest('target'), 1)
    subject.actions[1] = { ...subject.actions[1]!, resourceKey: 'order:rebound' }

    await expect(provisionWriteApprovalLeases({
      leaseAuthority: authority, subject, runId: 'RUN-SHARED',
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_LEASE_BINDING_AMBIGUOUS' })
  })
})

function writeSubject(targetFingerprint: string, fencingToken: number): WriteApprovalSubjectV2 {
  const request = (intentId: string, path: string, expectedOrder: number) => ({
    intentId, method: 'POST' as const, canonicalOrigin: 'https://example.test', exactPath: path,
    query: [], payload: { kind: 'no-body' as const }, targetFingerprint, maxRequests: 1, expectedOrder,
  })
  return {
    schemaVersion: '2.0.0', assetId: 'ASSET-SHARED', prdRevision: digest('prd'),
    scopeDigest: digest('scope'), requirementModelDigest: digest('model'),
    coveragePolicyDigest: digest('coverage'), universeDigest: digest('universe'),
    caseDigest: digest('case'), actionMapDigest: digest('action-map'), policyDigest: digest('policy'),
    executionContractDigest: digest('contract'), runBundleProjectionDigest: digest('bundle'),
    executionDigest: digest('execution'), environment: 'test', baseOrigin: 'https://example.test',
    actor: 'operator', discoveryGrantId: 'GRANT-DISCOVERY', preflightDigest: digest('preflight'),
    actions: [
      { actionId: 'ACTION-1', effect: 'reversible-write', dataLeaseId: 'LEASE-SHARED',
        resourceKey: 'order:shared', fencingToken, cleanupPlanDigest: digest('cleanup'),
        requests: [request('INTENT-1', '/orders/1', 1)] },
      { actionId: 'ACTION-2', effect: 'reversible-write', dataLeaseId: 'LEASE-SHARED',
        resourceKey: 'order:shared', fencingToken, cleanupPlanDigest: digest('cleanup'),
        requests: [request('INTENT-2', '/orders/2', 2)] },
    ],
  }
}
