import {
  RawNetworkEvidenceSchema,
  SanitizerPolicySchema,
  canonicalizeJson,
  digestBytes,
  type ClassifiedField,
  type DataClassification,
  type SanitizationRecord,
  type SanitizerPolicy,
} from '@mutil-skills/e2e-contracts'
import { blockSanitization, finalizeSanitizedEvidence } from './sanitizer-core.js'
import type { PrivacyScanner } from './privacy-scanner.js'

export type SanitizationOutcome =
  | { status: 'publishable'; bytes: Buffer; record: SanitizationRecord }
  | { status: 'review-required'; bytes: Buffer; record: SanitizationRecord }
  | { status: 'blocked'; reasonCodes: string[]; record: SanitizationRecord }

const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token',
])

export function sanitizeNetworkEvidence(input: {
  raw: Uint8Array
  policy: SanitizerPolicy
  scanner?: PrivacyScanner
}): SanitizationOutcome {
  const policyResult = SanitizerPolicySchema.safeParse(input.policy)
  if (!policyResult.success) return block(input, 'invalid-policy', 'E2E_SANITIZER_POLICY_INVALID')
  const policy = policyResult.data
  if (input.raw.byteLength > policy.maxInputBytes) return block({ ...input, policy }, 'oversized', 'E2E_SANITIZER_INPUT_TOO_LARGE')

  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(input.raw).toString('utf8')) } catch {
    return block({ ...input, policy }, 'unparseable', 'E2E_SANITIZER_PARSE_FAILED')
  }
  const declaredFormat = readDeclaredFormat(decoded)
  if (!policy.network.formatVersions.includes(declaredFormat)) {
    return block({ ...input, policy }, declaredFormat, 'E2E_SANITIZER_FORMAT_INCOMPATIBLE')
  }
  const parsed = RawNetworkEvidenceSchema.safeParse(decoded)
  if (!parsed.success) return block({ ...input, policy }, declaredFormat, 'E2E_SANITIZER_PARSE_FAILED')

  let url: URL
  try { url = new URL(parsed.data.request.url) } catch {
    return block({ ...input, policy }, declaredFormat, 'E2E_SANITIZER_URL_INVALID')
  }
  if (url.username || url.password || !policy.network.approvedPaths.includes(url.pathname)) {
    return block({ ...input, policy }, declaredFormat, 'E2E_SANITIZER_URL_NOT_APPROVED')
  }

  try {
    const classifications = new Set<DataClassification>()
    const requestBody = filterObject(parsed.data.request.body, policy.network.requestBodyFields, classifications)
    const requestHeaders = filterHeaders(parsed.data.request.headers, policy.network.requestHeaderFields, classifications)
    const responseBody = filterObject(parsed.data.response.body, policy.network.responseBodyFields, classifications)
    const responseHeaders = filterHeaders(parsed.data.response.headers, policy.network.responseHeaderFields, classifications)
    const output = Buffer.from(canonicalizeJson({
      format: 'network-sanitized-json/1',
      request: {
        body: requestBody,
        headers: requestHeaders,
        method: parsed.data.request.method,
        url: { path: url.pathname, queryDigests: digestApprovedQuery(url.searchParams, policy.network.queryFields) },
      },
      response: { body: responseBody, headers: responseHeaders, status: parsed.data.response.status },
    }), 'utf8')
    return finalizeSanitizedEvidence({
      raw: input.raw, output, policy, evidenceType: 'network', inputFormat: declaredFormat,
      scanner: input.scanner, scanScope: 'network-sanitized-output',
      declaredClassifications: [...classifications],
    })
  } catch {
    return block({ ...input, policy }, declaredFormat, 'E2E_SANITIZER_FIELD_VALUE_UNSUPPORTED')
  }
}

function filterHeaders(
  headers: Record<string, string>,
  allowlist: ClassifiedField[],
  classifications: Set<DataClassification>,
): Record<string, string> {
  const allowed = new Map(allowlist.map((field) => [field.name.toLowerCase(), field.classification]))
  const output: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    const classification = allowed.get(name)
    if (classification === undefined || SENSITIVE_HEADERS.has(name)) continue
    if (Object.hasOwn(output, name)) throw new Error('duplicate normalized header')
    output[name] = value
    classifications.add(classification)
  }
  return output
}

function filterObject(
  value: Record<string, unknown> | undefined,
  allowlist: ClassifiedField[],
  classifications: Set<DataClassification>,
): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {}
  if (!value) return output
  for (const field of allowlist) {
    if (!Object.hasOwn(value, field.name)) continue
    const candidate = value[field.name]
    if (!isJsonPrimitive(candidate)) throw new Error('nested or non-finite field value')
    output[field.name] = candidate
    classifications.add(field.classification)
  }
  return output
}

function digestApprovedQuery(search: URLSearchParams, allowlist: string[]): Record<string, string> {
  const output: Record<string, string> = {}
  for (const field of allowlist) {
    const values = search.getAll(field)
    if (values.length === 0) continue
    const bytes = values.length === 1
      ? Buffer.from(values[0]!, 'utf8')
      : Buffer.from(canonicalizeJson(values), 'utf8')
    output[field] = digestBytes('network-query-value/v1', bytes)
  }
  return output
}

function block(
  input: { raw: Uint8Array; policy: SanitizerPolicy },
  inputFormat: string,
  reasonCode: string,
): SanitizationOutcome {
  return blockSanitization({ ...input, evidenceType: 'network', inputFormat, reasonCode })
}

function readDeclaredFormat(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('format' in value) || typeof value.format !== 'string') {
    return 'missing-format'
  }
  return value.format.slice(0, 128) || 'missing-format'
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}
