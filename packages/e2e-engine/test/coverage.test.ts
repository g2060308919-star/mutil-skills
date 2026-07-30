import { describe, expect, test } from 'vitest'
import type { CoveragePolicy, InteractionNode, RequirementModel } from '@mutil-skills/e2e-contracts'
import { digestText } from '@mutil-skills/e2e-contracts'
import { buildCoverageUniverse } from '../src/index.js'

const modelDigest = digestText('requirement-model/v1', 'confirmed-model')

const model: RequirementModel = {
  modelRevision: 1,
  requirements: [
    {
      reqId: 'REQ-ORDER-1',
      revision: 1,
      title: '审核订单',
      actors: ['reviewer'],
      entities: ['order'],
      preconditions: ['存在待审核订单'],
      rules: [
        {
          ruleId: 'RULE-ORDER-1',
          category: 'business',
          statement: '审核后状态变为已通过',
          sourceRefs: ['prd:审核流程'],
          certainty: 'explicit',
          oracleIds: ['ORACLE-APPROVED'],
        },
      ],
      states: [{ stateId: 'pending', title: '待审核' }, { stateId: 'approved', title: '已通过' }],
      transitions: [
        { transitionId: 'TRANSITION-ORDER-1', from: 'pending', action: 'approve', to: 'approved' },
      ],
      observableOutcomes: [{ oracleId: 'ORACLE-APPROVED', ruleId: 'RULE-ORDER-1',
        statement: '页面显示已通过', sourceRefs: ['prd:审核流程'] }],
      applicability: [{ dimension: 'actor', value: 'reviewer', required: true }],
      sourceRefs: ['prd:审核流程'],
      status: 'active',
    },
  ],
  coupledDimensions: [],
  applicabilityRules: ['actor:reviewer'],
  modelDecisionDigest: modelDigest,
}

const nodes: InteractionNode[] = [
  {
    nodeId: 'NODE-ORDER-APPROVE',
    reqId: 'REQ-ORDER-1',
    kind: 'action',
    title: '点击审核通过',
    effect: 'reversible-write',
    hasOracle: true,
  },
]

const policy: CoveragePolicy = {
  policyVersion: '1.0.0',
  ruleScenarios: { business: ['happy-path'] },
  pairwiseSeed: 17,
}

describe('buildCoverageUniverse', () => {
  test('creates a stable obligation set from the confirmed model', () => {
    const first = buildCoverageUniverse({
      model,
      modelDigest,
      confirmedModelDigest: modelDigest,
      nodes,
      policy,
      dispositionFor: (candidate) => ({ kind: 'automated', caseIds: [`CASE-${candidate.kind.toUpperCase()}`] }),
    })
    const second = buildCoverageUniverse({
      model: { ...model },
      modelDigest,
      confirmedModelDigest: modelDigest,
      nodes: [...nodes],
      policy: { ...policy },
      dispositionFor: (candidate) => ({ kind: 'automated', caseIds: [`CASE-${candidate.kind.toUpperCase()}`] }),
    })

    expect(first.obligations.map((item) => item.kind)).toEqual(['actor', 'critical-node', 'rule', 'transition'])
    expect(first.universeDigest).toBe(second.universeDigest)
  })

  test('rejects a model that is not the model the user confirmed', () => {
    expect(() => buildCoverageUniverse({
      model,
      modelDigest,
      confirmedModelDigest: digestText('requirement-model/v1', 'another-model'),
      nodes,
      policy,
      dispositionFor: () => ({ kind: 'automated', caseIds: ['CASE-1'] }),
    })).toThrowError(expect.objectContaining({ code: 'E2E_COVERAGE_MODEL_NOT_CONFIRMED' }))
  })

  test('rejects not-applicable without a signed decision reference', () => {
    expect(() => buildCoverageUniverse({
      model,
      modelDigest,
      confirmedModelDigest: modelDigest,
      nodes,
      policy,
      dispositionFor: () => ({ kind: 'not-applicable', policyCode: 'NOT-APPLICABLE', rationale: '不适用' }),
    })).toThrowError(expect.objectContaining({ code: 'E2E_COVERAGE_NA_UNAPPROVED' }))
  })
})
