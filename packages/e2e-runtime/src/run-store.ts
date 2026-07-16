import { SqliteSnapshotStore } from '@mutil-skills/e2e-authority'
import {
  canonicalizeJson,
  digestText,
  E2EError,
  type WorkflowState,
} from '@mutil-skills/e2e-contracts'
import type { PendingWorkflowDecision } from '@mutil-skills/e2e-engine'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
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

export interface RuntimeRunStoreTestHooks {
  beforeResponseLedgerCommit?(): void
}

export interface RuntimeRunStoreOptions {
  homeDir: string
  projectRoot?: string
  forbiddenRoots?: string[]
  now?: () => Date
  leaseMilliseconds?: number
  testHooks?: RuntimeRunStoreTestHooks
}

export type RuntimeRequestReservation =
  | { kind: 'pending' }
  | { kind: 'replay'; response: unknown }

interface JournalRow {
  sequence: number
  previousDigest: string
  event: Record<string, unknown>
  eventDigest: string
  rowDigest: string
}

interface PendingGlobalRequest {
  requestDigest: string
  status: 'pending'
}

interface CompletedGlobalRequest {
  requestDigest: string
  status: 'completed'
  response: unknown
}

type GlobalRequestEntry = PendingGlobalRequest | CompletedGlobalRequest

interface GlobalReplayLedger {
  entries: Record<string, GlobalRequestEntry>
  journal: JournalRow[]
}

interface LeaseRow {
  ownerNonce: string
  expiresAt: string
}

interface RunStoreSnapshot {
  schemaVersion: '1.0.0'
  runs: Record<string, RuntimeRunSnapshot>
  leases: Record<string, LeaseRow>
  journals: Record<string, JournalRow[]>
  globalLedger: GlobalReplayLedger
}

export class RuntimeRunStore {
  readonly #snapshotStore: SqliteSnapshotStore
  readonly #processNonce = randomUUID()
  readonly #now: () => Date
  readonly #leaseMilliseconds: number
  readonly #testHooks: RuntimeRunStoreTestHooks

  private constructor(
    snapshotStore: SqliteSnapshotStore,
    now: () => Date,
    leaseMilliseconds: number,
    testHooks: RuntimeRunStoreTestHooks,
  ) {
    this.#snapshotStore = snapshotStore
    this.#now = now
    this.#leaseMilliseconds = leaseMilliseconds
    this.#testHooks = testHooks
  }

