import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixedLauncherSource } from './launcher-template.js'
import { runtimeLayout, type RuntimeLayout } from './runtime-layout.js'
import {
  RUNTIME_MANIFEST_FILE,
  RUNTIME_OWNER_FILE,
  assertDirectory,
  assertExactRuntimeVersion,
  createRuntimeCurrent,
  createRuntimeManifest,
  currentUid,
  readRuntimeCurrent,
  runtimeError,
  validatePreparedRuntimeClosure,
  verifyInstalledRuntimeVersion,
  verifyRuntimeRoot,
  type RuntimeCurrentPointer,
  type VerifiedRuntimeVersion,
} from './runtime-manifest.js'
import { beginRuntimeInstallTransaction } from './runtime-install-recovery.js'
export { recoverRuntimeInstallTransaction } from './runtime-install-recovery.js'

export interface RuntimeClosureInstallInput {
  stagingPrefix: string
  version: string
}

export interface InstallRuntimeOptions {
  homeDir: string
  version: string
  installClosure?: (input: RuntimeClosureInstallInput) => Promise<void>
}

export interface RuntimeInstallResult {
  version: string
  installationDigest: string
  launcher: string
}

export interface ProductionClosureInstallInput {
  prefix: string
  packageSpec: string
  env: NodeJS.ProcessEnv
}

export interface RuntimeFileSnapshot {
  contents: Buffer
  mode: number
}

export class RuntimeActivationError extends AggregateError {
  readonly code: 'E2E_RUNTIME_ACTIVATION_FAILED' | 'E2E_RUNTIME_ACTIVATION_ROLLBACK_FAILED'
  readonly targetCleanupSafe: boolean
  readonly activationError: unknown
  readonly rollbackErrors: readonly unknown[]

  constructor(activationError: unknown, rollbackErrors: readonly unknown[]) {
    const targetCleanupSafe = rollbackErrors.length === 0
    const code = targetCleanupSafe
      ? 'E2E_RUNTIME_ACTIVATION_FAILED'
      : 'E2E_RUNTIME_ACTIVATION_ROLLBACK_FAILED'
    super(
      [activationError, ...rollbackErrors],
      `${code}: ${errorMessage(activationError)}`,
    )
    this.name = 'RuntimeActivationError'
    this.code = code
    this.targetCleanupSafe = targetCleanupSafe
    this.activationError = activationError
    this.rollbackErrors = [...rollbackErrors]
  }
}

export interface RuntimeInstallerOperations {
  fsyncVersions(path: string): Promise<void>
  verifyVersion(layout: RuntimeLayout, version: string): Promise<VerifiedRuntimeVersion>
  writeLauncher(layout: RuntimeLayout): Promise<void>
  writeCurrent(layout: RuntimeLayout, current: RuntimeCurrentPointer): Promise<void>
  restoreCurrent(layout: RuntimeLayout, snapshot: RuntimeFileSnapshot | undefined): Promise<void>
  restoreLauncher(layout: RuntimeLayout, snapshot: RuntimeFileSnapshot | undefined): Promise<void>
}

const INSTALLER_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'TMPDIR',
  'npm_config_registry',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'npm_config_cafile',
] as const

export class ProductionClosureInstaller {
  async install(input: ProductionClosureInstallInput): Promise<void> {
    if (!isAbsolute(input.prefix)) {
      runtimeError('E2E_RUNTIME_STAGING_INVALID', '生产 closure prefix 必须是绝对路径', 'input')
    }
    const npmCliPath = process.env.npm_execpath
    if (npmCliPath === undefined || !isAbsolute(npmCliPath)) {
      runtimeError('E2E_RUNTIME_NPM_BOOTSTRAP_INVALID', '无法从当前 bootstrap 固定 npm CLI', 'environment')
    }
    const packageSpecMatch = /^@mutil-skills\/e2e-runtime@(.+)$/.exec(input.packageSpec)
    if (packageSpecMatch === null) {
      runtimeError('E2E_RUNTIME_VERSION_INVALID', '生产 closure 必须固定 Runtime package 与精确版本', 'input')
    }
    assertExactRuntimeVersion(packageSpecMatch[1]!)
    const npmArguments = [
      npmCliPath,
      'install',
      '--prefix',
      input.prefix,
      '--ignore-scripts',
      '--omit=dev',
      '--no-bin-links',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      input.packageSpec,
    ]
    await spawnAndWait(process.execPath, npmArguments, input.prefix, sanitizeInstallerEnvironment(input.env))
  }
}

