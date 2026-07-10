import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { runTests as foundationRunTests, type RunTestsOptions, type RunTestsResult, type TestRunner } from '@mutil-skills/foundation/testing'
import { buildPackageInstallCommand, detectPackageManager, mergePackageScripts, readJsonFile, scanFiles, writeJsonFile, type PackageJsonLike } from '@mutil-skills/core'
import { parseSkillManifest } from '@mutil-skills/schema'
import { resolveSkillDirectory } from '@mutil-skills/skills'
import { spawn } from 'node:child_process'

export type TestingFoundationStatus = 'complete' | 'partial' | 'missing' | 'conflicted'

export interface TestingFoundationDetection {
  status: TestingFoundationStatus
  runner?: TestRunner
  evidence: string[]
  missing: Array<'scripts' | 'dependencies' | 'structure'>
}

export interface BootstrapPlan {
  status: TestingFoundationStatus
  runner: TestRunner
  missing: Array<'scripts' | 'dependencies' | 'structure'>
  packages: string[]
  files: string[]
  scripts: Record<string, string>
  requiresConfirmation: true
  summary: string
}

export interface RepoTestOptions {
  cwd: string
  args?: string[]
  runTests?: (options: RunTestsOptions) => Promise<RunTestsResult>
}

export interface RepoTddOptions {
  cwd: string
  skillDir: string
  confirm?: (plan: BootstrapPlan) => Promise<boolean>
  installPackage?: (packageName: string, cwd: string) => Promise<void>
  runTests?: (options: RunTestsOptions) => Promise<RunTestsResult>
}

const testPatterns = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', 'tests/**/*.ts', 'test/**/*.ts', '__tests__/**/*.ts']
const configFiles = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'jest.config.ts', 'jest.config.js', 'jest.config.mjs']

export async function repoTest(options: RepoTestOptions): Promise<RunTestsResult> {
  const runTests = options.runTests ?? foundationRunTests
  return runTests({ cwd: options.cwd, ...parseRepoTestArgs(options.args ?? []) })
}

export function parseRepoTestArgs(args: string[]): Omit<RunTestsOptions, 'cwd' | 'executor'> {
  const forwarded: string[] = []
  let watch = false
  let coverage = false
  let passThrough = false

  for (const arg of args) {
    if (passThrough) {
      forwarded.push(arg)
      continue
    }
    if (arg === '--') {
      passThrough = true
      continue
    }
    if (arg === '--watch') {
      watch = true
      continue
    }
    if (arg === '--coverage') {
      coverage = true
      continue
    }
    forwarded.push(arg)
  }

  return {
    ...(watch ? { watch } : {}),
    ...(coverage ? { coverage } : {}),
    args: forwarded,
  }
}

export async function detectTestingFoundation(cwd: string): Promise<TestingFoundationDetection> {
  const pkg = await readOptionalPackageJson(cwd)
  const evidence: string[] = []
  const runnerSignals = new Set<TestRunner>()

  const scripts: Record<string, string> = pkg?.scripts ?? {}
  const scriptNames = Object.keys(scripts)
  const hasTestScript = scriptNames.some((name) => name === 'test' || name === 'test:watch' || name === 'test:unit' || name.includes('test'))
  for (const [name, command] of Object.entries(scripts)) {
    if (command.includes('vitest')) {
      runnerSignals.add('vitest')
      evidence.push(`script:${name}=vitest`)
    }
    if (command.includes('jest')) {
      runnerSignals.add('jest')
      evidence.push(`script:${name}=jest`)
    }
    if (command.includes('repo-test')) {
      runnerSignals.add('vitest')
      evidence.push(`script:${name}=repo-test`)
    }
  }

  const dependencyNames = dependencyKeys(pkg)
  const hasVitestDependency = dependencyNames.includes('vitest') || dependencyNames.includes('@mutil-skills/foundation')
  const hasJestDependency = dependencyNames.some((name) => ['jest', '@types/jest', 'ts-jest', 'babel-jest'].includes(name))
  if (hasVitestDependency) {
    runnerSignals.add('vitest')
    evidence.push('dependency:vitest')
  }
  if (hasJestDependency) {
    runnerSignals.add('jest')
    evidence.push('dependency:jest')
  }

  const existingConfigFiles = await existingFiles(cwd, configFiles)
  for (const file of existingConfigFiles) {
    if (file.startsWith('vitest')) {
      runnerSignals.add('vitest')
      evidence.push(`config:${file}`)
    }
    if (file.startsWith('jest')) {
      runnerSignals.add('jest')
      evidence.push(`config:${file}`)
    }
  }

  const testFiles = await scanFiles(cwd, testPatterns)
  if (testFiles.length > 0) {
    evidence.push(`tests:${testFiles.length}`)
  }

  if (runnerSignals.size > 1) {
    return {
      status: 'conflicted',
      runner: undefined,
      evidence,
      missing: missingLayers(hasTestScript, hasVitestDependency || hasJestDependency, existingConfigFiles.length > 0 || testFiles.length > 0),
    }
  }

  const runner = [...runnerSignals][0]
  const hasRunnerDependency = runner === 'jest' ? hasJestDependency : runner === 'vitest' ? hasVitestDependency : false
  const hasStructure = existingConfigFiles.length > 0 || testFiles.length > 0
  const missing = missingLayers(hasTestScript, hasRunnerDependency, hasStructure)

  if (!runner && missing.length === 3) {
    return { status: 'missing', runner: undefined, evidence, missing }
  }

  return {
    status: missing.length === 0 ? 'complete' : 'partial',
    runner,
    evidence,
    missing,
  }
}

