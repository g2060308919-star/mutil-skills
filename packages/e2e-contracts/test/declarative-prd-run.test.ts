import { describe, expect, test } from 'vitest'
import {
  CompiledPrdRunPlanSchema,
  DeclarativePrdRunDesignSchema,
  digestCompiledPrdRunPlan,
} from '../src/declarative-prd-run.js'

describe('declarative PRD run contracts', () => {
  test('accepts contract-bound cases while rejecting caller-owned artifact facts', () => {
    const design = designFixture()
    expect(DeclarativePrdRunDesignSchema.parse(design).cases).toHaveLength(3)
    expect(() => DeclarativePrdRunDesignSchema.parse({
      ...design,
      cases: [{ ...design.cases[0], contentDigest: `sha256:${'a'.repeat(64)}` }],
    })).toThrow()
  })

  test('requires unique local keys and complete action/oracle bindings', () => {
    const design = designFixture()
    design.cases[1]!.caseKey = design.cases[0]!.caseKey
    expect(() => DeclarativePrdRunDesignSchema.parse(design)).toThrow(/caseKey/)

    const missingAction = designFixture()
    missingAction.cases[0]!.oracles[0]!.actionKey = 'UNKNOWN'
    expect(() => DeclarativePrdRunDesignSchema.parse(missingAction)).toThrow(/actionKey/)
  })

  test('binds the compiled plan digest to canonical plan content', () => {
    const plan = {
      schemaVersion: '1.0.0' as const,
      contractProjectionDigest: `sha256:${'b'.repeat(64)}`,
      cases: [{
        queueOrdinal: 0, caseId: 'CASE-0001', caseKey: 'create', title: '创建项目',
        actor: 'USER', contractNodeIds: ['REQ-1'], failurePolicy: 'stop-required' as const,
        actions: [{ actionId: 'ACTION-0001-0001', actionKey: 'submit', kind: 'full-playwright' as const,
          effect: 'reversible-write' as const, statement: '提交表单' }],
        oracles: [{ oracleId: 'ORACLE-0001-0001', oracleKey: 'created', actionId: 'ACTION-0001-0001',
          contractNodeId: 'REQ-1', acceptanceCriterion: '显示创建成功' }],
      }],
      compilerDigest: `sha256:${'0'.repeat(64)}`,
    }
    plan.compilerDigest = digestCompiledPrdRunPlan(plan)
    expect(CompiledPrdRunPlanSchema.parse(plan).compilerDigest).toBe(plan.compilerDigest)
    plan.cases[0]!.title = '漂移'
    expect(() => CompiledPrdRunPlanSchema.parse(plan)).toThrow(/compilerDigest/)
  })
})

function designFixture() {
  return {
    schemaVersion: '1.0.0' as const,
    cases: Array.from({ length: 3 }, (_, index) => ({
      caseKey: `case-${index + 1}`,
      title: `场景 ${index + 1}`,
      actor: 'USER',
      contractNodeIds: [`REQ-${index + 1}`],
      failurePolicy: index === 0 ? 'stop-required' as const : 'continue' as const,
      actions: [{
        actionKey: 'submit', kind: 'full-playwright' as const,
        effect: 'reversible-write' as const, statement: '提交表单',
      }],
      oracles: [{
        oracleKey: 'visible', actionKey: 'submit', contractNodeId: `REQ-${index + 1}`,
        acceptanceCriterion: `显示结果 ${index + 1}`,
      }],
    })),
  }
}
