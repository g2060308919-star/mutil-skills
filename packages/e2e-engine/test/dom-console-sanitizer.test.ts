import { describe, expect, test } from 'vitest'
import type { SanitizerPolicy } from '@mutil-skills/e2e-contracts'
import {
  PatternPrivacyScanner,
  sanitizeConsoleEvidence,
  sanitizeDomEvidence,
} from '../src/index.js'

const policy: SanitizerPolicy = {
  schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.2.0', scannerVersion: '1.1.0',
  network: {
    formatVersions: ['network-json/1'], approvedPaths: ['/api/orders'], queryFields: [],
    requestHeaderFields: [], responseHeaderFields: [], requestBodyFields: [], responseBodyFields: [],
  },
  dom: {
    formatVersions: ['dom-tree/1'],
    allowedTags: ['main', 'section', 'h1', 'span', 'button'],
    allowedAttributes: [
      { name: 'role', classification: 'public' },
      { name: 'aria-label', classification: 'public' },
      { name: 'data-testid', classification: 'internal' },
    ],
    assertionTextClassification: 'public',
  },
  console: {
    formatVersions: ['console-json/1'],
    allowedObjectFields: [
      { name: 'code', classification: 'internal' },
      { name: 'retryable', classification: 'public' },
    ],
    primitiveArgumentClassification: 'internal',
  },
  screenshot: { formatVersions: ['png/1'] }, video: { formatVersions: ['webm/1'] },
  trace: { formatVersions: ['playwright-trace/1'] }, maxInputBytes: 1_048_576,
  requireManualReviewFor: ['credential', 'government-id', 'financial', 'health', 'contact'],
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

describe('sanitizeDomEvidence', () => {
  test('removes hidden and privacy regions, input values, disallowed attributes, and non-assertion text', () => {
    const raw = bytes({
      format: 'dom-tree/1',
      roots: [{
        tag: 'main', attributes: { role: 'main', style: 'color:red' }, children: [
          { tag: 'h1', assertionRelevant: true, text: 'Orders', attributes: {} },
          { tag: 'span', assertionRelevant: false, text: 'customer free text', attributes: {} },
          { tag: 'span', hidden: true, assertionRelevant: true, text: 'hidden secret', attributes: {} },
          { tag: 'section', privacy: 'pii', children: [{ tag: 'span', text: 'alice@example.com', attributes: {} }] },
          { tag: 'button', assertionRelevant: true, text: 'Submit', inputValue: 'secret-value', attributes: { 'data-testid': 'submit', value: 'secret-value' } },
        ],
      }],
    })

    const result = sanitizeDomEvidence({ raw, policy, scanner: new PatternPrivacyScanner('1.1.0') })

    expect(result.status).toBe('publishable')
    if (result.status !== 'publishable') throw new Error('expected publishable evidence')
    expect(JSON.parse(result.bytes.toString('utf8'))).toEqual({
      format: 'dom-sanitized-tree/1',
      roots: [{
        attributes: { role: 'main' }, tag: 'main', children: [
          { attributes: {}, tag: 'h1', text: 'Orders', children: [] },
          { attributes: {}, tag: 'span', children: [] },
          { attributes: { 'data-testid': 'submit' }, tag: 'button', text: 'Submit', children: [] },
        ],
      }],
    })
  })

  test('blocks unsupported structure and high-sensitivity data that remains in assertion text', () => {
    const leak = bytes({
      format: 'dom-tree/1',
      roots: [{ tag: 'main', attributes: {}, assertionRelevant: true, text: 'Bearer leaked-secret-token' }],
    })
    expect(sanitizeDomEvidence({ raw: bytes({ format: 'dom-html/99', html: '<main />' }), policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_FORMAT_INCOMPATIBLE'] })
    expect(sanitizeDomEvidence({ raw: leak, policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_PRIVACY_HIGH_SENSITIVITY_FOUND'] })
  })
})

describe('sanitizeConsoleEvidence', () => {
  test('keeps primitives and allowlisted primitive object fields without raw object serialization', () => {
    const raw = bytes({
      format: 'console-json/1',
      entries: [{
        level: 'error',
        args: ['request failed', { code: 'E_TIMEOUT', retryable: true, token: 'Bearer must-not-survive' }],
      }],
    })

    const result = sanitizeConsoleEvidence({ raw, policy, scanner: new PatternPrivacyScanner('1.1.0') })

    expect(result.status).toBe('publishable')
    if (result.status !== 'publishable') throw new Error('expected publishable evidence')
    expect(JSON.parse(result.bytes.toString('utf8'))).toEqual({
      format: 'console-sanitized-json/1',
      entries: [{ level: 'error', args: ['request failed', { code: 'E_TIMEOUT', retryable: true }] }],
    })
    expect(result.bytes.toString('utf8')).not.toContain('token')
  })

  test('fails closed for nested allowlisted objects instead of serializing them', () => {
    const raw = bytes({
      format: 'console-json/1',
      entries: [{ level: 'log', args: [{ code: { nested: 'unknown object' } }] }],
    })

    expect(sanitizeConsoleEvidence({ raw, policy }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_CONSOLE_ARGUMENT_UNSUPPORTED'] })
  })

  test('does not dereference a runtime-invalid policy before validation', () => {
    const invalid = {} as SanitizerPolicy
    expect(() => sanitizeDomEvidence({ raw: bytes({}), policy: invalid })).not.toThrow()
    expect(() => sanitizeConsoleEvidence({ raw: bytes({}), policy: invalid })).not.toThrow()
    expect(sanitizeDomEvidence({ raw: bytes({}), policy: invalid }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_POLICY_INVALID'] })
    expect(sanitizeConsoleEvidence({ raw: bytes({}), policy: invalid }))
      .toMatchObject({ status: 'blocked', reasonCodes: ['E2E_SANITIZER_POLICY_INVALID'] })
  })
})
