import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { LocalGatewayAuditSigner, LocalGatewayAuditVerifier, verifyGatewayPublicationAudit,
  type TrustedGatewayPublicationAuditRecorder } from '@mutil-skills/e2e-gateway'
import {
  canonicalizeJson,
  deriveExecutionResultId,
  digestBytes,
  digestPrdUnderstandingProjection,
  digestPrdUnderstandingQuote,
  digestText,
  type ArtifactSignature,
  type DeclarativePrdRunDesign,
  type PrdUnderstandingProjection,
  type AttemptEvent,
  type RequirementModel,
  type VerdictInput,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import { LocalArtifactStore, buildCoverageUniverse, computeVerdict, selectFinalAttempt,
  type ArtifactStoreAuthority } from '@mutil-skills/e2e-engine'
import { createB2BCoverageProof, digestPublishedB2BExecutions, digestPublishedB2BVerdicts,
  verifyB2BRuntimeChainFactsV1,
  type B2BScenarioExecution } from '../packages/e2e-runtime/src/b2b-scenario-coverage.js'
import { compilePrdRun } from '../packages/e2e-runtime/src/prd-run-compiler.js'
import { completeCase, createCaseSchedule, startNextCase } from '../packages/e2e-runtime/src/multi-case-scheduler.js'
import { adaptB2BProofBrowserExecutorV1, authorizeB2BProofBrowserExecutorV1,
  executeBrowserExecutorV1 }
  from '../packages/e2e-runtime/src/browser-executor-protocol.js'
import { startGatewayProxyHostForRuntime }
  from '../packages/e2e-runtime/src/gateway-proxy-host.js'
import { projectGatewayRules }
  from '../packages/e2e-runtime/src/gateway-rule-projector.js'
import { B2B_SCENARIO_CORPUS } from './e2e-b2b-coverage-corpus.js'
import { createGoldenAttemptProof } from './e2e-golden-attempt.js'

const outputRoot = resolve(process.env.E2E_B2B_COVERAGE_OUTPUT_DIR
  ?? join(homedir(), '.mutil-skills', 'e2e', 'proofs', 'b2b-scenario-coverage'))
const repetitions = Number(process.env.E2E_B2B_COVERAGE_REPETITIONS ?? '3')
if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 20) {
  throw new Error('E2E_B2B_REPETITIONS_INVALID')
}
await mkdir(outputRoot, { recursive: true, mode: 0o700 })
const artifactRoot = join(outputRoot, 'runtime-artifacts')
await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
const prd = createPrdFixture()
const compiledPlan = compilePrdRun({ understanding: prd.understanding, design: prd.design })
const caseSchedules = Array.from({ length: repetitions }, () =>
  createCaseSchedule(compiledPlan, '2026-08-09T00:00:00.000Z'))
const coverage = buildCoverageUniverse({
  model: prd.requirementModel,
  modelDigest: prd.modelDigest,
  confirmedModelDigest: prd.modelDigest,
  nodes: [],
  policy: { policyVersion: '1.0.0', ruleScenarios: { business: ['happy-path'] }, pairwiseSeed: 20260809 },
  dispositionFor: (candidate) => ({
    kind: 'automated',
    caseIds: [compiledPlan.cases[prd.requirementIndex.get(candidate.reqId)!]!.caseId],
  }),
})
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (requestUrl.pathname === '/api/data') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ready', count: 3 }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(appHtml(requestUrl.searchParams.get('case') ?? 'UNKNOWN'))
})
await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('E2E_B2B_SERVER_ADDRESS_INVALID')
const origin = `http://127.0.0.1:${address.port}`
const attemptAuthority = createAttemptProofAuthority()
const positiveRunIds = Array.from({ length: repetitions }, (_, index) => `RUN-B2B-PROOF-R${index + 1}`)
const compiledCaseActions = compiledPlan.cases.map((item) => ({
  caseId: item.caseId, actionId: item.actions[0]!.actionId,
}))
const attemptApprovals = []
for (const runId of positiveRunIds) attemptApprovals.push(await createAttemptProofApproval(
  attemptAuthority, origin, compiledCaseActions, runId))
const positiveAttemptSets = Array.from({ length: repetitions }, () =>
  new Map<string, ReturnType<typeof createGoldenAttemptProof>>())
const noBodyDigest = digestText('runtime-http-signed-payload/v1', canonicalizeJson({ kind: 'no-body' }))
const approvedRequests = compiledPlan.cases.flatMap((compiledCase) => {
  const actionId = compiledCase.actions[0]!.actionId
  const caseQuery = encodeURIComponent(compiledCase.caseId)
  const requests = [{ suffix: 'DOCUMENT', url: `${origin}/?case=${caseQuery}`, maxUses: repetitions * 3 }]
  if (compiledCase.caseKey === 'scenario-multipage') requests.push(
    { suffix: 'POPUP', url: `${origin}/?popup=ready&case=${caseQuery}`, maxUses: repetitions * 2 },
  )
  if (['scenario-multipage', 'scenario-evidence'].includes(compiledCase.caseKey)) requests.push(
    { suffix: 'API', url: `${origin}/api/data?case=${caseQuery}`, maxUses: repetitions * 4 },
  )
  return requests.map((request) => ({ actionId, capabilityId: `CAP-${actionId}`,
    requestId: `REQUEST-${actionId}-${request.suffix}`, method: 'GET', url: request.url,
    maxUses: request.maxUses, signedBodyDigest: noBodyDigest, headers: [], redirectRequestIds: [],
    channel: 'http' as const, behavior: { kind: 'pass-through' as const } }))
})
const actionGroups = Array.from({ length: Math.ceil(compiledPlan.cases.length / 4) }, (_, index) =>
  new Set(compiledPlan.cases.slice(index * 4, index * 4 + 4)
    .flatMap((item) => item.actions.map((action) => action.actionId))))
const approvedRequestGroups = actionGroups.map((actions) =>
  approvedRequests.filter((request) => actions.has(request.actionId)))
const gatewayDescriptors = positiveRunIds.flatMap((runId, repetitionIndex) =>
  approvedRequestGroups.map((requests, groupIndex) => ({ runId, repetitionIndex, groupIndex, requests })))
const gatewayAuditRecorders: TrustedGatewayPublicationAuditRecorder[] = []
const gatewayAuditSigners = gatewayDescriptors.map((descriptor, index) => LocalGatewayAuditSigner.create({
  issuer: 'e2e-b2b-gateway', keyId: `gateway-${index + 1}`,
  instanceId: descriptor.runId, version: '1.0.0',
}))
const gateways = await Promise.all(gatewayDescriptors.map(async (descriptor, gatewayIndex) => {
  const authorityRoot = join(outputRoot,
    `runtime-authority-r${descriptor.repetitionIndex + 1}-g${descriptor.groupIndex + 1}`)
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
  return await startGatewayProxyHostForRuntime({
    runId: descriptor.runId, mode: 'real-environment', authorityRoot,
    approvedRequests: descriptor.requests,
    policyObjects: { auditSigner: gatewayAuditSigners[gatewayIndex]!, factory: ({ recorder }) => {
      gatewayAuditRecorders[gatewayIndex] = recorder
      return {}
    } },
  })
}))
const gatewayRuleGroups = gatewayDescriptors.map((descriptor) => projectGatewayRules({
  runId: descriptor.runId, approvedRequests: descriptor.requests,
}).rules)
const browsers: Browser[] = []
let gatewayVerified = false
const gatewayPublications: Array<Awaited<ReturnType<typeof gateways[number]['handle']['finalize']>>> = []
const executionDrafts: Array<Omit<B2BScenarioExecution,
  'positiveVerdict' | 'positiveVerdicts' | 'negativeVerdict' | 'generation'
  | 'publishedExecutionsDigest' | 'publishedVerdictsDigest'>> = []
const browserExecutorFacts: Array<{ runId: string; caseId: string; actionId: string; attemptId: string; outcomeDigest: string;
  evidenceReferences: Array<{ kind: string; uri: string; digest: string }> }> = []
