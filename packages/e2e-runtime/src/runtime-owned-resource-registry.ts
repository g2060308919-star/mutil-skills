import {
  SqliteSnapshotStore,
  type SqliteStateDirectoryIdentity,
} from '@mutil-skills/e2e-authority'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import {
  RuntimeOwnedResourceMarkerSchema,
  type RuntimeOwnedResourceMarker,
} from './write-attempt.js'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface RuntimeOwnedResourceRecord {
  resourceId: string
  kind: 'loopback-endpoint' | 'browser-profile-lock'
  ownerMarker: RuntimeOwnedResourceMarker
  descriptor: unknown
  descriptorDigest: string
  revision: number
  status: 'active' | 'cleaned'
  registeredAt: string
  cleanupReceiptDigest?: string
}

export interface RuntimeOwnedResourceOperations {
  inspect(record: RuntimeOwnedResourceRecord): Promise<{
    status: 'owned' | 'absent' | 'owner-mismatch'
    summaryDigest: string
  }>
  cleanup(record: RuntimeOwnedResourceRecord): Promise<{ receiptDigest: string }>
}

/**
 * 持久化 production cleanup registry。descriptor 只由对应 kind 的固定 adapter 解释；
 * registry 先无锁外调 inspect，再清理，最后用 record revision 短事务 CAS 写 tombstone。
 */
export class RuntimeOwnedResourceRegistry {
  private constructor(
    private readonly store: SqliteSnapshotStore,
    private readonly operations: Readonly<Record<RuntimeOwnedResourceRecord['kind'], RuntimeOwnedResourceOperations>>,
  ) {}

  static async open(input: {
    statePath: string
    testWorkspaceRoots: string[]
    operations: Readonly<Record<RuntimeOwnedResourceRecord['kind'], RuntimeOwnedResourceOperations>>
    expectedStateDirectory?: SqliteStateDirectoryIdentity
  }): Promise<RuntimeOwnedResourceRegistry> {
    const store = new SqliteSnapshotStore(input.statePath, 'runtime-owned-resource-registry', {
      forbiddenRoots: input.testWorkspaceRoots,
      ...(input.expectedStateDirectory === undefined ? {} : {
        expectedStateDirectory: input.expectedStateDirectory,
      }),
    })
    store.initialize(canonicalizeJson({ schemaVersion: '1.0.0', records: {} }))
    await store.runExclusive(async () => {
      const raw = store.begin()
      try { parseSnapshot(raw); store.rollback() } catch (error) { store.rollback(); throw error }
    })
    return new RuntimeOwnedResourceRegistry(store, input.operations)
  }

  close(): void { this.store.close() }

  async register(input: Omit<RuntimeOwnedResourceRecord,
    'revision' | 'status' | 'cleanupReceiptDigest'>): Promise<RuntimeOwnedResourceRecord> {
    const record = parseRecord({ ...input, revision: 1, status: 'active' })
    return await this.mutate((snapshot) => {
      const existing = snapshot.records[record.resourceId]
      if (existing !== undefined) {
        if (canonicalizeJson(existing) === canonicalizeJson(record)) return structuredClone(existing)
        throw registryError('E2E_RUNTIME_OWNED_RESOURCE_REBOUND', 'resourceId 已绑定其他 owner/descriptor')
      }
      if (Object.keys(snapshot.records).length >= 4_096) throw registryError(
        'E2E_RUNTIME_OWNED_RESOURCE_CAPACITY', 'Owned resource registry 超过容量上限',
      )
      snapshot.records[record.resourceId] = record
      return structuredClone(record)
    })
  }

