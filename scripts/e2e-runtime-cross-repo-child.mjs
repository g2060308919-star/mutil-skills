import {
  AuthenticatedRpcServer,
  LocalApprovalAuthority,
  registerAuthorityExecutionRpcOperations,
  startAuthenticatedRpcLoopbackServer,
} from '@mutil-skills/e2e-authority'
import {
  ReadApprovalSubjectSchema,
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  SignedGrantSchema,
  canonicalizeJson,
} from '@mutil-skills/e2e-contracts'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { runtimeReadOnlyFixture } from './fixture.js'

const homeDir = requiredEnvironment('HOME')
const projectRoot = requiredEnvironment('E2E_PACKED_PROJECT')
const runtimePackageRoot = requiredEnvironment('E2E_PACKED_RUNTIME_PACKAGE_ROOT')
const runtimeModule = async (name) => await import(pathToFileURL(
  join(runtimePackageRoot, 'dist', 'src', `${name}.js`),
).href)

const [{ runCli }, { inspectRuntimeInstallation }, { runRuntimeDoctor },
  { runtimeLayout }, { runtimeProductionSanitizerPolicyDigest }] = await Promise.all([
  runtimeModule('cli'), runtimeModule('runtime-discovery'), runtimeModule('runtime-doctor'),
  runtimeModule('runtime-layout'), runtimeModule('runtime-finalization-material-sealer'),
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
const authorityAdapter = {
  async requestApproval(input) {
    return {
      sessionId: `SESSION-${input.approvalType}`,
      url: `http://127.0.0.1/approval/${input.approvalType}`,
      async wait() {},
      async finalize(subject) {
        const grant = 'expectedPageIdentity' in subject
          ? await approvalAuthority.issueDiscoveryGrant({
              subject, approvalSessionRef: `cross-repo:${input.approvalType}`, ttlMs: 10 * 60_000,
            })
          : await approvalAuthority.issueReadGrant({
              subject: ReadApprovalSubjectSchema.parse(subject),
              approvalSessionRef: `cross-repo:${input.approvalType}`, ttlMs: 10 * 60_000,
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
  const reportPath = join(
    projectRoot, '.biztest', 'assets', 'ASSET-ORDER-1', 'generations', runId, 'run', 'final-report.json',
  )
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  process.stdout.write(`${JSON.stringify({
    doctor,
    report,
    publishedRegression: { exitCode: 0, gatewayAuditDigest: executed.gatewayAuditDigest },
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
