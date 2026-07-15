import {
  canonicalizeJson,
  digestText,
  type ExecutionOutcomeBinding,
  type ExecutionOutcomeReceipt,
} from '@mutil-skills/e2e-contracts'
import { describe, expect, it } from 'vitest'
import { LocalExecutionOutcomeVerifier, LocalGatewayAuditSigner } from '../src/index.js'

function binding(): ExecutionOutcomeBinding {
  const evidenceIds = ['evidence.write.response', 'evidence.cleanup.probe']
  const cleanupPlanDigest = digestText('test/v1', 'cleanup-plan')
  const requests = [{ intentId: 'intent-write', method: 'POST', canonicalOrigin: 'https://example.test',
    exactPath: '/api/write', query: [] as Array<[string, string]>,
    payload: { kind: 'json' as const, digest: digestText('test/v1', 'payload') },
    targetFingerprint: digestText('test/v1', 'target'), maxRequests: 1, expectedOrder: 1 }]
  return {
    schemaVersion: '1.0.0',
    attemptContext: {
      assetId: 'asset.checkout', generationId: 'generation-7',
      prdRevision: digestText('test/v1', 'prd'), runId: 'run-8', caseId: 'case-write-1',
    },
    grantId: 'grant-1', capabilityId: 'capability-1', actionId: 'action-1',
    attemptId: 'attempt-1', reservationId: 'reservation-1', effect: 'reversible-write',
    capability: { capabilityId: 'capability-1', nonce: 'nonce', transport: 'http',
      effect: 'reversible-write', operation: 'http-request', actionId: 'action-1',
      dataLeaseId: 'lease-1', fencingToken: 1, cleanupPlanDigest, requests, maxUses: 1 },
    status: 'passed', effectObservation: 'applied',
    runnerResultDigest: digestText('test/v1', 'runner-result'),
    gateway: {
      executionSessionId: 'session-1',
      policyDigest: digestText('test/v1', 'gateway-policy'),
      approvedRequestSetDigest: digestText(
        'execution-outcome-approved-request-set/v1', canonicalizeJson(requests)),
      received: 1, forwarded: 1, blocked: 0,
    },
    cleanup: {
      cleanupPlanId: 'cleanup-plan-1', cleanupPlanDigest,
      leaseId: 'lease-1', status: 'verified-clean',
      resultDigest: digestText('test/v1', 'cleanup-result'),
      leaseReceiptDigest: digestText('test/v1', 'lease-receipt'),
    },
    evidenceIds,
    evidenceSetDigest: digestText(
      'execution-outcome-evidence-set/v1', canonicalizeJson([...evidenceIds].sort()),
    ),
    completedAt: '2026-07-14T10:00:00.000+08:00',
  }
}

function signer(): LocalGatewayAuditSigner {
  return LocalGatewayAuditSigner.create({
    issuer: 'gateway', keyId: 'gateway-key', instanceId: 'gateway-1', version: '1.0.0',
  })
}

describe('ExecutionOutcomeReceipt', () => {
  it('使用独立 purpose 签发完整回执，并可按预期 binding 独立验签', () => {
    const gatewaySigner = signer()
    const expected = binding()
    const receipt = gatewaySigner.issueExecutionOutcomeReceipt(expected)
    const verifier = LocalExecutionOutcomeVerifier.create(
      gatewaySigner.exportExecutionOutcomeVerifierMaterial(),
    )

    expect(receipt.purpose).toBe('execution-outcome-receipt/v1')
    expect(verifier.verifyReceipt(receipt)).toBe(true)
    expect(verifier.verifyReceipt(receipt, expected)).toBe(true)
  })

  it('拒绝上下文、reservation、Gateway、cleanup、evidence 与签名字段的任意篡改', () => {
    const gatewaySigner = signer()
    const receipt = gatewaySigner.issueExecutionOutcomeReceipt(binding())
    const verifier = LocalExecutionOutcomeVerifier.create(
      gatewaySigner.exportExecutionOutcomeVerifierMaterial(),
    )
    const tamperedSignature = `${receipt.signature.slice(0, -1)}${
      receipt.signature.endsWith('A') ? 'B' : 'A'
    }`
    const variants: ExecutionOutcomeReceipt[] = [
      { ...receipt, reservationId: 'reservation-other' },
      { ...receipt, attemptContext: { ...receipt.attemptContext, runId: 'run-other' } },
      { ...receipt, gateway: { ...receipt.gateway, forwarded: 2 } },
      { ...receipt, cleanup: { ...receipt.cleanup, resultDigest: digestText('test/v1', 'other') } },
      { ...receipt, evidenceIds: ['evidence.other'] },
      { ...receipt, signature: tamperedSignature },
    ]

    for (const candidate of variants) expect(verifier.verifyReceipt(candidate)).toBe(false)
  })

  it('拒绝替换密钥、错误预期 binding 与不满足 passed 语义的输入', () => {
    const gatewaySigner = signer()
    const expected = binding()
    const receipt = gatewaySigner.issueExecutionOutcomeReceipt(expected)
    const replacement = signer()

    expect(LocalExecutionOutcomeVerifier.create(
      replacement.exportExecutionOutcomeVerifierMaterial(),
    ).verifyReceipt(receipt)).toBe(false)
    expect(LocalExecutionOutcomeVerifier.create(
      gatewaySigner.exportExecutionOutcomeVerifierMaterial(),
    ).verifyReceipt(receipt, { ...expected, reservationId: 'reservation-other' })).toBe(false)
    expect(() => gatewaySigner.issueExecutionOutcomeReceipt({
      ...expected, effectObservation: 'unknown',
    })).toThrow(/passed outcome/)
  })
})
