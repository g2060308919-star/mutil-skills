import {
  ApprovalModeSchema,
  canonicalizeJson,
  E2EError,
  type ApprovalMode,
} from '@mutil-skills/e2e-contracts'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runtimeLayout } from './runtime-layout.js'
import { currentUid } from './runtime-manifest.js'

export { ApprovalModeSchema }
export type { ApprovalMode }

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const AbsolutePathSchema = z.string().min(1).max(16 * 1024).refine(isAbsolute, '浏览器路径必须是绝对路径')
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

export const BrowserSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system-chrome'), executablePath: AbsolutePathSchema }).strict(),
  z.object({ kind: z.literal('managed-chromium'), installationId: SafeIdSchema }).strict(),
])

export const BrowserSelectionSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  source: BrowserSourceSchema,
  browserVersion: z.string().min(1).max(1024),
  executableDigest: DigestSchema,
  runtimeInstallationDigest: DigestSchema,
  controlledLaunchProofDigest: DigestSchema,
  configuredAt: z.string().datetime({ offset: true }),
}).strict()

export const ApprovalModeConfigurationSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  mode: ApprovalModeSchema,
}).strict()

export type BrowserSource = z.infer<typeof BrowserSourceSchema>
export type BrowserSelection = z.infer<typeof BrowserSelectionSchema>
export type ApprovalModeConfiguration = z.infer<typeof ApprovalModeConfigurationSchema>

export async function readBrowserSelection(homeDir: string): Promise<BrowserSelection> {
  return BrowserSelectionSchema.parse(await readPrivateJson(runtimeLayout(homeDir).browserSelection))
}

export async function writeBrowserSelection(homeDir: string, selection: BrowserSelection): Promise<void> {
  await writePrivateJson(homeDir, runtimeLayout(homeDir).browserSelection, BrowserSelectionSchema.parse(selection))
}

export async function readApprovalMode(homeDir: string): Promise<ApprovalModeConfiguration> {
  const path = runtimeLayout(homeDir).approvalMode
  try {
    return ApprovalModeConfigurationSchema.parse(await readPrivateJson(path))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { schemaVersion: '1.0.0', mode: 'local-confirmation' }
    throw error
  }
}

export async function writeApprovalMode(homeDir: string, mode: ApprovalMode): Promise<void> {
  await writePrivateJson(homeDir, runtimeLayout(homeDir).approvalMode,
    ApprovalModeConfigurationSchema.parse({ schemaVersion: '1.0.0', mode }))
}

async function readPrivateJson(path: string): Promise<unknown> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== currentUid()
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > 1024 * 1024) {
      throw configError('E2E_RUNTIME_USER_CONFIG_UNSAFE', '用户级 E2E 配置必须是当前用户独占的 0600 普通文件')
    }
    const bytes = Buffer.alloc(metadata.size)
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0)
    if (bytesRead !== metadata.size) throw configError(
      'E2E_RUNTIME_USER_CONFIG_UNSAFE', '用户级 E2E 配置读取不完整')
    try { return JSON.parse(bytes.toString('utf8')) } catch (cause) {
      throw configError('E2E_RUNTIME_USER_CONFIG_INVALID', '用户级 E2E 配置不是合法 JSON', cause)
    }
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) throw configError(
      'E2E_RUNTIME_USER_CONFIG_UNSAFE', '用户级 E2E 配置不得是符号链接', error)
    throw error
  } finally { await handle?.close() }
}

async function writePrivateJson(homeDir: string, target: string, value: unknown): Promise<void> {
  const layout = runtimeLayout(homeDir)
  await ensurePrivateStateDirectory(layout.state)
  const staging = join(layout.state, `.config-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const bytes = Buffer.from(`${canonicalizeJson(value)}\n`)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(staging, target)
    await chmod(target, 0o600)
    const directory = await open(layout.state, constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await handle?.close()
    await unlink(staging).catch((error) => { if (!isNodeError(error, 'ENOENT')) throw error })
  }
}

async function ensurePrivateStateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
    throw configError('E2E_RUNTIME_USER_CONFIG_UNSAFE', '用户级 E2E state 必须是当前用户所有的真实目录')
  }
  if ((metadata.mode & 0o777) !== 0o700) await chmod(path, 0o700)
}

function configError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false, cause })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
