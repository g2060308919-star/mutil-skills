import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const race = vi.hoisted(() => ({ target: '', original: '', replacement: Buffer.from('REPLACEMENT-CANARY') }))

vi.mock('node:sqlite', async () => {
  const actual = await vi.importActual<typeof import('node:sqlite')>('node:sqlite')
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    DatabaseSync: function DatabaseSync(path: string, ...options: unknown[]) {
      if (path === race.target) {
        fs.renameSync(race.target, race.original)
        fs.writeFileSync(race.target, race.replacement, { mode: 0o600 })
      }
      return Reflect.construct(actual.DatabaseSync, [path, ...options])
    },
  }
})

const directories: string[] = []

afterEach(async () => {
  race.target = ''
  race.original = ''
  await Promise.all(directories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true })))
})

test('pathname leaf 在 fd 预检后被同 UID 替换时 fail closed，且不继续初始化替换文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-sqlite-leaf-race-'))
  directories.push(directory)
  race.target = join(directory, 'authority.sqlite')
  race.original = join(directory, 'authority-original.sqlite')

  const { SqliteSnapshotStore } = await import('../src/sqlite-state-store.js')
  expect(() => new SqliteSnapshotStore(
    race.target,
    'leaf-race-test',
    { forbiddenRoots: ['/dev'] },
  )).toThrow('E2E_AUTHORITY_STATE_LEAF_REBOUND')

  expect(await readFile(race.target)).toEqual(race.replacement)
  expect((await stat(race.target)).mode & 0o777).toBe(0o600)
  expect((await stat(race.original)).size).toBe(0)
})