try {
  const channel = process.env.E2E_B2B_BROWSER_CHANNEL ?? 'chrome'
  for (const gateway of gateways) browsers.push(await chromium.launch({
    headless: true, ...(channel === '' ? {} : { channel }),
    proxy: { server: gateway.handle.endpoint, bypass: '<-loopback>' },
    args: [`--ignore-certificate-errors-spki-list=${gateway.handle.caSpkiFingerprint}`],
  }))
  for (const compiledCase of compiledPlan.cases) {
    const groupIndex = Math.floor(compiledCase.queueOrdinal / 4)
    const scenario = B2B_SCENARIO_CORPUS.find((candidate) =>
      candidate.scenarioId.toLowerCase() === compiledCase.caseKey)
    if (scenario === undefined || compiledCase.actions.length !== 1
      || compiledCase.actions[0]?.kind !== 'full-playwright'
      || compiledCase.actions[0].effect !== 'reversible-write'
      || compiledCase.actions[0].statement !== scenario.title) {
      throw new Error('E2E_B2B_COMPILED_CASE_UNMAPPED')
    }
    const results: B2BScenarioExecution['repetitions'] = []
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const repetitionIndex = repetition - 1
      const runId = positiveRunIds[repetitionIndex]!
      const gatewayIndex = repetitionIndex * approvedRequestGroups.length + groupIndex
      const gateway = gateways[gatewayIndex]!
      const browser = browsers[gatewayIndex]!
      const attemptId = `ATTEMPT-B2B-${compiledCase.queueOrdinal + 1}-R${repetition}`
      caseSchedules[repetitionIndex] = startNextCase(caseSchedules[repetitionIndex]!, {
        attemptId, startedAt: new Date(Date.UTC(2026, 7, 9, repetitionIndex,
          0, compiledCase.queueOrdinal * 2 + 1)).toISOString(),
      })
      const attemptContext = { assetId: 'ASSET-B2B-PROOF', generationId: 'GEN-B2B-PROOF-0001',
        prdRevision: digestText('e2e-b2b-prd-revision/v1', '1'), runId, caseId: compiledCase.caseId }
      const attemptApproval = attemptApprovals[repetitionIndex]!
      const attemptCapability = attemptApproval.grant.capabilities.find((candidate) =>
        candidate.actionId === compiledCase.actions[0]!.actionId)
      if (attemptCapability === undefined) throw new Error('E2E_B2B_ATTEMPT_CAPABILITY_MISSING')
      const attemptReservation = await attemptAuthority.reserveForSubject({
        grant: attemptApproval.grant, currentSubject: attemptApproval.subject,
        capabilityId: attemptCapability.capabilityId, actionId: compiledCase.actions[0]!.actionId,
        attemptId, attemptContext,
      })
      gatewayAuditRecorders[gatewayIndex]!.recordCapabilityReservation({
        reservation: attemptReservation, consumed: false,
      })
      const attemptStart = startAttemptProof(attemptAuthority, attemptContext, attemptId)
      const evidenceDirectory = join(outputRoot, 'evidence', scenario.scenarioId, String(repetition))
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
      const context = await browser.newContext({ acceptDownloads: true })
      const actionRules = gatewayRuleGroups[gatewayIndex]!
      await context.route('**/*', async (route) => {
        const request = route.request()
        const rule = actionRules.find((candidate) => candidate.method === request.method().toUpperCase()
          && candidate.url === request.url())
        if (rule === undefined) { await route.abort('blockedbyclient'); return }
        await gateway.browserBinding.continueCorrelatedRequest({
          requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
          method: rule.method, url: rule.url, channel: 'http', bodyDigest: rule.bodyDigest,
          actionId: rule.actionId, capabilityId: rule.capabilityId,
          signedBodyDigest: rule.signedBodyDigest!, redirectRequestIds: [...rule.redirectRequestIds],
          navigation: request.isNavigationRequest(), maxUses: rule.maxUses,
          headers: { ...rule.requestHeaders },
        }, { continueWithHeaders: async (headers) => await route.continue({
          headers: { ...request.headers(), ...headers },
        }) })
      })
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
      const page = await context.newPage()
      const network: string[] = []
      const consoleMessages: string[] = []
      page.on('response', (item) => network.push(`${item.status()} ${new URL(item.url()).pathname}`))
      page.on('console', (item) => consoleMessages.push(item.text()))
      let status: 'passed' | 'failed' = 'passed'
      let reasonCode: string | null = null
      let oraclePassed = false
      let targetBound = false
      let evidenceFiles: B2BScenarioExecution['repetitions'][number]['evidenceFiles'] = []
      const caseUrl = `${origin}/?case=${encodeURIComponent(compiledCase.caseId)}`
      const protocol = adaptB2BProofBrowserExecutorV1(authorizeB2BProofBrowserExecutorV1(async (candidate) => {
        if (!plainRecord(candidate) || candidate.caseId !== compiledCase.caseId
          || candidate.actionId !== compiledCase.actions[0]!.actionId) {
          throw new Error('E2E_B2B_PROTOCOL_INPUT_BINDING_INVALID')
        }
        try {
          await page.goto(caseUrl, { waitUntil: 'domcontentloaded' })
          targetBound = await page.title() === 'B2B E2E Benchmark'
            && await page.getByRole('heading', { name: 'B2B E2E Benchmark' }).isVisible()
          await executeCompiledCase(page, compiledCase, scenario.scenarioId, evidenceDirectory)
          oraclePassed = targetBound
          if (!oraclePassed) throw new Error('ORACLE_FAILED')
        } catch (cause) {
          status = 'failed'
          reasonCode = code(cause)
        }
        const screenshot = join(evidenceDirectory, 'evidence.png')
        const dom = join(evidenceDirectory, 'evidence.html')
        const trace = join(evidenceDirectory, 'trace.zip')
        await page.screenshot({ path: screenshot, fullPage: true })
        await writeFile(dom, await page.content(), { mode: 0o600 })
        await context.tracing.stop({ path: trace })
        const urlEvidence = join(evidenceDirectory, 'url.txt')
        const networkEvidence = join(evidenceDirectory, 'network.json')
        const consoleEvidence = join(evidenceDirectory, 'console.json')
        await writeFile(urlEvidence, `${page.url()}\n`, { mode: 0o600 })
        await writeFile(networkEvidence, `${JSON.stringify(network, null, 2)}\n`, { mode: 0o600 })
        await writeFile(consoleEvidence, `${JSON.stringify(consoleMessages, null, 2)}\n`, { mode: 0o600 })
        const evidencePaths: Array<{
          kind: B2BScenarioExecution['repetitions'][number]['evidenceKinds'][number]
          path: string
        }> = [
          { kind: 'screenshot', path: screenshot }, { kind: 'dom', path: dom }, { kind: 'trace', path: trace },
          { kind: 'url', path: urlEvidence }, { kind: 'network', path: networkEvidence },
          { kind: 'console', path: consoleEvidence },
        ]
        if (scenario.scenarioId === 'SCENARIO-FILE') {
          evidencePaths.push({ kind: 'file', path: join(evidenceDirectory, 'download.txt') })
        }
        evidenceFiles = await Promise.all(evidencePaths.map(async (item) => ({
          kind: item.kind,
          path: relative(outputRoot, item.path),
          digest: digestBytes(`e2e-b2b-evidence-file:${relative(outputRoot, item.path)}`, await readFile(item.path)),
        })))
        return { status, effectObservation: 'applied', cleanup: { status: 'verified-clean' },
          evidenceReferences: evidenceFiles.filter((item) => ['screenshot', 'dom', 'trace'].includes(item.kind))
            .map((item) => ({ kind: item.kind,
              uri: `artifact://generation/${item.path}`, digest: item.digest })),
          resultDigest: digestText('e2e-b2b-browser-executor-result/v1', canonicalizeJson({
            caseId: compiledCase.caseId, repetition, status, reasonCode,
            evidenceDigest: digestText('e2e-b2b-evidence-set/v1', canonicalizeJson(evidenceFiles)),
          })) }
      }))
      const protocolExecution = await executeBrowserExecutorV1(protocol, {
        executionId: `B2B-${compiledCase.caseId}-${repetition}`,
        runId, attemptId,
        input: { caseId: compiledCase.caseId, actionId: compiledCase.actions[0]!.actionId },
      })
      const protocolEvidence = evidenceFiles.filter((item) => ['screenshot', 'dom', 'trace'].includes(item.kind))
        .map((item) => ({ kind: item.kind,
          uri: `artifact://generation/${item.path}`, digest: item.digest }))
      if (canonicalizeJson(protocolExecution.result.evidence.references) !== canonicalizeJson(protocolEvidence)) {
        throw new Error('E2E_B2B_PROTOCOL_EVIDENCE_BINDING_INVALID')
      }
      browserExecutorFacts.push({ runId, caseId: compiledCase.caseId,
        actionId: compiledCase.actions[0]!.actionId,
        attemptId, outcomeDigest: protocolExecution.result.outcomeDigest,
        evidenceReferences: protocolExecution.result.evidence.references })
      const negativeControlDetected = await runNegativeControl(page, scenario.scenarioId)
      const result = { repetition, runId, attemptId, status, oraclePassed,
        negativeControlDetected,
        evidenceKinds: [...new Set(evidenceFiles.map((item) => item.kind))].sort(),
        evidenceFiles,
        evidenceDigest: digestText('e2e-b2b-evidence-set/v1', canonicalizeJson(evidenceFiles)), reasonCode }
      results.push(result)
      const attemptOutcomeDigest = digestText(
        'e2e-b2b-attempt-outcome/v1', protocolExecution.result.outcomeDigest,
      )
      await attemptAuthority.complete(attemptReservation.reservationId, attemptOutcomeDigest)
      gatewayAuditRecorders[gatewayIndex]!.recordCapabilityReservation({
        reservation: { ...attemptReservation, status: 'completed', outcomeDigest: attemptOutcomeDigest },
        consumed: true,
      })
      positiveAttemptSets[repetitionIndex]!.set(compiledCase.caseId, completeAttemptProof(
        attemptAuthority, attemptStart, status, attemptReservation.reservationId, attemptOutcomeDigest,
      ))
      caseSchedules[repetitionIndex] = completeCase(caseSchedules[repetitionIndex]!, {
        caseId: compiledCase.caseId, attemptId, status,
        effectObservation: 'applied', cleanupStatus: 'verified-clean',
        completedAt: new Date(Date.UTC(2026, 7, 9, repetitionIndex,
          0, compiledCase.queueOrdinal * 2 + 2)).toISOString(),
      })
      await context.close()
    }
    const casePassed = results.every((item) => item.status === 'passed')
    const requirementId = compiledCase.contractNodeIds[0]
    const obligation = coverage.obligations.find((item) => item.reqId === requirementId)
    if (requirementId === undefined || obligation === undefined) {
      throw new Error('E2E_B2B_COMPILED_CASE_OBLIGATION_MISSING')
    }
    executionDrafts.push({
      scenarioId: scenario.scenarioId,
      requirementId: obligation.reqId,
      ruleIds: obligation.ruleIds,
      oracleIds: compiledCase.oracles.map((item) => item.oracleId),
      caseId: compiledCase.caseId,
      compiledPlanDigest: compiledPlan.compilerDigest,
      targetBound: casePassed,
      repetitions: results,
    })
  }
} finally {
  await Promise.all(browsers.map(async (item) => await item.close()))
  try {
    for (const gateway of gateways) {
      await gateway.handle.freeze()
      gatewayPublications.push(await gateway.handle.finalize())
    }
    gatewayVerified = gateways.every((gateway, index) => {
      const summary = gateway.handle.auditSummary()
      const publication = gatewayPublications[index]!
      return summary.received > 0 && summary.forwarded > 0 && summary.injected === 0
        && verifyGatewayPublicationAudit(publication, LocalGatewayAuditVerifier.create(
          gatewayAuditSigners[index]!.exportVerifierMaterial(),
        ))
        && publication.requestEvents.every((event) => event.decision === 'forwarded'
          ? compiledPlan.cases.some((item) => item.actions.some((action) => action.actionId === event.actionId))
          : event.decision === 'blocked' && event.actionId === 'GATEWAY-DEFAULT-DENY')
        && /^sha256:[a-f0-9]{64}$/.test(publication.signedCounters.digest)
    })
  } finally { await Promise.all(gateways.map(async (gateway) => await gateway.handle.close())) }
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) =>
    error === undefined ? resolvePromise() : rejectPromise(error)))
}

