import { describe, expect, it } from 'vitest'
import {
  BrowserExecutorDescriptorV1Schema,
  BrowserExecutorExecutionResultV1Schema,
  BrowserExecutorProgressV1Schema,
} from '../src/browser-executor-protocol.js'

const digest = `sha256:${'a'.repeat(64)}`

describe('BrowserExecutorProtocolV1 契约', () => {
  it.each([
    ['target-probe', 'diagnostic', 'safe'],
    ['preflight', 'diagnostic', 'safe'],
    ['read', 'read', 'safe'],
    ['reversible-write', 'write', 'reconcile-required'],
    ['injection', 'injection', 'safe'],
    ['full-playwright', 'write', 'reconcile-required'],
  ] as const)('描述 %s 执行器的发现、控制、证据与恢复能力', (kind, effect, afterDispatch) => {
    expect(BrowserExecutorDescriptorV1Schema.parse({
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executorId: `${kind}/v1`, kind, effect,
      inputSchemaVersion: 'legacy/v1', outputSchemaVersion: 'legacy/v1',
      control: { progress: true, timeout: 'deadline-before-dispatch', cancellation: 'pre-dispatch' },
      evidenceKinds: kind === 'target-probe' ? ['diagnostics'] : ['screenshot', 'dom'],
      retrySafety: { beforeDispatch: 'safe', afterDispatch },
      lifecycle: {
        cleanup: effect === 'write' ? 'required' : 'not-applicable',
        reconcile: effect === 'write' ? 'required-on-unknown' : 'not-applicable',
      },
    }).kind).toBe(kind)
  })

  it('拒绝把写执行器声明成可安全重试且无 reconcile', () => {
    expect(BrowserExecutorDescriptorV1Schema.safeParse({
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executorId: 'write/v1',
      kind: 'reversible-write', effect: 'write', inputSchemaVersion: 'legacy/v1', outputSchemaVersion: 'legacy/v1',
      control: { progress: true, timeout: 'deadline-before-dispatch', cancellation: 'pre-dispatch' },
      evidenceKinds: ['screenshot'], retrySafety: { beforeDispatch: 'safe', afterDispatch: 'safe' },
      lifecycle: { cleanup: 'not-applicable', reconcile: 'not-applicable' },
    }).success).toBe(false)
  })

  it('unknown 写结果只能进入 reconcile，不能自动 retry', () => {
    const result = BrowserExecutorExecutionResultV1Schema.parse({
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executionId: 'EXEC-1',
      executorId: 'reversible-write/v1', kind: 'reversible-write', runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      status: 'failed', outcomeDigest: digest, effectObservation: 'unknown', cleanupStatus: 'unknown',
      recovery: 'reconcile', evidence: { materialKinds: ['screenshot'], references: [] },
    })
    expect(result.recovery).toBe('reconcile')
    expect(BrowserExecutorExecutionResultV1Schema.safeParse({ ...result, recovery: 'retry' }).success).toBe(false)
  })

  it('进度事件闭合 execution、run、attempt 与单调序号', () => {
    expect(BrowserExecutorProgressV1Schema.parse({
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executionId: 'EXEC-1',
      runId: 'RUN-1', attemptId: 'ATTEMPT-1', sequence: 1, phase: 'dispatching', at: '2026-08-08T00:00:00.000Z',
    }).phase).toBe('dispatching')
    expect(BrowserExecutorProgressV1Schema.safeParse({
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executionId: 'EXEC-1',
      runId: 'RUN/1', attemptId: 'ATTEMPT-1', sequence: 1, phase: 'dispatching',
      at: '2026-08-08T00:00:00.000Z',
    }).success).toBe(false)
  })
})
