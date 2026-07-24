import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runtimeFullPlaywrightFixture, runtimeReadOnlyFixture } from './fixture.js'

const homeDir = requiredEnvironment('HOME')
const projectRoot = requiredEnvironment('E2E_PACKED_PROJECT')
const runtimePackageRoot = requiredEnvironment('E2E_PACKED_RUNTIME_PACKAGE_ROOT')
const installedPackage = async (name) => await import(pathToFileURL(
  join(runtimePackageRoot, '..', name, 'dist', 'src', 'index.js'),
).href)
const runtimeModule = async (name) => await import(pathToFileURL(
  join(runtimePackageRoot, 'dist', 'src', `${name}.js`),
).href)

const [{
  AuthenticatedRpcServer,
  LocalApprovalAuthority,
  createAuthenticatedRpcHttpTransport,
  createAuthorityReadRpcClient,
  registerAuthorityExecutionRpcOperations,
  startAuthenticatedRpcLoopbackServer,
}, {
  ReadApprovalSubjectSchema,
  RegressionDiscoveryAttestationSchema,
  RegressionDiscoveryVerifierMaterialSchema,
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  SignedGrantSchema,
  canonicalizeJson,
  digestArtifactContent,
  digestText,
  parseArtifactDocument,
}] = await Promise.all([
  installedPackage('e2e-authority'),
  installedPackage('e2e-contracts'),
])
const [{ LocalGatewayAuditVerifier, verifyGatewayPublicationAudit }, {
  PlaywrightPageAdapter,
  createTrustedCompilerControlledReadLauncher,
  createTrustedCompilerExecutionTrust,
  discardTrustedCompilerRun,
  executeTrustedCompilerProject,
  prepareTrustedCompilerRun,
  runBrowserPreflight,
  startTrustedCompilerControlledReadBridge,
}] = await Promise.all([
  installedPackage('e2e-gateway'),
  installedPackage('e2e-playwright-runtime'),
])
const [{ inspectRuntimeInstallation },
  { runtimeProductionSanitizerPolicyDigest }, { resolveRuntimeBrowserInstallation },
  { ControlledBrowserHost, getControlledBrowserSessionBinding },
  { startGatewayProxyHostForRuntime }, { runtimeLayout }, { RuntimeRunStore },
  { resolveProjectIdentity }, { TrustedReadActionProjector }, { BrowserPreflightFactSchema },
  { projectGatewayRules }, { openRuntimeArtifactStoreAuthority }] = await Promise.all([
  runtimeModule('runtime-discovery'),
  runtimeModule('runtime-finalization-material-sealer'),
  runtimeModule('runtime-browser-wiring'), runtimeModule('browser-host'),
  runtimeModule('gateway-proxy-host'), runtimeModule('runtime-layout'), runtimeModule('run-store'),
  runtimeModule('project-identity'), runtimeModule('trusted-action-runner'), runtimeModule('runtime-preflight'),
  runtimeModule('gateway-rule-projector'), runtimeModule('authority-host'),
])

await Promise.all([
  mkdir(join(projectRoot, '.biztest'), { recursive: true, mode: 0o700 }),
  mkdir(join(projectRoot, 'inputs'), { recursive: true, mode: 0o700 }),
])
await Promise.all([
  writeFile(join(projectRoot, '.biztest', 'project.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', projectId: 'RUNTIME-CROSS-REPO-GOLDEN',
  })}\n`, { mode: 0o600 }),
  writeFile(join(projectRoot, 'inputs', 'prd.md'), [
    '# 订单验收',
    '',
    '审计员应能看到待审核订单。',
    '审计员可以填写姓名、按键提交、勾选启用状态并打开详情弹窗。',
    '系统必须支持独立多页面，并以 JSON Body 提交写请求。',
    '写操作完成后必须执行 Cleanup，再 Reload 页面确认状态恢复为 clean。',
    '',
  ].join('\n'), { mode: 0o600 }),
  writeFile(join(projectRoot, 'inputs', 'policy.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', environment: 'test', browser: 'chromium',
  })}\n`, { mode: 0o600 }),
])

const installation = await inspectRuntimeInstallation({ homeDir })
let applicationState = 'clean'
const receivedApiBodies = []
let resetObserved = false
let rootReadsAfterReset = 0
const fixtureServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'POST' && url.pathname === '/api') {
    const body = await readRequestBody(request)
    receivedApiBodies.push(body)
    if (body !== canonicalizeJson({ enabled: true, name: 'Ada' })) {
      response.writeHead(400); response.end('bad json body'); return
    }
    applicationState = 'dirty'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (request.method === 'POST' && url.pathname === '/reset') {
    applicationState = 'clean'
    resetObserved = true
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (request.method === 'GET' && url.pathname === '/' && resetObserved) rootReadsAfterReset += 1
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (url.pathname === '/popup') {
    response.end('<!doctype html><html><head><title>popup</title></head><body>details</body></html>')
    return
  }
  if (url.pathname === '/extra') {
    response.end('<!doctype html><html><head><title>extra</title></head><body>extra page</body></html>')
    return
  }
  response.end(`<!doctype html><html data-e2e-role="auditor"><head><title>订单</title><link rel="icon" href="data:,"></head><body><main><h1>订单列表</h1><p>页面显示待审核订单</p><label>Name<input aria-label="Name"></label><label>Enabled<input aria-label="Enabled" type="checkbox"></label><a href="/popup" target="_blank">Details</a><div id="row">row</div><button id="remove">remove</button><span id="state">${applicationState}</span></main></body></html>`)
})
await listen(fixtureServer)
const address = fixtureServer.address()
if (!address || typeof address === 'string') throw new Error('fixture page server missing port')
const fixtureUrl = `http://127.0.0.1:${address.port}/orders`

