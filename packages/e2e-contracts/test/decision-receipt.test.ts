import { describe, expect, it } from 'vitest'
import {
  ArtifactSchemaRegistry,
  DecisionReceiptSchema,
  digestDecisionSubject,
  projectLineageDecisionSubject,
  projectScopeDecisionSubject,
  parseArtifactDocument,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

const scope = {
  includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['prd.md#req-1'] }],
  exclusions: [{ reqId: 'REQ-2', rationale: '本轮不覆盖', decisionId: 'EXCLUSION-1' }],
  ambiguities: [{ ambiguityId: 'AMB-1', question: '是否需要旧浏览器？', status: 'resolved' as const,
    decisionId: 'AMB-DECISION-1', resolution: '不需要，仅验收 Chrome' }],
  dependencies: [{ dependencyId: 'DEP-1', status: 'available' as const, digest: digest('1') }],
  visualScope: { required: true, refs: ['FIGMA-1'] },
  browserScope: { browserIds: ['chrome'], viewportIds: ['desktop'] },
}

const lineage = {
  previousRevision: digest('2'), currentRevision: digest('3'),
  sectionChanges: [{ sectionId: 'SEC-1', kind: 'changed' as const, digest: digest('4') }],
  lineageMappings: [{ entityKind: 'requirement' as const, semanticKey: 'order:list',
    disposition: 'preserved' as const, previousIds: ['REQ-1'], currentIds: ['REQ-1'], confidence: 1,
    confirmation: 'deterministic-exact' as const, rationale: 'semanticKey 精确一致',
    sourceRefs: ['prd.md#req-1'] }],
  impactedEntityIds: ['REQ-1'],
}

const receipt = (kind: 'scope' | 'lineage', decisionId: string, status: 'approved' | 'rejected', subjectDigest: string) => ({
  schemaVersion: '1.0.0' as const, kind, decisionId, decisionStatus: status,
  decisionSubjectDigest: subjectDigest, checkedAt: '2026-07-12T01:00:00.000Z',
  nonce: 'a'.repeat(64), approver: { subject: 'alice', roles: [`${kind}-approver`] },
  issuer: 'AUTHORITY', keyId: 'KEY-1:decision', purpose: `${kind}-decision-receipt/v1` as const,
  algorithm: 'Ed25519' as const, signedDigest: digest('5'), signature: 'signature',
})

