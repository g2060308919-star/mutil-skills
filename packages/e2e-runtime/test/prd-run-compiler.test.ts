import { describe, expect, test } from 'vitest'
import {
  AcceptanceReviewSchema,
  canonicalizeJson,
  digestPrdUnderstandingProjection,
  digestPrdUnderstandingQuote,
  digestText,
  type DeclarativePrdRunDesign,
  type DeclarativePrdRunDesignV2,
  type PrdUnderstandingProjection,
} from '@mutil-skills/e2e-contracts'
import { compileExecutableRun, compilePrdRun, compileSemanticRun } from '../src/prd-run-compiler.js'
import { confirmAcceptanceReview } from '../src/acceptance-review.js'

describe('PRDRunCompiler', () => {
  test('deterministically compiles three Cases and binds every acceptance criterion', () => {
    const input = inputFixture()
    const first = compilePrdRun(input)
    const second = compilePrdRun(input)
    expect(first).toEqual(second)
    expect(first.cases.map((item) => item.caseId)).toEqual(['CASE-0001', 'CASE-0002', 'CASE-0003'])
    expect(first.cases.flatMap((item) => item.oracles).map((item) => item.acceptanceCriterion))
      .toEqual(['结果 1 可见', '结果 2 可见', '结果 3 可见'])
    expect(first.compilerDigest).toMatch(/^sha256:/)
    expect(compileSemanticRun(input)).toEqual(first)
  })

  test('已确认 Review 与 ready Probe 把完整绑定确定性编译为 executable cases', () => {
    const semanticInput = inputFixture()
    const compiledPlan = compileSemanticRun(semanticInput)
    const review = acceptanceReview(compiledPlan)
    const receipt = confirmAcceptanceReview({
      review, expectedReviewDigest: review.reviewDigest, confirmedAt: '2026-08-12T00:00:00.000Z',
    })
    const first = compileExecutableRun({ compiledPlan, acceptanceReview: review,
      acceptanceReviewReceipt: receipt, targetProbe: targetProbe(), bindingCandidate: binding(compiledPlan) })
    const second = compileExecutableRun({ compiledPlan, acceptanceReview: review,
      acceptanceReviewReceipt: receipt, targetProbe: targetProbe(), bindingCandidate: binding(compiledPlan) })
    expect(first).toEqual(second)
    expect(first.executableCases.map((item) => item.caseId)).toEqual(['CASE-0001', 'CASE-0002', 'CASE-0003'])
    expect(first.blockedCases).toEqual([])
    expect(first.compilerDigest).toMatch(/^sha256:/)
  })

  test('缺失绑定形成 needs-binding，额外 action 与过期 Probe fail closed', () => {
    const compiledPlan = compileSemanticRun(inputFixture())
    const review = acceptanceReview(compiledPlan)
    const receipt = confirmAcceptanceReview({ review, expectedReviewDigest: review.reviewDigest,
      confirmedAt: '2026-08-12T00:00:00.000Z' })
    const partial = binding(compiledPlan)
    partial.cases.pop()
    expect(compileExecutableRun({ compiledPlan, acceptanceReview: review, acceptanceReviewReceipt: receipt,
      targetProbe: targetProbe(), bindingCandidate: partial }).blockedCases).toEqual([{
      caseId: 'CASE-0003', reason: 'needs-binding', missingActionIds: ['ACTION-0003-0001'],
      missingOracleIds: ['ORACLE-0003-0001'],
    }])
    const forged = binding(compiledPlan) as any
    forged.cases[0].actions[0].actionId = 'ACTION-FORGED'
    forged.cases[0].oracles[0].actionId = 'ACTION-FORGED'
    expect(() => compileExecutableRun({ compiledPlan, acceptanceReview: review, acceptanceReviewReceipt: receipt,
      targetProbe: targetProbe(), bindingCandidate: forged })).toThrow(/E2E_RUNTIME_EXECUTABLE_BINDING_ACTION_UNAUTHORIZED/)
    expect(() => compileExecutableRun({ compiledPlan, acceptanceReview: review, acceptanceReviewReceipt: receipt,
      targetProbe: { ...targetProbe(), status: 'environment-blocked' }, bindingCandidate: binding(compiledPlan) }))
      .toThrow(/E2E_RUNTIME_EXECUTABLE_TARGET_NOT_READY/)
  })

  test('允许多个独立场景覆盖同一验收条件', () => {
    const repeated = inputFixture()
    repeated.design.cases.push({
      ...structuredClone(repeated.design.cases[0]!),
      caseKey: 'case-1-negative',
      title: '场景 1 负向验证',
    })
    const result = compilePrdRun(repeated)
    expect(result.cases).toHaveLength(4)
    expect(result.cases.filter((item) =>
      item.oracles.some((oracle) => oracle.acceptanceCriterion === '结果 1 可见'))).toHaveLength(2)
  })

  test('拒绝同一 Case 用多个主 Oracle 重复映射同一验收标准', () => {
    const repeated = inputFixture()
    repeated.design.cases[0]!.oracles.push({
      ...structuredClone(repeated.design.cases[0]!.oracles[0]!),
      oracleKey: 'visible-duplicate',
    })

    expect(() => compilePrdRun(repeated))
      .toThrow(/E2E_RUNTIME_PRD_RUN_ACCEPTANCE_DUPLICATE/)
  })

  test('blocks missing, altered, or unauthorized acceptance mappings', () => {
    const missing = inputFixture()
    missing.design.cases[0]!.oracles = []
    expect(() => compilePrdRun(missing)).toThrow(/E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNMAPPED/)

    const altered = inputFixture()
    altered.design.cases[0]!.oracles[0]!.acceptanceCriterion = '模型自行弱化的预期'
    expect(() => compilePrdRun(altered)).toThrow(/E2E_RUNTIME_PRD_RUN_ACCEPTANCE_UNKNOWN/)

    const unauthorized = inputFixture()
    unauthorized.design.cases[0]!.contractNodeIds = ['REQ-UNKNOWN']
    unauthorized.design.cases[0]!.oracles[0]!.contractNodeId = 'REQ-UNKNOWN'
    expect(() => compilePrdRun(unauthorized)).toThrow(/E2E_RUNTIME_PRD_RUN_NODE_UNAUTHORIZED/)
  })

  test('编译 v2 设计时保留 execution lane、fixture、locator 和页面身份', () => {
    const input = inputFixture()
    const design: DeclarativePrdRunDesignV2 = {
      ...input.design,
      schemaVersion: '2.0.0',
      cases: input.design.cases.map((testCase) => ({
        ...testCase,
        executionLane: 'preview-readonly',
        fixture: { actorRef: testCase.actor, preconditions: [], seedStrategy: 'pre-existing' },
        locatorCandidates: [{ kind: 'test-id', value: 'result-panel' }],
        pageIdentityPolicy: {
          schemaVersion: '1.0.0',
          url: { origin: 'http://localhost:3000', pathPattern: '/results/**' },
          signals: [{ kind: 'test-id', value: 'results-page' }],
          match: { mode: 'all' },
        },
      })),
    }

    const compiled = compilePrdRun({ understanding: input.understanding, design })

    expect(compiled.cases[0]).toMatchObject({
      executionLane: 'preview-readonly',
      fixture: { actorRef: 'USER', seedStrategy: 'pre-existing' },
      locatorCandidates: [{ kind: 'test-id', value: 'result-panel' }],
      pageIdentityPolicy: {
        url: { origin: 'http://localhost:3000', pathPattern: '/results/**' },
      },
    })
  })
})

