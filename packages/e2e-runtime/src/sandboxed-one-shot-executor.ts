import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'

export type SandboxBackend = 'macos-sandbox-exec' | 'linux-bwrap'

export interface OneShotExecOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxBuffer: number
}

export type OneShotExecFile = (
  file: string,
  args: string[],
  options: OneShotExecOptions,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export interface SandboxedOneShotExecutionInput {
  command: string
  args: string[]
  cwd: string
  readOnlyRoots: string[]
  timeoutMs: number
}

export interface SandboxedOneShotExecutionResult {
  backend: SandboxBackend
  stdout: string
  stderr: string
  exitCode: number
  proofDigest: string
}

interface ExecutorOptions {
  backend: SandboxBackend
  backendPath: string
  tempParent: string
  execFile: OneShotExecFile
}

// 只开放 OS 运行时树。调用方必须把 Node、Runtime、staging 等实际依赖作为 readOnlyRoots
// 显式传入；绝不能用 `/private`、`/Users`、`/home` 或 `/opt` 这类宽根兜底，否则沙箱内
// 的生成代码可读取同机临时文件或用户秘密。
const SYSTEM_READ_ROOTS = process.platform === 'darwin'
  ? ['/bin', '/dev', '/etc', '/usr', '/System', '/Library/Apple']
  : ['/bin', '/dev', '/etc', '/lib', '/lib64', '/usr']

export class SandboxedOneShotExecutor {
  private constructor(private readonly options: ExecutorOptions) {}

  static async create(input: { platform?: NodeJS.Platform; tempParent?: string } = {}): Promise<SandboxedOneShotExecutor> {
    const platform = input.platform ?? process.platform
    const selected = platform === 'darwin'
      ? { backend: 'macos-sandbox-exec' as const, backendPath: '/usr/bin/sandbox-exec' }
      : platform === 'linux'
        ? { backend: 'linux-bwrap' as const, backendPath: '/usr/bin/bwrap' }
        : undefined
    if (selected === undefined) throw unavailable(`unsupported platform: ${platform}`)
    await assertExecutable(selected.backendPath)
    return new SandboxedOneShotExecutor({
      ...selected,
      tempParent: input.tempParent ?? tmpdir(),
      execFile: spawnExecFile,
    })
  }

  static async createForTesting(input: ExecutorOptions): Promise<SandboxedOneShotExecutor> {
    await assertRegularFile(input.backendPath)
    return new SandboxedOneShotExecutor(input)
  }

  async execute(input: SandboxedOneShotExecutionInput): Promise<SandboxedOneShotExecutionResult> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw invalidInput('timeoutMs must be a positive safe integer')
    }
    if (input.args.some((argument) => argument.includes('\0'))) throw invalidInput('argument contains NUL')

    const command = await resolveRegularFile(input.command)
    const cwd = await resolveDirectory(input.cwd)
    const readOnlyRoots = await Promise.all([...new Set(input.readOnlyRoots)].map(resolveExistingPath))
    if (!readOnlyRoots.some((root) => containsPath(root, command))) {
      throw invalidInput('command must be contained in readOnlyRoots')
    }
    if (!readOnlyRoots.some((root) => containsPath(root, cwd))) {
      throw invalidInput('cwd must be contained in readOnlyRoots')
    }

    const createdHome = await mkdtemp(join(resolve(this.options.tempParent), 'e2e-one-shot-home-'))
    const home = await realpath(createdHome)
    try {
      const env = fixedEnvironment(home)
      const invocation = this.options.backend === 'macos-sandbox-exec'
        ? buildMacInvocation(command, input.args, cwd, readOnlyRoots, home)
        : buildLinuxInvocation(command, input.args, cwd, readOnlyRoots, home)
      const output = await this.options.execFile(this.options.backendPath, invocation.args, {
        cwd,
        env,
        timeoutMs: input.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      })
      const commandBytes = await readFile(command)
      const proofDigest = digestText('sandboxed-one-shot-proof/v1', canonicalizeJson({
        backend: this.options.backend,
        commandName: basename(command),
        commandDigest: digestText('sandboxed-one-shot-command/v1', commandBytes.toString('base64url')),
        environmentDigest: digestText('sandboxed-one-shot-environment/v1', canonicalizeJson(redactEnvironment(env))),
        policyDigest: digestText('sandboxed-one-shot-policy/v1', invocation.policy),
        exitCode: output.exitCode,
        stdoutDigest: digestText('sandboxed-one-shot-stdout/v1', output.stdout),
        stderrDigest: digestText('sandboxed-one-shot-stderr/v1', output.stderr),
      }))
      return { backend: this.options.backend, ...output, proofDigest }
    } catch (cause) {
      if (cause instanceof E2EError) throw cause
      throw new E2EError({
        code: 'E2E_ONE_SHOT_SANDBOX_EXECUTION_FAILED', category: 'safety', retryable: false,
        message: 'sandboxed one-shot command execution failed', cause,
      })
    } finally {
      await rm(createdHome, { recursive: true, force: true })
    }
  }
}

