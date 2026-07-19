import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runtimeLayout } from '../src/runtime-layout.js'
import {
  BrowserSelectionSchema,
  readApprovalMode,
  readBrowserSelection,
  writeApprovalMode,
  writeBrowserSelection,
} from '../src/runtime-user-config.js'
import { createRuntimeTestRoots } from './fixtures.js'

const digest = (char: string) => `sha256:${char.repeat(64)}`

describe('runtime user configuration', () => {
  test('defaults approval mode to local-confirmation without creating state', async () => {
    const roots = await createRuntimeTestRoots()
    await expect(readApprovalMode(roots.home)).resolves.toEqual({
      schemaVersion: '1.0.0',
      mode: 'local-confirmation',
    })
    await expect(lstat(runtimeLayout(roots.home).approvalMode)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('atomically persists strict private browser and approval configuration', async () => {
    const roots = await createRuntimeTestRoots()
    const executablePath = join(roots.source, 'Google Chrome')
    await writeFile(executablePath, 'chrome', { mode: 0o700 })
    const selection = {
      schemaVersion: '1.0.0' as const,
      source: { kind: 'system-chrome' as const, executablePath },
      browserVersion: 'Google Chrome 126.0.0.0',
      executableDigest: digest('a'),
      runtimeInstallationDigest: digest('b'),
      controlledLaunchProofDigest: digest('c'),
      configuredAt: '2026-07-19T00:00:00.000Z',
    }

    await writeBrowserSelection(roots.home, selection)
    await writeApprovalMode(roots.home, 'webauthn')

    await expect(readBrowserSelection(roots.home)).resolves.toEqual(selection)
    await expect(readApprovalMode(roots.home)).resolves.toEqual({ schemaVersion: '1.0.0', mode: 'webauthn' })
    expect((await lstat(runtimeLayout(roots.home).browserSelection)).mode & 0o777).toBe(0o600)
    expect((await lstat(runtimeLayout(roots.home).approvalMode)).mode & 0o777).toBe(0o600)
    expect((await lstat(runtimeLayout(roots.home).state)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(runtimeLayout(roots.home).browserSelection, 'utf8'))).toEqual(selection)
  })

  test('rejects relative paths, unknown fields and malformed digests', () => {
    const valid = {
      schemaVersion: '1.0.0',
      source: { kind: 'system-chrome', executablePath: '/Applications/Google Chrome' },
      browserVersion: 'Google Chrome 126.0.0.0',
      executableDigest: digest('a'),
      runtimeInstallationDigest: digest('b'),
      controlledLaunchProofDigest: digest('c'),
      configuredAt: '2026-07-19T00:00:00.000Z',
    }
    expect(BrowserSelectionSchema.safeParse({ ...valid, extra: true }).success).toBe(false)
    expect(BrowserSelectionSchema.safeParse({ ...valid,
      source: { kind: 'system-chrome', executablePath: './chrome' } }).success).toBe(false)
    expect(BrowserSelectionSchema.safeParse({ ...valid, executableDigest: 'sha256:bad' }).success).toBe(false)
  })

  test('rejects symlinked or permission-open configuration files', async () => {
    const roots = await createRuntimeTestRoots()
    const layout = runtimeLayout(roots.home)
    await mkdir(layout.state, { recursive: true, mode: 0o700 })
    await writeFile(join(roots.source, 'foreign.json'), '{"schemaVersion":"1.0.0","mode":"webauthn"}')
    await symlink(join(roots.source, 'foreign.json'), layout.approvalMode)
    await expect(readApprovalMode(roots.home)).rejects.toMatchObject({ code: 'E2E_RUNTIME_USER_CONFIG_UNSAFE' })

    await writeFile(layout.browserSelection, '{}', { mode: 0o600 })
    await chmod(layout.browserSelection, 0o644)
    await expect(readBrowserSelection(roots.home)).rejects.toMatchObject({ code: 'E2E_RUNTIME_USER_CONFIG_UNSAFE' })
  })
})
