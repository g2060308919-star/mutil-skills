import {
  VerdictInputSchema,
  type CaseVerdictStatus,
  type ManualResult,
  type ManualResultVerification,
  type Metric,
  type VerdictInput,
  type VerdictResult,
} from '@mutil-skills/e2e-contracts'

export interface VerdictDependencies {
  verifyManualResult?(result: ManualResult): ManualResultVerification
  verifyAttemptSelection?(input: {
    assetId: string
    generationId: string
    prdRevision: string
    caseResult: VerdictInput['caseResults'][number]
  }): boolean
}

interface ManualEvaluation {
  outcomes: Map<string, 'passed' | 'failed' | 'unable' | 'incomplete'>
  safetyReasons: string[]
  incompleteReasons: string[]
  failedResultIds: string[]
  advisoryFailureIds: string[]
}

export function computeVerdict(
  candidate: VerdictInput,
  dependencies?: VerdictDependencies,
): VerdictResult {
  const parsed = VerdictInputSchema.safeParse(candidate)
  if (!parsed.success) return invalidInputResult(candidate)
  const input = parsed.data
  const obligations = new Map(input.obligations.map((obligation) => [obligation.obligationId, obligation]))
  const resultByCase = new Map(input.caseResults.map((caseResult) => [caseResult.caseId, caseResult]))
  const requiredAutomated = input.obligations.filter((item) => item.necessity === 'required' && item.disposition === 'automated')
  const requiredManual = input.obligations.filter((item) => item.necessity === 'required' && item.disposition === 'manual')
  const requiredCaseIds = unique(requiredAutomated.flatMap((item) => item.caseIds ?? []))
  const requiredResults = requiredCaseIds.map((caseId) => resultByCase.get(caseId)).filter(isDefined)
  const businessFailuresObserved = unique(input.caseResults.filter((item) => item.status === 'failed').map((item) => item.caseId))
  const advisoryFailures = unique(input.caseResults
    .filter((item) => item.status === 'failed' && item.obligationIds.every((id) => obligations.get(id)?.necessity === 'advisory'))
    .map((item) => item.caseId))
  const referenceSafety = validateReferences(input)
  const manual = evaluateManualResults(input, dependencies)
  const attemptSafety = validateAttemptSelections(input, dependencies)
  businessFailuresObserved.push(...manual.failedResultIds)
  advisoryFailures.push(...manual.advisoryFailureIds)
  const metrics = computeMetrics(input, requiredCaseIds, requiredManual, manual, resultByCase)

  if (input.pendingDecisionIds.length > 0 || requiredResults.some((item) => item.status === 'pending-decision')) {
    return result(input, 'pending-decision', ['VERDICT_PENDING_DECISION'], metrics, businessFailuresObserved, advisoryFailures)
  }

  const safetyReasons = unique([
    ...input.safetyFindings,
    ...referenceSafety,
    ...manual.safetyReasons,
    ...attemptSafety,
    ...(input.gatewayAudit.status === 'invalid' ? ['VERDICT_GATEWAY_AUDIT_INVALID', ...input.gatewayAudit.reasonCodes] : []),
    ...(input.evidenceAudit.status === 'invalid' ? ['VERDICT_EVIDENCE_AUDIT_INVALID', ...input.evidenceAudit.reasonCodes] : []),
    ...(input.cleanupAudit.status === 'invalid' ? ['VERDICT_CLEANUP_AUDIT_INVALID', ...input.cleanupAudit.reasonCodes] : []),
    ...requiredResults.filter((item) => item.status === 'safety-blocked').map(() => 'VERDICT_REQUIRED_CASE_SAFETY_BLOCKED'),
    ...input.caseResults.filter((item) => item.attemptSelection.status === 'invalid').map(() => 'VERDICT_ATTEMPT_CHAIN_INVALID'),
  ])
  if (safetyReasons.length > 0) {
    return result(input, 'safety-blocked', ['VERDICT_SAFETY_BLOCKED', ...safetyReasons], metrics, businessFailuresObserved, advisoryFailures)
  }
  if (input.artifactFindings.length > 0) {
    return result(input, 'artifact-blocked', [
      'VERDICT_ARTIFACT_BLOCKED', ...input.artifactFindings,
      ...(input.migrationFindings.length > 0 ? ['VERDICT_MIGRATION_REQUIRED', ...input.migrationFindings] : []),
    ], metrics, businessFailuresObserved, advisoryFailures)
  }
  if (input.migrationFindings.length > 0) {
    return result(input, 'migration-required', ['VERDICT_MIGRATION_REQUIRED', ...input.migrationFindings], metrics, businessFailuresObserved, advisoryFailures)
  }
  if (input.environmentFindings.length > 0 || requiredResults.some((item) => item.status === 'environment-blocked')) {
    return result(input, 'environment-blocked', ['VERDICT_ENVIRONMENT_BLOCKED', ...input.environmentFindings], metrics, businessFailuresObserved, advisoryFailures)
  }
  if (input.automationFindings.length > 0 || requiredResults.some((item) => item.status === 'automation-blocked')) {
    return result(input, 'automation-blocked', ['VERDICT_AUTOMATION_BLOCKED', ...input.automationFindings], metrics, businessFailuresObserved, advisoryFailures)
  }
  const requiredManualFailed = requiredManual.some((item) => manual.outcomes.get(item.obligationId) === 'failed')
  if (requiredResults.some((item) => item.status === 'failed') || requiredManualFailed) {
    return result(input, 'rejected', ['VERDICT_REQUIRED_OBLIGATION_FAILED'], metrics, businessFailuresObserved, advisoryFailures)
  }

  const incompleteStatuses: CaseVerdictStatus[] = [
    'input-blocked', 'not-executed-user-declined', 'manual-required',
  ]
  const incompleteReasons = unique([
    ...(requiredResults.length < requiredCaseIds.length ? ['VERDICT_REQUIRED_CASE_MISSING'] : []),
    ...(requiredResults.some((item) => incompleteStatuses.includes(item.status)) ? ['VERDICT_REQUIRED_CASE_INCOMPLETE'] : []),
    ...(requiredManual.some((item) => manual.outcomes.get(item.obligationId) !== 'passed')
      ? ['VERDICT_MANUAL_RESULT_INCOMPLETE', ...manual.incompleteReasons] : []),
    ...(input.gatewayAudit.required && input.gatewayAudit.status === 'incomplete'
      ? ['VERDICT_GATEWAY_AUDIT_INCOMPLETE', ...input.gatewayAudit.reasonCodes] : []),
    ...(input.evidenceAudit.status === 'incomplete' ? ['VERDICT_EVIDENCE_INCOMPLETE', ...input.evidenceAudit.reasonCodes] : []),
    ...(input.cleanupAudit.status === 'incomplete' ? ['VERDICT_CLEANUP_INCOMPLETE', ...input.cleanupAudit.reasonCodes] : []),
  ])
  if (incompleteReasons.length > 0) {
    return result(input, 'incomplete', incompleteReasons, metrics, businessFailuresObserved, advisoryFailures)
  }
  return result(
    input,
    'accepted',
    ['VERDICT_ALL_REQUIRED_OBLIGATIONS_SATISFIED'],
    metrics,
    businessFailuresObserved,
    advisoryFailures,
  )
}

