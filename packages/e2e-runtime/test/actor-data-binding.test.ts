import { describe, expect, test } from 'vitest'
import { createTargetContractFact } from '../src/target-contract.js'
import { assertActorDataBinding, deriveActorDataRequirements } from '../src/actor-data-binding.js'

const plan = {
  schemaVersion: '1.0.0' as const, contractProjectionDigest: `sha256:${'1'.repeat(64)}`,
  compilerDigest: `sha256:${'2'.repeat(64)}`,
  cases: [{ queueOrdinal: 0, caseId: 'CASE-0001', caseKey: 'review', title: 'Review', actor: 'auditor',
    contractNodeIds: ['REQ-1'], actions: [{ actionId: 'ACTION-0001-0001', actionKey: 'review',
      kind: 'full-playwright' as const, effect: 'reversible-write' as const, statement: 'Review' }],
    oracles: [{ oracleId: 'ORACLE-0001-0001', oracleKey: 'reviewed', actionId: 'ACTION-0001-0001',
      contractNodeId: 'REQ-1', acceptanceCriterion: 'Reviewed' }], failurePolicy: 'stop-required' as const }],
}
const target = createTargetContractFact({ schemaVersion: '1.0.0', targetUrl: 'https://example.test/',
  baseOrigin: 'https://example.test', environmentLabel: 'staging',
  pageIdentityPolicy: { schemaVersion: '1.0.0', url: { origin: 'https://example.test', pathPattern: '/' },
    signals: [{ kind: 'role', role: 'main', name: 'Home' }], match: { mode: 'all' } },
  allowedNavigationOrigins: ['https://example.test'] })
const intent = { schemaVersion: 'actor-data-intent/v1' as const, intentId: 'INTENT-AUDITOR',
  actor: 'auditor', role: 'reviewer', credentialRef: 'secret://accounts/reviewer',
  dataNeeds: [{ needId: 'ORDER-1', resourceType: 'order', initialState: { status: 'pending' },
    access: 'reversible-write' as const, seedStrategy: 'idempotent-seed' as const,
    cleanupExpectation: 'delete' as const }] }

describe('Actor/Data Intent Runtime 绑定', () => {
  test('Runtime 按 Case 派生 Requirement，并绑定权威 Environment 与 Target', () => {
    expect(deriveActorDataRequirements({ intents: [intent], plan, target })).toEqual([
      expect.objectContaining({ schemaVersion: 'actor-data-requirement/v1', caseId: 'CASE-0001',
        actor: 'auditor', role: 'reviewer', environment: 'staging',
        targetIdentity: target.contractDigest, credentialRef: 'secret://accounts/reviewer' }),
    ])
  })

  test('角色未映射到 Case 或同一 Case 的 needId 歧义时 fail closed', () => {
    expect(() => deriveActorDataRequirements({ intents: [{ ...intent, actor: 'unknown' }], plan, target }))
      .toThrow(expect.objectContaining({ code: 'E2E_RUNTIME_ACTOR_DATA_INTENT_UNMAPPED' }))
    expect(() => deriveActorDataRequirements({ intents: [intent, { ...intent, intentId: 'INTENT-2' }],
      plan, target })).toThrow(expect.objectContaining({ code: 'E2E_RUNTIME_ACTOR_DATA_NEED_AMBIGUOUS' }))
  })

  test('可执行绑定必须逐项引用 Runtime 派生的 Requirement', () => {
    const [requirement] = deriveActorDataRequirements({ intents: [intent], plan, target })
    const binding = { schemaVersion: 'declarative-execution-binding/v1' as const,
      planCompilerDigest: plan.compilerDigest, targetProbeDigest: `sha256:${'3'.repeat(64)}`,
      cases: [{ caseId: 'CASE-0001', dataNeeds: [{ dataNeedId: 'ORDER-1', kind: 'fixture' as const,
        ref: requirement!.requirementId }] }] }
    expect(() => assertActorDataBinding({ requirements: [requirement!], binding })).not.toThrow()
    expect(() => assertActorDataBinding({ requirements: [requirement!],
      binding: { ...binding, cases: [{ caseId: 'CASE-0001', dataNeeds: [] }] } }))
      .toThrow(expect.objectContaining({ code: 'E2E_RUNTIME_ACTOR_DATA_BINDING_INCOMPLETE' }))
  })
})
