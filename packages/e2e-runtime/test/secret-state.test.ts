import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SqliteSnapshotStore } from '@mutil-skills/e2e-authority'
import { afterEach, describe, expect, test } from 'vitest'
import {
  initialSecretState,
  parseSecretState,
  serializeSecretState,
} from '../src/secret-state.js'
import { createRuntimeTestRoots } from './fixtures.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, {
    recursive: true, force: true,
  })))
})

describe('Secret state 认证封装', () => {
  test('严格认证完整 schema、payload 与 SQLite revision', () => {
    const wrappingKey = randomBytes(32)
    const macKey = randomBytes(32)
    try {
      const initial = initialSecretState(macKey)
      expect(parseSecretState(initial, 1, wrappingKey, macKey).runs).toEqual({})

      const changed = JSON.parse(initial) as Record<string, unknown>
      delete (changed.payload as Record<string, unknown>).capacity
      expect(() => parseSecretState(JSON.stringify(changed), 1, wrappingKey, macKey))
        .toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
      expect(() => parseSecretState(initial, 2, wrappingKey, macKey))
        .toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
    } finally {
      wrappingKey.fill(0)
      macKey.fill(0)
    }
  })

  test('begin 保持旧字符串 API，beginVersioned 暴露同一事务 revision 并拒绝旧快照重放', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const stateDirectory = join(roots.home, '.mutil-skills/e2e/state')
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const store = new SqliteSnapshotStore(join(stateDirectory, 'secret-state-test.sqlite'), 'test', {
      forbiddenRoots: [roots.project],
    })
    const wrappingKey = randomBytes(32)
    const macKey = randomBytes(32)
    try {
      const revisionOne = initialSecretState(macKey)
      store.initialize(revisionOne)
      expect(store.begin()).toBe(revisionOne)
      store.rollback()

      const transaction = store.beginVersioned()
      expect(transaction).toEqual({ snapshot: revisionOne, revision: 1 })
      const payload = parseSecretState(transaction.snapshot, transaction.revision, wrappingKey, macKey)
      store.commit(serializeSecretState(payload, 2, macKey))

      const revisionTwo = store.beginVersioned()
      expect(revisionTwo.revision).toBe(2)
      store.commit(revisionOne)

      const replayed = store.beginVersioned()
      expect(replayed.revision).toBe(3)
      expect(() => parseSecretState(replayed.snapshot, replayed.revision, wrappingKey, macKey))
        .toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
      store.rollback()
    } finally {
      wrappingKey.fill(0)
      macKey.fill(0)
      store.close()
    }
  })
})