function evaluateManualResults(input: VerdictInput, dependencies?: VerdictDependencies): ManualEvaluation {
  const outcomes = new Map<string, 'passed' | 'failed' | 'unable' | 'incomplete'>()
  const safetyReasons: string[] = []
  const incompleteReasons: string[] = []
  const failedResultIds: string[] = []
  const advisoryFailureIds: string[] = []
  const manualObligations = input.obligations.filter((item) => item.disposition === 'manual')
  if ((manualObligations.length > 0 || input.manualResults.length > 0) && !dependencies?.verifyManualResult) {
    safetyReasons.push('VERDICT_MANUAL_AUTHORITY_UNAVAILABLE')
    return { outcomes, safetyReasons, incompleteReasons, failedResultIds, advisoryFailureIds }
  }
  const verified = new Map<string, ManualResultVerification>()
  for (const manualResult of input.manualResults) {
    let verification: ManualResultVerification
    try {
      verification = dependencies!.verifyManualResult!(manualResult)
    } catch {
      verification = { valid: false, code: 'E2E_MANUAL_RESULT_VERIFIER_ERROR', impact: 'safety-blocked' }
    }
    verified.set(manualResult.manualResultId, verification)
    if (!verification.valid && verification.impact === 'safety-blocked') safetyReasons.push(verification.code)
  }

  for (const obligation of manualObligations) {
    const candidates = input.manualResults.filter((manualResult) => manualResult.obligationIds.includes(obligation.obligationId))
    const current = candidates.filter((manualResult) =>
      manualResult.prdRevision === input.prdRevision
      && manualResult.assetId === input.assetId
      && manualResult.generationId === input.generationId
      && manualResult.requirementModelDigest === input.requirementModelDigest
      && manualResult.manualProcedureId === obligation.manualProcedureId)
    const valid = current.filter((manualResult) => verified.get(manualResult.manualResultId)?.valid)
    if (valid.length > 1) {
      safetyReasons.push('VERDICT_MANUAL_RESULT_CONFLICT')
      continue
    }
    if (valid.length === 1) {
      const manualResult = valid[0]!
      outcomes.set(obligation.obligationId, manualResult.outcome)
      if (manualResult.outcome === 'failed') {
        if (obligation.necessity === 'required') failedResultIds.push(manualResult.manualResultId)
        else advisoryFailureIds.push(manualResult.manualResultId)
      }
      if (manualResult.outcome === 'unable') incompleteReasons.push('VERDICT_MANUAL_RESULT_UNABLE')
      continue
    }
    outcomes.set(obligation.obligationId, 'incomplete')
    if (candidates.some((manualResult) => {
      const verification = verified.get(manualResult.manualResultId)
      return verification && !verification.valid && verification.impact === 'incomplete'
    })) incompleteReasons.push('VERDICT_MANUAL_RESULT_EXPIRED')
    else if (candidates.length > 0) incompleteReasons.push('VERDICT_MANUAL_RESULT_REVISION_OR_PROCEDURE_MISMATCH')
    else incompleteReasons.push('VERDICT_MANUAL_RESULT_MISSING')
  }
  return { outcomes, safetyReasons, incompleteReasons, failedResultIds, advisoryFailureIds }
}

