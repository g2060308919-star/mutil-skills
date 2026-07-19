import { describe, expect, test } from 'vitest'
import {
  approvalModeFromTrustedFacts,
  assertCurrentLocalApprovalConfirmation,
  createPendingLocalApprovalConfirmation,
} from '../src/local-approval-confirmations.js'

const digest = (char: string) => `sha256:${char.repeat(64)}`
const now = new Date('2026-07-19T00:00:00.000Z')

describe('local approval confirmations', () => {
  test('binds a bounded challenge to project, Runtime, workflow and exact subject', () => {
    const confirmation = createPendingLocalApprovalConfirmation({
      approvalType: 'privacy', subjectDigest: digest('a'), projectIdentityDigest: digest('b'),
      runtimeInstallationDigest: digest('c'), workflowState: 'diagnosing', now,
      summary: {
        runId: 'RUN-1', approvalType: 'privacy', environmentId: 'TEST', riskTier: 'test',
        origins: [], methods: [], actionCount: 0, effects: ['privacy-unlock'], maxUses: 1,
        secretRefs: [], dataLeaseRefs: [], cleanupRefs: [], injectionClassifications: [],
        subjectDigest: digest('a'), expiresAt: '2026-07-19T00:10:00.000Z',
      },
    })
    expect(assertCurrentLocalApprovalConfirmation(confirmation, {
      confirmationId: confirmation.confirmationId, subjectDigest: digest('a'),
      projectIdentityDigest: digest('b'), runtimeInstallationDigest: digest('c'),
      workflowState: 'diagnosing', now,
    })).toEqual(confirmation)
  })

  test.each([
    ['confirmationId', 'CONFIRM-other'], ['subjectDigest', digest('d')],
    ['projectIdentityDigest', digest('d')], ['runtimeInstallationDigest', digest('d')],
    ['workflowState', 'finalizing'],
  ] as const)('rejects changed %s', (key, value) => {
    const confirmation = challenge()
    expect(() => assertCurrentLocalApprovalConfirmation(confirmation, {
      confirmationId: confirmation.confirmationId, subjectDigest: digest('a'),
      projectIdentityDigest: digest('b'), runtimeInstallationDigest: digest('c'),
      workflowState: 'awaiting-execution-approval', now, [key]: value,
    })).toThrow(expect.objectContaining({ code: 'E2E_LOCAL_CONFIRMATION_BINDING_MISMATCH' }))
  })

  test('rejects expiry and defaults legacy Runs to webauthn', () => {
    const confirmation = challenge()
    expect(() => assertCurrentLocalApprovalConfirmation(confirmation, {
      confirmationId: confirmation.confirmationId, subjectDigest: digest('a'),
      projectIdentityDigest: digest('b'), runtimeInstallationDigest: digest('c'),
      workflowState: 'awaiting-execution-approval', now: new Date(confirmation.expiresAt),
    })).toThrow(expect.objectContaining({ code: 'E2E_LOCAL_CONFIRMATION_EXPIRED' }))
    expect(approvalModeFromTrustedFacts({})).toBe('webauthn')
    expect(approvalModeFromTrustedFacts({ 'approval-mode': 'local-confirmation' })).toBe('local-confirmation')
  })
})

function challenge() {
  return createPendingLocalApprovalConfirmation({
    approvalType: 'privacy', subjectDigest: digest('a'), projectIdentityDigest: digest('b'),
    runtimeInstallationDigest: digest('c'), workflowState: 'awaiting-execution-approval', now,
    summary: {
      runId: 'RUN-1', approvalType: 'privacy', environmentId: 'TEST', riskTier: 'test',
      origins: ['https://test.example.com'], methods: ['POST'], actionCount: 1,
      effects: ['reversible-write'], maxUses: 1, secretRefs: [], dataLeaseRefs: ['LEASE-1'],
      cleanupRefs: ['CLEANUP-1'], injectionClassifications: [], subjectDigest: digest('a'),
      expiresAt: '2026-07-19T00:10:00.000Z',
    },
  })
}