let runId = ''
const approver = { subject: 'os-user:runtime-cross-repo', roles: ['e2e-approver'] }
const approvalAuthority = LocalApprovalAuthority.create({
  issuer: 'runtime-cross-repo-authority', keyId: 'runtime-cross-repo-key', now: () => new Date(),
  approvalIdentities: [approver],
  manualIdentities: [
    { subject: 'os-user:runtime-scope', roles: ['scope-approver'] },
    { subject: 'os-user:runtime-lineage', roles: ['lineage-approver'] },
    { subject: 'os-user:runtime-privacy', roles: ['privacy-approver'] },
  ],
  authenticateApproverSession: (_sessionId, expected) => ({
    subject: approver.subject, runId, approvalType: expected.approvalType,
    subjectDigest: expected.subjectDigest, installationDigest: installation.installationDigest,
    origin: 'http://127.0.0.1:43210', issuedAt: new Date().toISOString(),
    // 上级审批上下文必须完整包住稍后签发的 10 分钟 Grant，避免毫秒级越界。
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }),
})
const rpc = AuthenticatedRpcServer.create({
  issuer: 'runtime-cross-repo-rpc', keyId: 'runtime-cross-repo-rpc-key', now: () => new Date(),
})
registerAuthorityExecutionRpcOperations(rpc, {
  writeAuthority: approvalAuthority,
  leaseAuthority: { async verifyTarget() { return false } },
  discoveryAuthority: approvalAuthority,
  readAuthority: approvalAuthority,
})
const rpcHttp = await startAuthenticatedRpcLoopbackServer(rpc)
let activeApprovalContext
let rpcClientOrdinal = 0
let approvalSessionOrdinal = 0
const authorityAdapter = {
  async requestApproval(input) {
    approvalSessionOrdinal += 1
    const sessionRef = `cross-repo:${input.approvalType}:${approvalSessionOrdinal}`
    return {
      sessionId: `SESSION-${input.approvalType}-${approvalSessionOrdinal}`,
      url: `http://127.0.0.1/approval/${input.approvalType}`,
      async wait() {},
      async finalize(subject) {
        const grant = 'expectedPageIdentity' in subject
          ? await approvalAuthority.issueDiscoveryGrant({
              subject, approvalSessionRef: sessionRef, ttlMs: 10 * 60_000,
            })
          : await approvalAuthority.issueReadGrant({
              subject: ReadApprovalSubjectSchema.parse(subject),
              approvalSessionRef: sessionRef, ttlMs: 10 * 60_000,
            })
        return { grant, approvalBinding: executionBinding(grant.approvalContext) }
      },
      async finalizeDecision({ decisionId, decisionSubject }) {
        const kind = input.approvalType
        if (kind !== 'scope' && kind !== 'lineage') throw new Error('unexpected decision approval type')
        return approvalAuthority.issueDecisionReceipt({
          kind, decisionId, decisionStatus: 'approved', decisionSubject,
          approver: kind === 'scope'
            ? { subject: 'os-user:runtime-scope', roles: ['scope-approver'] }
            : { subject: 'os-user:runtime-lineage', roles: ['lineage-approver'] },
        })
      },
    }
  },
  async activateGrant(input) {
    const decision = await approvalAuthority.verify(input.grant)
    if (!decision.allowed) throw new Error(`grant activation denied:${decision.code ?? 'unknown'}`)
    const expectedBinding = executionBinding(input.grant.approvalContext)
    if (canonicalizeJson(input.approvalBinding) !== canonicalizeJson(expectedBinding)) {
      throw new Error('approval activation binding is not the strict execution projection')
    }
    activeApprovalContext = structuredClone(input.grant.approvalContext)
  },
  executionRpcConnection(approvalBinding) {
    if (!activeApprovalContext
      || canonicalizeJson(approvalBinding) !== canonicalizeJson(executionBinding(activeApprovalContext))) {
      throw new Error('approval binding changed before execution RPC')
    }
    rpcClientOrdinal += 1
    const credential = rpc.registerClient(
      `runtime-cross-repo-${rpcClientOrdinal}`, randomBytes(32), { approvalContext: activeApprovalContext },
    )
    return { endpoint: rpcHttp.endpoint, credential, verifierMaterial: rpc.verifierMaterial, approvalBinding }
  },
  async close() {},
}

