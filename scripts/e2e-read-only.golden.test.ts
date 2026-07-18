import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium } from 'playwright'
import { createGoldenApprovalReceipt } from './e2e-approval-receipt.js'
import {
  E2EError, canonicalizeJson, digestText, projectCoverageDispositionDecisionSubject,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import {
  EncryptedQuarantine, InMemoryQuarantineAuditLog, InMemorySecretProvider,
  LocalArtifactStore, PatternPrivacyScanner, auditPersistedAttemptFacts, buildCompleteGeneration,
  buildCoverageUniverse, computeVerdict, createCompletePublicationAuditor,
  createPersistedAttemptVerdictDependencies, createTrustedCompilerReadiness, verifyQuarantineAuditChain,
} from '@mutil-skills/e2e-engine'
import {
  LocalGatewayAuditSigner, LocalGatewayAuditVerifier, ReadOnlyGateway,
  verifyGatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import {
  PlaywrightPageAdapter, LocalRegressionDiscoveryAuthority, createRegressionDiscoveryVerifier,
  captureTrustedCompilerRuntimeMeasurement,
  createTrustedCompilerControlledReadLauncher,
  createTrustedCompilerExecutionTrust, createTrustedCompilerProjectorTrust,
  executeTrustedCompilerProject, prepareTrustedCompilerRun,
  projectCompilerInputFromArtifacts,
  runBrowserPreflight, startTrustedCompilerControlledReadBridge,
  type BrowserPageAdapter, type ObservedPageIdentity,
} from '@mutil-skills/e2e-playwright-runtime'
import { renderCompleteReport } from '@mutil-skills/e2e-report'
import { createGoldenAttemptProof } from './e2e-golden-attempt.js'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'
import { createReadOnlyApprovalProjection, createReadOnlyGoldenCompilerArtifacts, createReadOnlyGoldenDecisions,
  createReadOnlyGoldenGenerationInput } from './e2e-read-only-generation.js'

const tempDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PRD-driven read-only golden path', () => {
  test.each([
    { name: 'accepted 主链', fixtureText: '待审核', expectedCaseStatus: 'passed' as const,
      expectedVerdict: 'accepted' as const, blockedCase: undefined, sanitizerCanaryDetected: true,
      reportTitle: undefined, exerciseCrashRecovery: true, mixedDispositions: false },
    { name: 'blocked Case 不生成假测试并发布 incomplete 报告', fixtureText: '待审核',
      expectedCaseStatus: 'passed' as const, expectedVerdict: 'incomplete' as const,
      blockedCase: { caseId: 'CASE-BLOCKED-CANVAS', title: '订单趋势画布语义验收',
        stepId: 'STEP-BLOCKED-CANVAS', actionId: 'ACTION-BLOCKED-CANVAS',
        reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED' }, sanitizerCanaryDetected: true,
      reportTitle: undefined, exerciseCrashRecovery: false, mixedDispositions: false },
    { name: '真实业务断言失败发布 rejected 且保留回归', fixtureText: '已处理',
      expectedCaseStatus: 'failed' as const, expectedVerdict: 'rejected' as const,
      blockedCase: undefined, sanitizerCanaryDetected: true, reportTitle: undefined,
      exerciseCrashRecovery: false, mixedDispositions: false },
    { name: '证据 canary 失败阻断发布', fixtureText: '待审核', expectedCaseStatus: 'passed' as const,
      expectedVerdict: 'accepted' as const, blockedCase: undefined, sanitizerCanaryDetected: false,
      reportTitle: undefined, exerciseCrashRecovery: false, mixedDispositions: false },
    { name: '报告转义 XSS 并拒绝证据路径逃逸', fixtureText: '待审核', expectedCaseStatus: 'passed' as const,
      expectedVerdict: 'accepted' as const, blockedCase: undefined, sanitizerCanaryDetected: true,
      reportTitle: '<img src=x onerror="globalThis.__E2E_XSS_EXECUTED__=true">恶意报告标题',
      exerciseCrashRecovery: false, mixedDispositions: false },
    { name: '自动、人工与 N/A obligation 共同满足后 accepted', fixtureText: '待审核',
      expectedCaseStatus: 'passed' as const, expectedVerdict: 'accepted' as const,
      blockedCase: undefined, sanitizerCanaryDetected: true, reportTitle: undefined,
      exerciseCrashRecovery: false, mixedDispositions: true },
  ])('$name', async ({ fixtureText, expectedCaseStatus, expectedVerdict, blockedCase,
    sanitizerCanaryDetected, reportTitle, exerciseCrashRecovery, mixedDispositions }) => {
    const fixture = createServer((request, response) => {
      if (request.url !== '/orders') {
        response.writeHead(404).end('not found')
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html><html data-e2e-role="auditor"><head><title>订单</title><link rel="icon" href="data:,"></head><body><main><h1>订单列表</h1><div>${fixtureText}</div></main></body></html>`)
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const gatewayPolicyDigest = digestText('gateway-policy/v1', 'golden-read-only')
    const gatewaySigner = LocalGatewayAuditSigner.create({
      issuer: 'golden-gateway', keyId: 'golden-gateway-key', instanceId: 'GATEWAY-GOLDEN-1', version: '1.0.0',
    })
    const gatewayVerifier = LocalGatewayAuditVerifier.create(structuredClone(gatewaySigner.exportVerifierMaterial()))
    const gatewayRecorder = gatewaySigner.createRecorder(gatewayPolicyDigest)
    let currentGatewayActionId = 'ACTION-PREFLIGHT'
    const gateway = new ReadOnlyGateway({
      stage: 'bootstrap',
      recorder: gatewayRecorder,
      intents: [{
        intentId: 'INTENT-DOCUMENT', stage: 'bootstrap', methods: ['GET'],
        actionId: 'ACTION-PREFLIGHT', origin: fixtureOrigin, exactPath: '/orders', query: [], maxRequests: 2,
      }, {
        intentId: 'INTENT-CASE-DOCUMENT', stage: 'case', methods: ['GET'],
        actionId: 'ACTION-READ-1', origin: fixtureOrigin, exactPath: '/orders', query: [], maxRequests: 2,
      }],
    })
    const proxy = createServer((request, response) => {
      const decision = gateway.decide(
        { method: request.method ?? 'GET', url: request.url ?? '' }, currentGatewayActionId,
      )
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

    const modelDigest = digestText('requirement-model/v1', 'golden-model')
    const baseUniverse = buildCoverageUniverse({
      modelDigest,
      confirmedModelDigest: modelDigest,
      model: {
        modelRevision: 1,
        modelDecisionDigest: modelDigest,
        coupledDimensions: [],
        applicabilityRules: ['actor:auditor'],
        requirements: [{
          reqId: 'REQ-ORDER-1', revision: 1, title: '展示订单列表', actors: ['auditor'], entities: ['order'],
          preconditions: [], states: [], transitions: [],
          observableOutcomes: [{ oracleId: 'ORACLE-ORDER-VISIBLE', statement: '显示待审核订单' }],
          sourceRefs: ['prd:审核流程'], status: 'active',
          applicability: [{ dimension: 'actor', value: 'auditor', required: true }],
          rules: [{ ruleId: 'RULE-ORDER-1', category: 'business', statement: '显示待审核订单', sourceRefs: ['prd:1'], certainty: 'explicit' }],
        }],
      },
      nodes: [{ nodeId: 'NODE-LIST', reqId: 'REQ-ORDER-1', kind: 'page', title: '订单列表', effect: 'read', hasOracle: true }],
      policy: { policyVersion: '1.0.0', ruleScenarios: { business: ['happy-path'] }, pairwiseSeed: 1 },
      dispositionFor: () => ({ kind: 'automated', caseIds: ['CASE-READ-1'] }),
    })
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
      approvalIdentities: [{ subject: 'os-user:golden', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'golden-session'
        ? createGoldenApprovalReceipt('os-user:golden', 'RUN-READ-1', expected) : undefined,
      manualIdentities: [
        { subject: 'os-user:privacy-golden', roles: ['privacy-approver'] },
        { subject: 'os-user:scope-golden', roles: ['scope-approver'] },
        { subject: 'os-user:lineage-golden', roles: ['lineage-approver'] },
        { subject: 'os-user:coverage-golden', roles: ['coverage-approver'] },
        { subject: 'os-user:manual-executor', roles: ['e2e-manual-executor'] },
        { subject: 'os-user:manual-reviewer', roles: ['e2e-manual-reviewer'] },
      ],
    })
    const naObligationId = 'COV-ORDER-BULK-NA'
    const manualObligationId = 'COV-ORDER-A11Y-MANUAL'
    const naDecisionSubject = projectCoverageDispositionDecisionSubject({
      obligationId: naObligationId, requirementModelDigest: modelDigest,
      coveragePolicyDigest: baseUniverse.coveragePolicyDigest, disposition: 'not-applicable',
      policyCode: 'POLICY-NO-BULK-ENTRY', rationale: '当前产品范围没有批量审核入口',
    })
    const naReceipt = mixedDispositions ? authority.issueDecisionReceipt({
      kind: 'coverage-disposition', decisionId: 'COVERAGE-NA-GOLDEN', decisionStatus: 'approved',
      decisionSubject: naDecisionSubject,
      approver: { subject: 'os-user:coverage-golden', roles: ['coverage-approver'] },
    }) : undefined
    const mixedObligations = mixedDispositions ? [
      ...baseUniverse.obligations,
      { ...baseUniverse.obligations[0]!, obligationId: manualObligationId, kind: 'rule' as const,
        scenario: '人工检查键盘焦点顺序', disposition: {
          kind: 'manual' as const, manualProcedureId: 'MANUAL-PROCEDURE-ORDER-A11Y', blocking: true,
        } },
      { ...baseUniverse.obligations[0]!, obligationId: naObligationId, kind: 'rule' as const,
        actor: 'not-applicable' as const, scenario: '批量审核入口', disposition: {
          kind: 'not-applicable' as const, policyCode: 'POLICY-NO-BULK-ENTRY',
          rationale: '当前产品范围没有批量审核入口', decisionGrantId: 'COVERAGE-NA-GOLDEN',
          decisionReceipt: naReceipt!,
        } },
    ] : baseUniverse.obligations
    const universe = mixedDispositions ? {
      ...baseUniverse, obligations: mixedObligations,
      universeDigest: digestText('coverage-universe/v1', canonicalizeJson({
        coveragePolicyDigest: baseUniverse.coveragePolicyDigest,
        pairwiseSeed: baseUniverse.pairwiseSeed, obligations: mixedObligations,
      })),
    } : baseUniverse
    const manualResultDraft = mixedDispositions ? {
      schemaVersion: '1.0.0', manualResultId: 'MANUAL-RESULT-ORDER-A11Y', assetId: 'PRODUCT-PRD-1',
      prdRevision: modelDigest, generationId: 'GENERATION-1',
      manualProcedureId: 'MANUAL-PROCEDURE-ORDER-A11Y', obligationIds: [manualObligationId],
      executor: { subject: 'os-user:manual-executor', roles: ['e2e-manual-executor'] },
      reviewer: { subject: 'os-user:manual-reviewer', roles: ['e2e-manual-reviewer'] },
      startedAt: '2026-07-11T09:58:00.000Z', finishedAt: '2026-07-11T09:59:00.000Z', outcome: 'passed',
      steps: [{ stepId: 'MANUAL-STEP-ORDER-A11Y',
        instructionDigest: digestText('golden-fact/v1', `manual:${manualObligationId}`), outcome: 'passed',
        observation: '键盘焦点按订单列表语义顺序移动',
        evidenceDigests: [digestText('manual-evidence/v1', 'order-a11y-observation')] }],
      evidenceDigests: [digestText('manual-evidence/v1', 'order-a11y-observation')],
      expiresAt: '2026-07-12T09:59:00.000Z',
    } as const : undefined
    const decisions = createReadOnlyGoldenDecisions({
      authority, modelDigest,
      scope: { status: 'approved', approver: { subject: 'os-user:scope-golden', roles: ['scope-approver'] } },
      lineage: { status: 'approved', approver: { subject: 'os-user:lineage-golden', roles: ['lineage-approver'] } },
    })
    const workspace = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-golden-'))
    tempDirectories.push(workspace)
    const discoveryAuthority = LocalRegressionDiscoveryAuthority.create({
      issuer: 'golden-regression-discovery', keyId: 'golden-regression-key',
    })
    const executionTrust = await createTrustedCompilerExecutionTrust({
      discoveryAuthority: { material: discoveryAuthority.verifierMaterial,
        expectedPublicKeyDigest: discoveryAuthority.verifierMaterial.publicKeyDigest },
      approvalFreshnessClient: authority.createTrustedApprovalFreshnessClient(),
      browserExecutablePath: resolveChromeExecutablePath(),
      gatewayProxyEndpoint: `http://127.0.0.1:${proxyPort}/`,
    })
    const runtimeMeasurement = captureTrustedCompilerRuntimeMeasurement(executionTrust)
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutablePath(),
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
    })
    try {
      const page = await browser.newPage()
      const capturingPage = new CapturingPageAdapter(new PlaywrightPageAdapter(page))
      const approvalProjection = createReadOnlyApprovalProjection({ modelDigest, universe, fixtureOrigin,
        runtimePolicyDigest: gatewayPolicyDigest, decisions, blockedCase })
      if (decisions.lineageDecision.status !== 'approved') throw new Error('Golden lineage 未批准')
      const discoverySubject = {
        schemaVersion: '1.1.0' as const, assetId: 'PRODUCT-PRD-1', prdRevision: modelDigest,
        scopeDigest: approvalProjection.scopeDigest, environment: 'test' as const, baseOrigin: fixtureOrigin, actor: 'auditor',
        expectedPageIdentity: {
          url: `${fixtureOrigin}/orders`, title: '订单', heading: '订单列表', ariaSignals: ['main:订单列表'],
        },
        bootstrapIntentsDigest: modelDigest,
        requests: [],
        actions: [{ actionId: 'ACTION-PREFLIGHT', operation: 'local-navigation' as const, maxUses: 1, requestIds: [] }],
      }
      const discoveryGrant = await authority.issueDiscoveryGrant({
        subject: discoverySubject, approver: { subject: 'os-user:golden', roles: ['e2e-approver'] },
        approvalSessionRef: 'golden-session', ttlMs: 60_000,
      })
      const preflight = await runBrowserPreflight({
        authorization: { grant: discoveryGrant, currentSubject: discoverySubject, authority },
        runtime: { sandboxHealthy: true, gatewayConnected: true }, gatewayAudit: () => gateway.getAuditSummary(),
        page: capturingPage, actionId: 'ACTION-PREFLIGHT', attemptId: 'ATTEMPT-PREFLIGHT-READ-1',
      })
      if (preflight.status !== 'ready' || !preflight.preflightDigest) throw new Error('Discovery preflight 未 ready')
      const grant = await authority.issueReadGrant({
        subject: {
          schemaVersion: '2.1.0', assetId: 'PRODUCT-PRD-1', prdRevision: modelDigest,
          ...approvalProjection,
          environment: 'test', baseOrigin: fixtureOrigin, actor: 'auditor',
          discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
          requests: [],
          actions: [
            { actionId: 'ACTION-READ-1', operation: 'local-navigation', maxUses: 1, requestIds: [] },
            { actionId: 'ACTION-READ-1', operation: 'dom-read', maxUses: 1, requestIds: [] },
            { actionId: 'ACTION-READ-1', operation: 'screenshot', maxUses: 1, requestIds: [] },
          ],
        },
        approver: { subject: 'os-user:golden', roles: ['e2e-approver'] },
        approvalSessionRef: 'golden-session', ttlMs: 60_000,
      })
      const compilerArtifacts = await createReadOnlyGoldenCompilerArtifacts({
        modelDigest, universe, fixtureOrigin, runtimePolicyDigest: gatewayPolicyDigest,
        decisions, blockedCase, authority, grant,
        discoveryGrantId: discoveryGrant.grantId, preflightDigest: preflight.preflightDigest,
        generationId: 'GENERATION-1',
      })
      const readinessArtifacts = compilerArtifacts.filter((artifact) =>
        ['prd-manifest', 'prd-diff', 'acceptance-scope'].includes((artifact as { artifactType: string }).artifactType))
      const readiness = createTrustedCompilerReadiness({
        artifacts: readinessArtifacts, contractsVersion: '2.0.0',
        verifyArtifactSignature: authority.verifyArtifactSignature.bind(authority),
        verifyDecisionReceipt: authority.verifyDecisionReceipt.bind(authority),
      })
      const projectorTrust = createTrustedCompilerProjectorTrust({
        artifactAuthority: { material: authority.artifactVerifierMaterial,
          expectedPublicKeyDigest: authority.artifactVerifierMaterial.publicKeyDigest },
        approvalFreshnessAuthority: { material: authority.approvalFreshnessVerifierMaterial,
          expectedPublicKeyDigest: authority.approvalFreshnessVerifierMaterial.publicKeyDigest },
        readiness,
      })
      const compilerInput = projectCompilerInputFromArtifacts({
        artifacts: compilerArtifacts, playwrightVersion: '1.61.1',
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
      const trustedReadSession = await prepareTrustedCompilerRun({
        projectDir: regressionDiscovery.projectDir,
        subject: regressionDiscovery.subject,
        attestation: regressionDiscovery.attestation,
        trust: executionTrust,
        expected: { assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-1', prdRevision: modelDigest,
          runId: 'RUN-READ-1', approvalDigest, executionProfile: 'trusted-read-only' },
        authorityTransport: 'in-process-test',
      })
      const auditedReadAuthority = {
        reserveForSubject: (reservationInput: Parameters<typeof authority.reserveForSubject>[0]) =>
          authority.reserveForSubject(reservationInput),
        complete: async (reservationId: string, outcomeDigest: string) => {
          await authority.complete(reservationId, outcomeDigest)
          const reservation = authority.getReservation(reservationId)
          if (!reservation) throw new Error(`Reservation 完成后不可重读：${reservationId}`)
          gatewayRecorder.recordCapabilityReservation({ reservation, consumed: true })
        },
      }
      const readAction = { actionId: 'ACTION-READ-1', target: '订单列表', expected: '待审核' }
      const readLauncher = createTrustedCompilerControlledReadLauncher([{
        action: readAction,
        runnerInput: {
          caseId: 'CASE-READ-1', actionId: 'ACTION-READ-1', url: `${fixtureOrigin}/orders`,
          expectedIdentity: { title: '订单', heading: '订单列表', role: 'auditor' }, expectedText: '待审核',
          authorization: { grant, currentSubject: grant.subject, authority: auditedReadAuthority },
          attemptId: 'ATTEMPT-READ-1', runtime: { sandboxHealthy: true, gatewayConnected: true },
          gatewayAudit: () => gateway.getAuditSummary(), page: new PlaywrightPageAdapter(page),
        },
      }], trustedReadSession)
      const readBridge = await startTrustedCompilerControlledReadBridge({
        session: trustedReadSession, actions: [readAction], launch: readLauncher,
      })
      gateway.switchToCaseStage()
      currentGatewayActionId = 'ACTION-READ-1'
      const generatedExecution = await executeTrustedCompilerProject({
        session: trustedReadSession, readBridge, timeoutMs: 30_000,
      }).finally(() => readBridge.close())
      if ((generatedExecution.exitCode === 0) !== (expectedCaseStatus === 'passed')) {
        throw new Error(`生成项目执行结果与预期不一致：exit=${generatedExecution.exitCode}\n${generatedExecution.stdout}\n${generatedExecution.stderr}`)
      }
      const readExecutions = readBridge.executions()
      const readExecution = readExecutions.find((item) => item.result.caseId === 'CASE-READ-1'
        && item.result.actionId === 'ACTION-READ-1')
      if (!readExecution || readExecutions.length !== 1) throw new Error('受控只读 Bridge 结果集合不闭合')
      const caseResult = readExecution.result
      const attempt = createGoldenAttemptProof({
        authority, assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-1', prdRevision: modelDigest,
        runId: 'RUN-READ-1', caseId: 'CASE-READ-1', attemptId: 'ATTEMPT-READ-1',
        status: caseResult.status === 'passed' || caseResult.status === 'failed'
          ? caseResult.status : 'safety-blocked', effect: 'read',
        reservationId: caseResult.reservationIds?.[0], outcomeDigest: caseResult.outcomeDigest,
      })
      const capturedEvidence = readExecution.evidence
      const quarantineRoot = await mkdtemp(join(tmpdir(), 'e2e-golden-quarantine-'))
      tempDirectories.push(quarantineRoot)
      const quarantineSecrets = new InMemorySecretProvider()
      const quarantineAudit = new InMemoryQuarantineAuditLog()
      const quarantine = new EncryptedQuarantine({
        root: quarantineRoot, secrets: quarantineSecrets, audit: quarantineAudit,
        now: () => new Date('2026-07-11T10:00:00.000Z'),
      })
      const quarantineRun = await quarantine.createRun({
        runId: 'RUN-READ-1', ttlMs: 60_000,
        actor: { subject: 'runner:golden', roles: ['e2e-runner'] },
      })
      const screenshotRecord = await quarantine.writeEvidence({
        runId: quarantineRun.runId, relativePath: 'raw/screenshot.png', plaintext: capturedEvidence.screenshot,
        actor: { subject: 'runner:golden', roles: ['e2e-runner'] },
      })
      const domRecord = await quarantine.writeEvidence({
        runId: quarantineRun.runId, relativePath: 'raw/dom.snapshot', plaintext: capturedEvidence.dom,
        actor: { subject: 'runner:golden', roles: ['e2e-runner'] },
      })
      expect(quarantineRoot.startsWith(process.cwd())).toBe(false)
      expect((await readFile(join(quarantineRoot, quarantineRun.runId, screenshotRecord.ciphertextFile)))
        .includes(capturedEvidence.screenshot)).toBe(false)
      expect((await readFile(join(quarantineRoot, quarantineRun.runId, domRecord.ciphertextFile)))
        .includes(capturedEvidence.dom)).toBe(false)
      capturedEvidence.screenshot.fill(0)
      capturedEvidence.dom.fill(0)
      const sanitizerEvidence = {
        screenshot: await quarantine.readEvidence({
          runId: quarantineRun.runId, relativePath: screenshotRecord.relativePath,
          actor: { subject: 'sanitizer:golden', roles: ['e2e-sanitizer'] },
        }),
        dom: await quarantine.readEvidence({
          runId: quarantineRun.runId, relativePath: domRecord.relativePath,
          actor: { subject: 'sanitizer:golden', roles: ['e2e-sanitizer'] },
        }),
      }
      const gatewayAudit = gatewayRecorder.finalize()
      expect(verifyGatewayPublicationAudit(gatewayAudit, gatewayVerifier)).toBe(true)
      let validationInput: ReturnType<typeof buildCompleteGeneration>['validationInput'] | undefined
      let publishedFiles: Record<string, Uint8Array> | undefined
      const store = new LocalArtifactStore(workspace, {
        auditStagedGeneration: createCompletePublicationAuditor({
          scanner: new PatternPrivacyScanner('1.0.0'),
          resolveValidationInput: () => {
            if (!validationInput) throw new Error('完整代际尚未准备完成')
            return validationInput
          },
        }),
        signDigest: (digest) => authority.signArtifactDigest(digest),
        verifySignature: (signature) => authority.verifyArtifactSignature(signature),
      })
      let publicationError: unknown
      try {
        await store.publishPrepared({
          assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-1',
          prepare: async ({ fencingToken }) => {
          let complete: ReturnType<typeof buildCompleteGeneration>
          try {
            complete = buildCompleteGeneration(await createReadOnlyGoldenGenerationInput({
              fencingToken, modelDigest, universe, authority, caseResult, attempt,
              gatewayAudit, gatewayVerifier, capturedEvidence: sanitizerEvidence,
              regressionDiscovery, regressionDiscoveryVerifier,
              trustedCompilerExecution: generatedExecution.execution, fixtureOrigin,
              trustedRuntimeMeasurement: runtimeMeasurement,
              discoveryGrant, readGrant: grant, authorityPreflightDigest: preflight.preflightDigest,
              privacyDecisions: [{ evidenceId: 'EVIDENCE-SCREENSHOT', decision: 'approved',
                approver: { subject: 'os-user:privacy-golden', roles: ['privacy-approver'] } }],
              decisions, blockedCase, sanitizerCanaryDetected, reportTitle,
              ...(manualResultDraft ? { manualResultDrafts: [manualResultDraft] } : {}),
            }))
          } finally {
            sanitizerEvidence.screenshot.fill(0)
            sanitizerEvidence.dom.fill(0)
          }
          validationInput = complete.validationInput
          expect(complete.files.filter((file) => file.path.startsWith('evidence/'))).toHaveLength(3)
          expect(complete.files.every((file) => file.byteLength > 0)).toBe(true)
          expect(complete.files.some((file) => file.path.includes('quarantine') || file.path.startsWith('raw/'))).toBe(false)
          publishedFiles = Object.fromEntries(complete.files.map((file) => [file.path, file.bytes]))
          return {
            terminalVerdict: complete.terminalVerdict,
            files: publishedFiles,
          }
          },
        })
      } catch (error) {
        if (!sanitizerCanaryDetected) publicationError = error
        else if (error instanceof E2EError) {
          throw new Error(`${error.code}:${error.refs.join('|')}`, { cause: error })
        } else throw error
      }
      if (!sanitizerCanaryDetected) {
        expect(publicationError).toBeInstanceOf(Error)
        expect((publicationError as Error).message).toContain('E2E_PRIVACY_CANARY_FAILED')
        expect(await store.readActive('PRODUCT-PRD-1')).toBeUndefined()
        await quarantine.recoverRun({
          runId: quarantineRun.runId, action: 'destroy',
          actor: { subject: 'privacy-admin:golden', roles: ['e2e-privacy-admin'] },
        })
        expect(await quarantineSecrets.hasKey(quarantineRun.keyId)).toBe(false)
        await expect(stat(join(quarantineRoot, quarantineRun.runId))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(verifyQuarantineAuditChain(quarantineAudit.events)).toBe(true)
        return
      }

      const active = await store.readActive('PRODUCT-PRD-1')
      await quarantine.destroyAfterPublication({
        runId: quarantineRun.runId, generationDigest: active!.generationDigest,
        actor: { subject: 'publisher:golden', roles: ['e2e-publisher'] },
      })
      expect(await quarantineSecrets.hasKey(quarantineRun.keyId)).toBe(false)
      await expect(stat(join(quarantineRoot, quarantineRun.runId))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(verifyQuarantineAuditChain(quarantineAudit.events)).toBe(true)
      expect(quarantineAudit.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'write', decision: 'allowed' }),
        expect.objectContaining({ action: 'read', decision: 'allowed' }),
        expect.objectContaining({ action: 'destroy', decision: 'allowed',
          reasonCode: 'E2E_QUARANTINE_PUBLICATION_CRYPTO_ERASURE' }),
      ]))
      const finalReport = JSON.parse(await readFile(join(active!.generationPath, 'run/final-report.json'), 'utf8'))
      const generationManifest = JSON.parse(await readFile(join(active!.generationPath, 'generation-manifest.json'), 'utf8'))
      const verdictInput = JSON.parse(await readFile(join(active!.generationPath, 'run/verdict-input.json'), 'utf8'))
      const browserEvidence = JSON.parse(await readFile(join(active!.generationPath, 'run/browser-evidence.json'), 'utf8'))
      const attemptArtifacts = await Promise.all([
        'design/test-cases.json', 'run/run-bundle.json', 'run/browser-results.json',
        'run/gateway-audit.json', 'run/workflow-events.json',
      ].map(async (relativePath) => JSON.parse(await readFile(join(active!.generationPath, relativePath), 'utf8'))))
      const persistedAttemptAudit = auditPersistedAttemptFacts(attemptArtifacts,
        (proof) => authority.verifyAttemptEventProof(proof))
      const recomputedVerdict = computeVerdict(verdictInput,
        createPersistedAttemptVerdictDependencies(persistedAttemptAudit,
          (result) => authority.verifyManualResult(result)))
      expect(caseResult.status).toBe(expectedCaseStatus)
      expect(active).toMatchObject({ generationId: 'GENERATION-1', terminalVerdict: expectedVerdict })
      expect(finalReport).toMatchObject({ generationId: 'GENERATION-1', content: { verdict: expectedVerdict } })
      expect(generationManifest).toMatchObject({
        generationId: 'GENERATION-1',
        content: { generationId: 'GENERATION-1', terminalVerdict: expectedVerdict },
      })
      expect(verdictInput).toMatchObject({ generationId: 'GENERATION-1' })
      expect(finalReport.content.verdictInputDigest).toBe(digestText('verdict-input/v2', canonicalizeJson(verdictInput)))
      expect(persistedAttemptAudit.valid).toBe(true)
      expect(finalReport.content).toMatchObject({
        verdict: recomputedVerdict.verdict,
        reasonCodes: recomputedVerdict.reasonCodes,
        metrics: recomputedVerdict.metrics,
      })
      const crossBrowserLimitation = '未完整批准、计划并执行浏览器：FIREFOX、WEBKIT；不能宣称跨浏览器兼容性'
      expect(finalReport.content.cannotClaim).toContain(crossBrowserLimitation)
      expect(finalReport.content.metrics.injectionPassRate).toMatchObject({
        status: 'not-applicable', numerator: 0, denominator: 0,
      })
      expect(finalReport.content.metrics.cleanupSuccess).toMatchObject({
        status: 'not-applicable', numerator: 0, denominator: 0,
      })
      const renderedReport = renderCompleteReport(finalReport)
      const reportPage = await browser.newPage()
      try {
        await reportPage.setContent(renderedReport.html, { waitUntil: 'domcontentloaded' })
        const injectionMetricRow = reportPage.getByRole('row').filter({ hasText: '注入通过率' })
        const cleanupMetricRow = reportPage.getByRole('row').filter({ hasText: '清理成功率' })
        const injectionMetricText = await injectionMetricRow.textContent()
        const cleanupMetricText = await cleanupMetricRow.textContent()
        expect(injectionMetricText).toContain('不适用')
        expect(cleanupMetricText).toContain('不适用')
        expect(injectionMetricText).not.toContain('0.00%')
        expect(cleanupMetricText).not.toContain('0.00%')
        expect(await reportPage.locator('body').textContent()).toContain(crossBrowserLimitation)
        if (reportTitle) {
          expect(finalReport.content.title).toBe(reportTitle)
          expect(await reportPage.locator('img').count()).toBe(0)
          expect(await reportPage.locator('body').textContent()).toContain(reportTitle)
          expect(await reportPage.evaluate(() =>
            (globalThis as typeof globalThis & { __E2E_XSS_EXECUTED__?: boolean }).__E2E_XSS_EXECUTED__))
            .toBeUndefined()
          const unsafePathReport = structuredClone(finalReport)
          unsafePathReport.content.caseDetails[0].steps[0].evidenceLinks[0] = '../escape.png'
          expect(() => renderCompleteReport(unsafePathReport)).toThrowError(expect.objectContaining({
            code: 'E2E_REPORT_INPUT_INVALID',
          }))
        }
      } finally {
        await reportPage.close()
      }
      expect(generationManifest.content.artifacts).toHaveLength(26)
      expect(new Set(generationManifest.content.artifacts.map((item: { artifactType: string }) => item.artifactType)).size).toBe(26)
      expect(generationManifest.content.artifacts.some((item: { artifactType: string }) => item.artifactType === 'generation-manifest')).toBe(false)
      expect(new Set([
        ...generationManifest.content.artifacts.map((item: { artifactType: string }) => item.artifactType),
        generationManifest.artifactType,
      ]).size).toBe(27)
      expect(browserEvidence.content.artifacts).toHaveLength(3)
      expect(browserEvidence.content.artifacts.find((item: { evidenceId: string }) =>
        item.evidenceId === 'EVIDENCE-SCREENSHOT').sanitizationRecord.manualReview.status).toBe('pending')
      expect(browserEvidence.content.privacyReviews.every((item: { status: string }) =>
        item.status === 'approved' || item.status === 'not-required')).toBe(true)
      if (blockedCase) {
        const regressionManifest = JSON.parse(await readFile(
          join(active!.generationPath, 'run/regression-manifest.json'), 'utf8'))
        const generatedSpec = await readFile(
          join(active!.generationPath, 'regression/tests/generated.spec.ts'), 'utf8')
        expect(regressionManifest.content.blockedCases).toEqual([
          { caseId: blockedCase.caseId, reasonCode: blockedCase.reasonCode },
        ])
        expect(regressionManifest.content.caseMappings.map((item: { caseId: string }) => item.caseId))
          .not.toContain(blockedCase.caseId)
        expect(regressionManifest.content.listResult.caseIds).not.toContain(blockedCase.caseId)
        expect(generatedSpec).not.toContain(blockedCase.caseId)
        expect(generatedSpec).not.toMatch(/\btest\s*\.\s*(?:skip|fixme|fail|only|todo)/)
        expect(finalReport.content.dispositions).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: blockedCase.caseId, kind: 'blocked', status: 'blocked' }),
        ]))
        expect(finalReport.content.verdict).toBe('incomplete')
        expect(finalReport.content.reasonCodes).toContain('VERDICT_REQUIRED_CASE_MISSING')
        expect(finalReport.content.metrics.executionCoverage.status).toBe('value')
        expect(finalReport.content.metrics.executionCoverage.percentage).toBeLessThan(100)
        expect(finalReport.content.caseDetails.filter((item: { status: string }) => item.status === 'passed'))
          .toHaveLength(1)
      }
      if (expectedCaseStatus === 'failed') {
        const regressionManifest = JSON.parse(await readFile(
          join(active!.generationPath, 'run/regression-manifest.json'), 'utf8'))
        const generatedSpec = await readFile(
          join(active!.generationPath, 'regression/tests/generated.spec.ts'), 'utf8')
        expect(finalReport.content.verdict).toBe('rejected')
        expect(finalReport.content.reasonCodes).toContain('VERDICT_REQUIRED_OBLIGATION_FAILED')
        expect(finalReport.content.caseDetails).toEqual(expect.arrayContaining([
          expect.objectContaining({ caseId: 'CASE-READ-1', status: 'failed' }),
        ]))
        expect(regressionManifest.content.caseMappings).toEqual(expect.arrayContaining([
          expect.objectContaining({ caseId: 'CASE-READ-1' }),
        ]))
        expect(regressionManifest.content.listResult.caseIds).toContain('CASE-READ-1')
        expect(generatedSpec).toContain('CASE-READ-1')
      }
      if (mixedDispositions) {
        expect(finalReport.content.verdict).toBe('accepted')
        expect(finalReport.content.dispositions).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: manualObligationId, kind: 'manual', status: 'manual-required' }),
          expect.objectContaining({ id: naObligationId, kind: 'not-applicable', status: 'not-applicable' }),
          expect.objectContaining({ id: 'MANUAL-RESULT-ORDER-A11Y', kind: 'manual', status: 'passed' }),
        ]))
        expect(finalReport.content.reasonCodes).toContain('VERDICT_ALL_REQUIRED_OBLIGATIONS_SATISFIED')
      }
      if (exerciseCrashRecovery) {
        expect(publishedFiles).toBeDefined()
        await expect(store.publish({
          assetId: 'PRODUCT-PRD-1', generationId: 'GENERATION-CRASHED-2',
          terminalVerdict: expectedVerdict, files: publishedFiles!, faultAt: 'crash-after-file-fsync',
        })).rejects.toMatchObject({ code: 'E2E_ARTIFACT_FAULT_INJECTED' })
        const recovered = await store.recover('PRODUCT-PRD-1')
        expect(recovered).toMatchObject({
          generationId: active!.generationId, generationDigest: active!.generationDigest,
          terminalVerdict: active!.terminalVerdict,
        })
        const recoveredReport = JSON.parse(await readFile(
          join(recovered!.generationPath, 'run/final-report.json'), 'utf8'))
        const recoveredManifest = JSON.parse(await readFile(
          join(recovered!.generationPath, 'generation-manifest.json'), 'utf8'))
        expect(recoveredReport).toEqual(finalReport)
        expect(recoveredManifest).toEqual(generationManifest)
      }
    } finally {
      await browser.close()
    }
  }, 30_000)
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}

class CapturingPageAdapter implements BrowserPageAdapter {
  #screenshot?: Buffer
  #dom?: Buffer

  constructor(readonly delegate: BrowserPageAdapter) {}
  goto(url: string) { return this.delegate.goto(url) }
  identity(): Promise<ObservedPageIdentity> { return this.delegate.identity() }
  containsText(text: string) { return this.delegate.containsText(text) }
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
    if (!this.#screenshot || !this.#dom) throw new Error('真实浏览器没有生成完整证据')
    const evidence = { screenshot: Buffer.from(this.#screenshot), dom: Buffer.from(this.#dom) }
    this.#screenshot.fill(0)
    this.#dom.fill(0)
    this.#screenshot = undefined
    this.#dom = undefined
    return evidence
  }
}
