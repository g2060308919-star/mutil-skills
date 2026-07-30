import { describe, expect, test } from 'vitest'
import {
  PrdUnderstandingProjectionSchema,
  digestPrdUnderstandingProjection,
  digestPrdUnderstandingQuote,
} from '../src/index.js'

const d = (character: string): string => `sha256:${character.repeat(64)}`

function projection() {
  const value = {
    schemaVersion: '1.0.0' as const,
    contractId: 'CONTRACT-TODO',
    contractVersion: 3,
    contractStatus: 'confirmed-by-caller' as const,
    contractSourceDigest: d('c'),
    sourceRevision: d('a'),
    sources: [{
      sourceId: 'PRD-BODY', kind: 'file' as const, ref: 'inputs/prd.md',
      origin: { kind: 'file' as const, ref: 'inputs/prd.md' },
      relevance: 'target' as const, digest: d('b'), byteLength: 18,
    }],
    nodes: [{
      nodeId: 'REQ-ADD-TODO', kind: 'REQ' as const,
      statement: '用户可以新增待办事项。',
      provenance: {
        kind: 'source-fact' as const,
        anchors: [{
          sourceId: 'PRD-BODY',
          sourceSpan: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 11 },
          quote: '用户可以新增待办事项。',
          quoteDigest: digestPrdUnderstandingQuote('用户可以新增待办事项。'),
        }],
      },
      responsibility: 'Todo 页面', upstreamNodeIds: [], downstreamNodeIds: [],
      acceptanceCriteria: ['输入内容并提交后列表出现新事项'],
    }],
    pendingQuestions: [],
    route: {
      skillName: 'e2e' as const,
      steps: [{
        stepId: 'E2E-1', inputNodeIds: ['REQ-ADD-TODO'],
        output: '可追踪 E2E 测试资产与报告', constraints: ['只消费已确认契约'],
        dependencyStepIds: [], completionCondition: '报告覆盖全部授权节点',
      }],
    },
    authorization: {
      status: 'confirmed-by-caller' as const, contractVersion: 3,
      authorizedNodeIds: ['REQ-ADD-TODO'], confirmedAt: '2026-07-28T00:00:00.000Z',
    },
    projectionDigest: '',
  }
  return { ...value, projectionDigest: digestPrdUnderstandingProjection(value) }
}

describe('understand-prd → E2E execution projection', () => {
  test('accepts one caller-confirmed contract projection bound to one E2E route', () => {
    const value = projection()
    expect(PrdUnderstandingProjectionSchema.parse(value)).toEqual(value)
  })

  test('rejects stale authorization, missing source refs, inference and digest drift', () => {
    const value = projection()
    expect(PrdUnderstandingProjectionSchema.safeParse({
      ...value,
      authorization: { ...value.authorization, contractVersion: 2 },
    }).success).toBe(false)
    expect(PrdUnderstandingProjectionSchema.safeParse({
      ...value,
      nodes: [{ ...value.nodes[0], provenance: {
        ...value.nodes[0]!.provenance,
        anchors: [{ ...value.nodes[0]!.provenance.anchors[0]!, sourceId: 'MISSING' }],
      } }],
    }).success).toBe(false)
    expect(PrdUnderstandingProjectionSchema.safeParse({
      ...value,
      nodes: [{ ...value.nodes[0], provenance: { kind: 'inference', confidence: 0.9 } }],
    }).success).toBe(false)
    expect(PrdUnderstandingProjectionSchema.safeParse({
      ...value, projectionDigest: d('f'),
    }).success).toBe(false)
  })

  test('source-fact must retain exact quoted source text instead of presenting a paraphrase as fact', () => {
    const value = projection()
    const changed = {
      ...value,
      nodes: [{ ...value.nodes[0], statement: '系统也许支持批量添加。' }],
    }
    changed.projectionDigest = digestPrdUnderstandingProjection(changed)
    expect(PrdUnderstandingProjectionSchema.safeParse(changed).success).toBe(false)
  })

  test('execution projection 只接受已冻结文件快照和执行相关来源', () => {
    const value = projection()
    expect(PrdUnderstandingProjectionSchema.safeParse({
      ...value,
      sources: [{ ...value.sources[0], kind: 'url', ref: 'https://example.test/prd' }],
    }).success).toBe(false)
    expect(PrdUnderstandingProjectionSchema.safeParse({
      ...value,
      sources: [{ ...value.sources[0], relevance: 'out-of-scope' }],
    }).success).toBe(false)
  })
})
