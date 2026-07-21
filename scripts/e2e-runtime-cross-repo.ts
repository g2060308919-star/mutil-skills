import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'

const execFileAsync = promisify(execFile)
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_VERSION = '0.2.1'

export interface CrossRepoRuntimeGoldenResult {
  doctor: { ready: boolean; [key: string]: unknown }
  managedBrowserInstalled: boolean
  report: { content: { verdict: string; approvalAssurance: {
    approvalMode: string
    identityVerified: boolean
    separationOfDutiesVerified: boolean
  }; runtimeProvenance: {
    sourceRepositoryIndependent: boolean
  } } }
  publishedRegression: { exitCode: 0; gatewayAuditDigest: string }
  tracePath: string[]
  reportPath: string
}

export async function runCrossRepoRuntimeGolden(input: {
  home: string
  project: string
  packs: string
}): Promise<CrossRepoRuntimeGoldenResult> {
  assertAbsoluteDistinct(input)
  const root = dirname(input.packs)
  const publicationSource = join(root, 'publication-source')
  const unavailableSource = join(root, 'publication-source.unavailable')
  const harnessRoot = join(root, 'harness')
  const npmCache = join(root, 'npm-cache')
  await Promise.all([
    mkdir(input.home, { recursive: true, mode: 0o700 }),
    mkdir(input.project, { recursive: true, mode: 0o700 }),
    mkdir(input.packs, { recursive: true, mode: 0o700 }),
    mkdir(harnessRoot, { recursive: true, mode: 0o700 }),
    mkdir(npmCache, { recursive: true, mode: 0o700 }),
  ])

  await exec('npm', ['run', 'build'], SOURCE_ROOT, buildEnvironment(npmCache), 180_000)
  await copyPublicationSource(publicationSource)
  try {
    await cp(join(publicationSource, 'scripts', 'e2e-runtime-cross-repo-child.mjs'),
      join(harnessRoot, 'runner.mjs'))
    await compileHarnessFixture(
      join(publicationSource, 'scripts', 'e2e-runtime-read-only.fixture.ts'),
      join(harnessRoot, 'fixture.js'),
    )
    await exec('npm', ['pack', '--workspaces', '--pack-destination', input.packs],
      publicationSource, buildEnvironment(npmCache), 180_000)
  } finally {
    await rename(publicationSource, unavailableSource)
  }

  const tarballs = (await readdir(input.packs))
    .filter((file) => file.endsWith('.tgz'))
    .sort()
    .map((file) => join(input.packs, file))
  if (tarballs.length === 0) throw new Error('没有生成 workspace tarball')
  await writeFile(join(input.project, 'package.json'), `${JSON.stringify({
    name: 'mutil-e2e-cross-repo-golden', version: '0.0.0', private: true, type: 'module',
  }, null, 2)}\n`, { mode: 0o600 })
  await exec('npm', [
    'install', '--ignore-scripts', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund',
    '--save-exact', ...tarballs,
  ], input.project, installEnvironment(input.home, npmCache), 360_000)

  // Harness 也必须进入安装闭包：这样源码仓被移走、用户项目 node_modules 被删除后，
  // 它仍只从已安装 Runtime 版本目录解析依赖。
  await Promise.all([
    cp(join(harnessRoot, 'runner.mjs'), join(input.project, 'runner.mjs')),
    cp(join(harnessRoot, 'fixture.js'), join(input.project, 'fixture.js')),
  ])

  const runtimePackageRoot = join(input.project, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await installPackedRuntime({
    home: input.home,
    project: input.project,
    runtimePackageRoot,
  })
  const installedRuntimePackageRoot = join(
    input.home, '.mutil-skills', 'runtime', 'e2e', 'versions', PACKAGE_VERSION,
    'node_modules', '@mutil-skills', 'e2e-runtime',
  )
  const installedRuntimeVersionRoot = resolve(
    installedRuntimePackageRoot, '..', '..', '..',
  )

  // 用户项目中的 node_modules 只用于构造安装闭包；真实 child 启动前必须移除，
  // 证明 Runtime 与 harness 均不从 cwd 或用户项目解析可执行依赖。
  await Promise.all([
    rm(join(input.project, 'node_modules'), { recursive: true, force: true }),
    rm(join(input.project, 'package.json'), { force: true }),
    rm(join(input.project, 'package-lock.json'), { force: true }),
  ])
  const harness = join(installedRuntimeVersionRoot, 'runner.mjs')
  const { stdout, stderr } = await execWithLiveStderr(process.execPath, [harness], input.project,
    childRuntimeEnvironment({
      home: input.home,
      runtimePackageRoot: installedRuntimePackageRoot,
      project: input.project,
    }), 180_000)
  const lines = stdout.trim().split('\n')
  if (lines.length !== 1) throw new Error(`跨仓 child 必须只输出一行 JSON: ${sanitize(stderr)}`)
  const result = parseResult(JSON.parse(lines[0]!))
  const canonicalSource = await realpath(SOURCE_ROOT)
  if (JSON.stringify(result).includes(canonicalSource)) {
    throw new Error('跨仓结果泄漏真实源码仓路径')
  }
  return result
}

async function compileHarnessFixture(source: string, target: string): Promise<void> {
  const output = ts.transpileModule(await readFile(source, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: source,
    reportDiagnostics: true,
  })
  const errors = output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length > 0) {
    throw new Error(`跨仓 fixture 编译失败：${errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ')}`)
  }
  await writeFile(target, output.outputText, { mode: 0o600 })
}

