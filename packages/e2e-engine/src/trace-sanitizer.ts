import {
  SanitizerPolicySchema,
  CanaryResultSchema,
  canonicalizeJson,
  digestBytes,
  digestText,
  type CanaryResult,
  type SanitizerPolicy,
} from '@mutil-skills/e2e-contracts'
import { sanitizeNetworkEvidence, type SanitizationOutcome } from './network-sanitizer.js'
import { blockSanitization, finalizeSanitizedEvidence } from './sanitizer-core.js'
import { sanitizeDomEvidence } from './structured-sanitizers.js'
import type { PrivacyScanner } from './privacy-scanner.js'

export interface TraceArchiveEntry {
  path: string
  kind: 'network' | 'snapshot' | 'source' | 'metadata'
  bytes: Uint8Array
}

export interface TraceArchiveAdapter {
  readonly version: string
  readonly supportedFormats: readonly string[]
  parse(input: { format: string; archive: Uint8Array }): {
    totalEntries: number
    entries: TraceArchiveEntry[]
    unparsedEntries: string[]
    canaries: CanaryResult[]
  }
}

export function sanitizeTraceEvidence(input: {
  raw: Uint8Array
  policy: SanitizerPolicy
  adapter?: TraceArchiveAdapter
  scanner?: PrivacyScanner
}): SanitizationOutcome {
  const decoded = decodeTrace(input.raw, input.policy)
  if ('reasonCode' in decoded) return block(input, decoded.format, decoded.reasonCode)
  const { format, archive } = decoded
  if (!input.policy.trace.formatVersions.includes(format)) {
    return block(input, format, 'E2E_SANITIZER_FORMAT_INCOMPATIBLE')
  }
  if (!input.adapter) return block(input, format, 'E2E_TRACE_ADAPTER_UNAVAILABLE')
  if (!validTraceAdapter(input.adapter)) return block(input, format, 'E2E_TRACE_ADAPTER_INVALID')
  if (!input.adapter.supportedFormats.includes(format)) {
    return block(input, format, 'E2E_SANITIZER_FORMAT_INCOMPATIBLE')
  }
  let parsed: unknown
  try { parsed = input.adapter.parse({ format, archive }) } catch {
    return block(input, format, 'E2E_TRACE_ADAPTER_ERROR')
  }
  if (!validTraceResult(parsed)) return block(input, format, 'E2E_TRACE_ARCHIVE_INVALID')
  if (parsed.canaries.length < 1 || parsed.canaries.some((canary) => !canary.detected)) {
    return block(input, format, 'E2E_PRIVACY_CANARY_FAILED')
  }
  if (parsed.unparsedEntries.length > 0 || parsed.totalEntries !== parsed.entries.length) {
    return block(input, format, 'E2E_TRACE_ARCHIVE_INCOMPLETE')
  }
  if (!validArchive(parsed, input.policy.maxInputBytes)) {
    return block(input, format, 'E2E_TRACE_ARCHIVE_INVALID')
  }

  const outputEntries: Array<Record<string, unknown>> = []
  for (const entry of parsed.entries) {
    const pathDigest = digestText('trace-entry-path/v1', entry.path)
    if (entry.kind === 'network') {
      const result = sanitizeNetworkEvidence({ raw: entry.bytes, policy: input.policy, scanner: input.scanner })
      if (result.status === 'blocked') return block(input, format, result.reasonCodes[0] ?? 'E2E_TRACE_CHILD_SANITIZATION_FAILED')
      outputEntries.push({ kind: entry.kind, pathDigest, content: JSON.parse(result.bytes.toString('utf8')) })
      continue
    }
    if (entry.kind === 'snapshot') {
      const result = sanitizeDomEvidence({ raw: entry.bytes, policy: input.policy, scanner: input.scanner })
      if (result.status === 'blocked') return block(input, format, result.reasonCodes[0] ?? 'E2E_TRACE_CHILD_SANITIZATION_FAILED')
      outputEntries.push({ kind: entry.kind, pathDigest, content: JSON.parse(result.bytes.toString('utf8')) })
      continue
    }
    outputEntries.push({
      kind: entry.kind,
      pathDigest,
      [`${entry.kind}Digest`]: digestBytes(`trace-${entry.kind}-entry/v1`, entry.bytes),
    })
  }
  const output = Buffer.from(canonicalizeJson({
    format: 'trace-sanitized-json/1', totalEntries: parsed.totalEntries, entries: outputEntries,
  }), 'utf8')
  return finalizeSanitizedEvidence({
    raw: input.raw, output, policy: input.policy, evidenceType: 'trace', inputFormat: format,
    scanner: input.scanner, scanScope: 'trace-sanitized-output',
    forcedReviewReasons: ['E2E_PRIVACY_REVIEW_TRACE'],
    parserVersion: input.adapter.version,
    pipelineCanaries: parsed.canaries,
  })
}

