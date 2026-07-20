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

  test.each([
    ['material', 'E2E_RUNTIME_FINALIZATION_MATERIAL_FAILED'],
    ['compile', 'E2E_RUNTIME_FINALIZATION_COMPILE_FAILED'],
    ['publish', 'E2E_RUNTIME_FINALIZATION_PUBLISH_FAILED'],
    ['readback', 'E2E_RUNTIME_FINALIZATION_READBACK_FAILED'],
    ['erasure', 'E2E_RUNTIME_FINALIZATION_ERASURE_FAILED'],
  ] as const)('%s 边界的普通异常转换为固定安全码且不暴露原始消息', async (stage, code) => {
    const active = { generationId: 'RUN-1', generationDigest: digest('4'), terminalVerdict: 'accepted' as const }
    const fail = async () => { throw new Error('secret path: /Users/example/.ssh/id_rsa') }
    const finalizer = new ProductionGenerationFinalizer({
      materialProvider: { prepare: stage === 'material' ? fail : async () => ({
        compilerInput: {} as never, bind: () => ({}) as never, release() {},
      }) },
      regressionPublisher: { compile: stage === 'compile' ? fail : async () => ({}) as never },
      assembler: {} as never,
      projectPublisher: {
        publish: stage === 'publish' ? fail : async () => active,
        readActiveGeneration: stage === 'readback' ? fail : async () => active,
      },
      quarantine: {
        destroyAfterPublication: stage === 'erasure' ? fail : async () => undefined,
        resumePendingErasure: async () => [],
      },
    } as never)

    const error = await executeRuntimeGenerationFinalization(finalizer.capability(), input(false))
      .then(() => undefined, (cause: unknown) => cause as Error & { code?: string })
    expect(error).toMatchObject({ code })
    expect(error?.message).not.toContain('.ssh')
  })

  test('publisher 回调中的组装异常与原子发布异常分开分类', async () => {
    const active = { generationId: 'RUN-1', generationDigest: digest('4'), terminalVerdict: 'accepted' as const }
    const finalizer = new ProductionGenerationFinalizer({
      materialProvider: { prepare: async () => ({
        compilerInput: {} as never,
        bind: () => ({}) as never,
        release() {},
      }) },
      regressionPublisher: { compile: async () => ({}) as never },
      assembler: { finalize: () => { throw new Error('invalid assembled draft') } },
      projectPublisher: {
        publish: async (request: { prepare(input: { fencingToken: number }): Promise<unknown> }) => {
          await request.prepare({ fencingToken: 1 })
          return active
        },
        readActiveGeneration: async () => active,
      },
      quarantine: { destroyAfterPublication: async () => undefined, resumePendingErasure: async () => [] },
    } as never)

    await expect(executeRuntimeGenerationFinalization(finalizer.capability(), input(false)))
      .rejects.toMatchObject({ code: 'E2E_RUNTIME_FINALIZATION_ASSEMBLE_FAILED' })
  })

  test('旧构建器 Error 消息只投影开头的固定 E2E 码并丢弃后续详情', async () => {
    const active = { generationId: 'RUN-1', generationDigest: digest('4'), terminalVerdict: 'accepted' as const }
    const finalizer = new ProductionGenerationFinalizer({
      materialProvider: { prepare: async () => ({
        compilerInput: {} as never, bind: () => ({}) as never, release() {},
      }) },
      regressionPublisher: { compile: async () => ({}) as never },
      assembler: { finalize: () => {
        throw new Error('E2E_GENERATION_TEST_FAILURE:DETAIL:/Users/example/.ssh/id_rsa')
      } },
      projectPublisher: {
        publish: async (request: { prepare(input: { fencingToken: number }): Promise<unknown> }) => {
          await request.prepare({ fencingToken: 1 }); return active
        },
        readActiveGeneration: async () => active,
      },
      quarantine: { destroyAfterPublication: async () => undefined, resumePendingErasure: async () => [] },
    } as never)

    const error = await executeRuntimeGenerationFinalization(finalizer.capability(), input(false))
      .then(() => undefined, (cause: unknown) => cause as Error & { code?: string })
    expect(error).toMatchObject({
      code: 'E2E_GENERATION_TEST_FAILURE_DETAIL', message: 'E2E_GENERATION_TEST_FAILURE_DETAIL',
    })
    expect(error?.message).not.toContain('.ssh')
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
