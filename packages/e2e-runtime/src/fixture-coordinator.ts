import {
  ActorDataRequirementV1Schema,
  FixtureCleanupOutcomeSchema,
  FixtureRecoveryOutcomeSchema,
  ProvisionedFixtureV1Schema,
  digestText,
  type ActorDataRequirementV1,
  type FixtureCleanupOutcome,
  type FixtureRecoveryOutcome,
  type ProvisionedFixtureV1,
} from '@mutil-skills/e2e-contracts'

export interface FixtureAdapter {
  readonly identity: string
  provision(input: { runId: string; attemptId: string; namespacedResourceKey: string;
    need: ActorDataRequirementV1['dataNeeds'][number] }): Promise<{
      logicalResourceKey: string; cleanupPlanRef: string; reloadOracleRefs: string[]
    }>
  cleanup(input: ProvisionedFixtureV1['resources'][number]): Promise<void>
  reloadAbsent(input: ProvisionedFixtureV1['resources'][number]): Promise<boolean>
  inspect(input: ProvisionedFixtureV1['resources'][number]): Promise<'owned' | 'absent' | 'owner-mismatch'>
}

export interface AuthorizedFixtureAdapter extends FixtureAdapter {
  readonly __fixtureAdapterCapability?: never
}

const authorizedAdapters = new WeakSet<object>()

/** 只有 Authority/Gateway 组装边界可把 adapter 提升为可执行 capability。 */
export function authorizeFixtureAdapter(adapter: FixtureAdapter, binding: {
  authority: string; gateway: string
}): AuthorizedFixtureAdapter {
  if (!binding.authority || !binding.gateway) throw fixtureError('E2E_FIXTURE_ADAPTER_AUTHORIZATION_INVALID')
  authorizedAdapters.add(adapter)
  return adapter
}

export interface FixtureActorBinding {
  accountRef: string; actor: string; role: string; tenant?: string
  environment: string; targetIdentity: string
}

export interface FixtureCoordinatorDependencies {
  actorResolver: { resolve(requirement: ActorDataRequirementV1): Promise<FixtureActorBinding> }
  adapter: FixtureAdapter
  leaseAuthority: {
    acquire(input: { runId: string; resourceKey: string; resourceFingerprint: string; ttlMs: number }):
      Promise<{ leaseId: string; expiresAt: string }>
    release(input: { leaseId: string; cleanupDigest: string }): Promise<void>
    quarantine(input: { leaseId: string; reason: string }): Promise<void>
  }
  now?: () => Date
}

export class FixtureCoordinator {
  readonly #dependencies: FixtureCoordinatorDependencies

  constructor(dependencies: FixtureCoordinatorDependencies) {
    if (!authorizedAdapters.has(dependencies.adapter)) throw fixtureError('E2E_FIXTURE_ADAPTER_NOT_AUTHORIZED')
    this.#dependencies = dependencies
  }

