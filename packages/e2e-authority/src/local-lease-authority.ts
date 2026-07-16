import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { E2EError, type DataLease, type LeaseRequest } from '@mutil-skills/e2e-contracts'
import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import {
  SqliteSnapshotStore,
  type SqliteStateDirectoryIdentity,
} from './sqlite-state-store.js'
import { trustLeaseClient, type TrustedLeaseClient } from './trusted-execution-clients.js'

const DigestPattern = /^sha256:[a-f0-9]{64}$/
export class LocalLeaseAuthority {
  readonly #now: () => Date
  readonly #stateStore?: SqliteSnapshotStore
  readonly #stateContext = new AsyncLocalStorage<boolean>()
  #activeStateTransactions = 0
  readonly #leases = new Map<string, DataLease>()
  readonly #resourceOwners = new Map<string, string>()
  readonly #fencingTokens = new Map<string, number>()

  constructor(options: { now: () => Date }, stateStore?: SqliteSnapshotStore) {
    this.#now = options.now
    this.#stateStore = stateStore
  }

  static async open(options: {
    now: () => Date
    statePath: string
    testWorkspaceRoots: string[]
    expectedStateDirectory?: SqliteStateDirectoryIdentity
  }): Promise<LocalLeaseAuthority> {
    const store = new SqliteSnapshotStore(options.statePath, 'lease-authority', {
      forbiddenRoots: options.testWorkspaceRoots,
      ...(options.expectedStateDirectory === undefined
        ? {} : { expectedStateDirectory: options.expectedStateDirectory }),
    })
    const snapshot = parseLeaseSnapshot(store.initialize(canonicalizeJson({
      schemaVersion: '1.0.0', leases: [], resourceOwners: [], fencingTokens: [],
    } satisfies LeasePersistentSnapshot)))
    const authority = new LocalLeaseAuthority(options, store)
    authority.#hydrate(snapshot)
    return authority
  }

  close(): void {
    if (this.#activeStateTransactions !== 0) throw leaseError('E2E_LEASE_STATE_BUSY', 'Lease 事务进行中不能关闭')
    this.#stateStore?.close()
  }

  createExecutionClient(): TrustedLeaseClient {
    const client: TrustedLeaseClient = Object.freeze({
      verifyTarget: (leaseId: string, fencingToken: number, targetFingerprint: string) =>
        this.verifyTarget(leaseId, fencingToken, targetFingerprint),
    })
    return trustLeaseClient(client, { transport: 'in-process-test' })
  }

  async acquire(request: LeaseRequest): Promise<DataLease> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withMutation(() => this.acquire(request))
    }
    validateRequest(request)
    const existingId = this.#resourceOwners.get(request.resourceKey)
    if (existingId) {
      const existing = this.#leases.get(existingId)
      if (existing && existing.status !== 'released') {
        throw leaseError('E2E_LEASE_RESOURCE_UNAVAILABLE', `资源 ${request.resourceKey} 已被租用或隔离`)
      }
    }

