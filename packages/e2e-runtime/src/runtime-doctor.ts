import {
  RuntimeDoctorProbeSchema,
  RuntimeDoctorReportSchema,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeInstallation } from './runtime-discovery.js'

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
}

export type RuntimeProbe = (context: RuntimeProbeContext) => Promise<RuntimeDoctorProbe>

export interface RunRuntimeDoctorOptions {
  installation: RuntimeInstallation
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
  const context: RuntimeProbeContext = { installation: options.installation }
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

const DEFAULT_RUNTIME_PROBES: Record<RuntimeDoctorProbeName, RuntimeProbe> = {
  installation: verifiedInstallationProbe('E2E_RUNTIME_INSTALLATION_OK'),
  'version-closure': verifiedInstallationProbe('E2E_RUNTIME_VERSION_CLOSURE_OK'),
  'source-independence': verifiedInstallationProbe('E2E_RUNTIME_SOURCE_INDEPENDENCE_OK'),
  authority: notInstalledProbe('E2E_AUTHORITY_NOT_INSTALLED', '安装并初始化 Authority Runtime'),
  'approval-presence': notInstalledProbe(
    'E2E_APPROVAL_PRESENCE_NOT_INSTALLED',
    '初始化需要用户在场的审批能力',
  ),
  gateway: notInstalledProbe('E2E_GATEWAY_NOT_INSTALLED', '安装 Gateway Runtime'),
  chromium: notInstalledProbe('E2E_CHROMIUM_NOT_INSTALLED', '使用 repo-e2e install-browser 安装固定 Chromium'),
  isolation: notInstalledProbe('E2E_RUNTIME_ISOLATION_NOT_INSTALLED', '安装 Runtime 隔离后端'),
  'artifact-fs': notInstalledProbe('E2E_ARTIFACT_FS_NOT_INSTALLED', '安装 Artifact FS helper'),
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
