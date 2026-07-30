import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function ensureVitestTempRoot(root = process.cwd()): Promise<void> {
  await mkdir(join(root, '.tmp'), { recursive: true })
}

export default async function setup(): Promise<void> {
  await ensureVitestTempRoot()
}
