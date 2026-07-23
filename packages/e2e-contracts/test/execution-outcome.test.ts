import { describe, expect, test } from 'vitest'
import {
  ExecutionOutcomeBindingSchema, ExecutionOutcomeReceiptSchema, canonicalizeJson,
  digestExecutionOutcomeBinding, digestText,
} from '../src/index.js'

function binding() {
  const evidenceIds = ['EVIDENCE-DOM', 'EVIDENCE-GATEWAY']
  const cleanupPlanDigest = digest('cleanup-plan')
  const requests = [{ intentId: 'INTENT-WRITE', method: 'POST', canonicalOrigin: 'https://example.test',
    exactPath: '/api/write', query: [], payload: { kind: 'json' as const, digest: digest('payload') },
    targetFingerprint: digest('target'), maxRequests: 1, expectedOrder: 1 }]
  return {
    schemaVersion: '1.0.0' as const,
    attemptContext: { assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digest('prd'),
      runId: 'RUN-1', caseId: 'CASE-1' },
    grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1',
    reservationId: 'RESERVATION-1', effect: 'reversible-write' as const, status: 'passed' as const,
    capability: { capabilityId: 'CAP-1', nonce: 'nonce', transport: 'http' as const,
      effect: 'reversible-write' as const, operation: 'http-request' as const, actionId: 'ACTION-1',
      dataLeaseId: 'LEASE-1', fencingToken: 1, cleanupPlanDigest, requests, maxUses: 1 as const },
    effectObservation: 'applied' as const, runnerResultDigest: digest('runner'),
    gateway: { executionSessionId: 'SESSION-1', policyDigest: digest('policy'), approvedRequestSetDigest: digestText(
      'execution-outcome-approved-request-set/v1', canonicalizeJson(requests)),
      received: 2, forwarded: 2, blocked: 0 },
    cleanup: { cleanupPlanId: 'CLEANUP-1', cleanupPlanDigest, leaseId: 'LEASE-1',
      status: 'verified-clean' as const, resultDigest: digest('cleanup-result'), leaseReceiptDigest: digest('lease-receipt') },
    evidenceIds, evidenceSetDigest: digestText('execution-outcome-evidence-set/v1', canonicalizeJson([...evidenceIds].sort())),
    completedAt: '2026-07-14T10:00:00.000+00:00',
  }
}

describe('ExecutionOutcomeReceipt 契约', () => {
  test('完整绑定可解析且摘要确定', () => {
    const value = ExecutionOutcomeBindingSchema.parse(binding())
    expect(digestExecutionOutcomeBinding(value)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('passed 不能缺少真实写、Gateway 转发或 verified cleanup', () => {
    expect(() => ExecutionOutcomeBindingSchema.parse({ ...binding(), effectObservation: 'unknown' }))
      .toThrow(/passed outcome/)
    expect(() => ExecutionOutcomeBindingSchema.parse({ ...binding(), gateway: { ...binding().gateway, forwarded: 0 } }))
      .toThrow(/passed outcome/)
    expect(() => ExecutionOutcomeBindingSchema.parse({ ...binding(), cleanup: { ...binding().cleanup, status: 'unknown' } }))
      .toThrow(/passed outcome/)
  })

  test('Receipt signedDigest 必须覆盖全部结构化 preimage', () => {
    const value = binding()
    const receipt = { ...value, issuer: 'GATEWAY', keyId: 'KEY-1', purpose: 'execution-outcome-receipt/v1' as const,
      algorithm: 'Ed25519' as const, signedDigest: digestExecutionOutcomeBinding(value), signature: 'signature' }
    expect(ExecutionOutcomeReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(() => ExecutionOutcomeReceiptSchema.parse({ ...receipt,
      cleanup: { ...receipt.cleanup, resultDigest: digest('forged') } })).toThrow(/signedDigest/)
  })

  test('browser-local capability 可绑定 full playwright 程序且拒绝 HTTP 字段串用', () => {
    const value = binding()
    const browserLocal = {
      ...value,
      capability: {
        capabilityId: 'CAP-1', nonce: 'nonce', transport: 'browser-local' as const,
        effect: 'reversible-write' as const, operation: 'full-playwright' as const,
        actionId: 'ACTION-1', programDigest: digest('program'), cleanupProgramDigest: digest('cleanup-program'),
        dataLeaseId: 'LEASE-1', fencingToken: 1, cleanupPlanDigest: digest('cleanup-plan'),
        requests: [], maxUses: 1 as const,
      },
      gateway: {
        ...value.gateway,
        approvedRequestSetDigest: digestText('execution-outcome-approved-request-set/v1', canonicalizeJson([])),
        received: 0,
        forwarded: 0,
      },
    }
    expect(ExecutionOutcomeBindingSchema.parse(browserLocal)).toEqual(browserLocal)
    expect(ExecutionOutcomeBindingSchema.safeParse({
      ...browserLocal,
      capability: { ...browserLocal.capability, operation: 'http-request' },
    }).success).toBe(false)
    expect(ExecutionOutcomeBindingSchema.safeParse({
      ...binding(),
      capability: { ...binding().capability, programDigest: digest('program') },
    }).success).toBe(false)
    expect(ExecutionOutcomeBindingSchema.safeParse({
      ...browserLocal,
      capability: { ...browserLocal.capability, cleanupProgramDigest: undefined },
    }).success).toBe(false)
    const tooManyRequests = Array.from({ length: 1_001 }, (_, index) => ({
      ...value.capability.requests[0]!, intentId: `INTENT-${index}`, expectedOrder: index + 1,
    }))
    const oversized = {
      ...browserLocal,
      capability: { ...browserLocal.capability, requests: tooManyRequests },
      gateway: {
        ...browserLocal.gateway,
        approvedRequestSetDigest: digestText(
          'execution-outcome-approved-request-set/v1', canonicalizeJson(tooManyRequests),
        ),
        received: 1,
        forwarded: 1,
      },
    }
    expect(ExecutionOutcomeBindingSchema.safeParse(oversized).success).toBe(false)
  })
})

function digest(value: string): string {
  return digestText('execution-outcome-test/v1', value)
}
