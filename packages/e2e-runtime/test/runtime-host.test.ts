import {
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  ReadApprovalSubjectSchema,
  SignedGrantSchema,
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  computeRegressionSourceSetDigest,
  digestApprovalProjection,
  digestArtifactContent,
  digestBytes,
  digestCompiledPrdRunPlan,
  deriveExecutionResultId,
  digestPrdClause,
  digestPrdClauseInventory,
  digestPrdUnderstandingProjection,
  digestPrdUnderstandingQuote,
  digestText,
  type ArtifactDocument,
  type ArtifactType,
  type ApprovalGrantSubject,
  type SignedDiscoveryGrant,
  type SignedGrant,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { cp, mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import type { RuntimeInstallation } from '../src/runtime-discovery.js'
import { E2ERuntimeHost } from '../src/runtime-host.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from '../src/run-store.js'
import { SecureProjectFileReader } from '../src/secure-project-files.js'
import {
  authorizeRuntimeInjectionExecutor,
  authorizeRuntimeFullPlaywrightExecutor,
  authorizeRuntimeReadExecutor,
  authorizeRuntimeWriteExecutor,
} from '../src/trusted-action-runner.js'
import { authorizeRuntimePreflight } from '../src/runtime-preflight.js'
import { authorizeRuntimeWriteProduction } from '../src/runtime-write-production.js'
import type { RuntimeAuthorityHost } from '../src/authority-host.js'
import type { ProjectPublisher } from '../src/project-publisher.js'
import { projectionFixture } from './trusted-action-runner.test.js'
import {
  multiCaseFixture,
  runtimeFullPlaywrightOutput,
} from './runtime-full-playwright-projector.test.js'
import { injectionOutput, realWriteOutput, runtimeWriteDigest } from './runtime-write-fixtures.js'
import { authorizeRuntimeGenerationFinalizer } from '../src/runtime-generation-finalizer.js'
import { authorizeRuntimeEvidenceQuarantine } from '../src/runtime-evidence-quarantine.js'
import { createCaseSchedule } from '../src/multi-case-scheduler.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const installation: RuntimeInstallation = {
  version: '0.0.0',
  protocolMajor: 1,
  versionRoot: '/runtime/versions/0.0.0',
  entrypoint: '/runtime/versions/0.0.0/runtime-host.js',
  installationDigest: digest('9'),
  sourceRepositoryIndependent: true,
}
const UNDERSTANDING_CONTRACT_MACHINE_VIEW = {
  schemaVersion: '1.0.0' as const,
  nodes: [{
    nodeId: 'REQ-1', kind: 'REQ' as const, statement: 'A stable PRD.',
    provenance: { kind: 'source-fact' as const, anchors: [{
      sourceId: 'PRD-BODY', sourceSpan: {
        startLine: 2, startColumn: 1, endLine: 2, endColumn: 14,
      }, quote: 'A stable PRD.', quoteDigest: digestPrdUnderstandingQuote('A stable PRD.'),
    }] },
    responsibility: 'Product', upstreamNodeIds: [], downstreamNodeIds: [],
    acceptanceCriteria: ['Product behavior is stable'],
  }],
  pendingQuestions: [],
  route: { skillName: 'e2e' as const, steps: [{
    stepId: 'E2E-1', inputNodeIds: ['REQ-1'], output: 'E2E report', constraints: [],
    dependencyStepIds: [], completionCondition: 'REQ-1 is covered',
  }] },
  authorizedNodeIds: ['REQ-1'],
}
const UNDERSTANDING_CONTRACT_TEXT = [
  '---',
  'schemaVersion: 1.0.0',
  'contractId: CONTRACT-PRODUCT',
  'contractVersion: 1',
  'contractStatus: confirmed-by-caller',
  'confirmationStatus: confirmed-by-caller',
  'confirmationContractVersion: 1',
  'confirmedAt: 2026-07-17T00:00:00.000Z',
  '---',
  '# Requirements Contract',
  '<!-- e2e-contract-machine-view:v1',
  JSON.stringify(UNDERSTANDING_CONTRACT_MACHINE_VIEW),
  '-->',
].join('\n')

describe('E2ERuntimeHost', () => {
  test('finalize-run 持久化 attempt 后发布同代 generation，完成 active 复读并幂等重放', async () => {
    const finalize = vi.fn(async (input: { snapshot: { runId: string }; recovery: boolean }) => ({
      generationId: input.snapshot.runId,
      generationDigest: digest('1'),
      terminalVerdict: 'accepted' as const,
      activeReadbackDigest: digest('2'),
      quarantineDispositionDigest: digest('3'),
    }))
    const fixture = await hostFixture({ finalizeGeneration: finalize })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-FINALIZE-CREATE', fixture.roots.project),
    ))
    await seedDiagnosingRun(fixture, created, 'REQUEST-SEED-DIAGNOSING')
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-FINALIZE-1',
      client: { name: 'e2e-skill', version: '0.1.0' }, command: 'finalize-run',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })

    const first = await handleRequest(fixture.host, request)
    const replay = await handleRequest(fixture.host, request)

    expect(first).toEqual(replay)
    expect(successResult(first)).toMatchObject({
      runId: created.runId,
      generationId: created.runId,
      generationDigest: digest('1'),
      terminalVerdict: 'accepted',
    })
    expect(finalize).toHaveBeenCalledOnce()
    expect(finalize.mock.calls[0]?.[0]).toMatchObject({
      recovery: false,
      snapshot: { workflow: { current: 'finalizing' } },
    })
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(persisted).toMatchObject({
      workflow: { current: 'accepted' },
      publication: {
        generationId: created.runId,
        generationDigest: digest('1'),
        activeReadbackDigest: digest('2'),
        quarantineDispositionDigest: digest('3'),
      },
    })
    expect(persisted).not.toHaveProperty('finalizationAttempt')
    await fixture.store.close()
  })

  test('finalize-run 崩溃后只以相同 request/attempt 显式恢复，不重复推测发布', async () => {
    let calls = 0
    const finalize = vi.fn(async (input: {
      snapshot: { runId: string }; recovery: boolean; attemptId: string
    }) => {
      calls += 1
      if (calls === 1) throw new Error('crash after publication boundary')
      return {
        generationId: input.snapshot.runId,
        generationDigest: digest('4'), terminalVerdict: 'rejected' as const,
        activeReadbackDigest: digest('5'), quarantineDispositionDigest: digest('6'),
      }
    })
    const fixture = await hostFixture({ finalizeGeneration: finalize })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-FINALIZE-RECOVERY-CREATE', fixture.roots.project),
    ))
    await seedDiagnosingRun(fixture, created, 'REQUEST-SEED-FINALIZE-RECOVERY')
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-FINALIZE-RECOVERY',
      client: { name: 'e2e-skill', version: '0.1.0' }, command: 'finalize-run',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })

    expect(await handleRequest(fixture.host, request)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_FINALIZATION_RECOVERY_REQUIRED' },
    })
    const recovered = successResult(await handleRequest(fixture.host, request))
    expect(recovered).toMatchObject({ terminalVerdict: 'rejected', generationDigest: digest('4') })
    expect(finalize.mock.calls.map((call) => call[0].recovery)).toEqual([false, true])
    expect(finalize.mock.calls[1]?.[0].attemptId).toBe(finalize.mock.calls[0]?.[0].attemptId)
    await fixture.store.close()
  })

  test('render-report 只渲染绑定当前 run 的 active generation，并进入请求重放账本', async () => {
    const renderActiveReport = vi.fn(async () => ({
      active: {
        generationId: 'RUN-REQUEST-REPORT-CREATE',
        generationDigest: digest('7'),
        terminalVerdict: 'accepted' as const,
      },
      rendered: { json: '{}\n', markdown: '# report\n', html: '<h1>report</h1>\n' },
      reportDirectory: '/project/.biztest/reports/ASSET-1/RUN-REQUEST-REPORT-CREATE',
    }))
    const fixture = await hostFixture({
      projectPublisherFactory: () => ({ renderActiveReport }),
    })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-REPORT-CREATE', fixture.roots.project),
    ))
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-REPORT-1',
      client: { name: 'e2e-skill', version: '0.1.0' }, command: 'render-report',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })

    const first = await handleRequest(fixture.host, request)
    const replay = await handleRequest(fixture.host, request)

    expect(first).toEqual(replay)
    expect(successResult(first)).toEqual({
      runId: created.runId,
      assetId: 'ASSET-1',
      generationId: created.runId,
      generationDigest: digest('7'),
      terminalVerdict: 'accepted',
      report: { json: '{}\n', markdown: '# report\n', html: '<h1>report</h1>\n' },
    })
    expect(renderActiveReport).toHaveBeenCalledOnce()
    expect(renderActiveReport).toHaveBeenCalledWith({
      assetId: 'ASSET-1', expectedGenerationId: created.runId,
      expectedProjectIdentityDigest: created.projectIdentityDigest,
    })
    await fixture.store.close()
  })

  test('creates a persistent run and reports status only under the same physical project identity', async () => {
    const fixture = await hostFixture()
    const created = await handleRequest(fixture.host, createRunRequest('REQUEST-CREATE-1', fixture.roots.project))
    const createdResult = successResult(created)

    expect(createdResult).toMatchObject({
      runId: 'RUN-REQUEST-CREATE-1',
      projectIdentityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      generationId: 'RUN-REQUEST-CREATE-1',
      prdRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sourceRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      understandingContractDigest: digestBytes(
        'e2e-prd-understanding-contract-source/v1', Buffer.from(UNDERSTANDING_CONTRACT_TEXT),
      ),
      sourceBundle: [{
        sourceId: 'PRD-BODY', kind: 'file', ref: 'inputs/prd.md', mediaType: 'text/markdown',
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        byteLength: Buffer.byteLength('# Product\nA stable PRD.'),
      }],
      workflow: { current: 'created', sequence: 0 },
    })
    const createdSnapshot = await fixture.store.getRun(
      createdResult.projectIdentityDigest as string, createdResult.runId as string,
    )
    expect(createdSnapshot?.trustedExecutionFacts['prd-source-snapshot']).toMatchObject({
      schemaVersion: '1.0.0', sourceRef: 'inputs/prd.md',
      normalizedText: '# Product\nA stable PRD.',
      normalizedDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(createdSnapshot?.trustedExecutionFacts['prd-understanding-contract']).toMatchObject({
      sourceDigest: createdResult.understandingContractDigest,
      normalizedText: UNDERSTANDING_CONTRACT_TEXT,
      machineView: UNDERSTANDING_CONTRACT_MACHINE_VIEW,
    })

    const status = await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-STATUS-1',
      fixture.roots.project,
      createdResult.runId as string,
    ))
    expect(successResult(status)).toMatchObject({
      runId: createdResult.runId,
      assetId: 'ASSET-1',
      workflow: { current: 'created', sequence: 0 },
      state: 'created',
      nextEdge: { command: 'prepare-prd-understanding', from: 'created', expectedState: 'created' },
      verifiedDigests: {
        runtimeInstallation: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        workflowEventChain: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      minimumMissingInput: ['prd-understanding-prepared'],
    })

    const copied = join(fixture.roots.root, 'project-copy')
    await cp(fixture.roots.project, copied, { recursive: true })
    const copiedStatus = await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-STATUS-2', copied, createdResult.runId as string,
    ))
    expect(copiedStatus).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_RUN_NOT_FOUND' },
    })
    await fixture.store.close()
  })

  test('create-run 拒绝与冻结 requirements contract 原文不一致的 Header', async () => {
    const fixture = await hostFixture()
    const request = createRunRequest('REQUEST-CONTRACT-HEADER-MISMATCH', fixture.roots.project)
    request.payload.understandingContract.header.contractId = 'CONTRACT-FORGED'
    expect(await handleRequest(fixture.host, request)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_CONTRACT_HEADER_MISMATCH' },
    })
    await fixture.store.close()
  })

  test('create-run 一次冻结 understand-prd 收集的 necessary-dependency Source Bundle', async () => {
    const fixture = await hostFixture()
    await writeFile(join(fixture.roots.project, 'inputs', 'rules.md'), 'Only named users may edit.')
    const request = createRunRequest('REQUEST-CREATE-SOURCE-BUNDLE', fixture.roots.project)
    const response = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...request,
      payload: { ...request.payload, supportingSources: [{
        sourceId: 'RULES', kind: 'file', path: 'inputs/rules.md', mediaType: 'text/markdown',
        origin: { kind: 'url', ref: 'https://example.test/rules' },
        relevance: 'necessary-dependency',
      }] },
    })))

    expect(response.sourceBundle).toEqual([
      expect.objectContaining({ sourceId: 'PRD-BODY', ref: 'inputs/prd.md' }),
      expect.objectContaining({
        sourceId: 'RULES', ref: 'inputs/rules.md', mediaType: 'text/markdown',
        origin: { kind: 'url', ref: 'https://example.test/rules' },
        relevance: 'necessary-dependency',
        digest: digestText('e2e-prd-understanding-source/v1', 'Only named users may edit.'),
        byteLength: Buffer.byteLength('Only named users may edit.'),
      }),
    ])
    const snapshot = await fixture.store.getRun(
      response.projectIdentityDigest as string, response.runId as string,
    )
    expect(snapshot?.trustedExecutionFacts['prd-source-bundle']).toMatchObject({
      sourceRevision: response.prdRevision,
      sources: [{ sourceId: 'PRD-BODY' }, { sourceId: 'RULES' }],
    })
    await fixture.store.close()
  })

  test('prepare-prd-understanding 由 Runtime 生成投影摘要并保持工作流只读', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-PREPARE-UNDERSTANDING', fixture.roots.project),
    ))
    const { projectionDigest: _ignored, ...draft } = understandingProjection(
      created.prdRevision as string,
    )
    const prepared = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREPARE-UNDERSTANDING'),
      command: 'prepare-prd-understanding', projectRoot: fixture.roots.project,
      payload: { runId: created.runId, projection: draft },
    })))

    expect(prepared).toMatchObject({
      runId: created.runId, sourceRevision: created.prdRevision,
      understanding: {
        contractId: 'CONTRACT-PRODUCT',
        projectionDigest: digestPrdUnderstandingProjection(draft),
      },
    })
    const replay = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREPARE-UNDERSTANDING-REPLAY'),
      command: 'prepare-prd-understanding', projectRoot: fixture.roots.project,
      payload: { runId: created.runId, projection: draft },
    })))
    expect(replay.understanding).toEqual(prepared.understanding)
    expect(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREPARE-UNDERSTANDING-DIFFERENT'),
      command: 'prepare-prd-understanding', projectRoot: fixture.roots.project,
      payload: { runId: created.runId, projection: {
        ...draft,
        nodes: draft.nodes.map((node) => ({ ...node, responsibility: 'Changed responsibility' })),
      } },
    }))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_CONTRACT_BODY_MISMATCH' },
    })
    expect(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREPARE-UNDERSTANDING-INVALID'),
      command: 'prepare-prd-understanding', projectRoot: fixture.roots.project,
      payload: { runId: created.runId, projection: { ...draft, pendingQuestions: [{
        questionId: 'QUESTION-1', question: '仍有待确认问题', affectedNodeIds: ['REQ-1'],
      }] } },
    }))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_SCHEMA_INVALID', category: 'input' },
    })
    const status = successResult(await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-STATUS-AFTER-PREPARE', fixture.roots.project, created.runId as string,
    )))
    expect(status).toMatchObject({
      state: 'created', nextEdge: { command: 'compile-prd-run' },
      minimumMissingInput: ['declarative-prd-run-design'],
      verifiedDigests: {
        'prd-understanding-projection': digestPrdUnderstandingProjection(draft),
      },
    })
    await fixture.store.close()
  })

  test('compile-prd-run 原子持久化编译计划与 Case 调度', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-COMPILE-CREATE', fixture.roots.project),
    ))
    await prepareUnderstandingForRun(fixture, created, 'REQUEST-COMPILE-PREPARE')
    const response = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-COMPILE-1'),
      command: 'compile-prd-run',
      projectRoot: fixture.roots.project,
      payload: {
        runId: created.runId,
        design: {
          schemaVersion: '1.0.0',
          cases: [{
            caseKey: 'stable-product',
            title: '验证产品行为稳定',
            actor: 'auditor',
            contractNodeIds: ['REQ-1'],
            actions: [{
              actionKey: 'observe-product',
              kind: 'full-playwright',
              effect: 'read',
              statement: '打开产品并观察稳定行为',
            }],
            oracles: [{
              oracleKey: 'stable-product-oracle',
              actionKey: 'observe-product',
              contractNodeId: 'REQ-1',
              acceptanceCriterion: 'Product behavior is stable',
            }],
            failurePolicy: 'stop-required',
          }],
        },
      },
    })))

    expect(response).toMatchObject({
      runId: created.runId,
      caseCount: 1,
      nextRequiredDecision: 'scope',
      unresolvedItems: [],
      review: {
        contractProjectionDigest: expect.stringMatching(/^sha256:/),
        caseIds: ['CASE-0001'],
        mappedAcceptanceCount: 1,
      },
    })
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(persisted?.compiledPrdRun?.cases).toHaveLength(1)
    expect(persisted?.caseSchedule?.cases).toMatchObject([{
      queueOrdinal: 0,
      caseId: 'CASE-0001',
      state: 'pending',
    }])
    expect(persisted?.caseSchedule?.compilerDigest).toBe(response.compilerDigest)
  })

  test('derives a publication-safe generation id from a protocol-valid lowercase request id', async () => {
    const fixture = await hostFixture()
    const response = await handleRequest(
      fixture.host,
      createRunRequest('request-lowercase:1', fixture.roots.project),
    )

    expect(successResult(response)).toMatchObject({
      runId: expect.stringMatching(/^RUN-[A-F0-9]{32}$/),
      generationId: expect.stringMatching(/^RUN-[A-F0-9]{32}$/),
    })
    await fixture.store.close()
  })

  test('replays identical requests but fails closed when a request id is rebound', async () => {
    const fixture = await hostFixture()
    const request = createRunRequest('REQUEST-CREATE-1', fixture.roots.project)
    const first = await handleRequest(fixture.host, request)
    const replay = await handleRequest(fixture.host, request)

    expect(replay).toEqual(first)
    const reboundRequest = {
      ...request,
      payload: { ...request.payload, assetId: 'ASSET-2' },
    }
    const rebound = await handleRequest(fixture.host, reboundRequest)
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
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-1', fixture.roots.project),
    ))
    const candidate = prdRequestCandidate({
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    })
    await prepareUnderstandingForRun(fixture, created, 'REQUEST-PREPARE-1')
    const response = await handleRequest(fixture.host, submitCandidateRequest({
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
    const status = successResult(await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-STATUS-1', fixture.roots.project, created.runId as string,
    )))
    expect(status.workflow).toMatchObject({ current: 'source-frozen', sequence: 1 })
    expect(status.verifiedDigests).toMatchObject({
      'prd-understanding-projection': (candidate as any).content.understanding.projectionDigest,
    })
    await expect(fixture.store.getRun(
      created.projectIdentityDigest as string,
      created.runId as string,
    )).resolves.toMatchObject({
      frozenArtifacts: { 'prd-request': candidate },
    })
    await fixture.store.close()
  })

  test('prd-request 不能跳过 Runtime prepare，也不能替换已准备投影', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-PREPARED-BINDING', fixture.roots.project),
    ))
    const candidate = prdRequestCandidate({
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    })
    expect(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-WITHOUT-PREPARE', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate,
    }))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_PREPARED_MISMATCH' },
    })
    await prepareUnderstandingForRun(fixture, created, 'REQUEST-PREPARE-BINDING')
    const changed = mutateUnderstandingCandidate(candidate, (understanding) => {
      understanding.nodes[0].responsibility = 'Changed responsibility'
    })
    expect(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-DIFFERENT-PREPARED', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate: changed,
    }))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_PREPARED_MISMATCH' },
    })
    await fixture.store.close()
  })

  test('拒绝过期契约 Revision、未冻结 source ref 与伪造 source-fact 引文', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-UNDERSTANDING-INVALID', fixture.roots.project),
    ))
    const { projectionDigest: _ignored, ...base } = understandingProjection(created.prdRevision as string)
    const prepare = (requestId: string, projection: unknown) => handleRequest(
      fixture.host,
      RuntimeRequestEnvelopeSchema.parse({
        ...requestHeader(requestId), command: 'prepare-prd-understanding',
        projectRoot: fixture.roots.project, payload: { runId: created.runId, projection },
      }),
    )

    const changedContractBody = structuredClone(base)
    changedContractBody.nodes[0]!.responsibility = 'Forged responsibility'
    expect(await prepare('REQUEST-UNDERSTANDING-BODY-MISMATCH', changedContractBody)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_CONTRACT_BODY_MISMATCH' },
    })

    const oversized = structuredClone(base)
    oversized.nodes = Array.from({ length: 40 }, (_unused, index) => ({
      ...structuredClone(base.nodes[0]!), nodeId: `REQ-LARGE-${index}`,
      responsibility: 'x'.repeat(64 * 1024),
      upstreamNodeIds: [], downstreamNodeIds: [],
    }))
    oversized.authorization.authorizedNodeIds = oversized.nodes.map((node) => node.nodeId)
    oversized.route.steps[0]!.inputNodeIds = oversized.authorization.authorizedNodeIds
    expect(await prepare('REQUEST-UNDERSTANDING-TOO-LARGE', oversized)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_TOO_LARGE' },
    })

    const stale = structuredClone(base)
    stale.sourceRevision = digest('f')
    expect(await prepare('REQUEST-UNDERSTANDING-STALE', stale)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_REVISION_MISMATCH' },
    })

    const missing = structuredClone(base)
    missing.sources.push({ sourceId: 'MISSING', kind: 'file', ref: 'inputs/missing.md',
      origin: { kind: 'file', ref: 'inputs/missing.md' },
      relevance: 'target', digest: digest('e'), byteLength: 1 })
    expect(await prepare('REQUEST-UNDERSTANDING-MISSING', missing)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_SOURCE_SET_MISMATCH' },
    })

    const forged = structuredClone(base)
    const quote = 'This fact does not occur.'
    forged.nodes[0]!.statement = quote
    forged.nodes[0]!.provenance.anchors[0]!.quote = quote
    forged.nodes[0]!.provenance.anchors[0]!.quoteDigest = digestPrdUnderstandingQuote(quote)
    expect(await prepare('REQUEST-UNDERSTANDING-FORGED', forged)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_CONTRACT_BODY_MISMATCH' },
    })

    const oldContract = structuredClone(base)
    oldContract.contractVersion = 2
    oldContract.authorization.contractVersion = 2
    expect(await prepare('REQUEST-UNDERSTANDING-OLD-CONTRACT', oldContract)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_CONTRACT_REVISION_MISMATCH' },
    })
    await fixture.store.close()
  })

  test('external candidates cannot forge trusted browser execution facts', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-FACT', fixture.roots.project),
    ))
    const candidate = prdRequestCandidate({
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    })
    const forged = { ...candidate, artifactType: 'browser-preflight' }

    const response = await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORGED-FACT', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate: forged,
      artifactType: 'browser-preflight',
    }))

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_TRUSTED_FACT_EXTERNAL_WRITE_FORBIDDEN' },
    })
    await fixture.store.close()
  })

  test('同阶段可补充完整语义资产，但已冻结类型不能被不同候选覆盖', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-SUPPLEMENTAL', fixture.roots.project),
    ))
    const binding = {
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    }
    const policy = projectPolicyCandidate(binding, 'RUNTIME-POLICY-1')
    const accepted = successResult(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUPPLEMENTAL-POLICY', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created',
      artifactType: 'project-policy', candidate: policy,
    })))
    expect(accepted).toMatchObject({
      workflow: { current: 'created', sequence: 0 },
      acceptedArtifact: { artifactType: 'project-policy', contentDigest: policy.contentDigest },
    })

    const replacement = projectPolicyCandidate(binding, 'RUNTIME-POLICY-2')
    const rejected = await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-REPLACE-POLICY', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created',
      artifactType: 'project-policy', candidate: replacement,
    }))
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_CANDIDATE_ALREADY_FROZEN', terminalState: 'artifact-blocked' },
    })
    await fixture.store.close()
  })

  test('通过公共 submit-candidate 冻结 binding 资产，并仅在两类资产齐备后申请执行审批', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-BINDING', fixture.roots.project),
    ))
    const projected = projectionFixture()
    const binding = {
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    }
    const actionMap = rebindArtifact(projected.frozenArtifacts['browser-action-map'], binding)
    await fixture.store.beginRequest('SEED-BINDING-DRAFT', digest('6'))
    const lock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string, created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-BINDING-DRAFT', digest('6'),
      (snapshot) => ({
        snapshot: {
          ...snapshot,
          artifactDigests: {
            ...snapshot.artifactDigests,
            'browser-action-map': actionMap.contentDigest,
          },
          frozenArtifacts: { 'browser-action-map': actionMap },
          workflow: { current: 'binding-draft', sequence: 7, eventChainDigest: digest('7') },
        },
        response: { seeded: true },
      }),
      'test-seed-binding-draft', lock,
    )
    await lock.close()

    const testCases = rebindArtifact(projected.frozenArtifacts['test-cases'], binding)
    const first = successResult(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-TEST-CASES', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'binding-draft',
      artifactType: 'test-cases', candidate: testCases,
    })))
    expect(first).toMatchObject({
      workflow: { current: 'binding-draft', sequence: 7 },
      acceptedArtifact: { artifactType: 'test-cases', contentDigest: testCases.contentDigest },
    })

    const executionContract = rebindArtifact(projected.frozenArtifacts['execution-contract'], binding)
    const second = successResult(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-EXECUTION-CONTRACT', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'binding-draft',
      artifactType: 'execution-contract', candidate: executionContract,
    })))
    expect(second).toMatchObject({
      workflow: { current: 'awaiting-execution-approval', sequence: 8 },
      acceptedArtifact: {
        artifactType: 'execution-contract', contentDigest: executionContract.contentDigest,
      },
    })
    await expect(fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )).resolves.toMatchObject({
      frozenArtifacts: {
        'browser-action-map': actionMap,
        'test-cases': testCases,
        'execution-contract': executionContract,
      },
    })
    await fixture.store.close()
  })

  test('写 Execution Contract 冻结时原子预留 Lease，并向 Skill 返回 Authority 分配的 fencing token', async () => {
    const reserveExecutionLeases = vi.fn(async (input: {
      runId: string
      leases: Array<{ leaseId: string; resourceKey: string; resourceFingerprint: string; ttlMs: number }>
    }) => input.leases.map((lease) => ({
      ...lease, runId: input.runId, exclusive: true as const, status: 'active' as const,
      fencingToken: 7, acquiredAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:10:00.000Z',
    })))
    const fixture = await hostFixture({ reserveExecutionLeases })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-WRITE-BINDING', fixture.roots.project),
    ))
    const projected = projectionFixture()
    const binding = { assetId: created.assetId as string, generationId: created.generationId as string,
      prdRevision: created.prdRevision as string }
    const actionMap = rebindArtifact(projected.frozenArtifacts['browser-action-map'], binding)
    await fixture.store.beginRequest('SEED-WRITE-BINDING-DRAFT', digest('6'))
    const lock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string, created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-WRITE-BINDING-DRAFT', digest('6'),
      (snapshot) => ({ snapshot: { ...snapshot,
        artifactDigests: { ...snapshot.artifactDigests, 'browser-action-map': actionMap.contentDigest },
        frozenArtifacts: { 'browser-action-map': actionMap },
        workflow: { current: 'binding-draft', sequence: 7, eventChainDigest: digest('7') },
      }, response: { seeded: true } }),
      'test-seed-write-binding-draft', lock,
    )
    await lock.close()
    const testCases = rebindArtifact(projected.frozenArtifacts['test-cases'], binding)
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-WRITE-CASES', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'binding-draft',
      artifactType: 'test-cases', candidate: testCases,
    }))
    const source = structuredClone(projected.frozenArtifacts['execution-contract']) as ArtifactDocument & {
      content: { dataNeeds: unknown[] }
    }
    source.content.dataNeeds = [{ leaseId: 'LEASE-WRITE-1', resourceKey: 'order:1',
      resourceFingerprint: digest('3'), mode: 'write' }]
    const executionContract = rebindArtifact(source, binding)

    const result = successResult(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-WRITE-CONTRACT', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'binding-draft',
      artifactType: 'execution-contract', candidate: executionContract,
    })))

    expect(reserveExecutionLeases).toHaveBeenCalledWith({
      runId: created.runId,
      leases: [{ leaseId: 'LEASE-WRITE-1', resourceKey: 'order:1',
        resourceFingerprint: digest('3'), ttlMs: 600_000 }],
    })
    expect(result).toMatchObject({
      workflow: { current: 'awaiting-execution-approval', sequence: 9 },
      reservedLeases: [{ leaseId: 'LEASE-WRITE-1', fencingToken: 7, status: 'active' }],
    })
    await fixture.store.close()
  })

  test('从 create-run 走公开 Host 全链，以正式 Authority Grant 执行只读 Case', async () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    const approver = { subject: 'os-user:runtime-host-test', roles: [
      'e2e-approver', 'scope-approver', 'lineage-approver',
    ] }
    let runId = ''
    let formalPreflightDigest: string | undefined
    const authority = LocalApprovalAuthority.create({
      issuer: 'runtime-host-test', keyId: 'runtime-host-key', now: () => now,
      approvalIdentities: [approver],
      manualIdentities: [approver],
      authenticateApproverSession: (_sessionId, expected) => ({
        subject: approver.subject, runId, approvalType: expected.approvalType,
        subjectDigest: expected.subjectDigest, installationDigest: installation.installationDigest,
        origin: 'http://127.0.0.1:43210', issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
    })
    const authorityAdapter = {
      async requestApproval(input: Parameters<RuntimeAuthorityHost['requestApproval']>[0]) {
        const common = {
          sessionId: `SESSION-${input.approvalType}`, url: 'http://127.0.0.1/approval', async wait() {},
          async finalizeDecision(decision: { decisionId: string; decisionSubject: any }) {
            return authority.issueDecisionReceipt({
              kind: decision.decisionSubject.kind,
              decisionId: decision.decisionId,
              decisionStatus: 'approved',
              decisionSubject: decision.decisionSubject,
              approver,
            })
          },
        }
        if (input.approvalType === 'scope') return common
        return {
          ...common,
          async finalize(subject: ApprovalGrantSubject) {
            const grant = 'expectedPageIdentity' in subject
              ? await authority.issueDiscoveryGrant({
                  subject, approvalSessionRef: 'formal-discovery', ttlMs: 60_000,
                })
              : await authority.issueReadGrant({
                  subject: ReadApprovalSubjectSchema.parse(subject),
                  approvalSessionRef: 'formal-execution', ttlMs: 60_000,
                })
            return { grant, approvalBinding: {
              runId: grant.approvalContext.runId, approvalType: grant.approvalContext.approvalType,
              subjectDigest: grant.subjectDigest,
              installationDigest: grant.approvalContext.installationDigest,
            } }
          },
        }
      },
    }
    const fixture = await hostFixture({
      authorityHostFactory: async () => authorityAdapter,
      quarantineEvidence: async (input) => ({
        schemaVersion: '1.0.0', runId: input.runId, attemptId: input.attemptId,
        records: [
          { evidenceType: 'screenshot', quarantinePath: `raw/${input.attemptId}/screenshot.bin`,
            plaintextDigest: digestBytes('quarantine-plaintext/v1', input.evidence.screenshot),
            byteLength: input.evidence.screenshot.byteLength },
          { evidenceType: 'dom', quarantinePath: `raw/${input.attemptId}/dom.bin`,
            plaintextDigest: digestBytes('quarantine-plaintext/v1', input.evidence.dom),
            byteLength: input.evidence.dom.byteLength },
        ],
      }),
      preflight: async () => {
        if (formalPreflightDigest === undefined) throw new Error('formal preflight not completed')
        return {
          status: 'ready', reservationId: 'RESERVATION-FORMAL', preflightDigest: formalPreflightDigest,
          observedIdentity: { url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'auditor' },
          browserMeasurement: {
            browserMeasurementDigest: digest('2'), browserClosureDigest: digest('3'),
            browserExecutableDigest: digest('4'), gatewaySessionMeasurementDigest: digest('5'),
            canaryProofDigest: digest('6'),
          },
          gatewayPolicyDigest: digest('7'), gatewayAuditDigest: digest('d'),
          authorityOutcomeDigest: digest('8'), authorityReceiptDigest: digest('a'),
        }
      },
      executeReadOnlyRun: async () => ({
        status: 'passed', result: {
          caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed', expected: [], actual: [],
          evidence: [
            { kind: 'screenshot', byteLength: 2,
              digest: digestBytes('runtime-evidence/screenshot/v1', new Uint8Array([1, 2])) },
            { kind: 'dom', byteLength: 2,
              digest: digestText('runtime-evidence/dom/v1', Buffer.from([3, 4]).toString('utf8')) },
            { kind: 'gateway-audit', byteLength: Buffer.byteLength(canonicalizeJson({
              received: 1, forwarded: 1, blocked: 0, byIntent: {},
            }), 'utf8'), digest: digestText('runtime-evidence/gateway-audit/v1', canonicalizeJson({
              received: 1, forwarded: 1, blocked: 0, byIntent: {},
            })) },
          ],
        },
        gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} },
        gatewayAuditDigest: digest('d'),
        evidence: { screenshot: new Uint8Array([1, 2]), dom: new Uint8Array([3, 4]) },
      }),
    })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-FORMAL', fixture.roots.project),
    ))
    runId = created.runId as string
    const binding = {
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    }
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-POLICY', projectRoot: fixture.roots.project,
      runId, expectedState: 'created', artifactType: 'project-policy',
      candidate: projectPolicyCandidate(binding, 'RUNTIME-POLICY-FORMAL'),
    }))
    const requestCandidate = prdRequestCandidate(binding)
    await prepareUnderstandingForRun(fixture, created, 'REQUEST-FORMAL-PREPARE')
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-PRD', projectRoot: fixture.roots.project,
      runId, expectedState: 'created', artifactType: 'prd-request', candidate: requestCandidate,
    }))
    const prematureAcceptance = semanticCandidate('acceptance-scope', '2.0.0', binding, {
      includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['CLAUSE-1'] }],
      clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'modeled', requirementIds: ['REQ-1'] }],
      exclusions: [], ambiguities: [], dependencies: [], visualScope: { required: false, refs: [] },
      browserScope: { browserIds: ['chromium'], viewportIds: ['desktop'] },
      scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
    })
    expect(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-SCOPE-PREMATURE', projectRoot: fixture.roots.project,
      runId, expectedState: 'source-frozen', artifactType: 'acceptance-scope',
      candidate: prematureAcceptance,
    }))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_STAGE_PREREQUISITES_MISSING' },
    })
    expect(successResult(await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-FORMAL-STATUS-SOURCE', fixture.roots.project, runId,
    ))).minimumMissingInput).toEqual([
      'project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation', 'acceptance-scope',
    ].filter((artifactType) => artifactType !== 'project-policy'))
    const prdText = '# Product\nA stable PRD.'
    const clauseInput = {
      clauseId: 'CLAUSE-1', sourceId: 'PRD-BODY', kind: 'functional' as const,
      sourceSpan: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 14 },
      originalText: 'A stable PRD.', normalizedText: 'A stable PRD.',
    }
    const clause = { ...clauseInput, textDigest: digestPrdClause(clauseInput) }
    const manifest = semanticCandidate('prd-manifest', '1.0.0', binding, {
      prdId: 'PRD-BODY', assetId: binding.assetId, revision: binding.prdRevision,
      normalizedPrdDigest: binding.prdRevision,
      sources: [{ sourceId: 'PRD-BODY', digest: binding.prdRevision,
        byteLength: Buffer.byteLength(prdText) }], attachments: [],
      sourceCacheIndexDigest: digest('e'), clauses: [clause],
      clauseInventoryDigest: digestPrdClauseInventory([clause]),
    })
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-MANIFEST', projectRoot: fixture.roots.project,
      runId, expectedState: 'source-frozen', artifactType: 'prd-manifest', candidate: manifest,
    }))
    for (const [artifactType, content] of [
      ['prd-diff', {
        previousRevision: digest('0'), currentRevision: binding.prdRevision,
        sectionChanges: [], lineageMappings: [], impactedEntityIds: [],
        lineageReview: { decisionId: 'LINEAGE-1', status: 'pending' },
      }],
      ['semantic-generation', {
        modelProvider: 'fixture', modelId: 'MODEL', modelVersion: '1.0.0',
        systemPromptDigest: digest('a'), toolOutputDigests: [],
        sampling: { temperature: 0, seed: 1 }, candidateDigests: [digest('b')],
        selectedDigest: digest('b'),
      }],
    ] as const) await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: `REQUEST-FORMAL-${artifactType}`, projectRoot: fixture.roots.project,
      runId, expectedState: 'source-frozen', artifactType,
      candidate: semanticCandidate(artifactType, artifactType === 'prd-diff' ? '2.0.0' : '1.0.0',
        binding, content),
    }))
    const acceptance = prematureAcceptance
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-SCOPE', projectRoot: fixture.roots.project,
      runId, expectedState: 'source-frozen', artifactType: 'acceptance-scope', candidate: acceptance,
    }))
    const scopeResult = await handleSuccess(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-FORMAL-SCOPE-APPROVAL'), command: 'open-approval',
      projectRoot: fixture.roots.project, payload: { runId, approvalType: 'scope' },
    }))
    expect(scopeResult).toMatchObject({ approvalType: 'scope' })

    const requirementModel = semanticCandidate('requirement-model', '1.0.0', binding, {
      modelRevision: 1, requirements: [{
        reqId: 'REQ-1', contractNodeIds: ['REQ-1'], revision: 1, title: '订单列表',
        actors: ['auditor'], entities: ['order'],
        preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business',
          contractNodeIds: ['REQ-1'],
          statement: '显示待审核订单', sourceRefs: ['CLAUSE-1'], certainty: 'explicit',
          oracleIds: ['ORACLE-1'] }],
        states: [], transitions: [], observableOutcomes: [{ oracleId: 'ORACLE-1',
          ruleId: 'RULE-1', statement: '页面显示待审核订单', sourceRefs: ['CLAUSE-1'],
          contractAcceptanceCriteria: [{ nodeId: 'REQ-1', criterionIndex: 0 }] }],
        applicability: [], sourceRefs: ['CLAUSE-1'], status: 'active',
      }], coupledDimensions: [], applicabilityRules: ['RULE-1'], modelDecisionDigest: digest('1'),
    })
    const interactionFlow = semanticCandidate('interaction-flow', '1.0.0', binding, { flows: [{
      flowId: 'FLOW-1', contractNodeIds: ['REQ-1'], nodes: [
        { nodeId: 'NODE-ENTRY', reqId: 'REQ-1', kind: 'entry', effect: 'read', oracleIds: ['ORACLE-1'] },
        { nodeId: 'NODE-EXIT', reqId: 'REQ-1', kind: 'exit', effect: 'read', oracleIds: ['ORACLE-1'] },
      ], edgeIds: ['EDGE-1'], entryNodeId: 'NODE-ENTRY', exitNodeIds: ['NODE-EXIT'],
    }] })
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-FLOW', projectRoot: fixture.roots.project,
      runId, expectedState: 'scope-approved', artifactType: 'interaction-flow', candidate: interactionFlow,
    }))
    const designAudit = semanticCandidate('design-audit', '1.0.0', binding, {
      inputDigests: [requirementModel.contentDigest], metrics: [], findings: [],
      orphanIds: [], weakIds: [], status: 'passed',
    })
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-DESIGN-AUDIT', projectRoot: fixture.roots.project,
      runId, expectedState: 'scope-approved', artifactType: 'design-audit', candidate: designAudit,
    }))
    const unboundRequirementModel = structuredClone(requirementModel) as any
    delete unboundRequirementModel.content.requirements[0].contractNodeIds
    unboundRequirementModel.contentDigest = ''
    unboundRequirementModel.contentDigest = digestArtifactContent(
      'artifact-content/1.0.0/requirement-model', unboundRequirementModel,
    )
    expect(await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-MODEL-UNBOUND', projectRoot: fixture.roots.project,
      runId, expectedState: 'scope-approved', artifactType: 'requirement-model',
      candidate: unboundRequirementModel,
    }))).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_UNDERSTANDING_DERIVED_ASSET_UNBOUND' },
    })
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-MODEL', projectRoot: fixture.roots.project,
      runId, expectedState: 'scope-approved', artifactType: 'requirement-model', candidate: requirementModel,
    }))
    const universe = semanticCandidate('coverage-universe', '1.0.0', binding, {
      coveragePolicyDigest: digest('2'), pairwiseSeed: 1, universeDigest: digest('3'), obligations: [],
    })
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-UNIVERSE', projectRoot: fixture.roots.project,
      runId, expectedState: 'modeled', artifactType: 'coverage-universe', candidate: universe,
    }))

    const projected = projectionFixture()
    const projectedDiscovery = SignedGrantSchema.parse(
      projected.trustedExecutionFacts['signed-discovery-grant'],
    ) as SignedDiscoveryGrant
    const discoverySubject = {
      ...projectedDiscovery.subject,
      assetId: binding.assetId,
      prdRevision: binding.prdRevision,
    }
    const discoveryResult = await handleSuccess(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-FORMAL-DISCOVERY'), command: 'open-approval',
      projectRoot: fixture.roots.project,
      payload: { runId, approvalType: 'discovery', grantSubject: discoverySubject },
    }))
    const discoveryGrant = SignedGrantSchema.parse(discoveryResult.signedGrant) as SignedDiscoveryGrant
    await expect(authority.verify(discoveryGrant)).resolves.toMatchObject({ allowed: true })
    const capability = discoveryGrant.capabilities[0]!
    const reservation = await authority.reserveForSubject({
      grant: discoveryGrant, currentSubject: discoverySubject,
      capabilityId: capability.capabilityId, actionId: capability.actionId,
      attemptId: 'ATTEMPT-FORMAL-PREFLIGHT',
    })
    formalPreflightDigest = await authority.completeDiscoveryPreflight({
      grant: discoveryGrant, currentSubject: discoverySubject,
      reservationId: reservation.reservationId, capabilityId: capability.capabilityId,
      outcome: { status: 'ready', observedIdentity: {
        url: discoverySubject.expectedPageIdentity.url,
        title: discoverySubject.expectedPageIdentity.title,
        headings: [discoverySubject.expectedPageIdentity.heading], role: discoverySubject.actor,
      } },
    })
    await handleSuccess(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-FORMAL-PREFLIGHT'), command: 'run-preflight',
      projectRoot: fixture.roots.project, payload: { runId },
    }))

    const actionMap = rebindArtifact(projected.frozenArtifacts['browser-action-map'], binding)
    const testCases = rebindArtifact(projected.frozenArtifacts['test-cases'], binding)
    const executionContract = rebindArtifact(projected.frozenArtifacts['execution-contract'], binding)
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-ACTION-MAP', projectRoot: fixture.roots.project,
      runId, expectedState: 'preflight-readonly', artifactType: 'browser-action-map', candidate: actionMap,
    }))
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-CASES', projectRoot: fixture.roots.project,
      runId, expectedState: 'binding-draft', artifactType: 'test-cases', candidate: testCases,
    }))
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-CONTRACT', projectRoot: fixture.roots.project,
      runId, expectedState: 'binding-draft', artifactType: 'execution-contract', candidate: executionContract,
    }))
    const bindingSnapshot = await fixture.store.getRun(
      created.projectIdentityDigest as string, runId,
    )
    const projectedExecutionGrant = SignedGrantSchema.parse(projected.grant) as any
    const runBundleProjection: Record<string, unknown> = {
      runId,
      schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
      attemptPlans: [{ caseId: 'CASE-1', slots: 1 }],
      signedCapabilities: projectedExecutionGrant.capabilities.map((capability: any) => ({
        capabilityId: capability.capabilityId,
        actionId: capability.actionId,
        operation: capability.operation,
        effect: capability.effect,
        maxUses: capability.maxUses,
        digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
      })),
      secretRefs: [],
      runtimeIsolationPolicyDigest: 'not-applicable',
    }
    runBundleProjection.allInputRefs = [
      'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
      'test-cases', 'execution-contract', 'browser-action-map',
    ].map((artifactType) => {
      const artifact = bindingSnapshot?.frozenArtifacts[artifactType]
      if (artifact === undefined) throw new Error(`missing ${artifactType}`)
      return {
        artifactId: artifact.artifactId,
        digest: digestApprovalProjection(
          artifactType as Parameters<typeof digestApprovalProjection>[0], artifact.content,
        ),
      }
    })
    runBundleProjection.runtimePolicyDigest = ((bindingSnapshot?.frozenArtifacts['project-policy']
      ?.content as { runtimePolicy: { digest: string } }).runtimePolicy.digest)
    const readSubject = {
      ...structuredClone(projected.currentSubject),
      assetId: binding.assetId, prdRevision: binding.prdRevision,
      caseDigest: digestApprovalProjection('test-cases', testCases.content),
      actionMapDigest: digestApprovalProjection('browser-action-map', actionMap.content),
      executionContractDigest: digestApprovalProjection('execution-contract', executionContract.content),
      runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundleProjection),
      discoveryGrantId: discoveryGrant.grantId, preflightDigest: formalPreflightDigest,
    }
    const semanticConfirmation = await handleSuccess(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-FORMAL-EXECUTION'), command: 'open-approval',
      projectRoot: fixture.roots.project,
      payload: { runId, approvalType: 'execution', grantSubject: readSubject },
    }))
    expect(semanticConfirmation).toMatchObject({
      status: 'confirmation-required', approvalMode: 'webauthn',
      summary: { semanticReview: { prd: { normalizedText: expect.any(String) } } },
    })
    const executionResult = await handleSuccess(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-FORMAL-EXECUTION-CONFIRM'), command: 'confirm-approval',
      projectRoot: fixture.roots.project,
      payload: { runId, confirmationId: semanticConfirmation.confirmationId,
        subjectDigest: semanticConfirmation.subjectDigest },
    }))
    await expect(authority.verify(SignedGrantSchema.parse(executionResult.signedGrant)))
      .resolves.toMatchObject({ allowed: true })
    const executionApproved = await fixture.store.getRun(
      created.projectIdentityDigest as string, runId,
    )
    const approvedGrant = SignedGrantSchema.parse(executionResult.signedGrant)
    expect(executionApproved?.frozenArtifacts['run-bundle']).toBeDefined()
    expect(((executionApproved?.frozenArtifacts['browser-action-map']?.content as {
      actions: Array<{ capabilities: Array<{ capabilityId: string }> }>
    }).actions[0]?.capabilities[0]?.capabilityId)).toBe(approvedGrant.capabilities[0]?.capabilityId)
    expect(digestApprovalProjection(
      'run-bundle', executionApproved?.frozenArtifacts['run-bundle']?.content,
    )).toBe((approvedGrant.subject as { runBundleProjectionDigest: string }).runBundleProjectionDigest)
    const regression = regressionManifestCandidate(binding)
    await handleSuccess(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-FORMAL-REGRESSION', projectRoot: fixture.roots.project,
      runId, expectedState: 'execution-approved', artifactType: 'regression-manifest', candidate: regression,
    }))
    const executed = await handleSuccess(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-FORMAL-EXECUTE'), command: 'execute-run',
      projectRoot: fixture.roots.project, payload: { runId },
    }))
    expect(executed).toMatchObject({ status: 'passed', workflow: { current: 'diagnosing' } })
    const persisted = await fixture.store.getRun(created.projectIdentityDigest as string, runId)
    expect(persisted?.executionResults?.readEnvironment?.['ACTION-1']).toMatchObject({
      caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed',
      gatewayAuditDigest: digest('d'),
    })
    await fixture.store.close()
    authority.close()
  })

  test('rejects caller state jumps, candidate rebinding, and false content digests without mutating state', async () => {
    const fixture = await hostFixture()
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-1', fixture.roots.project),
    ))
    const candidate = prdRequestCandidate({
      assetId: created.assetId as string,
      generationId: created.generationId as string,
      prdRevision: created.prdRevision as string,
    })

    const stateJump = await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-JUMP', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'accepted', candidate,
    }))
    expect(stateJump).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH' } })

    const reboundCandidate = { ...candidate, assetId: 'OTHER-ASSET' }
    reboundCandidate.contentDigest = digestArtifactContent(
      `artifact-content/${reboundCandidate.schemaVersion}/${reboundCandidate.artifactType}`,
      reboundCandidate,
    )
    const rebound = await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-REBIND', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate: reboundCandidate,
    }))
    expect(rebound).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_CANDIDATE_BINDING_MISMATCH' } })

    const falseDigest = await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-DIGEST', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created',
      candidate: { ...candidate, contentDigest: digest('f') },
    }))
    expect(falseDigest).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_CANDIDATE_DIGEST_MISMATCH' } })
    const reboundAfterError = await handleRequest(fixture.host, submitCandidateRequest({
      requestId: 'REQUEST-SUBMIT-DIGEST', projectRoot: fixture.roots.project,
      runId: created.runId as string, expectedState: 'created', candidate,
    }))
    expect(reboundAfterError).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })

    const status = successResult(await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-STATUS-1', fixture.roots.project, created.runId as string,
    )))
    expect(status.workflow).toMatchObject({ current: 'created', sequence: 0 })
    await fixture.store.close()
  })

  test('returns the strict doctor report through the host envelope', async () => {
    const fixture = await hostFixture()
    const response = await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-DOCTOR-1',
      client: { name: 'test-client', version: '1.0.0' }, command: 'doctor', payload: {},
    }))

    expect(successResult(response)).toMatchObject({ ready: true, runtimeVersion: '0.0.0' })
    await fixture.store.close()
  })

  test('execute-run 先持久化并释放 Run 锁，再以 fenced attempt 执行并落入 diagnosing', async () => {
    let lockWasReleased = false
    let activeResume: RuntimeResponseEnvelope | undefined
    const quarantineEvidence = vi.fn(async (input: {
      runId: string; attemptId: string; evidence: { screenshot: Uint8Array; dom: Uint8Array }
    }) => ({
      schemaVersion: '1.0.0' as const, runId: input.runId, attemptId: input.attemptId,
      records: [
        { evidenceType: 'screenshot' as const, quarantinePath: `raw/${input.attemptId}/screenshot.bin`,
          plaintextDigest: digestBytes('quarantine-plaintext/v1', input.evidence.screenshot), byteLength: 2 },
        { evidenceType: 'dom' as const, quarantinePath: `raw/${input.attemptId}/dom.bin`,
          plaintextDigest: digestBytes('quarantine-plaintext/v1', input.evidence.dom), byteLength: 2 },
      ],
    }))
    const fixture = await hostFixture({
      quarantineEvidence,
      executeReadOnlyRun: async ({ snapshot }) => {
        const concurrent = await fixture.store.acquireRunLock(snapshot.projectIdentityDigest, snapshot.runId)
        lockWasReleased = true
        await concurrent.close()
        const running = await fixture.store.getRun(snapshot.projectIdentityDigest, snapshot.runId)
        activeResume = await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
          ...requestHeader('REQUEST-RESUME-ACTIVE'), command: 'resume-run',
          projectRoot: fixture.roots.project,
          payload: { runId: snapshot.runId, decision: {
            kind: 'reconcile-stale-read', expectedAttemptId: running!.executionAttempt!.attemptId,
          } },
        }))
        return {
        status: 'passed', result: {
          caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed', expected: [], actual: [],
          evidence: [
            { kind: 'screenshot', byteLength: 2,
              digest: digestBytes('runtime-evidence/screenshot/v1', new Uint8Array([1, 2])) },
            { kind: 'dom', byteLength: 2,
              digest: digestText('runtime-evidence/dom/v1', Buffer.from([3, 4]).toString('utf8')) },
            { kind: 'gateway-audit', byteLength: Buffer.byteLength(canonicalizeJson({
              received: 1, forwarded: 1, blocked: 0, byIntent: {},
            }), 'utf8'), digest: digestText('runtime-evidence/gateway-audit/v1', canonicalizeJson({
              received: 1, forwarded: 1, blocked: 0, byIntent: {},
            })) },
          ],
        }, gatewayAudit: { received: 1, forwarded: 1, blocked: 0, byIntent: {} },
        gatewayAuditDigest: digest('d'),
        evidence: { screenshot: new Uint8Array([1, 2]), dom: new Uint8Array([3, 4]) },
      }
      },
    })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-EXECUTE', fixture.roots.project),
    ))
    await fixture.store.beginRequest('SEED-EXECUTION-APPROVED', digest('7'))
    const lock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string, created.runId as string,
    )
    const projected = projectionFixture()
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-EXECUTION-APPROVED', digest('7'),
      (snapshot) => ({
        snapshot: { ...snapshot,
          artifactDigests: {
            ...snapshot.artifactDigests,
            ...Object.fromEntries(Object.entries(projected.frozenArtifacts)
              .map(([key, artifact]) => [key, artifact.contentDigest])),
          },
          frozenArtifacts: projected.frozenArtifacts,
          trustedExecutionFacts: executionFactsFor(projected, snapshot),
          workflow: {
          current: 'compiled', sequence: 9, eventChainDigest: digest('8'),
        } },
        response: { seeded: true },
      }),
      'test-seed-execution-approved', lock,
    )
    await lock.close()
    const request = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-1'), command: 'execute-run', projectRoot: fixture.roots.project,
      payload: { runId: created.runId },
    })
    const requestBytes = JSON.stringify(request)
    await expect(fixture.store.beginRequest(
      request.requestId, digestBytes('e2e-runtime-request-bytes/v1', Buffer.from(requestBytes)),
    )).resolves.toEqual({ kind: 'reserved' })
    const result = successResult(await handleRequest(fixture.host, request, requestBytes))
    expect(lockWasReleased).toBe(true)
    expect(activeResume).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_EXECUTION_OWNER_ACTIVE' },
    })
    expect(result).toMatchObject({
      status: 'passed', result: { caseId: 'CASE-1' }, loadedGeneratedSourceFiles: [],
      workflow: { current: 'diagnosing' },
      evidence: {
        screenshot: { byteLength: 2, digest: expect.stringMatching(/^sha256:/) },
        dom: { byteLength: 2, digest: expect.stringMatching(/^sha256:/) },
      },
    })
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(persisted).toMatchObject({ workflow: { current: 'diagnosing' } })
    expect(quarantineEvidence).toHaveBeenCalledOnce()
    expect(persisted?.trustedExecutionFacts['quarantined-evidence']).toMatchObject({
      runId: created.runId, records: [{ evidenceType: 'screenshot' }, { evidenceType: 'dom' }],
    })
    expect(persisted?.executionAttempt).toBeUndefined()
    await fixture.store.close()
  })

  test('execute-run 通过正式 Host 持久串行调度三个 full-playwright Case', async () => {
    const calls: Array<{ caseId: string; attemptId: string }> = []
    const fixture = await hostFixture({
      executeFullPlaywrightRun: async ({ snapshot, attemptId, projection }) => {
        calls.push({ caseId: projection.caseId, attemptId })
        expect(snapshot.writeAttempts?.[attemptId]).toMatchObject({
          state: 'prepared',
          actionId: projection.actionId,
          executionFencingToken: snapshot.executionAttempt?.fencingToken,
        })
        return {
          ...runtimeFullPlaywrightOutput(projection.caseId, projection.actionId),
          finalizationFacts: {
            gatewayAudit: { caseId: projection.caseId },
            cleanup: { caseId: projection.caseId },
            executionOutcomeReceipt: { caseId: projection.caseId },
            executionOutcomeVerifierMaterial: { caseId: projection.caseId },
            gatewayAuditVerifierMaterial: { caseId: projection.caseId },
            browserMeasurements: { caseId: projection.caseId },
            isolationMeasurements: { caseId: projection.caseId },
          },
        }
      },
    })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-MULTI-FULL', fixture.roots.project),
    ))
    const projected = multiCaseFixture()
    const grant = structuredClone(
      projected.trustedExecutionFacts['signed-execution-grant'],
    ) as SignedGrant
    grant.approvalContext.runId = created.runId as string
    grant.approvalContext.installationDigest = installation.installationDigest
    const plan = compiledPlanForMultiCase(projected)
    await fixture.store.beginRequest('SEED-MULTI-FULL', digest('7'))
    const lock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string,
      created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string,
      created.runId as string,
      'SEED-MULTI-FULL',
      digest('7'),
      (snapshot) => ({
        snapshot: {
          ...snapshot,
          artifactDigests: {
            ...snapshot.artifactDigests,
            ...Object.fromEntries(Object.entries(projected.frozenArtifacts)
              .map(([key, artifact]) => [key, artifact.contentDigest])),
          },
          frozenArtifacts: projected.frozenArtifacts,
          trustedExecutionFacts: {
            ...snapshot.trustedExecutionFacts,
            ...projected.trustedExecutionFacts,
            'signed-execution-grant': grant,
          },
          compiledPrdRun: plan,
          caseSchedule: createCaseSchedule(plan, '2026-07-17T00:00:00.000Z'),
          workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('8') },
        },
        response: { seeded: true },
      }),
      'test-seed-multi-full',
      lock,
    )
    await lock.close()

    const result = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-MULTI-FULL'),
      command: 'execute-run',
      projectRoot: fixture.roots.project,
      payload: { runId: created.runId },
    })))

    expect(result).toMatchObject({
      status: 'passed',
      cases: [
        { caseId: 'CASE-1', status: 'passed' },
        { caseId: 'CASE-2', status: 'passed' },
        { caseId: 'CASE-3', status: 'passed' },
      ],
      schedule: {
        status: 'terminal',
        cases: [{ state: 'passed' }, { state: 'passed' }, { state: 'passed' }],
      },
      workflow: { current: 'diagnosing' },
    })
    expect(calls.map((item) => item.caseId)).toEqual(['CASE-1', 'CASE-2', 'CASE-3'])
    expect(new Set(calls.map((item) => item.attemptId)).size).toBe(3)
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string,
      created.runId as string,
    )
    expect(persisted?.caseSchedule?.cases.map((item) => item.state))
      .toEqual(['passed', 'passed', 'passed'])
    expect(Object.keys(persisted?.executionResults?.realEnvironment ?? {})).toEqual([
      'ACTION-1', 'ACTION-2', 'ACTION-3',
    ])
    const finalizationFacts = persisted?.trustedExecutionFacts[
      'finalization-execution-facts'
    ] as { realEnvironment?: Record<string, unknown> } | undefined
    expect(Object.keys(finalizationFacts?.realEnvironment ?? {})).toEqual([
      deriveExecutionResultId('CASE-1', 'real-environment'),
      deriveExecutionResultId('CASE-2', 'real-environment'),
      deriveExecutionResultId('CASE-3', 'real-environment'),
    ])
    expect(Object.values(persisted?.writeAttempts ?? {}).every(
      (attempt) => attempt.state === 'outcome-committed',
    )).toBe(true)
    await fixture.store.close()
  })

  test('resume-run 从第二个 running Case 恢复且不重放已完成 Case', async () => {
    const calls: string[] = []
    let crashed = false
    const recover = vi.fn(async () => ({
      status: 'recovered' as const, writeState: 'prepared' as const,
      next: 'resume-full-playwright', browserCalls: 0 as const,
    }))
    const fixture = await hostFixture({
      writeRecovery: { recover },
      executeFullPlaywrightRun: async ({ projection }) => {
        calls.push(projection.caseId)
        if (projection.caseId === 'CASE-2' && !crashed) {
          crashed = true
          throw Object.assign(new Error('simulated crash'), { code: 'E2E_RUNTIME_BROWSER_TEST_CRASH' })
        }
        return runtimeFullPlaywrightOutput(projection.caseId, projection.actionId)
      },
    })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-MULTI-RESUME', fixture.roots.project),
    ))
    const projected = multiCaseFixture()
    const grant = structuredClone(
      projected.trustedExecutionFacts['signed-execution-grant'],
    ) as SignedGrant
    grant.approvalContext.runId = created.runId as string
    grant.approvalContext.installationDigest = installation.installationDigest
    const plan = compiledPlanForMultiCase(projected)
    await fixture.store.beginRequest('SEED-MULTI-RESUME', digest('a'))
    const seedLock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string,
      created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string,
      created.runId as string,
      'SEED-MULTI-RESUME',
      digest('a'),
      (snapshot) => ({
        snapshot: {
          ...snapshot,
          artifactDigests: {
            ...snapshot.artifactDigests,
            ...Object.fromEntries(Object.entries(projected.frozenArtifacts)
              .map(([key, artifact]) => [key, artifact.contentDigest])),
          },
          frozenArtifacts: projected.frozenArtifacts,
          trustedExecutionFacts: {
            ...snapshot.trustedExecutionFacts,
            ...projected.trustedExecutionFacts,
            'signed-execution-grant': grant,
          },
          compiledPrdRun: plan,
          caseSchedule: createCaseSchedule(plan, '2026-07-17T00:00:00.000Z'),
          workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('b') },
        },
        response: { seeded: true },
      }),
      'test-seed-multi-resume',
      seedLock,
    )
    await seedLock.close()
    const execute = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-MULTI-RESUME'),
      command: 'execute-run',
      projectRoot: fixture.roots.project,
      payload: { runId: created.runId },
    })
    expect(await handleRequest(fixture.host, execute)).toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED' },
    })
    const interrupted = await fixture.store.getRun(
      created.projectIdentityDigest as string,
      created.runId as string,
    )
    expect(interrupted?.caseSchedule?.cases.map((item) => item.state))
      .toEqual(['passed', 'running', 'pending'])
    const interruptedAttemptId = interrupted?.caseSchedule?.cases[1]?.attemptId
    expect(interruptedAttemptId).toMatch(/^ATTEMPT-/)

    const resumed = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-RESUME-MULTI'),
      command: 'resume-run',
      projectRoot: fixture.roots.project,
      payload: {
        runId: created.runId,
        decision: { kind: 'recover-write-attempt', expectedAttemptId: interruptedAttemptId },
      },
    })))
    expect(resumed).toMatchObject({
      recoveredAttemptId: interruptedAttemptId,
      status: 'passed',
      schedule: {
        status: 'terminal',
        cases: [{ state: 'passed' }, { state: 'passed' }, { state: 'passed' }],
      },
    })
    expect(calls).toEqual(['CASE-1', 'CASE-2', 'CASE-2', 'CASE-3'])
    expect(recover).toHaveBeenCalledWith({
      projectIdentityDigest: created.projectIdentityDigest,
      runId: created.runId,
      attemptId: interruptedAttemptId,
    })
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string,
      created.runId as string,
    )
    expect(persisted?.executionAttempt).toBeUndefined()
    expect(Object.keys(persisted?.executionResults?.realEnvironment ?? {})).toEqual([
      'ACTION-1', 'ACTION-2', 'ACTION-3',
    ])
    await fixture.store.close()
  })

  test.each(['write', 'injection'] as const)(
    'execute-run 通过 Host 调用可信 %s executor，并在同一 fenced attempt 内持久化分域结果',
    async (mode) => {
      const fixture = await hostFixture(mode === 'write' ? {
        executeWriteRun: async ({ snapshot, attemptId, actionId }) => {
          expect(snapshot?.workflow.current).toBe('running-real')
          expect(attemptId).toMatch(/^ATTEMPT-/)
          expect(snapshot?.writeAttempts?.[attemptId]).toMatchObject({
            state: 'prepared', actionId, executionFencingToken: snapshot?.executionAttempt?.fencingToken,
          })
          return realWriteOutput({ actionId }) as never
        },
      } : {
        executeInjectionRun: async ({ snapshot, actionId }) => {
          expect(snapshot?.workflow.current).toBe('running-real')
          return injectionOutput({ actionId, finalizationFacts: {
            executionGrant: executionGrantForMode('injection', snapshot!.runId),
            gatewayAudit: { signed: true }, gatewayAuditVerifierMaterial: { keyId: 'INJECTION-KEY' },
            browserMeasurements: { browserMeasurementDigest: digest('1') },
            isolationMeasurements: { gatewaySessionMeasurementDigest: digest('2') },
          } }) as never
        },
      })
      const created = successResult(await handleRequest(fixture.host,
        createRunRequest(`REQUEST-CREATE-${mode}`, fixture.roots.project)))
      const projected = projectionFixture()
      const frozenArtifacts = structuredClone(projected.frozenArtifacts)
      const action = ((frozenArtifacts['browser-action-map'].content as Record<string, unknown>)
        .actions as Array<Record<string, unknown>>)[0]!
      if (mode === 'write') action.effect = 'reversible-write'
      const facts = executionFactsFor(projected, {
        runId: created.runId as string, runtimeInstallationDigest: installation.installationDigest,
      })
      facts['signed-execution-grant'] = executionGrantForMode(mode, created.runId as string)
      await fixture.store.beginRequest(`SEED-${mode}`, digest('7'))
      const lock = await fixture.store.acquireRunLock(created.projectIdentityDigest as string, created.runId as string)
      await fixture.store.updateRunOutcome(created.projectIdentityDigest as string, created.runId as string,
        `SEED-${mode}`, digest('7'), (snapshot) => ({
          snapshot: { ...snapshot, frozenArtifacts,
            artifactDigests: {
              ...snapshot.artifactDigests,
              ...Object.fromEntries(Object.entries(frozenArtifacts)
                .map(([key, artifact]) => [key, artifact.contentDigest])),
            },
            trustedExecutionFacts: facts,
            ...(mode !== 'injection' ? {} : {
              executionResults: {
                readEnvironment: {},
                realEnvironment: { 'ACTION-1': realWriteOutput({ actionId: 'ACTION-1' }) },
                gatewayInjection: {},
              },
            }),
            workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('8') } },
          response: { seeded: true },
        }), `seed-${mode}`, lock)
      await lock.close()

      const response = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
        ...requestHeader(`REQUEST-EXECUTE-${mode}`), command: 'execute-run', projectRoot: fixture.roots.project,
        payload: { runId: created.runId },
      })))
      expect(response).toMatchObject({ status: 'passed', loadedGeneratedSourceFiles: [],
        workflow: { current: 'diagnosing' } })
      expect((response.result as Record<string, unknown>).actionId).toBe('ACTION-1')
      const persisted = await fixture.store.getRun(created.projectIdentityDigest as string, created.runId as string)
      expect(persisted).toMatchObject({ workflow: { current: 'diagnosing' } })
      expect(persisted?.executionAttempt).toBeUndefined()
      if (mode === 'write') expect(Object.values(persisted?.writeAttempts ?? {})).toMatchObject([
        { state: 'outcome-committed', actionId: 'ACTION-1',
          reservation: { reservationId: 'RESERVATION-WRITE-1' },
          outcome: { outcomeDigest: runtimeWriteDigest('outcome-receipt'),
            receiptDigest: runtimeWriteDigest('reservation-receipt') } },
      ])
      if (mode === 'injection') {
        const facts = persisted?.trustedExecutionFacts['finalization-execution-facts'] as any
        expect(facts).toMatchObject({ schemaVersion: '2.0.0', gatewayInjection: {
          [injectionOutput().resultId]: { gatewayAudit: { signed: true } },
        } })
        expect(persisted?.executionResults?.gatewayInjection['ACTION-1']).not.toHaveProperty('evidence')
      }
      await fixture.store.close()
    },
  )

  test('write 原始证据必须先进入 Quarantine，Run Store 只持久化去除 bytes 的结果', async () => {
    const quarantineEvidence = vi.fn(async (input: {
      runId: string; attemptId: string; evidence: { screenshot: Uint8Array; dom: Uint8Array }
    }) => ({
      schemaVersion: '1.0.0' as const, runId: input.runId, attemptId: input.attemptId,
      records: [
        { evidenceType: 'screenshot' as const, quarantinePath: `raw/${input.attemptId}/screenshot.bin`,
          plaintextDigest: digestBytes('quarantine-plaintext/v1', input.evidence.screenshot),
          byteLength: input.evidence.screenshot.byteLength },
        { evidenceType: 'dom' as const, quarantinePath: `raw/${input.attemptId}/dom.bin`,
          plaintextDigest: digestBytes('quarantine-plaintext/v1', input.evidence.dom),
          byteLength: input.evidence.dom.byteLength },
      ],
    }))
    const fixture = await hostFixture({
      quarantineEvidence,
      executeWriteRun: async ({ actionId }) => realWriteOutput({
        actionId,
        evidence: { screenshot: Uint8Array.from([1, 2]), dom: Uint8Array.from([3, 4]) },
      }) as never,
    })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-WRITE-EVIDENCE', fixture.roots.project)))
    const projected = projectionFixture()
    const frozenArtifacts = structuredClone(projected.frozenArtifacts)
    const action = ((frozenArtifacts['browser-action-map'].content as Record<string, unknown>)
      .actions as Array<Record<string, unknown>>)[0]!
    action.effect = 'reversible-write'
    const facts = executionFactsFor(projected, {
      runId: created.runId as string, runtimeInstallationDigest: installation.installationDigest,
    })
    facts['signed-execution-grant'] = executionGrantForMode('write', created.runId as string)
    await fixture.store.beginRequest('SEED-WRITE-EVIDENCE', digest('7'))
    const lock = await fixture.store.acquireRunLock(created.projectIdentityDigest as string, created.runId as string)
    await fixture.store.updateRunOutcome(created.projectIdentityDigest as string, created.runId as string,
      'SEED-WRITE-EVIDENCE', digest('7'), (snapshot) => ({ snapshot: {
        ...snapshot, frozenArtifacts,
        artifactDigests: { ...snapshot.artifactDigests, ...Object.fromEntries(
          Object.entries(frozenArtifacts).map(([key, artifact]) => [key, artifact.contentDigest])) },
        trustedExecutionFacts: facts,
        workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('8') },
      }, response: { seeded: true } }), 'seed-write-evidence', lock)
    await lock.close()

    await expect(handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-WRITE-EVIDENCE'), command: 'execute-run',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    }))).resolves.toMatchObject({ ok: true })
    expect(quarantineEvidence).toHaveBeenCalledOnce()
    const persisted = await fixture.store.getRun(created.projectIdentityDigest as string, created.runId as string)
    expect(persisted?.trustedExecutionFacts['quarantined-evidence']).toMatchObject({
      runId: created.runId, records: [{ evidenceType: 'screenshot' }, { evidenceType: 'dom' }],
    })
    expect(persisted?.executionResults?.realEnvironment['ACTION-1']).not.toHaveProperty('evidence')
    await fixture.store.close()
  })

  test('run-preflight 只接受 branded 内部执行器并持久化完整 provenance fact', async () => {
    const fixture = await hostFixture({ preflight: async ({ snapshot }) => ({
      status: 'ready', reservationId: 'RESERVATION-1', preflightDigest: digest('1'),
      observedIdentity: { url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'auditor' },
      browserMeasurement: {
        browserMeasurementDigest: digest('2'), browserClosureDigest: digest('3'),
        browserExecutableDigest: digest('4'), gatewaySessionMeasurementDigest: digest('5'),
        canaryProofDigest: digest('6'),
      },
      gatewayPolicyDigest: digest('7'), authorityOutcomeDigest: digest('8'),
      authorityReceiptDigest: digest('a'), gatewayAuditDigest: digest('d'),
    }) })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-PREFLIGHT', fixture.roots.project),
    ))
    const projected = projectionFixture()
    await fixture.store.beginRequest('SEED-DISCOVERY', digest('b'))
    const lock = await fixture.store.acquireRunLock(created.projectIdentityDigest as string, created.runId as string)
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string, 'SEED-DISCOVERY', digest('b'),
      (snapshot) => ({ snapshot: {
        ...snapshot,
        trustedExecutionFacts: {
          'signed-discovery-grant': executionFactsFor(projected, snapshot)['signed-discovery-grant'],
        },
        workflow: { current: 'discovery-approved', sequence: 5, eventChainDigest: digest('c') },
      }, response: { seeded: true } }),
      'test-seed-discovery', lock,
    )
    await lock.close()

    const result = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREFLIGHT-1'), command: 'run-preflight', projectRoot: fixture.roots.project,
      payload: { runId: created.runId },
    })))
    expect(result).toMatchObject({
      status: 'ready', workflow: { current: 'preflight-readonly' },
      preflightFact: {
        runId: created.runId, discoveryGrantId: 'DISCOVERY-1', reservationId: 'RESERVATION-1',
        status: 'ready', browserMeasurementDigest: digest('2'), gatewayPolicyDigest: digest('7'),
      },
    })
    const persisted = await fixture.store.getRun(created.projectIdentityDigest as string, created.runId as string)
    expect(persisted?.trustedExecutionFacts['browser-preflight']).toEqual(result.preflightFact)
    await fixture.store.close()
  })

  test('环境预检阻断保留原 Run，修复后可以在同一 Run 重试', async () => {
    let attempts = 0
    const fixture = await hostFixture({ preflight: async () => {
      attempts += 1
      if (attempts === 1) return {
        status: 'environment-blocked' as const,
        reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
        observedIdentity: {
          url: 'http://localhost:3000/loading', title: '加载中', headings: [], role: 'auditor',
        },
      }
      return {
        status: 'ready' as const, reservationId: 'RESERVATION-RETRY', preflightDigest: digest('1'),
        observedIdentity: {
          url: 'http://localhost:3000/orders', title: '订单', headings: ['订单列表'], role: 'auditor',
        },
        browserMeasurement: {
          browserMeasurementDigest: digest('2'), browserClosureDigest: digest('3'),
          browserExecutableDigest: digest('4'), gatewaySessionMeasurementDigest: digest('5'),
          canaryProofDigest: digest('6'),
        },
        gatewayPolicyDigest: digest('7'), authorityOutcomeDigest: digest('8'),
        authorityReceiptDigest: digest('a'), gatewayAuditDigest: digest('d'),
      }
    } })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-PREFLIGHT-RETRY', fixture.roots.project),
    ))
    const projected = projectionFixture()
    await fixture.store.beginRequest('SEED-DISCOVERY-RETRY', digest('b'))
    const lock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string, created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-DISCOVERY-RETRY', digest('b'),
      (snapshot) => ({ snapshot: {
        ...snapshot,
        trustedExecutionFacts: {
          'signed-discovery-grant': executionFactsFor(projected, snapshot)['signed-discovery-grant'],
        },
        workflow: { current: 'discovery-approved', sequence: 5, eventChainDigest: digest('c') },
      }, response: { seeded: true } }),
      'test-seed-discovery-retry', lock,
    )
    await lock.close()

    const first = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREFLIGHT-BLOCKED'), command: 'run-preflight',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })))
    expect(first).toMatchObject({
      runId: created.runId, status: 'environment-blocked',
      reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', workflow: { current: 'preflight-readonly' },
    })
    const blocked = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(blocked).toMatchObject({
      workflow: { current: 'preflight-readonly' },
      preflightBlocker: {
        status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', attemptCount: 1,
        resumeState: 'preflight-readonly',
      },
    })
    const status = successResult(await handleRequest(fixture.host, getStatusRequest(
      'REQUEST-STATUS-PREFLIGHT-RETRY', fixture.roots.project, created.runId as string,
    )))
    expect(status).toMatchObject({
      state: 'preflight-readonly',
      nextEdge: { command: 'run-preflight', from: 'preflight-readonly' },
      minimumMissingInput: ['browser-preflight-retry:E2E_RUNTIME_PAGE_MISMATCH'],
    })

    const recovered = successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREFLIGHT-RETRY'), command: 'run-preflight',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })))
    expect(recovered).toMatchObject({
      runId: created.runId, status: 'ready', workflow: { current: 'preflight-readonly' },
      preflightFact: { reservationId: 'RESERVATION-RETRY' },
    })
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(persisted).not.toHaveProperty('preflightBlocker')
    expect(persisted?.trustedExecutionFacts['browser-preflight']).toEqual(recovered.preflightFact)
    expect(attempts).toBe(2)
    await fixture.store.close()
  })

  test('Authority complete 成功但 fact 落盘失败时从持久 preparation 恢复且不重复浏览器动作', async () => {
    let browserPreparations = 0
    let authorityCompletions = 0
    const stagedPreflight: Parameters<typeof authorizeRuntimePreflight>[0] = {
      prepare: async () => {
        browserPreparations += 1
        return {
          capabilityId: 'CAP-PREFLIGHT-1',
          output: {
            status: 'ready', reservationId: 'RESERVATION-PREFLIGHT-RECOVERY',
            observedIdentity: {
              url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'auditor',
            },
            browserMeasurement: {
              browserMeasurementDigest: digest('2'), browserClosureDigest: digest('3'),
              browserExecutableDigest: digest('4'), gatewaySessionMeasurementDigest: digest('5'),
              canaryProofDigest: digest('6'),
            },
            gatewayPolicyDigest: digest('7'), gatewayAuditDigest: digest('d'),
          },
        }
      },
      finalize: async ({ preparation }) => {
        authorityCompletions += 1
        return {
          ...preparation.output,
          status: 'ready' as const,
          preflightDigest: digest('1'), authorityOutcomeDigest: digest('8'),
          authorityReceiptDigest: digest('a'),
        }
      },
    }
    const fixture = await hostFixture({ preflight: stagedPreflight })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-PREFLIGHT-RECOVERY', fixture.roots.project),
    ))
    const projected = projectionFixture()
    await fixture.store.beginRequest('SEED-PREFLIGHT-RECOVERY', digest('b'))
    const seedLock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string, created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-PREFLIGHT-RECOVERY', digest('b'),
      (snapshot) => ({ snapshot: {
        ...snapshot,
        trustedExecutionFacts: {
          'signed-discovery-grant': executionFactsFor(projected, snapshot)['signed-discovery-grant'],
        },
        workflow: { current: 'discovery-approved', sequence: 5, eventChainDigest: digest('c') },
      }, response: { seeded: true } }),
      'test-seed-preflight-recovery', seedLock,
    )
    await seedLock.close()

    const writeFact = fixture.store.writeTrustedFactOutcome.bind(fixture.store)
    let failFactPersistence = true
    fixture.store.writeTrustedFactOutcome = (async (...args: Parameters<typeof writeFact>) => {
      if (failFactPersistence) {
        failFactPersistence = false
        throw new Error('injected post-authority fact persistence failure')
      }
      return await writeFact(...args)
    }) as typeof fixture.store.writeTrustedFactOutcome
    const request = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREFLIGHT-RECOVERY'), command: 'run-preflight',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })
    await expect(handleRequest(fixture.host, request)).resolves.toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED' },
    })
    expect(browserPreparations).toBe(1)
    expect(authorityCompletions).toBe(1)
    await expect(fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )).resolves.toMatchObject({
      workflow: { current: 'discovery-approved' },
      preflightAttempt: { requestId: request.requestId, preparation: {
        output: { reservationId: 'RESERVATION-PREFLIGHT-RECOVERY' },
      } },
    })

    const recovered = successResult(await handleRequest(fixture.host, request))
    expect(recovered).toMatchObject({ status: 'ready', workflow: { current: 'preflight-readonly' } })
    expect(browserPreparations).toBe(1)
    expect(authorityCompletions).toBe(2)
    const persisted = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(persisted?.preflightAttempt).toBeUndefined()
    expect(persisted?.trustedExecutionFacts['browser-preflight']).toEqual(recovered.preflightFact)
    await fixture.store.close()
  })

  test('reserve 成功但 preparation 落盘前崩溃时重建 Host 复用 reservation 且不增加 capability use', async () => {
    let capabilityUses = 0
    let browserPreparations = 0
    let reservedAttemptId: string | undefined
    const observedAttemptIds: string[] = []
    const stagedPreflight = (): Parameters<typeof authorizeRuntimePreflight>[0] => ({
      prepare: async ({ attemptId }) => {
        observedAttemptIds.push(attemptId)
        if (reservedAttemptId === undefined) {
          reservedAttemptId = attemptId
          capabilityUses += 1
        } else if (reservedAttemptId !== attemptId) {
          throw new Error('stable attemptId mismatch')
        }
        browserPreparations += 1
        return {
          capabilityId: 'CAP-PREFLIGHT-RESERVE-RECOVERY',
          output: {
            status: 'ready', reservationId: 'RESERVATION-STABLE',
            observedIdentity: {
              url: 'https://test.example.com/orders', title: '订单', headings: ['订单列表'], role: 'auditor',
            },
            browserMeasurement: {
              browserMeasurementDigest: digest('2'), browserClosureDigest: digest('3'),
              browserExecutableDigest: digest('4'), gatewaySessionMeasurementDigest: digest('5'),
              canaryProofDigest: digest('6'),
            },
            gatewayPolicyDigest: digest('7'), gatewayAuditDigest: digest('d'),
          },
        }
      },
      finalize: async ({ preparation }) => ({
        ...preparation.output, status: 'ready' as const,
        preflightDigest: digest('1'), authorityOutcomeDigest: digest('8'),
        authorityReceiptDigest: digest('a'),
      }),
    })
    const fixture = await hostFixture({ preflight: stagedPreflight() })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-RESERVE-RECOVERY', fixture.roots.project),
    ))
    const projected = projectionFixture()
    await fixture.store.beginRequest('SEED-RESERVE-RECOVERY', digest('b'))
    const seedLock = await fixture.store.acquireRunLock(
      created.projectIdentityDigest as string, created.runId as string,
    )
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-RESERVE-RECOVERY', digest('b'),
      (snapshot) => ({ snapshot: {
        ...snapshot,
        trustedExecutionFacts: {
          'signed-discovery-grant': executionFactsFor(projected, snapshot)['signed-discovery-grant'],
        },
        workflow: { current: 'discovery-approved', sequence: 5, eventChainDigest: digest('c') },
      }, response: { seeded: true } }),
      'test-seed-reserve-recovery', seedLock,
    )
    await seedLock.close()

    const recordPreparation = fixture.store.recordPreflightPreparation.bind(fixture.store)
    let failPreparationPersistence = true
    fixture.store.recordPreflightPreparation = (async (...args: Parameters<typeof recordPreparation>) => {
      if (failPreparationPersistence) {
        failPreparationPersistence = false
        throw new Error('injected kill after reserve before preparation record')
      }
      return await recordPreparation(...args)
    }) as typeof fixture.store.recordPreflightPreparation
    const request = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-PREFLIGHT-RESERVE-RECOVERY'), command: 'run-preflight',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })
    await expect(handleRequest(fixture.host, request)).resolves.toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED' },
    })
    expect(capabilityUses).toBe(1)
    expect(browserPreparations).toBe(1)
    await expect(fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )).resolves.not.toHaveProperty('preflightAttempt')

    const rebuiltHost = new E2ERuntimeHost({
      installation,
      doctor: async () => ({
        ready: true, runtimeVersion: installation.version,
        installationDigest: installation.installationDigest,
        browserSource: 'system-chrome', approvalMode: 'local-confirmation', probes: {},
      }),
      runStore: fixture.store,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
      preflightExecutor: authorizeRuntimePreflight(stagedPreflight()),
    })
    const recovered = successResult(await handleRequest(rebuiltHost, request))
    expect(recovered).toMatchObject({ status: 'ready', workflow: { current: 'preflight-readonly' } })
    expect(capabilityUses).toBe(1)
    expect(browserPreparations).toBe(2)
    expect(observedAttemptIds).toHaveLength(2)
    expect(observedAttemptIds[1]).toBe(observedAttemptIds[0])
    expect(observedAttemptIds[0]).toMatch(/^PREFLIGHT-[a-f0-9]{64}$/)
    await expect(fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )).resolves.toMatchObject({
      workflow: { current: 'preflight-readonly' },
      trustedExecutionFacts: { 'browser-preflight': {
        reservationId: 'RESERVATION-STABLE',
      } },
    })
    await fixture.store.close()
  })

  test('attempt 已提交但 mutation lease 释放报错时保持 pending 并可显式恢复', async () => {
    let executions = 0
    const fixture = await hostFixture({ executeReadOnlyRun: async () => {
      executions += 1
      throw new Error('must not execute after release failure')
    } })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-RELEASE-FAIL', fixture.roots.project),
    ))
    await seedCompiledRun(fixture, created, 'SEED-RELEASE-FAIL')
    const acquire = fixture.store.acquireRunLock.bind(fixture.store)
    let failClose = true
    fixture.store.acquireRunLock = (async (...args: Parameters<typeof acquire>) => {
      const real = await acquire(...args)
      const close = real.close.bind(real)
      real.close = async () => {
        await close()
        if (failClose) { failClose = false; throw new Error('injected lease release report failure') }
      }
      return real
    }) as typeof fixture.store.acquireRunLock
    const executeRequest = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-RELEASE-FAIL'), command: 'execute-run',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    })
    await expect(handleRequest(fixture.host, executeRequest)).resolves.toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED' },
    })
    expect(executions).toBe(0)
    const running = await fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )
    expect(running).toMatchObject({ workflow: { current: 'running-real' },
      executionAttempt: { requestId: executeRequest.requestId } })
    const reconciled = await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-RESUME-RELEASE-FAIL'), command: 'resume-run',
      projectRoot: fixture.roots.project, payload: { runId: created.runId, decision: {
        kind: 'reconcile-stale-read', expectedAttemptId: running!.executionAttempt!.attemptId,
      } },
    }))
    expect(reconciled).toMatchObject({ ok: true, result: { status: 'safety-blocked' } })
    await fixture.store.close()
  })

  test('execute-run 崩溃后保持 running-real fenced attempt，跨 package 错误只公开安全码且不能重复执行', async () => {
    const fixture = await hostFixture({ executeReadOnlyRun: async () => {
      throw Object.assign(new Error('包含不应泄漏的本机路径 /Users/example/private'), {
        code: 'E2E_RUNTIME_BROWSER_TEST_CRASH',
      })
    } })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-CRASH', fixture.roots.project),
    ))
    const projected = projectionFixture()
    await fixture.store.beginRequest('SEED-CRASH', digest('5'))
    const lock = await fixture.store.acquireRunLock(created.projectIdentityDigest as string, created.runId as string)
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string, 'SEED-CRASH', digest('5'),
      (snapshot) => ({ snapshot: {
        ...snapshot,
        artifactDigests: { ...snapshot.artifactDigests, ...Object.fromEntries(
          Object.entries(projected.frozenArtifacts).map(([key, artifact]) => [key, artifact.contentDigest]),
        ) },
        frozenArtifacts: projected.frozenArtifacts,
        trustedExecutionFacts: executionFactsFor(projected, snapshot),
        workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('8') },
      }, response: { seeded: true } }),
      'test-seed-crash', lock,
    )
    await lock.close()

    const executeRequest = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-CRASH'), command: 'execute-run', projectRoot: fixture.roots.project,
      payload: { runId: created.runId },
    })
    const response = await handleRequest(fixture.host, executeRequest)
    expect(response).toMatchObject({ ok: false, error: {
      code: 'E2E_RUNTIME_READ_EXECUTION_CRASHED',
      message: expect.stringContaining('内部错误码 E2E_RUNTIME_BROWSER_TEST_CRASH'),
    } })
    expect(response.error?.message).not.toContain('/Users/example/private')
    const persisted = await fixture.store.getRun(created.projectIdentityDigest as string, created.runId as string)
    expect(persisted).toMatchObject({
      workflow: { current: 'running-real' },
      executionAttempt: { attemptId: expect.stringMatching(/^ATTEMPT-/), requestId: 'REQUEST-EXECUTE-CRASH' },
    })
    await expect(handleRequest(fixture.host, executeRequest)).resolves.toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED' },
    })
    const attemptId = persisted?.executionAttempt?.attemptId
    const resumeRequest = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-RECONCILE-CRASH'), command: 'resume-run', projectRoot: fixture.roots.project,
      payload: { runId: created.runId, decision: { kind: 'reconcile-stale-read', expectedAttemptId: attemptId } },
    })
    const resumeBytes = JSON.stringify(resumeRequest)
    await expect(fixture.store.beginRequest(
      resumeRequest.requestId, digestBytes('e2e-runtime-request-bytes/v1', Buffer.from(resumeBytes)),
    )).resolves.toEqual({ kind: 'reserved' })
    const reconciled = successResult(await handleRequest(fixture.host, resumeRequest, resumeBytes))
    expect(reconciled).toEqual({
      runId: created.runId, reconciledAttemptId: attemptId, status: 'safety-blocked',
    })
    await expect(fixture.store.getRun(
      created.projectIdentityDigest as string, created.runId as string,
    )).resolves.not.toHaveProperty('executionAttempt')
    await expect(handleRequest(fixture.host, executeRequest)).resolves.toMatchObject({
      ok: false, error: { code: 'E2E_RUNTIME_EXECUTION_ATTEMPT_STALE' },
    })
    await fixture.store.close()
  })

  test('execute-run 清理包装错误只公开嵌套首因固定码', async () => {
    const fixture = await hostFixture({ executeReadOnlyRun: async () => {
      throw Object.assign(new Error('generic cleanup wrapper'), {
        code: 'E2E_RUNTIME_CLEANUP_FAILED',
        cause: new AggregateError([Object.assign(new Error('private browser failure'), {
          code: 'E2E_RUNTIME_BROWSER_TEST_CRASH',
        })]),
      })
    } })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-NESTED-CRASH', fixture.roots.project),
    ))
    const projected = projectionFixture()
    await fixture.store.beginRequest('SEED-NESTED-CRASH', digest('a'))
    const lock = await fixture.store.acquireRunLock(created.projectIdentityDigest as string, created.runId as string)
    await fixture.store.updateRunOutcome(
      created.projectIdentityDigest as string, created.runId as string,
      'SEED-NESTED-CRASH', digest('a'),
      (snapshot) => ({ snapshot: {
        ...snapshot,
        artifactDigests: { ...snapshot.artifactDigests, ...Object.fromEntries(
          Object.entries(projected.frozenArtifacts).map(([key, artifact]) => [key, artifact.contentDigest]),
        ) },
        frozenArtifacts: projected.frozenArtifacts,
        trustedExecutionFacts: executionFactsFor(projected, snapshot),
        workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('b') },
      }, response: { seeded: true } }),
      'test-seed-nested-crash', lock,
    )
    await lock.close()

    const response = await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-EXECUTE-NESTED-CRASH'), command: 'execute-run',
      projectRoot: fixture.roots.project, payload: { runId: created.runId },
    }))
    expect(response).toMatchObject({ ok: false, error: {
      code: 'E2E_RUNTIME_READ_EXECUTION_CRASHED',
      message: expect.stringContaining('内部错误码 E2E_RUNTIME_BROWSER_TEST_CRASH'),
    } })
    expect(response.error?.message).not.toContain('private browser failure')
    await fixture.store.close()
  })

  test('resume-run 把 recover-write-attempt 接到生产 Host recovery coordinator，并闭合 resume request', async () => {
    const recover = vi.fn(async () => ({ status: 'blocked' as const,
      reasonCode: 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN', browserCalls: 0 as const }))
    const fixture = await hostFixture({ writeRecovery: { recover } })
    const created = successResult(await handleRequest(fixture.host,
      createRunRequest('REQUEST-CREATE-WRITE-RECOVERY', fixture.roots.project)))
    const request = RuntimeRequestEnvelopeSchema.parse({
      ...requestHeader('REQUEST-RESUME-WRITE'), command: 'resume-run', projectRoot: fixture.roots.project,
      payload: { runId: created.runId,
        decision: { kind: 'recover-write-attempt', expectedAttemptId: 'ATTEMPT-WRITE-1' } },
    })
    await expect(handleRequest(fixture.host, request)).resolves.toMatchObject({ ok: true, result: {
      recoveredAttemptId: 'ATTEMPT-WRITE-1', status: 'blocked', browserCalls: 0,
    } })
    expect(recover).toHaveBeenCalledWith({ projectIdentityDigest: created.projectIdentityDigest,
      runId: created.runId, attemptId: 'ATTEMPT-WRITE-1' })
    await expect(handleRequest(fixture.host, request)).resolves.toMatchObject({ ok: true, result: {
      recoveredAttemptId: 'ATTEMPT-WRITE-1', status: 'blocked',
    } })
    expect(recover).toHaveBeenCalledTimes(1)
    await fixture.store.close()
  })

  test('globally reserves invalid-project errors before identity parsing', async () => {
    const fixture = await hostFixture()
    const invalid = createRunRequest('REQUEST-GLOBAL-1', join(fixture.roots.root, 'missing-project'))
    const first = await handleRequest(fixture.host, invalid)
    expect(first).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_PROJECT_IDENTITY_INVALID' } })

    const rebound = createRunRequest('REQUEST-GLOBAL-1', fixture.roots.project)
    const second = await handleRequest(fixture.host, rebound)
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })
    await fixture.store.close()
  })

  test('journals doctor responses in the same global raw-bytes replay ledger', async () => {
    const fixture = await hostFixture()
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: 'REQUEST-DOCTOR-GLOBAL',
      client: { name: 'test-client', version: '1.0.0' }, command: 'doctor', payload: {},
    })
    const bytes = JSON.stringify(request)
    const first = await fixture.host.handle(request, bytes)
    const replay = await fixture.host.handle(request, bytes)
    expect(replay).toEqual(first)
    await expect(fixture.host.handle(request, `${bytes} `)).resolves.toMatchObject({
      ok: false,
      error: { code: 'E2E_RUNTIME_REQUEST_REPLAY_MISMATCH' },
    })
    await fixture.store.close()
  })

  test.each(['inputs/prd.md', 'inputs/policy.json'])(
    'does not read an outside canary when %s parent is swapped before open',
    async (targetPath) => {
      const roots = await createRuntimeTestRoots()
      const outsideInputs = join(roots.root, 'outside-inputs')
      await mkdir(outsideInputs)
      await writeFile(join(outsideInputs, 'prd.md'), 'OUTSIDE-PRD-CANARY')
      await writeFile(join(outsideInputs, 'policy.json'), 'OUTSIDE-POLICY-CANARY')
      let targetRead = false
      let swapped = false
      const reader = new SecureProjectFileReader({
        beforeOpenFile: async ({ relativePath }) => {
          if (relativePath !== targetPath || swapped) return
          swapped = true
          await rename(join(roots.project, 'inputs'), join(roots.project, 'inputs-original'))
          await symlink(outsideInputs, join(roots.project, 'inputs'))
        },
        beforeRead: async ({ relativePath }) => {
          if (relativePath === targetPath) targetRead = true
        },
      })
      const fixture = await hostFixture({ roots, reader })

      const response = await handleRequest(
        fixture.host,
        createRunRequest(`REQUEST-SWAP-${targetPath.endsWith('prd.md') ? 'PRD' : 'POLICY'}`, roots.project),
      )
      expect(response).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_PROJECT_FILE_UNSAFE' } })
      expect(targetRead).toBe(false)
      await fixture.store.close()
    },
  )

  test.each(['inputs/prd.md', 'inputs/policy.json'])(
    'rejects a real project root replacement before reading %s',
    async (targetPath) => {
      const roots = await createRuntimeTestRoots()
      let targetRead = false
      let swapped = false
      const reader = new SecureProjectFileReader({
        beforeOpenFile: async ({ relativePath }) => {
          if (relativePath !== targetPath || swapped) return
          swapped = true
          await rename(roots.project, `${roots.project}-original`)
          await mkdir(join(roots.project, '.biztest'), { recursive: true })
          await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
            schemaVersion: '1.0.0', projectId: 'REPLACEMENT-CANARY',
          }))
          await mkdir(join(roots.project, 'inputs'))
          await writeFile(join(roots.project, 'inputs', 'prd.md'), 'REPLACEMENT-PRD-CANARY')
          await writeFile(join(roots.project, 'inputs', 'policy.json'), 'REPLACEMENT-POLICY-CANARY')
        },
        beforeRead: async ({ relativePath }) => {
          if (relativePath === targetPath) targetRead = true
        },
      })
      const fixture = await hostFixture({ roots, reader })

      const response = await handleRequest(
        fixture.host,
        createRunRequest(`REQUEST-ROOT-${targetPath.endsWith('prd.md') ? 'PRD' : 'POLICY'}`, roots.project),
      )
      expect(response).toMatchObject({ ok: false, error: { code: 'E2E_RUNTIME_PROJECT_FILE_UNSAFE' } })
      expect(targetRead).toBe(false)
      await fixture.store.close()
    },
  )
})