export async function installRuntime(options: InstallRuntimeOptions): Promise<RuntimeInstallResult> {
  return installRuntimeWithOperations(options, runtimeInstallerOperations)
}

export async function installRuntimeWithOperations(
  options: InstallRuntimeOptions,
  operations: RuntimeInstallerOperations,
): Promise<RuntimeInstallResult> {
  assertExactRuntimeVersion(options.version)
  const layout = runtimeLayout(options.homeDir)
  await prepareOwnedRuntimeRoot(layout)
  const transaction = await beginRuntimeInstallTransaction(layout, options.version)
  return (async () => {
    await verifyRuntimeRoot(layout)
    await ensurePrivateDirectory(layout.versions)
    await ensurePrivateDirectory(layout.browsers)
    const stagingPrefix = transaction.stagingPrefix
    await mkdir(stagingPrefix, { mode: 0o700 })
    await chmod(stagingPrefix, 0o700)
    await transaction.markStaging()
    const stagingRealpath = await realpath(stagingPrefix)
    const stagingIdentity = await lstat(stagingPrefix)
    const target = join(layout.versions, options.version)
    let createdTarget = false
    let activated = false
    try {
      const installClosure = options.installClosure ?? productionInstallClosure
      await installClosure({ stagingPrefix, version: options.version })
      const stagingAfterInstall = await lstat(stagingPrefix)
      if (await realpath(stagingPrefix) !== stagingRealpath
        || stagingAfterInstall.dev !== stagingIdentity.dev
        || stagingAfterInstall.ino !== stagingIdentity.ino) {
        runtimeError('E2E_RUNTIME_STAGING_REPLACED', '安装 closure 替换了固定 staging root')
      }
      await normalizeClosurePermissions(stagingPrefix)
      await validatePreparedRuntimeClosure(stagingPrefix, options.version)
      const manifest = await createRuntimeManifest(stagingPrefix)
      const manifestPath = join(stagingPrefix, RUNTIME_MANIFEST_FILE)
      await writeFile(manifestPath, `${canonicalizeJson(manifest)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }).catch((error: unknown) => {
        if (isNodeError(error, 'EEXIST')) {
          runtimeError('E2E_RUNTIME_MANIFEST_RESERVED', '安装 closure 不得预置根 runtime-manifest.json')
        }
        throw error
      })
      await chmod(manifestPath, 0o600)
      await fsyncTree(stagingPrefix)
      await transaction.markPreparedClosure(manifest.installationDigest)

      createdTarget = await placeVersionDirectory(stagingPrefix, target)
      if (createdTarget) await operations.fsyncVersions(layout.versions)
      const verified = await operations.verifyVersion(layout, options.version)
      if (verified.manifest.installationDigest !== manifest.installationDigest) {
        runtimeError('E2E_RUNTIME_VERSION_CONFLICT', '相同版本已存在但 installation digest 不同')
      }
      await transaction.markPublished()
      await activateRuntimeFiles(layout, verified, operations)
      activated = true
      return {
        version: verified.version,
        installationDigest: verified.manifest.installationDigest,
        launcher: layout.bin,
      }
    } catch (error) {
      const targetCleanupSafe = error instanceof RuntimeActivationError
        ? error.targetCleanupSafe
        : true
      if (createdTarget && !activated && targetCleanupSafe) {
        await removeNewVersionTarget(target, stagingIdentity)
      }
      throw error
    } finally {
      await rm(stagingPrefix, { recursive: true, force: true })
      await transaction.release()
    }
  })()
}

export const runtimeInstallerOperations: RuntimeInstallerOperations = Object.freeze({
  fsyncVersions: fsyncDirectory,
  verifyVersion: verifyInstalledRuntimeVersion,
  writeLauncher: writeFixedLauncher,
  writeCurrent: writeCurrentPointer,
  restoreCurrent: restoreCurrentPointer,
  restoreLauncher: restoreFixedLauncher,
})

export async function withRuntimeInstallLock<T>(layout: RuntimeLayout, operation: () => Promise<T>): Promise<T> {
  let handle
  try {
    handle = await open(
      layout.installLock,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      runtimeError('E2E_RUNTIME_INSTALL_LOCKED', '另一个 Runtime 安装事务正在运行', 'environment')
    }
    throw error
  }
  try {
    await handle.writeFile(`${canonicalizeJson({ pid: process.pid })}\n`, 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
    return await operation()
  } finally {
    await handle.close()
    await unlink(layout.installLock).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
    await fsyncDirectory(layout.root)
  }
}

export async function writeActiveRuntimeFiles(
  layout: RuntimeLayout,
  verified: VerifiedRuntimeVersion,
): Promise<RuntimeCurrentPointer> {
  return activateRuntimeFiles(layout, verified, runtimeInstallerOperations)
}

async function productionInstallClosure(input: RuntimeClosureInstallInput): Promise<void> {
  await new ProductionClosureInstaller().install({
    prefix: input.stagingPrefix,
    packageSpec: `@mutil-skills/e2e-runtime@${input.version}`,
    env: process.env,
  })
}

async function prepareOwnedRuntimeRoot(layout: RuntimeLayout): Promise<void> {
  if (await pathExists(layout.root)) {
    await verifyRuntimeRoot(layout)
    return
  }
  const runtimeParent = dirname(layout.root)
  const productRoot = dirname(runtimeParent)
  await ensurePrivateDirectory(productRoot)
  await ensurePrivateDirectory(runtimeParent)
  try {
    await mkdir(layout.root, { mode: 0o700 })
    await chmod(layout.root, 0o700)
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      await verifyRuntimeRoot(layout)
      return
    }
    throw error
  }
  const marker = {
    schemaVersion: '1.0.0',
    product: '@mutil-skills/e2e-runtime',
    ownerUid: currentUid(),
  }
  try {
    await atomicWriteFile(join(layout.root, RUNTIME_OWNER_FILE), `${canonicalizeJson(marker)}\n`, 0o600)
  } catch (error) {
    await rm(layout.root, { recursive: false, force: true }).catch(() => undefined)
    throw error
  }
  await verifyRuntimeRoot(layout)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
    await chmod(path, 0o700)
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
    await assertDirectory(path, 'E2E_RUNTIME_DIRECTORY_UNSAFE', true)
  }
}

async function normalizeClosurePermissions(directory: string): Promise<void> {
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
    runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', '安装闭包目录类型或 owner 无效')
  }
  await chmod(directory, 0o700)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const child = await lstat(path)
    if (child.isSymbolicLink()) {
      runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', '安装闭包不得包含 symlink')
    }
    if (child.isDirectory()) {
      await normalizeClosurePermissions(path)
    } else if (child.isFile() && child.nlink === 1 && child.uid === currentUid()) {
      await chmod(path, (child.mode & 0o111) === 0 ? 0o600 : 0o700)
    } else {
      runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', '安装闭包只接受当前用户拥有的单链接普通文件')
    }
  }
}

async function placeVersionDirectory(
  stagingPrefix: string,
  target: string,
): Promise<boolean> {
  if (await pathExists(target)) return false
  try {
    await rename(stagingPrefix, target)
    return true
  } catch (error) {
    if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error
    return false
  }
}

async function activateRuntimeFiles(
  layout: RuntimeLayout,
  verified: VerifiedRuntimeVersion,
  operations: RuntimeInstallerOperations,
): Promise<RuntimeCurrentPointer> {
  const current = createRuntimeCurrent(verified)
  const launcherBefore = await snapshotFile(layout.bin)
  const currentBefore = await snapshotFile(layout.current)
  let launcherWriteAttempted = false
  let currentWriteAttempted = false
  try {
    launcherWriteAttempted = true
    await operations.writeLauncher(layout)
    await verifyFixedLauncher(layout)
    currentWriteAttempted = true
    await operations.writeCurrent(layout, current)
    const writtenCurrent = await readRuntimeCurrent(layout)
    if (canonicalizeJson(writtenCurrent) !== canonicalizeJson(current)) {
      runtimeError('E2E_RUNTIME_CURRENT_MISMATCH', '激活后的 current pointer 与目标 installation 不一致')
    }
    return current
  } catch (error) {
    const rollbackErrors: unknown[] = []
    if (currentWriteAttempted) {
      try {
        await operations.restoreCurrent(layout, currentBefore)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (launcherWriteAttempted) {
      try {
        await operations.restoreLauncher(layout, launcherBefore)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    throw new RuntimeActivationError(error, rollbackErrors)
  }
}

async function writeFixedLauncher(layout: RuntimeLayout): Promise<void> {
  const binDirectory = dirname(layout.bin)
  await ensurePrivateDirectory(binDirectory)
  await atomicWriteFile(layout.bin, fixedLauncherSource(layout), 0o700)
}

async function writeCurrentPointer(layout: RuntimeLayout, current: RuntimeCurrentPointer): Promise<void> {
  await atomicWriteFile(layout.current, `${canonicalizeJson(current)}\n`, 0o600)
}

async function restoreCurrentPointer(
  layout: RuntimeLayout,
  snapshot: RuntimeFileSnapshot | undefined,
): Promise<void> {
  await restoreFile(layout.current, snapshot)
}

async function restoreFixedLauncher(
  layout: RuntimeLayout,
  snapshot: RuntimeFileSnapshot | undefined,
): Promise<void> {
  await restoreFile(layout.bin, snapshot)
}

async function verifyFixedLauncher(layout: RuntimeLayout): Promise<void> {
  const metadata = await lstat(layout.bin)
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700
    || await readFile(layout.bin, 'utf8') !== fixedLauncherSource(layout)) {
    runtimeError('E2E_RUNTIME_LAUNCHER_INVALID', '固定 launcher 写入后验证失败')
  }
}

async function snapshotFile(path: string): Promise<RuntimeFileSnapshot | undefined> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== currentUid()) {
      runtimeError('E2E_RUNTIME_FILE_UNSAFE', '事务快照只接受当前用户拥有的单链接普通文件')
    }
    return { contents: await readFile(path), mode: metadata.mode & 0o777 }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

async function restoreFile(path: string, snapshot: RuntimeFileSnapshot | undefined): Promise<void> {
  if (snapshot === undefined) {
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
    if (await pathExists(dirname(path))) await fsyncDirectory(dirname(path))
    return
  }
  await atomicWriteFile(path, snapshot.contents, snapshot.mode)
}

async function removeNewVersionTarget(target: string, identity: { dev: number; ino: number }): Promise<void> {
  const targetIdentity = await lstat(target).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (targetIdentity === undefined) {
    await fsyncDirectory(dirname(target))
    return
  }
  if (targetIdentity.dev !== identity.dev || targetIdentity.ino !== identity.ino) {
    runtimeError('E2E_RUNTIME_VERSION_PATH_UNSAFE', '失败清理只允许删除本事务 rename 的 version root')
  }
  await rm(target, { recursive: true, force: true })
  await fsyncDirectory(dirname(target))
}

async function atomicWriteFile(path: string, contents: string | Uint8Array, mode: number): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    await fsyncDirectory(directory)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function fsyncTree(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isDirectory()) {
    const entries = await readdir(path)
    for (const entry of entries) await fsyncTree(join(path, entry))
    await fsyncDirectory(path)
    return
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', 'fsync 仅接受安全安装闭包')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function spawnAndWait(
  executable: string,
  arguments_: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`E2E_RUNTIME_CLOSURE_INSTALL_FAILED: npm bootstrap exit ${code ?? signal ?? 'unknown'}`))
    })
  })
}

function sanitizeInstallerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const key of INSTALLER_ENVIRONMENT_KEYS) {
    const value = environment[key]
    if (value !== undefined) sanitized[key] = value
  }
  return sanitized
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
