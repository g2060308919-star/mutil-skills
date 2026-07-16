import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runtimeLayout } from '../src/runtime-layout.js'
import { installRuntime } from '../src/runtime-installer.js'
import { uninstallRuntime } from '../src/runtime-uninstaller.js'
import { createRuntimeTestRoots } from './fixtures.js'

describe('runtime uninstaller', () => {
  test('switches to a verified replacement before removing the active version', async () => {
    const roots = await createRuntimeTestRoots()
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    await installFixture(roots.source, roots.home, '0.0.1', 'one')
    await installFixture(roots.source, roots.home, '0.0.0', 'zero')
    const layout = runtimeLayout(roots.home)
    for (const retained of [layout.state, layout.quarantine, layout.authority, layout.logs, layout.browsers]) {
      await mkdir(retained, { recursive: true })
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
})

async function installFixture(sourceRoot: string, homeDir: string, version: string, body: string): Promise<void> {
  const source = join(sourceRoot, `${version}-${body}`)
  const packageRoot = join(source, 'node_modules', '@mutil-skills', 'e2e-runtime')
  await mkdir(join(packageRoot, 'dist', 'src', 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@mutil-skills/e2e-runtime',
    version,
  }))
  await writeFile(join(packageRoot, 'dist', 'src', 'bin', 'repo-e2e.js'), `#!/usr/bin/env node\n// ${body}\n`)
  await installRuntime({
    homeDir,
    version,
    installClosure: async ({ stagingPrefix }) => {
      const { cp } = await import('node:fs/promises')
      await cp(source, stagingPrefix, { recursive: true })
    },
  })
}
