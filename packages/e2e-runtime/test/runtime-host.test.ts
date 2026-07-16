import {
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  digestArtifactContent,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import type { RuntimeInstallation } from '../src/runtime-discovery.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { RuntimeRunStore } from '../src/run-store.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const installation: RuntimeInstallation = {
  version: '0.0.0',
  protocolMajor: 1,
  versionRoot: '/runtime/versions/0.0.0',
  entrypoint: '/runtime/versions/0.0.0/runtime-host.js',
  installationDigest: digest('9'),
  sourceRepositoryIndependent: true,
}

describe('E2ERuntimeHost', () => {
  test('creates a persistent run and reports status only under the same physical project identity', async () => {
    const fixture = await hostFixture()
    const created = await fixture.host.handle(createRunRequest('REQUEST-CREATE-1', fixture.roots.project))
    const createdResult = successResult(created)

    expect(createdResult).toMatchObject({
      runId: 'RUN-REQUEST-CREATE-1',
      projectIdentityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      generationId: 'RUN-REQUEST-CREATE-1',
      prdRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      workflow: { current: 'created', sequence: 0 },
    })

    const status = await fixture.host.handle(getStatusRequest(
      'REQUEST-STATUS-1',
      fixture.roots.project,
      createdResult.runId as string,
    ))
    expect(successResult(status)).toMatchObject({
      runId: createdResult.runId,
      assetId: 'ASSET-1',
      workflow: { current: 'created', sequence: 0 },
    })

    const copied = join(fixture.roots.root, 'project-copy')
    await cp(fixture.roots.project, copied, { recursive: true })
    const copiedStatus = await fixture.host.handle(getStatusRequest(
      'REQUEST-STATUS-2', copied, createdResult.runId as string,
    ))
    expect(copiedStatus).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_RUN_NOT_FOUND' },
    })
    await fixture.store.close()
  })

  test('replays identical requests but fails closed when a request id is rebound', async () => {
    const fixture = await hostFixture()
    const request = createRunRequest('REQUEST-CREATE-1', fixture.roots.project)
    const first = await fixture.host.handle(request)
    const replay = await fixture.host.handle(request)

    expect(replay).toEqual(first)
    const rebound = await fixture.host.handle({
      ...request,
      payload: { ...request.payload, assetId: 'ASSET-2' },
    })
    expect(rebound).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })
    await fixture.store.close()
  })

  test('binds request ids to the original request bytes rather than only parsed JSON semantics', async () => {
    const fixture = await hostFixture()
    const request = createRunRequest('REQUEST-CREATE-1', fixture.roots.project)
    const bytes = JSON.stringify(request)

    const first = await fixture.host.handle(request, bytes)
    expect(first.ok).toBe(true)
    const reboundBytes = await fixture.host.handle(request, `${bytes} `)
    expect(reboundBytes).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })
    await fixture.store.close()
  })

  test('parses and re-digests a candidate before advancing exactly one Engine edge', async () => {
    const fixture = await hostFixture()
    const created = successResult(await fixture.host.handle(
      createRunRequest('REQUEST-CREATE-1', fixture.roots.project),
    ))
    const candidate = prdRequestCandidate({
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    })
    const response = await fixture.host.handle(submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-1',
      projectRoot: fixture.roots.project,
      runId: created.runId as string,
      expectedState: 'created',
      candidate,
    }))

    expect(successResult(response)).toMatchObject({
      runId: created.runId,
      workflow: { current: 'source-frozen', sequence: 1 },
      acceptedArtifact: { artifactType: 'prd-request', contentDigest: candidate.contentDigest },
    })
    const status = successResult(await fixture.host.handle(getStatusRequest(
      'REQUEST-STATUS-1', fixture.roots.project, created.runId as string,
    )))
    expect(status.workflow).toMatchObject({ current: 'source-frozen', sequence: 1 })
    await fixture.store.close()
  })

  test('rejects caller state jumps, candidate rebinding, and false content digests without mutating state', async () => {
    const fixture = await hostFixture()
    const created = successResult(await fixture.host.handle(
      createRunRequest('REQUEST-CREATE-1', fixture.roots.project),
    ))
    const candidate = prdRequestCandidate({
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    })

    const stateJump = await fixture.host.handle(submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-JUMP', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'accepted', candidate,
    }))
    expect(stateJump).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH' } })

    const reboundCandidate = { ...candidate, assetId: 'OTHER-ASSET' }
    reboundCandidate.contentDigest = digestArtifactContent(
      `artifact-content/${reboundCandidate.schemaVersion}/${reboundCandidate.artifactType}`,
      reboundCandidate,
    )
    const rebound = await fixture.host.handle(submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-REBIND', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate: reboundCandidate,
    }))
    expect(rebound).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_CANDIDATE_BINDING_MISMATCH' } })

    const falseDigest = await fixture.host.handle(submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-DIGEST', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created',
      candidate: { ...candidate, contentDigest: digest('f') },
    }))
    expect(falseDigest).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_CANDIDATE_DIGEST_MISMATCH' } })
    const reboundAfterError = await fixture.host.handle(submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-DIGEST', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate,
    }))
    expect(reboundAfterError).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })

    const status = successResult(await fixture.host.handle(getStatusRequest(
      'REQUEST-STATUS-1', fixture.roots.project, created.runId as string,
    )))
    expect(status.workflow).toMatchObject({ current: 'created', sequence: 0 })
    await fixture.store.close()
  })

  test('returns the strict doctor report through the host envelope', async () => {
    const fixture = await hostFixture()
    const response = await fixture.host.handle(RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-DOCTOR-1',
      client: { name: 'test-client', version: '1.0.0' }, command: 'doctor', payload: {},
    }))

    expect(successResult(response)).toMatchObject({ ready: true, runtimeVersion: '0.0.0' })
    await fixture.store.close()
  })
})

