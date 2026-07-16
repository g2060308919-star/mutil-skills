import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { RuntimeRequestEnvelopeSchema } from '@mutil-skills/e2e-contracts'
import {
  RuntimeAuthorityHost,
  computeRuntimeApprovalSubjectDigest,
  loadRuntimeApprovalAssets,
  startRuntimeAuthorityHost,
} from '../src/authority-host.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { RuntimeRunStore } from '../src/run-store.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { createRuntimeTestRoots } from './fixtures.js'

const installationDigest = `sha256:${'a'.repeat(64)}`

test('Runtime Authority adapter can only open and wait for child-owned sessions', async () => {
  const waitForSession = vi.fn(async () => undefined)
  const processHandle = {
    enrollIdentity: vi.fn(async () => ({ url: 'http://localhost:41001/#enroll', sessionId: 'SESSION-1' })),
    openApprovalSession: vi.fn(async () => ({ url: 'http://localhost:41002/#approve', sessionId: 'SESSION-2' })),
    waitForSession,
    close: vi.fn(async () => undefined),
  }
  const host = new RuntimeAuthorityHost({ processHandle, installationDigest })
  const enrollment = await host.enroll({ subject: 'local:user' })
  expect(enrollment.url).toBe('http://localhost:41001/#enroll')
  await enrollment.wait()
  const approval = await host.requestApproval({
    runId: 'RUN-1', approvalType: 'execution',
    subjectDigest: `sha256:${'b'.repeat(64)}`, installationDigest,
  })
  await approval.wait()
  expect(processHandle.openApprovalSession).toHaveBeenCalledWith({
    runId: 'RUN-1', approvalType: 'execution',
    subjectDigest: `sha256:${'b'.repeat(64)}`, installationDigest,
  })
  expect(waitForSession).toHaveBeenNthCalledWith(1, 'SESSION-1')
  expect(waitForSession).toHaveBeenNthCalledWith(2, 'SESSION-2')
  expect('submit' in host).toBe(false)
  await host.close()
})

test('loads approval assets only from this Runtime package and verifies the pinned bundle', async () => {
  const assets = await loadRuntimeApprovalAssets()
  expect(Buffer.from(assets.indexHtml).toString()).toContain('Authority 审批摘要')
  expect(Buffer.from(assets.approvalJavaScript).toString()).toContain('startAuthentication')
  expect(Buffer.from(assets.simpleWebAuthnBrowser).byteLength).toBe(9269)
})

test('starts the real Authority child with user-only state and revokes enrollment on close', async ({ skip }) => {
  const roots = await createRuntimeTestRoots()
  let host: RuntimeAuthorityHost | undefined
  try {
    try {
      host = await startRuntimeAuthorityHost({
        homeDir: roots.home,
        subject: 'local:user',
        installation: {
          version: '0.0.0', protocolMajor: 1,
          versionRoot: await realpath(process.cwd()),
          entrypoint: `${process.cwd()}/packages/e2e-runtime/src/bin/repo-e2e.ts`,
          installationDigest, sourceRepositoryIndependent: true,
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    const enrollment = await host.enroll({ subject: 'local:user' })
    expect(new URL(enrollment.url).hostname).toBe('localhost')
    const authorityDirectory = await lstat(`${roots.home}/.mutil-skills/e2e/authority`)
    const stateKey = await lstat(`${roots.home}/.mutil-skills/e2e/authority/state.key`)
    expect(authorityDirectory.mode & 0o777).toBe(0o700)
    expect(stateKey.mode & 0o777).toBe(0o600)
    await host.close()
    host = undefined
  } finally {
    await host?.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('approval subject digest is recomputed from every security-relevant Run binding', () => {
  const snapshot = runSnapshot()
  const digest = computeRuntimeApprovalSubjectDigest(snapshot, 'scope')
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  for (const changed of [
    { ...snapshot, runId: 'RUN-2' },
    { ...snapshot, assetId: 'ASSET-2' },
    { ...snapshot, projectIdentityDigest: `sha256:${'c'.repeat(64)}` },
    { ...snapshot, runtimeInstallationDigest: `sha256:${'d'.repeat(64)}` },
    { ...snapshot, workflow: { ...snapshot.workflow, sequence: 3 } },
    { ...snapshot, artifactDigests: { ...snapshot.artifactDigests, scope: `sha256:${'e'.repeat(64)}` } },
  ]) {
    expect(computeRuntimeApprovalSubjectDigest(changed, 'scope')).not.toBe(digest)
  }
  expect(computeRuntimeApprovalSubjectDigest(snapshot, 'execution')).not.toBe(digest)
})

test('Runtime Host recomputes the approval subject from the locked Run before opening WebAuthn', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = { ...runSnapshot(), projectIdentityDigest: identity.digest }
    const seedDigest = `sha256:${'f'.repeat(64)}`
    await runStore.beginRequest('SEED-REQUEST', seedDigest)
    const lock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try {
      await runStore.createRunOutcome(snapshot, 'SEED-REQUEST', seedDigest, { seeded: true }, lock)
    } finally { await lock.close() }

    const wait = vi.fn(async () => undefined)
    const requestApproval = vi.fn(async () => ({
      url: 'http://localhost:42001/#approval', sessionId: 'SESSION-1', wait,
    }))
    const host = new E2ERuntimeHost({
      installation: {
        version: '0.0.0', protocolMajor: 1, versionRoot: '/runtime', entrypoint: '/runtime/repo-e2e.js',
        installationDigest, sourceRepositoryIndependent: true,
      },
      doctor: async () => { throw new Error('not used') },
      runStore,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      authorityHost: { requestApproval },
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-1', client: { name: 'test', version: '1.0.0' },
      command: 'open-approval', projectRoot: roots.project,
      payload: { runId: 'RUN-1', approvalType: 'scope' },
    })
    const response = await host.handle(request, JSON.stringify(request))
    expect(response).toMatchObject({ ok: true, result: {
      runId: 'RUN-1', approvalType: 'scope', sessionId: 'SESSION-1',
      subjectDigest: computeRuntimeApprovalSubjectDigest(snapshot, 'scope'),
    } })
    expect(requestApproval).toHaveBeenCalledWith({
      runId: 'RUN-1', approvalType: 'scope',
      subjectDigest: computeRuntimeApprovalSubjectDigest(snapshot, 'scope'),
      installationDigest,
    })
    expect(wait).toHaveBeenCalledOnce()
    expect(await host.handle(request, JSON.stringify(request))).toEqual(response)
    expect(requestApproval).toHaveBeenCalledTimes(1)

    const wrongType = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-2', client: { name: 'test', version: '1.0.0' },
      command: 'open-approval', projectRoot: roots.project,
      payload: { runId: 'RUN-1', approvalType: 'execution' },
    })
    expect(await host.handle(wrongType, JSON.stringify(wrongType))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_APPROVAL_TYPE_MISMATCH' },
    })
    expect(requestApproval).toHaveBeenCalledTimes(1)
  } finally {
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

function runSnapshot(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.0.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: `sha256:${'1'.repeat(64)}`,
    runtimeInstallationDigest: installationDigest,
    workflow: { current: 'awaiting-scope-approval', sequence: 2, eventChainDigest: `sha256:${'2'.repeat(64)}` },
    artifactDigests: { 'prd-source': `sha256:${'3'.repeat(64)}`, scope: `sha256:${'4'.repeat(64)}` },
    requestResponses: {}, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
  }
}