    const now = this.#now()
    const lease: DataLease = {
      leaseId: randomUUID(),
      runId: request.runId,
      resourceKey: request.resourceKey,
      resourceFingerprint: request.resourceFingerprint,
      exclusive: request.exclusive,
      status: 'tentative',
      fencingToken: 0,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    }
    this.#leases.set(lease.leaseId, lease)
    this.#resourceOwners.set(lease.resourceKey, lease.leaseId)
    return copy(lease)
  }

  async activate(leaseId: string): Promise<DataLease> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withMutation(() => this.activate(leaseId))
    }
    const lease = this.requireLease(leaseId)
    if (lease.status !== 'tentative') throw leaseError('E2E_LEASE_NOT_TENTATIVE', '只有 tentative Lease 可以 activate')
    if (this.#now().getTime() >= Date.parse(lease.expiresAt)) throw leaseError('E2E_LEASE_EXPIRED', 'Lease 已过期')
    const token = (this.#fencingTokens.get(lease.resourceKey) ?? 0) + 1
    this.#fencingTokens.set(lease.resourceKey, token)
    lease.status = 'active'
    lease.fencingToken = token
    return copy(lease)
  }

  async verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withRead(() => this.verifyTarget(leaseId, fencingToken, targetFingerprint))
    }
    const lease = this.#leases.get(leaseId)
    return lease?.status === 'active'
      && lease.fencingToken === fencingToken
      && lease.resourceFingerprint === targetFingerprint
      && this.#resourceOwners.get(lease.resourceKey) === leaseId
      && this.#now().getTime() < Date.parse(lease.expiresAt)
  }

  async quarantine(leaseId: string, reason: string): Promise<void> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withMutation(() => this.quarantine(leaseId, reason))
    }
    const lease = this.requireLease(leaseId)
    if (lease.status === 'released') throw leaseError('E2E_LEASE_ALREADY_RELEASED', '已释放 Lease 不能隔离')
    lease.status = 'quarantined'
    lease.quarantineReason = reason
  }

  async release(leaseId: string, cleanupDigest: string): Promise<void> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withMutation(() => this.release(leaseId, cleanupDigest))
    }
    if (!DigestPattern.test(cleanupDigest)) throw leaseError('E2E_LEASE_CLEANUP_DIGEST_INVALID', 'Cleanup digest 无效')
    const lease = this.requireLease(leaseId)
    if (lease.status !== 'active') throw leaseError('E2E_LEASE_NOT_ACTIVE', '只有 active Lease 可以在验证清理后释放')
    lease.status = 'released'
    lease.cleanupDigest = cleanupDigest
    this.#resourceOwners.delete(lease.resourceKey)
  }

  private requireLease(leaseId: string): DataLease {
    const lease = this.#leases.get(leaseId)
    if (!lease) throw leaseError('E2E_LEASE_UNKNOWN', 'Lease 不存在')
    return lease
  }

  async #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#stateStore || this.#stateContext.getStore()) return await operation()
    return await this.#stateStore.runExclusive(async () => {
      this.#hydrate(parseLeaseSnapshot(this.#stateStore!.begin()))
      this.#activeStateTransactions += 1
      try {
        return await this.#stateContext.run(true, async () => {
          const result = await operation()
          this.#stateStore!.commit(canonicalizeJson(this.#snapshot()))
          return result
        })
      } catch (error) {
        this.#stateStore!.rollback()
        throw error
      } finally {
        this.#activeStateTransactions -= 1
      }
    })
  }

  async #withRead<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#stateStore || this.#stateContext.getStore()) return await operation()
    return await this.#stateStore.runExclusive(async () => {
      this.#hydrate(parseLeaseSnapshot(this.#stateStore!.begin()))
      this.#activeStateTransactions += 1
      try {
        return await this.#stateContext.run(true, operation)
      } finally {
        this.#stateStore!.rollback()
        this.#activeStateTransactions -= 1
      }
    })
  }

  #snapshot(): LeasePersistentSnapshot {
    return { schemaVersion: '1.0.0', leases: [...this.#leases.entries()],
      resourceOwners: [...this.#resourceOwners.entries()], fencingTokens: [...this.#fencingTokens.entries()] }
  }

  #hydrate(snapshot: LeasePersistentSnapshot): void {
    replaceMap(this.#leases, snapshot.leases)
    replaceMap(this.#resourceOwners, snapshot.resourceOwners)
    replaceMap(this.#fencingTokens, snapshot.fencingTokens)
  }
}

interface LeasePersistentSnapshot {
  schemaVersion: '1.0.0'
  leases: Array<[string, DataLease]>
  resourceOwners: Array<[string, string]>
  fencingTokens: Array<[string, number]>
}

function parseLeaseSnapshot(value: string): LeasePersistentSnapshot {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw leaseError('E2E_LEASE_STATE_CORRUPT', 'Lease snapshot 不是合法 JSON') }
  const candidate = parsed as Partial<LeasePersistentSnapshot>
  if (!candidate || candidate.schemaVersion !== '1.0.0' || !Array.isArray(candidate.leases)
    || !Array.isArray(candidate.resourceOwners) || !Array.isArray(candidate.fencingTokens)) {
    throw leaseError('E2E_LEASE_STATE_CORRUPT', 'Lease snapshot 结构无效')
  }
  return candidate as LeasePersistentSnapshot
}

function replaceMap<K, V>(target: Map<K, V>, entries: Array<[K, V]>): void {
  target.clear()
  for (const [key, value] of entries) target.set(key, value)
}

function validateRequest(request: LeaseRequest): void {
  if (!request.runId || !request.resourceKey) throw leaseError('E2E_LEASE_INPUT_INVALID', 'Run ID 和 resourceKey 必填')
  if (!DigestPattern.test(request.resourceFingerprint)) throw leaseError('E2E_LEASE_FINGERPRINT_INVALID', 'Resource fingerprint 无效')
  if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) throw leaseError('E2E_LEASE_TTL_INVALID', 'Lease TTL 必须为正整数')
}

function copy(lease: DataLease): DataLease {
  return { ...lease }
}

function leaseError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
