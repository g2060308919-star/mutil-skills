import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { normalizeHookEvent, reconcileTranscript, reduceTelemetry } from '../src/index.js'

const options = {
  projectSecret: 'test-secret',
  cwd: '/repo',
  sessionId: 'session-fallback',
  now: () => new Date('2026-07-11T10:00:00.000Z'),
}

describe('reconcileTranscript', () => {
  test.each([
    ['codex' as const, 'codex-mcp-success.jsonl', { totalCalls: 1, successCalls: 1, failureCalls: 0 }],
    ['claude-code' as const, 'claude-skill-retry.jsonl', { totalCalls: 2, successCalls: 1, failureCalls: 1 }],
  ])('parses the redacted %s fixture', async (runtime, fixture, expected) => {
    const transcript = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8')
    const result = reconcileTranscript(runtime, transcript, options)

    expect(result.errors).toEqual([])
    expect(reduceTelemetry(result.events).summary).toEqual(expect.objectContaining(expected))
  })

  test('reconciles Codex calls, closes no-result calls, and preserves one logical turn across continuation ids', () => {
    const transcript = [
      { timestamp: '2026-07-11T09:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'do it', turn_id: 'native-1' } },
      { timestamp: '2026-07-11T09:00:01.000Z', type: 'response_item', payload: { type: 'mcp_tool_call', name: 'mcp__db__query', call_id: 'call-1', arguments: { sql: 'select 1' }, turn_id: 'native-1' } },
      { timestamp: '2026-07-11T09:00:02.000Z', type: 'response_item', payload: { type: 'mcp_tool_call_output', call_id: 'call-1', output: { rows: [1] }, turn_id: 'native-2' } },
      { timestamp: '2026-07-11T09:00:03.000Z', type: 'response_item', payload: { type: 'mcp_tool_call', name: 'mcp__db__query', call_id: 'call-2', arguments: { sql: 'select 2' }, turn_id: 'native-2' } },
    ].map((record) => JSON.stringify(record)).join('\n')

    const result = reconcileTranscript('codex', transcript, options)
    expect(result.errors).toEqual([])

    const reduction = reduceTelemetry(result.events)
    expect(reduction.summary).toEqual({
      totalCalls: 2,
      successCalls: 1,
      failureCalls: 1,
      usedTurnCount: 1,
      successRate: 50,
      failureRate: 50,
      averageCallsPerUsedTurn: 2,
    })
    expect(reduction.calls[1]).toEqual(expect.objectContaining({
      callId: 'call-2',
      status: 'failure',
      failureKind: 'no_result',
      errorCode: 'MCP_NO_RESULT',
      turnId: reduction.calls[0]?.turnId,
    }))
  })

  test('reconciles Claude Code SKILL.md read retries as separate failed and successful attempts', () => {
    const transcript = [
      { type: 'user', sessionId: 'claude-session', cwd: '/repo', message: { content: 'use tdd' } },
      { type: 'assistant', sessionId: 'claude-session', cwd: '/repo', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/skills/tdd/SKILL.md' } }] } },
      { type: 'user', sessionId: 'claude-session', cwd: '/repo', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', is_error: true, content: 'ENOENT: no such file' }] } },
      { type: 'assistant', sessionId: 'claude-session', cwd: '/repo', message: { content: [{ type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: '/skills/tdd/SKILL.md' } }] } },
      { type: 'user', sessionId: 'claude-session', cwd: '/repo', message: { content: [{ type: 'tool_result', tool_use_id: 'read-2', content: '# TDD' }] } },
    ]

    const result = reconcileTranscript('claude-code', transcript, options)
    expect(result.errors).toEqual([])
    expect(reduceTelemetry(result.events).summary).toEqual(expect.objectContaining({
      totalCalls: 2,
      successCalls: 1,
      failureCalls: 1,
      usedTurnCount: 1,
    }))
  })

  test('returns structured parse errors for malformed JSONL without throwing', () => {
    const result = reconcileTranscript('codex', '{"type":"event_msg"}\nnot-json', options)

    expect(result.errors).toEqual([
      expect.objectContaining({ line: 2, code: 'INVALID_JSON' }),
    ])
  })

  test('returns structured errors for unsupported versions and missing runtime fields', () => {
    const result = reconcileTranscript('codex', [
      { schema_version: 99, type: 'response_item', payload: {} },
      { type: 'response_item', payload: { type: 'mcp_tool_call', name: 'mcp__db__query' } },
    ], options)

    expect(result.errors).toEqual([
      expect.objectContaining({ line: 1, code: 'UNSUPPORTED_VERSION' }),
      expect.objectContaining({ line: 2, code: 'MISSING_REQUIRED_FIELD' }),
    ])
  })

  test('rejects transcripts that do not match the selected runtime format', () => {
    const result = reconcileTranscript('codex', [
      { type: 'assistant', message: { content: 'Claude record' } },
    ], options)

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_FORMAT' }),
    ])
  })

  test('confirms a Claude Code direct skill expansion from its transcript command marker', () => {
    const result = reconcileTranscript('claude-code', [
      {
        type: 'user',
        sessionId: 'claude-direct',
        cwd: '/repo',
        message: { content: '<command-name>/tdd</command-name>\n<command-message>tdd</command-message>\n# TDD skill contents' },
      },
    ], options)

    const realtime = normalizeHookEvent('claude-code', 'UserPromptExpansion', {
      session_id: 'claude-direct',
      cwd: '/repo',
      expansion_type: 'slash_command',
      command_name: 'tdd',
      prompt: '/tdd',
    }, options)
    expect(reduceTelemetry([...realtime, ...result.events]).calls).toEqual([
      expect.objectContaining({
        type: 'skill',
        target: 'tdd',
        status: 'success',
        source: 'reconciled',
      }),
    ])
  })

  test('counts the same direct skill once in each real user turn', () => {
    const directMessage = '<command-name>/tdd</command-name>\n<command-message>tdd</command-message>\n# expanded contents'
    const result = reconcileTranscript('claude-code', [
      { type: 'user', sessionId: 'repeat-session', cwd: '/repo', message: { content: directMessage } },
      { type: 'assistant', sessionId: 'repeat-session', cwd: '/repo', message: { content: 'done' } },
      { type: 'user', sessionId: 'repeat-session', cwd: '/repo', message: { content: directMessage } },
    ], options)

    expect(reduceTelemetry(result.events).summary).toEqual(expect.objectContaining({
      totalCalls: 2,
      successCalls: 2,
      usedTurnCount: 2,
    }))
  })

  test('maps a cancelled Skill transcript result to SKILL_CANCELLED', () => {
    const result = reconcileTranscript('claude-code', [
      { type: 'user', sessionId: 'cancel-session', cwd: '/repo', message: { content: 'load it' } },
      { type: 'assistant', sessionId: 'cancel-session', cwd: '/repo', message: { content: [{ type: 'tool_use', id: 'read-cancel', name: 'Read', input: { file_path: '/skills/tdd/SKILL.md' } }] } },
      { type: 'user', sessionId: 'cancel-session', cwd: '/repo', message: { content: [{ type: 'tool_result', tool_use_id: 'read-cancel', status: 'cancelled', content: 'User cancelled' }] } },
    ], options)

    expect(reduceTelemetry(result.events).calls).toEqual([
      expect.objectContaining({ failureKind: 'cancelled', errorCode: 'SKILL_CANCELLED' }),
    ])
  })

  test('maps Codex mcp_tool_call_end Err cancellation to MCP_CANCELLED', () => {
    const result = reconcileTranscript('codex', [
      { type: 'event_msg', payload: { type: 'user_message', message: 'use figma' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'mcp__figma__use_figma', call_id: 'call-cancel', arguments: '{}' } },
      { type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'call-cancel', result: { Err: 'user cancelled MCP tool call' } } },
    ], options)

    expect(reduceTelemetry(result.events).calls).toEqual([
      expect.objectContaining({ failureKind: 'cancelled', errorCode: 'MCP_CANCELLED' }),
    ])
  })
})
