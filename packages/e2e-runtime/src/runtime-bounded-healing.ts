import {
  DeclarativeExecutionBindingV1Schema,
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  digestApprovalProjection,
  digestText,
  normalizeDeclarativeExecutionBinding,
  type ArtifactDocument,
  type HealingProposal,
  type LocatorCandidate,
  RuntimeHealingAuditFactSchema,
  type RuntimeHealingAuditFact,
  type RuntimeHealingCandidate,
} from '@mutil-skills/e2e-contracts'
import { reviewHealingProposal } from '@mutil-skills/e2e-engine'
import { compileExecutableRun } from './prd-run-compiler.js'
import { AcceptanceReviewReceiptSchema, buildAcceptanceReview } from './acceptance-review.js'
import { createExecutableRunCompilationFact } from './executable-run-compilation-fact.js'
import { projectRuntimeExecutableArtifacts } from './runtime-executable-artifact-projector.js'
import type { RuntimeRunSnapshot } from './run-store.js'

export interface RuntimeHealingRevision {
  review: ReturnType<typeof reviewHealingProposal> & { accepted: true }
  artifacts: Record<'test-cases' | 'browser-action-map' | 'execution-contract' | 'run-bundle', ArtifactDocument>
  compilationFact: ReturnType<typeof createExecutableRunCompilationFact>
  auditFact: RuntimeHealingAuditFact
}

export function settleRuntimeHealingAudit(input: {
  fact: unknown
  finalAttemptId: string
  executionStatus: 'passed' | 'failed' | 'input-blocked' | 'environment-blocked' | 'safety-blocked'
  oracleResults?: Array<{ oracleId: string; passed: boolean }>
}): RuntimeHealingAuditFact {
  const fact = RuntimeHealingAuditFactSchema.parse(input.fact)
  if (fact.status !== 'awaiting-replay') throw healingError('E2E_RUNTIME_HEALING_REPLAY_STATE_INVALID')
  const passedOracleIds = input.oracleResults?.filter((oracle) => oracle.passed)
    .map((oracle) => oracle.oracleId).sort() ?? []
  const allRequiredPassed = input.executionStatus === 'passed'
    && canonicalizeJson(passedOracleIds) === canonicalizeJson([...fact.requiredOracleIds].sort())
  return RuntimeHealingAuditFactSchema.parse({
    ...fact,
    finalAttemptId: input.finalAttemptId,
    replayedOracleIds: passedOracleIds,
    status: allRequiredPassed ? 'accepted' : 'rejected',
  })
}

export function authorizeRuntimeHealingReplay(fact: unknown): RuntimeHealingAuditFact {
  const parsed = RuntimeHealingAuditFactSchema.parse(fact)
  if (parsed.status !== 'awaiting-execution-approval') {
    throw healingError('E2E_RUNTIME_HEALING_APPROVAL_STATE_INVALID')
  }
  return RuntimeHealingAuditFactSchema.parse({ ...parsed, status: 'awaiting-replay' })
}

/**
 * 将受限 locator/wait proposal 重投影为完整执行资产闭包。
 * 基线、失败 Attempt、Oracle 和审批摘要均从 Runtime 快照派生；调用方不能提交。
 */
