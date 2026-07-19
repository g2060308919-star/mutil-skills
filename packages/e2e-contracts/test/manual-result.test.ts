import { describe, expect, test } from 'vitest'
import {
  ManualResultDraftSchema,
  ManualResultSchema,
  MetricSchema,
  VerdictInputSchema,
  canonicalizeJson,
  digestText,
  deriveExecutionResultId,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function draft() {
  return {
    schemaVersion: '1.0.0',
    manualResultId: 'MANUAL-RESULT-1',
    runId: 'RUN-1',
    assetId: 'ASSET-1',
    prdRevision: digest('a'),
    generationId: 'GEN-1',
    runtimeInstallationDigest: digest('f'),
    manualProcedureId: 'MANUAL-PROCEDURE-1',
    caseIds: ['CASE-MANUAL-1'],
    obligationIds: ['COV-MANUAL-1'],
    requirementModelDigest: digest('b'),
    executor: { subject: 'executor:alice', roles: ['e2e-manual-executor'] },
    reviewer: { subject: 'reviewer:bob', roles: ['e2e-manual-reviewer'] },
    startedAt: '2026-07-11T10:00:00.000Z',
    finishedAt: '2026-07-11T10:05:00.000Z',
    outcome: 'passed' as const,
    steps: [{
      stepId: 'MANUAL-STEP-1', instructionDigest: digest('c'), outcome: 'passed' as const,
      observation: '界面展示与审批记录一致', evidenceDigests: [digest('d')],
    }],
    evidenceDigests: [digest('d')],
    expiresAt: '2026-07-12T10:05:00.000Z',
  }
}

describe('ManualResult contracts', () => {
  test('accepts a complete structured draft and requires an Authority proof for the final result', () => {
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    expect(ManualResultDraftSchema.safeParse(draft()).success).toBe(true)
    expect(ManualResultSchema.safeParse(draft()).success).toBe(false)
    expect(ManualResultSchema.safeParse({
      ...candidate,
      authorityProof: {
        issuer: 'local-authority', keyId: 'authority-key', proofScope: 'local-os-user', algorithm: 'Ed25519',
        signedDigest: digest('e'), signature: 'signature',
        executorPresence: {
          role: 'executor', approvalType: 'manual-executor', requiredRole: 'e2e-manual-executor',
          subject: candidate.executor.subject, sessionId: 'SESSION-EXECUTOR', runId: candidate.runId,
          installationDigest: candidate.runtimeInstallationDigest, draftDigest,
          origin: 'http://localhost:31001', issuedAt: '2026-07-11T10:06:00.000Z',
          expiresAt: '2026-07-11T10:11:00.000Z',
        },
        reviewerPresence: {
          role: 'reviewer', approvalType: 'manual-reviewer', requiredRole: 'e2e-manual-reviewer',
          subject: candidate.reviewer.subject, sessionId: 'SESSION-REVIEWER', runId: candidate.runId,
          installationDigest: candidate.runtimeInstallationDigest, draftDigest,
          origin: 'http://localhost:31002', issuedAt: '2026-07-11T10:07:00.000Z',
          expiresAt: '2026-07-11T10:12:00.000Z',
        },
      },
    }).success).toBe(true)
  })

  test('rejects user-presence proofs rebound to another draft, run, role, subject, or session', () => {
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    const executorPresence = {
      role: 'executor', approvalType: 'manual-executor', requiredRole: 'e2e-manual-executor',
      subject: candidate.executor.subject, sessionId: 'SESSION-1', runId: candidate.runId,
      installationDigest: candidate.runtimeInstallationDigest, draftDigest,
      origin: 'http://localhost:31001', issuedAt: '2026-07-11T10:06:00.000Z',
      expiresAt: '2026-07-11T10:11:00.000Z',
    }
    const reviewerPresence = {
      role: 'reviewer', approvalType: 'manual-reviewer', requiredRole: 'e2e-manual-reviewer',
      subject: candidate.reviewer.subject, sessionId: 'SESSION-2', runId: candidate.runId,
      installationDigest: candidate.runtimeInstallationDigest, draftDigest,
      origin: 'http://localhost:31002', issuedAt: '2026-07-11T10:07:00.000Z',
      expiresAt: '2026-07-11T10:12:00.000Z',
    }
    const result = (overrides: Record<string, unknown>) => ({
      ...candidate,
      authorityProof: {
        issuer: 'local-authority', keyId: 'authority-key', proofScope: 'local-os-user', algorithm: 'Ed25519',
        signedDigest: digest('e'), signature: 'signature', executorPresence, reviewerPresence, ...overrides,
      },
    })

    expect(ManualResultSchema.safeParse(result({ reviewerPresence: {
      ...reviewerPresence, draftDigest: digest('9'),
    } })).success).toBe(false)
    expect(ManualResultSchema.safeParse(result({ reviewerPresence: {
      ...reviewerPresence, runId: 'RUN-OTHER',
    } })).success).toBe(false)
    expect(ManualResultSchema.safeParse(result({ reviewerPresence: {
      ...reviewerPresence, subject: candidate.executor.subject,
    } })).success).toBe(false)
    expect(ManualResultSchema.safeParse(result({ reviewerPresence: {
      ...reviewerPresence, sessionId: executorPresence.sessionId,
    } })).success).toBe(false)
  })

  test('local mode accepts two distinct confirmations by the same unverified caller', () => {
    const candidate = draft()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(candidate))
    const presence = (role: 'executor' | 'reviewer', sessionId: string) => ({
      role, approvalType: `manual-${role}` as const,
      requiredRole: `e2e-manual-${role}` as const,
      subject: 'local-caller', sessionId, runId: candidate.runId,
      installationDigest: candidate.runtimeInstallationDigest, draftDigest,
      origin: 'http://localhost:1', issuedAt: '2026-07-11T10:06:00.000Z',
      expiresAt: '2026-07-11T10:11:00.000Z',
    })
    const local = {
      ...candidate,
      authorityProof: {
        issuer: 'local-authority', keyId: 'authority-key', proofScope: 'local-os-user',
        algorithm: 'Ed25519', signedDigest: digest('e'), signature: 'signature',
        approvalAssurance: { approvalMode: 'local-confirmation', identityVerified: false,
          separationOfDutiesVerified: false },
        executorPresence: presence('executor', 'CONFIRM-EXECUTOR'),
        reviewerPresence: presence('reviewer', 'CONFIRM-REVIEWER'),
      },
    }
    expect(ManualResultSchema.safeParse(local).success).toBe(true)
    expect(ManualResultSchema.safeParse({
      ...local, authorityProof: { ...local.authorityProof,
        reviewerPresence: presence('reviewer', 'CONFIRM-EXECUTOR') },
    }).success).toBe(false)
  })

  test('rejects self-review, invalid chronology, duplicate obligations, and outcome-step contradiction', () => {
    expect(ManualResultDraftSchema.safeParse({
      ...draft(), reviewer: { subject: 'executor:alice', roles: ['e2e-manual-reviewer'] },
    }).success).toBe(false)
    expect(ManualResultDraftSchema.safeParse({
      ...draft(), finishedAt: '2026-07-11T09:59:00.000Z',
    }).success).toBe(false)
    expect(ManualResultDraftSchema.safeParse({
      ...draft(), obligationIds: ['COV-MANUAL-1', 'COV-MANUAL-1'],
    }).success).toBe(false)
    expect(ManualResultDraftSchema.safeParse({
      ...draft(), steps: [{ ...draft().steps[0], outcome: 'failed' }],
    }).success).toBe(false)
    expect(ManualResultDraftSchema.safeParse({
      ...draft(), outcome: 'unable', steps: [
        { ...draft().steps[0], outcome: 'failed' },
        { ...draft().steps[0], stepId: 'MANUAL-STEP-2', outcome: 'unable' },
      ],
    }).success).toBe(false)
  })
})

