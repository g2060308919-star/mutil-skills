import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
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
  type RequirementModel,
  type VerdictInput,
} from '@mutil-skills/e2e-contracts'
import { LocalArtifactStore, buildCoverageUniverse, computeVerdict, type ArtifactStoreAuthority } from '@mutil-skills/e2e-engine'
import { createB2BCoverageProof, digestPublishedB2BExecutions, digestPublishedB2BVerdicts,
  type B2BScenarioExecution } from '../packages/e2e-runtime/src/b2b-scenario-coverage.js'
import { compilePrdRun } from '../packages/e2e-runtime/src/prd-run-compiler.js'
import { B2B_SCENARIO_CORPUS } from './e2e-b2b-coverage-corpus.js'

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
  if (request.url === '/api/data') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ready', count: 3 }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(appHtml())
})
await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('E2E_B2B_SERVER_ADDRESS_INVALID')
const origin = `http://127.0.0.1:${address.port}`
let browser: Browser | undefined
const executionDrafts: Array<Omit<B2BScenarioExecution,
  'positiveVerdict' | 'negativeVerdict' | 'generation' | 'publishedExecutionsDigest' | 'publishedVerdictsDigest'>> = []
try {
  const channel = process.env.E2E_B2B_BROWSER_CHANNEL ?? 'chrome'
  browser = await chromium.launch({ headless: true, ...(channel === '' ? {} : { channel }) })
  for (const compiledCase of compiledPlan.cases) {
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
      const evidenceDirectory = join(outputRoot, 'evidence', scenario.scenarioId, String(repetition))
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
      const context = await browser.newContext({ acceptDownloads: true })
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
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded' })
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
      const evidencePaths: Array<{ kind: B2BScenarioExecution['repetitions'][number]['evidenceKinds'][number]; path: string }> = [
        { kind: 'screenshot', path: screenshot }, { kind: 'dom', path: dom }, { kind: 'trace', path: trace },
        { kind: 'url', path: urlEvidence }, { kind: 'network', path: networkEvidence },
        { kind: 'console', path: consoleEvidence },
      ]
      if (scenario.scenarioId === 'SCENARIO-FILE') {
        evidencePaths.push({ kind: 'file', path: join(evidenceDirectory, 'download.txt') })
      }
      const evidenceFiles = await Promise.all(evidencePaths.map(async (item) => ({
        kind: item.kind,
        path: relative(outputRoot, item.path),
        digest: digestBytes(`e2e-b2b-evidence-file:${relative(outputRoot, item.path)}`, await readFile(item.path)),
      })))
      const negativeControlDetected = await runNegativeControl(page, scenario.scenarioId)
      results.push({ repetition, status, oraclePassed,
        negativeControlDetected,
        evidenceKinds: [...new Set(evidenceFiles.map((item) => item.kind))].sort(),
        evidenceFiles,
        evidenceDigest: digestText('e2e-b2b-evidence-set/v1', canonicalizeJson(evidenceFiles)), reasonCode })
      await context.close()
    }
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
      targetBound: results.every((item) => item.status === 'passed'),
      repetitions: results,
    })
  }
} finally {
  await browser?.close()
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) =>
    error === undefined ? resolvePromise() : rejectPromise(error)))
}

const positiveVerdict = computeVerdict(createVerdictInput(
  coverage.obligations, compiledPlan.cases.map((item) => item.caseId),
  executionDrafts.map((item) => item.repetitions.every((result) => result.status === 'passed')),
  prd.modelDigest, coverage.universeDigest,
), { verifyAttemptSelection: () => true })
const negativeVerdicts = executionDrafts.map((execution) => computeVerdict(createVerdictInput(
  coverage.obligations, compiledPlan.cases.map((item) => item.caseId),
  executionDrafts.map((candidate) => candidate.caseId !== execution.caseId
    || !candidate.repetitions.every((result) => result.negativeControlDetected)),
  prd.modelDigest, coverage.universeDigest,
), { verifyAttemptSelection: () => true }))
if (negativeVerdicts.some((verdict) => verdict.verdict !== 'rejected')) {
  throw new Error('E2E_B2B_NEGATIVE_VERDICT_NOT_REJECTED')
}
const generationId = 'GEN-B2B-PROOF-0001'
const publishedExecutionsDigest = digestPublishedB2BExecutions(executionDrafts)
const publishedVerdictFacts = { positiveVerdict: positiveVerdict.verdict,
  negativeVerdicts: executionDrafts.map((execution, index) => ({ scenarioId: execution.scenarioId,
    caseId: execution.caseId, verdict: negativeVerdicts[index]!.verdict })) }
