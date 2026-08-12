import { describe, expect, test } from 'vitest'
import { buildBrowserCapabilityMatrix } from './e2e-browser-capability-matrix.js'

const componentProof = {
  schemaVersion: '1.0.0' as const,
  proofKind: 'browser-capability' as const,
  proofDigest: `sha256:${'1'.repeat(64)}`,
  passed: true,
  gateEligible: true,
}
const realProjectProof = {
  schemaVersion: 'e2e-benchmark-proof/v1' as const,
  proofKind: 'real-project' as const,
  proofDigest: `sha256:${'2'.repeat(64)}`,
  gate: { eligible: true, passed: true },
}

describe('Browser Capability Matrix verifier', () => {
  test('只有组件 proof 与真实项目 proof 均绑定的能力才能标 supported', () => {
    const matrix = buildBrowserCapabilityMatrix({ componentProof, realProjectProof,
      generatedAt: '2026-08-12T00:00:00.000Z' })
    expect(matrix.entries.filter((entry) => entry.status === 'supported')).toHaveLength(10)
    expect(matrix.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: 'CAP-permission-negative', status: 'supported' }),
      expect.objectContaining({ capabilityId: 'CAP-iframe-popup-identity', status: 'unverified-on-real-project' }),
      expect.objectContaining({ capabilityId: 'CAP-backend-auth', status: 'fail-closed' }),
    ]))
  })

  test('缺少真实项目 proof 时不得人工提升为 supported', () => {
    const matrix = buildBrowserCapabilityMatrix({ componentProof,
      generatedAt: '2026-08-12T00:00:00.000Z' })
    expect(matrix.entries.some((entry) => entry.status === 'supported')).toBe(false)
  })

  test('不能只用任意 digest 把能力人工提升为 supported', () => {
    expect(() => buildBrowserCapabilityMatrix({
      componentProof: { ...componentProof, passed: false }, realProjectProof,
      generatedAt: '2026-08-12T00:00:00.000Z',
    })).not.toThrow()
    const matrix = buildBrowserCapabilityMatrix({
      componentProof: { ...componentProof, passed: false }, realProjectProof,
      generatedAt: '2026-08-12T00:00:00.000Z',
    })
    expect(matrix.entries.some((entry) => entry.status === 'supported')).toBe(false)
  })
})
