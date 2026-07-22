import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { E2EError, type ApprovalExecutionBinding, type DataLease, type LeaseRequest } from '@mutil-skills/e2e-contracts'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
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

  createExecutionClient(approvalBinding?: ApprovalExecutionBinding): TrustedLeaseClient {
    const client: TrustedLeaseClient = Object.freeze({
      verifyTarget: (leaseId: string, fencingToken: number, targetFingerprint: string) =>
        this.verifyTarget(leaseId, fencingToken, targetFingerprint),
    })
    return trustLeaseClient(client, { transport: 'in-process-test', ...(approvalBinding ? { approvalBinding: {
      runId: approvalBinding.runId, installationDigest: approvalBinding.installationDigest,
      approvalType: approvalBinding.approvalType, subjectDigest: approvalBinding.subjectDigest,
    } } : {}) })
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

  async getLeaseForTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<DataLease> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withRead(() => this.getLeaseForTarget(leaseId, fencingToken, targetFingerprint))
    }
    const lease = this.requireLease(leaseId)
    this.#requireBinding(lease, fencingToken, targetFingerprint)
    return copy(lease)
  }

  async releaseForTarget(input: {
    leaseId: string; fencingToken: number; targetFingerprint: string; cleanupDigest: string
  }): Promise<string> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withMutation(() => this.releaseForTarget(input))
    }
    if (!DigestPattern.test(input.cleanupDigest)) {
      throw leaseError('E2E_LEASE_CLEANUP_DIGEST_INVALID', 'Cleanup digest 无效')
    }
    const lease = this.requireLease(input.leaseId)
    this.#requireBinding(lease, input.fencingToken, input.targetFingerprint)
    if (lease.status === 'released' && lease.cleanupDigest === input.cleanupDigest) {
      return leaseTerminalReceipt(lease, 'released')
    }
    if (lease.status !== 'active') {
      throw leaseError('E2E_LEASE_TERMINAL_MISMATCH', 'Lease 终态与本次 cleanup 不一致')
    }
    lease.status = 'released'
    lease.cleanupDigest = input.cleanupDigest
    this.#resourceOwners.delete(lease.resourceKey)
    return leaseTerminalReceipt(lease, 'released')
  }

  async quarantineForTarget(input: {
    leaseId: string; fencingToken: number; targetFingerprint: string; reason: string
  }): Promise<string> {
    if (this.#stateStore && !this.#stateContext.getStore()) {
      return await this.#withMutation(() => this.quarantineForTarget(input))
    }
    if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 16 * 1024) {
      throw leaseError('E2E_LEASE_QUARANTINE_REASON_INVALID', '隔离原因无效')
    }
    const lease = this.requireLease(input.leaseId)
    this.#requireBinding(lease, input.fencingToken, input.targetFingerprint)
    if (lease.status === 'quarantined' && lease.quarantineReason === input.reason) {
      return leaseTerminalReceipt(lease, 'quarantined')
    }
    if (lease.status === 'released' || lease.status === 'quarantined') {
      throw leaseError('E2E_LEASE_TERMINAL_MISMATCH', 'Lease 终态与本次隔离原因不一致')
    }
    lease.status = 'quarantined'
    lease.quarantineReason = input.reason
    return leaseTerminalReceipt(lease, 'quarantined')
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

  #requireBinding(lease: DataLease, fencingToken: number, targetFingerprint: string): void {
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0
      || lease.fencingToken !== fencingToken || lease.resourceFingerprint !== targetFingerprint) {
      throw leaseError('E2E_LEASE_BINDING_MISMATCH', 'Lease fencing token 或目标指纹不匹配')
    }
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
  if (!plainRecord(parsed) || exactKeys(parsed) !== ['fencingTokens', 'leases', 'resourceOwners', 'schemaVersion'].join('\0')
    || parsed.schemaVersion !== '1.0.0' || !Array.isArray(parsed.leases)
    || !Array.isArray(parsed.resourceOwners) || !Array.isArray(parsed.fencingTokens)) corruptLeaseState()
  const leases = parseUniqueLeaseTuples(parsed.leases, parseLease)
  const owners = parseUniqueLeaseTuples(parsed.resourceOwners, (resourceKey, leaseId) => {
    if (!validResourceKey(resourceKey) || typeof leaseId !== 'string' || !safeId(leaseId)) corruptLeaseState()
    return leaseId
  })
  const tokens = parseUniqueLeaseTuples(parsed.fencingTokens, (resourceKey, token) => {
    if (!validResourceKey(resourceKey) || !nonNegativeInteger(token)) corruptLeaseState()
    return token
  })
  const leaseMap = new Map(leases)
  const ownerMap = new Map(owners)
  const tokenMap = new Map(tokens)
  for (const [leaseId, lease] of leases) {
    if (lease.leaseId !== leaseId) corruptLeaseState()
    const owner = ownerMap.get(lease.resourceKey)
    if (lease.status === 'released' ? owner === leaseId : owner !== leaseId) corruptLeaseState()
    const currentToken = tokenMap.get(lease.resourceKey) ?? 0
    if (lease.fencingToken > currentToken) corruptLeaseState()
  }
  for (const [resourceKey, leaseId] of owners) {
    const lease = leaseMap.get(leaseId)
    if (!lease || lease.resourceKey !== resourceKey || lease.status === 'released') corruptLeaseState()
  }
  for (const [resourceKey, token] of tokens) {
    const max = Math.max(0, ...leases.filter(([, lease]) => lease.resourceKey === resourceKey)
      .map(([, lease]) => lease.fencingToken))
    if (token < 1 || token !== max) corruptLeaseState()
  }
  return { schemaVersion: '1.0.0', leases, resourceOwners: owners, fencingTokens: tokens }
}

