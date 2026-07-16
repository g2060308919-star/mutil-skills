import { createHmac, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { CLAUDE_CODE_HOOK_DEFINITIONS } from '../claude-code/config.js'
import { parseClaudeDirectExpansion } from '../claude-code/transcript.js'
import { CODEX_HOOK_DEFINITIONS } from '../codex/config.js'
import { parseCodexSkillInjections } from '../codex/transcript.js'

export type Runtime = 'claude-code' | 'codex'
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionDenied'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'Stop'
  | 'SessionEnd'
export type TargetType = 'mcp' | 'skill'
export type LifecyclePhase = 'started' | 'completed' | 'reconciled'
export type FinalStatus = 'success' | 'failure'
export type FailureKind =
  | 'error'
  | 'timeout'
  | 'returned_failure'
  | 'rejected'
  | 'cancelled'
  | 'not_found'
  | 'permission_denied'
  | 'read_failed'
  | 'no_result'
  | 'unknown_error'
export type TelemetrySource =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'post_tool_use_failure'
  | 'permission_denied'
  | 'user_prompt_expansion'
  | 'stop_transcript'
  | 'session_end_transcript'
  | 'reconciled'

export interface TelemetryLog {
  prompt: unknown
  input: unknown
  output: unknown
  error: unknown
}

export interface TelemetryLifecycleEvent {
  schemaVersion: 1
  runtime: Runtime
  type: TargetType
  target: string
  callId: string
  sessionId: string
  turnId: string
  nativeTurnId: string | null
  phase: LifecyclePhase
  status: FinalStatus | null
  failureKind: FailureKind | null
  errorCode: string | null
  nativeErrorCode: string | null
  errorMessage: string | null
  timestamp: string
  projectHash: string
  source: TelemetrySource
  log: TelemetryLog
}

export type FailureDetails = Pick<TelemetryLifecycleEvent, 'failureKind' | 'errorCode' | 'nativeErrorCode' | 'errorMessage'>

export interface TelemetryCall {
  runtime: Runtime
  type: TargetType
  target: string
  callId: string
  sessionId: string
  turnId: string
  nativeTurnIds: string[]
  status: FinalStatus
  failureKind: FailureKind | null
  errorCode: string | null
  nativeErrorCode: string | null
  errorMessage: string | null
  startedAt: string
  completedAt: string
  projectHash: string
  source: TelemetrySource
  log: TelemetryLog
}

export interface TelemetrySummary {
  totalCalls: number
  successCalls: number
  failureCalls: number
  usedTurnCount: number
  successRate: number | null
  failureRate: number | null
  averageCallsPerUsedTurn: number | null
}

export interface TelemetryReduction {
  calls: TelemetryCall[]
  summary: TelemetrySummary
}

export interface TelemetrySink {
  send(event: TelemetryLifecycleEvent): Promise<void>
}

export class NoopTelemetrySink implements TelemetrySink {
  async send(_event: TelemetryLifecycleEvent): Promise<void> {}
}

export function createProjectHash(cwd: string, secret: string): string {
  return createHmac('sha256', secret).update(resolve(cwd)).digest('hex')
}

export interface NormalizeHookOptions {
  projectSecret: string
  now?: () => Date
}

export interface ReconcileTranscriptOptions extends NormalizeHookOptions {
  cwd?: string
  sessionId?: string
}

export interface TranscriptParseError {
  line: number
  code: 'INVALID_JSON' | 'INVALID_RECORD' | 'MISSING_REQUIRED_FIELD' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_FORMAT'
  message: string
}

export interface TranscriptReconciliation {
  events: TelemetryLifecycleEvent[]
  errors: TranscriptParseError[]
}

export function normalizeHookEvent(
  runtime: Runtime,
  eventName: HookEventName,
  input: unknown,
  options: NormalizeHookOptions,
): TelemetryLifecycleEvent[] {
  if (!isRecord(input)) return []
  const payload = canonicalHookPayload(input)
  const toolName = stringValue(payload.tool_name)
  const mcpTarget = toolName ? parseMcpTarget(toolName) : null
  if (!mcpTarget) return normalizeSkillHookEvent(runtime, eventName, payload, options)

  const event = baseEvent(runtime, payload, options, {
    type: 'mcp',
    target: mcpTarget,
    callId: stringValue(payload.tool_use_id) ?? fallbackCallId(runtime, payload, mcpTarget),
  })

  if (eventName === 'PreToolUse') {
    return [{ ...event, phase: 'started', source: 'pre_tool_use' }]
  }
  if (eventName === 'PostToolUse') {
    const returnedFailure = classifyReturnedFailure('mcp', payload.tool_response)
    return [{
      ...event,
      phase: 'completed',
      status: returnedFailure ? 'failure' : 'success',
      ...(returnedFailure ?? {}),
      source: 'post_tool_use',
      log: { ...event.log, output: payload.tool_response ?? null },
    }]
  }
  if (eventName === 'PostToolUseFailure') {
    const failure = payload.is_interrupt === true
      ? rejectedFailure('mcp', payload.error, true)
      : classifyFailure('mcp', payload.error)
    return [{
      ...event,
      phase: 'completed',
      status: 'failure',
      ...failure,
      source: 'post_tool_use_failure',
      log: { ...event.log, error: payload.error ?? null },
    }]
  }
  if (eventName === 'PermissionDenied') {
    const { nativeErrorCode, errorMessage } = nativeError(payload.error)
    return [{
      ...event,
      phase: 'completed',
      status: 'failure',
      failureKind: 'rejected',
      errorCode: 'MCP_REJECTED',
      nativeErrorCode,
      errorMessage,
      source: 'permission_denied',
      log: { ...event.log, error: payload.error ?? null },
    }]
  }
  return []
}

function canonicalHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    session_id: payload.session_id ?? payload.sessionId,
    turn_id: payload.turn_id ?? payload.turnId,
    tool_name: payload.tool_name ?? payload.toolName,
    tool_input: payload.tool_input ?? payload.toolInput ?? payload.arguments,
    tool_use_id: payload.tool_use_id ?? payload.toolUseId ?? payload.call_id ?? payload.callId,
    tool_response: payload.tool_response ?? payload.toolResponse ?? payload.output,
    error: payload.error ?? payload.reason,
    is_interrupt: payload.is_interrupt ?? payload.isInterrupt,
  }
}

