import { describe, expect, test } from 'vitest'
import type { SanitizerPolicy } from '@mutil-skills/e2e-contracts'
import {
  sanitizeTraceEvidence,
  sanitizeVisualEvidence,
  type TraceArchiveAdapter,
  type VisualSanitizerAdapter,
} from '../src/index.js'

const policy: SanitizerPolicy = {
  schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.2.0', scannerVersion: '1.1.0',
  network: {
    formatVersions: ['network-json/1'], approvedPaths: ['/api/orders'], queryFields: [],
    requestHeaderFields: [], responseHeaderFields: [], requestBodyFields: [],
    responseBodyFields: [{ name: 'status', classification: 'public' }],
  },
  dom: {
    formatVersions: ['dom-tree/1'], allowedTags: ['main'],
    allowedAttributes: [{ name: 'role', classification: 'public' }], assertionTextClassification: 'public',
  },
  console: {
    formatVersions: ['console-json/1'], allowedObjectFields: [{ name: 'code', classification: 'internal' }],
    primitiveArgumentClassification: 'internal',
  },
  screenshot: { formatVersions: ['png/1'] }, video: { formatVersions: ['webm/1'] },
  trace: { formatVersions: ['playwright-trace/1'] }, maxInputBytes: 1_048_576,
  requireManualReviewFor: ['credential', 'government-id', 'financial', 'health', 'contact'],
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

describe('sanitizeVisualEvidence', () => {
  test('publishes only adapter-produced masked bytes and records verified OCR/frame scope for manual review', () => {
    const adapter: VisualSanitizerAdapter = {
      version: '2.0.0',
      supportedFormats: ['png/1'],
      sanitize: () => ({
        bytes: Buffer.from('masked-png-bytes'),
        maskVerification: { verified: true, failedMaskIds: [] },
        ocr: { performed: true, engineVersion: 'ocr-2.0.0', text: 'Orders page', regions: ['full-frame'] },
        frames: { strategy: 'not-applicable', inspectedFrames: [] },
        canaries: [{ canaryId: 'visual-mask-ocr-v1', expectedClassification: 'contact', detected: true }],
      }),
    }
    const raw = bytes({
      format: 'png/1', mediaBase64: Buffer.from('raw-secret-pixels').toString('base64'),
      width: 1280, height: 720,
      masks: [{ maskId: 'customer-panel', target: 'element', x: 10, y: 20, width: 100, height: 40,
        stableTargetDigest: `sha256:${'a'.repeat(64)}` }],
    })

    const result = sanitizeVisualEvidence({ raw, evidenceType: 'screenshot', policy, adapter })

    expect(result.status).toBe('review-required')
    if (result.status !== 'review-required') throw new Error('expected review-required evidence')
    expect(result.bytes).toEqual(Buffer.from('masked-png-bytes'))
    expect(result.record).toMatchObject({
      evidenceType: 'screenshot',
      inspectionScope: {
        ocr: { performed: true, engineVersion: 'ocr-2.0.0', regions: ['full-frame'] },
        frames: { strategy: 'not-applicable', inspectedFrames: [] },
      },
      manualReview: { required: true, status: 'pending' },
    })
  })

  test('fails closed when the adapter is absent, format is unknown, mask tracking fails, OCR fails, or canary fails', () => {
    const raw = bytes({
      format: 'png/1', mediaBase64: Buffer.from('pixels').toString('base64'), width: 10, height: 10,
      masks: [{ maskId: 'panel', target: 'coordinates', x: 0, y: 0, width: 5, height: 5 }],
    })
    const failing = (overrides: Partial<ReturnType<VisualSanitizerAdapter['sanitize']>>): VisualSanitizerAdapter => ({
      version: '2.0.0',
      supportedFormats: ['png/1'],
      sanitize: () => ({
        bytes: Buffer.from('masked'), maskVerification: { verified: true, failedMaskIds: [] },
        ocr: { performed: true, engineVersion: 'ocr-2.0.0', text: '', regions: ['full-frame'] },
        frames: { strategy: 'not-applicable', inspectedFrames: [] },
        canaries: [{ canaryId: 'visual-mask-ocr-v1', expectedClassification: 'contact', detected: true }],
        ...overrides,
      }),
    })

    expect(sanitizeVisualEvidence({ raw, evidenceType: 'screenshot', policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_VISUAL_ADAPTER_UNAVAILABLE'] })
    expect(sanitizeVisualEvidence({ raw: bytes({ format: 'png/99' }), evidenceType: 'screenshot', policy, adapter: failing({}) }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_FORMAT_INCOMPATIBLE'] })
    expect(sanitizeVisualEvidence({ raw, evidenceType: 'screenshot', policy, adapter: failing({
      maskVerification: { verified: false, failedMaskIds: ['panel'] },
    }) })).toMatchObject({
      status: 'blocked', reasonCodes: ['E2E_VISUAL_MASK_VERIFICATION_FAILED'],
      record: { formatCompatibility: { status: 'compatible', parserVersion: '2.0.0' } },
    })
    expect(sanitizeVisualEvidence({ raw, evidenceType: 'screenshot', policy, adapter: failing({
      ocr: { performed: false, text: '', regions: [] },
    }) })).toMatchObject({ status: 'blocked', reasonCodes: ['E2E_VISUAL_OCR_REQUIRED'] })
    expect(sanitizeVisualEvidence({ raw, evidenceType: 'screenshot', policy, adapter: failing({
      canaries: [{ canaryId: 'visual-mask-ocr-v1', expectedClassification: 'contact', detected: false }],
    }) }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_PRIVACY_CANARY_FAILED'] })
  })

  test('blocks invalid runtime policy, malformed adapter output, and empty video sampling', () => {
    const raw = bytes({ format: 'webm/1', mediaBase64: Buffer.from('video').toString('base64'), width: 10, height: 10, masks: [] })
    const adapter: VisualSanitizerAdapter = {
      version: '2.0.0',
      supportedFormats: ['webm/1'],
      sanitize: () => ({
        bytes: Buffer.from('masked-video'), maskVerification: { verified: true, failedMaskIds: [] },
        ocr: { performed: true, engineVersion: 'ocr-2.0.0', text: '', regions: ['sampled'] },
        frames: { strategy: 'sampled', totalFrames: 10, inspectedFrames: [] },
        canaries: [{ canaryId: 'visual-video-v1', expectedClassification: 'contact', detected: true }],
      }),
    }
    expect(() => sanitizeVisualEvidence({ raw, evidenceType: 'video', policy: {} as SanitizerPolicy, adapter })).not.toThrow()
    expect(sanitizeVisualEvidence({ raw, evidenceType: 'video', policy: {} as SanitizerPolicy, adapter }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_POLICY_INVALID'] })
    expect(sanitizeVisualEvidence({ raw, evidenceType: 'video', policy, adapter }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_VISUAL_FRAME_SCOPE_INVALID'] })
    const malformed = {
      version: '2.0.0', supportedFormats: ['webm/1'], sanitize: () => null,
    } as unknown as VisualSanitizerAdapter
    expect(() => sanitizeVisualEvidence({ raw, evidenceType: 'video', policy, adapter: malformed })).not.toThrow()
    expect(sanitizeVisualEvidence({ raw, evidenceType: 'video', policy, adapter: malformed }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_VISUAL_ADAPTER_OUTPUT_INVALID'] })
  })
})

describe('sanitizeTraceEvidence', () => {
  test('enumerates every archive entry, sanitizes network/DOM, and emits only source/metadata digests', () => {
    const adapter: TraceArchiveAdapter = {
      version: '3.0.0',
      supportedFormats: ['playwright-trace/1'],
      parse: () => ({
        totalEntries: 4, unparsedEntries: [],
        canaries: [{ canaryId: 'trace-archive-v1', expectedClassification: 'internal', detected: true }],
        entries: [
          { path: 'network/1.json', kind: 'network', bytes: bytes({
            format: 'network-json/1',
            request: { method: 'GET', url: 'https://example.test/api/orders', headers: {} },
            response: { status: 200, headers: {}, body: { status: 'ok', email: 'removed@example.test' } },
          }) },
          { path: 'snapshots/1.json', kind: 'snapshot', bytes: bytes({
            format: 'dom-tree/1', roots: [{ tag: 'main', attributes: { role: 'main' }, assertionRelevant: true, text: 'Orders' }],
          }) },
          { path: 'sources/app.ts', kind: 'source', bytes: Buffer.from('const secret = "not published"') },
          { path: 'metadata.json', kind: 'metadata', bytes: bytes({ browser: 'chromium' }) },
        ],
      }),
    }
    const raw = bytes({ format: 'playwright-trace/1', archiveBase64: Buffer.from('zip-bytes').toString('base64') })

    const result = sanitizeTraceEvidence({ raw, policy, adapter })

    expect(result.status).toBe('review-required')
    if (result.status !== 'review-required') throw new Error('expected review-required trace')
    const output = result.bytes.toString('utf8')
    expect(output).toContain('network-sanitized-json/1')
    expect(output).toContain('dom-sanitized-tree/1')
    expect(output).toContain('sourceDigest')
    expect(output).not.toContain('not published')
    expect(output).not.toContain('removed@example.test')
  })

  test('blocks unknown, unparsed, missing, duplicate, or traversal archive entries', () => {
    const raw = bytes({ format: 'playwright-trace/1', archiveBase64: Buffer.from('zip').toString('base64') })
    const adapter = (result: ReturnType<TraceArchiveAdapter['parse']>): TraceArchiveAdapter => ({
      version: '3.0.0',
      supportedFormats: ['playwright-trace/1'], parse: () => result,
    })
    const entry = { path: 'metadata.json', kind: 'metadata' as const, bytes: bytes({}) }

    expect(sanitizeTraceEvidence({ raw, policy, adapter: adapter({
      totalEntries: 2, entries: [entry], unparsedEntries: ['unknown.bin'],
      canaries: [{ canaryId: 'trace-archive-v1', expectedClassification: 'internal', detected: true }],
    }) })).toMatchObject({ status: 'blocked', reasonCodes: ['E2E_TRACE_ARCHIVE_INCOMPLETE'] })
    expect(sanitizeTraceEvidence({ raw, policy, adapter: adapter({
      totalEntries: 2, entries: [entry, entry], unparsedEntries: [],
      canaries: [{ canaryId: 'trace-archive-v1', expectedClassification: 'internal', detected: true }],
    }) })).toMatchObject({ status: 'blocked', reasonCodes: ['E2E_TRACE_ARCHIVE_INVALID'] })
    expect(sanitizeTraceEvidence({ raw, policy, adapter: adapter({
      totalEntries: 1, entries: [{ ...entry, path: '../escape' }], unparsedEntries: [],
      canaries: [{ canaryId: 'trace-archive-v1', expectedClassification: 'internal', detected: true }],
    }) })).toMatchObject({ status: 'blocked', reasonCodes: ['E2E_TRACE_ARCHIVE_INVALID'] })
  })

  test('blocks invalid runtime policy and malformed adapter collections without throwing', () => {
    const raw = bytes({ format: 'playwright-trace/1', archiveBase64: Buffer.from('zip').toString('base64') })
    const malformed: TraceArchiveAdapter = {
      version: '3.0.0',
      supportedFormats: ['playwright-trace/1'],
      parse: () => ({ totalEntries: 1, entries: undefined, unparsedEntries: undefined, canaries: [] }),
    } as unknown as TraceArchiveAdapter
    expect(() => sanitizeTraceEvidence({ raw, policy: {} as SanitizerPolicy, adapter: malformed })).not.toThrow()
    expect(sanitizeTraceEvidence({ raw, policy: {} as SanitizerPolicy, adapter: malformed }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_POLICY_INVALID'] })
    expect(() => sanitizeTraceEvidence({ raw, policy, adapter: malformed })).not.toThrow()
    expect(sanitizeTraceEvidence({ raw, policy, adapter: malformed }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_TRACE_ARCHIVE_INVALID'] })
  })
})
