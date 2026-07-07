import { readFile } from 'node:fs/promises'
import { describe, expect, test, vi } from 'vitest'
import { createVitestConfig, resolveTestingDefaults, runTests, type CommandExecutor } from '../src/testing/index.js'

describe('foundation testing API', () => {
  test('resolves Vitest defaults without exposing a generic foundation API', () => {
    expect(resolveTestingDefaults()).toEqual({
      runner: 'vitest',
      environment: 'node',
      testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', 'tests/**/*.ts', 'test/**/*.ts', '__tests__/**/*.ts'],
    })
  })

  test('creates Vitest config content from template defaults', async () => {
    expect(createVitestConfig({ environment: 'node', include: ['tests/**/*.ts'] })).toContain("'tests/**/*.ts'")
  })

  test('runTests invokes Vitest with cwd, watch, coverage, passWithNoTests and extra args', async () => {
    const executor = vi.fn<CommandExecutor>(async () => 0)

    await expect(runTests({
      cwd: '/project',
      watch: true,
      coverage: true,
      passWithNoTests: true,
      args: ['--reporter=dot'],
      executor,
    })).resolves.toEqual({ runner: 'vitest', exitCode: 0 })

    expect(executor).toHaveBeenCalledTimes(1)
    const [command, args, options] = executor.mock.calls[0]
    expect(command).toBe(process.execPath)
    expect(args[0]).toMatch(/vitest\.mjs$/)
    expect(args.slice(1)).toEqual(['--environment=node', '--watch', '--coverage', '--passWithNoTests', '--reporter=dot'])
    expect(options).toEqual({ cwd: '/project' })
  })

  test('foundation package has Vitest as dependency and no bin', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    expect(pkg.dependencies.vitest).toBeTruthy()
    expect(pkg.bin).toBeUndefined()
  })
})