export function reconcileTranscript(
  runtime: Runtime,
  transcript: string | readonly unknown[],
  options: ReconcileTranscriptOptions,
): TranscriptReconciliation {
  const { records, errors } = parseTranscript(transcript)
  const events: TelemetryLifecycleEvent[] = []
  const started = new Map<string, TelemetryLifecycleEvent[]>()
  const completed = new Set<string>()
  const authoritativeResults = new Set<string>()
  let turnSequence = 0
  let logicalTurnId = `${options.sessionId ?? 'unknown-session'}:turn:0`
  let recognizedRecords = 0

  const beginTurn = (sessionId: string): void => {
    turnSequence += 1
    logicalTurnId = `${sessionId}:turn:${turnSequence}`
  }

  const addStarted = (payload: Record<string, unknown>, timestamp: string | null): void => {
    const normalized = normalizeHookEvent(runtime, 'PreToolUse', withTranscriptDefaults(payload, options), atTimestamp(options, timestamp))
      .map((event) => ({ ...event, turnId: logicalTurnId, source: 'stop_transcript' as const }))
    for (const event of normalized) {
      events.push(event)
      const baseCallId = transcriptBaseCallId(event.callId)
      started.set(baseCallId, [...(started.get(baseCallId) ?? []), event])
    }
  }

  const addCompleted = (callId: string, result: unknown, timestamp: string | null): void => {
    const calls = started.get(callId) ?? []
    for (const call of calls) {
      const failed = transcriptFailure(result)
      const failure = failed
        ? call.type === 'skill'
          ? failed.rejected || failed.cancelled
            ? rejectedFailure('skill', failed.error, failed.cancelled)
            : classifySkillFailure(failed.error, false)
          : failed.rejected || failed.cancelled
            ? rejectedFailure('mcp', failed.error, failed.cancelled)
            : classifyReturnedFailure('mcp', failed.response) ?? classifyFailure('mcp', failed.error)
        : null
      events.push({
        ...call,
        phase: 'reconciled',
        status: failure ? 'failure' : 'success',
        ...(failure ?? { failureKind: null, errorCode: null, nativeErrorCode: null, errorMessage: null }),
        timestamp: timestamp ?? call.timestamp,
        source: 'reconciled',
        log: failure
          ? { ...call.log, output: result, error: failed?.error ?? result }
          : { ...call.log, output: result },
      })
    }
    if (calls.length > 0) completed.add(callId)
  }

  for (const [recordIndex, record] of records.entries()) {
    if (!isRecord(record)) continue
    const line = recordIndex + 1
    if (record.schema_version !== undefined && record.schema_version !== 1) {
      errors.push({ line, code: 'UNSUPPORTED_VERSION', message: 'Unsupported transcript schema version' })
      continue
    }
    const timestamp = stringValue(record.timestamp)
    if (runtime === 'codex') {
      if (['event_msg', 'response_item', 'session_meta', 'turn_context', 'compacted'].includes(stringValue(record.type) ?? '')) {
        recognizedRecords += 1
      }
      const payload = isRecord(record.payload) ? record.payload : record
      const type = stringValue(payload.type)
      const sessionId = stringValue(payload.session_id) ?? options.sessionId ?? 'unknown-session'
      if (type === 'user_message') {
        beginTurn(sessionId)
      } else if (record.type === 'response_item' && type === 'message' && payload.role === 'user') {
        if (turnSequence === 0) beginTurn(sessionId)
        events.push(...codexInjectedSkillEvents(payload, sessionId, logicalTurnId, recordIndex, options, timestamp))
      } else if (type === 'mcp_tool_call' || type === 'function_call') {
        if (!stringValue(payload.name) || !stringValue(payload.call_id)) {
          errors.push({ line, code: 'MISSING_REQUIRED_FIELD', message: 'Tool call requires name and call_id' })
          continue
        }
        addStarted({
          ...payload,
          session_id: sessionId,
          tool_name: payload.name,
          tool_input: payload.arguments,
          tool_use_id: payload.call_id,
        }, timestamp)
      } else if (type === 'mcp_tool_call_output' || type === 'function_call_output') {
        const callId = stringValue(payload.call_id)
        if (!callId) errors.push({ line, code: 'MISSING_REQUIRED_FIELD', message: 'Tool result requires call_id' })
        else if (!authoritativeResults.has(callId)) addCompleted(callId, payload.output ?? payload, timestamp)
      } else if (type === 'mcp_tool_call_end') {
        const callId = stringValue(payload.call_id)
        if (callId) {
          addCompleted(callId, payload.result ?? payload, timestamp)
          authoritativeResults.add(callId)
        }
        else errors.push({ line, code: 'MISSING_REQUIRED_FIELD', message: 'MCP result requires call_id' })
      }
      continue
    }

    if (['user', 'assistant', 'system', 'summary', 'progress', 'file-history-snapshot', 'queue-operation'].includes(stringValue(record.type) ?? '')) {
      recognizedRecords += 1
    }
    const message = isRecord(record.message) ? record.message : {}
    const content = Array.isArray(message.content) ? message.content : []
    const sessionId = stringValue(record.sessionId) ?? options.sessionId ?? 'unknown-session'
    const hasToolResult = content.some((item) => isRecord(item) && item.type === 'tool_result')
    if (record.type === 'user' && !hasToolResult) beginTurn(sessionId)
    const textContent = stringValue(message.content)
    const directExpansion = textContent ? parseClaudeDirectExpansion(textContent) : null
    if (directExpansion) {
      const directEvents = normalizeHookEvent('claude-code', 'UserPromptExpansion', {
        session_id: sessionId,
        cwd: record.cwd,
        expansion_type: 'slash_command',
        command_name: directExpansion.command,
        turn_id: logicalTurnId,
        prompt: textContent,
      }, atTimestamp(options, timestamp))
      for (const event of directEvents) {
        events.push({ ...event, turnId: logicalTurnId, source: 'stop_transcript' })
        events.push({
          ...event,
          turnId: logicalTurnId,
          phase: 'reconciled',
          status: 'success',
          timestamp: timestamp ?? event.timestamp,
          source: 'reconciled',
          log: { ...event.log, output: textContent },
        })
      }
    }
    for (const item of content) {
      if (!isRecord(item)) continue
      if (item.type === 'tool_use') {
        if (!stringValue(item.id) || !stringValue(item.name)) {
          errors.push({ line, code: 'MISSING_REQUIRED_FIELD', message: 'Tool use requires id and name' })
          continue
        }
        addStarted({
          session_id: sessionId,
          cwd: record.cwd,
          tool_name: item.name,
          tool_input: item.input,
          tool_use_id: item.id,
        }, timestamp)
      } else if (item.type === 'tool_result') {
        const callId = stringValue(item.tool_use_id)
        if (callId) addCompleted(callId, item, timestamp)
        else errors.push({ line, code: 'MISSING_REQUIRED_FIELD', message: 'Tool result requires tool_use_id' })
      }
    }
  }

  if (records.length > 0 && recognizedRecords === 0) {
    errors.push({ line: 1, code: 'UNKNOWN_FORMAT', message: `Transcript does not match ${runtime} format` })
  }

  for (const [baseCallId, calls] of started) {
    if (completed.has(baseCallId)) continue
    for (const call of calls) {
      events.push({
        ...call,
        phase: 'reconciled',
        status: 'failure',
        failureKind: 'no_result',
        errorCode: `${call.type.toUpperCase()}_NO_RESULT`,
        timestamp: (options.now ?? (() => new Date()))().toISOString(),
        source: 'reconciled',
      })
    }
  }

  return { events, errors }
}

