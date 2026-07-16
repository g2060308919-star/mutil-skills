import { canonicalizeJson, digestBytes, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { RuntimeLayout } from './runtime-layout.js'

export const RUNTIME_MANIFEST_FILE = 'runtime-manifest.json'
export const RUNTIME_OWNER_FILE = '.owner.json'
export const RUNTIME_ENTRYPOINT = 'node_modules/@mutil-skills/e2e-runtime/dist/src/bin/repo-e2e.js'
export const RUNTIME_PROTOCOL_MAJOR = 1 as const

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const EXACT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export interface RuntimeManifestFile {
  path: string
  byteLength: number
  digest: string
}

export interface RuntimeManifest {
  schemaVersion: '1.0.0'
  files: RuntimeManifestFile[]
  installationDigest: string
}

export interface RuntimeOwnerMarker {
  schemaVersion: '1.0.0'
  product: '@mutil-skills/e2e-runtime'
  ownerUid: number
}

export interface RuntimeCurrentPointer {
  schemaVersion: '1.0.0'
  runtimeVersion: string
  runtimeManifestDigest: string
  protocolMajor: 1
  versionRoot: string
}

export interface VerifiedRuntimeVersion {
  version: string
  versionRoot: string
  entrypoint: string
  manifest: RuntimeManifest
}

export function assertExactRuntimeVersion(version: string): void {
  if (!EXACT_VERSION_PATTERN.test(version)) {
    runtimeError('E2E_RUNTIME_VERSION_INVALID', 'Runtime 版本必须是精确稳定 SemVer', 'input')
  }
}

export async function createRuntimeManifest(
  versionRoot: string,
  requirePrivateModes = false,
): Promise<RuntimeManifest> {
  const root = resolve(versionRoot)
  await assertDirectory(root, 'E2E_RUNTIME_MANIFEST_ROOT_INVALID', requirePrivateModes)
  const rootRealpath = await realpath(root)
  const files: RuntimeManifestFile[] = []
  await collectManifestFiles(root, rootRealpath, '', files, requirePrivateModes)
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    schemaVersion: '1.0.0',
    files,
    installationDigest: digestText(
      'e2e-runtime-installation/v1',
      canonicalizeJson(files),
    ),
  }
}

export async function verifyRuntimeManifest(versionRoot: string): Promise<RuntimeManifest> {
  const manifestPath = join(versionRoot, RUNTIME_MANIFEST_FILE)
  const stored = parseRuntimeManifest(await readSafeRegularFile(manifestPath, versionRoot, true))
  const actual = await createRuntimeManifest(versionRoot, true)
  if (canonicalizeJson(stored) !== canonicalizeJson(actual)) {
    runtimeError('E2E_RUNTIME_MANIFEST_MISMATCH', 'Runtime installation manifest 与实际 bytes 不一致')
  }
  return stored
}

export async function verifyRuntimeRoot(layout: RuntimeLayout): Promise<RuntimeOwnerMarker> {
  const runtimeParent = dirname(layout.root)
  const productRoot = dirname(runtimeParent)
  await assertDirectory(productRoot, 'E2E_RUNTIME_ROOT_UNOWNED', true)
  await assertDirectory(runtimeParent, 'E2E_RUNTIME_ROOT_UNOWNED', true)
  await assertDirectory(layout.root, 'E2E_RUNTIME_ROOT_UNOWNED', true)
  const markerPath = join(layout.root, RUNTIME_OWNER_FILE)
  const marker = parseOwnerMarker(await readSafeRegularFile(markerPath, layout.root, true))
  const uid = currentUid()
  if (marker.ownerUid !== uid) {
    runtimeError('E2E_RUNTIME_ROOT_UNOWNED', 'Runtime owner marker 不属于当前用户')
  }
  return marker
}

export async function readRuntimeCurrent(layout: RuntimeLayout): Promise<RuntimeCurrentPointer> {
  return parseCurrentPointer(await readSafeRegularFile(layout.current, layout.root, true))
}

export function createRuntimeCurrent(
  verified: VerifiedRuntimeVersion,
): RuntimeCurrentPointer {
  return {
    schemaVersion: '1.0.0',
    runtimeVersion: verified.version,
    runtimeManifestDigest: verified.manifest.installationDigest,
    protocolMajor: RUNTIME_PROTOCOL_MAJOR,
    versionRoot: verified.versionRoot,
  }
}

