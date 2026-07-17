import { E2EError } from '@mutil-skills/e2e-contracts'
import { spawn as nodeSpawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import {
  MAX_SECRET_BYTES,
  SECRET_REF_PATTERN,
  type SecretProviderId,
} from './secret-contract.js'

const SERVICE = 'mutil-skills-e2e'
const COMMAND_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 1_000

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

export interface LinuxSessionBusIdentity {
  path: string
  directoryDevice: string
  directoryInode: string
  socketDevice: string
  socketInode: string
}

type SpawnEnvironment =
  | { LANG: 'C.UTF-8'; PATH: '/usr/bin:/bin' }
  | {
    LANG: 'C.UTF-8'
    PATH: '/usr/bin:/bin'
    DBUS_SESSION_BUS_ADDRESS: string
  }

interface SpawnOptions {
  shell: false
  stdio: ['ignore', 'pipe', 'pipe']
  env: SpawnEnvironment
}

export interface SystemSecretProviderOptions {
  id: Exclude<SecretProviderId, 'interactive'>
  platform?: NodeJS.Platform
  uid?: number
  inspectExecutable?: (path: string) => Promise<ExecutableIdentity>
  inspectLinuxSessionBus?: (uid: number) => Promise<LinuxSessionBusIdentity>
  spawn?: (command: string, arguments_: string[], options: SpawnOptions) => SecretProviderChild
  timeoutMs?: number
  shutdownTimeoutMs?: number
}

export function createSystemSecretProvider(options: SystemSecretProviderOptions): SecretProvider {
  const platform = options.platform ?? process.platform
  const expectedPlatform = options.id === 'macos-keychain' ? 'darwin' : 'linux'
  if (platform !== expectedPlatform) {
    throw providerError('E2E_SECRET_PROVIDER_PLATFORM_MISMATCH', 'Secret provider 与当前平台不匹配')
  }
  const executable = options.id === 'macos-keychain' ? '/usr/bin/security' : '/usr/bin/secret-tool'
  const inspectExecutable = options.inspectExecutable ?? inspectTrustedExecutable
  const inspectLinuxSessionBus = options.inspectLinuxSessionBus ?? inspectTrustedLinuxSessionBus
  const spawn = options.spawn ?? ((command, arguments_, spawnOptions) =>
    nodeSpawn(command, arguments_, spawnOptions) as unknown as SecretProviderChild)
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  if (!isBoundedTimeout(timeoutMs, 60_000) || !isBoundedTimeout(shutdownTimeoutMs, 10_000)) {
    throw providerError('E2E_SECRET_PROVIDER_CONFIG_INVALID', 'provider timeout 不合法')
  }

  return Object.freeze({
    id: options.id,
    async resolve(secretRef: string): Promise<Buffer | undefined> {
      if (!SECRET_REF_PATTERN.test(secretRef)) {
        throw providerError('E2E_SECRET_PROVIDER_INPUT_INVALID', 'secretRef 不符合固定 account grammar')
      }
      const arguments_ = options.id === 'macos-keychain'
        ? ['find-generic-password', '-w', '-s', SERVICE, '-a', secretRef]
        : ['lookup', 'service', SERVICE, 'account', secretRef]
      let before: ExecutableIdentity
      try { before = await inspectExecutable(executable) } catch {
        throw providerError('E2E_SECRET_PROVIDER_EXECUTABLE_INVALID', '固定 provider 可执行文件不可验证')
      }

      let environment: SpawnEnvironment = { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }
      let linuxBusBefore: LinuxSessionBusIdentity | undefined
      let linuxUid: number | undefined
      if (options.id === 'linux-secret-service') {
        const uid = options.uid ?? process.getuid?.()
        if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0 || uid > 0x7fff_ffff) {
          throw providerError('E2E_SECRET_PROVIDER_SESSION_BUS_INVALID', 'Linux session uid 不可验证')
        }
        linuxUid = uid
        try { linuxBusBefore = await inspectLinuxSessionBus(uid) } catch {
          throw providerError('E2E_SECRET_PROVIDER_SESSION_BUS_INVALID', 'Linux session bus 目录或 socket 不可验证')
        }
        const expectedBusPath = `/run/user/${uid}/bus`
        if (linuxBusBefore.path !== expectedBusPath) {
          throw providerError('E2E_SECRET_PROVIDER_SESSION_BUS_INVALID', 'Linux session bus 路径不是固定派生路径')
        }
        environment = {
          LANG: 'C.UTF-8',
          PATH: '/usr/bin:/bin',
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${expectedBusPath}`,
        }
      }

      let child: SecretProviderChild
      try {
        child = spawn(executable, arguments_, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: environment,
        })
      } catch {
        throw providerError('E2E_SECRET_PROVIDER_UNAVAILABLE', '系统 Secret provider 无法启动')
      }
      const supervisor = superviseSecretProviderChild(child, timeoutMs, shutdownTimeoutMs)
      void supervisor.completion.catch(() => undefined)
      try {
        const after = await inspectExecutable(executable)
        if (before.device !== after.device || before.inode !== after.inode) {
          return await supervisor.abort(providerError(
            'E2E_SECRET_PROVIDER_EXECUTABLE_REPLACED',
            'provider 可执行文件身份在启动边界发生变化',
          ))
        }
      } catch (cause) {
        if (cause instanceof E2EError) throw cause
        return await supervisor.abort(providerError(
          'E2E_SECRET_PROVIDER_EXECUTABLE_INVALID',
          '固定 provider 可执行文件复验失败',
        ))
      }
      if (linuxBusBefore !== undefined && linuxUid !== undefined) {
        let linuxBusAfter: LinuxSessionBusIdentity
        try { linuxBusAfter = await inspectLinuxSessionBus(linuxUid) } catch {
          return await supervisor.abort(providerError(
            'E2E_SECRET_PROVIDER_SESSION_BUS_INVALID',
            'Linux session bus 在启动边界复验失败',
          ))
        }
        if (!sameLinuxSessionBus(linuxBusBefore, linuxBusAfter)) {
          return await supervisor.abort(providerError(
            'E2E_SECRET_PROVIDER_SESSION_BUS_REPLACED',
            'Linux session bus 目录或 socket 在启动边界发生变化',
          ))
        }
      }
      return await supervisor.completion
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

async function inspectTrustedLinuxSessionBus(uid: number): Promise<LinuxSessionBusIdentity> {
  const directory = `/run/user/${uid}`
  const socket = `${directory}/bus`
  const [canonicalDirectory, directoryMetadata, canonicalSocket, socketMetadata] = await Promise.all([
    realpath(directory), lstat(directory), realpath(socket), lstat(socket),
  ])
  if (canonicalDirectory !== directory || directoryMetadata.isSymbolicLink()
    || !directoryMetadata.isDirectory() || directoryMetadata.uid !== uid
    || (directoryMetadata.mode & 0o777) !== 0o700
    || canonicalSocket !== socket || socketMetadata.isSymbolicLink()
    || !socketMetadata.isSocket() || socketMetadata.uid !== uid) {
    throw new Error('untrusted Linux session bus')
  }
  return {
    path: socket,
    directoryDevice: String(directoryMetadata.dev),
    directoryInode: String(directoryMetadata.ino),
    socketDevice: String(socketMetadata.dev),
    socketInode: String(socketMetadata.ino),
  }
}

function sameLinuxSessionBus(left: LinuxSessionBusIdentity, right: LinuxSessionBusIdentity): boolean {
  return left.path === right.path
    && left.directoryDevice === right.directoryDevice
    && left.directoryInode === right.directoryInode
    && left.socketDevice === right.socketDevice
    && left.socketInode === right.socketInode
}

interface ChildSupervisor {
  completion: Promise<Buffer | undefined>
  abort(error: E2EError): Promise<never>
}

function superviseSecretProviderChild(
  child: SecretProviderChild,
  timeoutMs: number,
  shutdownTimeoutMs: number,
): ChildSupervisor {
  const chunks: Buffer[] = []
  let outputBytes = 0
  let stderrBytes = 0
  let primaryFailure: E2EError | undefined
  let closed = false
  let finalized = false
  let killRequested = false
  let shutdownFailed = false
  let operationTimer: NodeJS.Timeout | undefined
  let shutdownTimer: NodeJS.Timeout | undefined
  let resolveCompletion!: (value: Buffer | undefined) => void
  let rejectCompletion!: (reason: E2EError) => void

  const completion = new Promise<Buffer | undefined>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  const clearChunks = () => {
    for (const chunk of chunks) chunk.fill(0)
    chunks.length = 0
  }
  const removeListeners = () => {
    child.removeListener('error', onChildError)
    child.removeListener('close', onClose)
    child.stdout.removeListener('data', onStdoutData)
    child.stdout.removeListener('error', onStreamError)
    child.stderr.removeListener('data', onStderrData)
    child.stderr.removeListener('error', onStreamError)
  }
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finalized) return
    finalized = true
    if (operationTimer !== undefined) clearTimeout(operationTimer)
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
    removeListeners()
    if (shutdownFailed || (primaryFailure !== undefined && !closed)) {
      clearChunks()
      rejectCompletion(providerError(
        'E2E_SECRET_PROVIDER_SHUTDOWN_FAILED',
        'Secret provider 未能在有界时间内确认关闭',
      ))
      return
    }
    if (primaryFailure !== undefined) {
      clearChunks()
      rejectCompletion(primaryFailure)
      return
    }
    if (signal !== null || code !== 0) {
      clearChunks()
      rejectCompletion(providerError('E2E_SECRET_PROVIDER_UNAVAILABLE', 'Secret provider 未返回可用值'))
      return
    }
    const output = Buffer.concat(chunks)
    clearChunks()
    try {
      if (output.byteLength === 0) { resolveCompletion(undefined); return }
      const length = output.at(-1) === 0x0a ? output.byteLength - 1 : output.byteLength
      resolveCompletion(length === 0 ? undefined : Buffer.from(output.subarray(0, length)))
    } finally { output.fill(0) }
  }
  const scheduleClosedFinish = (code: number | null, signal: NodeJS.Signals | null) => {
    // Node 可以在同一调用栈中交错 close/error/data；延后一个 microtask 才拆 listener。
    queueMicrotask(() => finish(code, signal))
  }
  const beginShutdown = () => {
    if (closed || killRequested || finalized) return
    killRequested = true
    if (operationTimer !== undefined) clearTimeout(operationTimer)
    try {
      if (!child.kill('SIGKILL')) shutdownFailed = true
    } catch {
      shutdownFailed = true
    }
    if (!closed && !finalized) {
      shutdownTimer = setTimeout(() => {
        shutdownFailed = true
        finish(null, null)
      }, shutdownTimeoutMs)
    }
  }
  const fail = (error: E2EError) => {
    primaryFailure ??= error
    beginShutdown()
  }
  function onStdoutData(raw: Buffer | string): void {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    try {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_SECRET_BYTES) {
        fail(providerError('E2E_SECRET_PROVIDER_OUTPUT_LIMIT', 'Secret provider 输出超过 64KiB'))
      } else if (primaryFailure === undefined && !closed) {
        chunks.push(Buffer.from(chunk))
      }
    } finally { chunk.fill(0) }
  }
  function onStderrData(raw: Buffer | string): void {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    try {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_SECRET_BYTES) {
        fail(providerError('E2E_SECRET_PROVIDER_OUTPUT_LIMIT', 'Secret provider 输出超过 64KiB'))
      }
    } finally { chunk.fill(0) }
  }
  function onChildError(): void {
    fail(providerError('E2E_SECRET_PROVIDER_UNAVAILABLE', 'Secret provider 未返回可用值'))
  }
  function onStreamError(): void {
    fail(providerError('E2E_SECRET_PROVIDER_UNAVAILABLE', 'Secret provider 未返回可用值'))
  }
  function onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (closed || finalized) return
    closed = true
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
    scheduleClosedFinish(code, signal)
  }

  child.on('error', onChildError)
  child.on('close', onClose)
  child.stdout.on('data', onStdoutData)
  child.stdout.on('error', onStreamError)
  child.stderr.on('data', onStderrData)
  child.stderr.on('error', onStreamError)
  operationTimer = setTimeout(() => {
    fail(providerError('E2E_SECRET_PROVIDER_TIMEOUT', 'Secret provider 超时'))
  }, timeoutMs)

  return {
    completion,
    async abort(error: E2EError): Promise<never> {
      if (finalized) throw error
      fail(error)
      await completion
      throw error
    },
  }
}

function isBoundedTimeout(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

function providerError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false })
}