export function prepareRuntimeHealingRevision(input: {
  snapshot: RuntimeRunSnapshot
  candidate: RuntimeHealingCandidate
  createdAt: string
  engineVersion: string
}): RuntimeHealingRevision {
  const snapshot = input.snapshot
  const candidate = input.candidate
  if (snapshot.workflow.current !== 'diagnosing') throw healingError('E2E_RUNTIME_HEALING_STATE_MISMATCH')
  if (snapshot.trustedExecutionFacts['bounded-healing'] !== undefined) {
    throw healingError('E2E_RUNTIME_HEALING_LIMIT_REACHED')
  }
  if (snapshot.compiledPrdRun === undefined || snapshot.targetProbe === undefined) {
    throw healingError('E2E_RUNTIME_HEALING_PREREQUISITES_MISSING')
  }
  const execution = requiredArtifact(snapshot, 'execution-contract')
  const actionMap = requiredArtifact(snapshot, 'browser-action-map')
  const contract = asRecord(execution.content)
  if (contract.executionProfile !== 'declarative-browser') {
    throw healingError('E2E_RUNTIME_HEALING_PROFILE_UNSUPPORTED')
  }
  const binding = DeclarativeExecutionBindingV1Schema.parse(contract.declarativeExecutionBinding)
  const bound = locateBindingAction(binding, candidate.actionId)
  const failure = failedExecution(snapshot, bound.testCase.caseId, candidate.actionId)
  const requiredOracleIds = bound.testCase.oracles
    .filter((oracle) => oracle.actionId === candidate.actionId).map((oracle) => oracle.oracleId).sort()
  if (requiredOracleIds.length === 0) throw healingError('E2E_RUNTIME_HEALING_ORACLE_SET_EMPTY')
  const firstEvidenceDigest = digestText('runtime-healing-first-evidence/v1', canonicalizeJson({
    attemptId: failure.attemptId, result: failure.result,
  }))
  const semanticDigest = runtimeSemanticDigest(snapshot)
  const priorSubjectDigest = currentApprovalSubjectDigest(snapshot)
  const currentRevision = actionMapRevision(actionMap)
  const proposalBase = { ...candidate, baseRevision: currentRevision,
    semanticDigestBefore: semanticDigest, semanticDigestAfter: semanticDigest,
    approvalSubjectDigestBefore: priorSubjectDigest }
  const revisedBinding = applyMutations(binding, proposalBase as HealingProposal, bound.testCase.caseId)
  const acceptanceReview = buildAcceptanceReview(snapshot)
  const receipt = AcceptanceReviewReceiptSchema.parse(
    snapshot.trustedExecutionFacts['acceptance-review-receipt'],
  )
  const compilation = compileExecutableRun({ compiledPlan: snapshot.compiledPrdRun,
    acceptanceReview, acceptanceReviewReceipt: receipt, targetProbe: snapshot.targetProbe,
    bindingCandidate: withoutBindingDigest(revisedBinding) })
  if (compilation.blockedCases.length > 0) throw healingError('E2E_RUNTIME_HEALING_BINDING_INCOMPLETE')
  const projection = projectRuntimeExecutableArtifacts({ snapshot, compilation,
    actionMapRevision: currentRevision + 1, createdAt: input.createdAt, engineVersion: input.engineVersion })
  const revisedSubjectDigest = projectRevisedApprovalSubjectDigest(snapshot, projection.artifacts)
  if (revisedSubjectDigest === priorSubjectDigest) {
    throw healingError('E2E_RUNTIME_HEALING_APPROVAL_SUBJECT_MISMATCH')
  }
  const proposal: HealingProposal = { ...proposalBase,
    approvalSubjectDigestAfter: revisedSubjectDigest }
  const review = reviewHealingProposal(proposal, {
    currentSemanticDigest: semanticDigest,
    currentApprovalSubjectDigest: priorSubjectDigest,
    protectedPageIdentitySignals: protectedPageIdentitySignals(snapshot),
  })
  if (!review.accepted) throw healingError(review.reasonCodes[0] ?? 'E2E_RUNTIME_HEALING_REVIEW_REJECTED')
  const artifactDigests = Object.fromEntries(Object.entries(projection.artifacts)
    .map(([type, artifact]) => [type, artifact.contentDigest])) as {
      'test-cases': string; 'browser-action-map': string; 'execution-contract': string; 'run-bundle': string
    }
  const compilationFact = createExecutableRunCompilationFact({
    compilerDigest: compilation.compilerDigest, projectionDigest: projection.projectionDigest,
    planCompilerDigest: compilation.planCompilerDigest, targetProbeDigest: compilation.targetProbeDigest,
    bindingDigest: compilation.normalizedBinding.bindingDigest, artifactDigests,
    executableCaseIds: compilation.executableCases.map((testCase) => testCase.caseId),
  })
  return { review, artifacts: projection.artifacts, compilationFact, auditFact: {
    schemaVersion: 'runtime-healing-audit/v1', proposalId: proposal.proposalId,
    caseId: bound.testCase.caseId, actionId: proposal.actionId,
    firstAttemptId: failure.attemptId, firstEvidenceDigest, requiredOracleIds,
    revision: review.nextRevision, changeDigest: review.actionMapDigest,
    status: 'awaiting-execution-approval',
  } }
}

function applyMutations(
  binding: ReturnType<typeof DeclarativeExecutionBindingV1Schema.parse>,
  proposal: HealingProposal,
  caseId: string,
) {
  const revised = structuredClone(binding)
  const testCase = revised.cases.find((candidate) => candidate.caseId === caseId)!
  const action = testCase.actions.find((candidate) => candidate.actionId === proposal.actionId)!
  for (const mutation of proposal.mutations) {
    if (mutation.kind === 'locator-candidate') {
      if (canonicalizeJson(action.locatorCandidates) !== canonicalizeJson(
        mutation.before.map(toPageLocator),
      )) throw healingError('E2E_RUNTIME_HEALING_LOCATOR_BASELINE_MISMATCH')
      action.locatorCandidates = mutation.after.map(toPageLocator)
    } else if (mutation.kind === 'wait-condition') {
      if (mutation.before.timeoutMs !== action.timeout.timeoutMs) {
        throw healingError('E2E_RUNTIME_HEALING_WAIT_BASELINE_MISMATCH')
      }
      action.timeout.timeoutMs = mutation.after.timeoutMs
    } else {
      throw healingError('E2E_RUNTIME_HEALING_MUTATION_NOT_EXECUTABLE')
    }
  }
  return normalizeDeclarativeExecutionBinding(revised)
}

