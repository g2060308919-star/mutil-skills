import { describe, expect, test } from 'vitest'
import {
  PolicyDecisionViewV1Schema,
  canonicalizeJson,
  digestCanonicalGrantApprovalSubject,
  digestText,
  projectApprovalPolicyDecisionViews,
  projectGatewayPolicyDecisionViews,
} from '../src/index.js'

const d = (value: string) => digestText('test/v1', value)

function receipt() {
  const subject = {
    schemaVersion: '2.1.0' as const,
    assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage'),
    universeDigest: d('universe'), caseDigest: d('cases'), actionMapDigest: d('actions'),
    policyDigest: d('policy'), environment: 'test' as const, baseOrigin: 'https://example.test',
    runBundleProjectionDigest: d('run-bundle-projection'),
    executionContractDigest: d('execution-contract'),
    actor: 'USER', discoveryGrantId: 'DISCOVERY-1', preflightDigest: d('preflight-result'),
    requests: [],
    actions: [{ actionId: 'ACTION-1', operation: 'dom-read' as const, maxUses: 1, requestIds: [] }],
  }
  const capabilities = [{
    capabilityId: 'CAPABILITY-1', actionId: 'ACTION-1', operation: 'dom-read' as const,
    effect: 'read' as const, maxUses: 1, digest: d('capability'),
  }]
  const body = {
    schemaVersion: '1.0.0' as const, grantType: 'read' as const, grantId: 'GRANT-1',
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', subject),
    runBundleDigest: d('run-bundle'), executionSubjectSnapshot: subject,
    browserPreflightArtifactDigest: d('preflight-artifact'), capabilities,
    capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(capabilities)),
    expiresAt: '2026-07-13T00:00:00.000Z', checkedAt: '2026-07-12T00:00:00.000Z',
    revocationSequence: 0, status: 'valid' as const, reasonCodes: [],
  }
  return {
    ...body,
    authorityProof: {
      purpose: 'approval-freshness-receipt/v1' as const, issuer: 'AUTHORITY', keyId: 'KEY-1',
      algorithm: 'Ed25519' as const,
      signedDigest: digestText('approval-freshness-receipt/v1', canonicalizeJson(body)),
      signature: 'c2lnbmF0dXJl',
    },
  }
}

describe('PolicyDecisionViewV1', () => {
  test('把计划级审批逐 capability 投影为显式、只读且确定性的策略决策', () => {
    const input = receipt()
    const first = projectApprovalPolicyDecisionViews(input)
    const second = projectApprovalPolicyDecisionViews(structuredClone(input))

    expect(first).toEqual(second)
    expect(first).toEqual([expect.objectContaining({
      schemaVersion: '1.0.0', source: 'approval-freshness', stage: 'plan-approval',
      decision: 'approved', evidenceDigest: input.authorityProof.signedDigest,
      binding: expect.objectContaining({
        assetId: 'ASSET-1', actionId: 'ACTION-1', capabilityId: 'CAPABILITY-1',
        subjectDigest: input.subjectDigest, runBundleDigest: input.runBundleDigest,
        targetOrigin: 'https://example.test', policyDigest: d('policy'),
      }),
    })])
    expect(PolicyDecisionViewV1Schema.parse(first[0])).toEqual(first[0])
    expect(input).toEqual(receipt())
  })

  test('把 Gateway 的真实动作级二次校验投影为同一视图，但不伪造计划级批准', () => {
    const audit = {
      gatewayInstance: { instanceId: 'GATEWAY-1', version: '1.0.0', publicKeyDigest: d('key') },
      policyDigest: d('policy'),
      requestEvents: [
        { sequence: 0, actionId: 'ACTION-1', executionSessionId: 'SESSION-1',
          decision: 'forwarded' as const, digest: d('forwarded') },
        { sequence: 1, actionId: 'ACTION-2', decision: 'blocked' as const, digest: d('blocked') },
      ],
    }
    const views = projectGatewayPolicyDecisionViews(audit)

    expect(views.map((view) => view.decision)).toEqual(['forwarded', 'blocked'])
    expect(views[0]).toMatchObject({
      source: 'gateway-enforcement', stage: 'action-enforcement', evidenceDigest: d('forwarded'),
      binding: { actionId: 'ACTION-1', policyDigest: d('policy'),
        gatewayInstanceId: 'GATEWAY-1', executionSessionId: 'SESSION-1' },
    })
    expect(views.every((view) => view.source !== 'approval-freshness')).toBe(true)
  })

  test('拒绝篡改 decisionId 或混淆两个执行时点', () => {
    const [view] = projectApprovalPolicyDecisionViews(receipt())
    expect(PolicyDecisionViewV1Schema.safeParse({ ...view, decisionId: d('tampered') }).success).toBe(false)
    expect(PolicyDecisionViewV1Schema.safeParse({
      ...view, source: 'gateway-enforcement', stage: 'plan-approval',
    }).success).toBe(false)
  })
})
