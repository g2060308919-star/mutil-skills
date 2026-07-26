import { describe, expect, test } from 'vitest'
import { auditSemanticCompleteness } from '../src/index.js'

function facts() {
  return {
    manifest: { clauses: [
      { clauseId: 'CLAUSE-1' },
      { clauseId: 'CLAUSE-2' },
    ] },
    scope: {
      includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['CLAUSE-1'] }],
      clauseDispositions: [
        { clauseId: 'CLAUSE-1', disposition: 'modeled', requirementIds: ['REQ-1'] },
        { clauseId: 'CLAUSE-2', disposition: 'excluded', reason: '不属于验收范围', decisionId: 'DECISION-1' },
      ],
    },
    model: { requirements: [{
      reqId: 'REQ-1', status: 'active', sourceRefs: ['CLAUSE-1'],
      rules: [{ ruleId: 'RULE-1', sourceRefs: ['CLAUSE-1'], oracleIds: ['ORACLE-1'] }],
      observableOutcomes: [{ oracleId: 'ORACLE-1', ruleId: 'RULE-1', sourceRefs: ['CLAUSE-1'] }],
      actors: ['USER'], transitions: [],
    }] },
    flows: { flows: [] },
    coverage: { obligations: [{
      obligationId: 'COV-1', reqId: 'REQ-1', clauseIds: ['CLAUSE-1'], ruleIds: ['RULE-1'],
      oracleIds: ['ORACLE-1'], nodeIds: [], actor: 'USER', transitionId: 'not-applicable', scenario: 'positive',
      disposition: { kind: 'automated', caseIds: ['CASE-1'] },
    }] },
    cases: { cases: [{
      caseId: 'CASE-1', status: 'active', obligationIds: ['COV-1'],
      steps: [{ stepId: 'STEP-1', oracles: [{ oracleId: 'ORACLE-1' }] }],
    }] },
  }
}

describe('PRD 语义完整性审计', () => {
  test('完整闭环产生全覆盖事实且没有 finding', () => {
    const audit = auditSemanticCompleteness(facts())
    expect(audit.findings).toEqual([])
    expect(audit.coverageFacts).toMatchObject({
      prdClauses: { covered: 2, total: 2 },
      requirementDesign: { covered: 1, total: 1 },
      rules: { covered: 1, total: 1 },
      oracles: { covered: 1, total: 1 },
      cases: { covered: 1, total: 1 },
    })
  })

  test('漏处置 PRD 条款时阻断完整性', () => {
    const input = facts()
    input.scope.clauseDispositions.pop()
    const audit = auditSemanticCompleteness(input)
    expect(audit.findings).toContainEqual({ code: 'E2E_PRD_CLAUSE_DISPOSITION_MISSING', ref: 'CLAUSE-2' })
    expect(audit.coverageFacts.prdClauses).toEqual({ covered: 1, total: 2 })
  })

  test('Oracle 未进入 Obligation 或 Case Step 时分别报错', () => {
    const obligationGap = facts()
    obligationGap.coverage.obligations[0]!.oracleIds = []
    expect(auditSemanticCompleteness(obligationGap).findings)
      .toContainEqual({ code: 'E2E_ORACLE_COVERAGE_MISSING', ref: 'ORACLE-1' })

    const caseGap = facts()
    caseGap.cases.cases[0]!.steps[0]!.oracles = []
    expect(auditSemanticCompleteness(caseGap).findings)
      .toContainEqual({ code: 'E2E_ORACLE_CASE_MAPPING_MISSING', ref: 'ORACLE-1' })
  })
})
