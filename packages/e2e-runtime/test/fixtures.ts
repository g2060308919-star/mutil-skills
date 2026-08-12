import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { LocalApprovalAuthority, LocalLeaseAuthority } from '@mutil-skills/e2e-authority'
import {
  InjectionGateway,
  LocalGatewayAuditSigner,
  ReversibleWriteGateway,
  digestJsonHttpPayload,
} from '@mutil-skills/e2e-gateway'
import {
  runReversibleWriteCase,
} from '@mutil-skills/e2e-playwright-runtime'
import { createTestWriteRuntimeSession } from '../../e2e-playwright-runtime/src/production-isolation.js'
import {
  canonicalizeJson,
  digestInjectionResponseBody,
  digestText,
  type InjectionApprovalSubject,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import type {
  GatewayProxyProcessHandle,
  GatewayProxyStartOptions,
  GatewayWriteLifecycle,
} from '../src/gateway-proxy-host.js'
import { startGatewayProxyHostWithTestControl } from '../src/gateway-proxy-host.js'
import { GatewayCleanupTransport, authorizeGatewayCleanupTransport } from '../src/gateway-cleanup-transport.js'

export async function createRuntimeTestRoots(): Promise<{
  root: string
  home: string
  project: string
  source: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-runtime-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const source = join(root, 'source')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(source, { recursive: true }),
  ])
  return { root, home, project, source }
}

/** 让受限执行环境的 loopback EPERM 立即作为明确环境错误返回，而不是测试超时。 */
export async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export async function canBindLoopback(): Promise<boolean> {
  const server = createServer()
  try {
    await listenOnLoopback(server)
    return true
  } catch (error) {
    if (isSystemError(error) && ['EACCES', 'EPERM'].includes(error.code)) return false
    throw error
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function isSystemError(value: unknown): value is NodeJS.ErrnoException & { code: string } {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string'
}

export interface GatewayProxyTestHandle extends GatewayProxyProcessHandle, GatewayWriteLifecycle {
  requestThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string; channel?: 'http' | 'beacon' | 'service-worker' },
    caCertPathOverride?: string,
  ): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }>
  openWebSocketThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string; authorized?: boolean },
  ): Promise<{ status: number; responseHead: string }>
  requestWithTokenHeaders(
    url: string,
    correlation: { actionId: string; capabilityId: string },
    tokenValues: string[],
  ): Promise<{ status: number; body: string }>
}

export async function startGatewayProxyHostForTest(
  options: Omit<GatewayProxyStartOptions, 'authorityRoot'> & { authorityRoot?: string },
): Promise<GatewayProxyTestHandle> {
  const roots = options.authorityRoot === undefined ? await createRuntimeTestRoots() : undefined
  const authorityRoot = options.authorityRoot ?? join(roots!.home, '.mutil-skills', 'e2e', 'authority')
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
  const started = await startGatewayProxyHostWithTestControl({ ...options, authorityRoot })
  return Object.freeze({
    ...started.handle,
    requestThroughProxy: started.requestThroughProxy,
    openWebSocketThroughProxy: started.openWebSocketThroughProxy,
    requestWithTokenHeaders: started.requestWithTokenHeaders,
    writeAuditSummary: started.writeLifecycle.writeAuditSummary,
    writeExecutionSessionId: started.writeLifecycle.writeExecutionSessionId,
    reserveWrite: started.writeLifecycle.reserveWrite,
    finalizeWriteOutcome: started.writeLifecycle.finalizeWriteOutcome,
    markUnknownWithOutcome: started.writeLifecycle.markUnknownWithOutcome,
    markUnknown: started.writeLifecycle.markUnknown,
  })
}

const FLOW_NOW = new Date('2026-07-17T00:00:00.000Z')
const flowDigest = (value: string): string => digestText('runtime-vertical-fixture/v1', value)
const flowApprover = { subject: 'os-user:fixture', roles: ['e2e-approver'] }

export interface WriteFixtureFlowResult {
  result: { status: 'passed' | 'safety-blocked'; outcomeDigest: string; effectObservation: 'applied' | 'unknown' }
  gatewayAudit: ReturnType<ReturnType<LocalGatewayAuditSigner['createRecorder']>['finalize']>
  cleanup: { status: 'verified-clean' | 'failed' | 'unknown'; resultDigest: string; leaseReceiptDigest: string }
  retryDecision: { allowed: false; reason: string } | { allowed: true }
  resumeAutomatically: false
  lease: { status: 'released' | 'quarantined' }
  upstreamWriteCount: number
}

