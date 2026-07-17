import { createHash } from 'node:crypto'
import { runCli, type RuntimeCliDependencies } from '../../src/cli.js'

const expectedDigest = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? '')) process.exit(90)
if (process.stdin.isTTY !== true || typeof process.stdin.setRawMode !== 'function') process.exit(91)

const setRawMode = process.stdin.setRawMode.bind(process.stdin)
process.stdin.setRawMode = (enabled: boolean) => {
  const result = setRawMode(enabled)
  if (enabled) process.stdout.write('PTY_RAW_READY\n')
  else if (process.stdin.isRaw === false) process.stdout.write('PTY_RAW_RESTORED\n')
  return result
}

const dependencies: RuntimeCliDependencies = {
  homeDir: '/pty-helper-does-not-open-home',
  installRuntime: async () => ({
    version: '0.0.0', installationDigest: `sha256:${'0'.repeat(64)}`, launcher: '/safe',
  }),
  uninstallRuntime: async () => ({ version: '0.0.0' }),
  currentWorkingDirectory: () => '/pty-helper-project',
  validateSecretRun: async () => `sha256:${'1'.repeat(64)}`,
  openSecretBroker: async () => ({
    async provide(input) {
      const digest = `sha256:${createHash('sha256').update(input.value).digest('hex')}`
      if (digest !== expectedDigest) throw new Error('secret mismatch')
    },
    async close() {},
  }),
}

process.exitCode = await runCli(
  ['secret', 'provide', '--run-id', 'RUN-PTY', '--ref', 'PASSWORD'],
  process.stdin, process.stdout, process.stderr, dependencies,
)
