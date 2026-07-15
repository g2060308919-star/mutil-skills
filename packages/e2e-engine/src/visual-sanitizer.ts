import {
  SanitizerPolicySchema,
  CanaryResultSchema,
  type CanaryResult,
  type InspectionScope,
  type SanitizerPolicy,
} from '@mutil-skills/e2e-contracts'
import { blockSanitization, finalizeSanitizedEvidence } from './sanitizer-core.js'
import type { SanitizationOutcome } from './network-sanitizer.js'
import type { PrivacyScanner } from './privacy-scanner.js'

export interface VisualMaskRegion {
  maskId: string
  target: 'element' | 'coordinates'
  x: number
  y: number
  width: number
  height: number
  stableTargetDigest?: string
}

export interface VisualSanitizerAdapter {
  readonly version: string
  readonly supportedFormats: readonly string[]
  sanitize(input: {
    evidenceType: 'screenshot' | 'video'
    format: string
    media: Uint8Array
    width: number
    height: number
    masks: VisualMaskRegion[]
  }): {
    bytes: Uint8Array
    maskVerification: { verified: boolean; failedMaskIds: string[] }
    ocr: { performed: boolean; engineVersion?: string; text: string; regions: string[] }
    frames: InspectionScope['frames']
    canaries: CanaryResult[]
  }
}

export function sanitizeVisualEvidence(input: {
  raw: Uint8Array
  evidenceType: 'screenshot' | 'video'
  policy: SanitizerPolicy
  adapter?: VisualSanitizerAdapter
  scanner?: PrivacyScanner
}): SanitizationOutcome {
  const policyResult = SanitizerPolicySchema.safeParse(input.policy)
  if (!policyResult.success) return block(input, 'invalid-policy', 'E2E_SANITIZER_POLICY_INVALID')
  const policy = policyResult.data
  const formats = input.evidenceType === 'screenshot'
    ? policy.screenshot.formatVersions
    : policy.video.formatVersions
  const decodedResult = decodeEnvelope(input.raw, policy, formats)
  if ('reasonCode' in decodedResult) return block(input, decodedResult.format, decodedResult.reasonCode)
  const { envelope } = decodedResult
  if (!formats.includes(envelope.format)) return block(input, envelope.format, 'E2E_SANITIZER_FORMAT_INCOMPATIBLE')
  if (!input.adapter) return block(input, envelope.format, 'E2E_VISUAL_ADAPTER_UNAVAILABLE')
  if (!validVisualAdapter(input.adapter)) return block(input, envelope.format, 'E2E_VISUAL_ADAPTER_INVALID')
  if (!input.adapter.supportedFormats.includes(envelope.format)) {
    return block(input, envelope.format, 'E2E_SANITIZER_FORMAT_INCOMPATIBLE')
  }
  let result: ReturnType<VisualSanitizerAdapter['sanitize']>
  try {
    result = input.adapter.sanitize({
      evidenceType: input.evidenceType, format: envelope.format, media: envelope.media,
      width: envelope.width, height: envelope.height, masks: envelope.masks,
    })
  } catch {
    return block(input, envelope.format, 'E2E_VISUAL_ADAPTER_ERROR')
  }
  if (!validVisualResult(result)) return block(input, envelope.format, 'E2E_VISUAL_ADAPTER_OUTPUT_INVALID')
  if (result.canaries.length < 1 || result.canaries.some((canary) => !canary.detected)) {
    return block(input, envelope.format, 'E2E_PRIVACY_CANARY_FAILED')
  }
  if (!result.maskVerification.verified || result.maskVerification.failedMaskIds.length > 0) {
    return block(input, envelope.format, 'E2E_VISUAL_MASK_VERIFICATION_FAILED')
  }
  if (!result.ocr.performed || !result.ocr.engineVersion) {
    return block(input, envelope.format, 'E2E_VISUAL_OCR_REQUIRED')
  }
  if (result.bytes.byteLength === 0 || result.bytes.byteLength > policy.maxInputBytes) {
    return block(input, envelope.format, 'E2E_VISUAL_OUTPUT_INVALID')
  }
  if (Buffer.byteLength(result.ocr.text, 'utf8') > policy.maxInputBytes
    || result.ocr.regions.length < 1 || result.ocr.regions.length > 4096) {
    return block(input, envelope.format, 'E2E_VISUAL_OCR_SCOPE_INVALID')
  }
  if (!validFrameScope(input.evidenceType, result.frames)) {
    return block(input, envelope.format, 'E2E_VISUAL_FRAME_SCOPE_INVALID')
  }
  return finalizeSanitizedEvidence({
    raw: input.raw, output: result.bytes, policy, evidenceType: input.evidenceType,
    inputFormat: envelope.format, scanner: input.scanner, scanScope: `${input.evidenceType}-ocr-output`,
    scanBytes: Buffer.from(result.ocr.text, 'utf8'),
    inspectionScope: {
      ocr: {
        performed: true, engineVersion: result.ocr.engineVersion,
        regions: [...result.ocr.regions],
      },
      frames: result.frames,
    },
    forcedReviewReasons: [`E2E_PRIVACY_REVIEW_${input.evidenceType.toUpperCase()}`],
    parserVersion: input.adapter.version,
    pipelineCanaries: result.canaries,
  })
}

