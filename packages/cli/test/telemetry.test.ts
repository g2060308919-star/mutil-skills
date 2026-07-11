import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { createTemporaryTelemetryVerification } from '@mutil-skills/telemetry'
import { installStableTelemetryRuntime, resolveTelemetryHookExecutable, telemetryHookCommand, verificationSinkFromEnvironment } from '../src/telemetry.js'

describe('telemetryHookCommand', () => {
  test('resolves the hook executable next to the installed CLI entrypoint', () => {
    expect(resolveTelemetryHookExecutable()).toMatch(/packages\/cli\/src\/bin\/telemetry-hook\.js$/)
  })

  test('checks project exclusion before parsing sensitive nested payload fields', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-cli-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'telemetry-cli-project-'))
    await mkdir(join(homeDir, '.mutil-skills'))
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.json'), JSON.stringify({ excludedProjects: [cwd] }))
    const malformedAfterCwd = `{"cwd":${JSON.stringify(cwd)},"tool_input":not-valid-json}`

    await expect(telemetryHookCommand(
      ['--runtime', 'codex', '--event', 'post-tool-use'],
      malformedAfterCwd,
      { homeDir },
    )).resolves.toBeUndefined()
  })

  test('captures hook events only when an explicit temporary verification output is supplied', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-cli-verify-home-'))
    await mkdir(join(homeDir, '.mutil-skills'))
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.key'), 'c'.repeat(64))
    const verification = await createTemporaryTelemetryVerification()

    await telemetryHookCommand(
      ['--runtime', 'codex', '--event', 'post-tool-use'],
      JSON.stringify({
        cwd: '/repo',
        sessionId: 'verify-session',
        turnId: 'verify-turn',
        toolName: 'mcp__smoke__ping',
        toolInput: {},
        callId: 'verify-call',
        toolResponse: { content: 'pong' },
      }),
      {
        homeDir,
        sink: verificationSinkFromEnvironment({
          MUTIL_TELEMETRY_VERIFICATION_OUTPUT: verification.outputPath,
        }),
      },
    )

    expect(await verification.readEvents()).toEqual([
      expect.objectContaining({ target: 'smoke/ping', status: 'success' }),
    ])
    await verification.cleanup()
  })

  test('copies the hook runner and telemetry runtime to a stable user directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-runtime-home-'))
    const sourceRoot = await mkdtemp(join(tmpdir(), 'telemetry-runtime-source-'))
    const sourceCliDirectory = join(sourceRoot, 'cli')
    const sourceTelemetryRoot = join(sourceRoot, 'telemetry')
    await mkdir(join(sourceCliDirectory, 'bin'), { recursive: true })
    await mkdir(join(sourceTelemetryRoot, 'dist', 'src'), { recursive: true })
    await writeFile(join(sourceCliDirectory, 'telemetry.js'), 'export {};\n')
    await writeFile(join(sourceCliDirectory, 'bin', 'telemetry-hook.js'), '#!/usr/bin/env node\n')
    await writeFile(join(sourceTelemetryRoot, 'dist', 'src', 'index.js'), 'export {};\n')
    await writeFile(join(sourceTelemetryRoot, 'package.json'), JSON.stringify({ name: '@mutil-skills/telemetry' }))
    const executable = await installStableTelemetryRuntime({ homeDir, sourceCliDirectory, sourceTelemetryRoot })

    expect(executable).toMatch(/\.mutil-skills\/runtime\/cli\/bin\/telemetry-hook\.js$/)
    await expect(import('node:fs/promises').then(({ access }) => access(executable))).resolves.toBeUndefined()
    await expect(import('node:fs/promises').then(({ access }) => access(join(homeDir, '.mutil-skills', 'runtime', 'cli', 'telemetry.js')))).resolves.toBeUndefined()
    await expect(import('node:fs/promises').then(({ access }) => access(join(homeDir, '.mutil-skills', 'runtime', 'node_modules', '@mutil-skills', 'telemetry', 'dist', 'src', 'index.js')))).resolves.toBeUndefined()

    await mkdir(join(homeDir, '.mutil-skills'), { recursive: true })
    await writeFile(join(homeDir, '.mutil-skills', 'telemetry.key'), 'd'.repeat(64))
    const smoke = spawnSync(executable, ['--runtime', 'codex', '--event', 'post-tool-use'], {
      input: JSON.stringify({ cwd: '/repo', tool_name: 'mcp__smoke__ping', tool_use_id: 'runtime-call', tool_response: { ok: true } }),
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    })
    expect(smoke.status).toBe(0)
    expect(smoke.stdout).toBe('')
  })

  test('refuses to replace an unowned runtime directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'telemetry-runtime-owned-home-'))
    const runtimeRoot = join(homeDir, '.mutil-skills', 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(join(runtimeRoot, 'unrelated.txt'), 'keep me')

    await expect(installStableTelemetryRuntime({ homeDir })).rejects.toThrow(/unowned runtime directory/)
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(runtimeRoot, 'unrelated.txt'), 'utf8'))).toBe('keep me')
  })
})
