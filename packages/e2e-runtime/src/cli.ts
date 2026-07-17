import {
  ApprovalGrantSubjectSchema,
  E2EError,
  canonicalizeJson,
  canonicalGrantApprovalType,
  digestText,
  type ApprovalGrantSubject,
} from '@mutil-skills/e2e-contracts'
import { homedir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import {
  installRuntime as installRuntimeDefault,
  type InstallRuntimeOptions,
  type RuntimeInstallResult,
} from './runtime-installer.js'
import {
  uninstallRuntime as uninstallRuntimeDefault,
  type RuntimeUninstallResult,
  type UninstallRuntimeOptions,
} from './runtime-uninstaller.js'
import {
  inspectRuntimeInstallation as inspectRuntimeInstallationDefault,
  type InspectRuntimeInstallationOptions,
  type RuntimeInstallation,
} from './runtime-discovery.js'
import {
  runRuntimeDoctor as runRuntimeDoctorDefault,
  runtimeDoctorFailureReport,
  type RunRuntimeDoctorOptions,
  type RuntimeDoctorReport,
} from './runtime-doctor.js'
import { isExactRuntimeVersion } from './runtime-manifest.js'
import { E2ERuntimeHost } from './runtime-host.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from './run-store.js'
import { persistFinalizedApprovalOutcome } from './finalized-approval-outcome.js'
import { assertSameProjectIdentity, resolveProjectIdentity } from './project-identity.js'
import { SecureProjectFileReader } from './secure-project-files.js'
import { RuntimeSecretBroker } from './secret-broker.js'
import {
  computeRuntimeApprovalSubjectDigest,
  startRuntimeAuthorityHost,
  type RuntimeAuthorityHost,
  type RuntimeAuthoritySession,
} from './authority-host.js'
import {
  RUNTIME_PACKAGE_VERSION,
  exitCodeForResponse,
  parseRuntimeRequest,
  runtimeErrorResponse,
  serializeRuntimeDoctorReport,
} from './protocol.js'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const SECRET_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SECRET_REF = /^[A-Z][A-Z0-9_-]{0,127}$/
const MAX_INTERACTIVE_SECRET_BYTES = 64 * 1024

export interface SecretTerminalAdapter {
  readonly isTTY: boolean
  setRawMode(enabled: boolean): void
  read(): AsyncIterable<Uint8Array>
}

interface CliSecretBroker {
  provide(input: { runId: string; secretRef: string; value: Uint8Array }): Promise<void>
  close(): Promise<void>
}

export interface RuntimeCliDependencies {
  homeDir: string
  installRuntime: (options: InstallRuntimeOptions) => Promise<RuntimeInstallResult>
  uninstallRuntime: (options: UninstallRuntimeOptions) => Promise<RuntimeUninstallResult>
  inspectRuntimeInstallation?: (options: InspectRuntimeInstallationOptions) => Promise<RuntimeInstallation>
  runRuntimeDoctor?: (options: RunRuntimeDoctorOptions) => Promise<RuntimeDoctorReport>
  serializeRuntimeDoctorReport?: (report: unknown) => string
  runtimeHost?: Pick<E2ERuntimeHost, 'handle'>
  openHumanAuthoritySession?: (arguments_: string[]) => Promise<RuntimeAuthoritySession>
  startAuthorityHost?: (options: {
    homeDir: string
    installation: RuntimeInstallation
    subject: string
    approvalSessionTtlMs?: number
  }) => Promise<RuntimeAuthorityHost>
  openRunStore?: typeof RuntimeRunStore.open
  currentWorkingDirectory?: () => string
  approvalSessionTtlMs?: number
  secretTerminal?: SecretTerminalAdapter
  validateSecretRun?: (runId: string) => Promise<string | undefined>
  openSecretBroker?: (options: {
    homeDir: string
    projectRoot: string
    projectIdentityDigest?: string
  }) => Promise<CliSecretBroker>
}

export async function runCli(
  arguments_: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
  dependencies: RuntimeCliDependencies = defaultDependencies(),
): Promise<number> {
  const responseWriter = new SingleJsonResponseWriter(stdout)
  if (arguments_.length === 1 && arguments_[0] === '--version') {
    await writeText(stdout, `${RUNTIME_PACKAGE_VERSION}\n`)
    return 0
  }

  if (arguments_[0] === 'install-runtime' || arguments_[0] === 'uninstall-runtime') {
    return runInstallManagementCommand(arguments_, responseWriter, dependencies)
  }

  if (arguments_[0] === 'secret') {
    return await runSecretCommand(arguments_, stdin, responseWriter, dependencies)
  }

  if (isHumanAuthorityCommand(arguments_)) {
    try {
      const session = await (dependencies.openHumanAuthoritySession?.(arguments_)
        ?? openDefaultHumanAuthoritySession(arguments_, dependencies))
      if (session.url !== '') await writeText(stderr, `${session.url}\n`)
      const outcome = await session.wait()
      await responseWriter.write(`${canonicalizeJson(
        outcome ?? { sessionId: session.sessionId, status: 'verified' },
      )}\n`)
      return 0
    } catch (error) {
      const runtimeError = error instanceof E2EError ? error : new E2EError({
        code: 'E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE',
        category: 'safety',
        message: 'WebAuthn 用户在场流程失败',
        retryable: false,
        cause: error,
      })
      return writeErrorResponse(responseWriter, 'UNKNOWN', runtimeError)
    }
  }

  if ((arguments_.length === 1 && arguments_[0] === 'doctor')
    || (arguments_.length === 2 && arguments_[0] === 'doctor' && arguments_[1] === '--json')) {
    let report: RuntimeDoctorReport
    try {
      const installation = await (dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault)({
        homeDir: dependencies.homeDir,
      })
      report = await (dependencies.runRuntimeDoctor ?? runRuntimeDoctorDefault)({ installation })
    } catch {
      report = runtimeDoctorFailureReport(RUNTIME_PACKAGE_VERSION)
    }
    if (arguments_.length === 2) {
      let serialized: string
      try {
        serialized = (dependencies.serializeRuntimeDoctorReport ?? serializeRuntimeDoctorReport)(report)
      } catch {
        report = runtimeDoctorFailureReport(RUNTIME_PACKAGE_VERSION)
        serialized = serializeRuntimeDoctorReport(report)
      }
      await responseWriter.write(`${serialized}\n`)
    } else {
      await writeText(stderr, formatDoctorReport(report))
    }
    return report.ready ? 0 : 3
  }

  if (arguments_.length !== 1 || arguments_[0] !== 'rpc') {
    return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID',
      category: 'input',
      message: '只支持 --version、rpc 或显式 Runtime 安装管理命令',
      retryable: false,
    }))
  }

  let json = ''
  try {
    const requestBytes = await readBytes(stdin)
    json = decodeRequestBytes(requestBytes)
    const request = parseRuntimeRequest(json)
    if (dependencies.runtimeHost !== undefined) {
      const response = await dependencies.runtimeHost.handle(request, requestBytes)
      await responseWriter.write(`${canonicalizeJson(response)}\n`)
      return exitCodeForResponse(response)
    }
    let installation: RuntimeInstallation
    try {
      installation = await (dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault)({
        homeDir: dependencies.homeDir,
      })
    } catch (cause) {
      throw new E2EError({
        code: 'E2E_RUNTIME_NOT_INSTALLED',
        category: 'environment',
        message: 'E2E Runtime Host 尚未安装或 active installation 无法验证',
        retryable: false,
        cause,
      })
    }
    const projectRoot = 'projectRoot' in request ? request.projectRoot : undefined
    const runStore = await RuntimeRunStore.open({
      homeDir: dependencies.homeDir,
      ...(projectRoot === undefined ? {} : { projectRoot }),
    })
    let authorityHost: RuntimeAuthorityHost | undefined
    let response: Awaited<ReturnType<E2ERuntimeHost['handle']>> | undefined
    let processingError: unknown
    try {
      const host = new E2ERuntimeHost({
        installation,
        doctor: async () => await (dependencies.runRuntimeDoctor ?? runRuntimeDoctorDefault)({ installation }),
        runStore,
        now: () => new Date(),
        ...(request.command !== 'open-approval' ? {} : {
          authorityHostFactory: async () => {
            if (authorityHost !== undefined) return authorityHost
            authorityHost = await (dependencies.startAuthorityHost ?? startRuntimeAuthorityHost)({
              homeDir: dependencies.homeDir,
              installation,
              subject: localAuthoritySubject(),
              ...(dependencies.approvalSessionTtlMs === undefined
                ? {} : { approvalSessionTtlMs: dependencies.approvalSessionTtlMs }),
            })
            return authorityHost
          },
          presentUserPresenceUrl: async (url: string) => await writeText(stderr, `${url}\n`),
        }),
      })
      response = await host.handle(request, requestBytes)
    } catch (error) {
      processingError = error
    }
    const cleanupErrors: unknown[] = []
    if (authorityHost !== undefined) {
      try { await authorityHost.close() } catch (error) { cleanupErrors.push(error) }
    }
    try { await runStore.close() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) {
      throw new E2EError({
        code: 'E2E_RUNTIME_CLEANUP_FAILED',
        category: 'internal',
        message: 'Runtime 单请求资源未能完整关闭',
        retryable: false,
        cause: new AggregateError(cleanupErrors),
      })
    }
    if (processingError !== undefined) throw processingError
    if (response === undefined) throw new Error('Runtime response missing')
    await responseWriter.write(`${canonicalizeJson(response)}\n`)
    return exitCodeForResponse(response)
  } catch (error) {
    const runtimeError = error instanceof E2EError
      ? error
      : new E2EError({
          code: 'E2E_RUNTIME_INTERNAL_ERROR',
          category: 'internal',
          message: 'Runtime 处理请求时发生内部错误',
          retryable: false,
          cause: error,
        })
    return writeErrorResponse(responseWriter, requestIdFromUntrustedJson(json), runtimeError)
  }
}

