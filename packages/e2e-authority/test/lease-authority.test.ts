import { describe, expect, test } from 'vitest'
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
})
