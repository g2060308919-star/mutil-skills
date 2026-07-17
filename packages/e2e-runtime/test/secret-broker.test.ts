import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { RuntimeSecretBroker } from '../src/secret-broker.js'
import type { SecretProvider } from '../src/secret-providers.js'
import { createRuntimeTestRoots as createBareRuntimeTestRoots } from './fixtures.js'

const cleanup: string[] = []
const execFileAsync = promisify(execFile)

async function createRuntimeTestRoots() {
  const roots = await createBareRuntimeTestRoots()
  await mkdir(join(roots.project, '.biztest'))
  await writeFile(join(roots.project, '.biztest/project.json'), JSON.stringify({
    schemaVersion: '1.0.0', projectId: `secret-tests-${roots.root.split('-').at(-1)}`,
  }))
  return roots
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })))
})

describe('RuntimeSecretBroker 持久一次性语义', () => {
  test('跨 Broker 重开后可消费，handle 可序列化内容不含明文且不可伪造或重放', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const first = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const secret = Buffer.from('ssh-secret-canary')
    await first.provide({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD', value: secret })
    secret.fill(0)
    await first.close()

    const second = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const handle = await second.resolve({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD' })
    expect(JSON.stringify(handle)).not.toContain('ssh-secret-canary')
    await expect(second.consume(Object.freeze({ handleId: handle.handleId }))).rejects.toThrow(/E2E_SECRET_HANDLE_INVALID/)
    const value = await second.consume(handle)
    try { expect(value.toString('utf8')).toBe('ssh-secret-canary') } finally { value.fill(0) }
    await expect(second.consume(handle)).rejects.toThrow(/E2E_SECRET_HANDLE_CONSUMED/)
    await second.close()

    const third = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    await expect(third.resolve({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD' }))
      .rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
    await third.close()
  })

  test('同 ref 再 provide 原子递增 version 并使旧 handle 失效', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const one = Buffer.from('first-canary')
    await broker.provide({ runId: 'RUN-1', secretRef: 'PASSWORD', value: one }); one.fill(0)
    const stale = await broker.resolve({ runId: 'RUN-1', secretRef: 'PASSWORD' })
    const two = Buffer.from('second-canary')
    await broker.provide({ runId: 'RUN-1', secretRef: 'PASSWORD', value: two }); two.fill(0)
    await expect(broker.consume(stale)).rejects.toThrow(/E2E_SECRET_HANDLE_STALE/)
    const current = await broker.resolve({ runId: 'RUN-1', secretRef: 'PASSWORD' })
    const value = await broker.consume(current)
    try { expect(value.toString()).toBe('second-canary') } finally { value.fill(0) }
    await broker.close()
  })

  test('复合 project digest/runId 主键允许两个项目使用相同 runId/ref 且互不覆盖', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const otherProject = join(roots.root, 'other-project')
    await mkdir(join(otherProject, '.biztest'), { recursive: true })
    await writeFile(join(otherProject, '.biztest/project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'other-secret-project',
    }))
    const owner = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const secret = Buffer.from('project-bound-canary')
    await owner.provide({ runId: 'RUN-SAME', secretRef: 'PASSWORD', value: secret }); secret.fill(0)
    await owner.close()
    const other = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: otherProject })
    await expect(other.resolve({ runId: 'RUN-SAME', secretRef: 'PASSWORD' }))
      .rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
    const otherValue = Buffer.from('other-project-canary')
    await other.provide({ runId: 'RUN-SAME', secretRef: 'PASSWORD', value: otherValue })
    otherValue.fill(0)
    const otherHandle = await other.resolve({ runId: 'RUN-SAME', secretRef: 'PASSWORD' })
    const otherPlaintext = await other.consume(otherHandle)
    try { expect(otherPlaintext.toString()).toBe('other-project-canary') } finally { otherPlaintext.fill(0) }
    await other.close()
    const reopenedOwner = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const ownerHandle = await reopenedOwner.resolve({ runId: 'RUN-SAME', secretRef: 'PASSWORD' })
    const ownerPlaintext = await reopenedOwner.consume(ownerHandle)
    try { expect(ownerPlaintext.toString()).toBe('project-bound-canary') } finally { ownerPlaintext.fill(0) }
    await reopenedOwner.close()
  })

  test('两个进程等价 Broker 并发消费时只有一个成功', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const seed = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const value = Buffer.from('single-consumer-canary')
    await seed.provide({ runId: 'RUN-1', secretRef: 'TOKEN', value }); value.fill(0)
    await seed.close()
    const left = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const right = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const leftHandle = await left.resolve({ runId: 'RUN-1', secretRef: 'TOKEN' })
    const rightHandle = await right.resolve({ runId: 'RUN-1', secretRef: 'TOKEN' })
    const outcomes = await Promise.allSettled([left.consume(leftHandle), right.consume(rightHandle)])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1)
    for (const outcome of outcomes) if (outcome.status === 'fulfilled') outcome.value.fill(0)
    await left.close(); await right.close()
  })

  test('真实 OS 子进程可跨进程重开并且并发时只有一个消费成功', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const fixture = fileURLToPath(new URL('./fixtures/secret-broker-child.ts', import.meta.url))
    const runChild = async (mode: 'provide' | 'consume') => await execFileAsync(
      process.execPath, ['--import', 'tsx', fixture, mode, roots.home, roots.project],
      { cwd: process.cwd(), maxBuffer: 16 * 1024 },
    )
    const provided = await runChild('provide')
    expect(provided.stdout).toBe('stored\n')
    expect(`${provided.stdout}${provided.stderr}`).not.toContain('os-process-secret-canary')
    const outcomes = await Promise.allSettled([runChild('consume'), runChild('consume')])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    const success = outcomes.find((outcome) => outcome.status === 'fulfilled')
    expect(success?.value.stdout.trim()).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(outcomes)).not.toContain('os-process-secret-canary')
  }, 15_000)

  test('系统 provider 只读取一次，密封后跨重启消费且 consumed tombstone 禁止再次读取', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    let reads = 0
    const provider: SecretProvider = {
      id: 'macos-keychain',
      async resolve() { reads += 1; return Buffer.from('keychain-secret-canary') },
    }
    const first = await RuntimeSecretBroker.open({
      homeDir: roots.home, projectRoot: roots.project, providers: [provider],
    })
    const handle = await first.resolve({
      runId: 'RUN-1', secretRef: 'PASSWORD', providerId: 'macos-keychain',
    })
    expect(reads).toBe(1)
    await first.close()

    const shouldNotRead: SecretProvider = {
      id: 'macos-keychain',
      async resolve() { reads += 1; throw new Error('must not read provider twice') },
    }
    const second = await RuntimeSecretBroker.open({
      homeDir: roots.home, projectRoot: roots.project, providers: [shouldNotRead],
    })
    await expect(second.consume(handle)).rejects.toThrow(/E2E_SECRET_HANDLE_INVALID/)
    const recoveredHandle = await second.resolve({
      runId: 'RUN-1', secretRef: 'PASSWORD', providerId: 'macos-keychain',
    })
    const value = await second.consume(recoveredHandle)
    try { expect(value.toString()).toBe('keychain-secret-canary') } finally { value.fill(0) }
    await second.close()

    const third = await RuntimeSecretBroker.open({
      homeDir: roots.home, projectRoot: roots.project, providers: [shouldNotRead],
    })
    await expect(third.resolve({
      runId: 'RUN-1', secretRef: 'PASSWORD', providerId: 'macos-keychain',
    })).rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
    expect(reads).toBe(1)
    await third.close()
  })

  test('provider 返回后的 SQLite commit 崩溃保留 resolving，过期后变 abandoned 且绝不重读', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    let now = new Date('2026-07-17T00:00:00.000Z')
    let reads = 0
    const provider: SecretProvider = {
      id: 'macos-keychain',
      async resolve() {
        reads += 1
        installSecretCommitAbort(roots.home)
        return Buffer.from('crash-window-canary')
      },
    }
    const broker = await RuntimeSecretBroker.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      providers: [provider],
      now: () => now,
      reservationTtlMs: 1_000,
    })
    await expect(broker.resolve({
      runId: 'RUN-CRASH', secretRef: 'TOKEN', providerId: 'macos-keychain',
    })).rejects.toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
    removeSecretCommitAbort(roots.home)
    now = new Date('2026-07-17T00:00:02.000Z')
    await expect(broker.resolve({
      runId: 'RUN-CRASH', secretRef: 'TOKEN', providerId: 'macos-keychain',
    })).rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
    expect(reads).toBe(1)
    await broker.close()

    const snapshot = readSecretEnvelope(roots.home)
    const entry = (Object.values(snapshot.payload.runs)[0] as any).entries.TOKEN
    expect(entry).toMatchObject({ status: 'abandoned', attemptId: expect.any(String) })
  })

  test('项目身份在 Broker 打开后改变会在公开操作前 fail closed，调用方也不能注入 digest', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    await expect(RuntimeSecretBroker.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      projectIdentityDigest: `sha256:${'0'.repeat(64)}`,
    } as never)).rejects.toThrow(/E2E_SECRET_INPUT_INVALID/)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    await writeFile(join(roots.project, '.biztest/project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'identity-rebound',
    }))
    await expect(broker.provide({
      runId: 'RUN-IDENTITY', secretRef: 'TOKEN', value: Buffer.from('x'),
    })).rejects.toThrow(/E2E_RUNTIME_PROJECT_IDENTITY_CHANGED/)
    await broker.close()
  })

  test('删除 consumed tombstone 或重放旧 revision 均在 provider 读取前失败', async () => {
    for (const attack of ['delete-tombstone', 'replay-old-revision'] as const) {
      const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
      const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
      const first = Buffer.from('integrity-canary-one')
      await broker.provide({ runId: 'RUN-INTEGRITY', secretRef: 'TOKEN', value: first }); first.fill(0)
      const old = readSecretEnvelopeRow(roots.home)
      if (attack === 'delete-tombstone') {
        const handle = await broker.resolve({ runId: 'RUN-INTEGRITY', secretRef: 'TOKEN' })
        const value = await broker.consume(handle); value.fill(0)
      } else {
        const second = Buffer.from('integrity-canary-two')
        await broker.provide({ runId: 'RUN-INTEGRITY', secretRef: 'OTHER', value: second }); second.fill(0)
      }
      await broker.close()
      const database = openSecretDatabase(roots.home)
      try {
        if (attack === 'delete-tombstone') {
          const current = database.prepare(
            'SELECT snapshot FROM authority_snapshots WHERE namespace = ?',
          ).get('e2e-runtime-secrets/v1') as { snapshot: string }
          const envelope = JSON.parse(current.snapshot) as Record<string, any>
          delete (Object.values(envelope.payload.runs)[0] as any).entries.TOKEN
          database.prepare(
            'UPDATE authority_snapshots SET snapshot = ? WHERE namespace = ?',
          ).run(JSON.stringify(envelope), 'e2e-runtime-secrets/v1')
        } else {
          database.prepare(
            'UPDATE authority_snapshots SET snapshot = ? WHERE namespace = ?',
          ).run(old.snapshot, 'e2e-runtime-secrets/v1')
        }
      } finally { database.close() }
      let reads = 0
      await expect(RuntimeSecretBroker.open({
        homeDir: roots.home,
        projectRoot: roots.project,
        providers: [{
          id: 'macos-keychain',
          async resolve() { reads += 1; return Buffer.from('must-not-read') },
        }],
      })).rejects.toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
      expect(reads).toBe(0)
    }
  })

  test('拒绝 env fallback、越界 ID、空值和超长秘密', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    process.env.LOGIN_PASSWORD = 'host-env-canary'
    try {
      await expect(broker.resolve({ runId: 'RUN-1', secretRef: 'LOGIN-PASSWORD' }))
        .rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
      await expect(broker.provide({ runId: '../RUN', secretRef: 'PASSWORD', value: Buffer.from('x') }))
        .rejects.toThrow(/E2E_SECRET_INPUT_INVALID/)
      await expect(broker.provide({ runId: 'RUN-1', secretRef: '-password', value: Buffer.from('x') }))
        .rejects.toThrow(/E2E_SECRET_INPUT_INVALID/)
      await expect(broker.provide({ runId: 'RUN-1', secretRef: 'PASSWORD', value: Buffer.alloc(65 * 1024) }))
        .rejects.toThrow(/E2E_SECRET_VALUE_TOO_LARGE/)
    } finally {
      delete process.env.LOGIN_PASSWORD
      await broker.close()
    }
  })

  test('总 snapshot 容量在 commit 前原子阻塞，失败后既有 secret 仍可消费', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const value = Buffer.alloc(64 * 1024, 71)
    let failure: unknown
    try {
      for (let index = 0; index < 80; index += 1) {
        try {
          await broker.provide({ runId: 'RUN-CAP', secretRef: `SECRET_${index}`, value })
        } catch (error) { failure = error; break }
      }
    } finally { value.fill(0) }
    expect(failure).toMatchObject({ code: 'E2E_SECRET_STATE_CAPACITY_EXCEEDED' })
    const handle = await broker.resolve({ runId: 'RUN-CAP', secretRef: 'SECRET_0' })
    const existing = await broker.consume(handle)
    try { expect(existing.byteLength).toBe(64 * 1024) } finally { existing.fill(0) }
    await broker.close()
  }, 15_000)

  test('每次加密使用不同 nonce，snapshot schema 多余字段 fail closed', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const value = Buffer.from('nonce-canary')
    await broker.provide({ runId: 'RUN-NONCE', secretRef: 'ONE', value })
    await broker.provide({ runId: 'RUN-NONCE', secretRef: 'TWO', value }); value.fill(0)
    await broker.close()
    const path = join(roots.home, '.mutil-skills/e2e/state/runtime-secrets.sqlite')
    const database = new DatabaseSync(path)
    try {
      const row = database.prepare('SELECT snapshot FROM authority_snapshots WHERE namespace = ?')
        .get('e2e-runtime-secrets/v1') as { snapshot: string }
      const snapshot = JSON.parse(row.snapshot) as Record<string, any>
      const run = Object.values(snapshot.payload.runs)[0] as any
      expect(new Set([
        run.wrappedDataKey.nonce, run.entries.ONE.encrypted.nonce, run.entries.TWO.encrypted.nonce,
      ]).size).toBe(3)
      snapshot.untrusted = true
      database.prepare('UPDATE authority_snapshots SET snapshot = ? WHERE namespace = ?')
        .run(JSON.stringify(snapshot), 'e2e-runtime-secrets/v1')
    } finally { database.close() }
    await expect(RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project }))
      .rejects.toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
  })

  test('ciphertext 不含秘密并精确认证 run/ref/provider AAD，损坏后 fail closed', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const value = Buffer.from('database-secret-canary')
    await broker.provide({ runId: 'RUN-1', secretRef: 'PASSWORD', value }); value.fill(0)
    await broker.close()
    const database = await readFile(join(roots.home, '.mutil-skills/e2e/state/runtime-secrets.sqlite'))
    expect(database.includes(Buffer.from('database-secret-canary'))).toBe(false)
    const wrongKey = randomBytes(32)
    await writeFile(join(roots.home, '.mutil-skills/e2e/authority/state.key'), wrongKey, { mode: 0o600 })
    wrongKey.fill(0)
    await expect(RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project }))
      .rejects.toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
  })

  test('修改持久 snapshot 的 run/ref/provider 绑定会因 GCM AAD 认证失败', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const value = Buffer.from('aad-binding-canary')
    await broker.provide({ runId: 'RUN-1', secretRef: 'PASSWORD', value }); value.fill(0)
    await broker.close()
    const path = join(roots.home, '.mutil-skills/e2e/state/runtime-secrets.sqlite')
    const database = new DatabaseSync(path)
    try {
      const row = database.prepare('SELECT snapshot FROM authority_snapshots WHERE namespace = ?')
        .get('e2e-runtime-secrets/v1') as { snapshot: string }
      const snapshot = JSON.parse(row.snapshot) as Record<string, any>
      const run = Object.values(snapshot.payload.runs)[0] as any
      run.entries.TOKEN = run.entries.PASSWORD
      delete run.entries.PASSWORD
      database.prepare('UPDATE authority_snapshots SET snapshot = ? WHERE namespace = ?')
        .run(JSON.stringify(snapshot), 'e2e-runtime-secrets/v1')
    } finally { database.close() }
    await expect(RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project }))
      .rejects.toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
  })
})

