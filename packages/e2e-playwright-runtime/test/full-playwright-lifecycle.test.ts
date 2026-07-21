import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import ts from 'typescript'
import { afterAll, describe, expect, test } from 'vitest'
import { compileReadOnlyProject } from '../src/compiler.js'
import { projectCompilerInputFromArtifacts } from '../src/index.js'
import {
  approvedFullPlaywrightCompilerArtifacts,
  compilerArtifactVerification,
} from './compiler-artifacts.fixture.js'

type Execute = (input: {
  run: () => Promise<unknown>
  cleanup: () => Promise<unknown>
  retire: () => Promise<void>
  programTimeoutMs: number
  cleanupTimeoutMs: number
}) => Promise<void>

let generatedDirectory: string | undefined
let runtimePromise: Promise<{ executeFullPlaywrightAction?: Execute }> | undefined

async function runtime(): Promise<{ executeFullPlaywrightAction?: Execute }> {
  runtimePromise ??= (async () => {
    generatedDirectory = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-full-runtime-test-'))
    const result = await compileReadOnlyProject({ outputDir: generatedDirectory,
      compilerInput: projectCompilerInputFromArtifacts({
        artifacts: approvedFullPlaywrightCompilerArtifacts(), playwrightVersion: '1.61.1',
        ...compilerArtifactVerification,
      }) })
    if (!result.generatedFiles.includes('fixtures/full-playwright-runtime.ts')) return {}
    const source = await readFile(join(generatedDirectory, 'fixtures/full-playwright-runtime.ts'), 'utf8')
    const emitted = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    } }).outputText
    const modulePath = join(generatedDirectory, 'full-playwright-runtime.mjs')
    await writeFile(modulePath, emitted)
    return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`) as Promise<{ executeFullPlaywrightAction: Execute }>
  })()
  return runtimePromise
}

async function capture(operation: () => Promise<void>): Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown }> {
  try { await operation(); return { status: 'fulfilled' } } catch (error) { return { status: 'rejected', error } }
}

afterAll(async () => {
  if (generatedDirectory) await rm(generatedDirectory, { recursive: true, force: true })
})

describe('generated full Playwright lifecycle runtime', () => {
  test('success：program 与 verified cleanup 顺序完成', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const events: string[] = []
    const result = await capture(() => execute!({
      run: async () => { events.push('run') },
      cleanup: async () => { events.push('cleanup'); return 'verified-clean' },
      retire: async () => { events.push('retire') }, programTimeoutMs: 100, cleanupTimeoutMs: 100,
    }))
    expect(result).toEqual({ status: 'fulfilled' })
    expect(events).toEqual(['run', 'cleanup'])
  })

  test('primary only：cleanup 后保留原始失败', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const primary = new Error('primary')
    const result = await capture(() => execute!({
      run: async () => { throw primary }, cleanup: async () => 'verified-clean', retire: async () => {},
      programTimeoutMs: 100, cleanupTimeoutMs: 100,
    }))
    expect(result).toEqual({ status: 'rejected', error: primary })
  })

  test('cleanup only：传播 cleanup 失败', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const cleanup = new Error('cleanup')
    const result = await capture(() => execute!({
      run: async () => {}, cleanup: async () => { throw cleanup }, retire: async () => {},
      programTimeoutMs: 100, cleanupTimeoutMs: 100,
    }))
    expect(result).toEqual({ status: 'rejected', error: cleanup })
  })

  test('both：稳定 AggregateError 同时保留 primary 与 cleanup', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const primary = new Error('primary')
    const cleanup = new Error('cleanup')
    const result = await capture(() => execute!({
      run: async () => { throw primary }, cleanup: async () => { throw cleanup }, retire: async () => {},
      programTimeoutMs: 100, cleanupTimeoutMs: 100,
    }))
    expect(result.status).toBe('rejected')
    const error = (result as { status: 'rejected'; error: AggregateError }).error
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe('BIZTEST_FULL_PLAYWRIGHT_PROGRAM_AND_CLEANUP_FAILED')
    expect(error.errors).toEqual([primary, cleanup])
  })

  test('throw undefined 仍由显式 caught flag 作为 primary failure 传播', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const result = await capture(() => execute!({
      run: async () => { throw undefined }, cleanup: async () => 'verified-clean', retire: async () => {},
      programTimeoutMs: 100, cleanupTimeoutMs: 100,
    }))
    expect(result).toEqual({ status: 'rejected', error: undefined })
  })

  test('program deadline 后仍执行独立 cleanup，再关闭 context 并报告 outcome unknown', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const events: string[] = []
    const result = await capture(() => execute!({
      run: () => new Promise(() => { events.push('run') }),
      cleanup: async () => { events.push('cleanup'); return 'verified-clean' },
      retire: async () => { events.push('retire') }, programTimeoutMs: 10, cleanupTimeoutMs: 100,
    }))
    expect(events).toEqual(['run', 'cleanup', 'retire'])
    expect(result).toEqual({ status: 'rejected', error: expect.objectContaining({
      message: 'BIZTEST_FULL_PLAYWRIGHT_PROGRAM_TIMEOUT_OUTCOME_UNKNOWN',
    }) })
  })

  test('cleanup 使用独立 deadline；超时后退休 context', async () => {
    const execute = (await runtime()).executeFullPlaywrightAction
    expect(execute).toBeTypeOf('function')
    const events: string[] = []
    const result = await capture(() => execute!({
      run: async () => { events.push('run') },
      cleanup: () => new Promise(() => { events.push('cleanup') }),
      retire: async () => { events.push('retire') }, programTimeoutMs: 100, cleanupTimeoutMs: 10,
    }))
    expect(events).toEqual(['run', 'cleanup', 'retire'])
    expect(result).toEqual({ status: 'rejected', error: expect.objectContaining({
      message: 'BIZTEST_FULL_PLAYWRIGHT_CLEANUP_TIMEOUT_OUTCOME_UNKNOWN',
    }) })
  })
})
