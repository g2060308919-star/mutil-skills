import { Readable, Writable } from 'node:stream'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { E2EError } from '@mutil-skills/e2e-contracts'
import { runCli, type RuntimeCliDependencies, type SecretTerminalAdapter } from '../src/cli.js'
import { RuntimeSecretBroker } from '../src/secret-broker.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { createRuntimeTestRoots } from './fixtures.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })))
})

describe('repo-e2e secret provide', () => {
  test('真实 TTY adapter 关闭 echo/raw 后只输出无秘密的严格 JSON，且新 Broker 可消费', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    await writeProjectIdentity(roots.project, 'PROJECT-SECRET-CLI-REAL')
    await seedActiveCliRun(roots.home, roots.project, 'RUN-1')
    const stdout = captureWritable(); const stderr = captureWritable()
    const terminal = terminalWith([Buffer.from('interactive-secret-canary'), Buffer.from('\n')])
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    delete deps.openSecretBroker
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'LOGIN-PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream,
      deps,
    )
    expect(exitCode).toBe(0)
    expect(terminal.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false)
    expect(JSON.parse(stdout.text())).toEqual({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD', status: 'stored' })
    expect(`${stdout.text()}${stderr.text()}`).not.toContain('interactive-secret-canary')

    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const handle = await broker.resolve({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD' })
    const value = await broker.consume(handle)
    try { expect(value.toString()).toBe('interactive-secret-canary') } finally { value.fill(0) }
    await broker.close()
  })

  test('非 TTY 稳定阻塞且不创建 Broker', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const stdout = captureWritable(); const stderr = captureWritable()
    const terminal = terminalWith([], false)
    const openSecretBroker = vi.fn()
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    deps.openSecretBroker = openSecretBroker
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from(['piped-secret-canary']), stdout.stream, stderr.stream, deps,
    )
    expect(exitCode).toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_SECRET_INTERACTIVE_TTY_REQUIRED' },
    })
    expect(openSecretBroker).not.toHaveBeenCalled()
    expect(`${stdout.text()}${stderr.text()}`).not.toContain('piped-secret-canary')
  })

  test.each([
    ['interrupt', [Buffer.from([0x03])]],
    ['read-error', new Error('terminal-secret-canary')],
    ['store-error', [Buffer.from('terminal-secret-canary\n')]],
  ] as const)('%s 路径均恢复终端且错误输出脱敏', async (kind, input) => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const stdout = captureWritable(); const stderr = captureWritable()
    const terminal = input instanceof Error ? throwingTerminal(input) : terminalWith([...input])
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    if (kind === 'store-error') {
      deps.openSecretBroker = async () => ({
        provide: async () => { throw new Error('store-terminal-secret-canary') },
        close: async () => undefined,
      })
    }
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream, deps,
    )
    expect(exitCode).not.toBe(0)
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false)
    expect(`${stdout.text()}${stderr.text()}`).not.toMatch(/terminal-secret-canary|store-terminal/)
  })

  test('严格拒绝额外参数、非法 run/ref，并且不读取 TTY', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    for (const arguments_ of [
      ['secret', 'provide', '--run-id', '../RUN', '--ref', 'PASSWORD'],
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', '--password'],
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD', '--provider', 'env'],
    ]) {
      const stdout = captureWritable(); const stderr = captureWritable()
      const terminal = terminalWith([Buffer.from('must-not-read')])
      const exitCode = await runCli(
        arguments_, Readable.from([]), stdout.stream, stderr.stream,
        dependencies(roots.home, terminal, async () => undefined, roots.project),
      )
      expect(exitCode).toBe(2)
      expect(terminal.setRawMode).not.toHaveBeenCalled()
    }
  })

  test('终端恢复失败时 fail closed，且不会把已读 secret 写入 Broker', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const stdout = captureWritable(); const stderr = captureWritable()
    const terminal = terminalWith([Buffer.from('restore-failure-canary\n')])
    terminal.setRawMode.mockImplementation((enabled: boolean) => {
      if (!enabled) throw new Error('restore-failure-canary')
    })
    const provide = vi.fn()
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    deps.openSecretBroker = async () => ({ provide, close: async () => undefined })
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream, deps,
    )
    expect(exitCode).toBe(4)
    expect(provide).not.toHaveBeenCalled()
    expect(`${stdout.text()}${stderr.text()}`).not.toContain('restore-failure-canary')
  })

  test('读取主错误不会被终端恢复错误覆盖，setRawMode(true) 失败也会尝试恢复', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    for (const failAt of ['read', 'enable'] as const) {
      const stdout = captureWritable(); const stderr = captureWritable()
      const terminal = failAt === 'read'
        ? throwingTerminal(new Error('primary-read-canary'))
        : terminalWith([])
      terminal.setRawMode.mockImplementation((enabled: boolean) => {
        if ((failAt === 'enable' && enabled) || (failAt === 'read' && !enabled)) {
          throw new Error(enabled ? 'enable-canary' : 'restore-canary')
        }
      })
      const exitCode = await runCli(
        ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
        Readable.from([]), stdout.stream, stderr.stream,
        dependencies(roots.home, terminal, async () => undefined, roots.project),
      )
      expect(exitCode).toBe(4)
      expect(terminal.setRawMode).toHaveBeenCalledWith(false)
      expect(JSON.parse(stdout.text())).toMatchObject({
        error: { code: 'E2E_SECRET_INTERACTIVE_FAILED' },
      })
      expect(`${stdout.text()}${stderr.text()}`).not.toMatch(/primary-read|enable-canary|restore-canary/)
    }
  })

  test('EOF 可结束一次输入并将 terminal adapter 提供的原始 Buffer 清零', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    await writeProjectIdentity(roots.project, 'PROJECT-SECRET-CLI-EOF')
    await seedActiveCliRun(roots.home, roots.project, 'RUN-1')
    const raw = Buffer.from('eof-secret-canary')
    const terminal = terminalWith([raw])
    const stdout = captureWritable(); const stderr = captureWritable()
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    delete deps.openSecretBroker
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream,
      deps,
    )
    expect(exitCode).toBe(0)
    expect([...raw]).toEqual(new Array(raw.length).fill(0))
  })

  test('Ctrl-D 结束输入、退格删除字节，并恢复进入前已开启的 raw 状态', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const chunk = Buffer.from([0x61, 0x62, 0x7f, 0x63, 0x04, 0x64])
    const terminal = terminalWith([chunk], true, true)
    const stdout = captureWritable(); const stderr = captureWritable()
    const provide = vi.fn(async (input: { value: Uint8Array }) => {
      expect(Buffer.from(input.value).toString()).toBe('ac')
    })
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    deps.openSecretBroker = async () => ({ provide, close: async () => undefined })
    expect(await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream, deps,
    )).toBe(0)
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(true)
    expect([...chunk]).toEqual(new Array(chunk.length).fill(0))
  })

  test('provide 返回后立即清零明文，broker close 与 stdout 写入阶段只看到零值', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    let provided: Uint8Array | undefined
    const phases: string[] = []
    const terminal: SecretTerminalAdapter = {
      isTTY: true,
      setRawMode() {},
      async *read() { phases.push('read'); yield Buffer.from('clear-before-close-canary\n') },
    }
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    deps.openSecretBroker = async () => {
      phases.push('open')
      return {
        async provide(input) { phases.push('provide'); provided = input.value },
        async close() {
          phases.push('close')
          expect(provided).toBeDefined()
          expect([...provided!]).toEqual(new Array(provided!.byteLength).fill(0))
        },
      }
    }
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        phases.push('write')
        expect([...provided!]).toEqual(new Array(provided!.byteLength).fill(0))
        callback()
      },
    })
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout, captureWritable().stream, deps,
    )
    expect(exitCode).toBe(0)
    expect(phases).toEqual(['open', 'read', 'provide', 'close', 'write'])
  })

  test('进入前 raw 已开启时，中断失败也恢复为 raw 开启状态', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const terminal = terminalWith([Buffer.from([0x03])], true, true)
    const stdout = captureWritable(); const stderr = captureWritable()
    expect(await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream,
      dependencies(roots.home, terminal, async () => undefined, roots.project),
    )).toBe(4)
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(true)
  })

  test('交互输入使用固定 64KiB 上限，超限后清零输入且不写 Broker', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const chunk = Buffer.alloc(64 * 1024 + 1, 0x61)
    const terminal = terminalWith([chunk])
    const stdout = captureWritable(); const stderr = captureWritable()
    const provide = vi.fn()
    const deps = dependencies(roots.home, terminal, async () => undefined, roots.project)
    deps.openSecretBroker = async () => ({ provide, close: async () => undefined })
    expect(await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream, deps,
    )).toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({ error: { code: 'E2E_SECRET_VALUE_TOO_LARGE' } })
    expect(provide).not.toHaveBeenCalled()
    expect([...chunk]).toEqual(new Array(chunk.length).fill(0))
  })

  test('Broker 主错误不会被 close cleanup 错误覆盖', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const stdout = captureWritable(); const stderr = captureWritable()
    const deps = dependencies(
      roots.home, terminalWith([Buffer.from('cleanup-secret-canary\n')]),
      async () => undefined, roots.project,
    )
    deps.openSecretBroker = async () => ({
      provide: async () => { throw new E2EError({
        code: 'E2E_SECRET_PRIMARY_FAILURE', category: 'safety',
        message: 'primary failure', retryable: false,
      }) },
      close: async () => { throw new Error('cleanup-secret-canary') },
    })
    const exitCode = await runCli(
      ['secret', 'provide', '--run-id', 'RUN-1', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream, deps,
    )
    expect(exitCode).toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({ error: { code: 'E2E_SECRET_PRIMARY_FAILURE' } })
    expect(`${stdout.text()}${stderr.text()}`).not.toContain('cleanup-secret-canary')
  })

  test('默认 CLI 从 Task4 Run Store 复验当前项目 Run，Broker 自行解析项目 identity', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    await mkdir(`${roots.project}/.biztest`)
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-SECRET-CLI',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const requestDigest = digest('a')
    await store.beginRequest('REQUEST-SEED', requestDigest)
    const lock = await store.acquireRunLock(identity.digest, 'RUN-BOUND')
    const snapshot: RuntimeRunSnapshot = {
      schemaVersion: '1.0.0', runId: 'RUN-BOUND', assetId: 'ASSET-1',
      projectIdentityDigest: identity.digest, runtimeInstallationDigest: digest('b'),
      workflow: createWorkflow(), artifactDigests: { 'prd-source': digest('c') },
      requestResponses: {}, createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    }
    await store.createRunOutcome(snapshot, 'REQUEST-SEED', requestDigest, { ok: true }, lock)
    await lock.close(); await store.close()

    const openSecretBroker = vi.fn(async () => ({
      provide: async () => undefined, close: async () => undefined,
    }))
    const deps = dependencies(
      roots.home, terminalWith([Buffer.from('bound-secret-canary\n')]),
      async () => { throw new Error('injected validator must not be used') }, roots.project,
    )
    delete deps.validateSecretRun
    deps.openSecretBroker = openSecretBroker
    const stdout = captureWritable(); const stderr = captureWritable()
    expect(await runCli(
      ['secret', 'provide', '--run-id', 'RUN-BOUND', '--ref', 'PASSWORD'],
      Readable.from([]), stdout.stream, stderr.stream, deps,
    )).toBe(0)
    expect(openSecretBroker).toHaveBeenCalledWith({
      homeDir: roots.home, projectRoot: roots.project,
    })
  })

  test('预检查后 Run 进入终态时，生产 Broker 在持锁 provide 边界拒绝 TOCTOU', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    await writeProjectIdentity(roots.project, 'PROJECT-SECRET-CLI-RACE')
    await seedActiveCliRun(roots.home, roots.project, 'RUN-RACE')
    const identity = await resolveProjectIdentity(roots.project)
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await store.acquireRunLock(identity.digest, 'RUN-RACE')
    const deps = dependencies(
      roots.home,
      terminalWith([Buffer.from('terminal-race-secret\n')]),
      async () => {
        const requestDigest = digest('4')
        await store.beginRequest('TERMINATE-RUN-RACE', requestDigest)
        await store.updateRunOutcome(
          identity.digest, 'RUN-RACE', 'TERMINATE-RUN-RACE', requestDigest,
          (snapshot) => ({
            snapshot: {
              ...snapshot,
              workflow: { ...snapshot.workflow, current: 'accepted', sequence: snapshot.workflow.sequence + 1 },
            },
            response: { terminal: true },
          }),
          'terminal-race', lock,
        )
      },
      roots.project,
    )
    delete deps.openSecretBroker
    const stdout = captureWritable(); const stderr = captureWritable()
    try {
      expect(await runCli(
        ['secret', 'provide', '--run-id', 'RUN-RACE', '--ref', 'PASSWORD'],
        Readable.from([]), stdout.stream, stderr.stream, deps,
      )).toBe(4)
      expect(JSON.parse(stdout.text())).toMatchObject({ error: { code: 'E2E_SECRET_RUN_TERMINAL' } })
      expect(`${stdout.text()}${stderr.text()}`).not.toContain('terminal-race-secret')
    } finally { await lock.close(); await store.close() }
  })
})

