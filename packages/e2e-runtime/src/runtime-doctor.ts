import {
  ArtifactSchemaRegistry,
  RuntimeDoctorProbeSchema,
  RuntimeDoctorReportSchema,
  canonicalizeJson,
  digestText,
} from '@mutil-skills/e2e-contracts'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRuntimeInstallation, type RuntimeInstallation } from './runtime-discovery.js'
import { discoverTrustedPython } from './trusted-python.js'
import { inspectChromiumInstallation } from './browser-installer.js'
import { inspectRuntimeCapabilityProof } from './runtime-capability-proof.js'
import {
  deriveRuntimeQuarantineMasterKey,
  openRuntimeArtifactStoreAuthority,
} from './authority-host.js'
import { runtimeLayout } from './runtime-layout.js'
import { renderCompleteReport } from '@mutil-skills/e2e-report'
import {
  readApprovalMode,
  readBrowserSelection,
  type ApprovalMode,
} from './runtime-user-config.js'
import { revalidateSystemChrome, systemChromeClosureDigest } from './system-chrome.js'

export const RUNTIME_DOCTOR_PROBE_NAMES = [
  'installation',
  'version-closure',
  'source-independence',
  'authority',
  'approval-presence',
  'gateway',
  'chromium',
  'isolation',
  'artifact-fs',
  'quarantine',
  'report',
] as const

export type RuntimeDoctorProbeName = typeof RUNTIME_DOCTOR_PROBE_NAMES[number]
export type RuntimeDoctorProbe = ReturnType<typeof RuntimeDoctorProbeSchema.parse>
export type RuntimeDoctorReport = ReturnType<typeof RuntimeDoctorReportSchema.parse>

export interface RuntimeProbeContext {
  installation: RuntimeInstallation
  homeDir: string
  authorityInspection?: Promise<RuntimeAuthorityInspection>
  approvalMode: ApprovalMode
  systemChromeVersionReader?: (executablePath: string) => Promise<string>
}

export type RuntimeProbe = (context: RuntimeProbeContext) => Promise<RuntimeDoctorProbe>

export interface RunRuntimeDoctorOptions {
  installation: RuntimeInstallation
  homeDir: string
  probes?: Partial<Record<RuntimeDoctorProbeName, RuntimeProbe>>
  systemChromeVersionReader?: (executablePath: string) => Promise<string>
}

export interface AggregateDoctorReportInput {
  runtimeVersion: string
  installationDigest: string
  probes: Record<string, RuntimeDoctorProbe>
  browserSource?: 'system-chrome' | 'managed-chromium' | 'unconfigured'
  approvalMode?: ApprovalMode
}

export function aggregateDoctorReport(input: AggregateDoctorReportInput): RuntimeDoctorReport {
  return RuntimeDoctorReportSchema.parse({
    ready: RUNTIME_DOCTOR_PROBE_NAMES.every((name) => input.probes[name]?.status === 'passed'),
    runtimeVersion: input.runtimeVersion,
    installationDigest: input.installationDigest,
    browserSource: input.browserSource ?? 'unconfigured',
    approvalMode: input.approvalMode ?? 'local-confirmation',
    probes: input.probes,
  })
}

export async function runRuntimeDoctor(options: RunRuntimeDoctorOptions): Promise<RuntimeDoctorReport> {
  const approvalMode = (await readApprovalMode(options.homeDir)).mode
  const browserSource = await readBrowserSelection(options.homeDir)
    .then((selection) => selection.source.kind)
    .catch(() => 'unconfigured' as const)
  const context: RuntimeProbeContext = {
    installation: options.installation, homeDir: options.homeDir, approvalMode,
    ...(options.systemChromeVersionReader === undefined ? {} : {
      systemChromeVersionReader: options.systemChromeVersionReader,
    }),
  }
  const probes: Record<string, RuntimeDoctorProbe> = {}
  for (const name of RUNTIME_DOCTOR_PROBE_NAMES) {
    try {
      probes[name] = RuntimeDoctorProbeSchema.parse(
        await (options.probes?.[name] ?? DEFAULT_RUNTIME_PROBES[name])(context),
      )
    } catch {
      probes[name] = {
        status: 'blocked',
        reasonCode: 'E2E_RUNTIME_DOCTOR_PROBE_FAILED',
        remediation: '重新运行 doctor；若问题持续，重新安装 Runtime',
      }
    }
  }
  return aggregateDoctorReport({
    runtimeVersion: options.installation.version,
    installationDigest: options.installation.installationDigest,
    probes, browserSource, approvalMode,
  })
}

