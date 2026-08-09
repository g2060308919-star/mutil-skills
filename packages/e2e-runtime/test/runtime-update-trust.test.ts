import { describe, expect, test, vi } from 'vitest'
import {
  RuntimeUpdateError,
  advanceTrustedMetadata,
  applyStableRuntimeUpdate,
  validateRuntimeTarget,
  type RuntimeUpdateState,
  type SignedRuntimeTarget,
} from '../src/runtime-update-trust.js'

const NOW = new Date('2026-08-09T00:00:00.000Z')
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`

function target(overrides: Partial<SignedRuntimeTarget> = {}): SignedRuntimeTarget {
  return {
    name: '@mutil-skills/e2e-runtime-0.6.0.tgz',
    length: 1024,
    hashes: { sha512: Buffer.alloc(64, 1).toString('hex') },
    custom: {
      schemaVersion: '1.0.0',
      packageName: '@mutil-skills/e2e-runtime',
      runtimeVersion: '0.6.0',
      protocolMajor: 1,
      channel: 'stable',
      npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      registryUrl: 'https://registry.npmjs.org/@mutil-skills/e2e-runtime/-/e2e-runtime-0.6.0.tgz',
      contentDigest: DIGEST('1'),
      executableDigest: DIGEST('2'),
      installationDigest: DIGEST('3'),
      supportedNode: [{ major: 22, minimumPatch: '22.13.0' }, { major: 24, minimumPatch: '24.0.0' }],
      supportedPlatforms: [{ platform: 'darwin', arch: 'arm64' }, { platform: 'linux', arch: 'x64' }],
      minimumBootstrapVersion: '0.6.0',
      revoked: false,
      revocationReasonCode: null,
    },
    ...overrides,
  }
}

function metadata(version = 1, expires = '2026-08-10T00:00:00.000Z') {
  return {
    root: { version, digest: DIGEST('4'), expires: '2027-08-09T00:00:00.000Z' },
    timestamp: { version, digest: DIGEST('5'), expires },
    snapshot: { version, digest: DIGEST('6'), expires: '2026-08-16T00:00:00.000Z' },
    targets: { version, digest: DIGEST('7'), expires: '2026-09-08T00:00:00.000Z' },
  }
}

describe('签名 Runtime target 信任约束', () => {
  test('只接受被明确允许的 HTTPS registry、Node、平台、协议和 bootstrap', () => {
    expect(validateRuntimeTarget(target(), {
      channel: 'stable', nodeVersion: '22.13.0', platform: 'darwin', arch: 'arm64',
      protocolMajor: 1, bootstrapVersion: '0.6.0', allowedRegistryOrigins: ['https://registry.npmjs.org'],
    }).custom.runtimeVersion).toBe('0.6.0')

    expect(() => validateRuntimeTarget(target(), {
      channel: 'stable', nodeVersion: '26.0.0', platform: 'darwin', arch: 'arm64',
      protocolMajor: 1, bootstrapVersion: '0.6.0', allowedRegistryOrigins: ['https://registry.npmjs.org'],
    })).toThrow(/E2E_RUNTIME_UPDATE_NODE_UNSUPPORTED/)
    expect(() => validateRuntimeTarget(target({ custom: { ...target().custom, registryUrl: 'https://evil.example/runtime.tgz' } }), {
      channel: 'stable', nodeVersion: '22.13.0', platform: 'darwin', arch: 'arm64',
      protocolMajor: 1, bootstrapVersion: '0.6.0', allowedRegistryOrigins: ['https://registry.npmjs.org'],
    })).toThrow(/E2E_RUNTIME_UPDATE_ORIGIN_DENIED/)
  })

  test('撤销、未知字段和不完整 SHA-512 身份一律 fail closed', () => {
    expect(() => validateRuntimeTarget(target({ custom: {
      ...target().custom, revoked: true, revocationReasonCode: 'CVE-2026-0001',
    } }), environment())).toThrow(/E2E_RUNTIME_UPDATE_TARGET_REVOKED/)
    expect(() => validateRuntimeTarget({ ...target(), unexpected: true } as never, environment()))
      .toThrow(/E2E_RUNTIME_UPDATE_TARGET_INVALID/)
    expect(() => validateRuntimeTarget({ ...target(), hashes: { sha512: 'a'.repeat(64) } }, environment()))
      .toThrow(/E2E_RUNTIME_UPDATE_TARGET_INVALID/)
    expect(() => validateRuntimeTarget({
      ...target(),
      hashes: { sha512: 'b'.repeat(128) },
    }, environment())).toThrow(/E2E_RUNTIME_UPDATE_TARGET_INVALID/)
  })
})

describe('metadata 反回滚与防冻结状态', () => {
  test('原子推进角色高水位，并拒绝版本回滚、同版本摘要混搭和过期 metadata', () => {
    const first = advanceTrustedMetadata(undefined, metadata(2), NOW)
    expect(first.highwaterWallClock).toBe(NOW.toISOString())
    expect(first.metadata.timestamp.version).toBe(2)

    expect(() => advanceTrustedMetadata(first, metadata(1), NOW)).toThrow(/E2E_RUNTIME_UPDATE_METADATA_ROLLBACK/)
    expect(() => advanceTrustedMetadata(first, {
      ...metadata(2), timestamp: { ...metadata(2).timestamp, digest: DIGEST('8') },
    }, NOW)).toThrow(/E2E_RUNTIME_UPDATE_METADATA_MIX_AND_MATCH/)
    expect(() => advanceTrustedMetadata(first, metadata(2, '2026-08-08T23:59:59.000Z'), NOW))
      .toThrow(/E2E_RUNTIME_UPDATE_METADATA_EXPIRED/)
  })

  test('本机时钟相对可信高水位倒退超过五分钟时阻断', () => {
    const state = advanceTrustedMetadata(undefined, metadata(), NOW)
    expect(() => advanceTrustedMetadata(state, metadata(2), new Date('2026-08-08T23:54:59.999Z')))
      .toThrow(/E2E_RUNTIME_UPDATE_CLOCK_ROLLBACK/)
  })
})

describe('stable 安装、canary 与 LKG 事务', () => {
  test('canary 全绿后才把旧 default 留作 LKG，并原子提交新 default', async () => {
    let state: RuntimeUpdateState | undefined = {
      schemaVersion: '1.0.0', highwaterWallClock: NOW.toISOString(), metadata: metadata(),
      verifiedTargets: [], newRunDefault: { runtimeVersion: '0.5.2', installationDigest: DIGEST('9') },
      lkg: null, audit: [],
    }
    const save = vi.fn(async (next: RuntimeUpdateState) => { state = next })
    const result = await applyStableRuntimeUpdate({
      enabled: true, trustedRootPath: '/bootstrap/root.json', metadataBaseUrl: 'https://updates.example/',
      now: () => NOW, environment: environment(), loadState: async () => state, saveState: save,
      refresh: async () => ({ metadata: metadata(2), target: target() }),
      install: async () => ({ runtimeVersion: '0.6.0', installationDigest: DIGEST('3'),
        contentDigest: DIGEST('1'), executableDigest: DIGEST('2'), npmIntegrity: target().custom.npmIntegrity }),
      doctor: async () => undefined, canary: async () => undefined,
    })

    expect(result.status).toBe('activated')
    expect(state?.lkg).toEqual({ runtimeVersion: '0.5.2', installationDigest: DIGEST('9') })
    expect(state?.newRunDefault).toEqual({ runtimeVersion: '0.6.0', installationDigest: DIGEST('3') })
    expect(state?.audit.at(-1)).toMatchObject({ stage: 'activated', resultCode: 'OK' })
    expect(save).toHaveBeenCalled()
  })

  test('canary 失败时保留 metadata 防降级记忆，但不改变 default/LKG', async () => {
    const initial: RuntimeUpdateState = {
      schemaVersion: '1.0.0', highwaterWallClock: NOW.toISOString(), metadata: metadata(),
      verifiedTargets: [], newRunDefault: { runtimeVersion: '0.5.2', installationDigest: DIGEST('9') },
      lkg: null, audit: [],
    }
    let state: RuntimeUpdateState | undefined = initial
    await expect(applyStableRuntimeUpdate({
      enabled: true, trustedRootPath: '/bootstrap/root.json', metadataBaseUrl: 'https://updates.example/',
      now: () => NOW, environment: environment(), loadState: async () => state,
      saveState: async (next) => { state = next }, refresh: async () => ({ metadata: metadata(2), target: target() }),
      install: async () => ({ runtimeVersion: '0.6.0', installationDigest: DIGEST('3'),
        contentDigest: DIGEST('1'), executableDigest: DIGEST('2'), npmIntegrity: target().custom.npmIntegrity }),
      doctor: async () => undefined, canary: async () => { throw new Error('browser blocked') },
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_UPDATE_CANARY_FAILED' })
    expect(state?.metadata.timestamp.version).toBe(2)
    expect(state?.newRunDefault).toEqual(initial.newRunDefault)
    expect(state?.lkg).toBeNull()
  })

  test('target 已撤销或身份无效时仍先持久化已验签 metadata 高水位', async () => {
    let state: RuntimeUpdateState | undefined
    await expect(applyStableRuntimeUpdate({
      enabled: true, trustedRootPath: '/bootstrap/root.json', metadataBaseUrl: 'https://updates.example/',
      now: () => NOW, environment: environment(), loadState: async () => state,
      saveState: async (next) => { state = next },
      refresh: async () => ({ metadata: metadata(2), target: target({ custom: {
        ...target().custom, revoked: true, revocationReasonCode: 'EMERGENCY-REVOKED',
      } }) }),
      install: async () => { throw new Error('must not install') },
      doctor: async () => undefined, canary: async () => undefined,
    })).rejects.toThrow(/E2E_RUNTIME_UPDATE_TARGET_REVOKED/)
    expect(state?.metadata.timestamp.version).toBe(2)
  })

  test('没有经审核的内置 root 或 metadata origin 时不能启用 stable', async () => {
    await expect(applyStableRuntimeUpdate({
      enabled: true, trustedRootPath: '', metadataBaseUrl: '', now: () => NOW,
      environment: environment(), loadState: async () => undefined, saveState: async () => undefined,
      refresh: async () => { throw new Error('must not run') }, install: async () => { throw new Error('must not run') },
      doctor: async () => undefined, canary: async () => undefined,
    })).rejects.toBeInstanceOf(RuntimeUpdateError)
  })
})

function environment() {
  return {
    channel: 'stable' as const, nodeVersion: '22.13.0', platform: 'darwin' as const, arch: 'arm64' as const,
    protocolMajor: 1, bootstrapVersion: '0.6.0', allowedRegistryOrigins: ['https://registry.npmjs.org'],
  }
}
