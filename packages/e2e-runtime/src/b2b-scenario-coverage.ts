import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import { isRuntimeEvidenceUri } from './evidence-reference.js'

const Id = z.string().min(1).max(128).regex(/^[A-Z0-9._:-]+$/)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Verdict = z.enum(['accepted', 'rejected', 'incomplete', 'environment-blocked', 'automation-blocked',
  'safety-blocked', 'artifact-blocked', 'migration-required', 'pending-decision'])

export const B2BScenarioCategorySchema = z.enum([
  'table-query', 'filter-sort-pagination', 'form-validation', 'modal-drawer',
  'date-cascade-richtext', 'upload-download', 'authentication-authorization',
  'crud-workflow', 'iframe-multipage-async', 'data-cleanup', 'evidence-assertions',
  'component-adapters',
])

export const B2BScenarioDefinitionSchema = z.object({
  scenarioId: Id,
  category: B2BScenarioCategorySchema,
  title: z.string().min(1).max(256),
  weight: z.number().int().min(1).max(10),
  required: z.literal(true),
  minimumPassRate: z.number().min(0.5).max(1),
  requiredEvidenceKinds: z.array(z.enum([
    'screenshot', 'dom', 'trace', 'url', 'network', 'console', 'file',
  ])).min(1),
}).strict()

const RepetitionSchema = z.object({
  repetition: z.number().int().positive(),
  runId: Id,
  attemptId: Id,
  status: z.enum(['passed', 'failed', 'skipped']),
  oraclePassed: z.boolean(),
  negativeControlDetected: z.boolean(),
  evidenceKinds: z.array(z.enum([
    'screenshot', 'dom', 'trace', 'url', 'network', 'console', 'file',
  ])),
  evidenceDigest: Digest.nullable(),
  evidenceFiles: z.array(z.object({
    kind: z.enum(['screenshot', 'dom', 'trace', 'url', 'network', 'console', 'file']),
    path: z.string().min(1).max(512),
    digest: Digest,
  }).strict()).min(1),
  reasonCode: z.string().min(1).max(128).regex(/^[A-Z0-9._-]+$/).nullable(),
}).strict()

export const B2BScenarioExecutionSchema = z.object({
  scenarioId: Id,
  requirementId: Id,
  ruleIds: z.array(Id).min(1),
  oracleIds: z.array(Id).min(1),
  caseId: Id,
  compiledPlanDigest: Digest,
  publishedExecutionsDigest: Digest,
  publishedVerdictsDigest: Digest,
  positiveVerdict: Verdict,
  positiveVerdicts: z.array(z.object({ runId: Id, verdict: Verdict, verdictDigest: Digest })
    .strict()).min(2).max(20),
  negativeVerdict: Verdict,
  generation: z.object({
    expectedId: Id,
    activeId: Id,
    activeDigest: Digest,
  }).strict(),
  targetBound: z.boolean(),
  repetitions: z.array(RepetitionSchema).min(2).max(20),
}).strict()

export type B2BScenarioDefinition = z.infer<typeof B2BScenarioDefinitionSchema>
export type B2BScenarioExecution = z.infer<typeof B2BScenarioExecutionSchema>

export interface B2BCoverageProof {
  schemaVersion: '1.0.0'
  proofKind: 'browser-capability'
  corpusDigest: string
  executionsDigest: string
  scenarioCount: number
  categoryCount: number
  capabilitySupportRate: number
  endToEndSuccessRate: number
  weightedCoverage: number
  falseNegativeRate: number
  flakyRate: number
  categoryResults: Record<string, { passed: number; total: number; passRate: number; minimumPassRate: number }>
  runtimeChain: { scheduler: boolean; authority: boolean; gateway: boolean; browserExecutor: boolean }
  failures: Array<{ scenarioId: string; reasonCode: string }>
  passed: boolean
  gateEligible: boolean
  gateIneligibleReasons: string[]
  proofDigest: string
}

