import { describe, expect, test } from 'vitest'
import { LocalApprovalAuthority } from '../src/index.js'
import { canonicalizeJson, digestText, type ManualResultDraft } from '@mutil-skills/e2e-contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function prepareBinding(manualResultId: string) {
  const finalizationId = `PREPARE-${manualResultId}`
  return { finalizationId, requestDigest: digestText('manual-result-request/v1', finalizationId) }
}

function roleBinding(manualResultId: string, role: 'executor' | 'reviewer', attempt = 'primary') {
  const finalizationId = `FINALIZE-${manualResultId}-${role}-${attempt}`
  return { finalizationId, requestDigest: digestText('manual-result-request/v1', finalizationId) }
}

function draft(overrides: Partial<ManualResultDraft> = {}): ManualResultDraft {
  return {
    schemaVersion: '1.0.0', manualResultId: 'MANUAL-RESULT-1', runId: 'RUN-1', assetId: 'ASSET-1',
    prdRevision: digest('a'), generationId: 'GEN-1', manualProcedureId: 'MANUAL-PROCEDURE-1',
    runtimeInstallationDigest: digest('f'),
    caseIds: ['CASE-MANUAL-1'], obligationIds: ['COV-MANUAL-1'], requirementModelDigest: digest('b'),
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
  test('requires distinct executor and reviewer user-presence sessions before issuing a result', async () => {
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    const sessions = new Map<string, any>([
      ['SESSION-EXECUTOR', presenceReceipt(candidate, draftDigest, 'executor')],
      ['SESSION-REVIEWER', presenceReceipt(candidate, draftDigest, 'reviewer')],
    ])
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
      manualIdentities: [candidate.executor, candidate.reviewer],
      authenticateManualApproverSession: async (sessionRef) => sessions.get(sessionRef),
    })

    const prepared = await authority.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })
    const executor = await authority.finalizeManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'executor', approvalSessionRef: 'SESSION-EXECUTOR',
      ...roleBinding(candidate.manualResultId, 'executor'),
    })
    expect(executor).toEqual({
      status: 'awaiting-reviewer', manualResultId: candidate.manualResultId,
      draftDigest, nextRole: 'reviewer',
    })
    const reviewer = await authority.finalizeManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'reviewer', approvalSessionRef: 'SESSION-REVIEWER',
      ...roleBinding(candidate.manualResultId, 'reviewer'),
    })

    expect(reviewer.status).toBe('issued')
    if (reviewer.status !== 'issued') throw new Error('manual result not issued')
    expect(reviewer.result.authorityProof.executorPresence).toMatchObject({
      subject: candidate.executor.subject, sessionId: 'SESSION-EXECUTOR', draftDigest,
    })
    expect(reviewer.result.authorityProof.reviewerPresence).toMatchObject({
      subject: candidate.reviewer.subject, sessionId: 'SESSION-REVIEWER', draftDigest,
    })
    expect(authority.verifyManualResult(reviewer.result)).toEqual({ valid: true })
  })

  test('local mode requires two distinct confirmations but does not claim identity or duty separation', async () => {
    const candidate = draft()
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key',
      now: () => new Date('2026-07-11T10:10:00.000Z'),
    })
    const prepared = await authority.prepareLocalManualResult({
      draft: candidate, ...prepareBinding(candidate.manualResultId),
    })
    await authority.finalizeLocalManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'executor', confirmationId: 'CONFIRM-EXECUTOR',
      ...roleBinding(candidate.manualResultId, 'executor'),
    })
    await expect(authority.finalizeLocalManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'reviewer', confirmationId: 'CONFIRM-EXECUTOR',
      ...roleBinding(candidate.manualResultId, 'reviewer', 'reused'),
    })).rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_DUAL_CONTROL_INVALID' })
    const issued = await authority.finalizeLocalManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'reviewer', confirmationId: 'CONFIRM-REVIEWER',
      ...roleBinding(candidate.manualResultId, 'reviewer'),
    })
    expect(issued).toMatchObject({ status: 'issued', result: { authorityProof: {
      approvalAssurance: { approvalMode: 'local-confirmation', identityVerified: false,
        separationOfDutiesVerified: false },
      executorPresence: { subject: 'local-caller', sessionId: 'CONFIRM-EXECUTOR' },
      reviewerPresence: { subject: 'local-caller', sessionId: 'CONFIRM-REVIEWER' },
    } } })
    if (issued.status !== 'issued') throw new Error('manual result not issued')
    expect(authority.verifyManualResult(issued.result)).toEqual({ valid: true })
  })

  test('refuses self-asserted manual identities that are absent from the trusted registry', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
    })
    await expect(authority.prepareManualResult({ draft: draft(), ...prepareBinding(draft().manualResultId) }))
      .rejects.toMatchObject({ code: 'E2E_MANUAL_IDENTITY_UNTRUSTED' })
  })

  test('rejects wrong role order, wrong session role, and a replayed session', async () => {
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    const sessions = new Map<string, any>([
      ['SESSION-EXECUTOR', presenceReceipt(candidate, draftDigest, 'executor')],
      ['SESSION-REVIEWER', presenceReceipt(candidate, draftDigest, 'reviewer')],
    ])
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
      manualIdentities: [candidate.executor, candidate.reviewer],
      authenticateManualApproverSession: async (sessionRef) => {
        const receipt = sessions.get(sessionRef)
        sessions.delete(sessionRef)
        return receipt
      },
    })
    const prepared = await authority.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })

    await expect(authority.finalizeManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'reviewer', approvalSessionRef: 'SESSION-REVIEWER',
      ...roleBinding(candidate.manualResultId, 'reviewer', 'wrong-order'),
    })).rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_ROLE_ORDER_INVALID' })
    await expect(authority.finalizeManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'executor', approvalSessionRef: 'SESSION-REVIEWER',
      ...roleBinding(candidate.manualResultId, 'executor', 'wrong-role'),
    })).rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_SESSION_BINDING_MISMATCH' })
    await authority.finalizeManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'executor', approvalSessionRef: 'SESSION-EXECUTOR',
      ...roleBinding(candidate.manualResultId, 'executor'),
    })
    await expect(authority.finalizeManualResultRole({
      manualResultId: candidate.manualResultId, draftDigest: prepared.draftDigest,
      role: 'reviewer', approvalSessionRef: 'SESSION-EXECUTOR',
      ...roleBinding(candidate.manualResultId, 'reviewer', 'replayed-session'),
    })).rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_SESSION_BINDING_MISMATCH' })
  })

  test('the legacy direct issuer cannot bypass the two user-presence sessions', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
      manualIdentities: [draft().executor, draft().reviewer],
    })

    await expect(authority.issueManualResult({ draft: draft() }))
      .rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_USER_PRESENCE_REQUIRED' })
  })

  test('classifies payload tampering and unknown keys as a safety failure', async () => {
    const { authority, result } = await issueResult()

    expect(authority.verifyManualResult({
      ...result,
      steps: [{ ...result.steps[0]!, observation: '被篡改但仍满足 Schema 的观察值' }],
    })).toEqual({
      valid: false, code: 'E2E_MANUAL_RESULT_SCHEMA_INVALID', impact: 'safety-blocked',
    })
    expect(authority.verifyManualResult({ ...result, injected: true } as typeof result)).toEqual({
      valid: false, code: 'E2E_MANUAL_RESULT_SCHEMA_INVALID', impact: 'safety-blocked',
    })
  })

  test('classifies a correctly signed expired result as incomplete and rejects duplicate issuance', async () => {
    let now = new Date('2026-07-11T10:10:00.000Z')
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    const sessions = new Map<string, any>([
      ['SESSION-EXECUTOR', presenceReceipt(candidate, draftDigest, 'executor')],
      ['SESSION-REVIEWER', presenceReceipt(candidate, draftDigest, 'reviewer')],
    ])
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => now,
      manualIdentities: [candidate.executor, candidate.reviewer],
      authenticateManualApproverSession: async (sessionRef) => sessions.get(sessionRef),
    })
    const prepared = await authority.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })
    await authority.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
      draftDigest: prepared.draftDigest, role: 'executor', approvalSessionRef: 'SESSION-EXECUTOR',
      ...roleBinding(candidate.manualResultId, 'executor') })
    const issued = await authority.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
      draftDigest: prepared.draftDigest, role: 'reviewer', approvalSessionRef: 'SESSION-REVIEWER',
      ...roleBinding(candidate.manualResultId, 'reviewer') })
    if (issued.status !== 'issued') throw new Error('manual result not issued')
    await expect(authority.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) }))
      .resolves.toEqual({ manualResultId: candidate.manualResultId, draftDigest, nextRole: 'executor' })
    now = new Date('2026-07-13T10:10:00.000Z')

    expect(authority.verifyManualResult(issued.result)).toEqual({
      valid: false, code: 'E2E_MANUAL_RESULT_EXPIRED', impact: 'incomplete',
    })
  })

  test('persists the pending draft and executor proof across restart without replaying the executor session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-manual-result-'))
    const statePath = join(directory, 'approval.sqlite')
    const stateEncryptionKey = randomBytes(32)
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    const sessions = new Map<string, any>([
      ['SESSION-EXECUTOR', presenceReceipt(candidate, draftDigest, 'executor')],
      ['SESSION-REVIEWER', presenceReceipt(candidate, draftDigest, 'reviewer')],
    ])
    const options = {
      issuer: 'local-authority', keyId: 'authority-key',
      now: () => new Date('2026-07-11T10:10:00.000Z'), statePath, stateEncryptionKey,
      testWorkspaceRoots: [process.cwd()], manualIdentities: [candidate.executor, candidate.reviewer],
      authenticateManualApproverSession: async (sessionRef: string) => {
        const receipt = sessions.get(sessionRef)
        sessions.delete(sessionRef)
        return receipt
      },
    }
    try {
      const first = await LocalApprovalAuthority.open(options)
      const prepared = await first.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })
      await first.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
        draftDigest: prepared.draftDigest, role: 'executor', approvalSessionRef: 'SESSION-EXECUTOR',
        ...roleBinding(candidate.manualResultId, 'executor') })
      first.close()

      const second = await LocalApprovalAuthority.open(options)
      await expect(second.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) }))
        .resolves.toEqual({ manualResultId: candidate.manualResultId, draftDigest, nextRole: 'executor' })
      await expect(second.recoverManualResultRole({ manualResultId: candidate.manualResultId,
        draftDigest, role: 'executor', ...roleBinding(candidate.manualResultId, 'executor') }))
        .resolves.toEqual({ status: 'awaiting-reviewer', manualResultId: candidate.manualResultId,
          draftDigest, nextRole: 'reviewer' })
      const issued = await second.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
        draftDigest: prepared.draftDigest, role: 'reviewer', approvalSessionRef: 'SESSION-REVIEWER',
        ...roleBinding(candidate.manualResultId, 'reviewer') })
      expect(issued.status).toBe('issued')
      expect(sessions.has('SESSION-EXECUTOR')).toBe(false)
      second.close()

      const third = await LocalApprovalAuthority.open(options)
      const recovered = await third.recoverManualResultRole({ manualResultId: candidate.manualResultId,
        draftDigest, role: 'reviewer', ...roleBinding(candidate.manualResultId, 'reviewer') })
      expect(recovered).toEqual(issued)
      await expect(third.recoverManualResultRole({ manualResultId: candidate.manualResultId,
        draftDigest, role: 'reviewer', finalizationId: roleBinding(candidate.manualResultId, 'reviewer').finalizationId,
        requestDigest: digestText('manual-result-request/v1', 'different-bytes') }))
        .rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_FINALIZATION_REPLAY_MISMATCH' })
      expect(sessions.size).toBe(0)
      third.close()
    } finally {
      stateEncryptionKey.fill(0)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed when a persisted pending draft expires before reviewer finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-manual-expired-'))
    const statePath = join(directory, 'approval.sqlite')
    const stateEncryptionKey = randomBytes(32)
    const candidate = draft()
    let now = new Date('2026-07-11T10:10:00.000Z')
    const options = {
      issuer: 'local-authority', keyId: 'authority-key', now: () => now,
      statePath, stateEncryptionKey, testWorkspaceRoots: [process.cwd()],
      manualIdentities: [candidate.executor, candidate.reviewer],
      authenticateManualApproverSession: async () => undefined,
    }
    try {
      const first = await LocalApprovalAuthority.open(options)
      const prepared = await first.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })
      first.close()
      now = new Date('2026-07-13T10:10:00.000Z')

      const second = await LocalApprovalAuthority.open(options)
      await expect(second.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
        draftDigest: prepared.draftDigest, role: 'executor', approvalSessionRef: 'SESSION-EXPIRED',
        ...roleBinding(candidate.manualResultId, 'executor') }))
        .rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_VALIDITY_INVALID' })
      second.close()
    } finally {
      stateEncryptionKey.fill(0)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('stops accepting pending drafts at the fixed durable capacity', async () => {
    const base = draft()
    let now = new Date('2026-07-11T10:10:00.000Z')
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'authority-key', now: () => now,
      manualIdentities: [base.executor, base.reviewer],
    })
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = draft({ manualResultId: `MANUAL-RESULT-${index}` })
      await authority.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })
    }
    await expect(authority.prepareManualResult({ draft: draft({ manualResultId: 'MANUAL-RESULT-OVERFLOW' }),
      ...prepareBinding('MANUAL-RESULT-OVERFLOW') }))
      .rejects.toMatchObject({ code: 'E2E_MANUAL_RESULT_CAPACITY_EXHAUSTED' })
    now = new Date('2026-07-13T10:10:00.000Z')
    await expect(authority.prepareManualResult({ draft: draft({
      manualResultId: 'MANUAL-RESULT-RECOVERED',
      startedAt: '2026-07-13T09:00:00.000Z', finishedAt: '2026-07-13T09:05:00.000Z',
      expiresAt: '2026-07-14T09:05:00.000Z',
    }), ...prepareBinding('MANUAL-RESULT-RECOVERED') })).resolves.toMatchObject({ manualResultId: 'MANUAL-RESULT-RECOVERED' })
  })
})

