import { canonicalizeJson, digestText, E2EError } from './common.js'

export type ExecutionResultDomain = 'real-environment' | 'gateway-injection'

export interface ExecutionResultIdentityFact {
  resultId?: string
  caseId: string
  mode: ExecutionResultDomain
  status: string
  baselineResultId?: string
}

/**
 * 结果身份只由业务 Case 与执行域决定，因而不受输入数组顺序影响。
 * 使用摘要而不是拼接 caseId，避免合法的长 caseId 使 resultId 超出 SafeId 上限。
 */
export function deriveExecutionResultId(caseId: string, mode: ExecutionResultDomain): string {
  const domain = mode === 'real-environment' ? 'REAL' : 'INJECTION'
  return `RESULT-${domain}-${digestText(
    'execution-result-identity/v1', canonicalizeJson({ caseId, mode }),
  ).slice('sha256:'.length)}`
}

/** 当前双域协议的闭包校验。任何缺失、碰撞或悬空 baseline 都 fail closed。 */
export function assertExecutionResultIdentities(results: ExecutionResultIdentityFact[]): void {
  const resultIds = new Set<string>()
  const domainKeys = new Set<string>()
  const byResultId = new Map<string, ExecutionResultIdentityFact>()
  for (const result of results) {
    const expectedId = deriveExecutionResultId(result.caseId, result.mode)
    if (result.resultId !== expectedId) identityError('E2E_EXECUTION_RESULT_ID_INVALID')
    if (resultIds.has(result.resultId)) identityError('E2E_EXECUTION_RESULT_ID_DUPLICATE')
    resultIds.add(result.resultId)
    const domainKey = `${result.caseId}\0${result.mode}`
    if (domainKeys.has(domainKey)) identityError('E2E_EXECUTION_RESULT_DOMAIN_DUPLICATE')
    domainKeys.add(domainKey)
    byResultId.set(result.resultId, result)
    if (result.mode === 'real-environment' && result.baselineResultId !== undefined) {
      identityError('E2E_EXECUTION_REAL_BASELINE_FORBIDDEN')
    }
  }
  for (const result of results) {
    if (result.mode !== 'gateway-injection') continue
    if (result.baselineResultId === undefined) identityError('E2E_EXECUTION_INJECTION_BASELINE_REQUIRED')
    const baseline = byResultId.get(result.baselineResultId)
    if (baseline === undefined
      || baseline.mode !== 'real-environment'
      || baseline.caseId !== result.caseId
      || baseline.status !== 'passed') {
      identityError('E2E_EXECUTION_INJECTION_BASELINE_INVALID')
    }
  }
}

/**
 * 旧协议只允许单一 real 域。迁移结果完全确定；旧 injection、部分迁移或 Case 碰撞
 * 无法证明 baseline，因此拒绝猜测。
 */
export function migrateLegacyBrowserResultIdentities<T extends { caseResults: unknown[] }>(
  content: T,
): T & { caseResults: Array<Record<string, unknown> & { resultId: string }> } {
  const snapshot = structuredClone(content) as T & { caseResults: Array<Record<string, unknown>> }
  if (!Array.isArray(snapshot.caseResults)
    || snapshot.caseResults.some((item) => !plain(item))) identityError('E2E_EXECUTION_RESULT_MIGRATION_INVALID')
  const records = snapshot.caseResults as Array<Record<string, unknown>>
  const present = records.filter((item) => typeof item.resultId === 'string').length
  if (present !== 0 && present !== records.length) {
    identityError('E2E_EXECUTION_RESULT_MIGRATION_PARTIAL')
  }
  if (present === 0) {
    const caseIds = new Set<string>()
    for (const item of records) {
      if (typeof item.caseId !== 'string' || item.mode !== 'real-environment' || caseIds.has(item.caseId)) {
        identityError('E2E_EXECUTION_RESULT_MIGRATION_AMBIGUOUS')
      }
      caseIds.add(item.caseId)
      item.resultId = deriveExecutionResultId(item.caseId, 'real-environment')
    }
  }
  assertExecutionResultIdentities(records.map(toIdentityFact))
  return snapshot as T & { caseResults: Array<Record<string, unknown> & { resultId: string }> }
}

function toIdentityFact(value: Record<string, unknown>): ExecutionResultIdentityFact {
  if (typeof value.caseId !== 'string'
    || (value.mode !== 'real-environment' && value.mode !== 'gateway-injection')
    || typeof value.status !== 'string') identityError('E2E_EXECUTION_RESULT_IDENTITY_INVALID')
  return {
    ...(typeof value.resultId === 'string' ? { resultId: value.resultId } : {}),
    caseId: value.caseId,
    mode: value.mode,
    status: value.status,
    ...(typeof value.baselineResultId === 'string' ? { baselineResultId: value.baselineResultId } : {}),
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function identityError(code: string): never {
  throw new E2EError({ code, category: 'artifact', retryable: false, message: code })
}
