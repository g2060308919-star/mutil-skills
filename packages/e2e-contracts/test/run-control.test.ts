import { describe, expect, test } from 'vitest'
import {
  RunCancellationResultV1Schema,
  RunHealthSnapshotV1Schema,
} from '../src/run-control.js'

describe('Run cancel 与 health 契约', () => {
  test.each([
    ['pre-dispatch', 'cancelled'], ['read-running', 'cancelling'], ['write-known', 'cancelling'],
    ['write-unknown', 'reconcile-required'], ['cleanup-running', 'cleanup-continuing'],
  ] as const)('%s 取消投影为 %s', (phase, disposition) => {
    expect(RunCancellationResultV1Schema.parse({ schemaVersion: 'run-cancellation-result/v1',
      runId: 'RUN-1', requestId: 'CANCEL-1', phase, disposition, repeated: false,
      cleanupRequired: phase === 'write-known' || phase === 'write-unknown' || phase === 'cleanup-running',
      requestedAt: '2026-08-12T00:00:00.000Z' })).toMatchObject({ phase, disposition })
  })

  test('write-unknown 不能被伪装为普通 cancelled，cleanup 中不能跳过收敛', () => {
    expect(() => RunCancellationResultV1Schema.parse({ schemaVersion: 'run-cancellation-result/v1',
      runId: 'RUN-1', requestId: 'CANCEL-1', phase: 'write-unknown', disposition: 'cancelled',
      repeated: false, cleanupRequired: false, requestedAt: '2026-08-12T00:00:00.000Z' })).toThrow()
  })

  test('health 是只读诊断投影并携带 active/wait/cancel/cleanup', () => {
    expect(RunHealthSnapshotV1Schema.parse({ schemaVersion: 'run-health-snapshot/v1', runId: 'RUN-1',
      observedWorkflowState: 'running-real', observedWorkflowSequence: 9,
      lastProgressAt: '2026-08-12T00:00:00.000Z', status: 'cancelling',
      active: { caseId: 'CASE-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1',
        pageIdentity: 'page://orders', frameIdentity: 'main' },
      wait: { reasonCode: 'E2E_WAIT_EVENTUALLY', deadlineAt: '2026-08-12T00:01:00.000Z', elapsedMs: 10 },
      cancel: { requested: true, phase: 'read-running' }, cleanup: { status: 'pending', residualCount: 0 },
      resources: { queueDepth: 0, lockCount: 1, gatewayReservations: 1, childProcesses: 1,
        rssBytes: 1024, evidenceBytes: 2048 } })).toMatchObject({ status: 'cancelling' })
  })
})
