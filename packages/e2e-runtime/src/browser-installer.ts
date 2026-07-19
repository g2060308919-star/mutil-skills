import { canonicalizeJson, digestBytes, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, unlink,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runtimeLayout } from './runtime-layout.js'
import { currentUid, verifyCurrentRuntimeInstallation, verifyRuntimeRoot } from './runtime-manifest.js'
import type { RuntimeLayout } from './runtime-layout.js'
import type { InspectedSystemChrome } from './system-chrome.js'

export const EXPECTED_PLAYWRIGHT_VERSION = '1.61.1'
export const BROWSER_MANIFEST_FILE = 'browser-manifest.json'
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const SAFE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const STAGING_NAME = /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const INSTALL_OWNER_FILE = '.install-owner.json'
const INSTALL_CHILD_TIMEOUT_MS = 15 * 60_000
const INSTALL_CHILD_TERMINATION_GRACE_MS = 2_000
const INSTALL_CHILD_OUTPUT_LIMIT = 64 * 1024

export interface BrowserClosureFile {
  path: string
  kind: 'file' | 'symlink'
  byteLength: number
  digest: string
}

export interface BrowserManifest {
  schemaVersion: '1.0.0'
  runtimeVersion: string
  runtimeInstallationDigest: string
  playwrightVersion: '1.61.1'
  platform: NodeJS.Platform
  arch: string
  revision: string
  chromiumVersion: string
  cliByteLength: number
  cliDigest: string
  executableRelativePath: string
  executableByteLength: number
  executableDigest: string
  files: BrowserClosureFile[]
  closureDigest: string
}

export interface ChromiumInstallation {
  root: string
  executablePath: string
  manifest: BrowserManifest
}

/**
 * Runtime 受控浏览器入口接受的完整来源联合。托管 Chromium 保留不可变闭包
 * manifest；系统 Chrome 以每次重验的 executable identity 与用户选择记录绑定。
 */
export type BrowserInstallation = ChromiumInstallation | InspectedSystemChrome

export interface InstallChromiumOptions {
  homeDir: string
  runtimeVersion: string
  runtimeInstallationDigest: string
}

export interface BrowserInstallerOperations {
  inspectRuntime(homeDir: string): Promise<{
    version: string
    installationDigest: string
    versionRoot: string
    manifestFiles: Array<{ path: string; byteLength: number; digest: string }>
  }>
  verifyRuntimeRoot(layout: RuntimeLayout): Promise<void>
  resolvePlaywright(): Promise<{ packageRoot: string; cliPath: string; version: string }>
  runInstall(input: {
    executable: string
    arguments: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs?: number
    terminationGraceMs?: number
  }): Promise<void>
  readChromiumVersion(input: {
    executablePath: string
    cwd: string
    homeDir: string
    tempDir: string
  }): Promise<string>
}

export async function installChromium(options: InstallChromiumOptions): Promise<ChromiumInstallation> {
  return await installChromiumWithOperations(options, productionBrowserInstallerOperations)
}

