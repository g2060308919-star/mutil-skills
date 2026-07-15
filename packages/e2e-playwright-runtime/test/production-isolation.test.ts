import { describe, expect, test } from 'vitest'
import {
  digestRuntimeIsolationPolicy,
  digestText,
  type RuntimeIsolationPolicy,
} from '@mutil-skills/e2e-contracts'
import {
  LocalRuntimeIsolationAuthority,
  createProductionWriteRuntimeSession,
  createTestWriteRuntimeSession,
  getWriteRuntimeSessionBinding,
  type RuntimeIsolationClaims,
} from '../src/index.js'

const NOW = new Date('2026-07-14T10:00:00.000Z')
const digest = (value: string) => digestText('production-isolation-test/v1', value)

function claims(): RuntimeIsolationClaims {
  return {
    schemaVersion: '1.0.0' as const,
    isolationSessionId: 'ISOLATION-1', runId: 'RUN-1', assetId: 'ASSET-1', generationId: 'GEN-1',
    prdRevision: digest('prd'), caseIds: ['CASE-1'],
    backend: { kind: 'linux-bwrap' as const, instanceId: 'BACKEND-1', version: '1.0.0' },
    identity: { dedicatedLowPrivilegeUser: true, uid: 65534, orchestratorUid: 501 },
    filesystem: { sourceDigest: digest('source'), sourceReadOnly: true, temporaryHome: true,
      hostCredentialsMounted: false },
    network: { defaultDeny: true, gatewayEndpoint: 'http://127.0.0.1:4100',
      allowedEndpoints: ['http://127.0.0.1:4100', 'http://127.0.0.1:4200', 'http://127.0.0.1:4300'],
      quicDisabled: true, remoteDebuggingDisabled: true },
    process: { arbitrarySubprocesses: false, allowedExecutableDigests: [digest('node')] },
    browser: { sandboxEnabled: true, ephemeralProfile: true, downloadsDisabled: true },
    limits: { cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, diskBytes: 128 * 1024 * 1024,
      wallTimeMs: 60_000 },
    authorityRpcPublicKeyDigest: digest('authority-rpc-key'),
    checkedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
  }
}

function expected() {
  const value = claims()
  const runtimeIsolationPolicy: RuntimeIsolationPolicy = {
    schemaVersion: '1.0.0', sourceDigest: value.filesystem.sourceDigest,
    allowedBackends: ['linux-bwrap'], gatewayEndpoint: value.network.gatewayEndpoint,
    allowedEndpoints: value.network.allowedEndpoints,
    allowedExecutableDigests: value.process.allowedExecutableDigests, limits: value.limits,
    authorityRpcPublicKeyDigest: value.authorityRpcPublicKeyDigest,
    isolationAuthorityPublicKeyDigest: digest('placeholder-isolation-key'),
  }
  return { runId: value.runId, assetId: value.assetId, generationId: value.generationId,
    prdRevision: value.prdRevision, caseIds: value.caseIds, runtimeIsolationPolicy,
    runtimeIsolationPolicyDigest: digestRuntimeIsolationPolicy(runtimeIsolationPolicy) }
}

describe('production write isolation attestation', () => {
  test('只有固定隔离 Authority 公钥签名的完整证明能创建生产运行会话', () => {
    const authority = LocalRuntimeIsolationAuthority.create({
      issuer: 'isolation-authority', keyId: 'isolation-key-1', now: () => NOW,
    })
    const attestation = authority.issue(claims())
    const material = authority.verifierMaterial
    const expectedBinding = expected()
    expectedBinding.runtimeIsolationPolicy.isolationAuthorityPublicKeyDigest = material.publicKeyDigest
    expectedBinding.runtimeIsolationPolicyDigest = digestRuntimeIsolationPolicy(expectedBinding.runtimeIsolationPolicy)
    const session = createProductionWriteRuntimeSession({ attestation, verifierMaterial: material,
      expectedPublicKeyDigest: material.publicKeyDigest, now: () => NOW,
      expected: expectedBinding })

    expect(getWriteRuntimeSessionBinding(session)).toMatchObject({ mode: 'production-isolated',
      sandboxHealthy: true, gatewayConnected: true,
      authorityRpcPublicKeyDigest: digest('authority-rpc-key') })
  })

  test('拒绝证明篡改、公钥替换、过期和任一 fail-open 隔离声明', () => {
    const first = LocalRuntimeIsolationAuthority.create({ issuer: 'isolation-authority',
      keyId: 'isolation-key-1', now: () => NOW })
    const second = LocalRuntimeIsolationAuthority.create({ issuer: 'other-authority',
      keyId: 'other-key', now: () => NOW })
    const attestation = first.issue(claims())
    const material = first.verifierMaterial
    const expectedBinding = expected()
    expectedBinding.runtimeIsolationPolicy.isolationAuthorityPublicKeyDigest = material.publicKeyDigest
    expectedBinding.runtimeIsolationPolicyDigest = digestRuntimeIsolationPolicy(expectedBinding.runtimeIsolationPolicy)
    const base = { verifierMaterial: material, expectedPublicKeyDigest: material.publicKeyDigest,
      expected: expectedBinding }

    expect(() => createProductionWriteRuntimeSession({ ...base, now: () => NOW,
      attestation: { ...attestation, network: { ...attestation.network, defaultDeny: false } } as any }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_ISOLATION_ATTESTATION_INVALID' }))
    expect(() => createProductionWriteRuntimeSession({ ...base, now: () => NOW,
      verifierMaterial: second.verifierMaterial, attestation }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_ISOLATION_MATERIAL_INVALID' }))
    expect(() => createProductionWriteRuntimeSession({ ...base,
      now: () => new Date(NOW.getTime() + 30_000), attestation }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_ISOLATION_ATTESTATION_EXPIRED' }))
    expect(() => first.issue({ ...claims(), identity: {
      dedicatedLowPrivilegeUser: false, uid: 501, orchestratorUid: 501,
    } } as any))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_ISOLATION_CLAIMS_INVALID' }))
    const endpointChangedPolicy = { ...expectedBinding.runtimeIsolationPolicy,
      gatewayEndpoint: 'http://127.0.0.1:4200' }
    expect(() => createProductionWriteRuntimeSession({ ...base, now: () => NOW, attestation,
      expected: { ...expectedBinding, runtimeIsolationPolicy: endpointChangedPolicy,
        runtimeIsolationPolicyDigest: digestRuntimeIsolationPolicy(endpointChangedPolicy) } }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_ISOLATION_ATTESTATION_BINDING_INVALID' }))
    expect(() => createProductionWriteRuntimeSession({ ...base, now: () => NOW, attestation,
      expected: { ...expectedBinding, runtimeIsolationPolicyDigest: digest('wrong-policy') } }))
      .toThrowError(expect.objectContaining({ code: 'E2E_RUNTIME_ISOLATION_POLICY_DIGEST_INVALID' }))
  })

  test('测试会话带明确 test-only 来源，普通结构对象没有可信语义', () => {
    const session = createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
      authorityTransport: 'in-process-test' })
    expect(getWriteRuntimeSessionBinding(session)).toEqual({ mode: 'test-only', sandboxHealthy: true,
      gatewayConnected: true, authorityTransport: 'in-process-test' })
    expect(getWriteRuntimeSessionBinding({ sandboxHealthy: true, gatewayConnected: true })).toBeUndefined()
  })
})
