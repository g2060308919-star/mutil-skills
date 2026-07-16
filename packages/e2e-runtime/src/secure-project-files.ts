import { E2EError } from '@mutil-skills/e2e-contracts'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024

export interface SecureProjectRootBinding {
  realRoot: string
  device: string
  inode: string
}

export interface SecureProjectFileHookContext {
  root: SecureProjectRootBinding
  relativePath: string
  absolutePath: string
}

export interface SecureProjectFileReaderHooks {
  beforeOpenFile?(context: SecureProjectFileHookContext): void | Promise<void>
  beforeRead?(context: SecureProjectFileHookContext): void | Promise<void>
}

export class SecureProjectFileReader {
  constructor(private readonly hooks: SecureProjectFileReaderHooks = {}) {}

  async inspectProjectRoot(projectRoot: string): Promise<SecureProjectRootBinding> {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      throw projectFileError('E2E_RUNTIME_PROJECT_IDENTITY_INVALID', '项目根目录不能为空')
    }
    const absoluteRoot = resolve(projectRoot)
    let resolvedRoot: string
    try {
      resolvedRoot = await realpath(absoluteRoot)
    } catch (cause) {
      throw projectFileError('E2E_RUNTIME_PROJECT_IDENTITY_INVALID', '项目根目录不存在或不可读取', cause)
    }
    if (resolvedRoot !== normalizePlatformPathAlias(absoluteRoot)) {
      throw projectFileError(
        'E2E_RUNTIME_PROJECT_SYMLINK_FORBIDDEN',
        '项目根目录必须是未经符号链接解析的真实路径',
      )
    }
    await assertNoSymlinkComponents(resolvedRoot, 'E2E_RUNTIME_PROJECT_SYMLINK_FORBIDDEN')

    let handle: FileHandle | undefined
    try {
      handle = await open(
        resolvedRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      const descriptor = await handle.stat()
      validateDirectoryDescriptor(descriptor)
      const pathMetadata = await stat(resolvedRoot)
      assertSameObject(descriptor, pathMetadata, '项目根目录 fd 与 canonical path 不一致')
      const after = await handle.stat()
      assertStableDescriptor(descriptor, after, '项目根目录在身份解析期间发生变化')
      return {
        realRoot: resolvedRoot,
        device: String(descriptor.dev),
        inode: String(descriptor.ino),
      }
    } catch (error) {
      if (error instanceof E2EError) throw error
      throw projectFileError('E2E_RUNTIME_PROJECT_IDENTITY_INVALID', '无法安全打开项目根目录', error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async readFile(
    root: SecureProjectRootBinding,
    relativePath: string,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  ): Promise<Buffer> {
    validateRelativePath(relativePath)
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '文件大小上限无效')
    }
    const currentRoot = await this.inspectProjectRoot(root.realRoot)
    if (currentRoot.device !== root.device || currentRoot.inode !== root.inode) {
      throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目根目录身份已改变')
    }
    const absolutePath = join(root.realRoot, relativePath)
    await assertNoSymlinkComponents(absolutePath, 'E2E_RUNTIME_PROJECT_FILE_UNSAFE')
    const context = { root, relativePath, absolutePath }
    await this.hooks.beforeOpenFile?.(context)

    let handle: FileHandle | undefined
    try {
      handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await handle.stat()
      validateFileDescriptor(before, maxBytes)
      await assertOpenFileStillContained(root, absolutePath, before)
      await this.hooks.beforeRead?.(context)
      const bytes = await handle.readFile()
      const after = await handle.stat()
      assertStableDescriptor(before, after, '文件在读取期间发生变化')
      if (bytes.byteLength !== before.size) {
        throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '读取 bytes 与已验证文件大小不一致')
      }
      await assertOpenFileStillContained(root, absolutePath, after)
      return bytes
    } catch (error) {
      if (error instanceof E2EError) throw error
      throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件无法通过 no-follow 读取', error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}

async function assertOpenFileStillContained(
  root: SecureProjectRootBinding,
  absolutePath: string,
  descriptor: Awaited<ReturnType<FileHandle['stat']>>,
): Promise<void> {
  const resolvedPath = await realpath(absolutePath)
  const fromRoot = relative(root.realRoot, resolvedPath)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件 canonical path 逃逸项目根目录')
  }
  const pathMetadata = await stat(resolvedPath)
  assertSameObject(descriptor, pathMetadata, '项目文件 fd 与 canonical path 不一致')
}

function validateDirectoryDescriptor(metadata: Awaited<ReturnType<FileHandle['stat']>>): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw projectFileError('E2E_RUNTIME_PROJECT_IDENTITY_INVALID', '项目根 fd 不是普通目录')
  }
  assertCurrentUid(metadata.uid, '项目根目录')
}

function validateFileDescriptor(
  metadata: Awaited<ReturnType<FileHandle['stat']>>,
  maxBytes: number,
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件必须是普通文件')
  }
  assertCurrentUid(metadata.uid, '项目文件')
  if (metadata.nlink !== 1) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件不得是 hard link')
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件大小超出安全上限')
  }
}

function assertCurrentUid(uid: number | bigint, label: string): void {
  if (typeof process.getuid === 'function' && String(uid) !== String(process.getuid())) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', `${label} 必须由当前 UID 拥有`)
  }
}

function assertSameObject(
  descriptor: Awaited<ReturnType<FileHandle['stat']>>,
  pathMetadata: Awaited<ReturnType<typeof stat>>,
  message: string,
): void {
  if (descriptor.dev !== pathMetadata.dev || descriptor.ino !== pathMetadata.ino) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', message)
  }
}

function assertStableDescriptor(
  before: Awaited<ReturnType<FileHandle['stat']>>,
  after: Awaited<ReturnType<FileHandle['stat']>>,
  message: string,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.nlink !== after.nlink || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', message)
  }
}

async function assertNoSymlinkComponents(path: string, code: string): Promise<void> {
  const parsed = parse(path)
  const parts = path.slice(parsed.root.length).split(sep).filter(Boolean)
  let current = parsed.root
  for (const part of parts) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw projectFileError(code, `路径不得包含符号链接：${current}`)
      }
    } catch (error) {
      if (error instanceof E2EError) throw error
      throw projectFileError(code, `无法 lstat 路径组件：${current}`, error)
    }
  }
}

function validateRelativePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件路径必须是相对 POSIX path')
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw projectFileError('E2E_RUNTIME_PROJECT_FILE_UNSAFE', '项目文件路径包含非法段')
  }
}

function normalizePlatformPathAlias(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

function projectFileError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({
    code,
    category: 'safety',
    message: `${code}: ${message}`,
    retryable: false,
    cause,
  })
}
