import { describe, expect, test } from 'vitest'
import { digestText, type SseReadApprovalSubject } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from './approval-authority.fixture.js'

const digest = digestText('test/v1', 'sse-read')

function subject(): SseReadApprovalSubject {
  return {
    schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision: digest, executionDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com',
    actions: [{
      actionId: 'ACTION-SSE-READ', origin: 'https://stream.example.com', exactPath: '/events/orders',
      query: [['actor', 'reviewer']], maxReconnects: 2,
    }],
  }
}

describe('LocalApprovalAuthority SSE read grants', () => {
  test('signs exact origin, path, query order, and reconnect limit', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueSseReadGrant({
      subject: subject(), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(await authority.verify(grant)).toMatchObject({ allowed: true })
    expect(await authority.verify({
      ...grant,
      capabilities: [{ ...grant.capabilities[0]!, maxReconnects: 3 }],
    })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SIGNATURE_INVALID' })
  })

  test.each([
    { origin: 'wss://stream.example.com' },
    { exactPath: '/events/**' },
    { exactPath: '/events?admin=true' },
    { maxReconnects: 0 },
  ])('rejects an unsafe SSE scope', async (change) => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const invalid = subject()
    invalid.actions[0] = { ...invalid.actions[0]!, ...change }
    await expect(authority.issueSseReadGrant({
      subject: invalid, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SSE_SCOPE_INVALID', retryable: false })
  })
})
