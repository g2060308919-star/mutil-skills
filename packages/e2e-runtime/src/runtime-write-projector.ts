import {
  ArtifactSchemaRegistry,
  CleanupPlanDefinitionSchema,
  ExecutionContractV11ContentSchema,
  RuntimeWriteHttpActionSchema,
  SignedGrantSchema,
  canonicalizeJson,
  digestCleanupPlanDefinition,
  digestApprovalProjection,
  digestRuntimeWriteHttpAction,
  digestText,
  E2EError,
  type ArtifactDocument,
  type CleanupPlanDefinition,
  type HttpIntent,
  type ReversibleWriteCapability,
  type RuntimeFixedHttpRequest,
  type RuntimeHttpReadProbe,
  type RuntimeWriteHttpAction,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

type LegacyCleanupPlanDefinition = Extract<CleanupPlanDefinition, { schemaVersion: '1.0.0' }>
type RuntimeHttpCleanupPlan = LegacyCleanupPlanDefinition & {
  runtimeHttpCleanup: NonNullable<LegacyCleanupPlanDefinition['runtimeHttpCleanup']>
}

export interface RuntimeWriteProjection {
  caseId: string
  stepId: string
  actionId: string
  grant: SignedWriteGrant
  capability: ReversibleWriteCapability
  action: RuntimeWriteHttpAction
  cleanupPlan: RuntimeHttpCleanupPlan
  secretRefs: string[]
}

export function projectRuntimeWriteSnapshot(snapshot: RuntimeRunSnapshot): RuntimeWriteProjection {
  const testCases = parseFrozen(snapshot.frozenArtifacts, 'test-cases')
  const execution = parseFrozen(snapshot.frozenArtifacts, 'execution-contract')
  const actionMap = parseFrozen(snapshot.frozenArtifacts, 'browser-action-map')
  const runBundle = parseFrozen(snapshot.frozenArtifacts, 'run-bundle')
  const contract = ExecutionContractV11ContentSchema.parse(execution.content)
  const actions = contract.writeHttpActions ?? []
  const cleanups = contract.writeCleanupPlans ?? []
  if (actions.length !== 1 || cleanups.length !== 1) {
    throw projectionError('E2E_RUNTIME_WRITE_DEFINITION_CARDINALITY', '首发 Runtime 每次只接受一条固定 HTTP write action/cleanup plan')
  }
  const action = RuntimeWriteHttpActionSchema.parse(actions[0])
  const cleanup = CleanupPlanDefinitionSchema.parse(cleanups[0])
  if (cleanup.schemaVersion !== '1.0.0' || cleanup.runtimeHttpCleanup === undefined
    || cleanup.cleanupPlanId !== action.cleanupPlanId
    || cleanup.actionId !== action.actionId || cleanup.executorId !== 'runtime-http-cleanup.v1') {
    throw projectionError('E2E_RUNTIME_WRITE_CLEANUP_BINDING_MISMATCH', '固定 cleanup 定义未与 write action 闭合')
  }

  const grantResult = SignedGrantSchema.safeParse(snapshot.trustedExecutionFacts['signed-execution-grant'])
  if (!grantResult.success || !('executionDigest' in grantResult.data.subject)
    || grantResult.data.capabilities.some((candidate) => candidate.transport !== 'http'
      || candidate.effect !== 'reversible-write')) {
    throw projectionError('E2E_RUNTIME_WRITE_GRANT_REQUIRED', '缺少唯一 SignedWriteGrant')
  }
  const grant = grantResult.data as SignedWriteGrant
  const subject = grant.subject
  if (grant.approvalContext.runId !== snapshot.runId
    || grant.approvalContext.installationDigest !== snapshot.runtimeInstallationDigest
    || subject.caseDigest !== digestApprovalProjection('test-cases', testCases.content)
    || subject.executionContractDigest !== digestApprovalProjection('execution-contract', execution.content)
    || subject.actionMapDigest !== digestApprovalProjection('browser-action-map', actionMap.content)
    || subject.runBundleProjectionDigest !== digestApprovalProjection('run-bundle', runBundle.content)
    || subject.baseOrigin !== contract.baseOrigin
    || subject.environment !== contract.environment) {
    throw projectionError('E2E_RUNTIME_WRITE_ARTIFACT_BINDING_MISMATCH', 'Grant/run/installation/冻结资产未闭合')
  }

  const mapContent = actionMap.content as Record<string, unknown>
  const mapActions = Array.isArray(mapContent.actions) ? mapContent.actions as Array<Record<string, unknown>> : []
  const mapAction = mapActions.filter((candidate) => candidate.actionId === action.actionId)
  const actionDigest = digestRuntimeWriteHttpAction(action)
  if (mapAction.length !== 1 || mapAction[0]!.caseId !== action.caseId || mapAction[0]!.stepId !== action.stepId
    || mapAction[0]!.effect !== 'reversible-write'
    || mapAction[0]!.runtimeHttpActionDigest !== actionDigest
    || mapAction[0]!.playwrightAction !== 'runtime-fixed-http/v1'
    || !Array.isArray(mapAction[0]!.locatorCandidates) || mapAction[0]!.locatorCandidates.length !== 0
    || !Array.isArray(mapAction[0]!.waits) || mapAction[0]!.waits.length !== 0
    || !Array.isArray(mapAction[0]!.requestIds) || mapAction[0]!.requestIds.length !== 0) {
    throw projectionError('E2E_RUNTIME_WRITE_ACTION_DSL_INVALID', '写 action 必须使用无 locator/无 script 的固定 HTTP DSL')
  }

  const intents = contract.actionIntents.filter((candidate) => candidate.actionId === action.actionId)
  const queued = contract.caseQueue.some((candidate) => candidate.caseId === action.caseId)
  if (intents.length !== 1 || intents[0]!.effect !== 'reversible-write'
    || intents[0]!.runtimeHttpActionDigest !== actionDigest || !queued) {
    throw projectionError('E2E_RUNTIME_WRITE_CONTRACT_BINDING_MISMATCH', 'ExecutionContract 未绑定固定 HTTP action')
  }
  const cases = (testCases.content as Record<string, unknown>).cases
  const matchingCases = Array.isArray(cases)
    ? (cases as Array<Record<string, unknown>>).filter((candidate) => candidate.caseId === action.caseId) : []
  const matchingSteps = matchingCases.length === 1 && Array.isArray(matchingCases[0]!.steps)
    ? (matchingCases[0]!.steps as Array<Record<string, unknown>>).filter((step) => step.stepId === action.stepId) : []
  if (matchingCases.length !== 1 || matchingCases[0]!.effect !== 'reversible-write'
    || matchingCases[0]!.cleanupPlanId !== action.cleanupPlanId || matchingSteps.length !== 1) {
    throw projectionError('E2E_RUNTIME_WRITE_CASE_BINDING_MISMATCH', 'TestCase/Step/effect/cleanupPlanId 未闭合')
  }

  const capabilities = grant.capabilities.filter((candidate) => candidate.actionId === action.actionId)
  const subjectActions = subject.actions.filter((candidate) => candidate.actionId === action.actionId)
  const mapCapabilities = mapAction[0]!.capabilities
  if (capabilities.length !== 1 || subjectActions.length !== 1 || !Array.isArray(mapCapabilities)
    || mapCapabilities.length !== 1
    || (mapCapabilities[0] as Record<string, unknown>).operation !== 'http-request'
    || (mapCapabilities[0] as Record<string, unknown>).capabilityId !== capabilities[0]!.capabilityId) {
    throw projectionError('E2E_RUNTIME_WRITE_CAPABILITY_BINDING_MISMATCH', 'ActionMap/Subject/Grant capability 未唯一闭合')
  }
  const capability = capabilities[0]!
  const subjectAction = subjectActions[0]!
  const dataNeeds = contract.dataNeeds.filter((need) =>
    need.mode === 'write' && need.leaseId === subjectAction.dataLeaseId)
  const targetFingerprints = [...new Set(subjectAction.requests.map((item) => item.targetFingerprint))]
  if (canonicalizeJson(subjectAction.requests) !== canonicalizeJson(capability.requests)
    || subjectAction.dataLeaseId !== capability.dataLeaseId
    || dataNeeds.length !== 1 || subjectAction.resourceKey !== dataNeeds[0]!.resourceKey
    || !('resourceFingerprint' in dataNeeds[0]!)
    || targetFingerprints.length !== 1
    || dataNeeds[0]!.resourceFingerprint !== targetFingerprints[0]
    || subjectAction.fencingToken !== capability.fencingToken
    || subjectAction.cleanupPlanDigest !== capability.cleanupPlanDigest
    || capability.cleanupPlanDigest !== digestCleanupPlanDefinition(cleanup)) {
    throw projectionError('E2E_RUNTIME_WRITE_CAPABILITY_BINDING_MISMATCH', 'Subject/Grant/Lease/Cleanup 摘要未闭合')
  }
  assertRequestSequence(capability.requests, action, cleanup.runtimeHttpCleanup)

  const bundle = runBundle.content as Record<string, unknown>
  const signedCapabilities = Array.isArray(bundle.signedCapabilities)
    ? bundle.signedCapabilities as Array<Record<string, unknown>> : []
  const capabilityRecords = signedCapabilities.filter((record) => record.capabilityId === capability.capabilityId)
  if (bundle.runId !== snapshot.runId || capabilityRecords.length !== 1
    || capabilityRecords[0]!.actionId !== action.actionId
    || capabilityRecords[0]!.operation !== 'http-request'
    || capabilityRecords[0]!.effect !== 'reversible-write'
    || capabilityRecords[0]!.maxUses !== 1
    || capabilityRecords[0]!.digest !== digestText('approval-capability/v1', canonicalizeJson(capability))) {
    throw projectionError('E2E_RUNTIME_WRITE_RUN_BUNDLE_BINDING_MISMATCH', 'RunBundle capability 摘要未闭合')
  }
  const secretRefs = collectSecretRefs([action.writeRequest, cleanup.runtimeHttpCleanup.request])
  const approvedSecretRefs = new Set(Array.isArray(bundle.secretRefs) ? bundle.secretRefs : [])
  if (secretRefs.some((secretRef) => !approvedSecretRefs.has(secretRef))) {
    throw projectionError('E2E_RUNTIME_WRITE_SECRET_REF_UNAPPROVED', '固定 HTTP body 引用了 RunBundle 未批准的 secretRef')
  }
  return Object.freeze({
    caseId: action.caseId, stepId: action.stepId, actionId: action.actionId,
    grant, capability, action,
    cleanupPlan: cleanup as RuntimeWriteProjection['cleanupPlan'],
    secretRefs: Object.freeze([...secretRefs]) as unknown as string[],
  })
}

function assertRequestSequence(
  intents: HttpIntent[],
  action: RuntimeWriteHttpAction,
  cleanup: RuntimeHttpCleanupPlan['runtimeHttpCleanup'],
): void {
  const definitions: Array<RuntimeFixedHttpRequest | RuntimeHttpReadProbe> = [
    action.writeRequest, action.effectProbe, cleanup.request, cleanup.verificationProbe,
  ]
  const ordered = [...intents].sort((left, right) => left.expectedOrder - right.expectedOrder)
  if (ordered.length !== definitions.length) throw projectionError(
    'E2E_RUNTIME_WRITE_REQUEST_CLOSURE_MISMATCH', '写、effect probe、cleanup、verification 必须各有唯一签名 intent',
  )
  for (let index = 0; index < definitions.length; index += 1) {
    const intent = ordered[index]!
    const request = definitions[index]!
    const url = new URL(request.url)
    const body = 'body' in request ? request.body : { kind: 'no-body' as const }
    const expectedPayload = body.kind === 'segments'
      ? { kind: 'template' as const, templateDigest: body.templateDigest }
      : { kind: 'no-body' as const }
    if (intent.expectedOrder !== index + 1 || intent.maxRequests !== 1
      || intent.intentId !== request.intentId || intent.method !== request.method
      || intent.canonicalOrigin !== url.origin || intent.exactPath !== url.pathname
      || canonicalizeJson(intent.query) !== canonicalizeJson([...url.searchParams.entries()])
      || canonicalizeJson(intent.payload) !== canonicalizeJson(expectedPayload)
      || canonicalizeJson(intent.headers ?? []) !== canonicalizeJson(request.headers)) {
      throw projectionError('E2E_RUNTIME_WRITE_REQUEST_CLOSURE_MISMATCH', `第 ${index + 1} 个签名 intent 与固定请求不一致`)
    }
  }
}

function collectSecretRefs(requests: RuntimeFixedHttpRequest[]): string[] {
  return [...new Set(requests.flatMap((request) => request.body.kind === 'segments'
    ? request.body.segments.flatMap((segment) => segment.kind === 'secretRef' ? [segment.secretRef] : [])
    : []))].sort()
}

function parseFrozen(
  artifacts: Readonly<Record<string, ArtifactDocument>>,
  artifactType: 'test-cases' | 'execution-contract' | 'browser-action-map' | 'run-bundle',
): ArtifactDocument {
  const parsed = ArtifactSchemaRegistry[artifactType].safeParse(artifacts[artifactType])
  if (!parsed.success) throw projectionError(
    'E2E_RUNTIME_WRITE_FROZEN_ARTIFACT_REQUIRED', `缺少严格冻结 ${artifactType}`, parsed.error,
  )
  return parsed.data as ArtifactDocument
}

function projectionError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
