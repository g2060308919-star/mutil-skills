import {
  canonicalizeJson,
  digestText,
  type ExplicitWaitCondition,
  type HealingMutation,
  type HealingProposal,
  type HealingReviewContext,
  type HealingReview,
  type LocatorCandidate,
} from '@mutil-skills/e2e-contracts'

const DigestPattern = /^sha256:[a-f0-9]{64}$/
const equivalentActions = [
  new Set(['click', 'locator.click', 'getByRole.click']),
  new Set(['fill', 'locator.fill', 'getByLabel.fill']),
  new Set(['selectOption', 'locator.selectOption', 'getByLabel.selectOption']),
  new Set(['press', 'locator.press', 'getByRole.press']),
]

export type { HealingProposal, HealingReviewContext } from '@mutil-skills/e2e-contracts'

export function reviewHealingProposal(proposal: HealingProposal, context: HealingReviewContext): HealingReview {
  const reasons: string[] = []
  if (!proposal.proposalId || !proposal.actionId || !Number.isSafeInteger(proposal.baseRevision) || proposal.baseRevision < 1) {
    reasons.push('E2E_HEAL_PROPOSAL_INVALID')
  }
  if (!Number.isSafeInteger(proposal.caseTimeoutMs) || proposal.caseTimeoutMs < 1) reasons.push('E2E_HEAL_TIMEOUT_INVALID')
  if (
    !DigestPattern.test(proposal.semanticDigestBefore)
    || !DigestPattern.test(proposal.semanticDigestAfter)
    || !DigestPattern.test(proposal.approvalSubjectDigestBefore)
    || !DigestPattern.test(proposal.approvalSubjectDigestAfter)
  ) {
    reasons.push('E2E_HEAL_DIGEST_INVALID')
  }
  if (proposal.semanticDigestBefore !== proposal.semanticDigestAfter) reasons.push('E2E_HEAL_SEMANTIC_CHANGE_DENIED')
  if (
    proposal.semanticDigestBefore !== context.currentSemanticDigest
    || proposal.semanticDigestAfter !== context.currentSemanticDigest
  ) {
    reasons.push('E2E_HEAL_TRUSTED_SEMANTIC_BASELINE_MISMATCH')
  }
  if (proposal.approvalSubjectDigestBefore !== context.currentApprovalSubjectDigest) {
    reasons.push('E2E_HEAL_TRUSTED_APPROVAL_BASELINE_MISMATCH')
  }
  if (!Array.isArray(proposal.mutations) || proposal.mutations.length < 1 || proposal.mutations.length > 20) {
    reasons.push('E2E_HEAL_MUTATION_COUNT_INVALID')
  } else {
    for (const mutation of proposal.mutations) reasons.push(...validateMutation(mutation, proposal.caseTimeoutMs, context))
  }
  const reasonCodes = [...new Set(reasons)].sort()
  if (reasonCodes.length > 0) return { accepted: false, reasonCodes }

  const requiresReapproval = proposal.approvalSubjectDigestBefore !== proposal.approvalSubjectDigestAfter
    || proposal.mutations.some((mutation) => mutation.kind === 'injection-technical-matcher')
  const nextRevision = proposal.baseRevision + 1
  const actionMapDigest = digestText('action-map-healing-revision/v1', canonicalizeJson({
    proposalId: proposal.proposalId,
    actionId: proposal.actionId,
    baseRevision: proposal.baseRevision,
    nextRevision,
    semanticDigest: proposal.semanticDigestAfter,
    approvalSubjectDigest: proposal.approvalSubjectDigestAfter,
    mutations: proposal.mutations,
  }))
  return { accepted: true, reasonCodes: [], nextRevision, actionMapDigest, requiresReapproval }
}

