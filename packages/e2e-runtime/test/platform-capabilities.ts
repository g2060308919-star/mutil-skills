import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export const realMacSandboxAvailable = process.platform === 'darwin'
  && existsSync('/usr/bin/sandbox-exec')
  && spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1) (allow default)', '/usr/bin/true',
  ], {
    encoding: 'utf8',
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeout: 5_000,
  }).status === 0
