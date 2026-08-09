import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
import { currentUid, verifyInstalledRuntimeVersion } from './runtime-manifest.js'
import { installRuntime, ProductionClosureInstaller } from './runtime-installer.js'
import type { ExistingRunRevocationChecker, StableRuntimeResolver } from './runtime-resolver.js'
import {
  applyStableRuntimeUpdate,
  checkRuntimeInstallationRevocation,
  RuntimeUpdateError,
  type InstalledRuntimeIdentity,
  type RuntimeTargetEnvironment,
  type SignedRuntimeTarget,
  type TrustedMetadataSet,
} from './runtime-update-trust.js'
import {
  TufRuntimeUpdateClient,
  readRuntimeUpdateState,
  writeRuntimeUpdateState,
} from './tuf-runtime-update-client.js'

export interface RuntimeUpdateClient {
  refresh(): Promise<{ metadata: TrustedMetadataSet; target: SignedRuntimeTarget }>
  downloadTarget?(target: SignedRuntimeTarget): Promise<string>
}

export function createExistingRunRevocationChecker(
  homeDir: string,
  now: () => Date = () => new Date(),
): ExistingRunRevocationChecker {
  return async ({ installationDigest }) => checkRuntimeInstallationRevocation(
    await readRuntimeUpdateState(homeDir), installationDigest, now(),
  )
}

export interface StableRuntimeUpdateServiceOptions {
  homeDir: string
  enabled: boolean
  trustedRootPath: string
  metadataBaseUrl: string
  targetBaseUrl: string
  targetPath: string
  /** 由 bootstrap 固定并审核的 npm CLI 绝对路径；仅默认 tarball installer 使用。 */
  npmCliPath?: string
  now?: () => Date
  environment: RuntimeTargetEnvironment
  clientFactory?: () => RuntimeUpdateClient
  installCandidate?: (target: SignedRuntimeTarget) => Promise<InstalledRuntimeIdentity>
  doctor: (installed: InstalledRuntimeIdentity) => Promise<void>
  canary: (installed: InstalledRuntimeIdentity) => Promise<void>
}

/**
 * 生产更新编排边界。真实 root/origin 未配置时 fail closed；不会回退到 offline。
 * closure 由 installCandidate 以 activate=false 发布，只有本状态中的 new-run-default 会被新 Run 选择。
 */
export function createStableRuntimeResolver(options: StableRuntimeUpdateServiceOptions): StableRuntimeResolver {
  return async () => await withRuntimeUpdateLock(options.homeDir, async () => {
    const client = options.clientFactory?.() ?? new TufRuntimeUpdateClient({
      homeDir: options.homeDir,
      trustedRootPath: options.trustedRootPath,
      metadataBaseUrl: options.metadataBaseUrl,
      targetBaseUrl: options.targetBaseUrl,
      targetPath: options.targetPath,
    })
    const result = await applyStableRuntimeUpdate({
      enabled: options.enabled,
      trustedRootPath: options.trustedRootPath,
      metadataBaseUrl: options.metadataBaseUrl,
      now: options.now ?? (() => new Date()),
      environment: options.environment,
      loadState: async () => await readRuntimeUpdateState(options.homeDir),
      saveState: async (state) => await writeRuntimeUpdateState(options.homeDir, state),
      refresh: async () => await client.refresh(),
      install: options.installCandidate ?? (async (target) => {
        if (client.downloadTarget === undefined) {
          throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_DOWNLOADER_UNAVAILABLE', 'TUF 客户端没有 target 下载能力')
        }
        const tarballPath = await client.downloadTarget(target)
        if (options.npmCliPath === undefined) {
          throw new RuntimeUpdateError('E2E_RUNTIME_NPM_BOOTSTRAP_INVALID', '默认 stable installer 缺少固定 npm CLI 绝对路径')
        }
        return await installSignedRuntimeCandidate(options.homeDir, target, tarballPath, options.npmCliPath)
      }),
      doctor: options.doctor,
      canary: options.canary,
    })
    return {
      runtimeVersion: result.target.custom.runtimeVersion,
      installationDigest: result.target.custom.installationDigest,
      revocationStatus: 'revocation-checked',
    }
  })
}

export async function installSignedRuntimeCandidate(
  homeDir: string,
  target: SignedRuntimeTarget,
  tarballPath: string,
  npmCliPath: string,
): Promise<InstalledRuntimeIdentity> {
  const installed = await installRuntime({
    homeDir,
    version: target.custom.runtimeVersion,
    activate: false,
    installClosure: async ({ stagingPrefix }) => await new ProductionClosureInstaller().installTarball({
      prefix: stagingPrefix,
      tarballPath,
      npmCliPath,
      expectedLength: target.length,
      expectedIntegrity: target.custom.npmIntegrity,
      env: process.env,
    }),
  })
  // installer 已完整验证 package identity、内部包版本、manifest、content 与 executable closure。
  await verifyInstalledRuntimeVersion(runtimeLayout(homeDir), installed.version)
  return {
    runtimeVersion: installed.version,
    installationDigest: installed.installationDigest,
    contentDigest: installed.contentDigest ?? '',
    executableDigest: installed.executableDigest ?? '',
    npmIntegrity: target.custom.npmIntegrity,
  }
}

