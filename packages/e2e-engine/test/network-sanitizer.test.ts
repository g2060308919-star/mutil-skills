import { describe, expect, test } from 'vitest'
import { digestBytes, type SanitizerPolicy } from '@mutil-skills/e2e-contracts'
import {
  PatternPrivacyScanner,
  sanitizeNetworkEvidence,
  type PrivacyScanner,
} from '../src/index.js'

const policy: SanitizerPolicy = {
  schemaVersion: '1.0.0',
  policyVersion: '1.0.0',
  sanitizerVersion: '1.2.0',
  scannerVersion: '1.1.0',
  network: {
    formatVersions: ['network-json/1'],
    approvedPaths: ['/api/orders'],
    queryFields: ['page'],
    requestHeaderFields: [
      { name: 'content-type', classification: 'public' },
      { name: 'x-request-id', classification: 'internal' },
    ],
    responseHeaderFields: [{ name: 'content-type', classification: 'public' }],
    requestBodyFields: [{ name: 'orderId', classification: 'internal' }],
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
  screenshot: { formatVersions: ['png/1'] },
  video: { formatVersions: ['webm/1'] },
  trace: { formatVersions: ['playwright-trace/1'] },
  maxInputBytes: 1_048_576,
  requireManualReviewFor: ['credential', 'government-id', 'financial', 'health', 'contact'],
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

describe('sanitizeNetworkEvidence', () => {
  test('retains only approved fields and replaces approved query values with digests', () => {
    const raw = bytes({
      format: 'network-json/1',
      request: {
        method: 'POST',
        url: 'https://customer.example/api/orders?page=2&token=secret',
        headers: {
          authorization: 'Bearer production-secret',
          cookie: 'session=secret',
          'content-type': 'application/json',
          'x-request-id': 'request-1',
          'x-secret': 'must disappear',
        },
        body: { orderId: 'ORDER-1', customerName: 'must disappear' },
      },
      response: {
        status: 201,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=secret' },
        body: { status: 'created', email: 'must-disappear@example.com' },
      },
    })

    const result = sanitizeNetworkEvidence({ raw, policy, scanner: new PatternPrivacyScanner('1.1.0') })

    expect(result.status).toBe('publishable')
    if (result.status !== 'publishable') throw new Error('expected publishable evidence')
    const output = JSON.parse(result.bytes.toString('utf8'))
    expect(output).toEqual({
      format: 'network-sanitized-json/1',
      request: {
        body: { orderId: 'ORDER-1' },
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
        method: 'POST',
        url: {
          path: '/api/orders',
          queryDigests: { page: digestBytes('network-query-value/v1', Buffer.from('2')) },
        },
      },
      response: {
        body: { status: 'created' },
        headers: { 'content-type': 'application/json' },
        status: 201,
      },
    })
    expect(result.record).toMatchObject({
      evidenceType: 'network',
      sanitizerVersion: '1.2.0',
      formatCompatibility: { status: 'compatible', inputFormat: 'network-json/1' },
      scanResult: { status: 'clean' },
      manualReview: { required: false, status: 'not-required' },
    })
  })

  test('blocks an allowed field when the sanitized output still contains high-sensitivity data', () => {
    const raw = bytes({
      format: 'network-json/1',
      request: { method: 'GET', url: 'https://customer.example/api/orders', headers: {} },
      response: {
        status: 200,
        headers: {},
        body: { status: 'card 4111 1111 1111 1111' },
      },
    })

    const result = sanitizeNetworkEvidence({ raw, policy, scanner: new PatternPrivacyScanner('1.1.0') })

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCodes: ['E2E_PRIVACY_HIGH_SENSITIVITY_FOUND'],
      record: { scanResult: { status: 'findings' } },
    })
  })

  test('blocks credential classification even if a custom scanner understates its severity', () => {
    const raw = bytes({
      format: 'network-json/1',
      request: { method: 'GET', url: 'https://customer.example/api/orders', headers: {} },
      response: { status: 200, headers: {}, body: { status: 'ordinary-looking-token' } },
    })
    const pattern = new PatternPrivacyScanner('1.1.0')
    const scanner: PrivacyScanner = {
      version: '1.1.0',
      scan: (input) => input.scope.startsWith('canary-') ? pattern.scan(input) : [{
        classification: 'credential', severity: 'medium', detectorId: 'custom-understated',
        location: 'network-sanitized-output:field-status', matchDigest: `sha256:${'d'.repeat(64)}`,
      }],
    }

    expect(sanitizeNetworkEvidence({ raw, policy, scanner }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_PRIVACY_HIGH_SENSITIVITY_FOUND'] })
  })

  test('requires review for classified contact content and blocks nested allowlisted values', () => {
    const contactPolicy: SanitizerPolicy = {
      ...policy,
      network: {
        ...policy.network,
        responseBodyFields: [{ name: 'status', classification: 'contact' }],
      },
    }
    const contact = bytes({
      format: 'network-json/1',
      request: { method: 'GET', url: 'https://customer.example/api/orders', headers: {} },
      response: { status: 200, headers: {}, body: { status: 'alice@example.com' } },
    })
    const nested = bytes({
      format: 'network-json/1',
      request: { method: 'GET', url: 'https://customer.example/api/orders', headers: {} },
      response: { status: 200, headers: {}, body: { status: { unknown: 'customer content' } } },
    })

    expect(sanitizeNetworkEvidence({ raw: contact, policy: contactPolicy }))
      .toMatchObject({ status: 'review-required', record: { manualReview: { required: true, status: 'pending' } } })
    expect(sanitizeNetworkEvidence({ raw: nested, policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_FIELD_VALUE_UNSUPPORTED'] })
  })

  test('fails closed for unknown format, parser error, scanner error, and failed canary capability', () => {
    const scannerError: PrivacyScanner = {
      version: '1.1.0',
      scan: () => { throw new Error('scanner offline') },
    }
    const blindScanner: PrivacyScanner = { version: '1.1.0', scan: () => [] }
    const valid = bytes({
      format: 'network-json/1',
      request: { method: 'GET', url: 'https://customer.example/api/orders', headers: {} },
      response: { status: 200, headers: {} },
    })

    expect(sanitizeNetworkEvidence({ raw: bytes({ format: 'network-json/99' }), policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_FORMAT_INCOMPATIBLE'] })
    expect(sanitizeNetworkEvidence({ raw: Buffer.from('{'), policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_PARSE_FAILED'] })
    expect(sanitizeNetworkEvidence({ raw: valid, policy, scanner: scannerError }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_PRIVACY_SCANNER_ERROR'] })
    expect(sanitizeNetworkEvidence({ raw: valid, policy, scanner: blindScanner }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_PRIVACY_CANARY_FAILED'] })
  })

  test('treats runtime-invalid policy and scanner output as blocked boundary data', () => {
    const valid = bytes({
      format: 'network-json/1',
      request: { method: 'GET', url: 'https://customer.example/api/orders', headers: {} },
      response: { status: 200, headers: {} },
    })
    const malformedScanner = {
      version: '1.1.0',
      scan: ({ scope }: { scope: string }) => scope.startsWith('canary-')
        ? new PatternPrivacyScanner('1.1.0').scan({ bytes: Buffer.from(
          scope.includes('credential') ? 'Bearer canary-secret-token'
            : scope.includes('government') ? '11010519491231002X'
              : scope.includes('financial') ? '4111 1111 1111 1111'
                : scope.includes('health') ? 'medical-record: CANARY-42'
                  : 'canary@example.test',
        ), scope })
        : [{}],
    } as PrivacyScanner

    expect(() => sanitizeNetworkEvidence({ raw: valid, policy: {} as SanitizerPolicy })).not.toThrow()
    expect(sanitizeNetworkEvidence({ raw: valid, policy: {} as SanitizerPolicy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_POLICY_INVALID'] })
    expect(sanitizeNetworkEvidence({ raw: valid, policy, scanner: malformedScanner }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_PRIVACY_SCANNER_OUTPUT_INVALID'] })
  })
})