export async function installChromiumWithOperations(
  options: InstallChromiumOptions,
  operations: BrowserInstallerOperations,
): Promise<ChromiumInstallation> {
  assertInstallOptions(options)
  const layout = runtimeLayout(options.homeDir)
  const runtime = await operations.inspectRuntime(options.homeDir)
  if (runtime.version !== options.runtimeVersion
    || runtime.installationDigest !== options.runtimeInstallationDigest) {
    throw browserError('E2E_CHROMIUM_RUNTIME_BINDING_MISMATCH', 'Browser 安装输入与当前已验证 Runtime 不一致')
  }
  await operations.verifyRuntimeRoot(layout)
  await ensurePrivateDirectory(layout.browsers)
  const stagingName = `.staging-${randomUUID()}`
  return await withBrowserInstallLock(layout, stagingName, async (transactionRoot) => {
    const playwright = await trustedPlaywright(operations, runtime)
    const platformRoot = join(layout.browsers, options.runtimeVersion)
    await ensurePrivateDirectory(platformRoot)
    const target = join(platformRoot, `${process.platform}-${process.arch}`)
    const staging = join(transactionRoot, 'closure')
    const installerHome = join(transactionRoot, 'home')
    const installerTemp = join(transactionRoot, 'tmp')
    await Promise.all([
      mkdir(staging, { mode: 0o700 }),
      mkdir(installerHome, { mode: 0o700 }),
      mkdir(installerTemp, { mode: 0o700 }),
    ])
    await operations.runInstall({
      executable: process.execPath,
      arguments: [playwright.cliPath, 'install', 'chromium'],
      cwd: playwright.packageRoot,
      env: {
        HOME: installerHome,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: dirname(process.execPath),
        PLAYWRIGHT_BROWSERS_PATH: staging,
        TMPDIR: installerTemp,
      },
    })
    await normalizeBrowserClosure(staging)
    const manifest = await createBrowserManifest(staging, options, playwright.cliPath, operations)
    await writeDurableFile(join(staging, BROWSER_MANIFEST_FILE), `${canonicalizeJson(manifest)}\n`)
    await fsyncTree(staging)
    try {
      await rename(staging, target)
      await fsyncDirectory(platformRoot)
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error
      const existing = await inspectChromiumInstallation(options, operations)
      if (canonicalizeJson(existing.manifest) !== canonicalizeJson(manifest)) {
        throw browserError('E2E_CHROMIUM_VERSION_CONFLICT', '同一 Runtime/browser 版本已有不同闭包')
      }
      return existing
    }
    return await inspectChromiumInstallation(options, operations)
  })
}

export async function inspectChromiumInstallation(
  options: InstallChromiumOptions,
  operations: BrowserInstallerOperations = productionBrowserInstallerOperations,
): Promise<ChromiumInstallation> {
  assertInstallOptions(options)
  const runtime = await operations.inspectRuntime(options.homeDir)
  if (runtime.version !== options.runtimeVersion
    || runtime.installationDigest !== options.runtimeInstallationDigest) {
    throw browserError('E2E_CHROMIUM_RUNTIME_BINDING_MISMATCH', 'Browser inspect 输入与当前已验证 Runtime 不一致')
  }
  const layout = runtimeLayout(options.homeDir)
  await operations.verifyRuntimeRoot(layout)
  const versionRoot = join(layout.browsers, options.runtimeVersion)
  await verifySafePrivateDirectory(layout.browsers)
  await verifySafePrivateDirectory(versionRoot)
  const playwright = await trustedPlaywright(operations, runtime)
  const root = join(versionRoot, `${process.platform}-${process.arch}`)
  await verifySafePrivateDirectory(root)
  const rootReal = await realpath(root).catch((cause) => {
    throw browserError('E2E_CHROMIUM_NOT_INSTALLED', '固定 Chromium 尚未安装', cause)
  })
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw browserError('E2E_CHROMIUM_INSTALLATION_UNSAFE', 'Browser root 必须是真实目录')
  }
  assertWithin(await realpath(runtimeLayout(options.homeDir).browsers), rootReal, 'E2E_CHROMIUM_INSTALLATION_UNSAFE')
  const manifest = parseBrowserManifest((await readNoFollowPrivateFile(
    join(rootReal, BROWSER_MANIFEST_FILE),
  )).toString('utf8'))
  if (manifest.runtimeVersion !== options.runtimeVersion
    || manifest.runtimeInstallationDigest !== options.runtimeInstallationDigest
    || manifest.playwrightVersion !== playwright.version
    || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw browserError('E2E_CHROMIUM_MANIFEST_BINDING_MISMATCH', 'Browser manifest 与当前 Runtime/Playwright/平台不一致')
  }
  const cli = await readSafeRegularFile(playwright.cliPath, playwright.packageRoot)
  if (manifest.cliByteLength !== cli.byteLength
    || manifest.cliDigest !== digestBytes('e2e-playwright-cli/v1', cli)) {
    throw browserError('E2E_CHROMIUM_MANIFEST_BINDING_MISMATCH', 'Browser manifest 的 Playwright CLI binding 已改变')
  }
  const files = await collectClosure(rootReal)
  const closureDigest = digestText('e2e-browser-closure/v1', canonicalizeJson(files))
  if (canonicalizeJson(files) !== canonicalizeJson(manifest.files)
    || closureDigest !== manifest.closureDigest) {
    throw browserError('E2E_CHROMIUM_CLOSURE_MISMATCH', 'Browser bundle closure bytes 已改变')
  }
  const executablePath = join(rootReal, ...manifest.executableRelativePath.split('/'))
  const executable = await readSafeRegularFile(executablePath, rootReal)
  if (manifest.executableByteLength !== executable.byteLength
    || manifest.executableDigest !== digestBytes('e2e-browser-executable/v1', executable)) {
    throw browserError('E2E_CHROMIUM_EXECUTABLE_MISMATCH', 'Chromium executable bytes 已改变')
  }
  return { root: rootReal, executablePath, manifest }
}

