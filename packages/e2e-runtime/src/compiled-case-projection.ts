import {
  canonicalizeJson,
  E2EError,
  type CompiledPrdRunPlan,
} from '@mutil-skills/e2e-contracts'

type CompiledCases = Pick<CompiledPrdRunPlan, 'cases'>

interface ProjectedCase {
  caseId: string
  title: string
  actor: string
  preconditions: string[]
  dataNeedIds: string[]
  steps: Array<{ oracles: Array<{ statement: string }> }>
  mode: 'real-environment' | 'gateway-injection'
  effect: 'read' | 'reversible-write' | 'irreversible' | 'unknown'
  cleanupPlanId: string
  executionLane?: unknown
  fixture?: unknown
  locatorCandidates?: unknown
  pageIdentityPolicy?: unknown
}

interface TestCasesProjection {
  cases: ProjectedCase[]
  caseSetDigest?: string
}

/** 防止已确认 Semantic Case 在进入执行资产时发生 lane、fixture 或身份漂移。 */
export function assertCompiledCaseProjection(
  plan: CompiledCases,
  projection: TestCasesProjection,
): void {
  const compiled = plan.cases.filter((testCase) => testCase.executionLane !== undefined)
  if (compiled.length === 0) return
  if (compiled.length !== plan.cases.length || projection.cases.length !== compiled.length) {
    throw projectionError()
  }
  const byId = new Map(projection.cases.map((testCase) => [testCase.caseId, testCase]))
  if (byId.size !== projection.cases.length) throw projectionError()
  for (const semantic of compiled) {
    const candidate = byId.get(semantic.caseId)
    if (candidate === undefined || candidate.actor !== semantic.actor || candidate.title !== semantic.title
      || !sameRequiredProjection(candidate.executionLane, semantic.executionLane)
      || !sameRequiredProjection(candidate.fixture, semantic.fixture)
      || !sameRequiredProjection(candidate.locatorCandidates, semantic.locatorCandidates)
      || !sameRequiredProjection(candidate.pageIdentityPolicy, semantic.pageIdentityPolicy)) {
      throw projectionError()
    }
    const fixture = semantic.fixture!
    if (fixture.actorRef !== candidate.actor
      || fixture.preconditions.some((item) => !candidate.preconditions.includes(item.statement))) {
      throw projectionError()
    }
    if (semantic.executionLane === 'preview-readonly') {
      if (candidate.mode !== 'real-environment' || candidate.effect !== 'read'
        || candidate.cleanupPlanId !== 'not-applicable') throw projectionError()
      continue
    }
    if (semantic.executionLane === 'injection-simulated') {
      if (candidate.mode !== 'gateway-injection') throw projectionError()
      continue
    }
    const reloadStatements = new Set(candidate.steps.flatMap((step) =>
      step.oracles.map((oracle) => oracle.statement)))
    if (candidate.mode !== 'real-environment' || candidate.effect !== 'reversible-write'
      || candidate.cleanupPlanId === 'not-applicable'
      || fixture.dataLease === undefined
      || !candidate.dataNeedIds.includes(fixture.dataLease.leaseKey)
      || fixture.reloadVerification === undefined
      || fixture.reloadVerification.some((oracle) => !reloadStatements.has(oracle.statement))) {
      throw projectionError()
    }
  }
}

function sameRequiredProjection(candidate: unknown, semantic: unknown): boolean {
  return candidate !== undefined && semantic !== undefined
    && canonicalizeJson(candidate) === canonicalizeJson(semantic)
}

function projectionError(): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CASE_EXECUTION_PROJECTION_MISMATCH', category: 'artifact',
    message: 'test-cases 未与已确认 Semantic Case 的 lane、fixture、身份或恢复 Oracle 闭合',
    retryable: false,
  })
}
