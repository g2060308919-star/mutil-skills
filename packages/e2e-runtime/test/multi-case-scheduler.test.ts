import { describe, expect, test } from 'vitest'
import {
  completeCase,
  createCaseSchedule,
  recoverCaseSchedule,
  startNextCase,
} from '../src/multi-case-scheduler.js'
import {
  digestCompiledPrdRunPlan,
  type CompiledPrdRunPlan,
} from '@mutil-skills/e2e-contracts'

describe('MultiCaseScheduler', () => {
  test('executes three Cases in frozen order with independent terminals', () => {
    let state = createCaseSchedule(planFixture(), '2026-07-31T00:00:00.000Z')
    state = startNextCase(state, {
      attemptId: 'ATTEMPT-1', startedAt: '2026-07-31T00:01:00.000Z',
    })
    state = completeCase(state, {
      caseId: 'CASE-0001', attemptId: 'ATTEMPT-1', status: 'passed',
      effectObservation: 'not-applicable', cleanupStatus: 'not-applicable',
      completedAt: '2026-07-31T00:02:00.000Z',
    })
    state = startNextCase(state, {
      attemptId: 'ATTEMPT-2', startedAt: '2026-07-31T00:03:00.000Z',
    })
    expect(state.cases.map((item) => item.state)).toEqual(['passed', 'running', 'pending'])
    expect(state.currentCaseId).toBe('CASE-0002')
    expect(state.revision).toBe(3)
  })

  test('stop-required failure blocks remaining Cases without changing completed results', () => {
    let state = createCaseSchedule(planFixture(), '2026-07-31T00:00:00.000Z')
    state = startNextCase(state, {
      attemptId: 'ATTEMPT-1', startedAt: '2026-07-31T00:01:00.000Z',
    })
    state = completeCase(state, {
      caseId: 'CASE-0001', attemptId: 'ATTEMPT-1', status: 'failed',
      effectObservation: 'not-applied', cleanupStatus: 'verified-clean',
      completedAt: '2026-07-31T00:02:00.000Z',
    })
    expect(state.cases.map((item) => item.state)).toEqual(['failed', 'unable', 'unable'])
    expect(state.status).toBe('terminal')
  })

  test('effect-unknown recovers Cleanup first and permanently denies automatic retry', () => {
    let state = createCaseSchedule(planFixture(), '2026-07-31T00:00:00.000Z')
    state = startNextCase(state, {
      attemptId: 'ATTEMPT-1', startedAt: '2026-07-31T00:01:00.000Z',
    })
    state = completeCase(state, {
      caseId: 'CASE-0001', attemptId: 'ATTEMPT-1', status: 'failed',
      effectObservation: 'unknown', cleanupStatus: 'unknown',
      completedAt: '2026-07-31T00:02:00.000Z',
    })
    const recovered = recoverCaseSchedule(state)
    expect(recovered.next).toEqual({ kind: 'cleanup', caseId: 'CASE-0001' })
    expect(() => startNextCase(recovered.state, {
      attemptId: 'ATTEMPT-RETRY', startedAt: '2026-07-31T00:03:00.000Z',
    })).toThrow(/E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED/)
  })

  test('持久 running Case 必须先对账，不能被误判为可 finalization', () => {
    const state = startNextCase(
      createCaseSchedule(planFixture(), '2026-07-31T00:00:00.000Z'),
      { attemptId: 'ATTEMPT-1', startedAt: '2026-07-31T00:01:00.000Z' },
    )
    expect(recoverCaseSchedule(state).next).toEqual({
      kind: 'reconcile', caseId: 'CASE-0001', attemptId: 'ATTEMPT-1',
    })
  })

  test('continue policy advances after an independently failed Case', () => {
    const plan = planFixture()
    plan.cases[0]!.failurePolicy = 'continue'
    plan.compilerDigest = digestCompiledPrdRunPlan(plan)
    let state = createCaseSchedule(plan, '2026-07-31T00:00:00.000Z')
    state = startNextCase(state, {
      attemptId: 'ATTEMPT-1', startedAt: '2026-07-31T00:01:00.000Z',
    })
    state = completeCase(state, {
      caseId: 'CASE-0001', attemptId: 'ATTEMPT-1', status: 'failed',
      effectObservation: 'not-applied', cleanupStatus: 'verified-clean',
      completedAt: '2026-07-31T00:02:00.000Z',
    })
    state = startNextCase(state, {
      attemptId: 'ATTEMPT-2', startedAt: '2026-07-31T00:03:00.000Z',
    })
    expect(state.currentCaseId).toBe('CASE-0002')
  })
})

function planFixture(): CompiledPrdRunPlan {
  const draft = {
    schemaVersion: '1.0.0' as const, contractProjectionDigest: `sha256:${'a'.repeat(64)}`,
    cases: Array.from({ length: 3 }, (_, index) => ({
      queueOrdinal: index, caseId: `CASE-${String(index + 1).padStart(4, '0')}`,
      caseKey: `case-${index + 1}`, title: `场景 ${index + 1}`, actor: 'USER',
      contractNodeIds: [`REQ-${index + 1}`], failurePolicy: index === 0 ? 'stop-required' as const : 'continue' as const,
      actions: [{ actionId: `ACTION-${index + 1}`, actionKey: 'observe',
        kind: 'full-playwright' as const, effect: 'read' as const, statement: '检查结果' }],
      oracles: [{ oracleId: `ORACLE-${index + 1}`, oracleKey: 'visible',
        actionId: `ACTION-${index + 1}`, contractNodeId: `REQ-${index + 1}`,
        acceptanceCriterion: `结果 ${index + 1} 可见` }],
    })),
  }
  return { ...draft, compilerDigest: digestCompiledPrdRunPlan(draft) }
}
