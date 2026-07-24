import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  loadWorkspaceReleasePackages,
  releasePackIntegrities,
  verifyInstalledReleasePackages,
} from './e2e-runtime-cross-repo.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('Registry 发布闭包校验', () => {
  test('覆盖全部 14 个包，并拒绝已安装包中的任一内部依赖漂移', async () => {
    const sourceRoot = join(import.meta.dirname, '..')
    const manifests = await loadWorkspaceReleasePackages(sourceRoot)
    const project = await mkdtemp(join(tmpdir(), 'mutil-registry-closure-'))
    roots.push(project)

    for (const manifest of manifests) {
      const manifestPath = join(project, 'node_modules', ...manifest.name.split('/'), 'package.json')
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, JSON.stringify(manifest))
    }
    await expect(verifyInstalledReleasePackages(project, manifests)).resolves.toHaveLength(14)

    const runtime = manifests.find(({ name }) => name === '@mutil-skills/e2e-runtime')!
    const driftedPath = join(project, 'node_modules', '@mutil-skills', 'e2e-runtime', 'package.json')
    await writeFile(driftedPath, JSON.stringify({
      ...runtime,
      dependencies: { ...runtime.dependencies, '@mutil-skills/e2e-contracts': '0.2.1' },
    }))
    await expect(verifyInstalledReleasePackages(project, manifests))
      .rejects.toThrow('Registry 包内部依赖漂移')

    const withoutDependency = { ...runtime, dependencies: { ...runtime.dependencies } }
    delete withoutDependency.dependencies['@mutil-skills/e2e-contracts']
    await writeFile(driftedPath, JSON.stringify(withoutDependency))
    await expect(verifyInstalledReleasePackages(project, manifests))
      .rejects.toThrow('Registry 包内部依赖清单不一致')

    await writeFile(driftedPath, JSON.stringify({
      ...runtime,
      dependencies: { ...runtime.dependencies, '@mutil-skills/core': '0.3.0' },
    }))
    await expect(verifyInstalledReleasePackages(project, manifests))
      .rejects.toThrow('Registry 包内部依赖清单不一致')
  })

  test('Registry lockfile 的十四包完整性必须逐包等于本地待发布 tarball', async () => {
    const sourceRoot = join(import.meta.dirname, '..')
    const manifests = await loadWorkspaceReleasePackages(sourceRoot)
    const project = await mkdtemp(join(tmpdir(), 'mutil-registry-integrity-'))
    const packs = join(project, 'packs')
    roots.push(project)
    await mkdir(packs)
    const expected = new Map<string, string>()
    const lockPackages: Record<string, unknown> = {}
    for (const [index, manifest] of manifests.entries()) {
      const filename = `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`
      const bytes = Buffer.from(`pack-${manifest.name}-${index}`)
      await writeFile(join(packs, filename), bytes)
      const integrity = `sha512-${(await import('node:crypto')).createHash('sha512').update(bytes).digest('base64')}`
      expected.set(manifest.name, integrity)
      const manifestPath = join(project, 'node_modules', ...manifest.name.split('/'), 'package.json')
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, JSON.stringify(manifest))
      lockPackages[`node_modules/${manifest.name}`] = { version: manifest.version, integrity }
    }
    await writeFile(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }))

    await expect(releasePackIntegrities(packs, manifests)).resolves.toEqual(expected)
    await expect(verifyInstalledReleasePackages(project, manifests, expected)).resolves.toHaveLength(14)
    lockPackages[`node_modules/${manifests[0]!.name}`] = {
      version: manifests[0]!.version, integrity: `sha512-${'A'.repeat(88)}`,
    }
    await writeFile(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }))
    await expect(verifyInstalledReleasePackages(project, manifests, expected))
      .rejects.toThrow('Registry 包内容完整性不一致')
  })
})
