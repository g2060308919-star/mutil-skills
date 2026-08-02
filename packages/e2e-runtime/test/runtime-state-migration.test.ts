import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { describe, expect, test } from 'vitest'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { migrateRuntimeRunSnapshot } from '../src/runtime-state-migration.js'
import { createRuntimeOwnedResourceMarker, sealRuntimeWriteAttemptRecord } from '../src/write-attempt.js'
import { projectionFixture } from './trusted-action-runner.test.js'

function currentSnapshot(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.8.0',
    runId: 'RUN-1',
    assetId: 'ASSET-1',
    projectIdentityDigest: `sha256:${'a'.repeat(64)}`,
    runtimeInstallationDigest: `sha256:${'b'.repeat(64)}`,
    runRevision: 0,
    workflow: createWorkflow(),
    artifactDigests: {},
    frozenArtifacts: {},
    trustedExecutionFacts: { 'approval-mode': 'local-confirmation' },
    writeAttempts: {},
    executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {},
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  }
}

describe('runtime state migration', () => {
  test('canonical round-trips the current snapshot', () => {
    const snapshot = currentSnapshot()
    const migrated = migrateRuntimeRunSnapshot(snapshot)

    expect(migrated).toEqual(JSON.parse(canonicalizeJson(snapshot)))
    expect(migrated).not.toBe(snapshot)
  })

  test('explicitly migrates 1.0 through 1.8 and preserves legacy WebAuthn approval semantics', () => {
    const current = currentSnapshot()
    const legacy = {
      ...current,
      schemaVersion: '1.0.0',
    } as Record<string, unknown>
    delete legacy.frozenArtifacts
    delete legacy.trustedExecutionFacts

    expect(migrateRuntimeRunSnapshot(legacy)).toEqual({
      ...current,
      frozenArtifacts: {},
      trustedExecutionFacts: { 'approval-mode': 'webauthn' },
      writeAttempts: {},
      executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    })
  })

  test('explicitly migrates 1.1 to strict 1.8 with WebAuthn and empty WriteAttempt/execution result maps', () => {
    const current = currentSnapshot()
    const legacy = {
      ...current, schemaVersion: '1.1.0', trustedExecutionFacts: {},
    } as Record<string, unknown>
    delete legacy.writeAttempts
    expect(migrateRuntimeRunSnapshot(legacy)).toEqual({
      ...current, trustedExecutionFacts: { 'approval-mode': 'webauthn' },
    })
  })

  test('explicitly migrates 1.2 to 1.8 and adds the read result domain', () => {
    const current = currentSnapshot()
    const legacy = { ...current, schemaVersion: '1.2.0', trustedExecutionFacts: {} } as const
    expect(migrateRuntimeRunSnapshot(legacy)).toEqual({
      ...current, trustedExecutionFacts: { 'approval-mode': 'webauthn' },
    })
  })

  test('explicitly migrates 1.3 to 1.8 without conflating read, write and injection domains', () => {
    const current = currentSnapshot()
    const legacy = {
      ...current,
      schemaVersion: '1.3.0',
      trustedExecutionFacts: {},
      executionResults: { realEnvironment: {}, gatewayInjection: {} },
    } as const
    expect(migrateRuntimeRunSnapshot(legacy)).toEqual({
      ...current, trustedExecutionFacts: { 'approval-mode': 'webauthn' },
    })
  })

  test('1.4 Run 缺少模式时迁移为 WebAuthn，已有本地模式则保持不变', () => {
    const current = currentSnapshot()
    const legacy = { ...current, schemaVersion: '1.4.0', trustedExecutionFacts: {} } as const
    expect(migrateRuntimeRunSnapshot(legacy).trustedExecutionFacts).toEqual({ 'approval-mode': 'webauthn' })
    expect(migrateRuntimeRunSnapshot({
      ...legacy, trustedExecutionFacts: { 'approval-mode': 'local-confirmation' },
    }).trustedExecutionFacts).toEqual({ 'approval-mode': 'local-confirmation' })
  })

  test('1.5 Run 显式迁移为 1.8，缺少 understand-prd 冻结事实时不伪造事实', () => {
    const current = currentSnapshot()
    const legacy = { ...current, schemaVersion: '1.5.0' } as const
    const migrated = migrateRuntimeRunSnapshot(legacy)
    expect(migrated.schemaVersion).toBe('1.8.0')
    expect(migrated.trustedExecutionFacts['prd-understanding-contract']).toBeUndefined()
    expect(migrated.trustedExecutionFacts['prd-understanding-prepared']).toBeUndefined()
  })

  test('把 1.6 单 Case 快照迁移为一个持久调度项，不伪造编译计划', () => {
    const projected = projectionFixture()
    const frozenArtifacts = projected.frozenArtifacts
    const legacy = {
      ...currentSnapshot(),
      schemaVersion: '1.6.0',
      frozenArtifacts,
      artifactDigests: Object.fromEntries(Object.entries(frozenArtifacts)
        .map(([key, artifact]) => [key, artifact.contentDigest])),
    }

    const migrated = migrateRuntimeRunSnapshot(legacy)

    expect(migrated.schemaVersion).toBe('1.8.0')
    expect(migrated.compiledPrdRun).toBeUndefined()
    expect(migrated.caseSchedule?.cases).toMatchObject([{
      queueOrdinal: 0,
      caseId: 'CASE-1',
      actor: 'auditor',
      state: 'pending',
    }])
  })

  test.each(['1.9.0', '2.0.0', 'invalid'])(
    'blocks unsupported snapshot version %s instead of guessing a migration',
    (schemaVersion) => {
      expect(() => migrateRuntimeRunSnapshot({ ...currentSnapshot(), schemaVersion }))
        .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
    },
  )

  test('is idempotent when applied repeatedly to current state', () => {
    const first = migrateRuntimeRunSnapshot(currentSnapshot())
    const second = migrateRuntimeRunSnapshot(first)

    expect(second).toEqual(first)
    expect(canonicalizeJson(second)).toBe(canonicalizeJson(first))
  })

  test('rejects malformed current snapshots during strict canonical round-trip', () => {
    expect(() => migrateRuntimeRunSnapshot({ ...currentSnapshot(), unexpected: true }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
  })

  test('normalizes canonicalization failures to migration-required', () => {
    expect(() => migrateRuntimeRunSnapshot({
      ...currentSnapshot(),
      requestResponses: {
        'REQUEST-1': { requestDigest: `sha256:${'c'.repeat(64)}`, response: undefined },
      },
    })).toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
  })

  test('strictly validates WriteAttempt digest, owner binding and map key', () => {
    const snapshot = currentSnapshot()
    const marker = createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: snapshot.runtimeInstallationDigest,
      projectIdentityDigest: snapshot.projectIdentityDigest,
      runId: snapshot.runId, attemptId: 'ATTEMPT-WRITE-1', ownerNonce: 'OWNER-1',
    })
    const record = sealRuntimeWriteAttemptRecord({
      schemaVersion: '1.0.0', state: 'prepared', attemptId: 'ATTEMPT-WRITE-1',
      requestId: 'REQUEST-WRITE-1', requestDigest: `sha256:${'c'.repeat(64)}`,
      actionId: 'ACTION-WRITE-1', lease: {
        leaseId: 'LEASE-1', fencingToken: 1, targetFingerprintDigest: `sha256:${'d'.repeat(64)}`,
      },
      executionFencingToken: 2, ownerMarker: marker,
      preparedAt: '2026-07-17T00:00:00.000Z', recordRevision: 1,
    })
    expect(migrateRuntimeRunSnapshot({
      ...snapshot, writeAttempts: { [record.attemptId]: record },
    }).writeAttempts?.[record.attemptId]).toEqual(record)
    expect(() => migrateRuntimeRunSnapshot({
      ...snapshot, writeAttempts: { 'ATTEMPT-OTHER': record },
    })).toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
    expect(() => migrateRuntimeRunSnapshot({
      ...snapshot, writeAttempts: { [record.attemptId]: { ...record, recordDigest: `sha256:${'e'.repeat(64)}` } },
    })).toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
  })

  test.each([
    { field: 'runId', value: 'RUN/1' },
    { field: 'assetId', value: '../ASSET' },
  ])('rejects an invalid persistent $field', ({ field, value }) => {
    expect(() => migrateRuntimeRunSnapshot({ ...currentSnapshot(), [field]: value }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
  })
})