export function authorizeHealingRevision(input: {
  review: HealingReview
  freshApprovalValid: boolean
}): { allowed: boolean; reasonCode: string } {
  if (!input.review.accepted) return { allowed: false, reasonCode: 'E2E_HEAL_REVIEW_REJECTED' }
  if (input.review.requiresReapproval && !input.freshApprovalValid) {
    return { allowed: false, reasonCode: 'E2E_HEAL_FRESH_APPROVAL_REQUIRED' }
  }
  return { allowed: true, reasonCode: 'E2E_HEAL_EXECUTION_ALLOWED' }
}

function validateMutation(
  mutation: HealingMutation,
  caseTimeoutMs: number,
  context: HealingReviewContext,
): string[] {
  if (!mutation || typeof mutation !== 'object' || typeof (mutation as { kind?: unknown }).kind !== 'string') {
    return ['E2E_HEAL_MUTATION_KIND_DENIED']
  }
  switch (mutation.kind) {
    case 'locator-candidate':
      return validCandidates(mutation.before) && validCandidates(mutation.after) ? [] : ['E2E_HEAL_LOCATOR_INVALID']
    case 'locator-scope':
      return validCandidate(mutation.before) && validCandidate(mutation.after) ? [] : ['E2E_HEAL_SCOPE_INVALID']
    case 'wait-condition':
      return validWait(mutation.before, caseTimeoutMs) && validWait(mutation.after, caseTimeoutMs)
        ? [] : ['E2E_HEAL_WAIT_NOT_EXPLICIT']
    case 'equivalent-action':
      return equivalentActions.some((group) => group.has(mutation.before) && group.has(mutation.after))
        ? [] : ['E2E_HEAL_ACTION_NOT_EQUIVALENT']
    case 'page-identity-nonrequirement-signal':
      if (
        context.protectedPageIdentitySignals.includes(mutation.before.name)
        || context.protectedPageIdentitySignals.includes(mutation.after.name)
      ) return ['E2E_HEAL_REQUIRED_PAGE_SIGNAL_DENIED']
      return validNamedValue(mutation.before) && validNamedValue(mutation.after)
        ? [] : ['E2E_HEAL_PAGE_SIGNAL_INVALID']
    case 'evidence-capture-point':
      return validStringList(mutation.before) && validStringList(mutation.after)
        ? [] : ['E2E_HEAL_EVIDENCE_POINT_INVALID']
    case 'injection-technical-matcher':
      return validTechnicalMatcher(mutation.before) && validTechnicalMatcher(mutation.after)
        ? [] : ['E2E_HEAL_INJECTION_MATCHER_INVALID']
    default:
      return ['E2E_HEAL_MUTATION_KIND_DENIED']
  }
}

function validCandidates(candidates: LocatorCandidate[]): boolean {
  return Array.isArray(candidates) && candidates.length >= 1 && candidates.length <= 10 && candidates.every(validCandidate)
}

function validCandidate(candidate: LocatorCandidate): boolean {
  return candidate !== undefined
    && ['role', 'label', 'test-id', 'css'].includes(candidate.strategy)
    && typeof candidate.value === 'string'
    && candidate.value.length >= 1 && candidate.value.length <= 2_048
    && !['*', 'body', 'html'].includes(candidate.value.trim().toLowerCase())
}

function validWait(wait: ExplicitWaitCondition, caseTimeoutMs: number): boolean {
  return wait !== undefined
    && ['visible', 'attached', 'response', 'url', 'text'].includes(wait.kind)
    && Number.isSafeInteger(wait.timeoutMs) && wait.timeoutMs > 0 && wait.timeoutMs <= caseTimeoutMs
}

function validNamedValue(value: { name: string; value: string }): boolean {
  return value !== undefined && value.name.length > 0 && value.name.length <= 128 && value.value.length <= 2_048
}

function validStringList(values: string[]): boolean {
  return Array.isArray(values) && values.length <= 20 && values.every((value) => value.length > 0 && value.length <= 256)
}

function validTechnicalMatcher(matcher: string): boolean {
  return typeof matcher === 'string' && matcher.startsWith('/') && matcher.length <= 8 * 1024 && !/[*?\\#]/.test(matcher)
}
