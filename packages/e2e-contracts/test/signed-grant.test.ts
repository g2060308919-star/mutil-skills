import { expect, test } from 'vitest'
import {
  SignedGrantSchema,
  canonicalGrantApprovalSubjectDigest,
  digestInjectionResponseBody,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const discoverySubject = {
  schemaVersion: '1.1.0', assetId: 'ASSET-1', prdRevision: digest('3'), scopeDigest: digest('4'),
  environment: 'test', baseOrigin: 'https://test.example.com', actor: 'operator',
  expectedPageIdentity: {
    url: 'https://test.example.com/orders', title: 'Orders', heading: 'Orders', ariaSignals: [],
  },
  bootstrapIntentsDigest: digest('5'), requests: [],
  actions: [{ actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1, requestIds: [] }],
}
const subjectDigest = canonicalGrantApprovalSubjectDigest(discoverySubject)

const grant = {
  grantId: 'GRANT-1', issuer: 'authority', keyId: 'key-1', proofScope: 'local-os-user',
  approver: { subject: 'local:user', roles: ['e2e-approver'] },
  approvalContext: {
    schemaVersion: '1.0.0', subject: 'local:user', runId: 'RUN-1', approvalType: 'discovery',
    subjectDigest, installationDigest: digest('2'), origin: 'http://localhost:43210',
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:05:00.000Z',
  },
  subject: discoverySubject,
  subjectDigest, issuedAt: '2026-07-17T00:00:00.000Z',
  expiresAt: '2026-07-17T00:01:00.000Z',
  capabilities: [{
    capabilityId: 'CAP-1', nonce: 'a'.repeat(64), transport: 'browser-local', effect: 'read',
    actionId: 'ACTION-1', operation: 'dom-read', targetUrl: 'https://test.example.com/orders',
    actor: 'operator', expectedPageIdentityDigest: digest('6'), bootstrapIntentsDigest: digest('5'), maxUses: 1,
  }],
  revocationSequence: 0, signature: 's'.repeat(86),
}

test('SignedGrantSchema accepts one complete discriminator and rejects extra or malformed IPC fields', () => {
  expect(SignedGrantSchema.parse(grant)).toEqual(grant)
  expect(() => SignedGrantSchema.parse({ ...grant, injected: true })).toThrow()
  expect(() => SignedGrantSchema.parse({ ...grant, capabilities: [{ ...grant.capabilities[0], maxUses: 0 }] }))
    .toThrow()
  expect(() => SignedGrantSchema.parse({ ...grant, capabilities: [{ ...grant.capabilities[0], maxUses: 2 }] }))
    .toThrow()
})

test('SignedGrantSchema enforces production injection and streaming bounds', () => {
  const body = 'temporary failure'
  const subject = {
    schemaVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: digest('3'), executionDigest: digest('4'),
    environment: 'test', baseOrigin: 'https://test.example.com', actions: [{
      actionId: 'ACTION-1', caseId: 'CASE-1', runId: 'RUN-1', attemptSlot: 1,
      request: {
        intentId: 'INTENT-1', method: 'GET', canonicalOrigin: 'https://test.example.com',
        exactPath: '/orders', query: [], payload: { kind: 'no-body' },
        targetFingerprint: 'not-applicable', maxRequests: 1, expectedOrder: 1,
      },
      response: {
        kind: 'http-response', status: 503,
        headers: [{ name: 'retry-after', value: '1' }],
        body: { kind: 'utf8', value: body, digest: digestInjectionResponseBody(body) }, delayMs: 30_000,
      },
      expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden',
    }],
  } as const
  const injectionDigest = canonicalGrantApprovalSubjectDigest(subject)
  const injectionGrant = {
    ...grant,
    approvalContext: { ...grant.approvalContext, approvalType: 'execution', subjectDigest: injectionDigest },
    subject, subjectDigest: injectionDigest,
    capabilities: [{
      capabilityId: 'CAP-1', nonce: 'a'.repeat(64), transport: 'gateway-injection',
      actionId: 'ACTION-1', caseId: 'CASE-1', runId: 'RUN-1', attemptSlot: 1,
      request: subject.actions[0].request, response: subject.actions[0].response,
      expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden', maxUses: 1,
    }],
  }
  expect(SignedGrantSchema.safeParse(injectionGrant).success).toBe(true)
  expect(SignedGrantSchema.safeParse({
    ...injectionGrant,
    capabilities: [{ ...injectionGrant.capabilities[0], response: {
      ...injectionGrant.capabilities[0].response, status: 99,
    } }],
  }).success).toBe(false)
  expect(SignedGrantSchema.safeParse({
    ...injectionGrant,
    capabilities: [{ ...injectionGrant.capabilities[0], response: {
      ...injectionGrant.capabilities[0].response,
      headers: [{ name: 'set-cookie', value: 'unsafe' }],
    } }],
  }).success).toBe(false)
  expect(SignedGrantSchema.safeParse({
    ...injectionGrant,
    capabilities: [{ ...injectionGrant.capabilities[0], response: {
      ...injectionGrant.capabilities[0].response,
      body: { ...injectionGrant.capabilities[0].response.body, digest: digest('f') },
    } }],
  }).success).toBe(false)

  const webSocketSubject = {
    schemaVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: digest('3'), executionDigest: digest('4'),
    environment: 'test', baseOrigin: 'https://test.example.com', actions: [{
      actionId: 'ACTION-WS', origin: 'https://test.example.com', path: '/events',
      maxInboundMessages: 1_000, maxBytes: 10 * 1024 * 1024,
    }],
  } as const
  const webSocketDigest = canonicalGrantApprovalSubjectDigest(webSocketSubject)
  const webSocketGrant = {
    ...grant,
    approvalContext: { ...grant.approvalContext, approvalType: 'execution', subjectDigest: webSocketDigest },
    subject: webSocketSubject, subjectDigest: webSocketDigest,
    capabilities: [{
      capabilityId: 'CAP-WS', nonce: 'b'.repeat(64), transport: 'websocket', effect: 'read',
      actionId: 'ACTION-WS', origin: 'https://test.example.com', path: '/events',
      maxInboundMessages: 1_000, maxBytes: 10 * 1024 * 1024, maxUses: 1,
    }],
  }
  expect(SignedGrantSchema.safeParse(webSocketGrant).success).toBe(true)
  expect(SignedGrantSchema.safeParse({
    ...webSocketGrant,
    capabilities: [{ ...webSocketGrant.capabilities[0], maxBytes: 10 * 1024 * 1024 + 1 }],
  }).success).toBe(false)

  const sseSubject = {
    schemaVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: digest('3'), executionDigest: digest('4'),
    environment: 'test', baseOrigin: 'https://test.example.com', actions: [{
      actionId: 'ACTION-SSE', origin: 'https://test.example.com', exactPath: '/events',
      query: [], maxReconnects: 100,
    }],
  } as const
  const sseDigest = canonicalGrantApprovalSubjectDigest(sseSubject)
  const sseGrant = {
    ...grant,
    approvalContext: { ...grant.approvalContext, approvalType: 'execution', subjectDigest: sseDigest },
    subject: sseSubject, subjectDigest: sseDigest,
    capabilities: [{
      capabilityId: 'CAP-SSE', nonce: 'c'.repeat(64), transport: 'sse', effect: 'read',
      actionId: 'ACTION-SSE', origin: 'https://test.example.com', exactPath: '/events', query: [],
      maxReconnects: 100, maxUses: 100,
    }],
  }
  expect(SignedGrantSchema.safeParse(sseGrant).success).toBe(true)
  expect(SignedGrantSchema.safeParse({
    ...sseGrant,
    capabilities: [{ ...sseGrant.capabilities[0], maxReconnects: 101 }],
  }).success).toBe(false)
})
