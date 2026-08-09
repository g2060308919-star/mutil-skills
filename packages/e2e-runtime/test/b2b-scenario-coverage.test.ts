import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { describe, expect, test } from 'vitest'
import {
  createB2BCoverageProof,
  digestPublishedB2BExecutions,
  digestPublishedB2BVerdicts,
  verifyB2BRuntimeChainFactsV1,
  type B2BScenarioDefinition,
  type B2BScenarioExecution,
} from '../src/b2b-scenario-coverage.js'

const categories = [
  'table-query', 'filter-sort-pagination', 'form-validation', 'modal-drawer',
  'date-cascade-richtext', 'upload-download', 'authentication-authorization',
  'crud-workflow', 'iframe-multipage-async', 'data-cleanup', 'evidence-assertions',
  'component-adapters',
] as const
const corpus: B2BScenarioDefinition[] = categories.map((category, index) => ({
  scenarioId: `SCENARIO-${index + 1}`, category, title: category, weight: index > 7 ? 2 : 1,
  required: true, minimumPassRate: 1, requiredEvidenceKinds: ['screenshot', 'dom'],
}))
const D = digestText('b2b-scenario-test/v1', 'evidence')

function runtimeChainProof(boundExecutions: B2BScenarioExecution[] = executions(),
  options: { omitGatewayAction?: string; rewriteGatewayRun?: string; extraGatewayFact?: boolean;
    duplicateExpected?: boolean; rewriteGatewayOutcome?: string } = {}) {
  const facts = corpus.flatMap((_, index) => [1, 2, 3].map((repetition) => ({
    runId: `RUN-${repetition}`, caseId: `CASE-${index + 1}`, actionId: `ACTION-${index + 1}`,
    attemptId: `ATTEMPT-${index + 1}-R${repetition}` })))
  const expected = facts.map((item, index) => options.duplicateExpected && index === 1 ? facts[0]! : item)
  return verifyB2BRuntimeChainFactsV1({
    binding: {
      corpusDigest: digestText('e2e-b2b-scenario-corpus/v1', canonicalizeJson(corpus)),
      executionsDigest: digestText('e2e-b2b-scenario-executions/v1', canonicalizeJson(boundExecutions)),
      generationDigest: D,
    }, expected,
    scheduler: facts.map(({ runId, caseId, attemptId }) => ({ runId, caseId, attemptId })),
    authority: facts.map(({ runId, caseId, attemptId }) => ({ runId, caseId, attemptId,
      eventChainDigest: D, terminalOutcomeDigest: digestText('e2e-b2b-attempt-outcome/v1', D) })),
    gateway: [...facts.filter((item) => item.actionId !== options.omitGatewayAction)
      .map(({ runId, caseId, actionId, attemptId }) => ({
        runId: actionId === options.rewriteGatewayRun ? 'RUN-WRONG' : runId,
        caseId, actionId, attemptId, terminalOutcomeDigest: actionId === options.rewriteGatewayOutcome
          ? digestText('e2e-b2b-attempt-outcome/v1', 'wrong')
          : digestText('e2e-b2b-attempt-outcome/v1', D),
      })), ...(options.extraGatewayFact ? [{ runId: 'RUN-EXTRA', caseId: 'CASE-EXTRA',
        actionId: 'ACTION-EXTRA', attemptId: 'ATTEMPT-EXTRA',
        terminalOutcomeDigest: digestText('e2e-b2b-attempt-outcome/v1', D) }] : [])],
    browserExecutions: facts.map((item) => ({
      runId: item.runId, caseId: item.caseId, actionId: item.actionId,
      attemptId: item.attemptId, outcomeDigest: D,
      evidenceReferences: ['screenshot', 'dom', 'trace'].map((kind) => ({ kind,
        uri: `artifact://generation/${item.caseId}/${kind}`, digest: D })),
    })),
  })
}

function executions(): B2BScenarioExecution[] {
  const drafts = corpus.map((scenario, index) => ({
    scenarioId: scenario.scenarioId, requirementId: `REQ-${index + 1}`, ruleIds: [`RULE-${index + 1}`],
    oracleIds: [`ORACLE-${index + 1}`], caseId: `CASE-${index + 1}`,
    compiledPlanDigest: D,
    generation: { expectedId: 'GEN-1', activeId: 'GEN-1', activeDigest: D }, targetBound: true,
    repetitions: [1, 2, 3].map((repetition) => ({ repetition, runId: `RUN-${repetition}`,
      attemptId: `ATTEMPT-${index + 1}-R${repetition}`, status: 'passed' as const,
      oraclePassed: true, negativeControlDetected: true,
      evidenceKinds: ['screenshot' as const, 'dom' as const],
      evidenceFiles: [{ kind: 'screenshot' as const, path: 'evidence.png', digest: D },
        { kind: 'dom' as const, path: 'evidence.html', digest: D }],
      evidenceDigest: digestText('e2e-b2b-evidence-set/v1', canonicalizeJson([
        { digest: D, kind: 'screenshot', path: 'evidence.png' },
        { digest: D, kind: 'dom', path: 'evidence.html' },
      ])), reasonCode: null })),
  }))
  const publishedExecutionsDigest = digestPublishedB2BExecutions(drafts)
  const partial = drafts.map((draft) => ({ ...draft, publishedExecutionsDigest,
    publishedVerdictsDigest: D, positiveVerdict: 'accepted' as const,
    positiveVerdicts: [1, 2, 3].map((repetition) => ({ runId: `RUN-${repetition}`,
      verdict: 'accepted' as const, verdictDigest: D })), negativeVerdict: 'rejected' as const }))
  const publishedVerdictsDigest = digestPublishedB2BVerdicts(partial)
  return partial.map((execution) => ({ ...execution, publishedVerdictsDigest }))
}

