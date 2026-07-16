import { E2EError, canonicalizeJson } from '@mutil-skills/e2e-contracts'
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
import { runtimeLayout } from './runtime-layout.js'
import { E2ERuntimeHost } from './runtime-host.js'
import { RuntimeRunStore } from './run-store.js'
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
}

export async function runCli(
  arguments_: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
  dependencies: RuntimeCliDependencies = defaultDependencies(),
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === '--version') {
    await writeText(stdout, `${RUNTIME_PACKAGE_VERSION}\n`)
    return 0
  }

  if (arguments_[0] === 'install-runtime' || arguments_[0] === 'uninstall-runtime') {
    return runInstallManagementCommand(arguments_, stdout, dependencies)
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
      await writeText(stdout, `${serialized}\n`)
    } else {
      await writeText(stderr, formatDoctorReport(report))
    }
    return report.ready ? 0 : 3
  }

  if (arguments_.length !== 1 || arguments_[0] !== 'rpc') {
    return writeErrorResponse(stdout, 'UNKNOWN', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID',
      category: 'input',
      message: '只支持 --version、rpc 或显式 Runtime 安装管理命令',
      retryable: false,
    }))
  }

  const json = await readUtf8(stdin)
  try {
    const request = parseRuntimeRequest(json)
    if (dependencies.runtimeHost !== undefined) {
      const response = await dependencies.runtimeHost.handle(request, json)
      await writeText(stdout, `${canonicalizeJson(response)}\n`)
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
      stateRoot: runtimeLayout(dependencies.homeDir).state,
      ...(projectRoot === undefined ? {} : { forbiddenRoots: [projectRoot] }),
    })
    try {
      const host = new E2ERuntimeHost({
        installation,
        doctor: async () => await (dependencies.runRuntimeDoctor ?? runRuntimeDoctorDefault)({ installation }),
        runStore,
        now: () => new Date(),
      })
      const response = await host.handle(request, json)
      await writeText(stdout, `${canonicalizeJson(response)}\n`)
      return exitCodeForResponse(response)
    } finally {
      await runStore.close()
    }
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
    return writeErrorResponse(stdout, requestIdFromUntrustedJson(json), runtimeError)
  }
}

async function runInstallManagementCommand(
  arguments_: string[],
  stdout: Writable,
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
      await writeText(stdout, `${canonicalizeJson({
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
    await writeText(stdout, `${canonicalizeJson(result)}\n`)
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
    return writeErrorResponse(stdout, 'UNKNOWN', runtimeError)
  }
}

async function writeErrorResponse(stdout: Writable, requestId: string, error: E2EError): Promise<number> {
  const response = runtimeErrorResponse(requestId, error)
  await writeText(stdout, `${canonicalizeJson(response)}\n`)
  return exitCodeForResponse(response)
}

async function readUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
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
