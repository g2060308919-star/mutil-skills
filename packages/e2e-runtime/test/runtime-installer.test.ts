import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import { inspectRuntimeInstallation } from '../src/runtime-discovery.js'
import {
  ProductionClosureInstaller,
  installRuntime,
  installRuntimeWithOperations,
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
})

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
