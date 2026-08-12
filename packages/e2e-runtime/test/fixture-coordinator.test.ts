import { describe, expect, test, vi } from 'vitest'
import { FixtureCoordinator, authorizeFixtureAdapter, type FixtureAdapter } from '../src/fixture-coordinator.js'
import { digestText, type ActorDataRequirementV1 } from '@mutil-skills/e2e-contracts'

const req = (caseId = 'CASE-1'): ActorDataRequirementV1 => ({
  schemaVersion: 'actor-data-requirement/v1', requirementId: 'REQ-1', caseId,
  actor: 'auditor', role: 'reviewer', tenant: 'tenant-a', environment: 'staging',
  targetIdentity: 'TARGET-1', credentialRef: 'secret://reviewer', dataNeeds: [{
    needId: 'ORDER-1', resourceType: 'order', initialState: { status: 'pending' },
    access: 'reversible-write', seedStrategy: 'idempotent-seed', cleanupExpectation: 'delete',
  }],
})

function fixture() {
  const resources = new Set<string>()
  const adapter: FixtureAdapter = {
    identity: 'fixture-adapter://local/v1',
    async provision(input) { resources.add(input.namespacedResourceKey); return {
      logicalResourceKey: `${input.need.resourceType}:${input.need.needId}`,
      cleanupPlanRef: `cleanup://${input.namespacedResourceKey}`,
      reloadOracleRefs: [`oracle://${input.namespacedResourceKey}`],
    } },
    async cleanup(input) { resources.delete(input.namespacedResourceKey) },
    async reloadAbsent(input) { return !resources.has(input.namespacedResourceKey) },
    async inspect(input) { return resources.has(input.namespacedResourceKey) ? 'owned' : 'absent' },
  }
  let lease = 0
  const coordinator = new FixtureCoordinator({
    actorResolver: { async resolve() { return { accountRef: 'account://reviewer',
      actor: 'auditor', role: 'reviewer', tenant: 'tenant-a', environment: 'staging', targetIdentity: 'TARGET-1' } } },
    adapter: authorizeFixtureAdapter(adapter, { authority: 'fixture-authority', gateway: 'fixture-gateway' }),
    leaseAuthority: { async acquire(input) { lease++; return { leaseId: `LEASE-${lease}`, expiresAt: '2026-08-12T01:00:00.000Z' } },
      async release() {}, async quarantine() {} },
    now: () => new Date('2026-08-12T00:00:00.000Z'),
  })
  return { coordinator, adapter, resources }
}

describe('FixtureCoordinator', () => {
  test('角色/租户/环境/目标不匹配时在 adapter 调用前阻断', async () => {
    const { coordinator, adapter } = fixture(); const provision = vi.spyOn(adapter, 'provision')
    await expect(coordinator.provision({ runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      requirement: { ...req(), targetIdentity: 'TARGET-OTHER' } })).rejects.toThrow('E2E_FIXTURE_ACTOR_BINDING_MISMATCH')
    expect(provision).not.toHaveBeenCalled()
  })

  test('两个 Run 的同一 logical need 产生不同 namespace/Lease 且不可互相 cleanup', async () => {
    const { coordinator } = fixture()
    const [a, b] = await Promise.all([
      coordinator.provision({ runId: 'RUN-A', attemptId: 'ATTEMPT-1', requirement: req() }),
      coordinator.provision({ runId: 'RUN-B', attemptId: 'ATTEMPT-1', requirement: req() }),
    ])
    expect(a.resources[0]?.namespacedResourceKey).not.toBe(b.resources[0]?.namespacedResourceKey)
    expect(a.resources[0]?.leaseId).not.toBe(b.resources[0]?.leaseId)
    await expect(coordinator.cleanup({ runId: 'RUN-B', attemptId: 'ATTEMPT-1', fixture: a }))
      .rejects.toThrow('E2E_FIXTURE_OWNER_MISMATCH')
  })

  test('Cleanup 后 Reload 仍存在时失败并保留 residual；recover 不重放写', async () => {
    const { coordinator, adapter } = fixture()
    const provisioned = await coordinator.provision({ runId: 'RUN-A', attemptId: 'ATTEMPT-1', requirement: req() })
    vi.spyOn(adapter, 'reloadAbsent').mockResolvedValue(false)
    const outcome = await coordinator.cleanup({ runId: 'RUN-A', attemptId: 'ATTEMPT-1', fixture: provisioned })
    expect(outcome).toMatchObject({ status: 'failed', reloadVerified: false, residuals: [{ ownerRunId: 'RUN-A' }] })
    const recovery = await coordinator.recover({ runId: 'RUN-A', attemptId: 'ATTEMPT-1', fixture: provisioned })
    expect(recovery.replayedUncertainWrite).toBe(false)
  })

  test('未授权 adapter 与 cleanup 异常均 fail closed，且输出不泄漏 Secret', async () => {
    const { coordinator, adapter } = fixture()
    const unauthorized = { ...adapter }
    expect(() => new FixtureCoordinator({ actorResolver: {} as never, adapter: unauthorized,
      leaseAuthority: {} as never })).toThrow('E2E_FIXTURE_ADAPTER_NOT_AUTHORIZED')
    const provisioned = await coordinator.provision({ runId: 'RUN-A', attemptId: 'ATTEMPT-1', requirement: req() })
    vi.spyOn(adapter, 'cleanup').mockRejectedValue(new Error('password=leaked'))
    const outcome = await coordinator.cleanup({ runId: 'RUN-A', attemptId: 'ATTEMPT-1', fixture: provisioned })
    expect(outcome.status).toBe('failed')
    expect(JSON.stringify(outcome)).not.toContain('password')
    expect(digestText('fixture-test', JSON.stringify(outcome))).toMatch(/^sha256:/)
  })
})
