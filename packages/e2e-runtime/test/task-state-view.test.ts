import { describe, expect, test } from 'vitest'
import type { RuntimeStatusResult } from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { projectTaskStateViewV1 } from '../src/task-state-view.js'
import {
  createRuntimeOwnedResourceMarker,
  sealRuntimeWriteAttemptRecord,
} from '../src/write-attempt.js'

const d = (character: string): string => `sha256:${character.repeat(64)}`

describe('projectTaskStateViewV1', () => {
  test('从同一快照确定性投影 Case、制品和安全 retry，不产生可写状态', () => {
    const snapshot = snapshotFixture()
    const status = statusFixture()

    const first = projectTaskStateViewV1(snapshot, status)
    const second = projectTaskStateViewV1(structuredClone(snapshot), structuredClone(status))

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: '1.0.0', runId: 'RUN-1', assetId: 'ASSET-1', snapshotRevision: 3,
      workflow: status.workflow, stage: 'preflight', condition: status.condition,
      caseAttempts: [{ caseId: 'CASE-1', state: 'pending' }],
      artifactValidity: [
        { assetKey: 'browser-preflight', validity: 'invalidated' },
        { assetKey: 'prd-source', validity: 'preserved', contentDigest: d('2') },
      ],
      minimumMissingInput: ['browser-preflight-retry:E2E_RUNTIME_PAGE_MISMATCH'],
      recovery: {
        kind: 'retry', command: 'run-preflight',
        reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
      },
    })
  })

  test('运行中的 Case 必须 reconcile，只有无未知 Case 的相同执行身份才 resume', () => {
    const running = snapshotFixture({
      workflow: { current: 'running-real', sequence: 9, eventChainDigest: d('1') },
      executionAttempt: {
        attemptId: 'ATTEMPT-1', requestId: 'REQUEST-1', fencingToken: 1,
        revision: 1, startedAt: '2026-08-08T00:00:00.000Z',
      },
      caseSchedule: {
        schemaVersion: '1.0.0', compilerDigest: d('8'), revision: 1, status: 'active',
        currentCaseId: 'CASE-1', createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z', scheduleDigest: d('9'), cases: [{
          queueOrdinal: 0, caseId: 'CASE-1', actor: 'USER', failurePolicy: 'stop-required',
          state: 'running', attemptId: 'ATTEMPT-1', startedAt: '2026-08-08T00:00:00.000Z',
        }],
      },
    })
    const status = statusFixture({
      workflow: running.workflow, state: 'running-real', stage: 'execution',
      condition: { kind: 'running', attemptId: 'ATTEMPT-1' },
      nextEdge: { command: 'resume-run', from: 'running-real', expectedState: 'running-real' },
      minimumMissingInput: ['execution-recovery-decision'],
    })
    expect(projectTaskStateViewV1(running, status).recovery).toEqual({
      kind: 'reconcile', command: 'resume-run', attemptId: 'ATTEMPT-1',
      reasonCode: 'E2E_RUNTIME_CASE_EFFECT_RECONCILIATION_REQUIRED',
    })

    const resumable = { ...running, caseSchedule: undefined }
    expect(projectTaskStateViewV1(resumable, status).recovery).toEqual({
      kind: 'resume', command: 'resume-run', attemptId: 'ATTEMPT-1',
    })
  })

  test('migration-required 由权威 Workflow 投影，制品有效性冲突 fail closed', () => {
    const snapshot = snapshotFixture({
      workflow: { current: 'migration-required', sequence: 2, eventChainDigest: d('1') },
    })
    const status = statusFixture({
      workflow: snapshot.workflow, state: 'migration-required', stage: 'requirements',
      condition: {
        kind: 'blocked-requires-change', reasonCode: 'E2E_RUN_MIGRATION_REQUIRED',
        resumeStage: 'requirements',
      },
      nextEdge: null, minimumMissingInput: [],
    })
    expect(projectTaskStateViewV1(snapshot, status).recovery).toEqual({
      kind: 'migration-required', reasonCode: 'E2E_RUN_MIGRATION_REQUIRED',
    })
    expect(() => projectTaskStateViewV1(snapshot, {
      ...status, preservedAssets: ['prd-source'], invalidatedAssets: ['prd-source'],
    })).toThrowError('E2E_TASK_STATE_ARTIFACT_VALIDITY_CONFLICT')
  })

  test('effect-unknown 写 Attempt 永远先 reconcile，不能降级成 resume', () => {
    const ownerMarker = createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: d('4'), projectIdentityDigest: d('3'),
      runId: 'RUN-1', attemptId: 'ATTEMPT-WRITE-1', ownerNonce: 'OWNER-1',
    })
    const writeAttempt = sealRuntimeWriteAttemptRecord({
      schemaVersion: '1.0.0', state: 'effect-unknown', attemptId: 'ATTEMPT-WRITE-1',
      requestId: 'REQUEST-WRITE-1', requestDigest: d('5'), actionId: 'ACTION-WRITE-1',
      lease: { leaseId: 'LEASE-1', fencingToken: 1, targetFingerprintDigest: d('6') },
      executionFencingToken: 1, ownerMarker,
      preparedAt: '2026-08-08T00:00:00.000Z', recordRevision: 1,
      effectUnknown: {
        reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNKNOWN', observedAt: '2026-08-08T00:01:00.000Z',
      },
    })
    const snapshot = snapshotFixture({
      workflow: { current: 'running-real', sequence: 9, eventChainDigest: d('1') },
      executionAttempt: {
        attemptId: 'ATTEMPT-WRITE-1', requestId: 'REQUEST-WRITE-1', fencingToken: 1,
        revision: 1, startedAt: '2026-08-08T00:00:00.000Z',
      },
      caseSchedule: undefined,
      writeAttempts: { 'ATTEMPT-WRITE-1': writeAttempt },
    })
    const status = statusFixture({
      workflow: snapshot.workflow, state: 'running-real', stage: 'execution',
      condition: { kind: 'running', attemptId: 'ATTEMPT-WRITE-1' },
      nextEdge: { command: 'resume-run', from: 'running-real', expectedState: 'running-real' },
      minimumMissingInput: ['execution-recovery-decision'],
    })

    expect(projectTaskStateViewV1(snapshot, status).recovery).toEqual({
      kind: 'reconcile', command: 'resume-run', attemptId: 'ATTEMPT-WRITE-1',
      reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNKNOWN',
    })
  })

  test('旧 Case 缺少安全恢复所需 attemptId 时要求迁移，不能猜测 resume', () => {
    const snapshot = snapshotFixture({
      workflow: { current: 'running-real', sequence: 9, eventChainDigest: d('1') },
      executionAttempt: {
        attemptId: 'ATTEMPT-OUTER', requestId: 'REQUEST-1', fencingToken: 1,
        revision: 1, startedAt: '2026-08-08T00:00:00.000Z',
      },
      caseSchedule: {
        schemaVersion: '1.0.0', compilerDigest: d('8'), revision: 1,
        status: 'cleanup-required', createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:01:00.000Z', scheduleDigest: d('9'), cases: [{
          queueOrdinal: 0, caseId: 'CASE-1', actor: 'USER', failurePolicy: 'stop-required',
          state: 'cleanup', effectObservation: 'unknown', cleanupStatus: 'unknown',
        }],
      },
    })
    const status = statusFixture({
      workflow: snapshot.workflow, state: 'running-real', stage: 'execution',
      condition: { kind: 'running', attemptId: 'ATTEMPT-OUTER' },
      nextEdge: { command: 'resume-run', from: 'running-real', expectedState: 'running-real' },
      minimumMissingInput: ['execution-recovery-decision'],
    })

    expect(projectTaskStateViewV1(snapshot, status).recovery).toEqual({
      kind: 'migration-required', reasonCode: 'E2E_RUNTIME_CASE_ATTEMPT_ID_MISSING',
    })
  })
})