async function hostFixture(options: {
  roots?: Awaited<ReturnType<typeof createRuntimeTestRoots>>
  reader?: SecureProjectFileReader
  executeReadOnlyRun?: Parameters<typeof authorizeRuntimeReadExecutor>[0]
  executeWriteRun?: Parameters<typeof authorizeRuntimeWriteExecutor>[0]
  executeInjectionRun?: Parameters<typeof authorizeRuntimeInjectionExecutor>[0]
  executeFullPlaywrightRun?: Parameters<typeof authorizeRuntimeFullPlaywrightExecutor>[0]
  preflight?: Parameters<typeof authorizeRuntimePreflight>[0]
  authorityHostFactory?: () => Promise<Pick<RuntimeAuthorityHost, 'requestApproval'>>
  writeRecovery?: Parameters<typeof authorizeRuntimeWriteProduction>[0]['recovery']
  projectPublisherFactory?: (projectRoot: string) => Pick<ProjectPublisher, 'renderActiveReport'>
  finalizeGeneration?: Parameters<typeof authorizeRuntimeGenerationFinalizer>[0]
  quarantineEvidence?: Parameters<typeof authorizeRuntimeEvidenceQuarantine>[0]
  reserveExecutionLeases?: NonNullable<ConstructorParameters<typeof E2ERuntimeHost>[0]['reserveExecutionLeases']>
} = {}) {
  const roots = options.roots ?? await createRuntimeTestRoots()
  await mkdir(join(roots.project, '.biztest'), { recursive: true })
  await writeFile(join(roots.project, '.biztest', 'project.json'), JSON.stringify({
    schemaVersion: '1.0.0', projectId: 'PROJECT-1',
  }))
  await mkdir(join(roots.project, 'inputs'), { recursive: true })
  await writeFile(join(roots.project, 'inputs', 'prd.md'), '# Product\nA stable PRD.')
  await writeFile(join(roots.project, 'inputs', 'policy.json'), '{}')
  await writeFile(
    join(roots.project, 'inputs', 'understanding-contract.md'), UNDERSTANDING_CONTRACT_TEXT,
  )
  const store = await RuntimeRunStore.open({
    homeDir: roots.home,
    projectRoot: roots.project,
  })
  const host = new E2ERuntimeHost({
    installation,
    doctor: async () => ({
      ready: true,
      runtimeVersion: installation.version,
      installationDigest: installation.installationDigest,
      browserSource: 'system-chrome',
      approvalMode: 'local-confirmation',
      probes: {},
    }),
    runStore: store,
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    ...(options.reserveExecutionLeases === undefined ? {} : {
      reserveExecutionLeases: options.reserveExecutionLeases,
    }),
    ...(options.reader === undefined ? {} : { projectFileReader: options.reader }),
    ...(options.executeReadOnlyRun === undefined ? {} : {
      readExecutor: authorizeRuntimeReadExecutor(options.executeReadOnlyRun),
    }),
    ...(options.executeWriteRun === undefined ? {} : {
      writeExecutor: authorizeRuntimeWriteExecutor(options.executeWriteRun),
    }),
    ...(options.executeInjectionRun === undefined ? {} : {
      injectionExecutor: authorizeRuntimeInjectionExecutor(options.executeInjectionRun),
    }),
    ...(options.executeFullPlaywrightRun === undefined ? {} : {
      fullPlaywrightExecutor: authorizeRuntimeFullPlaywrightExecutor(
        options.executeFullPlaywrightRun,
      ),
    }),
    ...(options.preflight === undefined ? {} : {
      preflightExecutor: authorizeRuntimePreflight(options.preflight),
    }),
    ...(options.authorityHostFactory === undefined ? {} : {
      authorityHostFactory: options.authorityHostFactory,
    }),
    ...(options.writeRecovery === undefined ? {} : {
      writeProduction: authorizeRuntimeWriteProduction({
        recovery: options.writeRecovery,
        ownedResources: { register: vi.fn(), complete: vi.fn() },
        prepareCleanup: vi.fn(),
      }),
    }),
    ...(options.projectPublisherFactory === undefined ? {} : {
      projectPublisherFactory: options.projectPublisherFactory,
    }),
    ...(options.finalizeGeneration === undefined ? {} : {
      generationFinalizer: authorizeRuntimeGenerationFinalizer(options.finalizeGeneration),
    }),
    ...(options.quarantineEvidence === undefined ? {} : {
      evidenceQuarantine: authorizeRuntimeEvidenceQuarantine(options.quarantineEvidence),
    }),
  })
  return { roots, store, host }
}

