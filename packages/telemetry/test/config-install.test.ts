import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import {
  NoopTelemetrySink,
  createProjectHash,
  installHooks,
  isProjectTelemetryEnabled,
  uninstallHooks,
} from '../src/index.js'

describe('telemetry configuration and installation', () => {
  test('NoopTelemetrySink performs no external work', async () => {
    await expect(new NoopTelemetrySink().send({} as never)).resolves.toBeUndefined()
  })

  test('uses a stable keyed project hash without exposing the path', () => {
    const first = createProjectHash('/repo/../repo', 'secret')
    expect(first).toBe(createProjectHash('/repo', 'secret'))
    expect(first).not.toBe(createProjectHash('/repo', 'different-secret'))
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('/repo')
  })

  test('honors both project opt-out and exact user exclusions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'telemetry-project-'))
    await mkdir(join(homeDir, '.mutil-skills'), { recursive: true })
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.json'), JSON.stringify({ excludedProjects: [projectDir] }))

    await expect(isProjectTelemetryEnabled({ cwd: projectDir, homeDir })).resolves.toBe(false)

    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.json'), JSON.stringify({ excludedProjects: [] }))
    await mkdir(join(projectDir, '.mutil-skills'))
    await writeFile(join(projectDir, '.mutil-skills', 'telemetry.json'), JSON.stringify({ enabled: false }))
    await expect(isProjectTelemetryEnabled({ cwd: projectDir, homeDir })).resolves.toBe(false)
  })

  test('installs idempotently, preserves existing hooks, and uninstalls only owned entries', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-install-'))
    await mkdir(join(homeDir, '.claude'), { recursive: true })
    await writeFile(join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }],
        CustomEvent: [{ futureShape: true }],
      },
    }))

    const installOptions = { runtime: 'all' as const, homeDir, command: '/opt/bin/telemetry-hook' }
    await installHooks(installOptions)
    await installHooks(installOptions)

    const claude = JSON.parse(await readFile(join(homeDir, '.claude', 'settings.json'), 'utf8'))
    const codex = JSON.parse(await readFile(join(homeDir, '.codex', 'hooks.json'), 'utf8'))
    expect(claude.theme).toBe('dark')
    expect(JSON.stringify(claude).match(/telemetry-hook/g)).toHaveLength(8)
    expect(JSON.stringify(codex).match(/telemetry-hook/g)).toHaveLength(3)
    expect(JSON.stringify(claude)).toContain('existing-stop')

    const keyPath = join(homeDir, '.mutil-skills', 'telemetry.key')
    expect(await readFile(keyPath, 'utf8')).toMatch(/^[a-f0-9]{64}$/)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)

    await uninstallHooks({ runtime: 'all', homeDir, command: '/opt/bin/telemetry-hook' })
    const after = JSON.parse(await readFile(join(homeDir, '.claude', 'settings.json'), 'utf8'))
    expect(after.theme).toBe('dark')
    expect(JSON.stringify(after)).toContain('existing-stop')
    expect(after.hooks.CustomEvent).toEqual([{ futureShape: true }])
    expect(JSON.stringify(after)).not.toContain('telemetry-hook')
    await expect(readFile(keyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('removes the shared key after the last runtime is uninstalled', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-single-uninstall-'))
    const options = { runtime: 'claude-code' as const, homeDir, command: 'telemetry-hook' }
    await installHooks(options)
    await uninstallHooks(options)

    await expect(readFile(join(homeDir, '.mutil-skills', 'telemetry.key'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('fails safely without overwriting malformed host configuration', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-malformed-'))
    const configPath = join(homeDir, '.claude', 'settings.json')
    await mkdir(join(homeDir, '.claude'), { recursive: true })
    await writeFile(configPath, '{ malformed')

    await expect(installHooks({ runtime: 'claude-code', homeDir, command: 'telemetry-hook' })).rejects.toThrow()
    expect(await readFile(configPath, 'utf8')).toBe('{ malformed')
  })
})
