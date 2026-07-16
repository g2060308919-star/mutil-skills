import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'

const replacement = vi.hoisted(() => ({
  armed: false,
  stateKeyPath: '',
  authorityDirectory: '',
  originalDirectory: '',
  canaryDirectory: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (replacement.armed && String(args[0]) === replacement.stateKeyPath) {
        replacement.armed = false
        await actual.rename(replacement.authorityDirectory, replacement.originalDirectory)
        await actual.rename(replacement.canaryDirectory, replacement.authorityDirectory)
      }
      return await (actual.open as (...openArgs: Parameters<typeof actual.open>) => ReturnType<typeof actual.open>)(...args)
    },
  }
})

import { startRuntimeAuthorityHost } from '../src/authority-host.js'

const installationDigest = `sha256:${'a'.repeat(64)}`

test('rejects an Authority directory replaced after validation without reading or changing the canary key', async () => {
  const roots = await createRuntimeTestRoots()
  const authorityDirectory = `${roots.home}/.mutil-skills/e2e/authority`
  const originalDirectory = `${roots.root}/verified-authority`
  const canaryDirectory = `${roots.root}/canary-authority`
  const canaryKey = Buffer.alloc(32, 0x5a)
  try {
    await mkdir(canaryDirectory, { recursive: true, mode: 0o755 })
    await writeFile(`${canaryDirectory}/state.key`, canaryKey, { mode: 0o600 })
    Object.assign(replacement, {
      armed: true,
      stateKeyPath: `${authorityDirectory}/state.key`,
      authorityDirectory,
      originalDirectory,
      canaryDirectory,
    })

    await expect(startRuntimeAuthorityHost({
      homeDir: roots.home,
      subject: 'local:user',
      installation: {
        version: '0.0.0', protocolMajor: 1,
        versionRoot: '/runtime', entrypoint: '/runtime/repo-e2e.js',
        installationDigest, sourceRepositoryIndependent: true,
      },
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_STATE_DIRECTORY_INVALID' })
    expect(replacement.armed).toBe(false)
    expect(await readFile(`${authorityDirectory}/state.key`)).toEqual(canaryKey)
    expect((await stat(authorityDirectory)).mode & 0o777).toBe(0o755)
    expect((await stat(`${authorityDirectory}/state.key`)).mode & 0o777).toBe(0o600)
  } finally {
    replacement.armed = false
    await rm(roots.root, { recursive: true, force: true })
  }
})
