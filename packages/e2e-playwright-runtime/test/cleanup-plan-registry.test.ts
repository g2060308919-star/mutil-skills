import { describe, expect, test, vi } from 'vitest'
import { digestCleanupPlanDefinition, digestText } from '@mutil-skills/e2e-contracts'
import { LocalCleanupPlanRegistry } from '../src/index.js'

const definition = {
  schemaVersion: '1.0.0' as const, cleanupPlanId: 'CLEANUP-1', actionId: 'ACTION-1', leaseId: 'LEASE-1',
  executorId: 'EXECUTOR-1', cleanupRequestIntentIds: ['INTENT-CLEANUP'],
  verificationProbes: [{ probeId: 'PROBE-1', kind: 'resource-state' as const,
    expectedDigest: digestText('test/v1', 'clean') }], timeoutMs: 30_000,
}

describe('LocalCleanupPlanRegistry', () => {
  test('按同一计划 preimage 绑定 ID、digest、action、lease 和受信 executor', async () => {
    const registry = LocalCleanupPlanRegistry.create()
    const execute = vi.fn(async () => ({ status: 'verified-clean' as const,
      resultDigest: digestText('test/v1', 'result'), leaseReceiptDigest: digestText('test/v1', 'lease') }))
    const registered = registry.register({ definition, execute })
    expect(registered.digest).toBe(digestCleanupPlanDefinition(definition))
    await expect(registry.execute({ cleanupPlanId: definition.cleanupPlanId,
      cleanupPlanDigest: registered.digest, actionId: definition.actionId, leaseId: definition.leaseId,
      execution: { result: {} as any, outcomeDigest: digestText('test/v1', 'outcome') } }))
      .resolves.toMatchObject({ status: 'verified-clean' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('禁止同 ID 替换定义或 executor，并拒绝任一 binding 错配', () => {
    const registry = LocalCleanupPlanRegistry.create()
    const execute = async () => ({ status: 'verified-clean' as const,
      resultDigest: digestText('test/v1', 'result'), leaseReceiptDigest: digestText('test/v1', 'lease') })
    const registered = registry.register({ definition, execute })
    expect(() => registry.register({ definition: { ...definition, executorId: 'EXECUTOR-OTHER' }, execute }))
      .toThrow('E2E_CLEANUP_PLAN_IMMUTABLE')
    expect(() => registry.register({ definition, execute: async () => execute() }))
      .toThrow('E2E_CLEANUP_PLAN_IMMUTABLE')
    expect(() => registry.assertBinding({ cleanupPlanId: definition.cleanupPlanId,
      cleanupPlanDigest: registered.digest, actionId: 'ACTION-OTHER', leaseId: definition.leaseId }))
      .toThrow('E2E_CLEANUP_PLAN_BINDING_MISMATCH')
  })
})
