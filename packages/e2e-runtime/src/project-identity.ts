import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { join, parse, resolve, sep } from 'node:path'

const PROJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/

export interface ProjectIdentity {
  realRoot: string
  device: string
  inode: string
  logicalProjectId: string
  digest: string
}

export interface RebindProjectIdentityInput {
  projectRoot: string
}

interface ProjectIdentityFile {
  schemaVersion: '1.0.0'
  projectId: string
}

export async function resolveProjectIdentity(projectRoot: string): Promise<ProjectIdentity> {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw projectIdentityError('E2E_RUNTIME_PROJECT_IDENTITY_INVALID', '项目根目录不能为空')
  }
  const absoluteRoot = resolve(projectRoot)
  let resolvedRoot: string
  try {
    resolvedRoot = await realpath(absoluteRoot)
  } catch (cause) {
    throw projectIdentityError(
      'E2E_RUNTIME_PROJECT_IDENTITY_INVALID',
      '项目根目录不存在或无法读取',
      cause,
    )
  }
  if (resolvedRoot !== normalizePlatformPathAlias(absoluteRoot)) {
    throw projectIdentityError('E2E_RUNTIME_PROJECT_SYMLINK_FORBIDDEN', '项目根目录必须是未经符号链接解析的真实路径')
  }
  await assertPathContainsNoSymlink(resolvedRoot)

  const projectFile = join(resolvedRoot, '.biztest', 'project.json')
  await assertPathContainsNoSymlink(projectFile)
  const metadata = await readProjectIdentityFile(projectFile)
  const rootStats = await stat(resolvedRoot, { bigint: true })
  if (!rootStats.isDirectory()) {
    throw projectIdentityError('E2E_RUNTIME_PROJECT_IDENTITY_INVALID', '项目根目录不是目录')
  }
  const identity = {
    realRoot: resolvedRoot,
    device: rootStats.dev.toString(10),
    inode: rootStats.ino.toString(10),
    logicalProjectId: metadata.projectId,
  }
  return {
    ...identity,
    digest: digestText('e2e-project-identity/v1', canonicalizeJson(identity)),
  }
}

function normalizePlatformPathAlias(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

export async function rebindProjectIdentity(
  input: string | RebindProjectIdentityInput,
  verifyUserPresence: (identity: ProjectIdentity) => boolean | Promise<boolean>,
): Promise<ProjectIdentity> {
  const projectRoot = typeof input === 'string' ? input : input.projectRoot
  const identity = await resolveProjectIdentity(projectRoot)
  let verified = false
  try {
    verified = await verifyUserPresence(identity)
  } catch {
    verified = false
  }
  if (!verified) {
    throw projectIdentityError(
      'E2E_RUNTIME_PROJECT_REBIND_USER_PRESENCE_REQUIRED',
      '重新绑定项目身份需要已验证的用户在场证明',
    )
  }
  return identity
}

async function readProjectIdentityFile(path: string): Promise<ProjectIdentityFile> {
  try {
    const candidate = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isPlainRecord(candidate)
      || !hasExactKeys(candidate, ['projectId', 'schemaVersion'])
      || candidate.schemaVersion !== '1.0.0'
      || typeof candidate.projectId !== 'string'
      || !PROJECT_ID.test(candidate.projectId)) {
      throw new Error('invalid project identity')
    }
    return { schemaVersion: '1.0.0', projectId: candidate.projectId }
  } catch (error) {
    if (error instanceof E2EError) throw error
    throw projectIdentityError(
      'E2E_RUNTIME_PROJECT_IDENTITY_INVALID',
      '.biztest/project.json 必须是严格的 1.0.0 项目身份声明',
      error,
    )
  }
}

async function assertPathContainsNoSymlink(path: string): Promise<void> {
  const parsed = parse(path)
  const relativeParts = path.slice(parsed.root.length).split(sep).filter(Boolean)
  let current = parsed.root
  for (const part of relativeParts) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw projectIdentityError(
          'E2E_RUNTIME_PROJECT_SYMLINK_FORBIDDEN',
          `项目身份路径不得包含符号链接：${current}`,
        )
      }
    } catch (error) {
      if (error instanceof E2EError) throw error
      throw projectIdentityError(
        'E2E_RUNTIME_PROJECT_IDENTITY_INVALID',
        `无法读取项目身份路径：${current}`,
        error,
      )
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function projectIdentityError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({
    code,
    category: 'safety',
    message: `${code}: ${message}`,
    retryable: false,
    cause,
  })
}
