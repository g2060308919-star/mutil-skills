import {
  CoverageDispositionSchema,
  E2EError,
  canonicalizeJson,
  digestDecisionSubject,
  digestText,
  projectCoverageDispositionDecisionSubject,
  type CoverageDispositionDraft,
  type CoverageObligation,
  type CoverageObligationCandidate,
  type CoveragePolicy,
  type CoverageUniverse,
  type InteractionNode,
  type RequirementModel,
} from '@mutil-skills/e2e-contracts'

export interface BuildCoverageUniverseInput {
  model: RequirementModel
  modelDigest: string
  confirmedModelDigest: string
  nodes: InteractionNode[]
  policy: CoveragePolicy
  dispositionFor(candidate: CoverageObligationCandidate): CoverageDispositionDraft
}

export function buildCoverageUniverse(input: BuildCoverageUniverseInput): CoverageUniverse {
  if (input.modelDigest !== input.confirmedModelDigest || input.model.modelDecisionDigest !== input.modelDigest) {
    throw coverageError('E2E_COVERAGE_MODEL_NOT_CONFIRMED', '需求模型与用户确认的摘要不一致')
  }

  const coveragePolicyDigest = digestText('coverage-policy/v1', canonicalizeJson(input.policy))
  const candidates = createCandidates(input.model, input.nodes, input.policy)
    .sort((left, right) => compareCandidate(left, right))
  const obligations = candidates.map((candidate): CoverageObligation => {
    const draft = input.dispositionFor(candidate)
    if (draft.kind === 'not-applicable') {
      const receipt = draft.decisionReceipt
      const subjectDigest = digestDecisionSubject(projectCoverageDispositionDecisionSubject({
        obligationId: candidate.obligationId,
        requirementModelDigest: input.modelDigest,
        coveragePolicyDigest,
        disposition: 'not-applicable',
        policyCode: draft.policyCode,
        rationale: draft.rationale,
      }))
      if (!draft.decisionGrantId || !receipt || receipt.kind !== 'coverage-disposition'
        || receipt.decisionId !== draft.decisionGrantId || receipt.decisionStatus !== 'approved'
        || receipt.decisionSubjectDigest !== subjectDigest) {
        throw coverageError('E2E_COVERAGE_NA_UNAPPROVED', `Coverage ${candidate.obligationId} 的 N/A 未绑定有效决定`)
      }
    }
    const disposition = CoverageDispositionSchema.parse(draft)
    return { ...candidate, disposition }
  })
  const universeDigest = digestText('coverage-universe/v1', canonicalizeJson({
    coveragePolicyDigest,
    pairwiseSeed: input.policy.pairwiseSeed,
    obligations,
  }))

  return { coveragePolicyDigest, pairwiseSeed: input.policy.pairwiseSeed, obligations, universeDigest }
}

function createCandidates(model: RequirementModel, nodes: InteractionNode[], policy: CoveragePolicy): CoverageObligationCandidate[] {
  const candidates: CoverageObligationCandidate[] = []
  for (const requirement of [...model.requirements].filter((item) => item.status === 'active').sort(byId('reqId'))) {
    for (const applicability of requirement.applicability.filter((item) => item.required && item.dimension === 'actor').sort(byId('value'))) {
      candidates.push(candidate({
        kind: 'actor', reqId: requirement.reqId, actor: applicability.value,
        scenario: 'required-actor', applicabilityRuleId: `actor:${applicability.value}`,
      }))
    }
    for (const node of nodes.filter((item) => item.reqId === requirement.reqId && isCriticalNode(item)).sort(byId('nodeId'))) {
      candidates.push(candidate({
        kind: 'critical-node', reqId: requirement.reqId, nodeIds: [node.nodeId],
        scenario: 'critical-interaction', applicabilityRuleId: `node:${node.nodeId}`,
      }))
    }
    for (const rule of [...requirement.rules].sort(byId('ruleId'))) {
      const scenarios = policy.ruleScenarios[rule.category]
      if (!scenarios || scenarios.length === 0) {
        throw coverageError('E2E_COVERAGE_POLICY_INCOMPLETE', `规则类别 ${rule.category} 没有场景策略`)
      }
      for (const scenario of [...scenarios].sort()) {
        candidates.push(candidate({
          kind: 'rule', reqId: requirement.reqId, ruleIds: [rule.ruleId], scenario,
          applicabilityRuleId: `rule:${rule.ruleId}:${scenario}`,
        }))
      }
    }
    for (const transition of [...requirement.transitions].sort(byId('transitionId'))) {
      candidates.push(candidate({
        kind: 'transition', reqId: requirement.reqId, transitionId: transition.transitionId,
        scenario: 'state-transition', applicabilityRuleId: `transition:${transition.transitionId}`,
      }))
    }
  }
  return candidates
}

function candidate(input: {
  kind: CoverageObligationCandidate['kind']
  reqId: string
  ruleIds?: string[]
  nodeIds?: string[]
  actor?: string
  transitionId?: string
  scenario: string
  applicabilityRuleId: string
}): CoverageObligationCandidate {
  const key = {
    kind: input.kind,
    reqId: input.reqId,
    ruleIds: input.ruleIds ?? [],
    nodeIds: input.nodeIds ?? [],
    actor: input.actor ?? 'not-applicable',
    transitionId: input.transitionId ?? 'not-applicable',
    scenario: input.scenario,
    applicabilityRuleId: input.applicabilityRuleId,
  }
  const suffix = digestText('coverage-obligation/v1', canonicalizeJson(key)).slice('sha256:'.length, 19).toUpperCase()
  return { obligationId: `COV-${suffix}`, necessity: 'required', ...key }
}

function isCriticalNode(node: InteractionNode): boolean {
  return node.hasOracle || node.effect !== 'read' || ['entry', 'exit', 'decision', 'state'].includes(node.kind)
}

function compareCandidate(left: CoverageObligationCandidate, right: CoverageObligationCandidate): number {
  return left.kind.localeCompare(right.kind) || left.obligationId.localeCompare(right.obligationId)
}

function byId<Key extends string>(key: Key): (left: Record<Key, string>, right: Record<Key, string>) => number {
  return (left, right) => left[key].localeCompare(right[key])
}

function coverageError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'validation', message, retryable: false })
}
