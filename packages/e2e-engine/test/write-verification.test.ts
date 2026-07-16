import { describe, expect, test } from 'vitest'
import { evaluateWriteOutcome, type VerificationPlan } from '../src/index.js'

const plan: VerificationPlan = {
  planId: 'VERIFY-ORDER-1',
  probes: [
    { probeId: 'PROBE-STATE', kind: 'resource-state', required: true },
    { probeId: 'PROBE-AUDIT', kind: 'external-effect', required: true },
  ],
}

describe('evaluateWriteOutcome', () => {
  test('does not treat unchanged UI as proof that a write was not applied', () => {
    expect(evaluateWriteOutcome({
      plan,
      gatewayForwardedWriteCount: 1,
      reservationStatus: 'unknown',
      before: [{ probeId: 'PROBE-STATE', valueDigest: 'same' }],
      after: [{ probeId: 'PROBE-STATE', valueDigest: 'same' }],
      cleanupStatus: 'unknown',
    })).toEqual({ effectObservation: 'unknown', retryAllowed: false, acceptedCleanup: false })
  })

  test('proves not-applied when the gateway forwarded no write request', () => {
    expect(evaluateWriteOutcome({
      plan,
      gatewayForwardedWriteCount: 0,
      reservationStatus: 'reserved',
      before: [],
      after: [],
      cleanupStatus: 'not-needed',
    })).toEqual({ effectObservation: 'proven-not-applied', retryAllowed: true, acceptedCleanup: true })
  })

  test('marks an observed state change applied and requires verified cleanup', () => {
    expect(evaluateWriteOutcome({
      plan,
      gatewayForwardedWriteCount: 1,
      reservationStatus: 'completed',
      before: [
        { probeId: 'PROBE-STATE', valueDigest: 'pending' },
        { probeId: 'PROBE-AUDIT', valueDigest: 'none' },
      ],
      after: [
        { probeId: 'PROBE-STATE', valueDigest: 'approved' },
        { probeId: 'PROBE-AUDIT', valueDigest: 'audit-1' },
      ],
      cleanupStatus: 'verified-clean',
    })).toEqual({ effectObservation: 'applied', retryAllowed: false, acceptedCleanup: true })
  })
})