async function runSecretCommand(
  arguments_: string[],
  stdin: Readable,
  responseWriter: SingleJsonResponseWriter,
  dependencies: RuntimeCliDependencies,
): Promise<number> {
  if (arguments_.length !== 6 || arguments_[1] !== 'provide'
    || arguments_[2] !== '--run-id' || !SECRET_RUN_ID.test(arguments_[3]!)
    || arguments_[4] !== '--ref' || !SECRET_REF.test(arguments_[5]!)) {
    return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID', category: 'input',
      message: 'secret provide 只接受 --run-id <safe-id> --ref <SAFE_REF>', retryable: false,
    }))
  }
  const terminal = dependencies.secretTerminal ?? terminalAdapterFor(stdin)
  if (!terminal.isTTY) {
    return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
      code: 'E2E_SECRET_INTERACTIVE_TTY_REQUIRED', category: 'safety',
      message: '交互秘密只能从真实 TTY 隐藏输入读取', retryable: false,
    }))
  }
  const runId = arguments_[3]!
  const secretRef = arguments_[5]!
  const projectRoot = (dependencies.currentWorkingDirectory ?? process.cwd)()
  let secret: Buffer | undefined
  let broker: CliSecretBroker | undefined
  try {
    const projectIdentityDigest = await (dependencies.validateSecretRun?.(runId)
      ?? validateDefaultSecretRun(dependencies.homeDir, projectRoot, runId))
    secret = await readHiddenSecret(terminal)
    broker = await (dependencies.openSecretBroker ?? RuntimeSecretBroker.open)({
      homeDir: dependencies.homeDir,
      projectRoot,
      ...(projectIdentityDigest === undefined ? {} : { projectIdentityDigest }),
    })
    await broker.provide({ runId, secretRef, value: secret })
    await broker.close()
    broker = undefined
    await responseWriter.write(`${canonicalizeJson({ runId, secretRef, status: 'stored' })}\n`)
    return 0
  } catch (cause) {
    if (broker !== undefined) {
      try { await broker.close() } catch { /* output remains a single sanitized error */ }
    }
    const error = cause instanceof E2EError ? cause : new E2EError({
      code: 'E2E_SECRET_INTERACTIVE_FAILED', category: 'safety',
      message: '交互秘密未能安全保存', retryable: false,
    })
    return writeErrorResponse(responseWriter, 'UNKNOWN', error)
  } finally { secret?.fill(0) }
}

