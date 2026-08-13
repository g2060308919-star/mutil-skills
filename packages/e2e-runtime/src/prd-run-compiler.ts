import {
  CompiledPrdRunPlanSchema,
  AcceptanceReviewSchema,
  canonicalizeJson,
  digestText,
  normalizeDeclarativeExecutionBinding,
  AnyDeclarativePrdRunDesignSchema,
  PrdUnderstandingProjectionSchema,
  digestCompiledPrdRunPlan,
  type CompiledPrdRunPlan,
  type AnyDeclarativePrdRunDesign,
  type PrdUnderstandingProjection,
  type AcceptanceReview,
  type DeclarativeExecutionBindingV1,
  type NormalizedDeclarativeExecutionBindingV1,
} from '@mutil-skills/e2e-contracts'
import { AcceptanceReviewReceiptSchema, type AcceptanceReviewReceipt } from './acceptance-review.js'
import { TargetProbeFactSchema, type TargetProbeFact } from './target-probe.js'

export interface CompilePrdRunInput {
  understanding: PrdUnderstandingProjection
  design: AnyDeclarativePrdRunDesign
}

export function compileSemanticRun(input: CompilePrdRunInput): CompiledPrdRunPlan {
  const understanding = PrdUnderstandingProjectionSchema.parse(input.understanding)
  if (input.design.cases.some((testCase) => testCase.oracles.length === 0)) {
    throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNMAPPED')
  }
  const design = AnyDeclarativePrdRunDesignSchema.parse(input.design)
  const authorized = new Set(understanding.authorization.authorizedNodeIds)
  const expected = new Map<string, { nodeId: string; criterion: string }>()
  for (const node of understanding.nodes) {
    if (!authorized.has(node.nodeId)) continue
    node.acceptanceCriteria.forEach((criterion) => {
      expected.set(criterionKey(node.nodeId, criterion), { nodeId: node.nodeId, criterion })
    })
  }

  const observed = new Set<string>()
  for (const testCase of design.cases) {
    const caseObserved = new Set<string>()
    for (const nodeId of testCase.contractNodeIds) {
      if (!authorized.has(nodeId)) throw compilerError('E2E_RUNTIME_PRD_RUN_NODE_UNAUTHORIZED')
    }
    for (const oracle of testCase.oracles) {
      const key = criterionKey(oracle.contractNodeId, oracle.acceptanceCriterion)
      if (!expected.has(key)) throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNKNOWN')
      if (caseObserved.has(key)) {
        throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_DUPLICATE')
      }
      caseObserved.add(key)
      observed.add(key)
    }
  }
  if ([...expected.keys()].some((key) => !observed.has(key))) {
    throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNMAPPED')
  }

  const cases = design.cases.map((testCase, caseIndex) => {
    const caseOrdinal = caseIndex + 1
    const actionIds = new Map(testCase.actions.map((action, actionIndex) => [
      action.actionKey, `ACTION-${ordinal(caseOrdinal)}-${ordinal(actionIndex + 1)}`,
    ]))
    return {
      queueOrdinal: caseIndex,
      caseId: `CASE-${ordinal(caseOrdinal)}`,
      caseKey: testCase.caseKey,
      title: testCase.title,
      actor: testCase.actor,
      contractNodeIds: [...testCase.contractNodeIds],
      failurePolicy: testCase.failurePolicy,
      ...(!('executionLane' in testCase) ? {} : {
        executionLane: testCase.executionLane,
        fixture: testCase.fixture,
        locatorCandidates: testCase.locatorCandidates,
        pageIdentityPolicy: testCase.pageIdentityPolicy,
      }),
      actions: testCase.actions.map((action, actionIndex) => ({
        actionId: `ACTION-${ordinal(caseOrdinal)}-${ordinal(actionIndex + 1)}`,
        actionKey: action.actionKey,
        kind: action.kind,
        effect: action.effect,
        statement: action.statement,
      })),
      oracles: testCase.oracles.map((oracle, oracleIndex) => ({
        oracleId: `ORACLE-${ordinal(caseOrdinal)}-${ordinal(oracleIndex + 1)}`,
        oracleKey: oracle.oracleKey,
        actionId: actionIds.get(oracle.actionKey)!,
        contractNodeId: oracle.contractNodeId,
        acceptanceCriterion: oracle.acceptanceCriterion,
      })),
    }
  })
  const draft = {
    schemaVersion: '1.0.0' as const,
    contractProjectionDigest: understanding.projectionDigest,
    cases,
  }
  return CompiledPrdRunPlanSchema.parse({
    ...draft,
    compilerDigest: digestCompiledPrdRunPlan(draft),
  })
}

/** @deprecated 使用 compileSemanticRun；兼容旧主机和冻结资产。 */
export const compilePrdRun = compileSemanticRun

export interface CompileExecutableRunInput {
  compiledPlan: CompiledPrdRunPlan
  acceptanceReview: AcceptanceReview
  acceptanceReviewReceipt: AcceptanceReviewReceipt
  targetProbe: TargetProbeFact
  bindingCandidate: DeclarativeExecutionBindingV1
}

export interface ExecutableRunBlockedCase {
  caseId: string
  reason: 'needs-binding' | 'unsupported'
  missingActionIds: string[]
  missingOracleIds: string[]
}