function decodeEnvelope(raw: Uint8Array, policy: SanitizerPolicy, formats: string[]):
  | { envelope: { format: string; media: Buffer; width: number; height: number; masks: VisualMaskRegion[] } }
  | { reasonCode: string; format: string } {
  if (!SanitizerPolicySchema.safeParse(policy).success) return { reasonCode: 'E2E_SANITIZER_POLICY_INVALID', format: 'invalid-policy' }
  if (raw.byteLength > policy.maxInputBytes) return { reasonCode: 'E2E_SANITIZER_INPUT_TOO_LARGE', format: 'oversized' }
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(raw).toString('utf8')) } catch {
    return { reasonCode: 'E2E_SANITIZER_PARSE_FAILED', format: 'unparseable' }
  }
  const format = isObject(decoded) && typeof decoded.format === 'string' ? decoded.format.slice(0, 128) : 'missing-format'
  if (!formats.includes(format)) return { reasonCode: 'E2E_SANITIZER_FORMAT_INCOMPATIBLE', format }
  if (!isObject(decoded) || !exactKeys(decoded, ['format', 'mediaBase64', 'width', 'height', 'masks'])
    || typeof decoded.format !== 'string' || typeof decoded.mediaBase64 !== 'string'
    || !positiveInteger(decoded.width) || !positiveInteger(decoded.height) || !Array.isArray(decoded.masks)) {
    return { reasonCode: 'E2E_SANITIZER_PARSE_FAILED', format }
  }
  if (decoded.width * decoded.height > 100_000_000 || decoded.masks.length > 4096 || !canonicalBase64(decoded.mediaBase64)) {
    return { reasonCode: 'E2E_VISUAL_ENVELOPE_INVALID', format }
  }
  const media = Buffer.from(decoded.mediaBase64, 'base64')
  if (media.byteLength === 0 || media.byteLength > policy.maxInputBytes) {
    return { reasonCode: 'E2E_VISUAL_ENVELOPE_INVALID', format }
  }
  const masks: VisualMaskRegion[] = []
  for (const candidate of decoded.masks) {
    if (!isObject(candidate)) return { reasonCode: 'E2E_VISUAL_ENVELOPE_INVALID', format }
    const target = candidate.target
    const expectedKeys = target === 'element'
      ? ['maskId', 'target', 'x', 'y', 'width', 'height', 'stableTargetDigest']
      : ['maskId', 'target', 'x', 'y', 'width', 'height']
    if (!exactKeys(candidate, expectedKeys) || typeof candidate.maskId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.maskId)
      || (target !== 'element' && target !== 'coordinates')
      || !nonnegativeInteger(candidate.x) || !nonnegativeInteger(candidate.y)
      || !positiveInteger(candidate.width) || !positiveInteger(candidate.height)
      || candidate.x + candidate.width > decoded.width || candidate.y + candidate.height > decoded.height
      || (target === 'element' && (typeof candidate.stableTargetDigest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(candidate.stableTargetDigest)))) {
      return { reasonCode: 'E2E_VISUAL_ENVELOPE_INVALID', format }
    }
    masks.push({
      maskId: candidate.maskId, target, x: candidate.x, y: candidate.y,
      width: candidate.width, height: candidate.height,
      ...(target === 'element' ? { stableTargetDigest: candidate.stableTargetDigest as string } : {}),
    })
  }
  return { envelope: { format, media, width: decoded.width, height: decoded.height, masks } }
}

function validFrameScope(type: 'screenshot' | 'video', frames: InspectionScope['frames']): boolean {
  if (type === 'screenshot') return frames.strategy === 'not-applicable' && frames.inspectedFrames.length === 0
  if (frames.strategy === 'not-applicable' || !positiveInteger(frames.totalFrames)
    || frames.inspectedFrames.length === 0) return false
  const unique = new Set(frames.inspectedFrames)
  if (unique.size !== frames.inspectedFrames.length || frames.inspectedFrames.some((frame) =>
    !nonnegativeInteger(frame) || frame >= frames.totalFrames!)) return false
  return frames.strategy !== 'all' || frames.inspectedFrames.length === frames.totalFrames
}

function block(
  input: {
    raw: Uint8Array
    evidenceType: 'screenshot' | 'video'
    policy: SanitizerPolicy
    adapter?: VisualSanitizerAdapter
  },
  inputFormat: string,
  reasonCode: string,
): SanitizationOutcome {
  const parserVersion = input.adapter && validVisualAdapter(input.adapter) ? input.adapter.version : undefined
  return blockSanitization({ ...input, inputFormat, reasonCode, ...(parserVersion ? { parserVersion } : {}) })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function canonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function validVisualAdapter(value: unknown): value is VisualSanitizerAdapter {
  return isObject(value)
    && typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version)
    && Array.isArray(value.supportedFormats)
    && value.supportedFormats.every((format) => typeof format === 'string')
    && typeof value.sanitize === 'function'
}

function validVisualResult(value: unknown): value is ReturnType<VisualSanitizerAdapter['sanitize']> {
  if (!isObject(value) || !(value.bytes instanceof Uint8Array)
    || !isObject(value.maskVerification) || typeof value.maskVerification.verified !== 'boolean'
    || !Array.isArray(value.maskVerification.failedMaskIds)
    || !value.maskVerification.failedMaskIds.every((id) => typeof id === 'string')
    || !isObject(value.ocr) || typeof value.ocr.performed !== 'boolean'
    || (value.ocr.engineVersion !== undefined && typeof value.ocr.engineVersion !== 'string')
    || typeof value.ocr.text !== 'string' || !Array.isArray(value.ocr.regions)
    || !value.ocr.regions.every((region) => typeof region === 'string')
    || !isObject(value.frames) || !['not-applicable', 'all', 'sampled'].includes(String(value.frames.strategy))
    || (value.frames.totalFrames !== undefined && !nonnegativeInteger(value.frames.totalFrames))
    || !Array.isArray(value.frames.inspectedFrames)
    || !value.frames.inspectedFrames.every(nonnegativeInteger)
    || !Array.isArray(value.canaries)
    || !value.canaries.every((canary) => CanaryResultSchema.safeParse(canary).success)) return false
  return true
}