async function issueResult() {
  const candidate = draft()
  const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
  const sessions = new Map<string, any>([
    ['SESSION-EXECUTOR', presenceReceipt(candidate, draftDigest, 'executor')],
    ['SESSION-REVIEWER', presenceReceipt(candidate, draftDigest, 'reviewer')],
  ])
  const authority = LocalApprovalAuthority.create({
    issuer: 'local-authority', keyId: 'authority-key', now: () => new Date('2026-07-11T10:10:00.000Z'),
    manualIdentities: [candidate.executor, candidate.reviewer],
    authenticateManualApproverSession: async (sessionRef) => sessions.get(sessionRef),
  })
  const prepared = await authority.prepareManualResult({ draft: candidate, ...prepareBinding(candidate.manualResultId) })
  await authority.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
    draftDigest: prepared.draftDigest, role: 'executor', approvalSessionRef: 'SESSION-EXECUTOR',
    ...roleBinding(candidate.manualResultId, 'executor') })
  const issued = await authority.finalizeManualResultRole({ manualResultId: candidate.manualResultId,
    draftDigest: prepared.draftDigest, role: 'reviewer', approvalSessionRef: 'SESSION-REVIEWER',
    ...roleBinding(candidate.manualResultId, 'reviewer') })
  if (issued.status !== 'issued') throw new Error('manual result not issued')
  return { authority, result: issued.result }
}

function presenceReceipt(
  candidate: ManualResultDraft,
  draftDigest: string,
  role: 'executor' | 'reviewer',
) {
  return {
    subject: role === 'executor' ? candidate.executor.subject : candidate.reviewer.subject,
    runId: candidate.runId,
    approvalType: role === 'executor' ? 'manual-executor' : 'manual-reviewer',
    subjectDigest: draftDigest,
    installationDigest: candidate.runtimeInstallationDigest,
    origin: role === 'executor' ? 'http://localhost:31001' : 'http://localhost:31002',
    issuedAt: role === 'executor' ? '2026-07-11T10:06:00.000Z' : '2026-07-11T10:07:00.000Z',
    expiresAt: role === 'executor' ? '2026-07-11T10:11:00.000Z' : '2026-07-11T10:12:00.000Z',
  }
}