export async function verifyInstalledRuntimeVersion(
  layout: RuntimeLayout,
  version: string,
): Promise<VerifiedRuntimeVersion> {
  assertExactRuntimeVersion(version)
  const expectedRoot = join(layout.versions, version)
  await assertDirectory(layout.versions, 'E2E_RUNTIME_VERSION_PATH_UNSAFE', true)
  await assertDirectory(expectedRoot, 'E2E_RUNTIME_VERSION_PATH_UNSAFE', true)
  const runtimeRootRealpath = await realpath(layout.root)
  const versionsRealpath = await realpath(layout.versions)
  assertWithin(runtimeRootRealpath, versionsRealpath, 'E2E_RUNTIME_VERSION_PATH_UNSAFE')
  const versionRoot = await realpath(expectedRoot)
  assertWithin(versionsRealpath, versionRoot, 'E2E_RUNTIME_VERSION_PATH_UNSAFE')
  const manifest = await verifyRuntimeManifest(versionRoot)
  const entrypoint = await validatePreparedRuntimeClosure(versionRoot, version)
  const entrypointRealpath = await realpath(entrypoint)
  assertWithin(versionRoot, entrypointRealpath, 'E2E_RUNTIME_ENTRYPOINT_UNSAFE')
  return { version, versionRoot, entrypoint, manifest }
}

export async function validatePreparedRuntimeClosure(versionRoot: string, version: string): Promise<string> {
  assertExactRuntimeVersion(version)
  const packageRoot = join(versionRoot, 'node_modules', '@mutil-skills', 'e2e-runtime')
  const packageJsonPath = join(packageRoot, 'package.json')
  const packageJson = parsePackageJson(await readSafeRegularFile(packageJsonPath, versionRoot))
  if (packageJson.name !== '@mutil-skills/e2e-runtime' || packageJson.version !== version) {
    runtimeError('E2E_RUNTIME_PACKAGE_INVALID', '安装闭包的 package 名称或版本不匹配')
  }

  const scopeRoot = join(versionRoot, 'node_modules', '@mutil-skills')
  let entries: string[] = []
  try {
    entries = (await readdir(scopeRoot)).filter((name) => name.startsWith('e2e-'))
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  const internalPackages = new Map<string, ReturnType<typeof parsePackageJson>>()
  for (const packageName of entries) {
    const internalPackagePath = join(scopeRoot, packageName, 'package.json')
    const internalPackage = parsePackageJson(await readSafeRegularFile(internalPackagePath, versionRoot))
    const expectedName = `@mutil-skills/${packageName}`
    if (internalPackage.name !== expectedName || internalPackage.version !== version) {
      runtimeError('E2E_RUNTIME_PACKAGE_VERSION_SKEW', '安装闭包包含不同版本的内部 Runtime package')
    }
    internalPackages.set(expectedName, internalPackage)
  }
  for (const internalPackage of internalPackages.values()) {
    for (const [dependency, declaredVersion] of Object.entries(internalPackage.dependencies ?? {})) {
      if (!dependency.startsWith('@mutil-skills/e2e-')) continue
      const installedDependency = internalPackages.get(dependency)
      if (declaredVersion !== version || installedDependency?.version !== version) {
        runtimeError('E2E_RUNTIME_PACKAGE_VERSION_SKEW', '内部 Runtime package 依赖必须存在并使用相同精确版本')
      }
    }
  }

  const entrypoint = join(versionRoot, ...RUNTIME_ENTRYPOINT.split('/'))
  const entrypointBytes = await readSafeRegularFile(entrypoint, versionRoot)
  if (!entrypointBytes.toString('utf8').startsWith('#!/usr/bin/env node\n')) {
    runtimeError('E2E_RUNTIME_ENTRYPOINT_INVALID', 'Runtime 入口缺少固定 Node shebang')
  }
  return entrypoint
}

export async function assertDirectory(
  path: string,
  code: string,
  requirePrivateMode: boolean,
): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) runtimeError(code, '所需 Runtime 目录不存在')
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
    runtimeError(code, 'Runtime 路径必须是当前用户拥有的真实目录')
  }
  if (requirePrivateMode && (metadata.mode & 0o777) !== 0o700) {
    runtimeError(code, 'Runtime 目录权限必须是 0700')
  }
}