function envelope(artifactType: 'acceptance-scope' | 'prd-diff', content: unknown) {
  return {
    artifactId: `ARTIFACT-${artifactType}`, artifactType, schemaVersion: '2.0.0', engineVersion: '1.0.0',
    assetId: 'ASSET-1', prdRevision: digest('6'), generationId: 'GEN-1',
    createdAt: '2026-07-12T01:00:00.000Z', contentDigest: digest('7'), signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
}

describe('Scope/Lineage DecisionReceipt contract', () => {
  it('投影显式排除 decision 自身且任一安全字段变化都会改变 digest', () => {
    const projected = projectScopeDecisionSubject({ ...scope, scopeDecision: { decisionId: 'D', status: 'pending' } })
    expect(projected).toEqual({ schemaVersion: '1.0.0', kind: 'scope', ...scope })
    expect(projected).not.toHaveProperty('scopeDecision')
    const baseline = digestDecisionSubject(projected)
    const mutations = [
      { ...scope, includedReqCandidates: [{ reqId: 'REQ-X', sourceRefs: ['prd.md#req-1'] }] },
      { ...scope, exclusions: [{ ...scope.exclusions[0]!, rationale: 'changed' }] },
      { ...scope, ambiguities: [{ ...scope.ambiguities[0]!, question: 'changed' }] },
      { ...scope, ambiguities: [{ ...scope.ambiguities[0]!, resolution: 'changed' }] },
      { ...scope, dependencies: [{ ...scope.dependencies[0]!, digest: digest('8') }] },
      { ...scope, visualScope: { ...scope.visualScope, required: false } },
      { ...scope, browserScope: { ...scope.browserScope, browserIds: ['firefox'] } },
    ]
    for (const mutation of mutations) {
      expect(digestDecisionSubject(projectScopeDecisionSubject(mutation))).not.toBe(baseline)
    }
    expect(() => projectScopeDecisionSubject({ ...scope, securityBoundary: 'hidden' })).toThrow()
    expect(() => projectScopeDecisionSubject({ ...scope, ambiguities: [{
      ambiguityId: 'AMB-1', question: '是否需要旧浏览器？', status: 'resolved', decisionId: 'AMB-DECISION-1',
    }] })).toThrow()
  })

  it('lineage projection 绑定修订、section changes 与 impacted entities，并拒绝未知字段', () => {
    const projected = projectLineageDecisionSubject({ ...lineage, lineageReview: { decisionId: 'D', status: 'pending' } })
    expect(projected).toEqual({ schemaVersion: '1.0.0', kind: 'lineage', ...lineage })
    expect(projected).not.toHaveProperty('lineageReview')
    const baseline = digestDecisionSubject(projected)
    for (const mutation of [
      { ...lineage, previousRevision: digest('9') },
      { ...lineage, currentRevision: digest('a') },
      { ...lineage, sectionChanges: [{ ...lineage.sectionChanges[0]!, digest: digest('b') }] },
      { ...lineage, lineageMappings: [{ ...lineage.lineageMappings[0]!, semanticKey: 'order:detail' }] },
      { ...lineage, impactedEntityIds: ['REQ-X'] },
    ]) expect(digestDecisionSubject(projectLineageDecisionSubject(mutation))).not.toBe(baseline)
    expect(() => projectLineageDecisionSubject({ ...lineage, securityBoundary: 'hidden' })).toThrow()
  })

  it('lineage 映射拒绝伪稳定 ID、未审批 split/merge、重复 ID 和非确定排序', () => {
    const base = lineage.lineageMappings[0]!
    for (const lineageMappings of [
      [{ ...base, currentIds: ['REQ-RENAMED'] }],
      [{ ...base, disposition: 'split', currentIds: ['REQ-2', 'REQ-3'] }],
      [{ ...base, semanticKey: 'z' }, { ...base, semanticKey: 'a', previousIds: ['REQ-2'], currentIds: ['REQ-2'] }],
      [{ ...base }, { ...base, semanticKey: 'order:other' }],
    ]) {
      expect(() => projectLineageDecisionSubject({ ...lineage, lineageMappings })).toThrow()
    }
    expect(projectLineageDecisionSubject({ ...lineage, lineageMappings: [{
      ...base, disposition: 'split', currentIds: ['REQ-2', 'REQ-3'], confidence: 0.92,
      confirmation: 'authority-confirmed', rationale: '经 Lineage 审批确认需求拆分',
    }] }).lineageMappings[0]).toMatchObject({ disposition: 'split', confirmation: 'authority-confirmed' })
  })

  it('pending 严格无 receipt；approved/rejected 必须带匹配 kind/status/decisionId 的 receipt', () => {
    expect(ArtifactSchemaRegistry['acceptance-scope'].safeParse(envelope('acceptance-scope', {
      ...scope, scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
    })).success).toBe(true)
    expect(ArtifactSchemaRegistry['acceptance-scope'].safeParse(envelope('acceptance-scope', {
      ...scope, scopeDecision: { decisionId: 'SCOPE-1', status: 'pending', receipt: receipt('scope', 'SCOPE-1', 'approved', digest('c')) },
    })).success).toBe(false)
    const approved = receipt('scope', 'SCOPE-1', 'approved', digestDecisionSubject(projectScopeDecisionSubject(scope)))
    expect(ArtifactSchemaRegistry['acceptance-scope'].safeParse(envelope('acceptance-scope', {
      ...scope, scopeDecision: { decisionId: 'SCOPE-1', status: 'approved', receipt: approved },
    })).success).toBe(true)
    for (const badReceipt of [
      { ...approved, kind: 'lineage', purpose: 'lineage-decision-receipt/v1' },
      { ...approved, decisionId: 'OTHER' },
      { ...approved, decisionStatus: 'rejected' },
    ]) expect(ArtifactSchemaRegistry['acceptance-scope'].safeParse(envelope('acceptance-scope', {
      ...scope, scopeDecision: { decisionId: 'SCOPE-1', status: 'approved', receipt: badReceipt },
    })).success).toBe(false)
    expect(DecisionReceiptSchema.safeParse({ ...approved, extra: true }).success).toBe(false)
    expect(DecisionReceiptSchema.safeParse({
      ...approved, approver: { kind: 'local-caller' },
    }).success).toBe(true)
    expect(DecisionReceiptSchema.safeParse({
      ...approved, approver: { kind: 'local-caller', roles: ['scope-approver'] },
    }).success).toBe(false)
  })

  it('prd-diff v2 同样使用严格判别联合', () => {
    const rejected = receipt('lineage', 'LINEAGE-1', 'rejected',
      digestDecisionSubject(projectLineageDecisionSubject(lineage)))
    expect(ArtifactSchemaRegistry['prd-diff'].safeParse(envelope('prd-diff', {
      ...lineage, lineageReview: { decisionId: 'LINEAGE-1', status: 'rejected', receipt: rejected },
    })).success).toBe(true)
    expect(ArtifactSchemaRegistry['prd-diff'].safeParse(envelope('prd-diff', {
      ...lineage, lineageReview: { decisionId: 'LINEAGE-1', status: 'approved' },
    })).success).toBe(false)
  })

  it('acceptance-scope 与 prd-diff v1 明确要求迁移，而不是继续接受旧 digest 自批结构', () => {
    for (const [type, content] of [
      ['acceptance-scope', { ...scope, scopeDecision: { decisionId: 'SCOPE-1', status: 'approved', digest: digest('d') } }],
      ['prd-diff', { ...lineage, lineageReview: { decisionId: 'LINEAGE-1', status: 'approved', digest: digest('e') } }],
    ] as const) {
      expect(() => parseArtifactDocument({ ...envelope(type, content), schemaVersion: '1.0.0' }))
        .toThrowError(/E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED/)
    }
  })
})
