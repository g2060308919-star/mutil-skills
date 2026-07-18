import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { LocalArtifactStore } from '@mutil-skills/e2e-engine'
import {
  LocalGatewayAuditSigner, LocalGatewayAuditVerifier, ReadOnlyGateway,
  verifyGatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import {
  PlaywrightPageAdapter, runBrowserPreflight, runReadOnlyCase,
} from '@mutil-skills/e2e-playwright-runtime'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'

const tempDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('同一 Asset 双 Run 并发发布', () => {
  test('OS 锁拒绝并发覆盖，失败 Run 重试后以更高 fencing token 完整发布', async () => {
    const fixture = createServer((request, response) => {
      if (request.url !== '/orders') {
        response.writeHead(404).end('not found')
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html data-e2e-role="auditor"><head><title>并发订单</title></head>'
        + '<body><main><h1>订单列表</h1><p>待审核</p></main></body></html>')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const now = () => new Date('2026-07-11T10:00:00.000Z')
    const authority = LocalApprovalAuthority.create({
      issuer: 'concurrent-authority', keyId: 'concurrent-key', now,
      approvalIdentities: [{ subject: 'os-user:concurrent', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'concurrent-session'
        ? createGoldenApprovalReceipt('os-user:concurrent', 'RUN-CONCURRENT', expected) : undefined,
    })

    const [run1, run2] = await Promise.all([
      executeBrowserRun({ ordinal: 1, fixtureOrigin, fixturePort, authority }),
      executeBrowserRun({ ordinal: 2, fixtureOrigin, fixturePort, authority }),
    ])
    expect(run1.caseStatus).toBe('passed')
    expect(run2.caseStatus).toBe('passed')

    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-concurrent-publication-'))
    tempDirectories.push(workspace)
    const auditedRunIds: string[] = []
    const storeAuthority = {
      auditStagedGeneration: async (staged: Parameters<ConstructorParameters<typeof LocalArtifactStore>[1]['auditStagedGeneration']>[0]) => {
        expect(staged.files.map((file) => file.path)).toEqual(['run/result.json'])
        const persisted = JSON.parse(Buffer.from(await staged.readFile('run/result.json')).toString('utf8'))
        expect(persisted).toMatchObject({ generationId: staged.generationId, caseStatus: 'passed' })
        expect(persisted.fencingToken).toBe(staged.fencingToken)
        auditedRunIds.push(persisted.runId)
      },
      signDigest: (digest: string) => authority.signArtifactDigest(digest),
      verifySignature: (signature: Parameters<typeof authority.verifyArtifactSignature>[0]) =>
        authority.verifyArtifactSignature(signature),
    }
    const store1 = new LocalArtifactStore(workspace, storeAuthority)
    const store2 = new LocalArtifactStore(workspace, storeAuthority)
    const publish = (store: LocalArtifactStore, fact: typeof run1) => store.publishPrepared({
      assetId: 'PRODUCT-CONCURRENT', generationId: fact.generationId,
      prepare: ({ fencingToken }) => ({ terminalVerdict: 'accepted' as const, files: {
        'run/result.json': Buffer.from(canonicalizeJson({ ...fact, fencingToken })),
      } }),
    })

    await publish(store1, {
      runId: 'RUN-CONCURRENT-BASELINE', generationId: 'GENERATION-CONCURRENT-BASELINE',
      caseStatus: 'passed', gatewayAuditDigest: digestText('concurrent-baseline/v1', 'gateway-audit'),
    })

    const simultaneous = await Promise.allSettled([publish(store1, run1), publish(store2, run2)])
    const fulfilled = simultaneous.filter((result) => result.status === 'fulfilled')
    const rejected = simultaneous.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'E2E_ARTIFACT_LOCKED' })

    const firstActive = await store1.readActive('PRODUCT-CONCURRENT')
    const firstFact = firstActive!.generationId === run1.generationId ? run1 : run2
    const retryFact = firstActive!.generationId === run1.generationId ? run2 : run1
    expect(JSON.parse(await readFile(join(firstActive!.generationPath, 'run/result.json'), 'utf8')))
      .toMatchObject({ runId: firstFact.runId, generationId: firstFact.generationId,
        fencingToken: firstActive!.fencingToken })

    await store1.setValidationReferences('PRODUCT-CONCURRENT', [firstFact.generationId])
    const secondActive = await publish(firstActive!.generationId === run1.generationId ? store2 : store1, retryFact)
    expect(secondActive).toMatchObject({ generationId: retryFact.generationId })
    expect(secondActive.fencingToken).toBeGreaterThan(firstActive!.fencingToken)
    expect(JSON.parse(await readFile(join(secondActive.generationPath, 'run/result.json'), 'utf8')))
      .toMatchObject({ runId: retryFact.runId, generationId: retryFact.generationId,
        fencingToken: secondActive.fencingToken })
    expect(JSON.parse(await readFile(join(
      workspace, '.biztest', 'assets', 'PRODUCT-CONCURRENT', 'generations', firstFact.generationId,
      'run/result.json'), 'utf8')))
      .toMatchObject({ runId: firstFact.runId, generationId: firstFact.generationId })
    expect(new Set(auditedRunIds)).toEqual(new Set(['RUN-CONCURRENT-BASELINE', run1.runId, run2.runId]))
  }, 30_000)
})

async function executeBrowserRun(input: {
  ordinal: number
  fixtureOrigin: string
  fixturePort: number
  authority: LocalApprovalAuthority
}) {
  const runId = `RUN-CONCURRENT-${input.ordinal}`
  const generationId = `GENERATION-CONCURRENT-${input.ordinal}`
  const actionId = `ACTION-CONCURRENT-${input.ordinal}`
  const preflightActionId = `ACTION-PREFLIGHT-CONCURRENT-${input.ordinal}`
  const policyDigest = digestText('gateway-policy/v1', runId)
  const signer = LocalGatewayAuditSigner.create({
    issuer: `gateway-${input.ordinal}`, keyId: `gateway-key-${input.ordinal}`,
    instanceId: `GATEWAY-CONCURRENT-${input.ordinal}`, version: '1.0.0',
  })
  const verifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
  const recorder = signer.createRecorder(policyDigest)
  let currentActionId = preflightActionId
  const gateway = new ReadOnlyGateway({
    stage: 'bootstrap', recorder, intents: [
      { intentId: `INTENT-PREFLIGHT-${input.ordinal}`, stage: 'bootstrap', methods: ['GET'],
        actionId: preflightActionId, origin: input.fixtureOrigin, exactPath: '/orders', query: [], maxRequests: 1 },
      { intentId: `INTENT-CASE-${input.ordinal}`, stage: 'case', methods: ['GET'],
        actionId, origin: input.fixtureOrigin, exactPath: '/orders', query: [], maxRequests: 1 },
    ],
  })
  const proxy = createServer((request, response) => {
    const decision = gateway.decide({ method: request.method ?? 'GET', url: request.url ?? '' }, currentActionId)
    if (decision.decision === 'block') {
      response.writeHead(403).end(decision.code)
      return
    }
    const target = new URL(request.url!)
    const forwarded = httpRequest({
      hostname: '127.0.0.1', port: input.fixturePort, path: `${target.pathname}${target.search}`,
      method: request.method, headers: { ...request.headers, host: `fixture.test:${input.fixturePort}` },
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
    const page = new PlaywrightPageAdapter(await browser.newPage())
    const scopeDigest = digestText('concurrent-scope/v1', runId)
    const subject = {
      schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-CONCURRENT',
      prdRevision: digestText('concurrent-prd/v1', 'revision-1'), scopeDigest,
      environment: 'test' as const, baseOrigin: input.fixtureOrigin, actor: 'auditor',
      expectedPageIdentity: { url: `${input.fixtureOrigin}/orders`, title: '并发订单',
        heading: '订单列表', ariaSignals: ['main:订单列表'] },
      bootstrapIntentsDigest: digestText('concurrent-bootstrap/v1', runId),
      requests: [],
      actions: [{ actionId: preflightActionId, operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
    }
    const discoveryGrant = await input.authority.issueDiscoveryGrant({
      subject, approver: { subject: 'os-user:concurrent', roles: ['e2e-approver'] },
      approvalSessionRef: 'concurrent-session', ttlMs: 60_000,
    })
    const preflight = await runBrowserPreflight({
      authorization: { grant: discoveryGrant, currentSubject: subject, authority: input.authority },
      runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(),
      page, actionId: preflightActionId, attemptId: `ATTEMPT-PREFLIGHT-${input.ordinal}`,
    })
    if (preflight.status !== 'ready' || !preflight.preflightDigest) throw new Error(`${runId} preflight 未 ready`)
    const projection = (name: string) => digestText('concurrent-projection/v1', `${runId}:${name}`)
    const grant = await input.authority.issueReadGrant({
      subject: {
        schemaVersion: '2.1.0', assetId: 'PRODUCT-CONCURRENT', prdRevision: subject.prdRevision,
        scopeDigest, requirementModelDigest: projection('model'), coveragePolicyDigest: projection('coverage-policy'),
        universeDigest: projection('universe'), caseDigest: projection('cases'), actionMapDigest: projection('action-map'),
        policyDigest: projection('policy'), executionContractDigest: projection('execution-contract'),
        runBundleProjectionDigest: projection('run-bundle'), environment: 'test', baseOrigin: input.fixtureOrigin,
        actor: 'auditor', discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
        requests: [],
        actions: [
          { actionId, operation: 'local-navigation', maxUses: 1, requestIds: [] },
          { actionId, operation: 'dom-read', maxUses: 1, requestIds: [] },
          { actionId, operation: 'screenshot', maxUses: 1, requestIds: [] },
        ],
      },
      approver: { subject: 'os-user:concurrent', roles: ['e2e-approver'] },
      approvalSessionRef: 'concurrent-session', ttlMs: 60_000,
    })
    gateway.switchToCaseStage()
    currentActionId = actionId
    const auditedAuthority = {
      reserveForSubject: (reservationInput: Parameters<typeof input.authority.reserveForSubject>[0]) =>
        input.authority.reserveForSubject(reservationInput),
      complete: async (reservationId: string, outcomeDigest: string) => {
        await input.authority.complete(reservationId, outcomeDigest)
        const reservation = input.authority.getReservation(reservationId)
        if (!reservation) throw new Error('并发 Run reservation 丢失')
        recorder.recordCapabilityReservation({ reservation, consumed: true })
      },
    }
    const result = await runReadOnlyCase({
      caseId: `CASE-CONCURRENT-${input.ordinal}`, actionId, url: `${input.fixtureOrigin}/orders`,
      expectedIdentity: { title: '并发订单', heading: '订单列表', role: 'auditor' }, expectedText: '待审核',
      authorization: { grant, currentSubject: grant.subject, authority: auditedAuthority },
      attemptId: `ATTEMPT-CONCURRENT-${input.ordinal}`,
      runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(), page,
    })
    const audit = recorder.finalize()
    expect(verifyGatewayPublicationAudit(audit, verifier)).toBe(true)
    return { runId, generationId, caseStatus: result.status, gatewayAuditDigest: audit.signedCounters.digest }
  } finally {
    await browser.close()
  }
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}