function openSecretDatabase(homeDir: string): DatabaseSync {
  return new DatabaseSync(join(homeDir, '.mutil-skills/e2e/state/runtime-secrets.sqlite'))
}

function readSecretEnvelopeRow(homeDir: string): { snapshot: string; revision: number } {
  const database = openSecretDatabase(homeDir)
  try {
    return database.prepare(
      'SELECT snapshot, revision FROM authority_snapshots WHERE namespace = ?',
    ).get('e2e-runtime-secrets/v1') as { snapshot: string; revision: number }
  } finally { database.close() }
}

function readSecretEnvelope(homeDir: string): Record<string, any> {
  return JSON.parse(readSecretEnvelopeRow(homeDir).snapshot) as Record<string, any>
}

function installSecretCommitAbort(homeDir: string): void {
  const database = openSecretDatabase(homeDir)
  try {
    database.exec(`
      CREATE TRIGGER runtime_secret_test_abort_commit
      BEFORE UPDATE OF snapshot ON authority_snapshots
      WHEN OLD.namespace = 'e2e-runtime-secrets/v1'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_SECRET_COMMIT_ABORT');
      END;
    `)
  } finally { database.close() }
}

function removeSecretCommitAbort(homeDir: string): void {
  const database = openSecretDatabase(homeDir)
  try { database.exec('DROP TRIGGER IF EXISTS runtime_secret_test_abort_commit') }
  finally { database.close() }
}

