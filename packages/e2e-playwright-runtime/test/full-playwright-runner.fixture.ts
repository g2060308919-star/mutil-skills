import { describe, expect, test } from 'vitest'
import * as runtimePackage from '../src/index.js'
import {
  canonicalizeJson,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  digestApprovalProjection,
  digestCleanupPlanDefinition,
  digestExecutionOutcomeBinding,
  digestText,
  type ApprovalCapabilityRecord,
  type CleanupPlanDefinition,
  type ExecutionOutcomeBinding,
  type ExecutionOutcomeReceipt,
  type FullPlaywrightProgram,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, LocalLeaseAuthority } from '@mutil-skills/e2e-authority'
import {
  createTestWriteRuntimeSession,
  runFullPlaywrightCase,
  type FullPlaywrightBindings,
  type FullPlaywrightEvidenceStage,
} from '../src/index.js'
import { authorizeFullPlaywrightControlledSession,
  createFullPlaywrightBrowserFacade } from '../src/full-playwright-session-internal.js'
import { registerTrustedCompilerWriteRuntimeSession } from '../src/production-isolation.js'

const d = (value: string) => digestText('full-playwright-runner-test/v1', value)
const now = new Date('2026-07-22T01:00:00.000Z')

function evidenceForStage(stage: FullPlaywrightEvidenceStage) {
  return ['screenshot', 'dom', 'url', 'trace'].map((kind, index) => ({
    evidenceId: `${stage.toUpperCase()}-${index}`, stage,
    kind: kind as 'screenshot' | 'dom' | 'url' | 'trace', byteLength: stage.length + index + 1,
    digest: d(`${stage}:${kind}`), ...(kind === 'trace' ? { references: [`trace://${stage}`] } : {}),
  }))
}