try {
  const doctor = await invoke('DOCTOR-CROSS-REPO', 'doctor', {})
  if (doctor.ready !== true) throw new Error('installed Runtime doctor is not ready')
  const created = await invoke('CREATE-CROSS-REPO', 'create-run', {
    assetId: 'ASSET-ORDER-1', prdSource: { kind: 'file', path: 'inputs/prd.md' },
    projectPolicyPath: 'inputs/policy.json',
  })
  runId = requiredString(created, 'runId')
  const fixture = runtimeReadOnlyFixture({
    runId, assetId: requiredString(created, 'assetId'),
    prdRevision: requiredString(created, 'prdRevision'),
    installationDigest: installation.installationDigest, url: fixtureUrl, now: new Date(),
    evidencePolicyDigest: runtimeProductionSanitizerPolicyDigest(),
  })

  await submit(runId, 'SUBMIT-PRD', 'created', 'prd-request', fixture.semanticArtifacts['prd-request'])
  for (const artifactType of ['project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation']) {
    await submit(runId, `SUBMIT-${artifactType}`, 'source-frozen', artifactType,
      fixture.semanticArtifacts[artifactType])
  }
  await submit(runId, 'SUBMIT-SCOPE', 'source-frozen', 'acceptance-scope',
    fixture.semanticArtifacts['acceptance-scope'])
  await approve('APPROVE-LINEAGE', { runId, approvalType: 'lineage' })
  const scope = await approve('APPROVE-SCOPE', { runId, approvalType: 'scope' })
  for (const artifactType of ['interaction-flow', 'design-audit']) {
    await submit(runId, `SUBMIT-${artifactType}`, 'scope-approved', artifactType,
      fixture.semanticArtifacts[artifactType])
  }
  await submit(runId, 'SUBMIT-MODEL', 'scope-approved', 'requirement-model',
    fixture.semanticArtifacts['requirement-model'])
  await submit(runId, 'SUBMIT-COVERAGE', 'modeled', 'coverage-universe',
    fixture.semanticArtifacts['coverage-universe'])

  const discovery = await approve('APPROVE-DISCOVERY', {
    runId, approvalType: 'discovery', grantSubject: fixture.discoverySubject({
      scopeReceipt: scope.decisionReceipt,
    }),
  })
  const discoveryGrant = SignedGrantSchema.parse(discovery.signedGrant)
  const preflight = await invoke('RUN-PREFLIGHT', 'run-preflight', { runId })
  if (preflight.status !== 'ready') {
    throw new Error(`cross-repo preflight blocked:${safeCode(preflight.status)}:${safeCode(preflight.reasonCode)}`)
  }
  const preflightDigest = requiredString(preflight.preflightFact, 'preflightDigest')
  await submit(runId, 'SUBMIT-ACTION-MAP', 'preflight-readonly', 'browser-action-map',
    fixture.frozenArtifacts['browser-action-map'])
  await submit(runId, 'SUBMIT-TEST-CASES', 'binding-draft', 'test-cases',
    fixture.frozenArtifacts['test-cases'])
  await submit(runId, 'SUBMIT-EXECUTION-CONTRACT', 'binding-draft', 'execution-contract',
    fixture.frozenArtifacts['execution-contract'])
  await approve('APPROVE-EXECUTION', {
    runId, approvalType: 'execution',
    grantSubject: fixture.readSubject(discoveryGrant.grantId, preflightDigest, {
      scopeReceipt: scope.decisionReceipt,
    }),
  })
  await submit(runId, 'SUBMIT-REGRESSION', 'execution-approved', 'regression-manifest',
    fixture.regressionManifest)
  const executed = await invoke('EXECUTE-CROSS-REPO', 'execute-run', { runId })
  if (executed.status !== 'passed') throw new Error(
    `authoritative runtime result:${safeCode(executed.status)}:${safeCode(executed.result?.reasonCode)}`,
  )
  const finalized = await invoke('FINALIZE-CROSS-REPO', 'finalize-run', { runId })
  if (finalized.terminalVerdict !== 'accepted') {
    throw new Error(`final generation verdict:${finalized.terminalVerdict}`)
  }
  await invoke('REPORT-CROSS-REPO', 'render-report', { runId })
  const publishedRegression = await executePublishedRegression({
    authoritativeGatewayAuditDigest: executed.gatewayAuditDigest,
  })
  const reportPath = join(
    projectRoot, '.biztest', 'assets', 'ASSET-ORDER-1', 'generations', runId, 'run', 'final-report.json',
  )
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const fullPlaywright = await executeFullPlaywrightGolden({
    installation, fixtureUrl: new URL('/', fixtureUrl).href,
  })
  process.stdout.write(`${JSON.stringify({
    doctor,
    managedBrowserInstalled: await pathExists(join(
      homeDir, '.mutil-skills', 'runtime', 'e2e', 'browsers', installation.version,
    )),
    report,
    publishedRegression,
    fullPlaywright,
    tracePath: [
      'PRD-ORDER-1', 'REQ-ORDER-1', 'RULE-ORDER-1', 'COV-ORDER-1',
      'CASE-ORDER-1', 'ACTION-ORDER-1', 'EVIDENCE-ORDER-1', report.content.verdict,
    ],
    reportPath,
  })}\n`)
} finally {
  await Promise.allSettled([
    rpcHttp.close(),
    Promise.resolve().then(() => approvalAuthority.close()),
    new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve())),
  ])
}

