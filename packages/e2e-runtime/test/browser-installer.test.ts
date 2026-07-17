import { canonicalizeJson, digestBytes } from '@mutil-skills/e2e-contracts'
import { chmod, mkdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  installChromiumWithOperations,
  inspectChromiumInstallation,
  productionBrowserInstallerOperations,
  type BrowserInstallerOperations,
} from '../src/browser-installer.js'
import { runtimeLayout } from '../src/runtime-layout.js'

describe('Chromium installer', () => {
  test('atomically installs a versioned closure and binds every trusted byte', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)

    const installed = await installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)

    expect(installed.manifest).toMatchObject({
      schemaVersion: '1.0.0', runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
      playwrightVersion: '1.61.1', platform: process.platform, arch: process.arch,
      revision: '1234', chromiumVersion: 'fixture-chromium-1234',
      cliDigest: expect.stringMatching(/^sha256:/),
      cliByteLength: 3,
      executableRelativePath: 'chromium-1234/chrome', executableByteLength: 7,
      executableDigest: expect.stringMatching(/^sha256:/),
      closureDigest: expect.stringMatching(/^sha256:/),
    })
    expect(installed.manifest.files.map((file) => file.path)).toEqual([
      'chromium-1234/chrome', 'chromium-1234/chrome-link',
    ])
    await expect(inspectChromiumInstallation({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).resolves.toEqual(installed)
    expect(fixture.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      executable: process.execPath,
      arguments: [expect.stringMatching(/\/playwright\/cli\.js$/), 'install', 'chromium'],
      cwd: fixture.packageRoot,
      env: expect.objectContaining({
        HOME: expect.stringMatching(/\.staging-[^/]+\/home$/),
        TMPDIR: expect.stringMatching(/\.staging-[^/]+\/tmp$/),
        PLAYWRIGHT_BROWSERS_PATH: expect.stringMatching(/\.staging-[^/]+\/closure$/),
      }),
    }))
    expect(Object.keys(fixture.runInstall.mock.calls[0]![0].env).sort()).toEqual([
      'HOME', 'LANG', 'LC_ALL', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TMPDIR',
    ])
  })

  test('rejects Playwright packageRoot outside the verified Runtime versionRoot', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    fixture.operations.inspectRuntime = async () => ({
      version: '0.0.0', installationDigest: digest('a'),
      versionRoot: join(roots.source, 'different-runtime-version'),
      manifestFiles: fixture.runtimeManifestFiles,
    })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toThrow(/E2E_PLAYWRIGHT_CLI_UNSAFE/)
  })

  test('rejects Playwright CLI absent from the verified Runtime manifest closure', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    fixture.operations.inspectRuntime = async () => ({
      version: '0.0.0', installationDigest: digest('a'), versionRoot: roots.source,
      manifestFiles: fixture.runtimeManifestFiles.filter((file) => !file.path.endsWith('/cli.js')),
    })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toThrow(/E2E_PLAYWRIGHT_CLI_UNSAFE/)
  })

  test('rejects a symlink whose resolved target escapes the browser closure', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source, async (stagingRoot) => {
      const outside = join(roots.source, 'outside-browser')
      await writeFile(outside, 'foreign')
      await mkdir(join(stagingRoot, 'chromium-1234'), { recursive: true })
      await writeFile(join(stagingRoot, 'chromium-1234', 'chrome'), 'browser')
      await symlink(outside, join(stagingRoot, 'chromium-1234', 'escape'))
    })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toThrow(/E2E_CHROMIUM_CLOSURE_SYMLINK_ESCAPE/)
  })

  test('识别 Playwright 1.61.1 macOS Google Chrome for Testing app 内真实 executable', async () => {
    const roots = await createRuntimeTestRoots()
    const relative = join(
      'chromium-1234', 'chrome-mac-arm64', 'Google Chrome for Testing.app',
      'Contents', 'MacOS', 'Google Chrome for Testing',
    )
    const fixture = await fakeOperations(roots.source, async (stagingRoot) => {
      const executable = join(stagingRoot, relative)
      await mkdir(join(executable, '..'), { recursive: true })
      await writeFile(executable, 'browser', { mode: 0o700 })
    })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).resolves.toMatchObject({
      manifest: { executableRelativePath: relative.split('\\').join('/') },
    })
  })

  test('does not publish a partial target when install fails and exact retry succeeds', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    fixture.runInstall.mockRejectedValueOnce(new Error('injected install failure'))

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toThrow('injected install failure')
    await expect(readFile(join(
      runtimeLayout(roots.home).browsers, '0.0.0', `${process.platform}-${process.arch}`, 'browser-manifest.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).resolves.toMatchObject({ manifest: { revision: '1234' } })
  })

  test('inspect is read-only and rejects tampered file modes without normalizing them', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    const installed = await installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)
    await chmod(installed.executablePath, 0o744)

    await expect(inspectChromiumInstallation({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toThrow(/E2E_CHROMIUM_CLOSURE_MODE_INVALID/)
    expect((await stat(installed.executablePath)).mode & 0o777).toBe(0o744)
  })

  test('inspect rejects a symlinked manifest with O_NOFOLLOW', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    const installed = await installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)
    const manifest = join(installed.root, 'browser-manifest.json')
    const moved = join(roots.source, 'moved-manifest.json')
    await rename(manifest, moved)
    await symlink(moved, manifest)

    await expect(inspectChromiumInstallation({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  test('bounds installer stdout/stderr and terminates a child that ignores SIGTERM', async () => {
    const roots = await createRuntimeTestRoots()
    await expect(productionBrowserInstallerOperations.runInstall({
      executable: process.execPath,
      arguments: ['-e', 'process.stdout.write("x".repeat(70000));setInterval(()=>{},1000)'],
      cwd: roots.source,
      env: { HOME: roots.home, TMPDIR: roots.source, PATH: process.env.PATH },
      timeoutMs: 1_000,
      terminationGraceMs: 20,
    })).rejects.toThrow(/E2E_CHROMIUM_INSTALL_OUTPUT_LIMIT/)

    const startedAt = Date.now()
    await expect(productionBrowserInstallerOperations.runInstall({
      executable: process.execPath,
      arguments: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      cwd: roots.source,
      env: { HOME: roots.home, TMPDIR: roots.source, PATH: process.env.PATH },
      timeoutMs: 20,
      terminationGraceMs: 20,
    })).rejects.toThrow(/E2E_CHROMIUM_INSTALL_TIMEOUT/)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  test('recovers only a stale lock whose trusted marker owns the matching staging tree', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    const layout = runtimeLayout(roots.home)
    await mkdir(layout.root, { recursive: true, mode: 0o700 })
    await mkdir(layout.browsers, { recursive: true, mode: 0o700 })
    const stagingName = '.staging-00000000-0000-4000-8000-000000000000'
    const marker = {
      schemaVersion: '1.0.0', ownerUid: process.getuid!(), pid: 2_147_483_647,
      ownerNonce: 'a'.repeat(64), stagingName,
    }
    await writeFile(layout.browserInstallLock, `${canonicalizeJson(marker)}\n`, { mode: 0o600 })
    const staleStaging = join(layout.browsers, stagingName)
    await mkdir(staleStaging, { mode: 0o700 })
    await writeFile(join(staleStaging, '.install-owner.json'), `${canonicalizeJson(marker)}\n`, { mode: 0o600 })
    await writeFile(join(staleStaging, 'stale-canary'), 'must be removed', { mode: 0o600 })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).resolves.toMatchObject({ manifest: { revision: '1234' } })
    await expect(stat(staleStaging)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('fails closed on an untrusted stale lock marker and preserves its staging tree', async () => {
    const roots = await createRuntimeTestRoots()
    const fixture = await fakeOperations(roots.source)
    const layout = runtimeLayout(roots.home)
    await mkdir(layout.root, { recursive: true, mode: 0o700 })
    await mkdir(layout.browsers, { recursive: true, mode: 0o700 })
    const stagingName = '.staging-00000000-0000-4000-8000-000000000001'
    await writeFile(layout.browserInstallLock, `${canonicalizeJson({
      schemaVersion: '1.0.0', ownerUid: process.getuid!(), pid: 2_147_483_647,
      ownerNonce: 'b'.repeat(64), stagingName: '../escape',
    })}\n`, { mode: 0o600 })
    const staleStaging = join(layout.browsers, stagingName)
    await mkdir(staleStaging, { mode: 0o700 })

    await expect(installChromiumWithOperations({
      homeDir: roots.home, runtimeVersion: '0.0.0', runtimeInstallationDigest: digest('a'),
    }, fixture.operations)).rejects.toThrow(/E2E_CHROMIUM_INSTALL_LOCK_UNSAFE/)
    await expect(stat(staleStaging)).resolves.toMatchObject({})
  })
})

async function fakeOperations(
  sourceRoot: string,
  customInstall?: (stagingRoot: string) => Promise<void>,
): Promise<{
  operations: BrowserInstallerOperations
  runInstall: ReturnType<typeof vi.fn>
  cliPath: string
  packageRoot: string
  runtimeManifestFiles: Array<{ path: string; byteLength: number; digest: string }>
}> {
  const packageRootCandidate = join(sourceRoot, 'playwright')
  await mkdir(packageRootCandidate, { recursive: true })
  const sourceRootReal = await realpath(sourceRoot)
  const packageRoot = await realpath(packageRootCandidate)
  const cliPath = join(packageRoot, 'cli.js')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.61.1' }))
  await writeFile(cliPath, 'cli')
  const runtimeManifestFiles = await Promise.all([
    join(packageRoot, 'package.json'), cliPath,
  ].map(async (path) => {
    const bytes = await readFile(path)
    return {
      path: path.slice(sourceRootReal.length + 1).split('\\').join('/'),
      byteLength: bytes.byteLength,
      digest: digestBytes('e2e-runtime-file/v1', bytes),
    }
  }))
  const runInstall = vi.fn(async (input: { env: NodeJS.ProcessEnv }) => {
    const stagingRoot = input.env.PLAYWRIGHT_BROWSERS_PATH!
    if (customInstall) return await customInstall(stagingRoot)
    const revisionRoot = join(stagingRoot, 'chromium-1234')
    await mkdir(revisionRoot, { recursive: true })
    await writeFile(join(revisionRoot, 'chrome'), 'browser', { mode: 0o700 })
    await symlink('chrome', join(revisionRoot, 'chrome-link'))
  })
  return {
    cliPath,
    packageRoot,
    runtimeManifestFiles,
    runInstall,
    operations: {
      inspectRuntime: async () => ({
        version: '0.0.0', installationDigest: digest('a'),
        versionRoot: sourceRoot, manifestFiles: runtimeManifestFiles,
      }),
      verifyRuntimeRoot: async (layout) => {
        await mkdir(layout.root, { recursive: true, mode: 0o700 })
      },
      resolvePlaywright: async () => ({ packageRoot, cliPath, version: '1.61.1' }),
      runInstall,
      readChromiumVersion: async () => 'fixture-chromium-1234',
    },
  }
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`
}
