import { describe, expect, test } from 'vitest'
import { createAcceptedRegressionAsset, evaluateRegressionAssetValidity } from '../src/accepted-regression-asset.js'
import { createTargetContractFact } from '../src/target-contract.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { createExecutableRunCompilationFact } from '../src/executable-run-compilation-fact.js'
import { canonicalizeJson, digestPrdUnderstandingProjection, digestPrdUnderstandingQuote,
  digestText } from '@mutil-skills/e2e-contracts'

const d = (value: string) => `sha256:${value.repeat(64)}`

describe('Runtime accepted regression asset', () => {
  test('只从 Runtime 冻结事实派生稳定资产，模型上下文变化不影响摘要', () => {
    const first = createAcceptedRegressionAsset({ snapshot: fixture(), runtimeVersion: '0.8.0', version: 1,
      createdAt: '2026-08-12T00:00:00.000Z' })
    const second = createAcceptedRegressionAsset({ snapshot: fixture(), runtimeVersion: '0.8.0', version: 1,
      createdAt: '2026-08-12T00:00:00.000Z' })
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).not.toMatch(/secret|lease|approval/i)
  })

  test('分别识别文案漂移、PRD 变化、角色数据变化与 Runtime 不兼容', () => {
    const asset = createAcceptedRegressionAsset({ snapshot: fixture(), runtimeVersion: '0.8.0', version: 1,
      createdAt: '2026-08-12T00:00:00.000Z' })
    expect(evaluateRegressionAssetValidity({ asset, current: {
      sourceRevision: asset.sourceRevision, understandingDigest: asset.understandingDigest,
      semanticPlanDigest: asset.semanticPlanDigest, targetIdentityContract: asset.targetIdentityContract,
      actorDataContractDigest: asset.actorDataContractDigest, runtimeVersion: '0.8.3',
      browserCapabilities: asset.browserCapabilities,
    } })).toEqual({ status: 'valid' })
    expect(evaluateRegressionAssetValidity({ asset, current: {
      sourceRevision: d('f'), understandingDigest: asset.understandingDigest,
      semanticPlanDigest: asset.semanticPlanDigest, targetIdentityContract: asset.targetIdentityContract,
      actorDataContractDigest: asset.actorDataContractDigest, runtimeVersion: '0.8.3',
      browserCapabilities: asset.browserCapabilities,
    } }).status).toBe('review-required')
    expect(evaluateRegressionAssetValidity({ asset, current: {
      sourceRevision: asset.sourceRevision, understandingDigest: asset.understandingDigest,
      semanticPlanDigest: asset.semanticPlanDigest, targetIdentityContract: asset.targetIdentityContract,
      actorDataContractDigest: d('f'), runtimeVersion: '0.8.3', browserCapabilities: asset.browserCapabilities,
    } }).status).toBe('execution-blocked')
  })
})

function fixture(): RuntimeRunSnapshot {
  const targetContract = createTargetContractFact({ schemaVersion: '1.0.0', targetUrl: 'https://example.test/',
    baseOrigin: 'https://example.test', environmentLabel: 'test',
    allowedNavigationOrigins: ['https://example.test'], pageIdentityPolicy: { schemaVersion: '1.0.0',
      url: { origin: 'https://example.test', pathPattern: '/' }, signals: [{ kind: 'test-id', value: 'home' }],
      match: { mode: 'all' } } })
  const projectionDraft = { schemaVersion: '1.0.0' as const, contractId: 'CONTRACT-1', contractVersion: 1,
    contractStatus: 'confirmed-by-caller' as const, contractSourceDigest: d('a'), sourceRevision: d('4'),
    sources: [{ sourceId: 'PRD', kind: 'file' as const, ref: 'prd.md',
      origin: { kind: 'file' as const, ref: 'prd.md' }, relevance: 'target' as const,
      digest: d('b'), byteLength: 1 }], nodes: [{ nodeId: 'REQ-1', kind: 'REQ' as const,
      statement: '首页存在', provenance: { kind: 'source-fact' as const,
        anchors: [{ sourceId: 'PRD', sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
          quote: '首页存在', quoteDigest: digestPrdUnderstandingQuote('首页存在') }] }, responsibility: '验证首页',
      upstreamNodeIds: [], downstreamNodeIds: [], acceptanceCriteria: ['首页可见'] }], pendingQuestions: [],
    route: { skillName: 'e2e' as const, steps: [{ stepId: 'STEP-1', inputNodeIds: ['REQ-1'], output: 'E2E',
      constraints: [], dependencyStepIds: [], completionCondition: '完成' }] },
    authorization: { status: 'confirmed-by-caller' as const, contractVersion: 1,
      authorizedNodeIds: ['REQ-1'], confirmedAt: '2026-08-12T00:00:00.000Z' } }
  const projection = { ...projectionDraft, projectionDigest: digestPrdUnderstandingProjection(projectionDraft) }
  const executableFact = createExecutableRunCompilationFact({ compilerDigest: d('8'), projectionDigest: d('c'),
    planCompilerDigest: d('9'), targetProbeDigest: d('d'), bindingDigest: d('e'), artifactDigests: {
      'test-cases': d('1'), 'browser-action-map': d('2'), 'execution-contract': d('3'), 'run-bundle': d('4'),
    }, executableCaseIds: ['CASE-1'] })
  const reviewReceiptBody = { schemaVersion: '1.0.0' as const, reviewDigest: d('7'),
    approver: 'local-caller' as const, approvalMode: 'local-confirmation' as const,
    identityVerified: false as const, separationOfDutiesVerified: false as const,
    confirmedAt: '2026-08-12T00:00:00.000Z' }
  const reviewReceipt = { ...reviewReceiptBody, receiptDigest: digestText(
    'e2e-acceptance-review-receipt/v1', canonicalizeJson(reviewReceiptBody),
  ) }
  return { schemaVersion: '1.8.0', runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: d('1'),
    runtimeInstallationDigest: d('2'), workflow: { current: 'awaiting-execution-approval', sequence: 1,
      eventChainDigest: d('3') }, artifactDigests: { 'prd-source': d('4') }, frozenArtifacts: {
      'execution-contract': { content: { identities: [{ identityId: 'USER', roleIds: ['USER'], secretRef: 'SECRET' }],
        dataNeeds: [{ leaseId: 'LEASE', resourceKey: 'ORDER', resourceFingerprint: d('5'), mode: 'read' }] } } as any,
    }, trustedExecutionFacts: { 'prd-understanding-prepared': { schemaVersion: '1.0.0',
      contractSourceDigest: d('a'), preparedAt: '2026-08-12T00:00:00.000Z', projection },
      'acceptance-review-receipt': reviewReceipt, 'executable-run-compilation': {
        ...executableFact } }, targetContract,
    compiledPrdRun: { compilerDigest: d('9') } as any, requestResponses: {},
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }
}
