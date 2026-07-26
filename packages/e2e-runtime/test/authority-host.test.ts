import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { canonicalizeJson, digestArtifactContent, digestPrdClause, digestPrdClauseInventory, digestText,
  RuntimeRequestEnvelopeSchema, type RuntimeRequestEnvelope } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, getTrustedApprovalFreshnessClientKind } from '@mutil-skills/e2e-authority'
import {
  RuntimeAuthorityHost,
  computeRuntimeApprovalSubjectDigest,
  createRuntimeLocalApprovalHost,
  loadRuntimeApprovalAssets,
  openRuntimeArtifactStoreAuthority,
  runtimeApprovalExecutionBinding,
  startRuntimeAuthorityHost,
} from '../src/authority-host.js'
import { createPendingLocalApprovalConfirmation,
  localManualConfirmationSubjectDigest } from '../src/local-approval-confirmations.js'
import { writeApprovalMode } from '../src/runtime-user-config.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { RuntimeRunStore } from '../src/run-store.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { runCli } from '../src/cli.js'
import { createRuntimeTestRoots } from './fixtures.js'

const installationDigest = `sha256:${'a'.repeat(64)}`

test('完整审批上下文只投影严格四字段 execution binding', () => {
  expect(runtimeApprovalExecutionBinding({
    schemaVersion: '1.0.0', subject: 'local-caller', runId: 'RUN-BINDING-1',
    approvalType: 'discovery', subjectDigest: `sha256:${'b'.repeat(64)}`,
    installationDigest, origin: 'http://localhost',
    issuedAt: '2026-07-19T00:00:00.000Z', expiresAt: '2026-07-19T00:05:00.000Z',
  })).toEqual({
    runId: 'RUN-BINDING-1', approvalType: 'discovery',
    subjectDigest: `sha256:${'b'.repeat(64)}`, installationDigest,
  })
})

test('production artifact authority reopens the persistent Authority identity for signing and verification', async () => {
  const roots = await createRuntimeTestRoots()
  const installation = {
    ...runtimeInstallation(), versionRoot: roots.source, entrypoint: `${roots.source}/runtime-host.js`,
  }
  const subject = `local:uid:${process.getuid!()}`
  const first = await openRuntimeArtifactStoreAuthority({
    homeDir: roots.home, installation, subject,
  })
  const signature = first.signDigest(`sha256:${'6'.repeat(64)}`)
  expect(first.verifySignature(signature)).toBe(true)
  expect(getTrustedApprovalFreshnessClientKind(first.createTrustedApprovalFreshnessClient()))
    .toBe('authority-state')
  await first.close()

  const reopened = await openRuntimeArtifactStoreAuthority({
    homeDir: roots.home, installation, subject,
  })
  expect(reopened.verifySignature(signature)).toBe(true)
  await reopened.close()
  await rm(roots.root, { recursive: true, force: true })
})

