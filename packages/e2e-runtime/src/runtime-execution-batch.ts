import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface RuntimeWriteExecutionOutput {
  caseId: string
  actionId: string
  status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
  effectObservation: 'proven-not-applied' | 'applied' | 'unknown'
  resultDigest: string
  gatewayCommit: {
    reservationId: string
    reservationReceiptDigest: string
    outcomeReceiptDigest: string
    committed: true
  }
  cleanup: {
    status: 'verified-clean' | 'failed' | 'unknown'
    resultDigest: string
    leaseReceiptDigest: string
  }
  finalizationFacts?: RuntimeExecutionFinalizationFacts
}

export interface RuntimeExecutionFinalizationFacts {
  gatewayAudit: Record<string, unknown>
  cleanup: Record<string, unknown>
  executionOutcomeReceipt: Record<string, unknown>
  executionOutcomeVerifierMaterial: Record<string, unknown>
  gatewayAuditVerifierMaterial: Record<string, unknown>
  browserMeasurements: Record<string, unknown>
  isolationMeasurements: Record<string, unknown>
}

export interface RuntimeInjectionExecutionOutput {
  caseId: string
  actionId: string
  status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
  resultDigest: string
  completedReservationIds: string[]
  gatewayAudit: {
    source: 'egress-gateway'
    received: number
    matched: number
    forwarded: number
    blocked: number
    bootstrapForwarded: number
    injectionTargetForwarded: number
    byIntent: Record<string, number>
  }
}

/**
 * 单次 attempt 的分域结果容器。真实执行与故障注入永远写入不同 Map，
 * 因此即使 actionId 相同，注入结果也不能替换真实应用结果。
 */
export class RuntimeExecutionBatch {
  readonly runId: string
  readonly attemptId: string
  readonly #realWrites = new Map<string, RuntimeWriteExecutionOutput>()
  readonly #injections = new Map<string, RuntimeInjectionExecutionOutput>()
  readonly #passedRealCases = new Set<string>()
  #retryBlockReason?: 'E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED'

  constructor(input: {
    runId: string
    attemptId: string
    realEnvironmentResults?: RuntimeWriteExecutionOutput[]
  }) {
    if (!SAFE_ID.test(input.runId) || !SAFE_ID.test(input.attemptId)) {
      throw batchError('E2E_RUNTIME_EXECUTION_BATCH_BINDING_INVALID')
    }
    this.runId = input.runId
    this.attemptId = input.attemptId
    for (const result of input.realEnvironmentResults ?? []) {
      const parsed = parseRuntimeWriteExecutionOutput(result)
      if (this.#realWrites.has(parsed.actionId)) {
        throw batchError('E2E_RUNTIME_EXECUTION_RESULT_ALREADY_COMMITTED')
      }
      this.#realWrites.set(parsed.actionId, parsed)
      if (parsed.status === 'passed') this.#passedRealCases.add(parsed.caseId)
    }
  }

  commitRealWrite(value: RuntimeWriteExecutionOutput): RuntimeWriteExecutionOutput {
    const parsed = parseRuntimeWriteExecutionOutput(value)
    if (this.#realWrites.has(parsed.actionId)) {
      throw batchError('E2E_RUNTIME_EXECUTION_RESULT_ALREADY_COMMITTED')
    }
    this.#realWrites.set(parsed.actionId, parsed)
    if (parsed.status === 'passed') this.#passedRealCases.add(parsed.caseId)
    if (parsed.effectObservation === 'unknown') {
      this.#retryBlockReason = 'E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED'
    }
    return structuredClone(parsed)
  }

  commitInjection(value: RuntimeInjectionExecutionOutput): RuntimeInjectionExecutionOutput {
    const parsed = parseRuntimeInjectionExecutionOutput(value)
    if (this.#injections.has(parsed.actionId)) {
      throw batchError('E2E_RUNTIME_EXECUTION_RESULT_ALREADY_COMMITTED')
    }
    if (!this.#passedRealCases.has(parsed.caseId)) {
      throw batchError('E2E_RUNTIME_INJECTION_REAL_RESULT_REQUIRED')
    }
    this.#injections.set(parsed.actionId, parsed)
    return structuredClone(parsed)
  }

  getRealWrite(actionId: string): RuntimeWriteExecutionOutput | undefined {
    const value = this.#realWrites.get(actionId)
    return value === undefined ? undefined : structuredClone(value)
  }

  getInjection(actionId: string): RuntimeInjectionExecutionOutput | undefined {
    const value = this.#injections.get(actionId)
    return value === undefined ? undefined : structuredClone(value)
  }

