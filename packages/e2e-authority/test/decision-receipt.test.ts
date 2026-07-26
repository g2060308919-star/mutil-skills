import { describe, expect, it } from 'vitest'
import {
  digestDecisionSubject,
  digestText,
  projectCoverageDispositionDecisionSubject,
  projectLineageDecisionSubject,
  projectScopeDecisionSubject,
} from '@mutil-skills/e2e-contracts'
import { createDecisionReceiptVerifier, LocalApprovalAuthority } from '../src/index.js'

const d = (value: string) => digestText('test/v1', value)
const scopeSubject = projectScopeDecisionSubject({
  includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['prd.md#req-1'] }], exclusions: [], ambiguities: [],
  clauseDispositions: [{ clauseId: 'CLAUSE-1', disposition: 'modeled', requirementIds: ['REQ-1'] }],
  dependencies: [{ dependencyId: 'DEP-1', status: 'available', digest: d('dependency') }],
  visualScope: { required: true, refs: ['DESIGN-1'] },
  browserScope: { browserIds: ['chrome'], viewportIds: ['desktop'] },
})
const lineageSubject = projectLineageDecisionSubject({
  previousRevision: d('old'), currentRevision: d('new'),
  sectionChanges: [{ sectionId: 'SEC-1', kind: 'changed', digest: d('change') }],
  lineageMappings: [{ entityKind: 'requirement', semanticKey: 'order:list', disposition: 'preserved',
    previousIds: ['REQ-1'], currentIds: ['REQ-1'], confidence: 1, confirmation: 'deterministic-exact',
    rationale: 'semanticKey 精确一致', sourceRefs: ['prd.md#req-1'] }],
  impactedEntityIds: ['REQ-1'],
})
const coverageDispositionSubject = projectCoverageDispositionDecisionSubject({
  obligationId: 'COV-NA-1', requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage-policy'),
  disposition: 'not-applicable', policyCode: 'POLICY-NO-BULK', rationale: '产品不提供批量入口',
})

describe('LocalApprovalAuthority DecisionReceipt', () => {
  const now = () => new Date('2026-07-12T01:00:00.000Z')
  const authority = () => LocalApprovalAuthority.create({
    issuer: 'AUTHORITY', keyId: 'KEY-1', now,
    manualIdentities: [
      { subject: 'scope-alice', roles: ['scope-approver'] },
      { subject: 'lineage-bob', roles: ['lineage-approver'] },
      { subject: 'coverage-dora', roles: ['coverage-approver'] },
      { subject: 'privacy-carol', roles: ['privacy-approver'] },
    ],
  })

  it.each([
    ['scope', scopeSubject, 'SCOPE-1', 'scope-alice', 'scope-approver'],
    ['lineage', lineageSubject, 'LINEAGE-1', 'lineage-bob', 'lineage-approver'],
    ['coverage-disposition', coverageDispositionSubject, 'COVERAGE-NA-1', 'coverage-dora', 'coverage-approver'],
  ] as const)('只允许登记的对应角色签发 %s receipt，且可由固定 material 跨进程验签',
    (kind, decisionSubject, decisionId, subject, role) => {
      const local = authority()
      const receipt = local.issueDecisionReceipt({
        kind, decisionId, decisionStatus: 'approved', decisionSubject,
        approver: { subject, roles: [role] },
      })
      const material = local.decisionVerifierMaterial
      const verify = createDecisionReceiptVerifier(material, material.publicKeyDigest, now)
      expect(receipt).toMatchObject({
        kind, decisionId, decisionStatus: 'approved', checkedAt: now().toISOString(),
        decisionSubjectDigest: digestDecisionSubject(decisionSubject),
        purpose: `${kind}-decision-receipt/v1`, keyId: 'KEY-1:decision',
      })
      expect(receipt.nonce).toMatch(/^[a-f0-9]{64}$/)
      expect(verify(receipt, { kind, decisionId, decisionStatus: 'approved',
        decisionSubjectDigest: digestDecisionSubject(decisionSubject) })).toBe(true)
    })

  it('拒绝未登记、wrong role 与跨 kind approver', () => {
    const local = authority()
    for (const approver of [
      { subject: 'mallory', roles: ['scope-approver'] },
      { subject: 'scope-alice', roles: ['lineage-approver'] },
      { subject: 'lineage-bob', roles: ['lineage-approver'] },
    ]) expect(() => local.issueDecisionReceipt({
      kind: 'scope', decisionId: 'SCOPE-1', decisionStatus: 'approved', decisionSubject: scopeSubject, approver,
    })).toThrowError(/scope-approver|登记/)
  })

  it('拒绝 key substitution、purpose/status/id/subject tamper 与通用 Artifact 签名替换', () => {
    const local = authority()
    const binding = { kind: 'scope' as const, decisionId: 'SCOPE-1', decisionStatus: 'approved' as const,
      decisionSubjectDigest: digestDecisionSubject(scopeSubject) }
    const receipt = local.issueDecisionReceipt({ ...binding, decisionSubject: scopeSubject,
      approver: { subject: 'scope-alice', roles: ['scope-approver'] } })
    const material = local.decisionVerifierMaterial
    const verify = createDecisionReceiptVerifier(material, material.publicKeyDigest, now)
    const other = authority()
    expect(createDecisionReceiptVerifier(other.decisionVerifierMaterial,
      material.publicKeyDigest, now)(receipt, binding)).toBe(false)
    for (const mutation of [
      { ...receipt, purpose: 'lineage-decision-receipt/v1' },
      { ...receipt, decisionStatus: 'rejected' },
      { ...receipt, decisionId: 'OTHER' },
      { ...receipt, decisionSubjectDigest: d('other') },
      { ...receipt, signature: local.signArtifactDigest(receipt.signedDigest).signature },
      { ...receipt, signature: local.issuePrivacyReviewReceipt({
        evidenceId: 'E-1', relativePath: 'evidence/e-1.json', fileDigest: d('file'), outputDigest: d('output'),
        sanitizerProofDigest: d('sanitizer'), policyDigest: d('policy'), decision: 'approved',
        approver: { subject: 'privacy-carol', roles: ['privacy-approver'] },
      }).signature },
    ]) expect(verify(mutation as typeof receipt, binding)).toBe(false)
    expect(verify(receipt, { ...binding, decisionSubjectDigest: d('changed') })).toBe(false)
  })
})