export interface ExecutableRunCompilation {
  schemaVersion: 'executable-run-compilation/v1'
  planCompilerDigest: string
  targetProbeDigest: string
  normalizedBinding: NormalizedDeclarativeExecutionBindingV1
  executableCases: NormalizedDeclarativeExecutionBindingV1['cases']
  blockedCases: ExecutableRunBlockedCase[]
  diagnostics: Array<{ caseId: string; code: string }>
  compilerDigest: string
}

export function compileExecutableRun(input: CompileExecutableRunInput): ExecutableRunCompilation {
  const compiledPlan = CompiledPrdRunPlanSchema.parse(input.compiledPlan)
  const review = AcceptanceReviewSchema.parse(input.acceptanceReview)
  const receipt = AcceptanceReviewReceiptSchema.parse(input.acceptanceReviewReceipt)
  const targetProbe = TargetProbeFactSchema.parse(input.targetProbe)
  const binding = normalizeDeclarativeExecutionBinding(input.bindingCandidate)
  if (review.compilerDigest !== compiledPlan.compilerDigest
    || review.contractProjectionDigest !== compiledPlan.contractProjectionDigest) {
    throw compilerError('E2E_RUNTIME_EXECUTABLE_REVIEW_PLAN_MISMATCH')
  }
  if (receipt.reviewDigest !== review.reviewDigest) {
    throw compilerError('E2E_RUNTIME_EXECUTABLE_REVIEW_NOT_CONFIRMED')
  }
  if (review.unresolvedItems.length > 0) throw compilerError('E2E_RUNTIME_EXECUTABLE_REVIEW_UNRESOLVED')
  if (targetProbe.status !== 'ready' || !targetProbe.identityMatched
    || !targetProbe.diagnostics.resourceSummary.closureComplete) {
    throw compilerError('E2E_RUNTIME_EXECUTABLE_TARGET_NOT_READY')
  }
  if (binding.planCompilerDigest !== compiledPlan.compilerDigest) {
    throw compilerError('E2E_RUNTIME_EXECUTABLE_PLAN_DIGEST_MISMATCH')
  }
  if (binding.targetProbeDigest !== targetProbe.diagnosticDigest) {
    throw compilerError('E2E_RUNTIME_EXECUTABLE_TARGET_PROBE_DIGEST_MISMATCH')
  }
  const planByCase = new Map(compiledPlan.cases.map((testCase) => [testCase.caseId, testCase]))
  for (const boundCase of binding.cases) {
    const planCase = planByCase.get(boundCase.caseId)
    if (planCase === undefined) throw compilerError('E2E_RUNTIME_EXECUTABLE_BINDING_CASE_UNAUTHORIZED')
    const actionIds = new Set(planCase.actions.map((action) => action.actionId))
    const oracleIds = new Set(planCase.oracles.map((oracle) => oracle.oracleId))
    if (boundCase.actions.some((action) => !actionIds.has(action.actionId))) {
      throw compilerError('E2E_RUNTIME_EXECUTABLE_BINDING_ACTION_UNAUTHORIZED')
    }
    if (boundCase.oracles.some((oracle) => !oracleIds.has(oracle.oracleId))) {
      throw compilerError('E2E_RUNTIME_EXECUTABLE_BINDING_ORACLE_UNAUTHORIZED')
    }
  }
  const bindingByCase = new Map(binding.cases.map((testCase) => [testCase.caseId, testCase]))
  const blockedCases: ExecutableRunBlockedCase[] = []
  const executableCases: NormalizedDeclarativeExecutionBindingV1['cases'] = []
  for (const planCase of compiledPlan.cases) {
    const boundCase = bindingByCase.get(planCase.caseId)
    const boundActionIds = new Set(boundCase?.actions.map((action) => action.actionId) ?? [])
    const boundOracleIds = new Set(boundCase?.oracles.map((oracle) => oracle.oracleId) ?? [])
    const missingActionIds = planCase.actions.map((action) => action.actionId)
      .filter((actionId) => !boundActionIds.has(actionId))
    const missingOracleIds = planCase.oracles.map((oracle) => oracle.oracleId)
      .filter((oracleId) => !boundOracleIds.has(oracleId))
    if (boundCase === undefined || missingActionIds.length > 0 || missingOracleIds.length > 0) {
      blockedCases.push({ caseId: planCase.caseId, reason: 'needs-binding', missingActionIds, missingOracleIds })
    } else executableCases.push(boundCase)
  }
  const diagnostics = blockedCases.map((item) => ({
    caseId: item.caseId, code: item.reason === 'needs-binding'
      ? 'E2E_RUNTIME_EXECUTABLE_BINDING_REQUIRED' : 'E2E_RUNTIME_EXECUTABLE_BINDING_UNSUPPORTED',
  }))
  const draft = {
    schemaVersion: 'executable-run-compilation/v1' as const,
    planCompilerDigest: compiledPlan.compilerDigest,
    targetProbeDigest: targetProbe.diagnosticDigest,
    normalizedBinding: binding,
    executableCases,
    blockedCases,
    diagnostics,
  }
  return { ...draft, compilerDigest: digestText(
    'executable-run-compilation/v1', canonicalizeJson(draft),
  ) }
}

function ordinal(value: number): string {
  return String(value).padStart(4, '0')
}

function criterionKey(nodeId: string, criterion: string): string {
  return `${nodeId}\u0000${criterion}`
}

function compilerError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