  get canAutoRetry(): boolean { return this.#retryBlockReason === undefined }
  get retryBlockReason(): string | undefined { return this.#retryBlockReason }

  digest(): string {
    return digestText('runtime-execution-batch/v1', canonicalizeJson({
      runId: this.runId,
      attemptId: this.attemptId,
      domains: {
        realWrite: [...this.#realWrites.values()].sort(byActionId),
        injection: [...this.#injections.values()].sort(byActionId),
      },
      retryBlockReason: this.#retryBlockReason ?? null,
    }))
  }
}

export function parseRuntimeWriteExecutionOutput(value: unknown): RuntimeWriteExecutionOutput {
  const finalizationKeys = plain(value) && Object.hasOwn(value, 'finalizationFacts') ? ['finalizationFacts'] : []
  if (!plain(value) || !exact(value, ['actionId', 'caseId', 'cleanup', 'effectObservation', 'gatewayCommit', 'resultDigest', 'status', ...finalizationKeys])
    || !safeId(value.caseId) || !safeId(value.actionId)
    || !['passed', 'failed', 'environment-blocked', 'safety-blocked'].includes(String(value.status))
    || !['proven-not-applied', 'applied', 'unknown'].includes(String(value.effectObservation))
    || !digest(value.resultDigest) || !plain(value.gatewayCommit)
    || !exact(value.gatewayCommit, ['committed', 'outcomeReceiptDigest', 'reservationId', 'reservationReceiptDigest'])
    || value.gatewayCommit.committed !== true || !safeId(value.gatewayCommit.reservationId)
    || !digest(value.gatewayCommit.reservationReceiptDigest) || !digest(value.gatewayCommit.outcomeReceiptDigest)
    || !plain(value.cleanup) || !exact(value.cleanup, ['leaseReceiptDigest', 'resultDigest', 'status'])
    || !['verified-clean', 'failed', 'unknown'].includes(String(value.cleanup.status))
    || !digest(value.cleanup.resultDigest) || !digest(value.cleanup.leaseReceiptDigest)
    || value.effectObservation === 'applied' && value.status === 'passed' && value.cleanup.status !== 'verified-clean'
    || value.effectObservation === 'unknown' && value.cleanup.status === 'verified-clean'
    || value.finalizationFacts !== undefined && !parseFinalizationFacts(value.finalizationFacts)) {
    throw batchError('E2E_RUNTIME_WRITE_EXECUTOR_OUTPUT_INVALID')
  }
  return structuredClone(value) as unknown as RuntimeWriteExecutionOutput
}

function parseFinalizationFacts(value: unknown): value is RuntimeExecutionFinalizationFacts {
  if (!plain(value) || !exact(value, [
    'browserMeasurements', 'cleanup', 'executionOutcomeReceipt', 'executionOutcomeVerifierMaterial',
    'gatewayAudit', 'gatewayAuditVerifierMaterial', 'isolationMeasurements',
  ])) return false
  return ['browserMeasurements', 'cleanup', 'executionOutcomeReceipt', 'executionOutcomeVerifierMaterial',
    'gatewayAudit', 'gatewayAuditVerifierMaterial', 'isolationMeasurements']
    .every((key) => plain(value[key]) && jsonSafe(value[key], 0))
}

function jsonSafe(value: unknown, depth: number): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 100_000 && value.every((item) => jsonSafe(item, depth + 1))
  return plain(value) && Object.keys(value).length <= 100_000
    && Object.entries(value).every(([key, item]) => key.length <= 256 && jsonSafe(item, depth + 1))
}

export function parseRuntimeInjectionExecutionOutput(value: unknown): RuntimeInjectionExecutionOutput {
  const audit = plain(value) && plain(value.gatewayAudit) ? value.gatewayAudit : undefined
  if (!plain(value) || !exact(value, ['actionId', 'caseId', 'completedReservationIds', 'gatewayAudit', 'resultDigest', 'status'])
    || !safeId(value.caseId) || !safeId(value.actionId)
    || !['passed', 'failed', 'environment-blocked', 'safety-blocked'].includes(String(value.status))
    || !digest(value.resultDigest) || !Array.isArray(value.completedReservationIds)
    || value.completedReservationIds.length === 0 || value.completedReservationIds.some((id) => !safeId(id))
    || new Set(value.completedReservationIds).size !== value.completedReservationIds.length
    || audit === undefined
    || !exact(audit, ['blocked', 'bootstrapForwarded', 'byIntent', 'forwarded',
      'injectionTargetForwarded', 'matched', 'received', 'source'])
    || audit.source !== 'egress-gateway'
    || !counts(audit, ['received', 'matched', 'forwarded', 'blocked',
      'bootstrapForwarded', 'injectionTargetForwarded'])
    || !plain(audit.byIntent)
    || Object.values(audit.byIntent).some((count) => !nonNegativeInteger(count))
    || (audit.received as number) !== (audit.matched as number)
      + (audit.forwarded as number) + (audit.blocked as number)
    || audit.injectionTargetForwarded !== 0
    || (audit.bootstrapForwarded as number) > (audit.forwarded as number)) {
    throw batchError('E2E_RUNTIME_INJECTION_EXECUTOR_OUTPUT_INVALID')
  }
  return structuredClone(value) as unknown as RuntimeInjectionExecutionOutput
}

function counts(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => nonNegativeInteger(value[key]))
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function safeId(value: unknown): value is string { return typeof value === 'string' && SAFE_ID.test(value) }
function digest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value) }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function byActionId(left: { actionId: string }, right: { actionId: string }): number {
  return left.actionId.localeCompare(right.actionId)
}
function batchError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