  static async open(options: RuntimeRunStoreOptions): Promise<RuntimeRunStore> {
    if (!options.homeDir || 'stateRoot' in options) {
      throw runtimeStoreError(
        'E2E_RUNTIME_STATE_CONFIG_INVALID',
        'Run Store 必须从 homeDir 的固定用户级 layout 派生',
      )
    }
    const stateRoot = runtimeLayout(options.homeDir).state
    await ensureSecureUserStateRoot(options.homeDir, stateRoot)
    const forbiddenRoots = [...new Set([
      '/dev',
      ...(options.projectRoot === undefined ? [] : [options.projectRoot]),
      ...(options.forbiddenRoots ?? []),
    ])]
    const snapshotStore = new SqliteSnapshotStore(
      join(stateRoot, 'runtime-runs.sqlite'),
      'e2e-runtime-runs/v1',
      { forbiddenRoots },
    )
    snapshotStore.initialize(canonicalizeJson(emptyStoreSnapshot()))
    const store = new RuntimeRunStore(
      snapshotStore,
      options.now ?? (() => new Date()),
      options.leaseMilliseconds ?? LEASE_MILLISECONDS,
      options.testHooks ?? {},
    )
    try {
      await store.#verifyPersistedState()
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }

  async close(): Promise<void> {
    this.#snapshotStore.close()
  }

  async beginRequest(requestId: string, requestDigest: string): Promise<RuntimeRequestReservation> {
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const existing = snapshot.globalLedger.entries[requestId]
      if (existing !== undefined) return replayOrPending(existing, requestDigest)
      snapshot.globalLedger.entries[requestId] = { requestDigest, status: 'pending' }
      appendJournalRow(snapshot.globalLedger.journal, {
        kind: 'request-reserved',
        requestId,
        requestDigest,
      })
      return { kind: 'pending' }
    })
  }

  async completeGlobalRequest(
    requestId: string,
    requestDigest: string,
    response: unknown,
  ): Promise<unknown> {
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      this.#testHooks.beforeResponseLedgerCommit?.()
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, response)
      return structuredClone(response)
    })
  }

  async createRunOutcome(
    runSnapshot: RuntimeRunSnapshot,
    requestId: string,
    requestDigest: string,
    response: unknown,
  ): Promise<unknown> {
    const validatedInput = migrateRuntimeRunSnapshot(runSnapshot)
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(snapshot, requestId, requestDigest)
      const key = runKey(validatedInput.projectIdentityDigest, validatedInput.runId)
      if (snapshot.runs[key] !== undefined || snapshot.journals[key] !== undefined) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_ALREADY_EXISTS', 'Run 已存在')
      }
      const persisted = migrateRuntimeRunSnapshot({
        ...validatedInput,
        requestResponses: {
          ...validatedInput.requestResponses,
          [requestId]: { requestDigest, response },
        },
      })
      snapshot.runs[key] = persisted
      snapshot.journals[key] = []
      appendRunSnapshotJournal(snapshot, key, 'run-created')
      this.#testHooks.beforeResponseLedgerCommit?.()
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, response)
      return structuredClone(response)
    })
  }

  async updateRunOutcome(
    projectIdentityDigest: string,
    runId: string,
    requestId: string,
    requestDigest: string,
    update: (snapshot: RuntimeRunSnapshot) => {
      snapshot: RuntimeRunSnapshot
      response: unknown
    },
    eventKind = 'run-updated',
  ): Promise<unknown> {
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(snapshot, requestId, requestDigest)
      const key = runKey(projectIdentityDigest, runId)
      const existing = snapshot.runs[key]
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const outcome = update(migrateRuntimeRunSnapshot(existing))
      const persisted = migrateRuntimeRunSnapshot({
        ...outcome.snapshot,
        requestResponses: {
          ...outcome.snapshot.requestResponses,
          [requestId]: { requestDigest, response: outcome.response },
        },
      })
      if (persisted.projectIdentityDigest !== projectIdentityDigest || persisted.runId !== runId) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_REBIND_FORBIDDEN', '更新不得改变 Run 主键')
      }
      snapshot.runs[key] = persisted
      appendRunSnapshotJournal(snapshot, key, eventKind)
      this.#testHooks.beforeResponseLedgerCommit?.()
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, outcome.response)
      return structuredClone(outcome.response)
    })
  }

  async readRunOutcome(
    projectIdentityDigest: string,
    runId: string,
    requestId: string,
    requestDigest: string,
    project: (snapshot: RuntimeRunSnapshot) => unknown,
  ): Promise<unknown> {
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(snapshot, requestId, requestDigest)
      const key = runKey(projectIdentityDigest, runId)
      const existing = snapshot.runs[key]
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const response = project(migrateRuntimeRunSnapshot(existing))
      snapshot.runs[key] = migrateRuntimeRunSnapshot({
        ...existing,
        requestResponses: {
          ...existing.requestResponses,
          [requestId]: { requestDigest, response },
        },
      })
      appendRunSnapshotJournal(snapshot, key, 'status-recorded')
      this.#testHooks.beforeResponseLedgerCommit?.()
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, response)
      return structuredClone(response)
    })
  }

  async getRun(
    projectIdentityDigest: string,
    runId: string,
  ): Promise<RuntimeRunSnapshot | undefined> {
    return await this.#read((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const run = snapshot.runs[runKey(projectIdentityDigest, runId)]
      return run === undefined ? undefined : migrateRuntimeRunSnapshot(run)
    })
  }

  async acquireRunLock(projectIdentityDigest: string, runId: string): Promise<RuntimeRunLock> {
    const key = runKey(projectIdentityDigest, runId)
    await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const existing = snapshot.leases[key]
      const now = this.#now()
      if (existing !== undefined && Date.parse(existing.expiresAt) > now.getTime()) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_LOCKED', 'Run 正由 mutation owner 持有')
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
          verifyStoreSnapshot(snapshot)
          if (snapshot.leases[key]?.ownerNonce === this.#processNonce) delete snapshot.leases[key]
        })
      },
    }
  }

  async #verifyPersistedState(): Promise<void> {
    await this.#read((snapshot) => { verifyStoreSnapshot(snapshot) })
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

  async #mutate<T>(operation: (snapshot: RunStoreSnapshot) => T): Promise<T> {
    return await this.#snapshotStore.runExclusive(async () => {
      const serialized = this.#snapshotStore.begin()
      try {
        const snapshot = parseStoreSnapshot(serialized)
        const result = operation(snapshot)
        this.#snapshotStore.commit(canonicalizeJson(snapshot))
        return result
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }
}