function snapshotFixture(overrides: Partial<RuntimeRunSnapshot> = {}): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.8.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: d('3'), runtimeInstallationDigest: d('4'), runRevision: 3,
    workflow: { current: 'preflight-readonly', sequence: 5, eventChainDigest: d('1') },
    artifactDigests: { 'prd-source': d('2') }, frozenArtifacts: {}, trustedExecutionFacts: {},
    caseSchedule: {
      schemaVersion: '1.0.0', compilerDigest: d('8'), revision: 0, status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
      scheduleDigest: d('9'), cases: [{
        queueOrdinal: 0, caseId: 'CASE-1', actor: 'USER', failurePolicy: 'stop-required',
        state: 'pending',
      }],
    },
    requestResponses: {}, createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  }
}

function statusFixture(overrides: Partial<RuntimeStatusResult> = {}): RuntimeStatusResult {
  return {
    runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('3'),
    runtimeInstallationDigest: d('4'), generationId: 'RUN-1', prdRevision: d('2'),
    workflow: { current: 'preflight-readonly', sequence: 5, eventChainDigest: d('1') },
    artifactDigests: { 'prd-source': d('2') }, state: 'preflight-readonly',
    nextEdge: { command: 'run-preflight', from: 'preflight-readonly',
      expectedState: 'preflight-readonly' },
    verifiedDigests: { workflowEventChain: d('1') },
    minimumMissingInput: ['browser-preflight-retry:E2E_RUNTIME_PAGE_MISMATCH'],
    stage: 'preflight', condition: {
      kind: 'blocked-retryable', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
      resumeStage: 'preflight',
    },
    preservedAssets: ['prd-source'], invalidatedAssets: ['browser-preflight'],
    ...overrides,
  }
}
