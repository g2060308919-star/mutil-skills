import {
  canonicalizeJson,
  digestBytes,
  PrivacyScanFindingSchema,
  CanaryResultSchema,
  type EvidenceType,
  type DataClassification,
  type CanaryResult,
  type InspectionScope,
  type PrivacyScanFinding,
  type PrivacyScanResult,
  type SanitizationRecord,
  type SanitizerPolicy,
} from '@mutil-skills/e2e-contracts'
import { PatternPrivacyScanner, PRIVACY_CANARIES, type PrivacyScanner } from './privacy-scanner.js'
import type { SanitizationOutcome } from './network-sanitizer.js'

export function finalizeSanitizedEvidence(input: {
  raw: Uint8Array
  output: Uint8Array
  policy: SanitizerPolicy
  evidenceType: EvidenceType
  inputFormat: string
  scanner?: PrivacyScanner
  scanScope: string
  scanBytes?: Uint8Array
  inspectionScope?: InspectionScope
  forcedReviewReasons?: string[]
  declaredClassifications?: DataClassification[]
  parserVersion?: string
  pipelineCanaries?: CanaryResult[]
}): SanitizationOutcome {
  const scanner = input.scanner ?? new PatternPrivacyScanner(input.policy.scannerVersion)
  if (scanner.version !== input.policy.scannerVersion) {
    return blockWithScanError(input, scanner.version, 'E2E_PRIVACY_SCANNER_VERSION_MISMATCH')
  }
  let canaries
  try {
    canaries = [
      ...PRIVACY_CANARIES.map((canary) => ({
      canaryId: canary.id,
      expectedClassification: canary.classification,
      detected: scanner.scan({ bytes: Buffer.from(canary.sample), scope: canary.id })
        .some((finding) => finding.classification === canary.classification),
      })),
      ...(input.pipelineCanaries ?? []),
    ]
  } catch {
    return blockWithScanError(input, scanner.version, 'E2E_PRIVACY_SCANNER_ERROR')
  }
  const canaryIds = new Set(canaries.map((canary) => canary.canaryId))
  if (canaryIds.size !== canaries.length
    || canaries.some((canary) => !CanaryResultSchema.safeParse(canary).success || !canary.detected)) {
    const scanResult: PrivacyScanResult = {
      status: 'error', scannerVersion: scanner.version, scope: 'canary-suite',
      reasonCode: 'E2E_PRIVACY_CANARY_FAILED', canaries,
    }
    return {
      status: 'blocked', reasonCodes: ['E2E_PRIVACY_CANARY_FAILED'],
      record: makeRecord({ ...input, scanResult, findings: [] }),
    }
  }
  let findings: PrivacyScanFinding[]
  try {
    findings = scanner.scan({ bytes: input.scanBytes ?? input.output, scope: input.scanScope })
  } catch {
    return blockWithScanError(input, scanner.version, 'E2E_PRIVACY_SCANNER_ERROR', canaries)
  }
  if (!Array.isArray(findings) || findings.some((finding) => !PrivacyScanFindingSchema.safeParse(finding).success)) {
    return blockWithScanError(input, scanner.version, 'E2E_PRIVACY_SCANNER_OUTPUT_INVALID', canaries)
  }
  const scanResult: PrivacyScanResult = findings.length === 0
    ? { status: 'clean', scannerVersion: scanner.version, scope: input.scanScope, findings: [], canaries }
    : { status: 'findings', scannerVersion: scanner.version, scope: input.scanScope, findings, canaries }
  const record = makeRecord({ ...input, scanResult, findings })
  const highClassifications = new Set<DataClassification>(['credential', 'government-id', 'financial', 'health'])
  if (
    findings.some((finding) => highClassifications.has(finding.classification))
    || (input.declaredClassifications ?? []).some((classification) => highClassifications.has(classification))
  ) {
    return { status: 'blocked', reasonCodes: ['E2E_PRIVACY_HIGH_SENSITIVITY_FOUND'], record }
  }
  if (record.manualReview.required) {
    return { status: 'review-required', bytes: Buffer.from(input.output), record }
  }
  return { status: 'publishable', bytes: Buffer.from(input.output), record }
}

