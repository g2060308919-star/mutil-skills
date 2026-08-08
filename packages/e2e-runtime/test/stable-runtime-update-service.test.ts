import { describe, expect, test, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStableRuntimeResolver } from '../src/stable-runtime-update-service.js'
import type { SignedRuntimeTarget, TrustedMetadataSet } from '../src/runtime-update-trust.js'
import { createRuntimeTestRoots } from './fixtures.js'

const D = (character: string) => `sha256:${character.repeat(64)}`
const NOW = new Date('2026-08-09T00:00:00.000Z')

describe('生产 stable Runtime 更新服务', () => {
  test('串行执行 TUF refresh/download-install/doctor/canary，并返回可供 Resolver 复验的绑定', async () => {
    const roots = await createRuntimeTestRoots()
    const order: string[] = []
    const stable = createStableRuntimeResolver({
      homeDir: roots.home, enabled: true, trustedRootPath: '/reviewed/root.json',
      metadataBaseUrl: 'https://updates.example/metadata/', targetBaseUrl: 'https://registry.npmjs.org/',
      targetPath: 'stable/e2e-runtime-0.6.0.tgz', now: () => NOW, environment: environment(),
      clientFactory: () => ({ refresh: async () => { order.push('refresh'); return { metadata: metadata(), target: target() } } }),
      installCandidate: async (signedTarget) => { order.push('install'); return {
        runtimeVersion: signedTarget.custom.runtimeVersion, installationDigest: D('3'), contentDigest: D('1'),
        executableDigest: D('2'), npmIntegrity: signedTarget.custom.npmIntegrity,
      } },
      doctor: async () => { order.push('doctor') }, canary: async () => { order.push('canary') },
    })

    await expect(stable()).resolves.toEqual({
      runtimeVersion: '0.6.0', installationDigest: D('3'), revocationStatus: 'revocation-checked',
    })
    expect(order).toEqual(['refresh', 'install', 'doctor', 'canary'])
  })

  test('同一 HOME 的并发 update 被独占锁阻断，避免两个 default/LKG 事务交错', async () => {
    const roots = await createRuntimeTestRoots()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const client = { refresh: vi.fn(async () => { await pending; return { metadata: metadata(), target: target() } }) }
    const options = {
      homeDir: roots.home, enabled: true, trustedRootPath: '/reviewed/root.json',
      metadataBaseUrl: 'https://updates.example/metadata/', targetBaseUrl: 'https://registry.npmjs.org/',
      targetPath: 'stable/e2e-runtime-0.6.0.tgz', now: () => NOW, environment: environment(),
      clientFactory: () => client,
      installCandidate: async () => ({ runtimeVersion: '0.6.0', installationDigest: D('3'), contentDigest: D('1'),
        executableDigest: D('2'), npmIntegrity: target().custom.npmIntegrity }),
      doctor: async () => undefined, canary: async () => undefined,
    }
    const first = createStableRuntimeResolver(options)()
    await vi.waitFor(() => expect(client.refresh).toHaveBeenCalledOnce())
    await expect(createStableRuntimeResolver(options)()).rejects.toThrow(/E2E_RUNTIME_UPDATE_LOCKED/)
    release()
    await expect(first).resolves.toMatchObject({ runtimeVersion: '0.6.0' })
  })

  test('崩溃遗留且可证明 PID 已死亡的私有 update lock 会被安全回收', async () => {
    const roots = await createRuntimeTestRoots()
    const stateDirectory = join(roots.home, '.mutil-skills/e2e/state')
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    await writeFile(join(stateDirectory, 'runtime-update.lock'), JSON.stringify({
      schemaVersion: '1.0.0', ownerUid: process.getuid!(), pid: 2_147_483_647, nonce: 'a'.repeat(64),
    }), { mode: 0o600 })
    const stable = createStableRuntimeResolver({
      homeDir: roots.home, enabled: true, trustedRootPath: '/reviewed/root.json',
      metadataBaseUrl: 'https://updates.example/metadata/', targetBaseUrl: 'https://registry.npmjs.org/',
      targetPath: 'stable/e2e-runtime-0.6.0.tgz', now: () => NOW, environment: environment(),
      clientFactory: () => ({ refresh: async () => ({ metadata: metadata(), target: target() }) }),
      installCandidate: async () => ({ runtimeVersion: '0.6.0', installationDigest: D('3'), contentDigest: D('1'),
        executableDigest: D('2'), npmIntegrity: target().custom.npmIntegrity }),
      doctor: async () => undefined, canary: async () => undefined,
    })
    await expect(stable()).resolves.toMatchObject({ runtimeVersion: '0.6.0' })
  })
})

function metadata(): TrustedMetadataSet {
  return Object.fromEntries(['root', 'timestamp', 'snapshot', 'targets'].map((role, index) => [role, {
    version: 1, digest: D(String(index + 4)), expires: '2027-08-09T00:00:00.000Z',
  }])) as TrustedMetadataSet
}

function target(): SignedRuntimeTarget {
  return {
    name: 'stable/e2e-runtime-0.6.0.tgz', length: 1024,
    hashes: { sha512: Buffer.alloc(64, 1).toString('hex') }, custom: {
      schemaVersion: '1.0.0', packageName: '@mutil-skills/e2e-runtime', runtimeVersion: '0.6.0', protocolMajor: 1,
      channel: 'stable', npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      registryUrl: 'https://registry.npmjs.org/@mutil-skills/e2e-runtime/-/e2e-runtime-0.6.0.tgz',
      contentDigest: D('1'), executableDigest: D('2'), installationDigest: D('3'),
      supportedNode: [{ major: 22, minimumPatch: '22.13.0' }],
      supportedPlatforms: [{ platform: 'darwin', arch: 'arm64' }], minimumBootstrapVersion: '0.6.0',
      revoked: false, revocationReasonCode: null,
    },
  }
}

function environment() {
  return { channel: 'stable' as const, nodeVersion: '22.13.0', platform: 'darwin' as const, arch: 'arm64' as const,
    protocolMajor: 1, bootstrapVersion: '0.6.0', allowedRegistryOrigins: ['https://registry.npmjs.org'] }
}