  async provision(input: { runId: string; attemptId: string; requirement: ActorDataRequirementV1 }):
    Promise<ProvisionedFixtureV1> {
    const requirement = ActorDataRequirementV1Schema.parse(input.requirement)
    const account = await this.#dependencies.actorResolver.resolve(requirement)
    requireActorBinding(account, requirement)
    const provisionId = `PROVISION-${stableSuffix(input.runId, input.attemptId, requirement.caseId)}`
    const resources: ProvisionedFixtureV1['resources'] = []
    for (const need of requirement.dataNeeds) {
      const namespace = `${input.runId}:${input.attemptId}:${need.needId}:${stableSuffix(requirement.targetIdentity)}`
      const prepared = await this.#dependencies.adapter.provision({ runId: input.runId,
        attemptId: input.attemptId, namespacedResourceKey: namespace, need })
      const lease = await this.#dependencies.leaseAuthority.acquire({ runId: input.runId,
        resourceKey: namespace, resourceFingerprint: digestText('fixture-resource/v1', namespace), ttlMs: 3_600_000 })
      resources.push({ needId: need.needId, logicalResourceKey: prepared.logicalResourceKey,
        namespacedResourceKey: namespace, leaseId: lease.leaseId,
        cleanupPlanRef: prepared.cleanupPlanRef, reloadOracleRefs: prepared.reloadOracleRefs,
        adapterIdentity: this.#dependencies.adapter.identity, expiresAt: lease.expiresAt })
    }
    const expiresAt = resources.map((item) => item.expiresAt).sort()[0]
    if (expiresAt === undefined) throw fixtureError('E2E_FIXTURE_RESOURCE_REQUIRED')
    return ProvisionedFixtureV1Schema.parse({ schemaVersion: 'provisioned-fixture/v1', provisionId,
      runId: input.runId, attemptId: input.attemptId, requirementId: requirement.requirementId,
      caseId: requirement.caseId, environment: requirement.environment,
      targetIdentity: requirement.targetIdentity,
      accountBinding: { actor: account.actor, role: account.role,
        ...(account.tenant === undefined ? {} : { tenant: account.tenant }), accountRef: account.accountRef,
        ...(requirement.credentialRef === undefined ? {} : { credentialRef: requirement.credentialRef }) },
      resources, expiresAt })
  }

  async cleanup(input: { runId: string; attemptId: string; fixture: ProvisionedFixtureV1 }):
    Promise<FixtureCleanupOutcome> {
    const fixture = ProvisionedFixtureV1Schema.parse(input.fixture)
    requireOwner(input, fixture)
    const residuals: FixtureCleanupOutcome['residuals'] = []
    let reloadVerified = true
    let leaseRetired = true
    for (const resource of fixture.resources) {
      try {
        await this.#dependencies.adapter.cleanup(resource)
        const absent = await this.#dependencies.adapter.reloadAbsent(resource)
        if (!absent) {
          reloadVerified = false
          residuals.push(residual(resource, fixture, 'reload-observed-present', '重新执行 Cleanup 并核对 Reload Oracle'))
          await this.#dependencies.leaseAuthority.quarantine({ leaseId: resource.leaseId,
            reason: 'reload-observed-present' })
          leaseRetired = false
        } else {
          await this.#dependencies.leaseAuthority.release({ leaseId: resource.leaseId,
            cleanupDigest: digestText('fixture-cleanup/v1', resource.namespacedResourceKey) })
        }
      } catch {
        reloadVerified = false; leaseRetired = false
        residuals.push(residual(resource, fixture, 'cleanup-adapter-failed', '人工检查并清理 namespaced resource'))
        try { await this.#dependencies.leaseAuthority.quarantine({ leaseId: resource.leaseId,
          reason: 'cleanup-adapter-failed' }) } catch { /* outcome 已保留 residual */ }
      }
    }
    return FixtureCleanupOutcomeSchema.parse({ schemaVersion: 'fixture-cleanup-outcome/v1',
      provisionId: fixture.provisionId, status: residuals.length === 0 ? 'cleaned' : 'failed',
      reloadVerified, leaseRetired, residuals })
  }

  async recover(input: { runId: string; attemptId: string; fixture: ProvisionedFixtureV1 }):
    Promise<FixtureRecoveryOutcome> {
    const fixture = ProvisionedFixtureV1Schema.parse(input.fixture); requireOwner(input, fixture)
    const residuals: FixtureRecoveryOutcome['residuals'] = []
    for (const resource of fixture.resources) {
      const observation = await this.#dependencies.adapter.inspect(resource)
      if (observation !== 'absent') residuals.push(residual(resource, fixture,
        `recovery-${observation}`, '只检查/清理 owner resource；禁止重放 allocate 或写操作'))
    }
    return FixtureRecoveryOutcomeSchema.parse({ schemaVersion: 'fixture-recovery-outcome/v1',
      provisionId: fixture.provisionId, status: residuals.length === 0 ? 'recovered' : 'residual',
      replayedUncertainWrite: false,
      inspectedResourceKeys: fixture.resources.map((item) => item.namespacedResourceKey), residuals })
  }
}

function requireActorBinding(account: FixtureActorBinding, requirement: ActorDataRequirementV1): void {
  if (account.actor !== requirement.actor || account.role !== requirement.role
    || account.tenant !== requirement.tenant || account.environment !== requirement.environment
    || account.targetIdentity !== requirement.targetIdentity) throw fixtureError('E2E_FIXTURE_ACTOR_BINDING_MISMATCH')
}

function requireOwner(input: { runId: string; attemptId: string }, fixture: ProvisionedFixtureV1): void {
  if (fixture.runId !== input.runId || fixture.attemptId !== input.attemptId) {
    throw fixtureError('E2E_FIXTURE_OWNER_MISMATCH')
  }
}

function residual(resource: ProvisionedFixtureV1['resources'][number], fixture: ProvisionedFixtureV1,
  lastAction: string, remediation: string) {
  return { namespacedResourceKey: resource.namespacedResourceKey, ownerRunId: fixture.runId,
    ownerAttemptId: fixture.attemptId, adapterIdentity: resource.adapterIdentity, lastAction, remediation }
}

function stableSuffix(...values: string[]): string {
  return digestText('fixture-namespace/v1', values.join('\0')).slice(7, 31).toUpperCase()
}

function fixtureError(code: string): Error { return new Error(code) }