declare const b2bRuntimeChainProofBrand: unique symbol
export interface B2BRuntimeChainProofV1 {
  readonly [b2bRuntimeChainProofBrand]: true
}

interface B2BRuntimeChainFactsV1 {
  binding: { corpusDigest: string; executionsDigest: string; generationDigest: string }
  expected: Array<{ runId: string; caseId: string; actionId: string; attemptId: string }>
  scheduler: Array<{ runId: string; caseId: string; attemptId: string }>
  authority: Array<{ runId: string; caseId: string; attemptId: string; eventChainDigest: string;
    terminalOutcomeDigest: string }>
  gateway: Array<{ runId: string; caseId: string; actionId: string; attemptId: string;
    terminalOutcomeDigest: string }>
  browserExecutions: Array<{ runId: string; caseId: string; actionId: string; attemptId: string; outcomeDigest: string;
    evidenceReferences: Array<{ kind: string; uri: string; digest: string }> }>
}

const runtimeChainProofs = new WeakMap<object, {
  runtimeChain: B2BCoverageProof['runtimeChain']
  binding: B2BRuntimeChainFactsV1['binding']
}>()

/** 仓库内 Verification Harness 用事实集合推导链路结果；不从 package root 导出。 */
export function verifyB2BRuntimeChainFactsV1(input: B2BRuntimeChainFactsV1): B2BRuntimeChainProofV1 {
  const binding = z.object({ corpusDigest: Digest, executionsDigest: Digest, generationDigest: Digest })
    .strict().parse(input.binding)
  const expected = z.array(z.object({ runId: Id, caseId: Id, actionId: Id, attemptId: Id })
    .strict()).min(1).parse(input.expected)
  const scheduler = z.array(z.object({ runId: Id, caseId: Id, attemptId: Id }).strict()).parse(input.scheduler)
  const authority = z.array(z.object({ runId: Id, caseId: Id, attemptId: Id,
    eventChainDigest: Digest, terminalOutcomeDigest: Digest }).strict())
    .parse(input.authority)
  const gateway = z.array(z.object({ runId: Id, caseId: Id, actionId: Id, attemptId: Id,
    terminalOutcomeDigest: Digest }).strict())
    .parse(input.gateway)
  const browserExecutions = z.array(z.object({ runId: Id, caseId: Id, actionId: Id, attemptId: Id,
    outcomeDigest: Digest, evidenceReferences: z.array(z.object({
      kind: z.enum(['screenshot', 'dom', 'trace', 'gateway-audit', 'diagnostics']),
      uri: z.string().refine(isRuntimeEvidenceUri), digest: Digest,
    }).strict()).min(1) }).strict()).parse(input.browserExecutions)
  const attemptIdentity = (item: { runId: string; caseId: string; attemptId: string }) =>
    canonicalizeJson({ runId: item.runId, caseId: item.caseId, attemptId: item.attemptId })
  const actionIdentity = (item: { runId: string; caseId: string; actionId: string; attemptId: string }) =>
    canonicalizeJson({ runId: item.runId, caseId: item.caseId,
      actionId: item.actionId, attemptId: item.attemptId })
  const exactBindings = (actual: Array<{ runId: string; caseId: string; attemptId: string }>) => {
    const expectedKeys = expected.map(attemptIdentity)
    const actualKeys = actual.map(attemptIdentity)
    return new Set(expectedKeys).size === expectedKeys.length
      && new Set(actualKeys).size === actualKeys.length
      && actualKeys.length === expectedKeys.length
      && expectedKeys.every((item) => actualKeys.includes(item))
  }
  const exactActionBindings = (actual: Array<{
    runId: string; caseId: string; actionId: string; attemptId: string
  }>) => {
    const expectedKeys = expected.map(actionIdentity)
    const actualKeys = actual.map(actionIdentity)
    return new Set(expectedKeys).size === expectedKeys.length
      && new Set(actualKeys).size === actualKeys.length
      && actualKeys.length === expectedKeys.length
      && expectedKeys.every((item) => actualKeys.includes(item))
  }
  const runtimeChain = {
    scheduler: exactBindings(scheduler),
    authority: exactBindings(authority) && expected.every((item) => {
      const browser = browserExecutions.find((candidate) => actionIdentity(candidate) === actionIdentity(item))
      const terminalDigest = browser === undefined ? undefined
        : digestText('e2e-b2b-attempt-outcome/v1', browser.outcomeDigest)
      return authority.some((candidate) => attemptIdentity(candidate) === attemptIdentity(item)
        && candidate.terminalOutcomeDigest === terminalDigest)
    }),
    gateway: exactActionBindings(gateway) && expected.every((item) => {
      const browser = browserExecutions.find((candidate) => actionIdentity(candidate) === actionIdentity(item))
      const terminalDigest = browser === undefined ? undefined
        : digestText('e2e-b2b-attempt-outcome/v1', browser.outcomeDigest)
      return gateway.some((candidate) => actionIdentity(candidate) === actionIdentity(item)
        && candidate.terminalOutcomeDigest === terminalDigest)
    }),
    browserExecutor: exactActionBindings(browserExecutions) && expected.every((item) => {
      const executions = browserExecutions.filter((candidate) => candidate.runId === item.runId
        && candidate.caseId === item.caseId && candidate.attemptId === item.attemptId)
      return executions.length === 1 && executions.every((candidate) =>
        candidate.actionId === item.actionId
        && ['screenshot', 'dom', 'trace'].every((kind) => candidate.evidenceReferences.some((reference) =>
          reference.kind === kind)))
    }),
  }
  const proof = Object.freeze({}) as B2BRuntimeChainProofV1
  runtimeChainProofs.set(proof, { runtimeChain, binding })
  return proof
}