function decodeTrace(raw: Uint8Array, policy: SanitizerPolicy):
  | { format: string; archive: Buffer }
  | { format: string; reasonCode: string } {
  if (!SanitizerPolicySchema.safeParse(policy).success) {
    return { format: 'invalid-policy', reasonCode: 'E2E_SANITIZER_POLICY_INVALID' }
  }
  if (raw.byteLength > policy.maxInputBytes) return { format: 'oversized', reasonCode: 'E2E_SANITIZER_INPUT_TOO_LARGE' }
  let value: unknown
  try { value = JSON.parse(Buffer.from(raw).toString('utf8')) } catch {
    return { format: 'unparseable', reasonCode: 'E2E_SANITIZER_PARSE_FAILED' }
  }
  const format = isObject(value) && typeof value.format === 'string' ? value.format.slice(0, 128) : 'missing-format'
  if (!isObject(value) || !exactKeys(value, ['format', 'archiveBase64'])
    || typeof value.format !== 'string' || typeof value.archiveBase64 !== 'string'
    || !canonicalBase64(value.archiveBase64)) {
    return { format, reasonCode: 'E2E_SANITIZER_PARSE_FAILED' }
  }
  const archive = Buffer.from(value.archiveBase64, 'base64')
  if (archive.byteLength === 0 || archive.byteLength > policy.maxInputBytes) {
    return { format, reasonCode: 'E2E_TRACE_ARCHIVE_INVALID' }
  }
  return { format, archive }
}

function validArchive(parsed: ReturnType<TraceArchiveAdapter['parse']>, maxBytes: number): boolean {
  if (!Number.isSafeInteger(parsed.totalEntries) || parsed.totalEntries < 1 || parsed.totalEntries > 100_000) return false
  if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.unparsedEntries)) return false
  const paths = new Set<string>()
  let totalBytes = 0
  let metadataCount = 0
  for (const entry of parsed.entries) {
    if (!isObject(entry) || typeof entry.path !== 'string' || typeof entry.kind !== 'string'
      || !isSafePath(entry.path) || paths.has(entry.path)
      || !['network', 'snapshot', 'source', 'metadata'].includes(entry.kind)
      || !(entry.bytes instanceof Uint8Array)) return false
    paths.add(entry.path)
    totalBytes += entry.bytes.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) return false
    if (entry.kind === 'metadata') metadataCount += 1
  }
  return metadataCount === 1
}

function isSafePath(path: string): boolean {
  if (path.length < 1 || path.length > 4096 || path.startsWith('/') || path.includes('\\')) return false
  const segments = path.split('/')
  return segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment))
}

function block(
  input: { raw: Uint8Array; policy: SanitizerPolicy; adapter?: TraceArchiveAdapter },
  inputFormat: string,
  reasonCode: string,
): SanitizationOutcome {
  const parserVersion = input.adapter && validTraceAdapter(input.adapter) ? input.adapter.version : undefined
  return blockSanitization({
    raw: input.raw, policy: input.policy, evidenceType: 'trace', inputFormat, reasonCode,
    ...(parserVersion ? { parserVersion } : {}),
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
function canonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function validTraceAdapter(value: unknown): value is TraceArchiveAdapter {
  return isObject(value)
    && typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version)
    && Array.isArray(value.supportedFormats)
    && value.supportedFormats.every((format) => typeof format === 'string')
    && typeof value.parse === 'function'
}

function validTraceResult(value: unknown): value is ReturnType<TraceArchiveAdapter['parse']> {
  return isObject(value)
    && Number.isSafeInteger(value.totalEntries)
    && Array.isArray(value.entries)
    && Array.isArray(value.unparsedEntries)
    && value.unparsedEntries.every((path) => typeof path === 'string')
    && Array.isArray(value.canaries)
    && value.canaries.every((canary) => CanaryResultSchema.safeParse(canary).success)
}