function parseLease(key: string, value: unknown): DataLease {
  if (!safeId(key) || !plainRecord(value)) corruptLeaseState()
  const optional = ['cleanupDigest', 'quarantineReason'].filter((field) => Object.hasOwn(value, field))
  if (exactKeys(value) !== ['acquiredAt', 'exclusive', 'expiresAt', 'fencingToken', 'leaseId',
    'resourceFingerprint', 'resourceKey', 'runId', 'status', ...optional].sort().join('\0')
    || value.leaseId !== key || typeof value.runId !== 'string' || !safeId(value.runId)
    || !validResourceKey(value.resourceKey) || typeof value.resourceFingerprint !== 'string'
    || !DigestPattern.test(value.resourceFingerprint) || typeof value.exclusive !== 'boolean'
    || !['tentative', 'active', 'quarantined', 'released'].includes(String(value.status))
    || !nonNegativeInteger(value.fencingToken)
    || typeof value.acquiredAt !== 'string' || !canonicalInstant(value.acquiredAt)
    || typeof value.expiresAt !== 'string' || !canonicalInstant(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)
    || (value.status === 'tentative' && (value.fencingToken !== 0 || optional.length !== 0))
    || (value.status === 'active' && (value.fencingToken < 1 || optional.length !== 0))
    || (value.status === 'released' && (value.fencingToken < 1 || optional.join('\0') !== 'cleanupDigest'
      || typeof value.cleanupDigest !== 'string' || !DigestPattern.test(value.cleanupDigest)))
    || (value.status === 'quarantined' && (optional.join('\0') !== 'quarantineReason'
      || typeof value.quarantineReason !== 'string' || value.quarantineReason.length < 1
      || value.quarantineReason.length > 16 * 1024))) corruptLeaseState()
  return structuredClone(value) as unknown as DataLease
}

function parseUniqueLeaseTuples<T>(
  value: unknown[],
  parse: (key: string, entry: unknown) => T,
): Array<[string, T]> {
  const seen = new Set<string>()
  return value.map((tuple) => {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || seen.has(tuple[0])) {
      return corruptLeaseState()
    }
    seen.add(tuple[0])
    return [tuple[0], parse(tuple[0], tuple[1])]
  })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function exactKeys(value: Record<string, unknown>): string { return Object.keys(value).sort().join('\0') }
function safeId(value: string): boolean { return /^[A-Za-z0-9._:-]{1,256}$/.test(value) }
function validResourceKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 16 * 1024
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function canonicalInstant(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
function corruptLeaseState(): never {
  throw leaseError('E2E_LEASE_STATE_CORRUPT', 'Lease snapshot 结构或交叉约束无效')
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

function leaseTerminalReceipt(lease: DataLease, terminalStatus: 'released' | 'quarantined'): string {
  return digestText('authority-lease-terminal-receipt/v1', canonicalizeJson({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    targetFingerprint: lease.resourceFingerprint,
    terminalStatus,
    ...(terminalStatus === 'released'
      ? { cleanupDigest: lease.cleanupDigest }
      : { quarantineReason: lease.quarantineReason }),
  }))
}
