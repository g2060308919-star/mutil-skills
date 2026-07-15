import type {
  CleanupStatus,
  EffectObservation,
  VerificationObservation,
  VerificationPlan,
} from '@mutil-skills/e2e-contracts'

export interface EvaluateWriteOutcomeInput {
  plan: VerificationPlan
  gatewayForwardedWriteCount: number
  reservationStatus: 'reserved' | 'completed' | 'unknown'
  before: VerificationObservation[]
  after: VerificationObservation[]
  cleanupStatus: CleanupStatus
}

export interface WriteOutcome {
  effectObservation: EffectObservation
  retryAllowed: boolean
  acceptedCleanup: boolean
}

export function evaluateWriteOutcome(input: EvaluateWriteOutcomeInput): WriteOutcome {
  const acceptedCleanup = ['not-needed', 'verified-clean'].includes(input.cleanupStatus)
  let effectObservation: EffectObservation

  if (input.gatewayForwardedWriteCount === 0) {
    effectObservation = 'proven-not-applied'
  } else if (input.reservationStatus === 'unknown') {
    effectObservation = 'unknown'
  } else {
    effectObservation = evaluateProbes(input.plan, input.before, input.after)
  }

  return {
    effectObservation,
    retryAllowed: effectObservation === 'proven-not-applied' && acceptedCleanup,
    acceptedCleanup,
  }
}

function evaluateProbes(
  plan: VerificationPlan,
  before: VerificationObservation[],
  after: VerificationObservation[],
): EffectObservation {
  const beforeById = new Map(before.map((item) => [item.probeId, item.valueDigest]))
  const afterById = new Map(after.map((item) => [item.probeId, item.valueDigest]))
  const required = plan.probes.filter((probe) => probe.required)
  if (required.some((probe) => !beforeById.has(probe.probeId) || !afterById.has(probe.probeId))) return 'unknown'
  if (required.some((probe) => beforeById.get(probe.probeId) !== afterById.get(probe.probeId))) return 'applied'
  const provesExternalEffects = required.some((probe) => probe.kind === 'external-effect')
  const provesResourceState = required.some((probe) => probe.kind === 'resource-state')
  return provesExternalEffects && provesResourceState ? 'proven-not-applied' : 'unknown'
}

export type { VerificationPlan } from '@mutil-skills/e2e-contracts'