function parseTranscript(transcript: string | readonly unknown[]): { records: unknown[], errors: TranscriptParseError[] } {
  if (typeof transcript !== 'string') return { records: [...transcript], errors: [] }
  const records: unknown[] = []
  const errors: TranscriptParseError[] = []
  for (const [index, line] of transcript.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const record: unknown = JSON.parse(line)
      if (isRecord(record)) records.push(record)
      else errors.push({ line: index + 1, code: 'INVALID_RECORD', message: 'Transcript line must contain an object' })
    } catch {
      errors.push({ line: index + 1, code: 'INVALID_JSON', message: 'Transcript line is not valid JSON' })
    }
  }
  return { records, errors }
}

function inferClaudePromptTurnId(transcript: string, sessionId: string): string {
  const { records } = parseTranscript(transcript)
  const userMessages = records.filter((record) => {
    if (!isRecord(record) || record.type !== 'user') return false
    const message = isRecord(record.message) ? record.message : {}
    const content = Array.isArray(message.content) ? message.content : []
    return !content.some((item) => isRecord(item) && item.type === 'tool_result')
  })
  const last = userMessages.at(-1)
  const lastMessage = isRecord(last) && isRecord(last.message) ? stringValue(last.message.content) : null
  const includesCurrentExpansion = lastMessage?.includes('<command-name>') === true
  const sequence = userMessages.length + (includesCurrentExpansion ? 0 : 1)
  return `${sessionId}:turn:${Math.max(sequence, 1)}`
}