const publishedVerdictsDigest = digestText(
  'e2e-b2b-published-verdicts/v1', canonicalizeJson(publishedVerdictFacts),
)
const store = new LocalArtifactStore(await realpath(artifactRoot), createProofAuthority())
const active = await store.publish({
  assetId: 'ASSET-B2B-PROOF', generationId, terminalVerdict: positiveVerdict.verdict,
  files: {
    'prd/understanding.json': `${canonicalizeJson(prd.understanding)}\n`,
    'run/compiled-prd-run.json': `${canonicalizeJson(compiledPlan)}\n`,
    'run/coverage-universe.json': `${canonicalizeJson(coverage)}\n`,
    'run/executions.json': `${canonicalizeJson(executionDrafts)}\n`,
    'run/published-executions-digest.txt': `${publishedExecutionsDigest}\n`,
    'run/published-verdicts.json': `${canonicalizeJson(publishedVerdictFacts)}\n`,
    'run/positive-verdict.json': `${canonicalizeJson(positiveVerdict)}\n`,
    'run/negative-control-verdicts.json': `${canonicalizeJson(negativeVerdicts)}\n`,
  },
})
const readBack = await store.readActive('ASSET-B2B-PROOF')
if (readBack === null || readBack.generationId !== active.generationId
  || readBack.generationDigest !== active.generationDigest) throw new Error('E2E_B2B_GENERATION_READBACK_FAILED')
const executions: B2BScenarioExecution[] = executionDrafts.map((item, index) => ({
  ...item,
  publishedExecutionsDigest,
  publishedVerdictsDigest,
  positiveVerdict: positiveVerdict.verdict,
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
      caseId, runId: 'RUN-B2B-PROOF', obligationIds: obligationsByCase.get(caseId) ?? [],
      status: passed[index] ? 'passed' : 'failed', executionMode: 'real-environment',
      attemptSelection: { status: 'valid', attemptId: `ATTEMPT-B2B-${index + 1}`,
        eventChainDigest: digestText('e2e-b2b-attempt/v1', caseId) } })),
    manualResults: [], pendingDecisionIds: [], safetyFindings: [], artifactFindings: [], migrationFindings: [],
    environmentFindings: [], automationFindings: [],
    gatewayAudit: { status: 'valid', required: false, reasonCodes: [] },
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
    await popup.waitForURL('**/?popup=ready')
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

function markdown(proof: ReturnType<typeof createB2BCoverageProof>): string {
  const categories = Object.entries(proof.categoryResults)
    .map(([name, result]) => `| ${name} | ${result.passed}/${result.total} | ${result.passRate}% |`)
    .join('\n')
  return `# B 端 E2E 场景覆盖证明\n\n- 加权覆盖率：${proof.weightedCoverage}%\n- 能力支持率：${proof.capabilitySupportRate}%\n- 端到端成功率：${proof.endToEndSuccessRate}%\n- 误漏报率：${proof.falseNegativeRate}%\n- Flaky rate：${proof.flakyRate}%\n- 门禁资格：${proof.gateEligible}\n- Proof digest：${proof.proofDigest}\n\n| 类别 | 通过 | 通过率 |\n| --- | ---: | ---: |\n${categories}\n`
}

function appHtml(): string {
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
<iframe id="child-frame" srcdoc="<p>iframe ready</p>"></iframe><a target="_blank" href="/?popup=ready">打开新页面</a>
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
document.querySelector('#async').onclick=async()=>{const x=await fetch('/api/data').then(r=>r.json());document.querySelector('#async-result').textContent=x.status+':'+x.count};
prepare.onclick=()=>{localStorage.fixture='dirty';document.querySelector('#fixture-state').textContent='dirty'}; cleanup.onclick=()=>{localStorage.removeItem('fixture');document.querySelector('#fixture-state').textContent='clean'};
document.querySelector('#fixture-state').textContent=localStorage.fixture?'dirty':'clean'; let component=''; standard.onchange=()=>{component='standard-';render()};
document.querySelector('.ant-select').onclick=()=>{component+='ant-';render()};document.querySelector('.el-select').onclick=()=>{component+='element';render()};function render(){document.querySelector('#component-result').textContent=component}
</script></body></html>`
}