async function executeFullPlaywrightGolden(input) {
  applicationState = 'clean'
  receivedApiBodies.length = 0
  resetObserved = false
  rootReadsAfterReset = 0
  const created = await invoke('CREATE-FULL-PLAYWRIGHT', 'create-run', {
    assetId: 'ASSET-FULL-1', prdSource: { kind: 'file', path: 'inputs/prd.md' },
    projectPolicyPath: 'inputs/policy.json',
  })
  runId = requiredString(created, 'runId')
  const fixture = runtimeFullPlaywrightFixture({
    runId, assetId: requiredString(created, 'assetId'), prdRevision: requiredString(created, 'prdRevision'),
    installationDigest: input.installation.installationDigest, url: input.fixtureUrl, now: new Date(),
    evidencePolicyDigest: runtimeProductionSanitizerPolicyDigest(),
  })
  await submit(runId, 'SUBMIT-FULL-PRD', 'created', 'prd-request', fixture.semanticArtifacts['prd-request'])
  for (const artifactType of ['project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation']) {
    await submit(runId, `SUBMIT-FULL-${artifactType}`, 'source-frozen', artifactType,
      fixture.semanticArtifacts[artifactType])
  }
  await submit(runId, 'SUBMIT-FULL-SCOPE', 'source-frozen', 'acceptance-scope',
    fixture.semanticArtifacts['acceptance-scope'])
  await approve('APPROVE-FULL-LINEAGE', { runId, approvalType: 'lineage' })
  const scope = await approve('APPROVE-FULL-SCOPE', { runId, approvalType: 'scope' })
  for (const artifactType of ['interaction-flow', 'design-audit']) {
    await submit(runId, `SUBMIT-FULL-${artifactType}`, 'scope-approved', artifactType,
      fixture.semanticArtifacts[artifactType])
  }
  await submit(runId, 'SUBMIT-FULL-MODEL', 'scope-approved', 'requirement-model',
    fixture.semanticArtifacts['requirement-model'])
  await submit(runId, 'SUBMIT-FULL-COVERAGE', 'modeled', 'coverage-universe',
    fixture.semanticArtifacts['coverage-universe'])
  const discovery = await approve('APPROVE-FULL-DISCOVERY', {
    runId, approvalType: 'discovery',
    grantSubject: fixture.discoverySubject({ scopeReceipt: scope.decisionReceipt }),
  })
  const discoveryGrant = SignedGrantSchema.parse(discovery.signedGrant)
  const preflight = await invoke('RUN-FULL-PREFLIGHT', 'run-preflight', { runId })
  if (preflight.status !== 'ready') throw new Error(`full preflight:${safeCode(preflight.reasonCode)}`)
  const preflightDigest = requiredString(preflight.preflightFact, 'preflightDigest')
  await submit(runId, 'SUBMIT-FULL-ACTION-MAP', 'preflight-readonly', 'browser-action-map',
    fixture.frozenArtifacts['browser-action-map'])
  await submit(runId, 'SUBMIT-FULL-TEST-CASES', 'binding-draft', 'test-cases',
    fixture.frozenArtifacts['test-cases'])
  await submit(runId, 'SUBMIT-FULL-EXECUTION-CONTRACT', 'binding-draft', 'execution-contract',
    fixture.frozenArtifacts['execution-contract'])
  const approval = await approve('APPROVE-FULL-EXECUTION', {
    runId, approvalType: 'execution',
    grantSubject: fixture.writeSubject(discoveryGrant.grantId, preflightDigest,
      { scopeReceipt: scope.decisionReceipt }),
  })
  const review = approval.semanticReview
  if (!review || review.prd?.normalizedText !== await readFile(join(projectRoot, 'inputs', 'prd.md'), 'utf8')
    || review.requirements?.[0]?.rules?.[0]?.oracles?.[0]?.oracleId !== 'ORACLE-1'
    || review.requirements[0].rules[0].oracleMapping !== 'explicit') {
    throw new Error('E2E_RUNTIME_PRD_SEMANTIC_CONFIRMATION_INCOMPLETE')
  }
  await submit(runId, 'SUBMIT-FULL-REGRESSION', 'execution-approved', 'regression-manifest',
    fixture.regressionManifest)
  const executed = await invoke('EXECUTE-FULL-PLAYWRIGHT', 'execute-run', { runId })
  const executionResult = requiredRecord(executed, 'result')
  const executionCleanup = requiredRecord(executionResult, 'cleanup')
  if (executed.status !== 'passed' || executionCleanup.status !== 'verified-clean') {
    throw new Error(`full execution:${safeCode(executed.status)}:${safeCode(executionCleanup.status)}`)
  }
  if (applicationState !== fixture.expected.cleanupState
    || !receivedApiBodies.includes(fixture.expected.jsonBody)
    || rootReadsAfterReset < 2) {
    throw new Error('E2E_RUNTIME_FULL_PLAYWRIGHT_EXTERNAL_ASSERTION_FAILED')
  }
  const finalized = await invoke('FINALIZE-FULL-PLAYWRIGHT', 'finalize-run', { runId })
  if (finalized.terminalVerdict !== 'accepted') {
    throw new Error(`full finalization:${safeCode(finalized.terminalVerdict)}`)
  }
  await invoke('REPORT-FULL-PLAYWRIGHT', 'render-report', { runId })
  const reportPath = join(projectRoot, '.biztest', 'assets', 'ASSET-FULL-1',
    'generations', runId, 'run', 'final-report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  return {
    runId, executionProfile: 'full-playwright', status: executed.status,
    cleanupStatus: executionCleanup.status,
    reloadVerified: applicationState === 'clean' && rootReadsAfterReset >= 2,
    jsonBodyVerified: receivedApiBodies.includes(fixture.expected.jsonBody),
    semanticReview: review, report, reportPath,
  }
}