function validateReferences(input: VerdictInput): string[] {
  const obligations = new Map(input.obligations.map((item) => [item.obligationId, item]))
  const expectedCases = new Map<string, Set<string>>()
  for (const obligation of input.obligations) {
    for (const caseId of obligation.caseIds ?? []) {
      const ids = expectedCases.get(caseId) ?? new Set<string>()
      ids.add(obligation.obligationId)
      expectedCases.set(caseId, ids)
    }
  }
  const reasons: string[] = []
  for (const caseResult of input.caseResults) {
    const expected = expectedCases.get(caseResult.caseId)
    const actual = new Set(caseResult.obligationIds)
    if (!expected || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) {
      reasons.push('VERDICT_CASE_REFERENCE_INVALID')
    }
  }
  for (const manualResult of input.manualResults) {
    if (manualResult.obligationIds.some((id) => obligations.get(id)?.disposition !== 'manual')) {
      reasons.push('VERDICT_MANUAL_REFERENCE_INVALID')
    }
  }
  return unique(reasons)
}

function computeMetrics(
  input: VerdictInput,
  requiredCaseIds: string[],
  requiredManual: VerdictInput['obligations'],
  manual: ManualEvaluation,
  resultByCase: Map<string, VerdictInput['caseResults'][number]>,
): VerdictResult['metrics'] {
  const requiredResults = requiredCaseIds.map((id) => resultByCase.get(id)).filter(isDefined)
  const executed = requiredResults.filter((item) => item.status === 'passed' || item.status === 'failed')
  const real = executed.filter((item) => item.executionMode === 'real-environment')
  const injection = executed.filter((item) => item.executionMode === 'gateway-injection')
  const requiredObligations = input.obligations.filter((item) => item.necessity === 'required')
  const blockedAutomated = input.obligations.filter((obligation) =>
    obligation.necessity === 'required'
    && obligation.disposition === 'automated'
    && (obligation.caseIds ?? []).some((id) => {
      const status = resultByCase.get(id)?.status
      return status === undefined || !['passed', 'failed'].includes(status)
    }),
  ).length
  const blockedManual = requiredManual.filter((item) => manual.outcomes.get(item.obligationId) !== 'passed').length
  const automationApplicable = input.obligations.filter((item) => item.disposition !== 'not-applicable')
  const coverage = input.coverageFacts
  return {
    requirementDesignCoverage: metric(coverage.requirementDesign.covered, coverage.requirementDesign.total, '没有适用需求'),
    ruleCoverage: metric(coverage.rules.covered, coverage.rules.total, '没有适用规则'),
    criticalNodeCoverage: metric(coverage.criticalNodes.covered, coverage.criticalNodes.total, '没有适用关键节点'),
    roleCoverage: metric(coverage.roles.covered, coverage.roles.total, '没有适用角色'),
    stateTransitionCoverage: metric(coverage.stateTransitions.covered, coverage.stateTransitions.total, '没有适用状态转换'),
    scenarioCategoryCoverage: metric(coverage.scenarioCategories.covered, coverage.scenarioCategories.total, '没有适用场景类别'),
    automationDispositionCoverage: metric(
      automationApplicable.filter((item) => item.disposition === 'automated').length,
      automationApplicable.length,
      '没有适用的自动化处置 obligation',
    ),
    executionCoverage: metric(executed.length, requiredCaseIds.length, '没有计划自动执行的必要 Case'),
    realPassRate: metric(real.filter((item) => item.status === 'passed').length, real.length, '没有真实链路已执行的必要 Case'),
    injectionPassRate: metric(
      injection.filter((item) => item.status === 'passed').length,
      injection.length,
      '没有故障注入已执行的必要 Case',
    ),
    evidenceCompleteness: metric(input.evidenceAudit.complete, input.evidenceAudit.total, '没有适用证据'),
    cleanupSuccess: metric(input.cleanupAudit.complete, input.cleanupAudit.total, '没有适用清理任务'),
    blockingRate: metric(blockedAutomated + blockedManual, requiredObligations.length, '没有必要 obligation'),
  }
}