test('local Authority adapter signs a subject-bound grant without inventing a WebAuthn identity', async () => {
  const roots = await createRuntimeTestRoots()
  const installation = {
    ...runtimeInstallation(), versionRoot: roots.source, entrypoint: `${roots.source}/runtime-host.js`,
  }
  const authority = await openRuntimeArtifactStoreAuthority({
    homeDir: roots.home, installation, subject: `local:uid:${process.getuid!()}`,
  })
  try {
    const snapshot = runSnapshot()
    const subject = localExecutionGrantSubject(snapshot)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(snapshot, 'execution', subject)
    const host = createRuntimeLocalApprovalHost(authority)
    const session = await host.requestApproval!({
      runId: snapshot.runId, approvalType: 'execution', subjectDigest,
      installationDigest, finalizationId: 'LOCAL-FINALIZE-1',
      requestDigest: `sha256:${'d'.repeat(64)}`,
    })
    const finalized = await session.finalize!(subject)
    expect(finalized.grant.approver).toEqual({ kind: 'local-caller' })
    const grantLifetime = Date.parse(finalized.grant.expiresAt) - Date.parse(finalized.grant.issuedAt)
    expect(grantLifetime).toBeGreaterThan(0)
    expect(grantLifetime).toBeLessThanOrEqual(15 * 60_000)
    expect(finalized.grant.approvalContext).toMatchObject({
      subject: 'local-caller', runId: snapshot.runId, subjectDigest, installationDigest,
    })
    await expect(host.recoverApproval!({
      finalizationId: 'LOCAL-FINALIZE-1', requestDigest: `sha256:${'d'.repeat(64)}`,
      grantSubject: subject, approvalBinding: finalized.approvalBinding,
    })).resolves.toMatchObject({ grant: { grantId: finalized.grant.grantId } })
    await host.acknowledgeFinalization!({
      finalizationId: 'LOCAL-FINALIZE-1', requestDigest: `sha256:${'d'.repeat(64)}`,
      grantId: finalized.grant.grantId, approvalBinding: finalized.approvalBinding,
    })
  } finally {
    await authority.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Host consumes one subject-bound local confirmation and persists the signed Grant', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  let authority: Awaited<ReturnType<typeof openRuntimeArtifactStoreAuthority>> | undefined
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-LOCAL-CONFIRM',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const base = {
      ...runSnapshot(), projectIdentityDigest: identity.digest,
      workflow: { current: 'awaiting-execution-approval' as const, sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}` },
    }
    const subject = localExecutionGrantSubject(base)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(base, 'execution', subject)
    const confirmation = createPendingLocalApprovalConfirmation({
      approvalType: 'execution', subjectDigest, projectIdentityDigest: identity.digest,
      runtimeInstallationDigest: installationDigest, workflowState: base.workflow.current,
      grantSubject: subject, now: new Date('2026-07-16T00:00:00.000Z'),
      summary: {
        runId: base.runId, approvalType: 'execution', environmentId: 'test', riskTier: 'test',
        origins: ['https://test.example.com'], methods: [], actionCount: 1, effects: ['read'],
        maxUses: 1, secretRefs: [], dataLeaseRefs: [], cleanupRefs: [],
        injectionClassifications: [], subjectDigest, expiresAt: '2026-07-16T00:10:00.000Z',
      },
    })
    const snapshot = { ...base, trustedExecutionFacts: {
      ...base.trustedExecutionFacts,
      'approval-mode': 'local-confirmation',
      'pending-local-approval': confirmation,
    } }
    const seedDigest = `sha256:${'7'.repeat(64)}`
    await runStore.beginRequest('SEED-LOCAL-CONFIRM', seedDigest)
    const seedLock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try { await runStore.createRunOutcome(snapshot, 'SEED-LOCAL-CONFIRM', seedDigest, { seeded: true }, seedLock) }
    finally { await seedLock.close() }
    authority = await openRuntimeArtifactStoreAuthority({
      homeDir: roots.home,
      installation: { ...runtimeInstallation(), versionRoot: roots.source,
        entrypoint: `${roots.source}/runtime-host.js` },
      subject: `local:uid:${process.getuid!()}`,
    })
    const readExecutor = vi.fn()
    const writeExecutor = vi.fn()
    const injectionExecutor = vi.fn()
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(), doctor: async () => { throw new Error('not used') },
      runStore, now: () => new Date('2026-07-16T00:01:00.000Z'),
      localAuthorityHostFactory: async () => createRuntimeLocalApprovalHost(authority!),
      readExecutor: readExecutor as never,
      writeExecutor: writeExecutor as never,
      injectionExecutor: injectionExecutor as never,
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'CONFIRM-LOCAL-1',
      client: { name: 'test', version: '1.0.0' }, command: 'confirm-approval',
      projectRoot: roots.project,
      payload: { runId: snapshot.runId, confirmationId: confirmation.confirmationId, subjectDigest },
    })
    const response = await host.handle(request, JSON.stringify(request))
    expect(response).toMatchObject({ ok: true, result: {
      status: 'approved', approvalMode: 'local-confirmation',
      signedGrant: { approver: { kind: 'local-caller' } },
    } })
    expect(await host.handle(request, JSON.stringify(request))).toEqual(response)
    const persisted = await runStore.getRun(identity.digest, snapshot.runId)
    expect(persisted?.workflow.current).toBe('execution-approved')
    expect(persisted?.trustedExecutionFacts['pending-local-approval']).toBeUndefined()
    expect(persisted?.trustedExecutionFacts['signed-execution-grant']).toMatchObject({
      approver: { kind: 'local-caller' },
    })
    expect(readExecutor).not.toHaveBeenCalled()
    expect(writeExecutor).not.toHaveBeenCalled()
    expect(injectionExecutor).not.toHaveBeenCalled()
  } finally {
    await authority?.close()
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Host routes a distinct local manual confirmation to the prepared executor role', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  let authority: Awaited<ReturnType<typeof openRuntimeArtifactStoreAuthority>> | undefined
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-LOCAL-MANUAL',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const base = { ...runSnapshot(), projectIdentityDigest: identity.digest,
      workflow: { current: 'compiled' as const, sequence: 10,
        eventChainDigest: `sha256:${'9'.repeat(64)}` } }
    const authorityNow = Date.now()
    const draft = { ...manualDraft(), startedAt: new Date(authorityNow - 10 * 60_000).toISOString(),
      finishedAt: new Date(authorityNow - 5 * 60_000).toISOString(),
      expiresAt: new Date(authorityNow + 24 * 60 * 60_000).toISOString() }
    authority = await openRuntimeArtifactStoreAuthority({
      homeDir: roots.home,
      installation: { ...runtimeInstallation(), versionRoot: roots.source,
        entrypoint: `${roots.source}/runtime-host.js` },
      subject: `local:uid:${process.getuid!()}`,
    })
    const prepared = await authority.prepareLocalManualResult({
      draft, finalizationId: 'PREPARE-LOCAL-MANUAL', requestDigest: `sha256:${'6'.repeat(64)}`,
    })
    const subjectDigest = localManualConfirmationSubjectDigest({
      runId: base.runId, manualResultId: draft.manualResultId, draftDigest: prepared.draftDigest,
      role: 'executor', workflowState: base.workflow.current,
    })
    const confirmation = createPendingLocalApprovalConfirmation({
      approvalType: 'manual-executor', subjectDigest, projectIdentityDigest: identity.digest,
      runtimeInstallationDigest: installationDigest, workflowState: base.workflow.current,
      manualResult: { manualResultId: draft.manualResultId, draftDigest: prepared.draftDigest,
        role: 'executor' }, now: new Date('2026-07-19T00:00:00.000Z'),
      summary: {
        runId: base.runId, approvalType: 'manual-executor', environmentId: 'test', riskTier: 'test',
        origins: [], methods: [], actionCount: 0, effects: ['manual'], maxUses: 0,
        secretRefs: [], dataLeaseRefs: [], cleanupRefs: [], injectionClassifications: [],
        subjectDigest, expiresAt: '2026-07-19T00:10:00.000Z',
      },
    })
    const snapshot = { ...base, trustedExecutionFacts: { 'approval-mode': 'local-confirmation',
      'pending-local-approval': confirmation } }
    const seedDigest = `sha256:${'5'.repeat(64)}`
    await runStore.beginRequest('SEED-LOCAL-MANUAL', seedDigest)
    const lock = await runStore.acquireRunLock(identity.digest, base.runId)
    try { await runStore.createRunOutcome(snapshot, 'SEED-LOCAL-MANUAL', seedDigest, { seeded: true }, lock) }
    finally { await lock.close() }
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(), doctor: async () => { throw new Error('not used') },
      runStore, now: () => new Date('2026-07-19T00:01:00.000Z'),
      localAuthorityHostFactory: async () => createRuntimeLocalApprovalHost(authority!),
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'CONFIRM-LOCAL-MANUAL-EXECUTOR',
      client: { name: 'test', version: '1.0.0' }, command: 'confirm-approval',
      projectRoot: roots.project,
      payload: { runId: base.runId, confirmationId: confirmation.confirmationId, subjectDigest },
    })
    const response = await host.handle(request, JSON.stringify(request))
    expect(response.ok, JSON.stringify(response)).toBe(true)
    expect(response).toMatchObject({
      ok: true, result: { status: 'awaiting-reviewer', role: 'executor',
        approvalMode: 'local-confirmation' },
    })
    expect((await runStore.getRun(identity.digest, base.runId))
      ?.trustedExecutionFacts['pending-local-approval']).toBeUndefined()
  } finally {
    await authority?.close()
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Authority adapter can only open and wait for child-owned sessions', async () => {
  const enrollmentBearer = 'a'.repeat(43)
  const approvalBearer = 'b'.repeat(43)
  const waitForSession = vi.fn(async () => undefined)
  const processHandle = {
    enrollIdentity: vi.fn(async () => ({
      url: `http://localhost:41001/#${enrollmentBearer}`, sessionId: 'SESSION-1',
    })),
    openApprovalSession: vi.fn(async () => ({
      url: `http://localhost:41002/#${approvalBearer}`, sessionId: 'SESSION-2',
    })),
    waitForSession,
    close: vi.fn(async () => undefined),
  }
  const host = new RuntimeAuthorityHost({ processHandle, installationDigest })
  const enrollment = await host.enroll({ subject: 'local:user' })
  expect(enrollment.url).toBe(`http://localhost:41001/#${enrollmentBearer}`)
  await enrollment.wait()
  const approval = await host.requestApproval({
    runId: 'RUN-1', approvalType: 'execution',
    subjectDigest: `sha256:${'b'.repeat(64)}`, installationDigest,
    finalizationId: 'FINALIZE-ADAPTER-1', requestDigest: `sha256:${'d'.repeat(64)}`,
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

  const unsafe = new RuntimeAuthorityHost({
    installationDigest,
    processHandle: {
      ...processHandle,
      openApprovalSession: async () => ({
        url: 'http://localhost:41002/?bearer=leaked#fragment', sessionId: 'SESSION-UNSAFE',
      }),
    },
  })
  await expect(unsafe.requestApproval({
    runId: 'RUN-1', approvalType: 'execution',
    subjectDigest: `sha256:${'b'.repeat(64)}`, installationDigest,
    finalizationId: 'FINALIZE-UNSAFE-1', requestDigest: `sha256:${'d'.repeat(64)}`,
  })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_REFERENCE_INVALID' })
  await unsafe.close()
})

test('Runtime Authority adapter sends only the four provable fields and rejects a rebound finalize result', async () => {
  const subject = executionGrantSubject(runSnapshot())
  const subjectDigest = computeRuntimeApprovalSubjectDigest(runSnapshot(), 'execution', subject)
  const finalizeApproval = vi.fn(async () => ({
    grant: { grantId: 'GRANT-REBOUND' } as never,
    approvalBinding: {
      runId: 'RUN-OTHER', installationDigest, approvalType: 'execution' as const, subjectDigest,
    },
  }))
  const openApprovalSession = vi.fn(async () => ({
    url: `http://localhost:41003/#${'c'.repeat(43)}`, sessionId: 'SESSION-FINALIZE',
  }))
  const host = new RuntimeAuthorityHost({
    installationDigest,
    processHandle: {
      enrollIdentity: vi.fn(), openApprovalSession,
      waitForSession: vi.fn(async () => undefined), finalizeApproval,
      close: vi.fn(async () => undefined),
    },
  })
  const session = await host.requestApproval({
    runId: 'RUN-1', approvalType: 'execution', subjectDigest, installationDigest,
    finalizationId: 'FINALIZE-REBIND-1', requestDigest: `sha256:${'d'.repeat(64)}`,
  })
  expect(openApprovalSession).toHaveBeenCalledWith({
    runId: 'RUN-1', approvalType: 'execution', subjectDigest, installationDigest,
  })
  await expect(session.finalize!(subject)).rejects.toMatchObject({
    code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH',
  })
  await host.close()
})

test('Runtime Authority adapter keeps manual session references internal and binds both roles to one draft', async () => {
  const draft = manualDraft()
  const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
  const prepareFinalizationId = 'PREPARE-MANUAL-1'
  const prepareRequestDigest = digestText('manual-result-request/v1', prepareFinalizationId)
  const executorFinalizationId = 'FINALIZE-MANUAL-1-EXECUTOR'
  const executorRequestDigest = digestText('manual-result-request/v1', executorFinalizationId)
  const reviewerFinalizationId = 'FINALIZE-MANUAL-1-REVIEWER'
  const reviewerRequestDigest = digestText('manual-result-request/v1', reviewerFinalizationId)
  const prepareManualResult = vi.fn(async () => ({
    manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor' as const,
  }))
  const openApprovalSession = vi.fn()
    .mockResolvedValueOnce({ url: `http://localhost:41011/#${'e'.repeat(43)}`, sessionId: 'SESSION-EXECUTOR' })
    .mockResolvedValueOnce({ url: `http://localhost:41012/#${'f'.repeat(43)}`, sessionId: 'SESSION-REVIEWER' })
  const finalizeManualResultRole = vi.fn()
    .mockResolvedValueOnce({ status: 'awaiting-reviewer', manualResultId: draft.manualResultId,
      draftDigest, nextRole: 'reviewer' })
    .mockResolvedValueOnce({ status: 'issued', result: { ...draft, authorityProof: manualProof(draft, draftDigest) } })
  const host = new RuntimeAuthorityHost({ installationDigest, processHandle: {
    enrollIdentity: vi.fn(), openApprovalSession, waitForSession: vi.fn(async () => undefined),
    prepareManualResult, finalizeManualResultRole, close: vi.fn(async () => undefined),
  } })

  await expect(host.prepareManualResult({ draft, finalizationId: prepareFinalizationId,
    requestDigest: prepareRequestDigest })).resolves.toEqual({
    manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor',
  })
  const executor = await host.requestManualResultRole({
    runId: draft.runId, manualResultId: draft.manualResultId, draftDigest,
    role: 'executor', installationDigest, finalizationId: executorFinalizationId,
    requestDigest: executorRequestDigest,
  })
  await executor.wait()
  await expect(executor.finalizeManualResultRole!()).resolves.toMatchObject({
    status: 'awaiting-reviewer', nextRole: 'reviewer',
  })
  const reviewer = await host.requestManualResultRole({
    runId: draft.runId, manualResultId: draft.manualResultId, draftDigest,
    role: 'reviewer', installationDigest, finalizationId: reviewerFinalizationId,
    requestDigest: reviewerRequestDigest,
  })
  await reviewer.wait()
  await expect(reviewer.finalizeManualResultRole!()).resolves.toMatchObject({
    status: 'issued', result: { manualResultId: draft.manualResultId },
  })
  expect(openApprovalSession).toHaveBeenNthCalledWith(1, {
    runId: draft.runId, approvalType: 'manual-executor', subjectDigest: draftDigest, installationDigest,
  })
  expect(openApprovalSession).toHaveBeenNthCalledWith(2, {
    runId: draft.runId, approvalType: 'manual-reviewer', subjectDigest: draftDigest, installationDigest,
  })
  expect(finalizeManualResultRole).toHaveBeenNthCalledWith(1, {
    manualResultId: draft.manualResultId, draftDigest, role: 'executor',
    approvalSessionRef: 'SESSION-EXECUTOR',
    finalizationId: executorFinalizationId, requestDigest: executorRequestDigest,
  })
  expect(finalizeManualResultRole).toHaveBeenNthCalledWith(2, {
    manualResultId: draft.manualResultId, draftDigest, role: 'reviewer',
    approvalSessionRef: 'SESSION-REVIEWER',
    finalizationId: reviewerFinalizationId, requestDigest: reviewerRequestDigest,
  })
  await host.close()
})

test('Runtime Authority adapter strictly parses finalization acknowledgements before child IPC', async () => {
  const acknowledgeFinalization = vi.fn(async () => undefined)
  const host = new RuntimeAuthorityHost({
    installationDigest,
    processHandle: {
      enrollIdentity: vi.fn(), openApprovalSession: vi.fn(), waitForSession: vi.fn(),
      acknowledgeFinalization, close: vi.fn(async () => undefined),
    },
  })
  const acknowledgement = {
    finalizationId: 'FINALIZE-STRICT-1', requestDigest: `sha256:${'d'.repeat(64)}`,
    grantId: 'GRANT-STRICT-1',
    approvalBinding: {
      runId: 'RUN-1', installationDigest, approvalType: 'execution' as const,
      subjectDigest: `sha256:${'e'.repeat(64)}`,
    },
  }

  await expect(host.acknowledgeFinalization({ ...acknowledgement, injected: true } as never))
    .rejects.toMatchObject({ code: 'E2E_APPROVAL_FINALIZATION_INVALID' })
  await expect(host.acknowledgeFinalization({
    ...acknowledgement,
    approvalBinding: { ...acknowledgement.approvalBinding, rebound: true },
  } as never)).rejects.toMatchObject({ code: 'E2E_APPROVAL_FINALIZATION_INVALID' })
  expect(acknowledgeFinalization).not.toHaveBeenCalled()
  await host.close()

  const hostWithoutAckTransport = new RuntimeAuthorityHost({
    installationDigest,
    processHandle: {
      enrollIdentity: vi.fn(), openApprovalSession: vi.fn(), waitForSession: vi.fn(),
      close: vi.fn(async () => undefined),
    },
  })
  await expect(hostWithoutAckTransport.acknowledgeFinalization({
    ...acknowledgement, injected: true,
  } as never)).rejects.toMatchObject({ code: 'E2E_APPROVAL_FINALIZATION_INVALID' })
  await hostWithoutAckTransport.close()
})

test('loads approval assets only from this Runtime package and verifies the pinned bundle', async () => {
  const assets = await loadRuntimeApprovalAssets()
  const approvalJavaScript = Buffer.from(assets.approvalJavaScript).toString()
  expect(Buffer.from(assets.indexHtml).toString()).toContain('Authority 审批摘要')
  expect(approvalJavaScript).toContain('startAuthentication')
  expect(approvalJavaScript).toContain('authorization')
  expect(approvalJavaScript).not.toContain('document.cookie')
  expect(approvalJavaScript).not.toContain('bearer=')
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
      if (['EPERM', 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED']
        .includes(String((error as NodeJS.ErrnoException).code))) { skip(); return }
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

test('rejects symlinked Authority ancestors without chmod or writes to the canary target', async () => {
  const roots = await createRuntimeTestRoots()
  const canary = `${roots.root}/canary-product-root`
  try {
    await mkdir(canary, { mode: 0o755 })
    await writeFile(`${canary}/canary.txt`, 'UNCHANGED', { mode: 0o644 })
    await symlink(canary, `${roots.home}/.mutil-skills`)

    await expect(startRuntimeAuthorityHost({
      homeDir: roots.home, subject: 'local:user', installation: runtimeInstallation(),
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_STATE_DIRECTORY_INVALID' })
    expect((await stat(canary)).mode & 0o777).toBe(0o755)
    expect(await readFile(`${canary}/canary.txt`, 'utf8')).toBe('UNCHANGED')
  } finally {
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('rejects symlinked and hardlinked state keys without changing canary bytes or mode', async () => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const roots = await createRuntimeTestRoots()
    const authorityDirectory = `${roots.home}/.mutil-skills/e2e/authority`
    const canary = `${roots.root}/${kind}-key-canary`
    try {
      await mkdir(authorityDirectory, { recursive: true, mode: 0o700 })
      await writeFile(canary, Buffer.alloc(32, 0x5a), { mode: 0o600 })
      if (kind === 'symlink') await symlink(canary, `${authorityDirectory}/state.key`)
      else await link(canary, `${authorityDirectory}/state.key`)

      await expect(startRuntimeAuthorityHost({
        homeDir: roots.home, subject: 'local:user', installation: runtimeInstallation(),
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_STATE_KEY_INVALID' })
      expect(await readFile(canary)).toEqual(Buffer.alloc(32, 0x5a))
      expect((await stat(canary)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
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
  const grantSubject = executionGrantSubject(snapshot)
  const executionDigest = computeRuntimeApprovalSubjectDigest(snapshot, 'execution', grantSubject)
  expect(executionDigest).not.toBe(digest)
  expect(computeRuntimeApprovalSubjectDigest(snapshot, 'execution', {
    ...grantSubject,
    actions: [{ ...grantSubject.actions[0]!, maxInboundMessages: 2 }],
  })).not.toBe(executionDigest)
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
      authorityHostFactory: async () => ({ requestApproval }),
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
      payload: { runId: 'RUN-1', approvalType: 'execution', grantSubject: executionGrantSubject(snapshot) },
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

test('Runtime Host finalizes a Grant and journals the traceable Grant plus four-field binding idempotently', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = {
      ...executionReviewSnapshot(), projectIdentityDigest: identity.digest,
      workflow: {
        current: 'awaiting-execution-approval' as const, sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}`,
      },
    }
    const seedDigest = `sha256:${'7'.repeat(64)}`
    await runStore.beginRequest('SEED-FINALIZE', seedDigest)
    const seedLock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try { await runStore.createRunOutcome(snapshot, 'SEED-FINALIZE', seedDigest, { seeded: true }, seedLock) }
    finally { await seedLock.close() }

    const grantSubject = executionGrantSubject(snapshot)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(snapshot, 'execution', grantSubject)
    const approvalBinding = {
      runId: snapshot.runId, installationDigest,
      approvalType: 'execution' as const, subjectDigest,
    }
    const signedGrant = signedExecutionGrant('GRANT-1', grantSubject, subjectDigest, approvalBinding)
    const finalize = vi.fn(async () => ({ grant: signedGrant as never, approvalBinding }))
    const requestApproval = vi.fn(async () => ({
      url: 'http://localhost:42009/#approval', sessionId: 'SESSION-FINALIZE',
      wait: vi.fn(async () => undefined), finalize,
    }))
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(), doctor: async () => { throw new Error('not used') },
      runStore, now: () => new Date('2026-07-17T00:00:00.000Z'),
      authorityHostFactory: async () => ({ requestApproval }),
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-FINALIZE',
      client: { name: 'test', version: '1.0.0' }, command: 'open-approval',
      projectRoot: roots.project,
      payload: { runId: snapshot.runId, approvalType: 'execution', grantSubject },
    })
    const confirmedRequest = await semanticConfirmRequest(host, request)
    const first = await host.handle(confirmedRequest, JSON.stringify(confirmedRequest))
    expect(first).toMatchObject({ ok: true, result: {
      sessionId: 'SESSION-FINALIZE', signedGrant, approvalBinding,
    } })
    expect(await host.handle(confirmedRequest, JSON.stringify(confirmedRequest))).toEqual(first)
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledOnce()
    expect((await runStore.getRun(identity.digest, snapshot.runId))
      ?.requestResponses['APPROVE-FINALIZE-CONFIRMED'])
      .toMatchObject({ response: first })
  } finally {
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Host keeps a finalized request pending when Run Store persistence fails and recovers the same Grant', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = {
      ...executionReviewSnapshot(), projectIdentityDigest: identity.digest,
      workflow: {
        current: 'awaiting-execution-approval' as const, sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}`,
      },
    }
    const seedDigest = `sha256:${'6'.repeat(64)}`
    await runStore.beginRequest('SEED-RECOVER', seedDigest)
    const seedLock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try { await runStore.createRunOutcome(snapshot, 'SEED-RECOVER', seedDigest, { seeded: true }, seedLock) }
    finally { await seedLock.close() }

    const grantSubject = executionGrantSubject(snapshot)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(snapshot, 'execution', grantSubject)
    const approvalBinding = {
      runId: snapshot.runId, installationDigest,
      approvalType: 'execution' as const, subjectDigest,
    }
    const signedGrant = signedExecutionGrant(
      'GRANT-RECOVERED', grantSubject, subjectDigest, approvalBinding,
    )
    const finalize = vi.fn(async () => ({ grant: signedGrant as never, approvalBinding }))
    const requestApproval = vi.fn(async () => ({
      url: 'http://localhost:42010/#approval', sessionId: 'SESSION-RECOVER',
      wait: vi.fn(async () => undefined), finalize,
    }))
    const recoverFirst = vi.fn(async (_input: unknown) => undefined)
    const recoverSecond = vi.fn(async (_input: unknown) => ({
      grant: signedGrant as never, approvalBinding, sessionId: 'SESSION-RECOVER',
    }))
    const secondRequestApproval = vi.fn()
    const presentUserPresenceUrl = vi.fn(async () => undefined)
    const authorityHostFactory = vi.fn()
      .mockResolvedValueOnce({ requestApproval, recoverApproval: recoverFirst })
      .mockResolvedValueOnce({ requestApproval: secondRequestApproval, recoverApproval: recoverSecond })
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(), doctor: async () => { throw new Error('not used') },
      runStore, now: () => new Date('2026-07-17T00:00:00.000Z'), authorityHostFactory,
      presentUserPresenceUrl,
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-RECOVER',
      client: { name: 'test', version: '1.0.0' }, command: 'open-approval',
      projectRoot: roots.project,
      payload: { runId: snapshot.runId, approvalType: 'execution', grantSubject },
    })
    const confirmedRequest = await semanticConfirmRequest(host, request)
    const originalWriteTrustedFactOutcome = runStore.writeTrustedFactOutcome.bind(runStore)
    vi.spyOn(runStore, 'writeTrustedFactOutcome')
      .mockRejectedValueOnce(new Error('simulated Run Store fsync failure'))
      .mockImplementation(originalWriteTrustedFactOutcome)

    expect(await host.handle(confirmedRequest, JSON.stringify(confirmedRequest))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING' },
    })
    expect(await host.handle(confirmedRequest, JSON.stringify(confirmedRequest))).toMatchObject({
      ok: true, result: { signedGrant, approvalBinding },
    })
    expect(finalize).toHaveBeenCalledOnce()
    expect(requestApproval).toHaveBeenCalledOnce()
    expect(secondRequestApproval).not.toHaveBeenCalled()
    expect(presentUserPresenceUrl).toHaveBeenCalledOnce()
    expect(recoverSecond).toHaveBeenCalledOnce()
  } finally {
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Host holds the Run lock across recover registration and outcome persistence', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = {
      ...executionReviewSnapshot(), projectIdentityDigest: identity.digest,
      workflow: {
        current: 'awaiting-execution-approval' as const, sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}`,
      },
    }
    const seedDigest = `sha256:${'4'.repeat(64)}`
    await runStore.beginRequest('SEED-RECOVER-CHANGED', seedDigest)
    const seedLock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try {
      await runStore.createRunOutcome(snapshot, 'SEED-RECOVER-CHANGED', seedDigest, { seeded: true }, seedLock)
    } finally { await seedLock.close() }

    const grantSubject = executionGrantSubject(snapshot)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(snapshot, 'execution', grantSubject)
    const approvalBinding = {
      runId: snapshot.runId, installationDigest,
      approvalType: 'execution' as const, subjectDigest,
    }
    const signedGrant = signedExecutionGrant(
      'GRANT-RECOVERED-CHANGED', grantSubject, subjectDigest, approvalBinding,
    )
    const changeDigest = `sha256:${'3'.repeat(64)}`
    let interleavingError: unknown
    const recoverApproval = vi.fn(async () => {
      await runStore.beginRequest('CHANGE-RUN-BEFORE-RECOVERY', changeDigest)
      try {
        await runStore.acquireRunLock(identity.digest, snapshot.runId)
      } catch (error) { interleavingError = error }
      return { grant: signedGrant as never, approvalBinding, sessionId: 'SESSION-RECOVER-CHANGED' }
    })
    const requestApproval = vi.fn()
    const writeTrustedFactOutcome = vi.spyOn(runStore, 'writeTrustedFactOutcome')
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(), doctor: async () => { throw new Error('not used') },
      runStore, now: () => new Date('2026-07-17T00:00:00.000Z'),
      authorityHostFactory: async () => ({ recoverApproval, requestApproval }),
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-RECOVER-CHANGED',
      client: { name: 'test', version: '1.0.0' }, command: 'open-approval',
      projectRoot: roots.project,
      payload: { runId: snapshot.runId, approvalType: 'execution', grantSubject },
    })
    const confirmedRequest = await semanticConfirmRequest(host, request)

    expect(await host.handle(confirmedRequest, JSON.stringify(confirmedRequest))).toMatchObject({
      ok: true, result: { signedGrant, approvalBinding },
    })
    expect(interleavingError).toMatchObject({ code: 'E2E_RUNTIME_RUN_LOCKED' })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(writeTrustedFactOutcome).toHaveBeenCalledOnce()
    expect((await runStore.getRun(identity.digest, snapshot.runId))
      ?.requestResponses['APPROVE-RECOVER-CHANGED-CONFIRMED']).toBeDefined()
  } finally {
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Host rejects a replaced physical project root after the user-presence wait', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = { ...runSnapshot(), projectIdentityDigest: identity.digest }
    const seedDigest = `sha256:${'e'.repeat(64)}`
    await runStore.beginRequest('SEED-REPLACEMENT', seedDigest)
    const lock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try {
      await runStore.createRunOutcome(snapshot, 'SEED-REPLACEMENT', seedDigest, { seeded: true }, lock)
    } finally { await lock.close() }
    const requestApproval = vi.fn(async () => ({
      url: 'http://localhost:42003/#approval', sessionId: 'SESSION-REPLACEMENT',
      async wait() {
        await rename(roots.project, `${roots.root}/old-project`)
        await mkdir(`${roots.project}/.biztest`, { recursive: true })
        await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
          schemaVersion: '1.0.0', projectId: 'PROJECT-1',
        }))
      },
    }))
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(),
      doctor: async () => { throw new Error('not used') },
      runStore, now: () => new Date('2026-07-16T00:00:00.000Z'),
      authorityHostFactory: async () => ({ requestApproval }),
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-REPLACEMENT',
      client: { name: 'test', version: '1.0.0' }, command: 'open-approval', projectRoot: roots.project,
      payload: { runId: 'RUN-1', approvalType: 'scope' },
    })

    expect(await host.handle(request, JSON.stringify(request))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_PROJECT_IDENTITY_CHANGED' },
    })
  } finally {
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('Runtime Host rejects a logical project rebind after the user-presence wait', async () => {
  const roots = await createRuntimeTestRoots()
  const runStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    const identityPath = `${roots.project}/.biztest/project.json`
    await writeFile(identityPath, JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-1' }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = { ...runSnapshot(), projectIdentityDigest: identity.digest }
    const seedDigest = `sha256:${'9'.repeat(64)}`
    await runStore.beginRequest('SEED-REBIND', seedDigest)
    const lock = await runStore.acquireRunLock(identity.digest, snapshot.runId)
    try { await runStore.createRunOutcome(snapshot, 'SEED-REBIND', seedDigest, { seeded: true }, lock) }
    finally { await lock.close() }
    const host = new E2ERuntimeHost({
      installation: runtimeInstallation(),
      doctor: async () => { throw new Error('not used') }, runStore,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      authorityHostFactory: async () => ({
        requestApproval: async () => ({
          url: `http://localhost:42004/#${'d'.repeat(43)}`, sessionId: 'SESSION-REBIND',
          async wait() {
            await writeFile(identityPath, JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-2' }))
          },
        }),
      }),
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'APPROVE-REBIND', client: { name: 'test', version: '1.0.0' },
      command: 'open-approval', projectRoot: roots.project,
      payload: { runId: 'RUN-1', approvalType: 'scope' },
    })

    expect(await host.handle(request, JSON.stringify(request))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_PROJECT_IDENTITY_CHANGED' },
    })
  } finally {
    await runStore.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test.each(['physical', 'logical'] as const)(
  'human approval command rejects a %s project identity change after user presence',
  async (change) => {
    const roots = await createRuntimeTestRoots()
    try {
      await mkdir(`${roots.project}/.biztest`, { recursive: true })
      const identityPath = `${roots.project}/.biztest/project.json`
      await writeFile(identityPath, JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-1' }))
      const identity = await resolveProjectIdentity(roots.project)
      const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
      try {
        const snapshot = { ...runSnapshot(), projectIdentityDigest: identity.digest }
        const requestDigest = `sha256:${'8'.repeat(64)}`
        await store.beginRequest(`SEED-HUMAN-${change}`, requestDigest)
        const lock = await store.acquireRunLock(identity.digest, snapshot.runId)
        try {
          await store.createRunOutcome(snapshot, `SEED-HUMAN-${change}`, requestDigest, { seeded: true }, lock)
        } finally { await lock.close() }
      } finally { await store.close() }

      const close = vi.fn(async () => undefined)
      const startAuthorityHost = vi.fn(async () => new RuntimeAuthorityHost({
        installationDigest,
        processHandle: {
          enrollIdentity: vi.fn(),
          openApprovalSession: vi.fn(async () => ({
            url: `http://localhost:42005/#${'h'.repeat(43)}`,
            sessionId: `SESSION-HUMAN-${change}`,
          })),
          async waitForSession() {
            if (change === 'physical') {
              await rename(roots.project, `${roots.root}/old-human-project`)
              await mkdir(`${roots.project}/.biztest`, { recursive: true })
              await writeFile(identityPath, JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-1' }))
            } else {
              await writeFile(identityPath, JSON.stringify({ schemaVersion: '1.0.0', projectId: 'PROJECT-2' }))
            }
          },
          close,
        },
      }))
      const stdout = captureWritable()
      const stderr = captureWritable()
      const exitCode = await runCli(
        ['approve', '--run-id', 'RUN-1', '--type', 'scope'],
        Readable.from([]), stdout.stream, stderr.stream,
        {
          homeDir: roots.home,
          installRuntime: async () => { throw new Error('not used') },
          uninstallRuntime: async () => { throw new Error('not used') },
          inspectRuntimeInstallation: async () => runtimeInstallation(),
          startAuthorityHost,
          currentWorkingDirectory: () => roots.project,
        },
      )

      expect(exitCode).toBe(4)
      expect(JSON.parse(stdout.text())).toMatchObject({
        ok: false, error: { code: 'E2E_RUNTIME_PROJECT_IDENTITY_CHANGED' },
      })
      expect(stderr.text()).toBe(`http://localhost:42005/#${'h'.repeat(43)}\n`)
      expect(startAuthorityHost).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  },
)

test('direct approve 按目标 Run 冻结模式路由，旧 local Run 不因当前配置变化进入 WebAuthn', async () => {
  const roots = await createRuntimeTestRoots()
  const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-LOCAL-DIRECT-APPROVE',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = {
      ...runSnapshot(), projectIdentityDigest: identity.digest,
      trustedExecutionFacts: {
        ...runSnapshot().trustedExecutionFacts,
        'approval-mode': 'local-confirmation' as const,
      },
    }
    const seedDigest = `sha256:${'4'.repeat(64)}`
    await store.beginRequest('SEED-LOCAL-DIRECT-APPROVE', seedDigest)
    const lock = await store.acquireRunLock(identity.digest, snapshot.runId)
    try {
      await store.createRunOutcome(snapshot, 'SEED-LOCAL-DIRECT-APPROVE', seedDigest, { seeded: true }, lock)
    } finally { await lock.close() }

    const startAuthorityHost = vi.fn()
    const stdout = captureWritable()
    const exitCode = await runCli(
      ['approve', '--run-id', snapshot.runId, '--type', 'scope'],
      Readable.from([]), stdout.stream, captureWritable().stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('not used') },
        uninstallRuntime: async () => { throw new Error('not used') },
        inspectRuntimeInstallation: async () => runtimeInstallation(),
        startAuthorityHost,
        openRunStore: async () => store,
        currentWorkingDirectory: () => roots.project,
      },
    )

    expect(exitCode).toBe(2)
    expect(startAuthorityHost).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_LOCAL_APPROVAL_RPC_REQUIRED' },
    })
  } finally {
    await store.close()
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('direct CLI reserves a stable finalization before WebAuthn and recovers after Run Store persistence failure', async () => {
  const roots = await createRuntimeTestRoots()
  const firstStore = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = {
      ...runSnapshot(), projectIdentityDigest: identity.digest,
      workflow: {
        current: 'awaiting-execution-approval' as const, sequence: 8,
        eventChainDigest: `sha256:${'8'.repeat(64)}`,
      },
    }
    const seedDigest = `sha256:${'5'.repeat(64)}`
    await firstStore.beginRequest('SEED-CLI-RECOVER', seedDigest)
    const seedLock = await firstStore.acquireRunLock(identity.digest, snapshot.runId)
    try { await firstStore.createRunOutcome(snapshot, 'SEED-CLI-RECOVER', seedDigest, { seeded: true }, seedLock) }
    finally { await seedLock.close() }
    const grantSubject = executionGrantSubject(snapshot)
    await writeFile(`${roots.project}/execution-subject.json`, JSON.stringify(grantSubject))
    const subjectDigest = computeRuntimeApprovalSubjectDigest(snapshot, 'execution', grantSubject)
    const approvalBinding = {
      runId: snapshot.runId, installationDigest,
      approvalType: 'execution' as const, subjectDigest,
    }
    const signedGrant = signedExecutionGrant(
      'GRANT-CLI-RECOVER', grantSubject, subjectDigest, approvalBinding,
    )
    const finalize = vi.fn(async () => ({ grant: signedGrant as never, approvalBinding }))
    const recoverFirst = vi.fn(async (_input: unknown) => undefined)
    const recoverSecond = vi.fn(async (_input: unknown) => ({
      grant: signedGrant as never, approvalBinding, sessionId: 'SESSION-CLI-RECOVER',
    }))
    const requestApproval = vi.fn(async () => ({
      url: `http://localhost:42011/#${'r'.repeat(43)}`, sessionId: 'SESSION-CLI-RECOVER',
      wait: vi.fn(async () => undefined), finalize,
    }))
    const firstAuthority = {
      recoverApproval: recoverFirst, requestApproval, close: vi.fn(async () => undefined),
    }
    const secondRequestApproval = vi.fn()
    const secondAuthority = {
      recoverApproval: recoverSecond, requestApproval: secondRequestApproval,
      close: vi.fn(async () => undefined),
    }
    const nextSignedGrant = { ...signedGrant, grantId: 'GRANT-CLI-NEXT' }
    const nextFinalize = vi.fn(async () => ({ grant: nextSignedGrant as never, approvalBinding }))
    const recoverThird = vi.fn(async (_input: unknown) => undefined)
    const thirdRequestApproval = vi.fn(async () => ({
      url: `http://localhost:42012/#${'s'.repeat(43)}`, sessionId: 'SESSION-CLI-NEXT',
      wait: vi.fn(async () => undefined), finalize: nextFinalize,
    }))
    const thirdAuthority = {
      recoverApproval: recoverThird, requestApproval: thirdRequestApproval,
      close: vi.fn(async () => undefined),
    }
    const startAuthorityHost = vi.fn()
      .mockResolvedValueOnce(firstAuthority as never)
      .mockResolvedValueOnce(secondAuthority as never)
      .mockResolvedValueOnce(thirdAuthority as never)
    vi.spyOn(firstStore, 'readRunOutcome')
      .mockRejectedValueOnce(new Error('simulated direct CLI Run Store fsync failure'))
    let storeOpenCount = 0
    const openRunStore = vi.fn(async () => {
      if (storeOpenCount++ === 0) return firstStore
      return await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    })
    const dependencies = {
      homeDir: roots.home,
      installRuntime: async () => { throw new Error('not used') },
      uninstallRuntime: async () => { throw new Error('not used') },
      inspectRuntimeInstallation: async () => runtimeInstallation(),
      startAuthorityHost,
      openRunStore,
      currentWorkingDirectory: () => roots.project,
    }
    const args = [
      'approve', '--run-id', 'RUN-1', '--type', 'execution', '--subject-file', 'execution-subject.json',
    ]
    const firstStdout = captureWritable()
    expect(await runCli(args, Readable.from([]), firstStdout.stream, captureWritable().stream, dependencies))
      .toBe(4)
    expect(JSON.parse(firstStdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING' },
    })
    const secondStdout = captureWritable()
    expect(await runCli(args, Readable.from([]), secondStdout.stream, captureWritable().stream, dependencies))
      .toBe(0)
    expect(JSON.parse(secondStdout.text())).toMatchObject({
      sessionId: 'SESSION-CLI-RECOVER', status: 'verified', signedGrant, approvalBinding,
    })
    expect(requestApproval).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledOnce()
    expect(secondRequestApproval).not.toHaveBeenCalled()
    expect(recoverSecond).toHaveBeenCalledWith(recoverFirst.mock.calls[0]![0])

    const thirdStdout = captureWritable()
    expect(await runCli(args, Readable.from([]), thirdStdout.stream, captureWritable().stream, dependencies))
      .toBe(0)
    expect(JSON.parse(thirdStdout.text())).toMatchObject({
      sessionId: 'SESSION-CLI-NEXT', status: 'verified', signedGrant: nextSignedGrant,
    })
    expect(thirdRequestApproval).toHaveBeenCalledOnce()
    expect(nextFinalize).toHaveBeenCalledOnce()
    expect(recoverThird.mock.calls[0]![0]).not.toEqual(recoverSecond.mock.calls[0]![0])
  } finally {
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('default rpc wiring lazily starts Authority only after Host validation, writes URL to stderr, and closes it', async () => {
  const roots = await createRuntimeTestRoots()
  await writeApprovalMode(roots.home, 'webauthn')
  const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
  try {
    await mkdir(`${roots.project}/.biztest`, { recursive: true })
    await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    const snapshot = { ...runSnapshot(), projectIdentityDigest: identity.digest }
    const seedDigest = `sha256:${'d'.repeat(64)}`
    await store.beginRequest('SEED-CLI', seedDigest)
    const lock = await store.acquireRunLock(identity.digest, snapshot.runId)
    try { await store.createRunOutcome(snapshot, 'SEED-CLI', seedDigest, { seeded: true }, lock) }
    finally { await lock.close() }
    for (const [index, runId] of [
      'RUN-CLEANUP-AUTHORITY', 'RUN-CLEANUP-BOTH', 'RUN-PARTIAL-STDOUT',
    ].entries()) {
      const cleanupSeedId = `SEED-CLI-CLEANUP-${index + 1}`
      const cleanupSeedDigest = `sha256:${String(index + 1).repeat(64)}`
      await store.beginRequest(cleanupSeedId, cleanupSeedDigest)
      const cleanupLock = await store.acquireRunLock(identity.digest, runId)
      try {
        await store.createRunOutcome(
          { ...snapshot, runId }, cleanupSeedId, cleanupSeedDigest, { seeded: true }, cleanupLock,
        )
      } finally { await cleanupLock.close() }
    }
  } finally { await store.close() }

  const close = vi.fn(async () => undefined)
  const processHandle = {
    enrollIdentity: vi.fn(),
    openApprovalSession: vi.fn(async () => ({
      url: `http://localhost:43001/#${'c'.repeat(43)}`, sessionId: 'SESSION-CLI',
    })),
    waitForSession: vi.fn(async () => undefined),
    close,
  }
  const startAuthorityHost = vi.fn(async () => new RuntimeAuthorityHost({
    processHandle, installationDigest,
  }))
  const request = {
    schemaVersion: '1.0.0', requestId: 'APPROVE-CLI', client: { name: 'test', version: '1.0.0' },
    command: 'open-approval', projectRoot: roots.project,
    payload: { runId: 'RUN-1', approvalType: 'scope' },
  }
  const stdout = captureWritable()
  const stderr = captureWritable()
  try {
    const exitCode = await runCli(
      ['rpc'], Readable.from([JSON.stringify(request)]), stdout.stream, stderr.stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('not used') },
        uninstallRuntime: async () => { throw new Error('not used') },
        inspectRuntimeInstallation: async () => runtimeInstallation(),
        startAuthorityHost,
      },
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, result: { sessionId: 'SESSION-CLI' } })
    expect(stderr.text()).toBe(`http://localhost:43001/#${'c'.repeat(43)}\n`)
    expect(startAuthorityHost).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()

    const replayStdout = captureWritable()
    startAuthorityHost.mockRejectedValueOnce(new Error('Authority must not start for replay'))
    expect(await runCli(
      ['rpc'], Readable.from([JSON.stringify(request)]), replayStdout.stream, captureWritable().stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('not used') },
        uninstallRuntime: async () => { throw new Error('not used') },
        inspectRuntimeInstallation: async () => runtimeInstallation(),
        startAuthorityHost,
      },
    )).toBe(0)
    expect(JSON.parse(replayStdout.text())).toEqual(JSON.parse(stdout.text()))
    expect(startAuthorityHost).toHaveBeenCalledTimes(1)

    startAuthorityHost.mockReset()
    startAuthorityHost.mockImplementation(async () => new RuntimeAuthorityHost({
      processHandle, installationDigest,
    }))
    const statusStdout = captureWritable()
    const statusRequest = {
      schemaVersion: '1.0.0', requestId: 'STATUS-CLI', client: { name: 'test', version: '1.0.0' },
      command: 'get-status', projectRoot: roots.project, payload: { runId: 'RUN-1' },
    }
    expect(await runCli(
      ['rpc'], Readable.from([JSON.stringify(statusRequest)]), statusStdout.stream, captureWritable().stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('not used') },
        uninstallRuntime: async () => { throw new Error('not used') },
        inspectRuntimeInstallation: async () => runtimeInstallation(),
        startAuthorityHost,
      },
    )).toBe(0)
    expect(startAuthorityHost).not.toHaveBeenCalled()

    const invalidExecuteStdout = captureWritable()
    const invalidExecuteRequest = {
      schemaVersion: '1.0.0', requestId: 'EXECUTE-INVALID-WORKFLOW',
      client: { name: 'test', version: '1.0.0' }, command: 'execute-run',
      projectRoot: roots.project, payload: { runId: 'RUN-1' },
    }
    expect(await runCli(
      ['rpc'], Readable.from([JSON.stringify(invalidExecuteRequest)]),
      invalidExecuteStdout.stream, captureWritable().stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('not used') },
        uninstallRuntime: async () => { throw new Error('not used') },
        inspectRuntimeInstallation: async () => runtimeInstallation(),
        startAuthorityHost,
      },
    )).toBe(2)
    expect(JSON.parse(invalidExecuteStdout.text())).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH' },
    })
    expect(startAuthorityHost).not.toHaveBeenCalled()

    for (const runStoreAlsoThrows of [false, true]) {
      const originalRunStoreClose = RuntimeRunStore.prototype.close
      const runStoreClose = vi.spyOn(RuntimeRunStore.prototype, 'close').mockImplementation(async function (this: RuntimeRunStore) {
        await originalRunStoreClose.call(this)
        if (runStoreAlsoThrows) throw new Error('run store cleanup failed')
      })
      close.mockRejectedValueOnce(new Error('authority cleanup failed'))
      const cleanupStdout = captureWritable()
      const cleanupRequest = {
        ...request,
        requestId: runStoreAlsoThrows ? 'APPROVE-CLEANUP-BOTH' : 'APPROVE-CLEANUP-AUTHORITY',
        payload: {
          ...request.payload,
          runId: runStoreAlsoThrows ? 'RUN-CLEANUP-BOTH' : 'RUN-CLEANUP-AUTHORITY',
        },
      }
      try {
        expect(await runCli(
          ['rpc'], Readable.from([JSON.stringify(cleanupRequest)]), cleanupStdout.stream, captureWritable().stream,
          {
            homeDir: roots.home,
            installRuntime: async () => { throw new Error('not used') },
            uninstallRuntime: async () => { throw new Error('not used') },
            inspectRuntimeInstallation: async () => runtimeInstallation(),
            startAuthorityHost,
          },
        )).toBe(70)
        expect(cleanupStdout.text().trim().split('\n')).toHaveLength(1)
        expect(JSON.parse(cleanupStdout.text())).toMatchObject({
          ok: false, error: { code: 'E2E_RUNTIME_CLEANUP_FAILED' },
        })
        expect(runStoreClose).toHaveBeenCalledOnce()
      } finally { runStoreClose.mockRestore() }

      const callsBeforeReplay = startAuthorityHost.mock.calls.length
      startAuthorityHost.mockImplementation(async () => { throw new Error('Authority must stay lazy for persisted replay') })
      const persistedReplayStdout = captureWritable()
      expect(await runCli(
        ['rpc'], Readable.from([JSON.stringify(cleanupRequest)]),
        persistedReplayStdout.stream, captureWritable().stream,
        {
          homeDir: roots.home,
          installRuntime: async () => { throw new Error('not used') },
          uninstallRuntime: async () => { throw new Error('not used') },
          inspectRuntimeInstallation: async () => runtimeInstallation(),
          startAuthorityHost,
        },
      )).toBe(0)
      expect(JSON.parse(persistedReplayStdout.text())).toMatchObject({
        ok: true, result: { sessionId: 'SESSION-CLI' },
      })
      expect(startAuthorityHost).toHaveBeenCalledTimes(callsBeforeReplay)
      startAuthorityHost.mockImplementation(async () => new RuntimeAuthorityHost({
        processHandle, installationDigest,
      }))
    }

    const partialWrites: Buffer[] = []
    let writeCalls = 0
    const partiallyRejectingStdout = new Writable({
      write(chunk, _encoding, callback) {
        writeCalls += 1
        partialWrites.push(Buffer.from(chunk).subarray(0, 8))
        callback(new Error('stdout failed after partial write'))
      },
    })
    partiallyRejectingStdout.on('error', () => undefined)
    expect(await runCli(
      ['rpc'], Readable.from([JSON.stringify({
        ...request,
        requestId: 'APPROVE-PARTIAL-STDOUT',
        payload: { ...request.payload, runId: 'RUN-PARTIAL-STDOUT' },
      })]),
      partiallyRejectingStdout, captureWritable().stream,
      {
        homeDir: roots.home,
        installRuntime: async () => { throw new Error('not used') },
        uninstallRuntime: async () => { throw new Error('not used') },
        inspectRuntimeInstallation: async () => runtimeInstallation(),
        startAuthorityHost,
      },
    )).toBe(70)
    expect(writeCalls).toBe(1)
    expect(Buffer.concat(partialWrites).toString()).toBe('{"ok":tr')
  } finally {
    await rm(roots.root, { recursive: true, force: true })
  }
})

