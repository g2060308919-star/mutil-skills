import { describe, expect, test } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import {
  authorizeHealingRevision,
  reviewHealingProposal,
  type HealingProposal,
  type HealingReviewContext,
} from '../src/index.js'

const semanticDigest = digestText('semantic/v1', 'approve order assertion')
const approvalDigest = digestText('approval/v1', 'subject')
const context: HealingReviewContext = {
  currentSemanticDigest: semanticDigest,
  currentApprovalSubjectDigest: approvalDigest,
  protectedPageIdentitySignals: ['required-order-heading'],
}

function review(input: HealingProposal) {
  return reviewHealingProposal(input, context)
}

function proposal(mutations: HealingProposal['mutations']): HealingProposal {
  return {
    proposalId: 'HEAL-1', actionId: 'ACTION-1', baseRevision: 3, caseTimeoutMs: 10_000,
    semanticDigestBefore: semanticDigest, semanticDigestAfter: semanticDigest,
    approvalSubjectDigestBefore: approvalDigest, approvalSubjectDigestAfter: approvalDigest,
    mutations,
  }
}

describe('reviewHealingProposal', () => {
  test('accepts a bounded locator candidate change and produces a deterministic new revision', () => {
    const input = proposal([{
      kind: 'locator-candidate',
      before: [{ strategy: 'role', value: 'button:批准' }],
      after: [{ strategy: 'test-id', value: 'approve-order' }],
    }])

    const first = review(input)
    const second = review(input)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      accepted: true, nextRevision: 4, requiresReapproval: false,
      actionMapDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(authorizeHealingRevision({ review: first, freshApprovalValid: false })).toEqual({
      allowed: true, reasonCode: 'E2E_HEAL_EXECUTION_ALLOWED',
    })
  })

  test('rejects semantic changes and unsupported expected/oracle mutations', () => {
    const changed = proposal([{
      kind: 'locator-candidate', before: [{ strategy: 'role', value: 'button:批准' }],
      after: [{ strategy: 'role', value: 'button:确认删除' }],
    }])
    changed.semanticDigestAfter = digestText('semantic/v1', 'delete order assertion')
    expect(review(changed)).toMatchObject({
      accepted: false, reasonCodes: expect.arrayContaining(['E2E_HEAL_SEMANTIC_CHANGE_DENIED']),
    })

    const unsupported = proposal([{ kind: 'expected', before: '待审核', after: '已批准' }] as never)
    expect(review(unsupported)).toMatchObject({
      accepted: false, reasonCodes: expect.arrayContaining(['E2E_HEAL_MUTATION_KIND_DENIED']),
    })
  })

  test('allows only independently known equivalent Playwright actions', () => {
    expect(review(proposal([{
      kind: 'equivalent-action', before: 'locator.click', after: 'getByRole.click',
    }]))).toMatchObject({ accepted: true })
    expect(review(proposal([{
      kind: 'equivalent-action', before: 'locator.click', after: 'locator.fill',
    }]))).toMatchObject({
      accepted: false, reasonCodes: expect.arrayContaining(['E2E_HEAL_ACTION_NOT_EQUIVALENT']),
    })
  })

  test('allows explicit waits within the case timeout and rejects arbitrary sleep', () => {
    expect(review(proposal([{
      kind: 'wait-condition', before: { kind: 'visible', timeoutMs: 2_000 },
      after: { kind: 'attached', timeoutMs: 5_000 },
    }]))).toMatchObject({ accepted: true })
    expect(review(proposal([{
      kind: 'wait-condition', before: { kind: 'visible', timeoutMs: 2_000 },
      after: { kind: 'sleep' as 'visible', timeoutMs: 5_000 },
    }]))).toMatchObject({
      accepted: false, reasonCodes: expect.arrayContaining(['E2E_HEAL_WAIT_NOT_EXPLICIT']),
    })
  })

  test('requires fresh approval when a technical injection matcher changes the approval subject', () => {
    const input = proposal([{
      kind: 'injection-technical-matcher', before: '/api/orders/:id', after: '/api/orders/{orderId}',
    }])
    input.approvalSubjectDigestAfter = digestText('approval/v1', 'changed subject')
    const result = review(input)

    expect(result).toMatchObject({ accepted: true, requiresReapproval: true })
    expect(authorizeHealingRevision({ review: result, freshApprovalValid: false })).toEqual({
      allowed: false, reasonCode: 'E2E_HEAL_FRESH_APPROVAL_REQUIRED',
    })
    expect(authorizeHealingRevision({ review: result, freshApprovalValid: true })).toEqual({
      allowed: true, reasonCode: 'E2E_HEAL_EXECUTION_ALLOWED',
    })
  })

  test('checks page identity and evidence mutations against the trusted review context', () => {
    expect(review(proposal([
      {
        kind: 'page-identity-nonrequirement-signal',
        before: { name: 'decorative-subtitle', value: '旧文案' },
        after: { name: 'decorative-subtitle', value: '新文案' },
      },
      { kind: 'evidence-capture-point', before: ['after-navigation'], after: ['after-assertion'] },
    ]))).toMatchObject({ accepted: true })

    expect(review(proposal([{
      kind: 'page-identity-nonrequirement-signal',
      before: { name: 'required-order-heading', value: '订单' },
      after: { name: 'required-order-heading', value: '审批' },
    }]))).toMatchObject({
      accepted: false, reasonCodes: expect.arrayContaining(['E2E_HEAL_REQUIRED_PAGE_SIGNAL_DENIED']),
    })
  })

  test('rejects a proposal that forges both semantic baseline digests together', () => {
    const forged = digestText('semantic/v1', 'forged delete semantics')
    const input = proposal([{
      kind: 'locator-candidate', before: [{ strategy: 'role', value: 'button:批准' }],
      after: [{ strategy: 'role', value: 'button:删除' }],
    }])
    input.semanticDigestBefore = forged
    input.semanticDigestAfter = forged

    expect(review(input)).toMatchObject({
      accepted: false, reasonCodes: expect.arrayContaining(['E2E_HEAL_TRUSTED_SEMANTIC_BASELINE_MISMATCH']),
    })
  })
})