export async function readyFixture(input: {
  source?: string
  cleanupSource?: string
  programTimeoutMs?: number
  cleanupTimeoutMs?: number
  gatewayBlocked?: number
  programBindings?: FullPlaywrightBindings
  cleanupBindings?: FullPlaywrightBindings
  effectObservation?: 'proven-not-applied' | 'applied' | 'unknown'
  observeEffectError?: Error
  gatewayError?: Error
  finalizeGateway?: () => { executionSessionId: string; policyDigest: string;
    summary: { received: number; forwarded: number; blocked: number; byIntent: Record<string, number> }
    auditDigest: string }
  retireProgramError?: Error
  retireCleanupError?: Error
  networkRequests?: FullPlaywrightProgram['networkRequests']
  networkRequestBodies?: FullPlaywrightProgram['networkRequestBodies']
  capture?: (stage: FullPlaywrightEvidenceStage) => Promise<ReturnType<typeof evidenceForStage>>
  gatewaySummary?: { received: number; forwarded: number; blocked: number; byIntent: Record<string, number> }
  issueOutcome?: (binding: ExecutionOutcomeBinding) => ExecutionOutcomeReceipt
  terminalFailures?: Partial<Record<'complete' | 'release' | 'markUnknown' | 'quarantine' | 'sign', number>>
  checkpoint?: (stage: 'reserved' | 'lease-terminal-intent' | 'write-terminal-intent'
    | 'authority-terminal' | 'published', material: Record<string, unknown>) => Promise<void>
} = {}) {
  const events: string[] = []
  const terminalCalls = { complete: 0, release: 0, markUnknown: 0, quarantine: 0, sign: 0 }
  const fail = (kind: keyof typeof terminalCalls) => {
    terminalCalls[kind] += 1
    if (terminalCalls[kind] <= (input.terminalFailures?.[kind] ?? 0)) throw new Error(`${kind}-transient`)
  }
  const state: Record<string, unknown> = {}
  const leaseAuthority = new LocalLeaseAuthority({ now: () => now })
  const tentative = await leaseAuthority.acquire({ runId: 'RUN-TEST', resourceKey: 'browser-local:fixture',
    resourceFingerprint: d('target'), exclusive: true, ttlMs: 60_000 })
  const active = await leaseAuthority.activate(tentative.leaseId)
  const locator = (name: string) => ({
    async fill(value: string) { events.push(`fill:${name}:${value}`) },
    async press(value: string) { events.push(`press:${name}:${value}`) },
    async check() { events.push(`check:${name}`) },
    async click() { events.push(`click:${name}`) },
    async dblclick() { events.push(`dblclick:${name}`) },
    async hover() { events.push(`hover:${name}`) },
  })
  const programPage = {
    getByLabel: locator, getByRole: (role: string, options?: { name?: string }) => locator(`${role}:${options?.name ?? ''}`),
    locator, never: () => new Promise<never>(() => {}),
  }
  const cleanupPage = { async close() { events.push('cleanup-page-close') },
    never: () => new Promise<never>(() => {}) }
  const programContext = {
    async waitForEvent(name: string) { events.push(`popup:${name}`); return { url: () => 'http://127.0.0.1/popup' } },
  }
  const cleanupContext = { name: 'independent-cleanup-context' }
  const browser = { async newContext() { events.push('new-context'); return {
    async newPage() { events.push('new-page'); return {} },
  } } }
  const cleanupBrowser = { name: 'cleanup-browser' }
  const request = { async post(url: string) { events.push(`request:${url}`); return { ok: () => true } } }
  const expectBinding = (actual: unknown) => ({ async toBeTruthy() {
    events.push('expect'); if (!actual) throw new Error('expectation failed')
  } })
  const rawProgramBindings = input.programBindings ?? {
    page: programPage, context: programContext, browser, request, expect: expectBinding,
    testInfo: { title: 'full runner' }, state,
  }
  const rawCleanupBindings = input.cleanupBindings ?? {
    page: cleanupPage, context: cleanupContext, browser: cleanupBrowser,
    request: { name: 'cleanup-request' }, expect: expectBinding, testInfo: { title: 'cleanup' }, state,
  }
  const programBindings = { ...rawProgramBindings, browser: createFullPlaywrightBrowserFacade(
    rawProgramBindings.browser as object,
    { browserSessionId: 'BROWSER-PROGRAM-1', gatewaySessionId: 'GW-SESSION-1', lifecycle: 'program' }) }
  const cleanupBindings = { ...rawCleanupBindings, browser: createFullPlaywrightBrowserFacade(
    rawCleanupBindings.browser as object,
    { browserSessionId: 'BROWSER-CLEANUP-1', gatewaySessionId: 'GW-SESSION-1', lifecycle: 'cleanup' }) }
  const source = input.source ?? [
    "await page.getByLabel('Name').fill('Ada')",
    "await page.getByLabel('Name').press('Enter')",
    "await page.getByLabel('Enabled').check()",
    "await page.getByRole('link', { name: 'Details' }).click()",
    "await page.locator('#row').dblclick()",
    "await page.locator('#remove').hover()",
    "await context.waitForEvent('page')",
    'const extra = await browser.newContext()',
    'await extra.newPage()',
    "const response = await request.post('http://127.0.0.1/api')",
    'await expect(response.ok()).toBeTruthy()',
    'state.programCompleted = true',
  ].join('\n')
  const cleanupSource = input.cleanupSource ?? [
    "if (!state.programCompleted) state.recovered = true",
    'await page.close()',
    "return 'verified-clean'",
  ].join('\n')
  const program: FullPlaywrightProgram = {
    schemaVersion: 'full-playwright/v1', caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1',
    source, sourceDigest: computeFullPlaywrightSourceDigest(source), cleanupSource,
    cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource), dataLeaseId: active.leaseId,
    cleanupPlanId: 'CLEANUP-1', timeoutMs: input.programTimeoutMs ?? 500,
    networkRequests: input.networkRequests ?? [],
    ...(input.networkRequestBodies === undefined ? {} : {
      networkRequestBodies: input.networkRequestBodies,
    }),
  }
  const cleanupPlan: CleanupPlanDefinition = {
    schemaVersion: '2.0.0', transport: 'browser-local', cleanupPlanId: 'CLEANUP-1', actionId: 'ACTION-1',
    leaseId: active.leaseId, executorId: 'FULL-PLAYWRIGHT', cleanupProgramDigest: program.cleanupSourceDigest,
    cleanupRequestIntentIds: (input.networkRequests ?? []).map((request) => request.intentId),
    verificationProbes: [{ probeId: 'PROBE-1',
      kind: 'browser-observation', expectedDigest: d('clean') }], timeoutMs: input.cleanupTimeoutMs ?? 500,
  }
  const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan)
  const authority = LocalApprovalAuthority.create({
    issuer: 'AUTHORITY', keyId: 'KEY-1', now: () => now,
    approvalIdentities: [{ subject: 'alice', roles: ['e2e-approver'] }],
    authenticateApproverSession: (sessionRef, expected) => sessionRef === 'session:alice' ? {
      subject: 'alice', runId: 'RUN-TEST', approvalType: expected.approvalType,
      subjectDigest: expected.subjectDigest, installationDigest: d('installation'),
      origin: 'http://127.0.0.1:43210', issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    } : undefined,
  })
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    environment: 'test' as const, baseOrigin: 'http://127.0.0.1:43210', actor: 'OPERATOR',
    expectedPageIdentity: { url: 'http://127.0.0.1:43210/', title: 'Local', heading: 'Local', ariaSignals: ['main'] },
    bootstrapIntentsDigest: d('bootstrap'), requests: [], actions: [{ actionId: 'DISCOVERY-1',
      operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [] }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject,
    approver: { subject: 'alice', roles: ['e2e-approver'] }, approvalSessionRef: 'session:alice', ttlMs: 60_000 })
  const discoveryReservation = await authority.reserveForSubject({ grant: discovery,
    currentSubject: discoverySubject, capabilityId: discovery.capabilities[0]!.capabilityId,
    actionId: 'DISCOVERY-1', attemptId: 'DISCOVERY-ATTEMPT' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery,
    currentSubject: discoverySubject, reservationId: discoveryReservation.reservationId,
    capabilityId: discovery.capabilities[0]!.capabilityId, outcome: { status: 'ready',
      observedIdentity: { url: 'http://127.0.0.1:43210/', title: 'Local', headings: ['Local'],
        role: 'OPERATOR', ariaSignals: ['main'] } } })
  const runBundle = { runId: 'RUN-TEST', allInputRefs: [{ artifactId: 'A', digest: d('input') }],
    schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
    attemptPlans: [{ caseId: 'CASE-1', slots: 1 }], signedCapabilities: [{ capabilityId: 'PENDING',
      actionId: 'ACTION-1', operation: 'full-playwright', effect: 'reversible-write', maxUses: 1,
      digest: d('pending') }], secretRefs: [], runtimePolicyDigest: d('runtime'),
    runtimeIsolationPolicyDigest: 'not-applicable' }
  const subject = {
    schemaVersion: '2.0.0' as const, assetId: 'ASSET-1', prdRevision: d('prd'), executionDigest: d('execution'),
    scopeDigest: d('scope'), requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage'),
    universeDigest: d('universe'), caseDigest: d('cases'), actionMapDigest: d('actions'),
    policyDigest: d('policy'), executionContractDigest: d('contract'),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundle), environment: 'test' as const,
    baseOrigin: 'http://127.0.0.1:43210', actor: 'OPERATOR', discoveryGrantId: discovery.grantId,
    preflightDigest, actions: [{ actionId: 'ACTION-1', transport: 'browser-local' as const,
      operation: 'full-playwright' as const, effect: 'reversible-write' as const,
      programDigest: program.sourceDigest, cleanupProgramDigest: program.cleanupSourceDigest,
      dataLeaseId: active.leaseId, resourceKey: 'browser-local:fixture', fencingToken: 1,
      cleanupPlanDigest, requests: input.networkRequests ?? [] }],
  }
  const grant = await authority.issueWriteGrant({ subject, approver: { subject: 'alice', roles: ['e2e-approver'] },
    approvalSessionRef: 'session:alice', ttlMs: 60_000 })
  const capability = grant.capabilities[0]!
  const capabilityRecords: ApprovalCapabilityRecord[] = grant.capabilities.map((item) => ({
    capabilityId: item.capabilityId, actionId: item.actionId, operation: item.operation,
    effect: item.effect, maxUses: item.maxUses,
    digest: digestText('approval-capability/v1', canonicalizeJson(item)),
  }))
  runBundle.signedCapabilities = capabilityRecords
  const browserPreflight = { artifactDigest: d('browser-preflight'), discoveryGrantId: discovery.grantId,
    authorityPreflightDigest: preflightDigest }
  const freshnessReceipt = await authority.issueApprovalFreshnessReceipt({ grant, currentSubject: subject,
    expectedCapabilities: capabilityRecords, browserPreflight,
    runBundle: { artifactDigest: d('run-bundle'), content: runBundle } })
  const terminalAuthority = {
    releaseForTarget: async (value: Parameters<LocalLeaseAuthority['releaseForTarget']>[0]) => {
      fail('release'); return await leaseAuthority.releaseForTarget(value)
    },
    quarantineForTarget: async (value: Parameters<LocalLeaseAuthority['quarantineForTarget']>[0]) => {
      fail('quarantine'); return await leaseAuthority.quarantineForTarget(value)
    },
  }
  const trustedLease = leaseAuthority.createExecutionClient(grant.approvalContext)
  const evidence = (stage: FullPlaywrightEvidenceStage) => evidenceForStage(stage)
  const gatewaySummary = input.gatewaySummary ?? { received: 1, forwarded: 1, blocked: input.gatewayBlocked ?? 0,
    byIntent: { 'LOCAL-DOCUMENT': 1 } }
  let gatewayReservation: Awaited<ReturnType<LocalApprovalAuthority['reserveForSubject']>> | undefined
  const issueTerminalOutcome = (terminal: {
    status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
    effectObservation: 'proven-not-applied' | 'applied' | 'unknown'
    runnerResultDigest: string
    cleanupPlanId: string
    cleanup: { status: 'verified-clean' | 'failed' | 'unknown'; resultDigest: string; leaseReceiptDigest: string }
    evidenceIds: string[]
    completedAt: string
  }): ExecutionOutcomeReceipt => {
    fail('sign')
    if (!gatewayReservation) throw new Error('gateway reservation missing')
    const binding: ExecutionOutcomeBinding = {
      schemaVersion: '1.0.0', attemptContext: { assetId: 'ASSET-1', generationId: 'GEN-1',
        prdRevision: d('prd'), runId: 'RUN-TEST', caseId: 'CASE-1' },
      grantId: grant.grantId, capabilityId: capability.capabilityId, actionId: capability.actionId,
      attemptId: 'ATTEMPT-1', reservationId: gatewayReservation.reservationId, capability,
      effect: 'reversible-write', status: terminal.status, effectObservation: terminal.effectObservation,
      runnerResultDigest: terminal.runnerResultDigest,
      gateway: { executionSessionId: 'GW-SESSION-1', policyDigest: d('gateway-policy'),
        approvedRequestSetDigest: digestText('execution-outcome-approved-request-set/v1',
          canonicalizeJson(input.networkRequests ?? [])), received: gatewaySummary.received,
        forwarded: gatewaySummary.forwarded, blocked: gatewaySummary.blocked },
      cleanup: { cleanupPlanId: terminal.cleanupPlanId, cleanupPlanDigest,
        leaseId: active.leaseId, ...terminal.cleanup },
      evidenceIds: terminal.evidenceIds,
      evidenceSetDigest: digestText('execution-outcome-evidence-set/v1',
        canonicalizeJson([...terminal.evidenceIds].sort())),
      completedAt: terminal.completedAt,
    }
    return input.issueOutcome?.(binding) ?? ({ ...binding, issuer: 'GATEWAY', keyId: 'GW-KEY',
      purpose: 'execution-outcome-receipt/v1', algorithm: 'Ed25519',
      signedDigest: digestExecutionOutcomeBinding(binding), signature: 'test-signature' })
  }
  const session = authorizeFullPlaywrightControlledSession({
    binding: { executionProfile: 'full-playwright', assetId: 'ASSET-1', generationId: 'GEN-1',
      prdRevision: d('prd'), runId: 'RUN-TEST', caseId: 'CASE-1', stepId: 'STEP-1',
      actionId: 'ACTION-1', capabilityId: capability.capabilityId, programDigest: program.sourceDigest,
      cleanupProgramDigest: program.cleanupSourceDigest, cleanupPlanDigest, leaseId: active.leaseId, fencingToken: 1,
      targetFingerprint: d('target'), approvedRequestSetDigest: digestText(
        'execution-outcome-approved-request-set/v1', canonicalizeJson(input.networkRequests ?? [])),
      gatewayPolicyDigest: d('gateway-policy'), executionSessionId: 'GW-SESSION-1',
      sourceSetDigest: d('source-set'), programBrowserSessionId: 'BROWSER-PROGRAM-1',
      cleanupBrowserSessionId: 'BROWSER-CLEANUP-1' },
    programBindings, cleanupBindings,
    reserveCapability: async () => {
      events.push('gateway-reserve')
      gatewayReservation = await authority.reserveForSubject({ grant, currentSubject: subject,
        capabilityId: capability.capabilityId, actionId: capability.actionId,
        attemptId: 'ATTEMPT-1', attemptContext: { assetId: 'ASSET-1', generationId: 'GEN-1',
          prdRevision: d('prd'), runId: 'RUN-TEST', caseId: 'CASE-1' } })
      return gatewayReservation
    },
    capture: input.capture ?? (async (stage) => evidence(stage)),
    retireProgram: async () => { events.push('retire-program'); if (input.retireProgramError) throw input.retireProgramError },
    retireCleanup: async () => { events.push('retire-cleanup'); if (input.retireCleanupError) throw input.retireCleanupError },
    observeEffect: () => { if (input.observeEffectError) throw input.observeEffectError
      return input.effectObservation ?? 'applied' },
    freezeGateway: async () => { events.push('gateway-freeze'); if (input.gatewayError) throw input.gatewayError
      const value = input.finalizeGateway?.()
      return value ? { executionSessionId: value.executionSessionId, policyDigest: value.policyDigest,
        summary: value.summary } : { executionSessionId: 'GW-SESSION-1', policyDigest: d('gateway-policy'),
        summary: gatewaySummary }
    },
    publishGateway: async () => { events.push('gateway-publish'); return { auditDigest: d('gateway-audit') } },
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
    terminal: {
      releaseLease: terminalAuthority.releaseForTarget,
      quarantineLease: terminalAuthority.quarantineForTarget,
      finalizeWriteOutcome: async (terminal) => {
        const outcome = issueTerminalOutcome(terminal)
        events.push('gateway-terminal-complete')
        fail('complete')
        return { outcome, authorityReceiptDigest: await authority.complete(
          outcome.reservationId, outcome.signedDigest) }
      },
      markWriteUnknownWithOutcome: async (terminal, observation) => {
        const outcome = issueTerminalOutcome(terminal)
        events.push('gateway-terminal-unknown')
        fail('markUnknown')
        return { outcome, authorityReceiptDigest: await authority.markUnknown(
          outcome.reservationId, observation) }
      },
      markWriteUnknown: async (observation) => {
        events.push('gateway-terminal-unknown')
        fail('markUnknown')
        if (!gatewayReservation) throw new Error('gateway reservation missing')
        return await authority.markUnknown(gatewayReservation.reservationId, observation)
      },
    },
  })
  const attemptContext = { assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: d('prd'),
    runId: 'RUN-TEST', caseId: 'CASE-1' }
  const runtime = Object.freeze({})
  registerTrustedCompilerWriteRuntimeSession(runtime, { mode: 'trusted-compiler', sandboxHealthy: true,
    gatewayConnected: true, authorityTransport: 'in-process-test', runId: 'RUN-TEST',
    assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: d('prd'), sourceDigest: d('source-set') })
  return { events, terminalCalls, state, program, cleanupPlan, authority, leaseAuthority, grant, subject, freshnessReceipt,
    active, trustedLease, terminalAuthority, session, attemptContext,
    input: { program, cleanupPlan, attemptId: 'ATTEMPT-1', attemptContext,
      authorization: { grant, currentSubject: subject, freshnessReceipt,
        freshnessAuthority: authority.createTrustedApprovalFreshnessClient(),
        authority: authority.createWriteExecutionClient(grant.approvalContext) },
      lease: { leaseId: active.leaseId, fencingToken: 1, targetFingerprint: d('target'),
        authority: trustedLease, terminalAuthority },
      runtime, session },
  }
}