async function verifySafePrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path).catch((cause) => {
    throw browserError('E2E_CHROMIUM_NOT_INSTALLED', '固定 Chromium 目录不存在', cause)
  })
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700) {
    throw browserError('E2E_CHROMIUM_DIRECTORY_UNSAFE', 'Browser 路径每一级都必须是当前用户 0700 真实目录')
  }
}

export const productionBrowserInstallerOperations: BrowserInstallerOperations = Object.freeze({
  inspectRuntime: async (homeDir: string) => {
    const { installation } = await verifyCurrentRuntimeInstallation(runtimeLayout(homeDir))
    return {
      version: installation.version,
      installationDigest: installation.manifest.installationDigest,
      versionRoot: installation.versionRoot,
      manifestFiles: installation.manifest.files.map((file) => ({ ...file })),
    }
  },
  verifyRuntimeRoot: async (layout: RuntimeLayout) => { await verifyRuntimeRoot(layout) },
  resolvePlaywright: async () => {
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('playwright/package.json')
    const packageRoot = dirname(packageJsonPath)
    return { packageRoot, cliPath: join(packageRoot, 'cli.js'), version: EXPECTED_PLAYWRIGHT_VERSION }
  },
  runInstall: async (input: Parameters<BrowserInstallerOperations['runInstall']>[0]) => await spawnAndWait(input),
  readChromiumVersion: async (
    input: Parameters<BrowserInstallerOperations['readChromiumVersion']>[0],
  ) => await spawnAndCapture(input),
})

async function trustedPlaywright(
  operations: BrowserInstallerOperations,
  runtime: Awaited<ReturnType<BrowserInstallerOperations['inspectRuntime']>>,
) {
  const resolved = await operations.resolvePlaywright()
  if (resolved.version !== EXPECTED_PLAYWRIGHT_VERSION
    || !isAbsolute(resolved.packageRoot) || !isAbsolute(resolved.cliPath)) {
    throw browserError('E2E_PLAYWRIGHT_VERSION_MISMATCH', 'Runtime 必须使用 direct playwright@1.61.1')
  }
  const versionRoot = await realpath(runtime.versionRoot).catch((cause) => {
    throw browserError('E2E_PLAYWRIGHT_CLI_UNSAFE', '已验证 Runtime versionRoot 不可访问', cause)
  })
  const packageRoot = await realpath(resolved.packageRoot)
  const cliPath = await realpath(resolved.cliPath)
  assertWithin(versionRoot, packageRoot, 'E2E_PLAYWRIGHT_CLI_UNSAFE')
  assertWithin(packageRoot, cliPath, 'E2E_PLAYWRIGHT_CLI_UNSAFE')
  const packageJsonPath = join(packageRoot, 'package.json')
  const packageJsonBytes = await readSafeRegularFile(packageJsonPath, versionRoot)
  const cliBytes = await readSafeRegularFile(cliPath, versionRoot)
  assertRuntimeManifestFileBinding(runtime, versionRoot, packageJsonPath, packageJsonBytes)
  assertRuntimeManifestFileBinding(runtime, versionRoot, cliPath, cliBytes)
  let packageJson: unknown
  try { packageJson = JSON.parse(packageJsonBytes.toString('utf8')) } catch {
    throw browserError('E2E_PLAYWRIGHT_VERSION_MISMATCH', 'Playwright package metadata 非法')
  }
  if (!isRecord(packageJson) || packageJson.name !== 'playwright'
    || packageJson.version !== EXPECTED_PLAYWRIGHT_VERSION) {
    throw browserError('E2E_PLAYWRIGHT_VERSION_MISMATCH', 'Runtime 必须使用 direct playwright@1.61.1')
  }
  return { ...resolved, packageRoot, cliPath, version: EXPECTED_PLAYWRIGHT_VERSION as '1.61.1' }
}

