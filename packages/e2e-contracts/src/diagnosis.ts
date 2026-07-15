import type { CaseVerdictStatus } from './verdict.js'
import type { EffectObservation } from './verification.js'

export type DiagnosticCategory =
  | 'contract-approval-safety'
  | 'page-identity'
  | 'identity-role'
  | 'data-lease'
  | 'environment-dependency'
  | 'automation-binding-evidence'
  | 'pending-requirement'
  | 'business-nonconformance'

export interface DiagnosticFinding {
  category: DiagnosticCategory
  code: string
  observation: string
  evidenceRefs: string[]
}

export interface DiagnosisResult {
  status: Extract<CaseVerdictStatus, 'failed' | 'input-blocked' | 'environment-blocked' | 'safety-blocked' | 'automation-blocked' | 'pending-decision'>
  primaryCategory: DiagnosticCategory | 'unclassified'
  classifierRuleCode: string
  observation: string
  evidenceRefs: string[]
  excludedCategories: DiagnosticCategory[]
  findingCode: string
}

export type ExecutionMode = 'real-environment' | 'gateway-injection'
export type ExecutionEffect = 'read' | 'reversible-write' | 'irreversible-write'
export type RetryPolicy = 'none' | 'read-automation-max-2' | 'verified-not-applied-max-1'

export interface RetrySafetyInput {
  status: CaseVerdictStatus
  mode: ExecutionMode
  effect: ExecutionEffect
  effectObservation: EffectObservation
  retryPolicy: RetryPolicy
  currentSlot: number
  reservationSafeToVoid: boolean
}

export type RetrySafetyDecision =
  | { allowed: true; nextSlot: number; nextMode: ExecutionMode; reasonCode: string }
  | { allowed: false; reasonCode: string }