function emptyStoreSnapshot(): RunStoreSnapshot {
  return {
    schemaVersion: '1.0.0',
    runs: {},
    leases: {},
    journals: {},
    globalLedger: { entries: {}, journal: [] },
  }
}

function parseStoreSnapshot(serialized: string): RunStoreSnapshot {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (cause) {
    throw journalIntegrityError('Run Store snapshot 不是 JSON', cause)
  }
  if (!isPlainRecord(value) || value.schemaVersion !== '1.0.0') {
    throw runtimeStoreError('E2E_RUNTIME_STATE_MIGRATION_REQUIRED', 'Run Store snapshot 版本不受支持')
  }
  if (!hasExactKeys(value, ['globalLedger', 'journals', 'leases', 'runs', 'schemaVersion'])
    || !isPlainRecord(value.runs)
    || !isPlainRecord(value.leases)
    || !isPlainRecord(value.journals)
    || !isPlainRecord(value.globalLedger)
    || !hasExactKeys(value.globalLedger, ['entries', 'journal'])
    || !isPlainRecord(value.globalLedger.entries)
    || !Array.isArray(value.globalLedger.journal)) {
    throw journalIntegrityError('Run Store snapshot 严格结构或 global ledger 缺失')
  }
  return value as unknown as RunStoreSnapshot
}