async function hostFixture() {
  const roots = await createRuntimeTestRoots()
  await mkdir(join(roots.project, '.biztest'), { recursive: true })
  await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
    schemaVersion: '1.0.0', projectId: 'PROJECT-1',
  }))
  await writeFile(join(roots.project, 'prd.md'), '# Product\nA stable PRD.')
  await writeFile(join(roots.project, 'policy.json'), '{}')
  const store = await RuntimeRunStore.open({
    stateRoot: join(roots.home, '.mutil-skills/e2e/state'), forbiddenRoots: [roots.project],
  })
  const host = new E2ERuntimeHost({
    installation,
    doctor: async () => ({
      ready: true,
      runtimeVersion: installation.version,
      installationDigest: installation.installationDigest,
      probes: {},
    }),
    runStore: store,
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  })
  return { roots, store, host }
}

function requestHeader(requestId: string) {
  return {
    schemaVersion: '1.0.0' as const,
    requestId,
    client: { name: 'test-client', version: '1.0.0' },
  }
}

function createRunRequest(requestId: string, projectRoot: string) {
  return RuntimeRequestEnvelopeSchema.parse({
    ...requestHeader(requestId), command: 'create-run', projectRoot,
    payload: {
      assetId: 'ASSET-1',
      prdSource: { kind: 'file', path: 'prd.md' },
      projectPolicyPath: 'policy.json',
    },
  }) as Extract<RuntimeRequestEnvelope, { command: 'create-run' }>
}

function getStatusRequest(requestId: string, projectRoot: string, runId: string): RuntimeRequestEnvelope {
  return RuntimeRequestEnvelopeSchema.parse({
    ...requestHeader(requestId), command: 'get-status', projectRoot, payload: { runId },
  })
}

function submitCandidateRequest(input: {
  requestId: string
  projectRoot: string
  runId: string
  expectedState: string
  candidate: Record<string, unknown>
}): RuntimeRequestEnvelope {
  return RuntimeRequestEnvelopeSchema.parse({
    ...requestHeader(input.requestId), command: 'submit-candidate', projectRoot: input.projectRoot,
    payload: {
      runId: input.runId,
      expectedState: input.expectedState,
      artifactType: 'prd-request',
      candidate: input.candidate,
    },
  })
}

function prdRequestCandidate(binding: {
  assetId: string
  generationId: string
  prdRevision: string
}): Record<string, unknown> & { contentDigest: string; schemaVersion: string; artifactType: string } {
  const candidate = {
    artifactId: 'PRD-REQUEST-1', artifactType: 'prd-request', schemaVersion: '1.0.0',
    engineVersion: '0.1.0', ...binding, createdAt: '2026-07-17T00:00:00.000Z',
    contentDigest: '', signatures: [], dependencies: [], graph: { defines: [], references: [] },
    content: {
      productSpace: 'PRODUCT', title: 'Product PRD',
      sourceDescriptors: [{ sourceId: 'PRD-BODY', kind: 'file', ref: 'prd.md' }],
      userRequest: 'Test the product', testWorkspaceId: 'WORKSPACE-1', secretRefs: [],
    },
  }
  return {
    ...candidate,
    contentDigest: digestArtifactContent(
      `artifact-content/${candidate.schemaVersion}/${candidate.artifactType}`,
      candidate,
    ),
  }
}

function successResult(response: RuntimeResponseEnvelope): Record<string, unknown> {
  const parsed = RuntimeResponseEnvelopeSchema.parse(response)
  expect(parsed.ok).toBe(true)
  expect(parsed.result).toBeTypeOf('object')
  return parsed.result as Record<string, unknown>
}