function metric(numerator: number, denominator: number, zeroReason: string): Metric {
  if (denominator === 0) return { status: 'not-applicable', numerator: 0, denominator: 0, reason: zeroReason }
  return { status: 'value', numerator, denominator, percentage: numerator / denominator * 100 }
}

function result(
  input: VerdictInput,
  verdict: VerdictResult['verdict'],
  reasonCodes: string[],
  metrics: VerdictResult['metrics'],
  businessFailuresObserved: string[],
  advisoryFailures: string[],
): VerdictResult {
  return {
    verdictRuleVersion: input.verdictRuleVersion,
    verdict,
    reasonCodes: unique(reasonCodes),
    cannotClaim: verdict === 'accepted' ? [] : ['不能宣称本次验收范围已全部通过'],
    businessFailuresObserved: unique(businessFailuresObserved),
    advisoryFailures: unique(advisoryFailures),
    metrics,
  }
}

function invalidInputResult(candidate: VerdictInput): VerdictResult {
  const notApplicable = (reason: string): Metric => ({
    status: 'not-applicable', numerator: 0, denominator: 0, reason,
  })
  return {
    verdictRuleVersion: typeof candidate?.verdictRuleVersion === 'string' && /^\d+\.\d+\.\d+$/.test(candidate.verdictRuleVersion)
      ? candidate.verdictRuleVersion : '0.0.0',
    verdict: 'safety-blocked',
    reasonCodes: ['VERDICT_INPUT_INVALID'],
    cannotClaim: ['不能宣称本次验收范围已全部通过'],
    businessFailuresObserved: [],
    advisoryFailures: [],
    metrics: {
      requirementDesignCoverage: notApplicable('VerdictInput 无效'),
      ruleCoverage: notApplicable('VerdictInput 无效'),
      criticalNodeCoverage: notApplicable('VerdictInput 无效'),
      roleCoverage: notApplicable('VerdictInput 无效'),
      stateTransitionCoverage: notApplicable('VerdictInput 无效'),
      scenarioCategoryCoverage: notApplicable('VerdictInput 无效'),
      automationDispositionCoverage: notApplicable('VerdictInput 无效'),
      executionCoverage: notApplicable('VerdictInput 无效'),
      realPassRate: notApplicable('VerdictInput 无效'),
      injectionPassRate: notApplicable('VerdictInput 无效'),
      evidenceCompleteness: notApplicable('VerdictInput 无效'),
      cleanupSuccess: notApplicable('VerdictInput 无效'),
      blockingRate: notApplicable('VerdictInput 无效'),
    },
  }
}

function validateAttemptSelections(input: VerdictInput, dependencies?: VerdictDependencies): string[] {
  const reasons: string[] = []
  for (const caseResult of input.caseResults) {
    if (caseResult.attemptSelection.status !== 'valid') continue
    if (!dependencies?.verifyAttemptSelection) {
      reasons.push('VERDICT_ATTEMPT_VERIFIER_UNAVAILABLE')
      continue
    }
    try {
      if (!dependencies.verifyAttemptSelection({
        assetId: input.assetId,
        generationId: input.generationId,
        prdRevision: input.prdRevision,
        caseResult,
      })) reasons.push('VERDICT_ATTEMPT_CHAIN_INVALID')
    } catch {
      reasons.push('VERDICT_ATTEMPT_VERIFIER_ERROR')
    }
  }
  return unique(reasons)
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
