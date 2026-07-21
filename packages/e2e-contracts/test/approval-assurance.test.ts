import { describe, expect, test } from 'vitest'
import {
  LocalApprovalSummarySchema,
  OpenApprovalResultSchema,
  approvalAssuranceForMode,
} from '../src/approval-assurance.js'

const digest = `sha256:${'a'.repeat(64)}`

describe('approval assurance contracts', () => {
  test('local mode cannot claim identity verification or separation of duties', () => {
    expect(approvalAssuranceForMode('local-confirmation')).toEqual({
      approvalMode: 'local-confirmation', identityVerified: false,
      separationOfDutiesVerified: false,
    })
    expect(approvalAssuranceForMode('webauthn')).toEqual({
      approvalMode: 'webauthn', identityVerified: true,
      separationOfDutiesVerified: true,
    })
  })

  test('accepts a bounded public confirmation summary and rejects sensitive or unknown fields', () => {
    const summary = {
      runId: 'RUN-1', approvalType: 'execution', environmentId: 'TEST', riskTier: 'test',
      origins: ['https://test.example.com'], methods: ['POST'], actionCount: 1,
      effects: ['reversible-write'], maxUses: 1, secretRefs: ['API_TOKEN'],
      dataLeaseRefs: ['LEASE-1'], cleanupRefs: ['CLEANUP-1'], injectionClassifications: [],
      subjectDigest: digest, expiresAt: '2026-07-19T00:10:00.000Z',
    }
    expect(LocalApprovalSummarySchema.parse(summary)).toEqual(summary)
    expect(LocalApprovalSummarySchema.safeParse({ ...summary, secretValue: 'plaintext' }).success).toBe(false)
    expect(LocalApprovalSummarySchema.safeParse({ ...summary, requestBody: { password: 'x' } }).success).toBe(false)
    expect(LocalApprovalSummarySchema.safeParse({ ...summary, origins: Array(300).fill('https://x.test') }).success).toBe(false)
  })

  test('open approval result is a strict three-way union', () => {
    expect(OpenApprovalResultSchema.parse({
      status: 'approved', approvalMode: 'local-confirmation', receiptDigest: digest,
    })).toBeTruthy()
    expect(OpenApprovalResultSchema.parse({
      status: 'webauthn-required', approvalMode: 'webauthn',
      sessionId: 'SESSION-1', url: 'http://localhost:43111/approval',
    })).toBeTruthy()
    expect(OpenApprovalResultSchema.safeParse({
      status: 'approved', approvalMode: 'local-confirmation', receiptDigest: digest,
      sessionId: 'forbidden',
    }).success).toBe(false)
  })
})