function withTranscriptDefaults(payload: Record<string, unknown>, options: ReconcileTranscriptOptions): Record<string, unknown> {
  return {
    cwd: options.cwd ?? process.cwd(),
    session_id: options.sessionId ?? 'unknown-session',
    ...payload,
  }
}

function atTimestamp(options: NormalizeHookOptions, timestamp: string | null): NormalizeHookOptions {
  return timestamp ? { ...options, now: () => new Date(timestamp) } : options
}

function transcriptBaseCallId(callId: string): string {
  return callId.replace(/:skill:\d+$/, '')
}

function transcriptFailure(result: unknown): { error: unknown, response: unknown, rejected: boolean, cancelled: boolean } | null {
  if (typeof result === 'string') {
    const rejected = /reject|denied|not[_ ]executed/i.test(result)
    const cancelled = /cancelled|canceled/i.test(result)
    const failed = rejected || cancelled || /timed?\s*out|\bfailed\b|\berror\b/i.test(result)
    return failed ? { error: result, response: { isError: true, error: result }, rejected, cancelled } : null
  }
  if (!isRecord(result)) return null
  const status = stringValue(result.status)?.toLowerCase()
  const errValue = result.Err ?? result.error
  const content = stringValue(result.content) ?? stringValue(result.message) ?? stringValue(errValue) ?? ''
  const rejected = status === 'rejected' || /reject|denied|not[_ ]executed/i.test(content)
  const cancelled = status === 'cancelled' || /cancelled|canceled/i.test(content)
  const failed = result.is_error === true || result.isError === true || result.Err !== undefined || rejected || cancelled || ['error', 'failed', 'failure'].includes(status ?? '')
  if (!failed) return null
  const error = errValue ?? { code: stringValue(result.code), message: content || null }
  return { error, response: { ...result, isError: true, error }, rejected, cancelled }
}

function rejectedFailure(type: TargetType, error: unknown, cancelled: boolean): FailureDetails {
  const { nativeErrorCode, errorMessage } = nativeError(error)
  return {
    failureKind: cancelled ? 'cancelled' : 'rejected',
    errorCode: `${type.toUpperCase()}_${cancelled ? 'CANCELLED' : 'REJECTED'}`,
    nativeErrorCode,
    errorMessage,
  }
}