test('default rpc production wiring starts a real Authority child and closes it after TTL', async ({ skip }) => {
  const roots = await createRuntimeTestRoots()
  await writeApprovalMode(roots.home, 'webauthn')
  const installation = {
    ...runtimeInstallation(),
    versionRoot: await realpath(process.cwd()),
    entrypoint: `${process.cwd()}/packages/e2e-runtime/src/bin/repo-e2e.ts`,
  }
  const authorityDirectory = `${roots.home}/.mutil-skills/e2e/authority`
  const stateKey = Buffer.alloc(32, 0x31)
  const subject = `local:uid:${process.getuid?.()}`
  let url = ''
  try {
    await mkdir(authorityDirectory, { recursive: true, mode: 0o700 })
    await writeFile(`${authorityDirectory}/state.key`, stateKey, { mode: 0o600 })
    const authority = await LocalApprovalAuthority.open({
      issuer: 'e2e-runtime-authority', keyId: 'approval-v1', now: () => new Date(),
      statePath: `${authorityDirectory}/approval.sqlite`, stateEncryptionKey: stateKey,
      testWorkspaceRoots: [installation.versionRoot],
      approvalIdentities: [{ subject, roles: ['e2e-approver'] }],
      manualIdentities: [{ subject, roles: [
        'scope-approver', 'lineage-approver', 'privacy-approver',
      ] }],
    })
    await authority.createWebAuthnCredentialRepository().insert({
      id: 'CRED-REAL-CHILD', publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
      counter: 0, transports: ['internal'], subject,
    })
    authority.close()

    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project })
    try {
      await mkdir(`${roots.project}/.biztest`, { recursive: true })
      await writeFile(`${roots.project}/.biztest/project.json`, JSON.stringify({
        schemaVersion: '1.0.0', projectId: 'PROJECT-1',
      }))
      const identity = await resolveProjectIdentity(roots.project)
      const snapshot = { ...runSnapshot(), projectIdentityDigest: identity.digest }
      const seedDigest = `sha256:${'c'.repeat(64)}`
      await store.beginRequest('SEED-REAL-CLI', seedDigest)
      const lock = await store.acquireRunLock(identity.digest, snapshot.runId)
      try { await store.createRunOutcome(snapshot, 'SEED-REAL-CLI', seedDigest, { seeded: true }, lock) }
      finally { await lock.close() }
    } finally { await store.close() }

    const request = {
      schemaVersion: '1.0.0', requestId: 'APPROVE-REAL-CLI', client: { name: 'test', version: '1.0.0' },
      command: 'open-approval', projectRoot: roots.project,
      payload: { runId: 'RUN-1', approvalType: 'scope' },
    }
    const stdout = captureWritable()
    const stderr = captureWritable()
    let exitCode: number
    try {
      exitCode = await runCli(
        ['rpc'], Readable.from([JSON.stringify(request)]), stdout.stream, stderr.stream,
        {
          homeDir: roots.home,
          installRuntime: async () => { throw new Error('not used') },
          uninstallRuntime: async () => { throw new Error('not used') },
          inspectRuntimeInstallation: async () => installation,
          approvalSessionTtlMs: 30,
        },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED') { skip(); return }
      throw error
    }
    url = stderr.text().trim()
    const cliResponse = JSON.parse(stdout.text()) as { error?: { code?: string } }
    if (cliResponse.error?.code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED') {
      expect(url).toBe('')
      skip()
      return
    }
    expect(exitCode, stdout.text()).toBe(4)
    expect(new URL(url).search).toBe('')
    expect(new URL(url).hash).toMatch(/^#[A-Za-z0-9_-]{43}$/)
    expect(cliResponse).toMatchObject({
      ok: false, error: { code: 'E2E_APPROVAL_SESSION_EXPIRED' },
    })
    await expect(fetch(new URL(url).origin)).rejects.toThrow()
  } finally {
    stateKey.fill(0)
    await rm(roots.root, { recursive: true, force: true })
  }
})

