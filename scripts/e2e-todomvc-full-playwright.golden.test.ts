import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { chromium, expect as playwrightExpect, type BrowserContext } from '@playwright/test'
import { digestBytes, digestText } from '@mutil-skills/e2e-contracts'
import { LocalGatewayAuditSigner } from '@mutil-skills/e2e-gateway'
import { runFullPlaywrightCase, type FullPlaywrightEvidenceStage }
  from '@mutil-skills/e2e-playwright-runtime'
import { readyFixture } from '../packages/e2e-playwright-runtime/test/full-playwright-runner.fixture.js'
import { RuntimeFullPlaywrightTraceRecorder }
  from '../packages/e2e-runtime/src/runtime-browser-wiring.js'
import { runtimeTodoMvcFullPlaywrightFixture } from './e2e-runtime-read-only.fixture.js'

const runPublicGolden = process.env.E2E_RUNTIME_RUN_TODOMVC_PUBLIC === '1'
const targetUrl = 'https://todomvc.com/examples/typescript-react/'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const reportProgress = (message: string) => {
  if (process.env.E2E_RUNTIME_GOLDEN_PROGRESS === '1') process.stderr.write(`TODOMVC_GOLDEN:${message}\n`)
}

test.runIf(runPublicGolden)(
  '官方 TodoMVC PRD：完整功能覆盖并准确拒绝 localStorage 键名偏差',
  async () => {
    const traceRoot = await mkdtemp(join(tmpdir(), 'e2e-todomvc-full-trace-'))
    await mkdir(traceRoot, { recursive: true, mode: 0o700 })
    const programBrowser = await chromium.launch({ executablePath: chrome, headless: true })
    const cleanupBrowser = await chromium.launch({ executablePath: chrome, headless: true })
    const programContext = await programBrowser.newContext()
    const cleanupContext = await cleanupBrowser.newContext()
    const programPage = await programContext.newPage()
    const cleanupPage = await cleanupContext.newPage()
    const programTrace = new RuntimeFullPlaywrightTraceRecorder({
      context: programContext, stateRoot: traceRoot, attemptId: 'ATTEMPT-TODOMVC-PUBLIC', lifecycle: 'program',
    })
    const cleanupTrace = new RuntimeFullPlaywrightTraceRecorder({
      context: cleanupContext, stateRoot: traceRoot, attemptId: 'ATTEMPT-TODOMVC-PUBLIC', lifecycle: 'cleanup',
    })
    const fixture = runtimeTodoMvcFullPlaywrightFixture({
      runId: 'RUN-TODOMVC-PUBLIC', assetId: 'ASSET-TODOMVC-PUBLIC',
      prdRevision: digestText('todomvc-prd/v1', 'ff43b02e59dfa604386bb382034b2cd07c2bcd8a'),
      installationDigest: digestText('runtime-installation/v1', '0.4.4'),
      url: targetUrl, now: new Date('2026-07-26T00:00:00.000Z'),
    })
    const execution = fixture.frozenArtifacts['execution-contract'].content as any
    const program = execution.fullPlaywrightPrograms[0]
    const allowed = new Map(program.networkRequests.map((request: any) => [
      `GET ${request.exactPath}`, { intentId: request.intentId as string, max: request.maxRequests as number },
    ]))
    const counts = { received: 0, forwarded: 0, blocked: 0, byIntent: {} as Record<string, number> }
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'TODOMVC-PUBLIC-GATEWAY', keyId: 'TODOMVC-PUBLIC-KEY',
      instanceId: 'TODOMVC-PUBLIC-GW', version: '1.0.0',
    })
    const gatewayPolicyDigest = digestText('full-playwright-runner-test/v1', 'gateway-policy')
    const recorder = signer.createRecorder(gatewayPolicyDigest)
    const routeContext = async (context: BrowserContext) => await context.route('**/*', async (route) => {
      const request = route.request()
      const parsed = new URL(request.url())
      const rule = parsed.origin === 'https://todomvc.com'
        ? allowed.get(`${request.method().toUpperCase()} ${parsed.pathname}`) : undefined
      const used = rule ? counts.byIntent[rule.intentId] ?? 0 : 0
      const forwarded = Boolean(rule && used < rule.max)
      counts.received += 1
      recorder.recordReadDecision({
        actionId: 'ACTION-TODOMVC-FUNCTIONAL-1', executionSessionId: 'GW-SESSION-1',
        decision: forwarded ? 'forwarded' : 'blocked', request: { method: request.method(), url: request.url() },
      })
      if (!forwarded || !rule) {
        counts.blocked += 1
        await route.abort('blockedbyclient')
        return
      }
      counts.forwarded += 1
      counts.byIntent[rule.intentId] = used + 1
      await route.continue()
    })
    await routeContext(programContext)
    await routeContext(cleanupContext)
    await Promise.all([programTrace.start(), cleanupTrace.start()])
    const state: Record<string, unknown> = {}
    const capture = async (stage: FullPlaywrightEvidenceStage) => {
      reportProgress(`stage:${stage}:start`)
      const page = stage === 'cleanup' ? cleanupPage : programPage
      const screenshot = await page.screenshot()
      const dom = await page.content()
      const url = page.url()
      const evidence = [
        { evidenceId: `${stage.toUpperCase()}-SHOT`, stage, kind: 'screenshot' as const,
          byteLength: screenshot.byteLength,
          digest: digestBytes('runtime-evidence/screenshot/v1', screenshot) },
        { evidenceId: `${stage.toUpperCase()}-DOM`, stage, kind: 'dom' as const,
          byteLength: Buffer.byteLength(dom), digest: digestText('runtime-evidence/dom/v1', dom) },
        { evidenceId: `${stage.toUpperCase()}-URL`, stage, kind: 'url' as const,
          byteLength: Buffer.byteLength(url), digest: digestText('runtime-evidence/url/v1', url) },
        await (stage === 'cleanup' ? cleanupTrace : programTrace).capture(stage, stage === 'before'),
      ]
      reportProgress(`stage:${stage}:done`)
      return evidence
    }
    const captureCheckpoint = async (checkpointId: string) => {
      reportProgress(`checkpoint:${checkpointId}:start`)
      const screenshot = await programPage.screenshot()
      const dom = await programPage.content()
      const url = programPage.url()
      const evidence = [
        { evidenceId: `${checkpointId}-SHOT`, stage: 'checkpoint' as const, checkpointId,
          kind: 'screenshot' as const, byteLength: screenshot.byteLength,
          digest: digestBytes('runtime-evidence/screenshot/v1', screenshot) },
        { evidenceId: `${checkpointId}-DOM`, stage: 'checkpoint' as const, checkpointId,
          kind: 'dom' as const, byteLength: Buffer.byteLength(dom),
          digest: digestText('runtime-evidence/dom/v1', dom) },
        { evidenceId: `${checkpointId}-URL`, stage: 'checkpoint' as const, checkpointId,
          kind: 'url' as const, byteLength: Buffer.byteLength(url),
          digest: digestText('runtime-evidence/url/v1', url) },
        { ...await programTrace.capture('checkpoint', true, checkpointId), checkpointId },
      ]
      reportProgress(`checkpoint:${checkpointId}:done`)
      return evidence
    }
    try {
      const ready = await readyFixture({
        source: program.source, cleanupSource: program.cleanupSource,
        programTimeoutMs: 60_000, cleanupTimeoutMs: 30_000,
        networkRequests: program.networkRequests, networkRequestBodies: [],
        oracleCheckpoints: program.oracleCheckpoints,
        programBindings: {
          page: programPage, context: programContext, browser: programBrowser,
          request: programContext.request, expect: playwrightExpect,
          testInfo: { title: 'TodoMVC official PRD' }, state,
        },
        cleanupBindings: {
          page: cleanupPage, context: cleanupContext, browser: cleanupBrowser,
          request: cleanupContext.request, expect: playwrightExpect,
          testInfo: { title: 'TodoMVC official PRD cleanup' }, state,
        },
        capture, captureCheckpoint,
        finalizeGateway: () => {
          const audit = recorder.finalize()
          return { executionSessionId: 'GW-SESSION-1', policyDigest: audit.policyDigest,
            summary: counts, auditDigest: audit.signedCounters.digest }
        },
        issueOutcome: (binding) => signer.issueExecutionOutcomeReceipt(binding),
      })
      const result = await runFullPlaywrightCase(ready.input)
      reportProgress(`result:${JSON.stringify({ status: result.status,
        effectObservation: result.effectObservation, cleanup: result.cleanup,
        primaryError: result.primaryError, checkpointCount: result.oracleCheckpoints.length,
        blocked: counts.blocked, state })}`)

      expect(result.status, JSON.stringify(result)).toBe('failed')
      expect(result.effectObservation).toBe('applied')
      expect(result.cleanup.status).toBe('verified-clean')
      expect(result.primaryError).toMatchObject({ message: 'E2E_ORACLE_CHECKPOINT_FAILED' })
      expect(result.oracleCheckpoints).toHaveLength(25)
      expect(result.oracleCheckpoints.find((checkpoint) =>
        checkpoint.oracleId === 'ORACLE-TODOMVC-F20')).toMatchObject({
        status: 'failed', expectedJson: '"todos-react"', actualJson: '"react-todos"',
      })
      expect(counts.blocked).toBe(0)
      expect(state).toMatchObject({
        programCompleted: true, persistenceVerified: true, cleanupVerified: true,
        storageKeyDeviation: 'react-todos',
      })
      reportProgress('cleanup-assertion:start')
      expect(await cleanupPage.locator('.todo-list li').count()).toBe(0)
      reportProgress('cleanup-assertion:done')
    } finally {
      reportProgress('close:program-context:start')
      await programContext.close()
      reportProgress('close:program-context:done')
      await cleanupContext.close()
      reportProgress('close:cleanup-context:done')
      await programBrowser.close()
      reportProgress('close:program-browser:done')
      await cleanupBrowser.close()
      reportProgress('close:cleanup-browser:done')
      await rm(traceRoot, { recursive: true, force: true })
      reportProgress('close:trace-root:done')
    }
  },
  180_000,
)
