import { expect, test, vi } from 'vitest'
import { closeAuthorityExecutionRpcHostResources } from '../src/authority-execution-rpc-host-lifecycle.js'

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
