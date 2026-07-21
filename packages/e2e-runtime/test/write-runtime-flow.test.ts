import { describe, expect, test, vi } from 'vitest'
import { RuntimeExecutionBatch } from '../src/runtime-execution-batch.js'
import { executeSecretTemplateAtBridge } from '../src/secret-template.js'
import {
  GatewayCleanupTransport,
  authorizeGatewayCleanupTransport,
} from '../src/gateway-cleanup-transport.js'
import {
  TrustedActionRunner,
  authorizeRuntimeWriteExecutor,
} from '../src/trusted-action-runner.js'
import { realWriteOutput, runtimeWriteDigest } from './runtime-write-fixtures.js'
import { executeWriteFixtureFlow } from './fixtures.js'

describe('write Runtime vertical flow', () => {
  test('真实 Local Authority/Lease/Gateway 仅在 signed outcome 与 verified cleanup 后通过', async () => {
    const flow = await executeWriteFixtureFlow({ effectObservation: 'applied', cleanupStatus: 'verified-clean' })
    expect(flow.result).toMatchObject({ status: 'passed', effectObservation: 'applied' })
    expect(flow.result.outcomeDigest).toMatch(/^sha256:/)
    expect(flow.gatewayAudit.capabilityReservations).toEqual([
      expect.objectContaining({ actionId: 'ACTION-ORDER-UPDATE', status: 'completed' }),
    ])
    expect(flow.cleanup.status).toBe('verified-clean')
    expect(flow.lease.status).toBe('released')
    expect(flow.upstreamWriteCount).toBe(1)
  })

  test('真实 effect unknown 禁止自动重试并 quarantine lease', async () => {
    const flow = await executeWriteFixtureFlow({ effectObservation: 'unknown', cleanupStatus: 'unknown' })
    expect(flow.result.status).toBe('safety-blocked')
    expect(flow.retryDecision).toMatchObject({ allowed: false })
    expect(flow.resumeAutomatically).toBe(false)
    expect(flow.lease.status).toBe('quarantined')
  })
  test('真实 write 结果携带 reservation/outcome commit 与 cleanup lease receipt 进入独立 domain', async () => {
    const execute = vi.fn(async () => realWriteOutput())
    const batch = new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-1' })

    const output = await new TrustedActionRunner().executeWrite({
      executor: authorizeRuntimeWriteExecutor(execute),
      batch,
      runId: 'RUN-1',
      attemptId: 'ATTEMPT-1',
      caseId: 'CASE-1',
      actionId: 'ACTION-WRITE-1',
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(output.gatewayCommit).toMatchObject({ committed: true, reservationId: 'RESERVATION-WRITE-1' })
    expect(batch.getRealWrite('ACTION-WRITE-1')).toEqual(output)
    expect(batch.getInjection('ACTION-WRITE-1')).toBeUndefined()
    expect(batch.canAutoRetry).toBe(true)
  })

  test('effect unknown 一经提交即禁止自动重试且不能被第二次结果覆盖', async () => {
    const unknown = realWriteOutput({
      status: 'environment-blocked',
      effectObservation: 'unknown',
      resultDigest: runtimeWriteDigest('effect-unknown'),
      gatewayCommit: {
        reservationId: 'RESERVATION-WRITE-1',
        reservationReceiptDigest: runtimeWriteDigest('reservation-receipt'),
        outcomeReceiptDigest: runtimeWriteDigest('unknown-receipt'),
        committed: true,
      },
      cleanup: {
        status: 'unknown',
        resultDigest: runtimeWriteDigest('cleanup-unknown'),
        leaseReceiptDigest: runtimeWriteDigest('lease-quarantine-receipt'),
      },
    })
    const batch = new RuntimeExecutionBatch({ runId: 'RUN-1', attemptId: 'ATTEMPT-2' })
    await new TrustedActionRunner().executeWrite({
      executor: authorizeRuntimeWriteExecutor(async () => unknown as never), batch,
      runId: 'RUN-1', attemptId: 'ATTEMPT-2', caseId: 'CASE-1', actionId: 'ACTION-WRITE-1',
    })

    expect(batch.canAutoRetry).toBe(false)
    expect(batch.retryBlockReason).toBe('E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED')
    expect(() => batch.commitRealWrite(realWriteOutput())).toThrow(/E2E_RUNTIME_EXECUTION_RESULT_ALREADY_COMMITTED/)
  })

  test('SecretTemplate 仅接受 literal/secretRef，在 Bridge dispatch 前消费并在返回后清零', async () => {
    const secret = Buffer.from('TOKEN-123', 'utf8')
    let dispatchedView: Uint8Array | undefined
    const resolve = vi.fn(async () => Object.freeze({ handleId: 'HANDLE-1' }))
    const consume = vi.fn(async () => secret)

    const result = await executeSecretTemplateAtBridge({
      runId: 'RUN-1',
      template: [
        { kind: 'literal', value: 'Bearer ' },
        { kind: 'secretRef', secretRef: 'api-token', providerId: 'interactive' },
      ],
      broker: { resolve, consume },
      dispatch: async (payload) => {
        expect(Buffer.from(payload).toString('utf8')).toBe('Bearer TOKEN-123')
        dispatchedView = payload
        return 'sent'
      },
    })

    expect(result).toBe('sent')
    expect(resolve).toHaveBeenCalledWith({ runId: 'RUN-1', secretRef: 'api-token', providerId: 'interactive' })
    expect(consume).toHaveBeenCalledTimes(1)
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0))
    expect([...(dispatchedView ?? [])]).toEqual(new Array(dispatchedView?.byteLength ?? 0).fill(0))
    await expect(executeSecretTemplateAtBridge({
      runId: 'RUN-1', template: [{ kind: 'raw-secret', value: 'forbidden' }] as never,
      broker: { resolve, consume }, dispatch: async () => undefined,
    })).rejects.toMatchObject({ code: 'E2E_RUNTIME_SECRET_TEMPLATE_INVALID' })
  })

  test('cleanup 只能经已签发 Gateway transport，成功 release，失败 quarantine', async () => {
    const releaseLease = vi.fn(async () => runtimeWriteDigest('signed-release'))
    const quarantineLease = vi.fn(async () => runtimeWriteDigest('signed-quarantine'))
    const gateway = authorizeGatewayCleanupTransport(async () => ({
      status: 'verified-clean', resultDigest: runtimeWriteDigest('cleanup-result'),
    }))
    const transport = new GatewayCleanupTransport({
      gateway,
      authority: { releaseLease, quarantineLease },
    })
    const binding = {
      runId: 'RUN-1', actionId: 'ACTION-WRITE-1', cleanupPlanId: 'CLEANUP-1',
      cleanupPlanDigest: runtimeWriteDigest('cleanup-plan'), outcomeDigest: runtimeWriteDigest('write-outcome'),
      leaseId: 'LEASE-1', fencingToken: 1, targetFingerprint: runtimeWriteDigest('target'),
    }

    await expect(transport.execute(binding)).resolves.toEqual({
      status: 'verified-clean',
      resultDigest: runtimeWriteDigest('cleanup-result'),
      leaseReceiptDigest: runtimeWriteDigest('signed-release'),
    })
    expect(releaseLease).toHaveBeenCalledWith({
      leaseId: 'LEASE-1', fencingToken: 1, targetFingerprint: runtimeWriteDigest('target'),
      cleanupDigest: runtimeWriteDigest('cleanup-result'),
    })
    expect(quarantineLease).not.toHaveBeenCalled()

    const failed = new GatewayCleanupTransport({
      gateway: authorizeGatewayCleanupTransport(async () => ({
        status: 'unknown', resultDigest: runtimeWriteDigest('cleanup-unknown'),
      })),
      authority: { releaseLease, quarantineLease },
    })
    await expect(failed.execute(binding)).resolves.toEqual({
      status: 'unknown', resultDigest: runtimeWriteDigest('cleanup-unknown'),
      leaseReceiptDigest: runtimeWriteDigest('signed-quarantine'),
    })
    expect(quarantineLease).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'LEASE-1', reason: expect.stringContaining('CLEANUP-1'),
    }))
  })
})