function locateBindingAction(
  binding: ReturnType<typeof DeclarativeExecutionBindingV1Schema.parse>, actionId: string,
) {
  const matches = binding.cases.flatMap((testCase) => testCase.actions
    .filter((action) => action.actionId === actionId).map((action) => ({ testCase, action })))
  if (matches.length !== 1) throw healingError('E2E_RUNTIME_HEALING_ACTION_AMBIGUOUS')
  return matches[0]!
}

function failedExecution(snapshot: RuntimeRunSnapshot, caseId: string, actionId: string) {
  const failure = snapshot.executionResults?.readEnvironment?.[actionId]
  if (failure === undefined || failure.caseId !== caseId || failure.status !== 'failed') {
    throw healingError('E2E_RUNTIME_HEALING_FAILED_ATTEMPT_REQUIRED')
  }
  return failure
}

function runtimeSemanticDigest(snapshot: RuntimeRunSnapshot): string {
  return digestText('runtime-healing-semantic-baseline/v1', canonicalizeJson({
    compiledPrdRun: snapshot.compiledPrdRun,
    acceptanceReview: snapshot.trustedExecutionFacts['acceptance-review'],
    acceptanceReviewReceipt: snapshot.trustedExecutionFacts['acceptance-review-receipt'],
  }))
}

function currentApprovalSubjectDigest(snapshot: RuntimeRunSnapshot): string {
  const grant = asRecord(snapshot.trustedExecutionFacts['signed-execution-grant'])
  if (typeof grant.subjectDigest !== 'string') throw healingError('E2E_RUNTIME_HEALING_GRANT_REQUIRED')
  return grant.subjectDigest
}

function projectRevisedApprovalSubjectDigest(
  snapshot: RuntimeRunSnapshot,
  artifacts: RuntimeHealingRevision['artifacts'],
): string {
  const grant = asRecord(snapshot.trustedExecutionFacts['signed-execution-grant'])
  const subject = structuredClone(asRecord(grant.subject))
  if (!('actionMapDigest' in subject) || !('caseDigest' in subject)
    || !('executionContractDigest' in subject) || !('runBundleProjectionDigest' in subject)) {
    throw healingError('E2E_RUNTIME_HEALING_GRANT_KIND_UNSUPPORTED')
  }
  subject.caseDigest = digestApprovalProjection('test-cases', artifacts['test-cases'].content)
  subject.actionMapDigest = digestApprovalProjection('browser-action-map', artifacts['browser-action-map'].content)
  subject.executionContractDigest = digestApprovalProjection('execution-contract', artifacts['execution-contract'].content)
  subject.runBundleProjectionDigest = digestApprovalProjection('run-bundle', artifacts['run-bundle'].content)
  return canonicalGrantApprovalSubjectDigest(subject as never)
}

function protectedPageIdentitySignals(snapshot: RuntimeRunSnapshot): string[] {
  return snapshot.targetContract?.contract.pageIdentityPolicy.signals.map((signal) =>
    signal.kind === 'role' ? `role:${signal.role}:${signal.name}`
      : signal.kind === 'css-visible' ? `css:${signal.selector}`
        : signal.kind === 'test-id' ? `test-id:${signal.value}` : `${signal.kind}:${signal.value}`) ?? []
}

function actionMapRevision(artifact: ArtifactDocument): number {
  const value = asRecord(artifact.content).actionMapRevision
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw healingError('E2E_RUNTIME_HEALING_REVISION_INVALID')
  return Number(value)
}

function toPageLocator(candidate: LocatorCandidate) {
  if (candidate.strategy === 'role') {
    const separator = candidate.value.indexOf(':')
    if (separator < 1) throw healingError('E2E_RUNTIME_HEALING_ROLE_LOCATOR_INVALID')
    return { kind: 'role' as const, role: candidate.value.slice(0, separator) as never,
      name: candidate.value.slice(separator + 1) }
  }
  if (candidate.strategy === 'test-id') return { kind: 'test-id' as const, value: candidate.value }
  if (candidate.strategy === 'label') return { kind: 'label' as const, value: candidate.value }
  if (candidate.strategy === 'css') return { kind: 'css' as const, selector: candidate.value }
  return { kind: 'text' as const, value: candidate.value, exact: true }
}

function requiredArtifact(snapshot: RuntimeRunSnapshot, type: keyof RuntimeHealingRevision['artifacts']) {
  const artifact = snapshot.frozenArtifacts[type]
  if (artifact === undefined) throw healingError('E2E_RUNTIME_HEALING_ARTIFACT_MISSING')
  return artifact
}

function withoutBindingDigest(
  binding: ReturnType<typeof normalizeDeclarativeExecutionBinding>,
) {
  const { bindingDigest: _derived, ...candidate } = binding
  return candidate
}

function asRecord(value: unknown): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw healingError('E2E_RUNTIME_HEALING_FACT_INVALID')
  }
  return value as Record<string, any>
}

function healingError(code: string): Error { return Object.assign(new Error(code), { code }) }