async function validateDefaultSecretRun(homeDir: string, projectRoot: string, runId: string): Promise<string> {
  const store = await RuntimeRunStore.open({ homeDir, projectRoot })
  try {
    const identity = await resolveProjectIdentity(projectRoot)
    if (await store.getRun(identity.digest, runId) === undefined) {
      throw new E2EError({
        code: 'E2E_SECRET_RUN_NOT_FOUND', category: 'input',
        message: 'secret provide 必须绑定当前项目中已存在的 Run', retryable: false,
      })
    }
    return identity.digest
  } finally { await store.close() }
}

function terminalAdapterFor(stdin: Readable): SecretTerminalAdapter {
  const candidate = stdin as Readable & { isTTY?: boolean; setRawMode?(enabled: boolean): void }
  return {
    isTTY: candidate.isTTY === true && typeof candidate.setRawMode === 'function',
    setRawMode(enabled: boolean) {
      if (typeof candidate.setRawMode !== 'function') throw new Error('TTY raw mode unavailable')
      candidate.setRawMode(enabled)
    },
    read: () => candidate,
  }
}

async function readHiddenSecret(terminal: SecretTerminalAdapter): Promise<Buffer> {
  const bytes: number[] = []
  let rawMode = false
  let result: Buffer | undefined
  let failure: E2EError | undefined
  try {
    rawMode = true
    terminal.setRawMode(true)
    let completed = false
    for await (const raw of terminal.read()) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      try {
        for (const byte of chunk) {
          if (completed) continue
          if (byte === 0x03) throw new E2EError({
            code: 'E2E_SECRET_INTERACTIVE_INTERRUPTED', category: 'safety',
            message: '交互秘密输入已中断', retryable: false,
          })
          if (byte === 0x0a || byte === 0x0d) { completed = true; continue }
          if (byte === 0x7f || byte === 0x08) { bytes.pop(); continue }
          bytes.push(byte)
          if (bytes.length > MAX_INTERACTIVE_SECRET_BYTES) throw new E2EError({
            code: 'E2E_SECRET_VALUE_TOO_LARGE', category: 'safety',
            message: '交互秘密超过 64KiB 上限', retryable: false,
          })
        }
      } finally { chunk.fill(0) }
      if (completed) break
    }
    if (bytes.length === 0) throw new E2EError({
      code: 'E2E_SECRET_INPUT_INVALID', category: 'safety',
      message: '交互秘密不能为空', retryable: false,
    })
    result = Buffer.from(bytes)
  } catch (cause) {
    failure = cause instanceof E2EError ? cause : new E2EError({
      code: 'E2E_SECRET_INTERACTIVE_FAILED', category: 'safety',
      message: '交互 TTY 读取失败', retryable: false,
    })
  } finally {
    bytes.fill(0)
    if (rawMode) {
      try { terminal.setRawMode(false) } catch {
        result?.fill(0)
        failure ??= new E2EError({
          code: 'E2E_SECRET_INTERACTIVE_RESTORE_FAILED', category: 'safety',
          message: '交互 TTY 状态未能恢复', retryable: false,
        })
      }
    }
  }
  if (failure !== undefined) {
    result?.fill(0)
    throw failure
  }
  return result!
}

