import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { E2EError } from '@mutil-skills/e2e-contracts'

export interface BrowserProfileOwnerProcess {
  role: 'supervisor'
  pid: number
  startIdentity: string
}

export interface BrowserProfileSupervisorHandle {
  ownerProcess: BrowserProfileOwnerProcess
  stop(): Promise<void>
}

export interface BrowserProfileSupervisor {
  start(profileDir: string): Promise<BrowserProfileSupervisorHandle>
}

export interface BrowserProfileSupervisorTimeouts {
  readyMs?: number
  stopGraceMs?: number
  killWaitMs?: number
}

const CHILD_SOURCE = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const parentPid = Number(process.argv[1])
const profileDir = process.argv[2]
const lockPath = path.join(profileDir, '.supervisor.lock')
const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600)
const startIdentity = process.platform === 'linux' ? (() => {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return 'linux:' + boot + ':' + fields[19]
  } catch { return 'linux:unknown' }
})() : 'darwin:node-start-epoch-ms:' + Math.floor(Date.now() - process.uptime() * 1000)
fs.writeFileSync(fd, JSON.stringify({ schemaVersion: '1.0.0', pid: process.pid, startIdentity }) + '\n')
fs.fsyncSync(fd)
process.stdout.write(JSON.stringify({ pid: process.pid, startIdentity }) + '\n')
let stopping = false
const finish = () => {
  if (stopping) return
  stopping = true
  try { fs.closeSync(fd) } catch {}
  try { fs.unlinkSync(lockPath) } catch {}
  process.exit(0)
}
process.on('SIGTERM', finish)
process.on('SIGINT', finish)
setInterval(() => {
  try { process.kill(parentPid, 0) } catch (error) {
    if (error && error.code === 'ESRCH') {
      // Host 在 Chromium 建立 SingletonLock 之前崩溃时可明确退出；锁存在则保持 supervisor
      // 存活并 fail closed，直到外部能证明 Browser 已终止。
      try { fs.lstatSync(path.join(profileDir, 'SingletonLock')) } catch (lockError) {
        if (lockError && lockError.code === 'ENOENT') finish()
      }
    }
  }
}, 100).unref()
setInterval(() => {}, 1000)
`

export class NodeBrowserProfileSupervisor implements BrowserProfileSupervisor {
  constructor(private readonly timeouts: BrowserProfileSupervisorTimeouts = {}) {}

  async start(profileDir: string): Promise<BrowserProfileSupervisorHandle> {
    const child = spawn(process.execPath, ['-e', CHILD_SOURCE, String(process.pid), profileDir], {
      stdio: ['ignore', 'pipe', 'ignore'], env: {},
    })
    let ready: { pid: number; startIdentity: string }
    try {
      ready = await readReady(child, this.timeouts.readyMs ?? 5_000)
    } catch (error) {
      await terminateAndReap(child, this.timeouts)
      await removeOwnedLock(profileDir, child.pid)
      throw error
    }
    let stopped = false
    return Object.freeze({
      ownerProcess: { role: 'supervisor' as const, pid: ready.pid, startIdentity: ready.startIdentity },
      stop: async () => {
        if (stopped) return
        stopped = true
        if (child.exitCode !== null || child.signalCode !== null) return
        await terminateAndReap(child, this.timeouts)
        await removeOwnedLock(profileDir, ready.pid, ready.startIdentity)
      },
    })
  }
}

async function readReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ pid: number; startIdentity: string }> {
  if (child.stdout === null) throw supervisorError('supervisor stdout 不可用')
  return await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(supervisorError('supervisor ready 超时')), timeoutMs)
    const fail = (error: unknown) => { clearTimeout(timer); reject(error) }
    child.once('error', fail)
    child.once('exit', (code) => fail(supervisorError(`supervisor ready 前退出: ${code}`)))
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      try {
        const value = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
          || typeof value.startIdentity !== 'string' || value.startIdentity.length === 0) {
          throw supervisorError('supervisor ready schema 非法')
        }
        resolve({ pid: value.pid as number, startIdentity: value.startIdentity })
      } catch (error) { reject(error) }
    })
  })
}

async function terminateAndReap(
  child: ChildProcess,
  timeouts: BrowserProfileSupervisorTimeouts,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await exitsWithin(child, timeouts.stopGraceMs ?? 5_000)) return
  child.kill('SIGKILL')
  if (await exitsWithin(child, timeouts.killWaitMs ?? 5_000)) return
  throw supervisorError('supervisor SIGKILL 后仍未退出')
}

async function exitsWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
    const finish = () => { cleanup(); resolve(true) }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', finish)
    }
    // `error` 只说明 spawn/kill API 失败，不证明 OS 进程已经退出。只有 exit
    // 事件或同步 exitCode/signalCode 才能授权删除 owned lock。
    child.once('exit', finish)
  })
}

async function removeOwnedLock(
  profileDir: string,
  expectedPid: number | undefined,
  expectedStartIdentity?: string,
): Promise<void> {
  if (expectedPid === undefined) return
  const lockPath = join(profileDir, '.supervisor.lock')
  try {
    const stat = await lstat(lockPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw supervisorError('残留 supervisor lock 不是私有普通文件')
    }
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
    if (parsed.pid !== expectedPid
      || typeof parsed.startIdentity !== 'string'
      || (expectedStartIdentity !== undefined && parsed.startIdentity !== expectedStartIdentity)) {
      throw supervisorError('残留 supervisor lock 与已回收子进程不匹配')
    }
    await unlink(lockPath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
}

function supervisorError(message: string): E2EError {
  return new E2EError({ code: 'E2E_BROWSER_PROFILE_SUPERVISOR_FAILED', category: 'safety',
    message: `E2E_BROWSER_PROFILE_SUPERVISOR_FAILED: ${message}`, retryable: false })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
