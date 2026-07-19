import { chmod, link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runtimeLayout } from '../src/runtime-layout.js'
import {
  assertSupportedRuntimePlatform,
  createRuntimeManifest,
  verifyRuntimeManifest,
} from '../src/runtime-manifest.js'
import { createRuntimeTestRoots } from './fixtures.js'

describe('runtime layout', () => {
  test('uses only the fixed user-level paths', async () => {
    const roots = await createRuntimeTestRoots()

    expect(runtimeLayout(roots.home)).toEqual({
      root: join(roots.home, '.mutil-skills', 'runtime', 'e2e'),
      versions: join(roots.home, '.mutil-skills', 'runtime', 'e2e', 'versions'),
      current: join(roots.home, '.mutil-skills', 'runtime', 'e2e', 'current.json'),
      installLock: join(roots.home, '.mutil-skills', 'runtime', 'e2e', 'install.lock'),
      browserInstallLock: join(roots.home, '.mutil-skills', 'runtime', 'e2e', 'browser-install.lock'),
      bin: join(roots.home, '.mutil-skills', 'bin', 'repo-e2e'),
      state: join(roots.home, '.mutil-skills', 'e2e', 'state'),
      browserSelection: join(roots.home, '.mutil-skills', 'e2e', 'state', 'browser-selection.json'),
      approvalMode: join(roots.home, '.mutil-skills', 'e2e', 'state', 'approval-mode.json'),
      authority: join(roots.home, '.mutil-skills', 'e2e', 'authority'),
      quarantine: join(roots.home, '.mutil-skills', 'e2e', 'quarantine'),
      logs: join(roots.home, '.mutil-skills', 'e2e', 'logs'),
      browsers: join(roots.home, '.mutil-skills', 'runtime', 'e2e', 'browsers'),
    })
  })

  test('supports only the explicitly approved POSIX platforms', () => {
    expect(() => assertSupportedRuntimePlatform('darwin')).not.toThrow()
    expect(() => assertSupportedRuntimePlatform('linux')).not.toThrow()
    for (const platform of ['freebsd', 'aix', 'win32'] as const) {
      expect(() => assertSupportedRuntimePlatform(platform))
        .toThrow(/E2E_RUNTIME_PLATFORM_UNSUPPORTED/)
    }
  })
})

describe('runtime manifest', () => {
  test('indexes every regular file in POSIX path order and verifies actual bytes', async () => {
    const roots = await createRuntimeTestRoots()
    const versionRoot = join(roots.source, 'version')
    await mkdir(join(versionRoot, 'z'), { recursive: true })
    await writeFile(join(versionRoot, 'z', 'last.txt'), 'last')
    await writeFile(join(versionRoot, 'a.txt'), 'first')

    const manifest = await createRuntimeManifest(versionRoot)

    expect(manifest.files.map((file) => file.path)).toEqual(['a.txt', 'z/last.txt'])
    expect(manifest.files.map((file) => file.byteLength)).toEqual([5, 4])
    await writeFile(join(versionRoot, 'runtime-manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
    await chmod(join(versionRoot, 'a.txt'), 0o600)
    await chmod(join(versionRoot, 'z'), 0o700)
    await chmod(join(versionRoot, 'z', 'last.txt'), 0o600)
    await chmod(versionRoot, 0o700)
    expect(await verifyRuntimeManifest(versionRoot)).toEqual(manifest)

    await writeFile(join(versionRoot, 'a.txt'), 'changed')
    await expect(verifyRuntimeManifest(versionRoot)).rejects.toThrow(/E2E_RUNTIME_MANIFEST_MISMATCH/)
  })

  test('verification rejects group or other permissions on manifest closure bytes', async () => {
    const roots = await createRuntimeTestRoots()
    const versionRoot = join(roots.source, 'private-version')
    await mkdir(versionRoot, { mode: 0o700 })
    await writeFile(join(versionRoot, 'entry.js'), 'entry', { mode: 0o600 })
    const manifest = await createRuntimeManifest(versionRoot)
    await writeFile(join(versionRoot, 'runtime-manifest.json'), JSON.stringify(manifest), { mode: 0o600 })

    await chmod(join(versionRoot, 'entry.js'), 0o644)

    await expect(verifyRuntimeManifest(versionRoot)).rejects.toThrow(/E2E_RUNTIME_FILE_MODE_UNSAFE/)
  })

  test('rejects symlinks and multiply-linked files', async () => {
    const roots = await createRuntimeTestRoots()
    const symlinkRoot = join(roots.source, 'symlink-version')
    await mkdir(symlinkRoot)
    await writeFile(join(roots.source, 'outside'), 'outside')
    await symlink(join(roots.source, 'outside'), join(symlinkRoot, 'linked'))
    await expect(createRuntimeManifest(symlinkRoot)).rejects.toThrow(/E2E_RUNTIME_MANIFEST_UNSAFE_NODE/)

    const hardlinkRoot = join(roots.source, 'hardlink-version')
    await mkdir(hardlinkRoot)
    await writeFile(join(hardlinkRoot, 'one'), 'same inode')
    await link(join(hardlinkRoot, 'one'), join(hardlinkRoot, 'two'))
    await expect(createRuntimeManifest(hardlinkRoot)).rejects.toThrow(/E2E_RUNTIME_MANIFEST_UNSAFE_NODE/)
  })

  test('does not include the manifest itself in the installation digest', async () => {
    const roots = await createRuntimeTestRoots()
    const versionRoot = join(roots.source, 'version')
    await mkdir(versionRoot)
    await writeFile(join(versionRoot, 'entry.js'), 'entry')
    await writeFile(join(versionRoot, 'runtime-manifest.json'), 'foreign bytes')

    const manifest = await createRuntimeManifest(versionRoot)

    expect(manifest.files).toHaveLength(1)
    expect(manifest.files[0]?.path).toBe('entry.js')
    expect(await readFile(join(versionRoot, 'runtime-manifest.json'), 'utf8')).toBe('foreign bytes')
  })
})
