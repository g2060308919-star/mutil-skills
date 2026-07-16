import {
  startAuthorityExecutionRpcHostProcess,
  type AuthorityExecutionRpcProcessHandle,
  type WebAuthnApprovalAssets,
  type WebAuthnApprovalType,
} from '@mutil-skills/e2e-authority'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { buildChildEnvironment } from './environment-policy.js'
import type { RuntimeInstallation } from './runtime-discovery.js'
import { runtimeLayout } from './runtime-layout.js'
import type { RuntimeRunSnapshot } from './run-store.js'

const BUNDLE_DIGEST = 'sha256:cf4469953efcb5617a870ae3f022b3ad48aee8c06012ccdafcabc73058f123a0'
const DIGEST = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

type RuntimeAuthorityProcess = Pick<AuthorityExecutionRpcProcessHandle,
  'enrollIdentity' | 'openApprovalSession' | 'waitForSession' | 'close'>

export interface RuntimeAuthoritySession {
  url: string
  sessionId: string
  wait(): Promise<void>
}

export class RuntimeAuthorityHost {
  readonly #process: RuntimeAuthorityProcess
  readonly #installationDigest: string
  #closed = false

  constructor(options: {
    processHandle: RuntimeAuthorityProcess
    installationDigest: string
  }) {
    if (!DIGEST.test(options.installationDigest)) throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    this.#process = options.processHandle
    this.#installationDigest = options.installationDigest
  }

  async enroll(input: { subject: string }): Promise<RuntimeAuthoritySession> {
    this.#requireOpen()
    if (!SAFE_ID.test(input.subject)) throw authorityHostError('E2E_APPROVAL_ENROLLMENT_INPUT_INVALID')
    return this.#session(await this.#process.enrollIdentity(input))
  }

  async requestApproval(input: {
    runId: string
    approvalType: WebAuthnApprovalType
    subjectDigest: string
    installationDigest: string
  }): Promise<RuntimeAuthoritySession> {
    this.#requireOpen()
    if (input.installationDigest !== this.#installationDigest) {
      throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    }
    return this.#session(await this.#process.openApprovalSession(input))
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#process.close()
  }

  #session(reference: { url: string; sessionId: string }): RuntimeAuthoritySession {
    let url: URL
    try { url = new URL(reference.url) } catch {
      throw authorityHostError('E2E_APPROVAL_SESSION_REFERENCE_INVALID')
    }
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.port === ''
      || !SAFE_ID.test(reference.sessionId)) {
      throw authorityHostError('E2E_APPROVAL_SESSION_REFERENCE_INVALID')
    }
    return Object.freeze({
      url: reference.url,
      sessionId: reference.sessionId,
      wait: async () => await this.#process.waitForSession(reference.sessionId),
    })
  }

  #requireOpen(): void {
    if (this.#closed) throw authorityHostError('E2E_APPROVAL_AUTHORITY_CLOSED')
  }
}

export async function startRuntimeAuthorityHost(options: {
  homeDir: string
  installation: RuntimeInstallation
  subject: string
}): Promise<RuntimeAuthorityHost> {
  if (!SAFE_ID.test(options.subject)) throw authorityHostError('E2E_APPROVAL_ENROLLMENT_INPUT_INVALID')
  const layout = runtimeLayout(options.homeDir)
  await ensureAuthorityDirectories(options.homeDir, layout.authority)
  const stateEncryptionKey = await loadOrCreateAuthorityKey(join(layout.authority, 'state.key'))
  const assets = await loadRuntimeApprovalAssets()
  const environment = buildChildEnvironment({
    host: process.env,
    runtimeBinPaths: [dirname(process.execPath)],
    homeDir: options.homeDir,
    tempDir: tmpdir(),
  })
  try {
    const processHandle = await startAuthorityExecutionRpcHostProcess({
      rpc: { issuer: 'e2e-runtime-authority', keyId: 'rpc-v1', clientId: 'runtime-parent' },
      approval: {
        issuer: 'e2e-runtime-authority', keyId: 'approval-v1',
        statePath: join(layout.authority, 'approval.sqlite'),
        stateEncryptionKey,
        testWorkspaceRoots: [options.installation.versionRoot],
        approvalIdentities: [{ subject: options.subject, roles: ['e2e-approver'] }],
      },
      lease: {
        statePath: join(layout.authority, 'lease.sqlite'),
        testWorkspaceRoots: [options.installation.versionRoot],
      },
      userPresence: { installationDigest: options.installation.installationDigest, assets },
      process: { cwd: options.installation.versionRoot, env: environment },
    })
    return new RuntimeAuthorityHost({
      processHandle,
      installationDigest: options.installation.installationDigest,
    })
  } finally {
    stateEncryptionKey.fill(0)
  }
}

