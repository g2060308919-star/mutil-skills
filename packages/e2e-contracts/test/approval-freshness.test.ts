import { describe, expect, test } from 'vitest'
import {
  ApprovalFreshnessReceiptSchema,
  ArtifactSchemaRegistry,
  WriteHttpIntentSchema,
  canonicalizeJson,
  digestCanonicalGrantApprovalSubject,
  digestText,
} from '../src/index.js'

const d = (value: string) => digestText('test/v1', value)

function receipt() {
  const subject = {
    schemaVersion: '2.0.0' as const,
    assetId: 'ASSET-1', prdRevision: d('prd'), scopeDigest: d('scope'),
    requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage'),
    universeDigest: d('universe'), caseDigest: d('cases'), actionMapDigest: d('actions'),
    policyDigest: d('policy'), environment: 'test' as const, baseOrigin: 'https://example.test',
    runBundleProjectionDigest: d('run-bundle-projection'),
    executionContractDigest: d('execution-contract'),
    actor: 'USER', discoveryGrantId: 'DISCOVERY-1', preflightDigest: d('preflight-result'),
    actions: [{ actionId: 'ACTION-1', operation: 'dom-read' as const, maxUses: 1 }],
  }
  const capabilities = [{ capabilityId: 'CAPABILITY-1', actionId: 'ACTION-1', operation: 'dom-read' as const,
    effect: 'read' as const, maxUses: 1, digest: d('capability') }]
    const body = {
    schemaVersion: '1.0.0' as const, grantType: 'read' as const, grantId: 'GRANT-1',
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', subject),
    runBundleDigest: d('run-bundle'),
    executionSubjectSnapshot: subject, browserPreflightArtifactDigest: d('preflight-artifact'),
    capabilities, capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(capabilities)),
    expiresAt: '2026-07-13T00:00:00.000Z', checkedAt: '2026-07-12T00:00:00.000Z',
    revocationSequence: 0, status: 'valid' as const, reasonCodes: [],
  }
  const signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(body))
  return { ...body, authorityProof: { purpose: 'approval-freshness-receipt/v1' as const,
    issuer: 'AUTHORITY', keyId: 'KEY-1', algorithm: 'Ed25519' as const,
    signedDigest, signature: 'c2lnbmF0dXJl' } }
}

describe('ApprovalFreshnessReceipt v1 / approval-grants v2', () => {
  test('Write HTTP methods use one uppercase-token contract at the 1/32 byte boundaries', () => {
    const intent = {
      intentId: 'INTENT-1', method: 'X', canonicalOrigin: 'https://example.test', exactPath: '/orders',
      query: [], payload: { kind: 'no-body' as const }, targetFingerprint: d('target'),
      maxRequests: 1, expectedOrder: 1,
    }
    expect(WriteHttpIntentSchema.safeParse(intent).success).toBe(true)
    expect(WriteHttpIntentSchema.safeParse({ ...intent, method: 'M-1' }).success).toBe(true)
    expect(WriteHttpIntentSchema.safeParse({ ...intent, method: 'X'.repeat(32) }).success).toBe(true)
    expect(WriteHttpIntentSchema.safeParse({ ...intent, method: 'post' }).success).toBe(false)
    expect(WriteHttpIntentSchema.safeParse({ ...intent, method: 'X'.repeat(33) }).success).toBe(false)
  })

  test('只接受字段完整、严格且可解释的 Authority freshness receipt', () => {
    const valid = receipt()
    expect(ApprovalFreshnessReceiptSchema.parse(valid)).toEqual(valid)
    expect(ApprovalFreshnessReceiptSchema.safeParse({ ...valid, metadata: { approved: true } }).success).toBe(false)
    expect(ApprovalFreshnessReceiptSchema.safeParse({ ...valid,
      authorityProof: { ...valid.authorityProof, purpose: 'artifact-authority-signature/v1' },
    }).success).toBe(false)
  })

  test('approval-grants 只能以 2.0.0 记录 runBundleDigest 和 receipts', () => {
    const base = {
      artifactId: 'ARTIFACT-APPROVAL-GRANTS', artifactType: 'approval-grants' as const,
      schemaVersion: '2.0.0', engineVersion: '2.0.0', assetId: 'ASSET-1', prdRevision: d('prd'),
      generationId: 'GEN-1', createdAt: '2026-07-12T00:00:00.000Z', contentDigest: d('content'),
      signatures: [], dependencies: [], graph: { defines: [], references: [] },
      content: { runBundleDigest: d('bundle'), grants: [receipt()] },
    }
    expect(ArtifactSchemaRegistry['approval-grants'].safeParse(base).success).toBe(true)
    expect(ArtifactSchemaRegistry['approval-grants'].safeParse({ ...base, schemaVersion: '1.0.0' }).success).toBe(false)
    expect(ArtifactSchemaRegistry['approval-grants'].safeParse({ ...base, content: {
      approvalSubjectDigest: d('bundle'), grants: [], revocationSequence: 0,
    } }).success).toBe(false)
  })
})
