import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { runtimeReadOnlyFixture } from './fixture.js'

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
  startTrustedCompilerControlledReadBridge,
}] = await Promise.all([
  installedPackage('e2e-gateway'),
  installedPackage('e2e-playwright-runtime'),
])
const [{ runCli }, { inspectRuntimeInstallation }, { runRuntimeDoctor },
  { runtimeProductionSanitizerPolicyDigest }, { inspectChromiumInstallation },
  { ControlledBrowserHost, getControlledBrowserSessionBinding },
  { startGatewayProxyHostForRuntime }, { runtimeLayout }, { RuntimeRunStore },
  { resolveProjectIdentity }, { TrustedReadActionProjector }] = await Promise.all([
  runtimeModule('cli'), runtimeModule('runtime-discovery'), runtimeModule('runtime-doctor'),
  runtimeModule('runtime-finalization-material-sealer'),
  runtimeModule('browser-installer'), runtimeModule('browser-host'),
  runtimeModule('gateway-proxy-host'), runtimeModule('runtime-layout'), runtimeModule('run-store'),
  runtimeModule('project-identity'), runtimeModule('trusted-action-runner'),
])

await Promise.all([
  mkdir(join(projectRoot, '.biztest'), { recursive: true, mode: 0o700 }),
  mkdir(join(projectRoot, 'inputs'), { recursive: true, mode: 0o700 }),
])
await Promise.all([
  writeFile(join(projectRoot, '.biztest', 'project.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', projectId: 'RUNTIME-CROSS-REPO-GOLDEN',
  })}\n`, { mode: 0o600 }),
  writeFile(join(projectRoot, 'inputs', 'prd.md'), '# 订单验收\n\n审计员应能看到待审核订单。\n', { mode: 0o600 }),
  writeFile(join(projectRoot, 'inputs', 'policy.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', environment: 'test', browser: 'chromium',
  })}\n`, { mode: 0o600 }),
])

const installation = await inspectRuntimeInstallation({ homeDir })
const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html data-e2e-role="auditor"><head><title>订单</title></head><body><main><h1>订单列表</h1>页面显示待审核订单</main></body></html>')
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
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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
        return { grant, approvalBinding: structuredClone(grant.approvalContext) }
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
    activeApprovalContext = structuredClone(input.grant.approvalContext)
  },
  executionRpcConnection(approvalBinding) {
    if (canonicalizeJson(approvalBinding) !== canonicalizeJson(activeApprovalContext)) {
      throw new Error('approval binding changed before execution RPC')
    }
    rpcClientOrdinal += 1
    const credential = rpc.registerClient(
      `runtime-cross-repo-${rpcClientOrdinal}`, randomBytes(32), { approvalContext: approvalBinding },
    )
    return { endpoint: rpcHttp.endpoint, credential, verifierMaterial: rpc.verifierMaterial, approvalBinding }
  },
  async close() {},
}

const artifactAuthority = {
  credentialCount: 1,
  stateProtectionLevel: 'local-crash-integrity',
  artifactVerifierMaterial: approvalAuthority.artifactVerifierMaterial,
  approvalFreshnessVerifierMaterial: approvalAuthority.approvalFreshnessVerifierMaterial,
  decisionVerifierMaterial: approvalAuthority.decisionVerifierMaterial,
  privacyReviewVerifierMaterial: approvalAuthority.privacyReviewVerifierMaterial,
  attemptEventVerifierMaterial: approvalAuthority.attemptEventVerifierMaterial,
  signDigest: (digest) => approvalAuthority.signArtifactDigest(digest),
  verifySignature: (signature) => approvalAuthority.verifyArtifactSignature(signature),
  signArtifactDigest: (digest) => approvalAuthority.signArtifactDigest(digest),
  verifyArtifactSignature: (signature, digest) => approvalAuthority.verifyArtifactSignature(signature, digest),
  verifyApprovalFreshnessReceipt: (receipt, binding) =>
    approvalAuthority.verifyApprovalFreshnessReceipt({ receipt, ...binding }),
  verifyDecisionReceipt: (receipt, binding) => approvalAuthority.verifyDecisionReceipt(receipt, binding),
  verifyPrivacyReviewReceipt: (receipt, binding) => approvalAuthority.verifyPrivacyReviewReceipt(receipt, binding),
  issueApprovalFreshnessReceipt: (input) => approvalAuthority.issueApprovalFreshnessReceipt(input),
  appendAttemptEvent: (input) => approvalAuthority.appendAttemptEvent(input),
  async close() {},
}

