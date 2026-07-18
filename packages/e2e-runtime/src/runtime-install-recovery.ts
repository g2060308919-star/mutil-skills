import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod, lstat, mkdir, open, readFile, realpath, rename, rm,
} from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { currentUid, runtimeError, verifyInstalledRuntimeVersion } from './runtime-manifest.js'
import type { RuntimeLayout } from './runtime-layout.js'

const execFileAsync = promisify(execFile)
const OWNER_FILE = 'install-owner.json'
const TOMBSTONE_DIRECTORY = 'install-recovery-tombstones'
const STAGING_NAME = /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NONCE = /^[a-f0-9]{64}$/
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const NODE_PROCESS_START_EPOCH_MS = Math.floor(Date.now() - process.uptime() * 1_000)

export interface RuntimeInstallOwnerBinding {
  schemaVersion: '1.0.0'
  ownerUid: number
  pid: number
  processStartIdentity: string
  ownerNonce: string
  runtimeRoot: { canonicalPath: string; device: string; inode: string }
  stagingName: string
  targetVersion: string
}

export interface RuntimeInstallOwnerMarker extends RuntimeInstallOwnerBinding {
  phase: 'prepared' | 'locked' | 'staging' | 'prepared-closure' | 'published' | 'releasing'
  installationDigestIntent: 'pending' | string
}

export interface RuntimeInstallRecoveryOperations {
  inspectOwnerProcess(pid: number): Promise<
    | { status: 'alive'; startIdentity: string }
    | { status: 'dead' }
    | { status: 'unknown' }
  >
}

export interface RuntimeInstallRecoveryResult {
  status: 'absent' | 'recovered'
  outcome?: 'aborted' | 'published-preserved'
  tombstonePath?: string
}

export interface RuntimeInstallTransaction {
  readonly stagingPrefix: string
  markStaging(): Promise<void>
  markPreparedClosure(installationDigest: string): Promise<void>
  markPublished(): Promise<void>
  release(): Promise<void>
}

const productionRecoveryOperations: RuntimeInstallRecoveryOperations = Object.freeze({
  inspectOwnerProcess: inspectOwnerProcess,
})

