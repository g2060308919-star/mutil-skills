import { describe, expect, test } from 'vitest'
import { RuntimeExecutionBatch } from '../src/runtime-execution-batch.js'
import {
  TrustedActionRunner,
  authorizeRuntimeInjectionExecutor,
} from '../src/trusted-action-runner.js'
import { injectionOutput, realWriteOutput, runtimeWriteDigest } from './runtime-write-fixtures.js'
import { executeInjectionFixtureFlow } from './fixtures.js'

describe('injection Runtime vertical flow', () => {
  test('真实 InjectionGateway 返回注入响应且上游写计数保持 0', async () => {
    const flow = await executeInjectionFixtureFlow({ injectedStatus: 503 })
    expect(flow.result).toEqual({ mode: 'gateway-injection', status: 503 })
    expect(flow.gatewayAudit.counters).toMatchObject({ injected: 1, forwarded: 0 })
    expect(flow.upstreamWriteCount).toBe(0)
    expect(flow.realEnvironmentResult).toEqual({ mode: 'real-environment', status: 'passed' })
  })
  test('注入域保持 injectionTargetForwarded=0，且不覆盖真实 write 结果', async () => {
    const batch = new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-1' })
    batch.commitRealWrite(realWriteOutput())

    const injection = await new TrustedActionRunner().executeInjection({
      executor: authorizeRuntimeInjectionExecutor(async () => injectionOutput()),
      batch,
      runId: 'RUN-1', attemptId: 'ATTEMPT-1', caseId: 'CASE-1', actionId: 'ACTION-INJECT-1',
    })

    expect(injection.gatewayAudit.injectionTargetForwarded).toBe(0)
    expect(batch.getRealWrite('ACTION-WRITE-1')?.resultDigest).toBe(runtimeWriteDigest('real-result'))
    expect(batch.getInjection('ACTION-INJECT-1')).toEqual(injection)
  })

  test('注入报告试图宣称上游副作用时 fail closed', async () => {
    const batch = new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-2' })
    batch.commitRealWrite(realWriteOutput())
    await expect(new TrustedActionRunner().executeInjection({
      executor: authorizeRuntimeInjectionExecutor(async () => injectionOutput({
        gatewayAudit: {
          ...injectionOutput().gatewayAudit,
          forwarded: 1,
          injectionTargetForwarded: 1,
        },
      }) as never),
      batch,
      runId: 'RUN-1', attemptId: 'ATTEMPT-2', caseId: 'CASE-1', actionId: 'ACTION-INJECT-1',
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_INJECTION_EXECUTOR_OUTPUT_INVALID' })
    expect(batch.getInjection('ACTION-INJECT-1')).toBeUndefined()
  })

  test('相同 actionId 在真实域与注入域也不会互相覆盖', () => {
    const batch = new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-3' })
    batch.commitRealWrite(realWriteOutput({ actionId: 'ACTION-SHARED' }))
    batch.commitInjection(injectionOutput({ actionId: 'ACTION-SHARED' }))

    expect(batch.getRealWrite('ACTION-SHARED')?.resultDigest).toBe(runtimeWriteDigest('real-result'))
    expect(batch.getInjection('ACTION-SHARED')?.resultDigest).toBe(runtimeWriteDigest('injection-result'))
  })

  test('没有同一 Case 的真实 passed 结果时拒绝注入，即使其他 Case 已通过', () => {
    const batch = new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-4' })
    batch.commitRealWrite(realWriteOutput({ caseId: 'CASE-OTHER' }))
    expect(() => batch.commitInjection(injectionOutput({ caseId: 'CASE-1' })))
      .toThrow(/E2E_RUNTIME_INJECTION_REAL_RESULT_REQUIRED/)
  })
})
