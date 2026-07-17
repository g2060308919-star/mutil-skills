import { E2EError } from '@mutil-skills/e2e-contracts'
import { spawn as nodeSpawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { SecretProviderId } from './secret-broker.js'

const SECRET_REF = /^[A-Z][A-Z0-9_-]{0,127}$/
const SERVICE = 'mutil-skills-e2e'
const OUTPUT_LIMIT = 64 * 1024
const COMMAND_TIMEOUT_MS = 10_000

export interface SecretProvider {
  readonly id: SecretProviderId
  resolve(secretRef: string): Promise<Buffer | undefined>
}

export interface SecretProviderChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  kill(signal: NodeJS.Signals): boolean
}

interface ExecutableIdentity { device: string; inode: string }

interface SpawnOptions {
  shell: false
  stdio: ['ignore', 'pipe', 'pipe']
  env: { LANG: 'C.UTF-8'; PATH: '/usr/bin:/bin' }
}

export interface SystemSecretProviderOptions {
  id: Exclude<SecretProviderId, 'interactive'>
  platform?: NodeJS.Platform
  inspectExecutable?: (path: string) => Promise<ExecutableIdentity>
  spawn?: (command: string, arguments_: string[], options: SpawnOptions) => SecretProviderChild
  timeoutMs?: number
}

export function createSystemSecretProvider(options: SystemSecretProviderOptions): SecretProvider {
  const platform = options.platform ?? process.platform
  const expectedPlatform = options.id === 'macos-keychain' ? 'darwin' : 'linux'
  if (platform !== expectedPlatform) {
    throw providerError('E2E_SECRET_PROVIDER_PLATFORM_MISMATCH', 'Secret provider 与当前平台不匹配')
  }
  const executable = options.id === 'macos-keychain' ? '/usr/bin/security' : '/usr/bin/secret-tool'
  const inspectExecutable = options.inspectExecutable ?? inspectTrustedExecutable
  const spawn = options.spawn ?? ((command, arguments_, spawnOptions) =>
    nodeSpawn(command, arguments_, spawnOptions) as unknown as SecretProviderChild)
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw providerError('E2E_SECRET_PROVIDER_CONFIG_INVALID', 'provider timeout 不合法')
  }

  return Object.freeze({
    id: options.id,
    async resolve(secretRef: string): Promise<Buffer | undefined> {
      if (!SECRET_REF.test(secretRef)) {
        throw providerError('E2E_SECRET_PROVIDER_INPUT_INVALID', 'secretRef 不符合固定 account grammar')
      }
      const arguments_ = options.id === 'macos-keychain'
        ? ['find-generic-password', '-w', '-s', SERVICE, '-a', secretRef]
        : ['lookup', 'service', SERVICE, 'account', secretRef]
      let before: ExecutableIdentity
      try { before = await inspectExecutable(executable) } catch {
        throw providerError('E2E_SECRET_PROVIDER_EXECUTABLE_INVALID', '固定 provider 可执行文件不可验证')
      }
      let child: SecretProviderChild
      try {
        child = spawn(executable, arguments_, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
        })
      } catch {
        throw providerError('E2E_SECRET_PROVIDER_UNAVAILABLE', '系统 Secret provider 无法启动')
      }
      const collection = collectSecretOutput(child, timeoutMs)
      void collection.catch(() => undefined)
      try {
        const after = await inspectExecutable(executable)
        if (before.device !== after.device || before.inode !== after.inode) {
          child.kill('SIGKILL')
          throw providerError('E2E_SECRET_PROVIDER_EXECUTABLE_REPLACED', 'provider 可执行文件身份在启动边界发生变化')
        }
      } catch (cause) {
        child.kill('SIGKILL')
        if (cause instanceof E2EError) throw cause
        throw providerError('E2E_SECRET_PROVIDER_EXECUTABLE_INVALID', '固定 provider 可执行文件复验失败')
      }
      return await collection
    },
  })
}

async function inspectTrustedExecutable(path: string): Promise<ExecutableIdentity> {
  const [canonical, metadata] = await Promise.all([realpath(path), lstat(path)])
  if (canonical !== path || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error('untrusted executable')
  }
  return { device: String(metadata.dev), inode: String(metadata.ino) }
}

async function collectSecretOutput(child: SecretProviderChild, timeoutMs: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let outputBytes = 0
  let stderrBytes = 0
  let overflow = false
  let timedOut = false
  let spawnFailed = false

  child.stdout.on('data', (raw: Buffer | string) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    try {
      outputBytes += chunk.byteLength
      if (outputBytes > OUTPUT_LIMIT) {
        overflow = true
        child.kill('SIGKILL')
      } else {
        chunks.push(Buffer.from(chunk))
      }
    } finally { chunk.fill(0) }
  })
  child.stderr.on('data', (raw: Buffer | string) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    try {
      stderrBytes += chunk.byteLength
      if (stderrBytes > OUTPUT_LIMIT) {
        overflow = true
        child.kill('SIGKILL')
      }
    } finally { chunk.fill(0) }
  })

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      finish({ code: null, signal: 'SIGKILL' })
    }, timeoutMs)
    child.once('error', () => {
      spawnFailed = true
      finish({ code: null, signal: null })
    })
    const streamFailed = () => {
      spawnFailed = true
      child.kill('SIGKILL')
      finish({ code: null, signal: null })
    }
    child.stdout.on('error', streamFailed)
    child.stderr.on('error', streamFailed)
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal }))
  })

  const output = Buffer.concat(chunks)
  for (const chunk of chunks) chunk.fill(0)
  try {
    if (overflow) throw providerError('E2E_SECRET_PROVIDER_OUTPUT_LIMIT', 'Secret provider 输出超过 64KiB')
    if (timedOut) throw providerError('E2E_SECRET_PROVIDER_TIMEOUT', 'Secret provider 超时')
    if (spawnFailed || outcome.signal !== null || outcome.code !== 0) {
      throw providerError('E2E_SECRET_PROVIDER_UNAVAILABLE', 'Secret provider 未返回可用值')
    }
    if (output.byteLength === 0) return undefined
    const length = output.at(-1) === 0x0a ? output.byteLength - 1 : output.byteLength
    if (length === 0) return undefined
    return Buffer.from(output.subarray(0, length))
  } finally { output.fill(0) }
}

function providerError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false })
}