function nativeError(error: unknown): Pick<FailureDetails, 'nativeErrorCode' | 'errorMessage'> {
  return {
    nativeErrorCode: isRecord(error) ? stringValue(error.code) : null,
    errorMessage: isRecord(error)
      ? stringValue(error.message) ?? stableStringify(error)
      : typeof error === 'string' ? error : error == null ? null : String(error),
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value) ?? String(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function normalizeSkillHookEvent(
  runtime: Runtime,
  eventName: string,
  payload: Record<string, unknown>,
  options: NormalizeHookOptions,
): TelemetryLifecycleEvent[] {
  const toolName = stringValue(payload.tool_name)
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {}
  const targets = eventName === 'UserPromptExpansion'
    ? directSkillTargets(payload)
    : detectSkillTargets(toolName, toolInput, stringValue(payload.cwd) ?? process.cwd())
  if (targets.length === 0) return []

  const toolUseId = eventName === 'UserPromptExpansion'
    ? directSkillCallId(runtime, payload, targets.join(','))
    : stringValue(payload.tool_use_id) ?? fallbackCallId(runtime, payload, targets.join(','))
  return targets.map((target, index) => {
    const base = baseEvent(runtime, payload, options, {
      type: 'skill',
      target,
      callId: `${toolUseId}:skill:${index}`,
    })
    if (eventName === 'PreToolUse' || eventName === 'UserPromptExpansion') {
      return {
        ...base,
        phase: 'started',
        source: eventName === 'UserPromptExpansion' ? 'user_prompt_expansion' : 'pre_tool_use',
      }
    }
    if (eventName === 'PostToolUse') {
      if (!hasReturnedContent(payload.tool_response)) return null
      const responseFailure = classifyReturnedFailure('mcp', payload.tool_response)
      const skillFailure = responseFailure
        ? classifySkillFailure(
            isRecord(payload.tool_response) && payload.tool_response.error !== undefined
              ? payload.tool_response.error
              : payload.tool_response,
            false,
          )
        : null
      return {
        ...base,
        phase: 'completed',
        status: skillFailure ? 'failure' : 'success',
        ...(skillFailure ?? {}),
        source: 'post_tool_use',
        log: {
          ...base.log,
          output: payload.tool_response ?? null,
          error: skillFailure ? payload.tool_response ?? null : null,
        },
      }
    }
    if (eventName === 'PostToolUseFailure' || eventName === 'PermissionDenied') {
      const failure = classifySkillFailure(payload.error, eventName === 'PermissionDenied')
      return {
        ...base,
        phase: 'completed',
        status: 'failure',
        ...failure,
        source: eventName === 'PermissionDenied' ? 'permission_denied' : 'post_tool_use_failure',
        log: { ...base.log, error: payload.error ?? null },
      }
    }
    return null
  }).filter((event): event is TelemetryLifecycleEvent => event !== null)
}

function hasReturnedContent(response: unknown): boolean {
  if (typeof response === 'string') return true
  if (Array.isArray(response)) return response.length > 0
  if (!isRecord(response)) return false
  if (classifyReturnedFailure('mcp', response)) return true
  if (typeof response.content === 'string' || Array.isArray(response.content)) return true
  if (typeof response.text === 'string' || typeof response.output === 'string' || typeof response.stdout === 'string') return true
  return isRecord(response.file) && typeof response.file.content === 'string'
}

function directSkillCallId(runtime: Runtime, payload: Record<string, unknown>, target: string): string {
  return createHmac('sha256', runtime)
    .update(JSON.stringify([payload.session_id, payload.turn_id, target]))
    .digest('hex')
}

function codexInjectedSkillEvents(
  payload: Record<string, unknown>,
  sessionId: string,
  turnId: string,
  recordIndex: number,
  options: ReconcileTranscriptOptions,
  timestamp: string | null,
): TelemetryLifecycleEvent[] {
  const content = Array.isArray(payload.content) ? payload.content : []
  const texts = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'input_text')
    .map((item) => stringValue(item.text))
    .filter((text): text is string => text !== null)
  const injections = texts.flatMap(parseCodexSkillInjections)

  return injections.flatMap((injection, injectionIndex) => {
    const callId = createHmac('sha256', 'codex')
      .update(JSON.stringify([sessionId, turnId, recordIndex, injectionIndex, injection.target, injection.path]))
      .digest('hex')
    const base = baseEvent('codex', {
      session_id: sessionId,
      cwd: options.cwd,
      prompt: injection.text,
      tool_input: { skill: injection.target, path: injection.path },
    }, atTimestamp(options, timestamp), {
      type: 'skill',
      target: injection.target,
      callId,
    })
    const started: TelemetryLifecycleEvent = {
      ...base,
      turnId,
      source: 'stop_transcript',
      log: { ...base.log, output: injection.text },
    }
    return [
      started,
      {
        ...started,
        phase: 'reconciled',
        status: 'success',
        failureKind: null,
        errorCode: null,
        nativeErrorCode: null,
        errorMessage: null,
        source: 'reconciled',
        log: { ...started.log, output: injection.text },
      },
    ]
  })
}

function directSkillTargets(payload: Record<string, unknown>): string[] {
  if (payload.expansion_type !== 'slash_command') return []
  const commandName = stringValue(payload.command_name)
  return commandName ? [commandName] : []
}

function detectSkillTargets(toolName: string | null, input: Record<string, unknown>, cwd: string): string[] {
  if (toolName === 'Skill') {
    const name = stringValue(input.skill) ?? stringValue(input.name) ?? stringValue(input.skill_id)
    return name ? [name] : []
  }
  if (toolName === 'Read') {
    const path = stringValue(input.file_path) ?? stringValue(input.path)
    return path ? skillTargetFromPath(path, cwd) : []
  }
  if (toolName && ['Bash', 'shell_command', 'exec_command', 'unified_exec'].includes(toolName)) {
    const command = stringValue(input.command) ?? stringValue(input.cmd)
    return command ? skillTargetsFromShell(command, cwd) : []
  }
  return []
}

function skillTargetsFromShell(command: string, cwd: string): string[] {
  const readers = new Set(['cat', 'sed', 'head', 'tail', 'awk', 'bat'])
  const targets: string[] = []
  for (const segment of command.split(/&&|;|\n/)) {
    const tokens = shellTokens(segment)
    const executable = basename(tokens[0] ?? '')
    if (!readers.has(executable)) continue
    for (const token of tokens.slice(1)) {
      targets.push(...skillTargetFromPath(token, cwd))
    }
  }
  return targets
}

function shellTokens(command: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g
  for (const match of command.matchAll(pattern)) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"' ])/g, '$1'))
  }
  return tokens
}

