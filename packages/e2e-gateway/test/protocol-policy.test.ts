import { describe, expect, test, vi } from 'vitest'
import {
  digestText,
  type CapabilityReservation,
  type GatewayDecision,
  type SignedSseReadGrant,
  type SignedWebSocketReadGrant,
} from '@mutil-skills/e2e-contracts'
import { ProtocolGuard, canonicalizeHttpRequest } from '../src/index.js'

function websocketGrant(): SignedWebSocketReadGrant {
  const digest = digestText('test/v1', 'websocket')
  return {
    grantId: 'GRANT-WS-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: digest, executionDigest: digest,
      environment: 'test', baseOrigin: 'https://test.example.com',
      actions: [{
        actionId: 'ACTION-WS-READ', origin: 'wss://stream.example.com', path: '/events/orders',
        maxInboundMessages: 2, maxBytes: 10,
      }],
    },
    subjectDigest: digest, issuedAt: '2026-07-11T10:00:00.000Z', expiresAt: '2026-07-11T10:10:00.000Z',
    capabilities: [{
      capabilityId: 'CAP-WS-1', nonce: 'nonce', transport: 'websocket', effect: 'read',
      actionId: 'ACTION-WS-READ', origin: 'wss://stream.example.com', path: '/events/orders',
      maxInboundMessages: 2, maxBytes: 10, maxUses: 1,
    }],
    revocationSequence: 0, signature: 'signature',
  }
}

function sseGrant(): SignedSseReadGrant {
  const digest = digestText('test/v1', 'sse')
  return {
    grantId: 'GRANT-SSE-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: digest, executionDigest: digest,
      environment: 'test', baseOrigin: 'https://test.example.com', actions: [],
    },
    subjectDigest: digest, issuedAt: '2026-07-11T10:00:00.000Z', expiresAt: '2026-07-11T10:10:00.000Z',
    capabilities: [{
      capabilityId: 'INTENT-SSE', nonce: 'nonce', transport: 'sse', effect: 'read',
      actionId: 'ACTION-SSE', origin: 'https://stream.example.com', exactPath: '/events',
      query: [], maxReconnects: 2, maxUses: 2,
    }],
    revocationSequence: 0, signature: 'signature',
  }
}

function dependencies() {
  const downstream = {
    decide: vi.fn(async (raw): Promise<GatewayDecision> => raw.url.includes('approved.example.com')
      ? { decision: 'forward', intentId: 'INTENT-HTTP', request: canonicalizeHttpRequest(raw) }
      : { decision: 'block', code: 'E2E_GATEWAY_INTENT_NOT_FOUND', reason: 'not approved' }),
  }
  const reservation: CapabilityReservation = {
    reservationId: 'RES-WS-1', grantId: 'GRANT-WS-1', capabilityId: 'CAP-WS-1',
    actionId: 'ACTION-WS-READ', attemptId: 'ATTEMPT-1:CONNECTION-1', status: 'reserved',
    reservedAt: '2026-07-11T10:00:00.000Z',
  }
  const authority = {
    verify: vi.fn(async () => ({ allowed: true as const })),
    reserveForSubject: vi.fn(async () => reservation),
    complete: vi.fn(async () => undefined),
  }
  return { downstream, authority }
}

function guard() {
  const deps = dependencies()
  return {
    deps,
    guard: new ProtocolGuard({
      downstream: deps.downstream,
      sse: { grant: sseGrant(), capabilityId: 'INTENT-SSE', authority: deps.authority },
      allowedIframeOrigins: ['https://frame.example.com'],
      websocket: { grant: websocketGrant(), capabilityId: 'CAP-WS-1', authority: deps.authority },
    }),
  }
}

