import {
  startAuthorityExecutionRpcHostProcess,
  type AuthorityExecutionRpcProcessHandle,
  type WebAuthnApprovalAssets,
  type WebAuthnApprovalType,
} from '@mutil-skills/e2e-authority'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
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
      || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== ''
      || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)
      || !SAFE_ID.test(reference.sessionId)) {
      throw authorityHostError('E2E_APPROVAL_SESSION_REFERENCE_INVALID')
    }
    return Object.freeze({
      url: reference.url,
      sessionId: reference.sessionId,
      wait: async () => {
        try { await this.#process.waitForSession(reference.sessionId) }
        catch (error) {
          throw authorityHostError(safeAuthorityErrorCode(error))
        }
      },
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
  approvalSessionTtlMs?: number
}): Promise<RuntimeAuthorityHost> {
  if (!SAFE_ID.test(options.subject)) throw authorityHostError('E2E_APPROVAL_ENROLLMENT_INPUT_INVALID')
  const layout = runtimeLayout(options.homeDir)
  const environment = buildChildEnvironment({
    host: process.env,
    runtimeBinPaths: [dirname(process.execPath)],
    homeDir: options.homeDir,
    tempDir: tmpdir(),
  })
  const prepared = await prepareAuthorityState(options.homeDir, layout.authority, environment)
  try {
    const assets = await loadRuntimeApprovalAssets()
    const childWrapperPath = await secureRuntimeScriptPath('authority-child-fchdir.py')
    let processHandle: AuthorityExecutionRpcProcessHandle
    try {
      processHandle = await startAuthorityExecutionRpcHostProcess({
        rpc: { issuer: 'e2e-runtime-authority', keyId: 'rpc-v1', clientId: 'runtime-parent' },
        approval: {
          issuer: 'e2e-runtime-authority', keyId: 'approval-v1',
          statePath: 'approval.sqlite',
          stateEncryptionKey: prepared.stateEncryptionKey,
          expectedStateDirectory: prepared.identity,
          testWorkspaceRoots: [options.installation.versionRoot],
          approvalIdentities: [{ subject: options.subject, roles: ['e2e-approver'] }],
        },
        lease: {
          statePath: 'lease.sqlite',
          expectedStateDirectory: prepared.identity,
          testWorkspaceRoots: [options.installation.versionRoot],
        },
        userPresence: {
          installationDigest: options.installation.installationDigest,
          assets,
          ...(options.approvalSessionTtlMs === undefined ? {} : { ttlMs: options.approvalSessionTtlMs }),
        },
        process: {
          cwd: options.installation.versionRoot,
          env: environment,
          pinnedStateDirectory: {
            fd: prepared.directoryHandle.fd,
            identity: prepared.identity,
            pythonExecutable: '/usr/bin/python3',
            wrapperPath: childWrapperPath,
          },
        },
      })
    } catch (error) {
      if (error instanceof E2EError) throw error
      throw authorityHostError(safeAuthorityErrorCode(error))
    }
    return new RuntimeAuthorityHost({
      processHandle,
      installationDigest: options.installation.installationDigest,
    })
  } finally {
    prepared.stateEncryptionKey.fill(0)
    await prepared.directoryHandle.close()
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

interface SecureDirectoryIdentity {
  realPath: string
  device: string
  inode: string
}

interface PreparedAuthorityState {
  directoryHandle: FileHandle
  identity: SecureDirectoryIdentity
  stateEncryptionKey: Buffer
}

async function prepareAuthorityState(
  homeDir: string,
  authorityRoot: string,
  environment: Record<string, string>,
): Promise<PreparedAuthorityState> {
  let directoryHandle: FileHandle | undefined
  let stateEncryptionKey: Buffer | undefined
  try {
    const canonicalHome = await realpath(homeDir)
    if (canonicalHome !== normalizePlatformPathAlias(homeDir)) {
      throw authorityHostError('E2E_APPROVAL_STATE_DIRECTORY_INVALID')
    }
    const helperPath = await secureRuntimeScriptPath('authority-state-openat.py')
    const output = await runStateHelper(helperPath, canonicalHome, environment)
    const parsed = parseStateHelperOutput(output, authorityRoot)
    stateEncryptionKey = parsed.stateEncryptionKey
    directoryHandle = await open(
      parsed.identity.realPath,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    )
    const descriptorStat = await directoryHandle.stat()
    const pathStat = await lstat(parsed.identity.realPath)
    if (!descriptorStat.isDirectory() || !sameFileIdentity(descriptorStat, pathStat)
      || pathStat.isSymbolicLink() || descriptorStat.uid !== process.getuid?.()
      || (descriptorStat.mode & 0o777) !== 0o700
      || String(descriptorStat.dev) !== parsed.identity.device
      || String(descriptorStat.ino) !== parsed.identity.inode
      || await realpath(parsed.identity.realPath) !== parsed.identity.realPath) {
      throw authorityHostError('E2E_APPROVAL_STATE_DIRECTORY_INVALID')
    }
    return {
      directoryHandle,
      identity: parsed.identity,
      stateEncryptionKey,
    }
  } catch (error) {
    stateEncryptionKey?.fill(0)
    await directoryHandle?.close()
    if (error instanceof E2EError) throw error
    throw authorityHostError('E2E_APPROVAL_STATE_DIRECTORY_INVALID')
  }
}

async function secureRuntimeScriptPath(name: string): Promise<string> {
  const sourceMode = import.meta.url.endsWith('.ts')
  const candidate = fileURLToPath(new URL(
    sourceMode ? `../scripts/${name}` : `../../scripts/${name}`,
    import.meta.url,
  ))
  const metadata = await lstat(candidate)
  const resolved = await realpath(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || resolved !== candidate) {
    throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
  }
  return resolved
}

async function runStateHelper(
  helperPath: string,
  canonicalHome: string,
  environment: Record<string, string>,
): Promise<string> {
  const child = spawn('/usr/bin/python3', [helperPath, canonicalHome], {
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  })
  const stdout: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes > 8192) { overflow = true; child.kill('SIGKILL') } else stdout.push(Buffer.from(chunk))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes > 8192) { overflow = true; child.kill('SIGKILL') }
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { overflow = true; child.kill('SIGKILL') }, 10_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code) => { clearTimeout(timeout); resolve(code) })
  }).catch(() => null)
  if (overflow) throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
  const text = Buffer.concat(stdout).toString('utf8')
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
  }
  if (exitCode !== 0) {
    try {
      const error = JSON.parse(text) as unknown
      if (isRecord(error) && hasExactKeys(error, ['code', 'ok']) && error.ok === false
        && (error.code === 'E2E_APPROVAL_STATE_DIRECTORY_INVALID'
          || error.code === 'E2E_APPROVAL_STATE_KEY_INVALID')) {
        throw authorityHostError(error.code)
      }
    } catch (error) {
      if (error instanceof E2EError) throw error
    }
    throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
  }
  return text
}

