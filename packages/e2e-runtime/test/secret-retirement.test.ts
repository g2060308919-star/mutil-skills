import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveProjectIdentity } from '../src/project-identity.js'
import {
  consumeRuntimeSecretRetirementCapability,
  RuntimeRunStore,
  type RuntimeRunSnapshot,
} from '../src/run-store.js'
import { RuntimeSecretBroker } from '../src/secret-broker.js'
import { createRuntimeTestRoots as createBareRuntimeTestRoots } from './fixtures.js'

const cleanup: string[] = []
const digest = (character: string): string => `sha256:${character.repeat(64)}`

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, {
    recursive: true, force: true,
  })))
})

describe('Secret tombstone 终态退役 capability', () => {
  test('未执行 Secret 退役的终态 Run 也在 Broker 生产边界拒绝 provide/system resolve', async () => {
    const roots = await createSecretRoots('terminal-access'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createTerminalRun(runStore, identity.digest, 'RUN-TERMINAL')
    let providerReads = 0
    const broker = await RuntimeSecretBroker.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      providers: [{
        id: 'macos-keychain',
        async resolve() { providerReads += 1; return Buffer.from('must-not-read') },
      }],
    })
    const value = Buffer.from('must-not-store')
    try {
      await expect(broker.provide({
        runId: 'RUN-TERMINAL', secretRef: 'TOKEN', value,
      })).rejects.toThrow(/E2E_SECRET_RUN_TERMINAL/)
    } finally { value.fill(0) }
    await expect(broker.resolve({
      runId: 'RUN-TERMINAL', secretRef: 'SYSTEM', providerId: 'macos-keychain',
    })).rejects.toThrow(/E2E_SECRET_RUN_TERMINAL/)
    expect(providerReads).toBe(0)
    await broker.close(); await lock.close(); await runStore.close()
  })

  test('provider pending 期间不持 RunStore 锁，返回后终态复验只写 abandoned 不密封', async () => {
    const roots = await createSecretRoots('provider-terminal-race'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createRun(runStore, runSnapshot(identity.digest, 'RUN-RACE', false))
    let providerStarted!: () => void
    const started = new Promise<void>((resolve) => { providerStarted = resolve })
    let releaseProvider!: () => void
    const released = new Promise<void>((resolve) => { releaseProvider = resolve })
    const broker = await RuntimeSecretBroker.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      providers: [{
        id: 'macos-keychain',
        async resolve() {
          providerStarted()
          await released
          return Buffer.from('provider-race-canary')
        },
      }],
    })
    const resolving = broker.resolve({
      runId: 'RUN-RACE', secretRef: 'SYSTEM', providerId: 'macos-keychain',
    })
    await started
    await makeRunTerminal(runStore, identity.digest, 'RUN-RACE', lock)
    releaseProvider()
    await expect(resolving).rejects.toThrow(/E2E_SECRET_RUN_TERMINAL/)

    const database = new DatabaseSync(join(roots.home, '.mutil-skills/e2e/state/runtime-secrets.sqlite'))
    const row = database.prepare(
      'SELECT snapshot FROM authority_snapshots WHERE namespace = ?',
    ).get('e2e-runtime-secrets/v1') as { snapshot: string }
    database.close()
    const envelope = JSON.parse(row.snapshot) as Record<string, any>
    expect((Object.values(envelope.payload.runs)[0] as any).entries.SYSTEM.status).toBe('abandoned')

    await broker.close(); await lock.close(); await runStore.close()
  })

  test('退役保留认证 Run tombstone，禁止 provider 重读、直接 provide 和旧 handle 消费', async () => {
    const roots = await createSecretRoots('retirement-tombstone'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createRun(runStore, runSnapshot(identity.digest, 'RUN-RETIRED', false))
    let providerReads = 0
    const broker = await RuntimeSecretBroker.open({
      homeDir: roots.home,
      projectRoot: roots.project,
      providers: [{
        id: 'macos-keychain',
        async resolve() { providerReads += 1; return Buffer.from('must-never-be-read') },
      }],
    })
    const secret = Buffer.from('retired-secret-canary')
    await broker.provide({ runId: 'RUN-RETIRED', secretRef: 'TOKEN', value: secret })
    secret.fill(0)
    const oldHandle = await broker.resolve({ runId: 'RUN-RETIRED', secretRef: 'TOKEN' })
    await makeRunTerminal(runStore, identity.digest, 'RUN-RETIRED', lock)
    const capability = await runStore.authorizeSecretRetirement(identity.digest, 'RUN-RETIRED', lock)

    await broker.retireRunSecrets(capability)

    const replacement = Buffer.from('replacement-must-be-rejected')
    try {
      await expect(broker.provide({
        runId: 'RUN-RETIRED', secretRef: 'TOKEN', value: replacement,
      })).rejects.toThrow(/E2E_SECRET_RUN_(?:TERMINAL|RETIRED)/)
    } finally { replacement.fill(0) }
    await expect(broker.resolve({
      runId: 'RUN-RETIRED', secretRef: 'SYSTEM', providerId: 'macos-keychain',
    })).rejects.toThrow(/E2E_SECRET_RUN_(?:TERMINAL|RETIRED)/)
    await expect(broker.consume(oldHandle)).rejects.toThrow(/E2E_SECRET_RUN_(?:TERMINAL|RETIRED)/)
    expect(providerReads).toBe(0)

    await broker.close()
    await lock.close()
    await runStore.close()
  })

  test('只有当前 lease 下的终态 capability 可删除且 capability 不可重放或伪造', async () => {
    const roots = await createSecretRoots('retirement-main'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createRun(runStore, runSnapshot(identity.digest, 'RUN-RETIRE', false))
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const secret = Buffer.from('retirement-canary')
    await broker.provide({ runId: 'RUN-RETIRE', secretRef: 'TOKEN', value: secret })
    secret.fill(0)

    await expect(broker.retireRunSecrets(Object.freeze({}) as never))
      .rejects.toThrow(/E2E_SECRET_RETIREMENT_CAPABILITY_INVALID/)
    await makeRunTerminal(runStore, identity.digest, 'RUN-RETIRE', lock)
    const capability = await runStore.authorizeSecretRetirement(identity.digest, 'RUN-RETIRE', lock)
    await expect(broker.retireRunSecrets(capability)).resolves.toBeUndefined()
    await expect(broker.resolve({ runId: 'RUN-RETIRE', secretRef: 'TOKEN' }))
      .rejects.toThrow(/E2E_SECRET_RUN_(?:TERMINAL|RETIRED)/)
    await expect(broker.retireRunSecrets(capability))
      .rejects.toThrow(/E2E_SECRET_RETIREMENT_CAPABILITY_INVALID/)

    await broker.close()
    await lock.close()
    await runStore.close()
  })

  test('拒绝非终态、跨项目和 revision/lease 已改变的 capability', async () => {
    const roots = await createSecretRoots('retirement-owner'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const nonterminalLock = await createRun(runStore, runSnapshot(identity.digest, 'RUN-LIVE', false))
    await expect(runStore.authorizeSecretRetirement(identity.digest, 'RUN-LIVE', nonterminalLock))
      .rejects.toThrow(/E2E_SECRET_RETIREMENT_RUN_NOT_TERMINAL/)
    await nonterminalLock.close()

    const terminalLock = await createTerminalRun(runStore, identity.digest, 'RUN-STALE')
    const stale = await runStore.authorizeSecretRetirement(identity.digest, 'RUN-STALE', terminalLock)
    await runStore.beginRequest('UNRELATED-REVISION', digest('e'))
    const ownerBroker = await RuntimeSecretBroker.open({
      homeDir: roots.home, projectRoot: roots.project,
    })
    await expect(ownerBroker.retireRunSecrets(stale))
      .rejects.toThrow(/E2E_SECRET_RETIREMENT_CAPABILITY_STALE/)
    await terminalLock.close()

    const foreignLock = await createTerminalRun(runStore, identity.digest, 'RUN-FOREIGN')
    const foreignCapability = await runStore.authorizeSecretRetirement(
      identity.digest, 'RUN-FOREIGN', foreignLock,
    )
    const foreignProject = join(roots.root, 'foreign-project')
    await createProjectIdentity(foreignProject, 'retirement-foreign')
    const foreignBroker = await RuntimeSecretBroker.open({
      homeDir: roots.home, projectRoot: foreignProject,
    })
    await expect(foreignBroker.retireRunSecrets(foreignCapability))
      .rejects.toThrow(/E2E_SECRET_RETIREMENT_CAPABILITY_INVALID/)
    await expect(ownerBroker.retireRunSecrets(foreignCapability)).resolves.toBeUndefined()

    await foreignBroker.close()
    await ownerBroker.close()
    await foreignLock.close()
    await runStore.close()
  })

  test('SecretStore commit 失败不会烧毁 capability，移除故障后可安全重试', async () => {
    const roots = await createSecretRoots('retirement-retry'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createTerminalRun(runStore, identity.digest, 'RUN-RETRY')
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const capability = await runStore.authorizeSecretRetirement(identity.digest, 'RUN-RETRY', lock)
    const database = new DatabaseSync(join(roots.home, '.mutil-skills/e2e/state/runtime-secrets.sqlite'))
    database.exec(`
      CREATE TRIGGER secret_retirement_abort
      BEFORE UPDATE OF snapshot ON authority_snapshots
      WHEN OLD.namespace = 'e2e-runtime-secrets/v1'
      BEGIN SELECT RAISE(ABORT, 'TEST_RETIREMENT_ABORT'); END;
    `)
    database.close()

    await expect(broker.retireRunSecrets(capability))
      .rejects.toThrow(/E2E_SECRET_STATE_INTEGRITY_FAILED/)
    const repair = new DatabaseSync(join(roots.home, '.mutil-skills/e2e/state/runtime-secrets.sqlite'))
    repair.exec('DROP TRIGGER secret_retirement_abort')
    repair.close()
    await expect(broker.retireRunSecrets(capability)).resolves.toBeUndefined()

    await broker.close()
    await lock.close()
    await runStore.close()
  })

  test('退役 callback 持 RunStore transaction 时并发状态变化必须排队到 callback 完成', async () => {
    const roots = await createSecretRoots('retirement-lock-order'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createTerminalRun(runStore, identity.digest, 'RUN-LOCK-ORDER')
    const capability = await runStore.authorizeSecretRetirement(
      identity.digest, 'RUN-LOCK-ORDER', lock,
    )
    let callbackStarted!: () => void
    const started = new Promise<void>((resolve) => { callbackStarted = resolve })
    let releaseCallback!: () => void
    const released = new Promise<void>((resolve) => { releaseCallback = resolve })
    const retirement = consumeRuntimeSecretRetirementCapability(
      capability,
      identity.digest,
      async () => { callbackStarted(); await released },
    )
    await started
    let mutationSettled = false
    const mutation = runStore.beginRequest('CONCURRENT-MUTATION', digest('6'))
      .then(() => { mutationSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mutationSettled).toBe(false)
    releaseCallback()
    await retirement
    await mutation
    expect(mutationSettled).toBe(true)
    await lock.close(); await runStore.close()
  })
})

async function createSecretRoots(projectId: string) {
  const roots = await createBareRuntimeTestRoots()
  await createProjectIdentity(roots.project, projectId)
  return roots
}

async function createProjectIdentity(projectRoot: string, projectId: string): Promise<void> {
  await mkdir(join(projectRoot, '.biztest'), { recursive: true })
  await writeFile(join(projectRoot, '.biztest/project.json'), JSON.stringify({
    schemaVersion: '1.0.0', projectId,
  }))
}

async function createTerminalRun(
  store: RuntimeRunStore,
  projectIdentityDigest: string,
  runId: string,
) {
  return await createRun(store, runSnapshot(projectIdentityDigest, runId, true))
}

async function createRun(store: RuntimeRunStore, snapshot: RuntimeRunSnapshot) {
  const requestId = `CREATE-${snapshot.runId}`
  const requestDigest = digest(snapshot.runId === 'RUN-LIVE' ? 'a' : snapshot.runId === 'RUN-STALE' ? 'b' : 'c')
  await store.beginRequest(requestId, requestDigest)
  const lock = await store.acquireRunLock(snapshot.projectIdentityDigest, snapshot.runId)
  await store.createRunOutcome(snapshot, requestId, requestDigest, { ok: true }, lock)
  return lock
}

async function makeRunTerminal(
  store: RuntimeRunStore,
  projectIdentityDigest: string,
  runId: string,
  lock: Awaited<ReturnType<RuntimeRunStore['acquireRunLock']>>,
): Promise<void> {
  const requestId = `TERMINATE-${runId}`
  const requestDigest = digest(runId === 'RUN-RETIRED' ? '9' : '8')
  await store.beginRequest(requestId, requestDigest)
  await store.updateRunOutcome(
    projectIdentityDigest,
    runId,
    requestId,
    requestDigest,
    (snapshot) => ({
      snapshot: {
        ...snapshot,
        workflow: { ...snapshot.workflow, current: 'accepted', sequence: snapshot.workflow.sequence + 1 },
      },
      response: { terminal: true },
    }),
    'run-terminal-for-secret-retirement',
    lock,
  )
}

function runSnapshot(
  projectIdentityDigest: string,
  runId: string,
  terminal: boolean,
): RuntimeRunSnapshot {
  const workflow = terminal
    ? { ...createWorkflow(), current: 'accepted' as const, sequence: 1 }
    : createWorkflow()
  return {
    schemaVersion: '1.6.0',
    runId,
    assetId: `ASSET-${runId}`,
    projectIdentityDigest,
    runtimeInstallationDigest: digest('d'),
    runRevision: 0,
    workflow,
    artifactDigests: { 'prd-source': digest('f') }, frozenArtifacts: {}, trustedExecutionFacts: {},
    writeAttempts: {},
    executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {},
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  }
}
