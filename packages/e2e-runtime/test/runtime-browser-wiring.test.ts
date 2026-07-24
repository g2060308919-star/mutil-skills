import { describe, expect, test, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import {
  bindRuntimeCapabilityProofToBrowserSelection,
  consumeRpcConnectionCredential,
  createAuditedRuntimeReadAuthority,
  createRuntimeFixedHttpWriteEvidence,
  issueRuntimeFullPlaywrightExecutionFreshness,
  renderRuntimeFullPlaywrightRequestBodies,
  persistRuntimeFullPlaywrightRecoveryEvidence,
  restoreRuntimeFullPlaywrightRecoveryOutput,
  RuntimeFullPlaywrightTraceRecorder,
  runtimeFullPlaywrightRunnerResultDigest,
  resolveRuntimeBrowserInstallation,
  settleRuntimeBrowserResourcesThenRecordProof,
  settleRuntimeBrowserResources,
} from '../src/runtime-browser-wiring.js'
import {
  canonicalizeJson,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  digestBytes,
  digestRuntimeHttpBodyTemplate,
  digestText,
} from '@mutil-skills/e2e-contracts'
import { systemChromeClosureDigest } from '../src/system-chrome.js'
import { readBrowserSelection, writeBrowserSelection } from '../src/runtime-user-config.js'
import { createRuntimeTestRoots } from './fixtures.js'
import { projectRuntimeFullPlaywrightSnapshot } from '../src/runtime-full-playwright-projector.js'
import { runtimeFullPlaywrightProjectionFixture } from './runtime-full-playwright-projector.test.js'

describe('Runtime browser production wiring cleanup', () => {
  test('full-playwright 持久结果使用 ExecutionOutcome 绑定的 runnerResultDigest', () => {
    const runnerResultDigest = digestText('test/v1', 'runner-result')
    const outcomeReceiptDigest = digestText('test/v1', 'outcome-receipt')
    expect(runtimeFullPlaywrightRunnerResultDigest({
      resultDigest: outcomeReceiptDigest,
      outcome: { runnerResultDigest },
    })).toBe(runnerResultDigest)
    expect(runtimeFullPlaywrightRunnerResultDigest({ resultDigest: runnerResultDigest }))
      .toBe(runnerResultDigest)
  })

  test('full-playwright 在生产执行前用冻结 RunBundle 与可信 Preflight 即时签发 freshness', async () => {
    const snapshot = runtimeFullPlaywrightProjectionFixture()
    const preflight = {
      runId: snapshot.runId,
      discoveryGrantId: 'DISCOVERY-1',
      reservationId: 'RESERVATION-1',
      preflightDigest: digestText('runtime-full-playwright-projector-test/v1', 'preflight'),
      status: 'ready' as const,
      observedIdentityDigest: digestText('test/v1', 'observed'),
      browserMeasurementDigest: digestText('test/v1', 'browser'),
      browserClosureDigest: digestText('test/v1', 'closure'),
      browserExecutableDigest: digestText('test/v1', 'executable'),
      gatewaySessionMeasurementDigest: digestText('test/v1', 'gateway-session'),
      gatewayPolicyDigest: digestText('test/v1', 'gateway-policy'),
      gatewayAuditDigest: digestText('test/v1', 'gateway-audit'),
      canaryProofDigest: digestText('test/v1', 'canary'),
      authorityOutcomeDigest: digestText('test/v1', 'authority-outcome'),
      authorityReceiptDigest: digestText('test/v1', 'authority-receipt'),
    }
    snapshot.trustedExecutionFacts['browser-preflight'] = preflight
    const projection = projectRuntimeFullPlaywrightSnapshot(snapshot)
    const sentinel = new Error('issuer-called')
    let issued: unknown

    await expect(issueRuntimeFullPlaywrightExecutionFreshness({
      snapshot,
      projection,
      issuer: {
        issueApprovalFreshnessReceipt: async (input) => {
          issued = input
          throw sentinel
        },
      },
    })).rejects.toBe(sentinel)

    expect(issued).toEqual({
      grant: projection.grant,
      currentSubject: projection.grant.subject,
      expectedCapabilities: (snapshot.frozenArtifacts['run-bundle']!.content as {
        signedCapabilities: unknown[]
      }).signedCapabilities,
      browserPreflight: {
        artifactDigest: digestText('runtime-browser-preflight-fact/v1', canonicalizeJson(preflight)),
        discoveryGrantId: preflight.discoveryGrantId,
        authorityPreflightDigest: preflight.preflightDigest,
      },
      runBundle: {
        artifactDigest: snapshot.frozenArtifacts['run-bundle']!.contentDigest,
        content: snapshot.frozenArtifacts['run-bundle']!.content,
      },
    })
  })

  test('full Playwright trace 必须持久化真实 Playwright ZIP，不能用零字节引用占位', async () => {
    const roots = await createRuntimeTestRoots()
    const starts: unknown[] = []
    const stops: string[] = []
    const tracing = {
      start: async (options: unknown) => { starts.push(options) },
      stop: async ({ path }: { path: string }) => {
        stops.push(path)
        await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))
      },
    }
    try {
      const recorder = new RuntimeFullPlaywrightTraceRecorder({
        context: { tracing } as never, stateRoot: roots.home, attemptId: 'ATTEMPT-TRACE-1', lifecycle: 'program',
      })
      await recorder.start()
      const evidence = await recorder.capture('before', true)
      expect(evidence).toMatchObject({ kind: 'trace', stage: 'before', byteLength: 8,
        references: ['runtime-artifact://full-playwright-traces/ATTEMPT-TRACE-1/program-before.zip'] })
      expect(evidence.digest).toMatch(/^sha256:/)
      expect(starts).toHaveLength(2)
      expect(stops).toHaveLength(1)
      expect(await readFile(stops[0]!)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))
    } finally { await rm(roots.root, { recursive: true, force: true }) }
  })

  test('full Playwright checkpoint 以摘要约束的 Git 外 artifact ref 恢复 evidence 与完整 finalization facts', async () => {
    const roots = await createRuntimeTestRoots()
    try {
      const evidence = { screenshot: Uint8Array.from([137, 80, 78, 71]),
        dom: Buffer.from('<main>ok</main>') }
      const refs = await persistRuntimeFullPlaywrightRecoveryEvidence({
        stateRoot: roots.home, attemptId: 'ATTEMPT-1', evidence,
      })
      const output = { caseId: 'CASE-1', actionId: 'ACTION-1', status: 'passed',
        effectObservation: 'applied', resultDigest: digestText('test/v1', 'result'),
        gatewayCommit: { reservationId: 'RES-1', reservationReceiptDigest: digestText('test/v1', 'receipt'),
          outcomeReceiptDigest: digestText('test/v1', 'outcome'), committed: true },
        cleanup: { status: 'verified-clean', resultDigest: digestText('test/v1', 'cleanup'),
          leaseReceiptDigest: digestText('test/v1', 'lease') },
        finalizationFacts: { gatewayAudit: { publication: 'full' }, cleanup: { status: 'verified-clean' },
          executionOutcomeReceipt: { signedDigest: digestText('test/v1', 'outcome') },
          executionOutcomeVerifierMaterial: { key: 'outcome' }, gatewayAuditVerifierMaterial: { key: 'gateway' },
          browserMeasurements: { program: digestText('test/v1', 'program'), cleanup: digestText('test/v1', 'browser-cleanup') },
          isolationMeasurements: { program: digestText('test/v1', 'isolation') } } }
      const recovered = await restoreRuntimeFullPlaywrightRecoveryOutput({
        stateRoot: roots.home, output, evidenceArtifacts: refs,
      })
      expect(recovered).toMatchObject(output)
      expect([...recovered.evidence!.screenshot]).toEqual([...evidence.screenshot])
      expect([...recovered.evidence!.dom]).toEqual([...evidence.dom])
    } finally { await rm(roots.root, { recursive: true, force: true }) }
  })

  test('full Playwright JSON/binary/template body 仅由冻结 material 渲染并在 secret bridge 消费', async () => {
    const source = 'await request.post("https://example.test/api")'
    const cleanupSource = "return 'verified-clean'"
    const json = { title: 'approved' }
    const binary = Buffer.from([0, 1, 255])
    const segments = [{ kind: 'literal' as const, value: 'prefix:' },
      { kind: 'secretRef' as const, secretRef: 'TOKEN' }]
    const templateDigest = digestRuntimeHttpBodyTemplate({ kind: 'segments',
      contentType: 'text/plain', segments })
    const templateSecret = Buffer.from('secret')
    const program = {
      schemaVersion: 'full-playwright/v1' as const, caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
      source, sourceDigest: computeFullPlaywrightSourceDigest(source), cleanupSource,
      cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource), dataLeaseId: 'LEASE-1',
      cleanupPlanId: 'CLEANUP-1', timeoutMs: 30_000,
      networkRequests: [
        { intentId: 'JSON', method: 'POST', canonicalOrigin: 'https://example.test', exactPath: '/json', query: [],
          payload: { kind: 'json' as const, digest: digestText('http-json-payload/v1', canonicalizeJson(json)) },
          targetFingerprint: digestText('test/v1', 'target'), maxRequests: 1, expectedOrder: 1 },
        { intentId: 'BINARY', method: 'PUT', canonicalOrigin: 'https://example.test', exactPath: '/binary', query: [],
          payload: { kind: 'binary' as const, digest: digestBytes('http-binary-payload/v1', binary) },
          targetFingerprint: digestText('test/v1', 'target'), maxRequests: 1, expectedOrder: 2 },
        { intentId: 'TEMPLATE', method: 'PATCH', canonicalOrigin: 'https://example.test', exactPath: '/template', query: [],
          payload: { kind: 'template' as const, templateDigest },
          targetFingerprint: digestText('test/v1', 'target'), maxRequests: 1, expectedOrder: 3 },
      ],
      networkRequestBodies: [
        { intentId: 'JSON', kind: 'json' as const, canonicalJson: canonicalizeJson(json) },
        { intentId: 'BINARY', kind: 'binary' as const, contentType: 'application/octet-stream',
          bodyBase64Url: binary.toString('base64url') },
        { intentId: 'TEMPLATE', kind: 'template' as const, contentType: 'text/plain', segments, templateDigest },
      ],
    }
    const bodies = await renderRuntimeFullPlaywrightRequestBodies('RUN-1', program, {
      resolve: async () => ({ handleId: 'HANDLE-1' }) as never,
      consume: async () => templateSecret,
    })
    expect(bodies.get('JSON')?.bytes.toString()).toBe(canonicalizeJson(json))
    expect(bodies.get('BINARY')?.bytes).toEqual(binary)
    expect(bodies.get('TEMPLATE')?.bytes.toString()).toBe('prefix:secret')
    expect(templateSecret.every((value) => value === 0)).toBe(true)
    for (const body of bodies.values()) body.bytes.fill(0)
  })

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
        version: '0.3.0', installationDigest: runtimeInstallationDigest,
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
        version: '0.3.0', installationDigest: runtimeInstallationDigest,
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
      installation: { version: '0.3.0', installationDigest: runtimeInstallationDigest },
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