export async function recoverRuntimeInstallTransaction(
  layout: RuntimeLayout,
  operations: RuntimeInstallRecoveryOperations = productionRecoveryOperations,
): Promise<RuntimeInstallRecoveryResult> {
  const ownerPath = join(layout.root, OWNER_FILE)
  const ownerPresent = await exists(ownerPath)
  if (!ownerPresent) {
    if (await exists(layout.installLock)) blocked('install owner marker 缺失但 lock 仍存在')
    return { status: 'absent' }
  }

  try {
    const marker = parseOwnerMarker(await readTrustedFile(ownerPath))
    await verifyRootBinding(layout, marker)
    const processState = await operations.inspectOwnerProcess(marker.pid)
    // PID 复用不能作为“原 owner 已死亡”的充分证明：活 PID 无论启动身份是否相同都 fail closed。
    if (processState.status !== 'dead') blocked(
      processState.status === 'alive' && processState.startIdentity === marker.processStartIdentity
        ? 'installer owner 仍存活'
        : 'installer owner 生死或 PID 复用状态不确定',
    )

    const binding = ownerBinding(marker)
    const lockPresent = await exists(layout.installLock)
    if (lockPresent) {
      const storedBinding = parseOwnerBinding(await readTrustedFile(layout.installLock))
      if (canonicalizeJson(storedBinding) !== canonicalizeJson(binding)) {
        blocked('install lock 与 owner marker binding 不匹配')
      }
    } else if (marker.phase !== 'prepared' && marker.phase !== 'releasing') {
      blocked('install lock 在已持锁阶段缺失')
    }

    const target = join(layout.versions, marker.targetVersion)
    const targetPresent = await exists(target)
    const staging = join(layout.root, marker.stagingName)
    const stagingMetadata = await safeStagingMetadata(layout, staging)
    let outcome: 'aborted' | 'published-preserved'
    if (targetPresent) {
      if (!DIGEST.test(marker.installationDigestIntent)) {
        blocked('目标版本存在但 marker 未持久化 installation digest intent')
      }
      const verified = await verifyInstalledRuntimeVersion(layout, marker.targetVersion)
      if (verified.manifest.installationDigest !== marker.installationDigestIntent) {
        blocked('已发布目标与 marker digest intent 不匹配')
      }
      outcome = 'published-preserved'
    } else {
      if (marker.phase === 'published') blocked('marker 声明已发布但固定目标不存在')
      outcome = 'aborted'
    }

    const quarantine = join(layout.root, `.install-recovery-${marker.ownerNonce}`)
    await mkdir(quarantine, { mode: 0o700 }).catch((error: unknown) => {
      if (isNodeError(error, 'EEXIST')) blocked('installer recovery quarantine 已存在')
      throw error
    })
    await chmod(quarantine, 0o700)
    if (stagingMetadata !== undefined) {
      const isolated = join(quarantine, 'staging')
      await rename(staging, isolated)
      const isolatedMetadata = await lstat(isolated)
      if (isolatedMetadata.dev !== stagingMetadata.dev || isolatedMetadata.ino !== stagingMetadata.ino) {
        blocked('staging 在原子隔离时发生 path swap')
      }
    }
    if (lockPresent) {
      const lockIdentity = await lstat(layout.installLock)
      const isolatedLock = join(quarantine, 'install.lock')
      await rename(layout.installLock, isolatedLock)
      const isolatedIdentity = await lstat(isolatedLock)
      if (lockIdentity.dev !== isolatedIdentity.dev || lockIdentity.ino !== isolatedIdentity.ino) {
        blocked('install lock 在原子隔离时发生 path swap')
      }
    }
    const ownerIdentity = await lstat(ownerPath)
    const isolatedOwner = join(quarantine, OWNER_FILE)
    await rename(ownerPath, isolatedOwner)
    const isolatedOwnerIdentity = await lstat(isolatedOwner)
    if (ownerIdentity.dev !== isolatedOwnerIdentity.dev || ownerIdentity.ino !== isolatedOwnerIdentity.ino) {
      blocked('install owner marker 在原子隔离时发生 path swap')
    }
    await syncDirectory(layout.root)

    const tombstones = join(layout.root, TOMBSTONE_DIRECTORY)
    await ensurePrivateDirectory(tombstones)
    const tombstonePath = join(tombstones, `${marker.ownerNonce}.json`)
    await writeExclusiveTrustedFile(tombstonePath, `${canonicalizeJson({
      schemaVersion: '1.0.0', ownerBindingDigest: digestText(
        'e2e-runtime-install-owner-binding/v1', canonicalizeJson(binding),
      ), targetVersion: marker.targetVersion, installationDigestIntent: marker.installationDigestIntent,
      outcome,
    })}\n`)
    await rm(quarantine, { recursive: true, force: false })
    await syncDirectory(layout.root)
    return { status: 'recovered', outcome, tombstonePath }
  } catch (error) {
    if (error instanceof Error && error.message.includes('E2E_RUNTIME_INSTALL_RECOVERY_BLOCKED')) throw error
    blocked(`installer recovery 证明失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function beginRuntimeInstallTransaction(
  layout: RuntimeLayout,
  targetVersion: string,
): Promise<RuntimeInstallTransaction> {
  await recoverRuntimeInstallTransaction(layout)
  const rootMetadata = await lstat(layout.root)
  const binding: RuntimeInstallOwnerBinding = {
    schemaVersion: '1.0.0', ownerUid: currentUid(), pid: process.pid,
    processStartIdentity: await currentProcessStartIdentity(),
    ownerNonce: randomBytes(32).toString('hex'),
    runtimeRoot: { canonicalPath: await realpath(layout.root), device: String(rootMetadata.dev),
      inode: String(rootMetadata.ino) },
    stagingName: `.staging-${randomUUID()}`, targetVersion,
  }
  const ownerPath = join(layout.root, OWNER_FILE)
  let marker: RuntimeInstallOwnerMarker = { ...binding, phase: 'prepared', installationDigestIntent: 'pending' }
  await writeExclusiveTrustedFile(ownerPath, `${canonicalizeJson(marker)}\n`).catch((error: unknown) => {
    if (isNodeError(error, 'EEXIST')) blocked('另一个 installer 已持有 owner marker')
    throw error
  })
  try {
    await writeExclusiveTrustedFile(layout.installLock, `${canonicalizeJson(binding)}\n`).catch((error: unknown) => {
      if (isNodeError(error, 'EEXIST')) blocked('另一个 installer 已持有 install lock')
      throw error
    })
    marker = await replaceOwnerMarker(ownerPath, marker, { ...marker, phase: 'locked' })
  } catch (error) {
    await removeOwnedTransactionMetadata(layout, ownerPath, binding).catch(() => undefined)
    throw error
  }

  const update = async (next: RuntimeInstallOwnerMarker): Promise<void> => {
    marker = await replaceOwnerMarker(ownerPath, marker, next)
  }
  return Object.freeze({
    stagingPrefix: join(layout.root, binding.stagingName),
    markStaging: async () => { await update({ ...marker, phase: 'staging' }) },
    markPreparedClosure: async (installationDigest: string) => {
      if (!DIGEST.test(installationDigest)) blocked('prepared closure installation digest 非法')
      await update({ ...marker, phase: 'prepared-closure', installationDigestIntent: installationDigest })
    },
    markPublished: async () => {
      if (!DIGEST.test(marker.installationDigestIntent)) blocked('发布前必须持久化 installation digest intent')
      await update({ ...marker, phase: 'published' })
    },
    release: async () => {
      if (marker.phase !== 'releasing') await update({ ...marker, phase: 'releasing' })
      const storedLock = parseOwnerBinding(await readTrustedFile(layout.installLock))
      if (canonicalizeJson(storedLock) !== canonicalizeJson(binding)) blocked('release 时 lock binding 已改变')
      await rm(layout.installLock, { force: false })
      await syncDirectory(layout.root)
      const storedOwner = parseOwnerMarker(await readTrustedFile(ownerPath))
      if (canonicalizeJson(ownerBinding(storedOwner)) !== canonicalizeJson(binding)
        || storedOwner.phase !== 'releasing') blocked('release 时 owner marker 已改变')
      await rm(ownerPath, { force: false })
      await syncDirectory(layout.root)
    },
  })
}

export async function currentProcessStartIdentity(): Promise<string> {
  const inspected = await inspectOwnerProcess(process.pid)
  if (inspected.status !== 'alive') blocked('无法读取当前 installer 的 OS 启动身份')
  return inspected.startIdentity
}

async function inspectOwnerProcess(pid: number): Promise<Awaited<ReturnType<RuntimeInstallRecoveryOperations['inspectOwnerProcess']>>> {
  try { process.kill(pid, 0) } catch (error) {
    if (isNodeError(error, 'ESRCH')) return { status: 'dead' }
    return { status: 'unknown' }
  }
  try {
    if (process.platform === 'linux') {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ])
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      const startTicks = fields[19]
      if (startTicks === undefined || !/^\d+$/.test(startTicks)) return { status: 'unknown' }
      return { status: 'alive', startIdentity: `linux:${bootId.trim()}:${startTicks}` }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, maxBuffer: 4096,
      })
      const start = stdout.trim()
      return start === '' ? { status: 'unknown' } : { status: 'alive', startIdentity: `darwin:${start}` }
    }
  } catch {
    // macOS sandbox 可能禁止 ps。仅能为当前进程使用 Node 在启动时固定的 epoch；
    // 对任意其他 PID 仍返回 unknown 并 fail closed，绝不把它当作死亡证明。
    if (process.platform === 'darwin' && pid === process.pid) {
      return { status: 'alive', startIdentity: `darwin:node-start-epoch-ms:${NODE_PROCESS_START_EPOCH_MS}` }
    }
    return { status: 'unknown' }
  }
  return { status: 'unknown' }
}

function ownerBinding(marker: RuntimeInstallOwnerMarker): RuntimeInstallOwnerBinding {
  const { phase: _phase, installationDigestIntent: _digest, ...binding } = marker
  return binding
}

function parseOwnerMarker(bytes: Buffer): RuntimeInstallOwnerMarker {
  const value = parseObject(bytes)
  if (!hasExactKeys(value, [...bindingKeys, 'installationDigestIntent', 'phase'])) {
    blocked('install owner marker 字段集合非法')
  }
  const allowedPhases = ['prepared', 'locked', 'staging', 'prepared-closure', 'published', 'releasing']
  if (!allowedPhases.includes(String(value.phase))
    || (value.installationDigestIntent !== 'pending' && !DIGEST.test(String(value.installationDigestIntent)))) {
    blocked('install owner marker phase/digest 非法')
  }
  return { ...parseOwnerBindingValue(value), phase: value.phase as RuntimeInstallOwnerMarker['phase'],
    installationDigestIntent: value.installationDigestIntent as string }
}

function parseOwnerBinding(bytes: Buffer): RuntimeInstallOwnerBinding {
  const value = parseObject(bytes)
  if (!hasExactKeys(value, bindingKeys)) blocked('install lock binding 字段集合非法')
  return parseOwnerBindingValue(value)
}

const bindingKeys = [
  'ownerNonce', 'ownerUid', 'pid', 'processStartIdentity', 'runtimeRoot',
  'schemaVersion', 'stagingName', 'targetVersion',
] as const

function parseOwnerBindingValue(value: Record<string, unknown>): RuntimeInstallOwnerBinding {
  const root = value.runtimeRoot
  if (value.schemaVersion !== '1.0.0' || value.ownerUid !== currentUid()
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.processStartIdentity !== 'string' || value.processStartIdentity.length === 0
    || value.processStartIdentity.length > 512 || !NONCE.test(String(value.ownerNonce))
    || !STAGING_NAME.test(String(value.stagingName)) || !VERSION.test(String(value.targetVersion))
    || !isRecord(root) || !hasExactKeys(root, ['canonicalPath', 'device', 'inode'])
    || typeof root.canonicalPath !== 'string' || root.canonicalPath.length === 0
    || !/^\d+$/.test(String(root.device)) || !/^\d+$/.test(String(root.inode))) {
    blocked('install owner binding 非法')
  }
  return {
    schemaVersion: '1.0.0', ownerUid: value.ownerUid as number, pid: value.pid as number,
    processStartIdentity: value.processStartIdentity as string, ownerNonce: value.ownerNonce as string,
    runtimeRoot: { canonicalPath: root.canonicalPath as string, device: root.device as string,
      inode: root.inode as string }, stagingName: value.stagingName as string,
    targetVersion: value.targetVersion as string,
  }
}

function parseObject(bytes: Buffer): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { blocked('install marker JSON 非法') }
  if (!isRecord(value)) blocked('install marker 必须是 object')
  return value
}

async function verifyRootBinding(layout: RuntimeLayout, marker: RuntimeInstallOwnerMarker): Promise<void> {
  const metadata = await lstat(layout.root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700 || await realpath(layout.root) !== marker.runtimeRoot.canonicalPath
    || String(metadata.dev) !== marker.runtimeRoot.device || String(metadata.ino) !== marker.runtimeRoot.inode) {
    blocked('runtime root canonical path/inode binding 已改变')
  }
}

async function safeStagingMetadata(layout: RuntimeLayout, path: string) {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (metadata === undefined) return undefined
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700 || dirname(await realpath(path)) !== await realpath(layout.root)) {
    blocked('staging 不是固定 root 下当前用户 0700 真实目录')
  }
  return metadata
}

async function readTrustedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw error
  })
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUid()
      || (before.mode & 0o777) !== 0o600 || before.size > 8192) blocked('install marker 文件不安全')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) blocked('install marker 读取期间改变')
    return bytes
  } finally { await handle.close() }
}

async function writeExclusiveTrustedFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(contents); await handle.chmod(0o600); await handle.sync() }
  finally { await handle.close() }
  await syncDirectory(dirname(path))
}

async function replaceOwnerMarker(
  path: string,
  expected: RuntimeInstallOwnerMarker,
  next: RuntimeInstallOwnerMarker,
): Promise<RuntimeInstallOwnerMarker> {
  const stored = parseOwnerMarker(await readTrustedFile(path))
  if (canonicalizeJson(stored) !== canonicalizeJson(expected)
    || canonicalizeJson(ownerBinding(stored)) !== canonicalizeJson(ownerBinding(next))) {
    blocked('owner marker CAS binding/revision 不匹配')
  }
  const temporary = join(dirname(path), `.install-owner-${randomUUID()}.tmp`)
  await writeExclusiveTrustedFile(temporary, `${canonicalizeJson(next)}\n`)
  await rename(temporary, path)
  await syncDirectory(dirname(path))
  return next
}

async function removeOwnedTransactionMetadata(
  layout: RuntimeLayout,
  ownerPath: string,
  binding: RuntimeInstallOwnerBinding,
): Promise<void> {
  if (await exists(layout.installLock)) {
    const lock = parseOwnerBinding(await readTrustedFile(layout.installLock))
    if (canonicalizeJson(lock) === canonicalizeJson(binding)) await rm(layout.installLock, { force: false })
  }
  if (await exists(ownerPath)) {
    const owner = parseOwnerMarker(await readTrustedFile(ownerPath))
    if (canonicalizeJson(ownerBinding(owner)) === canonicalizeJson(binding)) await rm(ownerPath, { force: false })
  }
  await syncDirectory(layout.root)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!isNodeError(error, 'EEXIST')) throw error
  })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700) blocked('recovery tombstone 目录不安全')
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function blocked(message: string): never {
  runtimeError('E2E_RUNTIME_INSTALL_RECOVERY_BLOCKED', message, 'safety')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
