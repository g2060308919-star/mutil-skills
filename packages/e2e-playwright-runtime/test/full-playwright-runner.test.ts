import { describe, expect, test } from 'vitest'
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
  createTestControlledFullPlaywrightSession,
  createTestWriteRuntimeSession,
  runFullPlaywrightCase,
  type FullPlaywrightBindings,
  type FullPlaywrightEvidenceStage,
} from '../src/index.js'

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
  retireProgramError?: Error
  retireCleanupError?: Error
  networkRequests?: FullPlaywrightProgram['networkRequests']
  capture?: (stage: FullPlaywrightEvidenceStage) => Promise<ReturnType<typeof evidenceForStage>>
  gatewaySummary?: { received: number; forwarded: number; blocked: number; byIntent: Record<string, number> }
  issueOutcome?: (binding: ExecutionOutcomeBinding) => ExecutionOutcomeReceipt
} = {}) {
  const events: string[] = []
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
  const request = { async post(url: string) { events.push(`request:${url}`); return { ok: () => true } } }
  const expectBinding = (actual: unknown) => ({ async toBeTruthy() {
    events.push('expect'); if (!actual) throw new Error('expectation failed')
  } })
  const programBindings = input.programBindings ?? {
    page: programPage, context: programContext, browser, request, expect: expectBinding,
    testInfo: { title: 'full runner' }, state,
  }
  const cleanupBindings = input.cleanupBindings ?? {
    page: cleanupPage, context: cleanupContext, browser: { name: 'cleanup-browser' },
    request: { name: 'cleanup-request' }, expect: expectBinding, testInfo: { title: 'cleanup' }, state,
  }
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
      dataLeaseId: active.leaseId, fencingToken: 1, cleanupPlanDigest, requests: input.networkRequests ?? [] }],
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
    releaseForTarget: (value: Parameters<LocalLeaseAuthority['releaseForTarget']>[0]) =>
      leaseAuthority.releaseForTarget(value),
    quarantineForTarget: (value: Parameters<LocalLeaseAuthority['quarantineForTarget']>[0]) =>
      leaseAuthority.quarantineForTarget(value),
  }
  const trustedLease = leaseAuthority.createExecutionClient()
  const evidence = (stage: FullPlaywrightEvidenceStage) => evidenceForStage(stage)
  const gatewaySummary = input.gatewaySummary ?? { received: 1, forwarded: 1, blocked: input.gatewayBlocked ?? 0,
    byIntent: { 'LOCAL-DOCUMENT': 1 } }
  const session = createTestControlledFullPlaywrightSession({
    binding: { executionProfile: 'full-playwright', runId: 'RUN-TEST', caseId: 'CASE-1', stepId: 'STEP-1',
      actionId: 'ACTION-1', capabilityId: capability.capabilityId, programDigest: program.sourceDigest,
      cleanupProgramDigest: program.cleanupSourceDigest, cleanupPlanDigest, leaseId: active.leaseId, fencingToken: 1,
      targetFingerprint: d('target'), approvedRequestSetDigest: digestText(
        'execution-outcome-approved-request-set/v1', canonicalizeJson(input.networkRequests ?? [])),
      gatewayPolicyDigest: d('gateway-policy'), executionSessionId: 'GW-SESSION-1' },
    programBindings, cleanupBindings, capture: input.capture ?? (async (stage) => evidence(stage)),
    retireProgram: async () => { events.push('retire-program'); if (input.retireProgramError) throw input.retireProgramError },
    retireCleanup: async () => { events.push('retire-cleanup'); if (input.retireCleanupError) throw input.retireCleanupError },
    observeEffect: () => input.effectObservation ?? 'applied',
    finalizeGateway: async () => ({ executionSessionId: 'GW-SESSION-1', policyDigest: d('gateway-policy'),
      summary: gatewaySummary, auditDigest: d('gateway-audit') }),
    issueOutcome: input.issueOutcome ?? ((binding) => ({ ...binding, issuer: 'GATEWAY', keyId: 'GW-KEY',
      purpose: 'execution-outcome-receipt/v1', algorithm: 'Ed25519',
      signedDigest: digestExecutionOutcomeBinding(binding), signature: 'test-signature' })),
  })
  const attemptContext = { assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: d('prd'),
    runId: 'RUN-TEST', caseId: 'CASE-1' }
  return { events, state, program, cleanupPlan, authority, grant, subject, freshnessReceipt,
    active, trustedLease, terminalAuthority, session, attemptContext,
    input: { program, cleanupPlan, attemptId: 'ATTEMPT-1', attemptContext,
      authorization: { grant, currentSubject: subject, freshnessReceipt,
        freshnessAuthority: authority.createTrustedApprovalFreshnessClient(),
        authority: authority.createWriteExecutionClient(grant.approvalContext) },
      lease: { leaseId: active.leaseId, fencingToken: 1, targetFingerprint: d('target'),
        authority: trustedLease, terminalAuthority },
      runtime: createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
        authorityTransport: 'in-process-test' }), session },
  }
}

describe('runFullPlaywrightCase', () => {
  test('完整 Playwright bindings、独立 cleanup、证据和签名 outcome 一次闭合', async () => {
    const fixture = await readyFixture()
    const result = await runFullPlaywrightCase(fixture.input)

    expect(result).toMatchObject({ status: 'passed', effectObservation: 'applied', retryAllowed: false,
      cleanup: { status: 'verified-clean' } })
    expect(fixture.events).toEqual([
      'fill:Name:Ada', 'press:Name:Enter', 'check:Enabled', 'click:link:Details', 'dblclick:#row',
      'hover:#remove', 'popup:page', 'new-context', 'new-page', 'request:http://127.0.0.1/api',
      'expect', 'cleanup-page-close',
    ])
    expect(result.evidence.map((item) => item.stage)).toEqual(expect.arrayContaining(['before', 'after', 'cleanup']))
    expect(result.outcome).toBeDefined()
    expect(result.outcome?.signedDigest).toBe(result.resultDigest)
    expect(fixture.authority.getReservation(result.reservationId!)).toMatchObject({ status: 'completed' })
  })

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
    expect(fixture.events).toEqual(['retire-program', 'cleanup-page-close'])
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
    expect(fixture.events).toEqual(['cleanup-page-close'])
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
})