function assertRuntimeManifestFileBinding(
  runtime: Awaited<ReturnType<BrowserInstallerOperations['inspectRuntime']>>,
  versionRoot: string,
  path: string,
  bytes: Buffer,
): void {
  const relativePath = relative(versionRoot, path).split(sep).join('/')
  const binding = runtime.manifestFiles.find((file) => file.path === relativePath)
  if (binding === undefined || binding.byteLength !== bytes.byteLength
    || binding.digest !== digestBytes('e2e-runtime-file/v1', bytes)) {
    throw browserError('E2E_PLAYWRIGHT_CLI_UNSAFE', 'Playwright package/CLI 不属于已验证 Runtime manifest closure')
  }
}

async function createBrowserManifest(
  root: string,
  options: InstallChromiumOptions,
  cliPath: string,
  operations: BrowserInstallerOperations,
): Promise<BrowserManifest> {
  const files = await collectClosure(root)
  const executables = files.filter((file) => file.kind === 'file' && isChromiumExecutablePath(file.path))
  if (executables.length !== 1) throw browserError(
    'E2E_CHROMIUM_EXECUTABLE_AMBIGUOUS', 'Browser closure 必须包含唯一固定 Chromium executable',
  )
  const executableRelativePath = executables[0]!.path
  const revision = /^chromium-(\d+)(?:\/|$)/.exec(executableRelativePath)?.[1]
  if (revision === undefined) throw browserError('E2E_CHROMIUM_REVISION_INVALID', '无法从 browser closure 固定 revision')
  const executable = await readSafeRegularFile(join(root, ...executableRelativePath.split('/')), root)
  const chromiumVersion = (await operations.readChromiumVersion({
    executablePath: join(root, ...executableRelativePath.split('/')),
    cwd: dirname(root),
    homeDir: join(dirname(root), 'home'),
    tempDir: join(dirname(root), 'tmp'),
  })).trim()
  if (chromiumVersion.length === 0 || chromiumVersion.length > 256) {
    throw browserError('E2E_CHROMIUM_VERSION_INVALID', 'Chromium --version 输出非法')
  }
  const cli = await readSafeRegularFile(cliPath, dirname(cliPath))
  return {
    schemaVersion: '1.0.0', runtimeVersion: options.runtimeVersion,
    runtimeInstallationDigest: options.runtimeInstallationDigest,
    playwrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
    platform: process.platform, arch: process.arch, revision,
    chromiumVersion,
    cliByteLength: cli.byteLength, cliDigest: digestBytes('e2e-playwright-cli/v1', cli),
    executableRelativePath, executableByteLength: executable.byteLength,
    executableDigest: digestBytes('e2e-browser-executable/v1', executable),
    files, closureDigest: digestText('e2e-browser-closure/v1', canonicalizeJson(files)),
  }
}

function isChromiumExecutablePath(path: string): boolean {
  return path.endsWith('/chrome')
    || path.endsWith('/Chromium.app/Contents/MacOS/Chromium')
    || path.endsWith('/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
}

async function collectClosure(root: string): Promise<BrowserClosureFile[]> {
  const rootReal = await realpath(root)
  const files: BrowserClosureFile[] = []
  await walk(rootReal, rootReal, '', files)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function walk(root: string, directory: string, prefix: string, files: BrowserClosureFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const relativePath = prefix === '' ? entry.name : posix.join(prefix, entry.name)
    if (relativePath === BROWSER_MANIFEST_FILE) continue
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      const resolved = await realpath(path)
      assertWithin(root, resolved, 'E2E_CHROMIUM_CLOSURE_SYMLINK_ESCAPE')
      const target = await readlink(path)
      files.push({ path: relativePath, kind: 'symlink', byteLength: Buffer.byteLength(target),
        digest: digestText('e2e-browser-symlink/v1', target) })
    } else if (metadata.isDirectory()) {
      if (metadata.uid !== currentUid() || (metadata.mode & 0o777) !== 0o700) {
        throw browserError('E2E_CHROMIUM_CLOSURE_MODE_INVALID', 'Browser closure 目录必须是当前用户 0700')
      }
      await walk(root, path, relativePath, files)
    } else if (metadata.isFile() && metadata.nlink === 1 && metadata.uid === currentUid()) {
      const expectedMode = (metadata.mode & 0o111) === 0 ? 0o600 : 0o700
      if ((metadata.mode & 0o777) !== expectedMode) {
        throw browserError('E2E_CHROMIUM_CLOSURE_MODE_INVALID', 'Browser closure 文件 mode 非法')
      }
      const bytes = await readSafeRegularFile(path, root)
      files.push({ path: relativePath, kind: 'file', byteLength: bytes.byteLength,
        digest: digestBytes('e2e-browser-closure-file/v1', bytes) })
    } else throw browserError('E2E_CHROMIUM_CLOSURE_UNSAFE_NODE', 'Browser closure 只允许目录、单链接文件和内部 symlink')
  }
}