const schedulerVerified = caseSchedules.every((schedule) => schedule.status === 'terminal'
  && schedule.cases.length === compiledPlan.cases.length
  && schedule.cases.every((item) => item.state === 'passed' && typeof item.attemptId === 'string'))
if (!schedulerVerified) {
  throw new Error('E2E_B2B_CASE_SCHEDULE_INCOMPLETE')
}
const positiveVerdicts = positiveAttemptSets.map((attempts, repetitionIndex) => computeVerdict(createVerdictInput(
  coverage.obligations, compiledPlan.cases.map((item) => item.caseId),
  executionDrafts.map((item) => item.repetitions[repetitionIndex]!.status === 'passed'),
  prd.modelDigest, coverage.universeDigest, positiveRunIds[repetitionIndex]!, attempts,
), { verifyAttemptSelection: attemptVerifier(attemptAuthority, attempts) }))
if (positiveVerdicts.some((verdict) => verdict.verdict !== 'accepted')) {
  throw new Error('E2E_B2B_POSITIVE_VERDICT_NOT_ACCEPTED')
}
const positiveVerdict = positiveVerdicts[0]!
const positiveVerdictFacts = positiveVerdicts.map((verdict, index) => ({
  runId: positiveRunIds[index]!, verdict: verdict.verdict,
  verdictDigest: digestText('e2e-b2b-positive-verdict/v1', canonicalizeJson(verdict)),
}))
const negativeAttemptSets: Array<Awaited<ReturnType<typeof createAttemptProofs>>> = []
const negativeVerdicts = []
for (const [negativeIndex, execution] of executionDrafts.entries()) {
  const passed = executionDrafts.map((candidate) => candidate.caseId !== execution.caseId
    || !candidate.repetitions.every((result) => result.negativeControlDetected))
  const runId = `RUN-B2B-NEG-${negativeIndex + 1}`
  const negativeApproval = await createAttemptProofApproval(
    attemptAuthority, origin, compiledCaseActions, runId)
  const attempts = await createAttemptProofs(attemptAuthority, negativeApproval, runId,
    executionDrafts.map((item, index) => ({ caseId: item.caseId,
      actionId: compiledCaseActions[index]!.actionId, passed: passed[index]! })))
  negativeAttemptSets.push(attempts)
  negativeVerdicts.push(computeVerdict(createVerdictInput(
    coverage.obligations, compiledPlan.cases.map((item) => item.caseId), passed,
    prd.modelDigest, coverage.universeDigest, runId, attempts,
  ), { verifyAttemptSelection: attemptVerifier(attemptAuthority, attempts) }))
}
if (negativeVerdicts.some((verdict) => verdict.verdict !== 'rejected')) {
  throw new Error('E2E_B2B_NEGATIVE_VERDICT_NOT_REJECTED')
}
const generationId = 'GEN-B2B-PROOF-0001'
const publishedExecutionsDigest = digestPublishedB2BExecutions(executionDrafts)
const publishedVerdictFacts = { positiveVerdict: positiveVerdict.verdict,
  positiveVerdicts: positiveVerdictFacts,
  negativeVerdicts: executionDrafts.map((execution, index) => ({ scenarioId: execution.scenarioId,
    caseId: execution.caseId, verdict: negativeVerdicts[index]!.verdict })) }
const publishedVerdictsDigest = digestText(
  'e2e-b2b-published-verdicts/v1', canonicalizeJson(publishedVerdictFacts),
)
const evidenceArtifacts = Object.fromEntries(await Promise.all(executionDrafts.flatMap((execution) =>
  execution.repetitions.flatMap((result) => result.evidenceFiles.map(async (file) => [
    file.path, await readFile(join(outputRoot, file.path)),
  ] as const)))))
