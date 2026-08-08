import { z } from 'zod'
import { ApprovalFreshnessReceiptSchema, type ApprovalFreshnessReceipt } from './approval-freshness.js'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const SortedUniqueDigestsSchema = z.array(DigestSchema).max(1_000).superRefine((values, context) => {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: 'custom', message: 'digest 必须唯一并按字节升序排列' })
  }
})

const PolicyDecisionBindingSchema = z.object({
  assetId: SafeIdSchema.optional(),
  prdRevision: DigestSchema.optional(),
  subjectDigest: DigestSchema.optional(),
  runBundleDigest: DigestSchema.optional(),
  targetOrigin: z.string().url().optional(),
  actionId: SafeIdSchema,
  capabilityId: SafeIdSchema.optional(),
  capabilityDigest: DigestSchema.optional(),
  operation: SafeIdSchema.optional(),
  policyDigest: DigestSchema,
  payloadDigests: SortedUniqueDigestsSchema.optional(),
  targetFingerprints: SortedUniqueDigestsSchema.optional(),
  dataLeaseId: SafeIdSchema.optional(),
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  cleanupPlanDigest: DigestSchema.optional(),
  gatewayInstanceId: SafeIdSchema.optional(),
  executionSessionId: SafeIdSchema.optional(),
  executionResultId: SafeIdSchema.optional(),
  executionDomain: z.enum(['real-environment', 'gateway-injection']).optional(),
  sequence: z.number().int().nonnegative().optional(),
}).strict()

const ViewBase = {
  schemaVersion: z.literal('1.0.0'),
  decisionId: DigestSchema,
  evidenceDigest: DigestSchema,
  binding: PolicyDecisionBindingSchema,
  reasonCodes: z.array(SafeIdSchema).max(100),
}

export const PolicyDecisionViewV1Schema = z.discriminatedUnion('source', [
  z.object({
    ...ViewBase,
    source: z.literal('approval-freshness'),
    stage: z.literal('plan-approval'),
    decision: z.enum(['approved', 'denied', 'expired', 'revoked']),
  }).strict(),
  z.object({
    ...ViewBase,
    source: z.literal('gateway-enforcement'),
    stage: z.literal('action-enforcement'),
    decision: z.enum(['forwarded', 'blocked', 'injected']),
  }).strict(),
]).superRefine((view, context) => {
  const { decisionId, ...body } = view
  if (decisionId !== digestText('policy-decision-view/v1', canonicalizeJson(body))) {
    context.addIssue({ code: 'custom', message: 'decisionId 未绑定完整策略决策投影', path: ['decisionId'] })
  }
  if (view.source === 'approval-freshness') {
    const required = ['assetId', 'prdRevision', 'subjectDigest', 'runBundleDigest',
      'targetOrigin', 'capabilityId', 'capabilityDigest', 'operation'] as const
    for (const key of required) {
      if (view.binding[key] === undefined) context.addIssue({
        code: 'custom', message: `审批投影缺少 ${key} 绑定`, path: ['binding', key],
      })
    }
    if ((view.decision === 'approved') !== (view.reasonCodes.length === 0)) context.addIssue({
      code: 'custom', message: 'approved 不得含原因，非 approved 必须含原因', path: ['reasonCodes'],
    })
  } else {
    if (view.binding.gatewayInstanceId === undefined || view.binding.sequence === undefined) context.addIssue({
      code: 'custom', message: 'Gateway 投影必须绑定实例与事件序号', path: ['binding'],
    })
    if (view.reasonCodes.length !== 0) context.addIssue({
      code: 'custom', message: 'Gateway publication event 未携带原因码，不得在投影中臆造', path: ['reasonCodes'],
    })
  }
})

export type PolicyDecisionViewV1 = z.infer<typeof PolicyDecisionViewV1Schema>

const GatewayPolicyFactsSchema = z.object({
  gatewayInstance: z.object({ instanceId: SafeIdSchema }).passthrough(),
  policyDigest: DigestSchema,
  requestEvents: z.array(z.object({
    sequence: z.number().int().nonnegative(),
    actionId: SafeIdSchema,
    executionSessionId: SafeIdSchema.optional(),
    decision: z.enum(['forwarded', 'blocked', 'injected']),
    digest: DigestSchema,
  }).strict()).max(1_000_000),
}).passthrough()

