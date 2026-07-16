import { describe, expect, test } from 'vitest'
import { reduceTelemetry, type TelemetryLifecycleEvent } from '../src/index.js'

function event(overrides: Partial<TelemetryLifecycleEvent>): TelemetryLifecycleEvent {
  return {
    schemaVersion: 1,
    runtime: 'codex',
    type: 'skill',
    target: 'tdd',
    callId: 'call-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nativeTurnId: 'native-turn-1',
    phase: 'started',
    status: null,
    failureKind: null,
    errorCode: null,
    nativeErrorCode: null,
    errorMessage: null,
    timestamp: '2026-07-11T10:00:00.000Z',
    projectHash: 'project-1',
    source: 'pre_tool_use',
    log: { prompt: null, input: null, output: null, error: null },
    ...overrides,
  }
}

describe('reduceTelemetry', () => {
  test('counts retries as separate calls but one used turn', () => {
    const result = reduceTelemetry([
      event({ callId: 'read-1' }),
      event({
        callId: 'read-1',
        phase: 'completed',
        status: 'failure',
        failureKind: 'permission_denied',
        errorCode: 'SKILL_PERMISSION_DENIED',
        nativeErrorCode: 'EACCES',
        errorMessage: 'Permission denied',
        source: 'post_tool_use_failure',
      }),
      event({ callId: 'read-2', timestamp: '2026-07-11T10:00:01.000Z' }),
      event({
        callId: 'read-2',
        phase: 'completed',
        status: 'success',
        timestamp: '2026-07-11T10:00:02.000Z',
        source: 'post_tool_use',
      }),
    ])

    expect(result.summary).toEqual({
      totalCalls: 2,
      successCalls: 1,
      failureCalls: 1,
      usedTurnCount: 1,
      successRate: 50,
      failureRate: 50,
      averageCallsPerUsedTurn: 2,
    })
    expect(result.calls[0]).toMatchObject({
      callId: 'read-1',
      status: 'failure',
      errorCode: 'SKILL_PERMISSION_DENIED',
      nativeErrorCode: 'EACCES',
    })
  })

  test('reconciles duplicate hook and transcript events by call id', () => {
    const result = reduceTelemetry([
      event({ callId: 'mcp-1', type: 'mcp', target: 'github/get_issue' }),
      event({
        callId: 'mcp-1',
        type: 'mcp',
        target: 'github/get_issue',
        phase: 'completed',
        status: 'success',
        source: 'post_tool_use',
      }),
      event({
        callId: 'mcp-1',
        type: 'mcp',
        target: 'github/get_issue',
        phase: 'reconciled',
        status: 'success',
        source: 'reconciled',
      }),
    ])

    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]).toMatchObject({ callId: 'mcp-1', source: 'reconciled' })
    expect(result.summary.totalCalls).toBe(1)
  })

  test('filters calls by target and start time before calculating turn usage', () => {
    const result = reduceTelemetry([
      event({ callId: 'one', phase: 'completed', status: 'success', timestamp: '2026-07-11T10:00:00.000Z' }),
      event({ callId: 'two', phase: 'completed', status: 'success', timestamp: '2026-07-11T11:00:00.000Z' }),
      event({ callId: 'other', target: 'other-skill', phase: 'completed', status: 'success', timestamp: '2026-07-11T10:30:00.000Z' }),
    ], {
      target: 'tdd',
      startedFrom: '2026-07-11T10:30:00.000Z',
      startedBefore: '2026-07-11T12:00:00.000Z',
    })

    expect(result.calls.map((call) => call.callId)).toEqual(['two'])
    expect(result.summary).toMatchObject({ totalCalls: 1, usedTurnCount: 1 })
  })

  test('is deterministic for out-of-order lifecycle events', () => {
    const completed = event({
      callId: 'ordered',
      phase: 'completed',
      status: 'success',
      timestamp: '2026-07-11T10:00:02.000Z',
    })
    const started = event({ callId: 'ordered', timestamp: '2026-07-11T10:00:01.000Z' })

    expect(reduceTelemetry([completed, started])).toEqual(reduceTelemetry([started, completed]))
  })

  test('returns null rates instead of NaN when no calls match', () => {
    expect(reduceTelemetry([]).summary).toEqual({
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      usedTurnCount: 0,
      successRate: null,
      failureRate: null,
      averageCallsPerUsedTurn: null,
    })
  })
})
