import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertExpectedRegressionSourceSet,
  readRegressionSourceSet,
} from '../src/regression-source-set.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('密封 Regression Source Set', () => {
  test('从磁盘实际 bytes 枚举完整集合，并拒绝额外人工源码', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-source-set-'))
    directories.push(root)
    await mkdir(join(root, 'tests'))
    await writeFile(join(root, 'tests', 'generated.spec.ts'), 'trusted')
    let files = await readRegressionSourceSet(root, 'regression')
    expect(files.map((file) => file.relativePath)).toEqual(['regression/tests/generated.spec.ts'])
    expect(() => assertExpectedRegressionSourceSet(files, ['tests/generated.spec.ts'])).not.toThrow()

    await writeFile(join(root, 'tests', 'manual.spec.ts'), 'process.env.HOME')
    files = await readRegressionSourceSet(root, 'regression')
    expect(() => assertExpectedRegressionSourceSet(files, ['tests/generated.spec.ts']))
      .toThrow('E2E_COMPILER_UNATTESTED_SOURCE')
  })

  test('拒绝符号链接、硬链接和非普通文件', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-source-link-'))
    const outside = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-source-outside-'))
    directories.push(root, outside)
    await writeFile(join(outside, 'secret'), 'secret')
    await symlink(join(outside, 'secret'), join(root, 'linked'))
    await expect(readRegressionSourceSet(root, 'regression')).rejects.toThrow('E2E_COMPILER_PATH_ESCAPE')
    await rm(join(root, 'linked'))
    await link(join(outside, 'secret'), join(root, 'hard-linked'))
    await expect(readRegressionSourceSet(root, 'regression')).rejects.toThrow('E2E_COMPILER_PATH_ESCAPE')
  })
})