function runSnapshot(): RuntimeRunSnapshot {
  const normalizedText = '# 订单\n必须显示待审核订单。'
  const normalizedDigest = digestText('e2e-prd-normalized-source/v1', normalizedText)
  const requirementModel: Record<string, unknown> = {
    artifactId: 'ARTIFACT-REQUIREMENT-MODEL', artifactType: 'requirement-model', schemaVersion: '1.0.0',
    engineVersion: '0.3.0', assetId: 'ASSET-1', prdRevision: `sha256:${'3'.repeat(64)}`,
    generationId: 'RUN-1', createdAt: '2026-07-16T00:00:00.000Z', contentDigest: '',
    signatures: [], dependencies: [], graph: { defines: [], references: [] },
    content: { modelRevision: 1, requirements: [{
      reqId: 'REQ-1', revision: 1, title: '订单列表', actors: ['auditor'], entities: ['order'],
      preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business', statement: '显示待审核订单',
        sourceRefs: ['CLAUSE-1'], certainty: 'explicit', oracleIds: ['ORACLE-1'] }], states: [], transitions: [],
      observableOutcomes: [{ oracleId: 'ORACLE-1', ruleId: 'RULE-1', statement: '页面显示待审核订单',
        sourceRefs: ['CLAUSE-1'] }],
      applicability: [], sourceRefs: ['CLAUSE-1'], status: 'active',
    }], coupledDimensions: [], applicabilityRules: ['RULE-1'],
    modelDecisionDigest: `sha256:${'4'.repeat(64)}` },
  }
  requirementModel.contentDigest = digestArtifactContent(
    'artifact-content/1.0.0/requirement-model', requirementModel,
  )
  return {
    schemaVersion: '1.1.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: `sha256:${'1'.repeat(64)}`,
    runtimeInstallationDigest: installationDigest,
    workflow: { current: 'awaiting-scope-approval', sequence: 2, eventChainDigest: `sha256:${'2'.repeat(64)}` },
    artifactDigests: { 'prd-source': `sha256:${'3'.repeat(64)}`, scope: `sha256:${'4'.repeat(64)}`,
      'requirement-model': requirementModel.contentDigest as string },
    frozenArtifacts: { 'requirement-model': requirementModel as never },
    trustedExecutionFacts: { 'prd-source-snapshot': {
      schemaVersion: '1.0.0', sourceRef: 'inputs/prd.md', normalizedText,
      normalizedDigest,
      byteLength: Buffer.byteLength(normalizedText),
    } },
    requestResponses: {}, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
  }
}