export function runtimeDoctorFailureReport(runtimeVersion: string): RuntimeDoctorReport {
  const probes: Record<string, RuntimeDoctorProbe> = {}
  for (const name of RUNTIME_DOCTOR_PROBE_NAMES) {
    probes[name] = name === 'installation'
      ? {
          status: 'blocked',
          reasonCode: 'E2E_RUNTIME_INSTALLATION_CHECK_FAILED',
          remediation: '重新安装 Runtime 后再次运行 doctor',
        }
      : {
          status: 'not-installed',
          reasonCode: 'E2E_RUNTIME_PROBE_NOT_RUN',
          remediation: '先修复 Runtime 安装后再次运行 doctor',
        }
  }
  return RuntimeDoctorReportSchema.parse({
    ready: false,
    runtimeVersion,
    installationDigest: `sha256:${'0'.repeat(64)}`,
    browserSource: 'unconfigured',
    approvalMode: 'local-confirmation',
    probes,
  })
}

const DEFAULT_RUNTIME_PROBES: Record<RuntimeDoctorProbeName, RuntimeProbe> = {
  installation: verifiedInstallationProbe('E2E_RUNTIME_INSTALLATION_OK'),
  'version-closure': verifiedInstallationProbe('E2E_RUNTIME_VERSION_CLOSURE_OK'),
  'source-independence': verifiedInstallationProbe('E2E_RUNTIME_SOURCE_INDEPENDENCE_OK'),
  authority: authorityProbe,
  'approval-presence': approvalPresenceProbe,
  gateway: capabilityProofProbe('gateway'),
  chromium: async (context) => {
    const { homeDir, installation } = context
    try {
      const browser = await inspectConfiguredBrowser(context)
      return {
        status: 'passed',
        reasonCode: browser.source === 'system-chrome'
          ? 'E2E_SYSTEM_CHROME_SELECTION_OK' : 'E2E_CHROMIUM_INSTALLATION_OK',
        proofDigest: browser.browserClosureDigest, remediation: '无需处理',
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'E2E_CHROMIUM_INSPECTION_FAILED'
      return {
        status: code === 'E2E_CHROMIUM_NOT_INSTALLED' ? 'not-installed' : 'blocked', reasonCode: code,
        remediation: code === 'E2E_CHROMIUM_NOT_INSTALLED'
          ? '先运行 repo-e2e configure-browser --system；系统 Chrome 不可用时再显式 install-browser'
          : code === 'E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED'
            ? '重新运行 repo-e2e configure-browser --system'
            : '浏览器完整性验证失败；保留现场并重新配置浏览器',
      }
    }
  },
  isolation: capabilityProofProbe('isolation'),
  'artifact-fs': artifactAuthorityProbe,
  quarantine: quarantineProbe,
  report: reportProbe,
}

interface RuntimeAuthorityInspection {
  credentialCount: number
  proofDigest: string
  stateProtectionLevel: 'local-crash-integrity' | 'trusted-monotonic'
}

async function authorityProbe(context: RuntimeProbeContext): Promise<RuntimeDoctorProbe> {
  try {
    const inspected = await inspectRuntimeAuthority(context)
    return {
      status: 'passed', reasonCode: 'E2E_AUTHORITY_STATE_AND_SIGNING_OK',
      proofDigest: inspected.proofDigest,
      remediation: inspected.stateProtectionLevel === 'trusted-monotonic'
        ? '无需处理'
        : '当前为本地 crash/integrity 保护；若威胁模型包含同 UID 整体回滚，请配置独立可信单调锚',
    }
  } catch (error) {
    return authorityFailure(error)
  }
}

async function approvalPresenceProbe(context: RuntimeProbeContext): Promise<RuntimeDoctorProbe> {
  try {
    const inspected = await inspectRuntimeAuthority(context)
    if (context.approvalMode === 'local-confirmation') return {
      status: 'passed', reasonCode: 'E2E_LOCAL_CONFIRMATION_READY',
      proofDigest: inspected.proofDigest,
      remediation: '无需登记 WebAuthn；高风险操作仍需明确本地确认',
    }
    return inspected.credentialCount > 0 ? {
      status: 'passed', reasonCode: 'E2E_APPROVAL_IDENTITY_ENROLLED',
      proofDigest: inspected.proofDigest, remediation: '无需处理',
    } : {
      status: 'not-installed', reasonCode: 'E2E_APPROVAL_IDENTITY_NOT_ENROLLED',
      remediation: '使用 repo-e2e identity enroll 完成本机 WebAuthn identity 登记',
    }
  } catch (error) {
    return authorityFailure(error)
  }
}

async function artifactAuthorityProbe(context: RuntimeProbeContext): Promise<RuntimeDoctorProbe> {
  try {
    const inspected = await inspectRuntimeAuthority(context)
    return {
      status: 'passed', reasonCode: 'E2E_ARTIFACT_AUTHORITY_OK',
      proofDigest: inspected.proofDigest, remediation: '无需处理',
    }
  } catch (error) {
    return authorityFailure(error)
  }
}

async function quarantineProbe(context: RuntimeProbeContext): Promise<RuntimeDoctorProbe> {
  try {
    await requireVerifiedInstallation(context)
    await inspectRuntimeAuthority(context)
    const derived = await deriveRuntimeQuarantineMasterKey(context.homeDir)
    try {
      if (derived.masterKey.byteLength !== 32) throw new Error('E2E_QUARANTINE_KEY_DERIVATION_FAILED')
    } finally { derived.clear() }
    return {
      status: 'passed', reasonCode: 'E2E_QUARANTINE_KEY_PROVIDER_OK',
      proofDigest: digestText('runtime-doctor-quarantine/v1', canonicalizeJson({
        installationDigest: context.installation.installationDigest,
        storage: 'git-outside-encrypted',
      })),
      remediation: '无需处理',
    }
  } catch (error) {
    return doctorCapabilityFailure(error, 'E2E_QUARANTINE_NOT_INSTALLED',
      '先安装 Runtime、初始化 Authority 并再次运行 doctor')
  }
}

async function reportProbe(context: RuntimeProbeContext): Promise<RuntimeDoctorProbe> {
  try {
    await requireVerifiedInstallation(context)
    if (typeof renderCompleteReport !== 'function' || ArtifactSchemaRegistry['final-report'] === undefined) {
      throw new Error('E2E_REPORT_RUNTIME_INVALID')
    }
    return {
      status: 'passed', reasonCode: 'E2E_REPORT_RUNTIME_OK',
      proofDigest: digestText('runtime-doctor-report/v1', canonicalizeJson({
        installationDigest: context.installation.installationDigest,
        reportSchema: 'final-report',
      })),
      remediation: '无需处理',
    }
  } catch (error) {
    return doctorCapabilityFailure(error, 'E2E_REPORT_NOT_INSTALLED',
      '重新安装精确版本 Runtime 以恢复 Report 闭包')
  }
}

async function inspectRuntimeAuthority(context: RuntimeProbeContext): Promise<RuntimeAuthorityInspection> {
  context.authorityInspection ??= inspectRuntimeAuthorityOnce(context)
  return await context.authorityInspection
}

async function inspectRuntimeAuthorityOnce(context: RuntimeProbeContext): Promise<RuntimeAuthorityInspection> {
  await requireVerifiedInstallation(context)
  const layout = runtimeLayout(context.homeDir)
  await Promise.all([
    requirePrivateNode(layout.authority, 'directory', 0o700),
    requirePrivateNode(join(layout.authority, 'state.key'), 'file', 0o600),
    requirePrivateNode(join(layout.authority, 'approval.sqlite'), 'file', 0o600),
  ])
  const subject = typeof process.getuid === 'function' ? `local:uid:${process.getuid()}` : undefined
  if (subject === undefined) throw new Error('E2E_RUNTIME_PLATFORM_UNSUPPORTED')
  const authority = await openRuntimeArtifactStoreAuthority({
    homeDir: context.homeDir, installation: context.installation, subject,
  })
  try {
    const canary = digestText('runtime-doctor-authority-canary/v1', context.installation.installationDigest)
    const signature = authority.signDigest(canary)
    if (!authority.verifySignature(signature)) throw new Error('E2E_ARTIFACT_AUTHORITY_CANARY_FAILED')
    return {
      credentialCount: authority.credentialCount,
      stateProtectionLevel: authority.stateProtectionLevel,
      proofDigest: digestText('runtime-doctor-authority-proof/v1', canonicalizeJson({
        installationDigest: context.installation.installationDigest,
        issuer: signature.issuer,
        keyId: signature.keyId,
        stateProtectionLevel: authority.stateProtectionLevel,
      })),
    }
  } finally { await authority.close() }
}

async function requireVerifiedInstallation(context: RuntimeProbeContext): Promise<void> {
  const inspected = await inspectRuntimeInstallation({ homeDir: context.homeDir })
  if (inspected.installationDigest !== context.installation.installationDigest
    || inspected.versionRoot !== context.installation.versionRoot
    || inspected.entrypoint !== context.installation.entrypoint) {
    throw new Error('E2E_RUNTIME_DOCTOR_INSTALLATION_MISMATCH')
  }
}

async function requirePrivateNode(
  path: string,
  kind: 'file' | 'directory',
  mode: number,
): Promise<void> {
  const stat = await lstat(path)
  const correctKind = kind === 'file' ? stat.isFile() : stat.isDirectory()
  if (!correctKind || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode
    || (kind === 'file' && stat.nlink !== 1)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('E2E_AUTHORITY_STATE_NODE_INSECURE')
  }
}

function authorityFailure(error: unknown): RuntimeDoctorProbe {
  return doctorCapabilityFailure(error, 'E2E_AUTHORITY_NOT_INSTALLED',
    '先运行 install-browser 初始化 Authority；如已初始化则保留现场并修复状态完整性')
}

function doctorCapabilityFailure(
  error: unknown,
  missingCode: string,
  remediation: string,
): RuntimeDoctorProbe {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code
    : error instanceof Error && /^E2E_[A-Z0-9_]+$/.test(error.message) ? error.message : undefined
  const missing = code === 'ENOENT' || code === 'E2E_RUNTIME_NOT_INSTALLED'
  return {
    status: missing ? 'not-installed' : 'blocked',
    reasonCode: missing ? missingCode : code ?? 'E2E_RUNTIME_DOCTOR_CAPABILITY_INVALID',
    remediation,
  }
}

function verifiedInstallationProbe(reasonCode: string): RuntimeProbe {
  return async ({ installation, homeDir }) => {
    try {
      const inspected = await inspectRuntimeInstallation({ homeDir })
      if (inspected.version !== installation.version
        || inspected.protocolMajor !== installation.protocolMajor
        || inspected.versionRoot !== installation.versionRoot
        || inspected.entrypoint !== installation.entrypoint
        || inspected.installationDigest !== installation.installationDigest
        || inspected.sourceRepositoryIndependent !== true) {
        return {
          status: 'blocked',
          reasonCode: 'E2E_RUNTIME_DOCTOR_INSTALLATION_MISMATCH',
          remediation: 'Runtime 实际安装与 doctor 输入不一致；重新发现或重新安装 Runtime',
        }
      }
      return {
        status: 'passed',
        reasonCode,
        proofDigest: inspected.installationDigest,
        remediation: '无需处理',
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' ? error.code : 'E2E_RUNTIME_INSTALLATION_INSPECTION_FAILED'
      return {
        status: 'blocked',
        reasonCode: code,
        remediation: 'Runtime 安装缺失或完整性验证失败；重新安装 Runtime 后再次运行 doctor',
      }
    }
  }
}

function notInstalledProbe(reasonCode: string, remediation: string): RuntimeProbe {
  return async () => ({ status: 'not-installed', reasonCode, remediation })
}

function trustedPythonProbe(reasonCode: string): RuntimeProbe {
  return async () => {
    try {
      const runtime = await discoverTrustedPython()
      return {
        status: 'passed', reasonCode, proofDigest: runtime.proofDigest,
        remediation: '无需处理',
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' ? error.code : 'E2E_RUNTIME_TRUSTED_PYTHON_UNAVAILABLE'
      return {
        status: 'blocked', reasonCode: code,
        remediation: '安装由 root 管理、不可被普通用户修改且支持 dir_fd 的 Python 3.9+',
      }
    }
  }
}

function capabilityProofProbe(kind: 'gateway' | 'isolation'): RuntimeProbe {
  return async (context) => {
    const { homeDir, installation } = context
    try {
      const proof = await inspectRuntimeCapabilityProof({
        homeDir, runtimeInstallationDigest: installation.installationDigest,
      })
      const browser = await inspectConfiguredBrowser(context)
      if (proof.isolation.browserClosureDigest !== browser.browserClosureDigest
        || proof.isolation.browserExecutableDigest !== browser.browserExecutableDigest
        || (browser.controlledLaunchProofDigest !== undefined
          && browser.controlledLaunchProofDigest !== proof.proofDigest)) {
        const mismatch = new Error('E2E_RUNTIME_CAPABILITY_PROOF_BROWSER_MISMATCH') as Error & { code: string }
        mismatch.code = 'E2E_RUNTIME_CAPABILITY_PROOF_BROWSER_MISMATCH'
        throw mismatch
      }
      return {
        status: 'passed',
        reasonCode: kind === 'gateway' ? 'E2E_GATEWAY_CAPABILITY_PROOF_OK' : 'E2E_ISOLATION_CAPABILITY_PROOF_OK',
        proofDigest: proof.proofDigest,
        remediation: '无需处理',
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'E2E_RUNTIME_CAPABILITY_PROOF_INVALID'
      return {
        status: code === 'E2E_RUNTIME_CAPABILITY_PROOF_NOT_INSTALLED' ? 'not-installed' : 'blocked',
        reasonCode: code,
        remediation: code === 'E2E_RUNTIME_CAPABILITY_PROOF_NOT_INSTALLED'
          ? '先完成一次真实 Gateway/固定 Chromium 受控会话以生成 capability proof'
          : 'Capability proof 已损坏或与当前 Runtime 不匹配；保留现场并重新运行真实受控会话',
      }
    }
  }
}

async function inspectConfiguredBrowser(context: RuntimeProbeContext): Promise<{
  source: 'system-chrome' | 'managed-chromium'
  browserClosureDigest: string
  browserExecutableDigest: string
  controlledLaunchProofDigest?: string
}> {
  const selection = await readBrowserSelection(context.homeDir).catch((error) => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (selection !== undefined) {
    if (selection.runtimeInstallationDigest !== context.installation.installationDigest) {
      throw doctorError('E2E_BROWSER_SELECTION_RUNTIME_MISMATCH')
    }
    if (selection.source.kind === 'system-chrome') {
      const inspected = await revalidateSystemChrome({ ...selection,
        source: selection.source }, {
        projectRoot: runtimeLayout(context.homeDir).state,
        ...(context.systemChromeVersionReader === undefined ? {} : {
          readVersion: context.systemChromeVersionReader,
        }),
      })
      return {
        source: 'system-chrome',
        browserClosureDigest: systemChromeClosureDigest(inspected),
        browserExecutableDigest: inspected.selection.executableDigest,
        controlledLaunchProofDigest: inspected.selection.controlledLaunchProofDigest,
      }
    }
  }
  const browser = await inspectChromiumInstallation({
    homeDir: context.homeDir, runtimeVersion: context.installation.version,
    runtimeInstallationDigest: context.installation.installationDigest,
  })
  return {
    source: 'managed-chromium',
    browserClosureDigest: browser.manifest.closureDigest,
    browserExecutableDigest: browser.manifest.executableDigest,
    ...(selection === undefined ? {} : {
      controlledLaunchProofDigest: selection.controlledLaunchProofDigest,
    }),
  }
}

function doctorError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