function skillTargetFromPath(path: string, cwd: string): string[] {
  const cleaned = path.replaceAll('\\', '/').replace(/[),]+$/, '')
  const expanded = cleaned === '~' || cleaned.startsWith('~/')
    ? join(homedir(), cleaned.slice(2))
    : cleaned
  const resolved = resolve(cwd, expanded)
  let normalized = resolved
  try {
    normalized = realpathSync.native(resolved)
  } catch {
    // A missing path is still a Skill attempt and must be classified by its result.
  }
  if (basename(normalized).toLowerCase() !== 'skill.md') return []
  const target = basename(dirname(normalized))
  return target ? [target] : []
}

function classifySkillFailure(error: unknown, rejected: boolean): FailureDetails {
  const { nativeErrorCode, errorMessage } = nativeError(error)
  if (rejected) return { failureKind: 'rejected', errorCode: 'SKILL_REJECTED', nativeErrorCode, errorMessage }
  if (nativeErrorCode === 'ENOENT' || /not found|no such file/i.test(errorMessage ?? '')) {
    return { failureKind: 'not_found', errorCode: 'SKILL_NOT_FOUND', nativeErrorCode, errorMessage }
  }
  if (nativeErrorCode === 'EACCES' || /permission denied/i.test(errorMessage ?? '')) {
    return { failureKind: 'permission_denied', errorCode: 'SKILL_PERMISSION_DENIED', nativeErrorCode, errorMessage }
  }
  if (nativeErrorCode === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(errorMessage ?? '')) {
    return { failureKind: 'timeout', errorCode: 'SKILL_TIMEOUT', nativeErrorCode, errorMessage }
  }
  return { failureKind: 'read_failed', errorCode: 'SKILL_READ_FAILED', nativeErrorCode, errorMessage }
}

function classifyReturnedFailure(type: TargetType, response: unknown): FailureDetails | null {
  if (!isRecord(response)) return null
  const status = stringValue(response.status)?.toLowerCase()
  const failed = response.isError === true || ['error', 'failed', 'failure'].includes(status ?? '') || isRecord(response.error)
  if (!failed) return null
  const nestedError = isRecord(response.error) ? response.error : response
  return {
    failureKind: 'returned_failure',
    errorCode: `${type.toUpperCase()}_RETURNED_FAILURE`,
    ...nativeError(nestedError),
  }
}

function baseEvent(
  runtime: Runtime,
  payload: Record<string, unknown>,
  options: NormalizeHookOptions,
  target: Pick<TelemetryLifecycleEvent, 'type' | 'target' | 'callId'>,
): TelemetryLifecycleEvent {
  const sessionId = stringValue(payload.session_id) ?? 'unknown-session'
  const nativeTurnId = stringValue(payload.turn_id)
  const cwd = stringValue(payload.cwd) ?? process.cwd()
  return {
    schemaVersion: 1,
    runtime,
    ...target,
    sessionId,
    turnId: nativeTurnId ?? `${sessionId}:pending`,
    nativeTurnId,
    phase: 'started',
    status: null,
    failureKind: null,
    errorCode: null,
    nativeErrorCode: null,
    errorMessage: null,
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    projectHash: createProjectHash(cwd, options.projectSecret),
    source: 'pre_tool_use',
    log: {
      prompt: payload.prompt ?? null,
      input: payload.tool_input ?? null,
      output: null,
      error: null,
    },
  }
}

function parseMcpTarget(toolName: string): string | null {
  const match = /^mcp__([^_][\s\S]*?)__([^_][\s\S]*)$/.exec(toolName)
  return match ? `${match[1]}/${match[2]}` : null
}

function classifyFailure(type: TargetType, error: unknown): FailureDetails {
  const { nativeErrorCode, errorMessage } = nativeError(error)
  const timeout = nativeErrorCode === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(errorMessage ?? '')
  return {
    failureKind: timeout ? 'timeout' : 'error',
    errorCode: timeout ? `${type.toUpperCase()}_TIMEOUT` : `${type.toUpperCase()}_ERROR`,
    nativeErrorCode,
    errorMessage,
  }
}

