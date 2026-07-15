import { describe, expect, test, vi } from 'vitest'
import {
  ArtifactSchemaRegistry,
  canonicalizeJson,
  digestInjectionResponseBody,
  digestText,
  type CanonicalInjectionResponse,
  type CapabilityReservation,
  type SignedInjectionGrant,
} from '@mutil-skills/e2e-contracts'
import {
  InjectionGateway,
  LocalGatewayAuditVerifier,
  LocalGatewayAuditSigner,
  ReadOnlyGateway,
  digestJsonHttpPayload,
  evaluateInjectionSafety,
  verifyGatewayPublicationAudit,
} from '../src/index.js'

const payload = { query: 'order-100' }
const payloadDigest = digestJsonHttpPayload(payload)
const baseResponse: CanonicalInjectionResponse = {
  kind: 'http-response', status: 500, headers: [{ name: 'content-type', value: 'application/json' }],
  body: { kind: 'utf8', value: '{"error":"upstream"}', digest: digestInjectionResponseBody('{"error":"upstream"}') },
  delayMs: 0,
}

function grant(response: CanonicalInjectionResponse = baseResponse): SignedInjectionGrant {
  const capability = {
    capabilityId: 'CAP-INJECT-1', nonce: 'nonce', transport: 'gateway-injection' as const,
    actionId: 'ACTION-INJECT', caseId: 'CASE-INJECT', runId: 'RUN-1', attemptSlot: 1,
    request: {
      intentId: 'INTENT-INJECT', method: 'POST', canonicalOrigin: 'https://test.example.com',
      exactPath: '/api/orders/search', query: [['mode', 'full']] as Array<[string, string]>,
      payload: { kind: 'json' as const, digest: payloadDigest }, targetFingerprint: 'not-applicable',
      maxRequests: 1, expectedOrder: 1,
    },
    response, expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden' as const, maxUses: 1,
  }
  return {
    grantId: 'GRANT-INJECT-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
    approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
    subject: {
      schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: digestText('test/v1', 'prd'),
      executionDigest: digestText('test/v1', 'execution'), environment: 'test',
      baseOrigin: 'https://test.example.com', actions: [],
    },
    subjectDigest: digestText('test/v1', 'subject'), issuedAt: '2026-07-11T10:00:00.000Z',
    expiresAt: '2026-07-11T10:10:00.000Z', capabilities: [capability], revocationSequence: 0,
    signature: 'signature',
  }
}

function authority() {
  let reservation = 0
  return {
    verify: vi.fn(async () => ({ allowed: true as const })),
    reserveForSubject: vi.fn(async (input): Promise<CapabilityReservation> => ({
      reservationId: `RES-${++reservation}`, grantId: input.grant.grantId, capabilityId: input.capabilityId,
      actionId: input.actionId, attemptId: input.attemptId, status: 'reserved', reservedAt: '2026-07-11T10:00:00.000Z',
    })),
    complete: vi.fn(async () => undefined),
    markUnknown: vi.fn(async () => undefined),
  }
}

function gateway(response: CanonicalInjectionResponse = baseResponse) {
  return new InjectionGateway({
    stage: 'bootstrap', grant: grant(response), attemptId: 'ATTEMPT-1', authority: authority(),
    bootstrapIntents: [{
      intentId: 'INTENT-DOCUMENT', actionId: 'ACTION-BOOTSTRAP', stage: 'bootstrap', methods: ['GET'], origin: 'https://test.example.com',
      exactPath: '/orders', query: [], maxRequests: 1,
    }],
    caseReadIntents: [],
  })
}

