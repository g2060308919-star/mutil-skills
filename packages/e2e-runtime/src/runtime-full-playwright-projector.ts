import {
  ArtifactSchemaRegistry,
  CleanupPlanDefinitionSchema,
  FullPlaywrightProgramSchema,
  SignedGrantSchema,
  canonicalizeJson,
  digestApprovalProjection,
  digestCleanupPlanDefinition,
  digestText,
  type ArtifactDocument,
  type BrowserLocalReversibleWriteCapability,
  type CleanupPlanDefinition,
  type FullPlaywrightProgram,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

export interface RuntimeFullPlaywrightProjection {
  readonly caseId: string
  readonly stepId: string
  readonly actionId: string
  readonly program: Readonly<FullPlaywrightProgram>
  readonly cleanupPlan: Readonly<Extract<CleanupPlanDefinition, { schemaVersion: '2.0.0' }>>
  readonly grant: Readonly<SignedWriteGrant>
  readonly capability: Readonly<BrowserLocalReversibleWriteCapability>
  readonly targetFingerprint: string
  readonly sourceSetDigest: string
  readonly generationId: string
}

export function projectRuntimeFullPlaywrightSnapshot(
  snapshot: RuntimeRunSnapshot,
): RuntimeFullPlaywrightProjection {
  const testCases = frozen(snapshot, 'test-cases')
  const execution = frozen(snapshot, 'execution-contract')
  const actionMap = frozen(snapshot, 'browser-action-map')
  const runBundle = frozen(snapshot, 'run-bundle')
  const documents = [testCases, execution, actionMap, runBundle]
  if (documents.some((document) => document.assetId !== snapshot.assetId
    || document.prdRevision !== testCases.prdRevision
    || document.generationId !== testCases.generationId)) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_ARTIFACT_IDENTITY_MISMATCH')
  }
  const executionContent = execution.content as Record<string, unknown>
  const actionMapContent = actionMap.content as Record<string, unknown>
  if (executionContent.executionProfile !== 'full-playwright'
    || actionMapContent.executionProfile !== 'full-playwright') {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_PROFILE_REQUIRED')
  }
  const actions = actionMapContent.actions
  if (!Array.isArray(actions) || actions.length !== 1 || !record(actions[0])) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_ACTION_AMBIGUOUS')
  }
  const action = actions[0]
  if (action.effect !== 'reversible-write' || action.playwrightAction !== 'full-playwright/v1'
    || !Array.isArray(action.locatorCandidates) || action.locatorCandidates.length !== 0
    || !Array.isArray(action.capabilities) || action.capabilities.length !== 1
    || !record(action.capabilities[0]) || action.capabilities[0].operation !== 'full-playwright') {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_ACTION_INVALID')
  }
  const programs = [executionContent.fullPlaywrightPrograms, actionMapContent.fullPlaywrightPrograms]
    .map((value) => Array.isArray(value) && value.length === 1
      ? FullPlaywrightProgramSchema.safeParse(value[0]) : undefined)
  if (programs.some((parsed) => parsed === undefined || !parsed.success)) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_PROGRAM_INVALID')
  }
  const executionProgram = programs[0]!.data!
  const actionProgram = programs[1]!.data!
  if (canonicalizeJson(executionProgram) !== canonicalizeJson(actionProgram)
    || executionProgram.actionId !== action.actionId || executionProgram.caseId !== action.caseId
    || executionProgram.stepId !== action.stepId) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_PROGRAM_BINDING_MISMATCH')
  }
  const plans = executionContent.writeCleanupPlans
  if (!Array.isArray(plans) || plans.length !== 1) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_CLEANUP_AMBIGUOUS')
  }
  const parsedPlan = CleanupPlanDefinitionSchema.safeParse(plans[0])
  if (!parsedPlan.success || parsedPlan.data.schemaVersion !== '2.0.0') {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_CLEANUP_INVALID')
  }
  const cleanupPlan = parsedPlan.data
  const cases = (testCases.content as Record<string, unknown>).cases
  const selectedCases = Array.isArray(cases)
    ? cases.filter((candidate) => record(candidate) && candidate.caseId === executionProgram.caseId) : []
  const steps = selectedCases.length === 1 && Array.isArray(selectedCases[0]!.steps)
    ? selectedCases[0]!.steps as unknown[] : []
  if (selectedCases.length !== 1 || selectedCases[0]!.effect !== 'reversible-write'
    || selectedCases[0]!.cleanupPlanId !== cleanupPlan.cleanupPlanId
    || steps.filter((step) => record(step) && step.stepId === executionProgram.stepId).length !== 1) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_CASE_BINDING_MISMATCH')
  }
  const intents = executionContent.actionIntents
  const queue = executionContent.caseQueue
  const dataNeeds = executionContent.dataNeeds
  if (!Array.isArray(intents) || intents.length !== 1 || !record(intents[0])
    || intents[0].actionId !== executionProgram.actionId || intents[0].effect !== 'reversible-write'
    || !Array.isArray(queue) || queue.length !== 1 || !record(queue[0])
    || queue[0].caseId !== executionProgram.caseId
    || !Array.isArray(dataNeeds) || dataNeeds.filter((need) => record(need)
      && need.leaseId === executionProgram.dataLeaseId && need.mode === 'write').length !== 1) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_CONTRACT_BINDING_MISMATCH')
  }
  if (cleanupPlan.actionId !== executionProgram.actionId || cleanupPlan.leaseId !== executionProgram.dataLeaseId
    || cleanupPlan.cleanupPlanId !== executionProgram.cleanupPlanId
    || cleanupPlan.cleanupProgramDigest !== executionProgram.cleanupSourceDigest
    || canonicalizeJson(cleanupPlan.cleanupRequestIntentIds)
      !== canonicalizeJson(executionProgram.networkRequests.map((request) => request.intentId)
        .filter((intentId) => cleanupPlan.cleanupRequestIntentIds.includes(intentId)))) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_CLEANUP_BINDING_MISMATCH')
  }
  const grant = parseWriteGrant(snapshot.trustedExecutionFacts['signed-execution-grant'])
  if (grant.approvalContext.runId !== snapshot.runId
    || grant.approvalContext.installationDigest !== snapshot.runtimeInstallationDigest
    || grant.subject.assetId !== snapshot.assetId || grant.subject.prdRevision !== testCases.prdRevision
    || grant.subject.caseDigest !== digestApprovalProjection('test-cases', testCases.content)
    || grant.subject.executionContractDigest !== digestApprovalProjection('execution-contract', execution.content)
    || grant.subject.actionMapDigest !== digestApprovalProjection('browser-action-map', actionMap.content)
    || grant.subject.runBundleProjectionDigest !== digestApprovalProjection('run-bundle', runBundle.content)) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_GRANT_BINDING_MISMATCH')
  }
  const capabilities = grant.capabilities.filter((candidate): candidate is BrowserLocalReversibleWriteCapability =>
    candidate.actionId === executionProgram.actionId && candidate.transport === 'browser-local'
      && candidate.operation === 'full-playwright')
  const subjectActions = grant.subject.actions.filter((candidate) => candidate.actionId === executionProgram.actionId
    && 'transport' in candidate && candidate.transport === 'browser-local')
  if (capabilities.length !== 1 || subjectActions.length !== 1
    || grant.capabilities.filter((candidate) => candidate.actionId === executionProgram.actionId).length !== 1) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_CAPABILITY_AMBIGUOUS')
  }
  const capability = capabilities[0]
  const subjectAction = subjectActions[0] as Extract<SignedWriteGrant['subject']['actions'][number],
    { transport: 'browser-local' }>
  const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan)
  if (capability.capabilityId !== action.capabilities[0].capabilityId
    || capability.programDigest !== executionProgram.sourceDigest
    || capability.cleanupProgramDigest !== executionProgram.cleanupSourceDigest
    || capability.dataLeaseId !== executionProgram.dataLeaseId
    || capability.cleanupPlanDigest !== cleanupPlanDigest
    || canonicalizeJson(capability.requests) !== canonicalizeJson(executionProgram.networkRequests)
    || canonicalizeJson(subjectAction.requests) !== canonicalizeJson(executionProgram.networkRequests)
    || subjectAction.programDigest !== executionProgram.sourceDigest
    || subjectAction.cleanupProgramDigest !== executionProgram.cleanupSourceDigest
    || subjectAction.cleanupPlanDigest !== cleanupPlanDigest) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_FROZEN_BINDING_MISMATCH')
  }
  const targetFingerprints = [...new Set(executionProgram.networkRequests
    .map((request) => request.targetFingerprint))]
  if (targetFingerprints.length !== 1) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_TARGET_AMBIGUOUS')
  }
  const runContent = runBundle.content as Record<string, unknown>
  const schedule = runContent.schedule
  const signedCapabilities = runContent.signedCapabilities
  if (!Array.isArray(schedule) || schedule.length !== 1 || !record(schedule[0])
    || schedule[0].caseId !== executionProgram.caseId
    || canonicalizeJson(schedule[0].stepIds) !== canonicalizeJson([executionProgram.stepId])
    || canonicalizeJson(schedule[0].actionIds) !== canonicalizeJson([executionProgram.actionId])
    || !Array.isArray(signedCapabilities) || signedCapabilities.length !== 1
    || !record(signedCapabilities[0]) || signedCapabilities[0].capabilityId !== capability.capabilityId
    || signedCapabilities[0].digest !== digestText('approval-capability/v1', canonicalizeJson(capability))) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_RUN_BUNDLE_MISMATCH')
  }
  const sourceSetDigest = digestText('full-playwright-runtime-source-set/v1', canonicalizeJson({
    actionId: executionProgram.actionId,
    sourceDigest: executionProgram.sourceDigest,
    cleanupSourceDigest: executionProgram.cleanupSourceDigest,
  }))
  return Object.freeze({
    caseId: executionProgram.caseId, stepId: executionProgram.stepId, actionId: executionProgram.actionId,
    program: Object.freeze(structuredClone(executionProgram)),
    cleanupPlan: Object.freeze(structuredClone(cleanupPlan)),
    grant: Object.freeze(structuredClone(grant)), capability: Object.freeze(structuredClone(capability)),
    targetFingerprint: targetFingerprints[0]!, sourceSetDigest, generationId: testCases.generationId,
  })
}

function frozen(snapshot: RuntimeRunSnapshot,
  artifactType: 'test-cases' | 'execution-contract' | 'browser-action-map' | 'run-bundle'): ArtifactDocument {
  const parsed = ArtifactSchemaRegistry[artifactType].safeParse(snapshot.frozenArtifacts[artifactType])
  if (!parsed.success) throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_FROZEN_ARTIFACT_INVALID', parsed.error)
  return parsed.data as ArtifactDocument
}

function parseWriteGrant(value: unknown): SignedWriteGrant {
  const parsed = SignedGrantSchema.safeParse(value)
  if (!parsed.success || !('caseDigest' in parsed.data.subject)) {
    throw projectionError('E2E_RUNTIME_FULL_PLAYWRIGHT_GRANT_INVALID', parsed.success ? undefined : parsed.error)
  }
  return parsed.data as SignedWriteGrant
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectionError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code })
}