describe('B 端场景覆盖证明', () => {
  test('只有全部类别真实闭环且环境登记后才可作为 90% 门禁', () => {
    expect(createB2BCoverageProof({ corpus, executions: executions(), environmentEligible: true,
      runtimeChainProof: runtimeChainProof() }))
      .toMatchObject({ weightedCoverage: 100, capabilitySupportRate: 100,
        endToEndSuccessRate: 100, falseNegativeRate: 0, flakyRate: 0, passed: true, gateEligible: true })
  })

  test('缺证据、跳过、负样本漏报或 flaky 不得由 capability 支持率掩盖', () => {
    const results = executions()
    results[0]!.repetitions[0]!.evidenceKinds = ['dom']
    results[1]!.repetitions[0]!.status = 'skipped'
    results[2]!.repetitions[0]!.negativeControlDetected = false
    results[3]!.repetitions[0]!.oraclePassed = false
    const rebound = digestPublishedB2BExecutions(results)
    for (const result of results) result.publishedExecutionsDigest = rebound
    const verdicts = digestPublishedB2BVerdicts(results)
    for (const result of results) result.publishedVerdictsDigest = verdicts
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true,
      runtimeChainProof: runtimeChainProof(results) })
    expect(proof.capabilitySupportRate).toBe(100)
    expect(proof.endToEndSuccessRate).toBeLessThan(100)
    expect(proof).toMatchObject({ passed: false, gateEligible: false })
    expect(proof.failures.map((item) => item.reasonCode)).toEqual(expect.arrayContaining([
      'EVIDENCE_INCOMPLETE', 'FLAKY_RESULT',
    ]))
    expect(proof.falseNegativeRate).toBeGreaterThan(0)
    expect(proof.flakyRate).toBeGreaterThan(0)
  })

  test('开发机即使结果全绿也只能生成趋势证明', () => {
    const results = executions()
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: false,
      runtimeChainProof: runtimeChainProof(results) })
    expect(proof).toMatchObject({ passed: true, gateEligible: false,
      gateIneligibleReasons: ['ENVIRONMENT_NOT_APPROVED'] })
  })

  test('active generation 必须绑定同一份已发布执行集合', () => {
    const results = executions()
    results[0]!.publishedExecutionsDigest = digestText('wrong/v1', 'substituted')
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true,
      runtimeChainProof: runtimeChainProof(results) })
    expect(proof.failures).toContainEqual({ scenarioId: 'SCENARIO-1',
      reasonCode: 'PUBLISHED_EXECUTIONS_MISMATCH' })
  })

  test('Browser 能力结果未经 Scheduler、Authority、Gateway 和 Executor 全链时不得成为门禁', () => {
    const proof = createB2BCoverageProof({ corpus, executions: executions(), environmentEligible: true,
      runtimeChainProof: runtimeChainProof(executions(), { omitGatewayAction: 'ACTION-1' }) })
    expect(proof).toMatchObject({ passed: false, gateEligible: false,
      gateIneligibleReasons: ['RUNTIME_CHAIN_INCOMPLETE', 'COVERAGE_GATE_FAILED'] })
  })

  test('Gateway 事实必须与同一轮 Run、Case、Action 和 Attempt 精确绑定', () => {
    const results = executions()
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true,
      runtimeChainProof: runtimeChainProof(results, { rewriteGatewayRun: 'ACTION-1' }) })
    expect(proof.runtimeChain.gateway).toBe(false)
    expect(proof.gateEligible).toBe(false)
    const extra = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true,
      runtimeChainProof: runtimeChainProof(results, { extraGatewayFact: true }) })
    expect(extra.runtimeChain.gateway).toBe(false)
  })

  test('期望事实自身重复时四段 Runtime 链不得通过集合等价检查', () => {
    const results = executions()
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true,
      runtimeChainProof: runtimeChainProof(results, { duplicateExpected: true }) })
    expect(proof.runtimeChain).toEqual({ scheduler: false, authority: false,
      gateway: false, browserExecutor: false })
  })

  test('Gateway 终态 outcome 与 Browser Executor outcome 不一致时不得通过', () => {
    const results = executions()
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true,
      runtimeChainProof: runtimeChainProof(results, { rewriteGatewayOutcome: 'ACTION-1' }) })
    expect(proof.runtimeChain.gateway).toBe(false)
  })

  test('发布摘要必须包含所有正向轮次 Verdict', () => {
    const results = executions()
    results[0]!.positiveVerdicts[1]!.verdict = 'rejected'
    expect(() => digestPublishedB2BVerdicts(results)).toThrowError('E2E_B2B_POSITIVE_VERDICTS_INCONSISTENT')
  })

  test('调用者不能用普通对象伪造 Runtime 全链证明', () => {
    expect(() => createB2BCoverageProof({ corpus, executions: executions(), environmentEligible: true,
      runtimeChainProof: {} as never })).toThrowError('E2E_B2B_RUNTIME_CHAIN_PROOF_INVALID')
  })

  test('Runtime 全链证明不能复用于另一份 executions', () => {
    const original = executions()
    const proof = runtimeChainProof(original)
    const substituted = executions()
    substituted[0]!.generation.activeDigest = digestText('b2b-scenario-test/v1', 'another-generation')
    expect(createB2BCoverageProof({ corpus, executions: substituted, environmentEligible: true,
      runtimeChainProof: proof })).toMatchObject({ passed: false,
        runtimeChain: { scheduler: false, authority: false, gateway: false, browserExecutor: false } })
  })
})