export async function executeWriteFixtureFlow(input: {
  effectObservation: 'applied' | 'unknown'
  cleanupStatus: 'verified-clean' | 'unknown'
}): Promise<WriteFixtureFlowResult> {
  const authority = fixtureApprovalAuthority()
  const leaseAuthority = new LocalLeaseAuthority({ now: () => FLOW_NOW })
  const targetFingerprint = flowDigest('order:100')
  const tentative = await leaseAuthority.acquire({ runId: 'RUN-1', resourceKey: 'order:100',
    resourceFingerprint: targetFingerprint, exclusive: true, ttlMs: 60_000 })
  const lease = await leaseAuthority.activate(tentative.leaseId)
  const discovery = await readyDiscovery(authority)
  const request = { intentId: 'INTENT-ORDER-UPDATE', method: 'POST',
    canonicalOrigin: 'https://test.example.com', exactPath: '/api/orders/100/approve',
    query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const }, targetFingerprint,
    maxRequests: 1, expectedOrder: 1 }
  const subject: WriteApprovalSubject = {
    schemaVersion: '2.0.0', assetId: 'ASSET-ORDER', prdRevision: flowDigest('prd'),
    executionDigest: flowDigest('execution'), scopeDigest: flowDigest('scope'),
    requirementModelDigest: flowDigest('requirements'), coveragePolicyDigest: flowDigest('coverage'),
    universeDigest: flowDigest('universe'), caseDigest: flowDigest('cases'), actionMapDigest: flowDigest('actions'),
    policyDigest: flowDigest('policy'), executionContractDigest: flowDigest('contract'),
    runBundleProjectionDigest: flowDigest('bundle'), environment: 'test',
    baseOrigin: 'https://test.example.com', actor: 'qa', discoveryGrantId: discovery.grantId,
    preflightDigest: discovery.preflightDigest, actions: [{ actionId: 'ACTION-ORDER-UPDATE',
      effect: 'reversible-write', dataLeaseId: lease.leaseId, resourceKey: 'order:100',
      fencingToken: lease.fencingToken!,
      cleanupPlanDigest: flowDigest('cleanup-plan'), requests: [request] }],
  }
  const grant = await authority.issueWriteGrant({ subject, approver: flowApprover,
    approvalSessionRef: 'fixture-session', ttlMs: 60_000 })
  const capability = grant.capabilities[0]!
  const signer = LocalGatewayAuditSigner.create({ issuer: 'fixture-gateway', keyId: 'fixture-key',
    instanceId: 'GATEWAY-RUN-1', version: '1.0.0' })
  const recorder = signer.createRecorder(flowDigest('gateway-policy'))
  const gateway = new ReversibleWriteGateway({ grant, currentSubject: subject, capability,
    attemptId: 'ATTEMPT-WRITE-1', attemptContext: { assetId: subject.assetId, generationId: 'GEN-1',
      prdRevision: subject.prdRevision, runId: 'RUN-1', caseId: 'CASE-ORDER-UPDATE' },
    authority: { verifyForSubject: (grant, current) => authority.verifyForSubject(grant, current),
      reserveForSubject: (reservation) => authority.reserveForSubject(reservation),
      complete: async (reservationId, outcomeDigest) => await authority.complete(reservationId, outcomeDigest),
      markUnknown: async (reservationId, observation) => await authority.markUnknown(reservationId, observation) },
    leaseAuthority, recorder, outcomeSigner: signer })
  let pageState: 'pending' | 'approved' = 'pending'
  let upstreamWriteCount = 0
  const runResult = await runReversibleWriteCase({ caseId: 'CASE-ORDER-UPDATE',
    actionId: capability.actionId, url: 'https://test.example.com/orders/100', buttonName: '批准订单',
    beforeText: '待审核', afterText: '已批准', expectedIdentity: { title: 'Order', heading: 'Order 100' },
    authorization: { grant, currentSubject: subject,
      authority: authority.createWriteExecutionClient(grant.approvalContext) },
    lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken!, targetFingerprint,
      authority: leaseAuthority.createExecutionClient() },
    runtime: createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
      authorityTransport: 'in-process-test' }), gatewayAudit: () => gateway.getAuditSummary(),
    page: {
      goto: async () => undefined,
      identity: async () => ({ url: 'https://test.example.com/orders/100', title: 'Order',
        headings: ['Order 100'], role: 'qa' }),
      containsText: async (text) => text === (pageState === 'pending' ? '待审核' : '已批准'),
      clickButton: async () => {
        const decision = await gateway.decide({ method: 'POST', url: 'https://test.example.com/api/orders/100/approve' })
        if (decision.decision !== 'forward') throw new Error(decision.code)
        upstreamWriteCount += 1
        if (input.effectObservation === 'applied') pageState = 'approved'
      },
      waitForText: async (text) => text === '已批准' && pageState === 'approved',
      screenshot: async () => Uint8Array.from([1, 2, 3]), domSnapshot: async () => `<main>${pageState}</main>`,
    },
  })
  const runnerResultDigest = flowDigest(canonicalizeJson(runResult))
  const cleanupTransport = new GatewayCleanupTransport({
    gateway: authorizeGatewayCleanupTransport(async () => ({ status: input.cleanupStatus,
      resultDigest: flowDigest(`cleanup-${input.cleanupStatus}`) })),
    authority: {
      releaseLease: async (release) => await leaseAuthority.releaseForTarget(release),
      quarantineLease: async (quarantine) => await leaseAuthority.quarantineForTarget(quarantine),
    },
  })
  const cleanup = await cleanupTransport.execute({ runId: 'RUN-1', actionId: capability.actionId,
    cleanupPlanId: 'CLEANUP-ORDER-UPDATE', cleanupPlanDigest: capability.cleanupPlanDigest,
    outcomeDigest: runnerResultDigest, leaseId: lease.leaseId, fencingToken: lease.fencingToken!, targetFingerprint })
  let outcomeDigest: string
  if (runResult.effectObservation === 'applied' && cleanup.status === 'verified-clean') {
    const receipt = await gateway.completeWithExecutionOutcome({ status: runResult.status,
      effectObservation: runResult.effectObservation, runnerResultDigest, cleanupPlanId: 'CLEANUP-ORDER-UPDATE',
      cleanup, evidenceIds: runResult.evidence.map((item) => item.digest), completedAt: FLOW_NOW.toISOString() })
    outcomeDigest = receipt.signedDigest
  } else {
    await gateway.markUnknown('runner-effect-or-cleanup-unknown')
    outcomeDigest = flowDigest('effect-unknown')
  }
  const publication = recorder.finalize()
  const activeLease = await leaseAuthority.getLeaseForTarget(lease.leaseId, lease.fencingToken!, targetFingerprint)
  authority.close()
  return { result: { status: runResult.effectObservation === 'applied' && cleanup.status === 'verified-clean'
    ? 'passed' : 'safety-blocked', outcomeDigest,
    effectObservation: runResult.effectObservation === 'applied' ? 'applied' : 'unknown' },
    gatewayAudit: publication, cleanup,
    retryDecision: runResult.effectObservation === 'unknown' || cleanup.status === 'unknown'
      ? { allowed: false, reason: 'E2E_RUNTIME_EFFECT_UNKNOWN_RETRY_DENIED' } : { allowed: true },
    resumeAutomatically: false, lease: { status: activeLease!.status as 'released' | 'quarantined' },
    upstreamWriteCount }
}