async function copyPublicationSource(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
  await cp(SOURCE_ROOT, target, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    filter: (source) => {
      const path = relative(SOURCE_ROOT, source)
      if (path === '') return true
      const parts = path.split(sep)
      return !parts.some((part) => ['.git', '.worktrees', '.superpowers', '.tmp', 'node_modules'].includes(part))
    },
  })
}

async function installPackedRuntime(input: {
  home: string
  project: string
  runtimePackageRoot: string
}): Promise<void> {
  const installerUrl = pathToFileURL(join(input.runtimePackageRoot, 'dist', 'src', 'runtime-installer.js')).href
  const source = `
    import { cp, readdir } from 'node:fs/promises'
    import { join } from 'node:path'
    import { installRuntime } from ${JSON.stringify(installerUrl)}
    const home = process.env.HOME
    const project = process.env.E2E_PACKED_PROJECT
    if (!home || !project) throw new Error('cross-repo bootstrap env missing')
    await installRuntime({ homeDir: home, version: ${JSON.stringify(PACKAGE_VERSION)}, installClosure: async ({ stagingPrefix }) => {
      for (const entry of await readdir(project)) {
        await cp(join(project, entry), join(stagingPrefix, entry), { recursive: true, dereference: false, preserveTimestamps: true })
      }
    } })
  `
  await exec(process.execPath, ['--input-type=module', '--eval', source], input.project,
    runtimeEnvironment({
      home: input.home,
      runtimePackageRoot: input.runtimePackageRoot,
      project: input.project,
    }), 180_000)
  const launcher = join(input.home, '.mutil-skills', 'bin', 'repo-e2e')
  const environment = childRuntimeEnvironment({
    home: input.home, project: input.project, runtimePackageRoot: input.runtimePackageRoot,
  })
  await exec(launcher, ['configure-approval', '--mode', 'local-confirmation'],
    input.project, environment, 30_000)
  const chromeArguments = ['configure-browser', '--system']
  if (process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE !== undefined) {
    chromeArguments.push('--executable', process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE)
  }
  await exec(launcher, chromeArguments, input.project, environment, 180_000)
}

async function exec(
  executable: string,
  arguments_: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(executable, arguments_, {
    cwd, env, timeout, maxBuffer: 20 * 1024 * 1024,
  })
}

async function execWithLiveStderr(
  executable: string,
  arguments_: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('跨仓 Runtime child 超时'))
    }, timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal !== null || code !== 0) {
        reject(new Error(`跨仓 Runtime child 失败:${signal ?? code}:${sanitize(stderr)}`))
      } else resolvePromise({ stdout, stderr })
    })
  })
}

function buildEnvironment(npmCache: string): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR,
    npm_config_cache: npmCache,
  }
}

function installEnvironment(home: string, npmCache: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR,
    npm_config_cache: npmCache,
  }
}

function runtimeEnvironment(input: {
  home: string
  project: string
  runtimePackageRoot: string
}): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    PATH: '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR,
    E2E_PACKED_PROJECT: input.project,
    E2E_PACKED_RUNTIME_PACKAGE_ROOT: input.runtimePackageRoot,
  }
}

function childRuntimeEnvironment(input: {
  home: string
  project: string
  runtimePackageRoot: string
}): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    PATH: '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR,
    E2E_PACKED_PROJECT: input.project,
    E2E_PACKED_RUNTIME_PACKAGE_ROOT: input.runtimePackageRoot,
  }
}

function assertAbsoluteDistinct(input: { home: string; project: string; packs: string }): void {
  const paths = [input.home, input.project, input.packs]
  if (paths.some((path) => !isAbsolute(path)) || new Set(paths.map((path) => resolve(path))).size !== paths.length) {
    throw new Error('home/project/packs 必须是三个不同的绝对路径')
  }
}

function parseResult(value: unknown): CrossRepoRuntimeGoldenResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('跨仓结果无效')
  const result = value as CrossRepoRuntimeGoldenResult
  if (result.doctor?.ready !== true
    || result.managedBrowserInstalled !== false
    || result.report?.content?.runtimeProvenance?.sourceRepositoryIndependent !== true
    || result.report?.content?.approvalAssurance?.approvalMode !== 'local-confirmation'
    || result.report.content.approvalAssurance.identityVerified !== false
    || result.report.content.approvalAssurance.separationOfDutiesVerified !== false
    || result.publishedRegression?.exitCode !== 0
    || !/^sha256:[a-f0-9]{64}$/.test(result.publishedRegression.gatewayAuditDigest)
    || !Array.isArray(result.tracePath)
    || typeof result.reportPath !== 'string') {
    throw new Error('跨仓结果不满足完整 Runtime Golden 契约')
  }
  return result
}

function sanitize(value: string): string {
  return value.replaceAll(SOURCE_ROOT, '<source>').slice(0, 4096)
}