export function projectApprovalPolicyDecisionViews(candidate: unknown): PolicyDecisionViewV1[] {
  const receipt = ApprovalFreshnessReceiptSchema.parse(candidate)
  const subject = receipt.executionSubjectSnapshot
  return receipt.capabilities.map((capability) => {
    const action = subject.actions.find((item) => item.actionId === capability.actionId)
    if (action === undefined) throw new Error(`E2E_POLICY_DECISION_ACTION_MISSING:${capability.actionId}`)
    const payloadDigests = approvalPayloadDigests(receipt, action)
    const targetFingerprints = 'requests' in action
      ? sortedUnique(action.requests.map((request) => request.targetFingerprint)) : []
    const binding = {
      assetId: subject.assetId,
      prdRevision: subject.prdRevision,
      subjectDigest: receipt.subjectDigest,
      runBundleDigest: receipt.runBundleDigest,
      targetOrigin: subject.baseOrigin,
      actionId: capability.actionId,
      capabilityId: capability.capabilityId,
      capabilityDigest: capability.digest,
      operation: capability.operation,
      policyDigest: subject.policyDigest,
      ...(payloadDigests.length === 0 ? {} : { payloadDigests }),
      ...(targetFingerprints.length === 0 ? {} : { targetFingerprints }),
      ...('dataLeaseId' in action ? {
        dataLeaseId: action.dataLeaseId,
        fencingToken: action.fencingToken,
        cleanupPlanDigest: action.cleanupPlanDigest,
      } : {}),
    }
    return createView({
      schemaVersion: '1.0.0', source: 'approval-freshness', stage: 'plan-approval',
      decision: approvalDecision(receipt.status), evidenceDigest: receipt.authorityProof.signedDigest,
      binding, reasonCodes: [...receipt.reasonCodes],
    })
  })
}

export function projectGatewayPolicyDecisionViews(candidate: unknown, context?: {
  executionResultId: string
  executionDomain: 'real-environment' | 'gateway-injection'
}): PolicyDecisionViewV1[] {
  const audit = GatewayPolicyFactsSchema.parse(candidate)
  return audit.requestEvents.map((event) => createView({
    schemaVersion: '1.0.0', source: 'gateway-enforcement', stage: 'action-enforcement',
    decision: event.decision, evidenceDigest: event.digest,
    binding: {
      actionId: event.actionId,
      policyDigest: audit.policyDigest,
      gatewayInstanceId: audit.gatewayInstance.instanceId,
      ...(event.executionSessionId === undefined ? {} : { executionSessionId: event.executionSessionId }),
      ...(context === undefined ? {} : context),
      sequence: event.sequence,
    },
    reasonCodes: [],
  }))
}

function createView(
  body: Omit<PolicyDecisionViewV1, 'decisionId'>,
): PolicyDecisionViewV1 {
  return PolicyDecisionViewV1Schema.parse({
    ...body,
    decisionId: digestText('policy-decision-view/v1', canonicalizeJson(body)),
  })
}

function approvalDecision(status: ApprovalFreshnessReceipt['status']):
  Extract<PolicyDecisionViewV1, { source: 'approval-freshness' }>['decision'] {
  return status === 'valid' ? 'approved' : status
}

function approvalPayloadDigests(
  receipt: ApprovalFreshnessReceipt,
  action: ApprovalFreshnessReceipt['executionSubjectSnapshot']['actions'][number],
): string[] {
  if ('requests' in action) return sortedUnique(action.requests.flatMap((request) => {
    if (request.payload.kind === 'no-body') return []
    return [request.payload.kind === 'template' ? request.payload.templateDigest : request.payload.digest]
  }))
  if (receipt.grantType !== 'read' || !('requestIds' in action)) return []
  const selected = new Set(action.requestIds)
  return sortedUnique(receipt.executionSubjectSnapshot.requests
    .filter((request) => selected.has(request.requestId)).map((request) => request.bodyDigest))
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
