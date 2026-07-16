export interface VerificationPlan {
  planId: string
  probes: Array<{
    probeId: string
    kind: 'ui' | 'resource-state' | 'external-effect'
    required: boolean
  }>
}

export interface VerificationObservation {
  probeId: string
  valueDigest: string
}

export type EffectObservation = 'not-applicable' | 'proven-not-applied' | 'applied' | 'unknown'
export type CleanupStatus = 'not-needed' | 'verified-clean' | 'failed' | 'unknown'
