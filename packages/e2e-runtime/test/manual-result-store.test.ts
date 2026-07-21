import {
  canonicalizeJson,
  digestArtifactContent,
  digestText,
  RuntimeRequestEnvelopeSchema,
  type ArtifactDocument,
  type ManualResult,
} from '@mutil-skills/e2e-contracts'
import { buildCompleteGeneration } from '@mutil-skills/e2e-engine'
import { completeGenerationFixture } from '../../e2e-engine/test/complete-generation.fixture.js'
import { describe, expect, test, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { resolveProjectIdentity } from '../src/project-identity.js'
import { createRuntimeTestRoots } from './fixtures.js'

const d = (value: string): string => digestText('manual-result-store-test/v1', value)
const NOW = new Date('2026-07-18T00:03:00.000Z')

describe('trusted manual result store', () => {
  test('atomically appends an exactly-bound result without allowing overwrite or replay', async () => {
    const fixture = manualRunFixture()
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project, now: () => NOW })
    await createRun(store, fixture.snapshot)

    await store.beginRequest('REQUEST-MANUAL-1', d('request-1'))
    const firstLock = await store.acquireRunLock(fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId)
    const firstCapability = await store.authorizeTrustedFactWrite(
      fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId, firstLock,
    )
    await expect(store.appendTrustedManualResultOutcome({
      capability: firstCapability,
      requestId: 'REQUEST-MANUAL-1',
      requestDigest: d('request-1'),
      result: fixture.result,
      response: { ok: true },
    })).resolves.toEqual({ ok: true })
    await firstLock.close()

    const persisted = await store.getRun(fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId)
    expect(persisted?.trustedExecutionFacts['manual-results-by-id']).toEqual({
      [fixture.result.manualResultId]: fixture.result,
    })

    await store.beginRequest('REQUEST-MANUAL-DUPLICATE', d('request-duplicate'))
    const duplicateLock = await store.acquireRunLock(fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId)
    const duplicateCapability = await store.authorizeTrustedFactWrite(
      fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId, duplicateLock,
    )
    await expect(store.appendTrustedManualResultOutcome({
      capability: duplicateCapability,
      requestId: 'REQUEST-MANUAL-DUPLICATE',
      requestDigest: d('request-duplicate'),
      result: fixture.result,
      response: { ok: true },
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_MANUAL_RESULT_DUPLICATE' })
    await duplicateLock.close()
    expect((await store.getRun(fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId))
      ?.trustedExecutionFacts['manual-results-by-id']).toEqual({
      [fixture.result.manualResultId]: fixture.result,
    })
    await store.close()
  })

  test.each([
    ['run', (result: ManualResult) => ({ ...result, runId: 'OTHER-RUN' })],
    ['installation', (result: ManualResult) => ({ ...result, runtimeInstallationDigest: d('other-installation') })],
    ['asset', (result: ManualResult) => ({ ...result, assetId: 'OTHER-ASSET' })],
    ['revision', (result: ManualResult) => ({ ...result, prdRevision: d('other-prd') })],
    ['model', (result: ManualResult) => ({ ...result, requirementModelDigest: d('other-model') })],
    ['case', (result: ManualResult) => ({ ...result, caseIds: ['CASE-OTHER'] })],
    ['obligation', (result: ManualResult) => ({ ...result, obligationIds: ['COV-OTHER'] })],
    ['procedure', (result: ManualResult) => ({ ...result, manualProcedureId: 'MANUAL-OTHER' })],
    ['instructions', (result: ManualResult) => ({ ...result, steps: result.steps.map((step) => ({
      ...step, instructionDigest: d('other-instructions'),
    })) })],
  ])('rejects %s rebinding without polluting trusted state', async (_label, mutate) => {
    const fixture = manualRunFixture()
    const roots = await createRuntimeTestRoots()
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project, now: () => NOW })
    await createRun(store, fixture.snapshot)
    const requestId = `REQUEST-REBIND-${String(_label).toUpperCase()}`
    const requestDigest = d(requestId)
    await store.beginRequest(requestId, requestDigest)
    const lock = await store.acquireRunLock(fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId)
    const capability = await store.authorizeTrustedFactWrite(
      fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId, lock,
    )
    await expect(store.appendTrustedManualResultOutcome({
      capability, requestId, requestDigest,
      result: rebindProof(mutate(fixture.result)), response: { ok: true },
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_MANUAL_RESULT_BINDING_INVALID' })
    await lock.close()
    expect((await store.getRun(fixture.snapshot.projectIdentityDigest, fixture.snapshot.runId))
      ?.trustedExecutionFacts).not.toHaveProperty('manual-results-by-id')
    await store.close()
  })

  test('drives prepare, executor presence, reviewer presence and immutable persistence through Runtime RPC', async () => {
    const fixture = manualRunFixture()
    const roots = await createRuntimeTestRoots()
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-MANUAL-1',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    fixture.snapshot.projectIdentityDigest = identity.digest
    const store = await RuntimeRunStore.open({
      homeDir: roots.home, projectRoot: roots.project, now: () => NOW,
    })
    await createRun(store, fixture.snapshot)
    const draft = (() => {
      const { authorityProof: _authorityProof, ...value } = fixture.result
      return value
    })()
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
    const prepareManualResult = async () => ({
      manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor' as const,
    })
    const requestManualResultRole = async (input: { role: 'executor' | 'reviewer' }) => ({
      url: input.role === 'executor'
        ? `http://localhost:43101/#${'a'.repeat(43)}`
        : `http://localhost:43102/#${'b'.repeat(43)}`,
      sessionId: input.role === 'executor' ? 'SESSION-EXECUTOR' : 'SESSION-REVIEWER',
      wait: async () => undefined,
      finalizeManualResultRole: async () => input.role === 'executor'
        ? { status: 'awaiting-reviewer' as const, manualResultId: draft.manualResultId,
          draftDigest, nextRole: 'reviewer' as const }
        : { status: 'issued' as const, result: fixture.result },
    })
    const host = new E2ERuntimeHost({
      installation: { version: '0.0.0', protocolMajor: 1, versionRoot: '/runtime',
        entrypoint: '/runtime/repo-e2e.js', installationDigest: fixture.snapshot.runtimeInstallationDigest,
        sourceRepositoryIndependent: true },
      doctor: async () => { throw new Error('not used') }, runStore: store, now: () => NOW,
      authorityHostFactory: async () => ({ prepareManualResult, requestManualResultRole } as never),
      presentUserPresenceUrl: async () => undefined,
    })
    const request = (requestId: string, command: 'prepare-manual-result' | 'finalize-manual-result-role',
      payload: Record<string, unknown>) => RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId, client: { name: 'test', version: '1.0.0' },
      command, projectRoot: roots.project, payload,
    })
    const prepare = request('REQUEST-PREPARE-MANUAL', 'prepare-manual-result', {
      runId: draft.runId, draft,
    })
    expect(await host.handle(prepare, canonicalizeJson(prepare))).toMatchObject({
      ok: true, result: { manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor' },
    })
    const executor = request('REQUEST-MANUAL-EXECUTOR', 'finalize-manual-result-role', {
      runId: draft.runId, manualResultId: draft.manualResultId, draftDigest, role: 'executor',
    })
    expect(await host.handle(executor, canonicalizeJson(executor))).toMatchObject({
      ok: true, result: { status: 'awaiting-reviewer', nextRole: 'reviewer' },
    })
    const reviewer = request('REQUEST-MANUAL-REVIEWER', 'finalize-manual-result-role', {
      runId: draft.runId, manualResultId: draft.manualResultId, draftDigest, role: 'reviewer',
    })
    expect(await host.handle(reviewer, canonicalizeJson(reviewer))).toMatchObject({
      ok: true, result: { status: 'issued', result: { manualResultId: draft.manualResultId } },
    })
    expect((await store.getRun(identity.digest, draft.runId))
      ?.trustedExecutionFacts['manual-results-by-id']).toEqual({ [draft.manualResultId]: fixture.result })
    await store.close()
  })

  test('recovers prepare, executor and reviewer persistence kill-points without opening another presence session', async () => {
    const fixture = manualRunFixture()
    const roots = await createRuntimeTestRoots()
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-MANUAL-RECOVERY',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    fixture.snapshot.projectIdentityDigest = identity.digest
    const store = await RuntimeRunStore.open({
      homeDir: roots.home, projectRoot: roots.project, now: () => NOW,
    })
    await createRun(store, fixture.snapshot)
    const { authorityProof: _authorityProof, ...draft } = fixture.result
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
    let prepareMutations = 0
    let executorCompleted = false
    let reviewerCompleted = false
    let executorSessions = 0
    let reviewerSessions = 0
    const authority = {
      prepareManualResult: async () => {
        prepareMutations += 1
        return { manualResultId: draft.manualResultId, draftDigest, nextRole: 'executor' as const }
      },
      recoverManualResultRole: async (input: { role: 'executor' | 'reviewer' }) => {
        if (input.role === 'executor' && executorCompleted) return {
          status: 'awaiting-reviewer' as const, manualResultId: draft.manualResultId,
          draftDigest, nextRole: 'reviewer' as const,
        }
        if (input.role === 'reviewer' && reviewerCompleted) return {
          status: 'issued' as const, result: fixture.result,
        }
        return undefined
      },
      requestManualResultRole: async (input: { role: 'executor' | 'reviewer' }) => {
        if (input.role === 'executor') executorSessions += 1
        else reviewerSessions += 1
        return {
          url: input.role === 'executor'
            ? `http://localhost:44101/#${'c'.repeat(43)}`
            : `http://localhost:44102/#${'d'.repeat(43)}`,
          sessionId: input.role === 'executor' ? 'SESSION-EXECUTOR' : 'SESSION-REVIEWER',
          wait: async () => undefined,
          finalizeManualResultRole: async () => {
            if (input.role === 'executor') {
              executorCompleted = true
              return { status: 'awaiting-reviewer' as const, manualResultId: draft.manualResultId,
                draftDigest, nextRole: 'reviewer' as const }
            }
            reviewerCompleted = true
            return { status: 'issued' as const, result: fixture.result }
          },
        }
      },
    }
    const makeHost = () => new E2ERuntimeHost({
      installation: { version: '0.0.0', protocolMajor: 1, versionRoot: '/runtime',
        entrypoint: '/runtime/repo-e2e.js', installationDigest: fixture.snapshot.runtimeInstallationDigest,
        sourceRepositoryIndependent: true },
      doctor: async () => { throw new Error('not used') }, runStore: store, now: () => NOW,
      authorityHostFactory: async () => authority as never,
      presentUserPresenceUrl: async () => undefined,
    })
    const request = (requestId: string, command: 'prepare-manual-result' | 'finalize-manual-result-role',
      payload: Record<string, unknown>) => RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId, client: { name: 'test', version: '1.0.0' },
      command, projectRoot: roots.project, payload,
    })

    const prepare = request('REQUEST-PREPARE-CRASH', 'prepare-manual-result', { runId: draft.runId, draft })
    const prepareBytes = canonicalizeJson(prepare)
    const preparePersistence = vi.spyOn(store, 'readRunOutcome')
      .mockRejectedValueOnce(new Error('kill after Authority prepare mutation'))
    expect(await makeHost().handle(prepare, prepareBytes)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_MANUAL_RESULT_PERSISTENCE_PENDING' },
    })
    const reboundPrepare = RuntimeRequestEnvelopeSchema.parse({
      ...prepare,
      payload: { ...prepare.payload, draft: { ...draft,
        steps: draft.steps.map((step) => ({ ...step, observation: 'rebound bytes' })) } },
    })
    expect(await makeHost().handle(reboundPrepare, canonicalizeJson(reboundPrepare))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })
    expect(prepareMutations).toBe(1)
    expect(await makeHost().handle(prepare, prepareBytes)).toMatchObject({ ok: true })
    expect(prepareMutations).toBe(2)
    preparePersistence.mockRestore()

    const executor = request('REQUEST-EXECUTOR-CRASH', 'finalize-manual-result-role', {
      runId: draft.runId, manualResultId: draft.manualResultId, draftDigest, role: 'executor',
    })
    const executorBytes = canonicalizeJson(executor)
    const executorPersistence = vi.spyOn(store, 'readRunOutcome')
      .mockRejectedValueOnce(new Error('kill after executor proof mutation'))
    expect(await makeHost().handle(executor, executorBytes)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_MANUAL_RESULT_PERSISTENCE_PENDING' },
    })
    expect(await makeHost().handle(executor, executorBytes)).toMatchObject({
      ok: true, result: { status: 'awaiting-reviewer' },
    })
    expect(executorSessions).toBe(1)
    executorPersistence.mockRestore()

    const reviewer = request('REQUEST-REVIEWER-CRASH', 'finalize-manual-result-role', {
      runId: draft.runId, manualResultId: draft.manualResultId, draftDigest, role: 'reviewer',
    })
    const reviewerBytes = canonicalizeJson(reviewer)
    const appendManualResult = store.appendTrustedManualResultOutcome.bind(store)
    const reviewerPersistence = vi.spyOn(store, 'appendTrustedManualResultOutcome')
      .mockRejectedValueOnce(new Error('kill after reviewer issue before response append'))
      .mockImplementationOnce(async (input) => {
        await appendManualResult(input)
        throw new Error('kill after atomic result and response append before Host return')
      })
    expect(await makeHost().handle(reviewer, reviewerBytes)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_MANUAL_RESULT_PERSISTENCE_PENDING' },
    })
    expect(await makeHost().handle(reviewer, reviewerBytes)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_MANUAL_RESULT_PERSISTENCE_PENDING' },
    })
    expect(await makeHost().handle(reviewer, reviewerBytes)).toMatchObject({
      ok: true, result: { status: 'issued' },
    })
    expect(reviewerSessions).toBe(1)
    reviewerPersistence.mockRestore()
    expect((await store.getRun(identity.digest, draft.runId))
      ?.trustedExecutionFacts['manual-results-by-id']).toEqual({ [draft.manualResultId]: fixture.result })
    await store.close()
  })

  test('terminalizes an expired recovered result instead of leaving its request pending forever', async () => {
    const fixture = manualRunFixture()
    const roots = await createRuntimeTestRoots()
    await mkdir(join(roots.project, '.biztest'), { recursive: true })
    await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
      schemaVersion: '1.0.0', projectId: 'PROJECT-MANUAL-EXPIRED-RECOVERY',
    }))
    const identity = await resolveProjectIdentity(roots.project)
    fixture.snapshot.projectIdentityDigest = identity.digest
    const store = await RuntimeRunStore.open({ homeDir: roots.home, projectRoot: roots.project, now: () => NOW })
    await createRun(store, fixture.snapshot)
    const { authorityProof: _authorityProof, ...draft } = fixture.result
    const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
    const expiredResult = { ...fixture.result, expiresAt: '2026-07-18T00:02:00.000Z' }
    const host = new E2ERuntimeHost({
      installation: { version: '0.0.0', protocolMajor: 1, versionRoot: '/runtime',
        entrypoint: '/runtime/repo-e2e.js', installationDigest: fixture.snapshot.runtimeInstallationDigest,
        sourceRepositoryIndependent: true },
      doctor: async () => { throw new Error('not used') }, runStore: store, now: () => NOW,
      authorityHostFactory: async () => ({
        recoverManualResultRole: async () => ({ status: 'issued' as const, result: expiredResult }),
      } as never),
    })
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-EXPIRED-RECOVERY',
      client: { name: 'test', version: '1.0.0' }, command: 'finalize-manual-result-role',
      projectRoot: roots.project, payload: { runId: draft.runId, manualResultId: draft.manualResultId,
        draftDigest, role: 'reviewer' },
    })
    const bytes = canonicalizeJson(request)
    const first = await host.handle(request, bytes)
    expect(first).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_MANUAL_RESULT_BINDING_INVALID' } })
    expect(await host.handle(request, bytes)).toEqual(first)
    await store.close()
  })
})