export function registerFullPlaywrightRunnerTests(): void {
describe('runFullPlaywrightCase', () => {
  test('生产 package root 不导出 test-only controlled session assembly', () => {
    expect(runtimePackage).not.toHaveProperty('createTestControlledFullPlaywrightSession')
  })
  test('生产 full runner 拒绝 test-only runtime，即使健康标记为真', async () => {
    const fixture = await readyFixture()
    fixture.input.runtime = createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
      authorityTransport: 'in-process-test' })
    await expect(runFullPlaywrightCase(fixture.input)).resolves.toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_TRUSTED_RUNTIME_REQUIRED' })
  })
  test('attemptContext 严格拒绝额外字段', async () => {
    const fixture = await readyFixture()
    fixture.input.attemptContext = { ...fixture.attemptContext, injected: true } as typeof fixture.attemptContext
    await expect(runFullPlaywrightCase(fixture.input)).resolves.toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_ATTEMPT_CONTEXT_INVALID' })
  })
  test('runtime source-set digest 与 program digest 是独立 binding domain', async () => {
    const fixture = await readyFixture()
    const driftedRuntime = Object.freeze({})
    registerTrustedCompilerWriteRuntimeSession(driftedRuntime, { mode: 'trusted-compiler', sandboxHealthy: true,
      gatewayConnected: true, authorityTransport: 'in-process-test', runId: 'RUN-TEST', assetId: 'ASSET-1',
      generationId: 'GEN-1', prdRevision: d('prd'), sourceDigest: fixture.program.sourceDigest })
    fixture.input.runtime = driftedRuntime
    await expect(runFullPlaywrightCase(fixture.input)).resolves.toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_RUNTIME_BINDING_MISMATCH' })
  })
  test('lease execution client 缺少审批四字段 binding 时执行前拒绝', async () => {
    const fixture = await readyFixture()
    fixture.input.lease.authority = fixture.leaseAuthority.createExecutionClient()
    await expect(runFullPlaywrightCase(fixture.input)).resolves.toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_AUTHORITY_TRANSPORT_MISMATCH' })
  })
  test('完整 Playwright bindings、独立 cleanup、证据和签名 outcome 一次闭合', async () => {
    const fixture = await readyFixture()
    const result = await runFullPlaywrightCase(fixture.input)

    expect(result).toMatchObject({ status: 'passed', effectObservation: 'applied', retryAllowed: false,
      cleanup: { status: 'verified-clean' } })
    expect(fixture.events).toEqual([
      'gateway-reserve',
      'fill:Name:Ada', 'press:Name:Enter', 'check:Enabled', 'click:link:Details', 'dblclick:#row',
      'hover:#remove', 'popup:page', 'new-context', 'new-page', 'request:http://127.0.0.1/api',
      'expect', 'cleanup-page-close', 'gateway-freeze', 'gateway-terminal-complete', 'gateway-publish',
    ])
    expect(result.evidence.map((item) => item.stage)).toEqual(expect.arrayContaining(['before', 'after', 'cleanup']))
    expect(result.outcome).toBeDefined()
    expect(result.outcome?.signedDigest).toBe(result.resultDigest)
    expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({
      status: 'completed', outcomeDigest: result.outcome?.signedDigest,
    })
  })

  test('Gateway 成功 reservation 先由唯一 terminal owner 完成，再发布签名审计', async () => {
    const fixture = await readyFixture()
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result.finalization?.state).toBe('completed')
    expect(fixture.events.filter((event) => event.startsWith('gateway-'))).toEqual([
      'gateway-reserve', 'gateway-freeze', 'gateway-terminal-complete', 'gateway-publish',
    ])
  })

  test('持久 checkpoint 在 program 副作用与每个 terminal side effect 前记录可重放输入', async () => {
    const stages: string[] = []
    const materials: Record<string, unknown>[] = []
    const fixture = await readyFixture({ checkpoint: async (stage, material) => {
      stages.push(stage); materials.push(material)
    } })
    await expect(runFullPlaywrightCase(fixture.input)).resolves.toMatchObject({
      status: 'passed', finalization: { state: 'completed' },
    })
    expect(stages).toEqual(['reserved', 'lease-terminal-intent', 'write-terminal-intent',
      'authority-terminal', 'published'])
    expect(materials[0]).toMatchObject({ reservation: { reservationId: expect.any(String) } })
    expect(materials[1]).toMatchObject({ runnerResultDigest: expect.stringMatching(/^sha256:/),
      lease: { leaseId: expect.any(String), fencingToken: 1 } })
    expect(materials[2]).toMatchObject({ terminalInput: { runnerResultDigest: expect.stringMatching(/^sha256:/) } })
    expect(materials[3]).toMatchObject({ outcome: { signedDigest: expect.stringMatching(/^sha256:/) },
      authorityReceiptDigest: expect.stringMatching(/^sha256:/) })
    expect(materials[4]).toMatchObject({ publishedGateway: { auditDigest: expect.stringMatching(/^sha256:/) } })
    expect(fixture.events.indexOf('gateway-reserve')).toBeLessThan(fixture.events.indexOf('fill:Name:Ada'))
  })

  test.each(['complete', 'release', 'sign'] as const)(
    '%s 阶段一次性故障由同一 terminal intent 幂等恢复，receipt 不伪造', async (stage) => {
      const fixture = await readyFixture({ terminalFailures: { [stage]: 1 } })
      const result = await runFullPlaywrightCase(fixture.input)
      expect(result).toMatchObject({ status: 'passed', finalization: { state: 'completed',
        leaseReceiptDigest: expect.stringMatching(/^sha256:/),
        authorityReceiptDigest: expect.stringMatching(/^sha256:/),
        outcomeReceiptDigest: result.outcome?.signedDigest } })
      expect(fixture.terminalCalls[stage]).toBe(2)
      expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({
        status: 'completed', outcomeDigest: result.outcome?.signedDigest,
      })
    },
  )

  test('sign 持续故障返回可恢复 terminal intent；同 attempt 重入完成且不重新执行 program', async () => {
    const fixture = await readyFixture({ terminalFailures: { sign: 2 } })
    const failed = await runFullPlaywrightCase(fixture.input)
    expect(failed).toMatchObject({ status: 'failed', effectObservation: 'unknown', retryAllowed: false,
      finalization: { state: 'terminal-failed',
        terminalIntentDigest: expect.stringMatching(/^sha256:/), leaseReceiptDigest: expect.stringMatching(/^sha256:/),
      } })
    expect(failed.outcome).toBeUndefined()
    expect(failed.finalization?.outcomeReceiptDigest).toBeUndefined()
    expect(failed.finalization?.authorityReceiptDigest).toBeUndefined()
    const programEvents = fixture.events.filter((event) => !event.startsWith('gateway-'))
    const recovered = await runFullPlaywrightCase(fixture.input)
    expect(recovered).toMatchObject({ status: 'passed', finalization: { state: 'completed',
      outcomeReceiptDigest: expect.stringMatching(/^sha256:/), authorityReceiptDigest: expect.stringMatching(/^sha256:/) } })
    expect(fixture.events.filter((event) => !event.startsWith('gateway-'))).toEqual(programEvents)
    expect(fixture.authority.getReservation(recovered.reservationId!)).toMatchObject({ status: 'completed',
      outcomeDigest: recovered.outcome?.signedDigest })
  })

  test.each([
    ['release', {}], ['complete', {}], ['sign', {}],
    ['quarantine', { cleanupSource: "return 'dirty'" }],
    ['markUnknown', { cleanupSource: "return 'dirty'" }],
  ] as const)('%s 持续故障均返回 terminal-failed，同 attempt 恢复不重跑 program', async (stage, options) => {
    const fixture = await readyFixture({ ...options, terminalFailures: { [stage]: 2 } })
    const failed = await runFullPlaywrightCase(fixture.input)
    expect(failed).toMatchObject({ status: 'failed', effectObservation: 'unknown', retryAllowed: false,
      finalization: { state: 'terminal-failed', terminalIntentDigest: expect.stringMatching(/^sha256:/) } })
    const programEvents = fixture.events.filter((event) => !event.startsWith('gateway-'))
    const recovered = await runFullPlaywrightCase(fixture.input)
    expect(recovered.finalization?.state).toBe(stage === 'quarantine' || stage === 'markUnknown' ? 'unknown' : 'completed')
    expect(fixture.events.filter((event) => !event.startsWith('gateway-'))).toEqual(programEvents)
  })

  test.each(['markUnknown', 'quarantine'] as const)(
    '%s 一次性故障恢复；markUnknown 失败也绝不跳过 quarantine', async (stage) => {
      const fixture = await readyFixture({ cleanupSource: "return 'dirty'", terminalFailures: { [stage]: 1 } })
      const result = await runFullPlaywrightCase(fixture.input)
      expect(result).toMatchObject({ status: 'failed', effectObservation: 'unknown', retryAllowed: false,
        finalization: { state: 'unknown', leaseReceiptDigest: expect.stringMatching(/^sha256:/),
          authorityReceiptDigest: expect.stringMatching(/^sha256:/),
          outcomeReceiptDigest: result.outcome?.signedDigest } })
      expect(fixture.terminalCalls[stage]).toBe(2)
      expect(fixture.terminalCalls.quarantine).toBeGreaterThan(0)
      expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({ status: 'unknown' })
    },
  )

  test.each([
    ['program digest drift', (fixture: Awaited<ReturnType<typeof readyFixture>>) => {
      fixture.input.program = { ...fixture.program, source: `${fixture.program.source}\nvoid 0` }
    }],
    ['cleanup digest drift', (fixture: Awaited<ReturnType<typeof readyFixture>>) => {
      fixture.input.program = { ...fixture.program, cleanupSource: `${fixture.program.cleanupSource}\nvoid 0` }
    }],
    ['lease fencing drift', (fixture: Awaited<ReturnType<typeof readyFixture>>) => {
      fixture.input.lease = { ...fixture.input.lease, fencingToken: 2 }
    }],
    ['frozen request drift', (fixture: Awaited<ReturnType<typeof readyFixture>>) => {
      fixture.input.program = { ...fixture.program, networkRequests: [{ intentId: 'DRIFT', method: 'GET',
        canonicalOrigin: 'http://127.0.0.1:43210', exactPath: '/drift', query: [], payload: { kind: 'no-body' },
        targetFingerprint: d('target'), maxRequests: 1, expectedOrder: 1 }] }
    }],
  ])('执行前拒绝 %s，且不消费 capability', async (_name, mutate) => {
    const fixture = await readyFixture()
    mutate(fixture)
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'safety-blocked', effectObservation: 'proven-not-applied' })
    expect(fixture.authority.getReservation('ATTEMPT-1')).toBeUndefined()
  })

  test('Task 3 host AST audit 在 Runtime 再执行一次并拒绝 Node binding', async () => {
    const fixture = await readyFixture({ source: 'return process.cwd()' })
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_HOST_SOURCE_AUDIT_DENIED' })
  })

  test('Grant capability 漂移在执行前拒绝', async () => {
    const fixture = await readyFixture()
    const capability = fixture.grant.capabilities[0]!
    if (capability.transport !== 'browser-local') throw new Error('fixture capability mismatch')
    fixture.input.authorization.grant = { ...fixture.grant,
      capabilities: [{ ...capability, programDigest: d('drift') }] }
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_FROZEN_BINDING_MISMATCH' })
  })

  test('freshness receipt 在 Authority revoke 后即失效', async () => {
    const fixture = await readyFixture()
    await fixture.authority.revoke(fixture.grant.grantId, 'test-revoke')
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_APPROVAL_FRESHNESS_INVALID' })
  })

  test('Attempt/reservation owner 上下文漂移在 reserve 前拒绝', async () => {
    const fixture = await readyFixture()
    fixture.input.attemptContext = { ...fixture.attemptContext, caseId: 'CASE-OTHER' }
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'safety-blocked',
      reasonCode: 'E2E_FULL_PLAYWRIGHT_ATTEMPT_CONTEXT_MISMATCH' })
  })

  test('program timeout 立即退休 program context、在独立 session cleanup，但最终 unknown 且不可重试', async () => {
    const fixture = await readyFixture({ source: 'await page.never()', programTimeoutMs: 10 })
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'failed', effectObservation: 'unknown', retryAllowed: false,
      cleanup: { status: 'verified-clean' } })
    expect(fixture.events).toEqual(['gateway-reserve', 'retire-program', 'cleanup-page-close',
      'gateway-freeze', 'gateway-terminal-unknown', 'gateway-publish'])
    expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({ status: 'unknown' })
    expect(await fixture.trustedLease.verifyTarget(fixture.active.leaseId, 1, d('target'))).toBe(false)

    const replay = await runFullPlaywrightCase(fixture.input)
    expect(replay).toMatchObject({ status: 'safety-blocked', effectObservation: 'proven-not-applied',
      retryAllowed: false })
  })

  test('throw undefined 仍作为 primary failure 保留，verified cleanup 后安全闭合', async () => {
    const fixture = await readyFixture({ source: 'throw undefined' })
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'failed', effectObservation: 'applied',
      primaryError: { present: true, type: 'undefined' }, cleanup: { status: 'verified-clean' } })
    expect(fixture.events).toEqual(['gateway-reserve', 'cleanup-page-close',
      'gateway-freeze', 'gateway-terminal-complete', 'gateway-publish'])
  })

  test('primary 与 cleanup 双错并存，retire 错误也不覆盖前两者', async () => {
    const fixture = await readyFixture({ source: "throw new Error('primary')",
      cleanupSource: "throw new Error('cleanup')", retireCleanupError: new Error('retire') })
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'failed', effectObservation: 'unknown',
      primaryError: { type: 'error', message: 'primary' },
      cleanupError: { type: 'error', message: 'cleanup' },
      retireError: { type: 'error', message: 'retire' }, cleanup: { status: 'failed' } })
  })

  test.each([
    ['cleanup 未返回 verified-clean', { cleanupSource: "return 'dirty'" }],
    ['cleanup timeout', { cleanupSource: 'await page.never()', cleanupTimeoutMs: 10 }],
    ['Gateway 冻结集合外请求', { gatewayBlocked: 1 }],
  ])('%s 一律 markUnknown、quarantine 且禁止 retry', async (_name, options) => {
    const fixture = await readyFixture(options)
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'failed', effectObservation: 'unknown', retryAllowed: false })
    expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({ status: 'unknown' })
    expect(await fixture.trustedLease.verifyTarget(fixture.active.leaseId, 1, d('target'))).toBe(false)
  })

  test('明确证明尚未产生效果时返回 proven-not-applied，而不是把异常猜成 unknown', async () => {
    const fixture = await readyFixture({ source: "throw new Error('precondition')",
      effectObservation: 'proven-not-applied' })
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'failed', effectObservation: 'proven-not-applied', retryAllowed: true,
      cleanup: { status: 'verified-clean' } })
  })

  test.each([
    ['after evidence', { capture: async (stage: FullPlaywrightEvidenceStage) => {
      if (stage === 'after') throw new Error('after-evidence')
      return evidenceForStage(stage)
    } }],
    ['observeEffect', { observeEffectError: new Error('observe-effect') }],
    ['duplicate evidence ids', { capture: async (stage: FullPlaywrightEvidenceStage) =>
      evidenceForStage(stage).map((item) => ({ ...item, evidenceId: `DUP-${item.kind}` })) }],
    ['missing required evidence', { capture: async (stage: FullPlaywrightEvidenceStage) =>
      evidenceForStage(stage).filter((item) => item.kind !== 'trace') }],
    ['gateway finish', { gatewayError: new Error('gateway-finish') }],
    ['gateway summary schema', { gatewaySummary: { received: 1, forwarded: 2, blocked: 0, byIntent: {} } }],
  ] as const)('预留后 %s 异常统一 quarantine + markUnknown 且不重试', async (_stage, options) => {
    const fixture = await readyFixture(options)
    const result = await runFullPlaywrightCase(fixture.input)
    expect(result).toMatchObject({ status: 'failed', effectObservation: 'unknown', retryAllowed: false,
      finalization: { state: 'unknown', leaseReceiptDigest: expect.stringMatching(/^sha256:/),
        authorityReceiptDigest: expect.stringMatching(/^sha256:/) } })
    expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({ status: 'unknown' })
    expect(await fixture.trustedLease.verifyTarget(fixture.active.leaseId, 1, d('target'))).toBe(false)
  })
})
}
