import { describe, expect, test, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import {
  bindRuntimeCapabilityProofToBrowserSelection,
  consumeRpcConnectionCredential,
  createAuditedRuntimeReadAuthority,
  createRuntimeFixedHttpWriteEvidence,
  resolveRuntimeBrowserInstallation,
  settleRuntimeBrowserResourcesThenRecordProof,
  settleRuntimeBrowserResources,
} from '../src/runtime-browser-wiring.js'
import { systemChromeClosureDigest } from '../src/system-chrome.js'
import { readBrowserSelection, writeBrowserSelection } from '../src/runtime-user-config.js'
import { createRuntimeTestRoots } from './fixtures.js'

describe('Runtime browser production wiring cleanup', () => {
  test('生产装配按用户选择重验系统 Chrome，且旧托管安装只迁移为 managed-chromium', async () => {
    const runtimeInstallationDigest = `sha256:${'1'.repeat(64)}`
    const selection = {
      schemaVersion: '1.0.0' as const,
      source: { kind: 'system-chrome' as const, executablePath: '/Applications/Google Chrome' },
      browserVersion: 'Google Chrome 150.0.0.0', executableDigest: `sha256:${'2'.repeat(64)}`,
      runtimeInstallationDigest, controlledLaunchProofDigest: `sha256:${'3'.repeat(64)}`,
      configuredAt: '2026-07-19T00:00:00.000Z',
    }
    const inspected = { selection, identity: { device: 1, inode: 2, uid: 0, byteLength: 3 } }
    const inspectManaged = vi.fn()
    const revalidateSystem = vi.fn(async () => inspected)
    const inspectCapabilityProof = vi.fn(async () => ({
      proofDigest: selection.controlledLaunchProofDigest,
      isolation: {
        browserClosureDigest: systemChromeClosureDigest(inspected),
        browserExecutableDigest: selection.executableDigest,
      },
    }))
    await expect(resolveRuntimeBrowserInstallation({
      homeDir: '/safe/home', projectRoot: '/safe/project', installation: {
        version: '0.2.0', installationDigest: runtimeInstallationDigest,
      },
    } as never, {
      readSelection: async () => selection,
      inspectManaged,
      revalidateSystem,
      inspectCapabilityProof,
    } as never)).resolves.toEqual(inspected)
    expect(revalidateSystem).toHaveBeenCalledWith(selection, {
      projectRoot: '/safe/project',
    })
    expect(inspectCapabilityProof).toHaveBeenCalledWith({
      homeDir: '/safe/home', runtimeInstallationDigest,
    })
    expect(inspectManaged).not.toHaveBeenCalled()

    const managed = { root: '/safe/managed', executablePath: '/safe/managed/chrome', manifest: {
      executableDigest: selection.executableDigest,
      closureDigest: systemChromeClosureDigest(inspected),
    } }
    await expect(resolveRuntimeBrowserInstallation({
      homeDir: '/safe/home', projectRoot: '/safe/project', installation: {
        version: '0.2.0', installationDigest: runtimeInstallationDigest,
      },
    } as never, {
      readSelection: async () => undefined,
      inspectManaged: async () => managed as never,
      revalidateSystem,
      inspectCapabilityProof,
    } as never)).resolves.toBe(managed)
  })

  test('系统 Chrome selection 与可信 capability proof 不一致时 fail closed', async () => {
    const runtimeInstallationDigest = `sha256:${'1'.repeat(64)}`
    const selection = {
      schemaVersion: '1.0.0' as const,
      source: { kind: 'system-chrome' as const, executablePath: '/Applications/Google Chrome' },
      browserVersion: 'Google Chrome 150.0.0.0', executableDigest: `sha256:${'2'.repeat(64)}`,
      runtimeInstallationDigest, controlledLaunchProofDigest: `sha256:${'3'.repeat(64)}`,
      configuredAt: '2026-07-19T00:00:00.000Z',
    }
    const revalidateSystem = vi.fn()

    await expect(resolveRuntimeBrowserInstallation({
      homeDir: '/safe/home', projectRoot: '/safe/project',
      installation: { version: '0.2.0', installationDigest: runtimeInstallationDigest },
    } as never, {
      readSelection: async () => selection,
      inspectManaged: vi.fn(),
      revalidateSystem,
      inspectCapabilityProof: async () => ({
        proofDigest: `sha256:${'9'.repeat(64)}`,
        isolation: {
          browserClosureDigest: `sha256:${'4'.repeat(64)}`,
          browserExecutableDigest: selection.executableDigest,
        },
      }),
    } as never)).rejects.toMatchObject({
      code: 'E2E_RUNTIME_CAPABILITY_PROOF_BROWSER_MISMATCH',
    })
    expect(revalidateSystem).not.toHaveBeenCalled()
  })

  test('成功刷新 capability proof 后同步 selection，保证下一次 Run 仍能 fail closed 复验', async () => {
    const roots = await createRuntimeTestRoots()
    try {
      const runtimeInstallationDigest = `sha256:${'1'.repeat(64)}`
      const executableDigest = `sha256:${'2'.repeat(64)}`
      await writeBrowserSelection(roots.home, {
        schemaVersion: '1.0.0',
        source: { kind: 'system-chrome', executablePath: '/Applications/Google Chrome' },
        browserVersion: 'Google Chrome 150.0.0.0', executableDigest,
        runtimeInstallationDigest, controlledLaunchProofDigest: `sha256:${'3'.repeat(64)}`,
        configuredAt: '2026-07-19T00:00:00.000Z',
      })
      const proof = {
        schemaVersion: '1.0.0' as const,
        runtimeInstallationDigest,
        proofDigest: `sha256:${'4'.repeat(64)}`,
        gateway: {
          sessionMeasurementDigest: `sha256:${'5'.repeat(64)}`,
          policyDigest: `sha256:${'6'.repeat(64)}`,
          auditDigest: `sha256:${'7'.repeat(64)}`,
        },
        isolation: {
          browserMeasurementDigest: `sha256:${'8'.repeat(64)}`,
          sandboxProfileDigest: `sha256:${'9'.repeat(64)}`,
          canaryProofDigest: `sha256:${'a'.repeat(64)}`,
          browserClosureDigest: `sha256:${'b'.repeat(64)}`,
          browserExecutableDigest: executableDigest,
        },
        verifiedAt: '2026-07-19T00:00:00.000Z',
      }

      await bindRuntimeCapabilityProofToBrowserSelection(roots.home, proof)

      await expect(readBrowserSelection(roots.home)).resolves.toMatchObject({
        controlledLaunchProofDigest: proof.proofDigest,
        executableDigest,
        configuredAt: '2026-07-19T00:00:00.000Z',
      })
    } finally {
      await rm(roots.root, { recursive: true, force: true })
    }
  })

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
    const bindProof = vi.fn(async () => { calls.push('bind') })
    await expect(settleRuntimeBrowserResourcesThenRecordProof(
      undefined,
      ['browser', 'gateway', 'authority'].map((name) => async () => { calls.push(name) }),
      proof,
      recordProof,
      bindProof,
    )).resolves.toBeUndefined()
    expect(calls).toEqual(['browser', 'gateway', 'authority', 'proof', 'bind'])
    expect(recordProof).toHaveBeenCalledOnce()
    expect(bindProof).toHaveBeenCalledOnce()
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

  test('只读 Authority reservation 只有终态提交成功后才进入 Gateway 签名审计', async () => {
    const recordCapabilityReservation = vi.fn()
    const complete = vi.fn(async () => undefined)
    const markUnknown = vi.fn(async () => undefined)
    const authority = createAuditedRuntimeReadAuthority({
      reserveForSubject: async (input: { capabilityId: string; actionId: string; attemptId: string }) => ({
        reservationId: `RES-${input.capabilityId}`, grantId: 'GRANT-1',
        capabilityId: input.capabilityId, actionId: input.actionId, attemptId: input.attemptId,
        status: 'reserved' as const, reservedAt: '2026-07-20T00:00:00.000Z',
      }),
      complete, markUnknown, destroy() {},
    } as never, { recordCapabilityReservation } as never)
    const grant = { grantId: 'GRANT-1' }
    const currentSubject = {}
    await authority.reserveForSubject({ grant, currentSubject,
      capabilityId: 'CAP-1', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1' } as never)
    expect(recordCapabilityReservation).not.toHaveBeenCalled()
    await authority.complete('RES-CAP-1', `sha256:${'1'.repeat(64)}`)
    expect(recordCapabilityReservation).toHaveBeenLastCalledWith({ consumed: true, reservation: {
      reservationId: 'RES-CAP-1', grantId: 'GRANT-1', capabilityId: 'CAP-1', actionId: 'ACTION-1',
      attemptId: 'ATTEMPT-1', status: 'completed', outcomeDigest: `sha256:${'1'.repeat(64)}`,
      reservedAt: '2026-07-20T00:00:00.000Z',
    } })

    await authority.reserveForSubject({ grant, currentSubject,
      capabilityId: 'CAP-2', actionId: 'ACTION-1', attemptId: 'ATTEMPT-1' } as never)
    await authority.markUnknown('RES-CAP-2', 'browser-closed')
    expect(recordCapabilityReservation).toHaveBeenLastCalledWith({ consumed: false, reservation: {
      reservationId: 'RES-CAP-2', grantId: 'GRANT-1', capabilityId: 'CAP-2', actionId: 'ACTION-1',
      attemptId: 'ATTEMPT-1', status: 'unknown', observation: 'browser-closed',
      reservedAt: '2026-07-20T00:00:00.000Z',
    } })
  })
})