describe('VerdictInput contract', () => {
  test('rejects impossible metric ratios', () => {
    expect(MetricSchema.safeParse({
      status: 'value', numerator: 2, denominator: 1, percentage: 100,
    }).success).toBe(false)
    expect(MetricSchema.safeParse({
      status: 'value', numerator: 1, denominator: 2, percentage: 60,
    }).success).toBe(false)
  })

  test('requires a closed snapshot of disposition, attempts, manual results, and all publication audits', () => {
    const result = VerdictInputSchema.safeParse({
      schemaVersion: '2.1.0', assetId: 'ASSET-1', generationId: 'GEN-1',
      verdictRuleVersion: '2.0.0', policyDigest: digest('f'),
      universeDigest: digest('1'), prdRevision: digest('a'), requirementModelDigest: digest('b'),
      obligations: [{
        obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'],
      }],
      caseResults: [{
        resultId: deriveExecutionResultId('CASE-1', 'real-environment'),
        caseId: 'CASE-1', runId: 'RUN-1', obligationIds: ['COV-1'], status: 'passed', executionMode: 'real-environment',
        attemptSelection: { status: 'valid', attemptId: 'ATTEMPT-1', eventChainDigest: digest('2') },
      }],
      manualResults: [], pendingDecisionIds: [], safetyFindings: [], artifactFindings: [], migrationFindings: [],
      environmentFindings: [], automationFindings: [],
      gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
      evidenceAudit: { status: 'complete', total: 1, complete: 1, reasonCodes: [] },
      cleanupAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
      coverageFacts: {
        requirementDesign: { covered: 1, total: 1 }, rules: { covered: 1, total: 1 },
        criticalNodes: { covered: 1, total: 1 }, roles: { covered: 1, total: 1 },
        stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 1, total: 1 },
      },
    })

    expect(result.success, result.error?.message).toBe(true)
    expect(VerdictInputSchema.safeParse({ ...result.data, unexpected: true }).success).toBe(false)
    expect(VerdictInputSchema.safeParse({
      ...result.data,
      gatewayAudit: { status: 'valid', required: true, reasonCodes: ['CONTRADICTORY_REASON'] },
    }).success).toBe(false)
    expect(VerdictInputSchema.safeParse({
      ...result.data,
      evidenceAudit: { status: 'incomplete', total: 1, complete: 1, reasonCodes: ['CONTRADICTORY_COUNT'] },
    }).success).toBe(false)
    expect(VerdictInputSchema.safeParse({
      ...result.data,
      obligations: [{
        obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1', 'CASE-1'],
      }],
    }).success).toBe(false)
  })
})