async function runInstallManagementCommand(
  arguments_: string[],
  responseWriter: SingleJsonResponseWriter,
  dependencies: RuntimeCliDependencies,
): Promise<number> {
  try {
    if (arguments_.some((argument) => [
      '--purge-state',
      '--purge-quarantine',
      '--purge-identity',
    ].includes(argument))) {
      throw installArgumentError('Runtime 卸载不得混入 state、quarantine 或 identity 销毁')
    }

    if (arguments_[0] === 'install-runtime') {
      if (arguments_.length !== 3 || arguments_[1] !== '--version' || !isExactRuntimeVersion(arguments_[2])) {
        throw installArgumentError('install-runtime 需要 --version <exact>')
      }
      const result = await dependencies.installRuntime({
        homeDir: dependencies.homeDir,
        version: arguments_[2],
      })
      await responseWriter.write(`${canonicalizeJson({
        version: result.version,
        installationDigest: result.installationDigest,
        launcher: result.launcher,
      })}\n`)
      return 0
    }

    const withoutReplacement = arguments_.length === 3
      && arguments_[1] === '--version'
      && isExactRuntimeVersion(arguments_[2])
    const withReplacement = arguments_.length === 5
      && arguments_[1] === '--version'
      && isExactRuntimeVersion(arguments_[2])
      && arguments_[3] === '--activate'
      && isExactRuntimeVersion(arguments_[4])
    if (!withoutReplacement && !withReplacement) {
      throw installArgumentError('uninstall-runtime 需要 --version <exact> [--activate <exact>]')
    }
    const result = await dependencies.uninstallRuntime({
      homeDir: dependencies.homeDir,
      version: arguments_[2]!,
      ...(withReplacement ? { activateVersion: arguments_[4]! } : {}),
    })
    await responseWriter.write(`${canonicalizeJson(result)}\n`)
    return 0
  } catch (error) {
    const runtimeError = error instanceof E2EError
      ? error
      : new E2EError({
          code: 'E2E_RUNTIME_INTERNAL_ERROR',
          category: 'internal',
          message: 'Runtime 安装管理发生内部错误',
          retryable: false,
          cause: error,
        })
    return writeErrorResponse(responseWriter, 'UNKNOWN', runtimeError)
  }
}

