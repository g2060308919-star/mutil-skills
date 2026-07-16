import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { RuntimeRunStore } from '../src/run-store.js'

describe('runtime run store', () => {
  test('request id is idempotent but cannot be rebound to other bytes', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({
      stateRoot: join(roots.home, '.mutil-skills/e2e/state'),
      forbiddenRoots: [roots.project],
    })
    const digestA = `sha256:${'a'.repeat(64)}`
    const digestB = `sha256:${'b'.repeat(64)}`

    await expect(store.recordResponse('PROJECT-1', 'RUN-1', 'REQUEST-1', digestA, { ok: true }))
      .resolves.toEqual({ ok: true })
    await expect(store.recordResponse('PROJECT-1', 'RUN-1', 'REQUEST-1', digestA, { ignored: true }))
      .resolves.toEqual({ ok: true })
    await expect(store.recordResponse('PROJECT-1', 'RUN-1', 'REQUEST-1', digestB, { ok: true }))
      .rejects.toThrow(/E2E_RUNTIME_REQUEST_REPLAY_MISMATCH/)
    await store.close()
  })

  test('run lock and hash-chained journal fail closed on concurrent or tampered state', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({
      stateRoot: join(roots.home, '.mutil-skills/e2e/state'),
      forbiddenRoots: [roots.project],
    })
    const lock = await store.acquireRunLock('PROJECT-1', 'RUN-1')

    await expect(store.acquireRunLock('PROJECT-1', 'RUN-1')).rejects.toThrow(/E2E_RUNTIME_RUN_LOCKED/)
    await store.appendJournal('PROJECT-1', 'RUN-1', {
      kind: 'run-created',
      digest: `sha256:${'a'.repeat(64)}`,
    })
    await store.tamperJournalForTest('PROJECT-1', 'RUN-1', 0)
    await expect(store.verifyJournal('PROJECT-1', 'RUN-1'))
      .rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)
    await lock.close()
    await store.close()
  })

  test('verifies every persisted journal before startup recovery returns a store', async () => {
    const roots = await createRuntimeTestRoots()
    const options = {
      stateRoot: join(roots.home, '.mutil-skills/e2e/state'),
      forbiddenRoots: [roots.project],
    }
    const store = await RuntimeRunStore.open(options)
    const lock = await store.acquireRunLock('PROJECT-1', 'RUN-1')
    await store.appendJournal('PROJECT-1', 'RUN-1', {
      kind: 'run-created', digest: `sha256:${'a'.repeat(64)}`,
    })
    await store.tamperJournalForTest('PROJECT-1', 'RUN-1', 0)
    await lock.close()
    await store.close()

    await expect(RuntimeRunStore.open(options))
      .rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)
  })

  test('does not allow state storage inside a forbidden project root', async () => {
    const roots = await createRuntimeTestRoots()

    await expect(RuntimeRunStore.open({
      stateRoot: join(roots.project, '.biztest', 'runtime-state'),
      forbiddenRoots: [roots.project],
    })).rejects.toThrow(/E2E_AUTHORITY_STATE_INSIDE_TEST_WORKSPACE/)
  })

  test('accepts projectRoot as the mandatory forbidden root binding', async () => {
    const roots = await createRuntimeTestRoots()

    await expect(RuntimeRunStore.open({
      stateRoot: join(roots.project, '.biztest', 'runtime-state'),
      projectRoot: roots.project,
    })).rejects.toThrow(/E2E_AUTHORITY_STATE_INSIDE_TEST_WORKSPACE/)
  })
})
