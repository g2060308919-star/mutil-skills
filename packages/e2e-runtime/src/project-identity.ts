import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { SecureProjectFileReader } from './secure-project-files.js'

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

export async function resolveProjectIdentity(
  projectRoot: string,
  reader = new SecureProjectFileReader(),
): Promise<ProjectIdentity> {
  const root = await reader.inspectProjectRoot(projectRoot)
  const metadata = await readProjectIdentityFile(
    await reader.readFile(root, '.biztest/project.json', 64 * 1024),
  )
  const identity = {
    realRoot: root.realRoot,
    device: root.device,
    inode: root.inode,
    logicalProjectId: metadata.projectId,
  }
  return {
    ...identity,
    digest: digestText('e2e-project-identity/v1', canonicalizeJson(identity)),
  }
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

async function readProjectIdentityFile(bytes: Uint8Array): Promise<ProjectIdentityFile> {
  try {
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
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