function fallbackCallId(runtime: Runtime, payload: Record<string, unknown>, target: string): string {
  return createHmac('sha256', runtime).update(JSON.stringify([payload.session_id, payload.turn_id, target, payload.tool_input])).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export { reduceTelemetry } from './reducer.js'
export type { TelemetryQuery } from './reducer.js'
export {
  TELEMETRY_VERIFICATION_ROOT,
  TemporaryJsonlTelemetrySink,
  createTemporaryTelemetryVerification,
} from '../../runtime/verification.js'
export type { TemporaryTelemetryVerification } from '../../runtime/verification.js'

export interface ProjectTelemetryOptions {
  cwd: string
  homeDir?: string
}

export interface RunTelemetryHookOptions {
  runtime: Runtime
  eventName: HookEventName
  payload: unknown
  homeDir?: string
  sink?: TelemetrySink
  readTranscript?: (path: string) => Promise<string>
}

export interface HookRunResult {
  skipped: boolean
  eventCount: number
  errors: Array<TranscriptParseError | { code: 'SINK_FAILED' }>
}

export async function runTelemetryHook(options: RunTelemetryHookOptions): Promise<HookRunResult> {
  if (!isRecord(options.payload)) return { skipped: false, eventCount: 0, errors: [] }
  const cwd = stringValue(options.payload.cwd) ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  if (!await isProjectTelemetryEnabled({ cwd, homeDir })) {
    return { skipped: true, eventCount: 0, errors: [] }
  }

  const secret = (await readFile(join(homeDir, '.mutil-skills', 'telemetry.key'), 'utf8')).trim()
  let events: TelemetryLifecycleEvent[]
  let errors: HookRunResult['errors'] = []
  if (options.eventName === 'Stop' || options.eventName === 'SessionEnd') {
    const transcriptPath = stringValue(options.payload.transcript_path)
    if (!transcriptPath) return { skipped: false, eventCount: 0, errors: [] }
    const transcript = await (options.readTranscript ?? ((path) => readFile(path, 'utf8')))(transcriptPath)
    const reconciled = reconcileTranscript(options.runtime, transcript, {
      projectSecret: secret,
      cwd,
      sessionId: stringValue(options.payload.session_id) ?? undefined,
    })
    events = reconciled.events
    errors = reconciled.errors
  } else {
    let payload = options.payload
    if (options.runtime === 'claude-code' && options.eventName === 'UserPromptExpansion') {
      const transcriptPath = stringValue(options.payload.transcript_path)
      if (transcriptPath) {
        const transcript = await (options.readTranscript ?? ((path) => readFile(path, 'utf8')))(transcriptPath)
        payload = {
          ...options.payload,
          turn_id: inferClaudePromptTurnId(
            transcript,
            stringValue(options.payload.session_id) ?? 'unknown-session',
          ),
        }
      }
    }
    events = normalizeHookEvent(options.runtime, options.eventName, payload, { projectSecret: secret })
  }

  const sink = options.sink ?? new NoopTelemetrySink()
  for (const event of events) {
    try {
      await sink.send(event)
    } catch {
      errors.push({ code: 'SINK_FAILED' })
    }
  }
  return { skipped: false, eventCount: events.length, errors }
}

export async function isProjectTelemetryEnabled(options: ProjectTelemetryOptions): Promise<boolean> {
  const cwd = resolve(options.cwd)
  const homeDir = options.homeDir ?? homedir()
  const projectConfig = await readOptionalRecord(join(cwd, '.mutil-skills', 'telemetry.json'))
  if (projectConfig?.enabled === false) return false
  const userConfig = await readOptionalRecord(join(homeDir, '.mutil-skills', 'telemetry.json'))
  const excluded = Array.isArray(userConfig?.excludedProjects)
    ? userConfig.excludedProjects.filter((item): item is string => typeof item === 'string').map((item) => resolve(item))
    : []
  return !excluded.includes(cwd)
}

export type InstallRuntime = Runtime | 'all'

export interface HookInstallationOptions {
  runtime: InstallRuntime
  command: string
  homeDir?: string
}

type HookHandler = { type: 'command', command: string }
type HookGroup = { matcher?: string, hooks: HookHandler[] }
type HookConfiguration = Record<string, unknown> & { hooks?: Record<string, unknown> }

export async function installHooks(options: HookInstallationOptions): Promise<void> {
  const homeDir = options.homeDir ?? homedir()
  await ensureTelemetryKey(homeDir)
  if (options.runtime === 'all' || options.runtime === 'claude-code') {
    await updateHookConfiguration(
      join(homeDir, '.claude', 'settings.json'),
      (config) => addOwnedHooks(config, 'claude-code', options.command, CLAUDE_CODE_HOOK_DEFINITIONS),
    )
  }
  if (options.runtime === 'all' || options.runtime === 'codex') {
    await updateHookConfiguration(
      join(homeDir, '.codex', 'hooks.json'),
      (config) => addOwnedHooks(config, 'codex', options.command, CODEX_HOOK_DEFINITIONS),
    )
  }
}

export async function uninstallHooks(options: HookInstallationOptions): Promise<void> {
  const homeDir = options.homeDir ?? homedir()
  if (options.runtime === 'all' || options.runtime === 'claude-code') {
    await updateExistingHookConfiguration(
      join(homeDir, '.claude', 'settings.json'),
      (config) => removeOwnedHooks(config, 'claude-code', options.command),
    )
  }
  if (options.runtime === 'all' || options.runtime === 'codex') {
    await updateExistingHookConfiguration(
      join(homeDir, '.codex', 'hooks.json'),
      (config) => removeOwnedHooks(config, 'codex', options.command),
    )
  }
  const claudeConfig = await readOptionalRecord(join(homeDir, '.claude', 'settings.json'))
  const codexConfig = await readOptionalRecord(join(homeDir, '.codex', 'hooks.json'))
  if (!hasOwnedHooks(claudeConfig, options.command) && !hasOwnedHooks(codexConfig, options.command)) {
    await rm(join(homeDir, '.mutil-skills', 'telemetry.key'), { force: true })
  }
}

function addOwnedHooks(
  config: HookConfiguration,
  runtime: Runtime,
  command: string,
  definitions: readonly (readonly [HookEventName, string, string])[],
): HookConfiguration {
  const hooks: Record<string, unknown> = isRecord(config.hooks) ? { ...config.hooks } : {}
  for (const [eventName, eventFlag, matcher] of definitions) {
    const handlerCommand = `${shellQuote(command)} --runtime ${runtime} --event ${eventFlag}`
    const groups: unknown[] = Array.isArray(hooks[eventName]) ? [...hooks[eventName]] : []
    if (!groups.some((group) => isHookGroup(group) && group.hooks.some((handler) => handler.command === handlerCommand))) {
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: handlerCommand }] })
    }
    hooks[eventName] = groups
  }
  return { ...config, hooks }
}

