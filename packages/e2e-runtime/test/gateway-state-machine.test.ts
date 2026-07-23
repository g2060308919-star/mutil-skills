import { describe, expect, test, vi } from 'vitest'
import type { ReversibleWriteGateway } from '@mutil-skills/e2e-gateway'
import type { ExecutionOutcomeReceipt } from '@mutil-skills/e2e-contracts'
import { GatewayWriteStateCoordinator } from '../src/gateway-write-state.js'
import { freezeDrainAndFinalize } from '../src/gateway-finalization.js'
import {
  sseUnsupportedDisposition,
  websocketUnsupportedDisposition,
} from '../src/gateway-websocket-transport.js'

describe('Gateway write 终态协调器', () => {
  test('finalize 在首个 await 前 claim，child-exit unknown 只能等待同一终态', async () => {
    const completion = deferred<{ outcome: ExecutionOutcomeReceipt; authorityReceiptDigest: string }>()
    const complete = vi.fn(async () => await completion.promise)
    const unknown = vi.fn(async () => undefined)
    const coordinator = new GatewayWriteStateCoordinator()
    const gateway = fakeWriteGateway(complete, unknown)
    coordinator.observeReservation('REQ-1', 'CAP-1', gateway)
    coordinator.observeTransport('REQ-1')

    const finalized = coordinator.finalize('CAP-1', {} as never)
    const childExitSettlement = coordinator.settleAllUnknown('child-exit')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(unknown).not.toHaveBeenCalled()
    completion.resolve({ outcome: { signedDigest: 'receipt' } as ExecutionOutcomeReceipt,
      authorityReceiptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })

    await expect(childExitSettlement).resolves.toBeUndefined()
    expect(coordinator.unsettledCount).toBe(0)
    await expect(finalized).resolves.toMatchObject({ outcome: { signedDigest: 'receipt' } })
    expect(unknown).not.toHaveBeenCalled()
  })

  test('unknown 在首个 await 前 claim，并发 finalize 不会 complete 同一 reservation', async () => {
    const marking = deferred<void>()
    const complete = vi.fn(async () => ({ outcome: { signedDigest: 'receipt' } as ExecutionOutcomeReceipt,
      authorityReceiptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
    const unknown = vi.fn(async () => await marking.promise)
    const coordinator = new GatewayWriteStateCoordinator()
    coordinator.observeReservation('REQ-2', 'CAP-2', fakeWriteGateway(complete, unknown))
    coordinator.observeTransport('REQ-2')

    const marked = coordinator.markCapabilityUnknown('CAP-2', 'close')
    await expect(coordinator.finalize('CAP-2', {} as never))
      .rejects.toThrowError(/E2E_GATEWAY_WRITE_TRANSPORT_NOT_OBSERVED/)
    expect(complete).not.toHaveBeenCalled()
    expect(unknown).toHaveBeenCalledTimes(1)
    marking.resolve()
    await marked
    expect(coordinator.unsettledCount).toBe(0)
  })

  test('child exit 会立即 claim 全部 reserved write，并等待 Authority unknown 完成', async () => {
    const marking = deferred<void>()
    const unknown = vi.fn(async () => await marking.promise)
    const coordinator = new GatewayWriteStateCoordinator()
    coordinator.observeReservation('REQ-3', 'CAP-3', fakeWriteGateway(vi.fn(), unknown))

    const settlement = coordinator.settleAllUnknown('gateway-child-disconnected-before-response')
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(coordinator.unsettledCount).toBe(1)
    marking.resolve()
    await settlement
    expect(coordinator.unsettledCount).toBe(0)
  })

  test('多步请求全部 transport observed 且 policy sequence complete 后才允许 finalize', async () => {
    let sequenceComplete = false
    const complete = vi.fn(async () => ({ outcome: { signedDigest: 'receipt' } as ExecutionOutcomeReceipt,
      authorityReceiptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
    const coordinator = new GatewayWriteStateCoordinator()
    const gateway = fakeWriteGateway(complete, vi.fn(), () => sequenceComplete)
    coordinator.observeReservation('REQ-A', 'CAP-MULTI', gateway)
    coordinator.observeReservation('REQ-B', 'CAP-MULTI', gateway)

    coordinator.observeTransport('REQ-A')
    await expect(coordinator.finalize('CAP-MULTI', {} as never))
      .rejects.toThrowError(/E2E_GATEWAY_WRITE_TRANSPORT_NOT_OBSERVED/)
    sequenceComplete = true
    coordinator.observeTransport('REQ-B')
    await expect(coordinator.finalize('CAP-MULTI', {} as never))
      .resolves.toMatchObject({ outcome: { signedDigest: 'receipt' } })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  test('任一 outstanding request abort 会将整个 reservation claim unknown 并清除全部 requestId', async () => {
    const unknown = vi.fn(async () => undefined)
    const coordinator = new GatewayWriteStateCoordinator()
    const gateway = fakeWriteGateway(vi.fn(), unknown, () => false)
    coordinator.observeReservation('REQ-C', 'CAP-ABORT', gateway)
    coordinator.observeReservation('REQ-D', 'CAP-ABORT', gateway)

    await coordinator.markRequestUnknown('REQ-C', 'abort')
    await coordinator.markRequestUnknown('REQ-D', 'duplicate-abort-event')
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(coordinator.unsettledCount).toBe(0)
  })

  test('上游 response observed 后下游 abort 仍可定位同一 reservation 并标 unknown', async () => {
    const unknown = vi.fn(async () => undefined)
    const coordinator = new GatewayWriteStateCoordinator()
    const gateway = fakeWriteGateway(vi.fn(), unknown)
    coordinator.observeReservation('REQ-DOWNSTREAM', 'CAP-DOWNSTREAM', gateway)
    coordinator.observeTransport('REQ-DOWNSTREAM')

    await coordinator.markRequestUnknown('REQ-DOWNSTREAM', 'downstream-aborted-after-upstream-response')
    expect(unknown).toHaveBeenCalledTimes(1)
    await expect(coordinator.finalize('CAP-DOWNSTREAM', {} as never))
      .rejects.toThrowError(/E2E_GATEWAY_WRITE_CAPABILITY_NOT_ACTIVE/)
  })
})

test('publication 严格执行 freeze/drain → child settlement → terminal assertion → audit', async () => {
  const calls: string[] = []
  await expect(freezeDrainAndFinalize({
    freezeAndDrain: async () => { calls.push('freeze-drain') },
    waitForTerminalSettlement: async () => { calls.push('terminal-settlement') },
    assertWritesTerminal: () => { calls.push('terminal-assertion') },
    signAudit: () => { calls.push('sign-audit'); return 'audit' },
  })).resolves.toBe('audit')
  expect(calls).toEqual(['freeze-drain', 'terminal-settlement', 'terminal-assertion', 'sign-audit'])
})

test('terminal/write settlement 未完成或失败时 finalize 不得签 audit', async () => {
  const terminal = deferred<void>()
  const sign = vi.fn(() => 'audit')
  const finalization = freezeDrainAndFinalize({
    freezeAndDrain: async () => undefined,
    waitForTerminalSettlement: async () => await terminal.promise,
    assertWritesTerminal: () => undefined,
    signAudit: sign,
  })
  await Promise.resolve()
  expect(sign).not.toHaveBeenCalled()
  terminal.resolve()
  await expect(finalization).resolves.toBe('audit')
  expect(sign).toHaveBeenCalledTimes(1)

  const rejectedSign = vi.fn(() => 'must-not-sign')
  await expect(freezeDrainAndFinalize({
    freezeAndDrain: async () => undefined,
    waitForTerminalSettlement: async () => undefined,
    assertWritesTerminal: () => { throw new Error('terminal owner pending') },
    signAudit: rejectedSign,
  })).rejects.toThrowError(/terminal owner pending/)
  expect(rejectedSign).not.toHaveBeenCalled()
})

test.each(['pass-through', 'http-response', 'connection-reset', 'timeout'] as const)(
  '没有转发前 frame hook 时 WebSocket %s behavior 固定 fail closed 且不 reserve',
  (behavior) => {
    expect(websocketUnsupportedDisposition(behavior)).toEqual({
      selectMatchedRule: true,
      reserveCapability: false,
      auditDecision: 'blocked',
      status: 501,
      code: 'E2E_GATEWAY_WEBSOCKET_BRIDGE_UNAVAILABLE',
    })
  },
)

test('SSE 在真实 stream 终态桥完成前固定阻塞且不消费 reservation', () => {
  expect(sseUnsupportedDisposition()).toEqual({
    status: 501,
    code: 'E2E_GATEWAY_SSE_BRIDGE_UNAVAILABLE',
    reserveCapability: false,
    auditDecision: 'blocked',
  })
})

function fakeWriteGateway(
  completeWithExecutionOutcomeResult: (...args: any[]) => Promise<{
    outcome: ExecutionOutcomeReceipt; authorityReceiptDigest: string
  }>,
  markUnknown: (...args: any[]) => Promise<void>,
  isRequestSequenceComplete: () => boolean = () => true,
): ReversibleWriteGateway {
  return { completeWithExecutionOutcomeResult, markUnknown, isRequestSequenceComplete } as unknown as ReversibleWriteGateway
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
