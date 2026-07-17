import { expect, test, vi } from 'vitest'
import {
  parseAuthorityExecutionHostConfig,
  parseAuthorityExecutionIncomingEnvelope,
} from '../src/authority-execution-rpc-host-ipc.js'

const key = Buffer.alloc(32, 7).toString('base64url')
const asset = Buffer.from('asset').toString('base64url')
const config = {
  rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
  approval: {
    issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
    stateEncryptionKeyBase64Url: key, testWorkspaceRoots: ['/runtime'],
    expectedStateDirectory: { realPath: '/state', device: '1', inode: '2' },
    approvalIdentities: [{ subject: 'local:user', roles: ['e2e-approver'] }],
  },
  lease: {
    statePath: 'lease.sqlite', testWorkspaceRoots: ['/runtime'],
    expectedStateDirectory: { realPath: '/state', device: '1', inode: '2' },
  },
  userPresence: {
    installationDigest: `sha256:${'a'.repeat(64)}`, ttlMs: 60_000,
    assets: {
      indexHtmlBase64Url: asset, approvalJavaScriptBase64Url: asset,
      simpleWebAuthnBrowserBase64Url: asset,
    },
  },
  clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  sessionKeyBase64Url: key,
}

test('Authority child config parser accepts only the complete strict IPC shape', () => {
  expect(parseAuthorityExecutionHostConfig(config)).toEqual(config)
  expect(() => parseAuthorityExecutionHostConfig({ ...config, extra: true })).toThrow()
  expect(() => parseAuthorityExecutionHostConfig({
    ...config, rpc: { ...config.rpc, extra: true },
  })).toThrow()
  expect(() => parseAuthorityExecutionHostConfig({
    ...config, approval: { ...config.approval, stateEncryptionKeyBase64Url: `${key}=` },
  })).toThrow()
  expect(() => parseAuthorityExecutionHostConfig({
    ...config, lease: { ...config.lease, expectedStateDirectory: {
      ...config.lease.expectedStateDirectory, device: 'not-a-device',
    } },
  })).toThrow()
  expect(() => parseAuthorityExecutionHostConfig({
    ...config, clock: { kind: 'system', now: config.clock.now },
  })).toThrow()
  expect(() => parseAuthorityExecutionHostConfig({
    ...config,
    approval: { ...config.approval, testWorkspaceRoots: ['/runtime', '/runtime'] },
  })).toThrow()
})

test('Authority child accepts only exact incoming IPC envelopes', () => {
  const requestId = 'a'.repeat(32)
  expect(parseAuthorityExecutionIncomingEnvelope({
    type: 'recover-approval', requestId, input: {},
  })).toBeDefined()
  expect(parseAuthorityExecutionIncomingEnvelope({
    type: 'recover-approval', requestId, input: {}, extra: true,
  })).toBeUndefined()
  expect(parseAuthorityExecutionIncomingEnvelope({
    type: 'shutdown', requestId, input: {},
  })).toBeUndefined()
  expect(parseAuthorityExecutionIncomingEnvelope({
    type: 'start', config, requestId,
  })).toBeUndefined()
  expect(parseAuthorityExecutionIncomingEnvelope({
    type: 'unknown-control', requestId, input: {},
  })).toBeUndefined()
})

test('Authority child config parser zeroizes every temporary secret-key Buffer', () => {
  const fill = vi.spyOn(Buffer.prototype, 'fill')
  try {
    expect(parseAuthorityExecutionHostConfig(config)).toEqual(config)
    expect(fill).toHaveBeenCalledTimes(2)
    for (const buffer of fill.mock.instances) expect([...buffer]).toEqual(new Array(32).fill(0))

    fill.mockClear()
    expect(() => parseAuthorityExecutionHostConfig({
      ...config,
      approval: { ...config.approval, stateEncryptionKeyBase64Url: `${key}=` },
    })).toThrow()
    expect(fill).toHaveBeenCalledOnce()
    expect([...fill.mock.instances[0]!]).toEqual(new Array(32).fill(0))
  } finally {
    fill.mockRestore()
  }
})
