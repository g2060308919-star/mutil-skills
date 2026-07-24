import { describe, expect, test } from 'vitest'
import { localApprovalDisposition, projectRiskTier } from '../src/local-approval-policy.js'

describe('local approval policy', () => {
  test('treats missing or unknown Project Policy riskTier as production', () => {
    expect(projectRiskTier(undefined)).toBe('production')
    expect(projectRiskTier('sandbox')).toBe('production')
    expect(projectRiskTier('test')).toBe('test')
  })

  test('execution 始终要求确认语义链，其他完整非生产只读主题才自动批准', () => {
    expect(localApprovalDisposition({
      approvalType: 'execution', riskTier: 'test', effects: ['read'],
      hasInjection: false, hasPrivacyUnlock: false, hasManualFinalization: false,
    })).toEqual({ kind: 'confirmation-required',
      reasonCode: 'E2E_LOCAL_EXECUTION_SEMANTIC_CONFIRMATION_REQUIRED' })
    expect(localApprovalDisposition({
      approvalType: 'scope', riskTier: 'local', effects: [],
      hasInjection: false, hasPrivacyUnlock: false, hasManualFinalization: false,
    }).kind).toBe('auto-approved')
  })

  test.each([
    { approvalType: 'execution' as const, effects: ['reversible-write'] as const,
      hasInjection: false, hasPrivacyUnlock: false, hasManualFinalization: false },
    { approvalType: 'execution' as const, effects: ['read'] as const,
      hasInjection: true, hasPrivacyUnlock: false, hasManualFinalization: false },
    { approvalType: 'privacy' as const, effects: [] as const,
      hasInjection: false, hasPrivacyUnlock: true, hasManualFinalization: false },
    { approvalType: 'manual-executor' as const, effects: [] as const,
      hasInjection: false, hasPrivacyUnlock: false, hasManualFinalization: true },
  ])('requires explicit confirmation for high-risk local subject %#', (input) => {
    expect(localApprovalDisposition({ ...input, riskTier: 'test' }).kind).toBe('confirmation-required')
  })

  test('blocks production, irreversible and unknown effects', () => {
    expect(localApprovalDisposition({
      approvalType: 'execution', riskTier: 'production', effects: ['read'],
      hasInjection: false, hasPrivacyUnlock: false, hasManualFinalization: false,
    }).kind).toBe('blocked')
    for (const effect of ['irreversible-write', 'unknown'] as const) {
      expect(localApprovalDisposition({
        approvalType: 'execution', riskTier: 'test', effects: [effect],
        hasInjection: false, hasPrivacyUnlock: false, hasManualFinalization: false,
      }).kind).toBe('blocked')
    }
  })
})
