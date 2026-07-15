import { describe, expect, test } from 'vitest'
import type {
  ManualResult,
  ManualResultVerification,
  VerdictInput,
} from '@mutil-skills/e2e-contracts'
import { computeVerdict, type VerdictDependencies } from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function caseResult(
  status: VerdictInput['caseResults'][number]['status'] = 'passed',
  overrides: Partial<VerdictInput['caseResults'][number]> = {},
): VerdictInput['caseResults'][number] {
  return {
    caseId: 'CASE-1', runId: 'RUN-1', obligationIds: ['COV-1'], status, executionMode: 'real-environment',
    attemptSelection: ['passed', 'failed'].includes(status)
      ? { status: 'valid', attemptId: 'ATTEMPT-1', eventChainDigest: digest('2') }
      : { status: 'not-started' },
    ...overrides,
  }
}

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    schemaVersion: '2.0.0', assetId: 'ASSET-1', generationId: 'GEN-1',
    verdictRuleVersion: '2.0.0', policyDigest: digest('f'),
    universeDigest: digest('1'), prdRevision: digest('a'), requirementModelDigest: digest('b'),
    obligations: [{ obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'] }],
    caseResults: [caseResult()], manualResults: [], pendingDecisionIds: [], safetyFindings: [],
    artifactFindings: [], migrationFindings: [], environmentFindings: [], automationFindings: [],
    gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
    evidenceAudit: { status: 'complete', total: 1, complete: 1, reasonCodes: [] },
    cleanupAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    coverageFacts: {
      requirementDesign: { covered: 1, total: 1 }, rules: { covered: 1, total: 1 },
      criticalNodes: { covered: 1, total: 1 }, roles: { covered: 1, total: 1 },
      stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 1, total: 1 },
    },
    ...overrides,
  }
}

function manualResult(overrides: Partial<ManualResult> = {}): ManualResult {
  return {
    schemaVersion: '1.0.0', manualResultId: 'MANUAL-RESULT-1', assetId: 'ASSET-1',
    prdRevision: digest('a'), generationId: 'GEN-1', manualProcedureId: 'MANUAL-PROCEDURE-1',
    obligationIds: ['COV-MANUAL-1'], requirementModelDigest: digest('b'),
    executor: { subject: 'executor:alice', roles: ['e2e-manual-executor'] },
    reviewer: { subject: 'reviewer:bob', roles: ['e2e-manual-reviewer'] },
    startedAt: '2026-07-11T10:00:00.000Z', finishedAt: '2026-07-11T10:05:00.000Z', outcome: 'passed',
    steps: [{
      stepId: 'MANUAL-STEP-1', instructionDigest: digest('c'), outcome: 'passed', observation: '人工验收完成',
      evidenceDigests: [digest('d')],
    }],
    evidenceDigests: [digest('d')], expiresAt: '2026-07-12T10:05:00.000Z',
    authorityProof: {
      issuer: 'local-authority', keyId: 'authority-key', proofScope: 'local-os-user', algorithm: 'Ed25519',
      signedDigest: digest('e'), signature: 'valid-signature',
    },
    ...overrides,
  }
}

const dependencies: VerdictDependencies = {
  verifyAttemptSelection: () => true,
  verifyManualResult(result): ManualResultVerification {
    if (result.authorityProof.signature === 'invalid-signature') {
      return { valid: false, code: 'E2E_MANUAL_RESULT_SIGNATURE_INVALID', impact: 'safety-blocked' }
    }
    if (result.authorityProof.signature === 'expired-signature') {
      return { valid: false, code: 'E2E_MANUAL_RESULT_EXPIRED', impact: 'incomplete' }
    }
    return { valid: true }
  },
}

