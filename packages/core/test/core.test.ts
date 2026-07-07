import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  detectPackageManager,
  mergePackageScripts,
  readJsonFile,
  scanFiles,
  stableStringifyJson,
  writeJsonFile,
} from '../src/index.js'

describe('core json utilities', () => {
  test('writes JSON with stable formatting and sorted object keys', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await mkdir(cwd, { recursive: true })
    const path = join(cwd, 'package.json')

    await writeJsonFile(path, { z: 1, a: { d: true, b: false } })

    expect(await readFile(path, 'utf8')).toBe('{\n  "a": {\n    "b": false,\n    "d": true\n  },\n  "z": 1\n}\n')
    expect(await readJsonFile(path)).toEqual({ a: { b: false, d: true }, z: 1 })
  })

  test('stableStringifyJson preserves array order', () => {
    expect(stableStringifyJson({ list: [{ b: 2, a: 1 }] })).toBe('{\n  "list": [\n    {\n      "a": 1,\n      "b": 2\n    }\n  ]\n}\n')
  })
})

describe('core package utilities', () => {
  test('mergePackageScripts adds missing scripts without overwriting existing scripts', () => {
    const result = mergePackageScripts(
      { scripts: { test: 'jest' } },
      { test: 'repo-test', 'test:watch': 'repo-test --watch' },
    )

    expect(result.packageJson.scripts).toEqual({ test: 'jest', 'test:watch': 'repo-test --watch' })
    expect(result.added).toEqual(['test:watch'])
    expect(result.skipped).toEqual(['test'])
  })

  test('detectPackageManager prefers lockfiles in deterministic order', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'pnpm-lock.yaml'), '')
    await writeFile(join(cwd, 'package-lock.json'), '')

    expect(await detectPackageManager(cwd)).toBe('pnpm')
  })
})

describe('core path scanning', () => {
  test('scanFiles ignores node_modules and returns normalized relative paths', async ({ task }) => {
    const cwd = join(process.cwd(), '.tmp', task.id)
    await mkdir(join(cwd, 'src'), { recursive: true })
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(cwd, 'src', 'unit.test.ts'), '')
    await writeFile(join(cwd, 'node_modules', 'pkg', 'ignored.test.ts'), '')

    await expect(scanFiles(cwd, ['**/*.test.ts'])).resolves.toEqual(['src/unit.test.ts'])
  })
})
