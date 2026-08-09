import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  BoundedOriginFetcher,
  TufRuntimeUpdateClient,
  readRuntimeUpdateState,
  writeRuntimeUpdateState,
  type TufUpdaterLike,
} from '../src/tuf-runtime-update-client.js'
import { createRuntimeTestRoots } from './fixtures.js'

const D = (character: string) => `sha256:${character.repeat(64)}`
const ROOT = JSON.stringify({ signed: { _type: 'root', version: 1, expires: '2027-08-09T00:00:00Z' } })

function custom() {
  return {
    schemaVersion: '1.0.0', packageName: '@mutil-skills/e2e-runtime', runtimeVersion: '0.6.0',
    protocolMajor: 1, channel: 'stable', npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    registryUrl: 'https://registry.npmjs.org/@mutil-skills/e2e-runtime/-/e2e-runtime-0.6.0.tgz',
    contentDigest: D('1'), executableDigest: D('2'), installationDigest: D('3'),
    supportedNode: [{ major: 22, minimumPatch: '22.13.0' }],
    supportedPlatforms: [{ platform: 'darwin', arch: 'arm64' }], minimumBootstrapVersion: '0.6.0',
    revoked: false, revocationReasonCode: null,
  }
}

describe('官方 tuf-js Runtime 更新适配层', () => {
  test('从内置 root 引导缓存，刷新后投影严格 target 与四角色高水位', async () => {
    const roots = await createRuntimeTestRoots()
    const trustedRootPath = join(roots.source, 'root.json')
    await writeFile(trustedRootPath, ROOT)
    let updaterOptions: Record<string, unknown> | undefined
    const targetInfo = { path: '@mutil-skills/e2e-runtime/-/e2e-runtime-0.6.0.tgz', length: 7,
      hashes: { sha512: Buffer.alloc(64, 1).toString('hex') }, custom: custom() }
    const factory = vi.fn((options: Record<string, unknown>): TufUpdaterLike => {
      updaterOptions = options
      return {
        refresh: async () => {
          for (const [role, version, expires] of [
            ['root', 1, '2027-08-09T00:00:00Z'], ['timestamp', 2, '2026-08-10T00:00:00Z'],
            ['snapshot', 3, '2026-08-16T00:00:00Z'], ['targets', 4, '2026-09-08T00:00:00Z'],
          ] as const) await writeFile(join(options.metadataDir as string, `${role}.json`),
            JSON.stringify({ signed: { _type: role, version, expires } }))
        },
        getTargetInfo: async () => targetInfo,
        downloadTarget: async (_target, filePath) => {
          if (filePath === undefined) throw new Error('test requires an explicit target path')
          await writeFile(filePath, 'tarball')
          return filePath
        },
      }
    })
    const client = new TufRuntimeUpdateClient({
      homeDir: roots.home, trustedRootPath, metadataBaseUrl: 'https://updates.example/metadata/',
      targetBaseUrl: 'https://registry.npmjs.org/',
      targetPath: '@mutil-skills/e2e-runtime/-/e2e-runtime-0.6.0.tgz', updaterFactory: factory,
    })

    const refreshed = await client.refresh()
    expect(refreshed.target).toMatchObject({ name: targetInfo.path, custom: { runtimeVersion: '0.6.0' } })
    expect(refreshed.metadata).toMatchObject({ root: { version: 1 }, timestamp: { version: 2 },
      snapshot: { version: 3 }, targets: { version: 4 } })
    expect(await readFile(join(updaterOptions!.metadataDir as string, 'root.json'), 'utf8')).toBe(ROOT)
    expect((await stat(updaterOptions!.metadataDir as string)).mode & 0o777).toBe(0o700)
    expect(updaterOptions).toMatchObject({ config: { maxRootRotations: 32, fetchTimeout: 30_000,
      rootMaxLength: 512_000, timestampMaxLength: 16_384, snapshotMaxLength: 2_000_000,
      targetsMaxLength: 5_000_000 } })

    const downloaded = await client.downloadTarget(refreshed.target)
    expect(await readFile(downloaded, 'utf8')).toBe('tarball')
    expect((await stat(downloaded)).mode & 0o777).toBe(0o600)
  })

  test('拒绝 custom registry URL 与实际 TUF target URL 不一致', async () => {
    const roots = await createRuntimeTestRoots()
    const trustedRootPath = join(roots.source, 'root.json')
    await writeFile(trustedRootPath, ROOT)
    const factory = (): TufUpdaterLike => ({
      refresh: async () => {
        for (const role of ['root', 'timestamp', 'snapshot', 'targets'] as const) {
          await writeFile(join(roots.home, '.mutil-skills/e2e/state/runtime-update/metadata', `${role}.json`),
            JSON.stringify({ signed: { _type: role, version: 1, expires: '2027-08-09T00:00:00Z' } }))
        }
      },
      getTargetInfo: async () => ({
        path: 'different/runtime.tgz', length: 7, hashes: { sha512: Buffer.alloc(64, 1).toString('hex') }, custom: custom(),
      }),
      downloadTarget: async () => { throw new Error('must not download') },
    })
    await expect(new TufRuntimeUpdateClient({
      homeDir: roots.home, trustedRootPath, metadataBaseUrl: 'https://updates.example/metadata/',
      targetBaseUrl: 'https://registry.npmjs.org/', targetPath: 'different/runtime.tgz', updaterFactory: factory,
    }).refresh()).rejects.toThrow(/E2E_RUNTIME_UPDATE_TARGET_URL_MISMATCH/)
  })

  test('更新状态以当前用户 0600 普通文件原子保存，损坏或 symlink 状态 fail closed', async () => {
    const roots = await createRuntimeTestRoots()
    const state = {
      schemaVersion: '1.0.0' as const, highwaterWallClock: '2026-08-09T00:00:00.000Z',
      metadata: Object.fromEntries(['root', 'timestamp', 'snapshot', 'targets'].map((role, index) =>
        [role, { version: index + 1, digest: D(String(index + 4)), expires: '2027-08-09T00:00:00.000Z' }])) as never,
      verifiedTargets: [], newRunDefault: null, lkg: null, audit: [],
    }
    await writeRuntimeUpdateState(roots.home, state)
    expect(await readRuntimeUpdateState(roots.home)).toEqual(state)
    const statePath = join(roots.home, '.mutil-skills', 'e2e', 'state', 'runtime-update.json')
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)

    await chmod(statePath, 0o644)
    await expect(readRuntimeUpdateState(roots.home)).rejects.toThrow(/E2E_RUNTIME_UPDATE_STATE_UNSAFE/)
    await chmod(statePath, 0o600)
    await writeFile(statePath, '{}')
    await expect(readRuntimeUpdateState(roots.home)).rejects.toThrow(/E2E_RUNTIME_UPDATE_STATE_INVALID/)
  })

  test('不允许 HTTP metadata/target base URL 或越界 target path', async () => {
    const roots = await createRuntimeTestRoots()
    await expect(new TufRuntimeUpdateClient({
      homeDir: roots.home, trustedRootPath: '/root.json', metadataBaseUrl: 'http://updates.example/',
      targetBaseUrl: 'https://registry.npmjs.org/', targetPath: '../escape.tgz',
    }).refresh()).rejects.toThrow(/E2E_RUNTIME_UPDATE_CLIENT_CONFIG_INVALID/)
  })

  test('网络层拒绝跨 origin 重定向，并限制为三次 HTTPS 重定向', async () => {
    const deniedFetch = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://evil.example/metadata.json' },
    }))
    const denied = new BoundedOriginFetcher(['https://updates.example'], deniedFetch)
    await expect(denied.fetch('https://updates.example/timestamp.json'))
      .rejects.toThrow(/E2E_RUNTIME_UPDATE_FETCH_ORIGIN_DENIED/)

    let count = 0
    const loopingFetch = vi.fn(async () => {
      count += 1
      return new Response(null, { status: 302, headers: { location: `/redirect-${count}` } })
    })
    const looping = new BoundedOriginFetcher(['https://updates.example'], loopingFetch)
    await expect(looping.fetch('https://updates.example/start'))
      .rejects.toThrow(/E2E_RUNTIME_UPDATE_FETCH_REDIRECT_LIMIT/)
    expect(loopingFetch).toHaveBeenCalledTimes(4)
  })
})