export function blockSanitization(input: {
  raw: Uint8Array
  policy: SanitizerPolicy
  evidenceType: EvidenceType
  inputFormat: string
  reasonCode: string
  inspectionScope?: InspectionScope
  parserVersion?: string
}): SanitizationOutcome {
  const output = Buffer.alloc(0)
  const scanResult: PrivacyScanResult = {
    status: 'error', scannerVersion: safeSemver(input.policy.scannerVersion), scope: 'not-scanned',
    reasonCode: input.reasonCode, canaries: [],
  }
  return {
    status: 'blocked', reasonCodes: [input.reasonCode],
    record: makeRecord({
      ...input, output, scanResult, findings: [],
      compatibilityStatus: compatibilityForBlock(input.inputFormat, input.reasonCode),
      compatibilityReason: input.reasonCode,
    }),
  }
}

function blockWithScanError(
  input: Parameters<typeof finalizeSanitizedEvidence>[0],
  scannerVersion: string,
  reasonCode: string,
  canaries: PrivacyScanResult['canaries'] = [],
): SanitizationOutcome {
  const scanResult: PrivacyScanResult = {
    status: 'error', scannerVersion: safeSemver(scannerVersion), scope: input.scanScope, reasonCode, canaries,
  }
  return {
    status: 'blocked', reasonCodes: [reasonCode],
    record: makeRecord({ ...input, scanResult, findings: [] }),
  }
}

function makeRecord(input: {
  raw: Uint8Array
  output: Uint8Array
  policy: SanitizerPolicy
  evidenceType: EvidenceType
  inputFormat: string
  scanResult: PrivacyScanResult
  findings: PrivacyScanFinding[]
  inspectionScope?: InspectionScope
  forcedReviewReasons?: string[]
  declaredClassifications?: DataClassification[]
  parserVersion?: string
  compatibilityStatus?: 'compatible' | 'incompatible' | 'not-evaluated'
  compatibilityReason?: string
}): SanitizationRecord {
  const reviewClasses = new Set(input.policy.requireManualReviewFor)
  const reasons = [...new Set([
    ...(input.forcedReviewReasons ?? []),
    ...(input.declaredClassifications ?? [])
      .filter((classification) => reviewClasses.has(classification)
        || classification === 'contact' || classification === 'customer-content')
      .map((classification) => `E2E_PRIVACY_REVIEW_${classification.toUpperCase().replace('-', '_')}`),
    ...input.findings.filter((finding) => reviewClasses.has(finding.classification)).map((finding) =>
      `E2E_PRIVACY_REVIEW_${finding.classification.toUpperCase().replace('-', '_')}`),
  ])]
  return {
    schemaVersion: '1.0.0', evidenceType: input.evidenceType,
    sanitizerVersion: safeSemver(input.policy.sanitizerVersion),
    formatCompatibility: input.compatibilityStatus === 'incompatible'
      ? { status: 'incompatible', inputFormat: safeFormat(input.inputFormat), reasonCode: input.compatibilityReason! }
      : input.compatibilityStatus === 'not-evaluated'
        ? { status: 'not-evaluated', inputFormat: safeFormat(input.inputFormat), reasonCode: input.compatibilityReason! }
        : { status: 'compatible', inputFormat: safeFormat(input.inputFormat), parserVersion: safeSemver(input.parserVersion ?? '1.0.0') },
    policyDigest: digestBytes('sanitizer-policy/v1', safeCanonicalPolicy(input.policy)),
    inputDigest: digestBytes('sanitizer-input/v1', input.raw),
    outputDigest: digestBytes('sanitizer-output/v1', input.output),
    scanResult: input.scanResult,
    inspectionScope: input.inspectionScope ?? {
      ocr: { performed: false, regions: [] },
      frames: { strategy: 'not-applicable', inspectedFrames: [] },
    },
    manualReview: reasons.length > 0
      ? { required: true, status: 'pending', reasonCodes: reasons }
      : { required: false, status: 'not-required', reasonCodes: [] },
  }
}

function safeSemver(value: string): string {
  return /^\d+\.\d+\.\d+$/.test(value) ? value : '0.0.0'
}

function safeFormat(value: string): string {
  const candidate = value.slice(0, 128)
  return candidate.length > 0 ? candidate : 'unknown-format'
}

function safeCanonicalPolicy(policy: SanitizerPolicy): Buffer {
  try {
    return Buffer.from(canonicalizeJson(policy))
  } catch {
    return Buffer.from('[invalid-policy]', 'utf8')
  }
}

function compatibilityForBlock(
  inputFormat: string,
  reasonCode: string,
): 'compatible' | 'incompatible' | 'not-evaluated' {
  if (reasonCode === 'E2E_SANITIZER_FORMAT_INCOMPATIBLE') return 'incompatible'
  if (['invalid-policy', 'oversized', 'unparseable', 'missing-format'].includes(inputFormat)) return 'not-evaluated'
  return 'compatible'
}
