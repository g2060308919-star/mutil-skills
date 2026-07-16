import { SqliteSnapshotStore } from '@mutil-skills/e2e-authority'
import {
  canonicalizeJson,
  digestText,
  E2EError,
  type WorkflowState,
} from '@mutil-skills/e2e-contracts'
import type { PendingWorkflowDecision } from '@mutil-skills/e2e-engine'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { migrateRuntimeRunSnapshot } from './runtime-state-migration.js'

const EMPTY_DIGEST = `sha256:${'0'.repeat(64)}`
const LEASE_MILLISECONDS = 30_000

export interface RuntimeRunSnapshot {
  schemaVersion: '1.0.0'
  runId: string
  assetId: string
  projectIdentityDigest: string
  runtimeInstallationDigest: string
  workflow: WorkflowState
  pendingDecision?: PendingWorkflowDecision
  artifactDigests: Record<string, string>
  requestResponses: Record<string, { requestDigest: string; response: unknown }>
  createdAt: string
  updatedAt: string
}

export interface RuntimeRunLock {
  close(): Promise<void>
}

export interface RuntimeRunStoreOptions {
  stateRoot: string
  projectRoot?: string
  forbiddenRoots?: string[]
  now?: () => Date
  leaseMilliseconds?: number
}

interface JournalRow {
  sequence: number
  previousDigest: string
  event: Record<string, unknown>
  eventDigest: string
  rowDigest: string
}

interface StoredResponse {
  requestDigest: string
  response: unknown
}

interface LeaseRow {
  ownerNonce: string
  expiresAt: string
}

interface RunStoreSnapshot {
  schemaVersion: '1.0.0'
  runs: Record<string, RuntimeRunSnapshot>
  orphanResponses: Record<string, StoredResponse>
  leases: Record<string, LeaseRow>
  journals: Record<string, JournalRow[]>
}

export class RuntimeRunStore {
  readonly #snapshotStore: SqliteSnapshotStore
  readonly #processNonce = randomUUID()
  readonly #now: () => Date
  readonly #leaseMilliseconds: number

  private constructor(
    snapshotStore: SqliteSnapshotStore,
    now: () => Date,
    leaseMilliseconds: number,
  ) {
    this.#snapshotStore = snapshotStore
    this.#now = now
    this.#leaseMilliseconds = leaseMilliseconds
  }

