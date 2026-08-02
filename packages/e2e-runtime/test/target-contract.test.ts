import { describe, expect, test } from 'vitest'
import {
  assertTargetEnvironmentConsistency,
  createTargetContractFact,
} from '../src/target-contract.js'

const policy = {
  schemaVersion: '1.0.0' as const,
  url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
  signals: [{ kind: 'test-id' as const, value: 'orders-page' }],
  match: { mode: 'all' as const },
}

describe('TargetContract fact', () => {
  test('从唯一 TargetContract 派生稳定环境身份，不接受重复环境 ID', () => {
    const fact = createTargetContractFact({
      schemaVersion: '1.0.0', targetUrl: 'http://localhost:3000/orders',
      baseOrigin: 'http://localhost:3000', environmentLabel: 'local',
      pageIdentityPolicy: policy, allowedNavigationOrigins: ['http://localhost:3000'],
    })
    expect(fact).toMatchObject({
      schemaVersion: '1.0.0', contract: { environmentLabel: 'local' },
      contractDigest: expect.stringMatching(/^sha256:/),
      environmentIdentityDigest: expect.stringMatching(/^sha256:/),
    })
    expect(createTargetContractFact(fact.contract)).toEqual(fact)
    expect(() => assertTargetEnvironmentConsistency(fact, {
      baseOrigin: 'http://localhost:3001', environmentLabel: 'local',
    })).toThrowError(expect.objectContaining({ code: 'E2E_TARGET_ENVIRONMENT_MISMATCH' }))
  })
})
