import { describe, expect, it } from 'vitest'
import { digestOracleCheckpointValue } from '../src/compiler-input.js'
import {
  AssertionResultV1Schema,
  projectAssertionResultV1,
} from '../src/assertion-result.js'

const expectedJson = '{"visible":true}'
const actualJson = '{"visible":true}'

describe('AssertionResultV1 只读投影', () => {
  it('逐字段投影 checkpoint，不创造第二份断言事实', () => {
    expect(projectAssertionResultV1({
      checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1', expectedJson, actualJson,
      expectedDigest: digestOracleCheckpointValue(expectedJson),
      actualDigest: digestOracleCheckpointValue(actualJson),
      status: 'passed', evidenceIds: ['EVIDENCE-1', 'EVIDENCE-2'],
    })).toEqual({
      schemaVersion: '1.0.0', checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1',
      expected: { canonicalJson: expectedJson, digest: digestOracleCheckpointValue(expectedJson) },
      actual: { canonicalJson: actualJson, digest: digestOracleCheckpointValue(actualJson) },
      status: 'passed', evidenceRefs: ['EVIDENCE-1', 'EVIDENCE-2'],
    })
  })

  it('拒绝 status、JSON、digest 或重复 evidence 与源 checkpoint 语义矛盾的结果', () => {
    const valid = projectAssertionResultV1({
      checkpointId: 'CHECKPOINT-1', oracleId: 'ORACLE-1', expectedJson, actualJson,
      expectedDigest: digestOracleCheckpointValue(expectedJson),
      actualDigest: digestOracleCheckpointValue(actualJson), status: 'passed', evidenceIds: ['EVIDENCE-1'],
    })
    expect(AssertionResultV1Schema.safeParse({ ...valid, status: 'failed' }).success).toBe(false)
    expect(AssertionResultV1Schema.safeParse({ ...valid, evidenceRefs: ['EVIDENCE-1', 'EVIDENCE-1'] }).success)
      .toBe(false)
  })
})