function executionFactsFor(
  projected: ReturnType<typeof projectionFixture>,
  snapshot: { runId: string; runtimeInstallationDigest: string },
): Record<string, unknown> {
  const discovery = structuredClone(projected.trustedExecutionFacts['signed-discovery-grant']) as {
    approvalContext: { runId: string; installationDigest: string }
  }
  discovery.approvalContext.runId = snapshot.runId
  discovery.approvalContext.installationDigest = snapshot.runtimeInstallationDigest
  const execution = structuredClone(projected.grant)
  execution.approvalContext.runId = snapshot.runId
  execution.approvalContext.installationDigest = snapshot.runtimeInstallationDigest
  const preflight = structuredClone(projected.trustedExecutionFacts['browser-preflight']) as { runId: string }
  preflight.runId = snapshot.runId
  return {
    ...projected.trustedExecutionFacts,
    'signed-discovery-grant': discovery,
    'signed-execution-grant': execution,
    'browser-preflight': preflight,
  }
}

function compiledPlanForMultiCase(snapshot: RuntimeRunSnapshot) {
  const cases = (
    snapshot.frozenArtifacts['test-cases']!.content as {
      cases: Array<{ caseId: string; title: string; actor: string }>
    }
  ).cases
  const actions = (
    snapshot.frozenArtifacts['browser-action-map']!.content as {
      actions: Array<{ caseId: string; actionId: string }>
    }
  ).actions
  const draft = {
    schemaVersion: '1.0.0' as const,
    contractProjectionDigest: digest('6'),
    cases: cases.map((testCase, index) => {
      const action = actions.find((candidate) => candidate.caseId === testCase.caseId)!
      return {
        queueOrdinal: index,
        caseId: testCase.caseId,
        caseKey: `case-${index + 1}`,
        title: testCase.title,
        actor: testCase.actor,
        contractNodeIds: [`REQ-${index + 1}`],
        actions: [{
          actionId: action.actionId,
          actionKey: `action-${index + 1}`,
          kind: 'full-playwright' as const,
          effect: 'reversible-write' as const,
          statement: action.actionId,
        }],
        oracles: [{
          oracleId: `ORACLE-${index + 1}`,
          oracleKey: `oracle-${index + 1}`,
          actionId: action.actionId,
          contractNodeId: `REQ-${index + 1}`,
          acceptanceCriterion: `criterion-${index + 1}`,
        }],
        failurePolicy: 'continue' as const,
      }
    }),
  }
  return { ...draft, compilerDigest: digestCompiledPrdRunPlan(draft) }
}