function verifyStoreSnapshot(snapshot: RunStoreSnapshot): void {
  try {
    const runKeys = Object.keys(snapshot.runs).sort()
    const journalKeys = Object.keys(snapshot.journals).sort()
    if (canonicalizeJson(runKeys) !== canonicalizeJson(journalKeys)) {
      throw journalIntegrityError('Run snapshot 与 journal key 必须一一对应')
    }
    for (const key of runKeys) {
      const run = migrateRuntimeRunSnapshot(snapshot.runs[key])
      if (key !== runKey(run.projectIdentityDigest, run.runId)) {
        throw journalIntegrityError('Run snapshot key 与持久身份不一致')
      }
      const rows = snapshot.journals[key]
      if (!Array.isArray(rows) || rows.length === 0) {
        throw journalIntegrityError('每个 Run snapshot 必须有非空 journal')
      }
      verifyJournalRows(rows)
      const tail = rows.at(-1)?.event
      if (tail?.digest !== runtimeRunSnapshotDigest(run)) {
        throw journalIntegrityError('Run snapshot 与 journal tail digest 不一致')
      }
    }
    verifyGlobalLedger(snapshot.globalLedger)
    verifyLeases(snapshot.leases)
  } catch (error) {
    if (error instanceof E2EError && error.code === 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED') throw error
    throw journalIntegrityError('持久状态无法闭合验证', error)
  }
}

function verifyGlobalLedger(ledger: GlobalReplayLedger): void {
  verifyJournalRows(ledger.journal)
  const projected = new Map<string, { requestDigest: string; status: 'pending' | 'completed'; responseDigest?: string }>()
  for (const row of ledger.journal) {
    const event = row.event
    if (event.kind === 'request-reserved'
      && hasExactKeys(event, ['kind', 'requestDigest', 'requestId'])
      && typeof event.requestId === 'string'
      && typeof event.requestDigest === 'string'
      && projected.has(event.requestId) === false) {
      projected.set(event.requestId, { requestDigest: event.requestDigest, status: 'pending' })
      continue
    }
    if (event.kind === 'request-completed'
      && hasExactKeys(event, ['kind', 'requestDigest', 'requestId', 'responseDigest'])
      && typeof event.requestId === 'string'
      && typeof event.requestDigest === 'string'
      && typeof event.responseDigest === 'string') {
      const existing = projected.get(event.requestId)
      if (existing?.status === 'pending' && existing.requestDigest === event.requestDigest) {
        projected.set(event.requestId, {
          requestDigest: event.requestDigest,
          status: 'completed',
          responseDigest: event.responseDigest,
        })
        continue
      }
    }
    throw journalIntegrityError('global replay journal 事件非法或重排')
  }
  const entryKeys = Object.keys(ledger.entries).sort()
  if (canonicalizeJson(entryKeys) !== canonicalizeJson([...projected.keys()].sort())) {
    throw journalIntegrityError('global replay ledger entry 与 journal 不闭合')
  }
  for (const requestId of entryKeys) {
    const entry = ledger.entries[requestId]
    const expected = projected.get(requestId)
    if (!isPlainRecord(entry) || expected === undefined || entry.requestDigest !== expected.requestDigest
      || entry.status !== expected.status) {
      throw journalIntegrityError('global replay ledger entry 被修改')
    }
    if (entry.status === 'pending') {
      if (!hasExactKeys(entry, ['requestDigest', 'status'])) {
        throw journalIntegrityError('pending replay entry 结构非法')
      }
      continue
    }
    if (!hasExactKeys(entry, ['requestDigest', 'response', 'status'])
      || responseDigest(entry.response) !== expected.responseDigest) {
      throw journalIntegrityError('completed replay response 与 journal 不一致')
    }
  }
}

function verifyJournalRows(rows: JournalRow[]): void {
  let previousDigest = EMPTY_DIGEST
  for (const [index, candidate] of rows.entries()) {
    if (!isPlainRecord(candidate)
      || !hasExactKeys(candidate, ['event', 'eventDigest', 'previousDigest', 'rowDigest', 'sequence'])
      || candidate.sequence !== index + 1
      || candidate.previousDigest !== previousDigest
      || !isPlainRecord(candidate.event)) {
      throw journalIntegrityError('journal row 结构、sequence 或 previous digest 非法')
    }
    const eventDigest = digestText('e2e-runtime-journal-event/v1', canonicalizeJson(candidate.event))
    const rowDigest = digestText('e2e-runtime-journal-row/v1', canonicalizeJson({
      sequence: index + 1,
      previousDigest,
      eventDigest,
    }))
    if (candidate.eventDigest !== eventDigest || candidate.rowDigest !== rowDigest) {
      throw journalIntegrityError('journal event 或 row digest 不一致')
    }
    previousDigest = candidate.rowDigest as string
  }
}

function verifyLeases(leases: Record<string, LeaseRow>): void {
  for (const lease of Object.values(leases)) {
    if (!isPlainRecord(lease)
      || !hasExactKeys(lease, ['expiresAt', 'ownerNonce'])
      || typeof lease.ownerNonce !== 'string'
      || typeof lease.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(lease.expiresAt))) {
      throw journalIntegrityError('lease row 结构非法')
    }
  }
}

function replayOrPending(entry: GlobalRequestEntry, requestDigest: string): RuntimeRequestReservation {
  if (entry.requestDigest !== requestDigest) throw requestReplayMismatch()
  return entry.status === 'completed'
    ? { kind: 'replay', response: structuredClone(entry.response) }
    : { kind: 'pending' }
}

function completedReplay(
  snapshot: RunStoreSnapshot,
  requestId: string,
  requestDigest: string,
): { found: false } | { found: true; response: unknown } {
  const entry = snapshot.globalLedger.entries[requestId]
  if (entry === undefined) return { found: false }
  if (entry.requestDigest !== requestDigest) throw requestReplayMismatch()
  return entry.status === 'completed'
    ? { found: true, response: structuredClone(entry.response) }
    : { found: false }
}

function requirePendingRequest(
  snapshot: RunStoreSnapshot,
  requestId: string,
  requestDigest: string,
): void {
  const entry = snapshot.globalLedger.entries[requestId]
  if (entry?.requestDigest !== requestDigest) {
    if (entry !== undefined) throw requestReplayMismatch()
    throw runtimeStoreError('E2E_RUNTIME_REQUEST_NOT_RESERVED', 'request 必须先写入全局 reservation')
  }
  if (entry.status !== 'pending') {
    throw runtimeStoreError('E2E_RUNTIME_REQUEST_ALREADY_COMPLETED', 'request outcome 已完成')
  }
}

