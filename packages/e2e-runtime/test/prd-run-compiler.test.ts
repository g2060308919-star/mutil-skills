import { describe, expect, test } from 'vitest'
import {
  digestPrdUnderstandingProjection,
  digestPrdUnderstandingQuote,
  digestText,
  type DeclarativePrdRunDesign,
  type PrdUnderstandingProjection,
} from '@mutil-skills/e2e-contracts'
import { compilePrdRun } from '../src/prd-run-compiler.js'

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
})

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
