import { describe, expect, test } from 'vitest'
import {
  AcceptedRegressionAssetV1Schema,
  RegressionAssetValiditySchema,
  computeAcceptedRegressionAssetDigest,
} from '../src/index.js'

const d = (value: string) => `sha256:${value.repeat(64)}`

describe('AcceptedRegressionAssetV1', () => {
  test('严格绑定可复跑语义且拒绝 Secret、Lease、批准与篡改摘要', () => {
    const body = {
      schemaVersion: 'accepted-regression-asset/v1' as const, assetId: 'PRODUCT:ORDERS', version: 1,
      sourceRevision: d('1'), understandingDigest: d('2'), semanticPlanDigest: d('3'),
      acceptanceReviewReceiptDigest: d('4'), executableCompilationDigest: d('5'),
      targetIdentityContract: { baseOrigin: 'https://example.test', environmentLabel: 'test',
        allowedNavigationOrigins: ['https://example.test'], pageIdentityPolicyDigest: d('6') },
      actorDataContractDigest: d('7'), runtimeCompatibility: { packageName: '@mutil-skills/e2e-runtime' as const,
        range: '^0.8.0' }, browserCapabilities: ['chrome', 'dom', 'reload'], humanAmendments: [],
      createdAt: '2026-08-12T00:00:00.000Z',
    }
    const asset = { ...body, assetDigest: computeAcceptedRegressionAssetDigest(body) }
    expect(AcceptedRegressionAssetV1Schema.parse(asset)).toEqual(asset)
    expect(AcceptedRegressionAssetV1Schema.safeParse({ ...asset, secretValue: 'x' }).success).toBe(false)
    expect(AcceptedRegressionAssetV1Schema.safeParse({ ...asset, leaseId: 'LEASE-1' }).success).toBe(false)
    expect(AcceptedRegressionAssetV1Schema.safeParse({ ...asset, assetDigest: d('f') }).success).toBe(false)
  })

  test('失效状态明确区分 probe、review 与执行阻断', () => {
    for (const value of [
      { status: 'valid' },
      { status: 'probe-required', reasons: [{ code: 'E2E_REGRESSION_LOCATOR_DRIFT', ref: 'PAGE-1' }] },
      { status: 'review-required', reasons: [{ code: 'E2E_REGRESSION_PRD_CHANGED', ref: 'PRD' }],
        diff: { changedBindings: ['source'], previousDigest: d('1'), currentDigest: d('2') } },
      { status: 'execution-blocked', reasons: [{ code: 'E2E_REGRESSION_ROLE_CHANGED', ref: 'ROLE-1' }] },
    ]) expect(RegressionAssetValiditySchema.safeParse(value).success).toBe(true)
  })
})
