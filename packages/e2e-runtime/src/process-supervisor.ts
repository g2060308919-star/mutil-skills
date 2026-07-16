import { E2EError } from '@mutil-skills/e2e-contracts'
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { RuntimeInstallation } from './runtime-discovery.js'

export interface SupervisedProcessSpec {
  entrypoint: string
  args: string[]
  cwd: string
  env: Record<string, string>
  startTimeoutMs: number
  stopTimeoutMs: number
}

export interface SupervisedProcessHandle {
  pid: number
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
    const environment = supervisedEnvironment(spec.env)

    const child = spawnChild(process.execPath, [entrypoint, ...spec.args], {
      cwd: spec.cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const exit = observeExit(child)
    await waitForReady(child, spec.startTimeoutMs)
    if (child.pid === undefined) throw new Error('Runtime child started without a pid')

    return {
      pid: child.pid,
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

function supervisedEnvironment(environment: Record<string, string>): Record<string, string> {
  const allowedKeys = ['HOME', 'LANG', 'PATH', 'TMPDIR'] as const
  const actualKeys = Object.keys(environment).sort()
  if (actualKeys.length !== allowedKeys.length
    || allowedKeys.some((key, index) => actualKeys[index] !== key)
    || allowedKeys.some((key) => typeof environment[key] !== 'string')
    || environment.LANG !== 'C.UTF-8') {
    throw new E2EError({
      code: 'E2E_RUNTIME_CHILD_ENV_INVALID',
      category: 'safety',
      message: 'Runtime 子进程环境只允许固定的无敏感键',
      retryable: false,
    })
  }
  return {
    HOME: environment.HOME,
    LANG: 'C.UTF-8',
    PATH: environment.PATH,
    TMPDIR: environment.TMPDIR,
  }
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
    child.once('exit', () => {
      exited = true
      resolve()
    })
  })
  return { exited: () => exited, promise }
}

async function waitForReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      child.kill('SIGTERM')
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
    const onMessage = (message: unknown): void => {
      if (!isControlMessage(message, 'ready')) return
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
    }
    child.once('error', onError)
    child.once('exit', onExit)
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

async function sendShutdown(child: ChildProcess): Promise<void> {
  if (!child.connected) return
  await new Promise<void>((resolve, reject) => {
    child.send({ type: 'shutdown' }, (error) => error === null ? resolve() : reject(error))
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
