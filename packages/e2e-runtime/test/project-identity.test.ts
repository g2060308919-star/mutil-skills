import { cp, link, mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  assertSameProjectIdentity,
  rebindProjectIdentity,
  resolveProjectIdentity,
} from '../src/project-identity.js'
import { SecureProjectFileReader } from '../src/secure-project-files.js'

async function writeProjectIdentity(projectRoot: string, projectId = 'PROJECT-1'): Promise<void> {
  await mkdir(join(projectRoot, '.biztest'), { recursive: true })
  await writeFile(join(projectRoot, '.biztest', 'project.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projectId,
  }))
}

describe('project identity', () => {
  test('compares every physical and logical identity field instead of trusting a digest alone', () => {
    const expected = {
      realRoot: '/project', device: '1', inode: '2', logicalProjectId: 'PROJECT-1', digest: 'same-digest',
    }
    for (const current of [
      { ...expected, realRoot: '/replacement' },
      { ...expected, device: '3' },
      { ...expected, inode: '4' },
      { ...expected, logicalProjectId: 'PROJECT-2' },
      { ...expected, digest: 'different-digest' },
    ]) {
      expect(() => assertSameProjectIdentity(expected, current))
        .toThrow(/E2E_RUNTIME_PROJECT_IDENTITY_CHANGED/)
    }
    expect(() => assertSameProjectIdentity(expected, { ...expected })).not.toThrow()
  })

  test('changes when a project is copied', async () => {
    const roots = await createRuntimeTestRoots()
    await writeProjectIdentity(roots.project)

    const first = await resolveProjectIdentity(roots.project)
    const copied = join(roots.root, 'project-copy')
    await cp(roots.project, copied, { recursive: true })
    const second = await resolveProjectIdentity(copied)

    expect(first.logicalProjectId).toBe('PROJECT-1')
    expect(first.digest).not.toBe(second.digest)
  })

  test('rejects symlinks in every component before resolving the real project root', async () => {
    const roots = await createRuntimeTestRoots()
    await writeProjectIdentity(roots.project)
    const linked = join(roots.root, 'linked-project')
    await symlink(roots.project, linked)

    await expect(resolveProjectIdentity(linked)).rejects.toThrow(/E2E_RUNTIME_PROJECT_SYMLINK_FORBIDDEN/)
  })

  test('requires strict project metadata', async () => {
    const roots = await createRuntimeTestRoots()
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      projectId: 'PROJECT-1',
      ignored: true,
    }))

    await expect(resolveProjectIdentity(roots.project)).rejects.toThrow(/E2E_RUNTIME_PROJECT_IDENTITY_INVALID/)
  })

  test('does not read an outside canary when a parent is swapped to a symlink before open', async () => {
    const roots = await createRuntimeTestRoots()
    await writeProjectIdentity(roots.project)
    const outside = join(roots.root, 'outside')
    await mkdir(join(outside, '.biztest'), { recursive: true })
    await writeFile(join(outside, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'OUTSIDE-CANARY',
    }))
    let beforeReadCalled = false
    const reader = new SecureProjectFileReader({
      beforeOpenFile: async ({ relativePath }) => {
        if (relativePath !== '.biztest/project.json') return
        await rename(join(roots.project, '.biztest'), join(roots.project, '.biztest-original'))
        await symlink(join(outside, '.biztest'), join(roots.project, '.biztest'))
      },
      beforeRead: async () => { beforeReadCalled = true },
    })

    await expect(resolveProjectIdentity(roots.project, reader))
      .rejects.toThrow(/E2E_RUNTIME_PROJECT_FILE_UNSAFE/)
    expect(beforeReadCalled).toBe(false)
  })

  test('rejects a real project root replacement before reading its identity declaration', async () => {
    const roots = await createRuntimeTestRoots()
    await writeProjectIdentity(roots.project)
    let replacementRead = false
    const reader = new SecureProjectFileReader({
      beforeOpenFile: async ({ relativePath }) => {
        if (relativePath !== '.biztest/project.json') return
        await rename(roots.project, `${roots.project}-original`)
        await mkdir(roots.project)
        await writeProjectIdentity(roots.project, 'REPLACEMENT-CANARY')
      },
      beforeRead: async () => { replacementRead = true },
    })

    await expect(resolveProjectIdentity(roots.project, reader))
      .rejects.toThrow(/E2E_RUNTIME_PROJECT_FILE_UNSAFE/)
    expect(replacementRead).toBe(false)
  })

  test('rejects a hard-linked project declaration', async () => {
    const roots = await createRuntimeTestRoots()
    const outsideDeclaration = join(roots.root, 'outside-project.json')
    await writeFile(outsideDeclaration, JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-1' }))
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await link(outsideDeclaration, join(roots.project, '.biztest', 'project.json'))

    await expect(resolveProjectIdentity(roots.project))
      .rejects.toThrow(/E2E_RUNTIME_PROJECT_FILE_UNSAFE/)
  })

  test('normalizes a missing project root to the stable identity error', async () => {
    const roots = await createRuntimeTestRoots()

    await expect(resolveProjectIdentity(join(roots.root, 'missing-project')))
      .rejects.toThrow(/E2E_RUNTIME_PROJECT_IDENTITY_INVALID/)
  })

  test('rebind requires verified user presence', async () => {
    const roots = await createRuntimeTestRoots()
    await writeProjectIdentity(roots.project)

    await expect(rebindProjectIdentity(roots.project, async () => false))
      .rejects.toThrow(/E2E_RUNTIME_PROJECT_REBIND_USER_PRESENCE_REQUIRED/)
    await expect(rebindProjectIdentity(roots.project, async () => true))
      .resolves.toMatchObject({ logicalProjectId: 'PROJECT-1' })
    await expect(rebindProjectIdentity({ projectRoot: roots.project }, async () => true))
      .resolves.toMatchObject({ logicalProjectId: 'PROJECT-1' })
  })
})
