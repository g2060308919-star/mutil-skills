import type { HealingProposal, HealingReviewContext } from '@mutil-skills/e2e-contracts'
import { authorizeHealingRevision, reviewHealingProposal } from './self-healing.js'

export interface BoundedHealingFailure {
  caseId: string
  actionId: string
  attemptId: string
  pageIdentityDigest: string
  evidenceDigest: string
  requiredOracleIds: string[]
}

export type BoundedHealingResult =
  | { status: 'blocked'; reasonCode: string; firstAttemptId: string; recoveryRateSample: 0; falseRepairRateSample: 0 }
  | { status: 'recovered'; firstAttemptId: string; finalAttemptId: string; revision: number;
      actionMapDigest: string; recoveryRateSample: 1; falseRepairRateSample: 0 }
  | { status: 'misrepair'; reasonCode: string; firstAttemptId: string; finalAttemptId: string;
      recoveryRateSample: 0; falseRepairRateSample: 1 }

/**
 * 有界 healing 协调器：只复用 Engine review，不决定 Runtime workflow。
 * 调用方负责把返回事实交还 RuntimeHost，以新 Attempt 进入现有状态边。
 */
export async function executeBoundedHealing(input: {
  proposal: HealingProposal
  failure: BoundedHealingFailure
  observedPageIdentityDigest?: string
  context: HealingReviewContext
  priorAttempts: number
  maxAttempts: number
  authorize(review: ReturnType<typeof reviewHealingProposal>): Promise<boolean>
  execute(input: { proposal: HealingProposal; revision: number; actionMapDigest: string;
    failedAttemptId: string; evidenceDigest: string; requiredOracleIds: string[] }): Promise<{
      attemptId: string; oracleResults: Array<{ oracleId: string; status: 'passed' | 'failed' }>
    }>
}): Promise<BoundedHealingResult> {
  const firstAttemptId = input.failure.attemptId
  if (!Number.isSafeInteger(input.priorAttempts) || !Number.isSafeInteger(input.maxAttempts)
    || input.maxAttempts < 1 || input.priorAttempts >= input.maxAttempts) return blocked(
    'E2E_HEAL_ATTEMPT_LIMIT_REACHED', firstAttemptId,
  )
  if (input.proposal.actionId !== input.failure.actionId) return blocked(
    'E2E_HEAL_FAILURE_BINDING_MISMATCH', firstAttemptId,
  )
  if (input.observedPageIdentityDigest !== undefined
    && input.observedPageIdentityDigest !== input.failure.pageIdentityDigest) return blocked(
    'E2E_HEAL_PAGE_IDENTITY_CHANGED', firstAttemptId,
  )
  const review = reviewHealingProposal(input.proposal, input.context)
  if (!review.accepted) return blocked(review.reasonCodes[0] ?? 'E2E_HEAL_REVIEW_REJECTED', firstAttemptId)
  const approved = await input.authorize(review)
  const authorization = authorizeHealingRevision({ review, freshApprovalValid: approved })
  if (!authorization.allowed) return blocked(authorization.reasonCode, firstAttemptId)
  const rerun = await input.execute({ proposal: input.proposal, revision: review.nextRevision,
    actionMapDigest: review.actionMapDigest, failedAttemptId: firstAttemptId,
    evidenceDigest: input.failure.evidenceDigest, requiredOracleIds: [...input.failure.requiredOracleIds] })
  const results = new Map(rerun.oracleResults.map((item) => [item.oracleId, item.status]))
  const allOraclesPassed = input.failure.requiredOracleIds.length > 0
    && input.failure.requiredOracleIds.every((oracleId) => results.get(oracleId) === 'passed')
    && results.size === new Set(input.failure.requiredOracleIds).size
  if (!allOraclesPassed) return { status: 'misrepair', reasonCode: 'E2E_HEAL_ORACLE_SET_INCOMPLETE',
    firstAttemptId, finalAttemptId: rerun.attemptId, recoveryRateSample: 0, falseRepairRateSample: 1 }
  return { status: 'recovered', firstAttemptId, finalAttemptId: rerun.attemptId,
    revision: review.nextRevision, actionMapDigest: review.actionMapDigest,
    recoveryRateSample: 1, falseRepairRateSample: 0 }
}

function blocked(reasonCode: string, firstAttemptId: string): BoundedHealingResult {
  return { status: 'blocked', reasonCode, firstAttemptId, recoveryRateSample: 0, falseRepairRateSample: 0 }
}