  /**
   * 正常关闭路径在已经确认外部资源消失后写入 tombstone。调用方必须同时给出
   * owner marker 与观察到的 revision，避免把已被重新绑定的资源误记为 cleaned。
   */
  async complete(input: {
    resourceId: string
    ownerMarkerDigest: string
    expectedRevision: number
    cleanupReceiptDigest: string
  }): Promise<RuntimeOwnedResourceRecord> {
    if (!SAFE_ID.test(input.resourceId) || !DIGEST.test(input.ownerMarkerDigest)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !DIGEST.test(input.cleanupReceiptDigest)) throw registryError(
      'E2E_RUNTIME_OWNED_RESOURCE_COMPLETION_INVALID', 'Owned resource completion 输入非法',
    )
    return await this.mutate((snapshot) => {
      const current = snapshot.records[input.resourceId]
      if (current === undefined) throw registryError(
        'E2E_RUNTIME_OWNED_RESOURCE_NOT_FOUND', 'Owned resource record 不存在',
      )
      if (current.status === 'cleaned') {
        if (current.ownerMarker.markerDigest === input.ownerMarkerDigest
          && current.cleanupReceiptDigest === input.cleanupReceiptDigest) return structuredClone(current)
        throw registryError('E2E_RUNTIME_OWNED_RESOURCE_CAS_FAILED', 'Cleaned tombstone 与 completion 不一致')
      }
      if (current.revision !== input.expectedRevision
        || current.ownerMarker.markerDigest !== input.ownerMarkerDigest) throw registryError(
        'E2E_RUNTIME_OWNED_RESOURCE_CAS_FAILED', 'Owned resource completion 观察已陈旧',
      )
      const completed = parseRecord({
        ...current, revision: current.revision + 1, status: 'cleaned',
        cleanupReceiptDigest: input.cleanupReceiptDigest,
      })
      snapshot.records[input.resourceId] = completed
      return structuredClone(completed)
    })
  }

  async cleanupOwned(markerInput: RuntimeOwnedResourceMarker): Promise<{
    status: 'cleaned' | 'absent' | 'owner-mismatch'
    summaryDigest: string
  }> {
    const marker = RuntimeOwnedResourceMarkerSchema.parse(markerInput)
    const candidates = await this.read((snapshot) => Object.values(snapshot.records)
      .filter((record) => record.status === 'active'
        && record.ownerMarker.markerDigest === marker.markerDigest)
      .map((record) => structuredClone(record)))
    if (candidates.length === 0) return { status: 'absent', summaryDigest: cleanupSummary(marker, []) }

    const inspections: Array<{ record: RuntimeOwnedResourceRecord
      status: 'owned' | 'absent' | 'owner-mismatch'; summaryDigest: string }> = []
    for (const record of candidates) {
      const result = await this.operations[record.kind].inspect(structuredClone(record))
      requireDigest(result.summaryDigest, 'inspect summary')
      if (!['owned', 'absent', 'owner-mismatch'].includes(result.status)) throw registryError(
        'E2E_RUNTIME_OWNED_RESOURCE_ADAPTER_INVALID', 'Owned resource inspect status 非法',
      )
      inspections.push({ record, status: result.status, summaryDigest: result.summaryDigest })
    }
    if (inspections.some((result) => result.status === 'owner-mismatch')) {
      return { status: 'owner-mismatch', summaryDigest: cleanupSummary(marker, inspections.map((item) => ({
        resourceId: item.record.resourceId, status: item.status, digest: item.summaryDigest,
      }))) }
    }

    const receipts = new Map<string, string>()
    for (const item of inspections) {
      const receiptDigest = item.status === 'absent'
        ? digestText('runtime-owned-resource-absent/v1', canonicalizeJson({
          resourceId: item.record.resourceId, descriptorDigest: item.record.descriptorDigest,
        }))
        : (await this.operations[item.record.kind].cleanup(structuredClone(item.record))).receiptDigest
      requireDigest(receiptDigest, 'cleanup receipt')
      receipts.set(item.record.resourceId, receiptDigest)
    }

    await this.mutate((snapshot) => {
      for (const expected of candidates) {
        const current = snapshot.records[expected.resourceId]
        if (current === undefined || current.status !== 'active' || current.revision !== expected.revision
          || current.ownerMarker.markerDigest !== marker.markerDigest
          || current.descriptorDigest !== expected.descriptorDigest) throw registryError(
          'E2E_RUNTIME_OWNED_RESOURCE_CAS_FAILED', 'Cleanup 外调后 owned resource record 已改变',
        )
      }
      for (const expected of candidates) snapshot.records[expected.resourceId] = parseRecord({
        ...expected, revision: expected.revision + 1, status: 'cleaned',
        cleanupReceiptDigest: receipts.get(expected.resourceId),
      })
    })
    return { status: 'cleaned', summaryDigest: cleanupSummary(marker, candidates.map((record) => ({
      resourceId: record.resourceId, status: 'cleaned', digest: receipts.get(record.resourceId),
    }))) }
  }