function acceptanceReview(plan: ReturnType<typeof compilePrdRun>) {
  const draft = {
    schemaVersion: '1.0.0' as const, runId: 'RUN-1', contractProjectionDigest: plan.contractProjectionDigest,
    compilerDigest: plan.compilerDigest, links: [{
      clauseId: 'CLAUSE-1', sourceSpan: { sourceId: 'PRD', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      sourceText: '需求', disposition: 'modeled' as const, requirementIds: ['REQ-1'], ruleIds: ['RULE-1'],
      oracleIds: ['ORACLE-0001-0001'], caseIds: ['CASE-0001'],
    }], semanticCatalog: {
      requirements: [], rules: [], oracles: [], obligations: [], cases: [],
    }, includedClauseIds: [], excludedClauseIds: [], unresolvedItems: [],
  }
  return AcceptanceReviewSchema.parse({ ...draft,
    reviewDigest: digestText('e2e-acceptance-review/v1', canonicalizeJson(draft)) })
}

function targetProbe() {
  const base = {
    schemaVersion: '1.0.0' as const, trust: 'untrusted-diagnostic' as const, runId: 'RUN-1',
    targetContractDigest: digestText('test', 'target'), status: 'ready' as const,
    observedUrl: 'https://example.test/orders', observedTitle: '订单', identityMatched: true,
    diagnostics: { strategy: 'resource-closure' as const, attempt: 1, domPresent: true,
      visibleTextSummary: '订单', consoleErrors: [], failedRequests: [], pendingResources: [],
      unapprovedResources: [], persistentConnections: [], advisories: [], resourceSummary: {
        observedCount: 1, approvedCount: 1, pendingCount: 0, unapprovedCount: 0,
        persistentConnectionCount: 0, closureComplete: true,
      } }, probedAt: '2026-08-12T00:00:00.000Z',
  }
  return { ...base, diagnosticDigest: digestText('e2e-target-probe-diagnostic/v1', JSON.stringify(base)) }
}

function binding(plan: ReturnType<typeof compilePrdRun>) {
  return {
    schemaVersion: 'declarative-execution-binding/v1' as const,
    planCompilerDigest: plan.compilerDigest,
    targetProbeDigest: targetProbe().diagnosticDigest,
    cases: plan.cases.map((testCase) => ({
      caseId: testCase.caseId, executionLane: 'trusted-read-only' as const,
      pageIdentityPolicy: { schemaVersion: '1.0.0' as const,
        url: { origin: 'https://example.test', pathPattern: '/orders' },
        signals: [{ kind: 'role' as const, role: 'main' as const, name: '订单' }], match: { mode: 'all' as const } },
      actions: testCase.actions.map((action) => ({ kind: 'assert-only' as const, actionId: action.actionId,
        effect: 'read' as const, pageScope: { page: 'current' as const, frame: { kind: 'main' as const } },
        locatorCandidates: [{ kind: 'text' as const, value: '结果', exact: false }],
        timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' as const } })),
      oracles: testCase.oracles.map((oracle) => ({ kind: 'text' as const, oracleId: oracle.oracleId,
        actionId: oracle.actionId, locatorCandidates: [{ kind: 'text' as const, value: '结果', exact: false }],
        comparator: 'contains' as const, expected: oracle.acceptanceCriterion, deadlineMs: 5_000,
        evidenceKinds: ['dom' as const] })), dataNeeds: [], cleanupIntents: [],
    })),
  }
}

function inputFixture(): {
  understanding: PrdUnderstandingProjection
  design: DeclarativePrdRunDesign
} {
  const nodes = Array.from({ length: 3 }, (_, index) => {
    const ordinal = index + 1
    const quote = `需求 ${ordinal}`
    return {
      nodeId: `REQ-${ordinal}`, kind: 'REQ' as const, statement: quote,
      provenance: { kind: 'source-fact' as const, anchors: [{
        sourceId: 'PRD', sourceSpan: {
          startLine: ordinal, startColumn: 1, endLine: ordinal, endColumn: quote.length + 1,
        }, quote, quoteDigest: digestPrdUnderstandingQuote(quote),
      }] },
      responsibility: 'PRODUCT', upstreamNodeIds: [], downstreamNodeIds: [],
      acceptanceCriteria: [`结果 ${ordinal} 可见`],
    }
  })
  const projectionDraft = {
    schemaVersion: '1.0.0' as const, contractId: 'CONTRACT-1', contractVersion: 1,
    contractStatus: 'confirmed-by-caller' as const, contractSourceDigest: digestText('test', 'contract'),
    sourceRevision: digestText('test', 'source'), sources: [{
      sourceId: 'PRD', kind: 'file' as const, ref: 'prd.md',
      origin: { kind: 'file' as const, ref: 'prd.md' }, relevance: 'target' as const,
      digest: digestText('test', 'prd'), byteLength: 100,
    }],
    nodes, pendingQuestions: [],
    route: { skillName: 'e2e' as const, steps: nodes.map((node, index) => ({
      stepId: `STEP-${index + 1}`, inputNodeIds: [node.nodeId], output: 'E2E Case',
      constraints: [], dependencyStepIds: [], completionCondition: 'Oracle executed',
    })) },
    authorization: {
      status: 'confirmed-by-caller' as const, contractVersion: 1,
      confirmedAt: '2026-07-31T00:00:00.000Z', authorizedNodeIds: nodes.map((node) => node.nodeId),
    },
  }
  const understanding = {
    ...projectionDraft,
    projectionDigest: digestPrdUnderstandingProjection(projectionDraft),
  } as PrdUnderstandingProjection
  const design: DeclarativePrdRunDesign = {
    schemaVersion: '1.0.0',
    cases: nodes.map((node, index) => ({
      caseKey: `case-${index + 1}`, title: `场景 ${index + 1}`, actor: 'USER',
      contractNodeIds: [node.nodeId], failurePolicy: index === 0 ? 'stop-required' : 'continue',
      actions: [{ actionKey: 'observe', kind: 'full-playwright', effect: 'read', statement: '检查结果' }],
      oracles: [{ oracleKey: 'visible', actionKey: 'observe', contractNodeId: node.nodeId,
        acceptanceCriterion: node.acceptanceCriteria[0]! }],
    })),
  }
  return { understanding, design }
}
