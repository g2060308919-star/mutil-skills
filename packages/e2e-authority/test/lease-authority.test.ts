import { describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestText } from '@mutil-skills/e2e-contracts'
import { LocalLeaseAuthority } from '../src/index.js'

const fingerprint = digestText('resource/v1', 'order:100')

describe('LocalLeaseAuthority', () => {
  test('atomically gives an exclusive resource key to only one run', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const request = { runId: 'RUN-1', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 }
    const results = await Promise.allSettled([
      authority.acquire(request),
      authority.acquire({ ...request, runId: 'RUN-2' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  test('activates with a fencing token and verifies the exact write target', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const tentative = await authority.acquire({
      runId: 'RUN-1', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })
    const active = await authority.activate(tentative.leaseId)

    expect(active).toMatchObject({ status: 'active', fencingToken: 1 })
    expect(await authority.verifyTarget(active.leaseId, 1, fingerprint)).toBe(true)
    expect(await authority.verifyTarget(active.leaseId, 0, fingerprint)).toBe(false)
    expect(await authority.verifyTarget(active.leaseId, 1, digestText('resource/v1', 'order:999'))).toBe(false)
  })

  test('以审批主题指定的 leaseId 幂等取得 active lease，且拒绝重绑定', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const input = { leaseId: 'LEASE-RUN-1', runId: 'RUN-1', resourceKey: 'order:100',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 }

    const first = await authority.acquireBound(input)
    const replay = await authority.acquireBound(input)

    expect(first).toMatchObject({ leaseId: input.leaseId, status: 'active', fencingToken: 1 })
    expect(replay).toEqual(first)
    await expect(authority.acquireBound({ ...input, runId: 'RUN-2' }))
      .rejects.toMatchObject({ code: 'E2E_LEASE_BINDING_MISMATCH' })
    await expect(authority.acquireBound({ ...input, leaseId: 'LEASE-RUN-2', runId: 'RUN-2' }))
      .rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })
  })

  test('批量绑定要么全部激活，要么不留任何部分租约', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    await authority.acquireBound({
      leaseId: 'LEASE-BLOCKER', runId: 'RUN-BLOCKER', resourceKey: 'order:blocked',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })

    await expect(authority.acquireBoundBatch([
      { leaseId: 'LEASE-FIRST', runId: 'RUN-1', resourceKey: 'order:first',
        resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 },
      { leaseId: 'LEASE-SECOND', runId: 'RUN-1', resourceKey: 'order:blocked',
        resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 },
    ])).rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })

    await expect(authority.acquireBound({
      leaseId: 'LEASE-OTHER', runId: 'RUN-2', resourceKey: 'order:first',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })).resolves.toMatchObject({ status: 'active', fencingToken: 1 })
  })

  test('批量预留返回真实 fencing token，审批阶段只接受完全一致的 active 租约', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const requests = [
      { leaseId: 'LEASE-A', runId: 'RUN-1', resourceKey: 'order:a',
        resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 },
      { leaseId: 'LEASE-B', runId: 'RUN-1', resourceKey: 'order:b',
        resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 },
    ]

    const reserved = await authority.acquireBoundBatch(requests)
    expect(reserved).toMatchObject([
      { leaseId: 'LEASE-A', status: 'active', fencingToken: 1 },
      { leaseId: 'LEASE-B', status: 'active', fencingToken: 1 },
    ])
    await expect(authority.requireActiveBoundBatch(reserved.map((lease, index) => ({
      ...requests[index]!, fencingToken: lease.fencingToken,
    })))).resolves.toEqual(reserved)
    await expect(authority.requireActiveBoundBatch([{ ...requests[0]!, fencingToken: 2 }]))
      .rejects.toMatchObject({ code: 'E2E_LEASE_BINDING_MISMATCH' })
  })

  test('批量请求拒绝重复 leaseId 或 resourceKey', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const base = { leaseId: 'LEASE-A', runId: 'RUN-1', resourceKey: 'order:a',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 }
    await expect(authority.acquireBoundBatch([base, { ...base, resourceKey: 'order:b' }]))
      .rejects.toMatchObject({ code: 'E2E_LEASE_BATCH_DUPLICATE' })
    await expect(authority.acquireBoundBatch([base, { ...base, leaseId: 'LEASE-B' }]))
      .rejects.toMatchObject({ code: 'E2E_LEASE_BATCH_DUPLICATE' })
  })

  test('只回收从未激活的过期占用；过期 active lease 必须隔离并继续阻止写入', async () => {
    let now = new Date('2026-07-11T10:00:00.000Z')
    const authority = new LocalLeaseAuthority({ now: () => now })
    await authority.acquire({
      runId: 'RUN-TENTATIVE', resourceKey: 'order:tentative', resourceFingerprint: fingerprint,
      exclusive: true, ttlMs: 1_000,
    })
    const active = await authority.acquire({
      runId: 'RUN-ACTIVE', resourceKey: 'order:active', resourceFingerprint: fingerprint,
      exclusive: true, ttlMs: 1_000,
    })
    await authority.activate(active.leaseId)
    now = new Date('2026-07-11T10:00:02.000Z')

    await expect(authority.acquire({
      runId: 'RUN-REUSE', resourceKey: 'order:tentative', resourceFingerprint: fingerprint,
      exclusive: true, ttlMs: 1_000,
    })).resolves.toMatchObject({ status: 'tentative' })
    await expect(authority.acquire({
      runId: 'RUN-BLOCKED', resourceKey: 'order:active', resourceFingerprint: fingerprint,
      exclusive: true, ttlMs: 1_000,
    })).rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })
    await expect(authority.acquireBound({
      leaseId: active.leaseId, runId: 'RUN-ACTIVE', resourceKey: 'order:active',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 1_000,
    })).rejects.toMatchObject({ code: 'E2E_LEASE_BINDING_MISMATCH' })
  })

  test('持久 Authority 在拒绝过期 active lease 后仍提交隔离状态', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-persistent-expired-lease-'))
    let now = new Date('2026-07-11T10:00:00.000Z')
    const statePath = join(directory, 'lease.sqlite')
    const request = { leaseId: 'LEASE-EXPIRED', runId: 'RUN-1', resourceKey: 'order:expired',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 1_000 }
    try {
      const first = await LocalLeaseAuthority.open({
        now: () => now, statePath, testWorkspaceRoots: [process.cwd()],
      })
      const active = await first.acquireBound(request)
      now = new Date('2026-07-11T10:00:02.000Z')
      await expect(first.requireActiveBoundBatch([{ ...request, fencingToken: active.fencingToken }]))
        .rejects.toMatchObject({ code: 'E2E_LEASE_BINDING_MISMATCH' })
      first.close()

      const reopened = await LocalLeaseAuthority.open({
        now: () => now, statePath, testWorkspaceRoots: [process.cwd()],
      })
      await expect(reopened.getLeaseForTarget(active.leaseId, active.fencingToken, fingerprint))
        .resolves.toMatchObject({ status: 'quarantined' })
      await expect(reopened.acquireBoundBatch([{ ...request, leaseId: 'LEASE-REBOUND', runId: 'RUN-2' }]))
        .rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })
      reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('持久批量预留冲突时不会回滚过期 active lease 的隔离状态', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-persistent-batch-expiry-'))
    let now = new Date('2026-07-11T10:00:00.000Z')
    const statePath = join(directory, 'lease.sqlite')
    const expired = { leaseId: 'LEASE-BATCH-EXPIRED', runId: 'RUN-1', resourceKey: 'order:batch-expired',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 1_000 }
    try {
      const first = await LocalLeaseAuthority.open({
        now: () => now, statePath, testWorkspaceRoots: [process.cwd()],
      })
      const active = await first.acquireBound(expired)
      now = new Date('2026-07-11T10:00:02.000Z')
      await expect(first.acquireBoundBatch([
        { leaseId: 'LEASE-BATCH-FRESH', runId: 'RUN-2', resourceKey: 'order:fresh',
          resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 },
        { ...expired, leaseId: 'LEASE-BATCH-CONFLICT', runId: 'RUN-2', ttlMs: 60_000 },
      ])).rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })
      first.close()

      const reopened = await LocalLeaseAuthority.open({
        now: () => now, statePath, testWorkspaceRoots: [process.cwd()],
      })
      await expect(reopened.getLeaseForTarget(active.leaseId, active.fencingToken, fingerprint))
        .resolves.toMatchObject({ status: 'quarantined' })
      await expect(reopened.acquireBound({ leaseId: 'LEASE-FRESH-CHECK', runId: 'RUN-3',
        resourceKey: 'order:fresh', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 }))
        .resolves.toMatchObject({ status: 'active' })
      reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('quarantines unknown cleanup and releases only after verified cleanup', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const first = await authority.acquire({
      runId: 'RUN-1', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })
    await authority.quarantine(first.leaseId, 'cleanup unknown')
    await expect(authority.acquire({
      runId: 'RUN-2', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })

    const secondAuthority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const second = await secondAuthority.acquire({
      runId: 'RUN-1', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })
    const active = await secondAuthority.activate(second.leaseId)
    await secondAuthority.release(active.leaseId, digestText('cleanup/v1', 'verified'))
    await expect(secondAuthority.acquire({
      runId: 'RUN-2', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })).resolves.toMatchObject({ status: 'tentative' })
  })

  test('维护操作严格绑定 fencing/target，并对完全相同的终态重试返回稳定回执', async () => {
    const authority = new LocalLeaseAuthority({ now: () => new Date('2026-07-11T10:00:00.000Z') })
    const tentative = await authority.acquire({
      runId: 'RUN-1', resourceKey: 'order:100', resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000,
    })
    const active = await authority.activate(tentative.leaseId)
    const cleanupDigest = digestText('cleanup/v1', 'verified')

    await expect(authority.releaseForTarget({ leaseId: active.leaseId, fencingToken: active.fencingToken,
      targetFingerprint: digestText('resource/v1', 'wrong'), cleanupDigest }))
      .rejects.toMatchObject({ code: 'E2E_LEASE_BINDING_MISMATCH' })
    const first = await authority.releaseForTarget({ leaseId: active.leaseId, fencingToken: active.fencingToken,
      targetFingerprint: fingerprint, cleanupDigest })
    const retry = await authority.releaseForTarget({ leaseId: active.leaseId, fencingToken: active.fencingToken,
      targetFingerprint: fingerprint, cleanupDigest })
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(retry).toBe(first)
    await expect(authority.releaseForTarget({ leaseId: active.leaseId, fencingToken: active.fencingToken,
      targetFingerprint: fingerprint, cleanupDigest: digestText('cleanup/v1', 'different') }))
      .rejects.toMatchObject({ code: 'E2E_LEASE_TERMINAL_MISMATCH' })
    await expect(authority.getLeaseForTarget(active.leaseId, active.fencingToken, fingerprint))
      .resolves.toMatchObject({ status: 'released', cleanupDigest })
  })
})
