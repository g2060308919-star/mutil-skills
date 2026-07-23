import { describe, expect, test } from 'vitest'
import { CleanupPlanDefinitionSchema, digestCleanupPlanDefinition, digestText } from '../src/index.js'

const plan = {
  schemaVersion: '1.0.0' as const, cleanupPlanId: 'CLEANUP-1', actionId: 'ACTION-1', leaseId: 'LEASE-1',
  executorId: 'EXECUTOR-RESET-ORDER', cleanupRequestIntentIds: ['INTENT-CLEANUP'],
  verificationProbes: [{ probeId: 'PROBE-STATE', kind: 'resource-state' as const,
    expectedDigest: digestText('test/v1', 'pending') }], timeoutMs: 30_000,
}

const browserLocalPlan = {
  schemaVersion: '2.0.0' as const,
  transport: 'browser-local' as const,
  cleanupPlanId: 'CLEANUP-FULL-1',
  actionId: 'ACTION-FULL-1',
  leaseId: 'LEASE-FULL-1',
  executorId: 'FULL-PLAYWRIGHT' as const,
  cleanupProgramDigest: digestText('full-playwright-cleanup-source/v1', 'cleanup source'),
  cleanupRequestIntentIds: [],
  verificationProbes: [{
    probeId: 'PROBE-BROWSER-1', kind: 'browser-observation' as const,
    expectedDigest: digestText('test/v1', 'clean browser state'),
  }],
  timeoutMs: 30_000,
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

  test('browser-local plan 固定 full Playwright executor，并允许无网络 cleanup', () => {
    expect(CleanupPlanDefinitionSchema.parse(browserLocalPlan)).toEqual(browserLocalPlan)
  })

  test('browser-local plan 拒绝错误 executor 与非 browser verification', () => {
    expect(CleanupPlanDefinitionSchema.safeParse({
      ...browserLocalPlan, executorId: 'EXECUTOR-OTHER',
    }).success).toBe(false)
    expect(CleanupPlanDefinitionSchema.safeParse({
      ...browserLocalPlan,
      verificationProbes: [{ ...browserLocalPlan.verificationProbes[0], kind: 'resource-state' }],
    }).success).toBe(false)
  })

  test('browser-local cleanup intent 唯一且最多 1,000 个', () => {
    expect(CleanupPlanDefinitionSchema.safeParse({
      ...browserLocalPlan, cleanupRequestIntentIds: ['INTENT-1', 'INTENT-1'],
    }).success).toBe(false)
    expect(CleanupPlanDefinitionSchema.safeParse({
      ...browserLocalPlan,
      cleanupRequestIntentIds: Array.from({ length: 1_001 }, (_, index) => `INTENT-${index}`),
    }).success).toBe(false)
  })
})