async function normalizeBrowserClosure(directory: string, closureRoot?: string): Promise<void> {
  const root = closureRoot ?? await realpath(directory)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      assertWithin(root, await realpath(path), 'E2E_CHROMIUM_CLOSURE_SYMLINK_ESCAPE')
    } else if (metadata.isDirectory() && metadata.uid === currentUid()) {
      await chmod(path, 0o700)
      await normalizeBrowserClosure(path, root)
    } else if (metadata.isFile() && metadata.nlink === 1 && metadata.uid === currentUid()) {
      await chmod(path, (metadata.mode & 0o111) === 0 ? 0o600 : 0o700)
    } else {
      throw browserError('E2E_CHROMIUM_CLOSURE_UNSAFE_NODE', 'Browser closure 节点 owner/type/link count 非法')
    }
  }
}

async function readNoFollowPrivateFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUid()
      || (before.mode & 0o777) !== 0o600) {
      throw browserError('E2E_CHROMIUM_MANIFEST_INVALID', 'Browser manifest 必须是当前用户 0600 单链接普通文件')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    assertStableFileRead(before, after, bytes, 'E2E_CHROMIUM_MANIFEST_INVALID')
    return bytes
  } finally { await handle.close() }
}

interface BrowserInstallOwnerMarker {
  schemaVersion: '1.0.0'
  ownerUid: number
  pid: number
  ownerNonce: string
  stagingName: string
}

async function withBrowserInstallLock<T>(
  layout: RuntimeLayout,
  stagingName: string,
  operation: (transactionRoot: string) => Promise<T>,
): Promise<T> {
  const marker: BrowserInstallOwnerMarker = {
    schemaVersion: '1.0.0', ownerUid: currentUid(), pid: process.pid,
    ownerNonce: randomBytes(32).toString('hex'), stagingName,
  }
  const lock = await acquireBrowserInstallLock(layout, marker)
  const transactionRoot = join(layout.browsers, stagingName)
  let result: T | undefined
  let operationError: unknown
  try {
    await mkdir(transactionRoot, { mode: 0o700 })
    await writeDurableFile(
      join(transactionRoot, INSTALL_OWNER_FILE), `${canonicalizeJson(marker)}\n`,
    )
    await fsyncDirectory(transactionRoot)
    result = await operation(transactionRoot)
  } catch (error) {
    operationError = error
  }
  const cleanupErrors: unknown[] = []
  try { await rm(transactionRoot, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
  try { await releaseBrowserInstallLock(layout, marker, lock) } catch (error) { cleanupErrors.push(error) }
  if (cleanupErrors.length > 0) throw browserError(
    'E2E_CHROMIUM_INSTALL_CLEANUP_FAILED', 'Browser 安装事务清理失败',
    new AggregateError(operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors]),
  )
  if (operationError !== undefined) throw operationError
  return result as T
}

async function acquireBrowserInstallLock(layout: RuntimeLayout, marker: BrowserInstallOwnerMarker) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(
        layout.browserInstallLock,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(`${canonicalizeJson(marker)}\n`)
        await handle.chmod(0o600)
        await handle.sync()
        await fsyncDirectory(dirname(layout.browserInstallLock))
        return handle
      } catch (error) {
        await handle.close().catch(() => undefined)
        await unlink(layout.browserInstallLock).catch(() => undefined)
        throw error
      }
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') || attempt > 0) throw error
      await recoverStaleBrowserInstall(layout)
    }
  }
  throw browserError('E2E_CHROMIUM_INSTALL_LOCKED', '另一个 Browser 安装事务正在运行')
}

