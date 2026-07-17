import {
  startAuthorityExecutionRpcHostProcess,
  type AuthorityExecutionRpcProcessHandle,
  type WebAuthnApprovalAssets,
  type WebAuthnApprovalType,
} from '@mutil-skills/e2e-authority'
import {
  ApprovalFinalizationAcknowledgementSchema,
  canonicalizeJson,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
  digestText,
  E2EError,
  type ApprovalExecutionBinding,
  type ApprovalFinalizationAcknowledgement,
  type ApprovalGrantSubject,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
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
import {
  discoverTrustedPython,
  reverifyTrustedPython,
  type TrustedPythonRuntime,
} from './trusted-python.js'

const BUNDLE_DIGEST = 'sha256:cf4469953efcb5617a870ae3f022b3ad48aee8c06012ccdafcabc73058f123a0'
const DIGEST = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

type RuntimeAuthorityProcess = Pick<AuthorityExecutionRpcProcessHandle,
  'enrollIdentity' | 'openApprovalSession' | 'waitForSession' | 'close'> &
  Partial<Pick<AuthorityExecutionRpcProcessHandle,
    'finalizeApproval' | 'recoverApproval' | 'activateGrant' | 'acknowledgeFinalization'
    | 'endpoint' | 'credential' | 'verifierMaterial'>>

export interface RuntimeAuthoritySession {
  url: string
  sessionId: string
  wait(): Promise<void | {
    sessionId: string
    status: 'verified'
    signedGrant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
  }>
  finalize?(grantSubject: ApprovalGrantSubject): Promise<{
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
  }>
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
    finalizationId?: string
    requestDigest?: string
  }): Promise<RuntimeAuthoritySession> {
    this.#requireOpen()
    if (input.installationDigest !== this.#installationDigest) {
      throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    }
    const grantsCapability = input.approvalType === 'discovery' || input.approvalType === 'execution'
    if (grantsCapability && (!input.finalizationId || !SAFE_ID.test(input.finalizationId)
      || !input.requestDigest || !DIGEST.test(input.requestDigest))) {
      throw authorityHostError('E2E_APPROVAL_FINALIZATION_INVALID')
    }
    const reference = await this.#process.openApprovalSession({
      runId: input.runId, approvalType: input.approvalType,
      subjectDigest: input.subjectDigest, installationDigest: input.installationDigest,
    })
    const binding: ApprovalExecutionBinding | undefined = grantsCapability
      ? {
          runId: input.runId,
          installationDigest: input.installationDigest,
          approvalType: input.approvalType as 'discovery' | 'execution',
          subjectDigest: input.subjectDigest,
        }
      : undefined
    return this.#session(reference, binding, binding === undefined ? undefined : {
      finalizationId: input.finalizationId!, requestDigest: input.requestDigest!,
    })
  }

  async recoverApproval(input: {
    finalizationId: string
    requestDigest: string
    grantSubject: ApprovalGrantSubject
    approvalBinding: ApprovalExecutionBinding
  }): Promise<{
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
    sessionId: string
  } | undefined> {
    this.#requireOpen()
    if (!this.#process.recoverApproval) throw authorityHostError('E2E_APPROVAL_FINALIZE_UNAVAILABLE')
    if (input.approvalBinding.installationDigest !== this.#installationDigest) {
      throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    }
    try {
      const recovered = await this.#process.recoverApproval(input)
      if (recovered !== undefined
        && canonicalizeJson(recovered.approvalBinding) !== canonicalizeJson(input.approvalBinding)) {
        throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
      }
      return recovered
    } catch (error) { throw authorityHostError(safeAuthorityErrorCode(error)) }
  }

  async activateGrant(input: {
    grant: SignedGrant
    approvalBinding: ApprovalExecutionBinding
  }): Promise<void> {
    this.#requireOpen()
    if (!this.#process.activateGrant) throw authorityHostError('E2E_APPROVAL_ACTIVATE_UNAVAILABLE')
    if (input.approvalBinding.installationDigest !== this.#installationDigest) {
      throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
    }
    try { await this.#process.activateGrant(input) }
    catch (error) { throw authorityHostError(safeAuthorityErrorCode(error)) }
  }

  async acknowledgeFinalization(input: ApprovalFinalizationAcknowledgement): Promise<void> {
    this.#requireOpen()
    const parsed = ApprovalFinalizationAcknowledgementSchema.safeParse(input)
    if (!parsed.success || parsed.data.approvalBinding.installationDigest !== this.#installationDigest) {
      throw authorityHostError('E2E_APPROVAL_FINALIZATION_INVALID')
    }
    if (!this.#process.acknowledgeFinalization) return
    try { await this.#process.acknowledgeFinalization(parsed.data) }
    catch (error) { throw authorityHostError(safeAuthorityErrorCode(error)) }
  }

  executionRpcConnection(approvalBinding: ApprovalExecutionBinding) {
    this.#requireOpen()
    if (!this.#process.endpoint || !this.#process.credential || !this.#process.verifierMaterial) {
      throw authorityHostError('E2E_RPC_HOST_NOT_READY')
    }
    return {
      endpoint: this.#process.endpoint,
      credential: structuredClone(this.#process.credential),
      verifierMaterial: structuredClone(this.#process.verifierMaterial),
      approvalBinding: structuredClone(approvalBinding),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#process.close()
  }

  #session(
    reference: { url: string; sessionId: string },
    expectedBinding?: ApprovalExecutionBinding,
    finalization?: { finalizationId: string; requestDigest: string },
  ): RuntimeAuthoritySession {
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
      ...(expectedBinding === undefined ? {} : { finalize: async (grantSubject: ApprovalGrantSubject) => {
        if (!this.#process.finalizeApproval) throw authorityHostError('E2E_APPROVAL_FINALIZE_UNAVAILABLE')
        try {
          const finalized = await this.#process.finalizeApproval({
            sessionId: reference.sessionId, grantSubject,
            finalizationId: finalization!.finalizationId,
            requestDigest: finalization!.requestDigest,
          })
          if (canonicalizeJson(finalized.approvalBinding) !== canonicalizeJson(expectedBinding)) {
            throw authorityHostError('E2E_APPROVAL_SESSION_BINDING_MISMATCH')
          }
          return finalized
        }
        catch (error) { throw authorityHostError(safeAuthorityErrorCode(error)) }
      } }),
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
  const trustedPython = await discoverTrustedPython()
  const prepared = await prepareAuthorityState(options.homeDir, layout.authority, environment, trustedPython)
  let processHandle: AuthorityExecutionRpcProcessHandle | undefined
  try {
    const assets = await loadRuntimeApprovalAssets()
    const childWrapperPath = await secureRuntimeScriptPath('authority-child-fchdir.py')
    try {
      await reverifyTrustedPython(trustedPython)
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
            pythonExecutable: trustedPython.executable,
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
    try {
      await prepared.directoryHandle.close()
    } catch (closeError) {
      if (processHandle === undefined) throw closeError
      const childCleanup = await Promise.allSettled([processHandle.close()])
      const childError = childCleanup[0]?.status === 'rejected' ? childCleanup[0].reason : undefined
      if (childError !== undefined) {
        throw new AggregateError([closeError, childError], 'E2E_APPROVAL_PARENT_FD_AND_CHILD_CLEANUP_FAILED')
      }
      throw closeError
    }
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
  grantSubject?: ApprovalGrantSubject,
): string {
  if (approvalType === 'discovery' || approvalType === 'execution') {
    if (grantSubject === undefined || canonicalGrantApprovalType(grantSubject) !== approvalType
      || grantSubject.assetId !== snapshot.assetId
      || grantSubject.prdRevision !== snapshot.artifactDigests['prd-source']
      || ('actions' in grantSubject && grantSubject.actions.some((action) =>
        'runId' in action && action.runId !== snapshot.runId))) {
      throw authorityHostError('E2E_RUNTIME_APPROVAL_SUBJECT_INVALID')
    }
    return canonicalGrantApprovalSubjectDigest(grantSubject)
  }
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
  trustedPython: TrustedPythonRuntime,
): Promise<PreparedAuthorityState> {
  let directoryHandle: FileHandle | undefined
  let stateEncryptionKey: Buffer | undefined
  try {
    const canonicalHome = await realpath(homeDir)
    if (canonicalHome !== normalizePlatformPathAlias(homeDir)) {
      throw authorityHostError('E2E_APPROVAL_STATE_DIRECTORY_INVALID')
    }
    const helperPath = await secureRuntimeScriptPath('authority-state-openat.py')
    const output = await runStateHelper(helperPath, canonicalHome, environment, trustedPython)
    let parsed: ReturnType<typeof parseStateHelperOutput>
    try { parsed = parseStateHelperOutput(output, authorityRoot) }
    finally { output.fill(0) }
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
  trustedPython: TrustedPythonRuntime,
): Promise<Buffer> {
  await reverifyTrustedPython(trustedPython)
  const child = spawn(trustedPython.executable, [helperPath, canonicalHome], {
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  })
  const stdout: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > 8192) { overflow = true; child.kill('SIGKILL') } else stdout.push(Buffer.from(chunk))
    } finally { chunk.fill(0) }
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
  const output = Buffer.concat(stdout)
  for (const chunk of stdout) chunk.fill(0)
  try {
    if (overflow) throw authorityHostError('E2E_APPROVAL_STATE_HELPER_INVALID')
    const text = output.toString('utf8')
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
    return output
  } catch (error) {
    output.fill(0)
    throw error
  }
}

function parseStateHelperOutput(
  output: Buffer,
  expectedAuthorityRoot: string,
): { identity: SecureDirectoryIdentity; stateEncryptionKey: Buffer } {
  let value: unknown
  try { value = JSON.parse(output.toString('utf8')) } catch {
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
  const encodedKey = value.keyBase64Url
  const stateEncryptionKey = Buffer.from(encodedKey, 'base64url')
  if (stateEncryptionKey.byteLength !== 32
    || stateEncryptionKey.toString('base64url') !== encodedKey) {
    value.keyBase64Url = ''
    stateEncryptionKey.fill(0)
    throw authorityHostError('E2E_APPROVAL_STATE_KEY_INVALID')
  }
  value.keyBase64Url = ''
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
