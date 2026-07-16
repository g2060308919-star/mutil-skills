import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createRuntimeTestRoots(): Promise<{
  root: string
  home: string
  project: string
  source: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-runtime-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const source = join(root, 'source')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(source, { recursive: true }),
  ])
  return { root, home, project, source }
}
