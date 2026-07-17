import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

let childMode: 'startup-hang' | 'ready-cleanup-failure' | 'ready-cleanup-failure-hang'
  | 'ready-cleanup-success' | 'ready-terminal-cleanup' | 'ready-organic-disconnect'
  | 'startup-disconnect-exit1' | 'startup-disconnect-exit0'
  | 'startup-disconnect-error' | 'startup-disconnect-only' = 'startup-hang'
let lastChild: NonTerminatingChild | undefined

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
        } else if (childMode.startsWith('startup-disconnect')) {
          this.connected = false
          this.emit('disconnect')
          queueMicrotask(() => {
            if (childMode === 'startup-disconnect-error') {
              this.emit('message', {
                type: 'startup-error', code: 'E2E_RPC_HOST_START_FAILED', cleanup: {
                  ok: false,
                  error: {
                    code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
                    causes: ['E2E_RPC_HOST_STARTUP_CLEANUP_CAUSE'],
                  },
                },
              })
              this.exitCode = 1
              this.emit('exit', 1, null)
            } else if (childMode !== 'startup-disconnect-only') {
              this.exitCode = childMode === 'startup-disconnect-exit1' ? 1 : 0
              this.emit('exit', this.exitCode, null)
            }
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
      if ((message as { type?: unknown })?.type === 'shutdown' && childMode === 'ready-cleanup-success') {
        const requestId = (message as { requestId: string }).requestId
        this.emit('message', { type: 'shutdown-result', requestId, ok: true })
        this.connected = false
        this.exitCode = 0
        this.emit('disconnect')
        this.emit('exit', 0, null)
      }
    })
    return true
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (childMode === 'startup-disconnect-only') {
      queueMicrotask(() => {
        this.signalCode = typeof signal === 'string' ? signal : null
        this.emit('exit', null, this.signalCode)
      })
    }
    if (childMode === 'ready-terminal-cleanup' && signal === 'SIGTERM') {
      queueMicrotask(() => {
        this.emit('message', {
          type: 'terminal-cleanup-error',
          error: {
            code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
            causes: ['E2E_RPC_HOST_SIGTERM_CLEANUP_CAUSE'],
          },
        })
        this.connected = false
        this.exitCode = 1
        this.emit('disconnect')
        this.emit('exit', 1, 'SIGTERM')
      })
    }
    return true
  }

  organicFailure(): void {
    this.connected = false
    this.emit('disconnect')
    queueMicrotask(() => {
      this.exitCode = 1
      this.emit('exit', 1, null)
    })
  }
}

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => (lastChild = new NonTerminatingChild())),
  spawn: vi.fn(() => (lastChild = new NonTerminatingChild())),
}))

import { startAuthorityExecutionRpcHostProcess } from '../src/authority-execution-rpc-host.js'

afterEach(() => { vi.useRealTimers(); childMode = 'startup-hang'; lastChild = undefined; vi.restoreAllMocks() })

test('parent zeroizes its temporary state-key serialization buffer without mutating caller memory', async () => {
  childMode = 'ready-cleanup-success'
  const stateEncryptionKey = new Uint8Array(32).fill(7)
  const fill = vi.spyOn(Buffer.prototype, 'fill')
  const host = await startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey, testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  })

  expect([...stateEncryptionKey]).toEqual(new Array(32).fill(7))
  expect(fill.mock.instances.some((buffer) =>
    buffer.byteLength === 32 && [...buffer].every((byte) => byte === 0))).toBe(true)
  await host.close()
})

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

test.each([
  ['startup-disconnect-exit1', 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED'],
  ['startup-disconnect-exit0', 'E2E_RPC_HOST_EXITED'],
] as const)('startup disconnect waits for exit and maps %s deterministically', async (mode, code) => {
  childMode = mode
  await expect(startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  })).rejects.toMatchObject({ code })
})

test('strict startup-error wins after disconnect and preserves startup plus child cleanup', async () => {
  childMode = 'startup-disconnect-error'
  const result = await startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  }).catch((error: unknown) => error)

  expect(result).toMatchObject({
    message: 'E2E_RPC_HOST_START_AND_CLEANUP_FAILED',
    errors: [
      expect.objectContaining({ code: 'E2E_RPC_HOST_START_FAILED' }),
      expect.objectContaining({ code: 'E2E_RPC_HOST_STARTUP_CLEANUP_CAUSE' }),
    ],
  })
})

test('disconnect without exit or startup-error remains pending until the startup timeout', async () => {
  vi.useFakeTimers()
  childMode = 'startup-disconnect-only'
  const pending = startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  }).catch((error: unknown) => error)
  await vi.runAllTimersAsync()

  await expect(pending).resolves.toMatchObject({ code: 'E2E_RPC_HOST_START_TIMEOUT' })
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

test('SIGTERM terminal cleanup envelope preserves child causes alongside the stop failure', async () => {
  vi.useFakeTimers()
  childMode = 'ready-terminal-cleanup'
  const host = await startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  })
  const closing = host.close().catch((error: unknown) => error)
  await vi.runAllTimersAsync()

  expect(await closing).toMatchObject({
    message: 'E2E_RPC_HOST_CLEANUP_AND_STOP_FAILED',
    errors: [
      {
        message: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
        errors: [expect.objectContaining({ code: 'E2E_RPC_HOST_SIGTERM_CLEANUP_CAUSE' })],
      },
      expect.objectContaining({ code: 'E2E_RPC_HOST_SHUTDOWN_RESULT_MISSING' }),
    ],
  })
})

test('organic disconnect waits for a nonzero exit and reports stable cleanup failure', async () => {
  childMode = 'ready-organic-disconnect'
  const host = await startAuthorityExecutionRpcHostProcess({
    rpc: { issuer: 'authority-host', keyId: 'rpc-key', clientId: 'runner' },
    approval: { issuer: 'authority', keyId: 'approval-key', statePath: 'approval.sqlite',
      stateEncryptionKey: Buffer.alloc(32, 7), testWorkspaceRoots: [process.cwd()] },
    lease: { statePath: 'lease.sqlite', testWorkspaceRoots: [process.cwd()] },
    clock: { kind: 'fixed-test-only', now: '2026-07-17T00:00:00.000Z' },
  })
  lastChild!.organicFailure()
  await new Promise<void>((resolve) => setImmediate(resolve))

  await expect(host.close()).rejects.toMatchObject({
    message: 'E2E_RPC_HOST_RESOURCE_CLEANUP_FAILED',
    errors: [expect.objectContaining({ code: 'E2E_RPC_HOST_RESOURCE_CLEANUP_CAUSE' })],
  })
})
