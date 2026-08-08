import {
  TaskStateViewV1Schema,
  type RuntimeStatusResult,
  type TaskStateRecoveryV1,
  type TaskStateViewV1,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

type LegacyTaskStateBasis = Pick<RuntimeStatusResult,
  | 'workflow'
  | 'stage'
  | 'condition'
  | 'nextEdge'
  | 'verifiedDigests'
  | 'minimumMissingInput'
  | 'preservedAssets'
  | 'invalidatedAssets'
>

/**
 * 从 RuntimeRunSnapshot 与现有权威 status 投影生成只读 TaskStateViewV1。
 * 该函数不执行 I/O，也不写回任何状态。
 */
export function projectTaskStateViewV1(
  snapshot: RuntimeRunSnapshot,
  basis: LegacyTaskStateBasis,
): TaskStateViewV1 {
  if (basis.stage === undefined || basis.condition === undefined) {
    throw taskStateError('E2E_TASK_STATE_LEGACY_PROJECTION_INCOMPLETE')
  }
  const preserved = new Set(basis.preservedAssets ?? Object.keys(snapshot.artifactDigests))
  const invalidated = new Set(basis.invalidatedAssets ?? [])
  for (const assetKey of preserved) {
    if (invalidated.has(assetKey)) {
      throw taskStateError('E2E_TASK_STATE_ARTIFACT_VALIDITY_CONFLICT')
    }
  }
  const assetKeys = [...new Set([
    ...Object.keys(snapshot.artifactDigests), ...preserved, ...invalidated,
  ])].sort()

  return TaskStateViewV1Schema.parse({
    schemaVersion: '1.0.0',
    runId: snapshot.runId,
    assetId: snapshot.assetId,
    snapshotRevision: snapshot.runRevision ?? 0,
    workflow: basis.workflow,
    stage: basis.stage,
    condition: basis.condition,
    caseAttempts: (snapshot.caseSchedule?.cases ?? []).map((item) => ({ ...item })),
    artifactValidity: assetKeys.map((assetKey) => ({
      assetKey,
      validity: invalidated.has(assetKey) ? 'invalidated' : 'preserved',
      ...(snapshot.artifactDigests[assetKey] === undefined
        ? {} : { contentDigest: snapshot.artifactDigests[assetKey] }),
    })),
    verifiedDigests: basis.verifiedDigests,
    minimumMissingInput: basis.minimumMissingInput,
    recovery: recoveryProjection(snapshot, basis),
  })
}

function recoveryProjection(
  snapshot: RuntimeRunSnapshot,
  basis: LegacyTaskStateBasis,
): TaskStateRecoveryV1 {
  if (snapshot.workflow.current === 'migration-required') return {
    kind: 'migration-required', reasonCode: 'E2E_RUN_MIGRATION_REQUIRED',
  }
  if (basis.condition?.kind === 'blocked-retryable') {
    const command = basis.nextEdge?.command
    if (command === 'probe-target' || command === 'run-preflight') return {
      kind: 'retry', command, reasonCode: basis.condition.reasonCode,
    }
  }
  if (basis.condition?.kind !== 'running') return { kind: 'none' }

  const effectUnknown = Object.values(snapshot.writeAttempts ?? {})
    .find((attempt) => attempt.state === 'effect-unknown')
  if (effectUnknown !== undefined) return {
    kind: 'reconcile', command: 'resume-run', attemptId: effectUnknown.attemptId,
    reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNKNOWN',
  }
  const runningCase = snapshot.caseSchedule?.cases.find((item) =>
    item.state === 'running' || item.state === 'cleanup')
  const runningAttemptId = runningCase?.attemptId
  if (runningCase !== undefined && runningAttemptId === undefined) return {
    kind: 'migration-required', reasonCode: 'E2E_RUNTIME_CASE_ATTEMPT_ID_MISSING',
  }
  if (runningAttemptId !== undefined) return {
    kind: 'reconcile', command: 'resume-run', attemptId: runningAttemptId,
    reasonCode: 'E2E_RUNTIME_CASE_EFFECT_RECONCILIATION_REQUIRED',
  }
  return {
    kind: 'resume', command: 'resume-run',
    attemptId: snapshot.executionAttempt?.attemptId ?? basis.condition.attemptId,
  }
}

function taskStateError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
