import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import {
  canonicalizeJson,
  digestDecisionSubject,
  digestText,
  projectLineageDecisionSubject,
  type EntityLineageMapping,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { LocalArtifactStore, reconcileEntityLineage, type SemanticLineageEntity } from '@mutil-skills/e2e-engine'
import { ReadOnlyGateway } from '@mutil-skills/e2e-gateway'
import { PlaywrightPageAdapter, runBrowserPreflight, runReadOnlyCase } from '@mutil-skills/e2e-playwright-runtime'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'

const servers: Server[] = []
const tempDirectories: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PRD two-revision stable ID lineage golden path', () => {
  test('semanticKey 精确一致时跨两代保持稳定 ID，并把新增实体与映射纳入 Lineage 审批', async () => {
    const fixture = createServer((request, response) => {
      if (request.url !== '/orders') return response.writeHead(404).end('not found')
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html data-e2e-role="auditor"><head><title>订单</title><link rel="icon" href="data:,"></head><body><main><h1>订单列表</h1><p>展示订单列表</p><p>按创建时间排序</p></main></body></html>')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const revision0 = digestText('prd-revision/v1', 'empty-baseline')
    const revision1 = digestText('prd-revision/v1', '订单列表：展示订单')
    const revision2 = digestText('prd-revision/v1', '订单管理：展示订单，并按创建时间排序')
    const authority = LocalApprovalAuthority.create({
      issuer: 'lineage-authority', keyId: 'lineage-key', now: () => new Date('2026-07-11T10:00:00.000Z'),
      approvalIdentities: [{ subject: 'os-user:lineage-golden', roles: ['e2e-approver'] }],
      manualIdentities: [{ subject: 'os-user:lineage-reviewer', roles: ['lineage-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'lineage-session'
        ? createGoldenApprovalReceipt('os-user:lineage-golden', 'RUN-LINEAGE', expected) : undefined,
    })
    const snapshots = new Map<string, SemanticLineageEntity[]>([[revision0, []]])
    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-lineage-golden-'))
    tempDirectories.push(workspace)
    const store = new LocalArtifactStore(workspace, {
      auditStagedGeneration: async ({ readFile, generationId }) => {
        const diff = JSON.parse(Buffer.from(await readFile('prd/prd-diff.json')).toString('utf8'))
        const current = JSON.parse(Buffer.from(await readFile('design/entity-snapshot.json')).toString('utf8'))
          .entities as SemanticLineageEntity[]
        const execution = JSON.parse(Buffer.from(await readFile('run/execution-result.json')).toString('utf8'))
        const previous = snapshots.get(diff.previousRevision)
        if (!previous) throw new Error(`E2E_LINEAGE_PREVIOUS_REVISION_UNKNOWN:${diff.previousRevision}`)
        const explicit = (diff.lineageMappings as EntityLineageMapping[])
          .filter((mapping) => mapping.confirmation === 'authority-confirmed')
        const recomputed = reconcileEntityLineage({ previous, current, explicitMappings: explicit })
        if (canonicalizeJson(recomputed) !== canonicalizeJson(diff.lineageMappings)) {
          throw new Error(`E2E_LINEAGE_MAPPING_RECOMPUTE_MISMATCH:${generationId}`)
        }
        const subject = projectLineageDecisionSubject(diff)
        const decision = diff.lineageReview
        if (decision.status !== 'approved' || !authority.verifyDecisionReceipt(decision.receipt, {
          kind: 'lineage', decisionId: decision.decisionId, decisionStatus: decision.status,
          decisionSubjectDigest: digestDecisionSubject(subject),
        })) throw new Error(`E2E_LINEAGE_DECISION_INVALID:${generationId}`)
        if (execution.status !== 'passed' || execution.prdRevision !== diff.currentRevision) {
          throw new Error(`E2E_LINEAGE_EXECUTION_INVALID:${generationId}`)
        }
      },
      signDigest: (digest) => authority.signArtifactDigest(digest),
      verifySignature: (signature) => authority.verifyArtifactSignature(signature),
    })

    const revision1Entities = [entity('requirement', 'REQ-ORDER-LIST', 'order:list', 'prd-v1.md#orders')]
    const first = await executeRevision({
      authority, fixtureOrigin, fixturePort, prdRevision: revision1, expectedText: '展示订单列表', ordinal: 1,
    })
    const mappings1 = reconcileEntityLineage({ previous: [], current: revision1Entities, explicitMappings: [] })
    const diff1 = approvedLineageDiff({
      authority, previousRevision: revision0, currentRevision: revision1, mappings: mappings1,
      sectionId: 'SECTION-ORDERS', kind: 'added', impactedEntityIds: ['REQ-ORDER-LIST'],
    })
    await store.publish({
      assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-LINEAGE-1', terminalVerdict: 'accepted',
      files: lineageFiles(diff1, revision1Entities, first),
    })
    snapshots.set(revision1, revision1Entities)
    const active1 = await store.readActive('PRODUCT-PRD-1')
    expect(active1).toMatchObject({ generationId: 'GENERATION-LINEAGE-1', terminalVerdict: 'accepted' })

    const revision2Entities = [
      entity('requirement', 'REQ-ORDER-LIST', 'order:list', 'prd-v2.md#orders'),
      entity('rule', 'RULE-ORDER-SORT', 'order:sort-created-at', 'prd-v2.md#sorting'),
    ]
    const second = await executeRevision({
      authority, fixtureOrigin, fixturePort, prdRevision: revision2, expectedText: '按创建时间排序', ordinal: 2,
    })
    const mappings2 = reconcileEntityLineage({
      previous: revision1Entities, current: revision2Entities, explicitMappings: [],
    })
    const diff2 = approvedLineageDiff({
      authority, previousRevision: revision1, currentRevision: revision2, mappings: mappings2,
      sectionId: 'SECTION-ORDERS', kind: 'changed', impactedEntityIds: ['REQ-ORDER-LIST', 'RULE-ORDER-SORT'],
    })
    await store.publish({
      assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-LINEAGE-2', terminalVerdict: 'accepted',
      files: lineageFiles(diff2, revision2Entities, second),
    })
    snapshots.set(revision2, revision2Entities)
    const active2 = await store.readActive('PRODUCT-PRD-1')

    expect(first).toMatchObject({ status: 'passed', prdRevision: revision1 })
    expect(second).toMatchObject({ status: 'passed', prdRevision: revision2 })
    expect(mappings2).toEqual([
      expect.objectContaining({ entityKind: 'requirement', semanticKey: 'order:list', disposition: 'preserved',
        previousIds: ['REQ-ORDER-LIST'], currentIds: ['REQ-ORDER-LIST'] }),
      expect.objectContaining({ entityKind: 'rule', semanticKey: 'order:sort-created-at', disposition: 'created',
        previousIds: [], currentIds: ['RULE-ORDER-SORT'] }),
    ])
    expect(diff2.previousRevision).toBe(revision1)
    expect(active2).toMatchObject({ generationId: 'GENERATION-LINEAGE-2', terminalVerdict: 'accepted' })
    expect(active2!.generationDigest).not.toBe(active1!.generationDigest)
  }, 30_000)
})

async function executeRevision(input: {
  authority: LocalApprovalAuthority
  fixtureOrigin: string
  fixturePort: number
  prdRevision: string
  expectedText: string
  ordinal: number
}) {
  const actionId = `ACTION-LINEAGE-${input.ordinal}`
  const preflightActionId = `ACTION-LINEAGE-PREFLIGHT-${input.ordinal}`
  const gateway = new ReadOnlyGateway({ stage: 'bootstrap', intents: [{
    intentId: `INTENT-LINEAGE-BOOTSTRAP-${input.ordinal}`, stage: 'bootstrap', methods: ['GET'],
    actionId: preflightActionId, origin: input.fixtureOrigin, exactPath: '/orders', query: [], maxRequests: 1,
  }, {
    intentId: `INTENT-LINEAGE-CASE-${input.ordinal}`, stage: 'case', methods: ['GET'],
    actionId, origin: input.fixtureOrigin, exactPath: '/orders', query: [], maxRequests: 1,
  }] })
  let currentActionId = preflightActionId
  const proxy = createServer((request, response) => {
    const decision = gateway.decide({ method: request.method ?? 'GET', url: request.url ?? '' }, currentActionId)
    if (decision.decision === 'block') return response.writeHead(403).end(decision.code)
    const target = new URL(request.url!)
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: input.fixturePort,
      path: `${target.pathname}${target.search}`, method: request.method,
      headers: { ...request.headers, host: `fixture.test:${input.fixturePort}` } }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 500, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', (error) => response.writeHead(502).end(error.message))
    request.pipe(forwarded)
  })
  const proxyPort = await listen(proxy)
  const browser = await chromium.launch({ executablePath: resolveChromeExecutablePath(), headless: true,
    proxy: { server: `http://127.0.0.1:${proxyPort}` } })
  try {
    const page = new PlaywrightPageAdapter(await browser.newPage())
    const discoverySubject = {
      schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-PRD-1', prdRevision: input.prdRevision,
      scopeDigest: input.prdRevision, environment: 'test' as const, baseOrigin: input.fixtureOrigin, actor: 'auditor',
      expectedPageIdentity: { url: `${input.fixtureOrigin}/orders`, title: '订单', heading: '订单列表',
        ariaSignals: ['main:订单列表'] },
      bootstrapIntentsDigest: input.prdRevision,
      requests: [],
      actions: [{ actionId: preflightActionId, operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
    }
    const discoveryGrant = await input.authority.issueDiscoveryGrant({
      subject: discoverySubject, approver: { subject: 'os-user:lineage-golden', roles: ['e2e-approver'] },
      approvalSessionRef: 'lineage-session', ttlMs: 60_000,
    })
    const preflight = await runBrowserPreflight({
      authorization: { grant: discoveryGrant, currentSubject: discoverySubject, authority: input.authority },
      runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(),
      page, actionId: preflightActionId, attemptId: `ATTEMPT-LINEAGE-PREFLIGHT-${input.ordinal}`,
    })
    if (preflight.status !== 'ready' || !preflight.preflightDigest) throw new Error('Lineage preflight 未 ready')
    const grant = await input.authority.issueReadGrant({
      subject: {
        schemaVersion: '2.1.0', assetId: 'PRODUCT-PRD-1', prdRevision: input.prdRevision,
        scopeDigest: input.prdRevision, requirementModelDigest: input.prdRevision,
        coveragePolicyDigest: input.prdRevision, universeDigest: input.prdRevision,
        caseDigest: input.prdRevision, actionMapDigest: input.prdRevision, policyDigest: input.prdRevision,
        executionContractDigest: input.prdRevision, runBundleProjectionDigest: input.prdRevision,
        environment: 'test', baseOrigin: input.fixtureOrigin, actor: 'auditor',
        discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
        requests: [],
        actions: [
          { actionId, operation: 'local-navigation', maxUses: 1, requestIds: [] },
          { actionId, operation: 'dom-read', maxUses: 1, requestIds: [] },
          { actionId, operation: 'screenshot', maxUses: 1, requestIds: [] },
        ],
      },
      approver: { subject: 'os-user:lineage-golden', roles: ['e2e-approver'] },
      approvalSessionRef: 'lineage-session', ttlMs: 60_000,
    })
    gateway.switchToCaseStage()
    currentActionId = actionId
    const result = await runReadOnlyCase({
      caseId: `CASE-LINEAGE-${input.ordinal}`, actionId, url: `${input.fixtureOrigin}/orders`,
      expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' }, expectedText: input.expectedText,
      authorization: { grant, currentSubject: grant.subject, authority: input.authority },
      attemptId: `ATTEMPT-LINEAGE-${input.ordinal}`,
      runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(), page,
    })
    return { prdRevision: input.prdRevision, status: result.status, actual: result.actual,
      gatewayAudit: gateway.getAuditSummary() }
  } finally {
    await browser.close()
  }
}

function approvedLineageDiff(input: {
  authority: LocalApprovalAuthority
  previousRevision: string
  currentRevision: string
  mappings: EntityLineageMapping[]
  sectionId: string
  kind: 'added' | 'changed'
  impactedEntityIds: string[]
}) {
  const facts = {
    previousRevision: input.previousRevision, currentRevision: input.currentRevision,
    sectionChanges: [{ sectionId: input.sectionId, kind: input.kind,
      digest: digestText('prd-section/v1', `${input.currentRevision}:${input.sectionId}`) }],
    lineageMappings: input.mappings, impactedEntityIds: input.impactedEntityIds,
  }
  const receipt = input.authority.issueDecisionReceipt({
    kind: 'lineage', decisionId: `LINEAGE-${input.currentRevision.slice(-12)}`, decisionStatus: 'approved',
    decisionSubject: projectLineageDecisionSubject(facts),
    approver: { subject: 'os-user:lineage-reviewer', roles: ['lineage-approver'] },
  })
  return { ...facts, lineageReview: { decisionId: receipt.decisionId, status: 'approved' as const, receipt } }
}

function lineageFiles(diff: unknown, entities: SemanticLineageEntity[], execution: unknown) {
  return {
    'prd/prd-diff.json': JSON.stringify(diff),
    'design/entity-snapshot.json': JSON.stringify({ entities }),
    'run/execution-result.json': JSON.stringify(execution),
  }
}

function entity(
  entityKind: SemanticLineageEntity['entityKind'], entityId: string, semanticKey: string, sourceRef: string,
): SemanticLineageEntity {
  return { entityKind, entityId, semanticKey, sourceRefs: [sourceRef] }
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}