function executionReviewSnapshot(): RuntimeRunSnapshot {
  const snapshot = runSnapshot()
  const source = snapshot.trustedExecutionFacts['prd-source-snapshot'] as {
    normalizedText: string; normalizedDigest: string
  }
  const { prdManifest, acceptanceScope } = semanticReviewArtifacts(
    source.normalizedText, source.normalizedDigest,
  )
  return {
    ...snapshot,
    artifactDigests: {
      ...snapshot.artifactDigests,
      'prd-manifest': prdManifest.contentDigest as string,
      'acceptance-scope': acceptanceScope.contentDigest as string,
    },
    frozenArtifacts: {
      ...snapshot.frozenArtifacts,
      'prd-manifest': prdManifest as never,
      'acceptance-scope': acceptanceScope as never,
    },
  }
}

function semanticReviewArtifacts(normalizedText: string, normalizedDigest: string) {
  const clauseInput = {
    clauseId: 'CLAUSE-1', sourceId: 'PRD-1', kind: 'functional' as const,
    sourceSpan: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 11 },
    originalText: '必须显示待审核订单。', normalizedText: '必须显示待审核订单。',
  }
  const clause = { ...clauseInput, textDigest: digestPrdClause(clauseInput) }
  const artifact = (artifactType: string, schemaVersion: string, content: unknown) => {
    const document: Record<string, unknown> = {
      artifactId: `ARTIFACT-${artifactType.toUpperCase()}`, artifactType, schemaVersion,
      engineVersion: '0.3.0', assetId: 'ASSET-1', prdRevision: `sha256:${'3'.repeat(64)}`,
      generationId: 'RUN-1', createdAt: '2026-07-16T00:00:00.000Z', contentDigest: '',
      signatures: [], dependencies: [], graph: { defines: [], references: [] }, content,
    }
    document.contentDigest = digestArtifactContent(
      `artifact-content/${schemaVersion}/${artifactType}`, document,
    )
    return document
  }
  const prdManifest = artifact('prd-manifest', '1.0.0', {
    prdId: 'PRD-1', assetId: 'ASSET-1', revision: `sha256:${'3'.repeat(64)}`,
    normalizedPrdDigest: normalizedDigest,
    sources: [{ sourceId: 'PRD-1', digest: normalizedDigest, byteLength: Buffer.byteLength(normalizedText) }],
    attachments: [], sourceCacheIndexDigest: `sha256:${'5'.repeat(64)}`, clauses: [clause],
    clauseInventoryDigest: digestPrdClauseInventory([clause]),
  })
  const acceptanceScope = artifact('acceptance-scope', '2.0.0', {
    includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['CLAUSE-1'] }], exclusions: [],
    ambiguities: [], dependencies: [], visualScope: { required: false, refs: [] },
    browserScope: { browserIds: ['chromium'], viewportIds: ['desktop'] },
    clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'modeled', requirementIds: ['REQ-1'] }],
    scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
  })
  return { prdManifest, acceptanceScope }
}

