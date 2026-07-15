import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const SafeNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
const FieldNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).refine(
  (name) => !['__proto__', 'prototype', 'constructor'].includes(name),
  'prototype-sensitive field names are forbidden',
)
const FormatVersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._/-]+$/)

export const DataClassificationSchema = z.enum([
  'credential',
  'government-id',
  'financial',
  'health',
  'contact',
  'customer-content',
  'internal',
  'public',
])

export const EvidenceTypeSchema = z.enum([
  'network',
  'dom',
  'console',
  'screenshot',
  'video',
  'trace',
])

const VersionsSchema = z.array(FormatVersionSchema).min(1).max(32)
const FieldsSchema = z.array(FieldNameSchema).max(256)
const ClassifiedFieldSchema = z.object({
  name: FieldNameSchema,
  classification: DataClassificationSchema,
}).strict()
const ClassifiedFieldsSchema = z.array(ClassifiedFieldSchema).max(256).superRefine((fields, context) => {
  const names = new Set<string>()
  fields.forEach((field, index) => {
    if (names.has(field.name)) context.addIssue({ code: 'custom', message: 'duplicate classified field', path: [index, 'name'] })
    names.add(field.name)
  })
})

export const SanitizerPolicySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  policyVersion: SemverSchema,
  sanitizerVersion: SemverSchema,
  scannerVersion: SemverSchema,
  network: z.object({
    formatVersions: VersionsSchema,
    approvedPaths: z.array(z.string().min(1).max(2048).startsWith('/')).min(1).max(256),
    queryFields: FieldsSchema,
    requestHeaderFields: ClassifiedFieldsSchema,
    responseHeaderFields: ClassifiedFieldsSchema,
    requestBodyFields: ClassifiedFieldsSchema,
    responseBodyFields: ClassifiedFieldsSchema,
  }).strict(),
  dom: z.object({
    formatVersions: VersionsSchema,
    allowedTags: z.array(z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/)).min(1).max(128),
    allowedAttributes: ClassifiedFieldsSchema,
    assertionTextClassification: DataClassificationSchema,
  }).strict(),
  console: z.object({
    formatVersions: VersionsSchema,
    allowedObjectFields: ClassifiedFieldsSchema,
    primitiveArgumentClassification: DataClassificationSchema,
  }).strict(),
  screenshot: z.object({ formatVersions: VersionsSchema }).strict(),
  video: z.object({ formatVersions: VersionsSchema }).strict(),
  trace: z.object({ formatVersions: VersionsSchema }).strict(),
  maxInputBytes: z.number().int().positive().max(64 * 1024 * 1024),
  requireManualReviewFor: z.array(DataClassificationSchema).max(8),
}).strict()

export const FormatCompatibilitySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('compatible'),
    inputFormat: FormatVersionSchema,
    parserVersion: SemverSchema,
  }).strict(),
  z.object({
    status: z.literal('incompatible'),
    inputFormat: z.string().min(1).max(128),
    reasonCode: SafeNameSchema,
  }).strict(),
  z.object({
    status: z.literal('not-evaluated'),
    inputFormat: z.string().min(1).max(128),
    reasonCode: SafeNameSchema,
  }).strict(),
])

export const PrivacyScanFindingSchema = z.object({
  classification: DataClassificationSchema,
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  detectorId: SafeNameSchema,
  location: z.string().min(1).max(1024),
  matchDigest: DigestSchema,
}).strict()

export const CanaryResultSchema = z.object({
  canaryId: SafeNameSchema,
  expectedClassification: DataClassificationSchema,
  detected: z.boolean(),
}).strict()

export const PrivacyScanResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clean'),
    scannerVersion: SemverSchema,
    scope: z.string().min(1).max(1024),
    findings: z.tuple([]),
    canaries: z.array(CanaryResultSchema).min(1),
  }).strict(),
  z.object({
    status: z.literal('findings'),
    scannerVersion: SemverSchema,
    scope: z.string().min(1).max(1024),
    findings: z.array(PrivacyScanFindingSchema).min(1),
    canaries: z.array(CanaryResultSchema).min(1),
  }).strict(),
  z.object({
    status: z.literal('error'),
    scannerVersion: SemverSchema,
    scope: z.string().min(1).max(1024),
    reasonCode: SafeNameSchema,
    canaries: z.array(CanaryResultSchema),
  }).strict(),
]).superRefine((result, context) => {
  const ids = new Set<string>()
  result.canaries.forEach((canary, index) => {
    if (ids.has(canary.canaryId)) context.addIssue({ code: 'custom', message: 'duplicate canary', path: ['canaries', index] })
    ids.add(canary.canaryId)
    if (result.status !== 'error' && !canary.detected) {
      context.addIssue({ code: 'custom', message: 'successful scan requires every canary', path: ['canaries', index, 'detected'] })
    }
  })
})

