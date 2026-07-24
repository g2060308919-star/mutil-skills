import {
  ArtifactSchemaRegistry,
  ApprovalCapabilityRecordSchema,
  canonicalizeJson,
  digestApprovalProjection,
  digestArtifactContent,
  digestText,
  E2EError,
  type ApprovalCapabilityRecord,
  type ArtifactDocument,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

const APPROVAL_INPUT_TYPES = [
  'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
  'test-cases', 'execution-contract', 'browser-action-map',
] as const

export function bindRuntimeExecutionGrantArtifacts(input: {
  snapshot: RuntimeRunSnapshot
  grant: SignedGrant
  createdAt: string
  engineVersion: string
}): RuntimeRunSnapshot {
  const snapshot = structuredClone(input.snapshot)
  const actionMap = requiredArtifact(snapshot, 'browser-action-map')
  const execution = requiredArtifact(snapshot, 'execution-contract')
  const testCases = requiredArtifact(snapshot, 'test-cases')
  const projectPolicy = requiredArtifact(snapshot, 'project-policy')
  const capabilities = approvalCapabilities(input.grant)
  const boundActionMap = bindActionMapCapabilities(actionMap, capabilities)
  const runBundleContent = buildRunBundleContent({
    snapshot,
    actionMap: boundActionMap,
    execution,
    testCases,
    projectPolicy,
    capabilities,
  })
  if (!('runBundleProjectionDigest' in input.grant.subject)
    || input.grant.subject.runBundleProjectionDigest
      !== digestApprovalProjection('run-bundle', runBundleContent)) {
    throw binderError('E2E_RUNTIME_RUN_BUNDLE_APPROVAL_MISMATCH')
  }
  if ('actionMapDigest' in input.grant.subject
    && input.grant.subject.actionMapDigest
      !== digestApprovalProjection('browser-action-map', boundActionMap.content)) {
    throw binderError('E2E_RUNTIME_ACTION_MAP_APPROVAL_MISMATCH')
  }
  const runBundle = createRunBundleArtifact(snapshot, runBundleContent, input)
  snapshot.frozenArtifacts['browser-action-map'] = boundActionMap
  snapshot.frozenArtifacts['run-bundle'] = runBundle
  snapshot.trustedExecutionFacts['signed-execution-grant'] = structuredClone(input.grant)
  snapshot.artifactDigests['browser-action-map'] = boundActionMap.contentDigest
  snapshot.artifactDigests['run-bundle'] = runBundle.contentDigest
  return snapshot
}

function bindActionMapCapabilities(
  source: ArtifactDocument,
  capabilities: ApprovalCapabilityRecord[],
): ArtifactDocument {
  const document = structuredClone(source)
  const content = document.content as Record<string, unknown>
  const actions = Array.isArray(content.actions) ? content.actions : []
  const available = new Map<string, ApprovalCapabilityRecord[]>()
  for (const capability of capabilities) {
    const key = `${capability.actionId}\0${capability.operation}`
    available.set(key, [...(available.get(key) ?? []), capability])
  }
  for (const action of actions) {
    if (!plain(action) || typeof action.actionId !== 'string' || !Array.isArray(action.capabilities)) {
      throw binderError('E2E_RUNTIME_ACTION_MAP_CAPABILITY_BINDING_INVALID')
    }
    for (const candidate of action.capabilities) {
      if (!plain(candidate) || typeof candidate.operation !== 'string') {
        throw binderError('E2E_RUNTIME_ACTION_MAP_CAPABILITY_BINDING_INVALID')
      }
      const key = `${action.actionId}\0${candidate.operation}`
      const matches = available.get(key) ?? []
      if (matches.length !== 1) throw binderError('E2E_RUNTIME_ACTION_MAP_CAPABILITY_BINDING_AMBIGUOUS')
      candidate.capabilityId = matches[0]!.capabilityId
    }
  }
  const boundIds = new Set(actions.flatMap((action) => plain(action) && Array.isArray(action.capabilities)
    ? action.capabilities.flatMap((candidate) => plain(candidate) && typeof candidate.capabilityId === 'string'
      ? [candidate.capabilityId] : []) : []))
  if (boundIds.size !== capabilities.length
    || capabilities.some((capability) => !boundIds.has(capability.capabilityId))) {
    throw binderError('E2E_RUNTIME_ACTION_MAP_CAPABILITY_SET_MISMATCH')
  }
  document.signatures = []
  document.contentDigest = digestArtifactContent(
    `artifact-content/${document.schemaVersion}/${document.artifactType}`,
    document,
  )
  const parsed = ArtifactSchemaRegistry['browser-action-map'].safeParse(document)
  if (!parsed.success) throw binderError('E2E_RUNTIME_ACTION_MAP_CAPABILITY_BINDING_INVALID', parsed.error)
  return parsed.data as ArtifactDocument
}

function buildRunBundleContent(input: {
  snapshot: RuntimeRunSnapshot
  actionMap: ArtifactDocument
  execution: ArtifactDocument
  testCases: ArtifactDocument
  projectPolicy: ArtifactDocument
  capabilities: ApprovalCapabilityRecord[]
}) {
  const execution = input.execution.content as Record<string, unknown>
  const actionMap = input.actionMap.content as Record<string, unknown>
  const cases = ((input.testCases.content as Record<string, unknown>).cases ?? []) as unknown[]
  const actions = (actionMap.actions ?? []) as unknown[]
  const queue = (execution.caseQueue ?? []) as unknown[]
  if (!Array.isArray(cases) || !Array.isArray(actions) || !Array.isArray(queue)) {
    throw binderError('E2E_RUNTIME_RUN_BUNDLE_SOURCE_INVALID')
  }
  const schedule = queue.map((queued, ordinal) => {
    if (!plain(queued) || typeof queued.caseId !== 'string') {
      throw binderError('E2E_RUNTIME_RUN_BUNDLE_SOURCE_INVALID')
    }
    const selectedActions = actions.filter((action) => plain(action) && action.caseId === queued.caseId)
    const stepIds = unique(selectedActions.flatMap((action) => plain(action)
      && typeof action.stepId === 'string' ? [action.stepId] : []))
    const actionIds = selectedActions.flatMap((action) => plain(action)
      && typeof action.actionId === 'string' ? [action.actionId] : [])
    if (stepIds.length === 0 || actionIds.length === 0) {
      throw binderError('E2E_RUNTIME_RUN_BUNDLE_SCHEDULE_INCOMPLETE')
    }
    return { ordinal, caseId: queued.caseId, stepIds, actionIds }
  })
  const scheduledCaseIds = new Set(schedule.map((item) => item.caseId))
  const attemptPlans = cases.flatMap((candidate) => plain(candidate)
    && typeof candidate.caseId === 'string' && scheduledCaseIds.has(candidate.caseId)
    ? [{ caseId: candidate.caseId, slots: 1 }] : [])
  if (attemptPlans.length !== schedule.length) throw binderError('E2E_RUNTIME_RUN_BUNDLE_CASE_INCOMPLETE')
  const runtimePolicy = plain((input.projectPolicy.content as Record<string, unknown>).runtimePolicy)
    ? (input.projectPolicy.content as Record<string, any>).runtimePolicy.digest : undefined
  if (typeof runtimePolicy !== 'string') throw binderError('E2E_RUNTIME_RUN_BUNDLE_POLICY_MISSING')
  const allInputRefs = APPROVAL_INPUT_TYPES.map((type) => {
    const artifact = type === 'browser-action-map'
      ? input.actionMap : requiredArtifact(input.snapshot, type)
    return { artifactId: artifact.artifactId, digest: digestApprovalProjection(type, artifact.content) }
  })
  return ArtifactSchemaRegistry['run-bundle'].shape.content.parse({
    runId: input.snapshot.runId,
    allInputRefs,
    schedule,
    attemptPlans,
    signedCapabilities: input.capabilities,
    secretRefs: collectSecretRefs(execution),
    runtimePolicyDigest: runtimePolicy,
    runtimeIsolationPolicyDigest: 'not-applicable',
  })
}

function createRunBundleArtifact(
  snapshot: RuntimeRunSnapshot,
  content: unknown,
  input: { createdAt: string; engineVersion: string },
): ArtifactDocument {
  const anchor = requiredArtifact(snapshot, 'test-cases')
  const document: Record<string, unknown> = {
    artifactId: 'ARTIFACT-RUN-BUNDLE', artifactType: 'run-bundle', schemaVersion: '2.0.0',
    engineVersion: input.engineVersion, assetId: snapshot.assetId, prdRevision: anchor.prdRevision,
    generationId: anchor.generationId, createdAt: input.createdAt, contentDigest: '', signatures: [],
    dependencies: [], graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent('artifact-content/2.0.0/run-bundle', document)
  const parsed = ArtifactSchemaRegistry['run-bundle'].safeParse(document)
  if (!parsed.success) throw binderError('E2E_RUNTIME_RUN_BUNDLE_INVALID', parsed.error)
  return parsed.data as ArtifactDocument
}

function approvalCapabilities(grant: SignedGrant): ApprovalCapabilityRecord[] {
  return grant.capabilities.map((capability) => {
    if (!('operation' in capability) || !('effect' in capability)) {
      throw binderError('E2E_RUNTIME_EXECUTION_GRANT_KIND_UNSUPPORTED')
    }
    return ApprovalCapabilityRecordSchema.parse({
      capabilityId: capability.capabilityId,
      actionId: capability.actionId,
      operation: capability.operation,
      effect: capability.effect,
      maxUses: capability.maxUses,
      digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
    })
  })
}

function collectSecretRefs(value: unknown): string[] {
  const refs: string[] = []
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 32 || refs.length > 10_000) return
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item, depth + 1); return }
    if (!plain(candidate)) return
    if (typeof candidate.secretRef === 'string') refs.push(candidate.secretRef)
    for (const nested of Object.values(candidate)) visit(nested, depth + 1)
  }
  visit(value, 0)
  return unique(refs).sort()
}

function requiredArtifact(snapshot: RuntimeRunSnapshot, type: typeof APPROVAL_INPUT_TYPES[number]): ArtifactDocument
function requiredArtifact(snapshot: RuntimeRunSnapshot, type: 'run-bundle'): ArtifactDocument
function requiredArtifact(snapshot: RuntimeRunSnapshot, type: string): ArtifactDocument {
  const artifact = snapshot.frozenArtifacts[type]
  if (artifact === undefined) throw binderError('E2E_RUNTIME_RUN_BUNDLE_INPUT_MISSING')
  const schema = ArtifactSchemaRegistry[type as keyof typeof ArtifactSchemaRegistry]
  const parsed = schema?.safeParse(artifact)
  if (!parsed?.success) throw binderError('E2E_RUNTIME_RUN_BUNDLE_INPUT_INVALID', parsed?.error)
  return parsed.data as ArtifactDocument
}

function unique<T>(values: T[]): T[] { return [...new Set(values)] }
function plain(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function binderError(code: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false, cause })
}