export async function loadRuntimeApprovalAssets(): Promise<WebAuthnApprovalAssets> {
  const sourceMode = import.meta.url.endsWith('.ts')
  const rootCandidate = fileURLToPath(new URL(
    sourceMode ? '../assets/approval/' : '../../assets/approval/',
    import.meta.url,
  ))
  const assetRoot = await realpath(rootCandidate)
  const indexHtml = await readSecureAsset(assetRoot, 'index.html')
  const approvalJavaScript = await readSecureAsset(assetRoot, 'approval.js')
  const simpleWebAuthnBrowser = await readSecureAsset(assetRoot, 'simplewebauthn-browser.js')
  const raw = `sha256:${createHash('sha256').update(simpleWebAuthnBrowser).digest('hex')}`
  if (raw !== BUNDLE_DIGEST) throw authorityHostError('E2E_APPROVAL_ASSET_DIGEST_MISMATCH')
  return { indexHtml, approvalJavaScript, simpleWebAuthnBrowser }
}

export function computeRuntimeApprovalSubjectDigest(
  snapshot: RuntimeRunSnapshot,
  approvalType: WebAuthnApprovalType,
): string {
  return digestText('e2e-runtime-approval-subject/v1', canonicalizeJson({
    runId: snapshot.runId,
    assetId: snapshot.assetId,
    approvalType,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    runtimeInstallationDigest: snapshot.runtimeInstallationDigest,
    workflow: snapshot.workflow,
    artifactDigests: snapshot.artifactDigests,
  }))
}

async function readSecureAsset(root: string, name: string): Promise<Buffer> {
  const candidate = join(root, name)
  const stat = await lstat(candidate)
  const resolved = await realpath(candidate)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || resolved !== candidate || !isWithin(root, resolved)) {
    throw authorityHostError('E2E_APPROVAL_ASSET_REALPATH_INVALID')
  }
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { return await handle.readFile() } finally { await handle.close() }
}

async function ensureAuthorityDirectories(homeDir: string, authorityRoot: string): Promise<void> {
  const paths = [
    join(homeDir, '.mutil-skills'),
    join(homeDir, '.mutil-skills', 'e2e'),
    authorityRoot,
  ]
  for (const path of paths) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw authorityHostError('E2E_APPROVAL_STATE_DIRECTORY_INVALID')
    }
  }
}

async function loadOrCreateAuthorityKey(path: string): Promise<Buffer> {
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try { await handle.writeFile(randomBytes(32)) } finally { await handle.close() }
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error
  }
  const stat = await lstat(path)
  const resolved = await realpath(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || resolved !== normalizePlatformPathAlias(path)) {
    throw authorityHostError('E2E_APPROVAL_STATE_KEY_INVALID')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const key = await handle.readFile()
    if (key.byteLength !== 32) {
      key.fill(0)
      throw authorityHostError('E2E_APPROVAL_STATE_KEY_INVALID')
    }
    return key
  } finally { await handle.close() }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function normalizePlatformPathAlias(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

function authorityHostError(code: string): E2EError {
  return new E2EError({
    code,
    category: 'safety',
    message: `${code}: Runtime Authority Host 拒绝不可信 session 或本地状态`,
    retryable: false,
  })
}
