import {
  ApprovalGrantSubjectSchema,
  E2EError,
  canonicalizeJson,
  canonicalGrantApprovalType,
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
import { RuntimeRunStore } from './run-store.js'
import { assertSameProjectIdentity, resolveProjectIdentity } from './project-identity.js'
import { SecureProjectFileReader } from './secure-project-files.js'
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
  currentWorkingDirectory?: () => string
  approvalSessionTtlMs?: number
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

  if (isHumanAuthorityCommand(arguments_)) {
    try {
      const session = await (dependencies.openHumanAuthoritySession?.(arguments_)
        ?? openDefaultHumanAuthoritySession(arguments_, dependencies))
      await writeText(stderr, `${session.url}\n`)
      await session.wait()
      await responseWriter.write(`${canonicalizeJson({ sessionId: session.sessionId, status: 'verified' })}\n`)
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
  const authority = await (dependencies.startAuthorityHost ?? startRuntimeAuthorityHost)({
    homeDir: dependencies.homeDir,
    installation,
    subject: localAuthoritySubject(),
    ...(dependencies.approvalSessionTtlMs === undefined
      ? {} : { approvalSessionTtlMs: dependencies.approvalSessionTtlMs }),
  })
  if (arguments_[0] === 'identity') {
    try {
      return closeAuthorityAfterWait(await authority.enroll({ subject: localAuthoritySubject() }), authority)
    } catch (error) {
      return await closeResourcesAndRethrow(error, [authority])
    }
  }

  const projectRoot = (dependencies.currentWorkingDirectory ?? process.cwd)()
  let store: RuntimeRunStore
  try {
    store = await RuntimeRunStore.open({ homeDir: dependencies.homeDir, projectRoot })
  } catch (error) {
    return await closeResourcesAndRethrow(error, [authority])
  }
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
    const session = await authority.requestApproval({
      runId, approvalType, subjectDigest, installationDigest: installation.installationDigest,
    })
    return {
      url: session.url,
      sessionId: session.sessionId,
      async wait() {
        await runWithResourceCleanup(async () => {
          await session.wait()
          const currentIdentity = await resolveProjectIdentity(projectRoot)
          assertSameProjectIdentity(identity, currentIdentity)
          const current = await readRunWithLease(store, identity.digest, runId)
          if (computeRuntimeApprovalSubjectDigest(current, approvalType, grantSubject) !== subjectDigest) {
            throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_CHANGED')
          }
        }, [store, authority])
      },
    }
  } catch (error) {
    return await closeResourcesAndRethrow(error, [store, authority])
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
      await runWithResourceCleanup(async () => await session.wait(), [authority])
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
