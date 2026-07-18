import { digestText } from '@mutil-skills/e2e-contracts'

export const runtimeWriteDigest = (label: string): string =>
  digestText('runtime-write-flow-test/v1', label)

export function realWriteOutput(overrides: Record<string, unknown> = {}) {
  return {
    caseId: 'CASE-1',
    actionId: 'ACTION-WRITE-1',
    status: 'passed' as const,
    effectObservation: 'applied' as const,
    resultDigest: runtimeWriteDigest('real-result'),
    gatewayCommit: {
      reservationId: 'RESERVATION-WRITE-1',
      reservationReceiptDigest: runtimeWriteDigest('reservation-receipt'),
      outcomeReceiptDigest: runtimeWriteDigest('outcome-receipt'),
      committed: true as const,
    },
    cleanup: {
      status: 'verified-clean' as const,
      resultDigest: runtimeWriteDigest('cleanup-result'),
      leaseReceiptDigest: runtimeWriteDigest('lease-release-receipt'),
    },
    ...overrides,
  }
}

export function injectionOutput(overrides: Record<string, unknown> = {}) {
  return {
    caseId: 'CASE-1',
    actionId: 'ACTION-INJECT-1',
    status: 'passed' as const,
    resultDigest: runtimeWriteDigest('injection-result'),
    completedReservationIds: ['RESERVATION-INJECTION-1'],
    gatewayAudit: {
      source: 'egress-gateway' as const,
      received: 1,
      matched: 1,
      forwarded: 0,
      blocked: 0,
      bootstrapForwarded: 0,
      injectionTargetForwarded: 0,
      byIntent: { 'INTENT-INJECT-1': 1 },
    },
    ...overrides,
  }
}
