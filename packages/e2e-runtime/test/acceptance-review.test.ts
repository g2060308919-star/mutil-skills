import { describe, expect, test } from 'vitest'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import {
  AcceptanceReviewReceiptSchema,
  buildAcceptanceReview,
  confirmAcceptanceReview,
} from '../src/acceptance-review.js'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('AcceptanceReview', () => {
  test('从冻结资产生成 SourceSpan→Clause→Requirement→Rule→Oracle→Case 链路', () => {
    const review = buildAcceptanceReview(reviewSnapshot())

    expect(review).toMatchObject({
      runId: 'RUN-1',
      contractProjectionDigest: d('a'),
      compilerDigest: d('b'),
      includedClauseIds: ['CLAUSE-1'],
      excludedClauseIds: ['CLAUSE-2'],
      unresolvedItems: ['是否允许匿名下单？'],
    })
    expect(review.links).toEqual([
      {
        clauseId: 'CLAUSE-1', sourceSpan: {
          sourceId: 'PRD-BODY', startLine: 2, startColumn: 1, endLine: 2, endColumn: 8,
        },
        sourceText: '用户可以下单', disposition: 'modeled',
        requirementIds: ['REQ-1'], ruleIds: ['RULE-1'], oracleIds: ['ORACLE-1'],
        caseIds: ['CASE-0001'],
      },
      {
        clauseId: 'CLAUSE-2', sourceSpan: {
          sourceId: 'PRD-BODY', startLine: 3, startColumn: 1, endLine: 3, endColumn: 7,
        },
        sourceText: '不支持批发', disposition: 'excluded',
        requirementIds: [], ruleIds: [], oracleIds: [], caseIds: [],
      },
    ])
    expect(review.semanticCatalog).toEqual({
      requirements: [{
        reqId: 'REQ-1', title: '用户下单', actors: ['USER'], preconditions: ['已登录'],
        contractNodeIds: ['NODE-1'],
      }],
      rules: [{
        ruleId: 'RULE-1', reqId: 'REQ-1', category: 'business',
        statement: '提交有效订单后创建订单', certainty: 'explicit', oracleIds: ['ORACLE-1'],
      }],
      oracles: [{
        oracleId: 'ORACLE-1', reqId: 'REQ-1', ruleId: 'RULE-1', statement: '订单可见',
      }],
      obligations: [{
        obligationId: 'OBL-1', reqId: 'REQ-1', scenario: '用户提交有效订单',
        necessity: 'required', disposition: 'automated', caseIds: ['CASE-0001'],
      }],
      cases: [{
        caseId: 'CASE-0001', title: '下单', actor: 'USER', contractNodeIds: ['NODE-1'],
        actions: [{ actionId: 'ACTION-1', statement: '下单', effect: 'reversible-write' }],
        oracles: [{ oracleId: 'COMPILED-ORACLE-1', acceptanceCriterion: '订单可见' }],
        executionLane: 'real-reversible-write',
        fixture: { actorRef: 'USER', preconditions: [{ kind: 'data-record', statement: '待下单商品' }],
          seedStrategy: 'gateway-api', dataLease: { leaseKey: 'LEASE-order', scope: 'tenant',
            expiresAfterSeconds: 300 }, cleanup: { kind: 'gateway-api', statement: '删除测试订单' },
          reloadVerification: [{ statement: '删除后 Reload 仍不存在' }] },
      }],
    })
    expect(review.reviewDigest).toMatch(/^sha256:/)
    expect(review.executionSummary).toMatchObject({
      target: {
        baseOrigin: 'https://shop.example.test',
        environmentLabel: 'gold',
      },
      bindingStatus: 'semantic-only',
      caseCount: 1,
      actionCount: 1,
      oracleCount: 1,
      reversibleWriteCount: 1,
      dataNeedCount: 1,
      cleanupCount: 1,
      reloadOracleCount: 1,
    })
    expect(review).toMatchObject({ confirmable: false,
      blockingReasons: ['E2E_ACCEPTANCE_REVIEW_PENDING_AMBIGUITY'] })
    expect(buildAcceptanceReview(reviewSnapshot())).toEqual(review)
  })

  test('已建模 Clause 缺少 Requirement/Rule/Oracle/Case 任一链路时拒绝伪造 Review', () => {
    const snapshot = reviewSnapshot()
    const coverage = snapshot.frozenArtifacts['coverage-universe']!.content as any
    coverage.obligations[0].disposition = { kind: 'manual', manualProcedureId: 'MANUAL-1', blocking: true }
    snapshot.compiledPrdRun = { ...snapshot.compiledPrdRun!, cases: [] } as any

    expect(() => buildAcceptanceReview(snapshot)).toThrowError(expect.objectContaining({
      code: 'E2E_ACCEPTANCE_REVIEW_CHAIN_INCOMPLETE',
    }))
  })

  test('Coverage obligation 引用不存在的编译 Case 时拒绝生成伪完整链路', () => {
    const snapshot = reviewSnapshot()
    const coverage = snapshot.frozenArtifacts['coverage-universe']!.content as any
    coverage.obligations[0].disposition.caseIds = ['CASE-NOT-COMPILED']

    expect(() => buildAcceptanceReview(snapshot)).toThrowError(expect.objectContaining({
      code: 'E2E_ACCEPTANCE_REVIEW_CHAIN_INCOMPLETE',
    }))
  })

  test('本地确认回执绑定 reviewDigest 并如实报告无身份与职责分离保证', () => {
    const snapshot = reviewSnapshot()
    ;((snapshot.frozenArtifacts['acceptance-scope']!.content as any).ambiguities) = []
    const review = buildAcceptanceReview(snapshot)
    const receipt = confirmAcceptanceReview({
      review,
      expectedReviewDigest: review.reviewDigest,
      confirmedAt: '2026-08-02T01:00:00.000Z',
    })

    expect(AcceptanceReviewReceiptSchema.parse(receipt)).toMatchObject({
      reviewDigest: review.reviewDigest,
      approver: 'local-caller', approvalMode: 'local-confirmation',
      identityVerified: false, separationOfDutiesVerified: false,
    })
    expect(() => confirmAcceptanceReview({
      review, expectedReviewDigest: d('f'), confirmedAt: '2026-08-02T01:00:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'E2E_ACCEPTANCE_REVIEW_DIGEST_MISMATCH' }))
  })

  test('pending ambiguity 与 required 自动义务空链都禁止语义确认', () => {
    const ambiguous = buildAcceptanceReview(reviewSnapshot())
    expect(() => confirmAcceptanceReview({ review: ambiguous,
      expectedReviewDigest: ambiguous.reviewDigest,
      confirmedAt: '2026-08-02T01:00:00.000Z' })).toThrowError(expect.objectContaining({
      code: 'E2E_ACCEPTANCE_REVIEW_NOT_CONFIRMABLE',
    }))

    const snapshot = reviewSnapshot()
    ;((snapshot.frozenArtifacts['acceptance-scope']!.content as any).ambiguities) = []
    ;((snapshot.frozenArtifacts['coverage-universe']!.content as any).obligations[0].disposition) = {
      kind: 'automated', caseIds: [],
    }
    expect(() => buildAcceptanceReview(snapshot)).toThrowError(expect.objectContaining({
      code: 'E2E_ACCEPTANCE_REVIEW_REQUIRED_OBLIGATION_INCOMPLETE',
    }))
  })

  test('不可安全清理的写操作显示阻断原因且不能确认', () => {
    const snapshot = reviewSnapshot()
    ;((snapshot.frozenArtifacts['acceptance-scope']!.content as any).ambiguities) = []
    snapshot.compiledPrdRun!.cases[0]!.fixture = undefined
    const review = buildAcceptanceReview(snapshot)
    expect(review).toMatchObject({ confirmable: false,
      blockingReasons: ['E2E_ACCEPTANCE_REVIEW_WRITE_CLEANUP_REQUIRED'] })
    expect(() => confirmAcceptanceReview({ review, expectedReviewDigest: review.reviewDigest,
      confirmedAt: '2026-08-02T01:00:00.000Z' })).toThrowError(expect.objectContaining({
      code: 'E2E_ACCEPTANCE_REVIEW_NOT_CONFIRMABLE',
    }))
  })
})

function reviewSnapshot(): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.8.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: d('1'), runtimeInstallationDigest: d('2'), runRevision: 3,
    workflow: { current: 'coverage-audited', sequence: 4, eventChainDigest: d('3') },
    artifactDigests: {},
    frozenArtifacts: {
      'prd-manifest': { content: { clauses: [
        { clauseId: 'CLAUSE-1', sourceId: 'PRD-BODY', sourceSpan: {
          startLine: 2, startColumn: 1, endLine: 2, endColumn: 8,
        }, originalText: '用户可以下单' },
        { clauseId: 'CLAUSE-2', sourceId: 'PRD-BODY', sourceSpan: {
          startLine: 3, startColumn: 1, endLine: 3, endColumn: 7,
        }, originalText: '不支持批发' },
      ] } } as any,
      'acceptance-scope': { content: {
        clauseDispositions: [
          { clauseId: 'CLAUSE-1', disposition: 'modeled', requirementIds: ['REQ-1'] },
          { clauseId: 'CLAUSE-2', disposition: 'excluded', reason: '范围外', decisionId: 'DECISION-1' },
        ],
        ambiguities: [{ ambiguityId: 'AMB-1', question: '是否允许匿名下单？', status: 'pending' }],
      } } as any,
      'requirement-model': { content: { requirements: [{
        reqId: 'REQ-1', contractNodeIds: ['NODE-1'],
        revision: 1, title: '用户下单', actors: ['USER'], entities: ['订单'],
        preconditions: ['已登录'], states: [], transitions: [], applicability: [], sourceRefs: ['CLAUSE-1'],
        status: 'active',
        rules: [{ ruleId: 'RULE-1', category: 'business', statement: '提交有效订单后创建订单',
          sourceRefs: ['CLAUSE-1'], certainty: 'explicit', oracleIds: ['ORACLE-1'] }],
        observableOutcomes: [{ oracleId: 'ORACLE-1', ruleId: 'RULE-1', statement: '订单可见',
          sourceRefs: ['CLAUSE-1'] }],
      }] } } as any,
      'coverage-universe': { content: { obligations: [{
        obligationId: 'OBL-1', reqId: 'REQ-1', clauseIds: ['CLAUSE-1'],
        ruleIds: ['RULE-1'], oracleIds: ['ORACLE-1'],
        scenario: '用户提交有效订单', necessity: 'required',
        disposition: { kind: 'automated', caseIds: ['CASE-0001'] },
      }] } } as any,
    },
    trustedExecutionFacts: {},
    targetContract: {
      schemaVersion: '1.0.0',
      contract: {
        schemaVersion: '1.0.0', targetUrl: 'https://shop.example.test/orders',
        baseOrigin: 'https://shop.example.test', environmentLabel: 'gold',
        allowedNavigationOrigins: ['https://shop.example.test'],
        pageIdentityPolicy: { schemaVersion: '1.0.0',
          url: { origin: 'https://shop.example.test', pathPattern: '/orders' },
          signals: [{ kind: 'role', role: 'main', name: '订单' }], match: { mode: 'all' } },
      }, contractDigest: d('d'), environmentIdentityDigest: d('e'),
    },
    compiledPrdRun: {
      schemaVersion: '1.0.0', contractProjectionDigest: d('a'), compilerDigest: d('b'),
      cases: [{
        queueOrdinal: 0, caseId: 'CASE-0001', caseKey: 'buy', title: '下单', actor: 'USER',
        contractNodeIds: ['NODE-1'], failurePolicy: 'stop-required',
        actions: [{ actionId: 'ACTION-1', actionKey: 'buy', kind: 'full-playwright',
          effect: 'reversible-write', statement: '下单' }],
        oracles: [{ oracleId: 'COMPILED-ORACLE-1', oracleKey: 'created', actionId: 'ACTION-1',
          contractNodeId: 'NODE-1', acceptanceCriterion: '订单可见' }],
        executionLane: 'real-reversible-write',
        fixture: { actorRef: 'USER', preconditions: [{ kind: 'data-record', statement: '待下单商品' }],
          seedStrategy: 'gateway-api', dataLease: { leaseKey: 'LEASE-order', scope: 'tenant',
            expiresAfterSeconds: 300 }, cleanup: { kind: 'gateway-api', statement: '删除测试订单' },
          reloadVerification: [{ statement: '删除后 Reload 仍不存在' }] },
      }],
    } as any,
    writeAttempts: {}, executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {}, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  }
}
