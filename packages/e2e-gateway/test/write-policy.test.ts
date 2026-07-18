import { describe, expect, test, vi } from 'vitest'
import {
  canonicalizeJson,
  digestText,
  type CapabilityReservation,
  type GrantDecision,
  type ReversibleWriteCapability,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import {
  LocalGatewayAuditSigner,
  ReversibleWriteGateway,
  digestBinaryHttpPayload,
  digestJsonHttpPayload,
} from '../src/index.js'

const targetFingerprint = digestText('fixture-resource/v1', 'order:100')
const payload = { orderId: 100, decision: 'approve' }
const attemptContext = {
  assetId: 'PRD-1', generationId: 'GEN-1', prdRevision: targetFingerprint, runId: 'RUN-1', caseId: 'CASE-1',
}

function fixture(): { grant: SignedWriteGrant; capability: ReversibleWriteCapability } {
  const capability: ReversibleWriteCapability = {
    capabilityId: 'CAPABILITY-1', nonce: 'nonce', transport: 'http', effect: 'reversible-write',
    operation: 'http-request',
    actionId: 'ACTION-APPROVE', dataLeaseId: 'LEASE-1', fencingToken: 7,
    cleanupPlanDigest: digestText('cleanup/v1', 'restore pending'), maxUses: 1,
    requests: [
      {
        intentId: 'INTENT-LOAD', method: 'GET', canonicalOrigin: 'https://test.example.com',
        exactPath: '/api/orders/100', query: [], payload: { kind: 'no-body' },
        targetFingerprint, maxRequests: 1, expectedOrder: 1,
      },
      {
        intentId: 'INTENT-APPROVE', method: 'POST', canonicalOrigin: 'https://test.example.com',
        exactPath: '/api/orders/100/approve', query: [['source', 'e2e']],
        payload: { kind: 'json', digest: digestJsonHttpPayload(payload) },
        targetFingerprint, maxRequests: 1, expectedOrder: 2,
      },
    ],
  }
  return {
    capability,
    grant: {
      grantId: 'GRANT-1', issuer: 'authority', keyId: 'key', proofScope: 'local-os-user',
      approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
      subject: {
        schemaVersion: '1.0.0', assetId: 'PRD-1', prdRevision: targetFingerprint,
        executionDigest: targetFingerprint, environment: 'test', baseOrigin: 'https://test.example.com',
        actions: [],
      } as unknown as SignedWriteGrant['subject'],
      subjectDigest: targetFingerprint, issuedAt: '2026-07-11T10:00:00.000Z',
      approvalContext: { schemaVersion: '1.0.0', subject: 'os-user:qa', runId: 'RUN-1',
        approvalType: 'execution', subjectDigest: targetFingerprint, installationDigest: targetFingerprint,
        origin: 'http://127.0.0.1:43210', issuedAt: '2026-07-11T10:00:00.000Z',
        expiresAt: '2026-07-11T10:10:00.000Z' },
      expiresAt: '2026-07-11T10:10:00.000Z', capabilities: [capability], revocationSequence: 0,
      signature: 'signature',
    },
  }
}

function dependencies() {
  const reservation: CapabilityReservation = {
    reservationId: 'RESERVATION-1', grantId: 'GRANT-1', capabilityId: 'CAPABILITY-1',
    actionId: 'ACTION-APPROVE', attemptId: 'ATTEMPT-1', status: 'reserved',
    reservedAt: '2026-07-11T10:00:00.000Z',
  }
  const outcomeSigner = LocalGatewayAuditSigner.create({ issuer: 'gateway', keyId: 'gateway-key',
    instanceId: 'GATEWAY-1', version: '1.0.0' })
  return {
    recorder: outcomeSigner.createRecorder(digestText('gateway-policy/v1', 'test')),
    outcomeSigner,
    authority: {
      verifyForSubject: vi.fn(async (): Promise<GrantDecision> => ({ allowed: true })),
      reserveForSubject: vi.fn(async () => reservation),
      complete: vi.fn(async () => undefined),
      markUnknown: vi.fn(async () => undefined),
    },
    leaseAuthority: { verifyTarget: vi.fn(async () => true) },
  }
}

describe('ReversibleWriteGateway', () => {
  test('template intent 只接受 Runtime 解析后摘要完全一致的 payload，且必须完整绑定', async () => {
    const { grant, capability } = fixture()
    const body = Buffer.from('{"token":"runtime-secret"}')
    capability.requests = [{
      ...capability.requests[0]!, intentId: 'INTENT-TEMPLATE', method: 'POST',
      payload: { kind: 'template', templateDigest: digestText('template/v1', 'SECRET.API') },
    }]
    grant.capabilities = [capability]
    const deps = dependencies()
    expect(() => new ReversibleWriteGateway({
      grant, currentSubject: grant.subject, capability, attemptId: 'ATTEMPT-1', attemptContext, ...deps,
    })).toThrow(/template intent/)
    const gateway = new ReversibleWriteGateway({
      grant, currentSubject: grant.subject, capability, attemptId: 'ATTEMPT-1', attemptContext, ...deps,
      resolvedTemplatePayloadDigests: { 'INTENT-TEMPLATE': digestBinaryHttpPayload(body) },
    })
    await expect(gateway.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/100', body,
      contentType: 'application/json',
    })).resolves.toMatchObject({ decision: 'forward', intentId: 'INTENT-TEMPLATE' })
  })
  test('Gateway 使用独立当前计划主体复验，主体变化时不允许请求离开', async () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    deps.authority.verifyForSubject.mockResolvedValue({
      allowed: false as const,
      code: 'E2E_APPROVAL_SUBJECT_MISMATCH',
      reason: '当前计划与批准主体不一致',
    })
    const currentSubject = { ...grant.subject, prdRevision: digestText('revision/v1', 'changed') }
    const gateway = new ReversibleWriteGateway({
      grant, currentSubject, capability, attemptId: 'ATTEMPT-1', attemptContext, ...deps,
    })

    await expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' }))
      .resolves.toMatchObject({ decision: 'block', code: 'E2E_APPROVAL_SUBJECT_MISMATCH' })
    expect(deps.authority.verifyForSubject).toHaveBeenCalledWith(grant, currentSubject)
    expect(deps.authority.reserveForSubject).not.toHaveBeenCalled()
    expect(gateway.getAuditSummary()).toMatchObject({ received: 1, forwarded: 0, blocked: 1 })
  })

  test('reserves once, verifies lease fencing, and forwards the exact ordered request sequence', async () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    const gateway = new ReversibleWriteGateway({ grant, currentSubject: grant.subject, capability,
      attemptId: 'ATTEMPT-1', attemptContext, ...deps })

    await expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' }))
      .resolves.toMatchObject({ decision: 'forward', intentId: 'INTENT-LOAD' })
    await expect(gateway.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/100/approve?source=e2e',
      body: Buffer.from(JSON.stringify({ decision: 'approve', orderId: 100 })), contentType: 'application/json; charset=utf-8',
    })).resolves.toMatchObject({ decision: 'forward', intentId: 'INTENT-APPROVE' })
    await gateway.complete(digestText('outcome/v1', canonicalizeJson({ status: 'approved' })))

    expect(deps.authority.reserveForSubject).toHaveBeenCalledTimes(1)
    expect(deps.leaseAuthority.verifyTarget).toHaveBeenCalledTimes(2)
    expect(deps.authority.complete).toHaveBeenCalledWith('RESERVATION-1', expect.stringMatching(/^sha256:/))
    expect(gateway.getAuditSummary()).toMatchObject({ received: 2, forwarded: 2, blocked: 0 })
  })

  test('records signed-publication inputs for every write decision and the completed reservation', async () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    const gateway = new ReversibleWriteGateway({ grant, currentSubject: grant.subject, capability, attemptId: 'ATTEMPT-1',
      attemptContext, ...deps })
    await gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' })
    await gateway.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/100/approve?source=e2e',
      body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json',
    })
    const outcomeDigest = digestText('outcome/v1', canonicalizeJson({ status: 'approved' }))
    await gateway.complete(outcomeDigest)
    const audit = deps.recorder.finalize()
    expect(audit.requestEvents).toHaveLength(2)
    expect(audit.requestEvents[1]).toMatchObject({ actionId: 'ACTION-APPROVE', decision: 'forwarded' })
    expect(audit.capabilityReservations).toEqual([expect.objectContaining({
      capabilityId: 'CAPABILITY-1', actionId: 'ACTION-APPROVE', consumed: true,
    })])
  })

  test('由 Gateway 派生并签发完整 ExecutionOutcome，Authority 只接收其签名摘要', async () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    const gateway = new ReversibleWriteGateway({ grant, currentSubject: grant.subject, capability, attemptId: 'ATTEMPT-1',
      attemptContext, ...deps })
    await gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' })
    await gateway.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/100/approve?source=e2e',
      body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json',
    })

    const receipt = await gateway.completeWithExecutionOutcome({
      status: 'passed', effectObservation: 'applied',
      runnerResultDigest: digestText('runner-result/v1', 'passed'),
      cleanupPlanId: 'CLEANUP-1',
      cleanup: {
        status: 'verified-clean', resultDigest: digestText('cleanup-result/v1', 'clean'),
        leaseReceiptDigest: digestText('lease-receipt/v1', 'released'),
      },
      evidenceIds: ['EVIDENCE-1'], completedAt: '2026-07-11T10:01:00.000Z',
    })

    expect(receipt).toMatchObject({
      grantId: grant.grantId, capabilityId: capability.capabilityId,
      reservationId: 'RESERVATION-1', attemptContext,
      gateway: { received: 2, forwarded: 2, blocked: 0 },
      cleanup: { cleanupPlanDigest: capability.cleanupPlanDigest, leaseId: capability.dataLeaseId },
    })
    const audit = deps.recorder.finalize()
    expect(audit.requestEvents).toHaveLength(2)
    expect(new Set(audit.requestEvents.map((event) => event.executionSessionId)))
      .toEqual(new Set([receipt.gateway.executionSessionId]))
    expect(deps.authority.complete).toHaveBeenCalledWith('RESERVATION-1', receipt.signedDigest)
  })

  test('拒绝与 recorder 不同实例的签发器', () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    const replacement = LocalGatewayAuditSigner.create({
      issuer: 'gateway', keyId: 'gateway-key', instanceId: 'GATEWAY-OTHER', version: '1.0.0',
    })
    expect(() => new ReversibleWriteGateway({ grant, currentSubject: grant.subject, capability,
      attemptId: 'ATTEMPT-1', attemptContext,
      ...deps, outcomeSigner: replacement })).toThrow(expect.objectContaining({
      code: 'E2E_GATEWAY_OUTCOME_SIGNER_MISMATCH',
    }))
  })

  test('rejects untrusted or missing publication recorders before any request can leave', () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    expect(() => new ReversibleWriteGateway({ grant, currentSubject: grant.subject, capability,
      attemptId: 'ATTEMPT-1', attemptContext,
      authority: deps.authority, leaseAuthority: deps.leaseAuthority,
      recorder: { recordReadDecision() {}, recordCapabilityReservation() {}, finalize() { return {} } } as any,
    })).toThrow(expect.objectContaining({ code: 'E2E_GATEWAY_TRUSTED_AUDIT_RECORDER_REQUIRED' }))
  })

  test('blocks out-of-order, payload-mismatched, exhausted, and stale-lease requests', async () => {
    const first = fixture()
    const outOfOrder = new ReversibleWriteGateway({ grant: first.grant, currentSubject: first.grant.subject,
      capability: first.capability,
      attemptId: 'A', attemptContext, ...dependencies() })
    await expect(outOfOrder.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/100/approve?source=e2e',
      body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json',
    })).resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_REQUEST_OUT_OF_ORDER' })

    const second = fixture()
    const mismatch = new ReversibleWriteGateway({ grant: second.grant, currentSubject: second.grant.subject,
      capability: second.capability,
      attemptId: 'B', attemptContext, ...dependencies() })
    await mismatch.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' })
    await expect(mismatch.decide({
      method: 'POST', url: 'https://test.example.com/api/orders/100/approve?source=e2e',
      body: Buffer.from('{"orderId":101}'), contentType: 'application/json',
    })).resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_PAYLOAD_MISMATCH' })

    const third = fixture()
    const exhausted = new ReversibleWriteGateway({ grant: third.grant, currentSubject: third.grant.subject,
      capability: third.capability,
      attemptId: 'C', attemptContext, ...dependencies() })
    await exhausted.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' })
    await expect(exhausted.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' }))
      .resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_REQUEST_OUT_OF_ORDER' })

    const fourth = fixture()
    const staleDeps = dependencies()
    staleDeps.leaseAuthority.verifyTarget.mockResolvedValue(false)
    const stale = new ReversibleWriteGateway({ grant: fourth.grant, currentSubject: fourth.grant.subject,
      capability: fourth.capability,
      attemptId: 'D', attemptContext, ...staleDeps })
    await expect(stale.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' }))
      .resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_LEASE_TARGET_INVALID' })
  })

  test('marks a reserved action unknown after an ambiguous upstream result', async () => {
    const { grant, capability } = fixture()
    const deps = dependencies()
    const gateway = new ReversibleWriteGateway({ grant, currentSubject: grant.subject, capability,
      attemptId: 'ATTEMPT-1', attemptContext, ...deps })
    await gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' })
    await gateway.markUnknown('upstream connection closed after request bytes were sent')

    expect(deps.authority.markUnknown).toHaveBeenCalledWith('RESERVATION-1', expect.stringContaining('connection closed'))
    await expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders/100' }))
      .resolves.toMatchObject({ decision: 'block', code: 'E2E_GATEWAY_ACTION_FINAL' })
  })
})
