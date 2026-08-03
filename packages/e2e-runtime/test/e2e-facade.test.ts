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
})

function success(requestId: string, result: unknown): RuntimeResponseEnvelope {
  return RuntimeResponseEnvelopeSchema.parse({
    schemaVersion: '1.0.0', requestId,
    runtime: { version: '0.5.0', installationDigest: d('9') }, ok: true, result,
  })
}

function statusResult(handle: { assetId: string; runId: string; revision: number; generationDigest: string },
  blocked = true) {
  return JSON.parse(canonicalizeJson({
    runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('2'),
    runtimeInstallationDigest: d('9'), generationId: 'RUN-1', prdRevision: d('3'),
    workflow: { current: 'preflight-readonly', sequence: 5, eventChainDigest: d('4') },
    artifactDigests: { 'prd-source': d('3') }, state: 'preflight-readonly',
    nextEdge: blocked ? { command: 'run-preflight', from: 'preflight-readonly',
      expectedState: 'preflight-readonly' } : { command: 'submit-candidate', from: 'preflight-readonly',
      expectedState: 'preflight-readonly' },
    verifiedDigests: { runtimeInstallation: d('9'), workflowEventChain: d('4') },
    minimumMissingInput: blocked ? ['browser-preflight-retry:E2E_RUNTIME_PAGE_MISMATCH'] : [],
    handle, stage: 'preflight', condition: blocked
      ? { kind: 'blocked-retryable', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', resumeStage: 'preflight' }
      : { kind: 'ready' },
    preservedAssets: ['prd-source'], invalidatedAssets: [], semanticCases: [], remediation: [],
    ...(blocked ? { preflightBlocker: { status: 'environment-blocked',
      reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', blockedAt: '2026-08-02T00:00:00.000Z',
      attemptCount: 1, resumeState: 'preflight-readonly' } } : {}),
  }))
}
