import {
  CompiledPrdRunPlanSchema,
  canonicalizeJson,
  digestText,
  type CompiledPrdRunPlan,
} from '@mutil-skills/e2e-contracts'

export type CaseExecutionState =
  | 'pending'
  | 'running'
  | 'cleanup'
  | 'passed'
  | 'failed'
  | 'unable'
  | 'safety-blocked'

export interface ScheduledCaseRecord {
  queueOrdinal: number
  caseId: string
  actor: string
  failurePolicy: 'stop-required' | 'continue'
  state: CaseExecutionState
  attemptId?: string
  startedAt?: string
  completedAt?: string
  effectObservation?: 'not-applicable' | 'not-applied' | 'applied' | 'unknown'
  cleanupStatus?: 'not-applicable' | 'verified-clean' | 'failed' | 'unknown'
  terminalReason?: string
}

export interface RuntimeCaseSchedule {
  schemaVersion: '1.0.0'
  compilerDigest: string
  revision: number
  status: 'active' | 'cleanup-required' | 'terminal'
  currentCaseId?: string
  cases: ScheduledCaseRecord[]
  createdAt: string
  updatedAt: string
  scheduleDigest: string
}

export function createCaseSchedule(
  planInput: CompiledPrdRunPlan,
  createdAt: string,
): RuntimeCaseSchedule {
  const plan = CompiledPrdRunPlanSchema.parse(planInput)
  const draft = {
    schemaVersion: '1.0.0' as const,
    compilerDigest: plan.compilerDigest,
    revision: 0,
    status: 'active' as const,
    cases: plan.cases.map((testCase) => ({
      queueOrdinal: testCase.queueOrdinal,
      caseId: testCase.caseId,
      actor: testCase.actor,
      failurePolicy: testCase.failurePolicy,
      state: 'pending' as const,
    })),
    createdAt,
    updatedAt: createdAt,
  }
  return sealSchedule(draft)
}

export function createLegacySingleCaseSchedule(
  input: {
    caseId: string
    actor: string
    failurePolicy: 'stop-required' | 'continue'
  },
  createdAt: string,
): RuntimeCaseSchedule {
  const compilerDigest = digestText(
    'legacy-single-case-schedule/v1',
    canonicalizeJson(input),
  )
  return sealSchedule({
    schemaVersion: '1.0.0',
    compilerDigest,
    revision: 0,
    status: 'active',
    cases: [{
      queueOrdinal: 0,
      caseId: input.caseId,
      actor: input.actor,
      failurePolicy: input.failurePolicy,
      state: 'pending',
    }],
    createdAt,
    updatedAt: createdAt,
  })
}

export function parseCaseSchedule(input: unknown): RuntimeCaseSchedule {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw schedulerError('E2E_RUNTIME_CASE_SCHEDULE_INVALID')
  }
  return validateSchedule(structuredClone(input) as RuntimeCaseSchedule)
}

export function startNextCase(
  input: RuntimeCaseSchedule,
  attempt: { attemptId: string; startedAt: string },
): RuntimeCaseSchedule {
  const schedule = validateSchedule(input)
  if (schedule.status === 'cleanup-required'
    || schedule.cases.some((item) => item.effectObservation === 'unknown')) {
    throw schedulerError('E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED')
  }
  if (schedule.currentCaseId !== undefined || schedule.status !== 'active') {
    throw schedulerError('E2E_RUNTIME_CASE_SCHEDULE_NOT_READY')
  }
  const nextIndex = schedule.cases.findIndex((item) => item.state === 'pending')
  if (nextIndex < 0) throw schedulerError('E2E_RUNTIME_CASE_SCHEDULE_COMPLETE')
  const cases = structuredClone(schedule.cases)
  cases[nextIndex] = {
    ...cases[nextIndex]!,
    state: 'running',
    attemptId: attempt.attemptId,
    startedAt: attempt.startedAt,
  }
  return sealSchedule({
    ...withoutDigest(schedule),
    revision: schedule.revision + 1,
    currentCaseId: cases[nextIndex]!.caseId,
    cases,
    updatedAt: attempt.startedAt,
  })
}

