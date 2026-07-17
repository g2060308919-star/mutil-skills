import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { runtimeLayout } from '../src/runtime-layout.js'

const TEST_ABORT_TRIGGER = 'runtime_store_test_abort_commit'

export function installRunStoreCommitAbortForTest(homeDir: string): void {
  const database = openRunStoreDatabase(homeDir)
  try {
    database.exec(`
      CREATE TRIGGER ${TEST_ABORT_TRIGGER}
      BEFORE UPDATE OF snapshot ON authority_snapshots
      WHEN OLD.namespace = 'e2e-runtime-runs/v1'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_KILL_POINT');
      END;
    `)
  } finally {
    database.close()
  }
}

export function removeRunStoreCommitAbortForTest(homeDir: string): void {
  const database = openRunStoreDatabase(homeDir)
  try {
    database.exec(`DROP TRIGGER IF EXISTS ${TEST_ABORT_TRIGGER}`)
  } finally {
    database.close()
  }
}

export function mutateRunStoreSnapshotForTest(
  homeDir: string,
  mutation: (snapshot: Record<string, unknown>) => void,
): void {
  const database = openRunStoreDatabase(homeDir)
  try {
    const row = database.prepare(
      'SELECT snapshot FROM authority_snapshots WHERE namespace = ?',
    ).get('e2e-runtime-runs/v1') as { snapshot?: unknown } | undefined
    if (typeof row?.snapshot !== 'string') throw new Error('missing runtime snapshot')
    const snapshot = JSON.parse(row.snapshot) as Record<string, unknown>
    mutation(snapshot)
    database.prepare(
      'UPDATE authority_snapshots SET snapshot = ?, revision = revision + 1 WHERE namespace = ?',
    ).run(canonicalizeJson(snapshot), 'e2e-runtime-runs/v1')
  } finally {
    database.close()
  }
}

export function readRunStoreSnapshotForTest(homeDir: string): Record<string, unknown> {
  const database = openRunStoreDatabase(homeDir)
  try {
    const row = database.prepare(
      'SELECT snapshot FROM authority_snapshots WHERE namespace = ?',
    ).get('e2e-runtime-runs/v1') as { snapshot?: unknown } | undefined
    if (typeof row?.snapshot !== 'string') throw new Error('missing runtime snapshot')
    return JSON.parse(row.snapshot) as Record<string, unknown>
  } finally {
    database.close()
  }
}

function openRunStoreDatabase(homeDir: string): DatabaseSync {
  return new DatabaseSync(join(runtimeLayout(homeDir).state, 'runtime-runs.sqlite'))
}