const store = new LocalArtifactStore(await realpath(artifactRoot), createProofAuthority())
const active = await store.publish({
  assetId: 'ASSET-B2B-PROOF', generationId, terminalVerdict: positiveVerdict.verdict,
  files: {
    ...evidenceArtifacts,
    'prd/understanding.json': `${canonicalizeJson(prd.understanding)}\n`,
    'run/compiled-prd-run.json': `${canonicalizeJson(compiledPlan)}\n`,
    'run/coverage-universe.json': `${canonicalizeJson(coverage)}\n`,
    'run/executions.json': `${canonicalizeJson(executionDrafts)}\n`,
    'run/published-executions-digest.txt': `${publishedExecutionsDigest}\n`,
    'run/published-verdicts.json': `${canonicalizeJson(publishedVerdictFacts)}\n`,
    'run/positive-verdict.json': `${canonicalizeJson(positiveVerdict)}\n`,
    'run/positive-verdicts.json': `${canonicalizeJson(positiveVerdicts.map((verdict, index) => ({
      runId: positiveRunIds[index]!, verdict,
    })))}\n`,
    'run/negative-control-verdicts.json': `${canonicalizeJson(negativeVerdicts)}\n`,
    'run/gateway-publication.json': `${canonicalizeJson(gatewayPublications)}\n`,
  },
})
const readBack = await store.readActive('ASSET-B2B-PROOF')
if (readBack === null || readBack.generationId !== active.generationId
  || readBack.generationDigest !== active.generationDigest) throw new Error('E2E_B2B_GENERATION_READBACK_FAILED')
for (const execution of executionDrafts) for (const result of execution.repetitions) {
  for (const file of result.evidenceFiles) {
    const bytes = await readFile(join(readBack.generationPath, file.path))
    if (digestBytes(`e2e-b2b-evidence-file:${file.path}`, bytes) !== file.digest) {
      throw new Error('E2E_B2B_GENERATION_EVIDENCE_READBACK_FAILED')
    }
  }
}
const executions: B2BScenarioExecution[] = executionDrafts.map((item, index) => ({
  ...item,
  publishedExecutionsDigest,
  publishedVerdictsDigest,
  positiveVerdict: positiveVerdict.verdict,
  positiveVerdicts: positiveVerdictFacts,
  negativeVerdict: negativeVerdicts[index]!.verdict,
  generation: { expectedId: generationId, activeId: readBack.generationId, activeDigest: readBack.generationDigest },
}))
if (digestPublishedB2BVerdicts(executions) !== publishedVerdictsDigest) {
  throw new Error('E2E_B2B_PUBLISHED_VERDICTS_MISMATCH')
}