async function recoverStaleBrowserInstall(layout: RuntimeLayout): Promise<void> {
  const lockRead = await readInstallOwnerMarker(layout.browserInstallLock)
  const marker = lockRead.marker
  if (isProcessAlive(marker.pid)) {
    throw browserError('E2E_CHROMIUM_INSTALL_LOCKED', '另一个 Browser 安装事务正在运行')
  }
  const staging = join(layout.browsers, marker.stagingName)
  const stagingMetadata = await lstat(staging).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (stagingMetadata !== undefined) {
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()
      || stagingMetadata.uid !== currentUid() || (stagingMetadata.mode & 0o777) !== 0o700) {
      throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'stale staging 不是当前用户 0700 真实目录')
    }
    assertWithin(await realpath(layout.browsers), await realpath(staging), 'E2E_CHROMIUM_INSTALL_LOCK_UNSAFE')
    const ownerPath = join(staging, INSTALL_OWNER_FILE)
    const owner = await readInstallOwnerMarker(ownerPath).catch(async (error: unknown) => {
      if (isNodeError(error, 'ENOENT') && (await readdir(staging)).length === 0) return undefined
      throw error
    })
    if (owner !== undefined && canonicalizeJson(owner.marker) !== canonicalizeJson(marker)) {
      throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'stale staging owner marker 与 lock 不一致')
    }
  }
  await assertPathStillNamesFile(layout.browserInstallLock, lockRead.metadata)
  if (stagingMetadata !== undefined) await rm(staging, { recursive: true, force: false })
  await unlink(layout.browserInstallLock)
  await fsyncDirectory(dirname(layout.browserInstallLock))
}

async function releaseBrowserInstallLock(
  layout: RuntimeLayout,
  expected: BrowserInstallOwnerMarker,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const handleMetadata = await handle.stat()
  try {
    const stored = await readInstallOwnerMarker(layout.browserInstallLock)
    if (canonicalizeJson(stored.marker) !== canonicalizeJson(expected)
      || stored.metadata.dev !== handleMetadata.dev || stored.metadata.ino !== handleMetadata.ino) {
      throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'Browser install lock owner 在事务中发生变化')
    }
    await unlink(layout.browserInstallLock)
    await fsyncDirectory(dirname(layout.browserInstallLock))
  } finally { await handle.close() }
}

async function readInstallOwnerMarker(path: string): Promise<{
  marker: BrowserInstallOwnerMarker
  metadata: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>
}> {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (isNodeError(error, 'ELOOP')) throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'install marker 不得是 symlink')
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUid()
      || (before.mode & 0o777) !== 0o600 || before.size > 4096) {
      throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'install marker 必须是当前用户 0600 单链接普通文件')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    assertStableFileRead(before, after, bytes, 'E2E_CHROMIUM_INSTALL_LOCK_UNSAFE')
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch {
      throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'install marker JSON 非法')
    }
    const parsed = BrowserInstallOwnerMarkerSchema.safeParse(value)
    if (!parsed.success || parsed.data.ownerUid !== currentUid()) {
      throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'install marker binding 非法')
    }
    return { marker: parsed.data, metadata: after }
  } finally { await handle.close() }
}

async function assertPathStillNamesFile(
  path: string,
  expected: { dev: number | bigint; ino: number | bigint },
): Promise<void> {
  const actual = await lstat(path)
  if (!actual.isFile() || actual.isSymbolicLink()
    || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw browserError('E2E_CHROMIUM_INSTALL_LOCK_UNSAFE', 'install lock 在 stale recovery 中发生变化')
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return !isNodeError(error, 'ESRCH') }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
    await chmod(path, 0o700)
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()
      || (metadata.mode & 0o777) !== 0o700) {
      throw browserError('E2E_CHROMIUM_DIRECTORY_UNSAFE', '既有 Browser 目录必须是当前用户 0700 真实目录')
    }
  }
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(contents); await handle.chmod(0o600); await handle.sync() } finally { await handle.close() }
}

