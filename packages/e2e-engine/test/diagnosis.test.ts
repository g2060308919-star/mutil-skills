import { describe, expect, test } from 'vitest'
import { classifyFailure, evaluateRetrySafety, type DiagnosticFinding } from '../src/index.js'

function finding(category: DiagnosticFinding['category'], code: string): DiagnosticFinding {
  return { category, code, observation: `${category} observation`, evidenceRefs: [`evidence:${code}`] }
}

describe('classifyFailure', () => {
  test('uses the fixed priority and records categories that were checked and excluded', () => {
    const result = classifyFailure({
      findings: [
        finding('business-nonconformance', 'BUSINESS_STATUS_WRONG'),
        finding('environment-dependency', 'DEPENDENCY_UNAVAILABLE'),
        finding('contract-approval-safety', 'GRANT_REVOKED'),
      ],
    })

    expect(result).toEqual({
      status: 'safety-blocked', primaryCategory: 'contract-approval-safety',
      classifierRuleCode: 'E2E_DIAG_PRIORITY_CONTRACT_APPROVAL_SAFETY',
      observation: 'contract-approval-safety observation', evidenceRefs: ['evidence:GRANT_REVOKED'],
      excludedCategories: [], findingCode: 'GRANT_REVOKED',
    })
  })

  test('classifies a comparable product mismatch as failed only after higher categories are clear', () => {
    const result = classifyFailure({ findings: [finding('business-nonconformance', 'ORACLE_MISMATCH')] })

    expect(result).toMatchObject({
      status: 'failed', primaryCategory: 'business-nonconformance',
      excludedCategories: [
        'contract-approval-safety', 'page-identity', 'identity-role', 'data-lease',
        'environment-dependency', 'automation-binding-evidence', 'pending-requirement',
      ],
    })
  })

  test('fails closed when no supported classification can be proven', () => {
    expect(classifyFailure({ findings: [] })).toMatchObject({
      status: 'safety-blocked', primaryCategory: 'unclassified',
      classifierRuleCode: 'E2E_DIAG_UNCLASSIFIED_FAIL_CLOSED',
    })
  })
})

describe('evaluateRetrySafety', () => {
  test('never retries business failures or applied/unknown writes', () => {
    expect(evaluateRetrySafety({
      status: 'failed', mode: 'real-environment', effect: 'read', effectObservation: 'not-applicable',
      retryPolicy: 'read-automation-max-2', currentSlot: 0, reservationSafeToVoid: false,
    })).toMatchObject({ allowed: false, reasonCode: 'E2E_RETRY_BUSINESS_FAILURE_DENIED' })
    for (const effectObservation of ['applied', 'unknown'] as const) {
      expect(evaluateRetrySafety({
        status: 'automation-blocked', mode: 'real-environment', effect: 'reversible-write', effectObservation,
        retryPolicy: 'verified-not-applied-max-1', currentSlot: 0, reservationSafeToVoid: true,
      })).toMatchObject({ allowed: false, reasonCode: 'E2E_RETRY_WRITE_EFFECT_UNSAFE' })
    }
  })

  test('allows read automation failures for slots 1 and 2 only', () => {
    const input = {
      status: 'automation-blocked' as const, mode: 'real-environment' as const,
      effect: 'read' as const, effectObservation: 'not-applicable' as const,
      retryPolicy: 'read-automation-max-2' as const, reservationSafeToVoid: false,
    }
    expect(evaluateRetrySafety({ ...input, currentSlot: 0 })).toEqual({
      allowed: true, nextSlot: 1, nextMode: 'real-environment', reasonCode: 'E2E_RETRY_READ_AUTOMATION_ALLOWED',
    })
    expect(evaluateRetrySafety({ ...input, currentSlot: 1 })).toMatchObject({ allowed: true, nextSlot: 2 })
    expect(evaluateRetrySafety({ ...input, currentSlot: 2 })).toMatchObject({
      allowed: false, reasonCode: 'E2E_RETRY_SLOT_LIMIT_REACHED',
    })
  })

  test('allows one reversible-write retry only when proven not applied and the reservation is safe to void', () => {
    const base = {
      status: 'automation-blocked' as const, mode: 'real-environment' as const,
      effect: 'reversible-write' as const, effectObservation: 'proven-not-applied' as const,
      retryPolicy: 'verified-not-applied-max-1' as const, currentSlot: 0,
    }
    expect(evaluateRetrySafety({ ...base, reservationSafeToVoid: true })).toMatchObject({
      allowed: true, nextSlot: 1, reasonCode: 'E2E_RETRY_WRITE_PROVEN_NOT_APPLIED_ALLOWED',
    })
    expect(evaluateRetrySafety({ ...base, reservationSafeToVoid: false })).toMatchObject({
      allowed: false, reasonCode: 'E2E_RETRY_WRITE_RESERVATION_UNSAFE',
    })
  })

  test('keeps injection retries in injection mode and never falls back to a real environment', () => {
    expect(evaluateRetrySafety({
      status: 'automation-blocked', mode: 'gateway-injection', effect: 'read', effectObservation: 'not-applicable',
      retryPolicy: 'read-automation-max-2', currentSlot: 0, reservationSafeToVoid: false,
    })).toMatchObject({ allowed: true, nextMode: 'gateway-injection' })
  })
})
