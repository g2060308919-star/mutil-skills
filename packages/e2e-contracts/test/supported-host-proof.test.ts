import { describe, expect, test } from 'vitest'
import * as contracts from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('SupportedHostProofV1', () => {
  test('拒绝把缺少真实 Gateway canary 的宿主声明为 gate eligible', () => {
    const schema = (contracts as Record<string, unknown>).SupportedHostProofV1Schema as {
      safeParse(value: unknown): { success: boolean }
    }
    expect(schema).toBeDefined()
    expect(schema.safeParse(proof({ gatewayStatus: 'not-executed', gateEligible: true })).success).toBe(false)
  })

  test('拒绝 proofDigest 未绑定全部宿主事实的证明', () => {
    const schema = (contracts as Record<string, unknown>).SupportedHostProofV1Schema as {
      safeParse(value: unknown): { success: boolean }
    }
    expect(schema).toBeDefined()
    expect(schema.safeParse(proof({ proofDigest: digest('f') })).success).toBe(false)
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
  return {
    schemaVersion: 'supported-host-proof/v1',
    host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.18.0' },
    chrome: {
      channel: 'chrome', version: '140.0.7339.1', source: 'system-chrome',
      executableDigest: digest('c'), capability: capability('BROWSER'),
    },
    capabilities: {
      sandbox: capability('SANDBOX'), loopback: capability('LOOPBACK'),
      process: capability('PROCESS'), filesystem: capability('FILESYSTEM'),
      profileIsolation: capability('PROFILE'),
      gatewayCanary: capability('GATEWAY_CANARY', options.gatewayStatus),
    },
    executionEntry: { kind: 'public-full-journey', status: 'executed', proofDigest: digest('d') },
    conclusion: { status: 'supported', gateEligible: options.gateEligible ?? true, reasonCodes: [] },
    proofDigest: options.proofDigest ?? digest('e'),
  }
}
