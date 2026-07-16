import { describe, expect, test } from 'vitest'
import { CleanupPlanDefinitionSchema, digestCleanupPlanDefinition, digestText } from '../src/index.js'

const plan = {
  schemaVersion: '1.0.0' as const, cleanupPlanId: 'CLEANUP-1', actionId: 'ACTION-1', leaseId: 'LEASE-1',
  executorId: 'EXECUTOR-RESET-ORDER', cleanupRequestIntentIds: ['INTENT-CLEANUP'],
  verificationProbes: [{ probeId: 'PROBE-STATE', kind: 'resource-state' as const,
    expectedDigest: digestText('test/v1', 'pending') }], timeoutMs: 30_000,
}

describe('CleanupPlanDefinition', () => {
  test('完整定义产生确定摘要，ID、请求与验证探针都进入 preimage', () => {
    expect(digestCleanupPlanDefinition(plan)).toMatch(/^sha256:/)
    expect(digestCleanupPlanDefinition({ ...plan, executorId: 'EXECUTOR-OTHER' }))
      .not.toBe(digestCleanupPlanDefinition(plan))
  })

  test('拒绝重复 intent、重复 probe 和额外字段', () => {
    expect(() => CleanupPlanDefinitionSchema.parse({ ...plan,
      cleanupRequestIntentIds: ['INTENT-CLEANUP', 'INTENT-CLEANUP'] })).toThrow(/唯一/)
    expect(() => CleanupPlanDefinitionSchema.parse({ ...plan, unexpected: true })).toThrow()
  })
})