async function semanticConfirmRequest(
  host: E2ERuntimeHost,
  request: RuntimeRequestEnvelope,
) {
  if (request.command !== 'open-approval') throw new Error('open-approval required')
  const response = await host.handle(request, JSON.stringify(request))
  expect(response).toMatchObject({ ok: true, result: {
    status: 'confirmation-required', approvalMode: 'webauthn',
    summary: { semanticReview: { requirements: expect.any(Array) } },
  } })
  if (!response.ok) throw new Error('semantic confirmation was not created')
  const result = response.result as { confirmationId: string; subjectDigest: string }
  return RuntimeRequestEnvelopeSchema.parse({
    schemaVersion: request.schemaVersion,
    requestId: `${request.requestId}-CONFIRMED`,
    client: request.client,
    command: 'confirm-approval',
    projectRoot: request.projectRoot,
    payload: {
      runId: request.payload.runId,
      confirmationId: result.confirmationId,
      subjectDigest: result.subjectDigest,
    },
  })
}

function manualDraft() {
  return {
    schemaVersion: '1.0.0' as const, manualResultId: 'MANUAL-RESULT-ADAPTER-1',
    runId: 'RUN-1', assetId: 'ASSET-1', prdRevision: `sha256:${'1'.repeat(64)}`,
    generationId: 'RUN-1', runtimeInstallationDigest: installationDigest,
    manualProcedureId: 'MANUAL-1', caseIds: ['CASE-MANUAL-1'], obligationIds: ['COV-MANUAL-1'],
    requirementModelDigest: `sha256:${'2'.repeat(64)}`,
    executor: { subject: 'os-user:executor', roles: ['e2e-manual-executor'] },
    reviewer: { subject: 'os-user:reviewer', roles: ['e2e-manual-reviewer'] },
    startedAt: '2026-07-18T00:00:00.000Z', finishedAt: '2026-07-18T00:01:00.000Z',
    outcome: 'passed' as const,
    steps: [{ stepId: 'STEP-MANUAL-1', instructionDigest: `sha256:${'3'.repeat(64)}`,
      outcome: 'passed' as const, observation: '符合预期', evidenceDigests: [`sha256:${'4'.repeat(64)}`] }],
    evidenceDigests: [`sha256:${'4'.repeat(64)}`], expiresAt: '2026-07-18T01:00:00.000Z',
  }
}