export function completeCase(
  input: RuntimeCaseSchedule,
  completion: {
    caseId: string
    attemptId: string
    status: 'passed' | 'failed' | 'unable' | 'safety-blocked'
    effectObservation: 'not-applicable' | 'not-applied' | 'applied' | 'unknown'
    cleanupStatus: 'not-applicable' | 'verified-clean' | 'failed' | 'unknown'
    completedAt: string
  },
): RuntimeCaseSchedule {
  const schedule = validateSchedule(input)
  const index = schedule.cases.findIndex((item) => item.caseId === completion.caseId)
  const current = schedule.cases[index]
  if (index < 0 || current?.state !== 'running' || current.attemptId !== completion.attemptId
    || schedule.currentCaseId !== completion.caseId) {
    throw schedulerError('E2E_RUNTIME_CASE_COMPLETION_BINDING_INVALID')
  }
  const cases = structuredClone(schedule.cases)
  const needsCleanup = completion.effectObservation === 'unknown'
    || !['not-applicable', 'verified-clean'].includes(completion.cleanupStatus)
  cases[index] = {
    ...current,
    state: needsCleanup ? 'cleanup' : completion.status,
    completedAt: completion.completedAt,
    effectObservation: completion.effectObservation,
    cleanupStatus: completion.cleanupStatus,
  }
  let status: RuntimeCaseSchedule['status'] = needsCleanup ? 'cleanup-required' : 'active'
  if (!needsCleanup && completion.status !== 'passed' && current.failurePolicy === 'stop-required') {
    for (let position = index + 1; position < cases.length; position += 1) {
      if (cases[position]!.state === 'pending') cases[position] = {
        ...cases[position]!, state: 'unable', completedAt: completion.completedAt,
        terminalReason: 'E2E_RUNTIME_REQUIRED_CASE_FAILED',
      }
    }
    status = 'terminal'
  } else if (!needsCleanup && cases.every((item) => terminal(item.state))) {
    status = 'terminal'
  }
  const { currentCaseId: _completedCase, ...base } = withoutDigest(schedule)
  return sealSchedule({
    ...base,
    revision: schedule.revision + 1,
    status,
    cases,
    updatedAt: completion.completedAt,
  })
}

export function recoverCaseSchedule(input: RuntimeCaseSchedule): {
  state: RuntimeCaseSchedule
  next: { kind: 'cleanup'; caseId: string }
    | { kind: 'execute'; caseId: string }
    | { kind: 'finalize' }
} {
  const state = validateSchedule(input)
  const cleanup = state.cases.find((item) => item.state === 'cleanup')
  if (cleanup !== undefined) return { state, next: { kind: 'cleanup', caseId: cleanup.caseId } }
  const pending = state.cases.find((item) => item.state === 'pending')
  if (pending !== undefined && state.status === 'active') {
    return { state, next: { kind: 'execute', caseId: pending.caseId } }
  }
  return { state, next: { kind: 'finalize' } }
}

function validateSchedule(input: RuntimeCaseSchedule): RuntimeCaseSchedule {
  if (input.scheduleDigest !== digestSchedule(input)
    || input.cases.length === 0
    || input.cases.some((item, index) => item.queueOrdinal !== index)
    || new Set(input.cases.map((item) => item.caseId)).size !== input.cases.length) {
    throw schedulerError('E2E_RUNTIME_CASE_SCHEDULE_INVALID')
  }
  return structuredClone(input)
}

function sealSchedule(
  input: Omit<RuntimeCaseSchedule, 'scheduleDigest'>,
): RuntimeCaseSchedule {
  return {
    ...structuredClone(input),
    scheduleDigest: digestSchedule(input),
  }
}

function digestSchedule(input: Omit<RuntimeCaseSchedule, 'scheduleDigest'> | RuntimeCaseSchedule): string {
  const { scheduleDigest: _ignored, ...material } = input as RuntimeCaseSchedule
  return digestText('runtime-case-schedule/v1', canonicalizeJson(material))
}

function withoutDigest(input: RuntimeCaseSchedule): Omit<RuntimeCaseSchedule, 'scheduleDigest'> {
  const { scheduleDigest: _ignored, ...material } = input
  return material
}

function terminal(state: CaseExecutionState): boolean {
  return ['passed', 'failed', 'unable', 'safety-blocked'].includes(state)
}

function schedulerError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
