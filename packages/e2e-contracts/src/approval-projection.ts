import { canonicalizeJson, digestText } from './common.js'

export const APPROVAL_PROJECTION_TYPES = [
  'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
  'test-cases', 'browser-action-map',
  'run-bundle',
  'execution-contract',
] as const
export type ApprovalProjectionType = typeof APPROVAL_PROJECTION_TYPES[number]

/**
 * 审批投影不含 Envelope/generation/fencing/createdAt，因而可在执行前独立复算。
 * action-map 只排除 Authority 签发后才产生的 capabilityId；operation 等行为语义仍被绑定。
 */
export function digestApprovalProjection(type: ApprovalProjectionType, content: unknown): string {
  const projection = type === 'browser-action-map' ? actionMapProjection(content)
    : type === 'run-bundle' ? runBundleProjection(content) : content
  return digestText(`approval-projection/${type}/v1`, canonicalizeJson(projection))
}

function runBundleProjection(content: unknown): unknown {
  if (!isRecord(content) || !Array.isArray(content.signedCapabilities)) {
    throw new Error('E2E_APPROVAL_PROJECTION_RUN_BUNDLE_INVALID')
  }
  assertExactKeys(content, [
    'runId', 'allInputRefs', 'schedule', 'attemptPlans', 'signedCapabilities',
    'secretRefs', 'runtimePolicyDigest', 'runtimeIsolationPolicyDigest',
  ], 'run-bundle')
  return {
    runId: content.runId,
    allInputRefs: content.allInputRefs,
    schedule: content.schedule,
    attemptPlans: content.attemptPlans,
    signedCapabilities: content.signedCapabilities.map((capability) => {
      if (!isRecord(capability)) throw new Error('E2E_APPROVAL_PROJECTION_RUN_CAPABILITY_INVALID')
      assertExactKeys(capability, [
        'capabilityId', 'actionId', 'operation', 'effect', 'maxUses', 'digest',
      ], 'run-bundle.signedCapabilities[]')
      return {
        actionId: capability.actionId, operation: capability.operation,
        effect: capability.effect, maxUses: capability.maxUses,
      }
    }),
    secretRefs: content.secretRefs,
    runtimePolicyDigest: content.runtimePolicyDigest,
    runtimeIsolationPolicyDigest: content.runtimeIsolationPolicyDigest,
  }
}

function actionMapProjection(content: unknown): unknown {
  if (!isRecord(content) || !Array.isArray(content.actions)) throw new Error('E2E_APPROVAL_PROJECTION_ACTION_MAP_INVALID')
  assertExactKeys(content, [
    'actionMapRevision', 'pageIdentities', 'actions', 'unmappedSteps', 'discoveredRisks',
  ], 'browser-action-map')
  return {
    actionMapRevision: content.actionMapRevision,
    pageIdentities: content.pageIdentities,
    actions: content.actions.map((action) => {
      if (!isRecord(action) || !Array.isArray(action.capabilities)) {
        throw new Error('E2E_APPROVAL_PROJECTION_ACTION_INVALID')
      }
      assertExactKeys(action, [
        'caseId', 'stepId', 'actionId', 'pageIdentityId', 'locatorCandidates', 'playwrightAction',
        'waits', 'oracleIds', 'effect', 'capabilities',
      ], 'browser-action-map.actions[]')
      return {
        caseId: action.caseId, stepId: action.stepId, actionId: action.actionId,
        pageIdentityId: action.pageIdentityId, locatorCandidates: action.locatorCandidates,
        playwrightAction: action.playwrightAction, waits: action.waits, oracleIds: action.oracleIds,
        effect: action.effect,
        capabilities: action.capabilities.map((capability) => {
          if (!isRecord(capability)) throw new Error('E2E_APPROVAL_PROJECTION_CAPABILITY_INVALID')
          assertExactKeys(capability, ['operation', 'capabilityId'], 'browser-action-map.actions[].capabilities[]')
          return { operation: capability.operation }
        }),
      }
    }),
    unmappedSteps: content.unmappedSteps,
    discoveredRisks: content.discoveredRisks,
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`E2E_APPROVAL_PROJECTION_KEYS_INVALID:${path}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
