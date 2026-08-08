import {
  SqliteSnapshotStore,
  type SqliteStateDirectoryIdentity,
} from '@mutil-skills/e2e-authority'
import {
  canonicalizeJson,
  digestText,
  E2EError,
  RuntimeResponseEnvelopeSchema,
  type ManualResult,
  type ArtifactDocument,
  type CompiledPrdRunPlan,
  type RuntimePreflightBlocker,
  type WorkflowState,
} from '@mutil-skills/e2e-contracts'
import { transitionWorkflow, type PendingWorkflowDecision } from '@mutil-skills/e2e-engine'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
import { migrateRuntimeRunSnapshot } from './runtime-state-migration.js'
import type { RuntimeReadExecutionRecord } from './runtime-read-result.js'
import {
  RuntimeOwnedResourceMarkerSchema,
  parseRuntimeWriteAttemptRecord,
  sealRuntimeWriteAttemptRecord,
  type RuntimeOwnedResourceMarker,
  type RuntimeWriteAttemptRecord,
  type RuntimeWriteAttemptState,
  type UnsealedRuntimeWriteAttemptRecord,
} from './write-attempt.js'
import type { RuntimeInjectionExecutionOutput, RuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import { bindManualResultToRuntimeSnapshot, MAX_TRUSTED_MANUAL_RESULTS } from './runtime-manual-results.js'
import {
  PendingLocalApprovalConfirmationSchema,
  type PendingLocalApprovalConfirmation,
} from './local-approval-confirmations.js'
import type { RuntimeCaseSchedule } from './multi-case-scheduler.js'
import { parseCaseSchedule } from './multi-case-scheduler.js'
import type { TargetContractFact } from './target-contract.js'
import type { TargetProbeFact } from './target-probe.js'

const EMPTY_DIGEST = `sha256:${'0'.repeat(64)}`
const LEASE_MILLISECONDS = 30_000
const TERMINAL_SECRET_RETIREMENT_STATES = new Set<WorkflowState['current']>([
  'accepted', 'rejected', 'incomplete', 'environment-blocked', 'safety-blocked',
  'automation-blocked', 'artifact-blocked', 'migration-required',
])

declare const runtimeSecretRetirementCapabilityBrand: unique symbol

/** 仅供 Runtime 内部模块传递；运行时真实性由本模块私有 WeakMap 保证。 */
export interface RuntimeSecretRetirementCapability {
  readonly [runtimeSecretRetirementCapabilityBrand]: true
}

interface RetirementCapabilityRecord {
  projectIdentityDigest: string
  runId: string
  state: 'available' | 'in-progress' | 'used'
  execute<T>(operation: () => Promise<T>): Promise<T>
}

const retirementCapabilities = new WeakMap<object, RetirementCapabilityRecord>()
const trustedFactCapabilities = new WeakMap<object, {
  store: RuntimeRunStore
  projectIdentityDigest: string
  runId: string
  lock: RuntimeRunLock
  runRevision: number
  snapshotDigest: string
  used: boolean
}>()
const executionOwnerClaims = new WeakMap<object, {
  store: RuntimeRunStore
  key: string
  ownerNonce: string
  fencingToken: number
  released: boolean
}>()

declare const runtimeTrustedFactCapabilityBrand: unique symbol
export interface RuntimeTrustedFactCapability {
  readonly [runtimeTrustedFactCapabilityBrand]: true
}

export interface RuntimeRunSnapshot {
  /** 1.1–1.7 仅作为显式迁移输入兼容；Store 读取与写回始终规范化为 1.8。 */
  schemaVersion: '1.1.0' | '1.2.0' | '1.3.0' | '1.4.0' | '1.5.0' | '1.6.0' | '1.7.0' | '1.8.0'
  runId: string
  assetId: string
  projectIdentityDigest: string
  runtimeInstallationDigest: string
  /** 每次持久化执行边界单调递增，用于拒绝陈旧 execution completion。 */
  runRevision?: number
  executionAttempt?: RuntimeExecutionAttempt
  preflightAttempt?: RuntimePreflightAttempt
  /** 预检环境/输入阻断不是 Engine 终态；修复后可在原 Run 重试。 */
  preflightBlocker?: RuntimePreflightBlocker
  targetContract?: TargetContractFact
  targetProbe?: TargetProbeFact
  finalizationAttempt?: RuntimeFinalizationAttempt
  publication?: RuntimePublicationRecord
  workflow: WorkflowState
  pendingDecision?: PendingWorkflowDecision
  artifactDigests: Record<string, string>
  /** 通过 Artifact registry 严格解析后保存的 canonical Candidate；不得保存源文件路径或可执行源码。 */
  frozenArtifacts: Record<string, ArtifactDocument>
  /** 仅 Runtime 内部可信执行链产生；外部 submit-candidate 永远不能写入。 */
  trustedExecutionFacts: Record<string, unknown>
  /** Runtime 从唯一 requirements projection 确定性生成；调用者不能提交摘要或 ID。 */
  compiledPrdRun?: CompiledPrdRunPlan
  /** Runtime 持久化的串行多 Case 调度游标。 */
  caseSchedule?: RuntimeCaseSchedule
  /** 写动作的 durable 状态机；恢复只能 reconcile，绝不能据此重放动作。 */
  writeAttempts?: Record<string, RuntimeWriteAttemptRecord>
  /** real 与 injection 分域持久化；注入结果永远不能覆盖真实环境结果。 */
  executionResults?: {
    readEnvironment?: Record<string, RuntimeReadExecutionRecord>
    realEnvironment: Record<string, RuntimeWriteExecutionOutput>
    gatewayInjection: Record<string, RuntimeInjectionExecutionOutput>
  }
  requestResponses: Record<string, { requestDigest: string; response: unknown }>
  createdAt: string
  updatedAt: string
}

export interface RuntimeExecutionAttempt {
  attemptId: string
  requestId: string
  requestDigest?: string
  fencingToken: number
  revision: number
  startedAt: string
}

export interface RuntimePreflightAttempt {
  requestId: string
  requestDigest: string
  revision: number
  startedAt: string
  preparation: unknown
}

export interface RuntimeFinalizationAttempt {
  attemptId: string
  requestId: string
  requestDigest: string
  revision: number
  startedAt: string
}

export interface RuntimePublicationRecord {
  generationId: string
  generationDigest: string
  terminalVerdict: string
  activeReadbackDigest: string
  quarantineDispositionDigest: string
  committedAt: string
}

export interface RuntimeExecutionOwner {
  readonly heartbeatIntervalMs: number
  renew(): Promise<void>
  release(): Promise<void>
}

export interface ActiveRuntimeInstallationReference {
  projectIdentityDigest: string
  runId: string
  installationDigest: string
  workflowState: WorkflowState['current']
}

export interface RuntimeRunLock {
  close(): Promise<void>
}

export interface RuntimeRunStoreOptions {
  homeDir: string
  projectRoot?: string
  forbiddenRoots?: string[]
  now?: () => Date
  leaseMilliseconds?: number
}

export type RuntimeRequestReservation =
  | { kind: 'reserved' }
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
  runOutcome?: GlobalRunOutcomeBinding
}

interface GlobalRunOutcomeBinding {
  runKey: string
  snapshotDigest: string
  outcomeKind: string
}

type GlobalRequestEntry = PendingGlobalRequest | CompletedGlobalRequest

interface GlobalReplayLedger {
  entries: Record<string, GlobalRequestEntry>
  journal: JournalRow[]
}

interface LeaseRow {
  ownerNonce: string
  fencingToken: number
  expiresAt: string
}