describe('Gateway publication audit', () => {
  test('publishes schema-valid content that a rebuilt public-key verifier accepts', () => {
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    })
    expect('signDigest' in signer).toBe(false)
    const recorder = signer.createRecorder(digestText('test/v1', 'gateway-policy'))
    const readGateway = new ReadOnlyGateway({
      stage: 'case', recorder, intents: [{
        intentId: 'INTENT-READ', actionId: 'ACTION-READ', stage: 'case', methods: ['GET'],
        origin: 'https://test.example.com', exactPath: '/orders', query: [], maxRequests: 1,
      }],
    })

    expect(readGateway.decide(
      { method: 'GET', url: 'https://test.example.com/orders' }, 'ACTION-READ',
    )).toMatchObject({ decision: 'forward' })
    expect(readGateway.decide(
      { method: 'GET', url: 'https://test.example.com/not-approved' }, 'ACTION-READ',
    )).toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_INTENT_NOT_FOUND' })
    recorder.recordCapabilityReservation({
      reservation: {
        reservationId: 'RES-1', grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-INJECT',
        attemptId: 'ATTEMPT-1', status: 'completed', reservedAt: '2026-07-11T10:00:00.000Z',
        outcomeDigest: digestText('test/v1', 'outcome'),
      },
      consumed: true,
    })

    const audit = recorder.finalize()
    const verifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
    expect(audit).toMatchObject({
      gatewayInstance: { instanceId: 'GATEWAY-1', version: '1.0.0' },
      signedCounters: { forwarded: 1, blocked: 1, injected: 0 },
      requestEvents: [
        { sequence: 0, actionId: 'ACTION-READ', decision: 'forwarded' },
        { sequence: 1, actionId: 'ACTION-READ', decision: 'blocked' },
      ],
      capabilityReservations: [{ capabilityId: 'CAP-1', actionId: 'ACTION-INJECT', consumed: true }],
    })
    expect(audit.requestEvents[0]!.digest).toBe(digestText(
      'gateway-canonical-request/v1', canonicalizeJson({
        method: 'GET', origin: 'https://test.example.com', path: '/orders', query: [],
      }),
    ))
    expect(ArtifactSchemaRegistry['gateway-audit'].shape.content.parse(audit)).toEqual(audit)
    expect(verifyGatewayPublicationAudit(audit, verifier)).toBe(true)

    const replacement = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    }).exportVerifierMaterial()
    expect(verifyGatewayPublicationAudit(audit, LocalGatewayAuditVerifier.create({
      ...signer.exportVerifierMaterial(), publicKeySpki: replacement.publicKeySpki,
    }))).toBe(false)
  })

  test('rejects deleted, duplicated, or mutated publication data and seals after finalize', () => {
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    })
    const recorder = signer.createRecorder(digestText('test/v1', 'gateway-policy'))
    const readGateway = new ReadOnlyGateway({ stage: 'case', recorder, intents: [{
      intentId: 'INTENT-READ', actionId: 'ACTION-BLOCKED', stage: 'case', methods: ['GET'],
      origin: 'https://test.example.com', exactPath: '/approved', query: [], maxRequests: 1,
    }] })
    readGateway.decide({ method: 'GET', url: 'https://test.example.com/blocked' }, 'ACTION-BLOCKED')
    recorder.recordCapabilityReservation({ reservation: {
      reservationId: 'RES-1', grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-1',
      attemptId: 'ATTEMPT-1', status: 'reserved', reservedAt: '2026-07-11T10:00:00.000Z',
    }, consumed: false })
    const audit = recorder.finalize()
    const verifier = LocalGatewayAuditVerifier.create(signer.exportVerifierMaterial())

    const variants = [
      { ...audit, signedCounters: { ...audit.signedCounters, blocked: 2 } },
      { ...audit, requestEvents: [{ ...audit.requestEvents[0]!, actionId: 'ACTION-TAMPERED' }] },
      { ...audit, requestEvents: [] },
      { ...audit, requestEvents: [audit.requestEvents[0]!, audit.requestEvents[0]!] },
      { ...audit, capabilityReservations: [{ ...audit.capabilityReservations[0]!, consumed: true }] },
      { ...audit, capabilityReservations: [
        audit.capabilityReservations[0]!, audit.capabilityReservations[0]!,
      ] },
      { ...audit, signedCounters: { ...audit.signedCounters, signature: {
        ...audit.signedCounters.signature, signature: 'tampered',
      } } },
    ]
    for (const candidate of variants) expect(verifyGatewayPublicationAudit(candidate, verifier)).toBe(false)
    expect(() => recorder.recordCapabilityReservation({
      reservation: {
        reservationId: 'RES-2', grantId: 'GRANT-1', capabilityId: 'CAP-2', actionId: 'ACTION-2',
        attemptId: 'ATTEMPT-2', status: 'completed', reservedAt: '2026-07-11T10:00:00.000Z',
      },
      consumed: true,
    })).toThrowError(/finalized/i)
    expect(() => recorder.finalize()).toThrowError(/finalized/i)
    expect(() => readGateway.decide(
      { method: 'GET', url: 'https://test.example.com/late' }, 'ACTION-BLOCKED',
    )).toThrowError(/finalized/i)
  })

  test('snapshots getter-backed request and reservation inputs exactly once', () => {
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    })
    const recorder = signer.createRecorder(digestText('test/v1', 'gateway-policy'))
    const readGateway = new ReadOnlyGateway({ stage: 'case', recorder, intents: [{
      intentId: 'INTENT-READ', actionId: 'ACTION-READ', stage: 'case', methods: ['GET'],
      origin: 'https://test.example.com', exactPath: '/orders', query: [], maxRequests: 1,
    }] })
    let urlRead = 0
    expect(readGateway.decide({
      method: 'GET',
      get url() { return ++urlRead === 1 ? 'https://test.example.com/orders' : 'https://evil.example.com/' },
    }, 'ACTION-READ')).toMatchObject({ decision: 'forward' })
    let proxyUrlRead = 0
    expect(readGateway.decide(new Proxy({ method: 'GET', url: '' }, {
      get(target, property, receiver) {
        if (property === 'url') {
          proxyUrlRead += 1
          return 'https://test.example.com/%ZZ'
        }
        return Reflect.get(target, property, receiver)
      },
    }), 'ACTION-READ')).toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_URL_INVALID' })
    expect(proxyUrlRead).toBe(1)

    let capabilityRead = 0
    const reservation = {
      reservationId: 'RES-1', grantId: 'GRANT-1',
      get capabilityId() { return ++capabilityRead === 1 ? 'CAP-1' : 'CAP-TAMPERED' },
      actionId: 'ACTION-1', attemptId: 'ATTEMPT-1', status: 'reserved' as const,
      reservedAt: '2026-07-11T10:00:00.000Z',
    }
    recorder.recordCapabilityReservation({ reservation, consumed: false })
    const audit = recorder.finalize()
    expect(audit.capabilityReservations[0]!.capabilityId).toBe('CAP-1')
    expect(verifyGatewayPublicationAudit(
      audit, LocalGatewayAuditVerifier.create(signer.exportVerifierMaterial()),
    )).toBe(true)
  })

  test('validates signer, policy, uniqueness, and final artifact fields at their boundaries', () => {
    expect(() => LocalGatewayAuditSigner.create({
      issuer: '', keyId: 'key', instanceId: 'GATEWAY-1', version: '1.0.0',
    })).toThrow()
    expect(() => LocalGatewayAuditSigner.create({
      issuer: 'gateway', keyId: 'key', instanceId: 'bad instance', version: 'latest',
    })).toThrow()
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    })
    expect(() => signer.createRecorder('not-a-digest')).toThrow()

    const duplicateRecorder = signer.createRecorder(digestText('test/v1', 'policy-1'))
    const reservation = {
      reservationId: 'RES-1', grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-1',
      attemptId: 'ATTEMPT-1', status: 'reserved' as const, reservedAt: '2026-07-11T10:00:00.000Z',
    }
    duplicateRecorder.recordCapabilityReservation({ reservation, consumed: false })
    expect(() => duplicateRecorder.recordCapabilityReservation({ reservation, consumed: false })).toThrow(/unique/i)

    const invalidArtifactRecorder = signer.createRecorder(digestText('test/v1', 'policy-2'))
    invalidArtifactRecorder.recordReadDecision({
      actionId: 'invalid action id', decision: 'blocked', request: { method: 'GET', url: 'https://test.example.com/' },
    })
    expect(() => invalidArtifactRecorder.finalize()).toThrow()
  })

  test('records repeated canonical requests as distinct sequenced decisions', () => {
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    })
    const recorder = signer.createRecorder(digestText('test/v1', 'repeated-request-policy'))
    const gateway = new ReadOnlyGateway({ stage: 'case', recorder, intents: [{
      intentId: 'INTENT-READ', actionId: 'ACTION-READ', stage: 'case', methods: ['GET'],
      origin: 'https://test.example.com', exactPath: '/orders', query: [], maxRequests: 2,
    }] })
    const raw = { method: 'GET', url: 'https://test.example.com/orders' }

    expect(gateway.decide(raw, 'ACTION-READ')).toMatchObject({ decision: 'forward' })
    expect(gateway.decide(raw, 'ACTION-READ')).toMatchObject({ decision: 'forward' })
    expect(gateway.decide(raw, 'ACTION-READ')).toMatchObject({
      decision: 'block', code: 'E2E_GATEWAY_MAX_REQUESTS_EXCEEDED',
    })
    const audit = recorder.finalize()
    expect(audit.requestEvents.map(({ sequence, decision }) => ({ sequence, decision }))).toEqual([
      { sequence: 0, decision: 'forwarded' },
      { sequence: 1, decision: 'forwarded' },
      { sequence: 2, decision: 'blocked' },
    ])
    expect(new Set(audit.requestEvents.map((event) => event.digest)).size).toBe(1)
    expect(verifyGatewayPublicationAudit(
      audit, LocalGatewayAuditVerifier.create(signer.exportVerifierMaterial()),
    )).toBe(true)
  })

  test('rejects invalid capability reservation states after snapshotting', () => {
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'gateway-local', keyId: 'gateway-key-1', instanceId: 'GATEWAY-1', version: '1.0.0',
    })
    const base = {
      reservationId: 'RES-1', grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-1',
      attemptId: 'ATTEMPT-1', status: 'reserved' as const, reservedAt: '2026-07-11T10:00:00.000Z',
    }
    const invalid = [
      { ...base, reservationId: 'bad id' },
      { ...base, status: 'bogus' },
      { ...base, reservedAt: 'yesterday' },
      { ...base, status: 'completed', outcomeDigest: 'bad-digest' },
      { ...base, status: 'completed' },
      { ...base, status: 'completed', outcomeDigest: digestText('test/v1', 'outcome'), observation: 'unexpected' },
      { ...base, outcomeDigest: digestText('test/v1', 'outcome') },
      { ...base, observation: 'unexpected' },
      { ...base, status: 'unknown' },
      { ...base, status: 'unknown', observation: '', outcomeDigest: undefined },
      { ...base, status: 'unknown', observation: 'network state unknown', outcomeDigest: digestText('test/v1', 'outcome') },
    ]
    invalid.forEach((reservation, index) => {
      const recorder = signer.createRecorder(digestText('test/v1', `invalid-reservation-${index}`))
      expect(() => recorder.recordCapabilityReservation({
        reservation: reservation as CapabilityReservation,
        consumed: reservation.status === 'completed',
      })).toThrow()
    })
    const unknownRecorder = signer.createRecorder(digestText('test/v1', 'valid-unknown-reservation'))
    unknownRecorder.recordCapabilityReservation({
      reservation: { ...base, status: 'unknown', observation: 'upstream completion could not be observed' },
      consumed: false,
    })
    expect(unknownRecorder.finalize().capabilityReservations).toHaveLength(1)
  })
})

