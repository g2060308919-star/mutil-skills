import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createWorkflow } from '@mutil-skills/e2e-engine'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
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
  test('只有当前 lease 下的终态 capability 可删除且 capability 不可重放或伪造', async () => {
    const roots = await createSecretRoots('retirement-main'); cleanup.push(roots.root)
    const identity = await resolveProjectIdentity(roots.project)
    const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    const lock = await createTerminalRun(runStore, identity.digest, 'RUN-RETIRE')
    const broker = await RuntimeSecretBroker.open({ homeDir: roots.home, projectRoot: roots.project })
    const secret = Buffer.from('retirement-canary')
    await broker.provide({ runId: 'RUN-RETIRE', secretRef: 'TOKEN', value: secret })
    secret.fill(0)

    await expect(broker.retireRunSecrets(Object.freeze({}) as never))
      .rejects.toThrow(/E2E_SECRET_RETIREMENT_CAPABILITY_INVALID/)
    const capability = await runStore.authorizeSecretRetirement(identity.digest, 'RUN-RETIRE', lock)
    await expect(broker.retireRunSecrets(capability)).resolves.toBeUndefined()
    await expect(broker.resolve({ runId: 'RUN-RETIRE', secretRef: 'TOKEN' }))
      .rejects.toThrow(/E2E_SECRET_NOT_PROVIDED/)
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

function runSnapshot(
  projectIdentityDigest: string,
  runId: string,
  terminal: boolean,
): RuntimeRunSnapshot {
  const workflow = terminal
    ? { ...createWorkflow(), current: 'accepted' as const, sequence: 1 }
    : createWorkflow()
  return {
    schemaVersion: '1.0.0',
    runId,
    assetId: `ASSET-${runId}`,
    projectIdentityDigest,
    runtimeInstallationDigest: digest('d'),
    workflow,
    artifactDigests: { 'prd-source': digest('f') },
    requestResponses: {},
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  }
}
