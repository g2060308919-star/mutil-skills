import { describe, expect, test } from 'vitest'
import {
  AcceptanceScopeContentSchema,
  CoverageUniverseContentSchema,
  PrdManifestContentSchema,
  RequirementModelSchema,
  digestPrdClause,
  digestPrdClauseInventory,
  digestText,
} from '../src/index.js'

const d = (value: string) => digestText('test/v1', value)

function clause(overrides: Record<string, unknown> = {}) {
  const base = {
    clauseId: 'CLAUSE-1', sourceId: 'SOURCE-1', kind: 'functional' as const,
    sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 24 },
    originalText: '用户可以新增待办事项。', normalizedText: '用户可以新增待办事项。',
  }
  const value = { ...base, ...overrides }
  return { ...value, textDigest: digestPrdClause(value as typeof base) }
}

function manifest() {
  const clauses = [clause()]
  return {
    prdId: 'PRD-1', assetId: 'ASSET-1', revision: d('revision'),
    normalizedPrdDigest: d('normalized-prd'),
    sources: [{ sourceId: 'SOURCE-1', digest: d('source'), byteLength: 128 }],
    attachments: [], sourceCacheIndexDigest: d('cache'), clauses,
    clauseInventoryDigest: digestPrdClauseInventory(clauses),
  }
}

describe('PRD Clause Inventory 契约', () => {
  test('条款清单必须逐条绑定来源区间、文本摘要和清单摘要', () => {
    const value = manifest()
    expect(PrdManifestContentSchema.parse(value)).toEqual(value)
    expect(PrdManifestContentSchema.safeParse({ ...value, clauses: [] }).success).toBe(false)
    expect(PrdManifestContentSchema.safeParse({ ...value,
      clauses: [{ ...value.clauses[0], sourceId: 'SOURCE-UNKNOWN' }],
    }).success).toBe(false)
    expect(PrdManifestContentSchema.safeParse({ ...value,
      clauses: [{ ...value.clauses[0], originalText: '被篡改的原文' }],
    }).success).toBe(false)
    expect(PrdManifestContentSchema.safeParse({ ...value,
      clauses: [{ ...value.clauses[0], sourceSpan: { startLine: 4, startColumn: 1, endLine: 3, endColumn: 2 } }],
    }).success).toBe(false)
    expect(PrdManifestContentSchema.safeParse({ ...value,
      clauses: [value.clauses[0], { ...value.clauses[0] }],
      clauseInventoryDigest: digestPrdClauseInventory([value.clauses[0], value.clauses[0]]),
    }).success).toBe(false)
    expect(PrdManifestContentSchema.safeParse({ ...value, clauseInventoryDigest: d('wrong') }).success).toBe(false)
  })

  test('Scope 对每个 Clause 使用可审计的唯一处置记录', () => {
    const modeled = {
      includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['CLAUSE-1'] }],
      exclusions: [], ambiguities: [], dependencies: [],
      visualScope: { required: false, refs: [] },
      browserScope: { browserIds: ['CHROMIUM'], viewportIds: ['DESKTOP'] },
      clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'modeled' as const,
        requirementIds: ['REQ-1'] }],
      scopeDecision: { status: 'pending' as const, decisionId: 'DECISION-1' },
    }
    expect(AcceptanceScopeContentSchema.parse(modeled)).toEqual(modeled)
    expect(AcceptanceScopeContentSchema.safeParse({ ...modeled, clauseDispositions: [] }).success).toBe(false)
    expect(AcceptanceScopeContentSchema.safeParse({ ...modeled,
      clauseDispositions: [modeled.clauseDispositions[0], modeled.clauseDispositions[0]],
    }).success).toBe(false)
    expect(AcceptanceScopeContentSchema.safeParse({ ...modeled,
      clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'excluded' }],
    }).success).toBe(false)
  })

  test('Rule 与 Oracle 使用一对一的原子结构并各自引用 PRD Clause', () => {
    const requirement = {
      reqId: 'REQ-1', revision: 1, title: '新增待办', actors: ['USER'], entities: ['TODO'],
      preconditions: [],
      rules: [{ ruleId: 'RULE-1', category: 'business' as const, statement: '提交非空标题时新增一项',
        sourceRefs: ['CLAUSE-1'], certainty: 'explicit' as const, oracleIds: ['ORACLE-1'] }],
      states: [], transitions: [],
      observableOutcomes: [{ oracleId: 'ORACLE-1', ruleId: 'RULE-1', statement: '列表新增一项且标题一致',
        sourceRefs: ['CLAUSE-1'] }],
      applicability: [], sourceRefs: ['CLAUSE-1'], status: 'active' as const,
    }
    const model = { modelRevision: 1, requirements: [requirement], coupledDimensions: [],
      applicabilityRules: [], modelDecisionDigest: d('decision') }
    expect(RequirementModelSchema.parse(model)).toEqual(model)
    expect(RequirementModelSchema.safeParse({ ...model, requirements: [{ ...requirement,
      rules: [{ ...requirement.rules[0], oracleIds: ['ORACLE-1', 'ORACLE-2'] }],
      observableOutcomes: [...requirement.observableOutcomes,
        { oracleId: 'ORACLE-2', ruleId: 'RULE-1', statement: '另一结果', sourceRefs: ['CLAUSE-1'] }],
    }] }).success).toBe(false)
    expect(RequirementModelSchema.safeParse({ ...model, requirements: [{ ...requirement,
      observableOutcomes: [{ ...requirement.observableOutcomes[0], ruleId: 'RULE-UNKNOWN' }],
    }] }).success).toBe(false)
  })

  test('Coverage Obligation 显式冻结 Clause、Rule 与 Oracle 三层引用', () => {
    const content = {
      coveragePolicyDigest: d('policy'), pairwiseSeed: 1, universeDigest: d('universe'),
      obligations: [{ obligationId: 'COV-1', reqId: 'REQ-1', clauseIds: ['CLAUSE-1'],
        ruleIds: ['RULE-1'], oracleIds: ['ORACLE-1'], nodeIds: [], actor: 'USER',
        transitionId: 'not-applicable' as const, scenario: 'positive', necessity: 'required' as const,
        applicabilityRuleId: 'APPLICABILITY-1', disposition: { kind: 'automated' as const, caseIds: ['CASE-1'] } }],
    }
    expect(CoverageUniverseContentSchema.parse(content)).toEqual(content)
    for (const field of ['clauseIds', 'oracleIds'] as const) {
      expect(CoverageUniverseContentSchema.safeParse({ ...content,
        obligations: [{ ...content.obligations[0], [field]: undefined }],
      }).success, field).toBe(false)
    }
  })
})
