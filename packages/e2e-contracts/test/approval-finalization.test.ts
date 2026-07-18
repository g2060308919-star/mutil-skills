import { describe, expect, test } from 'vitest'
import {
  ApprovalExecutionBindingSchema,
  ApprovalFinalizationAcknowledgementSchema,
} from '../src/approval-finalization.js'

const acknowledgement = {
  finalizationId: 'FINALIZE-1',
  requestDigest: `sha256:${'a'.repeat(64)}`,
  grantId: 'GRANT-1',
  approvalBinding: {
    runId: 'RUN-1', installationDigest: `sha256:${'b'.repeat(64)}`,
    approvalType: 'execution', subjectDigest: `sha256:${'c'.repeat(64)}`,
  },
}

describe('approval finalization contracts', () => {
  test('parses the shared four-field execution binding strictly', () => {
    expect(ApprovalExecutionBindingSchema.parse(acknowledgement.approvalBinding))
      .toEqual(acknowledgement.approvalBinding)
    expect(ApprovalExecutionBindingSchema.safeParse({
      ...acknowledgement.approvalBinding, authorityTrusted: true,
    }).success).toBe(false)
  })

  test('parses finalization acknowledgement identity and binding as one strict contract', () => {
    expect(ApprovalFinalizationAcknowledgementSchema.parse(acknowledgement)).toEqual(acknowledgement)
    expect(ApprovalFinalizationAcknowledgementSchema.safeParse({
      ...acknowledgement, approvalBinding: { ...acknowledgement.approvalBinding, rebound: true },
    }).success).toBe(false)
    expect(ApprovalFinalizationAcknowledgementSchema.safeParse({
      ...acknowledgement, grantId: '../GRANT-1',
    }).success).toBe(false)
  })
})
