import { describe, expect, test, vi } from 'vitest'
import {
  RuntimeResponseEnvelopeSchema,
  canonicalizeJson,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { E2EFacade, E2EFacadeError } from '../src/e2e-facade.js'
import { RUNTIME_PACKAGE_VERSION } from '../src/protocol.js'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('E2EFacade', () => {
  test('startFromInput 自动准备内部文件并只把 create payload 交给 Runtime', async () => {
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (request.command === 'create-run') return success(request.requestId, { runId: 'RUN-1' })
      return success(request.requestId, statusResult({
        assetId: 'ASSET-1', runId: 'RUN-1', revision: 1, generationDigest: d('1'),
      }))
    }) }
    const create = {
      assetId: 'ASSET-1',
      prdSource: { kind: 'file' as const, path: '.biztest/e2e-intake/ASSET-1/prd.md',
        origin: { kind: 'url' as const, ref: 'https://example.test/prd' } },
      understandingContract: { header: { schemaVersion: '1.0.0' as const,
        contractId: 'CONTRACT-1', contractVersion: 1, contractStatus: 'confirmed-by-caller' as const,
        authorization: { status: 'confirmed-by-caller' as const, contractVersion: 1,
          confirmedAt: '2026-08-03T00:00:00.000Z' } },
      source: { kind: 'file' as const, path: '.biztest/e2e-intake/ASSET-1/contract.md' } },
      projectPolicyPath: '.biztest/e2e-intake/ASSET-1/policy.json',
    }
    const inputPreparer = { prepare: vi.fn(async () => ({
      schemaVersion: '1.0.0' as const, intakeId: 'INTAKE-1', projectRoot: '/project', create,
    })) }
    const facade = new E2EFacade({ projectRoot: '/project', host, inputPreparer,
      requestId: () => `REQUEST-${commands.length + 1}` })

    await facade.startFromInput({ intake: { schemaVersion: '1.0.0', assetId: 'ASSET-1',
      prd: { text: '# PRD', origin: { kind: 'url', ref: 'https://example.test/prd' } },
      understandingContract: { text: '# Contract', header: create.understandingContract.header } } })

    expect(inputPreparer.prepare).toHaveBeenCalledOnce()
    expect(commands).toEqual(['create-run', 'get-status'])
    expect(host.handle).toHaveBeenCalledWith(expect.objectContaining({ payload: create }), expect.any(Uint8Array))
  })

  test('start 冻结来源并配置 Target，等待需求编译后再由状态边触发 Probe', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 1, generationDigest: d('1') }
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (request.command === 'create-run') return success(request.requestId, { runId: 'RUN-1' })
      if (request.command === 'configure-target') return success(request.requestId, { runId: 'RUN-1' })
      return success(request.requestId, statusResult(handle))
    }) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => `REQUEST-${commands.length + 1}` })
    const targetContract = {
      schemaVersion: '1.0.0' as const, targetUrl: 'http://localhost:3000/orders',
      baseOrigin: 'http://localhost:3000', environmentLabel: 'local',
      allowedNavigationOrigins: ['http://localhost:3000'],
      pageIdentityPolicy: {
        schemaVersion: '1.0.0' as const,
        url: { origin: 'http://localhost:3000', pathPattern: '/orders/**' },
        signals: [{ kind: 'test-id' as const, value: 'orders-page' }],
        match: { mode: 'all' as const },
      },
    }

    await facade.start({ create: {
      assetId: 'ASSET-1',
      prdSource: { kind: 'file', path: 'prd.md', origin: { kind: 'file', ref: 'prd.md' } },
      understandingContract: { header: { schemaVersion: '1.0.0', contractId: 'CONTRACT-1',
        contractVersion: 1, contractStatus: 'confirmed-by-caller', authorization: {
          status: 'confirmed-by-caller', contractVersion: 1, confirmedAt: '2026-08-02T00:00:00.000Z',
        } }, source: { kind: 'file', path: 'contract.md' } },
      projectPolicyPath: 'policy.json',
    }, targetContract })

    expect(commands).toEqual(['create-run', 'configure-target', 'get-status'])
  })

  test('status 内部生成严格 envelope，对外只使用 RunHandle', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const host = vi.fn(async (request: RuntimeRequestEnvelope, bytes: Uint8Array) => {
      expect(JSON.parse(Buffer.from(bytes).toString())).toEqual(request)
      return success(request.requestId, statusResult(handle))
    })
    const facade = new E2EFacade({ projectRoot: '/project', host: { handle: host },
      requestId: () => 'FACADE-STATUS-1' })

    await expect(facade.status(handle)).resolves.toMatchObject({ handle, state: 'preflight-readonly' })
    expect(host).toHaveBeenCalledWith(expect.objectContaining({
      command: 'get-status', projectRoot: '/project', payload: { runId: 'RUN-1' },
      client: { name: 'e2e-facade', version: RUNTIME_PACKAGE_VERSION },
    }), expect.any(Uint8Array))
  })

  test('taskState 通过显式 opt-in 读取投影，不改变普通 status 协议', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const host = vi.fn(async (request: RuntimeRequestEnvelope) => {
      const status = statusResult(handle)
      return success(request.requestId, {
        ...status,
        ...(request.command === 'get-status' && request.payload.includeTaskState === true ? {
          taskState: {
            schemaVersion: '1.0.0', runId: 'RUN-1', assetId: 'ASSET-1', snapshotRevision: 2,
            workflow: status.workflow, stage: status.stage, condition: status.condition,
            caseAttempts: [], artifactValidity: [{
              assetKey: 'prd-source', validity: 'preserved', contentDigest: d('3'),
            }],
            verifiedDigests: status.verifiedDigests,
            minimumMissingInput: status.minimumMissingInput,
            recovery: {
              kind: 'retry', command: 'run-preflight', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
            },
          },
        } : {}),
      })
    })
    const facade = new E2EFacade({ projectRoot: '/project', host: { handle: host },
      requestId: () => 'FACADE-TASK-STATE-1' })

    await expect(facade.taskState(handle)).resolves.toMatchObject({
      schemaVersion: '1.0.0', runId: 'RUN-1', recovery: { kind: 'retry' },
    })
    expect(host).toHaveBeenCalledWith(expect.objectContaining({
      command: 'get-status', payload: { runId: 'RUN-1', includeTaskState: true },
    }), expect.any(Uint8Array))
  })

  test('retry 只重试当前可恢复 blocker，并返回更新状态', async () => {
    const oldHandle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const newHandle = { ...oldHandle, revision: 3 }
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (commands.length === 1) return success(request.requestId, statusResult(oldHandle))
      if (commands.length === 2) return success(request.requestId, {
        runId: 'RUN-1', status: 'ready', workflow: { current: 'preflight-readonly', sequence: 6,
          eventChainDigest: d('4') },
      })
      return success(request.requestId, statusResult(newHandle, false))
    }) }
    const ids = ['STATUS-1', 'RETRY-1', 'STATUS-2']
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => ids.shift()! })

    await expect(facade.retry(oldHandle)).resolves.toMatchObject({ handle: newHandle })
    expect(commands).toEqual(['get-status', 'run-preflight', 'get-status'])
  })

  test('Runtime 错误保留 reasonCode、requestId、runId 和 remediation', async () => {
    const host = { handle: async (request: RuntimeRequestEnvelope) => RuntimeResponseEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId: request.requestId,
      runtime: { version: '0.5.0', installationDigest: d('9') }, ok: false,
      error: { code: 'E2E_RUNTIME_PAGE_MISMATCH', category: 'environment',
        message: '页面身份不匹配', terminalState: 'environment-blocked', retryable: true,
        details: { remediation: '更新页面身份策略' } },
    }) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => 'FACADE-ERROR-1' })
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }

    await expect(facade.status(handle)).rejects.toMatchObject({
      name: 'E2EFacadeError', code: 'E2E_RUNTIME_PAGE_MISMATCH',
      requestId: 'FACADE-ERROR-1', runId: 'RUN-1', remediation: '更新页面身份策略',
    } satisfies Partial<E2EFacadeError>)
  })

  test('Execution Approval 由门面打开并确认，调用者不构造 envelope', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (request.command === 'get-status') return success(request.requestId, statusResult(handle))
      if (request.command === 'open-approval') return success(request.requestId, {
        status: 'confirmation-required', confirmationId: 'CONFIRM-1', subjectDigest: d('8'),
      })
      if (request.command === 'confirm-approval') return success(request.requestId, { signedGrant: {} })
      throw new Error(request.command)
    }) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => `REQUEST-${commands.length + 1}` })
    const subject = {
      schemaVersion: '2.1.0' as const, assetId: 'ASSET-1', prdRevision: d('1'),
      scopeDigest: d('2'), requirementModelDigest: d('3'), coveragePolicyDigest: d('4'),
      universeDigest: d('5'), caseDigest: d('6'), actionMapDigest: d('7'), policyDigest: d('8'),
      executionContractDigest: d('9'), runBundleProjectionDigest: d('a'), environment: 'local' as const,
      baseOrigin: 'http://localhost:3000', actor: 'USER', discoveryGrantId: 'GRANT-1',
      preflightDigest: d('b'), requests: [],
      actions: [{ actionId: 'ACTION-1', operation: 'dom-read' as const, maxUses: 1, requestIds: [] }],
    }

    await expect(facade.approveExecution(handle, subject)).resolves.toMatchObject({
      status: 'confirmation-required', confirmationId: 'CONFIRM-1', subjectDigest: d('8'),
    })
    await expect(facade.confirmApproval(handle, 'CONFIRM-1', d('8'))).resolves.toMatchObject({ handle })
    expect(commands).toEqual([
      'get-status', 'open-approval', 'get-status', 'confirm-approval', 'get-status',
    ])
  })

  test('声明式执行绑定通过高层门面一次编译，不暴露 Artifact 顺序', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (request.command === 'get-status') return success(request.requestId, statusResult(handle, false))
      if (request.command === 'compile-executable-run') return success(request.requestId, {
        runId: 'RUN-1', compilerDigest: d('2'), projectionDigest: d('3'),
        artifactDigests: { 'test-cases': d('4'), 'browser-action-map': d('5'),
          'execution-contract': d('6'), 'run-bundle': d('7') },
        executableCaseIds: ['CASE-1'], blockedCases: [],
        workflow: { current: 'awaiting-execution-approval', sequence: 6, eventChainDigest: d('8') },
      })
      throw new Error(request.command)
    }) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => `REQUEST-${commands.length + 1}` })
    const binding = { schemaVersion: 'declarative-execution-binding/v1' as const,
      planCompilerDigest: d('a'), targetProbeDigest: d('b'), cases: [{ caseId: 'CASE-1',
        executionLane: 'trusted-read-only' as const,
        pageIdentityPolicy: { schemaVersion: '1.0.0' as const,
          url: { origin: 'https://example.test', pathPattern: '/' },
          signals: [{ kind: 'test-id' as const, value: 'home' }], match: { mode: 'all' as const } },
        actions: [{ kind: 'assert-only' as const, actionId: 'ACTION-1', effect: 'read' as const,
          pageScope: { page: 'current' as const, frame: { kind: 'main' as const } }, locatorCandidates: [],
          timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' as const } }],
        oracles: [{ kind: 'url' as const, oracleId: 'ORACLE-1', actionId: 'ACTION-1',
          comparator: 'equals' as const, expected: 'https://example.test/', deadlineMs: 5_000,
          evidenceKinds: ['url' as const] }], dataNeeds: [], cleanupIntents: [] }] }

    await expect(facade.compileExecutable(handle, binding)).resolves.toMatchObject({
      executableCaseIds: ['CASE-1'], artifactDigests: { 'run-bundle': d('7') },
    })
    expect(commands).toEqual(['get-status', 'compile-executable-run'])
  })

  test('高层 journey 只跟随 Runtime nextEdge，并在语义审阅处返回 typed pending', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => success(request.requestId,
      statusResult(handle, false, { command: 'get-acceptance-review', from: 'coverage-audited',
        expectedState: 'coverage-audited' }))) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => 'REQUEST-JOURNEY-1' })

    await expect(facade.continueJourney(handle)).resolves.toMatchObject({
      schemaVersion: 'e2e-journey-result/v1', status: 'pending-decision', handle,
      pending: { kind: 'acceptance-review', command: 'get-acceptance-review' },
    })
    expect(host.handle).toHaveBeenCalledTimes(1)
  })

  test('acceptFromPrd 只接收已理解 intake 与 Target，并返回可恢复 RunHandle', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 1, generationDigest: d('1') }
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (request.command === 'create-run') return success(request.requestId, { runId: 'RUN-1' })
      if (request.command === 'configure-target') return success(request.requestId, { runId: 'RUN-1' })
      return success(request.requestId, statusResult(handle, false, {
        command: 'prepare-prd-understanding', from: 'created', expectedState: 'created',
      }))
    }) }
    const inputPreparer = { prepare: vi.fn(async () => ({ schemaVersion: '1.0.0' as const,
      intakeId: 'INTAKE-1', projectRoot: '/project', create: {
        assetId: 'ASSET-1', prdSource: { kind: 'file' as const, path: 'prd.md',
          origin: { kind: 'text' as const, ref: 'caller' } },
        understandingContract: { header: { schemaVersion: '1.0.0' as const,
          contractId: 'CONTRACT-1', contractVersion: 1, contractStatus: 'confirmed-by-caller' as const,
          authorization: { status: 'confirmed-by-caller' as const, contractVersion: 1,
            confirmedAt: '2026-08-12T00:00:00.000Z' } },
        source: { kind: 'file' as const, path: 'contract.md' } }, projectPolicyPath: 'policy.json',
      },
    })) }
    const facade = new E2EFacade({ projectRoot: '/project', host, inputPreparer,
      requestId: () => `REQUEST-${commands.length + 1}` })
    const result = await facade.acceptFromPrd({
      intake: {} as never,
      targetContract: { schemaVersion: '1.0.0', targetUrl: 'https://example.test/',
        baseOrigin: 'https://example.test', environmentLabel: 'test',
        allowedNavigationOrigins: ['https://example.test'], pageIdentityPolicy: {
          schemaVersion: '1.0.0', url: { origin: 'https://example.test', pathPattern: '/' },
          signals: [{ kind: 'test-id', value: 'home' }], match: { mode: 'all' },
        } },
    })

    expect(result).toMatchObject({ status: 'pending-decision', handle,
      pending: { kind: 'semantic-generation', command: 'prepare-prd-understanding' },
      metrics: { generatorCalls: 0, humanInteractions: 0, elapsedMs: expect.any(Number) } })
    expect(commands).toEqual(['create-run', 'configure-target', 'get-status'])
  })

  test('frozen replay 不调用生成器，只返回当次 probe/approval/lease 的下一合法边', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => success(request.requestId,
      statusResult(handle, false, { command: 'probe-target', from: 'preflight-readonly',
        expectedState: 'preflight-readonly' }))) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => 'REQUEST-REPLAY-1' })
    const generator = vi.fn()

    await expect(facade.replayRegression({ handle, generator })).resolves.toMatchObject({
      status: 'pending-decision', pending: { kind: 'target-probe' }, metrics: { generatorCalls: 0 },
    })
    expect(generator).not.toHaveBeenCalled()
  })

  test('cancel 与 health 通过公开 Facade 调用 Runtime，不由 Facade 推断副作用状态', async () => {
    const handle = { assetId: 'ASSET-1', runId: 'RUN-1', revision: 2, generationDigest: d('1') }
    const commands: string[] = []
    const host = { handle: vi.fn(async (request: RuntimeRequestEnvelope) => {
      commands.push(request.command)
      if (request.command === 'get-status') return success(request.requestId, statusResult(handle))
      if (request.command === 'cancel-run') return success(request.requestId, {
        schemaVersion: 'run-cancellation-result/v1', runId: 'RUN-1', requestId: request.requestId,
        phase: 'read-running', disposition: 'cancelling', repeated: false, cleanupRequired: false,
        requestedAt: '2026-08-12T00:00:00.000Z',
      })
      if (request.command === 'get-health') return success(request.requestId, {
        schemaVersion: 'run-health-snapshot/v1', runId: 'RUN-1', observedWorkflowState: 'running-real',
        observedWorkflowSequence: 9, lastProgressAt: '2026-08-12T00:00:00.000Z', status: 'cancelling',
        active: { attemptId: 'ATTEMPT-1' }, cancel: { requested: true, phase: 'read-running' },
        cleanup: { status: 'not-applicable', residualCount: 0 }, resources: { queueDepth: 0, lockCount: 1,
          gatewayReservations: 0, childProcesses: 1, rssBytes: 0, evidenceBytes: 0 },
      })
      throw new Error(request.command)
    }) }
    const facade = new E2EFacade({ projectRoot: '/project', host,
      requestId: () => `REQUEST-${commands.length + 1}` })
    await expect(facade.cancel(handle)).resolves.toMatchObject({ disposition: 'cancelling' })
    await expect(facade.health(handle)).resolves.toMatchObject({ status: 'cancelling' })
    expect(commands).toEqual(['get-status', 'cancel-run', 'get-status', 'get-health'])
  })
})