  static async open(options: RuntimeRunStoreOptions): Promise<RuntimeRunStore> {
    if (!options.stateRoot) throw runtimeStoreError('E2E_RUNTIME_STATE_CONFIG_INVALID', 'stateRoot 不能为空')
    const configuredForbiddenRoots = [
      ...(options.projectRoot === undefined ? [] : [options.projectRoot]),
      ...(options.forbiddenRoots ?? []),
    ]
    const forbiddenRoots = [...new Set(configuredForbiddenRoots)]
    if (forbiddenRoots.length === 0) {
      forbiddenRoots.push(join(options.stateRoot, '.forbidden-project-root'))
      await mkdir(forbiddenRoots[0]!, { recursive: true })
    }
    const snapshotStore = new SqliteSnapshotStore(
      join(options.stateRoot, 'runtime-runs.sqlite'),
      'e2e-runtime-runs/v1',
      { forbiddenRoots },
    )
    snapshotStore.initialize(canonicalizeJson(emptyStoreSnapshot()))
    const store = new RuntimeRunStore(
      snapshotStore,
      options.now ?? (() => new Date()),
      options.leaseMilliseconds ?? LEASE_MILLISECONDS,
    )
    try {
      await store.#verifyAllJournals()
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }

  async close(): Promise<void> {
    this.#snapshotStore.close()
  }

  async acquireRunLock(projectIdentityDigest: string, runId: string): Promise<RuntimeRunLock> {
    const key = runKey(projectIdentityDigest, runId)
    await this.#mutate((snapshot) => {
      const existing = snapshot.leases[key]
      const now = this.#now()
      if (existing !== undefined
        && existing.ownerNonce !== this.#processNonce
        && Date.parse(existing.expiresAt) > now.getTime()) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_LOCKED', 'Run 正由另一 mutation owner 持有')
      }
      if (existing !== undefined
        && existing.ownerNonce === this.#processNonce
        && Date.parse(existing.expiresAt) > now.getTime()) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_LOCKED', 'Run 已被当前 mutation owner 持有')
      }
      snapshot.leases[key] = {
        ownerNonce: this.#processNonce,
        expiresAt: new Date(now.getTime() + this.#leaseMilliseconds).toISOString(),
      }
    })
    let closed = false
    return {
      close: async () => {
        if (closed) return
        closed = true
        await this.#mutate((snapshot) => {
          if (snapshot.leases[key]?.ownerNonce === this.#processNonce) delete snapshot.leases[key]
        })
      },
    }
  }

  async recordResponse(
    projectIdentityDigest: string,
    runId: string,
    requestId: string,
    requestDigest: string,
    response: unknown,
  ): Promise<unknown> {
    let recordedResponse = response
    await this.#mutate((snapshot) => {
      const key = runKey(projectIdentityDigest, runId)
      const run = snapshot.runs[key]
      if (run !== undefined) {
        this.#assertOwnedLease(snapshot, key)
        verifyJournalRows(snapshot.journals[key] ?? [], true, run)
      }
      const responseMap = run?.requestResponses ?? snapshot.orphanResponses
      const responseKey = run === undefined ? replayKey(key, requestId) : requestId
      const existing = responseMap[responseKey]
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) {
          throw runtimeStoreError(
            'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH',
            '同一 requestId 不得绑定到不同请求 bytes',
          )
        }
        recordedResponse = existing.response
        return
      }
      responseMap[responseKey] = { requestDigest, response }
      if (run !== undefined) {
        appendJournalRow(snapshot, key, {
          kind: 'request-recorded',
          digest: runtimeRunSnapshotDigest(run),
        })
      }
    })
    return recordedResponse
  }

  async getRecordedResponse(
    projectIdentityDigest: string,
    runId: string,
    requestId: string,
    requestDigest: string,
  ): Promise<unknown | undefined> {
    return await this.#read((snapshot) => {
      const key = runKey(projectIdentityDigest, runId)
      const run = snapshot.runs[key]
      if (run !== undefined) verifyJournalRows(snapshot.journals[key] ?? [], true, run)
      const existing = run?.requestResponses[requestId]
        ?? snapshot.orphanResponses[replayKey(key, requestId)]
      if (existing === undefined) return undefined
      if (existing.requestDigest !== requestDigest) {
        throw runtimeStoreError(
          'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH',
          '同一 requestId 不得绑定到不同请求 bytes',
        )
      }
      return structuredClone(existing.response)
    })
  }

  async createRun(snapshot: RuntimeRunSnapshot): Promise<void> {
    const validated = migrateRuntimeRunSnapshot(snapshot)
    await this.#mutate((store) => {
      const key = runKey(validated.projectIdentityDigest, validated.runId)
      this.#assertOwnedLease(store, key)
      if (store.runs[key] !== undefined) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_ALREADY_EXISTS', 'Run 已存在')
      }
      store.runs[key] = structuredClone(validated)
      appendJournalRow(store, key, {
        kind: 'run-created',
        digest: runtimeRunSnapshotDigest(validated),
      })
    })
  }

  async getRun(
    projectIdentityDigest: string,
    runId: string,
  ): Promise<RuntimeRunSnapshot | undefined> {
    return await this.#read((snapshot) => {
      const key = runKey(projectIdentityDigest, runId)
      const run = snapshot.runs[key]
      verifyJournalRows(snapshot.journals[key] ?? [], run !== undefined, run)
      return run === undefined ? undefined : migrateRuntimeRunSnapshot(run)
    })
  }

  async updateRun(
    projectIdentityDigest: string,
    runId: string,
    update: (snapshot: RuntimeRunSnapshot) => RuntimeRunSnapshot,
    eventKind = 'run-updated',
  ): Promise<RuntimeRunSnapshot> {
    let updated!: RuntimeRunSnapshot
    await this.#mutate((store) => {
      const key = runKey(projectIdentityDigest, runId)
      this.#assertOwnedLease(store, key)
      const existing = store.runs[key]
      verifyJournalRows(store.journals[key] ?? [], existing !== undefined, existing)
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      updated = migrateRuntimeRunSnapshot(update(migrateRuntimeRunSnapshot(existing)))
      if (updated.projectIdentityDigest !== projectIdentityDigest || updated.runId !== runId) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_REBIND_FORBIDDEN', '更新不得改变 Run 主键')
      }
      store.runs[key] = structuredClone(updated)
      appendJournalRow(store, key, {
        kind: eventKind,
        digest: runtimeRunSnapshotDigest(updated),
      })
    })
    return structuredClone(updated)
  }

  async appendJournal(
    projectIdentityDigest: string,
    runId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    await this.#mutate((snapshot) => {
      const key = runKey(projectIdentityDigest, runId)
      this.#assertOwnedLease(snapshot, key)
      verifyJournalRows(snapshot.journals[key] ?? [], false)
      appendJournalRow(snapshot, key, event)
    })
  }

  async verifyJournal(projectIdentityDigest: string, runId: string): Promise<void> {
    await this.#read((snapshot) => {
      const key = runKey(projectIdentityDigest, runId)
      verifyJournalRows(snapshot.journals[key] ?? [], snapshot.runs[key] !== undefined, snapshot.runs[key])
    })
  }

  async tamperJournalForTest(
    projectIdentityDigest: string,
    runId: string,
    index: number,
  ): Promise<void> {
    await this.#mutate((snapshot) => {
      const row = snapshot.journals[runKey(projectIdentityDigest, runId)]?.[index]
      if (row !== undefined) row.rowDigest = EMPTY_DIGEST
    })
  }

  async #read<T>(operation: (snapshot: RunStoreSnapshot) => T): Promise<T> {
    return await this.#snapshotStore.runExclusive(async () => {
      const serialized = this.#snapshotStore.begin()
      try {
        const result = operation(parseStoreSnapshot(serialized))
        this.#snapshotStore.rollback()
        return result
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }

  async #mutate(operation: (snapshot: RunStoreSnapshot) => void): Promise<void> {
    await this.#snapshotStore.runExclusive(async () => {
      const serialized = this.#snapshotStore.begin()
      try {
        const snapshot = parseStoreSnapshot(serialized)
        operation(snapshot)
        this.#snapshotStore.commit(canonicalizeJson(snapshot))
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }

  async #verifyAllJournals(): Promise<void> {
    await this.#read((snapshot) => {
      const keys = new Set([...Object.keys(snapshot.runs), ...Object.keys(snapshot.journals)])
      for (const key of keys) {
        const run = snapshot.runs[key]
        verifyJournalRows(snapshot.journals[key] ?? [], run !== undefined, run)
      }
    })
  }

  #assertOwnedLease(snapshot: RunStoreSnapshot, key: string): void {
    const lease = snapshot.leases[key]
    if (lease?.ownerNonce !== this.#processNonce || Date.parse(lease.expiresAt) <= this.#now().getTime()) {
      throw runtimeStoreError('E2E_RUNTIME_RUN_LOCK_REQUIRED', 'Run mutation 需要有效的进程 nonce lease')
    }
  }
}