interface LeaseClaim {
  key: string
  ownerNonce: string
  fencingToken: number
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
  readonly #lockClaims = new WeakMap<RuntimeRunLock, LeaseClaim>()
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
    if (!options.homeDir || 'stateRoot' in options || 'testHooks' in options) {
      throw runtimeStoreError(
        'E2E_RUNTIME_STATE_CONFIG_INVALID',
        'Run Store 必须从 homeDir 的固定用户级 layout 派生',
      )
    }
    const stateRoot = runtimeLayout(options.homeDir).state
    const expectedStateDirectory = await ensureSecureUserStateRoot(options.homeDir, stateRoot)
    const forbiddenRoots = [...new Set([
      '/dev',
      ...(options.projectRoot === undefined ? [] : [options.projectRoot]),
      ...(options.forbiddenRoots ?? []),
    ])]
    const snapshotStore = new SqliteSnapshotStore(
      join(stateRoot, 'runtime-runs.sqlite'),
      'e2e-runtime-runs/v1',
      { forbiddenRoots, expectedStateDirectory },
    )
    snapshotStore.initialize(canonicalizeJson(emptyStoreSnapshot()))
    const store = new RuntimeRunStore(
      snapshotStore,
      options.now ?? (() => new Date()),
      options.leaseMilliseconds ?? LEASE_MILLISECONDS,
    )
    try {
      await store.#migratePersistedState()
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
      return { kind: 'reserved' }
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
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, response)
      return structuredClone(response)
    })
  }

  async createRunOutcome(
    runSnapshot: RuntimeRunSnapshot,
    requestId: string,
    requestDigest: string,
    response: unknown,
    lock: RuntimeRunLock,
  ): Promise<unknown> {
    const validatedInput = migrateRuntimeRunSnapshot(runSnapshot)
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const key = runKey(validatedInput.projectIdentityDigest, validatedInput.runId)
      this.#requireCurrentLease(snapshot, key, lock)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(snapshot, requestId, requestDigest)
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
      const runOutcome = appendRunSnapshotJournal(snapshot, key, 'run-created', requestId)
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, response, runOutcome)
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
    eventKind: string,
    lock: RuntimeRunLock,
  ): Promise<unknown> {
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const key = runKey(projectIdentityDigest, runId)
      this.#requireCurrentLease(snapshot, key, lock)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(snapshot, requestId, requestDigest)
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
      const runOutcome = appendRunSnapshotJournal(snapshot, key, eventKind, requestId)
      completeGlobalLedger(
        snapshot.globalLedger, requestId, requestDigest, outcome.response, runOutcome,
      )
      return structuredClone(outcome.response)
    })
  }

  async claimLocalApprovalConfirmation(input: {
    projectIdentityDigest: string
    runId: string
    confirmationId: string
    requestId: string
    requestDigest: string
    claimedAt: string
    lock: RuntimeRunLock
  }): Promise<PendingLocalApprovalConfirmation> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      requirePendingRequest(store, input.requestId, input.requestDigest)
      const raw = store.runs[key]
      if (raw === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(raw)
      const parsed = PendingLocalApprovalConfirmationSchema.safeParse(
        current.trustedExecutionFacts['pending-local-approval'],
      )
      if (!parsed.success || parsed.data.confirmationId !== input.confirmationId) {
        throw runtimeStoreError('E2E_LOCAL_CONFIRMATION_NOT_FOUND', '本地确认不存在或已消费')
      }
      if (parsed.data.claimRequestId !== undefined
        && (parsed.data.claimRequestId !== input.requestId
          || parsed.data.claimRequestDigest !== input.requestDigest)) {
        throw runtimeStoreError('E2E_LOCAL_CONFIRMATION_ALREADY_CLAIMED', '本地确认已被其他请求占用')
      }
      const claimed = PendingLocalApprovalConfirmationSchema.parse({
        ...parsed.data, claimRequestId: input.requestId, claimRequestDigest: input.requestDigest,
      })
      store.runs[key] = migrateRuntimeRunSnapshot({
        ...current,
        trustedExecutionFacts: {
          ...current.trustedExecutionFacts, 'pending-local-approval': claimed,
        },
        updatedAt: input.claimedAt,
      })
      appendRunSnapshotJournal(store, key, 'local-approval-confirmation-claimed', input.requestId)
      return structuredClone(claimed)
    })
  }

  async readRunOutcome(
    projectIdentityDigest: string,
    runId: string,
    requestId: string,
    requestDigest: string,
    project: (snapshot: RuntimeRunSnapshot) => unknown,
    lock: RuntimeRunLock,
  ): Promise<unknown> {
    return await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const key = runKey(projectIdentityDigest, runId)
      this.#requireCurrentLease(snapshot, key, lock)
      const replay = completedReplay(snapshot, requestId, requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(snapshot, requestId, requestDigest)
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
      const runOutcome = appendRunSnapshotJournal(snapshot, key, 'status-recorded', requestId)
      completeGlobalLedger(snapshot.globalLedger, requestId, requestDigest, response, runOutcome)
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

  /** 卸载/GC 的只读保护边界：终态前的每个 Run 都永久引用其创建时 installation digest。 */
  async listActiveRuntimeInstallationReferences(): Promise<ActiveRuntimeInstallationReference[]> {
    return await this.#read((snapshot) => {
      verifyStoreSnapshot(snapshot)
      return Object.values(snapshot.runs)
        .map(migrateRuntimeRunSnapshot)
        .filter((run) => !TERMINAL_SECRET_RETIREMENT_STATES.has(run.workflow.current))
        .map((run) => ({
          projectIdentityDigest: run.projectIdentityDigest,
          runId: run.runId,
          installationDigest: run.runtimeInstallationDigest,
          workflowState: run.workflow.current,
        }))
        .sort((left, right) => left.projectIdentityDigest.localeCompare(right.projectIdentityDigest)
          || left.runId.localeCompare(right.runId))
    })
  }

  async getWriteAttempt(
    projectIdentityDigest: string,
    runId: string,
    attemptId: string,
  ): Promise<RuntimeWriteAttemptRecord | undefined> {
    const run = await this.getRun(projectIdentityDigest, runId)
    const record = run?.writeAttempts?.[attemptId]
    return record === undefined ? undefined : structuredClone(record)
  }

  /** 生产写恢复的只读门禁：完整复验 store/journal 后，拒绝仍有活跃 owner 的 attempt。 */
  async verifyWriteRecoveryReady(
    projectIdentityDigest: string,
    runId: string,
    attemptId: string,
  ): Promise<{ ok: boolean; summaryDigest: string; reasonCode?: string }> {
    return await this.#read((store) => {
      const key = runKey(projectIdentityDigest, runId)
      const current = store.runs[key]
      const attempt = current?.writeAttempts?.[attemptId]
      const execution = current?.executionAttempt
      const owner = store.leases[executionOwnerKey(key)]
      const ownerActive = owner !== undefined && Date.parse(owner.expiresAt) > this.#now().getTime()
      const bindingValid = current !== undefined && attempt !== undefined && execution !== undefined
        && current.workflow.current === 'running-real'
        && execution.attemptId === attemptId
        && execution.requestId === attempt.requestId
        && execution.fencingToken === attempt.executionFencingToken
      const reasonCode = ownerActive ? 'E2E_RUNTIME_EXECUTION_OWNER_ACTIVE'
        : !bindingValid ? 'E2E_RUNTIME_WRITE_RECOVERY_BINDING_INVALID' : undefined
      return {
        ok: reasonCode === undefined,
        summaryDigest: digestText('runtime-write-recovery-state/v1', canonicalizeJson({
          projectIdentityDigest, runId, attemptId,
          runRevision: current?.runRevision ?? null,
          writeRecordDigest: attempt?.recordDigest ?? null,
          executionAttempt: execution ?? null,
          owner: owner === undefined ? null : {
            fencingToken: owner.fencingToken, expiresAt: owner.expiresAt, active: ownerActive,
          },
        })),
        ...(reasonCode === undefined ? {} : { reasonCode }),
      }
    })
  }

  async prepareWriteAttempt(input: {
    projectIdentityDigest: string
    runId: string
    requestId: string
    requestDigest: string
    attemptId: string
    actionId: string
    lease: { leaseId: string; fencingToken: number; targetFingerprintDigest: string }
    executionFencingToken: number
    ownerMarker: RuntimeOwnedResourceMarker
    preparedAt: string
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      requirePendingRequest(store, input.requestId, input.requestDigest)
      const raw = store.runs[key]
      if (raw === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(raw)
      const marker = RuntimeOwnedResourceMarkerSchema.parse(input.ownerMarker)
      if (marker.projectIdentityDigest !== input.projectIdentityDigest
        || marker.runId !== input.runId
        || marker.attemptId !== input.attemptId
        || marker.runtimeInstallationDigest !== current.runtimeInstallationDigest) {
        throw runtimeStoreError('E2E_RUNTIME_WRITE_OWNER_MARKER_MISMATCH', 'Write owner marker 与 Run 不一致')
      }
      const writeAttempts = current.writeAttempts ?? {}
      const existing = writeAttempts[input.attemptId]
      const record = sealRuntimeWriteAttemptRecord({
        schemaVersion: '1.0.0', state: 'prepared',
        attemptId: input.attemptId, requestId: input.requestId, requestDigest: input.requestDigest,
        actionId: input.actionId, lease: structuredClone(input.lease),
        executionFencingToken: input.executionFencingToken,
        ownerMarker: marker, preparedAt: input.preparedAt, recordRevision: 1,
      })
      if (existing !== undefined) {
        if (canonicalizeJson(existing) === canonicalizeJson(record)) return structuredClone(existing)
        throw runtimeStoreError('E2E_RUNTIME_WRITE_ATTEMPT_ALREADY_EXISTS', 'Write attemptId 已绑定其他记录')
      }
      if (Object.keys(writeAttempts).length >= 1_024) throw runtimeStoreError(
        'E2E_RUNTIME_WRITE_ATTEMPT_CAPACITY_EXCEEDED', 'WriteAttempt 数量超过上限',
      )
      const updated = migrateRuntimeRunSnapshot({
        ...current, runRevision: (current.runRevision ?? 0) + 1,
        writeAttempts: { ...writeAttempts, [input.attemptId]: record },
        updatedAt: input.preparedAt,
      })
      store.runs[key] = updated
      appendRunSnapshotJournal(store, key, 'write-attempt-prepared', input.requestId)
      return structuredClone(record)
    })
  }

  async observeWriteReservation(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    reservationId: string
    observedAt: string
    expectedRecordDigest?: string
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['prepared'], next: (current) => sealRuntimeWriteAttemptRecord({
        ...withoutRecordDigest(current), state: 'reservation-observed',
        reservation: { reservationId: input.reservationId, observedAt: input.observedAt },
        recordRevision: current.recordRevision + 1,
      } as UnsealedRuntimeWriteAttemptRecord),
      eventKind: 'write-reservation-observed', timestamp: input.observedAt,
    })
  }

  async prepareWriteOutcome(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    outcomeDigest: string
    receiptDigest: string
    preparedAt: string
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['reservation-observed'], next: (current) => {
        if (current.state !== 'reservation-observed') throw writeTransitionError()
        return sealRuntimeWriteAttemptRecord({
          ...withoutRecordDigest(current), state: 'outcome-prepared',
          outcome: {
            outcomeDigest: input.outcomeDigest,
            receiptDigest: input.receiptDigest,
            preparedAt: input.preparedAt,
          },
          recordRevision: current.recordRevision + 1,
        } as UnsealedRuntimeWriteAttemptRecord)
      },
      eventKind: 'write-outcome-prepared', timestamp: input.preparedAt,
    })
  }

  /** verified cleanup 的 durable intent；必须先于 Authority Lease release 落盘。 */
  async prepareWriteCleanup(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    cleanupDigest: string
    preparedAt: string
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['prepared', 'reservation-observed', 'outcome-prepared'],
      next: (current) => {
        if (current.cleanupPrepared !== undefined) {
          if (current.cleanupPrepared.cleanupDigest === input.cleanupDigest) return current
          throw runtimeStoreError(
            'E2E_RUNTIME_WRITE_CLEANUP_CHECKPOINT_MISMATCH',
            'Cleanup checkpoint 已绑定其他摘要',
          )
        }
        return sealRuntimeWriteAttemptRecord({
          ...withoutRecordDigest(current),
          cleanupPrepared: { cleanupDigest: input.cleanupDigest, preparedAt: input.preparedAt },
          recordRevision: current.recordRevision + 1,
        } as UnsealedRuntimeWriteAttemptRecord)
      },
      eventKind: 'write-cleanup-prepared', timestamp: input.preparedAt,
      allowExactNoop: true,
    })
  }

  async commitWriteOutcome(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    outcomeDigest: string
    receiptDigest: string
    committedAt: string
    expectedRecordDigest?: string
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['outcome-prepared'], next: (current) => {
        if (current.state !== 'outcome-prepared'
          || current.outcome.outcomeDigest !== input.outcomeDigest
          || current.outcome.receiptDigest !== input.receiptDigest) throw runtimeStoreError(
          'E2E_RUNTIME_WRITE_OUTCOME_RECEIPT_MISMATCH', 'Authority outcome receipt 与 intent 不一致',
        )
        return sealRuntimeWriteAttemptRecord({
          ...withoutRecordDigest(current), state: 'outcome-committed',
          outcome: { ...current.outcome, committedAt: input.committedAt },
          recordRevision: current.recordRevision + 1,
        } as UnsealedRuntimeWriteAttemptRecord)
      },
      eventKind: 'write-outcome-committed', timestamp: input.committedAt,
    })
  }

  async markWriteEffectUnknown(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    reasonCode: string
    observedAt: string
    expectedRecordDigest?: string
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['prepared', 'reservation-observed', 'outcome-prepared'],
      next: (current) => sealRuntimeWriteAttemptRecord({
        ...withoutRecordDigest(current), state: 'effect-unknown',
        ...('reservation' in current ? { reservation: current.reservation } : {}),
        ...('outcome' in current ? { outcome: current.outcome } : {}),
        effectUnknown: { reasonCode: input.reasonCode, observedAt: input.observedAt },
        recordRevision: current.recordRevision + 1,
      } as UnsealedRuntimeWriteAttemptRecord),
      eventKind: 'write-effect-unknown', timestamp: input.observedAt,
    })
  }

  async recordRecoveryStep(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    step: string
    status: string
    summaryDigest: string
    expectedRecordDigest?: string
    expectedRunRevision?: number
    lock: RuntimeRunLock
  }): Promise<void> {
    await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      const current = store.runs[key]
      const attempt = current?.writeAttempts?.[input.attemptId]
      if (current === undefined || attempt === undefined) throw runtimeStoreError(
        'E2E_RUNTIME_WRITE_ATTEMPT_NOT_FOUND', 'WriteAttempt 不存在',
      )
      if ((input.expectedRecordDigest !== undefined && attempt.recordDigest !== input.expectedRecordDigest)
        || (input.expectedRunRevision !== undefined
          && (current.runRevision ?? 0) !== input.expectedRunRevision)) throw runtimeStoreError(
        'E2E_RUNTIME_RECOVERY_CAS_FAILED', 'Recovery 观察后的 Run/WriteAttempt 已改变',
      )
      appendRunRecoveryJournal(store, key, {
        kind: 'runtime-recovery-step', requestId: attempt.requestId,
        attemptId: input.attemptId, step: input.step, status: input.status,
        summaryDigest: input.summaryDigest,
      })
    })
  }

  async prepareWriteRecovery(input: {
    projectIdentityDigest: string; runId: string; attemptId: string
    markUnknownOperationId?: string; quarantineOperationId?: string; leaseTerminalOperationId?: string
    expectedRecordDigest: string; preparedAt: string; lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['prepared', 'reservation-observed', 'outcome-prepared', 'effect-unknown'],
      next: (current) => {
        const recovery = {
          schemaVersion: '1.0.0' as const,
          ...(input.markUnknownOperationId === undefined ? {} : {
            markUnknown: { operationId: input.markUnknownOperationId },
          }),
          ...(input.quarantineOperationId === undefined ? {} : {
            quarantine: { operationId: input.quarantineOperationId },
          }),
          ...(input.leaseTerminalOperationId === undefined ? {} : {
            leaseTerminal: { operationId: input.leaseTerminalOperationId },
          }),
        }
        if (current.recovery !== undefined) {
          if (current.recovery.quarantine?.operationId === input.quarantineOperationId
            && current.recovery.leaseTerminal?.operationId === input.leaseTerminalOperationId
            && current.recovery.markUnknown?.operationId === input.markUnknownOperationId) return current
          throw runtimeStoreError('E2E_RUNTIME_RECOVERY_OPERATION_MISMATCH', 'Recovery operationId 绑定已改变')
        }
        return sealRuntimeWriteAttemptRecord({ ...withoutRecordDigest(current), recovery,
          recordRevision: current.recordRevision + 1 } as UnsealedRuntimeWriteAttemptRecord)
      },
      eventKind: 'write-recovery-operations-prepared', timestamp: input.preparedAt,
      allowExactNoop: true,
    })
  }

  async recordWriteRecoveryReceipt(input: {
    projectIdentityDigest: string; runId: string; attemptId: string
    operation: 'markUnknown' | 'quarantine' | 'leaseTerminal'; operationId: string; receiptDigest: string
    expectedRecordDigest: string; recordedAt: string; lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#transitionWriteAttempt({
      ...input, expected: ['prepared', 'reservation-observed', 'outcome-prepared', 'effect-unknown'],
      next: (current) => {
        const operation = current.recovery?.[input.operation]
        if (operation?.operationId !== input.operationId) throw runtimeStoreError(
          'E2E_RUNTIME_RECOVERY_OPERATION_MISMATCH', 'Recovery receipt operationId 不匹配',
        )
        if (operation.receiptDigest !== undefined) {
          if (operation.receiptDigest === input.receiptDigest) return current
          throw runtimeStoreError('E2E_RUNTIME_RECOVERY_RECEIPT_MISMATCH', 'Recovery receipt 已绑定其他摘要')
        }
        return sealRuntimeWriteAttemptRecord({ ...withoutRecordDigest(current), recovery: {
          ...current.recovery!, [input.operation]: { ...operation, receiptDigest: input.receiptDigest },
        }, recordRevision: current.recordRevision + 1 } as UnsealedRuntimeWriteAttemptRecord)
      },
      eventKind: `write-recovery-${input.operation}-receipt`, timestamp: input.recordedAt,
      allowExactNoop: true,
    })
  }

  async blockWriteRecovery(input: {
    projectIdentityDigest: string; runId: string; attemptId: string
    expectedRecordDigest: string; expectedRunRevision: number
    reasonCode: string; terminalState: 'safety-blocked' | 'migration-required'
    blockedAt: string; lock: RuntimeRunLock
  }): Promise<RuntimeRunSnapshot> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      const raw = store.runs[key]
      if (raw === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(raw)
      const attempt = current.writeAttempts?.[input.attemptId]
      if (attempt === undefined) throw runtimeStoreError('E2E_RUNTIME_WRITE_ATTEMPT_NOT_FOUND', 'WriteAttempt 不存在')
      if (attempt.recordDigest !== input.expectedRecordDigest
        || (current.runRevision ?? 0) !== input.expectedRunRevision) throw runtimeStoreError(
        'E2E_RUNTIME_RECOVERY_CAS_FAILED', 'Recovery blocked 观察后的 Run/WriteAttempt 已改变',
      )
      const replay = completedReplay(store, attempt.requestId, attempt.requestDigest)
      if (replay.found) return structuredClone(current)
      requirePendingRequest(store, attempt.requestId, attempt.requestDigest)
      const terminalAttempt = attempt.state === 'outcome-committed' || attempt.state === 'effect-unknown'
        ? attempt : sealRuntimeWriteAttemptRecord({ ...withoutRecordDigest(attempt), state: 'effect-unknown',
          ...('reservation' in attempt ? { reservation: attempt.reservation } : {}),
          ...('outcome' in attempt ? { outcome: attempt.outcome } : {}),
          effectUnknown: { reasonCode: input.reasonCode, observedAt: input.blockedAt },
          recordRevision: attempt.recordRevision + 1 } as UnsealedRuntimeWriteAttemptRecord)
      const response = {
        schemaVersion: '1.0.0', requestId: attempt.requestId,
        runtime: { version: 'runtime-recovery/1', installationDigest: current.runtimeInstallationDigest },
        ok: false, error: { code: input.reasonCode,
          category: input.terminalState === 'migration-required' ? 'migration' : 'safety',
          terminalState: input.terminalState, message: 'Runtime recovery 已持久阻断该写尝试',
          retryable: false, resumeState: input.terminalState },
      }
      const {
        pendingDecision: _pendingDecision,
        executionAttempt: _executionAttempt,
        ...withoutPendingDecision
      } = current
      const blocked = migrateRuntimeRunSnapshot({ ...withoutPendingDecision,
        runRevision: (current.runRevision ?? 0) + 1,
        workflow: recoveryTerminalWorkflow(current.workflow, input.terminalState, input.reasonCode, input.blockedAt),
        writeAttempts: { ...current.writeAttempts, [input.attemptId]: terminalAttempt },
        requestResponses: { ...current.requestResponses,
          [attempt.requestId]: { requestDigest: attempt.requestDigest, response } },
        updatedAt: input.blockedAt,
      })
      store.runs[key] = blocked
      delete store.leases[executionOwnerKey(key)]
      const outcome = appendRunSnapshotJournal(store, key, 'runtime-recovery-blocked', attempt.requestId)
      completeGlobalLedger(store.globalLedger, attempt.requestId, attempt.requestDigest, response, outcome)
      return structuredClone(blocked)
    })
  }

  async recordPreflightPreparation(input: {
    projectIdentityDigest: string
    runId: string
    requestId: string
    requestDigest: string
    startedAt: string
    preparation: unknown
    expectedRevision: number
    expectedWorkflowDigest: string
    lock: RuntimeRunLock
  }): Promise<RuntimeRunSnapshot> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      requirePendingRequest(store, input.requestId, input.requestDigest)
      const existing = store.runs[key]
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(existing)
      if (current.preflightAttempt !== undefined) throw runtimeStoreError(
        'E2E_RUNTIME_PREFLIGHT_ALREADY_PREPARED', 'Run 已有持久化 preflight preparation',
      )
      if ((current.runRevision ?? 0) !== input.expectedRevision
        || current.workflow.eventChainDigest !== input.expectedWorkflowDigest
        || (current.workflow.current !== 'discovery-approved'
          && !(current.workflow.current === 'preflight-readonly'
            && current.preflightBlocker !== undefined))) throw runtimeStoreError(
          'E2E_RUNTIME_PREFLIGHT_FENCED', 'preflight preparation 已陈旧，拒绝持久化',
        )
      const revision = (current.runRevision ?? 0) + 1
      const prepared = migrateRuntimeRunSnapshot({
        ...current,
        runRevision: revision,
        preflightAttempt: {
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          revision,
          startedAt: input.startedAt,
          preparation: structuredClone(input.preparation),
        },
        updatedAt: input.startedAt,
      })
      store.runs[key] = prepared
      appendRunSnapshotJournal(store, key, 'trusted-browser-preflight-prepared', input.requestId)
      return structuredClone(prepared)
    })
  }

  async recordFinalizationAttempt(input: {
    projectIdentityDigest: string
    runId: string
    requestId: string
    requestDigest: string
    attemptId: string
    startedAt: string
    expectedRevision: number
    expectedWorkflowDigest: string
    finalizationMaterial?: unknown
    toFinalizing(snapshot: RuntimeRunSnapshot): RuntimeRunSnapshot
    lock: RuntimeRunLock
  }): Promise<RuntimeRunSnapshot> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      requirePendingRequest(store, input.requestId, input.requestDigest)
      const existing = store.runs[key]
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(existing)
      if (current.finalizationAttempt !== undefined) throw runtimeStoreError(
        'E2E_RUNTIME_FINALIZATION_ALREADY_STARTED', 'Run 已有持久 finalization attempt',
      )
      if ((current.runRevision ?? 0) !== input.expectedRevision
        || current.workflow.eventChainDigest !== input.expectedWorkflowDigest
        || current.workflow.current !== 'diagnosing') throw runtimeStoreError(
        'E2E_RUNTIME_FINALIZATION_FENCED', 'finalization attempt 已陈旧，拒绝持久化',
      )
      const revision = (current.runRevision ?? 0) + 1
      const prepared = migrateRuntimeRunSnapshot({
        ...input.toFinalizing(current),
        ...(input.finalizationMaterial === undefined ? {} : {
          trustedExecutionFacts: {
            ...current.trustedExecutionFacts,
            'finalization-material': structuredClone(input.finalizationMaterial),
          },
        }),
        runRevision: revision,
        finalizationAttempt: {
          attemptId: input.attemptId,
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          revision,
          startedAt: input.startedAt,
        },
        updatedAt: input.startedAt,
      })
      store.runs[key] = prepared
      appendRunSnapshotJournal(store, key, 'trusted-finalization-prepared', input.requestId)
      return structuredClone(prepared)
    })
  }

  async beginExecutionAttempt(input: {
    projectIdentityDigest: string
    runId: string
    requestId: string
    requestDigest: string
    startedAt: string
    toRunning(snapshot: RuntimeRunSnapshot): RuntimeRunSnapshot
    lock: RuntimeRunLock
  }): Promise<{ snapshot: RuntimeRunSnapshot; attempt: RuntimeExecutionAttempt; owner: RuntimeExecutionOwner }> {
    let ownerClaim!: { key: string; ownerNonce: string; fencingToken: number }
    const started = await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      requirePendingRequest(store, input.requestId, input.requestDigest)
      const existing = store.runs[key]
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(existing)
      if (current.executionAttempt !== undefined) throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_ALREADY_STARTED', 'Run 已有持久化 execution attempt，禁止重复执行',
      )
      const claim = this.#lockClaims.get(input.lock)!
      const ownerKey = executionOwnerKey(key)
      const existingOwner = store.leases[ownerKey]
      const now = this.#now()
      if (existingOwner !== undefined && Date.parse(existingOwner.expiresAt) > now.getTime()) {
        throw runtimeStoreError('E2E_RUNTIME_EXECUTION_OWNER_ACTIVE', 'Run 已有活跃 execution owner')
      }
      ownerClaim = {
        key: ownerKey,
        ownerNonce: `${this.#processNonce}:execution:${randomUUID()}`,
        fencingToken: (existingOwner?.fencingToken ?? 0) + 1,
      }
      store.leases[ownerKey] = {
        ownerNonce: ownerClaim.ownerNonce,
        fencingToken: ownerClaim.fencingToken,
        expiresAt: new Date(now.getTime() + this.#leaseMilliseconds).toISOString(),
      }
      const revision = (current.runRevision ?? 0) + 1
      const attempt: RuntimeExecutionAttempt = {
        attemptId: `ATTEMPT-${randomUUID()}`,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        fencingToken: claim.fencingToken,
        revision,
        startedAt: input.startedAt,
      }
      const running = migrateRuntimeRunSnapshot({
        ...input.toRunning(current), runRevision: revision, executionAttempt: attempt,
      })
      if (running.workflow.current !== 'running-real') throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_START_STATE_INVALID', '执行开始必须原子进入 running-real',
      )
      store.runs[key] = running
      appendRunSnapshotJournal(store, key, 'trusted-read-execution-started', input.requestId)
      return { snapshot: structuredClone(running), attempt: structuredClone(attempt) }
    })
    const owner = Object.freeze({
      heartbeatIntervalMs: Math.max(10, Math.floor(this.#leaseMilliseconds / 3)),
      renew: async () => await this.#renewExecutionOwner(owner),
      release: async () => await this.#releaseExecutionOwner(owner),
    }) as RuntimeExecutionOwner
    executionOwnerClaims.set(owner, { store: this, ...ownerClaim, released: false })
    return { ...started, owner }
  }

  async completeExecutionAttempt(input: {
    projectIdentityDigest: string
    runId: string
    requestId: string
    requestDigest: string
    attempt: RuntimeExecutionAttempt
    owner: RuntimeExecutionOwner
    response: unknown
    complete(snapshot: RuntimeRunSnapshot): RuntimeRunSnapshot
    lock: RuntimeRunLock
  }): Promise<unknown> {
    const response = await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      this.#requireExecutionOwner(store, executionOwnerKey(key), input.owner)
      const replay = completedReplay(store, input.requestId, input.requestDigest)
      if (replay.found) return replay.response
      requirePendingRequest(store, input.requestId, input.requestDigest)
      const existing = store.runs[key]
      if (existing === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(existing)
      const durableWrite = current.writeAttempts?.[input.attempt.attemptId]
      const writeAdvanced = durableWrite?.state === 'outcome-committed'
        && durableWrite.requestId === input.requestId
        && durableWrite.requestDigest === input.requestDigest
        && durableWrite.executionFencingToken === input.attempt.fencingToken
      const multiCaseAdvanced = current.caseSchedule?.status === 'terminal'
        && current.caseSchedule.cases.every((item) =>
          ['passed', 'failed', 'unable', 'safety-blocked'].includes(item.state))
        && current.caseSchedule.cases.every((item) => {
          if (item.attemptId === undefined) return item.state === 'unable'
          const attempt = current.writeAttempts?.[item.attemptId]
          return attempt !== undefined
            && attempt.requestId === input.requestId
            && attempt.requestDigest === input.requestDigest
            && attempt.executionFencingToken === input.attempt.fencingToken
            && (attempt.state === 'outcome-committed' || attempt.state === 'effect-unknown')
        })
      if (canonicalizeJson(current.executionAttempt) !== canonicalizeJson(input.attempt)
        || ((current.runRevision ?? 0) !== input.attempt.revision && !writeAdvanced && !multiCaseAdvanced)
        || current.workflow.current !== 'running-real') throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_ATTEMPT_FENCED', 'execution attempt/revision 已改变，拒绝陈旧结果',
      )
      const completion = input.complete(current)
      const { executionAttempt: _completedAttempt, ...withoutAttempt } = completion
      const completed = migrateRuntimeRunSnapshot({
        ...withoutAttempt,
        runRevision: (current.runRevision ?? 0) + 1,
        requestResponses: {
          ...current.requestResponses,
          [input.requestId]: { requestDigest: input.requestDigest, response: input.response },
        },
      })
      if (completed.workflow.current === 'running-real') throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_COMPLETION_STATE_INVALID', '执行完成不得停留 running-real',
      )
      store.runs[key] = completed
      const runOutcome = appendRunSnapshotJournal(
        store, key, 'trusted-read-execution-completed', input.requestId,
      )
      completeGlobalLedger(
        store.globalLedger, input.requestId, input.requestDigest, input.response, runOutcome,
      )
      delete store.leases[executionOwnerKey(key)]
      return structuredClone(input.response)
    })
    const ownerClaim = executionOwnerClaims.get(input.owner)
    if (ownerClaim?.store === this) ownerClaim.released = true
    return response
  }

  async resumeExecutionAttempt(input: {
    projectIdentityDigest: string
    runId: string
    expectedAttemptId: string
    lock: RuntimeRunLock
  }): Promise<{
    snapshot: RuntimeRunSnapshot
    attempt: RuntimeExecutionAttempt
    owner: RuntimeExecutionOwner
  }> {
    let ownerClaim!: { key: string; ownerNonce: string; fencingToken: number }
    const resumed = await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      const raw = store.runs[key]
      if (raw === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(raw)
      const attempt = current.executionAttempt
      if (current.workflow.current !== 'running-real' || attempt === undefined
        || attempt.attemptId !== input.expectedAttemptId) throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_RESUME_MISMATCH',
        '只允许恢复当前完全匹配的 running-real execution attempt',
      )
      const ownerKey = executionOwnerKey(key)
      const existingOwner = store.leases[ownerKey]
      const now = this.#now()
      if (existingOwner !== undefined && Date.parse(existingOwner.expiresAt) > now.getTime()) {
        throw runtimeStoreError('E2E_RUNTIME_EXECUTION_OWNER_ACTIVE', 'Run 仍有活跃 execution owner')
      }
      ownerClaim = {
        key: ownerKey,
        ownerNonce: `${this.#processNonce}:execution-resume:${randomUUID()}`,
        fencingToken: (existingOwner?.fencingToken ?? 0) + 1,
      }
      store.leases[ownerKey] = {
        ownerNonce: ownerClaim.ownerNonce,
        fencingToken: ownerClaim.fencingToken,
        expiresAt: new Date(now.getTime() + this.#leaseMilliseconds).toISOString(),
      }
      appendRunSnapshotJournal(store, key, 'trusted-execution-resumed', attempt.requestId)
      return { snapshot: structuredClone(current), attempt: structuredClone(attempt) }
    })
    const owner = Object.freeze({
      heartbeatIntervalMs: Math.max(10, Math.floor(this.#leaseMilliseconds / 3)),
      renew: async () => await this.#renewExecutionOwner(owner),
      release: async () => await this.#releaseExecutionOwner(owner),
    }) as RuntimeExecutionOwner
    executionOwnerClaims.set(owner, { store: this, ...ownerClaim, released: false })
    return { ...resumed, owner }
  }

  async checkpointCaseSchedule(input: {
    projectIdentityDigest: string
    runId: string
    attempt: RuntimeExecutionAttempt
    owner: RuntimeExecutionOwner
    schedule: RuntimeCaseSchedule
    eventKind: 'multi-case-started' | 'multi-case-completed'
    updatedAt: string
    update?(snapshot: RuntimeRunSnapshot): RuntimeRunSnapshot
    lock: RuntimeRunLock
  }): Promise<RuntimeRunSnapshot> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      this.#requireExecutionOwner(store, executionOwnerKey(key), input.owner)
      const raw = store.runs[key]
      if (raw === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const current = migrateRuntimeRunSnapshot(raw)
      if (canonicalizeJson(current.executionAttempt) !== canonicalizeJson(input.attempt)
        || current.workflow.current !== 'running-real') throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_ATTEMPT_FENCED',
        'Case schedule checkpoint 未绑定当前 running execution attempt',
      )
      const schedule = parseCaseSchedule(input.schedule)
      if (current.compiledPrdRun !== undefined
        && schedule.compilerDigest !== current.compiledPrdRun.compilerDigest) throw runtimeStoreError(
        'E2E_RUNTIME_CASE_SCHEDULE_BINDING_INVALID',
        'Case schedule 与编译计划摘要不一致',
      )
      const updated = input.update?.(current) ?? current
      const persisted = migrateRuntimeRunSnapshot({
        ...updated,
        runRevision: (current.runRevision ?? 0) + 1,
        caseSchedule: schedule,
        updatedAt: input.updatedAt,
      })
      store.runs[key] = persisted
      appendRunSnapshotJournal(store, key, input.eventKind, input.attempt.requestId)
      return structuredClone(persisted)
    })
  }

  async authorizeTrustedFactWrite(
    projectIdentityDigest: string,
    runId: string,
    lock: RuntimeRunLock,
  ): Promise<RuntimeTrustedFactCapability> {
    const snapshot = await this.getRun(projectIdentityDigest, runId)
    if (snapshot === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
    const capability = Object.freeze({}) as RuntimeTrustedFactCapability
    trustedFactCapabilities.set(capability, {
      store: this, projectIdentityDigest, runId, lock,
      runRevision: snapshot.runRevision ?? 0,
      snapshotDigest: runtimeRunSnapshotDigest(snapshot),
      used: false,
    })
    return capability
  }

  async writeTrustedFactOutcome(input: {
    capability: RuntimeTrustedFactCapability
    requestId: string
    requestDigest: string
    factType: 'signed-discovery-grant' | 'signed-execution-grant' | 'browser-preflight'
      | 'finalization-material' | 'finalization-execution-facts'
      | 'quarantined-evidence'
    fact: unknown
    response: unknown
    update?(snapshot: RuntimeRunSnapshot): RuntimeRunSnapshot
  }): Promise<unknown> {
    const record = trustedFactCapabilities.get(input.capability)
    if (!record || record.store !== this || record.used) throw runtimeStoreError(
      'E2E_RUNTIME_TRUSTED_FACT_CAPABILITY_INVALID', '可信事实 capability 伪造、跨 Store 或已消费',
    )
    record.used = true
    try {
      return await this.updateRunOutcome(
        record.projectIdentityDigest, record.runId, input.requestId, input.requestDigest,
        (snapshot) => {
          if ((snapshot.runRevision ?? 0) !== record.runRevision
            || runtimeRunSnapshotDigest(snapshot) !== record.snapshotDigest) throw runtimeStoreError(
            'E2E_RUNTIME_TRUSTED_FACT_CAPABILITY_STALE',
            '可信事实 capability 的 Run revision/snapshot 已改变',
          )
          const updated = input.update?.(snapshot) ?? snapshot
          return { snapshot: {
            ...updated,
            runRevision: (snapshot.runRevision ?? 0) + 1,
            trustedExecutionFacts: {
              ...updated.trustedExecutionFacts,
              [input.factType]: structuredClone(input.fact),
            },
          },
          response: input.response }
        },
        'trusted-execution-fact-recorded', record.lock,
      )
    } catch (error) {
      record.used = false
      throw error
    }
  }

  async appendTrustedManualResultOutcome(input: {
    capability: RuntimeTrustedFactCapability
    requestId: string
    requestDigest: string
    result: ManualResult
    response: unknown
    update?: (snapshot: RuntimeRunSnapshot) => RuntimeRunSnapshot
  }): Promise<unknown> {
    const record = trustedFactCapabilities.get(input.capability)
    if (!record || record.store !== this || record.used) throw runtimeStoreError(
      'E2E_RUNTIME_TRUSTED_FACT_CAPABILITY_INVALID', '可信事实 capability 伪造、跨 Store 或已消费',
    )
    record.used = true
    try {
      return await this.updateRunOutcome(
        record.projectIdentityDigest, record.runId, input.requestId, input.requestDigest,
        (snapshot) => {
          if ((snapshot.runRevision ?? 0) !== record.runRevision
            || runtimeRunSnapshotDigest(snapshot) !== record.snapshotDigest) throw runtimeStoreError(
            'E2E_RUNTIME_TRUSTED_FACT_CAPABILITY_STALE',
            '可信事实 capability 的 Run revision/snapshot 已改变',
          )
          const result = bindManualResultToRuntimeSnapshot(snapshot, input.result, this.#now())
          const raw = snapshot.trustedExecutionFacts['manual-results-by-id']
          const existing = raw === undefined ? {} : structuredClone(raw) as Record<string, ManualResult>
          if (Object.prototype.hasOwnProperty.call(existing, result.manualResultId)) {
            throw runtimeStoreError(
              'E2E_RUNTIME_MANUAL_RESULT_DUPLICATE',
              'ManualResultId 已进入不可变可信集合；禁止覆盖或以新 request 重放',
            )
          }
          if (Object.keys(existing).length >= MAX_TRUSTED_MANUAL_RESULTS) throw runtimeStoreError(
            'E2E_RUNTIME_MANUAL_RESULT_CAPACITY_EXCEEDED', '可信 ManualResult 集合超过容量上限',
          )
          const updated = {
              ...snapshot,
              runRevision: (snapshot.runRevision ?? 0) + 1,
              trustedExecutionFacts: {
                ...snapshot.trustedExecutionFacts,
                'manual-results-by-id': { ...existing, [result.manualResultId]: result },
              },
            }
          return {
            snapshot: input.update === undefined ? updated : input.update(updated),
            response: input.response,
          }
        },
        'trusted-manual-result-recorded', record.lock,
      )
    } catch (error) {
      record.used = false
      throw error
    }
  }

  async acquireRunLock(projectIdentityDigest: string, runId: string): Promise<RuntimeRunLock> {
    const key = runKey(projectIdentityDigest, runId)
    let claim!: LeaseClaim
    await this.#mutate((snapshot) => {
      verifyStoreSnapshot(snapshot)
      const existing = snapshot.leases[key]
      const now = this.#now()
      if (existing !== undefined && Date.parse(existing.expiresAt) > now.getTime()) {
        throw runtimeStoreError('E2E_RUNTIME_RUN_LOCKED', 'Run 正由 mutation owner 持有')
      }
      claim = {
        key,
        ownerNonce: `${this.#processNonce}:${randomUUID()}`,
        fencingToken: (existing?.fencingToken ?? 0) + 1,
      }
      snapshot.leases[key] = {
        ownerNonce: claim.ownerNonce,
        fencingToken: claim.fencingToken,
        expiresAt: new Date(now.getTime() + this.#leaseMilliseconds).toISOString(),
      }
    })
    let closed = false
    const lock: RuntimeRunLock = {
      close: async () => {
        if (closed) return
        await this.#mutate((snapshot) => {
          verifyStoreSnapshot(snapshot)
          const existing = snapshot.leases[key]
          if (existing?.ownerNonce === claim.ownerNonce
            && existing.fencingToken === claim.fencingToken) {
            existing.expiresAt = this.#now().toISOString()
          }
        })
        this.#lockClaims.delete(lock)
        closed = true
      },
    }
    this.#lockClaims.set(lock, claim)
    return lock
  }

  async authorizeSecretRetirement(
    projectIdentityDigest: string,
    runId: string,
    lock: RuntimeRunLock,
  ): Promise<RuntimeSecretRetirementCapability> {
    const key = runKey(projectIdentityDigest, runId)
    let revision!: number
    let snapshotDigest!: string
    await this.#snapshotStore.runExclusive(async () => {
      const transaction = this.#snapshotStore.beginVersioned()
      try {
        const snapshot = parseStoreSnapshot(transaction.snapshot)
        verifyStoreSnapshot(snapshot)
        this.#requireCurrentLease(snapshot, key, lock)
        const run = snapshot.runs[key]
        if (run === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
        if (!TERMINAL_SECRET_RETIREMENT_STATES.has(run.workflow.current)) {
          throw runtimeStoreError(
            'E2E_SECRET_RETIREMENT_RUN_NOT_TERMINAL',
            '只有不可恢复的终态 Run 才能退役 secret tombstone',
          )
        }
        revision = transaction.revision
        snapshotDigest = runtimeRunSnapshotDigest(run)
        this.#snapshotStore.rollback()
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
    const capability = Object.freeze({}) as RuntimeSecretRetirementCapability
    retirementCapabilities.set(capability, {
      projectIdentityDigest,
      runId,
      state: 'available',
      execute: async <T>(operation: () => Promise<T>) => await this.#executeSecretRetirement({
        projectIdentityDigest, runId, key, lock, revision, snapshotDigest,
      }, operation),
    })
    return capability
  }

  /**
   * 固定以 RunStore→SecretStore 锁序执行秘密操作。BEGIN IMMEDIATE 在 callback 完成前
   * 阻止 Run 进入终态；两个 SQLite 库不是同一事务，callback 必须自身原子且失败回滚。
   */
  async withActiveSecretRun<T>(
    projectIdentityDigest: string,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = runKey(projectIdentityDigest, runId)
    return await this.#snapshotStore.runExclusive(async () => {
      const transaction = this.#snapshotStore.beginVersioned()
      try {
        const snapshot = parseStoreSnapshot(transaction.snapshot)
        verifyStoreSnapshot(snapshot)
        const run = snapshot.runs[key]
        if (run === undefined) {
          throw runtimeStoreError('E2E_SECRET_RUN_NOT_FOUND', 'Secret 操作必须绑定已存在的 Run')
        }
        if (TERMINAL_SECRET_RETIREMENT_STATES.has(run.workflow.current)) {
          throw runtimeStoreError('E2E_SECRET_RUN_TERMINAL', '终态 Run 禁止写入或读取 Secret')
        }
        const result = await operation()
        this.#snapshotStore.rollback()
        return result
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }

  async #transitionWriteAttempt(input: {
    projectIdentityDigest: string
    runId: string
    attemptId: string
    expected: RuntimeWriteAttemptState[]
    next(current: RuntimeWriteAttemptRecord): RuntimeWriteAttemptRecord
    eventKind: string
    timestamp: string
    expectedRecordDigest?: string
    allowExactNoop?: boolean
    lock: RuntimeRunLock
  }): Promise<RuntimeWriteAttemptRecord> {
    return await this.#mutate((store) => {
      verifyStoreSnapshot(store)
      const key = runKey(input.projectIdentityDigest, input.runId)
      this.#requireCurrentLease(store, key, input.lock)
      const raw = store.runs[key]
      if (raw === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
      const currentRun = migrateRuntimeRunSnapshot(raw)
      const writeAttempts = currentRun.writeAttempts ?? {}
      const current = writeAttempts[input.attemptId]
      if (current === undefined) throw runtimeStoreError(
        'E2E_RUNTIME_WRITE_ATTEMPT_NOT_FOUND', 'WriteAttempt 不存在',
      )
      requirePendingRequest(store, current.requestId, current.requestDigest)
      if (input.expectedRecordDigest !== undefined && current.recordDigest !== input.expectedRecordDigest) {
        throw runtimeStoreError('E2E_RUNTIME_RECOVERY_CAS_FAILED', 'Recovery 观察后的 WriteAttempt 已改变')
      }
      if (!input.expected.includes(current.state)) throw writeTransitionError()
      const next = parseRuntimeWriteAttemptRecord(input.next(structuredClone(current)))
      if (input.allowExactNoop && canonicalizeJson(next) === canonicalizeJson(current)) return structuredClone(current)
      if (next.attemptId !== current.attemptId
        || next.requestId !== current.requestId
        || next.requestDigest !== current.requestDigest
        || next.actionId !== current.actionId
        || canonicalizeJson(next.lease) !== canonicalizeJson(current.lease)
        || next.executionFencingToken !== current.executionFencingToken
        || canonicalizeJson(next.ownerMarker) !== canonicalizeJson(current.ownerMarker)
        || next.recordRevision !== current.recordRevision + 1) throw runtimeStoreError(
        'E2E_RUNTIME_WRITE_ATTEMPT_REBIND_FORBIDDEN', 'WriteAttempt transition 改变了不可变绑定',
      )
      const updated = migrateRuntimeRunSnapshot({
        ...currentRun, runRevision: (currentRun.runRevision ?? 0) + 1,
        writeAttempts: { ...writeAttempts, [input.attemptId]: next },
        updatedAt: input.timestamp,
      })
      store.runs[key] = updated
      appendRunSnapshotJournal(store, key, input.eventKind, current.requestId)
      return structuredClone(next)
    })
  }

  #requireCurrentLease(snapshot: RunStoreSnapshot, key: string, lock: RuntimeRunLock): void {
    const claim = this.#lockClaims.get(lock)
    const persisted = snapshot.leases[key]
    if (claim?.key !== key) {
      throw runtimeStoreError(
        'E2E_RUNTIME_RUN_LOCKED',
        'Run mutation lock 已释放、无效或不属于当前 Store',
      )
    }
    if (persisted?.ownerNonce !== claim.ownerNonce
      || persisted.fencingToken !== claim.fencingToken
      || Date.parse(persisted.expiresAt) <= this.#now().getTime()) {
      throw runtimeStoreError(
        'E2E_RUNTIME_RUN_LEASE_FENCED',
        'Run mutation 必须持有当前未过期的 persisted lease owner 与 fencing token',
      )
    }
  }

  #requireExecutionOwner(snapshot: RunStoreSnapshot, key: string, owner: RuntimeExecutionOwner): void {
    const claim = executionOwnerClaims.get(owner)
    const persisted = snapshot.leases[key]
    if (claim?.store !== this || claim.key !== key || claim.released
      || persisted?.ownerNonce !== claim.ownerNonce
      || persisted.fencingToken !== claim.fencingToken
      || Date.parse(persisted.expiresAt) <= this.#now().getTime()) {
      throw runtimeStoreError('E2E_RUNTIME_EXECUTION_OWNER_FENCED', 'execution owner lease 已失效')
    }
  }

  async #renewExecutionOwner(owner: RuntimeExecutionOwner): Promise<void> {
    await this.#mutate((snapshot) => {
      const claim = executionOwnerClaims.get(owner)
      if (claim?.store !== this) throw runtimeStoreError(
        'E2E_RUNTIME_EXECUTION_OWNER_FENCED', 'execution owner capability 无效',
      )
      this.#requireExecutionOwner(snapshot, claim.key, owner)
      snapshot.leases[claim.key]!.expiresAt = new Date(
        this.#now().getTime() + this.#leaseMilliseconds,
      ).toISOString()
    })
  }

  async #releaseExecutionOwner(owner: RuntimeExecutionOwner): Promise<void> {
    const claim = executionOwnerClaims.get(owner)
    if (claim?.store !== this || claim.released) return
    await this.#mutate((snapshot) => {
      const persisted = snapshot.leases[claim.key]
      if (persisted?.ownerNonce === claim.ownerNonce
        && persisted.fencingToken === claim.fencingToken) delete snapshot.leases[claim.key]
    })
    claim.released = true
  }

  async #executeSecretRetirement<T>(input: {
    projectIdentityDigest: string
    runId: string
    key: string
    lock: RuntimeRunLock
    revision: number
    snapshotDigest: string
  }, operation: () => Promise<T>): Promise<T> {
    return await this.#snapshotStore.runExclusive(async () => {
      const transaction = this.#snapshotStore.beginVersioned()
      try {
        if (transaction.revision !== input.revision) {
          throw runtimeStoreError(
            'E2E_SECRET_RETIREMENT_CAPABILITY_STALE',
            'Run Store revision 已改变，必须重新授权退役',
          )
        }
        const snapshot = parseStoreSnapshot(transaction.snapshot)
        verifyStoreSnapshot(snapshot)
        this.#requireCurrentLease(snapshot, input.key, input.lock)
        const run = snapshot.runs[input.key]
        if (run === undefined
          || run.projectIdentityDigest !== input.projectIdentityDigest
          || run.runId !== input.runId
          || !TERMINAL_SECRET_RETIREMENT_STATES.has(run.workflow.current)
          || runtimeRunSnapshotDigest(run) !== input.snapshotDigest) {
          throw runtimeStoreError(
            'E2E_SECRET_RETIREMENT_CAPABILITY_STALE',
            'Run 终态或 snapshot 已改变，必须重新授权退役',
          )
        }
        const result = await operation()
        this.#snapshotStore.rollback()
        return result
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }

  async #verifyPersistedState(): Promise<void> {
    await this.#read((snapshot) => { verifyStoreSnapshot(snapshot) })
  }

  async #migratePersistedState(): Promise<void> {
    await this.#snapshotStore.runExclusive(async () => {
      const serialized = this.#snapshotStore.begin()
      try {
        const snapshot = parseStoreSnapshot(serialized)
        let changed = false
        for (const [key, raw] of Object.entries(snapshot.runs)) {
          if (isPlainRecord(raw) && raw.schemaVersion === '1.8.0') continue
          const rows = snapshot.journals[key]
          if (!Array.isArray(rows) || rows.length === 0) {
            throw journalIntegrityError('legacy Run 缺少可验证 journal，拒绝迁移')
          }
          verifyJournalRows(rows)
          const legacyDigest = runtimeRunSnapshotDigest(raw)
          if (rows.at(-1)?.event.digest !== legacyDigest) {
            throw journalIntegrityError('legacy Run snapshot 与迁移前 journal tail 不闭合')
          }
          const migrated = migrateRuntimeRunSnapshot(raw)
          if (key !== runKey(migrated.projectIdentityDigest, migrated.runId)) {
            throw journalIntegrityError('legacy Run snapshot key 与持久身份不一致')
          }
          snapshot.runs[key] = migrated
          appendJournalRow(rows, {
            kind: 'runtime-state-migrated',
            fromSchemaVersion: isPlainRecord(raw) && typeof raw.schemaVersion === 'string'
              ? raw.schemaVersion : 'missing',
            toSchemaVersion: migrated.schemaVersion,
            digest: runtimeRunSnapshotDigest(migrated),
          })
          changed = true
        }
        if (!changed) {
          this.#snapshotStore.rollback()
          return
        }
        verifyStoreSnapshot(snapshot)
        this.#snapshotStore.commit(canonicalizeJson(snapshot))
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }

  async reconcileExecutionAttempt(input: {
    projectIdentityDigest: string
    runId: string
    expectedAttemptId: string
    reconcileRequestId: string
    reconcileRequestDigest: string
    runtimeVersion: string
    installationDigest: string
    lock: RuntimeRunLock
  }): Promise<{ attemptId: string; response: unknown }> {
    return await this.#snapshotStore.runExclusive(async () => {
      const serialized = this.#snapshotStore.begin()
      try {
        const snapshot = parseStoreSnapshot(serialized)
        verifyStoreSnapshot(snapshot)
        const now = this.#now()
        const key = runKey(input.projectIdentityDigest, input.runId)
        this.#requireCurrentLease(snapshot, key, input.lock)
        const replay = completedReplay(
          snapshot, input.reconcileRequestId, input.reconcileRequestDigest,
        )
        if (replay.found) {
          const response = requireExecutionReconcileReplay(replay.response, input)
          this.#snapshotStore.rollback()
          return { attemptId: input.expectedAttemptId, response }
        }
        const executionOwner = snapshot.leases[executionOwnerKey(key)]
        if (executionOwner !== undefined && Date.parse(executionOwner.expiresAt) > now.getTime()) {
          throw runtimeStoreError(
            'E2E_RUNTIME_EXECUTION_OWNER_ACTIVE',
            '活跃 execution owner 仍在执行，拒绝提前 reconcile',
          )
        }
        delete snapshot.leases[executionOwnerKey(key)]
        const current = snapshot.runs[key]
        const attempt = current?.executionAttempt
        if (current === undefined) throw runtimeStoreError('E2E_RUNTIME_RUN_NOT_FOUND', 'Run 不存在')
        if (current.workflow.current !== 'running-real' || attempt === undefined
          || attempt.attemptId !== input.expectedAttemptId) throw runtimeStoreError(
          'E2E_RUNTIME_EXECUTION_RECONCILE_MISMATCH',
          '只允许显式关闭目标 Run 当前完全匹配的 running-real attempt',
        )
        if (current.runtimeInstallationDigest !== input.installationDigest) throw runtimeStoreError(
          'E2E_RUNTIME_INSTALLATION_BINDING_MISMATCH', '恢复 Host 与 Run installation 不一致',
        )
        const requestDigest = requirePendingRequestDigest(snapshot, attempt.requestId)
        requirePendingRequest(snapshot, input.reconcileRequestId, input.reconcileRequestDigest)
        const executionResponse = {
          schemaVersion: '1.0.0', requestId: attempt.requestId,
          runtime: { version: input.runtimeVersion, installationDigest: input.installationDigest },
          ok: false,
          error: {
            code: 'E2E_RUNTIME_EXECUTION_ATTEMPT_STALE', category: 'safety',
            terminalState: 'safety-blocked',
            message: '上次只读执行在完成前中断；Runtime 已禁止自动重试并关闭该 attempt',
            retryable: false, resumeState: 'safety-blocked',
            details: {
              attemptId: attempt.attemptId, fencingToken: attempt.fencingToken,
              revision: attempt.revision, startedAt: attempt.startedAt, reconciledAt: now.toISOString(),
            },
          },
        }
        const reconcileResponse = {
          schemaVersion: '1.0.0', requestId: input.reconcileRequestId,
          runtime: { version: input.runtimeVersion, installationDigest: input.installationDigest },
          ok: true,
          result: { runId: input.runId, reconciledAttemptId: attempt.attemptId, status: 'safety-blocked' },
        }
        const { executionAttempt: _staleAttempt, ...withoutAttempt } = current
        const recovered = migrateRuntimeRunSnapshot({
          ...withoutAttempt,
          runRevision: (current.runRevision ?? 0) + 1,
          workflow: transitionWorkflow({
            state: current.workflow, next: 'safety-blocked',
            reason: `stale execution attempt reconciled:${attempt.attemptId}`,
            timestamp: now.toISOString(), engineVersion: 'runtime-store-recovery/1',
          }).state,
          updatedAt: now.toISOString(),
          requestResponses: {
            ...current.requestResponses,
            [attempt.requestId]: {
              requestDigest,
              response: executionResponse,
            },
            [input.reconcileRequestId]: {
              requestDigest: input.reconcileRequestDigest,
              response: reconcileResponse,
            },
          },
        })
        snapshot.runs[key] = recovered
        const executionRunOutcome = appendRunSnapshotJournal(
          snapshot, key, 'stale-execution-attempt-reconciled', attempt.requestId,
        )
        const reconcileRunOutcome = appendRunSnapshotJournal(
          snapshot, key, 'execution-reconcile-request-completed', input.reconcileRequestId,
        )
        completeGlobalLedger(
          snapshot.globalLedger, attempt.requestId, requestDigest, executionResponse, executionRunOutcome,
        )
        completeGlobalLedger(
          snapshot.globalLedger, input.reconcileRequestId, input.reconcileRequestDigest,
          reconcileResponse, reconcileRunOutcome,
        )
        verifyStoreSnapshot(snapshot)
        this.#snapshotStore.commit(canonicalizeJson(snapshot))
        return { attemptId: attempt.attemptId, response: structuredClone(reconcileResponse) }
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
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

  async #mutate<T>(operation: (snapshot: RunStoreSnapshot) => T): Promise<T> {
    return await this.#snapshotStore.runExclusive(async () => {
      const serialized = this.#snapshotStore.begin()
      try {
        const snapshot = parseStoreSnapshot(serialized)
        const result = operation(snapshot)
        verifyStoreSnapshot(snapshot)
        this.#snapshotStore.commit(canonicalizeJson(snapshot))
        return result
      } catch (error) {
        this.#snapshotStore.rollback()
        throw error
      }
    })
  }
}

