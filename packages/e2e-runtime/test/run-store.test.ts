import { createWorkflow } from '@mutil-skills/e2e-engine'
import { chmod, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  installRunStoreCommitAbortForTest,
  mutateRunStoreSnapshotForTest,
  removeRunStoreCommitAbortForTest,
} from './run-store-harness.js'
import {
  RuntimeRunStore,
  type RuntimeRunSnapshot,
  type RuntimeRunStoreOptions,
} from '../src/run-store.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

describe('runtime run store', () => {
  test('derives the exact secure user state root from homeDir', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    await store.close()

    await expect(RuntimeRunStore.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      stateRoot: roots.project,
    } as RuntimeRunStoreOptions & { stateRoot: string }))
      .rejects.toThrow(/E2E_RUNTIME_STATE_CONFIG_INVALID/)

    await expect(RuntimeRunStore.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      testHooks: { beforeResponseLedgerCommit: () => undefined },
    } as RuntimeRunStoreOptions & { testHooks: object }))
      .rejects.toThrow(/E2E_RUNTIME_STATE_CONFIG_INVALID/)
  })

  test('rejects permissive or symlinked user state roots', async () => {
    const permissive = await createRuntimeTestRoots()
    const permissiveState = join(permissive.home, '.mutil-skills/e2e/state')
    await mkdir(permissiveState, { recursive: true })
    await chmod(permissiveState, 0o755)
    await expect(openStore(permissive)).rejects.toThrow(/E2E_RUNTIME_STATE_PERMISSIONS_INVALID/)

    const permissiveParent = await createRuntimeTestRoots()
    const privateState = join(permissiveParent.home, '.mutil-skills/e2e/state')
    await mkdir(privateState, { recursive: true, mode: 0o700 })
    await chmod(join(permissiveParent.home, '.mutil-skills'), 0o755)
    await expect(openStore(permissiveParent))
      .rejects.toThrow(/E2E_RUNTIME_STATE_PERMISSIONS_INVALID/)

    const linked = await createRuntimeTestRoots()
    const e2eRoot = join(linked.home, '.mutil-skills/e2e')
    const outside = join(linked.root, 'outside-state')
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 })
    await mkdir(outside)
    await symlink(outside, join(e2eRoot, 'state'))
    await expect(openStore(linked)).rejects.toThrow(/E2E_RUNTIME_STATE_SYMLINK_FORBIDDEN/)
  })

  test('reserves request ids globally before business and rejects byte rebinding', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)

    await expect(store.beginRequest('REQUEST-1', digest('a'))).resolves.toEqual({ kind: 'pending' })
    await expect(store.beginRequest('REQUEST-1', digest('b')))
      .rejects.toThrow(/E2E_RUNTIME_REQUEST_REPLAY_MISMATCH/)
    await expect(store.completeGlobalRequest('REQUEST-1', digest('a'), { ok: false }))
      .resolves.toEqual({ ok: false })
    await expect(store.beginRequest('REQUEST-1', digest('a')))
      .resolves.toEqual({ kind: 'replay', response: { ok: false } })
    await store.close()
  })

  test('commits run creation, journal, and response as one outcome or aborts all three', async () => {
    const roots = await createRuntimeTestRoots()
    const requestDigest = digest('a')
    const aborting = await openStore(roots)
    await aborting.beginRequest('REQUEST-CREATE', requestDigest)
    const abortingLock = await aborting.acquireRunLock(digest('1'), 'RUN-1')
    installRunStoreCommitAbortForTest(roots.home)
    await expect(aborting.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', requestDigest, { ok: true, result: 'created' },
      abortingLock,
    )).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(roots.home)
    await expect(aborting.getRun(digest('1'), 'RUN-1')).resolves.toBeUndefined()
    await expect(aborting.beginRequest('REQUEST-CREATE', requestDigest)).resolves.toEqual({ kind: 'pending' })
    await abortingLock.close()
    await aborting.close()

    const retry = await openStore(roots)
    const retryLock = await retry.acquireRunLock(digest('1'), 'RUN-1')
    await expect(retry.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', requestDigest, { ok: true, result: 'created' },
      retryLock,
    )).resolves.toEqual({ ok: true, result: 'created' })
    await expect(retry.beginRequest('REQUEST-CREATE', requestDigest)).resolves.toEqual({
      kind: 'replay', response: { ok: true, result: 'created' },
    })
    await expect(retry.getRun(digest('1'), 'RUN-1')).resolves.toMatchObject({ runId: 'RUN-1' })
    await retryLock.close()
    await retry.close()
  })

  test('commits run update and response atomically across an injected abort', async () => {
    const roots = await createRuntimeTestRoots()
    const setup = await openStore(roots)
    await setup.beginRequest('REQUEST-CREATE', digest('a'))
    const setupLock = await setup.acquireRunLock(digest('1'), 'RUN-1')
    await setup.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', digest('a'), { ok: true }, setupLock,
    )
    await setupLock.close()
    await setup.beginRequest('REQUEST-UPDATE', digest('b'))
    await setup.close()

    const aborting = await openStore(roots)
    const abortingLock = await aborting.acquireRunLock(digest('1'), 'RUN-1')
    installRunStoreCommitAbortForTest(roots.home)
    await expect(aborting.updateRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-UPDATE', digest('b'),
      (snapshot) => ({
        snapshot: { ...snapshot, artifactDigests: { ...snapshot.artifactDigests, updated: digest('c') } },
        response: { ok: true, result: 'updated' },
      }),
      'candidate-accepted',
      abortingLock,
    )).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(roots.home)
    await expect(aborting.getRun(digest('1'), 'RUN-1'))
      .resolves.not.toHaveProperty('artifactDigests.updated')
    await abortingLock.close()
    await aborting.close()

    const retry = await openStore(roots)
    const retryLock = await retry.acquireRunLock(digest('1'), 'RUN-1')
    await expect(retry.updateRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-UPDATE', digest('b'),
      (snapshot) => ({
        snapshot: { ...snapshot, artifactDigests: { ...snapshot.artifactDigests, updated: digest('c') } },
        response: { ok: true, result: 'updated' },
      }),
      'candidate-accepted',
      retryLock,
    )).resolves.toEqual({ ok: true, result: 'updated' })
    await retryLock.close()
    await retry.close()
  })

  test('projects status and records its fixed response from one transaction snapshot', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    await store.beginRequest('REQUEST-CREATE', digest('a'))
    const createLock = await store.acquireRunLock(digest('1'), 'RUN-1')
    await store.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', digest('a'), { ok: true }, createLock,
    )
    await createLock.close()
    await store.beginRequest('REQUEST-STATUS', digest('d'))
    const statusLock = await store.acquireRunLock(digest('1'), 'RUN-1')

    await expect(store.readRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-STATUS', digest('d'),
      (snapshot) => ({ ok: true, result: { sequence: snapshot.workflow.sequence } }),
      statusLock,
    )).resolves.toEqual({ ok: true, result: { sequence: 0 } })
    await expect(store.beginRequest('REQUEST-STATUS', digest('d'))).resolves.toEqual({
      kind: 'replay', response: { ok: true, result: { sequence: 0 } },
    })
    await expect(store.getRun(digest('1'), 'RUN-1'))
      .resolves.toHaveProperty('requestResponses.REQUEST-STATUS')
    await statusLock.close()
    await store.close()
  })

  test('run lock uses a persisted process nonce lease', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    const lock = await store.acquireRunLock(digest('1'), 'RUN-1')
    await expect(store.acquireRunLock(digest('1'), 'RUN-1')).rejects.toThrow(/E2E_RUNTIME_RUN_LOCKED/)
    await lock.close()
    await store.close()
  })

  test('retries lease release when persistence fails', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    const lock = await store.acquireRunLock(digest('1'), 'RUN-1')
    installRunStoreCommitAbortForTest(roots.home)
    await expect(lock.close()).rejects.toThrow(/TEST_KILL_POINT/)
    removeRunStoreCommitAbortForTest(roots.home)

    await expect(lock.close()).resolves.toBeUndefined()
    const next = await store.acquireRunLock(digest('1'), 'RUN-1')
    await next.close()
    await store.close()
  })

  test('only the current persisted lease owner may mutate across store instances', async () => {
    const roots = await createRuntimeTestRoots()
    let now = new Date('2026-07-17T00:00:00.000Z')
    const options = {
      homeDir: roots.home,
      projectRoot: roots.project,
      now: () => now,
      leaseMilliseconds: 1_000,
    }
    const first = await RuntimeRunStore.open(options)
    const second = await RuntimeRunStore.open(options)

    await first.beginRequest('REQUEST-CREATE', digest('a'))
    const createLock = await first.acquireRunLock(digest('1'), 'RUN-1')
    await expect(second.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', digest('a'), { ok: true }, createLock,
    )).rejects.toThrow(/E2E_RUNTIME_RUN_LEASE_FENCED/)
    await first.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', digest('a'), { ok: true }, createLock,
    )
    await createLock.close()

    const firstOwner = await first.acquireRunLock(digest('1'), 'RUN-1')
    await second.beginRequest('REQUEST-READ-FOREIGN', digest('d'))
    await expect(second.readRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-READ-FOREIGN', digest('d'),
      (snapshot) => ({ runId: snapshot.runId }), firstOwner,
    )).rejects.toThrow(/E2E_RUNTIME_RUN_LEASE_FENCED/)
    await second.beginRequest('REQUEST-FOREIGN', digest('b'))
    await expect(second.updateRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-FOREIGN', digest('b'), unchangedOutcome,
      'foreign-update', firstOwner,
    )).rejects.toThrow(/E2E_RUNTIME_RUN_LEASE_FENCED/)
    await expect(second.acquireRunLock(digest('1'), 'RUN-1'))
      .rejects.toThrow(/E2E_RUNTIME_RUN_LOCKED/)

    now = new Date('2026-07-17T00:00:02.000Z')
    const secondOwner = await second.acquireRunLock(digest('1'), 'RUN-1')
    await first.beginRequest('REQUEST-STALE', digest('c'))
    await expect(first.updateRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-STALE', digest('c'), unchangedOutcome,
      'stale-update', firstOwner,
    )).rejects.toThrow(/E2E_RUNTIME_RUN_LEASE_FENCED/)

    await second.updateRunOutcome(
      digest('1'), 'RUN-1', 'REQUEST-FOREIGN', digest('b'), unchangedOutcome,
      'current-update', secondOwner,
    )
    await firstOwner.close()
    await secondOwner.close()
    await first.close()
    await second.close()
  })

  test('startup rejects a deleted run and journal retained by its global outcome', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    await store.beginRequest('REQUEST-CREATE', digest('a'))
    const lock = await store.acquireRunLock(digest('1'), 'RUN-1')
    await store.createRunOutcome(runSnapshot(), 'REQUEST-CREATE', digest('a'), { ok: true }, lock)
    await lock.close()
    await store.close()

    mutateRunStoreSnapshotForTest(roots.home, (snapshot) => {
      const runs = snapshot.runs as Record<string, unknown>
      const journals = snapshot.journals as Record<string, unknown>
      const key = `${digest('1')}\0RUN-1`
      delete runs[key]
      delete journals[key]
    })
    await expect(openStore(roots)).rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)
  })

  test('startup rejects deleted global history retained by a Run response', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    await store.beginRequest('REQUEST-CREATE', digest('a'))
    const lock = await store.acquireRunLock(digest('1'), 'RUN-1')
    await store.createRunOutcome(
      runSnapshot(), 'REQUEST-CREATE', digest('a'), { ok: true }, lock,
    )
    await lock.close()
    await store.close()

    mutateRunStoreSnapshotForTest(roots.home, (snapshot) => {
      const ledger = snapshot.globalLedger as {
        entries: Record<string, unknown>
        journal: unknown[]
      }
      delete ledger.entries['REQUEST-CREATE']
      ledger.journal.splice(-2)
    })
    await expect(openStore(roots)).rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)
  })

  test('startup rejects global ledger or global journal deletion', async () => {
    const responseDeleted = await createRuntimeTestRoots()
    const first = await openStore(responseDeleted)
    await first.beginRequest('REQUEST-1', digest('a'))
    await first.completeGlobalRequest('REQUEST-1', digest('a'), { ok: false })
    await first.close()
    mutateRunStoreSnapshotForTest(responseDeleted.home, (snapshot) => {
      const ledger = snapshot.globalLedger as { entries: Record<string, unknown> }
      delete ledger.entries['REQUEST-1']
    })
    await expect(openStore(responseDeleted)).rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)

    const journalDeleted = await createRuntimeTestRoots()
    const second = await openStore(journalDeleted)
    await second.beginRequest('REQUEST-1', digest('a'))
    await second.completeGlobalRequest('REQUEST-1', digest('a'), { ok: false })
    await second.close()
    mutateRunStoreSnapshotForTest(journalDeleted.home, (snapshot) => {
      const ledger = snapshot.globalLedger as { journal: unknown[] }
      ledger.journal.pop()
    })
    await expect(openStore(journalDeleted)).rejects.toThrow(/E2E_RUNTIME_JOURNAL_INTEGRITY_FAILED/)
  })

  test('does not expose a production journal tamper method', async () => {
    const roots = await createRuntimeTestRoots()
    const store = await openStore(roots)
    expect('tamperJournalForTest' in store).toBe(false)
    await store.close()
  })
})

async function openStore(roots: { home: string; project: string }): Promise<RuntimeRunStore> {
  return await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
}

function runSnapshot(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.0.0',
    runId: 'RUN-1',
    assetId: 'ASSET-1',
    projectIdentityDigest: digest('1'),
    runtimeInstallationDigest: digest('2'),
    workflow: createWorkflow(),
    artifactDigests: { 'prd-source': digest('3') },
    requestResponses: {},
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  }
}

function unchangedOutcome(snapshot: RuntimeRunSnapshot) {
  return { snapshot, response: { ok: true } }
}
