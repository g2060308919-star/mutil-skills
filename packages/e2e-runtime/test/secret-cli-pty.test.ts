import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

describe('repo-e2e secret provide 真实 PTY', () => {
  test('真实 TTY raw mode 不回显 secret，支持退格/Ctrl-D 并在退出前恢复', async (context) => {
    if (process.platform !== 'darwin') {
      context.skip('当前 PTY helper 使用 macOS 系统 Python pty 实现')
      return
    }
    const expected = Buffer.from([0x70, 0x74, 0x79, 0x2d, 0x61, 0x63])
    const digest = `sha256:${createHash('sha256').update(expected).digest('hex')}`
    expected.fill(0)
    const helper = fileURLToPath(new URL('./fixtures/secret-cli-pty-helper.ts', import.meta.url))
    const ptyHelper = fileURLToPath(new URL('./fixtures/run-in-secret-pty.py', import.meta.url))
    const child = spawn('/usr/bin/python3', [
      ptyHelper, process.execPath, '--import', 'tsx', helper, digest,
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)))
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
      child.once('error', () => { clearTimeout(timeout); resolve({ code: null, signal: null }) })
      child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
    })
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8')
    for (const chunk of [...stdout, ...stderr]) chunk.fill(0)
    if (result.code === 77 && output.includes('SANDBOX_PTY_DENIED')) {
      context.skip('sandbox 明确禁止创建 PTY，真实 PTY 断言在非 sandbox gate 执行')
      return
    }
    expect(result).toEqual({ code: 0, signal: null })
    expect(output).toContain('PTY_RAW_READY')
    expect(output).toContain('PTY_RAW_RESTORED')
    expect(output).toContain('"status":"stored"')
    expect(output).not.toContain('pty-')
  }, 10_000)
})