function emptyStoreSnapshot(): RunStoreSnapshot {
  return {
    schemaVersion: '1.0.0',
    runs: {},
    orphanResponses: {},
    leases: {},
    journals: {},
  }
}

function parseStoreSnapshot(serialized: string): RunStoreSnapshot {
  const value = JSON.parse(serialized) as RunStoreSnapshot
  if (value?.schemaVersion !== '1.0.0'
    || !isPlainRecord(value.runs)
    || !isPlainRecord(value.orphanResponses)
    || !isPlainRecord(value.leases)
    || !isPlainRecord(value.journals)) {
    throw runtimeStoreError('E2E_RUNTIME_STATE_MIGRATION_REQUIRED', 'Run Store snapshot 版本不受支持')
  }
  return value
}

function runKey(projectIdentityDigest: string, runId: string): string {
  return `${projectIdentityDigest}\u0000${runId}`
}

function replayKey(run: string, requestId: string): string {
  return `${run}\u0000${requestId}`
}

function appendJournalRow(
  snapshot: RunStoreSnapshot,
  key: string,
  event: Record<string, unknown>,
): void {
  const journal = snapshot.journals[key] ?? []
  const sequence = journal.length + 1
  const previousDigest = journal.at(-1)?.rowDigest ?? EMPTY_DIGEST
  const eventDigest = digestText('e2e-runtime-journal-event/v1', canonicalizeJson(event))
  const rowCore = { sequence, previousDigest, eventDigest }
  journal.push({
    ...rowCore,
    event: structuredClone(event),
    rowDigest: digestText('e2e-runtime-journal-row/v1', canonicalizeJson(rowCore)),
  })
  snapshot.journals[key] = journal
}

function verifyJournalRows(
  rows: JournalRow[],
  required: boolean,
  run?: RuntimeRunSnapshot,
): void {
  try {
    verifyJournalRowsUnchecked(rows, required, run)
  } catch (error) {
    if (error instanceof E2EError && error.code === 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED') throw error
    throw runtimeStoreError(
      'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED',
      'Journal 不是可校验的严格 hash chain',
      error,
    )
  }
}

function verifyJournalRowsUnchecked(
  rows: JournalRow[],
  required: boolean,
  run?: RuntimeRunSnapshot,
): void {
  if (required && rows.length === 0) {
    throw runtimeStoreError('E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED', '持久 Run 缺少 Journal')
  }
  let previousDigest = EMPTY_DIGEST
  for (const [index, row] of rows.entries()) {
    const sequence = index + 1
    const eventDigest = digestText('e2e-runtime-journal-event/v1', canonicalizeJson(row.event))
    const rowDigest = digestText('e2e-runtime-journal-row/v1', canonicalizeJson({
      sequence,
      previousDigest,
      eventDigest,
    }))
    if (row.sequence !== sequence
      || row.previousDigest !== previousDigest
      || row.eventDigest !== eventDigest
      || row.rowDigest !== rowDigest) {
      throw runtimeStoreError(
        'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED',
        'Journal 存在缺口、重排或摘要不一致',
      )
    }
    previousDigest = row.rowDigest
  }
  const lastEvent = rows.at(-1)?.event
  if (run !== undefined
    && lastEvent !== undefined
    && ['run-created', 'run-updated', 'candidate-accepted', 'request-recorded'].includes(String(lastEvent.kind))
    && lastEvent.digest !== runtimeRunSnapshotDigest(run)) {
    throw runtimeStoreError(
      'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED',
      'Run snapshot 与 Journal 尾摘要不一致',
    )
  }
}

function runtimeRunSnapshotDigest(snapshot: RuntimeRunSnapshot): string {
  return digestText('e2e-runtime-run-snapshot/v1', canonicalizeJson(snapshot))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function runtimeStoreError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({
    code,
    category: code.includes('MIGRATION') ? 'artifact' : 'safety',
    message: `${code}: ${message}`,
    retryable: false,
    cause,
  })
}
