import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SandboxedOneShotExecutor, type OneShotExecFile } from '../src/sandboxed-one-shot-executor.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('SandboxedOneShotExecutor', () => {
  test.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))(
    '真实 macOS sandbox 可在只读 staging 中执行 Playwright list', async () => {
      const root = await mkdtemp(join(tmpdir(), 'e2e-one-shot-real-')); roots.push(root)
      const staging = join(root, 'staging')
      await mkdir(join(staging, 'tests'), { recursive: true })
      await Promise.all([
        writeFile(join(staging, 'package.json'), '{"type":"module"}\n'),
        writeFile(join(staging, 'playwright.config.js'),
          "import { defineConfig } from '@playwright/test'; export default defineConfig({ testDir: './tests' });\n"),
        writeFile(join(staging, 'tests', 'generated.spec.js'),
          "import { test } from '@playwright/test'; test('CASE-1', async () => {});\n"),
      ])
      const require = createRequire(import.meta.url)
      const cliPath = require.resolve('@playwright/test/cli')
      const packagePath = require.resolve('@playwright/test/package.json')
      const modulesRoot = dirname(dirname(dirname(packagePath)))
      await symlink(modulesRoot, join(staging, 'node_modules'), 'dir')
      const executor = await SandboxedOneShotExecutor.create({ tempParent: root })
      const result = await executor.execute({
        command: process.execPath, args: [cliPath, 'test', '--list', '--reporter=json'], cwd: staging,
        readOnlyRoots: [staging, modulesRoot, dirname(process.execPath)], timeoutMs: 30_000,
      })

      if (result.exitCode !== 0) throw new Error(`Playwright list failed: ${result.stderr}`)
      expect(result.stdout).toContain('CASE-1')
    },
    30_000,
  )

  test('只在实际 macOS sandbox backend 中用固定最小 env 与临时 HOME 执行，并返回不可伪造路径的证明', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-one-shot-')); roots.push(root)
    const staging = join(root, 'staging'); const runtime = join(root, 'runtime')
    await mkdir(staging); await mkdir(runtime)
    const command = join(runtime, 'node'); const backendPath = join(runtime, 'sandbox-exec')
    await writeFile(command, 'node'); await writeFile(backendPath, 'sandbox')
    let captured: Parameters<OneShotExecFile> | undefined
    const execFile: OneShotExecFile = async (...args) => {
      captured = args
      return { stdout: '{"ok":true}', stderr: '', exitCode: 0 }
    }
    const executor = await SandboxedOneShotExecutor.createForTesting({
      backend: 'macos-sandbox-exec', backendPath, tempParent: root, execFile,
    })
    const result = await executor.execute({ command, args: ['--list'], cwd: staging,
      readOnlyRoots: [runtime, staging], timeoutMs: 5_000 })

    expect(result).toMatchObject({ backend: 'macos-sandbox-exec', stdout: '{"ok":true}', exitCode: 0 })
    expect(result.proofDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain(root)
    expect(captured?.[0]).toBe(backendPath)
    expect(captured?.[1]).toEqual(expect.arrayContaining(['-p', await realpath(command), '--list']))
    const policy = captured?.[1][1] ?? ''
    expect(policy).not.toContain('(subpath "/private")')
    expect(policy).not.toContain('(subpath "/Users")')
    expect(policy).not.toContain('(subpath "/home")')
    expect(policy).not.toContain('(subpath "/opt")')
    const options = captured?.[2]
    expect(options?.env).toEqual({
      CI: '1', FORCE_COLOR: '0', HOME: expect.stringContaining('e2e-one-shot-home-'), LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8', NO_PROXY: '*', PATH: '/usr/bin:/bin', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      TMPDIR: expect.stringContaining('e2e-one-shot-home-'), no_proxy: '*', npm_config_offline: 'true',
    })
  })

  test('不支持的 OS 或缺失 production backend 时 fail closed，不直接执行命令', async () => {
    await expect(SandboxedOneShotExecutor.create({ platform: 'win32' as NodeJS.Platform }))
      .rejects.toMatchObject({ code: 'E2E_ONE_SHOT_SANDBOX_UNAVAILABLE' })
  })
})
