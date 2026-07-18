import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_VERSION = '0.1.0'

export interface CrossRepoRuntimeGoldenResult {
  doctor: { ready: boolean; [key: string]: unknown }
  report: { content: { verdict: string; runtimeProvenance: {
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
  const npmCache = join(root, 'npm-cache')
  const externalGoldenHome = process.env.E2E_RUNTIME_REAL_GOLDEN_HOME
  if (externalGoldenHome === undefined || !isAbsolute(externalGoldenHome)) {
    throw new Error('E2E_RUNTIME_REAL_GOLDEN_HOME 必须指向已验证的真实 Chromium 闭包')
  }

  await Promise.all([
    mkdir(input.home, { recursive: true, mode: 0o700 }),
    mkdir(input.project, { recursive: true, mode: 0o700 }),
    mkdir(input.packs, { recursive: true, mode: 0o700 }),
    mkdir(npmCache, { recursive: true, mode: 0o700 }),
  ])

  await exec('npm', ['run', 'build'], SOURCE_ROOT, buildEnvironment(npmCache), 180_000)
  await copyPublicationSource(publicationSource)
  try {
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
  ], input.project, installEnvironment(input.home, npmCache), 240_000)

  const runtimePackageRoot = join(input.project, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await installPackedRuntime({
    home: input.home,
    project: input.project,
    runtimePackageRoot,
    externalGoldenHome,
  })

  const harnessRoot = join(input.project, '.cross-repo-harness')
  await mkdir(harnessRoot, { recursive: true, mode: 0o700 })
  await Promise.all([
    cp(join(unavailableSource, 'scripts', 'e2e-runtime-cross-repo-child.mjs'),
      join(harnessRoot, 'runner.mjs')),
    cp(join(unavailableSource, 'dist', 'scripts', 'e2e-runtime-read-only.fixture.js'),
      join(harnessRoot, 'fixture.js')),
  ])
  const harness = join(harnessRoot, 'runner.mjs')
  const { stdout, stderr } = await exec(process.execPath, [harness], input.project,
    runtimeEnvironment({
      home: input.home,
      runtimePackageRoot,
      externalGoldenHome,
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
      return !parts.some((part) => ['.git', '.worktrees', '.superpowers', 'node_modules'].includes(part))
    },
  })
}

async function installPackedRuntime(input: {
  home: string
  project: string
  runtimePackageRoot: string
  externalGoldenHome: string
}): Promise<void> {
  const installerUrl = pathToFileURL(join(input.runtimePackageRoot, 'dist', 'src', 'runtime-installer.js')).href
  const discoveryUrl = pathToFileURL(join(input.runtimePackageRoot, 'dist', 'src', 'runtime-discovery.js')).href
  const capabilityUrl = pathToFileURL(join(input.runtimePackageRoot, 'dist', 'src', 'runtime-capability-proof.js')).href
  const source = `
    import { cp, chmod, mkdir, readdir } from 'node:fs/promises'
    import { join } from 'node:path'
    import { installRuntime } from ${JSON.stringify(installerUrl)}
    import { inspectRuntimeInstallation } from ${JSON.stringify(discoveryUrl)}
    import { inspectRuntimeCapabilityProof, recordRuntimeCapabilityProof } from ${JSON.stringify(capabilityUrl)}
    const home = process.env.HOME
    const project = process.env.E2E_PACKED_PROJECT
    const sourceHome = process.env.E2E_REAL_GOLDEN_HOME
    if (!home || !project || !sourceHome) throw new Error('cross-repo bootstrap env missing')
    await installRuntime({ homeDir: home, version: ${JSON.stringify(PACKAGE_VERSION)}, installClosure: async ({ stagingPrefix }) => {
      for (const entry of await readdir(project)) {
        await cp(join(project, entry), join(stagingPrefix, entry), { recursive: true, dereference: false, preserveTimestamps: true })
      }
    } })
    const [sourceInstallation, targetInstallation] = await Promise.all([
      inspectRuntimeInstallation({ homeDir: sourceHome }), inspectRuntimeInstallation({ homeDir: home }),
    ])
    if (sourceInstallation.installationDigest !== targetInstallation.installationDigest) {
      throw new Error('E2E_RUNTIME_REAL_GOLDEN_DIGEST_MISMATCH')
    }
    const sourceBrowser = join(sourceHome, '.mutil-skills', 'runtime', 'e2e', 'browsers')
    const targetBrowser = join(home, '.mutil-skills', 'runtime', 'e2e', 'browsers')
    await cp(sourceBrowser, targetBrowser, { recursive: true, force: true, dereference: false, preserveTimestamps: true })
    await chmod(targetBrowser, 0o700)
    const proof = await inspectRuntimeCapabilityProof({ homeDir: sourceHome,
      runtimeInstallationDigest: sourceInstallation.installationDigest })
    const targetState = join(home, '.mutil-skills', 'e2e', 'state')
    await mkdir(targetState, { recursive: true, mode: 0o700 })
    await chmod(targetState, 0o700)
    await recordRuntimeCapabilityProof({ homeDir: home,
      runtimeInstallationDigest: targetInstallation.installationDigest,
      gateway: proof.gateway, isolation: proof.isolation, verifiedAt: proof.verifiedAt })
  `
  await exec(process.execPath, ['--input-type=module', '--eval', source], input.project,
    runtimeEnvironment({
      home: input.home,
      runtimePackageRoot: input.runtimePackageRoot,
      externalGoldenHome: input.externalGoldenHome,
      project: input.project,
    }), 180_000)
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
  externalGoldenHome: string
}): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    PATH: '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR,
    E2E_PACKED_PROJECT: input.project,
    E2E_PACKED_RUNTIME_PACKAGE_ROOT: input.runtimePackageRoot,
    E2E_REAL_GOLDEN_HOME: input.externalGoldenHome,
  }
}

function assertAbsoluteDistinct(input: { home: string; project: string; packs: string }): void {
  const paths = [input.home, input.project, input.packs]
  if (paths.some((path) => !isAbsolute(path)) || new Set(paths.map(resolve)).size !== paths.length) {
    throw new Error('home/project/packs 必须是三个不同的绝对路径')
  }
}

function parseResult(value: unknown): CrossRepoRuntimeGoldenResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('跨仓结果无效')
  const result = value as CrossRepoRuntimeGoldenResult
  if (result.doctor?.ready !== true
    || result.report?.content?.runtimeProvenance?.sourceRepositoryIndependent !== true
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
