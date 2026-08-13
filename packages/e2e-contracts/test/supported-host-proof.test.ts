import { describe, expect, test } from 'vitest'
import { SupportedHostProofV1Schema, computeSupportedHostProofDigest } from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('SupportedHostProofV1', () => {
  test('拒绝把缺少真实 Gateway canary 的宿主声明为 gate eligible', () => {
    expect(SupportedHostProofV1Schema.safeParse(
      proof({ gatewayStatus: 'not-executed', gateEligible: true }),
    ).success).toBe(false)
  })

  test('拒绝 proofDigest 未绑定全部宿主事实的证明', () => {
    expect(SupportedHostProofV1Schema.safeParse(proof({ proofDigest: digest('f') })).success).toBe(false)
  })
})

function proof(options: {
  gatewayStatus?: 'executed' | 'not-executed'
  gateEligible?: boolean
  proofDigest?: string
} = {}) {
  const capability = (name: string, status: 'executed' | 'not-executed' = 'executed') => ({
    status, reasonCode: `E2E_HOST_${name}_${status === 'executed' ? 'EXECUTED' : 'NOT_PROBED'}`,
    proofDigest: digest(name === 'LOOPBACK' ? 'a' : 'b'),
  })
  const body = {
    schemaVersion: 'supported-host-proof/v1' as const,
    host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.18.0' },
    chrome: {
      channel: 'chrome' as const, version: '140.0.7339.1', source: 'system-chrome' as const,
      executableDigest: digest('c'), capability: capability('BROWSER'),
    },
    capabilities: {
      sandbox: capability('SANDBOX'), loopback: capability('LOOPBACK'),
      process: capability('PROCESS'), filesystem: capability('FILESYSTEM'),
      profileIsolation: capability('PROFILE'),
      gatewayCanary: capability('GATEWAY_CANARY', options.gatewayStatus),
    },
    executionEntry: { kind: 'public-full-journey' as const, status: 'executed' as const, proofDigest: digest('d') },
    conclusion: { status: 'supported' as const, gateEligible: options.gateEligible ?? true, reasonCodes: [] },
  }
  return { ...body, proofDigest: options.proofDigest ?? computeSupportedHostProofDigest(body) }
}
