import { describe, expect, test } from 'vitest'
import {
  PrdGoldCorpusSchema,
  scorePrdGoldBenchmark,
  type PrdGoldCorpus,
} from '../src/prd-gold-scorer.js'

const semanticSet = {
  requirements: ['REQ-review'],
  rules: ['RULE-admin', 'RULE-user-hidden'],
  obligations: ['OBL-admin-pass', 'OBL-user-hidden', 'OBL-bypass-denied', 'OBL-reload-persists'],
  negativeEdgeObligations: ['OBL-user-hidden', 'OBL-bypass-denied'],
  oracles: ['ORACLE-admin', 'ORACLE-hidden', 'ORACLE-denied', 'ORACLE-reload'],
  classifications: [{ semanticId: 'QUESTION-revoke', disposition: 'ambiguous' as const }],
}

const corpus: PrdGoldCorpus = {
  schemaVersion: 'prd-gold-corpus/v1',
  corpusVersion: '1.0.0',
  adjudicationVersion: '1.0.0',
  entries: [{
    entryId: 'GOLD-admin-review',
    category: 'permission-and-reload',
    prd: '只有管理员可审核；普通用户无按钮；绕过权限失败；Reload 后保持已通过。PRD 未说明能否撤销。',
    sourceSpans: [{ clauseId: 'CLAUSE-review', startLine: 1, endLine: 1 }],
    actors: ['admin', 'ordinary-user'],
    preconditions: ['存在待审核记录'],
    adjudications: [
      ...semanticSet.requirements.map((semanticId) => ({ semanticId, kind: 'requirement' as const, statement: semanticId })),
      ...semanticSet.rules.map((semanticId) => ({ semanticId, kind: 'rule' as const, statement: semanticId })),
      ...semanticSet.obligations.map((semanticId) => ({ semanticId, kind: 'obligation' as const, statement: semanticId })),
      ...semanticSet.oracles.map((semanticId) => ({ semanticId, kind: 'oracle' as const, statement: semanticId })),
      ...semanticSet.classifications.map(({ semanticId }) => ({ semanticId, kind: 'classification' as const,
        statement: semanticId })),
      ...['CASE-admin', 'CASE-hidden', 'CASE-bypass', 'CASE-reload'].map((semanticId) => ({ semanticId,
        kind: 'case' as const, statement: semanticId })),
      { semanticId: 'DATA-review-record', kind: 'data-need' as const, statement: '待审核记录' },
      { semanticId: 'CLEANUP-review-record', kind: 'cleanup' as const, statement: '删除测试记录' },
    ],
    gold: {
      ...semanticSet,
      cases: ['CASE-admin', 'CASE-hidden', 'CASE-bypass', 'CASE-reload'],
      dataNeeds: ['DATA-review-record'],
      cleanup: ['CLEANUP-review-record'],
    },
    samples: [{ sample: 0, candidate: {
      ...semanticSet,
      cases: ['CASE-admin', 'CASE-hidden', 'CASE-bypass', 'CASE-reload'],
      dataNeeds: ['DATA-review-record'], cleanup: ['CLEANUP-review-record'],
    } }],
  }],
}

describe('PRD Gold deterministic scorer', () => {
  test('严格解析人工 Gold，四类管理员审核义务完整时通过零容忍门', () => {
    expect(PrdGoldCorpusSchema.parse(corpus)).toEqual(corpus)
    const proof = scorePrdGoldBenchmark(corpus, {
      generatorContextDigest: `sha256:${'1'.repeat(64)}`,
      scorerVersion: '1.0.0',
      generatedAt: '2026-08-12T00:00:00.000Z',
    })
    expect(proof.gate).toMatchObject({ passed: true, zeroToleranceViolations: [] })
    expect(proof.denominators).toMatchObject({ obligations: 4, negativeEdgeObligations: 2 })
  })

  test('缺失越权义务、凭空假设撤销规则和空链路均使 Gold gate 失败', () => {
    const broken = structuredClone(corpus)
    const candidate = broken.entries[0]!.samples[0]!.candidate
    candidate.obligations = candidate.obligations.filter((id) => id !== 'OBL-bypass-denied')
    candidate.negativeEdgeObligations = candidate.negativeEdgeObligations
      .filter((id) => id !== 'OBL-bypass-denied')
    candidate.rules = [...candidate.rules, 'RULE-revocation-is-allowed']
    candidate.classifications = []
    candidate.emptyLinkIds = ['REQ-review']
    const proof = scorePrdGoldBenchmark(broken, {
      generatorContextDigest: `sha256:${'2'.repeat(64)}`,
      scorerVersion: '1.0.0', generatedAt: '2026-08-12T00:00:00.000Z',
    })
    expect(proof.samples[0]?.metrics).toMatchObject({
      negativeEdgeRecall: 0.5,
      classificationAccuracy: 0,
      unexplainedEmptyLinks: 1,
    })
    expect(proof.samples[0]?.metrics.unsupportedHallucinationRate).toBeGreaterThan(0)
    expect(proof.gate.passed).toBe(false)
    expect(proof.gate.zeroToleranceViolations).toEqual(expect.arrayContaining([
      'sample:0:hallucination', 'sample:0:empty-link',
    ]))
  })

  test('保留全部非确定样本并由 proof schema 重算最差值与方差', () => {
    const repeated = structuredClone(corpus)
    repeated.entries[0]!.samples.push({ sample: 1, candidate: {
      ...structuredClone(repeated.entries[0]!.samples[0]!.candidate),
      obligations: ['OBL-admin-pass'],
      negativeEdgeObligations: [],
    } })
    const proof = scorePrdGoldBenchmark(repeated, {
      generatorContextDigest: `sha256:${'3'.repeat(64)}`,
      scorerVersion: '1.0.0', generatedAt: '2026-08-12T00:00:00.000Z',
    })
    expect(proof.repeatCount).toBe(2)
    expect(proof.aggregate.worstScore).toBeLessThan(proof.aggregate.meanScore)
    expect(proof.aggregate.variance).toBeGreaterThan(0)
    expect(proof.aggregate.irreproducibilityRate).toBe(0.5)
  })
})
