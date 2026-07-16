import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ProcessSupervisor } from '../src/process-supervisor.js'
import type { RuntimeInstallation } from '../src/runtime-discovery.js'

const digest = `sha256:${'a'.repeat(64)}`
const safeEnvironment = {
  HOME: '/safe/home',
  LANG: 'C.UTF-8',
  PATH: '/usr/bin',
  TMPDIR: '/safe/tmp',
}

describe('ProcessSupervisor', () => {
  test('rejects an entrypoint whose realpath escapes the installation version root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const outsideEntrypoint = join(root, 'outside.mjs')
      const linkedEntrypoint = join(versionRoot, 'child.mjs')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(outsideEntrypoint, '', { mode: 0o600 })
      await symlink(outsideEntrypoint, linkedEntrypoint)
      const canonicalVersionRoot = await realpath(versionRoot)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, linkedEntrypoint))

      await expect(supervisor.spawn({
        entrypoint: linkedEntrypoint,
        args: [],
        cwd: canonicalVersionRoot,
        env: {},
        startTimeoutMs: 100,
        stopTimeoutMs: 100,
      })).rejects.toMatchObject({
        code: 'E2E_RUNTIME_CHILD_ENTRYPOINT_OUTSIDE_INSTALLATION',
        category: 'safety',
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('starts JavaScript with Node without a shell and closes it through IPC shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    let handle: Awaited<ReturnType<ProcessSupervisor['spawn']>> | undefined
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const entrypoint = join(versionRoot, 'child.mjs')
      const marker = join(root, 'child.json')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(entrypoint, `
        import { writeFileSync } from 'node:fs'
        writeFileSync(process.argv[2], JSON.stringify({
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          env: process.env,
          execPath: process.execPath,
        }))
        process.on('message', (message) => {
          if (message?.type === 'shutdown') process.exit(0)
        })
        process.send?.({ type: 'ready' })
      `, { mode: 0o600 })
      const canonicalVersionRoot = await realpath(versionRoot)
      const canonicalEntrypoint = await realpath(entrypoint)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, canonicalEntrypoint))

      handle = await supervisor.spawn({
        entrypoint: canonicalEntrypoint,
        args: [marker, '; touch should-not-exist'],
        cwd: canonicalVersionRoot,
        env: safeEnvironment,
        startTimeoutMs: 2_000,
        stopTimeoutMs: 500,
      })
      const observed = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>

      expect(handle.pid).toBeGreaterThan(0)
      expect(observed).toMatchObject({
        argv: [marker, '; touch should-not-exist'],
        cwd: canonicalVersionRoot,
        execPath: process.execPath,
      })
      const observedEnvironment = observed.env as Record<string, string>
      expect(observedEnvironment).toMatchObject(safeEnvironment)
      expect(Object.keys(observedEnvironment).filter((key) => key !== '__CF_USER_TEXT_ENCODING').sort())
        .toEqual(Object.keys(safeEnvironment).sort())
      await handle.close()
      handle = undefined
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(root, { force: true, recursive: true })
    }
  })

  test('returns a stable error and terminates a child that misses its ready deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const entrypoint = join(versionRoot, 'child.mjs')
      const marker = join(root, 'child.pid')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(entrypoint, `
        import { writeFileSync } from 'node:fs'
        writeFileSync(process.argv[2], String(process.pid))
        setInterval(() => {}, 1_000)
      `, { mode: 0o600 })
      const canonicalVersionRoot = await realpath(versionRoot)
      const canonicalEntrypoint = await realpath(entrypoint)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, canonicalEntrypoint))

      await expect(supervisor.spawn({
        entrypoint: canonicalEntrypoint,
        args: [marker],
        cwd: canonicalVersionRoot,
        env: safeEnvironment,
        startTimeoutMs: 100,
        stopTimeoutMs: 100,
      })).rejects.toMatchObject({
        code: 'E2E_RUNTIME_CHILD_START_TIMEOUT',
        category: 'environment',
      })
      const pid = Number(await readFile(marker, 'utf8'))
      await expectProcessExit(pid)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('escalates IPC shutdown to SIGTERM and returns a stable stop-timeout error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    let pid: number | undefined
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const entrypoint = join(versionRoot, 'child.mjs')
      const marker = join(root, 'signal.txt')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(entrypoint, `
        import { writeFileSync } from 'node:fs'
        process.on('message', () => {})
        process.on('SIGTERM', () => writeFileSync(process.argv[2], 'SIGTERM'))
        setTimeout(() => process.exit(0), 500)
        process.send?.({ type: 'ready' })
      `, { mode: 0o600 })
      const canonicalVersionRoot = await realpath(versionRoot)
      const canonicalEntrypoint = await realpath(entrypoint)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, canonicalEntrypoint))
      const handle = await supervisor.spawn({
        entrypoint: canonicalEntrypoint,
        args: [marker],
        cwd: canonicalVersionRoot,
        env: safeEnvironment,
        startTimeoutMs: 2_000,
        stopTimeoutMs: 30,
      })
      pid = handle.pid

      await expect(handle.close()).rejects.toMatchObject({
        code: 'E2E_RUNTIME_CHILD_STOP_TIMEOUT',
        category: 'environment',
      })
      expect(await readFile(marker, 'utf8')).toBe('SIGTERM')
    } finally {
      if (pid !== undefined) await killProcessIfRunning(pid)
      await rm(root, { force: true, recursive: true })
    }
  })

  test('rejects caller-added environment keys before starting the child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const entrypoint = join(versionRoot, 'child.mjs')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(entrypoint, `
        setTimeout(() => process.exit(0), 300)
        process.send?.({ type: 'ready' })
      `, { mode: 0o600 })
      const canonicalVersionRoot = await realpath(versionRoot)
      const canonicalEntrypoint = await realpath(entrypoint)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, canonicalEntrypoint))

      await expect(supervisor.spawn({
        entrypoint: canonicalEntrypoint,
        args: [],
        cwd: canonicalVersionRoot,
        env: { ...safeEnvironment, AWS_SECRET_ACCESS_KEY: 'canary' },
        startTimeoutMs: 2_000,
        stopTimeoutMs: 100,
      })).rejects.toMatchObject({
        code: 'E2E_RUNTIME_CHILD_ENV_INVALID',
        category: 'safety',
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('maps an early child exit to a stable sanitized start error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const entrypoint = join(versionRoot, 'child.mjs')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(entrypoint, 'process.exit(12)', { mode: 0o600 })
      const canonicalVersionRoot = await realpath(versionRoot)
      const canonicalEntrypoint = await realpath(entrypoint)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, canonicalEntrypoint))

      await expect(supervisor.spawn({
        entrypoint: canonicalEntrypoint,
        args: [],
        cwd: canonicalVersionRoot,
        env: safeEnvironment,
        startTimeoutMs: 2_000,
        stopTimeoutMs: 100,
      })).rejects.toMatchObject({
        code: 'E2E_RUNTIME_CHILD_START_FAILED',
        category: 'environment',
        message: 'Runtime 子进程未就绪即退出',
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('requestShutdown sends the fixed IPC shutdown message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-supervisor-'))
    let handle: Awaited<ReturnType<ProcessSupervisor['spawn']>> | undefined
    try {
      const versionRoot = join(root, 'versions', '0.0.0')
      const entrypoint = join(versionRoot, 'child.mjs')
      const marker = join(root, 'shutdown.txt')
      await mkdir(versionRoot, { recursive: true })
      await writeFile(entrypoint, `
        import { writeFileSync } from 'node:fs'
        process.on('message', (message) => {
          if (message?.type === 'shutdown') {
            writeFileSync(process.argv[2], 'shutdown')
            process.exit(0)
          }
        })
        process.send?.({ type: 'ready' })
      `, { mode: 0o600 })
      const canonicalVersionRoot = await realpath(versionRoot)
      const canonicalEntrypoint = await realpath(entrypoint)
      const supervisor = new ProcessSupervisor(installation(canonicalVersionRoot, canonicalEntrypoint))
      handle = await supervisor.spawn({
        entrypoint: canonicalEntrypoint,
        args: [marker],
        cwd: canonicalVersionRoot,
        env: safeEnvironment,
        startTimeoutMs: 2_000,
        stopTimeoutMs: 100,
      })

      await handle.requestShutdown()
      await expectProcessExit(handle.pid)
      expect(await readFile(marker, 'utf8')).toBe('shutdown')
      await handle.close()
      handle = undefined
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(root, { force: true, recursive: true })
    }
  })
})

function installation(versionRoot: string, entrypoint: string): RuntimeInstallation {
  return {
    version: '0.0.0',
    protocolMajor: 1,
    versionRoot,
    entrypoint,
    installationDigest: digest,
    sourceRepositoryIndependent: true,
  }
}

async function expectProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`child process ${pid} did not exit`)
}

async function killProcessIfRunning(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw error
  }
  await expectProcessExit(pid)
}