describe('ProtocolGuard', () => {
  test.each([
    'service-worker', 'webrtc', 'quic', 'udp', 'ftp', 'file', 'custom-scheme', 'download', 'unknown',
  ] as const)('permanently blocks the %s escape channel before downstream access', async (channel) => {
    const { guard: protocolGuard, deps } = guard()
    await expect(protocolGuard.decide({ channel, correlationId: 'CORR-1', url: 'https://approved.example.com/data' }))
      .resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_PROTOCOL_FORBIDDEN' })
    expect(deps.downstream.decide).not.toHaveBeenCalled()
  })

  test('delegates HTTP and Beacon to the normal signed policy and isolates iframe origins', async () => {
    const { guard: protocolGuard, deps } = guard()
    await expect(protocolGuard.decide({
      channel: 'http', correlationId: 'CORR-HTTP', method: 'GET', url: 'https://approved.example.com/data',
    })).resolves.toMatchObject({ decision: 'forward' })
    await expect(protocolGuard.decide({
      channel: 'beacon', correlationId: 'CORR-BEACON', method: 'POST', url: 'https://evil.example.com/collect',
      body: Buffer.from('x'), contentType: 'text/plain',
    })).resolves.toMatchObject({ decision: 'block' })
    await expect(protocolGuard.decide({
      channel: 'iframe', correlationId: 'CORR-FRAME', method: 'GET', url: 'https://evil.example.com/frame',
    })).resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_IFRAME_ORIGIN_DENIED' })
    expect(deps.downstream.decide).toHaveBeenCalledTimes(2)
  })

  test('allows only a signed SSE read intent and counts every reconnect', async () => {
    const { guard: protocolGuard } = guard()
    const request = { channel: 'sse' as const, correlationId: 'CORR-SSE', method: 'GET', url: 'https://stream.example.com/events' }

    await expect(protocolGuard.decide(request)).resolves.toMatchObject({ decision: 'forward', intentId: 'INTENT-SSE' })
    await expect(protocolGuard.decide(request)).resolves.toMatchObject({ decision: 'forward', intentId: 'INTENT-SSE' })
    await expect(protocolGuard.decide(request)).resolves.toMatchObject({
      decision: 'block', code: 'E2E_GATEWAY_MAX_REQUESTS_EXCEEDED',
    })
    await expect(protocolGuard.decide({ ...request, method: 'POST' })).resolves.toMatchObject({ decision: 'block' })
  })

  test('accepts one exact read-only WebSocket, rejects client frames, and enforces inbound message and byte limits', async () => {
    const { guard: protocolGuard, deps } = guard()
    await expect(protocolGuard.decide({
      channel: 'websocket-handshake', correlationId: 'CORR-WS', connectionId: 'CONNECTION-1',
      url: 'wss://stream.example.com/events/orders',
    })).resolves.toMatchObject({ decision: 'accept-websocket', capabilityId: 'CAP-WS-1' })
    await expect(protocolGuard.decide({
      channel: 'websocket-client-frame', correlationId: 'CORR-WS', connectionId: 'CONNECTION-1', byteLength: 1,
    })).resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_WEBSOCKET_CLIENT_FRAME_DENIED' })
    await expect(protocolGuard.decide({
      channel: 'websocket-inbound-frame', correlationId: 'CORR-WS', connectionId: 'CONNECTION-1', byteLength: 4,
    })).resolves.toMatchObject({ decision: 'accept-frame' })
    await expect(protocolGuard.decide({
      channel: 'websocket-inbound-frame', correlationId: 'CORR-WS', connectionId: 'CONNECTION-1', byteLength: 6,
    })).resolves.toMatchObject({ decision: 'accept-frame' })
    await expect(protocolGuard.decide({
      channel: 'websocket-inbound-frame', correlationId: 'CORR-WS', connectionId: 'CONNECTION-1', byteLength: 1,
    })).resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_WEBSOCKET_LIMIT_EXCEEDED' })
    await protocolGuard.closeWebSocket('CONNECTION-1')

    expect(deps.authority.reserveForSubject).toHaveBeenCalledTimes(1)
    expect(deps.authority.complete).toHaveBeenCalledTimes(1)
  })

  test('rejects an unsigned WebSocket target and duplicate connection identifiers', async () => {
    const { guard: protocolGuard } = guard()
    await expect(protocolGuard.decide({
      channel: 'websocket-handshake', correlationId: 'CORR-BAD', connectionId: 'CONNECTION-BAD',
      url: 'wss://stream.example.com/events/admin',
    })).resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_WEBSOCKET_TARGET_DENIED' })
    const exact = {
      channel: 'websocket-handshake' as const, correlationId: 'CORR-WS', connectionId: 'CONNECTION-1',
      url: 'wss://stream.example.com/events/orders',
    }
    await protocolGuard.decide(exact)
    await expect(protocolGuard.decide(exact)).resolves.toMatchObject({
      decision: 'block', code: 'E2E_GATEWAY_WEBSOCKET_CONNECTION_EXISTS',
    })
  })
})