function dependencies(
  homeDir: string,
  secretTerminal: SecretTerminalAdapter,
  validateSecretRun: (runId: string) => Promise<void>,
  projectRoot: string,
): RuntimeCliDependencies {
  return {
    homeDir,
    installRuntime: async () => ({ version: '0.0.0', installationDigest: `sha256:${'0'.repeat(64)}`, launcher: '/safe' }),
    uninstallRuntime: async () => ({ version: '0.0.0' }),
    secretTerminal,
    validateSecretRun,
    currentWorkingDirectory: () => projectRoot,
    openSecretBroker: async () => ({
      provide: async () => undefined,
      close: async () => undefined,
    }),
  }
}

function terminalWith(
  chunks: Buffer[], isTTY = true, isRaw = false,
): SecretTerminalAdapter & { setRawMode: ReturnType<typeof vi.fn> } {
  return {
    isTTY, isRaw,
    setRawMode: vi.fn(),
    async *read() { for (const chunk of chunks) yield chunk },
  }
}

function throwingTerminal(error: Error): SecretTerminalAdapter & { setRawMode: ReturnType<typeof vi.fn> } {
  return {
    isTTY: true,
    setRawMode: vi.fn(),
    async *read() { throw error },
  }
}

function captureWritable(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = []
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`
}

async function writeProjectIdentity(projectRoot: string, projectId: string): Promise<void> {
  await mkdir(`${projectRoot}/.biztest`, { recursive: true })
  await writeFile(`${projectRoot}/.biztest/project.json`, JSON.stringify({
    schemaVersion: '1.0.0', projectId,
  }))
}

async function seedActiveCliRun(homeDir: string, projectRoot: string, runId: string): Promise<void> {
  const identity = await resolveProjectIdentity(projectRoot)
  const store = await RuntimeRunStore.open({ homeDir, projectRoot })
  const requestDigest = digest('7')
  const lock = await store.acquireRunLock(identity.digest, runId)
  try {
    await store.beginRequest(`SEED-${runId}`, requestDigest)
    await store.createRunOutcome({
      schemaVersion: '1.0.0', runId, assetId: `ASSET-${runId}`,
      projectIdentityDigest: identity.digest, runtimeInstallationDigest: digest('6'),
      workflow: createWorkflow(), artifactDigests: { 'prd-source': digest('5') },
      requestResponses: {}, createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    }, `SEED-${runId}`, requestDigest, { seeded: true }, lock)
  } finally { await lock.close(); await store.close() }
}
