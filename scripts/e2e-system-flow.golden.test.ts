import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'
import {
  canonicalizeJson, digestDecisionSubject, digestText,
  projectLineageDecisionSubject, projectScopeDecisionSubject,
  type EntityLineageMapping, type WorkflowState,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import {
  LocalArtifactStore,
  computePrdRevision,
  computeVerdict,
  diffPrdRevision,
  pauseWorkflow,
  reconcileEntityLineage,
  resumeWorkflow,
  selectFinalAttempt,
  type SemanticLineageEntity,
  workflowResumeAuthorizationDigest,
} from '@mutil-skills/e2e-engine'
import {
  LocalGatewayAuditSigner, LocalGatewayAuditVerifier, ReadOnlyGateway,
  verifyGatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import {
  PlaywrightPageAdapter, runBrowserPreflight, runReadOnlyCase,
  type BrowserPreflightResult, type ReadOnlyCaseResult,
} from '@mutil-skills/e2e-playwright-runtime'
import { renderReadOnlyReport } from '@mutil-skills/e2e-report'
import { createGoldenAttemptProof } from './e2e-golden-attempt.js'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'

const tempDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Spec §29 流程与 preflight 系统 E2E', () => {
  test('场景 2：PRD 歧义暂停后用 Authority 决定从原节点恢复并发布', async () => {
    const authority = approvalAuthority()
    const original: WorkflowState = {
      current: 'awaiting-scope-approval', sequence: 3,
      eventChainDigest: digestText('workflow-chain/v1', 'before-ambiguity'),
    }
    const paused = pauseWorkflow({ state: original, decisionId: 'DECISION-ROLE-1', reason: '审核角色范围存在歧义' })
    const decisionDigest = digestText('scope-decision/v1', canonicalizeJson({
      decisionId: 'DECISION-ROLE-1', answer: '仅验收审核员', source: 'user-decision',
    }))
    const proof = authority.signArtifactDigest(workflowResumeAuthorizationDigest(paused.pending, decisionDigest))
    const resumed = resumeWorkflow({
      state: paused.state, pending: paused.pending, decisionId: 'DECISION-ROLE-1', decisionDigest,
      decisionProof: proof, verifyDecisionProof: (candidate) => authority.verifyArtifactSignature(candidate),
    })
    const revision = digestText('prd-revision/v1', 'ambiguity-resolved')
    const execution = await executeRead({
      authority, revision, caseId: 'CASE-SCENARIO-2', generationId: 'GEN-SCENARIO-2',
      html: orderPage('auditor'), expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' },
    })
    const scopeArtifact = approvedScopeArtifact(authority, 'SCOPE-SCENARIO-2', {
      ambiguityId: 'AMBIGUITY-ROLE-1', question: '验收操作应使用哪个角色？',
      resolution: '仅使用 auditor（审核员）角色',
    })
    const published = await publishResult({
      authority, revision, generationId: 'GEN-SCENARIO-2', result: execution.result,
      gatewayAudit: execution.gatewayAudit, gatewayVerifier: execution.gatewayVerifier,
      scopeArtifact,
      workflowArtifact: { paused, resumed, decisionDigest, proof },
    })

    expect(resumed.state.current).toBe('awaiting-scope-approval')
    expect(execution.result.status).toBe('passed')
    expect(published.active).toMatchObject({ terminalVerdict: 'accepted', generationId: 'GEN-SCENARIO-2' })
    expect(await readFile(join(published.active.generationPath, 'run/workflow.json'), 'utf8')).toContain('DECISION-ROLE-1')
  }, 30_000)

  test('场景 3：附件 bytes 变化产生新 Revision，仅受影响实体重审后切换新代', async () => {
    const authority = approvalAuthority()
    const sourceIdentity = { sourceId: 'PRD-ORDER', version: '1', kind: 'file' }
    const firstRevision = computePrdRevision({
      normalizedPrd: '# 订单验收', sourceIdentity,
      attachments: [{ sourceId: 'ATTACHMENT-RULES', fileName: 'rules.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1]) }],
    })
    const secondRevision = computePrdRevision({
      normalizedPrd: '# 订单验收', sourceIdentity,
      attachments: [{ sourceId: 'ATTACHMENT-RULES', fileName: 'rules.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([2]) }],
    })
    const diff = diffPrdRevision({
      previous: firstRevision, current: secondRevision,
      entities: [
        { entityId: 'REQ-RULES', sourceIds: ['ATTACHMENT-RULES'] },
        { entityId: 'REQ-LIST', sourceIds: ['PRD-BODY'] },
      ],
    })
    const firstRun = await executeRead({
      authority, revision: firstRevision.prdRevision, caseId: 'CASE-REVISION', generationId: 'GEN-REV-1',
      html: orderPage('auditor'), expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' },
    })
    const firstPublished = await publishResult({
      authority, revision: firstRevision.prdRevision, generationId: 'GEN-REV-1', result: firstRun.result,
    })
    const paused = pauseWorkflow({
      state: { current: 'awaiting-scope-approval', sequence: 4, eventChainDigest: digestText('workflow-chain/v1', 'revision-2') },
      decisionId: 'DECISION-REVISION-2', reason: '附件变化需要重审受影响范围',
    })
    const reviewDigest = digestText('lineage-review/v1', canonicalizeJson(diff))
    const reviewProof = authority.signArtifactDigest(workflowResumeAuthorizationDigest(paused.pending, reviewDigest))
    resumeWorkflow({
      state: paused.state, pending: paused.pending, decisionId: 'DECISION-REVISION-2', decisionDigest: reviewDigest,
      decisionProof: reviewProof, verifyDecisionProof: (candidate) => authority.verifyArtifactSignature(candidate),
    })
    const previousEntities: SemanticLineageEntity[] = [
      { entityKind: 'requirement', entityId: 'REQ-LIST', semanticKey: 'order:list', sourceRefs: ['PRD-BODY'] },
      { entityKind: 'rule', entityId: 'REQ-RULES', semanticKey: 'order:rules', sourceRefs: ['ATTACHMENT-RULES'] },
    ]
    const currentEntities: SemanticLineageEntity[] = [
      { entityKind: 'requirement', entityId: 'REQ-LIST', semanticKey: 'order:list', sourceRefs: ['PRD-BODY'] },
      { entityKind: 'rule', entityId: 'REQ-RULES', semanticKey: 'order:rules', sourceRefs: ['ATTACHMENT-RULES'] },
    ]
    const lineageMappings = reconcileEntityLineage({ previous: previousEntities, current: currentEntities,
      explicitMappings: [] })
    const lineageArtifact = approvedLineageArtifact(authority, {
      previousRevision: firstRevision.prdRevision, currentRevision: secondRevision.prdRevision,
      lineageMappings, impactedEntityIds: diff.impactedEntityIds,
    })
    const scopeArtifact = approvedScopeArtifact(authority, 'SCOPE-REVISION-2')
    const secondRun = await executeRead({
      authority, revision: secondRevision.prdRevision, caseId: 'CASE-REVISION', generationId: 'GEN-REV-2',
      html: orderPage('auditor'), expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' },
    })
    const secondPublished = await publishResult({
      authority, revision: secondRevision.prdRevision, generationId: 'GEN-REV-2', result: secondRun.result,
      workspace: firstPublished.workspace,
      gatewayAudit: secondRun.gatewayAudit, gatewayVerifier: secondRun.gatewayVerifier,
      scopeArtifact, lineageArtifact, lineageEntities: { previous: previousEntities, current: currentEntities },
      extraFiles: { 'requirements/prd-diff.json': JSON.stringify({ ...diff, lineageReviewDigest: reviewDigest }) },
    })

    expect(diff).toMatchObject({
      changedSourceIds: ['ATTACHMENT-RULES'], impactedEntityIds: ['REQ-RULES'],
      stableEntityIds: ['REQ-LIST'], scopeReapprovalRequired: true,
    })
    expect(firstRun.grant.subject.prdRevision).not.toBe(secondRevision.prdRevision)
    await expect(authority.verifyForSubject(firstRun.grant, secondRun.grant.subject))
      .resolves.toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SUBJECT_MISMATCH' })
    expect(secondPublished.active).toMatchObject({ generationId: 'GEN-REV-2', terminalVerdict: 'accepted' })
    expect(secondPublished.active.previousGenerationId).toBeNull()
  }, 30_000)

  test('场景 4：真实浏览器落到错误 URL 时在 Oracle 前 environment-blocked', async () => {
    const authority = approvalAuthority()
    const revision = digestText('prd-revision/v1', 'wrong-url')
    const preflight = await executeDiscoveryPreflight({
      authority, revision, caseId: 'CASE-WRONG-URL', generationId: 'GEN-WRONG-URL',
      html: orderPage('auditor'), redirectTo: '/login', allowedPaths: ['/orders', '/login'],
      expectedIdentity: { url: 'http://fixture.test/orders', title: '订单', heading: '订单列表', role: 'auditor' },
    })
    const result = preflightCaseResult('CASE-WRONG-URL', preflight.result, preflight.gatewayAudit)
    const published = await publishResult({ authority, revision, generationId: 'GEN-WRONG-URL', result,
      gatewayAudit: preflight.gatewayAudit, gatewayVerifier: preflight.gatewayVerifier })

    expect(preflight.result).toMatchObject({ status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_URL_MISMATCH' })
    expect(preflight.grant.subject.actions).toEqual([{
      actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation', maxUses: 1, requestIds: [],
    }])
    expect(result.actual).toEqual([])
    expect(published.active.terminalVerdict).toBe('environment-blocked')
  }, 30_000)

  test('场景 5：真实浏览器角色与批准角色不符时 input-blocked，不记业务失败', async () => {
    const authority = approvalAuthority()
    const revision = digestText('prd-revision/v1', 'wrong-role')
    const preflight = await executeDiscoveryPreflight({
      authority, revision, caseId: 'CASE-WRONG-ROLE', generationId: 'GEN-WRONG-ROLE',
      html: orderPage('ordinary-user'),
      expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' },
    })
    const result = preflightCaseResult('CASE-WRONG-ROLE', preflight.result, preflight.gatewayAudit)
    const published = await publishResult({ authority, revision, generationId: 'GEN-WRONG-ROLE', result,
      gatewayAudit: preflight.gatewayAudit, gatewayVerifier: preflight.gatewayVerifier })

    expect(preflight.result).toMatchObject({ status: 'input-blocked', reasonCode: 'E2E_RUNTIME_ROLE_MISMATCH' })
    expect(published.verdict).toMatchObject({ verdict: 'incomplete', businessFailuresObserved: [] })
    expect(published.active.terminalVerdict).toBe('incomplete')
  }, 30_000)
})

function approvalAuthority(): LocalApprovalAuthority {
  return LocalApprovalAuthority.create({
    issuer: 'local-authority', keyId: 'local-key-flow', now: () => new Date('2026-07-12T10:00:00.000Z'),
    approvalIdentities: [{ subject: 'os-user:flow', roles: ['e2e-approver'] }],
    manualIdentities: [{ subject: 'os-user:flow-reviewer', roles: ['scope-approver', 'lineage-approver'] }],
    authenticateApproverSession: (sessionRef, expected) => sessionRef === 'flow-session'
      ? createGoldenApprovalReceipt('os-user:flow', 'RUN-SYSTEM-FLOW', expected,
        '2026-07-12T09:59:00.000Z') : undefined,
  })
}

async function executeDiscoveryPreflight(input: {
  authority: LocalApprovalAuthority
  revision: string
  caseId: string
  generationId: string
  html: string
  redirectTo?: string
  allowedPaths?: string[]
  expectedIdentity: { url?: string; title: string; heading: string; role: string }
}): Promise<{
  result: BrowserPreflightResult
  grant: Awaited<ReturnType<LocalApprovalAuthority['issueDiscoveryGrant']>>
  gatewayAudit: ReturnType<ReturnType<LocalGatewayAuditSigner['createRecorder']>['finalize']>
  gatewayVerifier: LocalGatewayAuditVerifier
}> {
  const fixture = createServer((request, response) => {
    if (request.url === '/orders' && input.redirectTo) {
      response.writeHead(302, { location: input.redirectTo }).end()
      return
    }
    if ((request.url === '/orders' || request.url === input.redirectTo) && request.method === 'GET') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(input.html)
      return
    }
    response.writeHead(404).end('not found')
  })
  const fixturePort = await listen(fixture)
  const fixtureOrigin = `http://fixture.test:${fixturePort}`
  const paths = input.allowedPaths ?? ['/orders']
  const actionId = 'ACTION-PREFLIGHT'
  const signer = LocalGatewayAuditSigner.create({ issuer: 'flow-gateway', keyId: `flow-${input.caseId}`,
    instanceId: `GATEWAY-${input.caseId}`, version: '1.0.0' })
  const gatewayVerifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
  const recorder = signer.createRecorder(digestText('gateway-policy/v1', `${input.revision}:${input.caseId}`))
  const gateway = new ReadOnlyGateway({
    stage: 'bootstrap', recorder,
    intents: paths.map((path, index) => ({
      intentId: `INTENT-PREFLIGHT-${input.caseId}-${index + 1}`, stage: 'bootstrap' as const,
      methods: ['GET'] as Array<'GET'>, actionId, origin: fixtureOrigin, exactPath: path, query: [], maxRequests: 1,
    })),
  })
  const proxy = createServer((request, response) => {
    const decision = gateway.decide({ method: request.method ?? 'GET', url: request.url ?? '' }, actionId)
    if (decision.decision === 'block') {
      response.writeHead(403).end(decision.code)
      return
    }
    const target = new URL(request.url!)
    const forwarded = httpRequest({
      hostname: '127.0.0.1', port: fixturePort, path: `${target.pathname}${target.search}`,
      method: request.method, headers: { ...request.headers, host: `fixture.test:${fixturePort}` },
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 500, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', (error) => response.writeHead(502).end(error.message))
    request.pipe(forwarded)
  })
  const proxyPort = await listen(proxy)
  const expectedUrl = (input.expectedIdentity.url ?? 'http://fixture.test/orders')
    .replace('http://fixture.test', fixtureOrigin)
  const currentSubject = {
    schemaVersion: '1.1.0' as const,
    assetId: 'PRODUCT-PRD-FLOW', prdRevision: input.revision, scopeDigest: input.revision,
    environment: 'test' as const, baseOrigin: fixtureOrigin, actor: input.expectedIdentity.role,
    expectedPageIdentity: {
      url: expectedUrl, title: input.expectedIdentity.title, heading: input.expectedIdentity.heading,
      ariaSignals: [`main:${input.expectedIdentity.heading}`],
    },
    bootstrapIntentsDigest: digestText('bootstrap-intents/v1', canonicalizeJson(paths)),
    requests: [],
    actions: [{ actionId, operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
  }
  const grant = await input.authority.issueDiscoveryGrant({
    subject: currentSubject, approver: { subject: 'os-user:flow', roles: ['e2e-approver'] },
    approvalSessionRef: 'flow-session', ttlMs: 60_000,
  })
  const browser = await chromium.launch({
    executablePath: resolveChromeExecutablePath(), headless: true,
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
  })
  try {
    const page = await browser.newPage()
    const result = await runBrowserPreflight({
      authorization: { grant, currentSubject, authority: input.authority },
      runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(),
      page: new PlaywrightPageAdapter(page), actionId,
      attemptId: `ATTEMPT-PREFLIGHT-${input.generationId}`,
    })
    const gatewayAudit = recorder.finalize()
    if (!verifyGatewayPublicationAudit(gatewayAudit, gatewayVerifier)) throw new Error('Gateway 签名审计无效')
    return { result, grant, gatewayAudit, gatewayVerifier }
  } finally {
    await browser.close()
  }
}

function preflightCaseResult(
  caseId: string,
  preflight: BrowserPreflightResult,
  gatewayAudit: ReturnType<ReturnType<LocalGatewayAuditSigner['createRecorder']>['finalize']>,
): ReadOnlyCaseResult {
  return {
    caseId, actionId: 'ACTION-PREFLIGHT',
    status: preflight.status === 'ready' ? 'passed' : preflight.status,
    ...(preflight.reasonCode ? { reasonCode: preflight.reasonCode } : {}),
    expected: ['Discovery preflight ready'], actual: [],
    ...(preflight.observedIdentity ? { observedIdentity: preflight.observedIdentity } : {}),
    evidence: [{ kind: 'gateway-audit', byteLength: Buffer.byteLength(canonicalizeJson(gatewayAudit), 'utf8'),
      digest: digestText('runtime-evidence/gateway-audit/v1', canonicalizeJson(gatewayAudit)) }],
  }
}

async function executeRead(input: {
  authority: LocalApprovalAuthority
  revision: string
  caseId: string
  generationId: string
  html: string
  redirectTo?: string
  allowedPaths?: string[]
  expectedIdentity: { url?: string; title: string; heading: string; role?: string }
}): Promise<{
  result: ReadOnlyCaseResult
  grant: Awaited<ReturnType<LocalApprovalAuthority['issueReadGrant']>>
  gatewayAudit: ReturnType<ReturnType<LocalGatewayAuditSigner['createRecorder']>['finalize']>
  gatewayVerifier: LocalGatewayAuditVerifier
}> {
  const fixture = createServer((request, response) => {
    if (request.url === '/orders' && input.redirectTo) {
      response.writeHead(302, { location: input.redirectTo }).end()
      return
    }
    if ((request.url === '/orders' || request.url === input.redirectTo) && request.method === 'GET') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(input.html)
      return
    }
    response.writeHead(404).end('not found')
  })
  const fixturePort = await listen(fixture)
  const fixtureOrigin = `http://fixture.test:${fixturePort}`
  const paths = input.allowedPaths ?? ['/orders']
  const preflightActionId = `ACTION-PREFLIGHT-${input.caseId}`
  const caseActionId = `ACTION-${input.caseId}`
  const signer = LocalGatewayAuditSigner.create({ issuer: 'flow-read-gateway', keyId: `read-${input.caseId}`,
    instanceId: `GATEWAY-READ-${input.caseId}`, version: '1.0.0' })
  const gatewayVerifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
  const recorder = signer.createRecorder(digestText('gateway-policy/v1', `${input.revision}:${input.caseId}`))
  let currentActionId = preflightActionId
  const gateway = new ReadOnlyGateway({
    stage: 'bootstrap', recorder,
    intents: paths.flatMap((path, index) => ([
      { intentId: `INTENT-PREFLIGHT-${input.caseId}-${index + 1}`, stage: 'bootstrap' as const,
        methods: ['GET'] as Array<'GET'>, actionId: preflightActionId,
        origin: fixtureOrigin, exactPath: path, query: [], maxRequests: 1 },
      { intentId: `INTENT-CASE-${input.caseId}-${index + 1}`, stage: 'case' as const,
        methods: ['GET'] as Array<'GET'>, actionId: caseActionId,
        origin: fixtureOrigin, exactPath: path, query: [], maxRequests: 1 },
    ])),
  })
  const proxy = createServer((request, response) => {
    const decision = gateway.decide({ method: request.method ?? 'GET', url: request.url ?? '' }, currentActionId)
    if (decision.decision === 'block') {
      response.writeHead(403).end(decision.code)
      return
    }
    const target = new URL(request.url!)
    const forwarded = httpRequest({
      hostname: '127.0.0.1', port: fixturePort, path: `${target.pathname}${target.search}`,
      method: request.method, headers: { ...request.headers, host: `fixture.test:${fixturePort}` },
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 500, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', (error) => response.writeHead(502).end(error.message))
    request.pipe(forwarded)
  })
  const proxyPort = await listen(proxy)
  const browser = await chromium.launch({
    executablePath: resolveChromeExecutablePath(), headless: true,
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
  })
  try {
    const page = await browser.newPage()
    const expectedUrl = input.expectedIdentity.url?.replace('http://fixture.test', fixtureOrigin)
    const discoverySubject = {
      schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-PRD-FLOW', prdRevision: input.revision,
      scopeDigest: input.revision, environment: 'test' as const, baseOrigin: fixtureOrigin, actor: 'auditor',
      expectedPageIdentity: {
        url: expectedUrl ?? `${fixtureOrigin}/orders`, title: input.expectedIdentity.title,
        heading: input.expectedIdentity.heading, ariaSignals: [`main:${input.expectedIdentity.heading}`],
      },
      bootstrapIntentsDigest: digestText('bootstrap-intents/v1', canonicalizeJson(paths)),
      requests: [],
      actions: [{ actionId: preflightActionId, operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
    }
    const discoveryGrant = await input.authority.issueDiscoveryGrant({
      subject: discoverySubject, approver: { subject: 'os-user:flow', roles: ['e2e-approver'] },
      approvalSessionRef: 'flow-session', ttlMs: 60_000,
    })
    const preflight = await runBrowserPreflight({
      authorization: { grant: discoveryGrant, currentSubject: discoverySubject, authority: input.authority },
      runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(),
      page: new PlaywrightPageAdapter(page), actionId: preflightActionId,
      attemptId: `ATTEMPT-PREFLIGHT-${input.generationId}-${input.caseId}`,
    })
    if (preflight.status !== 'ready' || !preflight.preflightDigest) {
      throw new Error(`Execution Grant 前的 Discovery preflight 未 ready：${preflight.reasonCode ?? preflight.status}`)
    }
    const grant = await input.authority.issueReadGrant({
      subject: {
        schemaVersion: '2.1.0', assetId: 'PRODUCT-PRD-FLOW', prdRevision: input.revision,
        scopeDigest: input.revision, requirementModelDigest: input.revision, coveragePolicyDigest: input.revision,
        universeDigest: input.revision, caseDigest: input.revision, actionMapDigest: input.revision,
        policyDigest: input.revision, executionContractDigest: input.revision,
        runBundleProjectionDigest: input.revision, environment: 'test', baseOrigin: fixtureOrigin, actor: 'auditor',
        discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
        requests: [],
        actions: [
          { actionId: caseActionId, operation: 'local-navigation', maxUses: 1, requestIds: [] },
          { actionId: caseActionId, operation: 'dom-read', maxUses: 1, requestIds: [] },
          { actionId: caseActionId, operation: 'screenshot', maxUses: 1, requestIds: [] },
        ],
      },
      approver: { subject: 'os-user:flow', roles: ['e2e-approver'] },
      approvalSessionRef: 'flow-session', ttlMs: 60_000,
    })
    gateway.switchToCaseStage()
    currentActionId = caseActionId
    const auditedAuthority = {
      reserveForSubject: (reservationInput: Parameters<typeof input.authority.reserveForSubject>[0]) =>
        input.authority.reserveForSubject(reservationInput),
      complete: async (reservationId: string, outcomeDigest: string) => {
        await input.authority.complete(reservationId, outcomeDigest)
        const reservation = input.authority.getReservation(reservationId)
        if (!reservation) throw new Error('Read reservation 丢失')
        recorder.recordCapabilityReservation({ reservation, consumed: true })
      },
      markUnknown: (reservationId: string, observation: string) =>
        input.authority.markUnknown(reservationId, observation),
    }
    const result = await runReadOnlyCase({
      caseId: input.caseId, actionId: caseActionId, url: `${fixtureOrigin}/orders`,
      expectedIdentity: { ...input.expectedIdentity, ...(expectedUrl ? { url: expectedUrl } : {}) },
      expectedText: '待审核',
      authorization: { grant, currentSubject: grant.subject, authority: auditedAuthority },
      attemptId: `ATTEMPT-${input.generationId}-${input.caseId}`,
      runtime: { sandboxHealthy: true, gatewayConnected: true },
      gatewayAudit: () => gateway.getAuditSummary(), page: new PlaywrightPageAdapter(page),
    })
    const gatewayAudit = recorder.finalize()
    if (!verifyGatewayPublicationAudit(gatewayAudit, gatewayVerifier)) throw new Error('Read Gateway 签名审计无效')
    return { result, grant, gatewayAudit, gatewayVerifier }
  } finally {
    await browser.close()
  }
}

async function publishResult(input: {
  authority: LocalApprovalAuthority
  revision: string
  generationId: string
  result: ReadOnlyCaseResult
  workspace?: string
  extraFiles?: Record<string, string>
  gatewayAudit?: ReturnType<ReturnType<LocalGatewayAuditSigner['createRecorder']>['finalize']>
  gatewayVerifier?: LocalGatewayAuditVerifier
  scopeArtifact?: ReturnType<typeof approvedScopeArtifact>
  lineageArtifact?: ReturnType<typeof approvedLineageArtifact>
  lineageEntities?: { previous: SemanticLineageEntity[]; current: SemanticLineageEntity[] }
  workflowArtifact?: {
    paused: ReturnType<typeof pauseWorkflow>
    resumed: ReturnType<typeof resumeWorkflow>
    decisionDigest: string
    proof: ReturnType<LocalApprovalAuthority['signArtifactDigest']>
  }
}): Promise<{
  workspace: string
  active: NonNullable<Awaited<ReturnType<LocalArtifactStore['readActive']>>>
  verdict: ReturnType<typeof computeVerdict>
}> {
  const workspace = input.workspace ?? await mkdtemp(join(process.cwd(), '.tmp', 'e2e-system-flow-'))
  if (!input.workspace) tempDirectories.push(workspace)
  const attempt = input.result.status === 'passed'
    ? createGoldenAttemptProof({
      authority: input.authority, assetId: 'PRODUCT-PRD-FLOW', generationId: input.generationId,
      prdRevision: input.revision, runId: `RUN-${input.generationId}`, caseId: input.result.caseId,
      attemptId: `ATTEMPT-${input.generationId}-${input.result.caseId}`, status: 'passed', effect: 'read',
      reservationId: input.result.reservationIds?.[0], outcomeDigest: input.result.outcomeDigest,
    })
    : undefined
  const verdict = computeVerdict({
    schemaVersion: '2.0.0', assetId: 'PRODUCT-PRD-FLOW', generationId: input.generationId,
    verdictRuleVersion: '2.0.0', policyDigest: input.revision, universeDigest: input.revision,
    prdRevision: input.revision, requirementModelDigest: input.revision,
    obligations: [{ obligationId: `COV-${input.result.caseId}`, necessity: 'required', disposition: 'automated', caseIds: [input.result.caseId] }],
    caseResults: [{
      caseId: input.result.caseId, runId: `RUN-${input.generationId}`, obligationIds: [`COV-${input.result.caseId}`],
      status: input.result.status, executionMode: 'real-environment',
      attemptSelection: attempt?.attemptSelection ?? { status: 'not-started' },
    }],
    manualResults: [], pendingDecisionIds: [], safetyFindings: [], artifactFindings: [], migrationFindings: [],
    environmentFindings: [], automationFindings: [], gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
    evidenceAudit: { status: 'complete', total: input.result.evidence.length, complete: input.result.evidence.length, reasonCodes: [] },
    cleanupAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    coverageFacts: {
      requirementDesign: { covered: 1, total: 1 }, rules: { covered: 1, total: 1 },
      criticalNodes: { covered: 1, total: 1 }, roles: { covered: input.result.status === 'input-blocked' ? 0 : 1, total: 1 },
      stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 1, total: 1 },
    },
  }, attempt ? { verifyAttemptSelection: ({ caseResult }) => {
    const persisted = attempt.workflowEvents.attemptCases[0]!
    const selected = selectFinalAttempt({ caseId: persisted.caseId, retryPolicy: persisted.retryPolicy,
      initialChainDigest: persisted.initialChainDigest, events: persisted.events,
      verifyAuthorityProof: (proof) => input.authority.verifyAttemptEventProof(proof) })
    return selected.status === 'selected' && caseResult.attemptSelection.status === 'valid'
      && caseResult.attemptSelection.attemptId === selected.attemptId
      && caseResult.attemptSelection.eventChainDigest === selected.eventChainDigest
  } } : undefined)
  const report = renderReadOnlyReport({
    assetId: 'PRODUCT-PRD-FLOW', prdRevision: input.revision, generationId: input.generationId,
    title: `系统场景 ${input.result.caseId}`, verdict,
    cases: [{ caseId: input.result.caseId, title: input.result.caseId, status: input.result.status, evidenceLinks: [] }],
  })
  const store = new LocalArtifactStore(workspace, {
    auditStagedGeneration: async (staged) => {
      const persistedResult = JSON.parse(Buffer.from(await staged.readFile('run/results.json')).toString('utf8'))
      expect(persistedResult).toMatchObject({ caseId: input.result.caseId, status: input.result.status,
        ...(input.result.reasonCode ? { reasonCode: input.result.reasonCode } : {}) })
      expect(staged.terminalVerdict).toBe(verdict.verdict)
      if (input.gatewayAudit && input.gatewayVerifier) {
        const persistedAudit = JSON.parse(Buffer.from(
          await staged.readFile('run/gateway-audit.json')).toString('utf8'))
        expect(persistedResult.evidence.length).toBeGreaterThan(0)
        expect(verifyGatewayPublicationAudit(persistedAudit, input.gatewayVerifier)).toBe(true)
        expect(persistedAudit.signedCounters.digest).toBe(input.gatewayAudit.signedCounters.digest)
      }
      if (input.scopeArtifact) {
        const scope = JSON.parse(Buffer.from(await staged.readFile('design/acceptance-scope.json')).toString('utf8'))
        const decision = scope.scopeDecision
        expect(decision.status).toBe('approved')
        expect(input.authority.verifyDecisionReceipt(decision.receipt, {
          kind: 'scope', decisionId: decision.decisionId, decisionStatus: decision.status,
          decisionSubjectDigest: digestDecisionSubject(projectScopeDecisionSubject(scope)),
        })).toBe(true)
      }
      if (input.workflowArtifact) {
        const workflow = JSON.parse(Buffer.from(await staged.readFile('run/workflow.json')).toString('utf8'))
        expect(workflow.resumed.state.current).toBe(workflow.paused.pending.resumeState)
        expect(workflow.resumed.state.sequence).toBe(workflow.paused.pending.pausedSequence + 1)
        expect(workflow.proof.signedDigest)
          .toBe(workflowResumeAuthorizationDigest(workflow.paused.pending, workflow.decisionDigest))
        expect(input.authority.verifyArtifactSignature(workflow.proof)).toBe(true)
      }
      if (input.lineageArtifact && input.lineageEntities) {
        const lineage = JSON.parse(Buffer.from(await staged.readFile('design/lineage.json')).toString('utf8'))
        const previous = JSON.parse(Buffer.from(
          await staged.readFile('design/previous-entities.json')).toString('utf8')).entities
        const current = JSON.parse(Buffer.from(
          await staged.readFile('design/current-entities.json')).toString('utf8')).entities
        expect(reconcileEntityLineage({ previous, current, explicitMappings: [] }))
          .toEqual(lineage.lineageMappings)
        const decision = lineage.lineageReview
        expect(decision.status).toBe('approved')
        expect(input.authority.verifyDecisionReceipt(decision.receipt, {
          kind: 'lineage', decisionId: decision.decisionId, decisionStatus: decision.status,
          decisionSubjectDigest: digestDecisionSubject(projectLineageDecisionSubject(lineage)),
        })).toBe(true)
      }
    },
    signDigest: (digest) => input.authority.signArtifactDigest(digest),
    verifySignature: (signature) => input.authority.verifyArtifactSignature(signature),
  })
  await store.publish({
    assetId: 'PRODUCT-PRD-FLOW', generationId: input.generationId, terminalVerdict: verdict.verdict,
    files: {
      'requirements/model.json': JSON.stringify({ prdRevision: input.revision }),
      'regression/cases.json': JSON.stringify([input.result.caseId]),
      'run/results.json': JSON.stringify(input.result),
      ...(input.gatewayAudit ? { 'run/gateway-audit.json': JSON.stringify(input.gatewayAudit) } : {}),
      ...(input.scopeArtifact ? { 'design/acceptance-scope.json': JSON.stringify(input.scopeArtifact) } : {}),
      ...(input.lineageArtifact ? { 'design/lineage.json': JSON.stringify(input.lineageArtifact) } : {}),
      ...(input.lineageEntities ? {
        'design/previous-entities.json': JSON.stringify({ entities: input.lineageEntities.previous }),
        'design/current-entities.json': JSON.stringify({ entities: input.lineageEntities.current }),
      } : {}),
      ...(input.workflowArtifact ? { 'run/workflow.json': JSON.stringify(input.workflowArtifact) } : {}),
      'run/report.md': report.markdown,
      'run/report.html': report.html,
      ...input.extraFiles,
    },
  })
  const active = await store.readActive('PRODUCT-PRD-FLOW')
  if (!active) throw new Error('active generation missing')
  return { workspace, active, verdict }
}

function approvedScopeArtifact(authority: LocalApprovalAuthority, decisionId: string, resolved?: {
  ambiguityId: string
  question: string
  resolution: string
}) {
  const facts = {
    includedReqCandidates: [{ reqId: 'REQ-LIST', sourceRefs: ['PRD-BODY'] }],
    exclusions: [], ambiguities: resolved ? [{ ...resolved, status: 'resolved' as const, decisionId }] : [],
    dependencies: [],
    visualScope: { required: false, refs: [] },
    browserScope: { browserIds: ['CHROMIUM'], viewportIds: ['DESKTOP'] },
  }
  const receipt = authority.issueDecisionReceipt({
    kind: 'scope', decisionId, decisionStatus: 'approved',
    decisionSubject: projectScopeDecisionSubject(facts),
    approver: { subject: 'os-user:flow-reviewer', roles: ['scope-approver', 'lineage-approver'] },
  })
  return { ...facts, scopeDecision: { decisionId, status: 'approved' as const, receipt } }
}

function approvedLineageArtifact(authority: LocalApprovalAuthority, input: {
  previousRevision: string
  currentRevision: string
  lineageMappings: EntityLineageMapping[]
  impactedEntityIds: string[]
}) {
  const facts = {
    previousRevision: input.previousRevision, currentRevision: input.currentRevision,
    sectionChanges: [{ sectionId: 'ATTACHMENT-RULES', kind: 'changed' as const,
      digest: digestText('prd-section/v1', input.currentRevision) }],
    lineageMappings: input.lineageMappings, impactedEntityIds: input.impactedEntityIds,
  }
  const decisionId = 'LINEAGE-REVISION-2'
  const receipt = authority.issueDecisionReceipt({
    kind: 'lineage', decisionId, decisionStatus: 'approved',
    decisionSubject: projectLineageDecisionSubject(facts),
    approver: { subject: 'os-user:flow-reviewer', roles: ['scope-approver', 'lineage-approver'] },
  })
  return { ...facts, lineageReview: { decisionId, status: 'approved' as const, receipt } }
}

function orderPage(role: string): string {
  return `<!doctype html><html data-e2e-role="${role}"><head><title>订单</title><link rel="icon" href="data:,"></head><body><main><h1>订单列表</h1><p>待审核</p></main></body></html>`
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}
