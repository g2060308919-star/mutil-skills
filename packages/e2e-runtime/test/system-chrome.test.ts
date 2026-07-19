import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { describe, expect, test, vi } from 'vitest'
import {
  SYSTEM_CHROME_PATHS,
  discoverSystemChrome,
  inspectSystemChrome,
  revalidateSystemChrome,
} from '../src/system-chrome.js'
import { createRuntimeTestRoots } from './fixtures.js'

const runtimeDigest = `sha256:${'b'.repeat(64)}`
const proofDigest = `sha256:${'c'.repeat(64)}`

describe('system Google Chrome', () => {
  test('discovers only the fixed platform allowlist in order', async () => {
    const exists = vi.fn(async (path: string) => path === '/usr/bin/google-chrome')
    await expect(discoverSystemChrome({ platform: 'linux', exists })).resolves.toBe('/usr/bin/google-chrome')
    expect(exists.mock.calls.map(([path]) => path)).toEqual(SYSTEM_CHROME_PATHS.linux.slice(0, 2))
    await expect(discoverSystemChrome({ platform: 'win32' as NodeJS.Platform, exists }))
      .rejects.toMatchObject({ code: 'E2E_SYSTEM_CHROME_PLATFORM_UNSUPPORTED' })
  })

  test('canonicalizes and binds safe executable bytes, version and inode', async () => {
    const roots = await createRuntimeTestRoots()
    const executable = join(roots.source, 'Google Chrome')
    await writeFile(executable, 'trusted chrome bytes', { mode: 0o700 })

    const inspected = await inspectSystemChrome({
      executablePath: executable,
      projectRoot: roots.project,
      runtimeInstallationDigest: runtimeDigest,
      controlledLaunchProofDigest: proofDigest,
      configuredAt: '2026-07-19T00:00:00.000Z',
      readVersion: async () => 'Google Chrome 126.0.6478.127',
    })

    expect(inspected.selection.source).toEqual({
      kind: 'system-chrome', executablePath: await realpath(executable),
    })
    expect(inspected.selection.browserVersion).toBe('Google Chrome 126.0.6478.127')
    expect(inspected.selection.executableDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(inspected.identity.device).toBeGreaterThanOrEqual(0)
    expect(inspected.identity.inode).toBeGreaterThan(0)
  })

  test('rejects relative, project-owned and group/world-writable candidates', async () => {
    const roots = await createRuntimeTestRoots()
    const projectChrome = join(roots.project, 'chrome')
    await writeFile(projectChrome, 'malicious', { mode: 0o700 })
    const common = {
      projectRoot: roots.project,
      runtimeInstallationDigest: runtimeDigest,
      controlledLaunchProofDigest: proofDigest,
      configuredAt: '2026-07-19T00:00:00.000Z',
      readVersion: async () => 'Google Chrome 126.0.6478.127',
    }
    await expect(inspectSystemChrome({ ...common, executablePath: './chrome' }))
      .rejects.toMatchObject({ code: 'E2E_SYSTEM_CHROME_PATH_INVALID' })
    await expect(inspectSystemChrome({ ...common, executablePath: projectChrome }))
      .rejects.toMatchObject({ code: 'E2E_SYSTEM_CHROME_PROJECT_PATH_FORBIDDEN' })

    const openChrome = join(roots.source, 'open-chrome')
    await writeFile(openChrome, 'open', { mode: 0o777 })
    await chmod(openChrome, 0o777)
    await expect(inspectSystemChrome({ ...common, executablePath: openChrome }))
      .rejects.toMatchObject({ code: 'E2E_SYSTEM_CHROME_EXECUTABLE_UNSAFE' })
  })

  test('detects path replacement, version changes and digest changes during revalidation', async () => {
    const roots = await createRuntimeTestRoots()
    const executable = join(roots.source, 'chrome')
    await writeFile(executable, 'v1', { mode: 0o700 })
    const inspected = await inspectSystemChrome({
      executablePath: executable, projectRoot: roots.project,
      runtimeInstallationDigest: runtimeDigest, controlledLaunchProofDigest: proofDigest,
      configuredAt: '2026-07-19T00:00:00.000Z', readVersion: async () => 'Google Chrome 126',
    })
    await writeFile(executable, 'v2')
    await expect(revalidateSystemChrome(inspected, { projectRoot: roots.project,
      readVersion: async () => 'Google Chrome 127' }))
      .rejects.toMatchObject({ code: 'E2E_SYSTEM_CHROME_REVALIDATION_REQUIRED' })
  })

  test('rejects candidates that resolve through a mutable project symlink', async () => {
    const roots = await createRuntimeTestRoots()
    const trusted = join(roots.source, 'trusted')
    const link = join(roots.project, 'chrome-link')
    await writeFile(trusted, 'trusted', { mode: 0o700 })
    await symlink(trusted, link)
    await expect(inspectSystemChrome({
      executablePath: link, projectRoot: roots.project,
      runtimeInstallationDigest: runtimeDigest, controlledLaunchProofDigest: proofDigest,
      configuredAt: '2026-07-19T00:00:00.000Z', readVersion: async () => 'Google Chrome 126',
    })).rejects.toMatchObject({ code: 'E2E_SYSTEM_CHROME_PROJECT_PATH_FORBIDDEN' })

    await mkdir(join(roots.source, 'dir'))
    await chmod(join(roots.source, 'dir'), 0o777)
  })
})