function buildMacInvocation(command: string, args: string[], cwd: string, roots: string[], home: string) {
  const readable = [...new Set([...SYSTEM_READ_ROOTS, ...roots])]
  const policy = [
    '(version 1)', '(deny default)', '(allow process-exec)', '(allow process-fork)',
    '(allow sysctl-read)', '(allow file-read-metadata)',
    '(allow file-read-data (literal "/"))',
    ...readable.map((root) => `(allow file-read* (subpath ${sandboxString(root)}))`),
    `(allow file-read* (subpath ${sandboxString(home)}))`,
    `(allow file-write* (subpath ${sandboxString(home)}))`,
    '(deny network*)',
  ].join(' ')
  return { policy, args: ['-p', policy, command, ...args], cwd }
}

function buildLinuxInvocation(command: string, args: string[], cwd: string, roots: string[], home: string) {
  const readable = [...new Set([...SYSTEM_READ_ROOTS, ...roots])]
  const policy = canonicalizeJson({ network: 'unshared', readable: readable.length, writable: 'ephemeral-home' })
  const bindArgs = readable.flatMap((root) => ['--ro-bind-try', root, root])
  return {
    policy,
    cwd,
    args: [
      '--die-with-parent', '--new-session', '--unshare-all', '--unshare-net', '--proc', '/proc', '--dev', '/dev',
      ...bindArgs, '--bind', home, home, '--chdir', cwd, '--', command, ...args,
    ],
  }
}

function fixedEnvironment(home: string): Record<string, string> {
  return {
    CI: '1', FORCE_COLOR: '0', HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_PROXY: '*',
    PATH: '/usr/bin:/bin', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', TMPDIR: home, no_proxy: '*',
    npm_config_offline: 'true',
  }
}

function redactEnvironment(env: Record<string, string>): Record<string, string> {
  return { ...env, HOME: '<ephemeral-home>', TMPDIR: '<ephemeral-home>' }
}

function sandboxString(value: string): string {
  return JSON.stringify(value)
}

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`)
}

async function resolveExistingPath(path: string): Promise<string> {
  try { return await realpath(path) } catch (cause) { throw invalidInput('readOnlyRoots contains a missing path', cause) }
}

async function resolveRegularFile(path: string): Promise<string> {
  const canonical = await resolveExistingPath(path)
  await assertRegularFile(canonical)
  return canonical
}

async function resolveDirectory(path: string): Promise<string> {
  const canonical = await resolveExistingPath(path)
  const stat = await lstat(canonical)
  if (!stat.isDirectory()) throw invalidInput('cwd must be a directory')
  return canonical
}

async function assertRegularFile(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) throw unavailable('sandbox backend is not a regular file')
  } catch (cause) {
    if (cause instanceof E2EError) throw cause
    throw unavailable('sandbox backend is missing', cause)
  }
}

async function assertExecutable(path: string): Promise<void> {
  await assertRegularFile(path)
  try { await access(path, constants.X_OK) } catch (cause) { throw unavailable('sandbox backend is not executable', cause) }
}

function unavailable(message: string, cause?: unknown): E2EError {
  return new E2EError({ code: 'E2E_ONE_SHOT_SANDBOX_UNAVAILABLE', category: 'environment', message, retryable: false, cause })
}

function invalidInput(message: string, cause?: unknown): E2EError {
  return new E2EError({ code: 'E2E_ONE_SHOT_SANDBOX_INPUT_INVALID', category: 'safety', message, retryable: false, cause })
}

const spawnExecFile: OneShotExecFile = async (file, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''; let size = 0; let settled = false
  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    child.kill('SIGKILL')
    reject(new Error('sandboxed command timed out'))
  }, options.timeoutMs)
  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    size += chunk.byteLength
    if (size > options.maxBuffer) {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        child.kill('SIGKILL')
        reject(new Error('sandboxed command output exceeded maxBuffer'))
      }
      return
    }
    if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
  }
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
  child.once('error', (error) => { clearTimeout(timeout); if (!settled) { settled = true; reject(error) } })
  child.once('close', (code) => {
    clearTimeout(timeout)
    if (!settled) { settled = true; resolvePromise({ stdout, stderr, exitCode: code ?? 1 }) }
  })
})