function parseStateHelperOutput(
  text: string,
  expectedAuthorityRoot: string,
): { identity: SecureDirectoryIdentity; stateEncryptionKey: Buffer } {
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
  }
  if (!isRecord(value) || !hasExactKeys(value, ['directory', 'keyBase64Url', 'ok', 'schemaVersion'])
    || value.ok !== true || value.schemaVersion !== '1.0.0' || !isRecord(value.directory)
    || !hasExactKeys(value.directory, ['device', 'inode', 'mode', 'realPath', 'uid'])
    || value.directory.realPath !== normalizePlatformPathAlias(expectedAuthorityRoot)
    || typeof value.directory.device !== 'string' || !/^\d+$/.test(value.directory.device)
    || typeof value.directory.inode !== 'string' || !/^\d+$/.test(value.directory.inode)
    || value.directory.uid !== process.getuid?.() || value.directory.mode !== 0o700
    || typeof value.keyBase64Url !== 'string') {
    throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
  }
  const stateEncryptionKey = Buffer.from(value.keyBase64Url, 'base64url')
  if (stateEncryptionKey.byteLength !== 32
    || stateEncryptionKey.toString('base64url') !== value.keyBase64Url) {
    stateEncryptionKey.fill(0)
    throw authorityHostError('E2E_APPROVAL_STATE_KEY_INVALID')
  }
  return {
    identity: {
      realPath: value.directory.realPath,
      device: value.directory.device,
      inode: value.directory.inode,
    },
    stateEncryptionKey,
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
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

function safeAuthorityErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'EPERM' || error.code === 'EACCES')) {
    return 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED'
  }
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(error.code)) return error.code
  return 'E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE'
}
