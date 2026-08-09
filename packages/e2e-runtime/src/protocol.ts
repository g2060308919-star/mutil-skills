import {
  E2EError,
  RuntimeDoctorReportSchema,
  RuntimeRequestEnvelopeSchema,
  canonicalizeJson,
  type E2EErrorCategory,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { z } from 'zod'

export const RUNTIME_PACKAGE_VERSION = '0.7.0'

const runtimeInstallRemediation = `npm exec --yes --package=@mutil-skills/e2e-runtime@${RUNTIME_PACKAGE_VERSION} -- repo-e2e install-runtime --version ${RUNTIME_PACKAGE_VERSION}`

const runtimeIdentity = {
  version: RUNTIME_PACKAGE_VERSION,
  installationDigest: `sha256:${'0'.repeat(64)}`,
} as const

const MIGRATION_REASON_CODES = new Set([
  'E2E_RUNTIME_PROTOCOL_MAJOR_UNSUPPORTED',
  'E2E_RUNTIME_PACKAGE_VERSION_SKEW',
  'E2E_RUNTIME_STATE_MIGRATION_REQUIRED',
  'E2E_RUNTIME_UNDERSTANDING_MIGRATION_REQUIRED',
])

export function parseRuntimeRequest(json: string): RuntimeRequestEnvelope {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (cause) {
    throw invalidRuntimeRequest(cause)
  }

  if (hasUnsupportedProtocolMajor(value)) {
    throw new E2EError({
      code: 'E2E_RUNTIME_PROTOCOL_MAJOR_UNSUPPORTED',
      category: 'validation',
      message: 'Runtime 不支持请求的 protocol major，且不会猜测转换',
      retryable: false,
    })
  }

  const parsed = RuntimeRequestEnvelopeSchema.safeParse(value)
  if (!parsed.success) throw invalidRuntimeRequest(parsed.error)
  return parsed.data
}

export function runtimeErrorResponse(
  requestId: string,
  error: E2EError,
  runtime: RuntimeResponseEnvelope['runtime'] = runtimeIdentity,
): RuntimeResponseEnvelope {
  const category = MIGRATION_REASON_CODES.has(error.code)
    ? 'migration'
    : runtimeCategory(error.category)
  const details = error.code === 'E2E_RUNTIME_NOT_INSTALLED'
    ? { remediation: runtimeInstallRemediation }
    : validationErrorDetails(error)
  return {
    schemaVersion: '1.0.0',
    requestId,
    runtime,
    ok: false,
    error: {
      code: error.code,
      category,
      terminalState: terminalStateForCategory(category),
      message: error.message,
      retryable: error.retryable,
      ...(details === undefined ? {} : { details }),
    },
  }
}

function validationErrorDetails(error: E2EError): Record<string, unknown> | undefined {
  if (error.code !== 'E2E_RUNTIME_REQUEST_INVALID' || !(error.cause instanceof z.ZodError)) {
    return undefined
  }
  return {
    validationIssues: error.cause.issues.slice(0, 20).map((issue) => ({
      path: issue.path.length === 0 ? '$' : issue.path.join('.'),
      code: issue.code,
      constraint: issue.message.slice(0, 1_024),
    })),
    remediation: '按 validationIssues 的字段路径修正输入；删除未声明字段，并使用对应命令的严格 schema 示例后重试。',
  }
}

export function exitCodeForResponse(response: RuntimeResponseEnvelope): number {
  if (response.ok) return 0
  switch (response.error?.category) {
    case 'input': return 2
    case 'environment':
    case 'automation': return 3
    case 'safety': return 4
    case 'artifact':
    case 'migration': return 5
    case 'internal':
    default: return 70
  }
}

export function serializeRuntimeDoctorReport(report: unknown): string {
  const parsed = RuntimeDoctorReportSchema.safeParse(report)
  if (!parsed.success) {
    throw new E2EError({
      code: 'E2E_RUNTIME_DOCTOR_REPORT_INVALID',
      category: 'internal',
      message: 'Runtime Doctor 报告不符合固定协议',
      retryable: false,
      cause: parsed.error,
    })
  }
  return canonicalizeJson(parsed.data)
}

function invalidRuntimeRequest(cause: unknown): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_REQUEST_INVALID',
    category: 'input',
    message: 'Runtime 请求必须是符合协议 1.0.0 的严格 JSON envelope',
    retryable: false,
    cause,
  })
}

function hasUnsupportedProtocolMajor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const schemaVersion = (value as Record<string, unknown>).schemaVersion
  if (typeof schemaVersion !== 'string') return false
  const match = /^(\d+)\.\d+\.\d+$/.exec(schemaVersion)
  return match !== null && Number(match[1]) !== 1
}

function runtimeCategory(category: E2EErrorCategory): NonNullable<RuntimeResponseEnvelope['error']>['category'] {
  switch (category) {
    case 'input':
    case 'validation':
    case 'source':
    case 'decision': return 'input'
    case 'environment': return 'environment'
    case 'safety': return 'safety'
    case 'automation':
    case 'business':
    case 'evidence': return 'automation'
    case 'artifact': return 'artifact'
    case 'internal': return 'internal'
  }
}

function terminalStateForCategory(
  category: NonNullable<RuntimeResponseEnvelope['error']>['category'],
): NonNullable<RuntimeResponseEnvelope['error']>['terminalState'] {
  switch (category) {
    case 'input': return 'input-blocked'
    case 'environment':
    case 'internal': return 'environment-blocked'
    case 'safety': return 'safety-blocked'
    case 'automation': return 'automation-blocked'
    case 'artifact': return 'artifact-blocked'
    case 'migration': return 'migration-required'
  }
}
