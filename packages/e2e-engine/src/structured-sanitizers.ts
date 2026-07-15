import {
  SanitizerPolicySchema,
  canonicalizeJson,
  type ClassifiedField,
  type DataClassification,
  type SanitizerPolicy,
} from '@mutil-skills/e2e-contracts'
import { blockSanitization, finalizeSanitizedEvidence } from './sanitizer-core.js'
import type { SanitizationOutcome } from './network-sanitizer.js'
import type { PrivacyScanner } from './privacy-scanner.js'

type JsonPrimitive = string | number | boolean | null

interface RawDomNode {
  tag: string
  attributes?: Record<string, string>
  text?: string
  assertionRelevant?: boolean
  inputValue?: string
  hidden?: boolean
  privacy?: 'none' | 'pii' | 'secret'
  children?: RawDomNode[]
}

interface SanitizedDomNode {
  tag: string
  attributes: Record<string, string>
  text?: string
  children: SanitizedDomNode[]
}

export function sanitizeDomEvidence(input: {
  raw: Uint8Array
  policy: SanitizerPolicy
  scanner?: PrivacyScanner
}): SanitizationOutcome {
  const policyResult = SanitizerPolicySchema.safeParse(input.policy)
  if (!policyResult.success) return block(input, 'dom', 'invalid-policy', 'E2E_SANITIZER_POLICY_INVALID')
  const normalized = { ...input, policy: policyResult.data }
  const prepared = prepare(normalized.raw, normalized.policy, 'dom', normalized.policy.dom.formatVersions)
  if ('blocked' in prepared) return prepared.blocked
  const decoded = prepared.decoded
  if (!isPlainObject(decoded) || !hasExactKeys(decoded, ['format', 'roots']) || !Array.isArray(decoded.roots)) {
    return block(input, 'dom', prepared.format, 'E2E_SANITIZER_PARSE_FAILED')
  }
  try {
    const classifications = new Set<DataClassification>()
    const roots = sanitizeDomForest(decoded.roots, normalized.policy, classifications)
    const output = Buffer.from(canonicalizeJson({ format: 'dom-sanitized-tree/1', roots }), 'utf8')
    return finalizeSanitizedEvidence({
      ...normalized, output, evidenceType: 'dom', inputFormat: prepared.format, scanScope: 'dom-sanitized-output',
      declaredClassifications: [...classifications],
    })
  } catch {
    return block(input, 'dom', prepared.format, 'E2E_DOM_STRUCTURE_UNSUPPORTED')
  }
}

export function sanitizeConsoleEvidence(input: {
  raw: Uint8Array
  policy: SanitizerPolicy
  scanner?: PrivacyScanner
}): SanitizationOutcome {
  const policyResult = SanitizerPolicySchema.safeParse(input.policy)
  if (!policyResult.success) return block(input, 'console', 'invalid-policy', 'E2E_SANITIZER_POLICY_INVALID')
  const normalized = { ...input, policy: policyResult.data }
  const prepared = prepare(normalized.raw, normalized.policy, 'console', normalized.policy.console.formatVersions)
  if ('blocked' in prepared) return prepared.blocked
  const decoded = prepared.decoded
  if (!isPlainObject(decoded) || !hasExactKeys(decoded, ['format', 'entries']) || !Array.isArray(decoded.entries)) {
    return block(input, 'console', prepared.format, 'E2E_SANITIZER_PARSE_FAILED')
  }
  try {
    if (decoded.entries.length > 10_000) throw new Error('too many console entries')
    const classifications = new Set<DataClassification>()
    const entries = decoded.entries.map((candidate) => sanitizeConsoleEntry(candidate, normalized.policy, classifications))
    const output = Buffer.from(canonicalizeJson({ format: 'console-sanitized-json/1', entries }), 'utf8')
    return finalizeSanitizedEvidence({
      ...normalized, output, evidenceType: 'console', inputFormat: prepared.format, scanScope: 'console-sanitized-output',
      declaredClassifications: [...classifications],
    })
  } catch {
    return block(input, 'console', prepared.format, 'E2E_CONSOLE_ARGUMENT_UNSUPPORTED')
  }
}

