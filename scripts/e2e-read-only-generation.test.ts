import { describe, expect, it } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { createReadOnlyGoldenDecisions, createReadOnlyGoldenPendingDecisions } from './e2e-read-only-generation.js'

describe('read-only Golden 的外部 Scope/Lineage 决定', () => {
  it('缺少外部决定时只生成无 receipt 的 pending，不能伪造 approved', () => {
    expect(createReadOnlyGoldenPendingDecisions()).toEqual({
      scopeDecision: { decisionId: 'SCOPE-GOLDEN', status: 'pending' },
      lineageDecision: { decisionId: 'LINEAGE-GOLDEN', status: 'pending' },
    })
  })

  it('外层显式传决定和登记审批人后，由 Authority 实时签发两类专用 receipt', () => {
    const authority = LocalApprovalAuthority.create({ issuer: 'AUTHORITY', keyId: 'KEY-1',
      now: () => new Date('2026-07-12T01:00:00.000Z'), manualIdentities: [
        { subject: 'scope-user', roles: ['scope-approver'] },
        { subject: 'lineage-user', roles: ['lineage-approver'] },
      ] })
    const decisions = createReadOnlyGoldenDecisions({ authority, modelDigest: digestText('test/v1', 'revision'),
      scope: { status: 'approved', approver: { subject: 'scope-user', roles: ['scope-approver'] } },
      lineage: { status: 'approved', approver: { subject: 'lineage-user', roles: ['lineage-approver'] } } })
    expect(decisions.scopeDecision).toMatchObject({ status: 'approved',
      receipt: { kind: 'scope', purpose: 'scope-decision-receipt/v1' } })
    expect(decisions.lineageDecision).toMatchObject({ status: 'approved',
      receipt: { kind: 'lineage', purpose: 'lineage-decision-receipt/v1' } })
  })
})