function completeGlobalLedger(
  ledger: GlobalReplayLedger,
  requestId: string,
  requestDigest: string,
  response: unknown,
): void {
  const entry = ledger.entries[requestId]
  if (entry?.requestDigest !== requestDigest || entry.status !== 'pending') {
    if (entry !== undefined && entry.requestDigest !== requestDigest) throw requestReplayMismatch()
    throw runtimeStoreError('E2E_RUNTIME_REQUEST_NOT_RESERVED', '只能完成已 reservation 的 request')
  }
  ledger.entries[requestId] = { requestDigest, status: 'completed', response }
  appendJournalRow(ledger.journal, {
    kind: 'request-completed',
    requestId,
    requestDigest,
    responseDigest: responseDigest(response),
  })
}

function appendRunSnapshotJournal(snapshot: RunStoreSnapshot, key: string, kind: string): void {
  const run = snapshot.runs[key]
  if (run === undefined) throw journalIntegrityError('无法为缺失 Run 写 journal')
  appendJournalRow(snapshot.journals[key]!, {
    kind,
    digest: runtimeRunSnapshotDigest(run),
  })
}

function appendJournalRow(journal: JournalRow[], event: Record<string, unknown>): void {
  const sequence = journal.length + 1
  const previousDigest = journal.at(-1)?.rowDigest ?? EMPTY_DIGEST
  const eventDigest = digestText('e2e-runtime-journal-event/v1', canonicalizeJson(event))
  const rowCore = { sequence, previousDigest, eventDigest }
  journal.push({
    ...rowCore,
    event: structuredClone(event),
    rowDigest: digestText('e2e-runtime-journal-row/v1', canonicalizeJson(rowCore)),
  })
}

function runKey(projectIdentityDigest: string, runId: string): string {
  return `${projectIdentityDigest}\u0000${runId}`
}

function runtimeRunSnapshotDigest(snapshot: RuntimeRunSnapshot): string {
  return digestText('e2e-runtime-run-snapshot/v1', canonicalizeJson(snapshot))
}

function responseDigest(response: unknown): string {
  return digestText('e2e-runtime-response/v1', canonicalizeJson(response))
}

function requestReplayMismatch(): E2EError {
  return runtimeStoreError(
    'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH',
    '同一 requestId 不得绑定到不同 request bytes',
  )
}

async function ensureSecureUserStateRoot(homeDir: string, stateRoot: string): Promise<void> {
  const absoluteHome = resolve(homeDir)
  let realHome: string
  try {
    realHome = await realpath(absoluteHome)
  } catch (cause) {
    throw runtimeStoreError('E2E_RUNTIME_STATE_ROOT_INVALID', 'homeDir 不存在或不可读取', cause)
  }
  if (realHome !== normalizePlatformPathAlias(absoluteHome)) {
    throw runtimeStoreError('E2E_RUNTIME_STATE_SYMLINK_FORBIDDEN', 'homeDir 不得经符号链接解析')
  }
  let current = realHome
  for (const part of ['.mutil-skills', 'e2e', 'state']) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
    }
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw runtimeStoreError('E2E_RUNTIME_STATE_SYMLINK_FORBIDDEN', '用户级 state 路径必须由真实目录组成')
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid
    if (metadata.uid !== currentUid || (metadata.mode & 0o077) !== 0) {
      throw runtimeStoreError(
        'E2E_RUNTIME_STATE_PERMISSIONS_INVALID',
        '用户级 state 路径各层必须由当前 UID 拥有且权限不宽于 0700',
      )
    }
  }
  if (await realpath(stateRoot) !== normalizePlatformPathAlias(resolve(stateRoot))) {
    throw runtimeStoreError('E2E_RUNTIME_STATE_SYMLINK_FORBIDDEN', 'state root canonical path 不一致')
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST'
}

function normalizePlatformPathAlias(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function journalIntegrityError(message: string, cause?: unknown): E2EError {
  return runtimeStoreError('E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED', message, cause)
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
