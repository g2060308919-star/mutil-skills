import { describe, expect, test } from 'vitest'
import { assertCompiledCaseProjection } from '../src/compiled-case-projection.js'

const compiledCase = {
  queueOrdinal: 0, caseId: 'CASE-0001', caseKey: 'order-update', title: '更新订单',
  actor: 'USER', contractNodeIds: ['REQ-1'], failurePolicy: 'stop-required' as const,
  executionLane: 'real-reversible-write' as const,
  fixture: {
    actorRef: 'USER',
    preconditions: [{ kind: 'business-state' as const, statement: '订单处于待处理状态' }],
    seedStrategy: 'gateway-api' as const,
    dataLease: { leaseKey: 'LEASE-ORDER-1', scope: 'order', expiresAfterSeconds: 600 },
    cleanup: { kind: 'gateway-api' as const, statement: '恢复订单状态' },
    reloadVerification: [{ statement: '刷新后订单恢复为待处理状态' }],
  },
  locatorCandidates: [{ kind: 'test-id' as const, value: 'order-card' }],
  pageIdentityPolicy: {
    schemaVersion: '1.0.0' as const,
    url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
    signals: [{ kind: 'test-id' as const, value: 'orders-page' }],
    match: { mode: 'all' as const },
  },
  actions: [{ actionId: 'ACTION-0001-0001', actionKey: 'save', kind: 'interact' as const,
    effect: 'reversible-write' as const, statement: '保存订单' }],
  oracles: [{ oracleId: 'ORACLE-0001-0001', oracleKey: 'saved',
    actionId: 'ACTION-0001-0001', contractNodeId: 'REQ-1', acceptanceCriterion: '保存成功' }],
}

const projectedCase = {
  caseId: 'CASE-0001', revision: 1, obligationIds: ['OBL-1'], title: '更新订单', actor: 'USER',
  necessity: 'required' as const, preconditions: ['订单处于待处理状态'],
  dataNeedIds: ['LEASE-ORDER-1'],
  steps: [{ stepId: 'STEP-1', ordinal: 0, semanticAction: '保存订单', semanticTarget: '订单',
    oracles: [
      { oracleId: 'ORACLE-0001-0001', statement: '保存成功' },
      { oracleId: 'ORACLE-RELOAD-1', statement: '刷新后订单恢复为待处理状态' },
    ], evidenceKinds: ['screenshot', 'trace'] }],
  mode: 'real-environment' as const, effect: 'reversible-write' as const,
  evidenceLevel: 'E3' as const, cleanupPlanId: 'CLEANUP-ORDER-1', timeoutMs: 30_000,
  retryPolicy: 'verified-not-applied-max-1' as const, status: 'active' as const,
  executionLane: compiledCase.executionLane, fixture: compiledCase.fixture,
  locatorCandidates: compiledCase.locatorCandidates,
  pageIdentityPolicy: compiledCase.pageIdentityPolicy,
}

describe('compiled semantic case → test-cases projection', () => {
  test('真实写 fixture 完整闭合 actor、lease、cleanup、reload 与身份策略', () => {
    expect(() => assertCompiledCaseProjection({ cases: [compiledCase] }, {
      cases: [projectedCase], caseSetDigest: `sha256:${'1'.repeat(64)}`,
    })).not.toThrow()
  })

  test.each([
    ['缺少执行契约字段', { fixture: undefined }],
    ['fixture 漂移', { fixture: { ...projectedCase.fixture, seedStrategy: 'browser-ui' } }],
    ['缺少 lease', { dataNeedIds: [] }],
    ['缺少 cleanup', { cleanupPlanId: 'not-applicable' }],
    ['缺少 reload oracle', { steps: [{ ...projectedCase.steps[0],
      oracles: [{ oracleId: 'ORACLE-0001-0001', statement: '保存成功' }] }] }],
  ])('%s 时在执行批准前拒绝', (_name, drift) => {
    expect(() => assertCompiledCaseProjection({ cases: [compiledCase] }, {
      cases: [{ ...projectedCase, ...drift }], caseSetDigest: `sha256:${'1'.repeat(64)}`,
    })).toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_CASE_EXECUTION_PROJECTION_MISMATCH' }))
  })
})