async function writeErrorResponse(
  responseWriter: SingleJsonResponseWriter,
  requestId: string,
  error: E2EError,
): Promise<number> {
  if (responseWriter.started) return 70
  const response = runtimeErrorResponse(requestId, error)
  try {
    await responseWriter.write(`${canonicalizeJson(response)}\n`)
  } catch {
    return 70
  }
  return exitCodeForResponse(response)
}

class SingleJsonResponseWriter {
  started = false

  constructor(private readonly stdout: Writable) {}

  async write(text: string): Promise<void> {
    if (this.started) throw new Error('Runtime stdout response has already started')
    this.started = true
    await writeText(this.stdout, text)
  }
}

async function readBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function decodeRequestBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID',
      category: 'input',
      message: 'Runtime request 必须是 UTF-8 JSON',
      retryable: false,
      cause,
    })
  }
}

async function writeText(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve())
  })
}

function requestIdFromUntrustedJson(json: string): string {
  try {
    const value = JSON.parse(json) as unknown
    if (isRecord(value) && typeof value.requestId === 'string' && SAFE_ID.test(value.requestId)) {
      return value.requestId
    }
  } catch {
    // The response still needs a schema-valid correlation value for malformed JSON.
  }
  return 'UNKNOWN'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function installArgumentError(message: string): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_INSTALL_ARGUMENT_INVALID',
    category: 'input',
    message,
    retryable: false,
  })
}

function defaultDependencies(): RuntimeCliDependencies {
  return {
    homeDir: process.env.HOME ?? homedir(),
    installRuntime: installRuntimeDefault,
    uninstallRuntime: uninstallRuntimeDefault,
    inspectRuntimeInstallation: inspectRuntimeInstallationDefault,
    runRuntimeDoctor: runRuntimeDoctorDefault,
  }
}

function isHumanAuthorityCommand(arguments_: string[]): boolean {
  if (arguments_.length === 2 && arguments_[0] === 'identity' && arguments_[1] === 'enroll') return true
  if (arguments_[0] !== 'approve' || arguments_[1] !== '--run-id' || !SAFE_ID.test(arguments_[2]!)
    || arguments_[3] !== '--type' || !isApprovalType(arguments_[4])) return false
  const grantsCapability = arguments_[4] === 'discovery' || arguments_[4] === 'execution'
  return grantsCapability
    ? arguments_.length === 7 && arguments_[5] === '--subject-file' && Boolean(arguments_[6])
    : arguments_.length === 5
}

