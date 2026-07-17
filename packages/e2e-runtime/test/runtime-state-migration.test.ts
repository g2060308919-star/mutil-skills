import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { describe, expect, test } from 'vitest'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { migrateRuntimeRunSnapshot } from '../src/runtime-state-migration.js'

function currentSnapshot(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.1.0',
    runId: 'RUN-1',
    assetId: 'ASSET-1',
    projectIdentityDigest: `sha256:${'a'.repeat(64)}`,
    runtimeInstallationDigest: `sha256:${'b'.repeat(64)}`,
    runRevision: 0,
    workflow: createWorkflow(),
    artifactDigests: {},
    frozenArtifacts: {},
    trustedExecutionFacts: {},
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

  test('explicitly migrates the previous same-major snapshot without inventing artifacts', () => {
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
      trustedExecutionFacts: {},
    })
  })

  test.each(['1.2.0', '2.0.0', 'invalid'])(
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

  test.each([
    { field: 'runId', value: 'RUN/1' },
    { field: 'assetId', value: '../ASSET' },
  ])('rejects an invalid persistent $field', ({ field, value }) => {
    expect(() => migrateRuntimeRunSnapshot({ ...currentSnapshot(), [field]: value }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' }))
  })
})