export function digestPublishedB2BExecutions(executions: readonly Record<string, unknown>[]): string {
  return digestText('e2e-b2b-published-executions/v1', canonicalizeJson(executions.map((execution) => {
    const { positiveVerdict: _positiveVerdict, positiveVerdicts: _positiveVerdicts,
      negativeVerdict: _negativeVerdict,
      generation: _generation, publishedExecutionsDigest: _publishedExecutionsDigest,
      publishedVerdictsDigest: _publishedVerdictsDigest, ...published } = execution
    return published
  })))
}

export function digestPublishedB2BVerdicts(executions: readonly B2BScenarioExecution[]): string {
  const positive = [...new Set(executions.map((execution) => execution.positiveVerdict))]
  if (positive.length !== 1) throw coverageError('E2E_B2B_POSITIVE_VERDICT_INCONSISTENT')
  const publishedSets = [...new Set(executions.map((execution) => canonicalizeJson(execution.positiveVerdicts)))]
  if (publishedSets.length !== 1) throw coverageError('E2E_B2B_POSITIVE_VERDICTS_INCONSISTENT')
  const positiveVerdicts = executions[0]?.positiveVerdicts ?? []
  if (new Set(positiveVerdicts.map((item) => item.runId)).size !== positiveVerdicts.length
    || positiveVerdicts.some((item) => item.verdict !== positive[0])) {
    throw coverageError('E2E_B2B_POSITIVE_VERDICTS_INVALID')
  }
  return digestText('e2e-b2b-published-verdicts/v1', canonicalizeJson({
    positiveVerdict: positive[0],
    positiveVerdicts,
    negativeVerdicts: executions.map((execution) => ({ scenarioId: execution.scenarioId,
      caseId: execution.caseId, verdict: execution.negativeVerdict })),
  }))
}