const proof = createB2BCoverageProof({
  corpus: B2B_SCENARIO_CORPUS,
  executions,
  environmentEligible: await verifyStableRunnerBaseline(),
  runtimeChainProof: verifyB2BRuntimeChainFactsV1({
    binding: {
      corpusDigest: digestText('e2e-b2b-scenario-corpus/v1', canonicalizeJson(B2B_SCENARIO_CORPUS)),
      executionsDigest: digestText('e2e-b2b-scenario-executions/v1', canonicalizeJson(executions)),
      generationDigest: readBack.generationDigest,
    },
    expected: positiveRunIds.flatMap((runId, repetitionIndex) => compiledPlan.cases.map((item) => ({
      runId, caseId: item.caseId, actionId: item.actions[0]!.actionId,
      attemptId: `ATTEMPT-B2B-${item.queueOrdinal + 1}-R${repetitionIndex + 1}` }))),
    scheduler: schedulerVerified ? caseSchedules.flatMap((schedule, repetitionIndex) => schedule.cases.map((item) => ({
      runId: positiveRunIds[repetitionIndex]!, caseId: item.caseId, attemptId: item.attemptId! }))) : [],
    authority: positiveAttemptSets.every((attempts) => verifyAttemptProofSet(attemptAuthority, attempts))
      && negativeAttemptSets.every((attempts) => verifyAttemptProofSet(attemptAuthority, attempts))
      ? positiveAttemptSets.flatMap((attempts, repetitionIndex) => [...attempts.entries()]
        .flatMap(([caseId, attempt]) => {
          const terminal = attempt.workflowEvents.attemptCases[0]?.events.find((event) => event.kind === 'terminal')
          if (terminal?.kind !== 'terminal' || terminal.result.outcomeDigest === undefined) return []
          return [{ runId: positiveRunIds[repetitionIndex]!, caseId,
            attemptId: attempt.attemptSelection.attemptId,
            eventChainDigest: attempt.attemptSelection.eventChainDigest,
            terminalOutcomeDigest: terminal.result.outcomeDigest }]
        })) : [],
    gateway: gatewayVerified ? gatewayPublications.flatMap((publication) => publication.capabilityReservations
      .flatMap((reservation) => reservation.attemptContext === undefined
        || reservation.status !== 'completed' || !reservation.consumed || reservation.outcomeDigest === undefined
        ? [] : [{
        runId: reservation.attemptContext.runId,
        caseId: reservation.attemptContext.caseId,
        actionId: reservation.actionId,
        attemptId: reservation.attemptId,
        terminalOutcomeDigest: reservation.outcomeDigest,
      }])) : [],
    browserExecutions: browserExecutorFacts,
  }),
})
await writeFile(join(outputRoot, 'executions.json'), `${JSON.stringify(executions, null, 2)}\n`, { mode: 0o600 })
await writeFile(join(outputRoot, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
await writeFile(join(outputRoot, 'report.md'), markdown(proof), { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: proof.passed, gateEligible: proof.gateEligible,
  weightedCoverage: proof.weightedCoverage, outputRoot, proofDigest: proof.proofDigest })}\n`)
if (!proof.passed) process.exitCode = 1

function createPrdFixture(): {
  understanding: PrdUnderstandingProjection
  design: DeclarativePrdRunDesign
  requirementModel: RequirementModel
  modelDigest: string
  requirementIndex: Map<string, number>
} {
  const createdAt = '2026-08-09T00:00:00.000Z'
  const nodes = B2B_SCENARIO_CORPUS.map((scenario, index) => {
    const quote = `${scenario.title}必须在真实浏览器中完成，并产生可审计证据。`
    return {
      nodeId: `REQ-B2B-${index + 1}`, kind: 'REQ' as const, statement: quote,
      provenance: { kind: 'source-fact' as const, anchors: [{
        sourceId: 'PRD-B2B', sourceSpan: { startLine: index + 1, startColumn: 1,
          endLine: index + 1, endColumn: quote.length + 1 }, quote,
        quoteDigest: digestPrdUnderstandingQuote(quote),
      }] },
      responsibility: 'PRODUCT', upstreamNodeIds: [], downstreamNodeIds: [], acceptanceCriteria: [quote],
    }
  })
  const projection = {
    schemaVersion: '1.0.0' as const, contractId: 'CONTRACT-B2B-PROOF', contractVersion: 1,
    contractStatus: 'confirmed-by-caller' as const,
    contractSourceDigest: digestText('e2e-b2b-prd-contract/v1', canonicalizeJson(B2B_SCENARIO_CORPUS)),
    sourceRevision: digestText('e2e-b2b-prd-source/v1', canonicalizeJson(B2B_SCENARIO_CORPUS)),
    sources: [{ sourceId: 'PRD-B2B', kind: 'file' as const, ref: 'scripts/e2e-b2b-coverage-corpus.ts',
      origin: { kind: 'file' as const, ref: 'scripts/e2e-b2b-coverage-corpus.ts' }, relevance: 'target' as const,
      digest: digestText('e2e-b2b-prd/v1', canonicalizeJson(B2B_SCENARIO_CORPUS)),
      byteLength: Buffer.byteLength(canonicalizeJson(B2B_SCENARIO_CORPUS)) }],
    nodes, pendingQuestions: [],
    route: { skillName: 'e2e' as const, steps: nodes.map((node, index) => ({
      stepId: `STEP-B2B-${index + 1}`, inputNodeIds: [node.nodeId], output: 'E2E Case', constraints: [],
      dependencyStepIds: [], completionCondition: node.acceptanceCriteria[0]!,
    })) },
    authorization: { status: 'confirmed-by-caller' as const, contractVersion: 1, confirmedAt: createdAt,
      authorizedNodeIds: nodes.map((node) => node.nodeId) },
  }
  const understanding: PrdUnderstandingProjection = {
    ...projection, projectionDigest: digestPrdUnderstandingProjection(projection),
  }
  const design: DeclarativePrdRunDesign = {
    schemaVersion: '1.0.0', cases: B2B_SCENARIO_CORPUS.map((scenario, index) => ({
      caseKey: scenario.scenarioId.toLowerCase(), title: scenario.title, actor: 'B2B-OPERATOR',
      contractNodeIds: [nodes[index]!.nodeId], failurePolicy: 'continue',
      actions: [{ actionKey: 'execute', kind: 'full-playwright', effect: 'reversible-write', statement: scenario.title }],
      oracles: [{ oracleKey: 'observable-outcome', actionKey: 'execute', contractNodeId: nodes[index]!.nodeId,
        acceptanceCriterion: nodes[index]!.acceptanceCriteria[0]! }],
    })),
  }
  const modelDigest = digestText('e2e-b2b-requirement-model/v1', canonicalizeJson(nodes))
  const requirementModel: RequirementModel = {
    modelRevision: 1,
    requirements: B2B_SCENARIO_CORPUS.map((scenario, index) => ({
      reqId: nodes[index]!.nodeId, revision: 1, title: scenario.title, actors: ['B2B-OPERATOR'],
      entities: [scenario.category], preconditions: [], rules: [{
        ruleId: `RULE-B2B-${index + 1}`, category: 'business', statement: scenario.title,
        sourceRefs: [`prd-b2b:${index + 1}`], certainty: 'explicit', oracleIds: [`MODEL-ORACLE-B2B-${index + 1}`],
      }], states: [], transitions: [], observableOutcomes: [{
        oracleId: `MODEL-ORACLE-B2B-${index + 1}`, ruleId: `RULE-B2B-${index + 1}`,
        statement: nodes[index]!.acceptanceCriteria[0]!, sourceRefs: [`prd-b2b:${index + 1}`],
      }], applicability: [], sourceRefs: [`prd-b2b:${index + 1}`], status: 'active',
    })),
    coupledDimensions: [], applicabilityRules: [], modelDecisionDigest: modelDigest,
  }
  return { understanding, design, requirementModel, modelDigest,
    requirementIndex: new Map(nodes.map((node, index) => [node.nodeId, index])) }
}

function createVerdictInput(
  obligations: ReturnType<typeof buildCoverageUniverse>['obligations'],
  caseIds: string[], passed: boolean[], requirementModelDigest: string, universeDigest: string,
  runId: string, attempts: Awaited<ReturnType<typeof createAttemptProofs>>,
): VerdictInput {
  const obligationsByCase = new Map(caseIds.map((caseId) => [caseId, [] as string[]]))
  for (const obligation of obligations) {
    if (obligation.disposition.kind !== 'automated') continue
    for (const caseId of obligation.disposition.caseIds) obligationsByCase.get(caseId)!.push(obligation.obligationId)
  }
  return {
    schemaVersion: '2.1.0', assetId: 'ASSET-B2B-PROOF', generationId: 'GEN-B2B-PROOF-0001',
    verdictRuleVersion: '2.0.0', policyDigest: digestText('e2e-b2b-policy/v1', 'required'),
    universeDigest, prdRevision: digestText('e2e-b2b-prd-revision/v1', '1'), requirementModelDigest,
    obligations: obligations.map((item) => ({ obligationId: item.obligationId, necessity: 'required',
      disposition: 'automated', caseIds: item.disposition.kind === 'automated' ? item.disposition.caseIds : [] })),
    caseResults: caseIds.map((caseId, index) => ({ resultId: deriveExecutionResultId(caseId, 'real-environment'),
      caseId, runId, obligationIds: obligationsByCase.get(caseId) ?? [],
      status: passed[index] ? 'passed' : 'failed', executionMode: 'real-environment',
      attemptSelection: attempts.get(caseId)!.attemptSelection })),
    manualResults: [], pendingDecisionIds: [], safetyFindings: [], artifactFindings: [], migrationFindings: [],
    environmentFindings: [], automationFindings: [],
    gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
    evidenceAudit: { status: 'complete', total: caseIds.length, complete: caseIds.length, reasonCodes: [] },
    cleanupAudit: { status: 'complete', total: caseIds.length, complete: caseIds.length, reasonCodes: [] },
    coverageFacts: { prdClauses: { covered: caseIds.length, total: caseIds.length },
      requirementDesign: { covered: caseIds.length, total: caseIds.length },
      rules: { covered: caseIds.length, total: caseIds.length }, oracles: { covered: caseIds.length, total: caseIds.length },
      cases: { covered: caseIds.length, total: caseIds.length }, criticalNodes: { covered: 0, total: 0 },
      roles: { covered: 1, total: 1 }, stateTransitions: { covered: 0, total: 0 },
      scenarioCategories: { covered: B2B_SCENARIO_CORPUS.length, total: B2B_SCENARIO_CORPUS.length } },
  }
}

async function createAttemptProofs(
  authority: ReturnType<typeof createAttemptProofAuthority>,
  approval: Awaited<ReturnType<typeof createAttemptProofApproval>>,
  runId: string,
  cases: Array<{ caseId: string; actionId: string; passed: boolean }>,
): Promise<Map<string, ReturnType<typeof createGoldenAttemptProof>>> {
  const entries = []
  for (const [index, item] of cases.entries()) {
    const actionId = item.actionId
    const capability = approval.grant.capabilities.find((candidate) => candidate.actionId === actionId)
    if (capability === undefined) throw new Error('E2E_B2B_ATTEMPT_CAPABILITY_MISSING')
    const attemptId = `${runId}-ATTEMPT-${index + 1}`
    const reservation = await authority.reserveForSubject({
      grant: approval.grant, currentSubject: approval.subject,
      capabilityId: capability.capabilityId, actionId, attemptId,
      attemptContext: { assetId: 'ASSET-B2B-PROOF', generationId: 'GEN-B2B-PROOF-0001',
        prdRevision: digestText('e2e-b2b-prd-revision/v1', '1'), runId, caseId: item.caseId },
    })
    const outcomeDigest = digestText('e2e-b2b-attempt-outcome/v1', `${runId}:${item.caseId}:${item.passed}`)
    await authority.complete(reservation.reservationId, outcomeDigest)
    entries.push([item.caseId, createGoldenAttemptProof({
      authority, assetId: 'ASSET-B2B-PROOF', generationId: 'GEN-B2B-PROOF-0001',
      prdRevision: digestText('e2e-b2b-prd-revision/v1', '1'), runId, caseId: item.caseId,
      attemptId, status: item.passed ? 'passed' : 'failed', effect: 'reversible-write',
      reservationId: reservation.reservationId, outcomeDigest,
    })] as const)
  }
  return new Map(entries)
}

function attemptVerifier(
  authority: ReturnType<typeof createAttemptProofAuthority>,
  attempts: ReturnType<typeof createAttemptProofs>,
): NonNullable<Parameters<typeof computeVerdict>[1]>['verifyAttemptSelection'] {
  return ({ caseResult }) => {
    const persisted = attempts.get(caseResult.caseId)?.workflowEvents.attemptCases[0]
    if (persisted === undefined) return false
    const selected = selectFinalAttempt({ caseId: persisted.caseId, retryPolicy: persisted.retryPolicy,
      initialChainDigest: persisted.initialChainDigest, events: persisted.events,
      verifyAuthorityProof: (proof) => authority.verifyAttemptEventProof(proof) })
    return selected.status === 'selected' && caseResult.attemptSelection.status === 'valid'
      && caseResult.attemptSelection.attemptId === selected.attemptId
      && caseResult.attemptSelection.eventChainDigest === selected.eventChainDigest
  }
}

function verifyAttemptProofSet(
  authority: ReturnType<typeof createAttemptProofAuthority>,
  attempts: ReturnType<typeof createAttemptProofs>,
): boolean {
  return [...attempts.values()].every(({ workflowEvents }) => {
    const persisted = workflowEvents.attemptCases[0]
    if (persisted === undefined) return false
    const selected = selectFinalAttempt({ caseId: persisted.caseId, retryPolicy: persisted.retryPolicy,
      initialChainDigest: persisted.initialChainDigest, events: persisted.events,
      verifyAuthorityProof: (proof) => authority.verifyAttemptEventProof(proof) })
    return selected.status === 'selected'
      && persisted.events.every((event) => authority.verifyAttemptEventProof(event.authorityProof))
  })
}

function createAttemptProofAuthority(): LocalApprovalAuthority {
  return LocalApprovalAuthority.create({
    issuer: 'e2e-b2b-attempt-authority', keyId: 'e2e-b2b-attempt-key',
    now: () => new Date('2026-08-09T00:00:00.000Z'),
    approvalIdentities: [{ subject: 'os-user:e2e-b2b', roles: ['e2e-approver'] }],
    authenticateApproverSession: (sessionRef, expected) => sessionRef.startsWith('b2b-proof-session:')
      ? { subject: 'os-user:e2e-b2b', runId: sessionRef.slice('b2b-proof-session:'.length),
        approvalType: expected.approvalType,
        subjectDigest: expected.subjectDigest, installationDigest: digestText('e2e-b2b-installation/v1', 'local'),
        origin: 'http://127.0.0.1', issuedAt: '2026-08-09T00:00:00.000Z', expiresAt: '2026-08-09T01:00:00.000Z' }
      : undefined,
  })
}

async function createAttemptProofApproval(
  authority: LocalApprovalAuthority,
  origin: string,
  caseActions: Array<{ caseId: string; actionId: string }>,
  runId: string,
): Promise<{ subject: WriteApprovalSubject; grant: Awaited<ReturnType<LocalApprovalAuthority['issueWriteGrant']>> }> {
  const prdRevision = digestText('e2e-b2b-prd-revision/v1', '1')
  const discoverySubject = {
    schemaVersion: '1.1.0' as const, assetId: 'ASSET-B2B-PROOF', prdRevision,
    scopeDigest: digestText('e2e-b2b-attempt-scope/v1', runId), environment: 'test' as const,
    baseOrigin: origin, actor: 'B2B-OPERATOR',
    expectedPageIdentity: { url: `${origin}/`, title: 'B2B E2E Benchmark',
      heading: 'B2B E2E Benchmark', ariaSignals: ['main:B2B E2E Benchmark'] },
    bootstrapIntentsDigest: digestText('e2e-b2b-attempt-bootstrap/v1', runId), requests: [],
    actions: [{ actionId: `DISCOVERY-${runId}`, operation: 'local-navigation' as const,
      maxUses: 1 as const, requestIds: [] }],
  }
  const approver = { subject: 'os-user:e2e-b2b', roles: ['e2e-approver'] }
  const approvalSessionRef = `b2b-proof-session:${runId}`
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject, approver,
    approvalSessionRef, ttlMs: 60_000 })
  const discoveryCapability = discovery.capabilities[0]!
  const discoveryReservation = await authority.reserveForSubject({
    grant: discovery, currentSubject: discoverySubject,
    capabilityId: discoveryCapability.capabilityId, actionId: discoveryCapability.actionId,
    attemptId: `DISCOVERY-${runId}`,
  })
  const preflightDigest = await authority.completeDiscoveryPreflight({
    grant: discovery, currentSubject: discoverySubject,
    reservationId: discoveryReservation.reservationId, capabilityId: discoveryCapability.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: discoverySubject.expectedPageIdentity.url,
      title: discoverySubject.expectedPageIdentity.title, headings: [discoverySubject.expectedPageIdentity.heading],
      role: discoverySubject.actor, ariaSignals: discoverySubject.expectedPageIdentity.ariaSignals } },
  })
  const sharedDigest = digestText('e2e-b2b-attempt-subject/v1', canonicalizeJson({ runId, caseActions }))
  const subject: WriteApprovalSubject = {
    schemaVersion: '2.0.0', assetId: discoverySubject.assetId, prdRevision,
    executionDigest: digestText('e2e-b2b-attempt-execution/v1', runId),
    scopeDigest: discoverySubject.scopeDigest, requirementModelDigest: sharedDigest,
    coveragePolicyDigest: sharedDigest, universeDigest: sharedDigest, caseDigest: sharedDigest,
    actionMapDigest: sharedDigest, policyDigest: sharedDigest, executionContractDigest: sharedDigest,
    runBundleProjectionDigest: sharedDigest, environment: 'test', baseOrigin: origin,
    actor: discoverySubject.actor, discoveryGrantId: discovery.grantId, preflightDigest,
    actions: caseActions.map(({ caseId, actionId }, index) => ({ actionId,
      transport: 'browser-local' as const, operation: 'full-playwright' as const,
      effect: 'reversible-write' as const,
      programDigest: digestText('e2e-b2b-attempt-program/v1', `${runId}:${caseId}`),
      cleanupProgramDigest: digestText('e2e-b2b-attempt-cleanup-program/v1', `${runId}:${caseId}`),
      dataLeaseId: `LEASE-${runId}-${index + 1}`, resourceKey: `b2b:${runId}:${caseId}`,
      fencingToken: index + 1, cleanupPlanDigest: digestText('e2e-b2b-attempt-cleanup/v1', `${runId}:${caseId}`),
      requests: [],
    })),
  }
  const grant = await authority.issueWriteGrant({ subject, approver,
    approvalSessionRef, ttlMs: 60_000 })
  return { subject, grant }
}

function startAttemptProof(
  authority: LocalApprovalAuthority,
  context: { assetId: string; generationId: string; prdRevision: string; runId: string; caseId: string },
  attemptId: string,
): { context: typeof context; attemptId: string; initialChainDigest: string; started: AttemptEvent;
  startedChainDigest: string } {
  const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(context))
  const started = authority.appendAttemptEvent({ context, event: {
    sequence: 1, caseId: context.caseId, slot: 0, attemptId,
    timestamp: '2026-08-09T00:00:00.000Z', previousChainDigest: initialChainDigest,
    kind: 'started', mode: 'real-environment',
  } })
  return { context, attemptId, initialChainDigest, started: started.event,
    startedChainDigest: started.eventChainDigest }
}

function completeAttemptProof(
  authority: LocalApprovalAuthority,
  started: ReturnType<typeof startAttemptProof>,
  status: 'passed' | 'failed',
  reservationId: string,
  outcomeDigest: string,
): ReturnType<typeof createGoldenAttemptProof> {
  const terminal = authority.appendAttemptEvent({ context: started.context, event: {
    sequence: 2, caseId: started.context.caseId, slot: 0, attemptId: started.attemptId,
    timestamp: '2026-08-09T00:00:01.000Z', previousChainDigest: started.startedChainDigest,
    kind: 'terminal', result: { status, mode: 'real-environment', effect: 'reversible-write',
      effectObservation: 'applied', reservationSafeToVoid: false, reservationId, outcomeDigest },
  } })
  const events = [started.started, terminal.event]
  const selected = selectFinalAttempt({ caseId: started.context.caseId,
    retryPolicy: 'verified-not-applied-max-1', initialChainDigest: started.initialChainDigest, events,
    verifyAuthorityProof: (proof) => authority.verifyAttemptEventProof(proof) })
  if (selected.status !== 'selected') throw new Error(`B2B attempt chain invalid: ${selected.reasonCodes.join(',')}`)
  const attemptCase = { caseId: started.context.caseId, retryPolicy: 'verified-not-applied-max-1' as const,
    initialChainDigest: started.initialChainDigest, events,
    selection: { status: 'selected' as const, attemptId: selected.attemptId,
      slot: selected.slot, eventChainDigest: selected.eventChainDigest } }
  return {
    attemptSelection: { status: 'valid', attemptId: selected.attemptId,
      eventChainDigest: selected.eventChainDigest },
    workflowEvents: { runId: started.context.runId, attemptCases: [attemptCase],
      workflowDigest: digestText('workflow-events/v2', canonicalizeJson({
        runId: started.context.runId, attemptCases: [attemptCase],
      })) },
  }
}

function createProofAuthority(): ArtifactStoreAuthority {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    async auditStagedGeneration(input) {
      if (input.files.length < 8) throw new Error('E2E_B2B_GENERATION_INCOMPLETE')
    },
    signDigest(signedDigest): ArtifactSignature {
      return { issuer: 'e2e-b2b-proof', keyId: 'ephemeral-proof-key', algorithm: 'Ed25519', signedDigest,
        signature: sign(null, Buffer.from(canonicalizeJson({ signedDigest })), privateKey).toString('base64url') }
    },
    verifySignature(signature) {
      return signature.issuer === 'e2e-b2b-proof' && signature.keyId === 'ephemeral-proof-key'
        && verify(null, Buffer.from(canonicalizeJson({ signedDigest: signature.signedDigest })), publicKey,
          Buffer.from(signature.signature, 'base64url'))
    },
  }
}

async function verifyStableRunnerBaseline(): Promise<boolean> {
  const configured = process.env.E2E_STABLE_RUNNER_BASELINE
  if (configured === undefined) return false
  const baselineRoot = resolve('.github/e2e-baselines')
  const path = resolve(configured)
  if (!path.startsWith(`${baselineRoot}${sep}`)) throw new Error('E2E_STABLE_RUNNER_BASELINE_OUTSIDE_REPOSITORY')
  const baseline = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  return baseline.schemaVersion === '1.0.0'
    && baseline.runnerName === process.env.RUNNER_NAME
    && baseline.platform === platform() && baseline.arch === arch()
    && baseline.nodeMajor === Number(process.versions.node.split('.')[0])
    && baseline.browserChannel === (process.env.E2E_B2B_BROWSER_CHANNEL ?? 'chrome')
}

async function runNegativeControl(page: Page, scenarioId: string): Promise<boolean> {
  await mutateScenarioOutcome(page, scenarioId)
  try {
    await assertScenarioOutcome(page, scenarioId)
    return false
  } catch {
    return true
  }
}

async function mutateScenarioOutcome(page: Page, scenarioId: string): Promise<void> {
  await page.evaluate((id) => {
    const selector = id === 'SCENARIO-TABLE' ? '#query' : id === 'SCENARIO-FILTER' ? '#page'
      : id === 'SCENARIO-FORM' ? '#form-result' : id === 'SCENARIO-OVERLAY' ? '#drawer'
        : id === 'SCENARIO-RICH-INPUT' ? '#editor' : id === 'SCENARIO-FILE' ? '#upload-name'
          : id === 'SCENARIO-ROLE' ? '#approve' : id === 'SCENARIO-WORKFLOW' ? '#workflow-state'
            : ['SCENARIO-MULTIPAGE', 'SCENARIO-EVIDENCE'].includes(id) ? '#async-result'
              : id === 'SCENARIO-CLEANUP' ? '#fixture-state' : '#component-result'
    const element = document.querySelector(selector) as HTMLElement | HTMLInputElement | HTMLButtonElement | null
    if (element === null) throw new Error('NEGATIVE_CONTROL_TARGET_MISSING')
    if (id === 'SCENARIO-TABLE' && element instanceof HTMLInputElement) {
      element.value = ''; element.dispatchEvent(new Event('input'))
    } else if (id === 'SCENARIO-OVERLAY') element.hidden = true
    else if (id === 'SCENARIO-ROLE' && element instanceof HTMLButtonElement) element.disabled = true
    else element.textContent = '__mutated__'
  }, scenarioId)
}

async function assertScenarioOutcome(page: Page, scenarioId: string): Promise<void> {
  const check = scenarioId === 'SCENARIO-TABLE' ? await page.locator('#orders tbody tr:visible').count() === 1
    : scenarioId === 'SCENARIO-FILTER' ? await page.locator('#page').textContent() === '2'
      : scenarioId === 'SCENARIO-FORM' ? await page.locator('#form-result').textContent() === '已提交 Cooper'
        : scenarioId === 'SCENARIO-OVERLAY' ? await page.locator('#drawer').isVisible()
          : scenarioId === 'SCENARIO-RICH-INPUT' ? await page.locator('#editor').textContent() === '富文本验收'
            : scenarioId === 'SCENARIO-FILE' ? await page.locator('#upload-name').textContent() === 'upload.txt'
              : scenarioId === 'SCENARIO-ROLE' ? !await page.locator('#approve').isDisabled()
                : scenarioId === 'SCENARIO-WORKFLOW' ? await page.locator('#workflow-state').textContent() === 'empty'
                  : ['SCENARIO-MULTIPAGE', 'SCENARIO-EVIDENCE'].includes(scenarioId)
                    ? await page.locator('#async-result').textContent() === 'ready:3'
                    : scenarioId === 'SCENARIO-CLEANUP' ? await page.locator('#fixture-state').textContent() === 'clean'
                      : await page.locator('#component-result').textContent() === 'standard-ant-element'
  if (!check) throw new Error('NEGATIVE_CONTROL_ORACLE_REJECTED')
}

async function executeCompiledCase(
  page: Page,
  compiledCase: ReturnType<typeof compilePrdRun>['cases'][number],
  scenarioId: string,
  evidenceDirectory: string,
): Promise<void> {
  if (compiledCase.actions.length !== 1 || compiledCase.oracles.length === 0
    || !compiledCase.oracles.every((oracle) => oracle.actionId === compiledCase.actions[0]!.actionId)) {
    throw new Error('E2E_B2B_COMPILED_CASE_INVALID')
  }
  if (scenarioId === 'SCENARIO-TABLE') {
    await page.getByLabel('查询').fill('Beta')
    if (await page.locator('#orders tbody tr:visible').count() !== 1
      || !await page.getByText('Beta').isVisible()) throw new Error('TABLE_QUERY_FAILED')
  } else if (scenarioId === 'SCENARIO-FILTER') {
    await page.getByLabel('状态筛选').selectOption('pending')
    await page.getByRole('button', { name: '金额排序' }).click()
    await page.getByRole('button', { name: '下一页' }).click()
    if (await page.locator('#page').textContent() !== '2') throw new Error('PAGINATION_FAILED')
  } else if (scenarioId === 'SCENARIO-FORM') {
    await page.getByRole('button', { name: '提交表单' }).click()
    if (!await page.getByText('名称必填').isVisible()) throw new Error('VALIDATION_MISSING')
    await page.getByLabel('名称').fill('Cooper')
    await page.getByRole('button', { name: '提交表单' }).click()
    if (!await page.getByText('已提交 Cooper').isVisible()) throw new Error('FORM_SUBMIT_FAILED')
  } else if (scenarioId === 'SCENARIO-OVERLAY') {
    await page.getByRole('button', { name: '打开弹窗' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认' }).click()
    await page.getByRole('button', { name: '打开抽屉' }).click()
    if (!await page.getByText('抽屉内容').isVisible()) throw new Error('DRAWER_FAILED')
  } else if (scenarioId === 'SCENARIO-RICH-INPUT') {
    await page.getByLabel('日期').fill('2026-08-09')
    await page.getByLabel('省份').selectOption('zhejiang')
    await page.getByLabel('城市').selectOption('hangzhou')
    await page.locator('#editor').fill('富文本验收')
    if (await page.locator('#editor').textContent() !== '富文本验收') throw new Error('RICH_INPUT_FAILED')
  } else if (scenarioId === 'SCENARIO-FILE') {
    const upload = join(evidenceDirectory, 'upload.txt')
    await writeFile(upload, 'upload-content', { mode: 0o600 })
    await page.getByLabel('上传文件').setInputFiles(upload)
    if (await page.locator('#upload-name').textContent() !== 'upload.txt') throw new Error('UPLOAD_FAILED')
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: '下载文件' }).click()
    const download = await downloadPromise
    const downloaded = join(evidenceDirectory, 'download.txt')
    await download.saveAs(downloaded)
    if (await readFile(downloaded, 'utf8') !== 'download-content') throw new Error('DOWNLOAD_FAILED')
  } else if (scenarioId === 'SCENARIO-ROLE') {
    await page.getByLabel('角色').selectOption('viewer')
    if (!await page.getByRole('button', { name: '审批', exact: true }).isDisabled()) throw new Error('VIEWER_PERMISSION_FAILED')
    await page.getByLabel('角色').selectOption('admin')
    if (await page.getByRole('button', { name: '审批', exact: true }).isDisabled()) throw new Error('ADMIN_PERMISSION_FAILED')
  } else if (scenarioId === 'SCENARIO-WORKFLOW') {
    await page.getByRole('button', { name: '创建记录' }).click()
    await page.getByRole('button', { name: '编辑记录' }).click()
    await page.getByRole('button', { name: '审批记录' }).click()
    if (await page.locator('#workflow-state').textContent() !== 'approved') throw new Error('WORKFLOW_FAILED')
    await page.getByRole('button', { name: '删除记录' }).click()
    if (await page.locator('#workflow-state').textContent() !== 'empty') throw new Error('DELETE_FAILED')
  } else if (scenarioId === 'SCENARIO-MULTIPAGE') {
    const frame = page.frameLocator('#child-frame')
    if (!await frame.getByText('iframe ready').isVisible()) throw new Error('IFRAME_FAILED')
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('link', { name: '打开新页面' }).click()
    const popup = await popupPromise
    await popup.waitForURL('**/?popup=ready&case=*')
    await popup.close()
    await page.getByRole('button', { name: '异步加载' }).click()
    await page.getByText('ready:3').waitFor()
  } else if (scenarioId === 'SCENARIO-CLEANUP') {
    await page.getByRole('button', { name: '准备数据' }).click()
    await page.getByRole('button', { name: '清理数据' }).click()
    await page.reload()
    if (await page.locator('#fixture-state').textContent() !== 'clean') throw new Error('CLEANUP_RELOAD_FAILED')
  } else if (scenarioId === 'SCENARIO-EVIDENCE') {
    await page.getByRole('button', { name: '异步加载' }).click()
    await page.getByText('ready:3').waitFor()
    if (!page.url().startsWith('http://127.0.0.1:')) {
      throw new Error('EVIDENCE_ASSERTION_FAILED')
    }
  } else if (scenarioId === 'SCENARIO-COMPONENT') {
    await page.getByLabel('标准组件选择').selectOption('a')
    await page.locator('.ant-select').click()
    await page.locator('.el-select').click()
    if (await page.locator('#component-result').textContent() !== 'standard-ant-element') {
      throw new Error('COMPONENT_FALLBACK_FAILED')
    }
  } else throw new Error('SCENARIO_UNKNOWN')
}

function code(cause: unknown): string {
  const candidate = cause instanceof Error ? cause.message : String(cause)
  const normalized = candidate.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 128)
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(normalized) ? normalized : 'SCENARIO_EXECUTION_FAILED'
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function markdown(proof: ReturnType<typeof createB2BCoverageProof>): string {
  const categories = Object.entries(proof.categoryResults)
    .map(([name, result]) => `| ${name} | ${result.passed}/${result.total} | ${result.passRate}% |`)
    .join('\n')
  const runtimeChain = Object.entries(proof.runtimeChain)
    .map(([name, connected]) => `| ${name} | ${connected ? '已接通' : '未接通'} |`)
    .join('\n')
  const reasons = proof.gateIneligibleReasons.length === 0
    ? '无'
    : proof.gateIneligibleReasons.map((reason) => `\`${reason}\``).join('、')
  return `# B 端 E2E 场景覆盖证明\n\n- 加权覆盖率：${proof.weightedCoverage}%\n- 能力支持率：${proof.capabilitySupportRate}%\n- 端到端成功率：${proof.endToEndSuccessRate}%\n- 误漏报率：${proof.falseNegativeRate}%\n- Flaky rate：${proof.flakyRate}%\n- 覆盖证明通过：${proof.passed}\n- 门禁资格：${proof.gateEligible}\n- 门禁未满足原因：${reasons}\n- Proof digest：${proof.proofDigest}\n\n## Runtime 执行链\n\n| 组件 | 状态 |\n| --- | --- |\n${runtimeChain}\n\n## 场景覆盖\n\n| 类别 | 通过 | 通过率 |\n| --- | ---: | ---: |\n${categories}\n`
}

