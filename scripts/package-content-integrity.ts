import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function packageArchiveContentIntegrity(
  archive: string,
  label = archive,
): Promise<string> {
  const extractionRoot = await mkdtemp(join(tmpdir(), 'mutil-package-content-'))
  try {
    const listing = await execFileAsync('tar', ['-tzf', archive], {
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    const entries = listing.stdout.trim().split('\n').filter((entry) => entry.length > 0)
    if (entries.length === 0 || entries.some((entry) =>
      !entry.startsWith('package/')
      || entry.includes('\\')
      || entry.split('/').some((part) => part === '..'))) {
      throw new Error(`发布 tarball 路径不安全: ${label}`)
    }
    await execFileAsync('tar', ['-xzf', archive, '-C', extractionRoot], {
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    return await packageDirectoryContentIntegrity(join(extractionRoot, 'package'))
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

export async function packageDirectoryContentIntegrity(root: string): Promise<string> {
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
      // npm install 会归一化 owner 权限，但会保留可执行语义。
      files.push({
        path: relativePath,
        mode: (info.mode & 0o111) === 0 ? 0 : 1,
        bytes: await readFile(path),
      })
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
