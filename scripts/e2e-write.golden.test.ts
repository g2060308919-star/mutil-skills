import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'
import {
  E2EError, canonicalGrantApprovalSubjectDigest, canonicalizeJson, digestCleanupPlanDefinition, digestText,
  type ExecutionOutcomeReceipt, type SignedWriteGrant, type VerificationObservation,
} from '@mutil-skills/e2e-contracts'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import {
  LocalApprovalAuthority,
  LocalLeaseAuthority,
  createAuthenticatedRpcHttpTransport,
  createAuthorityExecutionRpcClients,
  startAuthorityExecutionRpcHostProcess,
  type AuthorityExecutionRpcProcessHandle,
} from '@mutil-skills/e2e-authority'
import {
  LocalArtifactStore, PatternPrivacyScanner, buildCompleteGeneration, buildCoverageUniverse,
  createCompletePublicationAuditor, createTrustedCompilerReadiness, evaluateWriteOutcome,
} from '@mutil-skills/e2e-engine'
import {
  LocalExecutionOutcomeVerifier, LocalGatewayAuditSigner, LocalGatewayAuditVerifier,
  ReadOnlyGateway, ReversibleWriteGateway,
  digestJsonHttpPayload, verifyGatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import {
  LocalCleanupPlanRegistry, LocalRegressionDiscoveryAuthority, PlaywrightPageAdapter,
  captureTrustedCompilerRuntimeMeasurement,
  createTrustedCompilerControlledWriteLauncher,
  createTrustedCompilerExecutionTrust, createTrustedCompilerProjectorTrust,
  createRegressionDiscoveryVerifier, executeTrustedCompilerProject, prepareTrustedCompilerRun,
  projectCompilerInputFromArtifacts,
  runBrowserPreflight, startTrustedCompilerControlledWriteBridge,
  runReversibleWriteCase,
  type ObservedPageIdentity, type ReversibleWriteCaseResult, type WriteBrowserPageAdapter,
} from '@mutil-skills/e2e-playwright-runtime'
import { createTestWriteRuntimeSession } from '../packages/e2e-playwright-runtime/src/production-isolation.js'
import { createGoldenAttemptProof } from './e2e-golden-attempt.js'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'
import {
  createReadOnlyGoldenDecisions, createReadOnlyGoldenGenerationInput, createWriteApprovalProjection,
  createWriteGoldenCompilerArtifacts,
} from './e2e-read-only-generation.js'

const tempDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PRD-driven reversible-write golden path', () => {
  test('executes and cleans a real browser write before publishing an accepted 27-artifact generation', async () => {
    let orderStatus: 'pending' | 'approved' = 'pending'
    const fixture = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/orders/100') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(orderPage())
        return
      }
      const body = await readBody(request)
      if (request.method === 'POST' && request.url === '/api/orders/100/approve?source=e2e') {
        if (canonicalizeJson(JSON.parse(body.toString('utf8'))) !== canonicalizeJson({ decision: 'approve', orderId: 100 })) {
          response.writeHead(400).end('bad payload')
          return
        }
        orderStatus = 'approved'
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ orderId: 100, status: orderStatus }))
        return
      }
      if (request.method === 'POST' && request.url === '/api/orders/100/reset?source=e2e-cleanup') {
        orderStatus = 'pending'
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ orderId: 100, status: orderStatus }))
        return
      }
      response.writeHead(404).end('not found')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const gatewayPolicyDigest = digestText('gateway-policy/v1', 'golden-reversible-write')
    const gatewaySigner = LocalGatewayAuditSigner.create({
      issuer: 'golden-write-gateway', keyId: 'golden-write-gateway-key',
      instanceId: 'GATEWAY-WRITE-GOLDEN-1', version: '1.0.0',
    })
    const gatewayVerifier = LocalGatewayAuditVerifier.create(structuredClone(gatewaySigner.exportVerifierMaterial()))
    const executionOutcomeVerifier = LocalExecutionOutcomeVerifier.create(
      structuredClone(gatewaySigner.exportExecutionOutcomeVerifierMaterial()),
    )
    const gatewayRecorder = gatewaySigner.createRecorder(gatewayPolicyDigest)
    let currentReadActionId = 'ACTION-PREFLIGHT-WRITE'
    const readGateway = new ReadOnlyGateway({
      stage: 'bootstrap', recorder: gatewayRecorder,
      intents: [
        { intentId: 'INTENT-PREFLIGHT-DOCUMENT', stage: 'bootstrap', methods: ['GET'],
          actionId: 'ACTION-PREFLIGHT-WRITE', origin: fixtureOrigin, exactPath: '/orders/100', query: [], maxRequests: 1 },
        { intentId: 'INTENT-CASE-DOCUMENT', stage: 'case', methods: ['GET'],
          actionId: 'ACTION-APPROVE', origin: fixtureOrigin, exactPath: '/orders/100', query: [], maxRequests: 1 },
      ],
    })

    const now = () => new Date('2026-07-11T10:00:00.000Z')
    const authorityDirectory = await mkdtemp(join(tmpdir(), 'e2e-write-authority-'))
    tempDirectories.push(authorityDirectory)
    const approvalStatePath = join(authorityDirectory, 'approval.sqlite')
    const leaseStatePath = join(authorityDirectory, 'lease.sqlite')
    const authorityOptions = {
      issuer: 'local-authority', keyId: 'local-key-1', now,
      approvalIdentities: [{ subject: 'os-user:golden', roles: ['e2e-approver'] }],
      manualIdentities: [
        { subject: 'privacy-golden', roles: ['privacy-approver'] },
        { subject: 'scope-golden', roles: ['scope-approver'] },
        { subject: 'lineage-golden', roles: ['lineage-approver'] },
      ],
      authenticateApproverSession: (sessionRef: string, expected) => sessionRef === 'golden-session'
        ? createGoldenApprovalReceipt('os-user:golden', 'RUN-WRITE-1', expected) : undefined,
      statePath: approvalStatePath, stateEncryptionKey: randomBytes(32), testWorkspaceRoots: [process.cwd()],
    }
    let approvalAuthority = await LocalApprovalAuthority.open(authorityOptions)
    let leaseAuthority = await LocalLeaseAuthority.open({
      now, statePath: leaseStatePath, testWorkspaceRoots: [process.cwd()],
    })
    const resourceFingerprint = digestText('fixture-resource/v1', 'order:100')
    const modelDigest = resourceFingerprint
    const before = observations('pending')
    const lease = await leaseAuthority.acquire({
      runId: 'RUN-WRITE-1', resourceKey: 'order:100', resourceFingerprint, exclusive: true, ttlMs: 60_000,
    })
    const activeLease = await leaseAuthority.activate(lease.leaseId)
    const cleanupPlanDefinition = {
      schemaVersion: '1.0.0' as const, cleanupPlanId: 'CLEANUP-ORDER-RESET',
      actionId: 'ACTION-APPROVE', leaseId: activeLease.leaseId, executorId: 'EXECUTOR-ORDER-RESET',
      cleanupRequestIntentIds: ['INTENT-CLEANUP'],
      verificationProbes: [{ probeId: 'PROBE-ORDER-PENDING', kind: 'resource-state' as const,
        expectedDigest: digestText('cleanup-expected-state/v1', canonicalizeJson({ orderStatus: 'pending' })) }],
      timeoutMs: 30_000,
    }
    const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlanDefinition)
    const approvePayload = { decision: 'approve', orderId: 100 }
    const cleanupPayload = { orderId: 100, restore: 'pending' }

    let writeGateway: ReversibleWriteGateway | undefined
    const proxy = createServer(async (request, response) => {
      const body = await readBody(request)
      const raw = {
        method: request.method ?? 'GET', url: request.url ?? '', body,
        contentType: Array.isArray(request.headers['content-type'])
          ? request.headers['content-type'][0] : request.headers['content-type'],
      }
      const decision = raw.method === 'GET'
        ? readGateway.decide(raw, currentReadActionId)
        : writeGateway ? await writeGateway.decide(raw)
          : { decision: 'block' as const, code: 'E2E_GATEWAY_WRITE_NOT_READY', reason: 'write grant not issued' }
      if (decision.decision === 'block') {
        response.writeHead(403).end(decision.code)
        return
      }
      const target = new URL(request.url!)
      const forwarded = httpRequest({
        hostname: '127.0.0.1', port: fixturePort, path: `${target.pathname}${target.search}`,
        method: request.method, headers: { ...request.headers, host: `fixture.test:${fixturePort}`,
          'content-length': body.byteLength },
      }, (upstream) => {
        response.writeHead(upstream.statusCode ?? 500, upstream.headers)
        upstream.pipe(response)
      })
      forwarded.on('error', (error) => response.writeHead(502).end(error.message))
      forwarded.end(body)
    })
    const proxyPort = await listen(proxy)

    const universe = buildCoverageUniverse({
      modelDigest, confirmedModelDigest: modelDigest,
      model: {
        modelRevision: 1, modelDecisionDigest: modelDigest, coupledDimensions: [],
        applicabilityRules: ['actor:operator'], requirements: [{
          reqId: 'REQ-ORDER-1', revision: 1, title: '批准订单并恢复测试数据', actors: ['operator'], entities: ['order'],
          preconditions: ['订单待审核'], rules: [{ ruleId: 'RULE-ORDER-1', category: 'business',
            statement: '授权操作员可以批准待审核订单', sourceRefs: ['CLAUSE-ORDER-1'], certainty: 'explicit',
            oracleIds: ['ORACLE-ORDER-APPROVED'] }],
          states: [{ stateId: 'pending', title: '待审核' }, { stateId: 'approved', title: '已批准' }],
          transitions: [{ transitionId: 'TRANSITION-APPROVE', from: 'pending', action: '批准订单', to: 'approved' }],
          observableOutcomes: [{ oracleId: 'ORACLE-ORDER-APPROVED', ruleId: 'RULE-ORDER-1',
            statement: '订单显示已批准', sourceRefs: ['CLAUSE-ORDER-1'] }],
          applicability: [{ dimension: 'actor', value: 'operator', required: true }],
          sourceRefs: ['CLAUSE-ORDER-1'], status: 'active',
        }],
      },
      nodes: [{ nodeId: 'NODE-APPROVE', reqId: 'REQ-ORDER-1', kind: 'action', title: '批准订单',
        effect: 'reversible-write', hasOracle: true }],
      policy: { policyVersion: '1.0.0', ruleScenarios: { business: ['happy-path'] }, pairwiseSeed: 1 },
      dispositionFor: () => ({ kind: 'automated', caseIds: ['CASE-WRITE-1'] }),
    })
    const decisions = createReadOnlyGoldenDecisions({
      authority: approvalAuthority, modelDigest,
      scope: { status: 'approved', approver: { subject: 'scope-golden', roles: ['scope-approver'] } },
      lineage: { status: 'approved', approver: { subject: 'lineage-golden', roles: ['lineage-approver'] } },
    })
    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-write-golden-'))
    tempDirectories.push(workspace)
    const discoveryAuthority = LocalRegressionDiscoveryAuthority.create({
      issuer: 'golden-write-regression-discovery', keyId: 'golden-write-regression-key',
    })
    let authorityRpcHandle: AuthorityExecutionRpcProcessHandle | undefined
    let destroyAuthorityRpcClients: (() => void) | undefined
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutablePath(), headless: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
    })
    try {
      const page = await browser.newPage()
      const capturingPage = new CapturingWritePageAdapter(new PlaywrightPageAdapter(page))
      const runtimeIsolationPolicy = {
        schemaVersion: '1.0.0' as const, sourceDigest: digestText('golden-isolation/v1', 'regression-source'),
        allowedBackends: ['linux-bwrap' as const], gatewayEndpoint: `http://127.0.0.1:${proxyPort}`,
        allowedEndpoints: [`http://127.0.0.1:${fixturePort}`, `http://127.0.0.1:${proxyPort}`].sort(),
        allowedExecutableDigests: [digestText('golden-isolation/v1', 'chrome')],
        limits: { cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024,
          diskBytes: 128 * 1024 * 1024, wallTimeMs: 60_000 },
        authorityRpcPublicKeyDigest: digestText('golden-isolation/v1', 'authority-rpc-key'),
        isolationAuthorityPublicKeyDigest: digestText('golden-isolation/v1', 'isolation-authority-key'),
      }
      const approvalProjection = createWriteApprovalProjection({
        modelDigest, universe, fixtureOrigin, runtimePolicyDigest: gatewayPolicyDigest,
        dataLeaseId: activeLease.leaseId, resourceKey: 'order:100', resourceFingerprint,
        cleanupPlanDigest,
        runtimeIsolationPolicy, decisions,
      })
      if (decisions.lineageDecision.status !== 'approved') throw new Error('Golden lineage 未批准')
      const discoverySubject = {
        schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-PRD-1', prdRevision: modelDigest,
        scopeDigest: approvalProjection.scopeDigest, environment: 'test' as const, baseOrigin: fixtureOrigin,
        actor: 'operator', expectedPageIdentity: {
          url: `${fixtureOrigin}/orders/100`, title: '订单审批', heading: '订单 100', ariaSignals: ['main:订单 100'],
        }, bootstrapIntentsDigest: modelDigest,
        requests: [],
        actions: [{ actionId: 'ACTION-PREFLIGHT-WRITE', operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
      }
      const discoveryGrant = await approvalAuthority.issueDiscoveryGrant({
        subject: discoverySubject, approver: { subject: 'os-user:golden', roles: ['e2e-approver'] },
        approvalSessionRef: 'golden-session', ttlMs: 60_000,
      })
      const preflight = await runBrowserPreflight({
        authorization: { grant: discoveryGrant, currentSubject: discoverySubject, authority: approvalAuthority },
        runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => readGateway.getAuditSummary(),
        page: capturingPage, actionId: 'ACTION-PREFLIGHT-WRITE', attemptId: 'ATTEMPT-PREFLIGHT-WRITE-1',
      })
      if (preflight.status !== 'ready' || !preflight.preflightDigest) throw new Error('Write Discovery preflight 未 ready')
      const grantSubject = {
          schemaVersion: '2.0.0', assetId: 'PRODUCT-PRD-1', prdRevision: modelDigest,
          executionDigest: digestText('execution/v1', 'CASE-WRITE-1'), ...approvalProjection,
          environment: 'test', baseOrigin: fixtureOrigin, actor: 'operator',
          discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
          actions: [{ actionId: 'ACTION-APPROVE', effect: 'reversible-write', dataLeaseId: activeLease.leaseId,
            resourceKey: 'order:100', fencingToken: activeLease.fencingToken, cleanupPlanDigest, requests: [
              { intentId: 'INTENT-APPROVE', method: 'POST', canonicalOrigin: fixtureOrigin,
                exactPath: '/api/orders/100/approve', query: [['source', 'e2e']],
                payload: { kind: 'json', digest: digestJsonHttpPayload(approvePayload) },
                targetFingerprint: resourceFingerprint, maxRequests: 1, expectedOrder: 1 },
              { intentId: 'INTENT-CLEANUP', method: 'POST', canonicalOrigin: fixtureOrigin,
                exactPath: '/api/orders/100/reset', query: [['source', 'e2e-cleanup']],
                payload: { kind: 'json', digest: digestJsonHttpPayload(cleanupPayload) },
                targetFingerprint: resourceFingerprint, maxRequests: 1, expectedOrder: 2 },
            ] }],
        } as const
      const authenticator = createGoldenAuthenticatorCredential()
      await approvalAuthority.createWebAuthnCredentialRepository().insert({
        id: authenticator.id, publicKey: authenticator.publicKey, counter: 0,
        transports: ['internal'], subject: 'os-user:golden',
      })
      approvalAuthority.close()
      leaseAuthority.close()
      const authorityRpcHostOptions: Parameters<typeof startAuthorityExecutionRpcHostProcess>[0] = {
        rpc: { issuer: 'golden-authority-host', keyId: 'golden-authority-rpc-key-1',
          clientId: 'golden-write-runner' },
        approval: {
          issuer: authorityOptions.issuer, keyId: authorityOptions.keyId,
          statePath: approvalStatePath, stateEncryptionKey: authorityOptions.stateEncryptionKey,
          testWorkspaceRoots: authorityOptions.testWorkspaceRoots,
          approvalIdentities: authorityOptions.approvalIdentities,
          manualIdentities: authorityOptions.manualIdentities,
        },
        lease: { statePath: leaseStatePath, testWorkspaceRoots: [process.cwd()] },
        userPresence: {
          installationDigest: digestText('golden-runtime-installation/v1', 'portable-e2e-runtime'),
          assets: {
            indexHtml: Buffer.from('<!doctype html>'), approvalJavaScript: Buffer.from('void 0'),
            simpleWebAuthnBrowser: Buffer.from('void 0'),
          },
        },
        clock: { kind: 'fixed-test-only', now: now().toISOString() },
      }
      authorityRpcHandle = await startAuthorityExecutionRpcHostProcess(authorityRpcHostOptions)
      const grantSubjectDigest = canonicalGrantApprovalSubjectDigest(grantSubject)
      const grantFinalization = {
        finalizationId: 'GOLDEN-WRITE-FINALIZATION-1',
        requestDigest: digestText('golden-write-finalization-request/v1', 'RUN-WRITE-1'),
      }
      const grantSession = await authorityRpcHandle.openApprovalSession({
        runId: 'RUN-WRITE-1', approvalType: 'execution',
        subjectDigest: grantSubjectDigest,
        installationDigest: digestText('golden-runtime-installation/v1', 'portable-e2e-runtime'),
      })
      await expect(authorityRpcHandle.finalizeApproval({
        sessionId: grantSession.sessionId, grantSubject, ...grantFinalization,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_INVALID' })
      await completeGoldenWebAuthnApproval(grantSession, authenticator)
      await authorityRpcHandle.waitForSession(grantSession.sessionId)
      await expect(authorityRpcHandle.finalizeApproval({
        sessionId: grantSession.sessionId,
        ...grantFinalization,
        grantSubject: {
          ...grantSubject,
          actions: [{ ...grantSubject.actions[0], cleanupPlanDigest: digestText('cleanup-plan/v1', 'rebound') }],
        },
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' })
      const finalized = await authorityRpcHandle.finalizeApproval({
        sessionId: grantSession.sessionId, grantSubject, ...grantFinalization,
      })
      const grant = finalized.grant as SignedWriteGrant
      expect(finalized.approvalBinding).toEqual({
        runId: grant.approvalContext.runId,
        installationDigest: grant.approvalContext.installationDigest,
        approvalType: grant.approvalContext.approvalType,
        subjectDigest: grant.approvalContext.subjectDigest,
      })
      await expect(authorityRpcHandle.finalizeApproval({
        sessionId: grantSession.sessionId, grantSubject, ...grantFinalization,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_INVALID' })
      const host1SessionKey = authorityRpcHandle.credential.sessionKeyBase64Url
      await authorityRpcHandle.close()
      authorityRpcHandle = await startAuthorityExecutionRpcHostProcess(authorityRpcHostOptions)
      expect(authorityRpcHandle.credential.sessionKeyBase64Url).not.toBe(host1SessionKey)
      await authorityRpcHandle.activateGrant({
        grant,
        approvalBinding: finalized.approvalBinding,
      })
      approvalAuthority = await LocalApprovalAuthority.open(authorityOptions)
      leaseAuthority = await LocalLeaseAuthority.open({
        now, statePath: leaseStatePath, testWorkspaceRoots: [process.cwd()],
      })
      const compilerArtifacts = await createWriteGoldenCompilerArtifacts({
        modelDigest, universe, fixtureOrigin, runtimePolicyDigest: gatewayPolicyDigest,
        dataLeaseId: activeLease.leaseId, resourceKey: 'order:100', resourceFingerprint,
        cleanupPlanDigest,
        runtimeIsolationPolicy, decisions, authority: approvalAuthority, grant,
        discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
        generationId: 'GENERATION-WRITE-1',
      })
      const readinessArtifacts = compilerArtifacts.filter((artifact) =>
        ['prd-manifest', 'prd-diff', 'acceptance-scope'].includes((artifact as { artifactType: string }).artifactType))
      const readiness = createTrustedCompilerReadiness({
        artifacts: readinessArtifacts, contractsVersion: '2.0.0',
        verifyArtifactSignature: approvalAuthority.verifyArtifactSignature.bind(approvalAuthority),
        verifyDecisionReceipt: approvalAuthority.verifyDecisionReceipt.bind(approvalAuthority),
      })
      const projectorTrust = createTrustedCompilerProjectorTrust({
        artifactAuthority: { material: approvalAuthority.artifactVerifierMaterial,
          expectedPublicKeyDigest: approvalAuthority.artifactVerifierMaterial.publicKeyDigest },
        approvalFreshnessAuthority: { material: approvalAuthority.approvalFreshnessVerifierMaterial,
          expectedPublicKeyDigest: approvalAuthority.approvalFreshnessVerifierMaterial.publicKeyDigest },
        readiness,
      })
      const compilerInput = projectCompilerInputFromArtifacts({
        artifacts: compilerArtifacts, nodeVersion: process.versions.node, playwrightVersion: '1.61.1',
        typescriptVersion: '5.9.3',
        trust: projectorTrust,
      })
      const regressionDiscovery = await discoveryAuthority.compileAndAttest({
        tempParent: join(workspace, 'discovery'), compilerInput,
      })
      const regressionDiscoveryVerifier = createRegressionDiscoveryVerifier(
        discoveryAuthority.verifierMaterial, discoveryAuthority.verifierMaterial.publicKeyDigest,
      )
      const approvalDigest = (compilerArtifacts.find((artifact) =>
        (artifact as { artifactType?: string }).artifactType === 'approval-grants') as { contentDigest: string }).contentDigest
      approvalAuthority.close()
      leaseAuthority.close()
      approvalAuthority = await LocalApprovalAuthority.open(authorityOptions)
      leaseAuthority = await LocalLeaseAuthority.open({ now, statePath: leaseStatePath, testWorkspaceRoots: [process.cwd()] })
      const authorityRpcMaterial = authorityRpcHandle.verifierMaterial
      const authorityRpcClients = createAuthorityExecutionRpcClients({
        credential: authorityRpcHandle.credential,
        approvalBinding: {
          runId: grant.approvalContext.runId,
          installationDigest: grant.approvalContext.installationDigest,
          approvalType: grant.approvalContext.approvalType,
          subjectDigest: grant.approvalContext.subjectDigest,
        },
        verifierMaterial: authorityRpcMaterial,
        expectedPublicKeyDigest: authorityRpcMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(authorityRpcHandle.endpoint),
        now,
      })
      destroyAuthorityRpcClients = authorityRpcClients.destroy
      const executionTrust = await createTrustedCompilerExecutionTrust({
        discoveryAuthority: { material: discoveryAuthority.verifierMaterial,
          expectedPublicKeyDigest: discoveryAuthority.verifierMaterial.publicKeyDigest },
        approvalFreshnessClient: approvalAuthority.createTrustedApprovalFreshnessClient(),
        browserExecutablePath: resolveChromeExecutablePath(),
        gatewayProxyEndpoint: `http://127.0.0.1:${proxyPort}/`,
      })
      const runtimeMeasurement = captureTrustedCompilerRuntimeMeasurement(executionTrust)
      const trustedRunSession = await prepareTrustedCompilerRun({
        projectDir: regressionDiscovery.projectDir,
        subject: regressionDiscovery.subject,
        attestation: regressionDiscovery.attestation,
        trust: executionTrust,
        expected: { assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-WRITE-1', prdRevision: modelDigest,
          runId: 'RUN-WRITE-1', approvalDigest, executionProfile: 'trusted-reversible-write' },
        authorityTransport: 'authenticated-rpc',
        authorityRpcPublicKeyDigest: authorityRpcMaterial.publicKeyDigest,
      })
      writeGateway = new ReversibleWriteGateway({
        grant, currentSubject: grant.subject, capability: grant.capabilities[0]!, attemptId: 'ATTEMPT-WRITE-1',
        authority: authorityRpcClients.gatewayAuthority, leaseAuthority: authorityRpcClients.lease,
        recorder: gatewayRecorder, outcomeSigner: gatewaySigner,
        attemptContext: { assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-WRITE-1',
          prdRevision: modelDigest, runId: 'RUN-WRITE-1', caseId: 'CASE-WRITE-1' },
      })
      readGateway.switchToCaseStage()
      currentReadActionId = 'ACTION-APPROVE'
      const bridgeAction = {
        actionId: 'ACTION-APPROVE', buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
        dataLeaseId: activeLease.leaseId, cleanupPlanId: 'CLEANUP-ORDER-RESET',
      }
      let caseResult!: ReversibleWriteCaseResult
      let capturedEvidence!: ReturnType<CapturingWritePageAdapter['takeEvidence']>
      let after!: VerificationObservation[]
      let cleanupVerified = false
      let cleanupResultDigest = ''
      let outcome!: ReturnType<typeof evaluateWriteOutcome>
      let outcomeDigest = ''
      let executionOutcomeReceipt!: ExecutionOutcomeReceipt
      let reservationId = ''
      let reservation: ReturnType<LocalApprovalAuthority['getReservation']>
      let gatewayAudit!: ReturnType<typeof gatewayRecorder.finalize>
      const cleanupPlans = LocalCleanupPlanRegistry.create()
      cleanupPlans.register({ definition: cleanupPlanDefinition, execute: async ({ result }) => {
        caseResult = result
        capturedEvidence = capturingPage.takeEvidence()
        after = observations(orderStatus)
        const cleanupResponse = await requestThroughProxy({
          proxyPort, url: `${fixtureOrigin}/api/orders/100/reset?source=e2e-cleanup`, payload: cleanupPayload,
        })
        cleanupVerified = cleanupResponse.statusCode === 200 && orderStatus === 'pending'
        cleanupResultDigest = digestText('cleanup-result/v1', canonicalizeJson({ orderStatus }))
        if (cleanupVerified) await leaseAuthority.release(activeLease.leaseId, cleanupResultDigest)
        return { status: cleanupVerified ? 'verified-clean' : 'failed', resultDigest: cleanupResultDigest,
          leaseReceiptDigest: cleanupResultDigest }
      } })
      const launch = createTrustedCompilerControlledWriteLauncher([{
        action: bridgeAction, cleanupPlanDigest,
        runnerInput: {
          caseId: 'CASE-WRITE-1', actionId: 'ACTION-APPROVE', url: `${fixtureOrigin}/orders/100`,
          buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
          expectedIdentity: { title: '订单审批', heading: '订单 100' },
          authorization: { grant, currentSubject: grant.subject, authority: authorityRpcClients.writeApproval },
          lease: { leaseId: activeLease.leaseId, fencingToken: activeLease.fencingToken,
            targetFingerprint: resourceFingerprint, authority: authorityRpcClients.lease },
          runtime: trustedRunSession,
          gatewayAudit: () => writeGateway!.getAuditSummary(), page: capturingPage,
        },
        lifecycle: {
          finalizeExecution: async ({ result, outcomeDigest: runnerResultDigest, cleanup }) => {
            outcome = evaluateWriteOutcome({
              plan: { planId: 'VERIFY-WRITE-1', probes: [
                { probeId: 'PROBE-UI-STATUS', kind: 'ui', required: true },
                { probeId: 'PROBE-RESOURCE-STATUS', kind: 'resource-state', required: true },
              ] },
              gatewayForwardedWriteCount: writeGateway!.getAuditSummary().forwarded,
              reservationStatus: 'reserved', before, after, cleanupStatus: cleanup.status,
            })
            outcomeDigest = digestText('write-outcome/v1', canonicalizeJson(outcome))
            if (cleanup.status !== 'verified-clean') {
              await writeGateway!.markUnknown(`cleanup:${cleanup.status}`)
              throw new Error(`cleanup:${cleanup.status}`)
            }
            executionOutcomeReceipt = await writeGateway!.completeWithExecutionOutcome({
              status: result.status === 'passed' ? 'passed' : 'failed',
              effectObservation: result.effectObservation,
              runnerResultDigest,
              cleanupPlanId: bridgeAction.cleanupPlanId,
              cleanup: {
                status: cleanup.status,
                resultDigest: cleanup.resultDigest,
                leaseReceiptDigest: cleanup.leaseReceiptDigest,
              },
              evidenceIds: ['EVIDENCE-SCREENSHOT', 'EVIDENCE-DOM', 'EVIDENCE-GATEWAY'],
              completedAt: now().toISOString(),
            })
            reservationId = writeGateway!.getReservation()!.reservationId
            reservation = approvalAuthority.getReservation(reservationId)
            gatewayAudit = gatewayRecorder.finalize()
            return { executionOutcomeReceipt,
              gatewayAuditDigest: gatewayAudit.signedCounters.digest,
            }
          },
        },
      }], cleanupPlans, trustedRunSession)
      const bridge = await startTrustedCompilerControlledWriteBridge({
        session: trustedRunSession, actions: [bridgeAction], launch,
        verifyExecutionOutcomeReceipt: (candidate) => executionOutcomeVerifier.verifyReceipt(candidate),
        executionOutcomeVerifierMaterial: gatewaySigner.exportExecutionOutcomeVerifierMaterial(),
      })
      let generatedExecution: Awaited<ReturnType<typeof executeTrustedCompilerProject>>
      try {
        generatedExecution = await executeTrustedCompilerProject({
          session: trustedRunSession, writeBridge: bridge, timeoutMs: 30_000,
        })
        expect(generatedExecution.exitCode).toBe(0)
      } finally {
        await bridge.close()
      }
      expect(caseResult.status).toBe('passed')
      expect(after).toEqual(observations('approved'))
      const attempt = createGoldenAttemptProof({
        authority: approvalAuthority, assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-WRITE-1',
        prdRevision: modelDigest, runId: 'RUN-WRITE-1', caseId: 'CASE-WRITE-1', attemptId: 'ATTEMPT-WRITE-1',
        status: caseResult.status === 'passed' ? 'passed' : 'failed', effect: 'reversible-write',
        reservationId, outcomeDigest: reservation?.outcomeDigest,
      })
      expect(verifyGatewayPublicationAudit(gatewayAudit, gatewayVerifier)).toBe(true)
      let validationInput: ReturnType<typeof buildCompleteGeneration>['validationInput'] | undefined
      const store = new LocalArtifactStore(workspace, {
        auditStagedGeneration: createCompletePublicationAuditor({
          scanner: new PatternPrivacyScanner('1.0.0'),
          resolveValidationInput: () => {
            if (!validationInput) throw new Error('完整写代际尚未准备完成')
            return validationInput
          },
        }),
        signDigest: (digest) => approvalAuthority.signArtifactDigest(digest),
        verifySignature: (signature) => approvalAuthority.verifyArtifactSignature(signature),
      })
      try {
        await store.publishPrepared({
          assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-WRITE-1',
          prepare: async ({ fencingToken }) => {
            const complete = buildCompleteGeneration(await createReadOnlyGoldenGenerationInput({
              fencingToken, modelDigest, universe, authority: approvalAuthority, caseResult, attempt,
              gatewayAudit, gatewayVerifier, executionOutcomeVerifier, capturedEvidence,
              regressionDiscovery, regressionDiscoveryVerifier,
              trustedCompilerExecution: generatedExecution.execution,
              trustedRuntimeMeasurement: runtimeMeasurement,
              fixtureOrigin, discoveryGrant, readGrant: grant, authorityPreflightDigest: preflight.preflightDigest,
              privacyDecisions: [{ evidenceId: 'EVIDENCE-SCREENSHOT', decision: 'approved',
                approver: { subject: 'privacy-golden', roles: ['privacy-approver'] } }], decisions,
              write: { generationId: 'GENERATION-WRITE-1', runId: 'RUN-WRITE-1', caseId: 'CASE-WRITE-1',
                stepId: 'STEP-WRITE-1', actionId: 'ACTION-APPROVE', actor: 'operator',
                dataLeaseId: activeLease.leaseId, resourceKey: 'order:100', resourceDigest: resourceFingerprint,
                cleanupPlanDigest, cleanupPlanDefinition, cleanupResultDigest, executionOutcomeReceipt,
                runtimeIsolationPolicy },
            }))
            validationInput = complete.validationInput
            expect(complete.artifacts).toHaveLength(27)
            expect(complete.terminalVerdict, JSON.stringify(complete.artifacts.find((artifact) =>
              artifact.artifactType === 'final-report')?.content)).toBe('accepted')
            return { terminalVerdict: complete.terminalVerdict,
              files: Object.fromEntries(complete.files.map((file) => [file.path, file.bytes])) }
          },
        })
      } catch (error) {
        if (error instanceof E2EError) throw new Error(`${error.code}:${error.refs.join('|')}`, { cause: error })
        throw error
      }
      const active = await store.readActive('PRODUCT-PRD-1')
      const finalReport = JSON.parse(await readFile(join(active!.generationPath, 'run/final-report.json'), 'utf8'))
      const manifest = JSON.parse(await readFile(join(active!.generationPath, 'generation-manifest.json'), 'utf8'))
      expect(outcome).toMatchObject({ effectObservation: 'applied', acceptedCleanup: true })
      expect(cleanupVerified).toBe(true)
      expect(orderStatus).toBe('pending')
      expect(writeGateway.getAuditSummary()).toMatchObject({ forwarded: 2, blocked: 0 })
      expect(active).toMatchObject({ generationId: 'GENERATION-WRITE-1', terminalVerdict: 'accepted' })
      expect(finalReport).toMatchObject({ content: { verdict: 'accepted' } })
      expect(new Set([...manifest.content.artifacts.map((item: { artifactType: string }) => item.artifactType),
        manifest.artifactType]).size).toBe(27)
      expect(executionOutcomeVerifier.verifyReceipt(executionOutcomeReceipt)).toBe(true)
      expect(reservation).toMatchObject({
        status: 'completed', outcomeDigest: executionOutcomeReceipt.signedDigest,
      })
    } finally {
      await browser.close()
      destroyAuthorityRpcClients?.()
      await authorityRpcHandle?.close()
      approvalAuthority.close()
      leaseAuthority.close()
    }
  }, 30_000)

  test('写响应断连导致副作用 unknown 时永久阻断重试并发布 safety-blocked 事实', async () => {
    let mutationHits = 0
    const fixture = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/orders/200') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><html data-e2e-role="operator"><head><title>订单审批</title></head><body><main>
          <h1>订单 200</h1><p>待审核</p><button>批准订单</button>
          <script>document.querySelector('button').addEventListener('click', async () => {
            const response = await fetch('/api/orders/200/approve?source=e2e', { method: 'POST',
              headers: {'content-type':'application/json'}, body: JSON.stringify({orderId:200}) });
            if (response.ok) document.querySelector('p').textContent = '已批准';
          });</script></main></body></html>`)
        return
      }
      const body = await readBody(request)
      if (request.method === 'POST' && request.url === '/api/orders/200/approve?source=e2e'
        && canonicalizeJson(JSON.parse(body.toString('utf8'))) === canonicalizeJson({ orderId: 200 })) {
        mutationHits += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ orderId: 200, status: 'approved' }))
        return
      }
      response.writeHead(404).end('not found')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const now = () => new Date('2026-07-11T10:00:00.000Z')
    const authority = LocalApprovalAuthority.create({
      issuer: 'unknown-authority', keyId: 'unknown-key', now,
      approvalIdentities: [{ subject: 'os-user:unknown', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'unknown-session'
        ? createGoldenApprovalReceipt('os-user:unknown', 'RUN-WRITE-UNKNOWN', expected) : undefined,
    })
    const leaseAuthority = new LocalLeaseAuthority({ now })
    const targetFingerprint = digestText('fixture-resource/v1', 'order:200')
    const tentativeLease = await leaseAuthority.acquire({
      runId: 'RUN-WRITE-UNKNOWN', resourceKey: 'order:200', resourceFingerprint: targetFingerprint,
      exclusive: true, ttlMs: 60_000,
    })
    const lease = await leaseAuthority.activate(tentativeLease.leaseId)
    const policyDigest = digestText('gateway-policy/v1', 'unknown-write')
    const signer = LocalGatewayAuditSigner.create({
      issuer: 'unknown-gateway', keyId: 'unknown-gateway-key', instanceId: 'GATEWAY-UNKNOWN-1', version: '1.0.0',
    })
    const verifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
    const recorder = signer.createRecorder(policyDigest)
    let readActionId = 'ACTION-PREFLIGHT-UNKNOWN'
    const readGateway = new ReadOnlyGateway({
      stage: 'bootstrap', recorder, intents: [
        { intentId: 'INTENT-PREFLIGHT-UNKNOWN', stage: 'bootstrap', methods: ['GET'],
          actionId: 'ACTION-PREFLIGHT-UNKNOWN', origin: fixtureOrigin, exactPath: '/orders/200', query: [], maxRequests: 1 },
        { intentId: 'INTENT-CASE-UNKNOWN', stage: 'case', methods: ['GET'],
          actionId: 'ACTION-APPROVE-UNKNOWN', origin: fixtureOrigin, exactPath: '/orders/200', query: [], maxRequests: 2 },
      ],
    })
    let writeGateway: ReversibleWriteGateway | undefined
    let dropFirstWriteResponse = true
    const proxy = createServer(async (request, response) => {
      const body = await readBody(request)
      const raw = { method: request.method ?? 'GET', url: request.url ?? '', body,
        contentType: typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : undefined }
      const decision = request.method === 'GET'
        ? readGateway.decide(raw, readActionId)
        : writeGateway ? await writeGateway.decide(raw)
          : { decision: 'block' as const, code: 'E2E_GATEWAY_WRITE_NOT_READY' }
      if (decision.decision === 'block') {
        response.writeHead(403).end(decision.code)
        return
      }
      const target = new URL(request.url!)
      const forwarded = httpRequest({
        hostname: '127.0.0.1', port: fixturePort, path: `${target.pathname}${target.search}`,
        method: request.method, headers: { ...request.headers, host: `fixture.test:${fixturePort}`,
          'content-length': body.byteLength },
      }, (upstream) => {
        if (request.method === 'POST' && dropFirstWriteResponse) {
          dropFirstWriteResponse = false
          upstream.resume()
          upstream.on('end', () => response.destroy(new Error('模拟上游已生效但响应链路断开')))
          return
        }
        response.writeHead(upstream.statusCode ?? 500, upstream.headers)
        upstream.pipe(response)
      })
      forwarded.on('error', (error) => response.destroy(error))
      forwarded.end(body)
    })
    const proxyPort = await listen(proxy)
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutablePath(), headless: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
    })
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(750)
      const adapter = new PlaywrightPageAdapter(page)
      const projectionDigest = (name: string) => digestText('unknown-write-projection/v1', name)
      const discoverySubject = {
        schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-PRD-UNKNOWN', prdRevision: targetFingerprint,
        scopeDigest: projectionDigest('scope'), environment: 'test' as const, baseOrigin: fixtureOrigin,
        actor: 'operator', expectedPageIdentity: {
          url: `${fixtureOrigin}/orders/200`, title: '订单审批', heading: '订单 200', ariaSignals: ['main:订单 200'],
        }, bootstrapIntentsDigest: projectionDigest('bootstrap'),
        requests: [],
        actions: [{ actionId: 'ACTION-PREFLIGHT-UNKNOWN', operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
      }
      const discoveryGrant = await authority.issueDiscoveryGrant({
        subject: discoverySubject, approver: { subject: 'os-user:unknown', roles: ['e2e-approver'] },
        approvalSessionRef: 'unknown-session', ttlMs: 60_000,
      })
      const preflight = await runBrowserPreflight({
        authorization: { grant: discoveryGrant, currentSubject: discoverySubject, authority },
        runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => readGateway.getAuditSummary(),
        page: adapter, actionId: 'ACTION-PREFLIGHT-UNKNOWN', attemptId: 'ATTEMPT-PREFLIGHT-UNKNOWN',
      })
      if (preflight.status !== 'ready' || !preflight.preflightDigest) throw new Error('unknown write preflight 未 ready')
      const cleanupPlanDigest = projectionDigest('cleanup-plan')
      const grant = await authority.issueWriteGrant({
        subject: {
          schemaVersion: '2.0.0', assetId: 'PRODUCT-PRD-UNKNOWN', prdRevision: targetFingerprint,
          scopeDigest: projectionDigest('scope'), requirementModelDigest: projectionDigest('model'),
          coveragePolicyDigest: projectionDigest('coverage-policy'), universeDigest: projectionDigest('universe'),
          caseDigest: projectionDigest('cases'), actionMapDigest: projectionDigest('action-map'),
          policyDigest: projectionDigest('project-policy'), executionContractDigest: projectionDigest('execution-contract'),
          runBundleProjectionDigest: projectionDigest('run-bundle'), executionDigest: projectionDigest('execution'),
          environment: 'test', baseOrigin: fixtureOrigin, actor: 'operator',
          discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
          actions: [{ actionId: 'ACTION-APPROVE-UNKNOWN', effect: 'reversible-write',
            dataLeaseId: lease.leaseId, resourceKey: 'order:200',
            fencingToken: lease.fencingToken, cleanupPlanDigest,
            requests: [{ intentId: 'INTENT-APPROVE-UNKNOWN', method: 'POST', canonicalOrigin: fixtureOrigin,
              exactPath: '/api/orders/200/approve', query: [['source', 'e2e']],
              payload: { kind: 'json', digest: digestJsonHttpPayload({ orderId: 200 }) },
              targetFingerprint, maxRequests: 1, expectedOrder: 1 }] }],
        },
        approver: { subject: 'os-user:unknown', roles: ['e2e-approver'] },
        approvalSessionRef: 'unknown-session', ttlMs: 60_000,
      })
      readGateway.switchToCaseStage()
      readActionId = 'ACTION-APPROVE-UNKNOWN'
      const attemptContext = { assetId: 'PRODUCT-PRD-UNKNOWN', generationId: 'GENERATION-UNKNOWN-1',
        prdRevision: targetFingerprint, runId: 'RUN-WRITE-UNKNOWN', caseId: 'CASE-WRITE-UNKNOWN' }
      const runnerInput = (attemptId: string) => ({
        caseId: 'CASE-WRITE-UNKNOWN', actionId: 'ACTION-APPROVE-UNKNOWN',
        url: `${fixtureOrigin}/orders/200`, buttonName: '批准订单', beforeText: '待审核', afterText: '已批准',
        expectedIdentity: { title: '订单审批', heading: '订单 200' },
        authorization: { grant, currentSubject: grant.subject,
          authority: authority.createWriteExecutionClient(grant.approvalContext) },
        lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken, targetFingerprint,
          authority: leaseAuthority.createExecutionClient() },
        runtime: createTestWriteRuntimeSession({ sandboxHealthy: true, gatewayConnected: true,
          authorityTransport: 'in-process-test' }),
        gatewayAudit: () => writeGateway!.getAuditSummary(), page: adapter,
      })
      writeGateway = new ReversibleWriteGateway({
        grant, currentSubject: grant.subject, capability: grant.capabilities[0]!,
        attemptId: 'ATTEMPT-WRITE-UNKNOWN-1', attemptContext,
        authority, leaseAuthority, recorder, outcomeSigner: signer,
      })
      const first = await runReversibleWriteCase(runnerInput('ATTEMPT-WRITE-UNKNOWN-1'))
      expect(first).toMatchObject({ status: 'failed', effectObservation: 'unknown' })
      expect(mutationHits).toBe(1)
      const reservationId = writeGateway.getReservation()!.reservationId
      await writeGateway.markUnknown('上游响应在已转发后断开，无法确认最终状态')
      expect(authority.getReservation(reservationId)).toMatchObject({ status: 'unknown' })

      writeGateway = new ReversibleWriteGateway({
        grant, currentSubject: grant.subject, capability: grant.capabilities[0]!,
        attemptId: 'ATTEMPT-WRITE-UNKNOWN-2', attemptContext,
        authority, leaseAuthority, recorder, outcomeSigner: signer,
      })
      const forbiddenRetry = await runReversibleWriteCase(runnerInput('ATTEMPT-WRITE-UNKNOWN-2'))
      expect(forbiddenRetry).toMatchObject({ status: 'safety-blocked', effectObservation: 'unknown' })
      expect(writeGateway.getAuditSummary()).toMatchObject({ forwarded: 0, blocked: 1 })
      expect(mutationHits).toBe(1)
      await leaseAuthority.quarantine(lease.leaseId, '写入是否生效未知，禁止复用资源')
      await expect(leaseAuthority.acquire({
        runId: 'RUN-WRITE-RETRY', resourceKey: 'order:200', resourceFingerprint: targetFingerprint,
        exclusive: true, ttlMs: 60_000,
      })).rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })
      const gatewayAudit = recorder.finalize()
      expect(verifyGatewayPublicationAudit(gatewayAudit, verifier)).toBe(true)

      const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-write-unknown-'))
      tempDirectories.push(workspace)
      const store = new LocalArtifactStore(workspace, {
        auditStagedGeneration: async (staged) => {
          expect(staged.terminalVerdict).toBe('safety-blocked')
          expect(staged.files.map((file) => file.path)).toEqual(['run/unknown-write-result.json'])
          const persisted = JSON.parse(Buffer.from(
            await staged.readFile('run/unknown-write-result.json')).toString('utf8'))
          expect(persisted).toMatchObject({
            mutationHits: 1, reservation: { status: 'unknown' },
            first: { effectObservation: 'unknown' },
            forbiddenRetry: { status: 'safety-blocked' },
          })
        },
        signDigest: (digest) => authority.signArtifactDigest(digest),
        verifySignature: (signature) => authority.verifyArtifactSignature(signature),
      })
      await store.publish({
        assetId: 'PRODUCT-PRD-UNKNOWN', generationId: 'GENERATION-UNKNOWN-1', terminalVerdict: 'safety-blocked',
        files: { 'run/unknown-write-result.json': Buffer.from(canonicalizeJson({
          first, forbiddenRetry, mutationHits, reservation: authority.getReservation(reservationId),
          gatewayAuditDigest: gatewayAudit.signedCounters.digest,
        })) },
      })
      expect(await store.readActive('PRODUCT-PRD-UNKNOWN')).toMatchObject({
        generationId: 'GENERATION-UNKNOWN-1', terminalVerdict: 'safety-blocked',
      })
    } finally {
      await browser.close()
      authority.close()
      leaseAuthority.close()
    }
  }, 30_000)
})

function createGoldenAuthenticatorCredential(): {
  id: string
  publicKey: string
  privateKey: KeyObject
} {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = keys.publicKey.export({ format: 'jwk' })
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')],
    [-3, Buffer.from(jwk.y!, 'base64url')],
  ]))
  return {
    id: randomBytes(16).toString('base64url'),
    publicKey: Buffer.from(cose).toString('base64url'),
    privateKey: keys.privateKey,
  }
}

async function completeGoldenWebAuthnApproval(
  session: { url: string; sessionId: string },
  credential: ReturnType<typeof createGoldenAuthenticatorCredential>,
): Promise<void> {
  const url = new URL(session.url)
  const bearer = url.hash.slice(1)
  const sessionResponse = await fetch(`${url.origin}/session`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const approval = await sessionResponse.json() as { challenge: string; sessionId: string }
  const clientData = Buffer.from(canonicalizeJson({
    type: 'webauthn.get', challenge: approval.challenge, origin: url.origin,
  }))
  const authenticatorData = Buffer.alloc(37)
  createHash('sha256').update('localhost').digest().copy(authenticatorData)
  authenticatorData[32] = 0x05
  authenticatorData.writeUInt32BE(1, 33)
  const signature = sign('sha256', Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientData).digest(),
  ]), credential.privateKey)
  const response = await fetch(`${url.origin}/submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`, origin: url.origin, 'content-type': 'application/json',
    },
    body: canonicalizeJson({
      sessionId: approval.sessionId, challenge: approval.challenge, credentialId: credential.id,
      response: {
        id: credential.id, rawId: credential.id, type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'), userHandle: null,
        },
      },
    }),
  })
  expect(response.status, await response.text()).toBe(204)
}

function orderPage(): string {
  return `<!doctype html><html data-e2e-role="operator"><head><title>订单审批</title><link rel="icon" href="data:,"></head><body><main>
    <h1>订单 100</h1><p id="status">待审核</p><button id="approve">批准订单</button>
    <script>document.querySelector('#approve').addEventListener('click', async () => {
      const response = await fetch('/api/orders/100/approve?source=e2e', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({decision: 'approve', orderId: 100})
      });
      if (response.ok) document.querySelector('#status').textContent = '已批准';
    });</script></main></body></html>`
}

function observations(status: string): VerificationObservation[] {
  return [
    { probeId: 'PROBE-UI-STATUS', valueDigest: digestText('probe-ui/v1', status) },
    { probeId: 'PROBE-RESOURCE-STATUS', valueDigest: digestText('probe-resource/v1', status) },
  ]
}

async function requestThroughProxy(input: {
  proxyPort: number; url: string; payload: unknown
}): Promise<{ statusCode: number; body: string }> {
  const body = Buffer.from(JSON.stringify(input.payload))
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: input.proxyPort, path: input.url, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.byteLength },
    }, async (response) => resolve({ statusCode: response.statusCode ?? 0,
      body: (await readBody(response)).toString('utf8') }))
    request.on('error', reject)
    request.end(body)
  })
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}

class CapturingWritePageAdapter implements WriteBrowserPageAdapter {
  #screenshot?: Buffer
  #dom?: Buffer

  constructor(readonly delegate: WriteBrowserPageAdapter) {}
  goto(url: string) { return this.delegate.goto(url) }
  identity(): Promise<ObservedPageIdentity> { return this.delegate.identity() }
  containsText(text: string) { return this.delegate.containsText(text) }
  clickButton(name: string) { return this.delegate.clickButton(name) }
  waitForText(text: string) { return this.delegate.waitForText(text) }
  async screenshot(): Promise<Uint8Array> {
    const bytes = Buffer.from(await this.delegate.screenshot())
    this.#screenshot?.fill(0)
    this.#screenshot = Buffer.from(bytes)
    return bytes
  }
  async domSnapshot(): Promise<string> {
    const value = await this.delegate.domSnapshot()
    this.#dom?.fill(0)
    this.#dom = Buffer.from(value, 'utf8')
    return value
  }
  takeEvidence(): { screenshot: Buffer; dom: Buffer } {
    if (!this.#screenshot || !this.#dom) throw new Error('真实写浏览器没有生成完整证据')
    const evidence = { screenshot: Buffer.from(this.#screenshot), dom: Buffer.from(this.#dom) }
    this.#screenshot.fill(0)
    this.#dom.fill(0)
    this.#screenshot = undefined
    this.#dom = undefined
    return evidence
  }
}
