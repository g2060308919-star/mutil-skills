import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import ts from 'typescript'

const execFileAsync = promisify(execFile)
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_PACKAGES = await loadWorkspaceReleasePackages(SOURCE_ROOT)
const RUNTIME_PACKAGE_VERSION = RELEASE_PACKAGES.find(
  (releasePackage) => releasePackage.name === '@mutil-skills/e2e-runtime',
)?.version
if (RUNTIME_PACKAGE_VERSION === undefined) throw new Error('发布闭包缺少 @mutil-skills/e2e-runtime')

export interface ReleasePackageManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface CrossRepoRuntimeGoldenResult {
  packageSource: 'workspace-tarballs' | 'npm-registry'
  verifiedPublishedPackages: string[]
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
  fullPlaywright: {
    executionProfile: 'full-playwright'
    status: 'passed'
    cleanupStatus: 'verified-clean'
    caseCount: 3
    caseIds: string[]
    reloadVerified: true
    jsonBodyVerified: true
    semanticReview: { reviewDigest: string; prd: { normalizedText: string } }
    report: { content: { verdict: string } }
    reportPath: string
    standaloneReportRoot: string
  }
  todoMvc?: {
    executionProfile: 'full-playwright'
    status: 'failed'
    cleanupStatus: 'verified-clean'
    prdUrl: string
    targetUrl: string
    prdRevision: string
    semanticReview: { reviewDigest: string; prd: { normalizedText: string } }
    report: { content: { verdict: string } }
    reportPath: string
    tracePath: string[]
  }
  tracePath: string[]
  reportPath: string
}