async function openDefaultHumanAuthoritySession(
  arguments_: string[],
  dependencies: RuntimeCliDependencies,
): Promise<RuntimeAuthoritySession> {
  const inspect = dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault
  const installation = await inspect({ homeDir: dependencies.homeDir })
  const startAuthority = async () => await (dependencies.startAuthorityHost ?? startRuntimeAuthorityHost)({
    homeDir: dependencies.homeDir, installation, subject: localAuthoritySubject(),
    ...(dependencies.approvalSessionTtlMs === undefined ? {} : {
      approvalSessionTtlMs: dependencies.approvalSessionTtlMs,
    }),
  })
  if (arguments_[0] === 'identity') {
    const authority = await startAuthority()
    try {
      return closeAuthorityAfterWait(await authority.enroll({ subject: localAuthoritySubject() }), authority)
    } catch (error) {
      return await closeResourcesAndRethrow(error, [authority])
    }
  }

  const projectRoot = (dependencies.currentWorkingDirectory ?? process.cwd)()
  let store: RuntimeRunStore
  try {
    store = await (dependencies.openRunStore ?? RuntimeRunStore.open)({
      homeDir: dependencies.homeDir, projectRoot,
    })
  } catch (error) {
    throw error
  }
  let authority: RuntimeAuthorityHost | undefined
  try {
    const identity = await resolveProjectIdentity(projectRoot)
    const runId = arguments_[2]!
    const initial = await readRunWithLease(store, identity.digest, runId)
    if (initial.runtimeInstallationDigest !== installation.installationDigest) {
      throw cliAuthorityError('E2E_RUNTIME_INSTALLATION_BINDING_MISMATCH')
    }
    const approvalType = approvalTypeForWorkflow(initial.workflow.current, arguments_[4]!)
    const grantSubject = await readHumanGrantSubject(arguments_, approvalType, identity)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(initial, approvalType, grantSubject)
    const stable = stableHumanApprovalRequest(initial, approvalType, subjectDigest)
    const reservation = grantSubject === undefined
      ? { kind: 'pending' as const }
      : await store.beginRequest(stable.requestId, stable.requestDigest)
    if (reservation.kind === 'replay') {
      await store.close()
      return {
        url: '', sessionId: stable.finalizationId,
        async wait() { return reservation.response as Awaited<ReturnType<RuntimeAuthoritySession['wait']>> },
      }
    }
    authority = await startAuthority()
    const approvalBinding = grantSubject === undefined ? undefined : {
      runId, approvalType: approvalType as 'discovery' | 'execution', subjectDigest,
      installationDigest: installation.installationDigest,
    }
    const assertCurrentApprovalSubject = async () => {
      const current = await store.getRun(identity.digest, runId)
      if (current === undefined
        || current.runtimeInstallationDigest !== installation.installationDigest
        || approvalTypeForWorkflow(current.workflow.current, approvalType) !== approvalType
        || computeRuntimeApprovalSubjectDigest(current, approvalType, grantSubject) !== subjectDigest
        || stableHumanApprovalRequest(current, approvalType, subjectDigest).requestId !== stable.requestId) {
        throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_CHANGED')
      }
      return current
    }
    let recoveredSessionId: string | undefined
    let recoveredOutcome: Awaited<ReturnType<RuntimeAuthoritySession['wait']>>
    if (grantSubject !== undefined) {
      const currentIdentity = await resolveProjectIdentity(projectRoot)
      assertSameProjectIdentity(identity, currentIdentity)
      const lock = await store.acquireRunLock(identity.digest, runId)
      try {
        assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
        await assertCurrentApprovalSubject()
        const recovered = await authority.recoverApproval({
          finalizationId: stable.finalizationId, requestDigest: stable.requestDigest,
          grantSubject, approvalBinding: approvalBinding!,
        })
        if (recovered !== undefined) {
          assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
          const response = {
            sessionId: recovered.sessionId,
            status: 'verified' as const,
            signedGrant: recovered.grant,
            approvalBinding: recovered.approvalBinding,
          }
          recoveredOutcome = await persistFinalizedApprovalOutcome({
            persist: async () => await store.readRunOutcome(
              identity.digest, runId, stable.requestId, stable.requestDigest, () => response, lock,
            ) as typeof response,
            acknowledge: async () => {
              await authority!.acknowledgeFinalization({
                finalizationId: stable.finalizationId,
                requestDigest: stable.requestDigest,
                grantId: recovered.grant.grantId,
                approvalBinding: recovered.approvalBinding,
              })
            },
            persistencePending: (cause) => new E2EError({
              code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING', category: 'safety',
              message: 'Authority 已恢复 Grant，但 Run Store outcome 尚未持久化；可用相同命令重试',
              retryable: true, cause,
            }),
          })
          recoveredSessionId = recovered.sessionId
        }
      } finally { await lock.close() }
    }
    if (recoveredSessionId !== undefined) {
      await runWithResourceCleanup(async () => undefined, [store, authority])
      return {
        url: '', sessionId: recoveredSessionId,
        async wait() { return recoveredOutcome },
      }
    }
    const session = await authority.requestApproval({
      runId, approvalType, subjectDigest, installationDigest: installation.installationDigest,
      ...(grantSubject === undefined ? {} : {
        finalizationId: stable.finalizationId, requestDigest: stable.requestDigest,
      }),
    })
    return {
      url: session.url,
      sessionId: session.sessionId,
      async wait() {
        let outcome: Awaited<ReturnType<RuntimeAuthoritySession['wait']>> = undefined
        await runWithResourceCleanup(async () => {
          await session.wait()
          const currentIdentity = await resolveProjectIdentity(projectRoot)
          assertSameProjectIdentity(identity, currentIdentity)
          const lock = await store.acquireRunLock(identity.digest, runId)
          try {
            assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
            await assertCurrentApprovalSubject()
            if (grantSubject !== undefined) {
              if (!session.finalize) {
                throw cliAuthorityError('E2E_APPROVAL_FINALIZE_UNAVAILABLE')
              }
              const finalized = await session.finalize(grantSubject)
              assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
              const response = {
                sessionId: session.sessionId,
                status: 'verified' as const,
                signedGrant: finalized.grant,
                approvalBinding: finalized.approvalBinding,
              }
              outcome = await persistFinalizedApprovalOutcome({
                persist: async () => await store.readRunOutcome(
                  identity.digest, runId, stable.requestId, stable.requestDigest, () => response, lock,
                ) as typeof response,
                acknowledge: async () => {
                  await authority!.acknowledgeFinalization({
                    finalizationId: stable.finalizationId,
                    requestDigest: stable.requestDigest,
                    grantId: finalized.grant.grantId,
                    approvalBinding: finalized.approvalBinding,
                  })
                },
                persistencePending: (cause) => new E2EError({
                  code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING', category: 'safety',
                  message: 'Authority 已最终化 Grant，但 Run Store outcome 尚未持久化；可用相同命令恢复',
                  retryable: true, cause,
                }),
              })
            }
          } finally { await lock.close() }
        }, [store, authority!])
        return outcome
      },
    }
  } catch (error) {
    return await closeResourcesAndRethrow(error, [store, ...(authority === undefined ? [] : [authority])])
  }
}