/** RuntimeSecretBroker 内部消费；伪造、跨项目和重放均 fail closed。 */
export async function consumeRuntimeSecretRetirementCapability(
  capability: RuntimeSecretRetirementCapability,
  expectedProjectIdentityDigest: string,
  operation: (binding: { projectIdentityDigest: string; runId: string }) => Promise<void>,
): Promise<void> {
  const record = retirementCapabilities.get(capability)
  if (record === undefined || record.state !== 'available'
    || record.projectIdentityDigest !== expectedProjectIdentityDigest) {
    throw runtimeStoreError(
      'E2E_SECRET_RETIREMENT_CAPABILITY_INVALID',
      'Secret 退役 capability 伪造、跨项目或已消费',
    )
  }
  record.state = 'in-progress'
  try {
    await record.execute(async () => await operation({
      projectIdentityDigest: record.projectIdentityDigest,
      runId: record.runId,
    }))
    record.state = 'used'
  } catch (error) {
    record.state = 'available'
    throw error
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
    verifyRunGlobalClosure(snapshot)
    verifyLeases(snapshot.leases)
  } catch (error) {
    if (error instanceof E2EError && error.code === 'E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED') throw error
    throw journalIntegrityError('持久状态无法闭合验证', error)
  }
}

function verifyGlobalLedger(ledger: GlobalReplayLedger): void {
  verifyJournalRows(ledger.journal)
  const projected = new Map<string, {
    requestDigest: string
    status: 'pending' | 'completed'
    responseDigest?: string
    runOutcome?: GlobalRunOutcomeBinding
  }>()
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
    const eventRunOutcome = parseRunOutcomeBinding(event.runOutcome)
    const completionKeys = eventRunOutcome === undefined
      ? ['kind', 'requestDigest', 'requestId', 'responseDigest']
      : ['kind', 'requestDigest', 'requestId', 'responseDigest', 'runOutcome']
    if (event.kind === 'request-completed'
      && hasExactKeys(event, completionKeys)
      && typeof event.requestId === 'string'
      && typeof event.requestDigest === 'string'
      && typeof event.responseDigest === 'string') {
      const existing = projected.get(event.requestId)
      if (existing?.status === 'pending' && existing.requestDigest === event.requestDigest) {
        projected.set(event.requestId, {
          requestDigest: event.requestDigest,
          status: 'completed',
          responseDigest: event.responseDigest,
          ...(eventRunOutcome === undefined ? {} : { runOutcome: eventRunOutcome }),
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
    const entryRunOutcome = parseRunOutcomeBinding(entry.runOutcome)
    const completedKeys = entryRunOutcome === undefined
      ? ['requestDigest', 'response', 'status']
      : ['requestDigest', 'response', 'runOutcome', 'status']
    if (!hasExactKeys(entry, completedKeys)
      || responseDigest(entry.response) !== expected.responseDigest
      || !sameRunOutcome(entryRunOutcome, expected.runOutcome)) {
      throw journalIntegrityError('completed replay response 与 journal 不一致')
    }
  }
}

function sameRunOutcome(
  first: GlobalRunOutcomeBinding | undefined,
  second: GlobalRunOutcomeBinding | undefined,
): boolean {
  if (first === undefined || second === undefined) return first === second
  return canonicalizeJson(first) === canonicalizeJson(second)
}

function verifyRunGlobalClosure(snapshot: RunStoreSnapshot): void {
  for (const [requestId, entry] of Object.entries(snapshot.globalLedger.entries)) {
    if (entry.status !== 'completed' || entry.runOutcome === undefined) continue
    const run = snapshot.runs[entry.runOutcome.runKey]
    const local = run?.requestResponses[requestId]
    if (run === undefined || local === undefined
      || local.requestDigest !== entry.requestDigest
      || responseDigest(local.response) !== responseDigest(entry.response)
      || !runJournalContainsOutcome(snapshot.journals[entry.runOutcome.runKey], requestId, entry.runOutcome)) {
      throw journalIntegrityError('global Run outcome 无法与 Run response/journal 双向闭合')
    }
  }
  for (const [key, run] of Object.entries(snapshot.runs)) {
    for (const [requestId, local] of Object.entries(run.requestResponses)) {
      const global = snapshot.globalLedger.entries[requestId]
      if (global?.status !== 'completed'
        || global.runOutcome?.runKey !== key
        || local.requestDigest !== global.requestDigest
        || responseDigest(local.response) !== responseDigest(global.response)
        || !runJournalContainsOutcome(snapshot.journals[key], requestId, global.runOutcome)) {
        throw journalIntegrityError('Run response 无法与 global outcome/journal 双向闭合')
      }
    }
  }
}

function runJournalContainsOutcome(
  rows: JournalRow[] | undefined,
  requestId: string,
  binding: GlobalRunOutcomeBinding,
): boolean {
  return rows?.some((row) => row.event.requestId === requestId
    && row.event.kind === binding.outcomeKind
    && row.event.digest === binding.snapshotDigest
    && hasExactKeys(row.event, ['digest', 'kind', 'requestId'])) ?? false
}

function parseRunOutcomeBinding(value: unknown): GlobalRunOutcomeBinding | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['outcomeKind', 'runKey', 'snapshotDigest'])
    || typeof value.runKey !== 'string'
    || typeof value.snapshotDigest !== 'string'
    || typeof value.outcomeKind !== 'string') {
    throw journalIntegrityError('global Run outcome binding 结构非法')
  }
  return {
    runKey: value.runKey,
    snapshotDigest: value.snapshotDigest,
    outcomeKind: value.outcomeKind,
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
      || !hasExactKeys(lease, ['expiresAt', 'fencingToken', 'ownerNonce'])
      || typeof lease.ownerNonce !== 'string'
      || !Number.isSafeInteger(lease.fencingToken)
      || lease.fencingToken <= 0
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

function requireExecutionReconcileReplay(response: unknown, expected: {
  runId: string
  expectedAttemptId: string
  reconcileRequestId: string
  runtimeVersion: string
  installationDigest: string
}): unknown {
  const parsed = RuntimeResponseEnvelopeSchema.safeParse(response)
  const result = parsed.success && parsed.data.ok ? parsed.data.result : undefined
  if (!parsed.success || !parsed.data.ok || parsed.data.requestId !== expected.reconcileRequestId
    || parsed.data.runtime.version !== expected.runtimeVersion
    || parsed.data.runtime.installationDigest !== expected.installationDigest
    || !isPlainRecord(result)
    || result.runId !== expected.runId
    || result.reconciledAttemptId !== expected.expectedAttemptId
    || result.status !== 'safety-blocked') {
    throw runtimeStoreError(
      'E2E_RUNTIME_EXECUTION_RECONCILE_REPLAY_INVALID',
      '已完成 resume-run outcome 与显式 reconcile identity 不一致',
    )
  }
  return structuredClone(parsed.data)
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

function requirePendingRequestDigest(snapshot: RunStoreSnapshot, requestId: string): string {
  const entry = snapshot.globalLedger.entries[requestId]
  if (entry?.status !== 'pending') throw runtimeStoreError(
    'E2E_RUNTIME_EXECUTION_RECONCILE_REQUEST_INVALID',
    'stale execution attempt 必须绑定仍为 pending 的原始请求',
  )
  return entry.requestDigest
}

function completeGlobalLedger(
  ledger: GlobalReplayLedger,
  requestId: string,
  requestDigest: string,
  response: unknown,
  runOutcome?: GlobalRunOutcomeBinding,
): void {
  const entry = ledger.entries[requestId]
  if (entry?.requestDigest !== requestDigest || entry.status !== 'pending') {
    if (entry !== undefined && entry.requestDigest !== requestDigest) throw requestReplayMismatch()
    throw runtimeStoreError('E2E_RUNTIME_REQUEST_NOT_RESERVED', '只能完成已 reservation 的 request')
  }
  ledger.entries[requestId] = {
    requestDigest,
    status: 'completed',
    response,
    ...(runOutcome === undefined ? {} : { runOutcome }),
  }
  appendJournalRow(ledger.journal, {
    kind: 'request-completed',
    requestId,
    requestDigest,
    responseDigest: responseDigest(response),
    ...(runOutcome === undefined ? {} : { runOutcome }),
  })
}

function appendRunSnapshotJournal(
  snapshot: RunStoreSnapshot,
  key: string,
  kind: string,
  requestId: string,
): GlobalRunOutcomeBinding {
  const run = snapshot.runs[key]
  if (run === undefined) throw journalIntegrityError('无法为缺失 Run 写 journal')
  const snapshotDigest = runtimeRunSnapshotDigest(run)
  appendJournalRow(snapshot.journals[key]!, {
    kind,
    digest: snapshotDigest,
    requestId,
  })
  return { runKey: key, snapshotDigest, outcomeKind: kind }
}

function appendRunRecoveryJournal(
  snapshot: RunStoreSnapshot,
  key: string,
  event: Record<string, unknown>,
): void {
  const run = snapshot.runs[key]
  if (run === undefined) throw journalIntegrityError('无法为缺失 Run 写 recovery journal')
  appendJournalRow(snapshot.journals[key]!, {
    ...event,
    digest: runtimeRunSnapshotDigest(run),
  })
}

function withoutRecordDigest(
  record: RuntimeWriteAttemptRecord,
): Omit<RuntimeWriteAttemptRecord, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...withoutDigest } = record
  return withoutDigest
}

function recoveryTerminalWorkflow(
  state: WorkflowState,
  next: 'safety-blocked' | 'migration-required',
  reason: string,
  timestamp: string,
): WorkflowState {
  const eventCore = {
    sequence: state.sequence + 1, previous: state.current, next, reason, timestamp,
    engineVersion: 'runtime-recovery/1', commitVerified: false,
    previousChainDigest: state.eventChainDigest,
  }
  const eventDigest = digestText('workflow-event/v1', canonicalizeJson(eventCore))
  return { current: next, sequence: eventCore.sequence,
    eventChainDigest: digestText('workflow-event-chain/v1', canonicalizeJson({
      previous: state.eventChainDigest, event: eventDigest,
    })) }
}

function writeTransitionError(): E2EError {
  return runtimeStoreError(
    'E2E_RUNTIME_WRITE_ATTEMPT_TRANSITION_INVALID',
    'WriteAttempt 状态转换不在固定状态机内',
  )
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

function executionOwnerKey(key: string): string {
  return `execution-owner\u0000${key}`
}

function runtimeRunSnapshotDigest(snapshot: unknown): string {
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

/** Runtime 内部共享：固定创建并钉住用户级 state 根；不从包根导出。 */
export async function ensureSecureUserStateRoot(
  homeDir: string,
  stateRoot: string,
): Promise<SqliteStateDirectoryIdentity> {
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
  const realStateRoot = await realpath(stateRoot)
  if (realStateRoot !== normalizePlatformPathAlias(resolve(stateRoot))) {
    throw runtimeStoreError('E2E_RUNTIME_STATE_SYMLINK_FORBIDDEN', 'state root canonical path 不一致')
  }
  const stateMetadata = await lstat(stateRoot)
  return {
    realPath: realStateRoot,
    device: String(stateMetadata.dev),
    inode: String(stateMetadata.ino),
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
