import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { inspectRuntimeInstallation } from '../src/runtime-discovery.js'
import { installRuntime } from '../src/runtime-installer.js'
import { runtimeLayout } from '../src/runtime-layout.js'
import { createRuntimeTestRoots } from './fixtures.js'

const execFileAsync = promisify(execFile)

describe('runtime discovery', () => {
  test('resolves only the installed absolute closure despite a malicious project package and NODE_PATH', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const malicious = join(roots.project, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin')
    await mkdir(malicious, { recursive: true })
    await writeFile(join(malicious, 'repo-e2e.js'), 'throw new Error("project entrypoint loaded")')
    const previousNodePath = process.env.NODE_PATH
    process.env.NODE_PATH = join(roots.project, 'node_modules')
    try {
      const installation = await inspectRuntimeInstallation({ homeDir: roots.home })
      expect(installation).toMatchObject({
        version: '0.0.0',
        protocolMajor: 1,
        versionRoot: await realpath(join(runtimeLayout(roots.home).versions, '0.0.0')),
        sourceRepositoryIndependent: true,
      })
      expect(installation.entrypoint.startsWith(installation.versionRoot + '/')).toBe(true)
    } finally {
      if (previousNodePath === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = previousNodePath
    }
  })

  test('fails closed when current metadata or an installed entrypoint is tampered', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const layout = runtimeLayout(roots.home)
    const current = JSON.parse(await readFile(layout.current, 'utf8')) as Record<string, unknown>
    await writeFile(layout.current, JSON.stringify({ ...current, unexpected: true }), { mode: 0o600 })
    await expect(inspectRuntimeInstallation({ homeDir: roots.home }))
      .rejects.toThrow(/E2E_RUNTIME_CURRENT_INVALID/)

    await writeFile(layout.current, JSON.stringify(current), { mode: 0o600 })
    await writeFile(join(layout.versions, '0.0.0', 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin', 'repo-e2e.js'), 'tampered')
    await expect(inspectRuntimeInstallation({ homeDir: roots.home }))
      .rejects.toThrow(/E2E_RUNTIME_MANIFEST_MISMATCH/)
  })

  test('the fixed launcher executes the absolute installed entrypoint and rejects preload environment', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const launcher = runtimeLayout(roots.home).bin
    await chmod(launcher, 0o700)

    const clean = await execFileAsync(launcher, ['--probe'], {
      cwd: roots.project,
      env: { HOME: roots.home, PATH: process.env.PATH ?? '' },
    })
    expect(clean.stdout).toBe('trusted --probe\n')

    await expect(execFileAsync(launcher, [], {
      cwd: roots.project,
      env: { HOME: roots.home, PATH: process.env.PATH ?? '', NODE_PATH: roots.project },
    })).rejects.toMatchObject({ code: 70 })

    const entrypoint = join(
      runtimeLayout(roots.home).versions,
      '0.0.0',
      'node_modules',
      '@mutil-skills',
      'e2e-runtime',
      'dist',
      'src',
      'bin',
      'repo-e2e.js',
    )
    await chmod(entrypoint, 0o755)
    await expect(execFileAsync(launcher, [], {
      cwd: roots.project,
      env: { HOME: roots.home, PATH: process.env.PATH ?? '' },
    })).rejects.toMatchObject({ code: 70 })
    await chmod(entrypoint, 0o600)

    const manifestPath = join(runtimeLayout(roots.home).versions, '0.0.0', 'runtime-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<Record<string, unknown>>
    }
    const entryRecord = manifest.files.find((record) => record.path === 'node_modules/@mutil-skills/e2e-runtime/dist/src/bin/repo-e2e.js')
    if (entryRecord === undefined) throw new Error('missing entry record in test fixture')
    entryRecord.unexpected = true
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    await expect(execFileAsync(launcher, [], {
      cwd: roots.project,
      env: { HOME: roots.home, PATH: process.env.PATH ?? '' },
    })).rejects.toMatchObject({ code: 70 })
  })

  test('the fixed launcher rejects a symlinked versions root even when current binds its resolved path', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const layout = runtimeLayout(roots.home)
    const realVersions = join(layout.root, 'versions-real')
    await rename(layout.versions, realVersions)
    await symlink(realVersions, layout.versions)
    await rewriteCurrentVersionRoot(layout.current, await realpath(join(layout.versions, '0.0.0')))

    await expect(runLauncher(layout.bin, roots.home, roots.project)).rejects.toMatchObject({ code: 70 })
  })

  test('the fixed launcher rejects a symlinked target version even when current binds its resolved path', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const layout = runtimeLayout(roots.home)
    const target = join(layout.versions, '0.0.0')
    const realTarget = join(layout.versions, '0.0.0-real')
    await rename(target, realTarget)
    await symlink(realTarget, target)
    await rewriteCurrentVersionRoot(layout.current, await realpath(target))

    await expect(runLauncher(layout.bin, roots.home, roots.project)).rejects.toMatchObject({ code: 70 })
  })

  test('the fixed launcher rejects group or other permissions on versions and version roots', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const layout = runtimeLayout(roots.home)
    await chmod(layout.versions, 0o755)
    await expect(runLauncher(layout.bin, roots.home, roots.project)).rejects.toMatchObject({ code: 70 })

    await chmod(layout.versions, 0o700)
    await chmod(join(layout.versions, '0.0.0'), 0o755)
    await expect(runLauncher(layout.bin, roots.home, roots.project)).rejects.toMatchObject({ code: 70 })
  })

  test('the fixed launcher rejects a resolved version root equal to the versions root', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0')
    const layout = runtimeLayout(roots.home)
    const original = join(layout.versions, '0.0.0')
    const holding = join(roots.source, 'holding-version')
    await rename(original, holding)
    for (const entry of await readdir(holding)) {
      await rename(join(holding, entry), join(layout.versions, entry))
    }
    await rm(holding, { recursive: true })
    await symlink('.', original)
    await rewriteCurrentVersionRoot(layout.current, await realpath(layout.versions))

    await expect(runLauncher(layout.bin, roots.home, roots.project)).rejects.toMatchObject({ code: 70 })
  })
})

async function rewriteCurrentVersionRoot(currentPath: string, versionRoot: string): Promise<void> {
  const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
  await writeFile(currentPath, JSON.stringify({ ...current, versionRoot }), { mode: 0o600 })
}

async function runLauncher(launcher: string, homeDir: string, cwd: string) {
  return execFileAsync(launcher, [], {
    cwd,
    env: { HOME: homeDir, PATH: process.env.PATH ?? '' },
  })
}

async function installFixture(sourceRoot: string, homeDir: string, version: string): Promise<void> {
  const source = join(sourceRoot, version)
  const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@mutil-skills/e2e-runtime',
    version,
  }))
  await writeFile(
    join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'),
    '#!/usr/bin/env node\nconsole.log(`trusted ${process.argv.slice(2).join(" ")}`.trimEnd())\n',
  )
  await installRuntime({
    homeDir,
    version,
    installClosure: async ({ stagingPrefix }) => {
      const { cp } = await import('node:fs/promises')
      await cp(source, stagingPrefix, { recursive: true })
    },
  })
}
