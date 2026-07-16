import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { E2EError, digestBytes } from '@mutil-skills/e2e-contracts'

const MAX_SOURCE_FILES = 100_000

export interface RegressionSourceBytes {
  relativePath: string
  bytes: Uint8Array
  digest: string
  byteLength: number
  mediaType: 'application/json' | 'text/markdown' | 'text/typescript'
}

export async function assertFreshOutputRoot(root: string): Promise<void> {
  let stats
  try { stats = await lstat(root) } catch (cause) {
    throw sourceError('E2E_COMPILER_OUTPUT_NOT_FRESH', 'Compiler 输出根必须预先存在', cause)
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw sourceError('E2E_COMPILER_PATH_ESCAPE', 'Compiler 输出根必须是真实目录')
  }
  const entries = await readdir(root)
  if (entries.length !== 0) {
    throw sourceError('E2E_COMPILER_OUTPUT_NOT_FRESH', 'Compiler 输出根必须为空')
  }
}

export async function readRegressionSourceSet(root: string, prefix: string): Promise<RegressionSourceBytes[]> {
  const rootStats = await lstat(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw sourceError('E2E_COMPILER_PATH_ESCAPE', 'Regression 根必须是真实目录')
  }
  const canonicalRoot = await realpath(root)
  const files: RegressionSourceBytes[] = []
  await visit(canonicalRoot, '')
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  async function visit(directory: string, localDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const localPath = localDirectory === '' ? entry.name : `${localDirectory}/${entry.name}`
      const absolutePath = join(directory, entry.name)
      const stats = await lstat(absolutePath)
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw sourceError('E2E_COMPILER_PATH_ESCAPE', `Regression Source Set 禁止符号链接：${localPath}`)
      }
      const canonicalPath = await realpath(absolutePath)
      const escaped = relative(canonicalRoot, canonicalPath)
      if (escaped === '..' || escaped.startsWith(`..${sep}`) || resolve(canonicalRoot, escaped) !== canonicalPath) {
        throw sourceError('E2E_COMPILER_PATH_ESCAPE', `Regression 文件逃逸输出根：${localPath}`)
      }
      if (stats.isDirectory()) {
        await visit(canonicalPath, localPath)
        continue
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw sourceError('E2E_COMPILER_PATH_ESCAPE', `Regression Source Set 只允许单链接普通文件：${localPath}`)
      }
      if (files.length >= MAX_SOURCE_FILES) {
        throw sourceError('E2E_COMPILER_SOURCE_SET_LIMIT', `Regression 文件数超过 ${MAX_SOURCE_FILES}`)
      }
      const bytes = await readFile(canonicalPath)
      const relativePath = `${prefix}/${localPath}`
      files.push({ relativePath, bytes,
        digest: digestBytes(`generation-file:${relativePath}`, bytes), byteLength: bytes.byteLength,
        mediaType: mediaTypeFor(localPath) })
    }
  }
}

function mediaTypeFor(path: string): RegressionSourceBytes['mediaType'] {
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.md')) return 'text/markdown'
  return 'text/typescript'
}

export function assertExpectedRegressionSourceSet(
  files: RegressionSourceBytes[],
  expectedLocalPaths: string[],
  prefix = 'regression',
): void {
  const expected = [...expectedLocalPaths].sort().map((path) => `${prefix}/${path}`)
  const actual = files.map((file) => file.relativePath).sort()
  const extra = actual.filter((path) => !expected.includes(path))
  if (extra.length > 0) {
    throw sourceError('E2E_COMPILER_UNATTESTED_SOURCE', `发现未由可信 Compiler 登记的文件：${extra.join(', ')}`)
  }
  const missing = expected.filter((path) => !actual.includes(path))
  if (missing.length > 0 || new Set(actual).size !== actual.length) {
    throw sourceError('E2E_SOURCE_SET_MISMATCH', `Compiler Source Set 缺失、重复或不闭合：${missing.join(', ')}`)
  }
}

function sourceError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