async function executePublishedRegression(input) {
  const activeRoot = join(
    projectRoot, '.biztest', 'assets', 'ASSET-ORDER-1', 'generations', runId,
  )
  const manifestDocument = parseArtifactDocument(JSON.parse(
    await readFile(join(activeRoot, 'run', 'regression-manifest.json'), 'utf8'),
  ))
  const expectedManifestDigest = digestArtifactContent(
    `artifact-content/${manifestDocument.schemaVersion}/${manifestDocument.artifactType}`,
    manifestDocument,
  )
  if (manifestDocument.artifactType !== 'regression-manifest'
    || manifestDocument.assetId !== 'ASSET-ORDER-1'
    || manifestDocument.generationId !== runId
    || manifestDocument.contentDigest !== expectedManifestDigest
    || manifestDocument.signatures.length !== 0) {
    throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_MANIFEST_UNTRUSTED')
  }
  const attestation = RegressionDiscoveryAttestationSchema.parse(manifestDocument.content?.listResult?.attestation)
  const verifierMaterial = RegressionDiscoveryVerifierMaterialSchema.parse(
    manifestDocument.content?.discoveryVerifierMaterial,
  )
  if (attestation.issuer !== verifierMaterial.issuer || attestation.keyId !== verifierMaterial.keyId) {
    throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_VERIFIER_UNBOUND')
  }
  const { issuer: _issuer, keyId: _keyId, purpose: _purpose, algorithm: _algorithm,
    signedDigest: _signedDigest, signature: _signature, ...subject } = attestation

  const sourceParent = join(homeDir, '.mutil-skills', 'e2e', 'state', runId, 'published-regression')
  await mkdir(sourceParent, { recursive: true, mode: 0o700 })
  const projectDir = await mkdtemp(join(sourceParent, 'project-'))
  await cp(join(activeRoot, 'regression'), projectDir, {
    recursive: true, dereference: false, preserveTimestamps: true,
  })

  let store
  let gateway
  let browser
  let readBridge
  let trustedSession
  let readAuthority
  let artifactAuthority
  let operationError
  try {
    store = await RuntimeRunStore.open({ homeDir, projectRoot })
    const identity = await resolveProjectIdentity(projectRoot)
    const snapshot = await store.getRun(identity.digest, runId)
    if (!snapshot) throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_RUN_MISSING')
    artifactAuthority = await openRuntimeArtifactStoreAuthority({
      homeDir,
      installation,
      subject: `local:uid:${process.getuid()}`,
    })
    const originalExecutionGrant = SignedGrantSchema.parse(
      snapshot.trustedExecutionFacts['signed-execution-grant'],
    )
    const originalDiscoveryGrant = SignedGrantSchema.parse(
      snapshot.trustedExecutionFacts['signed-discovery-grant'],
    )
    const browserInstallation = await resolveRuntimeBrowserInstallation({ homeDir, projectRoot, installation })
    const freshPreflight = await preparePublishedRegressionPreflight({
      subject: originalDiscoveryGrant.subject,
      browserInstallation,
    })
    const approvalSession = await authorityAdapter.requestApproval({ approvalType: 'execution' })
    await approvalSession.wait()
    const freshApproval = await approvalSession.finalize(ReadApprovalSubjectSchema.parse({
      ...originalExecutionGrant.subject,
      discoveryGrantId: freshPreflight.grant.grantId,
      preflightDigest: freshPreflight.fact.preflightDigest,
    }))
    const freshGrant = SignedGrantSchema.parse(freshApproval.grant)
    if (freshGrant.grantId === originalExecutionGrant.grantId) {
      throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_FRESH_GRANT_REQUIRED')
    }
    const freshSnapshot = structuredClone(snapshot)
    freshSnapshot.trustedExecutionFacts['signed-execution-grant'] = freshGrant
    freshSnapshot.trustedExecutionFacts['signed-discovery-grant'] = freshPreflight.grant
    freshSnapshot.trustedExecutionFacts['browser-preflight'] = freshPreflight.fact
    const action = new TrustedReadActionProjector().project({
      runId, actionId: 'ACTION-ORDER-1', frozenArtifacts: freshSnapshot.frozenArtifacts,
      trustedExecutionFacts: freshSnapshot.trustedExecutionFacts,
      grant: freshGrant, currentSubject: freshGrant.subject,
      runtimeInstallationDigest: installation.installationDigest,
    })

    const freshApprovalBinding = executionBinding(freshGrant.approvalContext)
    await authorityAdapter.activateGrant({ grant: freshGrant, approvalBinding: freshApprovalBinding })
    const connection = authorityAdapter.executionRpcConnection(freshApprovalBinding)
    readAuthority = createAuthorityReadRpcClient({
      credential: connection.credential,
      verifierMaterial: connection.verifierMaterial,
      expectedPublicKeyDigest: connection.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(connection.endpoint),
      approvalBinding: connection.approvalBinding,
    })
    let gatewayVerifierMaterial
    gateway = await startGatewayProxyHostForRuntime({
      runId, mode: 'real-environment', authorityRoot: runtimeLayout(homeDir).authority,
      approvedRequests: action.requestCorrelations.map((correlation) => ({
        actionId: correlation.actionId, capabilityId: correlation.capabilityId,
        requestId: correlation.requestId, method: correlation.method, url: correlation.url,
        maxUses: correlation.maxUses, signedBodyDigest: correlation.signedBodyDigest,
        headers: Object.entries(correlation.headers).map(([name, value]) => ({ name, value })),
        redirectRequestIds: [...correlation.redirectRequestIds],
        behavior: { kind: 'pass-through' },
      })),
      policyObjects: { factory: ({ signer }) => {
        gatewayVerifierMaterial = signer.exportVerifierMaterial()
        return {}
      } },
    })
    browser = await new ControlledBrowserHost().open({
      homeDir, runId, installation: browserInstallation, gateway,
    })
    const browserExecutablePath = 'manifest' in browserInstallation
      ? browserInstallation.executablePath
      : browserInstallation.selection.source.executablePath
    const trust = await createTrustedCompilerExecutionTrust({
      discoveryAuthority: {
        material: verifierMaterial, expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
      },
      approvalFreshnessClient: artifactAuthority.createTrustedApprovalFreshnessClient(),
      browserExecutablePath,
      gatewayProxyEndpoint: gateway.handle.endpoint,
    })
    trustedSession = await prepareTrustedCompilerRun({
      projectDir, subject, attestation, trust,
      expected: {
        assetId: attestation.assetId, generationId: attestation.generationId,
        prdRevision: attestation.prdRevision, runId,
        approvalDigest: attestation.approvalDigest, executionProfile: 'trusted-read-only',
      },
      authorityTransport: 'authenticated-rpc',
      authorityRpcPublicKeyDigest: connection.verifierMaterial.publicKeyDigest,
    })
    const page = new PlaywrightPageAdapter(browser.page)
    const browserBinding = getControlledBrowserSessionBinding(browser)
    const regressionAction = {
      actionId: action.actionId, target: '订单列表', expected: action.expectedText,
    }
    const readLauncher = createTrustedCompilerControlledReadLauncher([{
      action: regressionAction,
      runnerInput: {
        caseId: action.caseId, actionId: action.actionId, url: action.url,
        expectedIdentity: action.expectedIdentity, expectedText: action.expectedText,
        authorization: { grant: freshGrant, currentSubject: freshGrant.subject, authority: readAuthority },
        attemptId: 'ATTEMPT-PUBLISHED-REGRESSION-1',
        runtime: { sandboxHealthy: true, gatewayConnected: true },
        gatewayAudit: () => gateway.handle.auditSummary(),
        page: {
          goto: async (url) => await browserBinding.executeWithCorrelations(
            action.requestCorrelations,
            async () => await page.goto(url),
          ),
          identity: async () => await page.identity(),
          containsText: async (text) => await page.containsText(text),
          screenshot: async () => await page.screenshot(),
          domSnapshot: async () => await page.domSnapshot(),
        },
      },
    }], trustedSession)
    readBridge = await startTrustedCompilerControlledReadBridge({
      session: trustedSession, actions: [regressionAction], launch: readLauncher,
    })
    const execution = await executeTrustedCompilerProject({
      session: trustedSession, readBridge, timeoutMs: 30_000,
    })
    trustedSession = undefined
    const bridgeSnapshot = readBridge.snapshot()
    if (execution.exitCode !== 0 || !bridgeSnapshot.complete) {
      throw new Error(
        `E2E_RUNTIME_PUBLISHED_REGRESSION_COMPILER_FAILED:${compilerExecutionDiagnostic(execution)}`,
      )
    }
    const executions = readBridge.executions()
    if (execution.exitCode !== 0 || executions.length !== 1 || executions[0].result.status !== 'passed') {
      throw new Error(`E2E_RUNTIME_PUBLISHED_REGRESSION_FAILED:${execution.exitCode}`)
    }
    const publication = await gateway.handle.finalize()
    if (!gatewayVerifierMaterial || !verifyGatewayPublicationAudit(
      publication, LocalGatewayAuditVerifier.create(gatewayVerifierMaterial),
    )) {
      throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_GATEWAY_AUDIT_INVALID')
    }
    const gatewayAuditDigest = digestText('gateway-publication-audit/v1', canonicalizeJson(publication))
    if (gatewayAuditDigest === input.authoritativeGatewayAuditDigest) {
      throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_GATEWAY_AUDIT_REUSED')
    }
    return { exitCode: 0, gatewayAuditDigest }
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const cleanupErrors = []
    for (const cleanup of [
      async () => await readBridge?.close(),
      async () => { if (trustedSession) await discardTrustedCompilerRun(trustedSession) },
      async () => await browser?.close(),
      async () => await gateway?.handle.close(),
      async () => { readAuthority?.destroy() },
      async () => await artifactAuthority?.close(),
      async () => await store?.close(),
      async () => await rm(projectDir, { recursive: true, force: true }),
    ]) {
      try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (operationError === undefined && cleanupErrors.length === 1) throw cleanupErrors[0]
    if (operationError === undefined && cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'E2E_RUNTIME_PUBLISHED_REGRESSION_CLEANUP_FAILED')
    }
  }
}

