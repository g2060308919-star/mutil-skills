import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { installRuntime } from '../src/runtime-installer.js'
import { runtimeLayout } from '../src/runtime-layout.js'
import { uninstallRuntime } from '../src/runtime-uninstaller.js'
import { resolveRuntimeInstallation, withResolvedRuntimeInstallation } from '../src/runtime-resolver.js'
import { writeRuntimeUpdateState } from '../src/tuf-runtime-update-client.js'
import { createRuntimeTestRoots } from './fixtures.js'

describe('Runtime Resolver offline / pinned', () => {
  test('offline 对新 Run 只复用当前已验证本地版本并固化 installation digest', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.5.2', 'baseline')
    const currentBefore = await readFile(runtimeLayout(roots.home).current, 'utf8')

    const result = await resolveRuntimeInstallation({ homeDir: roots.home, policy: { mode: 'offline' } })

    expect(result).toMatchObject({
      selectionKind: 'new-run', policyMode: 'offline',
      installation: { version: '0.5.2', sourceRepositoryIndependent: true },
      runBinding: { runtimeVersion: '0.5.2' },
    })
    expect(result.runBinding.installationDigest).toBe(result.installation.installationDigest)
    expect(result.selectionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(await readFile(runtimeLayout(roots.home).current, 'utf8')).toBe(currentBefore)
  })

  test('pinned 选择精确本地版本和可选摘要，且不移动 current pointer', async () => {
    const roots = await createRuntimeTestRoots()
    const old = await installFixture(roots.source, roots.home, '0.5.2', 'old')
    await installFixture(roots.source, roots.home, '0.5.3', 'current')
    const currentBefore = await readFile(runtimeLayout(roots.home).current, 'utf8')

    const result = await resolveRuntimeInstallation({
      homeDir: roots.home,
      policy: { mode: 'pinned', version: '0.5.2', installationDigest: old.installationDigest },
    })
    expect(result).toMatchObject({
      selectionKind: 'new-run', policyMode: 'pinned',
      installation: { version: '0.5.2', installationDigest: old.installationDigest },
    })
    expect(await readFile(runtimeLayout(roots.home).current, 'utf8')).toBe(currentBefore)

    await expect(resolveRuntimeInstallation({
      homeDir: roots.home,
      policy: { mode: 'pinned', version: '0.5.2', installationDigest: result.installation.installationDigest
        .replace(/.$/, result.installation.installationDigest.endsWith('0') ? '1' : '0') },
    })).rejects.toThrow(/E2E_RUNTIME_PINNED_DIGEST_MISMATCH/)
  })

  test('已有 Run 忽略新 Run policy，只按原 installation digest 定位并拒绝缺失闭包', async () => {
    const roots = await createRuntimeTestRoots()
    const original = await installFixture(roots.source, roots.home, '0.5.2', 'original')
    await installFixture(roots.source, roots.home, '0.5.3', 'new-default')

    const result = await resolveRuntimeInstallation({
      homeDir: roots.home,
      policy: { mode: 'pinned', version: '0.5.3' },
      existingRun: { runId: 'RUN-1', installationDigest: original.installationDigest },
    })
    expect(result).toMatchObject({
      selectionKind: 'existing-run', policyMode: 'run-bound',
      installation: { version: '0.5.2', installationDigest: original.installationDigest },
      runBinding: { runtimeVersion: '0.5.2', installationDigest: original.installationDigest },
    })

    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'offline' },
      existingRun: { runId: 'RUN-MISSING', installationDigest: `sha256:${'f'.repeat(64)}` },
    })).rejects.toThrow(/E2E_RUNTIME_RUN_INSTALLATION_UNAVAILABLE/)
  })

  test('stable 无服务时阻断，拒绝 latest 和非精确 pinned，不执行隐式安装', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.5.2', 'baseline')
    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'stable' } as never,
    })).rejects.toThrow(/E2E_RUNTIME_STABLE_UPDATE_UNAVAILABLE/)
    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'pinned', version: '^0.5.2' },
    })).rejects.toThrow(/E2E_RUNTIME_RESOLVER_POLICY_INVALID|E2E_RUNTIME_VERSION_INVALID/)
  })

  test('stable 只对新 Run 调用签名更新服务，并在安装锁内复验其精确 closure 身份', async () => {
    const roots = await createRuntimeTestRoots()
    const installed = await installFixture(roots.source, roots.home, '0.6.0', 'signed-stable')
    const stableResolver = async () => ({
      runtimeVersion: '0.6.0', installationDigest: installed.installationDigest,
      revocationStatus: 'revocation-checked' as const,
    })
    const result = await resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'stable' }, stableResolver,
    })
    expect(result).toMatchObject({
      selectionKind: 'new-run', policyMode: 'stable',
      installation: { version: '0.6.0', installationDigest: installed.installationDigest },
      revocationStatus: 'revocation-checked',
    })

    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'stable' },
    })).rejects.toThrow(/E2E_RUNTIME_STABLE_UPDATE_UNAVAILABLE/)
    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'latest' } as never, stableResolver,
    })).rejects.toThrow(/E2E_RUNTIME_RESOLVER_POLICY_INVALID/)
  })

  test('已有 Run 不调用 stable 更新服务，并报告离线未检查最新撤销', async () => {
    const roots = await createRuntimeTestRoots()
    const original = await installFixture(roots.source, roots.home, '0.5.2', 'run-bound')
    let called = false
    const result = await resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'stable' },
      existingRun: { runId: 'RUN-STABLE-IGNORED', installationDigest: original.installationDigest },
      stableResolver: async () => { called = true; throw new Error('must not run') },
    })
    expect(called).toBe(false)
    expect(result).toMatchObject({ policyMode: 'run-bound', revocationStatus: 'offline-unchecked' })
  })

  test.each([
    ['revocation-checked', 'revocation-checked'],
    ['metadata-expired', 'metadata-expired'],
    ['offline-unchecked', 'offline-unchecked'],
  ] as const)('已有 Run 保留撤销检查状态 %s', async (status, expected) => {
    const roots = await createRuntimeTestRoots()
    const original = await installFixture(roots.source, roots.home, '0.5.2', status)
    const result = await resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'offline' },
      existingRun: { runId: 'RUN-CHECKED', installationDigest: original.installationDigest },
      existingRunRevocationChecker: async () => ({ status, revoked: false }),
    })
    expect(result.revocationStatus).toBe(expected)
  })

  test('已有 Run 命中可信撤销事实时安全阻断', async () => {
    const roots = await createRuntimeTestRoots()
    const original = await installFixture(roots.source, roots.home, '0.5.2', 'revoked')
    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy: { mode: 'offline' },
      existingRun: { runId: 'RUN-REVOKED', installationDigest: original.installationDigest },
      existingRunRevocationChecker: async () => ({
        status: 'revocation-checked', revoked: true, reasonCode: 'EMERGENCY-REVOKED',
      }),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_RUN_INSTALLATION_REVOKED', category: 'safety' })
  })

  test.each([
    { mode: 'offline' as const },
    { mode: 'pinned' as const, version: '0.5.2' },
  ])('$mode 新 Run 也必须拒绝本地已知撤销的 closure', async (policy) => {
    const roots = await createRuntimeTestRoots()
    const original = await installFixture(roots.source, roots.home, '0.5.2', `revoked-${policy.mode}`)
    await expect(resolveRuntimeInstallation({
      homeDir: roots.home, policy,
      existingRunRevocationChecker: async ({ installationDigest }) => ({
        status: 'revocation-checked',
        revoked: installationDigest === original.installationDigest,
        reasonCode: 'EMERGENCY-REVOKED',
      }),
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_INSTALLATION_REVOKED', category: 'safety' })
  })

  test('调用方不注入 checker 时也必须读取 HOME 中持久化的撤销 tombstone', async () => {
    const roots = await createRuntimeTestRoots()
    const original = await installFixture(roots.source, roots.home, '0.5.2', 'persisted-revocation')
    await writeRuntimeUpdateState(roots.home, {
      schemaVersion: '1.1.0', highwaterWallClock: '2026-08-09T00:00:00.000Z',
      metadata: { root: role('1'), timestamp: role('2'), snapshot: role('3'), targets: role('4') },
      verifiedTargets: [], revocations: [{ runtimeVersion: '0.5.2',
        installationDigest: original.installationDigest, reasonCode: 'EMERGENCY-REVOKED',
        targetsMetadataVersion: 1, observedAt: '2026-08-09T00:00:00.000Z' }],
      revocationOverflow: null, newRunDefault: null, lkg: null, audit: [],
    })

    await expect(resolveRuntimeInstallation({ homeDir: roots.home, policy: { mode: 'offline' } }))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_INSTALLATION_REVOKED', category: 'safety' })
    await expect(resolveRuntimeInstallation({ homeDir: roots.home, policy: { mode: 'offline' },
      existingRun: { runId: 'RUN-PERSISTED-REVOKED', installationDigest: original.installationDigest } }))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_RUN_INSTALLATION_REVOKED', category: 'safety' })
  })

  test('在同一安装锁内完成解析和 Run 绑定，阻断解析与固化之间的卸载竞态', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.5.2', 'selected')
    await installFixture(roots.source, roots.home, '0.5.3', 'current')
    const layout = runtimeLayout(roots.home)

    const result = await withResolvedRuntimeInstallation({
      homeDir: roots.home,
      policy: { mode: 'pinned', version: '0.5.2' },
    }, async (resolution) => {
      expect((await stat(layout.installLock)).isFile()).toBe(true)
      await expect(uninstallRuntime({ homeDir: roots.home, version: '0.5.2' }))
        .rejects.toThrow(/E2E_RUNTIME_INSTALL_LOCKED/)
      return { persistedDigest: resolution.runBinding.installationDigest }
    })

    expect(result.persistedDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    await expect(stat(layout.installLock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('同进程并发新 Run 解析按安装锁安全排队而不是随机失败', async () => {
    const roots = await createRuntimeTestRoots()
    const installed = await installFixture(roots.source, roots.home, '0.5.2', 'concurrent-resolution')

    const results = await Promise.all(Array.from({ length: 32 }, async () =>
      await resolveRuntimeInstallation({
        homeDir: roots.home,
        policy: { mode: 'offline' },
        existingRunRevocationChecker: async () => ({ status: 'revocation-checked', revoked: false }),
      })))

    expect(new Set(results.map((item) => item.installation.installationDigest)))
      .toEqual(new Set([installed.installationDigest]))
    expect(results.every((item) => item.revocationStatus === 'revocation-checked')).toBe(true)
  })
})

function role(character: string) {
  return { version: 1, digest: `sha256:${character.repeat(64)}`, expires: '2027-08-09T00:00:00.000Z' }
}

async function installFixture(sourceRoot: string, homeDir: string, version: string, body: string) {
  const source = join(sourceRoot, `${version}-${body}`)
  const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@mutil-skills/e2e-runtime', version,
  }))
  await writeFile(join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'), `#!/usr/bin/env node\n// ${body}\n`)
  return await installRuntime({
    homeDir, version,
    installClosure: async ({ stagingPrefix }) => {
      const { cp } = await import('node:fs/promises')
      await cp(source, stagingPrefix, { recursive: true })
    },
  })
}
