import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { chmod, lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { inspectRuntimeInstallation } from '../src/runtime-discovery.js'
import {
  ProductionClosureInstaller,
  installRuntime,
  installRuntimeWithOperations,
  recoverRuntimeInstallTransaction,
  runtimeInstallerOperations,
  type InstallRuntimeOptions,
  type RuntimeInstallerOperations,
} from '../src/runtime-installer.js'
import { uninstallRuntime } from '../src/runtime-uninstaller.js'
import { runtimeLayout } from '../src/runtime-layout.js'

describe('versioned runtime installer', () => {
  test('installs an exact closure and switches current atomically', async () => {
    const roots = await createRuntimeTestRoots()
    const source = join(roots.source, 'prepared-prefix')
    await mkdir(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin'), { recursive: true })
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'package.json'),
      JSON.stringify({ name: '@mutil-skills/e2e-runtime', version: '0.0.0' }))
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin', 'repo-e2e.js'),
      '#!/usr/bin/env node\n')

    const result = await installRuntime({
      homeDir: roots.home,
      version: '0.0.0',
      installClosure: async ({ stagingPrefix }) => {
        const { cp } = await import('node:fs/promises')
        await cp(source, stagingPrefix, { recursive: true })
      },
    })

    expect(result.version).toBe('0.0.0')
    expect(result).toMatchObject({
      installationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      launcher: runtimeLayout(roots.home).bin,
    })
    const current = JSON.parse(await readFile(join(roots.home, '.mutil-skills/runtime/e2e/current.json'), 'utf8'))
    expect(current).toMatchObject({
      runtimeVersion: '0.0.0',
      runtimeManifestDigest: result.installationDigest,
      protocolMajor: 1,
      versionRoot: await realpath(join(runtimeLayout(roots.home).versions, '0.0.0')),
    })
    expect((await stat(join(runtimeLayout(roots.home).versions, '0.0.0'))).mode & 0o777).toBe(0o700)
    expect((await stat(runtimeLayout(roots.home).current)).mode & 0o777).toBe(0o600)
    expect((await stat(runtimeLayout(roots.home).bin)).mode & 0o777).toBe(0o700)
  })

  test('rejects an unowned root and symlinked version directory', async () => {
    const roots = await createRuntimeTestRoots()
    const runtimeRoot = join(roots.home, '.mutil-skills/runtime/e2e')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(join(runtimeRoot, 'foreign.txt'), 'keep')
    await expect(installRuntime({ homeDir: roots.home, version: '0.0.0', installClosure: async () => undefined }))
      .rejects.toThrow(/E2E_RUNTIME_ROOT_UNOWNED/)

    const other = join(roots.source, 'other')
    await mkdir(other)
    await mkdir(join(runtimeRoot, 'versions'), { recursive: true })
    await symlink(other, join(runtimeRoot, 'versions', '0.0.0'))
    await chmod(runtimeRoot, 0o700)
  })

  test('rejects a symlink in the exact target version path', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.1', 'safe')
    const target = join(runtimeLayout(roots.home).versions, '0.0.0')
    await mkdir(join(roots.source, 'outside'))
    await symlink(join(roots.source, 'outside'), target)

    await expect(installFixture(roots.source, roots.home, '0.0.0', 'unsafe'))
      .rejects.toThrow(/E2E_RUNTIME_VERSION_PATH_UNSAFE/)
  })

  test('permits only byte-identical idempotent installs of the same version', async () => {
    const roots = await createRuntimeTestRoots()
    const first = await installFixture(roots.source, roots.home, '0.0.0', 'same')
    const second = await installFixture(roots.source, roots.home, '0.0.0', 'same')
    expect(second.installationDigest).toBe(first.installationDigest)

    await expect(installFixture(roots.source, roots.home, '0.0.0', 'different'))
      .rejects.toThrow(/E2E_RUNTIME_VERSION_CONFLICT/)
  })

  test('validates the requested version and installed package identity', async () => {
    const roots = await createRuntimeTestRoots()
    await expect(installRuntime({
      homeDir: roots.home,
      version: 'latest',
      installClosure: async () => undefined,
    })).rejects.toThrow(/E2E_RUNTIME_VERSION_INVALID/)

    await expect(installFixture(roots.source, roots.home, '0.0.0', 'wrong', '0.0.1'))
      .rejects.toThrow(/E2E_RUNTIME_PACKAGE_INVALID/)
    await expect(installFixture(roots.source, roots.home, '0.0.0', 'skew', '0.0.0', {
      '@mutil-skills/e2e-engine': '^0.0.0',
    })).rejects.toThrow(/E2E_RUNTIME_PACKAGE_VERSION_SKEW/)
    await expect(installFixture(roots.source, roots.home, '0.0.0', 'missing-dependency', '0.0.0', {
      '@mutil-skills/e2e-engine': '0.0.0',
    })).rejects.toThrow(/E2E_RUNTIME_PACKAGE_VERSION_SKEW/)
  })

  test('keeps the previous current version when staging fails', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    const currentPath = runtimeLayout(roots.home).current
    const currentBefore = await readFile(currentPath, 'utf8')

    await expect(installRuntime({
      homeDir: roots.home,
      version: '0.0.1',
      installClosure: async () => { throw new Error('closure failed') },
    })).rejects.toThrow('closure failed')

    expect(await readFile(currentPath, 'utf8')).toBe(currentBefore)
  })

  test('rolls back launcher and a newly placed version when launcher preparation fails', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    const layout = runtimeLayout(roots.home)
    await writeFile(layout.bin, Buffer.concat([
      await readFile(layout.bin),
      Buffer.from('// prior launcher generation\n'),
    ]), { mode: 0o700 })
    const currentBefore = await readFile(layout.current)
    const launcherBefore = await readFile(layout.bin)
    const operations: RuntimeInstallerOperations = {
      ...runtimeInstallerOperations,
      writeLauncher: async (runtimeLayout_) => {
        await runtimeInstallerOperations.writeLauncher(runtimeLayout_)
        throw new Error('injected launcher failure')
      },
    }

    await expect(installFixture(
      roots.source,
      roots.home,
      '0.0.1',
      'launcher-failure',
      '0.0.1',
      undefined,
      operations,
    )).rejects.toThrow('injected launcher failure')

    expect(await readFile(layout.current)).toEqual(currentBefore)
    expect(await readFile(layout.bin)).toEqual(launcherBefore)
    await expect(stat(join(layout.versions, '0.0.1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rolls back current, launcher, and a newly placed version when current activation fails', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    const layout = runtimeLayout(roots.home)
    await writeFile(layout.bin, Buffer.concat([
      await readFile(layout.bin),
      Buffer.from('// prior launcher generation\n'),
    ]), { mode: 0o700 })
    const currentBefore = await readFile(layout.current)
    const launcherBefore = await readFile(layout.bin)
    const operations: RuntimeInstallerOperations = {
      ...runtimeInstallerOperations,
      writeCurrent: async (runtimeLayout_, current) => {
        await runtimeInstallerOperations.writeCurrent(runtimeLayout_, current)
        throw new Error('injected current failure')
      },
    }

    await expect(installFixture(
      roots.source,
      roots.home,
      '0.0.1',
      'current-failure',
      '0.0.1',
      undefined,
      operations,
    )).rejects.toThrow('injected current failure')

    expect(await readFile(layout.current)).toEqual(currentBefore)
    expect(await readFile(layout.bin)).toEqual(launcherBefore)
    await expect(stat(join(layout.versions, '0.0.1'))).rejects.toMatchObject({ code: 'ENOENT' })

    const retried = await installFixture(roots.source, roots.home, '0.0.1', 'current-failure')
    expect(retried.version).toBe('0.0.1')
  })

  test('preserves the new target when current rollback fails after the new binding was written', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    const layout = runtimeLayout(roots.home)
    const operations: RuntimeInstallerOperations = {
      ...runtimeInstallerOperations,
      writeCurrent: async (runtimeLayout_, current) => {
        await runtimeInstallerOperations.writeCurrent(runtimeLayout_, current)
        throw new Error('injected activation failure after new current')
      },
      restoreCurrent: async () => {
        throw new Error('injected old current rollback failure')
      },
    }

    let activationError: unknown
    try {
      await installFixture(
        roots.source,
        roots.home,
        '0.0.1',
        'rollback-failure',
        '0.0.1',
        undefined,
        operations,
      )
    } catch (error) {
      activationError = error
    }

    expect(activationError).toMatchObject({
      code: 'E2E_RUNTIME_ACTIVATION_ROLLBACK_FAILED',
      targetCleanupSafe: false,
      errors: [
        expect.objectContaining({ message: 'injected activation failure after new current' }),
        expect.objectContaining({ message: 'injected old current rollback failure' }),
      ],
    })
    expect(JSON.parse(await readFile(layout.current, 'utf8'))).toMatchObject({ runtimeVersion: '0.0.1' })
    expect((await stat(join(layout.versions, '0.0.1'))).isDirectory()).toBe(true)
    await expect(inspectRuntimeInstallation({ homeDir: roots.home })).resolves.toMatchObject({
      version: '0.0.1',
      sourceRepositoryIndependent: true,
    })
  })

  test('removes a newly renamed version after fsync failure so an exact retry succeeds', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    const layout = runtimeLayout(roots.home)
    const currentBefore = await readFile(layout.current)
    const launcherBefore = await readFile(layout.bin)
    const operations: RuntimeInstallerOperations = {
      ...runtimeInstallerOperations,
      fsyncVersions: async () => { throw new Error('injected versions fsync failure') },
    }

    await expect(installFixture(
      roots.source,
      roots.home,
      '0.0.1',
      'fsync-failure',
      '0.0.1',
      undefined,
      operations,
    )).rejects.toThrow('injected versions fsync failure')

    expect(await readFile(layout.current)).toEqual(currentBefore)
    expect(await readFile(layout.bin)).toEqual(launcherBefore)
    await expect(stat(join(layout.versions, '0.0.1'))).rejects.toMatchObject({ code: 'ENOENT' })

    const retried = await installFixture(roots.source, roots.home, '0.0.1', 'fsync-failure')
    expect(retried.version).toBe('0.0.1')
  })

  test('removes a newly renamed version after post-rename verification failure so retry succeeds', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    const layout = runtimeLayout(roots.home)
    const currentBefore = await readFile(layout.current)
    const launcherBefore = await readFile(layout.bin)
    const operations: RuntimeInstallerOperations = {
      ...runtimeInstallerOperations,
      verifyVersion: async () => { throw new Error('injected post-rename verification failure') },
    }

    await expect(installFixture(
      roots.source,
      roots.home,
      '0.0.1',
      'verification-failure',
      '0.0.1',
      undefined,
      operations,
    )).rejects.toThrow('injected post-rename verification failure')

    expect(await readFile(layout.current)).toEqual(currentBefore)
    expect(await readFile(layout.bin)).toEqual(launcherBefore)
    await expect(stat(join(layout.versions, '0.0.1'))).rejects.toMatchObject({ code: 'ENOENT' })

    const retried = await installFixture(roots.source, roots.home, '0.0.1', 'verification-failure')
    expect(retried.version).toBe('0.0.1')
  })

  test('revalidates the existing user-level ancestor permissions before installation', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'active')
    await chmod(join(roots.home, '.mutil-skills'), 0o755)

    await expect(installFixture(roots.source, roots.home, '0.0.0', 'active'))
      .rejects.toThrow(/E2E_RUNTIME_ROOT_UNOWNED/)
  })

  test('production closure installation uses fixed npm arguments and a sanitized environment', async () => {
    const roots = await createRuntimeTestRoots()
    const prefix = join(roots.home, 'staging')
    const npmCli = join(roots.source, 'fake-npm.mjs')
    await mkdir(prefix)
    await writeFile(npmCli, [
      "import { writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      "await writeFile(join(process.cwd(), 'observed.json'), JSON.stringify({",
      '  arguments: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  env: process.env,',
      '}))',
    ].join('\n'))
    const previousNpmExecPath = process.env.npm_execpath
    process.env.npm_execpath = npmCli
    try {
      await expect(new ProductionClosureInstaller().install({
        prefix,
        packageSpec: '@mutil-skills/e2e-runtime@latest',
        env: { HOME: roots.home, PATH: process.env.PATH ?? '' },
      })).rejects.toThrow(/E2E_RUNTIME_VERSION_INVALID/)
      await new ProductionClosureInstaller().install({
        prefix,
        packageSpec: '@mutil-skills/e2e-runtime@0.0.0',
        env: {
          HOME: roots.home,
          PATH: process.env.PATH ?? '',
          TMPDIR: roots.source,
          npm_config_registry: 'https://registry.example.invalid',
          NODE_EXTRA_CA_CERTS: join(roots.source, 'ca.pem'),
          NODE_OPTIONS: '--require=evil',
          NODE_PATH: roots.project,
          INIT_CWD: roots.project,
          npm_config_prefix: roots.project,
          SECRET_TOKEN: 'must-not-leak',
        },
      })
    } finally {
      if (previousNpmExecPath === undefined) delete process.env.npm_execpath
      else process.env.npm_execpath = previousNpmExecPath
    }

    const observed = JSON.parse(await readFile(join(prefix, 'observed.json'), 'utf8')) as {
      arguments: string[]
      cwd: string
      env: Record<string, string>
    }
    expect(observed.arguments).toEqual([
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-bin-links',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '@mutil-skills/e2e-runtime@0.0.0',
    ])
    expect(observed.cwd).toBe(await realpath(prefix))
    expect(observed.env).toMatchObject({
      HOME: roots.home,
      TMPDIR: roots.source,
      npm_config_registry: 'https://registry.example.invalid',
      NODE_EXTRA_CA_CERTS: join(roots.source, 'ca.pem'),
    })
    expect(observed.env).not.toHaveProperty('NODE_OPTIONS')
    expect(observed.env).not.toHaveProperty('NODE_PATH')
    expect(observed.env).not.toHaveProperty('INIT_CWD')
    expect(observed.env).not.toHaveProperty('npm_config_prefix')
    expect(observed.env).not.toHaveProperty('SECRET_TOKEN')
  })

  test('never removes the active version without an explicit verified replacement', async () => {
    const roots = await createRuntimeTestRoots()
    const source = join(roots.source, 'active-prefix')
    await mkdir(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin'), { recursive: true })
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'package.json'),
      JSON.stringify({ name: '@mutil-skills/e2e-runtime', version: '0.0.0' }))
    await writeFile(join(source, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin', 'repo-e2e.js'),
      '#!/usr/bin/env node\n')
    await installRuntime({
      homeDir: roots.home,
      version: '0.0.0',
      installClosure: async ({ stagingPrefix }) => {
        const { cp } = await import('node:fs/promises')
        await cp(source, stagingPrefix, { recursive: true })
      },
    })
    await expect(uninstallRuntime({ homeDir: roots.home, version: '0.0.0' }))
      .rejects.toThrow(/E2E_RUNTIME_ACTIVE_VERSION_REMOVAL_BLOCKED/)
    await expect(uninstallRuntime({
      homeDir: roots.home, version: '0.0.0', activateVersion: '0.0.1',
    })).rejects.toThrow(/E2E_RUNTIME_REPLACEMENT_NOT_VERIFIED/)
  })

  test.each([
    { phase: 'prepared', lock: false, staging: false },
    { phase: 'locked', lock: true, staging: false },
    { phase: 'staging', lock: true, staging: true },
  ] as const)('安全恢复 installer kill-point: $phase', async ({ phase, lock, staging }) => {
    const fixture = await staleInstallTransactionFixture({ phase, lock, staging })
    await expect(recoverRuntimeInstallTransaction(fixture.layout, {
      inspectOwnerProcess: async () => ({ status: 'dead' }),
    })).resolves.toMatchObject({ status: 'recovered', outcome: 'aborted' })
    await expect(stat(fixture.ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(fixture.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(fixture.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(fixture.tombstones)).toHaveLength(1)
  })

  test.each([
    { label: '活 owner', startIdentity: 'boot-a:100' },
    { label: 'PID 复用', startIdentity: 'boot-b:999' },
  ])('$label 一律阻止 installer 恢复', async ({ startIdentity }) => {
    const fixture = await staleInstallTransactionFixture({ phase: 'staging', lock: true, staging: true })
    await expect(recoverRuntimeInstallTransaction(fixture.layout, {
      inspectOwnerProcess: async () => ({ status: 'alive', startIdentity }),
    })).rejects.toThrow(/E2E_RUNTIME_INSTALL_RECOVERY_BLOCKED/)
    await expect(stat(fixture.ownerPath)).resolves.toMatchObject({})
    await expect(stat(fixture.stagingPath)).resolves.toMatchObject({})
  })

  test('marker 缺失或 lock binding 不匹配时 fail closed', async () => {
    const missing = await staleInstallTransactionFixture({ phase: 'locked', lock: true, staging: false })
    const ownerBytes = await readFile(missing.ownerPath)
    await import('node:fs/promises').then(({ unlink }) => unlink(missing.ownerPath))
    await expect(recoverRuntimeInstallTransaction(missing.layout, {
      inspectOwnerProcess: async () => ({ status: 'dead' }),
    })).rejects.toThrow(/E2E_RUNTIME_INSTALL_RECOVERY_BLOCKED/)
    await writeFile(missing.ownerPath, ownerBytes, { mode: 0o600 })
    const lock = JSON.parse(await readFile(missing.lockPath, 'utf8'))
    lock.ownerNonce = 'f'.repeat(64)
    await writeFile(missing.lockPath, `${canonicalizeJson(lock)}\n`, { mode: 0o600 })
    await expect(recoverRuntimeInstallTransaction(missing.layout, {
      inspectOwnerProcess: async () => ({ status: 'dead' }),
    })).rejects.toThrow(/E2E_RUNTIME_INSTALL_RECOVERY_BLOCKED/)
  })

  test('staging symlink/path swap 时阻止恢复且不删除外部目录', async () => {
    const fixture = await staleInstallTransactionFixture({ phase: 'staging', lock: true, staging: false })
    const outside = join(fixture.roots.source, 'outside-canary')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'keep')
    await symlink(outside, fixture.stagingPath)
    await expect(recoverRuntimeInstallTransaction(fixture.layout, {
      inspectOwnerProcess: async () => ({ status: 'dead' }),
    })).rejects.toThrow(/E2E_RUNTIME_INSTALL_RECOVERY_BLOCKED/)
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep')
  })

  test('发布完成后残留 marker 只回收事务元数据，不删除已验证版本', async () => {
    const roots = await createRuntimeTestRoots()
    const installed = await installFixture(roots.source, roots.home, '0.0.0', 'published')
    const fixture = await staleInstallTransactionFixture({
      roots, phase: 'published', lock: true, staging: false,
      targetVersion: '0.0.0', installationDigestIntent: installed.installationDigest,
    })
    await expect(recoverRuntimeInstallTransaction(fixture.layout, {
      inspectOwnerProcess: async () => ({ status: 'dead' }),
    })).resolves.toMatchObject({ status: 'recovered', outcome: 'published-preserved' })
    await expect(stat(join(fixture.layout.versions, '0.0.0'))).resolves.toMatchObject({})
  })

  test('install-runtime 入口自动安全恢复已证明死亡的旧事务', async () => {
    const fixture = await staleInstallTransactionFixture({ phase: 'staging', lock: true, staging: true })
    await expect(installFixture(
      fixture.roots.source, fixture.roots.home, '0.1.0', 'automatic-recovery',
    )).resolves.toMatchObject({ version: '0.1.0' })
    expect(await readdir(fixture.tombstones)).toHaveLength(1)
  })

  test('正常安装在创建 staging 前已持久化 owner marker 与精确 lock binding', async () => {
    const roots = await createRuntimeTestRoots()
    const source = join(roots.source, 'owner-before-staging')
    const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
    await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@mutil-skills/e2e-runtime', version: '0.0.0',
    }))
    await writeFile(join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'), '#!/usr/bin/env node\n')
    await installRuntime({ homeDir: roots.home, version: '0.0.0', installClosure: async ({ stagingPrefix }) => {
      const layout = runtimeLayout(roots.home)
      const owner = JSON.parse(await readFile(join(layout.root, 'install-owner.json'), 'utf8'))
      const lock = JSON.parse(await readFile(layout.installLock, 'utf8'))
      expect(owner).toMatchObject({ phase: 'staging', targetVersion: '0.0.0', installationDigestIntent: 'pending' })
      const { phase: _phase, installationDigestIntent: _digest, ...binding } = owner
      expect(lock).toEqual(binding)
      const { cp } = await import('node:fs/promises')
      await cp(source, stagingPrefix, { recursive: true })
    } })
    await expect(stat(join(runtimeLayout(roots.home).root, 'install-owner.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(runtimeLayout(roots.home).installLock)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function staleInstallTransactionFixture(input: {
  phase: 'prepared' | 'locked' | 'staging' | 'published'
  lock: boolean
  staging: boolean
  roots?: Awaited<ReturnType<typeof createRuntimeTestRoots>>
  targetVersion?: string
  installationDigestIntent?: string
}) {
  const roots = input.roots ?? await createRuntimeTestRoots()
  if (input.roots === undefined) await installFixture(roots.source, roots.home, '0.0.9', 'root-bootstrap')
  const layout = runtimeLayout(roots.home)
  const rootRealpath = await realpath(layout.root)
  const rootIdentity = await lstat(layout.root)
  const stagingName = '.staging-00000000-0000-4000-8000-000000000099'
  const binding = {
    schemaVersion: '1.0.0', ownerUid: process.getuid!(), pid: 2_147_483_647,
    processStartIdentity: 'boot-a:100', ownerNonce: 'a'.repeat(64),
    runtimeRoot: { canonicalPath: rootRealpath, device: String(rootIdentity.dev), inode: String(rootIdentity.ino) },
    stagingName, targetVersion: input.targetVersion ?? '0.1.0',
  }
  const marker = {
    ...binding, phase: input.phase,
    installationDigestIntent: input.installationDigestIntent ?? 'pending',
  }
  const ownerPath = join(layout.root, 'install-owner.json')
  const lockPath = layout.installLock
  const stagingPath = join(layout.root, stagingName)
  const tombstones = join(layout.root, 'install-recovery-tombstones')
  await writeFile(ownerPath, `${canonicalizeJson(marker)}\n`, { mode: 0o600 })
  if (input.lock) await writeFile(lockPath, `${canonicalizeJson(binding)}\n`, { mode: 0o600 })
  if (input.staging) await mkdir(stagingPath, { mode: 0o700 })
  return { roots, layout, ownerPath, lockPath, stagingPath, tombstones }
}

async function installFixture(
  sourceRoot: string,
  homeDir: string,
  version: string,
  body: string,
  packageVersion = version,
  dependencies?: Record<string, string>,
  operations?: RuntimeInstallerOperations,
): Promise<Awaited<ReturnType<typeof installRuntime>>> {
  const source = join(sourceRoot, `${version}-${body}`)
  const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@mutil-skills/e2e-runtime',
    version: packageVersion,
    ...(dependencies === undefined ? {} : { dependencies }),
  }))
  await writeFile(join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'), `#!/usr/bin/env node\n// ${body}\n`)
  const options: InstallRuntimeOptions = {
    homeDir,
    version,
    installClosure: async ({ stagingPrefix }) => {
      const { cp } = await import('node:fs/promises')
      await cp(source, stagingPrefix, { recursive: true })
    },
  }
  return operations === undefined
    ? installRuntime(options)
    : installRuntimeWithOperations(options, operations)
}
