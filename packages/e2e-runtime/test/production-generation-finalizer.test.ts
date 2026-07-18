import { describe, expect, test, vi } from 'vitest'
import { executeRuntimeGenerationFinalization } from '../src/runtime-generation-finalizer.js'
import { ProductionGenerationFinalizer } from '../src/production-generation-finalizer.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'

const digest = (value: string) => `sha256:${value.repeat(64)}`

describe('ProductionGenerationFinalizer', () => {
  test('固定执行 material/sanitize → compile → assemble/publish → active readback → crypto-erasure', async () => {
    const order: string[] = []
    const release = vi.fn(() => { order.push('release') })
    const prepared = {
      compilerInput: {} as never,
      bind: vi.fn(() => {
        order.push('bind')
        return {
          context: {}, semanticDrafts: {}, execution: {}, gatewayAudit: {}, evidence: [], cleanup: [],
          provenance: {}, authorities: {},
        } as never
      }),
      release,
    }
    const dependencies = {
      materialProvider: { prepare: vi.fn(async () => { order.push('material'); return prepared }) },
      regressionPublisher: { compile: vi.fn(async () => {
        order.push('compile')
        return { compilerInputDigest: digest('1'), sourceSetDigest: digest('2'),
          discoveryAttestation: {}, caseIds: [], files: [], isolationProof: {
            backend: 'macos-sandbox-exec', proofDigest: digest('3'),
          } } as never
      }) },
      assembler: { finalize: vi.fn(() => { order.push('assemble'); return { terminalVerdict: 'accepted' } }) },
      projectPublisher: {
        publish: vi.fn(async (input: { prepare(value: { fencingToken: number }): unknown }) => {
          order.push('publish')
          input.prepare({ fencingToken: 9 })
          return { generationId: 'RUN-1', generationDigest: digest('4'), terminalVerdict: 'accepted' }
        }),
        readActiveGeneration: vi.fn(async () => {
          order.push('read-active')
          return { generationId: 'RUN-1', generationDigest: digest('4'), terminalVerdict: 'accepted' }
        }),
      },
      quarantine: {
        destroyAfterPublication: vi.fn(async () => { order.push('erase') }),
        resumePendingErasure: vi.fn(async () => []),
      },
    }
    const finalizer = new ProductionGenerationFinalizer(dependencies as never)
    const result = await executeRuntimeGenerationFinalization(finalizer.capability(), input(false))

    expect(result).toMatchObject({
      generationId: 'RUN-1', generationDigest: digest('4'), terminalVerdict: 'accepted',
    })
    expect(order).toEqual(['material', 'compile', 'publish', 'bind', 'assemble', 'read-active', 'erase', 'release'])
  })

  test('recovery 只复读已提交 active 并恢复 erasure；无 active 时禁止自动重新发布', async () => {
    const prepare = vi.fn()
    const compile = vi.fn()
    const publish = vi.fn()
    const readActiveGeneration = vi.fn(async () => ({
      generationId: 'RUN-1', generationDigest: digest('7'), terminalVerdict: 'rejected' as const,
    }))
    const resumePendingErasure = vi.fn(async () => ['RUN-1'])
    const finalizer = new ProductionGenerationFinalizer({
      materialProvider: { prepare }, regressionPublisher: { compile }, assembler: {} as never,
      projectPublisher: { publish, readActiveGeneration },
      quarantine: { destroyAfterPublication: vi.fn(), resumePendingErasure },
    } as never)

    await expect(executeRuntimeGenerationFinalization(finalizer.capability(), input(true)))
      .resolves.toMatchObject({ generationDigest: digest('7'), terminalVerdict: 'rejected' })
    expect(prepare).not.toHaveBeenCalled()
    expect(compile).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(resumePendingErasure).toHaveBeenCalledOnce()

    readActiveGeneration.mockResolvedValueOnce(undefined as never)
    await expect(executeRuntimeGenerationFinalization(finalizer.capability(), input(true)))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_FINALIZATION_PRIVACY_RECOVERY_REQUIRED' })
  })
})

function input(recovery: boolean) {
  return {
    projectRoot: '/project', snapshot: snapshot(), attemptId: 'FINALIZE-1',
    requestDigest: digest('9'), recovery,
  }
}

function snapshot(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.2.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: digest('a'), runtimeInstallationDigest: digest('b'), runRevision: 1,
    workflow: { current: 'finalizing', sequence: 1, eventChainDigest: digest('c') },
    artifactDigests: {}, frozenArtifacts: {}, trustedExecutionFacts: {}, writeAttempts: {},
    executionResults: { realEnvironment: {}, gatewayInjection: {} }, requestResponses: {},
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }
}
