import { describe, expect, test } from 'vitest'
import { ExecutionExplanationV1Schema } from '../src/execution-explanation.js'

describe('ExecutionExplanationV1', () => {
  test('Action 成功但 Oracle 失败时 claim 不能 verified，总体不能 accepted', () => {
    const parsed = ExecutionExplanationV1Schema.safeParse(fixture({
      verdict: 'accepted', oracleStatus: 'failed', claimStatus: 'verified',
    }))
    expect(parsed.success).toBe(false)
  })

  test('Mock 前端只允许 browser-product verified，被替代后端必须 not-executed', () => {
    const parsed = ExecutionExplanationV1Schema.parse(fixture({
      verdict: 'rejected', oracleStatus: 'failed', claimStatus: 'observed',
    }))
    expect(parsed.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'browser-product', status: 'observed' }),
      expect.objectContaining({ component: 'backend', status: 'not-executed' }),
    ]))
  })
})

function fixture(input: { verdict: 'accepted' | 'rejected'; oracleStatus: 'passed' | 'failed';
  claimStatus: 'observed' | 'verified' }) {
  return { schemaVersion: 'execution-explanation/v1', runId: 'RUN-1', verdict: input.verdict,
    timeline: [
      { eventId: 'EVENT-1', sequence: 1, phase: 'action', caseId: 'CASE-1', actionId: 'ACTION-1',
        attemptId: 'ATTEMPT-1', status: 'passed', at: '2026-08-12T00:00:00.000Z' },
      { eventId: 'EVENT-2', sequence: 2, phase: 'oracle', caseId: 'CASE-1', actionId: 'ACTION-1',
        oracleId: 'ORACLE-1', attemptId: 'ATTEMPT-1', status: input.oracleStatus,
        at: '2026-08-12T00:00:01.000Z' },
    ], failures: input.oracleStatus === 'failed' ? [{ failureId: 'FAIL-1', responsibility: 'product',
      reasonCode: 'E2E_ORACLE_FAILED', firstAttemptId: 'ATTEMPT-1', finalAttemptId: 'ATTEMPT-1',
      safeToRetry: true, nextLegalEdge: 'diagnosing', remediation: ['修复业务结果'] }] : [],
    claims: [{ claimId: 'CLAIM-UI', component: 'browser-product', status: input.claimStatus,
      evidenceIds: ['EVIDENCE-1'], reason: '真实 Chrome 观察' },
    { claimId: 'CLAIM-BACKEND', component: 'backend', status: 'not-executed', evidenceIds: [],
      reason: 'Mock backend 替代真实服务' }], lineageDigest: `sha256:${'a'.repeat(64)}` }
}