function manualProof(draft: ReturnType<typeof manualDraft>, draftDigest: string) {
  return {
    issuer: 'fixture-authority', keyId: 'fixture-key', proofScope: 'local-os-user' as const,
    algorithm: 'Ed25519' as const, signedDigest: `sha256:${'5'.repeat(64)}`, signature: 'signature',
    executorPresence: { role: 'executor' as const, approvalType: 'manual-executor' as const,
      requiredRole: 'e2e-manual-executor' as const, subject: draft.executor.subject,
      sessionId: 'SESSION-EXECUTOR', runId: draft.runId, installationDigest,
      draftDigest, origin: 'http://localhost:41011', issuedAt: '2026-07-18T00:01:00.000Z',
      expiresAt: draft.expiresAt },
    reviewerPresence: { role: 'reviewer' as const, approvalType: 'manual-reviewer' as const,
      requiredRole: 'e2e-manual-reviewer' as const, subject: draft.reviewer.subject,
      sessionId: 'SESSION-REVIEWER', runId: draft.runId, installationDigest,
      draftDigest, origin: 'http://localhost:41012', issuedAt: '2026-07-18T00:02:00.000Z',
      expiresAt: draft.expiresAt },
  }
}

function executionGrantSubject(snapshot: RuntimeRunSnapshot) {
  return {
    schemaVersion: '1.0.0' as const,
    assetId: snapshot.assetId,
    prdRevision: snapshot.artifactDigests['prd-source']!,
    executionDigest: `sha256:${'5'.repeat(64)}`,
    environment: 'test' as const,
    baseOrigin: 'https://test.example.com',
    actions: [{
      actionId: 'ACTION-WS-1', origin: 'https://test.example.com', path: '/events',
      maxInboundMessages: 1, maxBytes: 1024,
    }],
  }
}

