import { describe, expect, test } from 'vitest'
import { LocalApprovalAuthority } from '../src/index.js'
import type { ManualResultDraft } from '@mutil-skills/e2e-contracts'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function draft(overrides: Partial<ManualResultDraft> = {}): ManualResultDraft {
  return {
    schemaVersion: '1.0.0', manualResultId: 'MANUAL-RESULT-1', assetId: 'ASSET-1',
    prdRevision: digest('a'), generationId: 'GEN-1', manualProcedureId: 'MANUAL-PROCEDURE-1',
    obligationIds: ['COV-MANUAL-1'], requirementModelDigest: digest('b'),
    executor: { subject: 'executor:alice', roles: ['e2e-manual-executor'] },
    reviewer: { subject: 'reviewer:bob', roles: ['e2e-manual-reviewer'] },
    startedAt: '2026-07-11T10:00:00.000Z', finishedAt: '2026-07-11T10:05:00.000Z', outcome: 'passed',
    steps: [{
      stepId: 'MANUAL-STEP-1', instructionDigest: digest('c'), outcome: 'passed',
      observation: '人工验收通过', evidenceDigests: [digest('d')],
    }],
    evidenceDigests: [digest('d')], expiresAt: '2026-07-12T10:05:00.000Z',
    ...overrides,
  }
}

describe('LocalApprovalAuthority ManualResult', () => {
  test('refuses self-asserted manual identities that are absent from the trusted registry', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
    })
    await expect(authority.issueManualResult({ draft: draft() }))
      .rejects.toMatchObject({ code: 'E2E_MANUAL_IDENTITY_UNTRUSTED' })
  })

  test('issues an Ed25519 proof bound to the complete manual result payload', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
      manualIdentities: [draft().executor, draft().reviewer],
    })

    const result = await authority.issueManualResult({ draft: draft() })

    expect(result.authorityProof).toMatchObject({
      issuer: 'local-authority', keyId: 'authority-key', proofScope: 'local-os-user', algorithm: 'Ed25519',
    })
    expect(authority.verifyManualResult(result)).toEqual({ valid: true })
  })

  test('classifies payload tampering and unknown keys as a safety failure', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
      manualIdentities: [draft().executor, draft().reviewer],
    })
    const result = await authority.issueManualResult({ draft: draft() })

    expect(authority.verifyManualResult({
      ...result,
      steps: [{ ...result.steps[0]!, observation: '被篡改但仍满足 Schema 的观察值' }],
    })).toEqual({
      valid: false, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked',
    })
    expect(authority.verifyManualResult({ ...result, injected: true } as typeof result)).toEqual({
      valid: false, code: 'E2E_MANUAL_RESULT_SCHEMA_INVALID', impact: 'safety-blocked',
    })
  })

  test('classifies a correctly signed expired result as incomplete and rejects duplicate issuance', async () => {
    let now = new Date('2026-07-11T10:10:00.000Z')
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => now,
      manualIdentities: [draft().executor, draft().reviewer],
    })
    const result = await authority.issueManualResult({ draft: draft() })
    await expect(authority.issueManualResult({ draft: draft() }))
      .rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_DUPLICATE' })
    now = new Date('2026-07-13T10:10:00.000Z')

    expect(authority.verifyManualResult(result)).toEqual({
      valid: false, code: 'E2E_MANUAL_RESULT_EXPIRED', impact: 'incomplete',
    })
  })
})
