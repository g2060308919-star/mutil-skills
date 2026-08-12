import { describe, expect, test } from 'vitest'
import * as runtime from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('createSupportedHostProof', () => {
  test('只有 Chrome、隔离、Gateway 与公开旅程全部实际执行才产生 gateEligible proof', () => {
    const create = (runtime as Record<string, unknown>).createSupportedHostProof as (input: unknown) => {
      conclusion: { gateEligible: boolean; status: string }
      proofDigest: string
    }
    expect(create).toBeTypeOf('function')
    const result = create(input())
    expect(result.conclusion).toEqual({ status: 'supported', gateEligible: true, reasonCodes: [] })
    expect(result.proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('缺失能力时保留原因并禁止形成支持声明', () => {
    const create = (runtime as Record<string, unknown>).createSupportedHostProof as (input: unknown) => {
      conclusion: { gateEligible: boolean; status: string; reasonCodes: string[] }
    }
    expect(create).toBeTypeOf('function')
    const value = input()
    value.capabilities.gatewayCanary.status = 'not-executed'
    value.capabilities.gatewayCanary.reasonCode = 'E2E_HOST_GATEWAY_CANARY_NOT_PROBED'
    const result = create(value)
    expect(result.conclusion).toEqual({
      status: 'unverified', gateEligible: false,
      reasonCodes: ['E2E_HOST_GATEWAY_CANARY_NOT_PROBED'],
    })
  })
})

function input() {
  const capability = (character: string, reasonCode: string): {
    status: 'executed' | 'not-executed'
    reasonCode: string
    proofDigest: string
  } => ({
    status: 'executed', reasonCode, proofDigest: digest(character),
  })
  return {
    host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.18.0' },
    chrome: {
      channel: 'chrome' as const, version: '140.0.7339.1', source: 'system-chrome' as const,
      executableDigest: digest('a'), capability: capability('b', 'E2E_HOST_BROWSER_EXECUTED'),
    },
    capabilities: {
      sandbox: capability('c', 'E2E_HOST_SANDBOX_EXECUTED'),
      loopback: capability('d', 'E2E_HOST_LOOPBACK_EXECUTED'),
      process: capability('e', 'E2E_HOST_PROCESS_EXECUTED'),
      filesystem: capability('f', 'E2E_HOST_FILESYSTEM_EXECUTED'),
      profileIsolation: capability('1', 'E2E_HOST_PROFILE_EXECUTED'),
      gatewayCanary: capability('2', 'E2E_HOST_GATEWAY_CANARY_EXECUTED'),
    },
    executionEntry: { kind: 'public-full-journey' as const, status: 'executed' as const, proofDigest: digest('3') },
  }
}
