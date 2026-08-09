import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { describe, expect, test } from 'vitest'
import {
  createB2BCoverageProof,
  digestPublishedB2BExecutions,
  digestPublishedB2BVerdicts,
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

function executions(): B2BScenarioExecution[] {
  const drafts = corpus.map((scenario, index) => ({
    scenarioId: scenario.scenarioId, requirementId: `REQ-${index + 1}`, ruleIds: [`RULE-${index + 1}`],
    oracleIds: [`ORACLE-${index + 1}`], caseId: `CASE-${index + 1}`,
    compiledPlanDigest: D,
    generation: { expectedId: 'GEN-1', activeId: 'GEN-1', activeDigest: D }, targetBound: true,
    repetitions: [1, 2, 3].map((repetition) => ({ repetition, status: 'passed' as const,
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
    publishedVerdictsDigest: D, positiveVerdict: 'accepted' as const, negativeVerdict: 'rejected' as const }))
  const publishedVerdictsDigest = digestPublishedB2BVerdicts(partial)
  return partial.map((execution) => ({ ...execution, publishedVerdictsDigest }))
}

describe('B 端场景覆盖证明', () => {
  test('只有全部类别真实闭环且环境登记后才可作为 90% 门禁', () => {
    expect(createB2BCoverageProof({ corpus, executions: executions(), environmentEligible: true }))
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
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true })
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
    const proof = createB2BCoverageProof({ corpus, executions: executions(), environmentEligible: false })
    expect(proof).toMatchObject({ passed: true, gateEligible: false,
      gateIneligibleReasons: ['ENVIRONMENT_NOT_APPROVED'] })
  })

  test('active generation 必须绑定同一份已发布执行集合', () => {
    const results = executions()
    results[0]!.publishedExecutionsDigest = digestText('wrong/v1', 'substituted')
    const proof = createB2BCoverageProof({ corpus, executions: results, environmentEligible: true })
    expect(proof.failures).toContainEqual({ scenarioId: 'SCENARIO-1',
      reasonCode: 'PUBLISHED_EXECUTIONS_MISMATCH' })
  })
})