async function preparePublishedRegressionPreflight(input) {
  const approvalSession = await authorityAdapter.requestApproval({ approvalType: 'discovery' })
  await approvalSession.wait()
  const approval = await approvalSession.finalize(input.subject)
  const grant = SignedGrantSchema.parse(approval.grant)
  const capability = grant.capabilities.find((candidate) => candidate.operation === 'local-navigation')
  if (!capability) throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_DISCOVERY_CAPABILITY_MISSING')
  const approvedRequests = [{
    actionId: capability.actionId,
    capabilityId: capability.capabilityId,
    method: 'GET',
    url: grant.subject.expectedPageIdentity.url,
    maxUses: capability.maxUses,
    behavior: { kind: 'pass-through' },
  }]
  let gateway
  let browser
  let operationError
  try {
    gateway = await startGatewayProxyHostForRuntime({
      runId,
      mode: 'real-environment',
      authorityRoot: runtimeLayout(homeDir).authority,
      approvedRequests,
    })
    browser = await new ControlledBrowserHost().open({
      homeDir,
      runId,
      installation: input.browserInstallation,
      gateway,
    })
    const rule = projectGatewayRules({ runId, approvedRequests }).rules[0]
    if (!rule) throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_PREFLIGHT_RULE_MISSING')
    const page = new PlaywrightPageAdapter(browser.page)
    const binding = getControlledBrowserSessionBinding(browser)
    const outcome = await runBrowserPreflight({
      authorization: {
        grant,
        currentSubject: grant.subject,
        authority: approvalAuthority,
      },
      runtime: { sandboxHealthy: true, gatewayConnected: true },
      gatewayAudit: () => gateway.handle.auditSummary(),
      page: {
        goto: async (url) => await binding.executeWithCorrelation({
          ruleId: rule.ruleId,
          stepOrdinal: rule.stepOrdinal,
          method: rule.method,
          url: rule.url,
          channel: 'http',
          bodyDigest: rule.bodyDigest,
          actionId: rule.actionId,
          capabilityId: rule.capabilityId,
          headers: {},
        }, async () => await page.goto(url)),
        identity: async () => await page.identity(),
        containsText: async (text) => await page.containsText(text),
        screenshot: async () => await page.screenshot(),
        domSnapshot: async () => await page.domSnapshot(),
      },
      actionId: capability.actionId,
      attemptId: 'ATTEMPT-PUBLISHED-REGRESSION-PREFLIGHT-1',
    })
    if (outcome.status !== 'ready' || !outcome.preflightDigest
      || !outcome.reservationId || !outcome.observedIdentity) {
      throw new Error(`E2E_RUNTIME_PUBLISHED_REGRESSION_PREFLIGHT_FAILED:${safeCode(outcome.reasonCode)}`)
    }
    const publication = await gateway.handle.finalize()
    const gatewayAuditDigest = digestText('gateway-publication-audit/v1', canonicalizeJson(publication))
    const authorityOutcomeDigest = digestText('authority-preflight-outcome/v1', canonicalizeJson({
      status: outcome.status,
      observedIdentity: outcome.observedIdentity,
      preflightDigest: outcome.preflightDigest,
    }))
    const fact = BrowserPreflightFactSchema.parse({
      runId,
      discoveryGrantId: grant.grantId,
      reservationId: outcome.reservationId,
      preflightDigest: outcome.preflightDigest,
      status: 'ready',
      observedIdentityDigest: digestText(
        'observed-page-identity/v1', canonicalizeJson(outcome.observedIdentity),
      ),
      browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
      browserClosureDigest: browser.measurement.browserClosureDigest,
      browserExecutableDigest: browser.measurement.browserExecutableDigest,
      gatewaySessionMeasurementDigest: browser.measurement.gatewaySessionMeasurementDigest,
      gatewayPolicyDigest: gateway.handle.measurement.policyDigest,
      gatewayAuditDigest,
      canaryProofDigest: browser.measurement.canaryProofDigest,
      authorityOutcomeDigest,
      authorityReceiptDigest: digestText('authority-preflight-receipt/v1', canonicalizeJson({
        reservationId: outcome.reservationId,
        preflightDigest: outcome.preflightDigest,
        authorityOutcomeDigest,
      })),
    })
    return { grant, fact }
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const cleanupErrors = []
    for (const cleanup of [
      async () => await browser?.close(),
      async () => await gateway?.handle.close(),
    ]) {
      try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (operationError === undefined && cleanupErrors.length === 1) throw cleanupErrors[0]
    if (operationError === undefined && cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'E2E_RUNTIME_PUBLISHED_REGRESSION_PREFLIGHT_CLEANUP_FAILED')
    }
  }
}

