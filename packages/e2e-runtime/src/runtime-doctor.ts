import {
  RuntimeDoctorProbeSchema,
  RuntimeDoctorReportSchema,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeInstallation } from './runtime-discovery.js'
import { discoverTrustedPython } from './trusted-python.js'
import { inspectChromiumInstallation } from './browser-installer.js'
import { inspectRuntimeCapabilityProof } from './runtime-capability-proof.js'

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
}

export type RuntimeProbe = (context: RuntimeProbeContext) => Promise<RuntimeDoctorProbe>

export interface RunRuntimeDoctorOptions {
  installation: RuntimeInstallation
  homeDir: string
  probes?: Partial<Record<RuntimeDoctorProbeName, RuntimeProbe>>
}

export interface AggregateDoctorReportInput {
  runtimeVersion: string
  installationDigest: string
  probes: Record<string, RuntimeDoctorProbe>
}

export function aggregateDoctorReport(input: AggregateDoctorReportInput): RuntimeDoctorReport {
  return RuntimeDoctorReportSchema.parse({
    ready: RUNTIME_DOCTOR_PROBE_NAMES.every((name) => input.probes[name]?.status === 'passed'),
    runtimeVersion: input.runtimeVersion,
    installationDigest: input.installationDigest,
    probes: input.probes,
  })
}

export async function runRuntimeDoctor(options: RunRuntimeDoctorOptions): Promise<RuntimeDoctorReport> {
  const context: RuntimeProbeContext = { installation: options.installation, homeDir: options.homeDir }
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
    probes,
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
    probes,
  })
}

const DEFAULT_RUNTIME_PROBES: Record<RuntimeDoctorProbeName, RuntimeProbe> = {
  installation: verifiedInstallationProbe('E2E_RUNTIME_INSTALLATION_OK'),
  'version-closure': verifiedInstallationProbe('E2E_RUNTIME_VERSION_CLOSURE_OK'),
  'source-independence': verifiedInstallationProbe('E2E_RUNTIME_SOURCE_INDEPENDENCE_OK'),
  authority: trustedPythonProbe('E2E_AUTHORITY_TRUSTED_PYTHON_OK'),
  'approval-presence': notInstalledProbe(
    'E2E_APPROVAL_PRESENCE_NOT_INSTALLED',
    '初始化需要用户在场的审批能力',
  ),
  gateway: capabilityProofProbe('gateway'),
  chromium: async ({ homeDir, installation }) => {
    try {
      const browser = await inspectChromiumInstallation({
        homeDir, runtimeVersion: installation.version,
        runtimeInstallationDigest: installation.installationDigest,
      })
      return {
        status: 'passed', reasonCode: 'E2E_CHROMIUM_INSTALLATION_OK',
        proofDigest: browser.manifest.closureDigest, remediation: '无需处理',
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'E2E_CHROMIUM_INSPECTION_FAILED'
      return {
        status: code === 'E2E_CHROMIUM_NOT_INSTALLED' ? 'not-installed' : 'blocked', reasonCode: code,
        remediation: code === 'E2E_CHROMIUM_NOT_INSTALLED'
          ? '使用 repo-e2e install-browser 安装固定 Chromium'
          : 'Chromium 安装完整性验证失败；保留现场并重新安装 Runtime 与固定 Chromium',
      }
    }
  },
  isolation: capabilityProofProbe('isolation'),
  'artifact-fs': trustedPythonProbe('E2E_ARTIFACT_FS_TRUSTED_PYTHON_OK'),
  quarantine: notInstalledProbe('E2E_QUARANTINE_NOT_INSTALLED', '初始化加密 quarantine 存储'),
  report: notInstalledProbe('E2E_REPORT_NOT_INSTALLED', '安装 Report Runtime'),
}

function verifiedInstallationProbe(reasonCode: string): RuntimeProbe {
  return async ({ installation }) => ({
    status: 'passed',
    reasonCode,
    proofDigest: installation.installationDigest,
    remediation: '无需处理',
  })
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
  return async ({ homeDir, installation }) => {
    try {
      const proof = await inspectRuntimeCapabilityProof({
        homeDir, runtimeInstallationDigest: installation.installationDigest,
      })
      const browser = await inspectChromiumInstallation({
        homeDir, runtimeVersion: installation.version,
        runtimeInstallationDigest: installation.installationDigest,
      })
      if (proof.isolation.browserClosureDigest !== browser.manifest.closureDigest
        || proof.isolation.browserExecutableDigest !== browser.manifest.executableDigest) {
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
