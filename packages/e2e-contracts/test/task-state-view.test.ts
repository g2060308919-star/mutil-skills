import { describe, expect, test } from 'vitest'
import {
  RuntimeRequestEnvelopeSchema,
  RuntimeStatusResultSchema,
  TaskStateViewV1Schema,
} from '../src/index.js'

const d = (character: string): string => `sha256:${character.repeat(64)}`

describe('TaskStateViewV1 contract', () => {
  test('严格描述单一快照的流程、Case、制品、缺失输入和恢复动作', () => {
    const view = {
      schemaVersion: '1.0.0',
      runId: 'RUN-1',
      assetId: 'ASSET-1',
      snapshotRevision: 7,
      workflow: { current: 'running-real', sequence: 8, eventChainDigest: d('1') },
      stage: 'execution',
      condition: { kind: 'running', attemptId: 'ATTEMPT-1' },
      caseAttempts: [{
        queueOrdinal: 0, caseId: 'CASE-1', actor: 'USER', failurePolicy: 'stop-required',
        state: 'running', attemptId: 'ATTEMPT-1', startedAt: '2026-08-08T00:00:00.000Z',
      }],
      artifactValidity: [
        { assetKey: 'browser-preflight', validity: 'invalidated' },
        { assetKey: 'prd-source', validity: 'preserved', contentDigest: d('2') },
      ],
      verifiedDigests: { workflowEventChain: d('1') },
      minimumMissingInput: ['execution-recovery-decision'],
      recovery: {
        kind: 'reconcile', command: 'resume-run', attemptId: 'ATTEMPT-1',
        reasonCode: 'E2E_RUNTIME_CASE_EFFECT_RECONCILIATION_REQUIRED',
      },
    } as const

    expect(TaskStateViewV1Schema.parse(view)).toEqual(view)
    expect(TaskStateViewV1Schema.safeParse({ ...view, independentlyWritableState: true }).success)
      .toBe(false)
  })

  test('恢复联合类型显式保留 new-run 与 migration-required 语义', () => {
    const common = {
      schemaVersion: '1.0.0', runId: 'RUN-1', assetId: 'ASSET-1', snapshotRevision: 0,
      workflow: { current: 'migration-required', sequence: 0, eventChainDigest: d('1') },
      stage: 'requirements',
      condition: {
        kind: 'blocked-requires-change', reasonCode: 'E2E_RUN_MIGRATION_REQUIRED',
        resumeStage: 'requirements',
      },
      caseAttempts: [], artifactValidity: [], verifiedDigests: {}, minimumMissingInput: [],
    } as const
    expect(TaskStateViewV1Schema.safeParse({
      ...common,
      recovery: { kind: 'migration-required', reasonCode: 'E2E_RUN_MIGRATION_REQUIRED' },
    }).success).toBe(true)
    expect(TaskStateViewV1Schema.safeParse({
      ...common,
      recovery: {
        kind: 'new-run', changedBinding: 'runtime-installation',
        reasonCode: 'E2E_RUNTIME_INSTALLATION_BINDING_CHANGED',
      },
    }).success).toBe(true)
  })

  test('get-status 只在调用方显式选择时接受 TaskState 投影', () => {
    const request = {
      schemaVersion: '1.0.0', requestId: 'REQUEST-1',
      client: { name: 'e2e-facade', version: '0.5.2' }, command: 'get-status',
      projectRoot: '/project', payload: { runId: 'RUN-1', includeTaskState: true },
    } as const
    expect(RuntimeRequestEnvelopeSchema.parse(request)).toEqual(request)

    const taskState = TaskStateViewV1Schema.parse({
      schemaVersion: '1.0.0', runId: 'RUN-1', assetId: 'ASSET-1', snapshotRevision: 0,
      workflow: { current: 'created', sequence: 0, eventChainDigest: d('1') },
      stage: 'requirements', condition: { kind: 'ready' }, caseAttempts: [],
      artifactValidity: [{ assetKey: 'prd-source', validity: 'preserved', contentDigest: d('2') }],
      verifiedDigests: { workflowEventChain: d('1') },
      minimumMissingInput: ['prd-understanding-prepared'], recovery: { kind: 'none' },
    })
    const result = {
      runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('3'),
      runtimeInstallationDigest: d('4'), generationId: 'RUN-1', prdRevision: d('2'),
      workflow: taskState.workflow, artifactDigests: { 'prd-source': d('2') }, state: 'created',
      nextEdge: null, verifiedDigests: taskState.verifiedDigests,
      minimumMissingInput: taskState.minimumMissingInput, taskState,
    }
    expect(RuntimeStatusResultSchema.parse(result)).toEqual(result)
  })
})