function stableHumanApprovalRequest(
  snapshot: RuntimeRunSnapshot,
  approvalType: 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy',
  subjectDigest: string,
): { requestId: string; requestDigest: string; finalizationId: string } {
  const requestDigest = digestText('e2e-runtime-human-approval/v2', canonicalizeJson({
    runId: snapshot.runId,
    approvalType,
    subjectDigest,
    workflowSequence: snapshot.workflow.sequence,
    workflowEventChainDigest: snapshot.workflow.eventChainDigest,
    recordedRequestIds: Object.keys(snapshot.requestResponses).sort(),
  }))
  const suffix = requestDigest.slice('sha256:'.length)
  return {
    requestId: `HUMAN-APPROVAL-${suffix}`,
    requestDigest,
    finalizationId: `FINALIZE-HUMAN-${suffix}`,
  }
}

async function readHumanGrantSubject(
  arguments_: string[],
  approvalType: 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy',
  identity: Awaited<ReturnType<typeof resolveProjectIdentity>>,
): Promise<ApprovalGrantSubject | undefined> {
  const grantsCapability = approvalType === 'discovery' || approvalType === 'execution'
  if (!grantsCapability) {
    if (arguments_.length !== 5) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_UNEXPECTED')
    return undefined
  }
  if (arguments_.length !== 7 || arguments_[5] !== '--subject-file') {
    throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_REQUIRED')
  }
  const reader = new SecureProjectFileReader()
  const bytes = await reader.readFile({
    realRoot: identity.realRoot, device: identity.device, inode: identity.inode,
  }, arguments_[6]!, 16 * 1024 * 1024)
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    const subject = ApprovalGrantSubjectSchema.parse(parsed)
    const actualType = canonicalGrantApprovalType(subject)
    if (actualType !== approvalType) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_INVALID')
    return subject
  } catch (error) {
    if (error instanceof E2EError) throw error
    throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_INVALID')
  } finally { bytes.fill(0) }
}