export async function runCrossRepoRuntimeGolden(input: {
  home: string
  project: string
  packs: string
}): Promise<CrossRepoRuntimeGoldenResult> {
  assertAbsoluteDistinct(input)
  await Promise.all([
    mkdir(input.home, { recursive: true, mode: 0o700 }),
    mkdir(input.project, { recursive: true, mode: 0o700 }),
    mkdir(input.packs, { recursive: true, mode: 0o700 }),
  ])
  input = {
    home: await realpath(input.home),
    project: await realpath(input.project),
    packs: await realpath(input.packs),
  }
  const root = dirname(input.packs)
  const publicationSource = join(root, 'publication-source')
  const unavailableSource = join(root, 'publication-source.unavailable')
  const harnessRoot = join(root, 'harness')
  // HOME/项目/Runtime 状态必须全新；npm 的内容寻址下载缓存可以显式复用，
  // 它只保存公共 tarball，不包含已安装依赖、Runtime 配置或浏览器 Profile。
  const npmCache = process.env.E2E_RUNTIME_NPM_CACHE ?? join(root, 'npm-cache')
  const packageSource = process.env.E2E_RUNTIME_GOLDEN_PACKAGE_SOURCE === 'registry'
    ? 'npm-registry' as const : 'workspace-tarballs' as const
  await Promise.all([
    mkdir(harnessRoot, { recursive: true, mode: 0o700 }),
    mkdir(npmCache, { recursive: true, mode: 0o700 }),
  ])

  let installSpecs: string[]
  let expectedPackContentIntegrities: ReadonlyMap<string, string> | undefined
  let expectedRegistryIntegrities: ReadonlyMap<string, string> | undefined
  if (packageSource === 'workspace-tarballs') {
    await exec('npm', ['run', 'build'], SOURCE_ROOT, buildEnvironment(npmCache), 180_000)
    await copyPublicationSource(publicationSource)
    try {
      await cp(join(publicationSource, 'scripts', 'e2e-runtime-cross-repo-child.mjs'),
        join(harnessRoot, 'runner.mjs'))
      await cp(join(publicationSource, 'scripts', 'e2e-todomvc-app-spec.fixture.md'),
        join(harnessRoot, 'todomvc-app-spec.fixture.md'))
      await compileHarnessFixture(
        join(publicationSource, 'scripts', 'e2e-runtime-read-only.fixture.ts'),
        join(harnessRoot, 'fixture.js'),
      )
      await exec('npm', ['pack', '--workspaces', '--pack-destination', input.packs],
        publicationSource, buildEnvironment(npmCache), 180_000)
    } finally {
      await rename(publicationSource, unavailableSource)
    }
    installSpecs = (await readdir(input.packs))
      .filter((file) => file.endsWith('.tgz'))
      .sort()
      .map((file) => join(input.packs, file))
    if (installSpecs.length === 0) throw new Error('没有生成 workspace tarball')
  } else {
    const releasePacksDir = process.env.E2E_RUNTIME_RELEASE_PACKS_DIR
    if (releasePacksDir === undefined || !isAbsolute(releasePacksDir)) {
      throw new Error('Registry Golden 必须提供本次发布的绝对 tarball 目录')
    }
    expectedPackContentIntegrities = await releasePackIntegrities(releasePacksDir, RELEASE_PACKAGES)
    expectedRegistryIntegrities = await registryReleaseIntegrities(RELEASE_PACKAGES, npmCache)
    await cp(join(SOURCE_ROOT, 'scripts', 'e2e-runtime-cross-repo-child.mjs'),
      join(harnessRoot, 'runner.mjs'))
    await cp(join(SOURCE_ROOT, 'scripts', 'e2e-todomvc-app-spec.fixture.md'),
      join(harnessRoot, 'todomvc-app-spec.fixture.md'))
    await compileHarnessFixture(
      join(SOURCE_ROOT, 'scripts', 'e2e-runtime-read-only.fixture.ts'),
      join(harnessRoot, 'fixture.js'),
    )
    installSpecs = RELEASE_PACKAGES.map(({ name, version }) => `${name}@${version}`)
  }
  await writeFile(join(input.project, 'package.json'), `${JSON.stringify({
    name: 'mutil-e2e-cross-repo-golden', version: '0.0.0', private: true, type: 'module',
  }, null, 2)}\n`, { mode: 0o600 })
  await exec('npm', [
    'install', '--ignore-scripts', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund',
    '--save-exact', ...installSpecs,
  // 全新 HOME 的 Registry/Pack Golden 需要下载完整 Runtime 闭包。冷缓存网络下
  // 10 分钟不足以区分“安装失败”和“registry 较慢”，因此给安装阶段独立预留
  // 13 分钟；child 执行仍保持原有 10 分钟故障边界。
  ], input.project, installEnvironment(input.home, npmCache), 780_000)
  const installedReleasePackages = await verifyInstalledReleasePackages(
    input.project,
    RELEASE_PACKAGES,
    expectedPackContentIntegrities === undefined || expectedRegistryIntegrities === undefined
      ? undefined
      : {
          packContentIntegrities: expectedPackContentIntegrities,
          registryIntegrities: expectedRegistryIntegrities,
        },
  )

  // Harness 也必须进入安装闭包：这样源码仓被移走、用户项目 node_modules 被删除后，
  // 它仍只从已安装 Runtime 版本目录解析依赖。
  await Promise.all([
    cp(join(harnessRoot, 'runner.mjs'), join(input.project, 'runner.mjs')),
    cp(join(harnessRoot, 'fixture.js'), join(input.project, 'fixture.js')),
    cp(join(harnessRoot, 'todomvc-app-spec.fixture.md'),
      join(input.project, 'todomvc-app-spec.fixture.md')),
  ])

  const runtimePackageRoot = join(input.project, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await installPackedRuntime({
    home: input.home,
    project: input.project,
    runtimePackageRoot,
  })
  const installedRuntimePackageRoot = join(
    input.home, '.mutil-skills', 'runtime', 'e2e', 'versions', RUNTIME_PACKAGE_VERSION,
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
    }), 600_000)
  const lines = stdout.trim().split('\n')
  if (lines.length !== 1) throw new Error(`跨仓 child 必须只输出一行 JSON: ${sanitize(stderr)}`)
  const result = {
    ...parseResult(JSON.parse(lines[0]!)),
    packageSource,
    verifiedPublishedPackages: packageSource === 'npm-registry' ? installedReleasePackages : [],
  }
  const canonicalSource = await realpath(SOURCE_ROOT)
  if (JSON.stringify(result).includes(canonicalSource)) {
    throw new Error('跨仓结果泄漏真实源码仓路径')
  }
  return result
}

