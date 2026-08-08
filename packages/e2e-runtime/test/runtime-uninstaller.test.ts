import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { runtimeLayout } from '../src/runtime-layout.js'
import { installRuntime } from '../src/runtime-installer.js'
import { uninstallRuntime } from '../src/runtime-uninstaller.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { createRuntimeTestRoots } from './fixtures.js'

describe('runtime uninstaller', () => {
  test('switches to a verified replacement before removing the active version', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    await installFixture(roots.source, roots.home, '0.0.1', 'one')
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    const layout = runtimeLayout(roots.home)
    for (const retained of [layout.state, layout.quarantine, layout.authority, layout.logs, layout.browsers]) {
      await mkdir(retained, { recursive: true, mode: 0o700 })
      await chmod(retained, 0o700)
      await writeFile(join(retained, 'keep'), 'keep')
    }

    const result = await uninstallRuntime({
      homeDir: roots.home,
      version: '0.0.0',
      activateVersion: '0.0.1',
    })

    expect(result).toEqual({ version: '0.0.0', activeVersion: '0.0.1' })
    expect(JSON.parse(await readFile(layout.current, 'utf8'))).toMatchObject({ runtimeVersion: '0.0.1' })
    await expect(stat(join(layout.versions, '0.0.0'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const retained of [layout.state, layout.quarantine, layout.authority, layout.logs, layout.browsers]) {
      expect(await readFile(join(retained, 'keep'), 'utf8')).toBe('keep')
    }
  })

  test('removes a verified inactive version without changing current', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    await installFixture(roots.source, roots.home, '0.0.1', 'one')
    const before = await readFile(runtimeLayout(roots.home).current, 'utf8')

    await uninstallRuntime({ homeDir: roots.home, version: '0.0.0' })

    expect(await readFile(runtimeLayout(roots.home).current, 'utf8')).toBe(before)
  })

  test('refuses deletion after installed bytes are tampered', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    await installFixture(roots.source, roots.home, '0.0.1', 'one')
    const target = join(runtimeLayout(roots.home).versions, '0.0.0')
    await writeFile(join(target, 'node_modules', '@mutil-skills', 'e2e-runtime', 'dist', 'src', 'bin', 'repo-e2e.js'), 'tampered')

    await expect(uninstallRuntime({ homeDir: roots.home, version: '0.0.0' }))
      .rejects.toThrow(/E2E_RUNTIME_MANIFEST_MISMATCH/)
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  test('refuses every deletion when current metadata is schema-valid but not bound to its installation', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    await installFixture(roots.source, roots.home, '0.0.1', 'one')
    const layout = runtimeLayout(roots.home)
    const current = JSON.parse(await readFile(layout.current, 'utf8')) as Record<string, unknown>
    await writeFile(layout.current, JSON.stringify({
      ...current,
      versionRoot: await realpath(join(layout.versions, '0.0.0')),
    }), { mode: 0o600 })

    await expect(uninstallRuntime({ homeDir: roots.home, version: '0.0.0' }))
      .rejects.toThrow(/E2E_RUNTIME_CURRENT_MISMATCH/)

    expect((await stat(join(layout.versions, '0.0.0'))).isDirectory()).toBe(true)
    expect((await stat(join(layout.versions, '0.0.1'))).isDirectory()).toBe(true)
  })

  test('accepts only exact versions and rejects unverified replacements', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    await expect(uninstallRuntime({ homeDir: roots.home, version: '../0.0.0' }))
      .rejects.toThrow(/E2E_RUNTIME_VERSION_INVALID/)
    await expect(uninstallRuntime({
      homeDir: roots.home,
      version: '0.0.0',
      activateVersion: '0.0.1',
    })).rejects.toThrow(/E2E_RUNTIME_REPLACEMENT_NOT_VERIFIED/)
  })

  test('拒绝删除仍被活跃 Run 精确绑定的 Runtime closure', async () => {
    const roots = await createRuntimeTestRoots()
    const retained = await installFixture(roots.source, roots.home, '0.5.2', 'retained')
    await installFixture(roots.source, roots.home, '0.5.3', 'active')
    const projectIdentityDigest = `sha256:${'1'.repeat(64)}`
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    await store.beginRequest('REQUEST-CREATE', `sha256:${'2'.repeat(64)}`)
    const lock = await store.acquireRunLock(projectIdentityDigest, 'RUN-ACTIVE')
    const snapshot: RuntimeRunSnapshot = {
      schemaVersion: '1.8.0', runId: 'RUN-ACTIVE', assetId: 'ASSET-1', projectIdentityDigest,
      runtimeInstallationDigest: retained.installationDigest, workflow: createWorkflow(),
      artifactDigests: {}, frozenArtifacts: {}, trustedExecutionFacts: {}, writeAttempts: {},
      executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} }, requestResponses: {},
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
    }
    await store.createRunOutcome(snapshot, 'REQUEST-CREATE', `sha256:${'2'.repeat(64)}`, { ok: true }, lock)
    await lock.close()
    await store.close()

    await expect(uninstallRuntime({ homeDir: roots.home, version: '0.5.2' }))
      .rejects.toThrow(/E2E_RUNTIME_VERSION_REFERENCED_BY_ACTIVE_RUN/)
    expect((await stat(join(runtimeLayout(roots.home).versions, '0.5.2'))).isDirectory()).toBe(true)
  })
})

async function installFixture(sourceRoot: string, homeDir: string, version: string, body: string) {
  const source = join(sourceRoot, `${version}-${body}`)
  const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@mutil-skills/e2e-runtime',
    version,
  }))
  await writeFile(join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'), `#!/usr/bin/env node\n// ${body}\n`)
  return await installRuntime({
    homeDir,
    version,
    installClosure: async ({ stagingPrefix }) => {
      const { cp } = await import('node:fs/promises')
      await cp(source, stagingPrefix, { recursive: true })
    },
  })
}
