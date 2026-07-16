import { describe, expect, test } from 'vitest'
import {
  DataClassificationSchema,
  InspectionScopeSchema,
  PrivacyReviewRequirementSchema,
  PrivacyScanResultSchema,
  SanitizationRecordSchema,
  SanitizerPolicySchema,
} from '../src/index.js'

describe('privacy contracts', () => {
  test('uses the fixed data classification vocabulary', () => {
    expect(DataClassificationSchema.options).toEqual([
      'credential',
      'government-id',
      'financial',
      'health',
      'contact',
      'customer-content',
      'internal',
      'public',
    ])
    expect(DataClassificationSchema.safeParse('redacted').success).toBe(false)
  })

  test('requires strict allowlists and bounded input for every sanitizer policy', () => {
    const result = SanitizerPolicySchema.safeParse({
      schemaVersion: '1.0.0',
      policyVersion: '1.0.0',
      sanitizerVersion: '1.0.0',
      scannerVersion: '1.0.0',
      network: {
        formatVersions: ['network-json/1'],
        approvedPaths: ['/api/orders'],
        queryFields: ['page'],
        requestHeaderFields: [{ name: 'content-type', classification: 'public' }],
        responseHeaderFields: [{ name: 'content-type', classification: 'public' }],
        requestBodyFields: [{ name: 'orderId', classification: 'internal' }],
        responseBodyFields: [{ name: 'status', classification: 'public' }],
      },
      dom: {
        formatVersions: ['dom-tree/1'], allowedTags: ['main'],
        allowedAttributes: [{ name: 'role', classification: 'public' }],
        assertionTextClassification: 'public',
      },
      console: {
        formatVersions: ['console-json/1'],
        allowedObjectFields: [{ name: 'code', classification: 'internal' }],
        primitiveArgumentClassification: 'internal',
      },
      screenshot: { formatVersions: ['png/1'] },
      video: { formatVersions: ['webm/1'] },
      trace: { formatVersions: ['playwright-trace/1'] },
      maxInputBytes: 1_048_576,
      requireManualReviewFor: ['credential', 'government-id', 'financial', 'health'],
    })

    expect(result.success).toBe(true)
    expect(SanitizerPolicySchema.safeParse({ ...result.data, unexpected: true }).success).toBe(false)
    expect(SanitizerPolicySchema.safeParse({
      ...result.data,
      network: { ...result.data?.network, requestBodyFields: ['unclassified'] },
    }).success).toBe(false)
    expect(SanitizerPolicySchema.safeParse({
      ...result.data,
      console: {
        ...result.data?.console,
        allowedObjectFields: [{ name: '__proto__', classification: 'public' }],
      },
    }).success).toBe(false)
  })

  test('rejects proof metadata that omits compatibility, scan, sampling, or review scope', () => {
    const incomplete = {
      schemaVersion: '1.0.0',
      evidenceType: 'network',
      sanitizerVersion: '1.0.0',
      policyDigest: `sha256:${'a'.repeat(64)}`,
      inputDigest: `sha256:${'b'.repeat(64)}`,
      outputDigest: `sha256:${'c'.repeat(64)}`,
    }
    expect(SanitizationRecordSchema.safeParse(incomplete).success).toBe(false)
  })

  test('rejects contradictory canary, OCR/frame, and manual-review proof', () => {
    expect(PrivacyScanResultSchema.safeParse({
      status: 'clean', scannerVersion: '1.0.0', scope: 'output', findings: [],
      canaries: [{ canaryId: 'known-pipeline', expectedClassification: 'contact', detected: false }],
    }).success).toBe(false)
    expect(InspectionScopeSchema.safeParse({
      ocr: { performed: false, engineVersion: 'ocr-1.0.0', regions: ['full-frame'] },
      frames: { strategy: 'all', totalFrames: 2, inspectedFrames: [0] },
    }).success).toBe(false)
    expect(PrivacyReviewRequirementSchema.safeParse({
      required: true, status: 'pending', reasonCodes: [],
    }).success).toBe(false)
  })
})
