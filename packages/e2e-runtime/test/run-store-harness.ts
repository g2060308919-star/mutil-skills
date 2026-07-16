import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { runtimeLayout } from '../src/runtime-layout.js'

export function mutateRunStoreSnapshotForTest(
  homeDir: string,
  mutation: (snapshot: Record<string, unknown>) => void,
): void {
  const database = new DatabaseSync(join(runtimeLayout(homeDir).state, 'runtime-runs.sqlite'))
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
