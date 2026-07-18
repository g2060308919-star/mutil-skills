import { spawn, type ChildProcess } from 'node:child_process'
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
  async start(profileDir: string): Promise<BrowserProfileSupervisorHandle> {
    const child = spawn(process.execPath, ['-e', CHILD_SOURCE, String(process.pid), profileDir], {
      stdio: ['ignore', 'pipe', 'ignore'], env: {},
    })
    const ready = await readReady(child)
    let stopped = false
    return Object.freeze({
      ownerProcess: { role: 'supervisor' as const, pid: ready.pid, startIdentity: ready.startIdentity },
      stop: async () => {
        if (stopped) return
        stopped = true
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        await waitForExit(child)
      },
    })
  }
}

async function readReady(child: ChildProcess): Promise<{ pid: number; startIdentity: string }> {
  if (child.stdout === null) throw supervisorError('supervisor stdout 不可用')
  return await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(supervisorError('supervisor ready 超时')), 5_000)
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

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(supervisorError('supervisor stop 超时')), 5_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

function supervisorError(message: string): E2EError {
  return new E2EError({ code: 'E2E_BROWSER_PROFILE_SUPERVISOR_FAILED', category: 'safety',
    message: `E2E_BROWSER_PROFILE_SUPERVISOR_FAILED: ${message}`, retryable: false })
}