export async function loadWorkspaceReleasePackages(root: string): Promise<ReleasePackageManifest[]> {
  const packagesRoot = join(root, 'packages')
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const manifests = await Promise.all(entries.map(async (entry) => {
    const manifest = JSON.parse(await readFile(join(packagesRoot, entry, 'package.json'), 'utf8')) as unknown
    if (!plainPackageManifest(manifest)) throw new Error(`发布包清单无效: packages/${entry}/package.json`)
    return manifest
  }))
  if (manifests.length !== 14 || new Set(manifests.map(({ name }) => name)).size !== manifests.length) {
    throw new Error('发布闭包必须精确覆盖 14 个唯一 workspace 包')
  }
  return manifests.sort((left, right) => left.name.localeCompare(right.name))
}

export async function verifyInstalledReleasePackages(
  project: string,
  expected: ReleasePackageManifest[],
  verification?: {
    packContentIntegrities?: ReadonlyMap<string, string>
    registryIntegrities?: ReadonlyMap<string, string>
  },
): Promise<string[]> {
  if (verification !== undefined
    && verification.packContentIntegrities === undefined
    && verification.registryIntegrities === undefined) {
    throw new Error('Registry 安装校验至少需要一种完整性来源')
  }
  const expectedVersions = new Map(expected.map(({ name, version }) => [name, version]))
  const lock = verification?.registryIntegrities === undefined ? undefined
    : JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8')) as unknown
  if (verification?.registryIntegrities !== undefined && !plainRecord(lock)) {
    throw new Error('Registry 安装缺少可验证 package-lock')
  }
  const lockPackages = lock === undefined ? undefined : (lock as Record<string, unknown>).packages
  if (verification?.registryIntegrities !== undefined && !plainRecord(lockPackages)) {
    throw new Error('Registry 安装缺少 package-lock packages')
  }
  const dependencySections = [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ] as const
  for (const releasePackage of expected) {
    const installedPath = join(project, 'node_modules', ...releasePackage.name.split('/'), 'package.json')
    const installed = JSON.parse(await readFile(installedPath, 'utf8')) as unknown
    if (!plainPackageManifest(installed)
      || installed.name !== releasePackage.name
      || installed.version !== releasePackage.version) {
      throw new Error(`Registry 安装包版本不一致: ${releasePackage.name}@${releasePackage.version}`)
    }
    if (verification?.registryIntegrities !== undefined) {
      const lockEntry = (lockPackages as Record<string, unknown>)[`node_modules/${releasePackage.name}`]
      const expectedIntegrity = verification.registryIntegrities.get(releasePackage.name)
      if (!plainRecord(lockEntry) || typeof lockEntry.integrity !== 'string'
        || lockEntry.version !== releasePackage.version || lockEntry.integrity !== expectedIntegrity) {
        throw new Error(`Registry lock integrity 与 Registry 元数据不一致: ${releasePackage.name}@${releasePackage.version}`)
      }
    }
    if (verification?.packContentIntegrities !== undefined) {
      const installedRoot = dirname(installedPath)
      const actualContentIntegrity = await packageContentIntegrity(installedRoot)
      const expectedContentIntegrity = verification.packContentIntegrities.get(releasePackage.name)
      if (actualContentIntegrity !== expectedContentIntegrity) {
        throw new Error(
          `Registry 安装内容与发布 Tag pack 不一致: ${releasePackage.name}@${releasePackage.version}`
          + ` expected=${expectedContentIntegrity ?? '<missing>'} actual=${actualContentIntegrity}`,
        )
      }
    }
    for (const sectionName of dependencySections) {
      const expectedInternal = internalDependencyEntries(releasePackage[sectionName])
      const installedInternal = internalDependencyEntries(installed[sectionName])
      if (JSON.stringify(installedInternal.map(([dependency]) => dependency))
        !== JSON.stringify(expectedInternal.map(([dependency]) => dependency))) {
        throw new Error(`Registry 包内部依赖清单不一致: ${installed.name}#${sectionName}`)
      }
      for (const [index, [dependency, version]] of expectedInternal.entries()) {
        const expectedVersion = expectedVersions.get(dependency)
        if (expectedVersion === undefined || version !== expectedVersion
          || installedInternal[index]?.[1] !== version) {
          throw new Error(`Registry 包内部依赖漂移: ${installed.name} -> ${dependency}@${version}`)
        }
      }
    }
  }
  return expected.map(({ name }) => name).sort()
}