function removeOwnedHooks(config: HookConfiguration, runtime: Runtime, command: string): HookConfiguration {
  if (!isRecord(config.hooks)) return config
  const prefix = `${shellQuote(command)} --runtime ${runtime} --event `
  const hooks: Record<string, unknown> = {}
  for (const [eventName, rawGroups] of Object.entries(config.hooks)) {
    if (!Array.isArray(rawGroups)) {
      hooks[eventName] = rawGroups
      continue
    }
    const groups = rawGroups
      .map((group) => ({
        group,
        updated: isHookGroup(group)
          ? { ...group, hooks: group.hooks.filter((handler) => !handler.command.startsWith(prefix)) }
          : group,
      }))
      .filter(({ group, updated }) => !isHookGroup(group) || (isHookGroup(updated) && updated.hooks.length > 0))
      .map(({ updated }) => updated)
    if (groups.length > 0) hooks[eventName] = groups
  }
  return { ...config, hooks }
}

function hasOwnedHooks(config: HookConfiguration | null, command: string): boolean {
  if (!config || !isRecord(config.hooks)) return false
  const prefix = `${shellQuote(command)} --runtime `
  return Object.values(config.hooks).some((groups) =>
    Array.isArray(groups) && groups.some((group) =>
      isHookGroup(group) && group.hooks.some((handler) => handler.command.startsWith(prefix)),
    ),
  )
}

function isHookGroup(value: unknown): value is HookGroup {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false
  return value.hooks.every((handler) => isRecord(handler) && handler.type === 'command' && typeof handler.command === 'string')
}

async function ensureTelemetryKey(homeDir: string): Promise<void> {
  const directory = join(homeDir, '.mutil-skills')
  const keyPath = join(directory, 'telemetry.key')
  await mkdir(directory, { recursive: true })
  try {
    await readFile(keyPath, 'utf8')
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
    await writeFile(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  }
  await chmod(keyPath, 0o600)
}

async function updateHookConfiguration(path: string, update: (config: HookConfiguration) => HookConfiguration): Promise<void> {
  const config = await readOptionalRecord(path) ?? {}
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(update(config), null, 2)}\n`)
}

async function updateExistingHookConfiguration(path: string, update: (config: HookConfiguration) => HookConfiguration): Promise<void> {
  const config = await readOptionalRecord(path)
  if (!config) return
  await writeFile(path, `${JSON.stringify(update(config), null, 2)}\n`)
}

async function readOptionalRecord(path: string): Promise<HookConfiguration | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
