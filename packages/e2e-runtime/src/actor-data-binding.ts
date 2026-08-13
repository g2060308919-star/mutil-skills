import {
  ActorDataIntentV1Schema,
  ActorDataRequirementV1Schema,
  canonicalizeJson,
  digestText,
  E2EError,
  type ActorDataIntentV1,
  type ActorDataRequirementV1,
  type CompiledPrdRunPlan,
} from '@mutil-skills/e2e-contracts'
import type { TargetContractFact } from './target-contract.js'

export function deriveActorDataRequirements(input: {
  intents: readonly ActorDataIntentV1[]
  plan: CompiledPrdRunPlan
  target: TargetContractFact
}): ActorDataRequirementV1[] {
  const intents = ActorDataIntentV1Schema.array().parse(input.intents)
  const requirements: ActorDataRequirementV1[] = []
  const needOwners = new Set<string>()
  for (const intent of intents) {
    const cases = input.plan.cases.filter((testCase) => testCase.actor === intent.actor)
    if (cases.length === 0) throw actorDataError(
      'E2E_RUNTIME_ACTOR_DATA_INTENT_UNMAPPED',
      `Actor/Data Intent ${intent.intentId} 的 actor 未映射到任何编译 Case`,
    )
    for (const testCase of cases) {
      for (const need of intent.dataNeeds) {
        const key = `${testCase.caseId}\u0000${need.needId}`
        if (needOwners.has(key)) throw actorDataError(
          'E2E_RUNTIME_ACTOR_DATA_NEED_AMBIGUOUS',
          `Case ${testCase.caseId} 的 Data Need ${need.needId} 被多个 Intent 声明`,
        )
        needOwners.add(key)
      }
      const requirementId = `DATAREQ-${digestText('e2e-actor-data-requirement-id/v1', canonicalizeJson({
        intentId: intent.intentId, caseId: testCase.caseId,
        targetIdentity: input.target.contractDigest,
      })).slice(7, 39).toUpperCase()}`
      requirements.push(ActorDataRequirementV1Schema.parse({
        schemaVersion: 'actor-data-requirement/v1', requirementId,
        caseId: testCase.caseId, actor: intent.actor, role: intent.role,
        ...(intent.tenant === undefined ? {} : { tenant: intent.tenant }),
        environment: input.target.contract.environmentLabel,
        targetIdentity: input.target.contractDigest,
        ...(intent.credentialRef === undefined ? {} : { credentialRef: intent.credentialRef }),
        dataNeeds: intent.dataNeeds,
      }))
    }
  }
  return requirements.sort((left, right) => left.caseId.localeCompare(right.caseId)
    || left.requirementId.localeCompare(right.requirementId))
}

export function assertActorDataBinding(input: {
  requirements: readonly ActorDataRequirementV1[]
  binding: { cases: ReadonlyArray<{ caseId: string; dataNeeds: ReadonlyArray<{
    dataNeedId: string; kind: 'fixture' | 'secret' | 'record'; ref: string
  }> }> }
}): void {
  const requirements = ActorDataRequirementV1Schema.array().parse(input.requirements)
  for (const requirement of requirements) {
    const testCase = input.binding.cases.find((candidate) => candidate.caseId === requirement.caseId)
    if (testCase === undefined) throw incomplete(requirement, '缺少对应 Case')
    for (const need of requirement.dataNeeds) {
      const bound = testCase.dataNeeds.find((candidate) => candidate.dataNeedId === need.needId)
      if (bound?.kind !== 'fixture' || bound.ref !== requirement.requirementId) {
        throw incomplete(requirement, `Data Need ${need.needId} 未以 fixture 引用 Runtime Requirement`)
      }
    }
  }
}

function incomplete(requirement: ActorDataRequirementV1, reason: string): E2EError {
  return actorDataError('E2E_RUNTIME_ACTOR_DATA_BINDING_INCOMPLETE',
    `${requirement.caseId}/${requirement.requirementId}: ${reason}`)
}

function actorDataError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'input', message, retryable: false })
}
