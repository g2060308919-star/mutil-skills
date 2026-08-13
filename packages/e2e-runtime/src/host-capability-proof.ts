import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  readFile,
} from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxedOneShotExecutor } from './sandboxed-one-shot-executor.js'

export type HostCapabilityName =
  | 'loopback'
  | 'process'
  | 'filesystem'
  | 'browser'
  | 'profile'
  | 'sandbox'
  | 'gateway-canary'

export interface HostCapabilityOperations {
  loopback?: () => Promise<Record<string, unknown>>
  process?: () => Promise<Record<string, unknown>>
  filesystem?: () => Promise<Record<string, unknown>>
  browser?: () => Promise<Record<string, unknown>>
  profile?: () => Promise<Record<string, unknown>>
  sandbox?: () => Promise<Record<string, unknown>>
  gatewayCanary?: () => Promise<Record<string, unknown>>
}

export interface HostCapabilityResult {
  status: 'executed' | 'unsupported' | 'failed' | 'not-executed'
  reasonCode: string
  proofDigest: string
  details?: Record<string, unknown>
}

export interface HostCapabilityProof {
  schemaVersion: '1.0.0'
  environment: { platform: string; arch: string; node: string }
  capabilities: Record<HostCapabilityName, HostCapabilityResult>
  proofDigest: string
}

export async function probeHostCapabilities(options?: {
  operations?: HostCapabilityOperations
  environment?: HostCapabilityProof['environment']
}): Promise<HostCapabilityProof> {
  const environment = options?.environment ?? {
    platform: platform(), arch: arch(), node: process.version,
  }
  const operations = options?.operations ?? realHostOperations()
  const entries: Array<[HostCapabilityName, (() => Promise<Record<string, unknown>>) | undefined]> = [
    ['loopback', operations.loopback],
    ['process', operations.process],
    ['filesystem', operations.filesystem],
    ['browser', operations.browser],
    ['profile', operations.profile],
    ['sandbox', operations.sandbox],
    ['gateway-canary', operations.gatewayCanary],
  ]
  const capabilities = Object.fromEntries(await Promise.all(entries.map(async ([name, operation]) =>
    [name, await runProbe(name, environment, operation)]))) as HostCapabilityProof['capabilities']
  const draft = { schemaVersion: '1.0.0' as const, environment, capabilities }
  return {
    ...draft,
    proofDigest: digestText('e2e-host-capability-proof/v1', canonicalizeJson(draft)),
  }
}

export function assertRequiredHostCapabilities(
  proof: HostCapabilityProof,
  required: readonly HostCapabilityName[],
): void {
  for (const name of required) {
    if (proof.capabilities[name]?.status !== 'executed') throw hostError(
      'E2E_HOST_CAPABILITY_NOT_EXECUTED',
      `宿主能力 ${name} 未执行：${proof.capabilities[name]?.reasonCode ?? 'missing'}`,
    )
  }
}

export function realHostOperations(): HostCapabilityOperations {
  return {
    loopback: probeLoopback,
    process: probeProcess,
    filesystem: probeFilesystem,
    browser: probeBrowser,
    profile: probeProfile,
    sandbox: probeSandbox,
  }
}

async function runProbe(
  name: HostCapabilityName,
  environment: HostCapabilityProof['environment'],
  operation: (() => Promise<Record<string, unknown>>) | undefined,
): Promise<HostCapabilityResult> {
  if (operation === undefined) return result(name, environment, {
    status: 'not-executed',
    reasonCode: `E2E_HOST_${reasonName(name)}_NOT_PROBED`,
  })
  try {
    const details = await operation()
    return result(name, environment, {
      status: 'executed',
      reasonCode: `E2E_HOST_${reasonName(name)}_EXECUTED`,
      details,
    })
  } catch (cause) {
    const code = errorCode(cause)
    const unsupported = unavailable(cause)
    return result(name, environment, {
      status: unsupported ? 'unsupported' : 'failed',
      reasonCode: code?.startsWith('E2E_HOST_')
        ? code : `E2E_HOST_${reasonName(name)}_${unsupported ? 'UNAVAILABLE' : 'FAILED'}`,
      details: { osCode: code ?? 'unknown' },
    })
  }
}

function result(
  name: HostCapabilityName,
  environment: HostCapabilityProof['environment'],
  input: Omit<HostCapabilityResult, 'proofDigest'>,
): HostCapabilityResult {
  return {
    ...input,
    proofDigest: digestText(`e2e-host-capability/${name}/v1`, canonicalizeJson({
      environment, ...input,
    })),
  }
}

