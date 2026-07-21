import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, test } from 'vitest'
import { projectCompilerInputFromArtifacts } from '../src/index.js'
import { assertLegacyCompilerActionSupported, compileReadOnlyProject } from '../src/compiler.js'
import { approvedCompilerArtifacts, approvedCompilerArtifactsWithBlockedCase,
  compilerArtifactVerification } from './compiler-artifacts.fixture.js'

const createdDirectories: string[] = []
const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('compileReadOnlyProject', () => {
  test('fullPlaywright action 在旧编译模板入口 fail-closed，不得落入 reversibleWrite', () => {
    expect(() => assertLegacyCompilerActionSupported({
      kind: 'fullPlaywright',
      actionId: 'ACTION-FULL-1',
      source: "test('full', async ({ page }) => { await page.goto('/') })",
      sourceDigest: `sha256:${'0'.repeat(64)}`,
      cleanupSource: "test('cleanup', async ({ page }) => { await page.goto('/cleanup') })",
      cleanupSourceDigest: `sha256:${'1'.repeat(64)}`,
      dataLeaseId: 'LEASE-1',
      cleanupPlanId: 'CLEANUP-1',
      timeoutMs: 30_000,
    })).toThrow('E2E_COMPILER_FULL_PLAYWRIGHT_UNSUPPORTED')
  })

  test('拒绝非空输出根，且不覆盖调用方已有文件', async () => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-compiler-non-fresh-'))
    createdDirectories.push(outputDir)
    await writeFile(join(outputDir, 'existing.txt'), 'owned-by-caller')
    await expect(compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    }) })).rejects.toThrow('E2E_COMPILER_OUTPUT_NOT_FRESH')
    expect(await readFile(join(outputDir, 'existing.txt'), 'utf8')).toBe('owned-by-caller')
  })

  test('generates a deterministic safe Playwright project that can be listed', async () => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-compiler-'))
    createdDirectories.push(outputDir)

    const result = await compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts(), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    }) })

    expect(result.generatedFiles).toEqual([
      'README.md',
      'evidence-policy.json',
      'fixtures/safe-page.ts',
      'network-policy.json',
      'package-lock.json',
      'package.json',
      'playwright.config.ts',
      'run-bundle.json',
      'safety-policy.json',
      'source-integrity.json',
      'template-manifest.json',
      'tests/generated.spec.ts',
      'toolchain-manifest.json',
    ])
    const packageJson = JSON.parse(await readFile(join(outputDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const [spec, fixture] = await Promise.all([
      readFile(join(outputDir, 'tests/generated.spec.ts'), 'utf8'),
      readFile(join(outputDir, 'fixtures/safe-page.ts'), 'utf8'),
    ])

    expect(packageJson.scripts).toEqual({ test: 'playwright test' })
    expect(JSON.parse(await readFile(join(outputDir, 'safety-policy.json'), 'utf8'))).toMatchObject({
      failClosed: true, runGateRequired: true, nativeNetworkForbidden: true,
    })
    expect(spec).toContain("type: 'caseId', description: \"CASE-READ-1\"")
    expect(spec).toContain("type: 'ruleId', description: \"RULE-1\"")
    expect(spec).toContain("type: 'obligationId', description: \"COV-READ-1\"")
    expect(spec).toContain("type: 'mode', description: \"real-environment\"")
    expect(spec).toContain('safePage.assertText("ACTION-READ-1"')
    expect(spec).toContain('await safePage.complete()')
    expect(fixture).toContain("url.pathname !== '/v1/read-assertion'")
    expect(fixture).toContain('JSON.stringify({ actionId, target, expected })')
    expect(fixture).toContain('readFailures.push(actionId)')
    expect(fixture).toContain("if (result.status === 'failed') readFailures.push(actionId)")
    expect(fixture).toContain('BIZTEST_READ_EXECUTION_BLOCKED')
    expect(fixture).toContain("throw new Error(`BIZTEST_READ_ASSERTION_FAILED:${readFailures.join(',')}`)")
    expect(fixture).not.toContain('page.goto')
    expect(spec).not.toMatch(/\(\{\s*page\s*\}\)|\b(child_process|globalSetup|fetch)\b/)

    const output = execFileSync(process.execPath, [playwrightCli, 'test', '--list'], { cwd: outputDir, encoding: 'utf8' })
    expect(output).toContain('CASE-READ-1 读取订单')
  })

  test('可恢复写只编译为受控 runner bridge 调用，直接 Playwright 运行在页面动作前 fail-closed', async () => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-write-compiler-'))
    createdDirectories.push(outputDir)
    await compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifacts({ effect: 'reversible-write' }), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }) })
    const [spec, fixture, runBundleText] = await Promise.all([
      readFile(join(outputDir, 'tests/generated.spec.ts'), 'utf8'),
      readFile(join(outputDir, 'fixtures/safe-page.ts'), 'utf8'),
      readFile(join(outputDir, 'run-bundle.json'), 'utf8'),
    ])
    expect(spec).toContain('safePage.reversibleWrite({"actionId":"ACTION-WRITE-1"')
    expect(spec).not.toContain('.click(')
    expect(fixture).toContain('BIZTEST_CONTROLLED_WRITE_BRIDGE_REQUIRED')
    expect(fixture).toContain("url.hostname !== '127.0.0.1'")
    expect(fixture).toContain('verifyExecutionOutcomeReceipt(receipt)')
    expect(fixture).toContain("createPublicKey({ key: publicKeyBytes, type: 'spki', format: 'der' })")
    expect(JSON.parse(runBundleText)).toMatchObject({ mode: 'controlled-reversible-write', runGateRequired: true })
    const listed = execFileSync(process.execPath, [playwrightCli, 'test', '--list'], { cwd: outputDir, encoding: 'utf8' })
    expect(listed).toContain('CASE-WRITE-1 批准订单')
    const execution = spawnSync(process.execPath, [playwrightCli, 'test'], {
      cwd: outputDir, encoding: 'utf8', env: { ...process.env, BIZTEST_RUN_BUNDLE: 'run-bundle.json' },
    })
    expect(execution.status).not.toBe(0)
    expect(`${execution.stdout}${execution.stderr}`).toContain('BIZTEST_CONTROLLED_WRITE_BRIDGE_REQUIRED')
  })

  test('blocked Case 只进入处置清单，不生成 skip/fixme 或 Playwright 测试', async () => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-blocked-compiler-'))
    createdDirectories.push(outputDir)
    await compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedCompilerArtifactsWithBlockedCase(), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }) })
    const [spec, runBundleText] = await Promise.all([
      readFile(join(outputDir, 'tests/generated.spec.ts'), 'utf8'),
      readFile(join(outputDir, 'run-bundle.json'), 'utf8'),
    ])
    expect(spec).toContain('CASE-READ-1')
    expect(spec).not.toContain('CASE-BLOCKED')
    expect(spec).not.toMatch(/\btest\s*\.\s*(?:skip|fixme|fail|only|todo)|\btest\s*\.\s*describe\s*\.\s*(?:skip|fixme|only)/)
    expect(JSON.parse(runBundleText).blockedCases).toEqual([
      { caseId: 'CASE-BLOCKED', reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED' },
    ])
    const listed = execFileSync(process.execPath, [playwrightCli, 'test', '--list'], {
      cwd: outputDir, encoding: 'utf8',
    })
    expect(listed).toContain('CASE-READ-1')
    expect(listed).not.toContain('CASE-BLOCKED')
  })
})
