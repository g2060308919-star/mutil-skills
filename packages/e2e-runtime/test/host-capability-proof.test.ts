import { describe, expect, test } from 'vitest'
import {
  assertRequiredHostCapabilities,
  probeHostCapabilities,
  type HostCapabilityOperations,
  type HostCapabilityProof,
} from '../src/host-capability-proof.js'

describe('HostCapabilityProof', () => {
  test('executes injected host adapters and binds their facts into a proof', async () => {
    const proof = await probeHostCapabilities({
      operations: operations({
        loopback: async () => ({ endpointClass: 'ipv4-loopback' }),
        process: async () => ({ childExitCode: 0 }),
      filesystem: async () => ({ posixMode: '0700/0600', hardlinkChecked: true }),
        sandbox: async () => ({ backend: 'test-sandbox' }),
      }),
      environment: { platform: 'test', arch: 'test', node: 'v24.0.0' },
    })
    expect(proof.capabilities).toMatchObject({
      loopback: { status: 'executed', reasonCode: 'E2E_HOST_LOOPBACK_EXECUTED' },
      process: { status: 'executed', reasonCode: 'E2E_HOST_PROCESS_EXECUTED' },
      filesystem: { status: 'executed', reasonCode: 'E2E_HOST_FILESYSTEM_EXECUTED' },
    })
    expect(proof.proofDigest).toMatch(/^sha256:/)
    expect(() => assertRequiredHostCapabilities(proof, ['loopback', 'process', 'filesystem']))
      .not.toThrow()
  })

  test('classifies unsupported host capabilities separately from business failures', async () => {
    const proof = await probeHostCapabilities({
      operations: operations({
        loopback: async () => { throw unavailable('E2E_HOST_LOOPBACK_UNAVAILABLE') },
      }),
      environment: { platform: 'restricted', arch: 'test', node: 'v24.0.0' },
    })
    expect(proof.capabilities.loopback).toMatchObject({
      status: 'unsupported', reasonCode: 'E2E_HOST_LOOPBACK_UNAVAILABLE',
    })
    expect(proof.capabilities.browser).toMatchObject({
      status: 'not-executed', reasonCode: 'E2E_HOST_BROWSER_NOT_PROBED',
    })
  })

  test('required capability fails for unsupported, failed, or not-executed results', () => {
    for (const status of ['unsupported', 'failed', 'not-executed'] as const) {
      const proof = proofFixture(status)
      expect(() => assertRequiredHostCapabilities(proof, ['loopback']))
        .toThrowError(expect.objectContaining({ code: 'E2E_HOST_CAPABILITY_NOT_EXECUTED' }))
    }
  })
})

function operations(overrides: Partial<HostCapabilityOperations>): HostCapabilityOperations {
  return {
    loopback: undefined,
    process: undefined,
    filesystem: undefined,
    browser: undefined,
    profile: undefined,
    sandbox: undefined,
    gatewayCanary: undefined,
    ...overrides,
  }
}

function unavailable(code: string): Error {
  return Object.assign(new Error(code), { code, capabilityUnavailable: true })
}

function proofFixture(
  status: 'unsupported' | 'failed' | 'not-executed',
): HostCapabilityProof {
  return {
    schemaVersion: '1.0.0',
    environment: { platform: 'test', arch: 'test', node: 'v24.0.0' },
    capabilities: {
      loopback: { status, reasonCode: 'E2E_HOST_LOOPBACK_UNAVAILABLE', proofDigest: `sha256:${'a'.repeat(64)}` },
      process: { status: 'executed', reasonCode: 'E2E_HOST_PROCESS_EXECUTED', proofDigest: `sha256:${'b'.repeat(64)}` },
      filesystem: { status: 'executed', reasonCode: 'E2E_HOST_FILESYSTEM_EXECUTED', proofDigest: `sha256:${'c'.repeat(64)}` },
      browser: { status: 'not-executed', reasonCode: 'E2E_HOST_BROWSER_NOT_PROBED', proofDigest: `sha256:${'d'.repeat(64)}` },
      profile: { status: 'not-executed', reasonCode: 'E2E_HOST_PROFILE_NOT_PROBED', proofDigest: `sha256:${'e'.repeat(64)}` },
      sandbox: { status: 'not-executed', reasonCode: 'E2E_HOST_SANDBOX_NOT_PROBED',
        proofDigest: `sha256:${'1'.repeat(64)}` },
      'gateway-canary': { status: 'not-executed', reasonCode: 'E2E_HOST_GATEWAY_CANARY_NOT_PROBED',
        proofDigest: `sha256:${'f'.repeat(64)}` },
    },
    proofDigest: `sha256:${'0'.repeat(64)}`,
  }
}
