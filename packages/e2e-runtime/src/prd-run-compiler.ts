import {
  CompiledPrdRunPlanSchema,
  DeclarativePrdRunDesignSchema,
  PrdUnderstandingProjectionSchema,
  digestCompiledPrdRunPlan,
  type CompiledPrdRunPlan,
  type DeclarativePrdRunDesign,
  type PrdUnderstandingProjection,
} from '@mutil-skills/e2e-contracts'

export interface CompilePrdRunInput {
  understanding: PrdUnderstandingProjection
  design: DeclarativePrdRunDesign
}

export function compilePrdRun(input: CompilePrdRunInput): CompiledPrdRunPlan {
  const understanding = PrdUnderstandingProjectionSchema.parse(input.understanding)
  if (input.design.cases.some((testCase) => testCase.oracles.length === 0)) {
    throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNMAPPED')
  }
  const design = DeclarativePrdRunDesignSchema.parse(input.design)
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
    for (const nodeId of testCase.contractNodeIds) {
      if (!authorized.has(nodeId)) throw compilerError('E2E_RUNTIME_PRD_RUN_NODE_UNAUTHORIZED')
    }
    for (const oracle of testCase.oracles) {
      const key = criterionKey(oracle.contractNodeId, oracle.acceptanceCriterion)
      if (!expected.has(key)) throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNKNOWN')
      if (observed.has(key)) throw compilerError('E2E_RUNTIME_PRD_RUN_ACCEPTANCE_DUPLICATED')
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

function ordinal(value: number): string {
  return String(value).padStart(4, '0')
}

function criterionKey(nodeId: string, criterion: string): string {
  return `${nodeId}\u0000${criterion}`
}

function compilerError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