async function submit(run, requestId, expectedState, artifactType, candidate) {
  return await invoke(requestId, 'submit-candidate', {
    runId: run, expectedState, artifactType, candidate,
  })
}

async function approve(requestId, payload) {
  const opened = await invoke(requestId, 'open-approval', payload)
  if (opened.status !== 'confirmation-required') return opened
  const confirmed = await invoke(`${requestId}-CONFIRM`, 'confirm-approval', {
    runId: payload.runId,
    confirmationId: requiredString(opened, 'confirmationId'),
    subjectDigest: requiredString(opened, 'subjectDigest'),
  })
  return {
    ...confirmed,
    ...(opened.summary?.semanticReview === undefined
      ? {} : { semanticReview: opened.summary.semanticReview }),
  }
}

async function invoke(requestId, command, payload) {
  const request = RuntimeRequestEnvelopeSchema.parse({
    schemaVersion: '1.0.0', requestId,
    client: { name: 'runtime-cross-repo', version: '1.0.0' },
    command, ...(command === 'doctor' ? {} : { projectRoot }), payload,
  })
  const { exitCode, stdout, stderr } = await invokeFixedLauncher(canonicalizeJson(request))
  const output = stdout.trim()
  const lines = output.split('\n')
  if (lines.length !== 1) throw new Error(`Runtime RPC wrote ${lines.length} lines:${stderr}`)
  const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(output))
  if (exitCode !== 0 || !response.ok || !response.result || typeof response.result !== 'object') {
    throw new Error(`Runtime RPC failed:${stderr}:${output}`)
  }
  return response.result
}

