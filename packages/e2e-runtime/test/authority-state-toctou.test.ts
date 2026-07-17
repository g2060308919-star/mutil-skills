import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { startAuthorityExecutionRpcHostProcess } from '@mutil-skills/e2e-authority'
import { createRuntimeTestRoots } from './fixtures.js'

const replacement = vi.hoisted(() => ({
  armed: false,
  authorityDirectory: '',
  originalDirectory: '',
  canaryDirectory: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (replacement.armed && String(args[0]) === replacement.authorityDirectory) {
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
  const authorityDirectory = `${await realpath(roots.home)}/.mutil-skills/e2e/authority`
  const originalDirectory = `${roots.root}/verified-authority`
  const canaryDirectory = `${roots.root}/canary-authority`
  try {
    await mkdir(canaryDirectory, { recursive: true, mode: 0o755 })
    Object.assign(replacement, {
      armed: true,
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
    expect(await readdir(authorityDirectory)).toEqual([])
    expect(await readdir(originalDirectory)).toEqual(['state.key'])
    expect((await stat(authorityDirectory)).mode & 0o777).toBe(0o755)
    await expect(readFile(`${authorityDirectory}/state.key`)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    replacement.armed = false
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Authority child pins the inherited directory fd and creates no database after the path is rebound', async () => {
  const roots = await createRuntimeTestRoots()
  const authorityDirectory = `${await realpath(roots.home)}/authority-pinned`
  const originalDirectory = `${await realpath(roots.home)}/authority-original`
  const stateEncryptionKey = randomBytes(32)
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(authorityDirectory, { mode: 0o700 })
    directoryHandle = await open(
      authorityDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    )
    const metadata = await directoryHandle.stat()
    const identity = {
      realPath: authorityDirectory,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    }
    await rename(authorityDirectory, originalDirectory)
    await mkdir(authorityDirectory, { mode: 0o755 })

    await expect(startAuthorityExecutionRpcHostProcess({
      rpc: { issuer: 'authority-host', keyId: 'rpc-v1', clientId: 'runtime-parent' },
      approval: {
        issuer: 'authority', keyId: 'approval-v1', statePath: 'approval.sqlite',
        stateEncryptionKey, expectedStateDirectory: identity,
        testWorkspaceRoots: [process.cwd()],
      },
      lease: {
        statePath: 'lease.sqlite', expectedStateDirectory: identity,
        testWorkspaceRoots: [process.cwd()],
      },
      process: {
        cwd: process.cwd(),
        env: {
          HOME: roots.home,
          LANG: 'C.UTF-8',
          PATH: dirname(process.execPath),
          TMPDIR: tmpdir(),
        },
        pinnedStateDirectory: {
          fd: directoryHandle.fd,
          identity,
          pythonExecutable: '/usr/bin/python3',
          wrapperPath: join(process.cwd(), 'packages/e2e-runtime/scripts/authority-child-fchdir.py'),
        },
      },
    })).rejects.toMatchObject({
      code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
      message: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
    })
    expect(await readdir(authorityDirectory)).toEqual([])
    expect(await readdir(originalDirectory)).toEqual([])
    expect((await stat(authorityDirectory)).mode & 0o777).toBe(0o755)
  } finally {
    stateEncryptionKey.fill(0)
    await directoryHandle?.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})
