import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { RuntimeRunStore, type RuntimeRunSnapshot } from './run-store.js'
import type {
  RuntimeOwnedResourceMarker,
  RuntimeWriteAttemptRecord,
  RuntimeWriteAttemptState,
} from './write-attempt.js'

interface VerificationResult {
  ok: boolean
  summaryDigest: string
  reasonCode?: string
}

type ReservationObservation =
  | { status: 'reserved' | 'unknown'; reservationId: string }
  | { status: 'completed'; reservationId: string; outcomeDigest: string; receiptDigest: string }

export interface RuntimeRecoveryDependencies {
  runStore: RuntimeRunStore
  installation: { verify(snapshot: RuntimeRunSnapshot): Promise<VerificationResult> }
  state: { verify(snapshot: RuntimeRunSnapshot): Promise<VerificationResult> }
  journal: { verify(snapshot: RuntimeRunSnapshot): Promise<VerificationResult> }
  resources: { cleanupOwned(marker: RuntimeOwnedResourceMarker): Promise<{
    status: 'cleaned' | 'absent' | 'owner-mismatch'
    summaryDigest: string
  }> }
  reservation: {
    inspect(record: RuntimeWriteAttemptRecord): Promise<ReservationObservation>
    markUnknown(input: { operationId: string; reservationId: string; reason: string }): Promise<string>
  }
  lease: {
    quarantine(input: { operationId: string; leaseId: string; fencingToken: number
      targetFingerprint: string; reason: string }): Promise<string>
  }
  artifacts: { recover(snapshot: RuntimeRunSnapshot): Promise<VerificationResult> }
  frozen: { verify(snapshot: RuntimeRunSnapshot): Promise<VerificationResult> }
  resume: { evaluate(snapshot: RuntimeRunSnapshot): Promise<{
    allowed: boolean
    next: string
    summaryDigest: string
    reasonCode?: string
  }> }
  now(): Date
}

export interface RuntimeRecoveryResult {
  status: 'recovered' | 'blocked'
  writeState?: RuntimeWriteAttemptState
  next?: string
  reasonCode?: string
  browserCalls: 0
}

type RecoveryInput = { projectIdentityDigest: string; runId: string; attemptId: string }

/** Recovery 依赖面不含 Browser/Gateway/Secret；每次外调前后只用短锁和 recordDigest CAS。 */
export class RuntimeRecoveryCoordinator {
  constructor(private readonly dependencies: RuntimeRecoveryDependencies) {}

  async recover(input: RecoveryInput): Promise<RuntimeRecoveryResult> {
    let { snapshot, attempt } = await this.context(input)
    for (const [step, verify] of [
      ['installation', this.dependencies.installation.verify],
      ['state', this.dependencies.state.verify],
      ['journal', this.dependencies.journal.verify],
    ] as const) {
      const observedRevision = snapshot.runRevision ?? 0
      const result = requireVerificationResult(await verify(snapshot), step)
      if (!result.ok) return await this.persistBlocked(input, snapshot, attempt,
        result.reasonCode ?? `E2E_RUNTIME_RECOVERY_${step.toUpperCase()}_INVALID`)
      await this.recordStep(input, attempt, observedRevision, step, 'verified', result.summaryDigest)
      ;({ snapshot, attempt } = await this.context(input))
    }

    const ownerRevision = snapshot.runRevision ?? 0
    const cleanup = await this.dependencies.resources.cleanupOwned(attempt.ownerMarker)
    requireDigest(cleanup.summaryDigest, 'owner cleanup summary')
    await this.recordStep(input, attempt, ownerRevision,
      'owner-marker-cleanup', cleanup.status, cleanup.summaryDigest)
    if (cleanup.status === 'owner-mismatch') {
      return await this.persistBlocked(input, snapshot, attempt, 'E2E_RUNTIME_RECOVERY_OWNER_MISMATCH')
    }

    attempt = await this.reconcileReservation(input, attempt)
    ;({ snapshot, attempt } = await this.context(input))

    const artifactRevision = snapshot.runRevision ?? 0
    const artifact = requireVerificationResult(await this.dependencies.artifacts.recover(snapshot), 'artifact recovery')
    await this.recordStep(input, attempt, artifactRevision, 'artifact-recovery',
      artifact.ok ? 'verified' : 'blocked', artifact.summaryDigest)
    if (!artifact.ok) return await this.persistBlocked(input, snapshot, attempt,
      artifact.reasonCode ?? 'E2E_RUNTIME_RECOVERY_ARTIFACT_INVALID')

    ;({ snapshot, attempt } = await this.context(input))
    const frozenRevision = snapshot.runRevision ?? 0
    const frozen = requireVerificationResult(await this.dependencies.frozen.verify(snapshot), 'frozen digest')
    await this.recordStep(input, attempt, frozenRevision, 'frozen-digest',
      frozen.ok ? 'verified' : 'blocked', frozen.summaryDigest)
    if (!frozen.ok) return await this.persistBlocked(input, snapshot, attempt,
      frozen.reasonCode ?? 'E2E_RUNTIME_RECOVERY_FROZEN_DIGEST_INVALID')

    ;({ snapshot, attempt } = await this.context(input))
    const resumeRevision = snapshot.runRevision ?? 0
    const resume = await this.dependencies.resume.evaluate(snapshot)
    requireDigest(resume.summaryDigest, 'resume summary')
    await this.recordStep(input, attempt, resumeRevision, 'resume-edge',
      resume.allowed ? 'allowed' : 'blocked', resume.summaryDigest)
    if (!resume.allowed) return await this.persistBlocked(input, snapshot, attempt,
      resume.reasonCode ?? 'E2E_RUNTIME_RECOVERY_RESUME_REJECTED')
    return { status: 'recovered', writeState: attempt.state, next: resume.next, browserCalls: 0 }
  }