  private async read<T>(operation: (snapshot: RegistrySnapshot) => T): Promise<T> {
    return await this.store.runExclusive(async () => {
      const raw = this.store.begin()
      try { const result = operation(parseSnapshot(raw)); this.store.rollback(); return result }
      catch (error) { this.store.rollback(); throw error }
    })
  }

  private async mutate<T>(operation: (snapshot: RegistrySnapshot) => T): Promise<T> {
    return await this.store.runExclusive(async () => {
      const raw = this.store.begin()
      try {
        const snapshot = parseSnapshot(raw)
        const result = operation(snapshot)
        this.store.commit(canonicalizeJson(snapshot))
        return result
      } catch (error) { this.store.rollback(); throw error }
    })
  }
}

interface RegistrySnapshot {
  schemaVersion: '1.0.0'
  records: Record<string, RuntimeOwnedResourceRecord>
}

function parseSnapshot(raw: string): RegistrySnapshot {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw registryError('E2E_RUNTIME_OWNED_RESOURCE_STATE_CORRUPT', 'Registry 不是 JSON') }
  if (!isRecord(value) || !exactKeys(value, ['records', 'schemaVersion'])
    || value.schemaVersion !== '1.0.0' || !isRecord(value.records)) throw registryError(
    'E2E_RUNTIME_OWNED_RESOURCE_STATE_CORRUPT', 'Registry snapshot 结构非法',
  )
  const records: Record<string, RuntimeOwnedResourceRecord> = {}
  for (const [key, candidate] of Object.entries(value.records)) {
    const record = parseRecord(candidate)
    if (key !== record.resourceId) throw registryError(
      'E2E_RUNTIME_OWNED_RESOURCE_STATE_CORRUPT', 'Registry key/resourceId 不闭合',
    )
    records[key] = record
  }
  return { schemaVersion: '1.0.0', records }
}

function parseRecord(value: unknown): RuntimeOwnedResourceRecord {
  if (!isRecord(value)) throw invalidRecord()
  const hasReceipt = Object.hasOwn(value, 'cleanupReceiptDigest')
  if (!exactKeys(value, ['descriptor', 'descriptorDigest', 'kind', 'ownerMarker', 'registeredAt',
    'resourceId', 'revision', 'status', ...(hasReceipt ? ['cleanupReceiptDigest'] : [])])
    || typeof value.resourceId !== 'string' || !SAFE_ID.test(value.resourceId)
    || !['loopback-endpoint', 'browser-profile-lock'].includes(value.kind as string)
    || typeof value.descriptorDigest !== 'string' || !DIGEST.test(value.descriptorDigest)
    || value.descriptorDigest !== digestText('runtime-owned-resource-descriptor/v1', canonicalizeJson(value.descriptor))
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !['active', 'cleaned'].includes(value.status as string)
    || typeof value.registeredAt !== 'string' || !canonicalInstant(value.registeredAt)
    || (value.status === 'cleaned' && (!hasReceipt || typeof value.cleanupReceiptDigest !== 'string'
      || !DIGEST.test(value.cleanupReceiptDigest)))
    || (value.status === 'active' && hasReceipt)) throw invalidRecord()
  const marker = RuntimeOwnedResourceMarkerSchema.safeParse(value.ownerMarker)
  if (!marker.success) throw invalidRecord()
  return structuredClone({ ...value, ownerMarker: marker.data }) as RuntimeOwnedResourceRecord
}

function cleanupSummary(marker: RuntimeOwnedResourceMarker, outcomes: unknown[]): string {
  return digestText('runtime-owned-resource-cleanup-summary/v1', canonicalizeJson({
    ownerMarkerDigest: marker.markerDigest, outcomes,
  }))
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw registryError(
    'E2E_RUNTIME_OWNED_RESOURCE_ADAPTER_INVALID', `${label} 非法`,
  )
}

function canonicalInstant(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function invalidRecord(): E2EError {
  return registryError('E2E_RUNTIME_OWNED_RESOURCE_STATE_CORRUPT', 'Owned resource record 结构或摘要非法')
}
function registryError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
