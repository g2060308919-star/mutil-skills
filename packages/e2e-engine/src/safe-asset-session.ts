import { E2EError } from '@mutil-skills/e2e-contracts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

interface HelperResponse {
  id?: number
  ready?: boolean
  ok?: boolean
  result?: unknown
  code?: string
  message?: string
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const HELPER_START_TIMEOUT_MS = 10_000
const HELPER_REQUEST_TIMEOUT_MS = 30_000
const HELPER_CLOSE_TIMEOUT_MS = 5_000

export class SafeAssetSession {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, PendingRequest>()
  #nextId = 1
  #closed = false
  #stderr = ''

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-16 * 1024)
    })
    child.on('exit', () => {
      const error = sessionError('E2E_ARTIFACT_HELPER_EXITED', 'Artifact 文件系统辅助进程意外退出')
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.#pending.clear()
    })
  }

  static async acquire(assetRoot: string, python = process.env.BIZTEST_PYTHON ?? '/usr/bin/python3'): Promise<SafeAssetSession> {
    const helper = resolveHelperPath()
    const child = spawn(python, [helper, assetRoot], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    const session = new SafeAssetSession(child)
    let ready: HelperResponse
    try {
      ready = await new Promise<HelperResponse>((resolve, reject) => {
        let settled = false
        let exitCode: number | null | undefined
        let stdoutClosed = false
        let stderrClosed = false
        let handshakeOutput = ''
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          reject(sessionError('E2E_ARTIFACT_HELPER_START_TIMEOUT', 'Artifact helper 启动超时'))
        }, HELPER_START_TIMEOUT_MS)
        timer.unref()
        const onError = (cause: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(sessionError('E2E_ARTIFACT_HELPER_START_FAILED', '无法启动 Artifact 文件系统辅助进程', cause))
        }
        child.once('error', onError)
        const onData = (chunk: Buffer | string) => {
          if (settled) return
          handshakeOutput += chunk.toString()
          const newline = handshakeOutput.indexOf('\n')
          if (newline < 0) return
          settled = true
          clearTimeout(timer)
          child.off('error', onError)
          child.stdout.off('data', onData)
          try { resolve(JSON.parse(handshakeOutput.slice(0, newline)) as HelperResponse) } catch (cause) {
            reject(sessionError('E2E_ARTIFACT_HELPER_PROTOCOL_INVALID', 'Artifact helper 握手无效', cause))
          }
        }
        child.stdout.on('data', onData)
        child.once('exit', (code) => {
          exitCode = code
          rejectExitedWithoutHandshake()
        })
        child.stdout.once('close', () => {
          stdoutClosed = true
          rejectExitedWithoutHandshake()
        })
        child.stderr.once('close', () => {
          stderrClosed = true
          rejectExitedWithoutHandshake()
        })
        function rejectExitedWithoutHandshake(): void {
          if (!settled && stdoutClosed && stderrClosed
            && exitCode !== undefined && exitCode !== null && exitCode !== 0) {
            const line = handshakeOutput.trim()
            if (line) {
              settled = true
              clearTimeout(timer)
              child.stdout.off('data', onData)
              try { resolve(JSON.parse(line) as HelperResponse) } catch (cause) {
                reject(sessionError('E2E_ARTIFACT_HELPER_PROTOCOL_INVALID', 'Artifact helper 握手无效', cause))
              }
              return
            }
            settled = true
            clearTimeout(timer)
            child.stdout.off('data', onData)
            const detail = session.#stderr.trim()
            reject(sessionError('E2E_ARTIFACT_HELPER_START_FAILED',
              detail ? `Artifact helper 启动失败：${detail}` : 'Artifact helper 启动失败'))
          }
        }
      })
    } catch (error) {
      child.kill('SIGKILL')
      await session.close()
      throw error
    }
    if (!ready.ready) {
      await session.close()
      throw sessionError(ready.code ?? 'E2E_ARTIFACT_HELPER_START_FAILED', ready.message ?? 'Artifact helper 拒绝启动')
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => session.acceptLine(line))
    return session
  }

  mkdir(path: string): Promise<void> { return this.request({ operation: 'mkdir', path }).then(() => undefined) }
  removeTree(path: string, crashAt?: string): Promise<void> {
    return this.request({ operation: 'removeTree', path, crashAt }).then(() => undefined)
  }
  rename(source: string, target: string, crashAt?: string): Promise<void> {
    return this.request({ operation: 'rename', source, target, crashAt }).then(() => undefined)
  }
  syncDirectory(path = '', crashAt?: string): Promise<void> {
    return this.request({ operation: 'syncDirectory', path, crashAt }).then(() => undefined)
  }
  writeNew(path: string, content: string | Uint8Array, crashAt?: string): Promise<void> {
    return this.request({ operation: 'writeNew', path, data: encode(content), crashAt }).then(() => undefined)
  }
  writeAtomic(path: string, content: string | Uint8Array, crashAt?: string): Promise<void> {
    return this.request({ operation: 'writeAtomic', path, data: encode(content), crashAt }).then(() => undefined)
  }
  async read(path: string): Promise<Buffer> {
    const result = await this.request({ operation: 'read', path })
    if (typeof result !== 'string') throw sessionError('E2E_ARTIFACT_HELPER_PROTOCOL_INVALID', 'Artifact helper read 响应无效')
    return Buffer.from(result, 'base64')
  }
  async readOptionalText(path: string): Promise<string | undefined> {
    try { return (await this.read(path)).toString('utf8') } catch (error) {
      if (error instanceof E2EError && error.code === 'E2E_ARTIFACT_NOT_FOUND') return undefined
      throw error
    }
  }
  async list(path = ''): Promise<string[]> {
    const result = await this.request({ operation: 'list', path })
    if (!Array.isArray(result) || result.some((entry) => typeof entry !== 'string')) {
      throw sessionError('E2E_ARTIFACT_HELPER_PROTOCOL_INVALID', 'Artifact helper list 响应无效')
    }
    return result as string[]
  }
  async listFiles(path: string): Promise<Array<{ path: string; byteLength: number }>> {
    const result = await this.request({ operation: 'listFiles', path })
    if (!Array.isArray(result) || result.some((entry) => !entry || typeof entry !== 'object'
      || typeof (entry as { path?: unknown }).path !== 'string'
      || !Number.isSafeInteger((entry as { byteLength?: unknown }).byteLength)
      || ((entry as { byteLength: number }).byteLength < 0))) {
      throw sessionError('E2E_ARTIFACT_HELPER_PROTOCOL_INVALID', 'Artifact helper listFiles 响应无效')
    }
    return result as Array<{ path: string; byteLength: number }>
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#child.stdin.end()
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#child.kill('SIGKILL')
        }, HELPER_CLOSE_TIMEOUT_MS)
        timer.unref()
        this.#child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return Promise.reject(sessionError('E2E_ARTIFACT_HELPER_EXITED', 'Artifact helper 已关闭'))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        this.#child.kill('SIGKILL')
        reject(sessionError('E2E_ARTIFACT_HELPER_REQUEST_TIMEOUT', 'Artifact helper 请求超时'))
      }, HELPER_REQUEST_TIMEOUT_MS)
      timer.unref()
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (error) {
          clearTimeout(timer)
          this.#pending.delete(id)
          reject(sessionError('E2E_ARTIFACT_HELPER_WRITE_FAILED', '无法向 Artifact helper 发送请求', error))
        }
      })
    })
  }

  private acceptLine(line: string): void {
    let response: HelperResponse
    try { response = JSON.parse(line) as HelperResponse } catch (cause) {
      this.failProtocol('Artifact helper 返回非法 JSON', cause)
      return
    }
    const responseId = response.id
    if (typeof responseId !== 'number' || !Number.isSafeInteger(responseId)) {
      this.failProtocol('Artifact helper 响应缺少合法 request id')
      return
    }
    const pending = this.#pending.get(responseId)
    if (!pending) {
      this.failProtocol(`Artifact helper 返回未知 request id：${String(responseId)}`)
      return
    }
    clearTimeout(pending.timer)
    this.#pending.delete(responseId)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(sessionError(response.code ?? 'E2E_ARTIFACT_HELPER_ERROR', response.message ?? this.#stderr))
  }

  private failProtocol(message: string, cause?: unknown): void {
    const error = sessionError('E2E_ARTIFACT_HELPER_PROTOCOL_INVALID', message, cause)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#child.kill('SIGKILL')
  }
}

function resolveHelperPath(): string {
  const candidates = [
    fileURLToPath(new URL('../runtime/artifact-fs-helper.py', import.meta.url)),
    fileURLToPath(new URL('../../runtime/artifact-fs-helper.py', import.meta.url)),
  ]
  const path = candidates.find(existsSync)
  if (!path) throw sessionError('E2E_ARTIFACT_HELPER_MISSING', '缺少 artifact-fs-helper.py')
  return path
}

function encode(content: string | Uint8Array): string {
  return Buffer.from(content).toString('base64')
}

function sessionError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false, cause })
}