export interface InjectionFixtureFlowResult {
  result: { mode: 'gateway-injection'; status: number }
  gatewayAudit: { counters: { injected: number; forwarded: number } }
  upstreamWriteCount: number
  realEnvironmentResult: { mode: 'real-environment'; status: 'passed' }
}

export async function executeInjectionFixtureFlow(input: { injectedStatus: number }): Promise<InjectionFixtureFlowResult> {
  const authority = fixtureApprovalAuthority()
  const payload = { query: 'order-100' }
  const body = JSON.stringify({ code: 'INJECTED' })
  const action = { actionId: 'ACTION-INJECT', caseId: 'CASE-INJECT', runId: 'RUN-1', attemptSlot: 1,
    request: { intentId: 'INTENT-INJECT', method: 'POST', canonicalOrigin: 'https://test.example.com',
      exactPath: '/api/orders/search', query: [] as Array<[string, string]>,
      payload: { kind: 'json' as const, digest: digestJsonHttpPayload(payload) },
      targetFingerprint: 'not-applicable' as const, maxRequests: 1, expectedOrder: 1 },
    response: { kind: 'http-response' as const, status: input.injectedStatus, headers: [],
      body: { kind: 'utf8' as const, value: body, digest: digestInjectionResponseBody(body) }, delayMs: 0 },
    expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden' as const }
  const subject: InjectionApprovalSubject = { schemaVersion: '1.0.0', assetId: 'ASSET-INJECT',
    prdRevision: flowDigest('prd-inject'), executionDigest: flowDigest('execution-inject'),
    environment: 'test', baseOrigin: 'https://test.example.com', actions: [action] }
  const grant = await authority.issueInjectionGrant({ subject, approver: flowApprover,
    approvalSessionRef: 'fixture-session', ttlMs: 60_000 })
  const gateway = new InjectionGateway({ stage: 'case', grant, attemptId: 'ATTEMPT-INJECT', authority: {
    verify: (candidate) => authority.verify(candidate),
    reserveForSubject: (reservation) => authority.reserveForSubject(reservation),
    complete: async (reservationId, outcomeDigest) => { await authority.complete(reservationId, outcomeDigest) },
    markUnknown: async (reservationId, observation) => { await authority.markUnknown(reservationId, observation) },
  },
    bootstrapIntents: [], caseReadIntents: [] })
  let upstreamWriteCount = 0
  const decision = await gateway.decide({ method: 'POST', url: 'https://test.example.com/api/orders/search',
    body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' })
  if (decision.decision === 'forward') upstreamWriteCount += 1
  if (decision.decision !== 'inject') throw new Error('code' in decision ? decision.code : 'unexpected forward')
  const audit = gateway.getAuditSummary()
  authority.close()
  return { result: { mode: 'gateway-injection', status: decision.response.status as number },
    gatewayAudit: { counters: { injected: audit.matched, forwarded: audit.injectionTargetForwarded } },
    upstreamWriteCount, realEnvironmentResult: { mode: 'real-environment', status: 'passed' } }
}

function fixtureApprovalAuthority(): LocalApprovalAuthority {
  return LocalApprovalAuthority.create({ issuer: 'fixture-authority', keyId: 'fixture-key', now: () => FLOW_NOW,
    approvalIdentities: [flowApprover], authenticateApproverSession: (sessionRef, expected) =>
      sessionRef === 'fixture-session' ? { subject: flowApprover.subject, runId: 'RUN-1',
        approvalType: expected.approvalType, subjectDigest: expected.subjectDigest,
        installationDigest: flowDigest('installation'), origin: 'http://127.0.0.1:43210',
        issuedAt: FLOW_NOW.toISOString(), expiresAt: new Date(FLOW_NOW.getTime() + 60_000).toISOString() } : undefined })
}

async function readyDiscovery(authority: LocalApprovalAuthority): Promise<{ grantId: string; preflightDigest: string }> {
  const subject = { schemaVersion: '1.1.0' as const, assetId: 'ASSET-ORDER', prdRevision: flowDigest('prd'),
    scopeDigest: flowDigest('scope'), environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'qa',
    expectedPageIdentity: { url: 'https://test.example.com/orders/100', title: 'Order', heading: 'Order 100',
      ariaSignals: ['main'] }, bootstrapIntentsDigest: flowDigest('bootstrap'), requests: [],
    actions: [{ actionId: 'ACTION-DISCOVERY', operation: 'local-navigation' as const,
      maxUses: 1 as const, requestIds: [] }] }
  const grant = await authority.issueDiscoveryGrant({ subject, approver: flowApprover,
    approvalSessionRef: 'fixture-session', ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant, currentSubject: subject,
    capabilityId: grant.capabilities[0]!.capabilityId, actionId: 'ACTION-DISCOVERY', attemptId: 'ATTEMPT-DISCOVERY' })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant, currentSubject: subject,
    reservationId: reservation.reservationId, capabilityId: grant.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: subject.expectedPageIdentity.url, title: 'Order',
      headings: ['Order 100'], role: 'qa', ariaSignals: ['main'] } } })
  return { grantId: grant.grantId, preflightDigest }
}
