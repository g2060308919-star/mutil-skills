import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { telemetryHookCommand } from '../src/telemetry.js'

describe('telemetryHookCommand', () => {
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
})