export async function releasePackIntegrities(
  packsDir: string,
  expected: ReleasePackageManifest[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const extractionRoot = await mkdtemp(join(tmpdir(), 'mutil-release-pack-content-'))
  try {
    for (const [index, releasePackage] of expected.entries()) {
      const filename = `${releasePackage.name.slice(1).replace('/', '-')}-${releasePackage.version}.tgz`
      const archive = join(packsDir, filename)
      const listing = await execFileAsync('tar', ['-tzf', archive], {
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
      })
      const entries = listing.stdout.trim().split('\n').filter((entry) => entry.length > 0)
      if (entries.length === 0 || entries.some((entry) =>
        !entry.startsWith('package/')
        || entry.includes('\\')
        || entry.split('/').some((part) => part === '..'))) {
        throw new Error(`发布 tarball 路径不安全: ${releasePackage.name}@${releasePackage.version}`)
      }
      const target = join(extractionRoot, String(index))
      await mkdir(target, { mode: 0o700 })
      await execFileAsync('tar', ['-xzf', archive, '-C', target], {
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
      })
      result.set(releasePackage.name, await packageContentIntegrity(join(target, 'package')))
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
  return result
}

async function registryReleaseIntegrities(
  expected: ReleasePackageManifest[],
  npmCache: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const releasePackage of expected) {
    const { stdout } = await exec('npm', [
      'view',
      `${releasePackage.name}@${releasePackage.version}`,
      'dist.integrity',
      '--json',
    ], SOURCE_ROOT, buildEnvironment(npmCache), 60_000)
    const integrity = JSON.parse(stdout) as unknown
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      throw new Error(`Registry 缺少有效 integrity: ${releasePackage.name}@${releasePackage.version}`)
    }
    result.set(releasePackage.name, integrity)
  }
  return result
}

async function packageContentIntegrity(root: string): Promise<string> {
  const files: Array<{ path: string; mode: number; bytes: Buffer }> = []
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (prefix === '' && entry.name === 'node_modules') continue
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path, relativePath)
        continue
      }
      if (!entry.isFile()) throw new Error(`发布包包含非普通文件: ${relativePath}`)
      const info = await lstat(path)
      if (!info.isFile() || info.nlink !== 1) throw new Error(`发布包文件边界无效: ${relativePath}`)
      // npm install 会把普通文件的 0600/0644 等 owner 权限归一化，但会保留
      // 可执行语义。内容摘要只绑定跨 pack/install 稳定且影响使用行为的 exec bit。
      files.push({ path: relativePath, mode: (info.mode & 0o111) === 0 ? 0 : 1, bytes: await readFile(path) })
    }
  }
  await visit(root, '')
  if (files.length === 0) throw new Error('发布包内容为空')
  const hash = createHash('sha512')
  for (const file of files) {
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}:${file.mode}:${file.bytes.byteLength}:`)
    hash.update(file.bytes)
  }
  return `sha512-${hash.digest('base64')}`
}

function internalDependencyEntries(section: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(section ?? {})
    .filter(([dependency]) => dependency.startsWith('@mutil-skills/'))
    .sort(([left], [right]) => left.localeCompare(right))
}

function plainPackageManifest(value: unknown): value is ReleasePackageManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Record<string, unknown>
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@mutil-skills/')
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) return false
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].every((field) => {
    const section = manifest[field]
    return section === undefined || (section !== null && typeof section === 'object' && !Array.isArray(section)
      && Object.entries(section as Record<string, unknown>).every(
        ([name, version]) => name.length > 0 && typeof version === 'string',
      ))
  })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    await installRuntime({ homeDir: home, version: ${JSON.stringify(RUNTIME_PACKAGE_VERSION)}, installClosure: async ({ stagingPrefix }) => {
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
    ...(process.env.E2E_RUNTIME_RUN_TODOMVC_PUBLIC === undefined ? {}
      : { E2E_RUNTIME_RUN_TODOMVC_PUBLIC: process.env.E2E_RUNTIME_RUN_TODOMVC_PUBLIC }),
    ...(process.env.E2E_RUNTIME_TODOMVC_ONLY === undefined ? {}
      : { E2E_RUNTIME_TODOMVC_ONLY: process.env.E2E_RUNTIME_TODOMVC_ONLY }),
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
  if (process.env.E2E_RUNTIME_TODOMVC_ONLY === '1') {
    if (result.doctor?.ready !== true
      || result.todoMvc?.executionProfile !== 'full-playwright'
      || result.todoMvc.status !== 'failed'
      || result.todoMvc.cleanupStatus !== 'verified-clean'
      || !/^sha256:[a-f0-9]{64}$/.test(result.todoMvc.prdRevision)
      || !/^sha256:[a-f0-9]{64}$/.test(result.todoMvc.semanticReview?.reviewDigest)
      || result.todoMvc.report?.content?.verdict !== 'rejected'
      || !Array.isArray(result.todoMvc.tracePath)) {
      throw new Error('跨仓 TodoMVC 诊断结果不满足完整 Runtime Golden 契约')
    }
    return result
  }
  if (result.doctor?.ready !== true
    || result.managedBrowserInstalled !== false
    || result.report?.content?.runtimeProvenance?.sourceRepositoryIndependent !== true
    || result.report?.content?.approvalAssurance?.approvalMode !== 'local-confirmation'
    || result.report.content.approvalAssurance.identityVerified !== false
    || result.report.content.approvalAssurance.separationOfDutiesVerified !== false
    || result.publishedRegression?.exitCode !== 0
    || !/^sha256:[a-f0-9]{64}$/.test(result.publishedRegression.gatewayAuditDigest)
    || result.fullPlaywright?.executionProfile !== 'full-playwright'
    || result.fullPlaywright.status !== 'passed'
    || result.fullPlaywright.cleanupStatus !== 'verified-clean'
    || result.fullPlaywright.caseCount !== 3
    || result.fullPlaywright.caseIds?.length !== 3
    || result.fullPlaywright.reloadVerified !== true
    || result.fullPlaywright.jsonBodyVerified !== true
    || !/^sha256:[a-f0-9]{64}$/.test(result.fullPlaywright.semanticReview?.reviewDigest)
    || result.fullPlaywright.report?.content?.verdict !== 'accepted'
    || typeof result.fullPlaywright.standaloneReportRoot !== 'string'
    || (process.env.E2E_RUNTIME_RUN_TODOMVC_PUBLIC === '1'
      && (result.todoMvc?.executionProfile !== 'full-playwright'
        || result.todoMvc.status !== 'failed'
        || result.todoMvc.cleanupStatus !== 'verified-clean'
        || !/^sha256:[a-f0-9]{64}$/.test(result.todoMvc.prdRevision)
        || !/^sha256:[a-f0-9]{64}$/.test(result.todoMvc.semanticReview?.reviewDigest)
        || result.todoMvc.report?.content?.verdict !== 'rejected'
        || !Array.isArray(result.todoMvc.tracePath)))
    || !Array.isArray(result.tracePath)
    || typeof result.reportPath !== 'string') {
    throw new Error('跨仓结果不满足完整 Runtime Golden 契约')
  }
  return result
}

function sanitize(value: string): string {
  return value.replaceAll(SOURCE_ROOT, '<source>').slice(0, 4096)
}