export function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    runtimeError('E2E_RUNTIME_PLATFORM_UNSUPPORTED', '首期 Runtime 只支持 POSIX 用户权限模型', 'environment')
  }
  return process.getuid()
}

export function runtimeError(
  code: string,
  message: string,
  category: 'input' | 'environment' | 'safety' | 'internal' = 'safety',
): never {
  throw new E2EError({
    code,
    category,
    message: `${code}: ${message}`,
    retryable: false,
  })
}

async function collectManifestFiles(
  directory: string,
  rootRealpath: string,
  relativeDirectory: string,
  files: RuntimeManifestFile[],
  requirePrivateModes: boolean,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  for (const entry of entries) {
    const relativePath = relativeDirectory === ''
      ? entry.name
      : posix.join(relativeDirectory, entry.name)
    if (relativePath === RUNTIME_MANIFEST_FILE) continue
    const absolutePath = join(directory, entry.name)
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink() || metadata.uid !== currentUid()) {
      runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', 'Runtime manifest 不接受 symlink 或非当前 owner 节点')
    }
    const resolved = await realpath(absolutePath)
    assertWithin(rootRealpath, resolved, 'E2E_RUNTIME_MANIFEST_PATH_ESCAPE')
    if (metadata.isDirectory()) {
      if (requirePrivateModes && (metadata.mode & 0o777) !== 0o700) {
        runtimeError('E2E_RUNTIME_FILE_MODE_UNSAFE', 'Runtime closure 目录权限必须是 0700')
      }
      await collectManifestFiles(absolutePath, rootRealpath, relativePath, files, requirePrivateModes)
      continue
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', 'Runtime manifest 只接受单链接普通文件')
    }
    if (requirePrivateModes && (metadata.mode & 0o077) !== 0) {
      runtimeError('E2E_RUNTIME_FILE_MODE_UNSAFE', 'Runtime closure 文件不得授予 group/other 权限')
    }
    const bytes = await readSafeRegularFile(absolutePath, rootRealpath)
    files.push({
      path: relativePath,
      byteLength: bytes.byteLength,
      digest: digestBytes('e2e-runtime-file/v1', bytes),
    })
  }
}