describe('Secret Broker 用户级文件边界', () => {
  test('state root、Authority key 与 sqlite 固定为私有权限且 state 内没有旁路 key', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    await broker.close()
    const stateRoot = join(roots.home, '.mutil-skills/e2e/state')
    expect((await stat(stateRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(join(roots.home, '.mutil-skills/e2e/authority/state.key'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(stateRoot, 'runtime-secrets.sqlite'))).mode & 0o777).toBe(0o600)
    await expect(stat(join(stateRoot, 'runtime-secrets.key'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stateRoot.startsWith(roots.project)).toBe(false)
  })

  test.each(['symlink', 'hardlink', 'mode'] as const)('拒绝 %s Authority state key', async (kind) => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const authorityRoot = join(roots.home, '.mutil-skills/e2e/authority')
    await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
    await chmod(join(roots.home, '.mutil-skills'), 0o700)
    await chmod(join(roots.home, '.mutil-skills/e2e'), 0o700)
    const key = join(authorityRoot, 'state.key')
    const canary = join(roots.source, 'canary-key')
    await writeFile(canary, Buffer.alloc(32, 9), { mode: 0o600 })
    if (kind === 'symlink') await symlink(canary, key)
    if (kind === 'hardlink') await link(canary, key)
    if (kind === 'mode') { await writeFile(key, Buffer.alloc(32, 9), { mode: 0o644 }); await chmod(key, 0o644) }
    await expect(RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project }))
      .rejects.toThrow(/E2E_APPROVAL_STATE_(?:KEY|DIRECTORY)_INVALID/)
  })

  test('拒绝 projectRoot 指向固定 state 路径', async () => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const stateRoot = join(roots.home, '.mutil-skills/e2e/state')
    await expect(RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: stateRoot }))
      .rejects.toThrow(/E2E_SECRET_STATE_INSIDE_PROJECT/)
  })

  test.each(['symlink', 'mode'] as const)('拒绝 %s state 父目录', async (kind) => {
    const roots = await createRuntimeTestRoots(); cleanup.push(roots.root)
    const product = join(roots.home, '.mutil-skills')
    if (kind === 'symlink') {
      const outside = join(roots.source, 'outside-product')
      await mkdir(outside, { mode: 0o700 })
      await symlink(outside, product)
    } else {
      await mkdir(product, { mode: 0o755 })
      await chmod(product, 0o755)
    }
    await expect(RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project }))
      .rejects.toThrow(/E2E_RUNTIME_STATE_(?:SYMLINK_FORBIDDEN|PERMISSIONS_INVALID)/)
  })
})
