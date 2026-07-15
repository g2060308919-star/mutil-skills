import { describe, expect, test } from 'vitest'
import { digestText, type WebSocketReadApprovalSubject } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from './approval-authority.fixture.js'

const digest = digestText('test/v1', 'websocket-read')

function subject(): WebSocketReadApprovalSubject {
  return {
    schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision: digest, executionDigest: digest,
    environment: 'test', baseOrigin: 'https://test.example.com',
    actions: [{
      actionId: 'ACTION-WS-READ', origin: 'wss://stream.example.com', path: '/events/orders',
      maxInboundMessages: 10, maxBytes: 65_536,
    }],
  }
}

describe('LocalApprovalAuthority WebSocket read grants', () => {
  test('signs exact origin, path, message count, and byte limits', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueWebSocketReadGrant({
      subject: subject(), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(await authority.verify(grant)).toMatchObject({ allowed: true })
    expect(await authority.verify({
      ...grant,
      capabilities: [{ ...grant.capabilities[0]!, maxBytes: 65_537 }],
    })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SIGNATURE_INVALID' })
  })

  test.each([
    { origin: 'https://stream.example.com' },
    { path: '/events/**' },
    { path: '/events/orders?role=admin' },
    { maxInboundMessages: 0 },
    { maxBytes: 0 },
  ])('rejects unsafe or unbounded WebSocket read scope: $origin$path', async (change) => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const invalid = subject()
    invalid.actions[0] = { ...invalid.actions[0]!, ...change }

    await expect(authority.issueWebSocketReadGrant({
      subject: invalid, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_WEBSOCKET_SCOPE_INVALID', retryable: false })
  })
})
