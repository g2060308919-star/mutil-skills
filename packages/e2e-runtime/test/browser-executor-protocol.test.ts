import { digestText, type BrowserExecutorDescriptorV1 } from '@mutil-skills/e2e-contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  adaptRuntimeFullPlaywrightExecutorV1,
  adaptRuntimeInjectionExecutorV1,
  adaptRuntimePreflightExecutorV1,
  adaptRuntimeReadExecutorV1,
  adaptRuntimeWriteExecutorV1,
  adaptTargetProbeExecutorV1,
  assertLegacyBrowserExecutorSemanticEquivalentV1,
  describeBrowserExecutorV1,
  executeBrowserExecutorV1,
  executeRuntimeReadWithBrowserExecutorProtocolV1,
  projectLegacyBrowserExecutorResultV1,
} from '../src/browser-executor-protocol.js'
import { authorizeRuntimeReadExecutor } from '../src/trusted-action-runner.js'
import { projectionFixture } from './trusted-action-runner.test.js'

const d = (label: string) => digestText('browser-executor-protocol-test/v1', label)

describe('BrowserExecutorProtocolV1 Runtime 适配', () => {
  it('为 Probe、Preflight、Read、Write、Injection、Full Playwright 提供统一发现面', () => {
    const descriptors = [
      adaptTargetProbeExecutorV1({} as never),
      adaptRuntimePreflightExecutorV1({} as never),
      adaptRuntimeReadExecutorV1({} as never),
      adaptRuntimeWriteExecutorV1({} as never),
      adaptRuntimeInjectionExecutorV1({} as never),
      adaptRuntimeFullPlaywrightExecutorV1({} as never),
    ].map(describeBrowserExecutorV1)
    expect(descriptors.map(({ kind }) => kind)).toEqual([
      'target-probe', 'preflight', 'read', 'reversible-write', 'injection', 'full-playwright',
    ])
    expect(descriptors.filter(({ effect }) => effect === 'write'))
      .toEqual(descriptors.filter(({ kind }) => ['reversible-write', 'full-playwright'].includes(kind)))
    expect(descriptors.find(({ kind }) => kind === 'full-playwright')?.evidenceKinds).toContain('trace')
  })

  it('发现描述符但不把旧 WeakMap capability backend 暴露给调用方', async () => {
    const protocol = adaptRuntimeReadExecutorV1({} as never)
    expect(describeBrowserExecutorV1(protocol)).toMatchObject({ kind: 'read', effect: 'read' })
    await expect(executeBrowserExecutorV1(protocol, {
      executionId: 'EXEC-1', runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      input: { snapshot: {}, attemptId: 'ATTEMPT-1' }, now: () => '2026-08-08T00:00:00.000Z',
    })).rejects.toThrow(/E2E_RUNTIME_READ_EXECUTOR_CAPABILITY_INVALID/)
  })

  it('shadow 路由只执行一次真实 read，并比较旧输出和协议语义投影', async () => {
    const fixture = projectionFixture()
    const execute = vi.fn(async () => ({
      status: 'passed' as const,
      result: { caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed' as const,
        expected: ['页面显示待审核订单'], actual: ['页面显示待审核订单'], evidence: [] },
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} },
      gatewayAuditDigest: d('gateway-audit'),
    }))
    const progress: string[] = []
    const capability = authorizeRuntimeReadExecutor(execute)
    const output = await executeRuntimeReadWithBrowserExecutorProtocolV1(capability, {
      snapshot: snapshot(fixture), attemptId: 'ATTEMPT-1', route: 'shadow', executionId: 'EXEC-1',
      now: () => '2026-08-08T00:00:00.000Z', onProgress: (event) => { progress.push(event.phase) },
    })

    expect(output.status).toBe('passed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(progress).toEqual(['accepted', 'dispatching', 'executed', 'completed'])
  })

  it('在 dispatch 前响应取消与过期 deadline，不触发旧 backend', async () => {
    const fixture = projectionFixture()
    const execute = vi.fn(async () => { throw new Error('不应执行') })
    const protocol = adaptRuntimeReadExecutorV1(authorizeRuntimeReadExecutor(execute))
    const controller = new AbortController(); controller.abort()
    await expect(executeBrowserExecutorV1(protocol, {
      executionId: 'EXEC-1', runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      input: { snapshot: snapshot(fixture), attemptId: 'ATTEMPT-1' }, signal: controller.signal,
      now: () => '2026-08-08T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'E2E_BROWSER_EXECUTOR_CANCELLED_BEFORE_DISPATCH' })
    await expect(executeBrowserExecutorV1(protocol, {
      executionId: 'EXEC-2', runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      input: { snapshot: snapshot(fixture), attemptId: 'ATTEMPT-1' },
      deadlineAt: '2026-08-07T23:59:59.000Z', now: () => '2026-08-08T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'E2E_BROWSER_EXECUTOR_DEADLINE_EXPIRED' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('把写 effect unknown 固定映射为 reconcile 且保留 cleanup 状态', () => {
    const descriptor: BrowserExecutorDescriptorV1 = {
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executorId: 'reversible-write/v1',
      kind: 'reversible-write', effect: 'write', inputSchemaVersion: 'runtime-write/v1',
      outputSchemaVersion: 'runtime-write/v1',
      control: { progress: true, timeout: 'deadline-before-dispatch', cancellation: 'pre-dispatch' },
      evidenceKinds: ['screenshot', 'dom', 'gateway-audit'],
      retrySafety: { beforeDispatch: 'safe', afterDispatch: 'reconcile-required' },
      lifecycle: { cleanup: 'required', reconcile: 'required-on-unknown' },
    }
    expect(projectLegacyBrowserExecutorResultV1({
      descriptor, executionId: 'EXEC-1', runId: 'RUN-1', attemptId: 'ATTEMPT-1',
      output: { status: 'failed', effectObservation: 'unknown', cleanup: { status: 'unknown' },
        resultDigest: d('write-result'), evidence: { screenshot: new Uint8Array([1]), dom: new Uint8Array([2]) } },
    })).toMatchObject({
      status: 'failed', effectObservation: 'unknown', cleanupStatus: 'unknown', recovery: 'reconcile',
      evidence: { materialKinds: ['screenshot', 'dom'], references: [] },
    })
  })

  it('独立语义比较会拒绝被篡改的 shadow 协议结果', () => {
    const descriptor = describeBrowserExecutorV1(adaptRuntimeReadExecutorV1({} as never))
    const legacy = {
      status: 'passed', result: { status: 'passed' }, gatewayAuditDigest: d('read'),
      gatewayAudit: { received: 0, forwarded: 0, blocked: 0, byIntent: {} },
    }
    const result = projectLegacyBrowserExecutorResultV1({
      descriptor, executionId: 'EXEC-1', runId: 'RUN-1', attemptId: 'ATTEMPT-1', output: legacy,
    })
    expect(() => assertLegacyBrowserExecutorSemanticEquivalentV1({
      descriptor, legacyOutput: legacy, protocolResult: { ...result, status: 'failed' },
    })).toThrow(/legacy 与 BrowserExecutorProtocolV1 语义不一致/)
  })
})

function snapshot(fixture: ReturnType<typeof projectionFixture>) {
  return {
    schemaVersion: '1.1.0' as const, runId: fixture.runId, assetId: 'ASSET-1',
    projectIdentityDigest: d('project'), runtimeInstallationDigest: fixture.runtimeInstallationDigest,
    runRevision: 1, workflow: { current: 'compiled' as const, sequence: 1, eventChainDigest: d('chain') },
    artifactDigests: Object.fromEntries(Object.entries(fixture.frozenArtifacts)
      .map(([key, artifact]) => [key, artifact.contentDigest])),
    frozenArtifacts: fixture.frozenArtifacts,
    trustedExecutionFacts: { ...fixture.trustedExecutionFacts, 'signed-execution-grant': fixture.grant },
    requestResponses: {}, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  }
}