async function withRuntimeUpdateLock<T>(homeDir: string, operation: () => Promise<T>): Promise<T> {
  const state = runtimeLayout(homeDir).state
  await ensurePrivateStateDirectory(state)
  const lock = join(state, 'runtime-update.lock')
  const acquired = await acquireRuntimeUpdateLock(lock, state)
  try {
    return await operation()
  } finally {
    await releaseRuntimeUpdateLock(lock, state, acquired)
  }
}

interface RuntimeUpdateLockBinding {
  schemaVersion: '1.0.0'
  ownerUid: number
  pid: number
  nonce: string
}

async function acquireRuntimeUpdateLock(lock: string, directory: string): Promise<{
  handle: Awaited<ReturnType<typeof open>>
  binding: RuntimeUpdateLockBinding
  device: bigint
  inode: bigint
}> {
  const binding: RuntimeUpdateLockBinding = {
    schemaVersion: '1.0.0', ownerUid: currentUid(), pid: process.pid, nonce: randomBytes(32).toString('hex'),
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle
    try {
      handle = await open(lock,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(`${canonicalizeJson(binding)}\n`, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
      const metadata = await handle.stat({ bigint: true })
      await fsyncDirectory(directory)
      return { handle, binding, device: metadata.dev, inode: metadata.ino }
    } catch (cause) {
      await handle?.close().catch(() => undefined)
      if (isNodeError(cause, 'EEXIST') && attempt === 0) {
        await recoverStaleRuntimeUpdateLock(lock, directory)
        continue
      }
      if (cause instanceof RuntimeUpdateError) throw cause
      if (isNodeError(cause, 'EEXIST')) {
        throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCKED', '另一个签名 Runtime 更新事务正在运行')
      }
      throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', '无法安全取得 Runtime update lock', { cause })
    }
  }
  throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCKED', '另一个签名 Runtime 更新事务正在运行')
}

async function recoverStaleRuntimeUpdateLock(lock: string, directory: string): Promise<void> {
  const opened = await readRuntimeUpdateLock(lock)
  try {
    try {
      process.kill(opened.binding.pid, 0)
      throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCKED', '另一个签名 Runtime 更新事务仍存活')
    } catch (cause) {
      if (cause instanceof RuntimeUpdateError) throw cause
      if (!isNodeError(cause, 'ESRCH')) {
        throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', '无法证明遗留 Runtime update owner 已死亡', { cause })
      }
    }
    const current = await lstat(lock, { bigint: true })
    if (current.dev !== opened.device || current.ino !== opened.inode) {
      throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock 在恢复期间被替换')
    }
    await unlink(lock)
    await fsyncDirectory(directory)
  } finally { await opened.handle.close() }
}

async function releaseRuntimeUpdateLock(
  lock: string,
  directory: string,
  acquired: Awaited<ReturnType<typeof acquireRuntimeUpdateLock>>,
): Promise<void> {
  let opened: Awaited<ReturnType<typeof readRuntimeUpdateLock>> | undefined
  try {
    opened = await readRuntimeUpdateLock(lock)
    if (opened.device !== acquired.device || opened.inode !== acquired.inode) {
      throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock owner 在事务中发生变化')
    }
    if (canonicalizeJson(opened.binding) !== canonicalizeJson(acquired.binding)) {
      throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock binding 在事务中发生变化')
    }
    await unlink(lock)
    await fsyncDirectory(directory)
  } finally {
    await opened?.handle.close().catch(() => undefined)
    await acquired.handle.close()
  }
}

async function readRuntimeUpdateLock(lock: string): Promise<{
  handle: Awaited<ReturnType<typeof open>>
  binding: RuntimeUpdateLockBinding
  device: bigint
  inode: bigint
}> {
  let handle
  try {
    handle = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat({ bigint: true })
    if (!metadata.isFile() || metadata.uid !== BigInt(currentUid()) || metadata.nlink !== 1n
      || (metadata.mode & 0o777n) !== 0o600n || metadata.size <= 0n || metadata.size > 1024n) {
      throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock 不是当前用户独占的 0600 普通文件')
    }
    return {
      handle, binding: parseRuntimeUpdateLock(await handle.readFile({ encoding: 'utf8' })),
      device: metadata.dev, inode: metadata.ino,
    }
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    if (cause instanceof RuntimeUpdateError) throw cause
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', '无法安全读取 Runtime update lock', { cause })
  }
}

function parseRuntimeUpdateLock(text: string): RuntimeUpdateLockBinding {
  let candidate: unknown
  try { candidate = JSON.parse(text) } catch (cause) {
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock JSON 无效', { cause })
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
    || Object.keys(candidate).sort().join(',') !== 'nonce,ownerUid,pid,schemaVersion') {
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock schema 无效')
  }
  const value = candidate as Record<string, unknown>
  if (value.schemaVersion !== '1.0.0' || value.ownerUid !== currentUid()
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce)) {
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_LOCK_UNSAFE', 'Runtime update lock binding 无效')
  }
  return value as unknown as RuntimeUpdateLockBinding
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function ensurePrivateStateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
    throw new RuntimeUpdateError('E2E_RUNTIME_UPDATE_DIRECTORY_UNSAFE', 'Runtime update state 目录不安全')
  }
  if ((metadata.mode & 0o777) !== 0o700) await chmod(path, 0o700)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
