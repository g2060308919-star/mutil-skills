import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

let childMode: 'startup-hang' | 'ready-cleanup-failure' | 'ready-cleanup-failure-hang' = 'startup-hang'

class NonTerminatingChild extends EventEmitter {
  pid = 4242
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => {
      callback?.(null)
      if ((message as { type?: unknown })?.type === 'start') {
        if (childMode === 'startup-hang') {
          this.emit('message', {
            type: 'startup-error', code: 'E2E_RPC_HOST_START_FAILED', cleanup: { ok: true },
          })
        } else {
          this.emit('message', {
            type: 'ready', endpoint: 'http://127.0.0.1:43210/v1/authority-rpc',
            verifierMaterial: {
              schemaVersion: '1.0.0', issuer: 'authority-host', keyId: 'rpc-key',
              purpose: 'authority-rpc-response/v1', algorithm: 'Ed25519',
              publicKeySpkiBase64Url: Buffer.from('public-key').toString('base64url'),
              publicKeyDigest: `sha256:${'a'.repeat(64)}`,
            },
          })
        }
      }
      if ((message as { type?: unknown })?.type === 'shutdown'
        && (childMode === 'ready-cleanup-failure' || childMode === 'ready-cleanup-failure-hang')) {
        const requestId = (message as { requestId: string }).requestId
        this.emit('message', {
          type: 'shutdown-result', requestId, ok: false,
          error: {
            code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
            causes: ['E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE'],
          },
        })
        if (childMode === 'ready-cleanup-failure') {
          this.connected = false
          this.exitCode = 1
          this.emit('disconnect')
          this.emit('exit', 1, null)
        }
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

afterEach(() => { vi.useRealTimers(); childMode = 'startup-hang' })

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

test('显式 close 等待严格 shutdown IPC，并保留 child cleanup cause codes', async () => {
  childMode = 'ready-cleanup-failure'
  const host = await startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  })

  await expect(host.close()).rejects.toMatchObject({
    message: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
    errors: [expect.objectContaining({ code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE' })],
  })
  expect(host.credential.sessionKeyBase64Url).toBe('')
})

test('cleanup 已失败且 child 仍无法回收时同时保留 cleanup 与 stop timeout', async () => {
  vi.useFakeTimers()
  childMode = 'ready-cleanup-failure-hang'
  const host = await startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  })
  const closing = host.close().catch((error: unknown) => error)
  await vi.runAllTimersAsync()

  const error = await closing
  expect(error).toMatchObject({
    message: 'E2E_RPC_HOST_CLEANUP_AND_STOP_FAILED',
    errors: [
      expect.objectContaining({ message: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED' }),
      expect.objectContaining({ code: 'E2E_RPC_HOST_STOP_TIMEOUT' }),
    ],
  })
})
