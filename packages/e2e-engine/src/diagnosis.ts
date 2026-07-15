import type {
  DiagnosisResult,
  DiagnosticCategory,
  DiagnosticFinding,
  RetrySafetyDecision,
  RetrySafetyInput,
} from '@mutil-skills/e2e-contracts'

const priority: readonly DiagnosticCategory[] = [
  'contract-approval-safety',
  'page-identity',
  'identity-role',
  'data-lease',
  'environment-dependency',
  'automation-binding-evidence',
  'pending-requirement',
  'business-nonconformance',
]

const classification = {
  'contract-approval-safety': ['safety-blocked', 'E2E_DIAG_PRIORITY_CONTRACT_APPROVAL_SAFETY'],
  'page-identity': ['environment-blocked', 'E2E_DIAG_PRIORITY_PAGE_IDENTITY'],
  'identity-role': ['input-blocked', 'E2E_DIAG_PRIORITY_IDENTITY_ROLE'],
  'data-lease': ['input-blocked', 'E2E_DIAG_PRIORITY_DATA_LEASE'],
  'environment-dependency': ['environment-blocked', 'E2E_DIAG_PRIORITY_ENVIRONMENT_DEPENDENCY'],
  'automation-binding-evidence': ['automation-blocked', 'E2E_DIAG_PRIORITY_AUTOMATION_BINDING_EVIDENCE'],
  'pending-requirement': ['pending-decision', 'E2E_DIAG_PRIORITY_PENDING_REQUIREMENT'],
  'business-nonconformance': ['failed', 'E2E_DIAG_PRIORITY_BUSINESS_NONCONFORMANCE'],
} as const

export type { DiagnosticFinding } from '@mutil-skills/e2e-contracts'

export function classifyFailure(input: { findings: DiagnosticFinding[] }): DiagnosisResult {
  for (const [index, category] of priority.entries()) {
    const findings = input.findings
      .filter((finding) => finding.category === category)
      .sort((left, right) => left.code.localeCompare(right.code))
    const primary = findings[0]
    if (!primary) continue
    const [status, classifierRuleCode] = classification[category]
    return {
      status,
      primaryCategory: category,
      classifierRuleCode,
      observation: primary.observation,
      evidenceRefs: [...new Set(primary.evidenceRefs)].sort(),
      excludedCategories: priority.slice(0, index),
      findingCode: primary.code,
    }
  }
  return {
    status: 'safety-blocked',
    primaryCategory: 'unclassified',
    classifierRuleCode: 'E2E_DIAG_UNCLASSIFIED_FAIL_CLOSED',
    observation: '没有足够事实按受支持规则完成分类',
    evidenceRefs: [],
    excludedCategories: [...priority],
    findingCode: 'E2E_DIAG_NO_SUPPORTED_FINDING',
  }
}

export function evaluateRetrySafety(input: RetrySafetyInput): RetrySafetyDecision {
  if (!Number.isSafeInteger(input.currentSlot) || input.currentSlot < 0) {
    return denied('E2E_RETRY_SLOT_INVALID')
  }
  if (input.status === 'failed') return denied('E2E_RETRY_BUSINESS_FAILURE_DENIED')
  if (input.effect !== 'read' && ['applied', 'unknown'].includes(input.effectObservation)) {
    return denied('E2E_RETRY_WRITE_EFFECT_UNSAFE')
  }
  if (input.retryPolicy === 'none') return denied('E2E_RETRY_POLICY_NONE')
  if (input.status !== 'automation-blocked') return denied('E2E_RETRY_STATUS_NOT_ELIGIBLE')

  if (
    input.effect === 'read'
    && input.effectObservation === 'not-applicable'
    && input.retryPolicy === 'read-automation-max-2'
  ) {
    if (input.currentSlot >= 2) return denied('E2E_RETRY_SLOT_LIMIT_REACHED')
    return allowed(input, input.currentSlot + 1, 'E2E_RETRY_READ_AUTOMATION_ALLOWED')
  }

  if (input.effect === 'reversible-write' && input.retryPolicy === 'verified-not-applied-max-1') {
    if (input.effectObservation !== 'proven-not-applied') return denied('E2E_RETRY_WRITE_EFFECT_UNSAFE')
    if (!input.reservationSafeToVoid) return denied('E2E_RETRY_WRITE_RESERVATION_UNSAFE')
    if (input.currentSlot >= 1) return denied('E2E_RETRY_SLOT_LIMIT_REACHED')
    return allowed(input, input.currentSlot + 1, 'E2E_RETRY_WRITE_PROVEN_NOT_APPLIED_ALLOWED')
  }

  return denied('E2E_RETRY_POLICY_EFFECT_MISMATCH')
}

function allowed(input: RetrySafetyInput, nextSlot: number, reasonCode: string): RetrySafetyDecision {
  return { allowed: true, nextSlot, nextMode: input.mode, reasonCode }
}

function denied(reasonCode: string): RetrySafetyDecision {
  return { allowed: false, reasonCode }
}