function success(requestId: string, result: unknown): RuntimeResponseEnvelope {
  return RuntimeResponseEnvelopeSchema.parse({
    schemaVersion: '1.0.0', requestId,
    runtime: { version: '0.5.0', installationDigest: d('9') }, ok: true, result,
  })
}

function statusResult(handle: { assetId: string; runId: string; revision: number; generationDigest: string },
  blocked = true, nextEdge?: Record<string, unknown>) {
  return JSON.parse(canonicalizeJson({
    runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('2'),
    runtimeInstallationDigest: d('9'), generationId: 'RUN-1', prdRevision: d('3'),
    workflow: { current: 'preflight-readonly', sequence: 5, eventChainDigest: d('4') },
    artifactDigests: { 'prd-source': d('3') }, state: 'preflight-readonly',
    nextEdge: nextEdge ?? (blocked ? { command: 'run-preflight', from: 'preflight-readonly',
      expectedState: 'preflight-readonly' } : { command: 'compile-executable-run', from: 'preflight-readonly',
      expectedState: 'preflight-readonly' }),
    verifiedDigests: { runtimeInstallation: d('9'), workflowEventChain: d('4') },
    minimumMissingInput: blocked ? ['browser-preflight-retry:E2E_RUNTIME_PAGE_MISMATCH']
      : ['declarative-execution-binding'],
    handle, stage: 'preflight', condition: blocked
      ? { kind: 'blocked-retryable', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', resumeStage: 'preflight' }
      : { kind: 'ready' },
    preservedAssets: ['prd-source'], invalidatedAssets: [], semanticCases: [], remediation: [],
    ...(blocked ? { preflightBlocker: { status: 'environment-blocked',
      reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', blockedAt: '2026-08-02T00:00:00.000Z',
      attemptCount: 1, resumeState: 'preflight-readonly' } } : {}),
  }))
}
