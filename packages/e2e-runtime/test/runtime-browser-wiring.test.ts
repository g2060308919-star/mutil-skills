import { describe, expect, test, vi } from 'vitest'
import {
  consumeRpcConnectionCredential,
  createRuntimeFixedHttpWriteEvidence,
  settleRuntimeBrowserResourcesThenRecordProof,
  settleRuntimeBrowserResources,
} from '../src/runtime-browser-wiring.js'

describe('Runtime browser production wiring cleanup', () => {
  test('固定 HTTP write 从真实 transport observation 生成可隔离的确定性证据', () => {
    const result = createRuntimeFixedHttpWriteEvidence({
      actionId: 'ACTION-WRITE-1',
      observations: [
        { status: 201, bodyDigest: `sha256:${'1'.repeat(64)}` },
        { status: 200, bodyDigest: `sha256:${'2'.repeat(64)}` },
        { status: 204, bodyDigest: `sha256:${'3'.repeat(64)}` },
        { status: 404, bodyDigest: `sha256:${'4'.repeat(64)}` },
      ],
      matches: [true, true, true, true], cleanupStatus: 'verified-clean',
      screenshot: Uint8Array.from([137, 80, 78, 71]),
    })

    expect(result.evidenceId).toBe('EVIDENCE-ACTION-WRITE-1')
    expect(JSON.parse(Buffer.from(result.evidence.dom).toString('utf8'))).toMatchObject({
      format: 'dom-tree/1', roots: [{ tag: 'main', assertionRelevant: true }],
    })
    expect(Buffer.from(result.evidence.dom).toString('utf8')).not.toContain('SECRET-CANARY')
    expect(result.evidence.screenshot).toEqual(Uint8Array.from([137, 80, 78, 71]))
  })
  test('并行尝试全部清理并在主操作同时失败时保留聚合 cause', async () => {
    const calls: string[] = []
    const primary = new Error('primary execution failure')
    const browserFailure = new Error('browser cleanup failure')
    const gatewayFailure = new Error('gateway cleanup failure')

    const failure = await settleRuntimeBrowserResources(primary, [
      async () => { calls.push('browser'); throw browserFailure },
      async () => { calls.push('gateway'); throw gatewayFailure },
      async () => { calls.push('authority') },
    ]).catch((error: unknown) => error)

    expect(calls).toEqual(['browser', 'gateway', 'authority'])
    expect(failure).toMatchObject({ code: 'E2E_RUNTIME_CLEANUP_FAILED', category: 'safety' })
    expect((failure as { cause: AggregateError }).cause.errors)
      .toEqual([primary, browserFailure, gatewayFailure])
  })

  test('清理全部成功时不掩盖主流程，由调用方继续传播原错误', async () => {
    const cleanup = vi.fn(async () => undefined)
    await expect(settleRuntimeBrowserResources(new Error('primary'), [cleanup])).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  test('普通 Browser 会话只有 Browser/Gateway/Authority cleanup 全成功后才刷新 capability proof', async () => {
    const proof = { runtimeInstallationDigest: 'proof-canary' } as never
    for (const failingCleanup of [0, 1, 2]) {
      const calls: string[] = []
      const recordProof = vi.fn(async () => { calls.push('proof'); return proof })
      await expect(settleRuntimeBrowserResourcesThenRecordProof(
        undefined,
        ['browser', 'gateway', 'authority'].map((name, index) => async () => {
          calls.push(name)
          if (index === failingCleanup) throw new Error(`${name} cleanup failed`)
        }),
        proof,
        recordProof,
      )).rejects.toMatchObject({ code: 'E2E_RUNTIME_CLEANUP_FAILED' })
      expect(calls).toEqual(['browser', 'gateway', 'authority'])
      expect(recordProof).not.toHaveBeenCalled()
    }

    const calls: string[] = []
    const recordProof = vi.fn(async () => { calls.push('proof'); return proof })
    await expect(settleRuntimeBrowserResourcesThenRecordProof(
      undefined,
      ['browser', 'gateway', 'authority'].map((name) => async () => { calls.push(name) }),
      proof,
      recordProof,
    )).resolves.toBeUndefined()
    expect(calls).toEqual(['browser', 'gateway', 'authority', 'proof'])
    expect(recordProof).toHaveBeenCalledOnce()
  })

  test('Authority RPC connection 的临时 session key 在 client 构造成功和异常时都立即清除', () => {
    for (const shouldThrow of [false, true]) {
      const connection = { credential: { sessionKeyBase64Url: 'SECRET-CANARY' } }
      const invoke = () => consumeRpcConnectionCredential(connection, () => {
        if (shouldThrow) throw new Error('client construction failed')
        return 'client'
      })
      if (shouldThrow) expect(invoke).toThrow('client construction failed')
      else expect(invoke()).toBe('client')
      expect(connection.credential.sessionKeyBase64Url).toBe('')
    }
  })
})
