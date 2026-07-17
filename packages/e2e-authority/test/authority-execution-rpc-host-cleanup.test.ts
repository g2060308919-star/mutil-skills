import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

class NonTerminatingChild extends EventEmitter {
  pid = 4242
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => {
      callback?.(null)
      if ((message as { type?: unknown })?.type === 'start') {
        this.emit('message', { type: 'error', code: 'E2E_RPC_HOST_START_FAILED' })
      }
    })
    return true
  }

  kill(): boolean { return true }
}

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => new NonTerminatingChild()),
  spawn: vi.fn(() => new NonTerminatingChild()),
}))

import { startAuthorityExecutionRpcHostProcess } from '../src/authority-execution-rpc-host.js'

afterEach(() => { vi.useRealTimers() })

test('真实启动失败路径在 child 有界清理也失败时聚合保留两个错误', async () => {
  vi.useFakeTimers()
  const pending = startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  }).catch((error: unknown) => error)

  await vi.runAllTimersAsync()
  const result = await pending
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors).toEqual([
    expect.objectContaining({ code: 'E2E_RPC_HOST_START_FAILED' }),
    expect.objectContaining({ code: 'E2E_RPC_HOST_STOP_TIMEOUT' }),
  ])
  expect((result as Error).message).toBe('E2E_RPC_HOST_START_AND_CLEANUP_FAILED')
})
