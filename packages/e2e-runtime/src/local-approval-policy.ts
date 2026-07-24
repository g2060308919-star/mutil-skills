import type { ApprovalEffect, ApprovalType, RiskTier } from '@mutil-skills/e2e-contracts'

export type LocalApprovalDisposition =
  | { kind: 'auto-approved'; reasonCode: 'E2E_LOCAL_READ_ONLY_AUTO_APPROVED' }
  | { kind: 'confirmation-required'; reasonCode: string }
  | { kind: 'blocked'; reasonCode: string }

export interface LocalApprovalPolicyInput {
  approvalType: ApprovalType
  riskTier: RiskTier
  effects: readonly (ApprovalEffect | 'unknown')[]
  hasInjection: boolean
  hasPrivacyUnlock: boolean
  hasManualFinalization: boolean
}

export function projectRiskTier(value: unknown): RiskTier {
  return value === 'local' || value === 'test' || value === 'staging' || value === 'production'
    ? value : 'production'
}

export function localApprovalDisposition(input: LocalApprovalPolicyInput): LocalApprovalDisposition {
  if (input.riskTier === 'production') return {
    kind: 'blocked', reasonCode: 'E2E_LOCAL_APPROVAL_PRODUCTION_BLOCKED',
  }
  if (input.effects.some((effect) => effect === 'unknown' || effect === 'irreversible-write')) return {
    kind: 'blocked', reasonCode: 'E2E_LOCAL_APPROVAL_EFFECT_BLOCKED',
  }
  if (input.approvalType === 'execution') return {
    kind: 'confirmation-required', reasonCode: 'E2E_LOCAL_EXECUTION_SEMANTIC_CONFIRMATION_REQUIRED',
  }
  if (input.hasInjection || input.hasPrivacyUnlock || input.hasManualFinalization
    || input.effects.some((effect) => effect !== 'read')) return {
    kind: 'confirmation-required', reasonCode: 'E2E_LOCAL_HIGH_RISK_CONFIRMATION_REQUIRED',
  }
  return { kind: 'auto-approved', reasonCode: 'E2E_LOCAL_READ_ONLY_AUTO_APPROVED' }
}
