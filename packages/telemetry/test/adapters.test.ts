import { describe, expect, test } from 'vitest'
import { normalizeHookEvent } from '../src/index.js'

const options = {
  projectSecret: 'test-secret',
  now: () => new Date('2026-07-11T10:00:00.000Z'),
}

describe('normalizeHookEvent', () => {
  test('normalizes Claude Code MCP success and failure with preserved error data', () => {
    const common = {
      session_id: 'session-1',
      cwd: '/repo',
      tool_name: 'mcp__github__get_issue',
      tool_input: { issue: 42 },
      tool_use_id: 'tool-1',
    }

    expect(normalizeHookEvent('claude-code', 'PreToolUse', common, options)).toEqual([
      expect.objectContaining({
        type: 'mcp',
        target: 'github/get_issue',
        callId: 'tool-1',
        phase: 'started',
        status: null,
        source: 'pre_tool_use',
      }),
    ])

    expect(normalizeHookEvent('claude-code', 'PostToolUse', {
      ...common,
      tool_response: { content: [{ type: 'text', text: 'issue' }] },
    }, options)).toEqual([
      expect.objectContaining({
        callId: 'tool-1',
        phase: 'completed',
        status: 'success',
        errorCode: null,
        source: 'post_tool_use',
      }),
    ])

    expect(normalizeHookEvent('claude-code', 'PostToolUseFailure', {
      ...common,
      error: { code: 'ETIMEDOUT', message: 'request timed out' },
    }, options)).toEqual([
      expect.objectContaining({
        callId: 'tool-1',
        status: 'failure',
        failureKind: 'timeout',
        errorCode: 'MCP_TIMEOUT',
        nativeErrorCode: 'ETIMEDOUT',
        errorMessage: 'request timed out',
        source: 'post_tool_use_failure',
      }),
    ])
  })

  test('classifies Codex MCP returned failures from PostToolUse', () => {
    const events = normalizeHookEvent('codex', 'PostToolUse', {
      session_id: 'session-2',
      turn_id: 'turn-2',
      cwd: '/repo',
      tool_name: 'mcp__database__query',
      tool_input: { sql: 'select 1' },
      tool_use_id: 'tool-2',
      tool_response: {
        isError: true,
        error: { code: 'DB_DOWN', message: 'database unavailable' },
      },
    }, options)

    expect(events).toEqual([
      expect.objectContaining({
        target: 'database/query',
        status: 'failure',
        failureKind: 'returned_failure',
        errorCode: 'MCP_RETURNED_FAILURE',
        nativeErrorCode: 'DB_DOWN',
        errorMessage: 'database unavailable',
      }),
    ])
  })

  test('counts each SKILL.md content read and ignores search-only commands', () => {
    const common = {
      session_id: 'session-3',
      turn_id: 'turn-3',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_use_id: 'tool-3',
    }

    const reads = normalizeHookEvent('codex', 'PreToolUse', {
      ...common,
      tool_input: {
        command: 'cat "/home/me/.agents/skills/tdd/SKILL.md" "/repo/.codex/skills/review/SKILL.md"',
      },
    }, options)

    expect(reads).toEqual([
      expect.objectContaining({ type: 'skill', target: 'tdd', callId: 'tool-3:skill:0', status: null }),
      expect.objectContaining({ type: 'skill', target: 'review', callId: 'tool-3:skill:1', status: null }),
    ])

    expect(normalizeHookEvent('codex', 'PreToolUse', {
      ...common,
      tool_use_id: 'tool-4',
      tool_input: { command: 'rg "mock" /home/me/.agents/skills/tdd/SKILL.md' },
    }, options)).toEqual([])
  })

  test('counts rejected MCP permission as a failure with its own error code', () => {
    const events = normalizeHookEvent('claude-code', 'PermissionDenied', {
      session_id: 'session-4',
      cwd: '/repo',
      tool_name: 'mcp__github__create_issue',
      tool_input: { title: 'Example' },
      tool_use_id: 'tool-5',
      error: { code: 'USER_DENIED', message: 'User rejected the tool call' },
    }, options)

    expect(events).toEqual([
      expect.objectContaining({
        status: 'failure',
        failureKind: 'rejected',
        errorCode: 'MCP_REJECTED',
        nativeErrorCode: 'USER_DENIED',
        errorMessage: 'User rejected the tool call',
        source: 'permission_denied',
      }),
    ])
  })

  test('classifies a failed SKILL.md read and preserves the native error', () => {
    const events = normalizeHookEvent('codex', 'PostToolUseFailure', {
      session_id: 'session-5',
      turn_id: 'turn-5',
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: { file_path: '/home/me/.agents/skills/tdd/SKILL.md' },
      tool_use_id: 'tool-6',
      error: { code: 'EACCES', message: 'permission denied' },
    }, options)

    expect(events).toEqual([
      expect.objectContaining({
        type: 'skill',
        target: 'tdd',
        callId: 'tool-6:skill:0',
        status: 'failure',
        failureKind: 'permission_denied',
        errorCode: 'SKILL_PERMISSION_DENIED',
        nativeErrorCode: 'EACCES',
        errorMessage: 'permission denied',
      }),
    ])
  })

  test('counts an interrupted MCP call as cancelled', () => {
    const events = normalizeHookEvent('claude-code', 'PostToolUseFailure', {
      session_id: 'session-6',
      cwd: '/repo',
      tool_name: 'mcp__db__query',
      tool_use_id: 'tool-7',
      error: 'User cancelled the operation',
      is_interrupt: true,
    }, options)

    expect(events).toEqual([
      expect.objectContaining({
        status: 'failure',
        failureKind: 'cancelled',
        errorCode: 'MCP_CANCELLED',
        errorMessage: 'User cancelled the operation',
      }),
    ])
  })

  test('does not report a failed Skill command response as success', () => {
    const events = normalizeHookEvent('codex', 'PostToolUse', {
      session_id: 'session-7',
      turn_id: 'turn-7',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_use_id: 'tool-8',
      tool_input: { command: 'cat /skills/tdd/SKILL.md' },
      tool_response: { isError: true, error: { code: 'ENOENT', message: 'no such file' } },
    }, options)

    expect(events).toEqual([
      expect.objectContaining({
        status: 'failure',
        failureKind: 'not_found',
        errorCode: 'SKILL_NOT_FOUND',
        nativeErrorCode: 'ENOENT',
      }),
    ])
  })

  test('accepts Codex camelCase hook payload fields', () => {
    const events = normalizeHookEvent('codex', 'PreToolUse', {
      sessionId: 'session-8',
      turnId: 'turn-8',
      cwd: '/repo',
      toolName: 'mcp__github__get_issue',
      toolInput: { issue: 42 },
      callId: 'tool-9',
    }, options)

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'session-8',
        turnId: 'turn-8',
        callId: 'tool-9',
        target: 'github/get_issue',
      }),
    ])
  })

  test('normalizes a relative SKILL.md path against the hook working directory', () => {
    const events = normalizeHookEvent('claude-code', 'PreToolUse', {
      session_id: 'session-9',
      cwd: '/repo/.agents/skills/tdd',
      tool_name: 'Read',
      tool_input: { file_path: './SKILL.md' },
      tool_use_id: 'tool-10',
    }, options)

    expect(events).toEqual([
      expect.objectContaining({ target: 'tdd' }),
    ])
  })

  test('requires evidence that SKILL.md content was returned before reporting success', () => {
    const common = {
      session_id: 'session-10',
      cwd: '/repo',
      tool_name: 'Read',
      tool_input: { file_path: '/skills/tdd/SKILL.md' },
      tool_use_id: 'tool-11',
    }

    expect(normalizeHookEvent('claude-code', 'PostToolUse', {
      ...common,
      tool_response: {},
    }, options)).toEqual([])
    expect(normalizeHookEvent('claude-code', 'PostToolUse', {
      ...common,
      tool_response: { content: '# TDD' },
    }, options)).toEqual([
      expect.objectContaining({ status: 'success', target: 'tdd' }),
    ])
  })
})