export function createB2BCoverageProof(input: {
  corpus: B2BScenarioDefinition[]
  executions: B2BScenarioExecution[]
  environmentEligible: boolean
  runtimeChainProof: B2BRuntimeChainProofV1
}): B2BCoverageProof {
  const corpus = z.array(B2BScenarioDefinitionSchema).min(1).parse(input.corpus)
  const executions = z.array(B2BScenarioExecutionSchema).parse(input.executions)
  const corpusDigest = digestText('e2e-b2b-scenario-corpus/v1', canonicalizeJson(corpus))
  const executionsDigest = digestText('e2e-b2b-scenario-executions/v1', canonicalizeJson(executions))
  if (new Set(corpus.map((item) => item.scenarioId)).size !== corpus.length
    || new Set(executions.map((item) => item.scenarioId)).size !== executions.length) {
    throw coverageError('E2E_B2B_SCENARIO_ID_DUPLICATED')
  }
  const executionById = new Map(executions.map((item) => [item.scenarioId, item]))
  const publishedExecutionsDigest = digestPublishedB2BExecutions(executions)
  const publishedVerdictsDigest = digestPublishedB2BVerdicts(executions)
  if (executions.some((item) => !corpus.some((scenario) => scenario.scenarioId === item.scenarioId))) {
    throw coverageError('E2E_B2B_EXECUTION_OUTSIDE_CORPUS')
  }
  const failures: B2BCoverageProof['failures'] = []
  let supportedWeight = 0
  let passedWeight = 0
  let falseNegatives = 0
  let repetitionCount = 0
  let flakyScenarios = 0
  const categoryAccumulator = new Map<string, { passed: number; total: number; minimumPassRate: number }>()
  for (const scenario of corpus) {
    const execution = executionById.get(scenario.scenarioId)
    const category = categoryAccumulator.get(scenario.category)
      ?? { passed: 0, total: 0, minimumPassRate: scenario.minimumPassRate }
    category.total += 1
    category.minimumPassRate = Math.max(category.minimumPassRate, scenario.minimumPassRate)
    categoryAccumulator.set(scenario.category, category)
    if (execution === undefined) {
      failures.push({ scenarioId: scenario.scenarioId, reasonCode: 'EXECUTION_MISSING' })
      continue
    }
    supportedWeight += scenario.weight
    repetitionCount += execution.repetitions.length
    falseNegatives += execution.repetitions.filter((item) => !item.negativeControlDetected).length
    const statuses = new Set(execution.repetitions.map((item) => item.status))
    const flaky = statuses.size > 1
      || new Set(execution.repetitions.map((item) => item.oraclePassed)).size > 1
    if (flaky) flakyScenarios += 1
    const generationMatched = execution.generation.expectedId === execution.generation.activeId
    const evidenceComplete = scenario.requiredEvidenceKinds.every((kind) =>
      execution.repetitions.every((item) => item.evidenceKinds.includes(kind) && item.evidenceDigest !== null
        && item.evidenceFiles.some((file) => file.kind === kind)))
      && execution.repetitions.every((item) => item.evidenceDigest === digestText(
        'e2e-b2b-evidence-set/v1', canonicalizeJson(item.evidenceFiles),
      ))
    const generationBound = execution.publishedExecutionsDigest === publishedExecutionsDigest
      && execution.publishedVerdictsDigest === publishedVerdictsDigest
    const closed = generationMatched && generationBound && execution.targetBound && evidenceComplete && !flaky
      && execution.positiveVerdict === 'accepted'
      && execution.positiveVerdicts.length === execution.repetitions.length
      && execution.positiveVerdicts.every((item) => item.verdict === 'accepted'
        && execution.repetitions.some((repetition) => repetition.runId === item.runId))
      && execution.negativeVerdict === 'rejected'
      && execution.repetitions.every((item) => item.status === 'passed'
        && item.oraclePassed && item.negativeControlDetected && item.reasonCode === null)
    if (closed) {
      passedWeight += scenario.weight
      category.passed += 1
    } else {
      const reasonCode = !generationMatched ? 'GENERATION_MISMATCH'
        : !generationBound ? 'PUBLISHED_EXECUTIONS_MISMATCH'
          : !execution.targetBound ? 'TARGET_BINDING_FAILED'
          : !evidenceComplete ? 'EVIDENCE_INCOMPLETE'
            : execution.positiveVerdict !== 'accepted' ? 'POSITIVE_VERDICT_NOT_ACCEPTED'
              : execution.negativeVerdict !== 'rejected' ? 'NEGATIVE_CONTROL_NOT_REJECTED'
            : flaky ? 'FLAKY_RESULT' : execution.repetitions.some((item) => item.status === 'skipped')
              ? 'EXECUTION_SKIPPED' : 'ORACLE_OR_NEGATIVE_CONTROL_FAILED'
      failures.push({ scenarioId: scenario.scenarioId, reasonCode })
    }
  }
  const totalWeight = corpus.reduce((sum, item) => sum + item.weight, 0)
  const categoryResults = Object.fromEntries([...categoryAccumulator.entries()].sort(([left], [right]) =>
    left.localeCompare(right)).map(([name, result]) => [name, {
      ...result, passRate: round(result.passed / result.total * 100),
    }]))
  const weightedCoverage = round(passedWeight / totalWeight * 100)
  const categoryMinimumsPassed = Object.values(categoryResults).every((result) =>
    result.passed / result.total >= result.minimumPassRate)
  const storedRuntimeChain = runtimeChainProofs.get(input.runtimeChainProof)
  if (storedRuntimeChain === undefined) throw coverageError('E2E_B2B_RUNTIME_CHAIN_PROOF_INVALID')
  const generationDigests = [...new Set(executions.map((item) => item.generation.activeDigest))]
  const bindingMatches = storedRuntimeChain.binding.corpusDigest === corpusDigest
    && storedRuntimeChain.binding.executionsDigest === executionsDigest
    && generationDigests.length === 1
    && storedRuntimeChain.binding.generationDigest === generationDigests[0]
  const runtimeChain = bindingMatches ? storedRuntimeChain.runtimeChain
    : { scheduler: false, authority: false, gateway: false, browserExecutor: false }
  const runtimeChainComplete = Object.values(runtimeChain).every(Boolean)
  const passed = runtimeChainComplete && weightedCoverage >= 90 && categoryMinimumsPassed && falseNegatives === 0
    && flakyScenarios === 0 && failures.length === 0
  const gateIneligibleReasons = [
    ...(!input.environmentEligible ? ['ENVIRONMENT_NOT_APPROVED'] : []),
    ...(!runtimeChainComplete ? ['RUNTIME_CHAIN_INCOMPLETE'] : []),
    ...(!passed ? ['COVERAGE_GATE_FAILED'] : []),
  ]
  const draft = {
    schemaVersion: '1.0.0' as const,
    proofKind: 'browser-capability' as const,
    corpusDigest,
    executionsDigest,
    scenarioCount: corpus.length,
    categoryCount: categoryAccumulator.size,
    capabilitySupportRate: round(supportedWeight / totalWeight * 100),
    endToEndSuccessRate: round(corpus.length === 0 ? 0
      : (corpus.length - failures.length) / corpus.length * 100),
    weightedCoverage,
    falseNegativeRate: round(repetitionCount === 0 ? 100 : falseNegatives / repetitionCount * 100),
    flakyRate: round(corpus.length === 0 ? 100 : flakyScenarios / corpus.length * 100),
    categoryResults,
    runtimeChain,
    failures,
    passed,
    gateEligible: passed && input.environmentEligible,
    gateIneligibleReasons,
  }
  return { ...draft, proofDigest: digestText('e2e-b2b-coverage-proof/v1', canonicalizeJson(draft)) }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function coverageError(code: string): E2EError {
  return new E2EError({ code, category: 'automation', retryable: false, message: code })
}
