import { expect, test, vi } from 'vitest'
import {
  authorityHostCleanupFailurePayload,
  closeAuthorityExecutionRpcHostResources,
} from '../src/authority-execution-rpc-host-lifecycle.js'

test('listen failure without an HTTP handle still destroys RPC keys and closes every other resource', async () => {
  const destroy = vi.fn()
  const approvalClose = vi.fn(() => { throw new Error('approval close failed') })
  const leaseClose = vi.fn()
  const revoke = vi.fn()
  const firstServerClose = vi.fn(async () => { throw new Error('approval server close failed') })
  const secondServerClose = vi.fn(async () => undefined)

  await expect(closeAuthorityExecutionRpcHostResources({
    webAuthnAuthority: { revokePendingSessions: revoke },
    approvalServers: [{ close: firstServerClose }, { close: secondServerClose }],
    executionRpc: { destroy },
    approvalAuthority: { close: approvalClose },
    leaseAuthority: { close: leaseClose },
  })).rejects.toMatchObject({
    message: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
    errors: [
      expect.objectContaining({ message: 'approval server close failed' }),
      expect.objectContaining({ message: 'approval close failed' }),
    ],
  })
  expect(revoke).toHaveBeenCalledOnce()
  expect(firstServerClose).toHaveBeenCalledOnce()
  expect(secondServerClose).toHaveBeenCalledOnce()
  expect(destroy).toHaveBeenCalledOnce()
  expect(approvalClose).toHaveBeenCalledOnce()
  expect(leaseClose).toHaveBeenCalledOnce()
})

test('cleanup IPC exposes only stable E2E cause codes', () => {
  expect(authorityHostCleanupFailurePayload(new AggregateError([
    Object.assign(new Error('stable'), { code: 'E2E_RPC_CLOSE_FAILED' }),
    Object.assign(new Error('platform'), { code: 'EACCES' }),
    new Error('untyped'),
  ]))).toEqual({
    code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
    causes: [
      'E2E_RPC_CLOSE_FAILED',
      'E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE',
      'E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE',
    ],
  })
})
