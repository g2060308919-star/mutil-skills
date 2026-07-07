import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { renderTemplate } from '@mutil-skills/template'

const require = createRequire(import.meta.url)

export type TestRunner = 'vitest' | 'jest'

export interface RunTestsOptions {
  cwd: string
  watch?: boolean
  coverage?: boolean
  passWithNoTests?: boolean
  args?: string[]
  executor?: CommandExecutor
}

export interface RunTestsResult {
  runner: TestRunner
  exitCode: number
}

export interface TestingDefaults {
  runner: 'vitest'
  environment: 'node'
  testFilePatterns: string[]
}

export type CommandExecutor = (command: string, args: string[], options: { cwd: string }) => Promise<number>

export function resolveTestingDefaults(): TestingDefaults {
  return {
    runner: 'vitest',
    environment: 'node',
    testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', 'tests/**/*.ts', 'test/**/*.ts', '__tests__/**/*.ts'],
  }
}

export function createVitestConfig(options: {
  environment?: 'node'
  include?: string[]
} = {}): string {
  return renderTemplate('foundation.testing.vitest-config', {
    environment: options.environment ?? 'node',
    include: options.include ?? ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
  })
}

export async function runTests(options: RunTestsOptions): Promise<RunTestsResult> {
  const args: string[] = ['--environment=node']
  if (options.watch) args.push('--watch')
  if (options.coverage) args.push('--coverage')
  if (options.passWithNoTests) args.push('--passWithNoTests')
  args.push(...(options.args ?? []))

  const executor = options.executor ?? spawnExecutor
  const exitCode = await executor(process.execPath, [resolveVitestBin(), ...args], { cwd: options.cwd })
  return { runner: 'vitest', exitCode }
}

function resolveVitestBin(): string {
  return require.resolve('vitest/vitest.mjs')
}

async function spawnExecutor(command: string, args: string[], options: { cwd: string }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (error) => {
      console.error(`启动 test runner 失败：${error.message}`)
      resolve(1)
    })
  })
}
