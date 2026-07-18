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

  test('可按稳定 attempt 严格查询 reservation，并仅接受完全相同的终态幂等重试', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueWebSocketReadGrant({ subject: subject(),
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000 })
    const capability = grant.capabilities[0]!
    const reservation = await authority.reserveForSubject({ grant, currentSubject: grant.subject,
      capabilityId: capability.capabilityId, actionId: capability.actionId, attemptId: 'ATTEMPT-WS-1' })
    expect(authority.findReservation({ attemptId: 'ATTEMPT-WS-1', grantId: grant.grantId,
      capabilityId: capability.capabilityId, actionId: capability.actionId }))
      .toMatchObject({ reservationId: reservation.reservationId, status: 'reserved' })
    const outcome = digestText('outcome/v1', 'success')
    const receipt = await authority.complete(reservation.reservationId, outcome)
    expect(receipt).toMatch(/^sha256:[a-f0-9]{64}$/)
    await expect(authority.complete(reservation.reservationId, outcome)).resolves.toBe(receipt)
    await expect(authority.complete(reservation.reservationId, digestText('outcome/v1', 'different')))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_RESERVATION_FINAL' })

    const secondGrant = await authority.issueWebSocketReadGrant({ subject: subject(),
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000 })
    const secondCapability = secondGrant.capabilities[0]!
    const unknownReservation = await authority.reserveForSubject({ grant: secondGrant,
      currentSubject: secondGrant.subject, capabilityId: secondCapability.capabilityId,
      actionId: secondCapability.actionId, attemptId: 'ATTEMPT-WS-2' })
    const unknownReceipt = await authority.markUnknown(unknownReservation.reservationId, 'connection lost')
    await expect(authority.markUnknown(unknownReservation.reservationId, 'connection lost'))
      .resolves.toBe(unknownReceipt)
    await expect(authority.markUnknown(unknownReservation.reservationId, 'different observation'))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_RESERVATION_FINAL' })
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