async function fsyncTree(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await fsyncTree(join(path, entry))
    await fsyncDirectory(path)
    return
  }
  if (!metadata.isFile()) throw browserError('E2E_CHROMIUM_CLOSURE_UNSAFE_NODE', '无法 fsync 非普通 Browser closure 节点')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== currentUid()
      || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw browserError('E2E_CHROMIUM_CLOSURE_UNSAFE_NODE', 'fsync Browser closure 时普通文件发生替换')
    }
    await handle.sync()
  } finally { await handle.close() }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
}

async function readSafeRegularFile(path: string, root: string): Promise<Buffer> {
  const rootReal = await realpath(root)
  const parentReal = await realpath(dirname(path))
  assertWithin(rootReal, parentReal, 'E2E_CHROMIUM_INSTALLATION_UNSAFE')
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (isNodeError(error, 'ELOOP')) throw browserError('E2E_CHROMIUM_INSTALLATION_UNSAFE', '普通文件不得是 symlink')
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUid()) {
      throw browserError('E2E_CHROMIUM_INSTALLATION_UNSAFE', '必须读取当前用户拥有的单链接普通文件')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    assertStableFileRead(before, after, bytes, 'E2E_CHROMIUM_INSTALLATION_UNSAFE')
    const named = await lstat(path)
    if (!named.isFile() || named.isSymbolicLink()
      || named.dev !== after.dev || named.ino !== after.ino) {
      throw browserError('E2E_CHROMIUM_INSTALLATION_UNSAFE', '普通文件在读取期间发生路径替换')
    }
    assertWithin(rootReal, await realpath(path), 'E2E_CHROMIUM_INSTALLATION_UNSAFE')
    return bytes
  } finally { await handle.close() }
}

function assertStableFileRead(
  before: { dev: number; ino: number; size: number; mtimeMs: number },
  after: { dev: number; ino: number; size: number; mtimeMs: number },
  bytes: Buffer,
  code: string,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
    throw browserError(code, '普通文件在读取期间发生变化')
  }
}

function parseBrowserManifest(text: string): BrowserManifest {
  let value: unknown
  try { value = JSON.parse(text) } catch (cause) { throw browserError('E2E_CHROMIUM_MANIFEST_INVALID', 'manifest 不是 JSON', cause) }
  const parsed = BrowserManifestSchema.safeParse(value)
  if (!parsed.success) {
    throw browserError('E2E_CHROMIUM_MANIFEST_INVALID', 'manifest 结构非法')
  }
  return parsed.data as BrowserManifest
}

function assertInstallOptions(options: InstallChromiumOptions): void {
  if (!SAFE_VERSION.test(options.runtimeVersion) || !DIGEST_PATTERN.test(options.runtimeInstallationDigest)) {
    throw browserError('E2E_CHROMIUM_INSTALL_INPUT_INVALID', 'Browser 安装必须绑定精确 Runtime version 与 installation digest')
  }
}

function assertWithin(root: string, candidate: string, code: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw browserError(code, '路径逃逸固定根目录')
}