async function invokeFixedLauncher(requestJson) {
  const launcher = join(homeDir, '.mutil-skills', 'bin', 'repo-e2e')
  const child = spawn(launcher, ['rpc'], {
    cwd: projectRoot,
    env: {
      HOME: homeDir,
      PATH: '/usr/bin:/bin',
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    process.stderr.write(chunk)
  })
  child.stdin.end(requestJson)
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('E2E_RUNTIME_LAUNCHER_RPC_TIMEOUT'))
    }, 180_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal !== null) reject(new Error(`E2E_RUNTIME_LAUNCHER_SIGNAL:${signal}`))
      else resolve(code ?? 70)
    })
  })
  return { exitCode, stdout, stderr }
}

function requiredString(record, key) {
  const value = record?.[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${key}`)
  return value
}

function requiredRecord(record, key) {
  const value = record?.[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`missing ${key}`)
  return value
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'unknown'
}

function compilerExecutionDiagnostic(execution) {
  const messages = []
  if (execution.stderr) messages.push(execution.stderr)
  try { visit(JSON.parse(execution.stdout)) } catch {}
  const summary = messages
    .filter((value) => /(?:BIZTEST|E2E)_[A-Z0-9_]+/.test(value))
    .join(' | ')
    .replace(/[^A-Za-z0-9_:. -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 1024)
  return `${execution.exitCode}:${summary || 'CONTROLLED_READ_INCOMPLETE'}`

  function visit(value) {
    if (typeof value === 'string') { messages.push(value); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item)
    }
  }
}

function executionBinding(context) {
  return {
    runId: context.runId,
    installationDigest: context.installationDigest,
    approvalType: context.approvalType,
    subjectDigest: context.subjectDigest,
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing environment:${name}`)
  return value
}

async function pathExists(path) {
  try { await access(path); return true } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
