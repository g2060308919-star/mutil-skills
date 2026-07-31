import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import {
  loadWorkspaceReleasePackages,
  releasePackIntegrities,
  verifyInstalledReleasePackages,
} from './e2e-runtime-cross-repo.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

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
      dependencies: { ...runtime.dependencies, '@mutil-skills/core': runtime.version },
    }))
    await expect(verifyInstalledReleasePackages(project, manifests))
      .rejects.toThrow('Registry 包内部依赖清单不一致')
  })

  test('Registry lockfile 的十四包完整性必须逐包等于 Registry 元数据', async () => {
    const sourceRoot = join(import.meta.dirname, '..')
    const manifests = await loadWorkspaceReleasePackages(sourceRoot)
    const project = await mkdtemp(join(tmpdir(), 'mutil-registry-integrity-'))
    roots.push(project)
    const expected = new Map<string, string>()
    const lockPackages: Record<string, unknown> = {}
    for (const [index, manifest] of manifests.entries()) {
      const bytes = Buffer.from(`pack-${manifest.name}-${index}`)
      const integrity = `sha512-${(await import('node:crypto')).createHash('sha512').update(bytes).digest('base64')}`
      expected.set(manifest.name, integrity)
      const manifestPath = join(project, 'node_modules', ...manifest.name.split('/'), 'package.json')
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, JSON.stringify(manifest))
      lockPackages[`node_modules/${manifest.name}`] = { version: manifest.version, integrity }
    }
    await writeFile(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }))

    await expect(verifyInstalledReleasePackages(project, manifests, {
      registryIntegrities: expected,
    })).resolves.toHaveLength(14)
    lockPackages[`node_modules/${manifests[0]!.name}`] = {
      version: manifests[0]!.version, integrity: `sha512-${'A'.repeat(88)}`,
    }
    await writeFile(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }))
    await expect(verifyInstalledReleasePackages(project, manifests, {
      registryIntegrities: expected,
    })).rejects.toThrow('Registry lock integrity 与 Registry 元数据不一致')
  })

  test('相同包内容不受 gzip metadata 影响，安装内容被篡改仍会拒绝', async () => {
    const sourceRoot = join(import.meta.dirname, '..')
    const manifests = await loadWorkspaceReleasePackages(sourceRoot)
    const root = await mkdtemp(join(tmpdir(), 'mutil-registry-content-'))
    const firstPacks = join(root, 'packs-first')
    const secondPacks = join(root, 'packs-second')
    const stagingPackage = join(root, 'staging', 'package')
    roots.push(root)
    await Promise.all([
      mkdir(firstPacks),
      mkdir(secondPacks),
      mkdir(stagingPackage, { recursive: true }),
    ])

    for (const manifest of manifests) {
      const filename = `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`
      await writeFile(join(stagingPackage, 'package.json'), JSON.stringify(manifest))
      await writeFile(join(stagingPackage, 'payload.txt'), `payload:${manifest.name}\n`)
      await chmod(join(stagingPackage, 'payload.txt'), 0o600)
      await execFileAsync('tar', ['-czf', join(firstPacks, filename), '-C', dirname(stagingPackage), 'package'])
      const secondBytes = await readFile(join(firstPacks, filename))
      secondBytes[4] = 0x01
      secondBytes[5] = 0x02
      secondBytes[6] = 0x03
      secondBytes[7] = 0x04
      await writeFile(join(secondPacks, filename), secondBytes)
    }

    const first = await releasePackIntegrities(firstPacks, manifests)
    const second = await releasePackIntegrities(secondPacks, manifests)
    expect(second).toEqual(first)

    const project = join(root, 'project')
    for (const manifest of manifests) {
      const installedRoot = join(project, 'node_modules', ...manifest.name.split('/'))
      await mkdir(installedRoot, { recursive: true })
      await writeFile(join(installedRoot, 'package.json'), JSON.stringify(manifest))
      await writeFile(join(installedRoot, 'payload.txt'), `payload:${manifest.name}\n`)
    }
    await expect(verifyInstalledReleasePackages(project, manifests, {
      packContentIntegrities: first,
    })).resolves.toHaveLength(14)

    await writeFile(
      join(project, 'node_modules', '@mutil-skills', 'e2e-contracts', 'payload.txt'),
      'tampered\n',
    )
    await expect(verifyInstalledReleasePackages(project, manifests, {
      packContentIntegrities: first,
    })).rejects.toThrow('Registry 安装内容与发布 Tag pack 不一致')
  })
})