describe('InjectionGateway', () => {
  test('forwards only signed bootstrap traffic then injects an exact case request with zero upstream forwarding', async () => {
    const guard = gateway()
    await expect(guard.decide({ method: 'GET', url: 'https://test.example.com/orders' }))
      .resolves.toMatchObject({ decision: 'forward', intentId: 'INTENT-DOCUMENT' })
    guard.switchToCaseStage()
    await expect(guard.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/search?mode=full',
      contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)),
    })).resolves.toMatchObject({
      decision: 'inject', intentId: 'INTENT-INJECT', source: 'egress-gateway',
      response: { kind: 'http-response', status: 500 },
    })

    const audit = guard.getAuditSummary()
    expect(audit).toMatchObject({
      source: 'egress-gateway', received: 2, matched: 1, forwarded: 1, blocked: 0,
      bootstrapForwarded: 1, injectionTargetForwarded: 0,
    })
    expect(evaluateInjectionSafety({ audit, expectedMatches: 1 })).toEqual({ status: 'passed', reasonCodes: [] })
  })

  test.each([
    ['empty response', { kind: 'http-response', status: 503, headers: [], body: { kind: 'no-body' }, delayMs: 0 }],
    ['connection reset', { kind: 'connection-reset', status: 'not-applicable', headers: [], body: { kind: 'no-body' }, delayMs: 0 }],
    ['timeout', { kind: 'timeout', status: 'not-applicable', headers: [], body: { kind: 'no-body' }, delayMs: 5_000 }],
  ] satisfies Array<[string, CanonicalInjectionResponse]>)('emits a signed %s directive', async (_name, response) => {
    const guard = gateway(response)
    guard.switchToCaseStage()
    await expect(guard.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/search?mode=full',
      contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)),
    })).resolves.toMatchObject({ decision: 'inject', response })
  })

  test('classifies unmatched, over-limit, incomplete, and browser-route evidence as safety-blocked', async () => {
    const unmatched = gateway()
    unmatched.switchToCaseStage()
    await expect(unmatched.decide({ method: 'POST', url: 'https://test.example.com/api/other' }))
      .resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_INJECTION_INTENT_NOT_FOUND' })
    expect(evaluateInjectionSafety({ audit: unmatched.getAuditSummary(), expectedMatches: 1 }))
      .toMatchObject({ status: 'safety-blocked' })

    const exceeded = gateway()
    exceeded.switchToCaseStage()
    const exact = {
      method: 'POST', url: 'https://test.example.com/api/orders/search?mode=full',
      contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)),
    }
    await exceeded.decide(exact)
    await expect(exceeded.decide(exact)).resolves.toMatchObject({
      decision: 'block', code: 'E2E_GATEWAY_INJECTION_MATCHES_EXCEEDED',
    })
    expect(evaluateInjectionSafety({ audit: exceeded.getAuditSummary(), expectedMatches: 1 }))
      .toMatchObject({ status: 'safety-blocked' })

    expect(evaluateInjectionSafety({
      audit: { ...exceeded.getAuditSummary(), source: 'browser-route' as 'egress-gateway' }, expectedMatches: 1,
    })).toMatchObject({ status: 'safety-blocked', reasonCodes: expect.arrayContaining(['E2E_INJECTION_SOURCE_UNTRUSTED']) })
  })
})
