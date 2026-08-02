import { describe, expect, test, vi } from 'vitest'
import {
  RuntimeResponseEnvelopeSchema,
  canonicalizeJson,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
} from '@mutil-skills/e2e-contracts'
import { E2EFacade, E2EFacadeError } from '../src/e2e-facade.js'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('E2EFacade', () => {
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
      runtime: { version: '0.4.7', installationDigest: d('9') }, ok: false,
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
})

function success(requestId: string, result: unknown): RuntimeResponseEnvelope {
  return RuntimeResponseEnvelopeSchema.parse({
    schemaVersion: '1.0.0', requestId,
    runtime: { version: '0.4.7', installationDigest: d('9') }, ok: true, result,
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