function appHtml(caseId: string): string {
  const caseQuery = encodeURIComponent(caseId)
  return String.raw`<!doctype html><html><head><meta charset="utf-8"><title>B2B E2E Benchmark</title></head>
<body><h1>B2B E2E Benchmark</h1><label>查询<input aria-label="查询" id="query"></label>
<label>状态筛选<select aria-label="状态筛选" id="filter"><option value="all">全部</option><option value="pending">待处理</option></select></label>
<button id="sort">金额排序</button><button id="next">下一页</button><span id="page">1</span>
<table id="orders"><tbody><tr data-status="pending"><td>Alpha</td><td>20</td></tr><tr data-status="done"><td>Beta</td><td>10</td></tr><tr data-status="pending"><td>Gamma</td><td>30</td></tr></tbody></table>
<label>名称<input aria-label="名称" id="name"></label><button id="submit">提交表单</button><span id="form-result"></span>
<button id="open-modal">打开弹窗</button><dialog id="modal"><p>弹窗内容</p><button id="confirm-modal">确认</button></dialog>
<button id="open-drawer">打开抽屉</button><aside id="drawer" hidden>抽屉内容</aside>
<label>日期<input aria-label="日期" id="date" type="date"></label>
<label>省份<select aria-label="省份" id="province"><option value="zhejiang">浙江</option></select></label>
<label>城市<select aria-label="城市" id="city"><option value="hangzhou">杭州</option></select></label>
<div id="editor" contenteditable="true" aria-label="富文本"></div>
<label>上传文件<input aria-label="上传文件" id="upload" type="file"></label><span id="upload-name"></span>
<a download="download.txt" href="data:text/plain,download-content">下载文件</a>
<label>角色<select aria-label="角色" id="role"><option value="viewer">viewer</option><option value="admin">admin</option></select></label><button id="approve" disabled>审批</button>
<button id="create">创建记录</button><button id="edit">编辑记录</button><button id="approve-record">审批记录</button><button id="delete">删除记录</button><span id="workflow-state">empty</span>
<iframe id="child-frame" srcdoc="<p>iframe ready</p>"></iframe><a target="_blank" href="/?popup=ready&case=${caseQuery}">打开新页面</a>
<button id="async">异步加载</button><span id="async-result"></span>
<button id="prepare">准备数据</button><button id="cleanup">清理数据</button><span id="fixture-state">clean</span>
<label>标准组件选择<select aria-label="标准组件选择" id="standard"><option value="a">A</option></select></label>
<button class="ant-select">Ant Select</button><button class="el-select">Element Select</button><span id="component-result"></span>
<script>
console.log('benchmark-ready');
query.oninput=()=>[...document.querySelectorAll('#orders tr')].forEach(r=>r.hidden=!r.textContent.includes(query.value));
filter.onchange=()=>[...document.querySelectorAll('#orders tr')].forEach(r=>r.hidden=filter.value!=='all'&&r.dataset.status!==filter.value);
sort.onclick=()=>[...orders.tBodies[0].rows].sort((a,b)=>+a.cells[1].textContent-+b.cells[1].textContent).forEach(r=>orders.tBodies[0].append(r));
next.onclick=()=>page.textContent='2'; submit.onclick=()=>formResult(document.querySelector('#name').value); function formResult(v){document.querySelector('#form-result').textContent=v?'已提交 '+v:'名称必填'}
openModal=()=>modal.showModal(); document.querySelector('#open-modal').onclick=openModal; document.querySelector('#confirm-modal').onclick=()=>modal.close();
document.querySelector('#open-drawer').onclick=()=>drawer.hidden=false; upload.onchange=()=>document.querySelector('#upload-name').textContent=upload.files[0].name;
role.onchange=()=>approve.disabled=role.value!=='admin'; create.onclick=()=>workflowState('created'); edit.onclick=()=>workflowState('edited'); approveRecord=()=>workflowState('approved');
document.querySelector('#approve-record').onclick=approveRecord; document.querySelector('#delete').onclick=()=>workflowState('empty'); function workflowState(v){document.querySelector('#workflow-state').textContent=v}
document.querySelector('#async').onclick=async()=>{const x=await fetch('/api/data?case=${caseQuery}').then(r=>r.json());document.querySelector('#async-result').textContent=x.status+':'+x.count};
prepare.onclick=()=>{localStorage.fixture='dirty';document.querySelector('#fixture-state').textContent='dirty'}; cleanup.onclick=()=>{localStorage.removeItem('fixture');document.querySelector('#fixture-state').textContent='clean'};
document.querySelector('#fixture-state').textContent=localStorage.fixture?'dirty':'clean'; let component=''; standard.onchange=()=>{component='standard-';render()};
document.querySelector('.ant-select').onclick=()=>{component+='ant-';render()};document.querySelector('.el-select').onclick=()=>{component+='element';render()};function render(){document.querySelector('#component-result').textContent=component}
</script></body></html>`
}