function prepare(
  raw: Uint8Array,
  policy: SanitizerPolicy,
  evidenceType: 'dom' | 'console',
  formats: string[],
): { decoded: unknown; format: string } | { blocked: SanitizationOutcome } {
  if (!SanitizerPolicySchema.safeParse(policy).success) {
    return { blocked: block({ raw, policy }, evidenceType, 'invalid-policy', 'E2E_SANITIZER_POLICY_INVALID') }
  }
  if (raw.byteLength > policy.maxInputBytes) {
    return { blocked: block({ raw, policy }, evidenceType, 'oversized', 'E2E_SANITIZER_INPUT_TOO_LARGE') }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch {
    return { blocked: block({ raw, policy }, evidenceType, 'unparseable', 'E2E_SANITIZER_PARSE_FAILED') }
  }
  const format = isPlainObject(decoded) && typeof decoded.format === 'string'
    ? decoded.format.slice(0, 128) || 'missing-format'
    : 'missing-format'
  if (!formats.includes(format)) {
    return { blocked: block({ raw, policy }, evidenceType, format, 'E2E_SANITIZER_FORMAT_INCOMPATIBLE') }
  }
  return { decoded, format }
}

function sanitizeDomForest(
  values: unknown[],
  policy: SanitizerPolicy,
  classifications: Set<DataClassification>,
): SanitizedDomNode[] {
  if (values.length > 10_000) throw new Error('too many roots')
  let count = 0
  const visit = (candidate: unknown, depth: number): SanitizedDomNode | undefined => {
    count += 1
    if (count > 10_000 || depth > 64 || !isPlainObject(candidate)) throw new Error('invalid DOM bounds')
    if (!hasOnlyKeys(candidate, [
      'tag', 'attributes', 'text', 'assertionRelevant', 'inputValue', 'hidden', 'privacy', 'children',
    ])) throw new Error('unknown DOM field')
    if (typeof candidate.tag !== 'string' || candidate.tag.length > 64) throw new Error('invalid tag')
    if (candidate.hidden === true || candidate.privacy === 'pii' || candidate.privacy === 'secret') return undefined
    if (candidate.hidden !== undefined && typeof candidate.hidden !== 'boolean') throw new Error('invalid hidden')
    if (candidate.privacy !== undefined && !['none', 'pii', 'secret'].includes(String(candidate.privacy))) throw new Error('invalid privacy')
    if (candidate.inputValue !== undefined && typeof candidate.inputValue !== 'string') throw new Error('invalid input value')
    if (candidate.assertionRelevant !== undefined && typeof candidate.assertionRelevant !== 'boolean') throw new Error('invalid assertion marker')
    if (candidate.text !== undefined && typeof candidate.text !== 'string') throw new Error('invalid text')
    if (!policy.dom.allowedTags.includes(candidate.tag)) return undefined
    const attributes = sanitizeAttributes(candidate.attributes, policy.dom.allowedAttributes, classifications)
    const rawChildren = candidate.children ?? []
    if (!Array.isArray(rawChildren)) throw new Error('invalid children')
    const children = rawChildren.map((child) => visit(child, depth + 1)).filter(isDefined)
    const includeText = candidate.assertionRelevant === true && candidate.text !== undefined
    if (includeText) classifications.add(policy.dom.assertionTextClassification)
    return {
      tag: candidate.tag,
      attributes,
      ...(includeText ? { text: candidate.text as string } : {}),
      children,
    }
  }
  return values.map((value) => visit(value, 0)).filter(isDefined)
}

function sanitizeAttributes(
  value: unknown,
  allowlist: ClassifiedField[],
  classifications: Set<DataClassification>,
): Record<string, string> {
  if (value === undefined) return {}
  if (!isPlainObject(value) || Object.keys(value).length > 256) throw new Error('invalid attributes')
  const output: Record<string, string> = {}
  for (const field of allowlist) {
    const candidate = value[field.name]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string' || candidate.length > 16 * 1024) throw new Error('invalid attribute')
    output[field.name] = candidate
    classifications.add(field.classification)
  }
  return output
}

function sanitizeConsoleEntry(
  candidate: unknown,
  policy: SanitizerPolicy,
  classifications: Set<DataClassification>,
) {
  if (!isPlainObject(candidate) || !hasExactKeys(candidate, ['level', 'args'])) throw new Error('invalid entry')
  if (!['debug', 'log', 'info', 'warn', 'error'].includes(String(candidate.level)) || !Array.isArray(candidate.args)) {
    throw new Error('invalid entry values')
  }
  if (candidate.args.length > 256) throw new Error('too many arguments')
  return {
    level: candidate.level as string,
    args: candidate.args.map((argument) => sanitizeConsoleArgument(
      argument, policy.console.allowedObjectFields, policy.console.primitiveArgumentClassification, classifications,
    )),
  }
}

function sanitizeConsoleArgument(
  value: unknown,
  allowlist: ClassifiedField[],
  primitiveClassification: DataClassification,
  classifications: Set<DataClassification>,
): JsonPrimitive | Record<string, JsonPrimitive> {
  if (isPrimitive(value)) {
    classifications.add(primitiveClassification)
    return value
  }
  if (!isPlainObject(value)) throw new Error('unsupported console argument')
  const output: Record<string, JsonPrimitive> = {}
  for (const field of allowlist) {
    if (!Object.hasOwn(value, field.name)) continue
    const candidate = value[field.name]
    if (!isPrimitive(candidate)) throw new Error('nested console object')
    output[field.name] = candidate
    classifications.add(field.classification)
  }
  return output
}

function block(
  input: { raw: Uint8Array; policy: SanitizerPolicy },
  evidenceType: 'dom' | 'console',
  inputFormat: string,
  reasonCode: string,
): SanitizationOutcome {
  return blockSanitization({ ...input, evidenceType, inputFormat, reasonCode })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return hasOnlyKeys(value, keys) && keys.every((key) => Object.hasOwn(value, key))
}

function isPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
