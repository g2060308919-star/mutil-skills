import { describe, expect, test } from 'vitest'
import { LocalApprovalAuthority } from '../src/index.js'

describe('LocalApprovalAuthority privacy unlock grants', () => {
  test('signs an exact run/key scope with a short TTL and rejects tampering', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issuePrivacyUnlockGrant({
      runId: 'RUN-1', quarantineKeyId: 'run-key:1',
      approver: { subject: 'privacy:alice', roles: ['privacy-approver'] }, ttlMs: 5 * 60_000,
    })

    expect(authority.verifyPrivacyUnlockGrant(grant)).toBe(true)
    expect(authority.verifyPrivacyUnlockGrant({ ...grant, runId: 'RUN-2' })).toBe(false)
  })

  test('rejects the wrong role and TTL above fifteen minutes', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    await expect(authority.issuePrivacyUnlockGrant({
      runId: 'RUN-1', quarantineKeyId: 'run-key:1',
      approver: { subject: 'qa:bob', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_PRIVACY_APPROVER_ROLE_REQUIRED' })
    await expect(authority.issuePrivacyUnlockGrant({
      runId: 'RUN-1', quarantineKeyId: 'run-key:1',
      approver: { subject: 'privacy:alice', roles: ['privacy-approver'] }, ttlMs: 15 * 60_000 + 1,
    })).rejects.toMatchObject({ code: 'E2E_PRIVACY_UNLOCK_TTL_INVALID' })
  })

  test('rejects a validly signed grant before its issuedAt time', async () => {
    let now = new Date('2026-07-11T10:00:00.000Z')
    const authority = LocalApprovalAuthority.create({ issuer: 'local-authority', keyId: 'local-key-1', now: () => now })
    const grant = await authority.issuePrivacyUnlockGrant({
      runId: 'RUN-1', quarantineKeyId: 'run-key:1',
      approver: { subject: 'privacy:alice', roles: ['privacy-approver'] }, ttlMs: 60_000,
    })
    now = new Date('2026-07-11T09:59:59.999Z')

    expect(authority.verifyPrivacyUnlockGrant(grant)).toBe(false)
  })
})