async function spawnAndWait(input: Parameters<BrowserInstallerOperations['runInstall']>[0]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(input.executable, input.arguments, {
      cwd: input.cwd, env: input.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timeoutMs = input.timeoutMs ?? INSTALL_CHILD_TIMEOUT_MS
    const terminationGraceMs = input.terminationGraceMs ?? INSTALL_CHILD_TERMINATION_GRACE_MS
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalCode: 'E2E_CHROMIUM_INSTALL_OUTPUT_LIMIT' | 'E2E_CHROMIUM_INSTALL_TIMEOUT' | undefined
    let spawnError: unknown
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (code: typeof terminalCode) => {
      if (terminalCode !== undefined) return
      terminalCode = code
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { if (!child.killed || child.exitCode === null) child.kill('SIGKILL') }, terminationGraceMs)
    }
    const account = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (stream === 'stdout') stdoutBytes += chunk.byteLength
      else stderrBytes += chunk.byteLength
      if (stdoutBytes > INSTALL_CHILD_OUTPUT_LIMIT || stderrBytes > INSTALL_CHILD_OUTPUT_LIMIT) {
        terminate('E2E_CHROMIUM_INSTALL_OUTPUT_LIMIT')
      }
    }
    child.stdout.on('data', (chunk: Buffer) => account('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => account('stderr', chunk))
    child.once('error', (error) => { spawnError = error })
    const timeout = setTimeout(() => terminate('E2E_CHROMIUM_INSTALL_TIMEOUT'), timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (terminalCode !== undefined) {
        reject(browserError(terminalCode, terminalCode.endsWith('TIMEOUT')
          ? 'Playwright browser installer 超时并已终止'
          : 'Playwright browser installer 输出超过安全上限并已终止'))
      } else if (spawnError !== undefined) {
        reject(browserError('E2E_CHROMIUM_INSTALL_FAILED', 'Playwright browser installer 无法启动', spawnError))
      } else if (code === 0) resolvePromise()
      else reject(browserError('E2E_CHROMIUM_INSTALL_FAILED', 'Playwright browser installer 失败'))
    })
  })
}

async function spawnAndCapture(
  input: Parameters<BrowserInstallerOperations['readChromiumVersion']>[0],
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(input.executablePath, ['--version'], {
      cwd: input.cwd,
      env: {
        HOME: input.homeDir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        PATH: dirname(process.execPath), TMPDIR: input.tempDir,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalFailure = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      if (terminalFailure) return
      terminalFailure = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, INSTALL_CHILD_TERMINATION_GRACE_MS)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > 4096) terminate()
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > 4096) terminate()
    })
    let spawnError: unknown
    child.once('error', (error) => { spawnError = error })
    const timeout = setTimeout(terminate, 10_000)
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (!terminalFailure && spawnError === undefined && code === 0
        && stdoutBytes <= 4096 && stderrBytes <= 4096) {
        resolvePromise(Buffer.concat(chunks).toString('utf8'))
      } else reject(browserError(
        'E2E_CHROMIUM_VERSION_PROBE_FAILED', 'Chromium version probe 失败', spawnError,
      ))
    })
  })
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function browserError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}

const DigestSchema = z.string().regex(DIGEST_PATTERN)
const BrowserInstallOwnerMarkerSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  ownerUid: z.number().int().nonnegative(),
  pid: z.number().int().positive().max(2_147_483_647),
  ownerNonce: z.string().regex(/^[a-f0-9]{64}$/),
  stagingName: z.string().regex(STAGING_NAME),
}).strict()
const RelativeBrowserPathSchema = z.string().min(1).max(2048)
  .refine((path) => !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
const BrowserClosureFileSchema = z.object({
  path: RelativeBrowserPathSchema,
  kind: z.enum(['file', 'symlink']),
  byteLength: z.number().int().nonnegative().max(2 * 1024 * 1024 * 1024),
  digest: DigestSchema,
}).strict()
const BrowserManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runtimeVersion: z.string().regex(SAFE_VERSION),
  runtimeInstallationDigest: DigestSchema,
  playwrightVersion: z.literal(EXPECTED_PLAYWRIGHT_VERSION),
  platform: z.enum(['darwin', 'linux']),
  arch: z.string().min(1).max(64),
  revision: z.string().regex(/^\d+$/),
  chromiumVersion: z.string().min(1).max(256),
  cliByteLength: z.number().int().positive().max(64 * 1024 * 1024),
  cliDigest: DigestSchema,
  executableRelativePath: RelativeBrowserPathSchema,
  executableByteLength: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  executableDigest: DigestSchema,
  files: z.array(BrowserClosureFileSchema).min(1).max(200_000),
  closureDigest: DigestSchema,
}).strict().superRefine((manifest, context) => {
  const paths = manifest.files.map((file) => file.path)
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'closure files 必须唯一且严格排序' })
  }
  const executable = manifest.files.find((file) => file.path === manifest.executableRelativePath)
  if (executable?.kind !== 'file') context.addIssue({
    code: 'custom', path: ['executableRelativePath'], message: 'executable 必须存在于 closure files 且为普通文件',
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