async function readSafeRegularFile(
  path: string,
  root: string,
  requirePrivateMode = false,
): Promise<Buffer> {
  if (!isAbsolute(path) || !isAbsolute(root)) {
    runtimeError('E2E_RUNTIME_PATH_INVALID', 'Runtime 安全读取只接受绝对路径')
  }
  const pathMetadata = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) runtimeError('E2E_RUNTIME_FILE_MISSING', 'Runtime 所需文件不存在')
    throw error
  })
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', 'Runtime 文件必须是普通文件且不得是 symlink')
  }
  const rootRealpath = await realpath(root)
  const pathRealpath = await realpath(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) runtimeError('E2E_RUNTIME_FILE_MISSING', 'Runtime 所需文件不存在')
    throw error
  })
  assertWithin(rootRealpath, pathRealpath, 'E2E_RUNTIME_MANIFEST_PATH_ESCAPE')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUid()) {
      runtimeError('E2E_RUNTIME_MANIFEST_UNSAFE_NODE', 'Runtime 文件必须是当前用户拥有的单链接普通文件')
    }
    if (requirePrivateMode && (before.mode & 0o777) !== 0o600) {
      runtimeError('E2E_RUNTIME_FILE_MODE_UNSAFE', 'Runtime 元数据文件权限必须是 0600')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      runtimeError('E2E_RUNTIME_FILE_CHANGED', '读取 Runtime 文件时 bytes 发生变化')
    }
    if (bytes.byteLength !== after.size) {
      runtimeError('E2E_RUNTIME_FILE_CHANGED', 'Runtime 文件长度与实际读取 bytes 不一致')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function parseRuntimeManifest(bytes: Buffer): RuntimeManifest {
  const value = parseJsonObject(bytes, 'E2E_RUNTIME_MANIFEST_INVALID')
  assertExactKeys(value, ['files', 'installationDigest', 'schemaVersion'], 'E2E_RUNTIME_MANIFEST_INVALID')
  if (value.schemaVersion !== '1.0.0' || !isDigest(value.installationDigest) || !Array.isArray(value.files)) {
    runtimeError('E2E_RUNTIME_MANIFEST_INVALID', 'Runtime manifest schema 无效')
  }
  const files: RuntimeManifestFile[] = []
  let previousPath: string | undefined
  for (const item of value.files) {
    if (!isRecord(item)) runtimeError('E2E_RUNTIME_MANIFEST_INVALID', 'Runtime manifest file record 无效')
    assertExactKeys(item, ['byteLength', 'digest', 'path'], 'E2E_RUNTIME_MANIFEST_INVALID')
    if (typeof item.path !== 'string'
      || item.path.length === 0
      || item.path.startsWith('/')
      || item.path.includes('\\')
      || item.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || !Number.isSafeInteger(item.byteLength)
      || (item.byteLength as number) < 0
      || !isDigest(item.digest)
      || (previousPath !== undefined && item.path <= previousPath)) {
      runtimeError('E2E_RUNTIME_MANIFEST_INVALID', 'Runtime manifest file record 未严格排序或字段无效')
    }
    previousPath = item.path
    files.push({ path: item.path, byteLength: item.byteLength as number, digest: item.digest as string })
  }
  return {
    schemaVersion: '1.0.0',
    files,
    installationDigest: value.installationDigest as string,
  }
}

function parseOwnerMarker(bytes: Buffer): RuntimeOwnerMarker {
  const value = parseJsonObject(bytes, 'E2E_RUNTIME_ROOT_UNOWNED')
  assertExactKeys(value, ['ownerUid', 'product', 'schemaVersion'], 'E2E_RUNTIME_ROOT_UNOWNED')
  if (value.schemaVersion !== '1.0.0'
    || value.product !== '@mutil-skills/e2e-runtime'
    || !Number.isSafeInteger(value.ownerUid)
    || (value.ownerUid as number) < 0) {
    runtimeError('E2E_RUNTIME_ROOT_UNOWNED', 'Runtime owner marker 无效')
  }
  return value as unknown as RuntimeOwnerMarker
}

function parseCurrentPointer(bytes: Buffer): RuntimeCurrentPointer {
  const value = parseJsonObject(bytes, 'E2E_RUNTIME_CURRENT_INVALID')
  assertExactKeys(
    value,
    ['protocolMajor', 'runtimeManifestDigest', 'runtimeVersion', 'schemaVersion', 'versionRoot'],
    'E2E_RUNTIME_CURRENT_INVALID',
  )
  if (value.schemaVersion !== '1.0.0'
    || typeof value.runtimeVersion !== 'string'
    || !EXACT_VERSION_PATTERN.test(value.runtimeVersion)
    || !isDigest(value.runtimeManifestDigest)
    || value.protocolMajor !== RUNTIME_PROTOCOL_MAJOR
    || typeof value.versionRoot !== 'string'
    || !isAbsolute(value.versionRoot)) {
    runtimeError('E2E_RUNTIME_CURRENT_INVALID', 'Runtime current pointer schema 无效')
  }
  return value as unknown as RuntimeCurrentPointer
}

function parsePackageJson(bytes: Buffer): {
  name?: unknown
  version?: unknown
  dependencies?: Record<string, unknown>
} {
  const value = parseJsonObject(bytes, 'E2E_RUNTIME_PACKAGE_INVALID')
  if (value.dependencies !== undefined && !isRecord(value.dependencies)) {
    runtimeError('E2E_RUNTIME_PACKAGE_INVALID', 'package metadata dependencies 无效')
  }
  return value as { name?: unknown; version?: unknown; dependencies?: Record<string, unknown> }
}

function parseJsonObject(bytes: Buffer, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isRecord(value)) runtimeError(code, 'Runtime JSON 必须是对象')
    return value
  } catch (error) {
    if (error instanceof E2EError) throw error
    runtimeError(code, 'Runtime JSON 无法解析')
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], code: string): void {
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    runtimeError(code, 'Runtime JSON 包含缺失或未知字段')
  }
}

function assertWithin(root: string, candidate: string, code: string): void {
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))) return
  runtimeError(code, 'Runtime 路径越过固定根目录')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}
