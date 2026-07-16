import { describe, expect, it } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import { auditDecisionReceipts } from '../src/index.js'
import { completeGenerationFixture } from './complete-generation.fixture.js'

const d = (value: string) => digestText('test/v1', value)
function facts() {
  const input = completeGenerationFixture()
  const artifacts = [
    { artifactId: 'SCOPE', artifactType: 'acceptance-scope', content: {
      ...(input.drafts['acceptance-scope'].content as Record<string, unknown>),
    } },
    { artifactId: 'DIFF', artifactType: 'prd-diff', content: {
      ...(input.drafts['prd-diff'].content as Record<string, unknown>),
    } },
  ]
  const verifier = input.authority.verifyDecisionReceipt
  return { artifacts, verifier }
}

describe('generation decision receipt 动态审计', () => {
  it('从本代事实重建 scope/lineage subject 并验专用 receipt', () => {
    const { artifacts, verifier } = facts()
    expect(auditDecisionReceipts(artifacts, verifier)).toEqual({ valid: true, findings: [] })
    expect(auditDecisionReceipts(artifacts).findings.map((item) => item.code))
      .toContain('E2E_GENERATION_DECISION_VERIFIER_UNAVAILABLE')
  })

  it.each([
    ['scope dependency', (artifacts: any[]) => { artifacts[0].content.dependencies = [{ dependencyId: 'DEP-X', status: 'available', digest: d('changed') }] }],
    ['scope visual', (artifacts: any[]) => { artifacts[0].content.visualScope.required = true }],
    ['scope browser', (artifacts: any[]) => { artifacts[0].content.browserScope.browserIds = ['firefox'] }],
    ['scope exclusion', (artifacts: any[]) => { artifacts[0].content.exclusions = [{ reqId: 'REQ-2', rationale: 'x', decisionId: 'D' }] }],
    ['lineage current revision', (artifacts: any[]) => { artifacts[1].content.currentRevision = d('changed') }],
    ['lineage changes', (artifacts: any[]) => { artifacts[1].content.sectionChanges = [{ sectionId: 'SEC-X', kind: 'changed', digest: d('changed') }] }],
  ])('拒绝复用旧 receipt 后修改 %s', (_name, mutate) => {
    const { artifacts, verifier } = facts()
    mutate(artifacts)
    expect(auditDecisionReceipts(artifacts, verifier).valid).toBe(false)
  })

  it('拒绝 status/decisionId/receipt tamper，pending 则不伪造 approved', () => {
    const { artifacts, verifier } = facts()
    ;(artifacts[0]!.content as any).scopeDecision.status = 'rejected'
    expect(auditDecisionReceipts(artifacts, verifier).valid).toBe(false)
    ;(artifacts[0]!.content as any).scopeDecision.status = 'approved'
    ;(artifacts[0]!.content as any).scopeDecision.decisionId = 'OTHER'
    expect(auditDecisionReceipts(artifacts, verifier).valid).toBe(false)
    ;(artifacts[0]!.content as any).scopeDecision = { decisionId: 'SCOPE-1', status: 'pending' }
    expect(auditDecisionReceipts(artifacts, verifier).findings
      .filter((item) => item.artifactId === 'SCOPE')).toEqual([])
  })
})
