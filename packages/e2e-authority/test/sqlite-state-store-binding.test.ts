import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const race = vi.hoisted(() => ({
  calls: 0,
  originalPath: '',
  targetPath: '',
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    statSync: (...arguments_: Parameters<typeof actual.statSync>) => {
      const path = String(arguments_[0])
      if (path === race.targetPath) {
        race.calls += 1
        if (race.calls === 2) {
          actual.renameSync(race.targetPath, race.originalPath)
          actual.mkdirSync(race.targetPath, { mode: 0o700 })
        }
      }
      return actual.statSync(...arguments_)
    },
  }
})

const directories: string[] = []

afterEach(async () => {
  race.calls = 0
  race.originalPath = ''
  race.targetPath = ''
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('revalidates the physical state directory after SQLite opens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-sqlite-open-race-'))
  directories.push(directory)
  const stateDirectory = join(directory, 'state')
  await mkdir(stateDirectory, { mode: 0o700 })
  const metadata = await stat(stateDirectory)
  const expectedStateDirectory = {
    realPath: await realpath(stateDirectory),
    device: String(metadata.dev),
    inode: String(metadata.ino),
  }
  race.targetPath = stateDirectory
  race.originalPath = join(directory, 'state-original')

  const { SqliteSnapshotStore } = await import('../src/sqlite-state-store.js')
  expect(() => new SqliteSnapshotStore(
    join(stateDirectory, 'authority.sqlite'),
    'post-open-state-binding-test',
    { forbiddenRoots: ['/dev'], expectedStateDirectory },
  )).toThrow('E2E_AUTHORITY_STATE_DIRECTORY_REBOUND')
})
