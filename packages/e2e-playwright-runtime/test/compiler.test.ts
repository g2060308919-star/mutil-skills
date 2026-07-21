import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, test } from 'vitest'
import { projectCompilerInputFromArtifacts } from '../src/index.js'
import { compileReadOnlyProject } from '../src/compiler.js'
import { approvedCompilerArtifacts, approvedCompilerArtifactsWithBlockedCase,
  approvedFullPlaywrightCompilerArtifacts, compilerArtifactVerification,
  FULL_PLAYWRIGHT_CLEANUP_SOURCE, FULL_PLAYWRIGHT_SOURCE } from './compiler-artifacts.fixture.js'

const createdDirectories: string[] = []
const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('compileReadOnlyProject', () => {
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

  test('full Playwright 程序逐字进入确定性测试模板且相同输入 byte-identical', async () => {
    const first = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-full-compiler-a-'))
    const second = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-full-compiler-b-'))
    createdDirectories.push(first, second)
    const artifacts = approvedFullPlaywrightCompilerArtifacts()
    const compile = (outputDir: string) => compileReadOnlyProject({ outputDir,
      compilerInput: projectCompilerInputFromArtifacts({ artifacts, playwrightVersion: '1.61.1',
        ...compilerArtifactVerification }) })
    const [firstResult, secondResult] = await Promise.all([compile(first), compile(second)])
    expect(firstResult.sourceDigests).toEqual(secondResult.sourceDigests)
    for (const relativePath of firstResult.generatedFiles) {
      expect(await readFile(join(first, relativePath))).toEqual(await readFile(join(second, relativePath)))
    }
    const spec = await readFile(join(first, 'tests/generated.spec.ts'), 'utf8')
    expect(spec).toContain(FULL_PLAYWRIGHT_SOURCE)
    expect(spec).toContain(FULL_PLAYWRIGHT_CLEANUP_SOURCE)
    expect(spec).toContain("`todo-${state.seed ?? 'fixed'}`")
    expect(spec).toContain('async ({ page, context, request }, testInfo) =>')
    expect(spec).toContain('browser: context.browser()!')
    expect(spec).toContain('executeFullPlaywrightAction({')
    expect(spec).toContain('const __biztestRun0 = async')
    expect(spec).toContain('const __biztestCleanup0 = async')
    expect(spec).toContain('const __biztestRetire = Object.freeze(context.close.bind(context))')
    expect(spec).not.toContain('async function runProgram0')
    expect(spec).not.toContain('safePage.reversibleWrite')
    expect(JSON.parse(await readFile(join(first, 'run-bundle.json'), 'utf8'))).toMatchObject({
      executionProfile: 'full-playwright', mode: 'full-playwright',
    })
    expect(JSON.parse(await readFile(join(first, 'safety-policy.json'), 'utf8'))).toMatchObject({
      executionProfile: 'full-playwright',
      executionOutcomeReceipt: 'independent-ed25519-verification-required',
      programTimeoutOutcome: 'unknown',
      programTimeoutContext: 'retired-before-cleanup',
      sameContextCleanupAfterProgramTimeout: 'forbidden',
      leaseAfterProgramTimeout: 'quarantine',
      retryAfterProgramTimeout: 'forbidden',
      independentCleanupSession: 'task4-required',
    })
    expect(JSON.parse(await readFile(join(first, 'toolchain-manifest.json'), 'utf8')).typescriptVersion).toBe('5.9.3')
    expect(JSON.parse(await readFile(join(first, 'template-manifest.json'), 'utf8'))).toMatchObject({
      executionProfile: 'full-playwright', actionKinds: ['fullPlaywright'],
    })
    const listed = execFileSync(process.execPath, [playwrightCli, 'test', '--list'], { cwd: first, encoding: 'utf8' })
    expect(listed).toContain('CASE-WRITE-1 批准订单')
  })

  test.each([
    ["}\ntest.afterEach(() => {})\nif (true) {", '直接闭合 wrapper'],
    ["}/* close */\ntest.afterEach(() => {})\nif (true) {", 'comment trivia 闭合 wrapper'],
    ["}\ntest.afterEach(() => {})\nconst injected = `", 'template literal 吞掉 wrapper'],
    ["test.afterEach(() => {})", '函数体内注册 hook'],
    ["const hook = test['afterEach']; hook(() => {})", 'computed hook alias'],
    ["const suite = test; suite.afterEach(() => {})", 'test object alias'],
    ["Reflect.get(Object, 'create')", 'Reflect meta operation'],
    ["Object.getOwnPropertyDescriptor(async () => {}, 'constructor')", 'descriptor constructor escape'],
    ["const key = 'constructor'; ({})[key]", 'computed sensitive property'],
    ["globalThis['Object']['getPrototypeOf'](async () => {})", 'host Object property chain'],
    ["globalThis['Promise'].race = async () => 'forged'", 'primordial property monkeypatch'],
    ["__biztestCleanup0 = async () => 'verified-clean'", 'compiler-reserved binding'],
  ])('full Playwright source/cleanup 不能逃逸 FunctionBody 或注册 hook：%s', async (source) => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-full-fragment-'))
    createdDirectories.push(outputDir)
    await expect(compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts({ source }), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }) })).rejects.toThrow('不是密封 FunctionBody')
  })

  test('full Playwright cleanup 也按 FunctionBody 严格验证', async () => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-full-cleanup-fragment-'))
    createdDirectories.push(outputDir)
    await expect(compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts({
        cleanupSource: "}\ntest.afterEach(() => {})\nif (true) {",
      }), playwrightVersion: '1.61.1', ...compilerArtifactVerification,
    }) })).rejects.toThrow('不是密封 FunctionBody')
  })

  test('同一冻结 Compiler Input 的输出不受宿主 process.version 影响', async () => {
    const first = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-node-version-a-'))
    const second = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-node-version-b-'))
    createdDirectories.push(first, second)
    const compilerInput = projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts(), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    })
    const firstResult = await compileReadOnlyProject({ outputDir: first, compilerInput })
    const descriptor = Object.getOwnPropertyDescriptor(process, 'version')!
    let secondResult
    try {
      Object.defineProperty(process, 'version', { ...descriptor, value: 'v99.99.99' })
      secondResult = await compileReadOnlyProject({ outputDir: second, compilerInput })
    } finally {
      Object.defineProperty(process, 'version', descriptor)
    }
    expect(secondResult!.sourceDigests).toEqual(firstResult.sourceDigests)
    expect(await readFile(join(second, 'toolchain-manifest.json')))
      .toEqual(await readFile(join(first, 'toolchain-manifest.json')))
  })

  test('full Playwright 项目包含独立可审计的 lifecycle runtime', async () => {
    const outputDir = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-full-lifecycle-'))
    createdDirectories.push(outputDir)
    const result = await compileReadOnlyProject({ outputDir, compilerInput: projectCompilerInputFromArtifacts({
      artifacts: approvedFullPlaywrightCompilerArtifacts(), playwrightVersion: '1.61.1',
      ...compilerArtifactVerification,
    }) })
    expect(result.generatedFiles).toContain('fixtures/full-playwright-runtime.ts')
    expect(await readFile(join(outputDir, 'fixtures/full-playwright-runtime.ts'), 'utf8'))
      .toContain('export async function executeFullPlaywrightAction')
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