describe('computeVerdict complete truth table', () => {
  test('maps every Case status deterministically', () => {
    const statuses: Array<[VerdictInput['caseResults'][number]['status'], string]> = [
      ['passed', 'accepted'],
      ['failed', 'rejected'],
      ['input-blocked', 'incomplete'],
      ['environment-blocked', 'environment-blocked'],
      ['safety-blocked', 'safety-blocked'],
      ['automation-blocked', 'automation-blocked'],
      ['pending-decision', 'pending-decision'],
      ['not-executed-user-declined', 'incomplete'],
      ['manual-required', 'incomplete'],
    ]
    for (const [status, expected] of statuses) {
      expect(computeVerdict(input({ caseResults: [caseResult(status)] }), dependencies).verdict).toBe(expected)
    }
  })

  test('accepts automated, valid manual, and not-applicable dispositions only when all audits are complete', () => {
    const result = computeVerdict(input({
      obligations: [
        { obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'] },
        { obligationId: 'COV-MANUAL-1', necessity: 'required', disposition: 'manual', manualProcedureId: 'MANUAL-PROCEDURE-1' },
        { obligationId: 'COV-NA-1', necessity: 'required', disposition: 'not-applicable', notApplicableRationale: '该产品无批量入口' },
      ],
      manualResults: [manualResult()],
    }), dependencies)

    expect(result).toMatchObject({
      verdict: 'accepted', businessFailuresObserved: [], advisoryFailures: [],
      metrics: {
        requirementDesignCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
        executionCoverage: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
        realPassRate: { status: 'value', numerator: 1, denominator: 1, percentage: 100 },
        injectionPassRate: { status: 'not-applicable' },
      },
    })
  })

  test('applies the fixed top-level priority without discarding observed business failures', () => {
    const failed = [caseResult('failed')]
    const scenarios: Array<[Partial<VerdictInput>, string]> = [
      [{ pendingDecisionIds: ['DECISION-1'], safetyFindings: ['SAFETY-1'], caseResults: failed }, 'pending-decision'],
      [{ safetyFindings: ['SAFETY-1'], caseResults: failed }, 'safety-blocked'],
      [{ artifactFindings: ['ARTIFACT-1'], caseResults: failed }, 'artifact-blocked'],
      [{ migrationFindings: ['MIGRATION-1'], caseResults: failed }, 'migration-required'],
      [{ environmentFindings: ['ENV-1'], caseResults: failed }, 'environment-blocked'],
      [{ automationFindings: ['AUTO-1'], caseResults: failed }, 'automation-blocked'],
      [{ caseResults: failed }, 'rejected'],
      [{ caseResults: [] }, 'incomplete'],
    ]
    for (const [overrides, verdict] of scenarios) {
      const result = computeVerdict(input(overrides), dependencies)
      expect(result.verdict).toBe(verdict)
      if (overrides.caseResults === failed) expect(result.businessFailuresObserved).toEqual(['CASE-1'])
    }
  })

  test('maps manual failed to rejected and unable, expired, missing, or Revision mismatch to incomplete', () => {
    const manualInput = (result?: ManualResult) => input({
      obligations: [{
        obligationId: 'COV-MANUAL-1', necessity: 'required', disposition: 'manual',
        manualProcedureId: 'MANUAL-PROCEDURE-1',
      }],
      caseResults: [], manualResults: result ? [result] : [], evidenceAudit: { status: 'complete', total: 1, complete: 1, reasonCodes: [] },
    })
    const failed = manualResult({
      outcome: 'failed', steps: [{ ...manualResult().steps[0]!, outcome: 'failed' }],
    })
    const unable = manualResult({
      outcome: 'unable', steps: [{ ...manualResult().steps[0]!, outcome: 'unable' }],
    })

    expect(computeVerdict(manualInput(failed), dependencies).verdict).toBe('rejected')
    expect(computeVerdict(manualInput(unable), dependencies).verdict).toBe('incomplete')
    expect(computeVerdict(manualInput(manualResult({
      authorityProof: { ...manualResult().authorityProof, signature: 'expired-signature' },
    })), dependencies).verdict).toBe('incomplete')
    expect(computeVerdict(manualInput(manualResult({ prdRevision: digest('9') })), dependencies).verdict).toBe('incomplete')
    expect(computeVerdict(manualInput(), dependencies).verdict).toBe('incomplete')
  })

  test('maps invalid manual signatures, invalid attempts, and invalid audits to safety-blocked', () => {
    const invalidManual = manualResult({
      authorityProof: { ...manualResult().authorityProof, signature: 'invalid-signature' },
    })
    const manualInput = input({
      obligations: [{
        obligationId: 'COV-MANUAL-1', necessity: 'required', disposition: 'manual',
        manualProcedureId: 'MANUAL-PROCEDURE-1',
      }], caseResults: [], manualResults: [invalidManual],
    })
    expect(computeVerdict(manualInput, dependencies).verdict).toBe('safety-blocked')
    expect(computeVerdict(input({
      caseResults: [caseResult('safety-blocked', { attemptSelection: { status: 'invalid', reasonCode: 'CHAIN_INVALID' } })],
    }), dependencies).verdict).toBe('safety-blocked')
    expect(computeVerdict(input({
      gatewayAudit: { status: 'invalid', required: true, reasonCodes: ['GATEWAY_SIGNATURE_INVALID'] },
    }), dependencies).verdict).toBe('safety-blocked')
    expect(computeVerdict(input({
      evidenceAudit: { status: 'invalid', total: 1, complete: 0, reasonCodes: ['EVIDENCE_DIGEST_INVALID'] },
    }), dependencies).verdict).toBe('safety-blocked')
    expect(computeVerdict(input(), { ...dependencies, verifyAttemptSelection: () => false }).verdict)
      .toBe('safety-blocked')
  })

  test('blocks partial shared-Case references and preserves simultaneous artifact and migration facts', () => {
    expect(computeVerdict(input({
      obligations: [
        { obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'] },
        { obligationId: 'COV-2', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1'] },
      ],
      caseResults: [caseResult('passed', { obligationIds: ['COV-1'] })],
    }), dependencies).verdict).toBe('safety-blocked')

    const result = computeVerdict(input({
      artifactFindings: ['ARTIFACT_CORRUPTED'], migrationFindings: ['MIGRATION_REQUIRED'],
    }), dependencies)
    expect(result.verdict).toBe('artifact-blocked')
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['VERDICT_ARTIFACT_BLOCKED', 'VERDICT_MIGRATION_REQUIRED']))
  })

  test('maps incomplete gateway, evidence, cleanup, input, declined, and manual-required states to incomplete', () => {
    const scenarios: Partial<VerdictInput>[] = [
      { gatewayAudit: { status: 'incomplete', required: true, reasonCodes: ['GATEWAY_MISSING'] } },
      { evidenceAudit: { status: 'incomplete', total: 1, complete: 0, reasonCodes: ['EVIDENCE_MISSING'] } },
      { cleanupAudit: { status: 'incomplete', total: 1, complete: 0, reasonCodes: ['CLEANUP_MISSING'] } },
      { caseResults: [caseResult('input-blocked')] },
      { caseResults: [caseResult('not-executed-user-declined')] },
      { caseResults: [caseResult('manual-required')] },
    ]
    scenarios.forEach((overrides) => expect(computeVerdict(input(overrides), dependencies).verdict).toBe('incomplete'))
  })

  test('keeps advisory failures out of the top-level verdict and uses not-applicable for zero denominators', () => {
    const result = computeVerdict(input({
      obligations: [
        { obligationId: 'COV-NA-1', necessity: 'required', disposition: 'not-applicable', notApplicableRationale: '无该能力' },
        { obligationId: 'COV-ADVISORY-1', necessity: 'advisory', disposition: 'automated', caseIds: ['CASE-A'] },
      ],
      caseResults: [caseResult('failed', {
        caseId: 'CASE-A', obligationIds: ['COV-ADVISORY-1'], executionMode: 'gateway-injection',
      })],
      evidenceAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    }), dependencies)

    expect(result.verdict).toBe('accepted')
    expect(result.advisoryFailures).toEqual(['CASE-A'])
    expect(result.metrics.executionCoverage.status).toBe('not-applicable')
    expect(result.metrics.realPassRate.status).toBe('not-applicable')
    expect(result.metrics.injectionPassRate.status).toBe('not-applicable')
  })

  test('computes blocking rate by required obligation rather than by Case count', () => {
    const result = computeVerdict(input({
      obligations: [{
        obligationId: 'COV-1', necessity: 'required', disposition: 'automated', caseIds: ['CASE-1', 'CASE-2'],
      }],
      caseResults: [
        caseResult('input-blocked'),
        caseResult('input-blocked', { caseId: 'CASE-2' }),
      ],
    }), dependencies)

    expect(result.metrics.blockingRate).toEqual({
      status: 'value', numerator: 1, denominator: 1, percentage: 100,
    })
  })
})
