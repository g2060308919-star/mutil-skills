import { describe, expect, test } from 'vitest'
import {
  ActorDataIntentV1Schema,
  ActorDataRequirementV1Schema,
  ProvisionedFixtureV1Schema,
} from '../src/actor-data-fixture.js'

const requirement = {
  schemaVersion: 'actor-data-requirement/v1' as const,
  requirementId: 'REQ-1', caseId: 'CASE-1', actor: 'auditor', role: 'reviewer',
  tenant: 'tenant-a', environment: 'staging', targetIdentity: 'TARGET-1',
  credentialRef: 'secret://accounts/reviewer',
  dataNeeds: [{ needId: 'ORDER-1', resourceType: 'order', initialState: { status: 'pending' },
    access: 'reversible-write' as const, seedStrategy: 'idempotent-seed' as const,
    cleanupExpectation: 'delete' as const }],
}

describe('Actor/Data 与 Provisioned Fixture 契约', () => {
  test('产品入口只声明 Role/Data Need，不要求调用者预先知道 Case 或 Target 摘要', () => {
    const intent = {
      schemaVersion: 'actor-data-intent/v1' as const,
      intentId: 'INTENT-AUDITOR', actor: 'auditor', role: 'reviewer', tenant: 'tenant-a',
      credentialRef: 'secret://accounts/reviewer',
      dataNeeds: requirement.dataNeeds,
    }
    expect(ActorDataIntentV1Schema.parse(intent)).toEqual(intent)
    expect(() => ActorDataIntentV1Schema.parse({ ...intent, targetIdentity: 'caller-controlled' }))
      .toThrow()
  })

  test('只接受角色、数据需要与 Secret reference', () => {
    expect(ActorDataRequirementV1Schema.parse(requirement)).toEqual(requirement)
  })

  test.each([
    { password: 'plain' }, { token: 'plain' }, { cookieValue: 'plain' },
    { initialState: { nested: { access_token: 'plain' } } },
  ])('任何层级出现明文敏感字段都 fail closed: %#', (extra) => {
    const candidate = 'initialState' in extra
      ? { ...requirement, dataNeeds: [{ ...requirement.dataNeeds[0], ...extra }] }
      : { ...requirement, ...extra }
    expect(() => ActorDataRequirementV1Schema.parse(candidate)).toThrow()
  })

  test('provisioning 事实仅保存 account/lease/resource reference，不接受明文 Secret', () => {
    const fixture = { schemaVersion: 'provisioned-fixture/v1', provisionId: 'PROVISION-1', runId: 'RUN-1',
      attemptId: 'ATTEMPT-1', requirementId: 'REQ-1', caseId: 'CASE-1', environment: 'staging',
      targetIdentity: 'TARGET-1', accountBinding: { actor: 'auditor', role: 'reviewer', tenant: 'tenant-a',
        accountRef: 'account://reviewer-1', credentialRef: 'secret://accounts/reviewer' },
      resources: [{ needId: 'ORDER-1', logicalResourceKey: 'order:pending',
        namespacedResourceKey: 'RUN-1:ATTEMPT-1:ORDER-1', leaseId: 'LEASE-1',
        cleanupPlanRef: 'cleanup://PROVISION-1/ORDER-1', reloadOracleRefs: ['ORACLE-RELOAD-1'],
        adapterIdentity: 'fixture-adapter://local/v1', expiresAt: '2026-08-12T01:00:00.000Z' }],
      expiresAt: '2026-08-12T01:00:00.000Z' }
    expect(ProvisionedFixtureV1Schema.parse(fixture)).toEqual(fixture)
    expect(() => ProvisionedFixtureV1Schema.parse({ ...fixture, password: 'plain' })).toThrow()
  })
})