function closeAuthorityAfterWait(
  session: RuntimeAuthoritySession,
  authority: { close(): Promise<void> },
): RuntimeAuthoritySession {
  return {
    url: session.url,
    sessionId: session.sessionId,
    async wait() {
      await runWithResourceCleanup(async () => { await session.wait() }, [authority])
    },
  }
}

async function settleResources(resources: Array<{ close(): Promise<void> }>): Promise<unknown[]> {
  const results = await Promise.allSettled(resources.map(async (resource) => await resource.close()))
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
}

async function closeResourcesAndRethrow(
  operationError: unknown,
  resources: Array<{ close(): Promise<void> }>,
): Promise<never> {
  const cleanupErrors = await settleResources(resources)
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      'E2E_RUNTIME_OPERATION_AND_RESOURCE_CLEANUP_FAILED',
    )
  }
  throw operationError
}

async function runWithResourceCleanup(
  operation: () => Promise<void>,
  resources: Array<{ close(): Promise<void> }>,
): Promise<void> {
  let outcome: { status: 'fulfilled' } | { status: 'rejected'; reason: unknown }
  try {
    await operation()
    outcome = { status: 'fulfilled' }
  } catch (reason) {
    outcome = { status: 'rejected', reason }
  }
  const cleanupErrors = await settleResources(resources)
  if (outcome.status === 'rejected') {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [outcome.reason, ...cleanupErrors],
        'E2E_RUNTIME_OPERATION_AND_RESOURCE_CLEANUP_FAILED',
      )
    }
    throw outcome.reason
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'E2E_RUNTIME_RESOURCE_CLEANUP_FAILED')
  }
}

async function readRunWithLease(
  store: RuntimeRunStore,
  projectIdentityDigest: string,
  runId: string,
) {
  const lock = await store.acquireRunLock(projectIdentityDigest, runId)
  try {
    const snapshot = await store.getRun(projectIdentityDigest, runId)
    if (snapshot === undefined) throw cliAuthorityError('E2E_RUNTIME_RUN_NOT_FOUND')
    return snapshot
  } finally { await lock.close() }
}

function approvalTypeForWorkflow(
  workflow: string,
  requested: string,
): 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy' {
  if (!isApprovalType(requested)) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_TYPE_MISMATCH')
  const allowed: Record<string, Array<typeof requested>> = {
    'awaiting-scope-approval': ['scope', 'lineage'],
    'coverage-audited': ['discovery'],
    'awaiting-execution-approval': ['execution'],
    diagnosing: ['privacy'],
    finalizing: ['privacy'],
  }
  if (!allowed[workflow]?.includes(requested)) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_TYPE_MISMATCH')
  return requested
}

function isApprovalType(value: string | undefined): value is
  'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy' {
  return value !== undefined && ['scope', 'lineage', 'discovery', 'execution', 'privacy'].includes(value)
}

function localAuthoritySubject(): string {
  if (typeof process.getuid !== 'function') throw cliAuthorityError('E2E_RUNTIME_PLATFORM_UNSUPPORTED')
  return `local:uid:${process.getuid()}`
}

function cliAuthorityError(code: string): E2EError {
  return new E2EError({
    code,
    category: 'safety',
    message: `${code}: 人类审批命令无法建立可信 Run/Authority 绑定`,
    retryable: false,
  })
}

function formatDoctorReport(report: RuntimeDoctorReport): string {
  const statusLabels: Record<RuntimeDoctorReport['probes'][string]['status'], string> = {
    passed: '通过',
    blocked: '阻塞',
    'not-installed': '未安装',
  }
  const lines = [
    'Runtime Doctor',
    `运行时版本：${report.runtimeVersion}`,
    `就绪：${report.ready ? '是' : '否'}`,
    '探针\t状态\t原因代码\t修复建议',
  ]
  for (const [name, probe] of Object.entries(report.probes)) {
    lines.push(`${name}\t${statusLabels[probe.status]}\t${probe.reasonCode}\t${probe.remediation}`)
  }
  return `${lines.join('\n')}\n`
}
