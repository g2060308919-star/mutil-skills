import { E2EError } from '@mutil-skills/e2e-contracts'
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { RuntimeInstallation } from './runtime-discovery.js'
import { validateSupervisedChildEnvironment } from './environment-policy.js'

export interface SupervisedProcessSpec {
  entrypoint: string
  args: string[]
  cwd: string
  env: Record<string, string>
  startTimeoutMs: number
  stopTimeoutMs: number
}

export interface SupervisedProcessHandle {
  readonly pid: number
  readonly waitForExit: () => Promise<void>
  readonly isRunning: () => boolean
  requestShutdown(): Promise<void>
  close(): Promise<void>
}

export class ProcessSupervisor {
  constructor(private readonly installation: RuntimeInstallation) {}

  async spawn(spec: SupervisedProcessSpec): Promise<SupervisedProcessHandle> {
    const versionRoot = await realpath(this.installation.versionRoot)
    const entrypoint = await realpath(spec.entrypoint)
    const pathFromRoot = relative(versionRoot, entrypoint)
    if (pathFromRoot === ''
      || pathFromRoot === '..'
      || pathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(pathFromRoot)) {
      throw childEntrypointOutsideInstallation()
    }
    const environment = validateSupervisedChildEnvironment(spec.env)

    const child = spawnChild(process.execPath, [entrypoint, ...spec.args], {
      cwd: spec.cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const exit = observeExit(child)
    try {
      await waitForReady(child, spec.startTimeoutMs)
    } catch (error) {
      await terminateFailedStart(child, exit, spec.stopTimeoutMs)
      throw error instanceof E2EError ? error : childStartFailed()
    }
    if (exit.exited()) throw childExitedEarly()
    await nextEventLoopTurn()
    if (exit.exited()) throw childExitedEarly()
    if (await exitsWithin(exit.promise, 10)) throw childExitedEarly()
    if (child.pid === undefined) throw childStartFailed()
    if (!processIsAlive(child.pid)) throw childExitedEarly()

    return {
      pid: child.pid,
      waitForExit: async () => exit.promise,
      isRunning: () => !exit.exited(),
      requestShutdown: async () => {
        if (exit.exited()) return
        await sendShutdown(child)
      },
      close: async () => {
        if (exit.exited()) return
        await sendShutdown(child)
        if (await exitsWithin(exit.promise, spec.stopTimeoutMs)) return
        child.kill('SIGTERM')
        if (await exitsWithin(exit.promise, spec.stopTimeoutMs)) return
        throw new E2EError({
          code: 'E2E_RUNTIME_CHILD_STOP_TIMEOUT',
          category: 'environment',
          message: 'Runtime 子进程未在期限内停止',
          retryable: false,
        })
      },
    }
  }
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => setImmediate(resolve))
  })
}

async function exitsWithin(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void exit.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function observeExit(child: ChildProcess): { exited: () => boolean; promise: Promise<void> } {
  let exited = false
  const promise = new Promise<void>((resolve) => {
    const markExited = (): void => {
      if (exited) return
      exited = true
      resolve()
    }
    child.once('error', markExited)
    child.once('exit', markExited)
  })
  return { exited: () => exited, promise }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function terminateFailedStart(
  child: ChildProcess,
  exit: { exited: () => boolean; promise: Promise<void> },
  graceMs: number,
): Promise<void> {
  if (exit.exited()) return
  child.kill('SIGTERM')
  if (await exitsWithin(exit.promise, graceMs)) return
  child.kill('SIGKILL')
  await exit.promise
}

async function waitForReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new E2EError({
        code: 'E2E_RUNTIME_CHILD_START_TIMEOUT',
        category: 'environment',
        message: 'Runtime 子进程未在期限内就绪',
        retryable: false,
      }))
    }, timeoutMs)
    const onError = (): void => {
      cleanup()
      reject(childStartFailed())
    }
    const onExit = (): void => {
      cleanup()
      reject(childStartFailed())
    }
    const onDisconnect = (): void => {
      cleanup()
      reject(childStartFailed())
    }
    const onMessage = (message: unknown): void => {
      if (!isControlMessage(message, 'ready')) return
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('disconnect', onDisconnect)
      child.off('message', onMessage)
    }
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('disconnect', onDisconnect)
    child.on('message', onMessage)
  })
}

function childStartFailed(): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CHILD_START_FAILED',
    category: 'environment',
    message: 'Runtime 子进程未就绪即退出',
    retryable: false,
  })
}

function childExitedEarly(): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CHILD_EXITED_EARLY',
    category: 'environment',
    message: 'Runtime 子进程就绪后立即退出',
    retryable: false,
  })
}

async function sendShutdown(child: ChildProcess): Promise<void> {
  if (!child.connected) return
  await new Promise<void>((resolve) => {
    try {
      child.send({ type: 'shutdown' }, () => resolve())
    } catch {
      resolve()
    }
  })
}

function isControlMessage(message: unknown, type: string): boolean {
  return typeof message === 'object'
    && message !== null
    && !Array.isArray(message)
    && (message as Record<string, unknown>).type === type
}

function childEntrypointOutsideInstallation(): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CHILD_ENTRYPOINT_OUTSIDE_INSTALLATION',
    category: 'safety',
    message: '子进程入口不在当前 Runtime 版本根目录内',
    retryable: false,
  })
}
