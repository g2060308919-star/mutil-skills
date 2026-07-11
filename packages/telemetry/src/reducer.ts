import type {
  LifecyclePhase,
  Runtime,
  TargetType,
  TelemetryCall,
  TelemetryLifecycleEvent,
  TelemetryLog,
  TelemetryReduction,
} from './index.js'

export interface TelemetryQuery {
  runtime?: Runtime
  type?: TargetType
  target?: string
  projectHash?: string
  startedFrom?: string
  startedBefore?: string
}

const phasePriority: Record<LifecyclePhase, number> = {
  started: 0,
  completed: 1,
  reconciled: 2,
}

export function reduceTelemetry(events: readonly TelemetryLifecycleEvent[], query: TelemetryQuery = {}): TelemetryReduction {
  const grouped = new Map<string, TelemetryLifecycleEvent[]>()
  for (const event of events) {
    const key = `${event.runtime}\u0000${event.callId}`
    grouped.set(key, [...(grouped.get(key) ?? []), event])
  }

  const calls = [...grouped.values()]
    .map(toCall)
    .filter((call): call is TelemetryCall => call !== null)
    .filter((call) => matchesQuery(call, query))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.callId.localeCompare(right.callId))

  const successCalls = calls.filter((call) => call.status === 'success').length
  const failureCalls = calls.length - successCalls
  const usedTurns = new Set(calls.map((call) => `${call.runtime}\u0000${call.sessionId}\u0000${call.turnId}`))
  const totalCalls = calls.length
  const usedTurnCount = usedTurns.size

  return {
    calls,
    summary: {
      totalCalls,
      successCalls,
      failureCalls,
      usedTurnCount,
      successRate: percentage(successCalls, totalCalls),
      failureRate: percentage(failureCalls, totalCalls),
      averageCallsPerUsedTurn: usedTurnCount === 0 ? null : totalCalls / usedTurnCount,
    },
  }
}

function matchesQuery(call: TelemetryCall, query: TelemetryQuery): boolean {
  if (query.runtime && call.runtime !== query.runtime) return false
  if (query.type && call.type !== query.type) return false
  if (query.target && call.target !== query.target) return false
  if (query.projectHash && call.projectHash !== query.projectHash) return false
  if (query.startedFrom && call.startedAt < query.startedFrom) return false
  if (query.startedBefore && call.startedAt >= query.startedBefore) return false
  return true
}

function toCall(events: TelemetryLifecycleEvent[]): TelemetryCall | null {
  const ordered = [...events].sort(compareEvents)
  const finalEvent = [...ordered].reverse().find((event) => event.status !== null)
  if (!finalEvent?.status) return null

  const first = ordered[0]
  const started = ordered.find((event) => event.phase === 'started') ?? first
  const nativeTurnIds = [...new Set(ordered.map((event) => event.nativeTurnId).filter((id): id is string => id !== null))]

  return {
    runtime: finalEvent.runtime,
    type: finalEvent.type,
    target: finalEvent.target,
    callId: finalEvent.callId,
    sessionId: finalEvent.sessionId,
    turnId: finalEvent.turnId,
    nativeTurnIds,
    status: finalEvent.status,
    failureKind: finalEvent.failureKind,
    errorCode: finalEvent.errorCode,
    nativeErrorCode: finalEvent.nativeErrorCode,
    errorMessage: finalEvent.errorMessage,
    startedAt: started.timestamp,
    completedAt: finalEvent.timestamp,
    projectHash: finalEvent.projectHash,
    source: finalEvent.source,
    log: mergeLogs(ordered.map((event) => event.log)),
  }
}

function compareEvents(left: TelemetryLifecycleEvent, right: TelemetryLifecycleEvent): number {
  return left.timestamp.localeCompare(right.timestamp) || phasePriority[left.phase] - phasePriority[right.phase]
}

function mergeLogs(logs: TelemetryLog[]): TelemetryLog {
  const result: TelemetryLog = { prompt: null, input: null, output: null, error: null }
  for (const log of logs) {
    if (log.prompt !== null) result.prompt = log.prompt
    if (log.input !== null) result.input = log.input
    if (log.output !== null) result.output = log.output
    if (log.error !== null) result.error = log.error
  }
  return result
}

function percentage(value: number, total: number): number | null {
  return total === 0 ? null : value / total * 100
}