function localExecutionGrantSubject(snapshot: RuntimeRunSnapshot) {
  const subject = executionGrantSubject(snapshot)
  return {
    ...subject,
    actions: subject.actions.map((action) => ({ ...action, origin: 'wss://test.example.com' })),
  }
}

function signedExecutionGrant(
  grantId: string,
  subject: ReturnType<typeof executionGrantSubject>,
  subjectDigest: string,
  binding: {
    runId: string
    installationDigest: string
    approvalType: 'execution'
    subjectDigest: string
  },
) {
  const issuedAt = '2026-07-17T00:00:00.000Z'
  const expiresAt = '2026-07-17T00:05:00.000Z'
  const approverSubject = 'os-user:runtime-test'
  const action = subject.actions[0]!
  return {
    grantId,
    issuer: 'runtime-test-authority',
    keyId: 'runtime-test-key',
    proofScope: 'local-os-user' as const,
    approver: { subject: approverSubject, roles: ['e2e-approver'] },
    approvalContext: {
      schemaVersion: '1.0.0' as const,
      subject: approverSubject,
      ...binding,
      origin: 'http://localhost:42009',
      issuedAt,
      expiresAt,
    },
    subject,
    subjectDigest,
    issuedAt,
    expiresAt,
    capabilities: [{
      capabilityId: `CAP-${grantId}`,
      nonce: 'c'.repeat(64),
      transport: 'websocket' as const,
      effect: 'read' as const,
      actionId: action.actionId,
      origin: action.origin,
      path: action.path,
      maxInboundMessages: action.maxInboundMessages,
      maxBytes: action.maxBytes,
      maxUses: 1 as const,
    }],
    revocationSequence: 0,
    signature: 's'.repeat(86),
  }
}

function runtimeInstallation() {
  return {
    version: '0.0.0', protocolMajor: 1 as const,
    versionRoot: '/runtime', entrypoint: '/runtime/repo-e2e.js',
    installationDigest, sourceRepositoryIndependent: true as const,
  }
}

function captureWritable(): { stream: Writable; text(): string } {
  const chunks: Buffer[] = []
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}