const dependencies = {
  homeDir,
  installRuntime: async () => { throw new Error('unused installRuntime') },
  uninstallRuntime: async () => { throw new Error('unused uninstallRuntime') },
  inspectRuntimeInstallation: async () => installation,
  runRuntimeDoctor: async () => {
    const report = await runRuntimeDoctor({ installation, homeDir })
    return { ...report, ready: ['gateway', 'chromium', 'isolation'].every(
      (probe) => report.probes[probe]?.status === 'passed',
    ) }
  },
  startAuthorityHost: async () => authorityAdapter,
  openArtifactStoreAuthority: async () => artifactAuthority,
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
  await invoke('APPROVE-LINEAGE', 'open-approval', { runId, approvalType: 'lineage' })
  const scope = await invoke('APPROVE-SCOPE', 'open-approval', { runId, approvalType: 'scope' })
  for (const artifactType of ['interaction-flow', 'design-audit']) {
    await submit(runId, `SUBMIT-${artifactType}`, 'scope-approved', artifactType,
      fixture.semanticArtifacts[artifactType])
  }
  await submit(runId, 'SUBMIT-MODEL', 'scope-approved', 'requirement-model',
    fixture.semanticArtifacts['requirement-model'])
  await submit(runId, 'SUBMIT-COVERAGE', 'modeled', 'coverage-universe',
    fixture.semanticArtifacts['coverage-universe'])

  const discovery = await invoke('APPROVE-DISCOVERY', 'open-approval', {
    runId, approvalType: 'discovery', grantSubject: fixture.discoverySubject,
  })
  const discoveryGrant = SignedGrantSchema.parse(discovery.signedGrant)
  const preflight = await invoke('RUN-PREFLIGHT', 'run-preflight', { runId })
  const preflightDigest = requiredString(preflight.preflightFact, 'preflightDigest')
  await submit(runId, 'SUBMIT-ACTION-MAP', 'preflight-readonly', 'browser-action-map',
    fixture.frozenArtifacts['browser-action-map'])
  await submit(runId, 'SUBMIT-TEST-CASES', 'binding-draft', 'test-cases',
    fixture.frozenArtifacts['test-cases'])
  await submit(runId, 'SUBMIT-EXECUTION-CONTRACT', 'binding-draft', 'execution-contract',
    fixture.frozenArtifacts['execution-contract'])
  await invoke('APPROVE-EXECUTION', 'open-approval', {
    runId, approvalType: 'execution',
    grantSubject: fixture.readSubject(discoveryGrant.grantId, preflightDigest, {
      scopeReceipt: scope.decisionReceipt,
    }),
  })
  await submit(runId, 'SUBMIT-REGRESSION', 'execution-approved', 'regression-manifest',
    fixture.regressionManifest)
  const executed = await invoke('EXECUTE-CROSS-REPO', 'execute-run', { runId })
  if (executed.status !== 'passed') throw new Error(`authoritative runtime result:${executed.status}`)
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
  process.stdout.write(`${JSON.stringify({
    doctor,
    report,
    publishedRegression,
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
    || manifestDocument.signatures.length === 0
    || manifestDocument.signatures.some((signature) =>
      signature.signedDigest !== expectedManifestDigest
      || !artifactAuthority.verifyArtifactSignature(signature, expectedManifestDigest))) {
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
  let operationError
  try {
    store = await RuntimeRunStore.open({ homeDir, projectRoot })
    const identity = await resolveProjectIdentity(projectRoot)
    const snapshot = await store.getRun(identity.digest, runId)
    if (!snapshot) throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_RUN_MISSING')
    const originalExecutionGrant = SignedGrantSchema.parse(
      snapshot.trustedExecutionFacts['signed-execution-grant'],
    )
    const approvalSession = await authorityAdapter.requestApproval({ approvalType: 'execution' })
    await approvalSession.wait()
    const freshApproval = await approvalSession.finalize(originalExecutionGrant.subject)
    const freshGrant = SignedGrantSchema.parse(freshApproval.grant)
    if (freshGrant.grantId === originalExecutionGrant.grantId) {
      throw new Error('E2E_RUNTIME_PUBLISHED_REGRESSION_FRESH_GRANT_REQUIRED')
    }
    const freshSnapshot = structuredClone(snapshot)
    freshSnapshot.trustedExecutionFacts['signed-execution-grant'] = freshGrant
    const action = new TrustedReadActionProjector().project({
      runId, actionId: 'ACTION-ORDER-1', frozenArtifacts: freshSnapshot.frozenArtifacts,
      trustedExecutionFacts: freshSnapshot.trustedExecutionFacts,
      grant: freshGrant, currentSubject: freshGrant.subject,
      runtimeInstallationDigest: installation.installationDigest,
    })

    await authorityAdapter.activateGrant({ grant: freshGrant, approvalBinding: freshGrant.approvalContext })
    const connection = authorityAdapter.executionRpcConnection(freshGrant.approvalContext)
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
    const browserInstallation = await inspectChromiumInstallation({
      homeDir, runtimeVersion: installation.version,
      runtimeInstallationDigest: installation.installationDigest,
    })
    browser = await new ControlledBrowserHost().open({
      homeDir, runId, installation: browserInstallation, gateway,
    })
    const trust = await createTrustedCompilerExecutionTrust({
      discoveryAuthority: {
        material: verifierMaterial, expectedPublicKeyDigest: verifierMaterial.publicKeyDigest,
      },
      approvalFreshnessClient: approvalAuthority.createTrustedApprovalFreshnessClient(),
      browserExecutablePath: browserInstallation.executablePath,
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

async function submit(run, requestId, expectedState, artifactType, candidate) {
  return await invoke(requestId, 'submit-candidate', {
    runId: run, expectedState, artifactType, candidate,
  })
}

async function invoke(requestId, command, payload) {
  const request = RuntimeRequestEnvelopeSchema.parse({
    schemaVersion: '1.0.0', requestId,
    client: { name: 'runtime-cross-repo', version: '1.0.0' },
    command, projectRoot, payload,
  })
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  const exitCode = await runCli(['rpc'], Readable.from([canonicalizeJson(request)]), stdout, stderr, dependencies)
  const output = stdout.text().trim()
  const lines = output.split('\n')
  if (lines.length !== 1) throw new Error(`Runtime RPC wrote ${lines.length} lines:${stderr.text()}`)
  const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(output))
  if (exitCode !== 0 || !response.ok || !response.result || typeof response.result !== 'object') {
    throw new Error(`Runtime RPC failed:${stderr.text()}:${output}`)
  }
  return response.result
}

function requiredString(record, key) {
  const value = record?.[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${key}`)
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing environment:${name}`)
  return value
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

class CaptureStream extends Writable {
  #chunks = []
  _write(chunk, encoding, callback) {
    this.#chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk))
    callback()
  }
  text() { return Buffer.concat(this.#chunks).toString('utf8') }
}
