import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ensureVitestTempRoot } from './vitest-global-setup.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Vitest 全局临时目录', () => {
  test('在干净 checkout 中幂等创建仓库级 .tmp 父目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-vitest-setup-'))
    directories.push(root)

    await ensureVitestTempRoot(root)
    await ensureVitestTempRoot(root)

    expect((await stat(join(root, '.tmp'))).isDirectory()).toBe(true)
  })
})