function executionGrantForMode(mode: 'write' | 'injection', runId: string) {
  const issuedAt = '2026-07-17T00:00:00.000Z'
  const expiresAt = '2026-07-17T01:00:00.000Z'
  const common = {
    issuer: 'authority', keyId: 'key', proofScope: 'local-os-user' as const,
    approver: { subject: 'os-user:test', roles: ['approver'] }, issuedAt, expiresAt,
    revocationSequence: 0, signature: 'A'.repeat(86),
  }
  if (mode === 'write') {
    const request = {
      intentId: 'INTENT-WRITE-1', method: 'POST', canonicalOrigin: 'https://test.example.com',
      exactPath: '/api/orders/1/approve', query: [] as Array<[string, string]>,
      payload: { kind: 'no-body' as const }, targetFingerprint: digest('3'),
      maxRequests: 1, expectedOrder: 1,
    }
    const subject = {
      schemaVersion: '2.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('1'),
      executionDigest: digest('2'), scopeDigest: digest('3'), requirementModelDigest: digest('4'),
      coveragePolicyDigest: digest('5'), universeDigest: digest('6'), caseDigest: digest('7'),
      actionMapDigest: digest('8'), policyDigest: digest('a'), executionContractDigest: digest('b'),
      runBundleProjectionDigest: digest('c'), environment: 'test' as const,
      baseOrigin: 'https://test.example.com', actor: 'auditor', discoveryGrantId: 'DISCOVERY-1',
      preflightDigest: digest('d'), actions: [{ actionId: 'ACTION-1', effect: 'reversible-write' as const,
        dataLeaseId: 'LEASE-1', resourceKey: 'order:1', fencingToken: 1,
        cleanupPlanDigest: digest('e'), requests: [request] }],
    }
    const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
    return SignedGrantSchema.parse({ ...common, grantId: 'WRITE-1', subject, subjectDigest,
      approvalContext: { schemaVersion: '1.0.0', subject: common.approver.subject, runId,
        approvalType: 'execution', subjectDigest, installationDigest: installation.installationDigest,
        origin: 'http://127.0.0.1:43210', issuedAt, expiresAt },
      capabilities: [{ capabilityId: 'CAP-WRITE-1', nonce: '1'.repeat(64), transport: 'http',
        effect: 'reversible-write', operation: 'http-request', actionId: 'ACTION-1',
        dataLeaseId: 'LEASE-1', fencingToken: 1, cleanupPlanDigest: digest('e'),
        requests: [request], maxUses: 1 }],
    })
  }
  const request = {
    intentId: 'INTENT-INJECT-1', method: 'POST', canonicalOrigin: 'https://test.example.com',
    exactPath: '/api/orders/search', query: [] as Array<[string, string]>,
    payload: { kind: 'no-body' as const }, targetFingerprint: 'not-applicable' as const,
    maxRequests: 1, expectedOrder: 1,
  }
  const response = { kind: 'http-response' as const, status: 500,
    headers: [] as Array<{ name: 'content-type'; value: string }>,
    body: { kind: 'no-body' as const }, delayMs: 0 }
  const action = { actionId: 'ACTION-1', caseId: 'CASE-1', runId, attemptSlot: 1,
    request, response, expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden' as const }
  const subject = { schemaVersion: '1.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('1'),
    executionDigest: digest('2'), environment: 'test' as const,
    baseOrigin: 'https://test.example.com', actions: [action] }
  const subjectDigest = canonicalGrantApprovalSubjectDigest(subject)
  return SignedGrantSchema.parse({ ...common, grantId: 'INJECTION-1', subject, subjectDigest,
    approvalContext: { schemaVersion: '1.0.0', subject: common.approver.subject, runId,
      approvalType: 'execution', subjectDigest, installationDigest: installation.installationDigest,
      origin: 'http://127.0.0.1:43210', issuedAt, expiresAt },
    capabilities: [{ capabilityId: 'CAP-INJECT-1', nonce: '2'.repeat(64),
      transport: 'gateway-injection', ...action, maxUses: 1 }],
  })
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
      prdSource: { kind: 'file', path: 'inputs/prd.md',
        origin: { kind: 'file', ref: 'inputs/prd.md' } },
      understandingContract: {
        header: {
          schemaVersion: '1.0.0', contractId: 'CONTRACT-PRODUCT', contractVersion: 1,
          contractStatus: 'confirmed-by-caller', authorization: {
            status: 'confirmed-by-caller', contractVersion: 1,
            confirmedAt: '2026-07-17T00:00:00.000Z',
          },
        },
        source: { kind: 'file', path: 'inputs/understanding-contract.md' },
      },
      projectPolicyPath: 'inputs/policy.json',
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
  artifactType?: RuntimeRequestEnvelope['payload'] extends never ? never : string
}): RuntimeRequestEnvelope {
  return RuntimeRequestEnvelopeSchema.parse({
    ...requestHeader(input.requestId), command: 'submit-candidate', projectRoot: input.projectRoot,
    payload: {
      runId: input.runId,
      expectedState: input.expectedState,
      artifactType: input.artifactType ?? 'prd-request',
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
    artifactId: 'PRD-REQUEST-1', artifactType: 'prd-request', schemaVersion: '2.0.0',
    engineVersion: '0.1.0', ...binding, createdAt: '2026-07-17T00:00:00.000Z',
    contentDigest: '', signatures: [], dependencies: [], graph: { defines: [], references: [] },
    content: {
      productSpace: 'PRODUCT', title: 'Product PRD',
      sourceDescriptors: [{ sourceId: 'PRD-BODY', kind: 'file', ref: 'inputs/prd.md' }],
      userRequest: 'Test the product', testWorkspaceId: 'WORKSPACE-1', secretRefs: [],
      understanding: understandingProjection(binding.prdRevision),
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

function understandingProjection(sourceRevision: string) {
  const value = {
    schemaVersion: '1.0.0' as const,
    contractId: 'CONTRACT-PRODUCT', contractVersion: 1,
    contractStatus: 'confirmed-by-caller' as const,
    contractSourceDigest: digestBytes(
      'e2e-prd-understanding-contract-source/v1', Buffer.from(UNDERSTANDING_CONTRACT_TEXT),
    ),
    sourceRevision,
    sources: [{
      sourceId: 'PRD-BODY', kind: 'file' as const, ref: 'inputs/prd.md',
      origin: { kind: 'file' as const, ref: 'inputs/prd.md' },
      relevance: 'target' as const,
      digest: digestText('e2e-prd-understanding-source/v1', '# Product\nA stable PRD.'),
      byteLength: Buffer.byteLength('# Product\nA stable PRD.', 'utf8'),
    }],
    nodes: structuredClone(UNDERSTANDING_CONTRACT_MACHINE_VIEW.nodes),
    pendingQuestions: structuredClone(UNDERSTANDING_CONTRACT_MACHINE_VIEW.pendingQuestions),
    route: structuredClone(UNDERSTANDING_CONTRACT_MACHINE_VIEW.route),
    authorization: {
      status: 'confirmed-by-caller' as const, contractVersion: 1,
      authorizedNodeIds: structuredClone(UNDERSTANDING_CONTRACT_MACHINE_VIEW.authorizedNodeIds),
      confirmedAt: '2026-07-17T00:00:00.000Z',
    },
    projectionDigest: '',
  }
  return { ...value, projectionDigest: digestPrdUnderstandingProjection(value) }
}

async function prepareUnderstandingForRun(
  fixture: Awaited<ReturnType<typeof hostFixture>>,
  created: Record<string, unknown>,
  requestId: string,
): Promise<Record<string, unknown>> {
  const { projectionDigest: _ignored, ...draft } = understandingProjection(
    created.prdRevision as string,
  )
  return successResult(await handleRequest(fixture.host, RuntimeRequestEnvelopeSchema.parse({
    ...requestHeader(requestId), command: 'prepare-prd-understanding',
    projectRoot: fixture.roots.project, payload: { runId: created.runId, projection: draft },
  })))
}

function mutateUnderstandingCandidate(
  candidate: Record<string, unknown>,
  mutate: (understanding: any, content: any) => void,
): Record<string, unknown> {
  const changed = structuredClone(candidate) as any
  mutate(changed.content.understanding, changed.content)
  changed.content.understanding.projectionDigest = digestPrdUnderstandingProjection(
    changed.content.understanding,
  )
  changed.contentDigest = ''
  changed.contentDigest = digestArtifactContent(
    `artifact-content/${changed.schemaVersion}/${changed.artifactType}`,
    changed,
  )
  return changed
}

function projectPolicyCandidate(binding: {
  assetId: string
  generationId: string
  prdRevision: string
}, runtimePolicyId: string): Record<string, unknown> & { contentDigest: string } {
  const idDigest = (id: string) => ({ id, digest: digest(id === runtimePolicyId ? 'a' : 'b') })
  const candidate = {
    artifactId: 'ARTIFACT-PROJECT-POLICY', artifactType: 'project-policy', schemaVersion: '2.0.0',
    engineVersion: '0.1.0', ...binding, createdAt: '2026-07-17T00:00:00.000Z',
    contentDigest: '', signatures: [], dependencies: [], graph: { defines: [], references: [] },
    content: {
      policyVersion: '1.0.0',
      environments: [{ environmentId: 'test', baseOrigin: 'https://test.example.com' }],
      originPolicies: [{ origin: 'https://test.example.com', allowRead: true, allowWrite: false }],
      browserMatrix: [{ browserId: 'chromium', channel: 'chromium', required: true }],
      coveragePolicy: idDigest('COVERAGE-POLICY'), evidencePolicy: idDigest('EVIDENCE-POLICY'),
      retentionPolicy: idDigest('RETENTION-POLICY'), riskPolicy: idDigest('RISK-POLICY'),
      timeoutPolicy: idDigest('TIMEOUT-POLICY'), runtimePolicy: idDigest(runtimePolicyId),
    },
  }
  return {
    ...candidate,
    contentDigest: digestArtifactContent('artifact-content/2.0.0/project-policy', candidate),
  }
}

function rebindArtifact(
  candidate: ArtifactDocument,
  binding: { assetId: string; generationId: string; prdRevision: string },
): ArtifactDocument {
  const rebound = {
    ...structuredClone(candidate),
    ...binding,
    contentDigest: '',
  }
  rebound.contentDigest = digestArtifactContent(
    `artifact-content/${rebound.schemaVersion}/${rebound.artifactType}`,
    rebound,
  )
  return rebound as ArtifactDocument
}

function semanticCandidate(
  artifactType: ArtifactType,
  schemaVersion: string,
  binding: { assetId: string; generationId: string; prdRevision: string },
  content: unknown,
): ArtifactDocument {
  const candidate = {
    artifactId: `ARTIFACT-${artifactType}`, artifactType, schemaVersion, engineVersion: '0.1.0',
    ...binding, createdAt: '2026-07-17T00:00:00.000Z', contentDigest: '',
    signatures: [], dependencies: [], graph: { defines: [], references: [] }, content,
  }
  candidate.contentDigest = digestArtifactContent(
    `artifact-content/${schemaVersion}/${artifactType}`, candidate,
  )
  return candidate as unknown as ArtifactDocument
}

function regressionManifestCandidate(
  binding: { assetId: string; generationId: string; prdRevision: string },
): ArtifactDocument {
  const sourceFiles = [{
    relativePath: 'regression/tests/generated.spec.ts', digest: digest('1'), byteLength: 1,
    mediaType: 'text/typescript' as const,
  }]
  const caseMappings = [{
    caseId: 'CASE-1', relativePath: sourceFiles[0]!.relativePath, testTitle: '订单列表',
  }]
  const toolchain = {
    nodeVersion: '24.0.0', playwrightVersion: '1.61.1', typescriptVersion: '5.9.3',
    compilerDigest: digest('2'), playwrightCliDigest: digest('3'),
  }
  const attestation = {
    schemaVersion: '2.1.0', testDomain: 'prd-e2e-trusted-compiler',
    executionProfile: 'trusted-read-only', ...binding,
    compilerVersion: '0.1.0', templateVersion: '0.1.0', contractsVersion: '2.0.0',
    environmentId: 'TEST', approvalDigest: digest('4'), policyDigest: digest('5'),
    templateDigest: digest('6'), compilerInputDigest: digest('7'), sourceFiles, caseMappings, toolchain,
    isolation: { command: ['node', '@playwright/test/cli', 'test', '--list', '--reporter=json'],
      exitCode: 0, stdoutDigest: digest('8') },
    discoveredCaseIds: ['CASE-1'], blockedCases: [],
    sourceSetDigest: computeRegressionSourceSetDigest(sourceFiles),
    issuer: 'runtime-test', keyId: 'runtime-test-key', purpose: 'regression-discovery-attestation/v2',
    algorithm: 'Ed25519', signedDigest: digest('9'), signature: 'test-attestation',
  }
  const content = {
    testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
    templateDigest: digest('6'), toolchain, sourceFiles, caseMappings,
    blockedCases: [], deprecatedCases: [],
    listResult: { caseIds: ['CASE-1'], digest: digest('a'), attestation },
  }
  const candidate = {
    artifactId: 'ARTIFACT-regression-manifest', artifactType: 'regression-manifest',
    schemaVersion: '2.0.0', engineVersion: '0.1.0', ...binding,
    createdAt: '2026-07-17T00:00:00.000Z', contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
  candidate.contentDigest = digestArtifactContent(
    'artifact-content/2.0.0/regression-manifest', candidate,
  )
  return candidate as unknown as ArtifactDocument
}

async function handleSuccess(
  host: E2ERuntimeHost,
  request: RuntimeRequestEnvelope,
): Promise<Record<string, unknown>> {
  return successResult(await handleRequest(host, request))
}

async function seedCompiledRun(
  fixture: Awaited<ReturnType<typeof hostFixture>>,
  created: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  await fixture.store.beginRequest(requestId, digest('7'))
  const lock = await fixture.store.acquireRunLock(
    created.projectIdentityDigest as string, created.runId as string,
  )
  const projected = projectionFixture()
  await fixture.store.updateRunOutcome(
    created.projectIdentityDigest as string, created.runId as string, requestId, digest('7'),
    (snapshot) => ({ snapshot: {
      ...snapshot,
      artifactDigests: { ...snapshot.artifactDigests, ...Object.fromEntries(
        Object.entries(projected.frozenArtifacts).map(([key, artifact]) => [key, artifact.contentDigest]),
      ) },
      frozenArtifacts: projected.frozenArtifacts,
      trustedExecutionFacts: executionFactsFor(projected, snapshot),
      workflow: { current: 'compiled', sequence: 9, eventChainDigest: digest('8') },
    }, response: { seeded: true } }),
    'test-seed-compiled', lock,
  )
  await lock.close()
}

async function seedDiagnosingRun(
  fixture: Awaited<ReturnType<typeof hostFixture>>,
  created: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  await fixture.store.beginRequest(requestId, digest('6'))
  const lock = await fixture.store.acquireRunLock(
    created.projectIdentityDigest as string, created.runId as string,
  )
  await fixture.store.updateRunOutcome(
    created.projectIdentityDigest as string, created.runId as string, requestId, digest('6'),
    (snapshot) => ({
      snapshot: {
        ...snapshot,
        workflow: { current: 'diagnosing', sequence: 10, eventChainDigest: digest('5') },
      },
      response: { seeded: true },
    }),
    'test-seed-diagnosing', lock,
  )
  await lock.close()
}

function successResult(response: RuntimeResponseEnvelope): Record<string, unknown> {
  const parsed = RuntimeResponseEnvelopeSchema.parse(response)
  expect(parsed.ok, JSON.stringify(parsed.error)).toBe(true)
  expect(parsed.result).toBeTypeOf('object')
  return parsed.result as Record<string, unknown>
}

async function handleRequest(
  host: E2ERuntimeHost,
  request: RuntimeRequestEnvelope,
  bytes = JSON.stringify(request),
): Promise<RuntimeResponseEnvelope> {
  return await host.handle(request, bytes)
}