  private async reconcileReservation(input: RecoveryInput, initial: RuntimeWriteAttemptRecord) {
    if (initial.state === 'outcome-committed') {
      await this.recordStep(input, initial, undefined, 'reservation-reconcile', 'committed', initial.recordDigest)
      return initial
    }
    let attempt: RuntimeWriteAttemptRecord = initial
    const observed = await this.dependencies.reservation.inspect(attempt)
    if (attempt.state === 'prepared') {
      attempt = await this.withLock(input, async (lock) => await this.dependencies.runStore.observeWriteReservation({
        ...input, reservationId: observed.reservationId, observedAt: this.dependencies.now().toISOString(),
        expectedRecordDigest: attempt.recordDigest, lock,
      }))
    } else if ('reservation' in attempt && attempt.reservation !== undefined
      && attempt.reservation.reservationId !== observed.reservationId) {
      throw recoveryError('E2E_RUNTIME_RECOVERY_RESERVATION_MISMATCH', 'Authority 返回了其他 Reservation')
    }

    if (observed.status === 'completed' && attempt.state === 'outcome-prepared'
      && observed.outcomeDigest === attempt.outcome.outcomeDigest
      && observed.receiptDigest === attempt.outcome.receiptDigest) {
      const committed = await this.withLock(input, async (lock) =>
        await this.dependencies.runStore.commitWriteOutcome({ ...input,
          outcomeDigest: observed.outcomeDigest, receiptDigest: observed.receiptDigest,
          committedAt: this.dependencies.now().toISOString(), expectedRecordDigest: attempt.recordDigest, lock }))
      await this.recordStep(input, committed, undefined, 'reservation-reconcile', 'committed', committed.recordDigest)
      return committed
    }

    const reason = 'runtime recovery cannot prove write outcome'
    const markUnknownOperationId = observed.status === 'completed' ? undefined
      : stableOperationId('mark-unknown', attempt, observed.reservationId)
    const quarantineOperationId = stableOperationId('quarantine', attempt, observed.reservationId)
    attempt = await this.withLock(input, async (lock) => await this.dependencies.runStore.prepareWriteRecovery({
      ...input, ...(markUnknownOperationId === undefined ? {} : { markUnknownOperationId }),
      quarantineOperationId, expectedRecordDigest: attempt.recordDigest,
      preparedAt: this.dependencies.now().toISOString(), lock,
    }))

    let unknownReceipt = attempt.recovery?.markUnknown?.receiptDigest
    if (markUnknownOperationId !== undefined && unknownReceipt === undefined) {
      unknownReceipt = await this.dependencies.reservation.markUnknown({
        operationId: markUnknownOperationId, reservationId: observed.reservationId, reason,
      })
      requireDigest(unknownReceipt, 'markUnknown receipt')
      attempt = await this.withLock(input, async (lock) => await this.dependencies.runStore.recordWriteRecoveryReceipt({
        ...input, operation: 'markUnknown', operationId: markUnknownOperationId,
        receiptDigest: unknownReceipt!, expectedRecordDigest: attempt.recordDigest,
        recordedAt: this.dependencies.now().toISOString(), lock,
      }))
    }

    let quarantineReceipt = attempt.recovery?.quarantine.receiptDigest
    if (quarantineReceipt === undefined) {
      quarantineReceipt = await this.dependencies.lease.quarantine({ operationId: quarantineOperationId,
        leaseId: attempt.lease.leaseId, fencingToken: attempt.lease.fencingToken,
        targetFingerprint: attempt.lease.targetFingerprintDigest,
        reason: 'write effect is unknown after runtime recovery' })
      requireDigest(quarantineReceipt, 'quarantine receipt')
      attempt = await this.withLock(input, async (lock) => await this.dependencies.runStore.recordWriteRecoveryReceipt({
        ...input, operation: 'quarantine', operationId: quarantineOperationId,
        receiptDigest: quarantineReceipt!, expectedRecordDigest: attempt.recordDigest,
        recordedAt: this.dependencies.now().toISOString(), lock,
      }))
    }

    const unknown = attempt.state === 'effect-unknown' ? attempt
      : await this.withLock(input, async (lock) => await this.dependencies.runStore.markWriteEffectUnknown({
        ...input, reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN',
        observedAt: this.dependencies.now().toISOString(), expectedRecordDigest: attempt.recordDigest, lock,
      }))
    await this.recordStep(input, unknown, undefined, 'reservation-reconcile', 'effect-unknown', digestText(
      'runtime-recovery-reservation/v1', canonicalizeJson({ reservationStatus: observed.status,
        unknownReceipt: unknownReceipt ?? null, quarantineReceipt, writeRecordDigest: unknown.recordDigest }),
    ))
    return unknown
  }