async function probeLoopback(): Promise<Record<string, unknown>> {
  const server = createServer()
  try {
    const address = await new Promise<{ address: string; port: number }>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', () => {
        const value = server.address()
        if (value === null || typeof value === 'string') rejectPromise(new Error('E2E_HOST_LOOPBACK_UNAVAILABLE'))
        else resolvePromise({ address: value.address, port: value.port })
      })
    })
    return { endpointClass: 'ipv4-loopback', address: address.address, ephemeralPortAssigned: address.port > 0 }
  } catch (cause) {
    throw asUnavailable(cause, 'E2E_HOST_LOOPBACK_UNAVAILABLE')
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }
}

async function probeProcess(): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore', shell: false,
  })
  const pidObserved = typeof child.pid === 'number' && child.pid > 0
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', resolvePromise)
  }).catch((cause) => { throw asUnavailable(cause, 'E2E_HOST_PROCESS_UNAVAILABLE') })
  if (exitCode !== 0 || !pidObserved) throw new Error('E2E_HOST_PROCESS_FAILED')
  return { childExitCode: exitCode, pidObserved }
}

async function probeFilesystem(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'e2e-host-filesystem-'))
  try {
    const secure = join(root, 'secure')
    const original = join(secure, 'original')
    const hardlink = join(secure, 'hardlink')
    const symbolic = join(secure, 'symbolic')
    const renamed = join(secure, 'renamed')
    await mkdir(secure, { mode: 0o700 })
    await chmod(secure, 0o700)
    await writeFile(original, 'proof', { mode: 0o600 })
    await link(original, hardlink)
    await symlink(original, symbolic)
    if (!(await lstat(symbolic)).isSymbolicLink() || (await stat(hardlink)).ino !== (await stat(original)).ino) {
      throw new Error('E2E_HOST_FILESYSTEM_FAILED')
    }
    await rename(original, renamed)
    return {
      directoryMode: (await stat(secure)).mode & 0o777,
      fileMode: (await stat(renamed)).mode & 0o777,
      hardlinkChecked: true,
      symlinkChecked: true,
      atomicRenameChecked: true,
    }
  } catch (cause) {
    throw asUnavailable(cause, 'E2E_HOST_FILESYSTEM_UNAVAILABLE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function probeProfile(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'e2e-host-profile-'))
  try {
    await chmod(root, 0o700)
    return { disposable: true, mode: (await stat(root)).mode & 0o777 }
  } catch (cause) {
    throw asUnavailable(cause, 'E2E_HOST_PROFILE_UNAVAILABLE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function probeBrowser(): Promise<Record<string, unknown>> {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) {
      const versionOutput = await runCommand(candidate, ['--version'])
      const version = versionOutput.match(/\d+(?:\.\d+){1,3}/)?.[0]
      if (!version) throw new Error('E2E_HOST_BROWSER_VERSION_UNAVAILABLE')
      const bytes = await readFile(candidate)
      return {
        channel: candidate.includes('chromium') ? 'chromium' : 'chrome', version,
        source: candidate.includes('chromium') ? 'managed-chromium' : 'system-chrome',
        executablePath: candidate,
        executableDigest: digestText('e2e-host-browser-executable/v1', bytes.toString('base64url')),
      }
    }
  }
  throw Object.assign(new Error('E2E_HOST_BROWSER_UNAVAILABLE'), { capabilityUnavailable: true })
}

async function probeSandbox(): Promise<Record<string, unknown>> {
  const executor = await SandboxedOneShotExecutor.create()
  const result = await executor.execute({
    command: process.execPath, args: ['-e', 'process.stdout.write("sandbox-ok")'],
    cwd: process.cwd(), readOnlyRoots: [process.execPath, process.cwd()], timeoutMs: 10_000,
  })
  if (result.exitCode !== 0 || result.stdout !== 'sandbox-ok') throw new Error('E2E_HOST_SANDBOX_FAILED')
  return { backend: result.backend, proofDigest: result.proofDigest, networkPolicy: 'denied' }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', rejectPromise)
    child.once('close', (code) => code === 0 ? resolvePromise(`${stdout}\n${stderr}`) : rejectPromise(
      new Error('E2E_HOST_BROWSER_VERSION_UNAVAILABLE'),
    ))
  })
}

function reasonName(name: HostCapabilityName): string {
  return name.replace('-', '_').toUpperCase()
}

function unavailable(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  if ('capabilityUnavailable' in cause && cause.capabilityUnavailable === true) return true
  return 'code' in cause && ['EPERM', 'EACCES', 'ENOENT', 'ENOSYS', 'EAFNOSUPPORT'].includes(String(cause.code))
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? String(cause.code)
    : cause instanceof Error && /^E2E_[A-Z0-9_]+$/.test(cause.message) ? cause.message : undefined
}

function asUnavailable(cause: unknown, code: string): Error {
  return Object.assign(new Error(code, { cause }), { code, capabilityUnavailable: unavailable(cause) })
}

function hostError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'environment', message, retryable: false })
}