export function buildBootstrapPlan(detection: TestingFoundationDetection): BootstrapPlan {
  if (detection.status === 'partial' && detection.runner === 'jest') {
    return {
      status: 'partial',
      runner: 'jest',
      missing: detection.missing,
      packages: detection.missing.includes('dependencies') ? ['jest'] : [],
      files: detection.missing.includes('structure') ? ['jest.config.js', 'tests/foundation.sample.test.ts'] : [],
      scripts: detection.missing.includes('scripts') ? { test: 'jest' } : {},
      requiresConfirmation: true,
      summary: '补齐现有 Jest 测试基建，不迁移到 Vitest。',
    }
  }

  return {
    status: detection.status,
    runner: 'vitest',
    missing: detection.missing,
    packages: detection.missing.includes('dependencies') || detection.status === 'missing' ? ['@mutil-skills/foundation'] : [],
    files: detection.missing.includes('structure') || detection.status === 'missing' ? ['package.json', 'tests/foundation.sample.test.ts'] : ['package.json'],
    scripts: detection.missing.includes('scripts') || detection.status === 'missing' ? { test: 'repo-test', 'test:watch': 'repo-test --watch' } : {},
    requiresConfirmation: true,
    summary: '安装 @mutil-skills/foundation 并接入默认测试基建 baseline。',
  }
}

export function formatBootstrapPlan(plan: BootstrapPlan): string {
  const scripts = Object.entries(plan.scripts).map(([name, command]) => `${name}=${command}`).join(', ') || 'none'
  return [
    plan.summary,
    `状态：${plan.status}`,
    `Runner：${plan.runner}`,
    `缺失项：${plan.missing.join(', ') || 'none'}`,
    `准备安装的包：${plan.packages.join(', ') || 'none'}`,
    `准备写入或修改的文件：${plan.files.join(', ') || 'none'}`,
    `准备增加的 scripts：${scripts}`,
    '如果拒绝，将不会安装依赖，也不会写入文件；请在手动设置测试基建后运行现有测试命令。',
  ].join('\n')
}

export function resolveRepoTddSkillDirectory(args: string[]): string {
  const skillId = parseRepoTddArgs(args).skill
  if (skillId !== 'tdd') {
    throw new Error(`repo-tdd 仅支持 tdd skill：${skillId}`)
  }
  const skillDirectory = resolveSkillDirectory(skillId)
  if (!skillDirectory) {
    throw new Error(`未知 skill：${skillId}`)
  }
  return skillDirectory
}

function parseRepoTddArgs(args: string[]): { skill: string } {
  const skillFlagIndex = args.indexOf('--skill')
  if (skillFlagIndex >= 0) {
    return { skill: args[skillFlagIndex + 1] ?? 'tdd' }
  }
  return { skill: 'tdd' }
}

