import { cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  rebindProjectIdentity,
  resolveProjectIdentity,
} from '../src/project-identity.js'

async function writeProjectIdentity(projectRoot: string, projectId = 'PROJECT-1'): Promise<void> {
  await mkdir(join(projectRoot, '.biztest'), { recursive: true })
  await writeFile(join(projectRoot, '.biztest', 'project.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projectId,
  }))
}

describe('project identity', () => {
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