export const InspectionScopeSchema = z.object({
  ocr: z.object({
    performed: z.boolean(),
    engineVersion: z.string().min(1).max(128).optional(),
    regions: z.array(z.string().min(1).max(256)).max(4096),
  }).strict(),
  frames: z.object({
    strategy: z.enum(['not-applicable', 'all', 'sampled']),
    totalFrames: z.number().int().nonnegative().optional(),
    inspectedFrames: z.array(z.number().int().nonnegative()).max(100_000),
  }).strict(),
}).strict().superRefine((scope, context) => {
  if (!scope.ocr.performed && (scope.ocr.engineVersion !== undefined || scope.ocr.regions.length > 0)) {
    context.addIssue({ code: 'custom', message: 'OCR metadata requires performed=true', path: ['ocr'] })
  }
  if (scope.ocr.performed && scope.ocr.engineVersion === undefined) {
    context.addIssue({ code: 'custom', message: 'performed OCR requires engineVersion', path: ['ocr', 'engineVersion'] })
  }
  const frames = scope.frames
  const uniqueFrames = new Set(frames.inspectedFrames)
  if (uniqueFrames.size !== frames.inspectedFrames.length) {
    context.addIssue({ code: 'custom', message: 'inspected frames must be unique', path: ['frames', 'inspectedFrames'] })
  }
  if (frames.strategy === 'not-applicable' && (frames.totalFrames !== undefined || frames.inspectedFrames.length > 0)) {
    context.addIssue({ code: 'custom', message: 'not-applicable frame scope must be empty', path: ['frames'] })
  }
  if (frames.strategy !== 'not-applicable') {
    if (frames.totalFrames === undefined || frames.totalFrames < 1) {
      context.addIssue({ code: 'custom', message: 'sampled/all requires totalFrames', path: ['frames', 'totalFrames'] })
    } else if (frames.inspectedFrames.some((frame) => frame >= frames.totalFrames!)) {
      context.addIssue({ code: 'custom', message: 'inspected frame is out of range', path: ['frames', 'inspectedFrames'] })
    }
    if (frames.inspectedFrames.length < 1) {
      context.addIssue({ code: 'custom', message: 'sampled/all requires inspected frames', path: ['frames', 'inspectedFrames'] })
    }
    if (frames.strategy === 'all' && frames.inspectedFrames.length !== frames.totalFrames) {
      context.addIssue({ code: 'custom', message: 'all strategy requires every frame', path: ['frames', 'inspectedFrames'] })
    }
  }
})

export const PrivacyReviewRequirementSchema = z.object({
  required: z.boolean(),
  status: z.enum(['not-required', 'pending', 'approved', 'rejected']),
  reasonCodes: z.array(SafeNameSchema).max(32),
}).strict().superRefine((review, context) => {
  if (review.required && review.status === 'not-required') {
    context.addIssue({ code: 'custom', message: 'required review cannot be not-required', path: ['status'] })
  }
  if (review.required && review.reasonCodes.length === 0) {
    context.addIssue({ code: 'custom', message: 'required review needs reasonCodes', path: ['reasonCodes'] })
  }
  if (!review.required && review.status !== 'not-required') {
    context.addIssue({ code: 'custom', message: 'optional review must be not-required', path: ['status'] })
  }
})

export const SanitizationRecordSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidenceType: EvidenceTypeSchema,
  sanitizerVersion: SemverSchema,
  formatCompatibility: FormatCompatibilitySchema,
  policyDigest: DigestSchema,
  inputDigest: DigestSchema,
  outputDigest: DigestSchema,
  scanResult: PrivacyScanResultSchema,
  inspectionScope: InspectionScopeSchema,
  manualReview: PrivacyReviewRequirementSchema,
}).strict()

const HeaderValueSchema = z.string().max(64 * 1024)
const HeadersSchema = z.record(z.string().min(1).max(256), HeaderValueSchema)
const JsonObjectSchema = z.record(z.string().min(1).max(256), z.unknown())

export const RawNetworkEvidenceSchema = z.object({
  format: FormatVersionSchema,
  request: z.object({
    method: z.string().min(1).max(32).regex(/^[A-Z]+$/),
    url: z.string().min(1).max(16 * 1024),
    headers: HeadersSchema,
    body: JsonObjectSchema.optional(),
  }).strict(),
  response: z.object({
    status: z.number().int().min(100).max(599),
    headers: HeadersSchema,
    body: JsonObjectSchema.optional(),
  }).strict(),
}).strict()

export type DataClassification = z.infer<typeof DataClassificationSchema>
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>
export type SanitizerPolicy = z.infer<typeof SanitizerPolicySchema>
export type ClassifiedField = z.infer<typeof ClassifiedFieldSchema>
export type FormatCompatibility = z.infer<typeof FormatCompatibilitySchema>
export type PrivacyScanFinding = z.infer<typeof PrivacyScanFindingSchema>
export type CanaryResult = z.infer<typeof CanaryResultSchema>
export type PrivacyScanResult = z.infer<typeof PrivacyScanResultSchema>
export type InspectionScope = z.infer<typeof InspectionScopeSchema>
export type PrivacyReviewRequirement = z.infer<typeof PrivacyReviewRequirementSchema>
export type SanitizationRecord = z.infer<typeof SanitizationRecordSchema>
export type RawNetworkEvidence = z.infer<typeof RawNetworkEvidenceSchema>