export async function repoTddWorkflow(options: RepoTddOptions): Promise<{ status: 'ready' | 'cancelled'; detection: TestingFoundationDetection; plan?: BootstrapPlan; testResult?: RunTestsResult }> {
  await readFile(join(options.skillDir, 'SKILL.md'), 'utf8')
  const manifestText = await readFile(join(options.skillDir, 'skill.manifest.json'), 'utf8')
  parseSkillManifest(JSON.parse(manifestText))

  const detection = await detectTestingFoundation(options.cwd)
  if (detection.status === 'complete') {
    const runTests = options.runTests ?? foundationRunTests
    return { status: 'ready', detection, testResult: await runTests({ cwd: options.cwd, passWithNoTests: true }) }
  }
  if (detection.status === 'conflicted') {
    throw new Error(`测试基建存在冲突：${detection.evidence.join(', ')}`)
  }

  const plan = buildBootstrapPlan(detection)
  const confirmed = await (options.confirm ?? defaultConfirm)(plan)
  if (!confirmed) {
    return { status: 'cancelled', detection, plan }
  }

  await applyBootstrapPlan(options.cwd, plan, options.installPackage)
  const runTests = options.runTests ?? foundationRunTests
  return { status: 'ready', detection, plan, testResult: await runTests({ cwd: options.cwd, passWithNoTests: true }) }
}

export async function applyBootstrapPlan(cwd: string, plan: BootstrapPlan, installPackage: (packageName: string, cwd: string) => Promise<void> = defaultInstallPackage): Promise<void> {
  for (const packageName of plan.packages) {
    await installPackage(packageName, cwd)
  }

  const pkgPath = join(cwd, 'package.json')
  const pkg = await readJsonFile<PackageJsonLike>(pkgPath)
  const merged = mergePackageScripts(discardNpmInitPlaceholderTestScript(pkg), plan.scripts)
  await writeJsonFile(pkgPath, merged.packageJson as Record<string, unknown>)

  if (plan.runner === 'jest' && plan.files.includes('jest.config.js')) {
    await writeFile(join(cwd, 'jest.config.js'), "export default {\n  testEnvironment: 'node',\n}\n", 'utf8')
  }
  if (plan.files.includes('tests/foundation.sample.test.ts')) {
    await mkdir(join(cwd, 'tests'), { recursive: true })
    const sample = plan.runner === 'jest' ? [
      "describe('测试基建', () => {",
      "  test('可以运行', () => {",
      '    expect(true).toBe(true)',
      '  })',
      '})',
      '',
    ] : [
      "import { describe, expect, test } from 'vitest'",
      '',
      "describe('测试基建', () => {",
      "  test('可以运行', () => {",
      '    expect(true).toBe(true)',
      '  })',
      '})',
      '',
    ]
    await writeFile(join(cwd, 'tests', 'foundation.sample.test.ts'), sample.join('\n'), 'utf8')
  }
}

async function defaultInstallPackage(packageName: string, cwd: string): Promise<void> {
  const manager = await detectPackageManager(cwd)
  const spec = buildPackageInstallCommand(manager, packageName)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`安装命令失败，退出码 ${code}`))
    })
    child.on('error', reject)
  })
}

async function readOptionalPackageJson(cwd: string): Promise<PackageJsonLike | undefined> {
  try {
    return await readJsonFile<PackageJsonLike>(join(cwd, 'package.json'))
  } catch {
    return undefined
  }
}

function dependencyKeys(pkg: PackageJsonLike | undefined): string[] {
  return [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
    ...Object.keys(pkg?.peerDependencies ?? {}),
  ]
}

async function existingFiles(cwd: string, names: string[]): Promise<string[]> {
  const found: string[] = []
  for (const name of names) {
    try {
      await access(join(cwd, name))
      found.push(name)
    } catch {
      // 缺失文件只表示没有对应证据。
    }
  }
  return found
}

function missingLayers(hasScript: boolean, hasDependency: boolean, hasStructure: boolean): Array<'scripts' | 'dependencies' | 'structure'> {
  return [
    ...hasScript ? [] as const : ['scripts'] as const,
    ...hasDependency ? [] as const : ['dependencies'] as const,
    ...hasStructure ? [] as const : ['structure'] as const,
  ]
}

function discardNpmInitPlaceholderTestScript(pkg: PackageJsonLike): PackageJsonLike {
  if (pkg.scripts?.test !== 'echo "Error: no test specified" && exit 1') {
    return pkg
  }

  const { test: _placeholder, ...scripts } = pkg.scripts
  return { ...pkg, scripts }
}

async function defaultConfirm(plan: BootstrapPlan): Promise<boolean> {
  process.stdout.write(`${formatBootstrapPlan(plan)}\n`)
  if (!process.stdin.isTTY) {
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('是否应用这个测试基建计划？[y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}
