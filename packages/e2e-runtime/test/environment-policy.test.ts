import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildChildEnvironment } from '../src/environment-policy.js'

describe('child process environment policy', () => {
  test('drops host and project secrets', () => {
    const environment = buildChildEnvironment({
      host: {
        HOME: '/home/user',
        PATH: '/project/node_modules/.bin:/usr/bin',
        TMPDIR: '/tmp',
        SSH_AUTH_SOCK: '/tmp/ssh.sock',
        AWS_SECRET_ACCESS_KEY: 'canary',
        NODE_OPTIONS: '--require /project/hook.js',
        NODE_PATH: '/project/node_modules',
      },
      runtimeBinPaths: ['/usr/bin'],
      homeDir: '/home/user',
      tempDir: '/tmp/e2e-run',
    })

    expect(environment).toEqual({
      HOME: '/home/user',
      LANG: 'C.UTF-8',
      PATH: '/usr/bin',
      TMPDIR: '/tmp/e2e-run',
    })
  })

  test('rejects a relative runtime bin path with a stable safety error', () => {
    expect(() => buildChildEnvironment({
      host: {},
      runtimeBinPaths: ['project/node_modules/.bin'],
      homeDir: '/home/user',
      tempDir: '/tmp/e2e-run',
    })).toThrow(expect.objectContaining({
      code: 'E2E_RUNTIME_CHILD_PATH_INVALID',
      category: 'safety',
    }))
  })

  test('canonicalizes each allowlisted runtime bin path', () => {
    const root = mkdtempSync(join(tmpdir(), 'mutil-e2e-env-'))
    try {
      const runtimeBin = join(root, 'runtime-bin')
      const runtimeBinLink = join(root, 'runtime-bin-link')
      mkdirSync(runtimeBin)
      symlinkSync(runtimeBin, runtimeBinLink, 'dir')

      const environment = buildChildEnvironment({
        host: {},
        runtimeBinPaths: [runtimeBinLink],
        homeDir: '/home/user',
        tempDir: '/tmp/e2e-run',
      })

      expect(environment.PATH).toBe(realpathSync(runtimeBin))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('deduplicates runtime bin paths after realpath canonicalization', () => {
    const root = mkdtempSync(join(tmpdir(), 'mutil-e2e-env-'))
    try {
      const runtimeBin = join(root, 'runtime-bin')
      const runtimeBinLink = join(root, 'runtime-bin-link')
      mkdirSync(runtimeBin)
      symlinkSync(runtimeBin, runtimeBinLink, 'dir')

      const environment = buildChildEnvironment({
        host: {},
        runtimeBinPaths: [runtimeBin, runtimeBinLink],
        homeDir: '/home/user',
        tempDir: '/tmp/e2e-run',
      })

      expect(environment.PATH).toBe(realpathSync(runtimeBin))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