  private async context(input: RecoveryInput): Promise<{
    snapshot: RuntimeRunSnapshot; attempt: RuntimeWriteAttemptRecord
  }> {
    const snapshot = await this.dependencies.runStore.getRun(input.projectIdentityDigest, input.runId)
    if (snapshot === undefined) throw recoveryError('E2E_RUNTIME_RUN_NOT_FOUND', '恢复目标 Run 不存在')
    const attempt = snapshot.writeAttempts?.[input.attemptId]
    if (attempt === undefined) throw recoveryError('E2E_RUNTIME_WRITE_ATTEMPT_NOT_FOUND', '恢复目标 WriteAttempt 不存在')
    return { snapshot, attempt }
  }

  private async recordStep(input: RecoveryInput, attempt: RuntimeWriteAttemptRecord,
    expectedRunRevision: number | undefined, step: string, status: string, summaryDigest: string): Promise<void> {
    requireDigest(summaryDigest, `${step} summary`)
    await this.withLock(input, async (lock) => await this.dependencies.runStore.recordRecoveryStep({
      ...input, step, status, summaryDigest, expectedRecordDigest: attempt.recordDigest,
      ...(expectedRunRevision === undefined ? {} : { expectedRunRevision }), lock,
    }))
  }

  private async persistBlocked(input: RecoveryInput, snapshot: RuntimeRunSnapshot,
    attempt: RuntimeWriteAttemptRecord, reasonCode: string): Promise<RuntimeRecoveryResult> {
    const terminalState = reasonCode.includes('MIGRATION') ? 'migration-required' : 'safety-blocked'
    await this.withLock(input, async (lock) => await this.dependencies.runStore.blockWriteRecovery({
      ...input, expectedRecordDigest: attempt.recordDigest, expectedRunRevision: snapshot.runRevision ?? 0,
      reasonCode, terminalState, blockedAt: this.dependencies.now().toISOString(), lock,
    }))
    return { status: 'blocked', reasonCode, browserCalls: 0 }
  }

  private async withLock<T>(input: RecoveryInput, operation: (lock: Awaited<ReturnType<RuntimeRunStore['acquireRunLock']>>) => Promise<T>) {
    const lock = await this.dependencies.runStore.acquireRunLock(input.projectIdentityDigest, input.runId)
    try { return await operation(lock) } finally { await lock.close() }
  }
}

function stableOperationId(kind: string, attempt: RuntimeWriteAttemptRecord, reservationId: string): string {
  return `RECOVERY:${kind}:${digestText('runtime-recovery-operation/v1', canonicalizeJson({
    attemptId: attempt.attemptId, recordBinding: { requestId: attempt.requestId, actionId: attempt.actionId,
      lease: attempt.lease }, reservationId,
  })).slice('sha256:'.length)}`
}

function requireVerificationResult(result: VerificationResult, label: string): VerificationResult {
  if (typeof result.ok !== 'boolean') throw recoveryError('E2E_RUNTIME_RECOVERY_ADAPTER_INVALID',
    `${label} verification result 非法`)
  requireDigest(result.summaryDigest, `${label} summary`)
  return result
}

function requireDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw recoveryError(
    'E2E_RUNTIME_RECOVERY_ADAPTER_INVALID', `${label} digest 非法`)
}

function recoveryError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