async function createRun(store: RuntimeRunStore, snapshot: RuntimeRunSnapshot): Promise<void> {
  await store.beginRequest('REQUEST-CREATE', d('create'))
  const lock = await store.acquireRunLock(snapshot.projectIdentityDigest, snapshot.runId)
  await store.createRunOutcome(snapshot, 'REQUEST-CREATE', d('create'), { ok: true }, lock)
  await lock.close()
}

function manualRunFixture(): { snapshot: RuntimeRunSnapshot; result: ManualResult } {
  const built = buildCompleteGeneration(completeGenerationFixture())
  const artifacts = Object.fromEntries(built.artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const model = structuredClone(artifacts['requirement-model']!)
  const coverage = rebindArtifact(structuredClone(artifacts['coverage-universe']!), (content: any) => {
    content.obligations.push({
      obligationId: 'COV-MANUAL-1', reqId: 'REQ-1', ruleIds: ['RULE-1'], nodeIds: [],
      actor: 'USER', transitionId: 'not-applicable', scenario: '人工核验关键视觉结果',
      necessity: 'required', applicabilityRuleId: 'APPLICABILITY-1',
      disposition: { kind: 'manual', manualProcedureId: 'MANUAL-1', blocking: true },
    })
  })
  const cases = rebindArtifact(structuredClone(artifacts['test-cases']!), (content: any) => {
    content.cases.push({
      caseId: 'CASE-MANUAL-1', revision: 1, obligationIds: ['COV-MANUAL-1'],
      title: '人工视觉核验', actor: 'USER', necessity: 'required', preconditions: ['页面可访问'],
      dataNeedIds: [], steps: [{ stepId: 'STEP-MANUAL-1', ordinal: 0,
        semanticAction: '人工核验', semanticTarget: '关键视觉结果',
        oracles: [{ oracleId: 'ORACLE-MANUAL-1', statement: '视觉结果符合 PRD' }],
        evidenceKinds: ['screenshot'] }], mode: 'real-environment', effect: 'read', evidenceLevel: 'E1',
      cleanupPlanId: 'not-applicable', timeoutMs: 60_000, retryPolicy: 'none', status: 'active',
    })
  })
  const instructionDigest = d('manual-instructions')
  const execution = rebindArtifact(structuredClone(artifacts['execution-contract']!), (content: any) => {
    content.manualProcedures.push({ manualProcedureId: 'MANUAL-1', instructionDigest })
  })
  const now = '2026-07-18T00:00:00.000Z'
  const draft = {
    schemaVersion: '1.0.0' as const, manualResultId: 'MANUAL-RESULT-1',
    runId: 'GEN-1', assetId: 'ASSET-1', prdRevision: model.prdRevision, generationId: 'GEN-1',
    runtimeInstallationDigest: d('runtime-installation'), manualProcedureId: 'MANUAL-1',
    caseIds: ['CASE-MANUAL-1'], obligationIds: ['COV-MANUAL-1'],
    requirementModelDigest: model.contentDigest,
    executor: { subject: 'os-user:executor', roles: ['e2e-manual-executor'] },
    reviewer: { subject: 'os-user:reviewer', roles: ['e2e-manual-reviewer'] },
    startedAt: now, finishedAt: '2026-07-18T00:01:00.000Z', outcome: 'passed' as const,
    steps: [{ stepId: 'STEP-MANUAL-1', instructionDigest, outcome: 'passed' as const,
      observation: '人工确认符合预期', evidenceDigests: [d('evidence')] }],
    evidenceDigests: [d('evidence')], expiresAt: '2026-07-18T01:00:00.000Z',
  }
  const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
  const result = {
    ...draft,
    authorityProof: {
      issuer: 'fixture-authority', keyId: 'fixture-manual-key', proofScope: 'local-os-user' as const,
      algorithm: 'Ed25519' as const, signedDigest: d('manual-result'), signature: 'fixture-signature',
      approvalAssurance: { approvalMode: 'webauthn' as const, identityVerified: true,
        separationOfDutiesVerified: true },
      executorPresence: { role: 'executor' as const, approvalType: 'manual-executor' as const,
        requiredRole: 'e2e-manual-executor' as const, subject: draft.executor.subject,
        sessionId: 'SESSION-EXECUTOR', runId: draft.runId,
        installationDigest: draft.runtimeInstallationDigest, draftDigest,
        origin: 'http://localhost:43101', issuedAt: now, expiresAt: draft.expiresAt },
      reviewerPresence: { role: 'reviewer' as const, approvalType: 'manual-reviewer' as const,
        requiredRole: 'e2e-manual-reviewer' as const, subject: draft.reviewer.subject,
        sessionId: 'SESSION-REVIEWER', runId: draft.runId,
        installationDigest: draft.runtimeInstallationDigest, draftDigest,
        origin: 'http://localhost:43102', issuedAt: '2026-07-18T00:02:00.000Z', expiresAt: draft.expiresAt },
    },
  }
  return {
    snapshot: {
      schemaVersion: '1.4.0', runId: draft.runId, assetId: draft.assetId,
      projectIdentityDigest: d('project'), runtimeInstallationDigest: draft.runtimeInstallationDigest,
      runRevision: 0, workflow: { current: 'compiled', sequence: 1, eventChainDigest: d('workflow') },
      artifactDigests: {
        'prd-source': draft.prdRevision,
        'requirement-model': model.contentDigest,
        'coverage-universe': coverage.contentDigest,
        'test-cases': cases.contentDigest,
        'execution-contract': execution.contentDigest,
      },
      frozenArtifacts: { 'requirement-model': model, 'coverage-universe': coverage,
        'test-cases': cases, 'execution-contract': execution },
      trustedExecutionFacts: {}, writeAttempts: {},
      executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
      requestResponses: {}, createdAt: now, updatedAt: now,
    },
    result,
  }
}

function rebindArtifact(document: ArtifactDocument, mutate: (content: any) => void): ArtifactDocument {
  mutate(document.content)
  ;(document as any).contentDigest = d('placeholder')
  ;(document as any).contentDigest = digestArtifactContent(
    `artifact-content/${document.schemaVersion}/${document.artifactType}`, document,
  )
  return document
}

function rebindProof(result: ManualResult): ManualResult {
  const { authorityProof, ...draft } = result
  const draftDigest = digestText('manual-result-draft/v1', canonicalizeJson(draft))
  return { ...result, authorityProof: {
    ...authorityProof,
    executorPresence: { ...authorityProof.executorPresence, runId: result.runId,
      installationDigest: result.runtimeInstallationDigest, draftDigest },
    reviewerPresence: { ...authorityProof.reviewerPresence, runId: result.runId,
      installationDigest: result.runtimeInstallationDigest, draftDigest },
  } }
}
