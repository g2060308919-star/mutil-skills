import { describe, expect, test } from 'vitest'
import * as contracts from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('DeclarativeExecutionBindingV1', () => {
  test('接受首批声明式动作和 Oracle，并将候选乱序规范化为相同摘要', () => {
    const normalize = (contracts as Record<string, unknown>).normalizeDeclarativeExecutionBinding as
      (input: unknown) => { bindingDigest: string; cases: Array<{ actions: Array<{ actionId: string }> }> }
    expect(normalize).toBeTypeOf('function')
    const left = normalize(binding())
    const reversed = binding()
    reversed.cases[0]!.actions.reverse()
    reversed.cases[0]!.oracles.reverse()
    const right = normalize(reversed)
    expect(left.bindingDigest).toBe(right.bindingDigest)
    expect(left.cases[0]!.actions.map((action) => action.actionId)).toEqual(['ACTION-1', 'ACTION-2'])
  })

  test('拒绝未知 action/oracle、自由 JavaScript 和调用方伪造的授权结果', () => {
    const schema = (contracts as Record<string, unknown>).DeclarativeExecutionBindingV1Schema as {
      safeParse(input: unknown): { success: boolean }
    }
    expect(schema).toBeDefined()
    const unknownAction = binding() as any
    unknownAction.cases[0].actions[0].kind = 'evaluate-javascript'
    expect(schema.safeParse(unknownAction).success).toBe(false)
    const source = binding() as any
    source.cases[0].actions[0].source = 'process.exit(0)'
    expect(schema.safeParse(source).success).toBe(false)
    const forged = binding() as any
    forged.approval = { status: 'approved' }
    forged.verdict = 'accepted'
    expect(schema.safeParse(forged).success).toBe(false)
  })

  test('写动作缺少 DataLease 或 Cleanup 时 fail closed', () => {
    const schema = (contracts as Record<string, unknown>).DeclarativeExecutionBindingV1Schema as {
      safeParse(input: unknown): { success: boolean }
    }
    expect(schema).toBeDefined()
    const candidate = binding() as any
    candidate.cases[0].executionLane = 'trusted-reversible-write'
    candidate.cases[0].actions[1].effect = 'reversible-write'
    expect(schema.safeParse(candidate).success).toBe(false)
  })
})

function binding() {
  const locatorCandidates = [{ kind: 'role' as const, role: 'button' as const, name: '保存' }]
  return {
    schemaVersion: 'declarative-execution-binding/v1' as const,
    planCompilerDigest: digest('a'), targetProbeDigest: digest('b'),
    cases: [{
      caseId: 'CASE-1', executionLane: 'trusted-read-only' as const,
      pageIdentityPolicy: {
        schemaVersion: '1.0.0' as const,
        url: { origin: 'https://example.test', pathPattern: '/orders' },
        signals: [{ kind: 'role' as const, role: 'main' as const, name: '订单' }],
        match: { mode: 'all' as const },
      },
      actions: [
        { kind: 'assert-only' as const, actionId: 'ACTION-1', effect: 'read' as const,
          pageScope: { page: 'current' as const, frame: { kind: 'main' as const } }, locatorCandidates,
          timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' as const } },
        { kind: 'click' as const, actionId: 'ACTION-2', effect: 'read' as const,
          pageScope: { page: 'current' as const, frame: { kind: 'main' as const } }, locatorCandidates,
          timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' as const } },
      ],
      oracles: [
        { kind: 'text' as const, oracleId: 'ORACLE-1', actionId: 'ACTION-1', locatorCandidates,
          comparator: 'contains' as const, expected: '待审核', deadlineMs: 5_000, evidenceKinds: ['dom'] },
        { kind: 'url' as const, oracleId: 'ORACLE-2', actionId: 'ACTION-2',
          comparator: 'matches' as const, expected: '/orders', deadlineMs: 5_000, evidenceKinds: ['url'] },
      ], dataNeeds: [], cleanupIntents: [],
    }],
  }
}
