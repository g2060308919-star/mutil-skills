import { describe, expect, test, vi } from 'vitest'
import { digestText, type HealingProposal } from '@mutil-skills/e2e-contracts'
import { executeBoundedHealing } from '../src/bounded-healing.js'

const digest = (value: string) => digestText('bounded-healing-test/v1', value)
const proposal: HealingProposal = { proposalId: 'HEAL-1', actionId: 'ACTION-1', baseRevision: 1,
  caseTimeoutMs: 5_000, semanticDigestBefore: digest('semantic'), semanticDigestAfter: digest('semantic'),
  approvalSubjectDigestBefore: digest('approval'), approvalSubjectDigestAfter: digest('approval'),
  mutations: [{ kind: 'locator-candidate', before: [{ strategy: 'label', value: '旧名称' }],
    after: [{ strategy: 'test-id', value: 'stable-name' }] }] }

describe('executeBoundedHealing', () => {
  test('绑定失败 Attempt/页面证据并在新 Attempt 重跑全部 Oracle', async () => {
    const execute = vi.fn(async () => ({ attemptId: 'ATTEMPT-2',
      oracleResults: [{ oracleId: 'ORACLE-1', status: 'passed' as const },
        { oracleId: 'ORACLE-2', status: 'passed' as const }] }))
    const result = await executeBoundedHealing({ proposal, failure: { caseId: 'CASE-1',
      actionId: 'ACTION-1', attemptId: 'ATTEMPT-1', pageIdentityDigest: digest('page'),
      evidenceDigest: digest('evidence'), requiredOracleIds: ['ORACLE-1', 'ORACLE-2'] },
    context: { currentSemanticDigest: digest('semantic'), currentApprovalSubjectDigest: digest('approval'),
      protectedPageIdentitySignals: [] }, priorAttempts: 0, maxAttempts: 1,
    authorize: async () => true, execute })

    expect(result).toMatchObject({ status: 'recovered', firstAttemptId: 'ATTEMPT-1',
      finalAttemptId: 'ATTEMPT-2', recoveryRateSample: 1, falseRepairRateSample: 0 })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ requiredOracleIds: ['ORACLE-1', 'ORACLE-2'] }))
  })

  test('页面身份漂移、次数超限或 Oracle 缺失均 fail closed', async () => {
    const base = { proposal, failure: { caseId: 'CASE-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1',
      pageIdentityDigest: digest('page'), evidenceDigest: digest('evidence'), requiredOracleIds: ['ORACLE-1'] },
    context: { currentSemanticDigest: digest('semantic'), currentApprovalSubjectDigest: digest('approval'),
      protectedPageIdentitySignals: [] }, maxAttempts: 1, authorize: async () => true }
    await expect(executeBoundedHealing({ ...base, priorAttempts: 1,
      execute: async () => ({ attemptId: 'ATTEMPT-2', oracleResults: [] }) }))
      .resolves.toMatchObject({ status: 'blocked', reasonCode: 'E2E_HEAL_ATTEMPT_LIMIT_REACHED' })
    await expect(executeBoundedHealing({ ...base, priorAttempts: 0, observedPageIdentityDigest: digest('other'),
      execute: async () => ({ attemptId: 'ATTEMPT-2', oracleResults: [] }) }))
      .resolves.toMatchObject({ status: 'blocked', reasonCode: 'E2E_HEAL_PAGE_IDENTITY_CHANGED' })
    await expect(executeBoundedHealing({ ...base, priorAttempts: 0,
      execute: async () => ({ attemptId: 'ATTEMPT-2', oracleResults: [] }) }))
      .resolves.toMatchObject({ status: 'misrepair', reasonCode: 'E2E_HEAL_ORACLE_SET_INCOMPLETE',
        falseRepairRateSample: 1 })
  })
})
