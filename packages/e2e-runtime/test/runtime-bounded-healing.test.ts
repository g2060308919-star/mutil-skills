import { describe, expect, test } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import { authorizeRuntimeHealingReplay, settleRuntimeHealingAudit } from '../src/runtime-bounded-healing.js'

const fact = () => ({ schemaVersion: 'runtime-healing-audit/v1' as const,
  proposalId: 'HEAL-1', caseId: 'CASE-1', actionId: 'ACTION-1', firstAttemptId: 'ATTEMPT-1',
  firstEvidenceDigest: digestText('test/v1', 'first'), requiredOracleIds: ['ORACLE-1', 'ORACLE-2'],
  revision: 2, changeDigest: digestText('test/v1', 'change'), status: 'awaiting-execution-approval' as const })

describe('Runtime bounded healing audit', () => {
  test('只有新 Attempt 的全部 Oracle 明确通过才 accepted', () => {
    const authorized = authorizeRuntimeHealingReplay(fact())
    expect(settleRuntimeHealingAudit({ fact: authorized, finalAttemptId: 'ATTEMPT-2',
      executionStatus: 'passed', oracleResults: [{ oracleId: 'ORACLE-1', passed: true }] }))
      .toMatchObject({ status: 'rejected', replayedOracleIds: ['ORACLE-1'] })
    expect(settleRuntimeHealingAudit({ fact: authorized, finalAttemptId: 'ATTEMPT-2',
      executionStatus: 'passed', oracleResults: [
        { oracleId: 'ORACLE-2', passed: true }, { oracleId: 'ORACLE-1', passed: true },
      ] })).toMatchObject({ status: 'accepted', replayedOracleIds: ['ORACLE-1', 'ORACLE-2'] })
  })
})
