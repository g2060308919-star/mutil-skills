import { z } from 'zod'
import {
  RegressionBlockedCasesSchema,
  RegressionDiscoveryAttestationSchema,
  RegressionDiscoveryVerifierMaterialSchema,
  RegressionSourceFileSchema,
  RegressionToolchainSchema,
} from './regression-discovery.js'
import {
  ArtifactEnvelopeSchema, ArtifactSignatureSchema, AssetIdSchema, E2EError, RelativePathSchema,
  canonicalizeJson, digestBytes, digestText,
} from './common.js'
import { RequirementModelSchema } from './design.js'
import { PrdUnderstandingProjectionSchema } from './prd-understanding.js'
import { ManualResultSchema } from './manual-result.js'
import { ApprovalAssuranceSchema } from './approval-assurance.js'
import { SanitizationRecordSchema } from './privacy.js'
import { PrivacyReviewReceiptSchema, SanitizerAttestationSchema } from './privacy-attestation.js'
import { VerdictResultSchema } from './verdict.js'
import {
  ApprovalCapabilityRecordSchema,
  ApprovalFreshnessReceiptSchema,
  WriteHttpIntentSetSchema,
} from './approval-freshness.js'
import {
  CoverageDispositionDecisionReceiptSchema,
  DecisionReceiptSchema,
  EntityLineageMappingsSchema,
  type DecisionReceipt,
} from './decision-receipt.js'
import { WorkflowEventsV2ContentSchema } from './attempt.js'
import { ExecutionOutcomeReceiptSchema } from './execution-outcome.js'
import { CleanupPlanDefinitionSchema, type CleanupPlanDefinition } from './cleanup-plan.js'
import { RuntimeIsolationPolicySchema } from './runtime-isolation.js'
import { TrustedCompilerExecutionFactSchema } from './trusted-compiler-execution.js'
import { DiscoveryApprovalSubjectSchema } from './approval-subject.js'
import { ReadApprovalSubjectSchema } from './approval-freshness.js'
import {
  ReadHttpRequestSetSchema,
  validateReadHttpActionReferences,
  validateReadHttpRequestSet,
  type ReadHttpRequestReferences,
} from './read-http-request.js'
import {
  RuntimeHttpBodySegmentSchema,
  RuntimeWriteHttpActionSchema,
  digestRuntimeHttpBodyTemplate,
  digestRuntimeWriteHttpAction,
} from './runtime-http-action.js'
import { assertExecutionResultIdentities } from './execution-result-identity.js'
import { SignedGrantSchema } from './signed-grant.js'
import {
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  digestOracleCheckpointValue,
  OracleCheckpointPlanSchema,
} from './compiler-input.js'
import { E2ECaseExecutionFieldsSchema } from './e2e-flow.js'
import { AssertionResultV1Schema, projectAssertionResultV1 } from './assertion-result.js'
import { PolicyDecisionViewV1Schema } from './policy-decision-view.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const NonEmptyTextSchema = z.string().min(1).max(16 * 1024)
const UniqueIdsSchema = z.array(SafeIdSchema).max(100_000)
  .refine((values) => new Set(values).size === values.length, 'ID 必须唯一')
const ExecutionProfileSchema = z.enum([
  'trusted-read-only', 'trusted-reversible-write', 'production-isolated', 'full-playwright',
])

const FullPlaywrightContentTypeSchema = z.string().min(1).max(8 * 1024)
  .refine((value) => !/[\r\n\0]/.test(value))
const FullPlaywrightRequestBodySchema = z.union([
  z.object({ intentId: SafeIdSchema, kind: z.literal('json'),
    canonicalJson: z.string().min(1).max(256 * 1024).refine((value) => {
      try { return canonicalizeJson(JSON.parse(value)) === value } catch { return false }
    }),
  }).strict(),
  z.object({ intentId: SafeIdSchema, kind: z.literal('binary'), contentType: FullPlaywrightContentTypeSchema,
    bodyBase64Url: z.string().min(1).max(350 * 1024).regex(/^[A-Za-z0-9_-]+$/)
      .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value),
  }).strict(),
  z.object({ intentId: SafeIdSchema, kind: z.literal('template'), contentType: FullPlaywrightContentTypeSchema,
    segments: z.array(RuntimeHttpBodySegmentSchema).min(1).max(128), templateDigest: DigestSchema,
  }).strict().superRefine((body, context) => {
    if (body.templateDigest !== digestRuntimeHttpBodyTemplate({ kind: 'segments',
      contentType: body.contentType, segments: body.segments })) {
      context.addIssue({ code: 'custom', path: ['templateDigest'], message: 'template body digest mismatch' })
    }
  }),
])

export const FullPlaywrightProgramSchema = z.object({
  schemaVersion: z.literal('full-playwright/v1'),
  caseId: SafeIdSchema,
  stepId: SafeIdSchema,
  actionId: SafeIdSchema,
  source: z.string().min(1).max(1024 * 1024),
  sourceDigest: DigestSchema,
  cleanupSource: z.string().min(1).max(1024 * 1024),
  cleanupSourceDigest: DigestSchema,
  dataLeaseId: SafeIdSchema,
  cleanupPlanId: SafeIdSchema,
  timeoutMs: z.number().int().positive().max(3_600_000),
  oracleCheckpoints: z.array(OracleCheckpointPlanSchema).min(1).max(10_000),
  networkRequests: WriteHttpIntentSetSchema,
  networkRequestBodies: z.array(FullPlaywrightRequestBodySchema).max(1_000).optional(),
}).strict().superRefine((program, context) => {
  if (program.sourceDigest !== computeFullPlaywrightSourceDigest(program.source)) {
    context.addIssue({ code: 'custom', message: 'sourceDigest 未绑定 full Playwright source', path: ['sourceDigest'] })
  }
  if (program.cleanupSourceDigest !== computeFullPlaywrightCleanupSourceDigest(program.cleanupSource)) {
    context.addIssue({
      code: 'custom', message: 'cleanupSourceDigest 未绑定 full Playwright cleanupSource',
      path: ['cleanupSourceDigest'],
    })
  }
  const checkpointIds = program.oracleCheckpoints.map((checkpoint) => checkpoint.checkpointId)
  const oracleIds = program.oracleCheckpoints.map((checkpoint) => checkpoint.oracleId)
  if (new Set(checkpointIds).size !== checkpointIds.length) {
    context.addIssue({ code: 'custom', path: ['oracleCheckpoints'], message: 'checkpointId 必须唯一' })
  }
  if (new Set(oracleIds).size !== oracleIds.length) {
    context.addIssue({ code: 'custom', path: ['oracleCheckpoints'], message: '每个 Program 的 oracleId 必须唯一' })
  }
  const intentIds = program.networkRequests.map((request) => request.intentId)
  const expectedOrders = program.networkRequests.map((request) => request.expectedOrder)
  if (new Set(intentIds).size !== intentIds.length) {
    context.addIssue({ code: 'custom', message: 'full Playwright request intentId 必须唯一', path: ['networkRequests'] })
  }
  const orderStages = [...new Set(expectedOrders)].sort((left, right) => left - right)
  if (orderStages.some((order, index) => order !== index + 1)) {
    context.addIssue({
      code: 'custom', message: 'full Playwright request expectedOrder 阶段必须从 1 开始连续', path: ['networkRequests'],
    })
  }
  if (program.networkRequestBodies !== undefined) {
    const bodies = new Map(program.networkRequestBodies.map((body) => [body.intentId, body]))
    if (bodies.size !== program.networkRequestBodies.length) {
      context.addIssue({ code: 'custom', path: ['networkRequestBodies'], message: 'body intentId must be unique' })
    }
    for (const request of program.networkRequests) {
      const body = bodies.get(request.intentId)
      if (request.payload.kind === 'no-body') {
        if (body !== undefined) context.addIssue({ code: 'custom', path: ['networkRequestBodies'],
          message: 'no-body intent cannot have body material' })
        continue
      }
      if (body === undefined || body.kind !== request.payload.kind) {
        context.addIssue({ code: 'custom', path: ['networkRequestBodies'], message: 'body material missing or kind mismatch' })
        continue
      }
      const digest = body.kind === 'json'
        ? digestText('http-json-payload/v1', body.canonicalJson)
        : body.kind === 'binary'
          ? digestBytes('http-binary-payload/v1', Buffer.from(body.bodyBase64Url, 'base64url'))
          : body.templateDigest
      const approvedDigest = request.payload.kind === 'template'
        ? request.payload.templateDigest : request.payload.digest
      if (digest !== approvedDigest) context.addIssue({ code: 'custom', path: ['networkRequestBodies'],
        message: 'body material digest does not match approved intent' })
      bodies.delete(request.intentId)
    }
    if (bodies.size > 0) context.addIssue({ code: 'custom', path: ['networkRequestBodies'],
      message: 'body material references unknown intent' })
  }
})

export type FullPlaywrightProgram = z.infer<typeof FullPlaywrightProgramSchema>
export type FullPlaywrightRequestBody = z.infer<typeof FullPlaywrightRequestBodySchema>

export const OracleCheckpointResultSchema = z.object({
  checkpointId: SafeIdSchema,
  oracleId: SafeIdSchema,
  expectedJson: z.string().min(1).max(64 * 1024),
  actualJson: z.string().min(1).max(64 * 1024),
  expectedDigest: DigestSchema,
  actualDigest: DigestSchema,
  status: z.enum(['passed', 'failed']),
  evidenceIds: z.array(SafeIdSchema).min(1).max(10_000)
    .refine((values) => new Set(values).size === values.length, 'checkpoint evidenceId 必须唯一'),
}).strict().superRefine((checkpoint, context) => {
  for (const field of ['expectedJson', 'actualJson'] as const) {
    try {
      if (canonicalizeJson(JSON.parse(checkpoint[field])) !== checkpoint[field]) throw new Error()
    } catch {
      context.addIssue({ code: 'custom', path: [field], message: 'checkpoint value 必须是规范 JSON' })
    }
  }
  if (checkpoint.expectedDigest !== digestOracleCheckpointValue(checkpoint.expectedJson)) {
    context.addIssue({ code: 'custom', path: ['expectedDigest'], message: 'checkpoint expectedDigest 不匹配' })
  }
  if (checkpoint.actualDigest !== digestOracleCheckpointValue(checkpoint.actualJson)) {
    context.addIssue({ code: 'custom', path: ['actualDigest'], message: 'checkpoint actualDigest 不匹配' })
  }
  if ((checkpoint.expectedDigest === checkpoint.actualDigest) !== (checkpoint.status === 'passed')) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'checkpoint status 与 expected/actual 不一致' })
  }
})

export type OracleCheckpointResult = z.infer<typeof OracleCheckpointResultSchema>

function refineFullPlaywrightPrograms(input: {
  executionProfile?: z.infer<typeof ExecutionProfileSchema>
  programs: z.infer<typeof FullPlaywrightProgramSchema>[]
  actionRefs: Array<{
    actionId: string
    caseId?: string
    stepId?: string
    effect: string
    runtimeHttpActionDigest?: string
    capabilityOperations?: string[]
  }>
  caseIds?: string[]
  writeLeaseIds?: string[]
  cleanupPlans?: CleanupPlanDefinition[]
}, context: z.RefinementCtx): void {
  const usesFullPlaywright = input.programs.length > 0
  if (usesFullPlaywright !== (input.executionProfile === 'full-playwright')) {
    context.addIssue({
      code: 'custom', message: 'full Playwright program 必须且只能由显式 full-playwright Profile 使用',
      path: ['executionProfile'],
    })
  }
  const hasFullPlaywrightCapability = input.actionRefs.some((action) =>
    action.capabilityOperations?.includes('full-playwright'))
  if (input.actionRefs.some((action) => action.capabilityOperations !== undefined)
    && hasFullPlaywrightCapability !== usesFullPlaywright) {
    context.addIssue({
      code: 'custom', message: 'full-playwright capability 必须且只能绑定 full Playwright program',
      path: ['actions'],
    })
  }
  if (!usesFullPlaywright) return

  const programsByAction = new Map(input.programs.map((program) => [program.actionId, program]))
  if (programsByAction.size !== input.programs.length) {
    context.addIssue({ code: 'custom', message: 'full Playwright program actionId 必须唯一', path: ['fullPlaywrightPrograms'] })
  }
  const refsByAction = new Map(input.actionRefs.map((action) => [action.actionId, action]))
  if (refsByAction.size !== input.actionRefs.length
    || refsByAction.size !== programsByAction.size
    || [...refsByAction].some(([actionId]) => !programsByAction.has(actionId))) {
    context.addIssue({
      code: 'custom', message: 'full Playwright program 必须与 action 一一闭合', path: ['fullPlaywrightPrograms'],
    })
  }
  const knownCases = input.caseIds === undefined ? undefined : new Set(input.caseIds)
  const knownWriteLeases = input.writeLeaseIds === undefined ? undefined : new Set(input.writeLeaseIds)
  const cleanupPlans = input.cleanupPlans
  const cleanupPlansById = cleanupPlans === undefined ? undefined
    : new Map(cleanupPlans.map((plan) => [plan.cleanupPlanId, plan]))
  if (cleanupPlans !== undefined && cleanupPlansById?.size !== cleanupPlans.length) {
    context.addIssue({
      code: 'custom', message: 'full Playwright cleanupPlanId 必须唯一', path: ['writeCleanupPlans'],
    })
  }
  input.programs.forEach((program, index) => {
    const action = refsByAction.get(program.actionId)
    if (action === undefined
      || (action.caseId !== undefined && action.caseId !== program.caseId)
      || (action.stepId !== undefined && action.stepId !== program.stepId)
      || action.effect !== 'reversible-write'
      || action.runtimeHttpActionDigest !== undefined
      || (action.capabilityOperations !== undefined
        && (action.capabilityOperations.length !== 1 || action.capabilityOperations[0] !== 'full-playwright'))) {
      context.addIssue({
        code: 'custom', message: 'full Playwright case/action/step/effect 必须与 action 投影闭合',
        path: ['fullPlaywrightPrograms', index],
      })
    }
    if (knownCases !== undefined && !knownCases.has(program.caseId)) {
      context.addIssue({
        code: 'custom', message: 'full Playwright caseId 必须存在于 caseQueue',
        path: ['fullPlaywrightPrograms', index, 'caseId'],
      })
    }
    if (knownWriteLeases !== undefined && !knownWriteLeases.has(program.dataLeaseId)) {
      context.addIssue({
        code: 'custom', message: 'full Playwright dataLeaseId 必须存在于 write dataNeeds',
        path: ['fullPlaywrightPrograms', index, 'dataLeaseId'],
      })
    }
    const cleanupPlan = cleanupPlansById?.get(program.cleanupPlanId)
    if (cleanupPlansById !== undefined && (cleanupPlan === undefined
      || cleanupPlan.schemaVersion !== '2.0.0'
      || cleanupPlan.actionId !== program.actionId || cleanupPlan.leaseId !== program.dataLeaseId
      || cleanupPlan.cleanupProgramDigest !== program.cleanupSourceDigest)) {
      context.addIssue({
        code: 'custom', message: 'full Playwright cleanup plan 必须精确绑定 action、lease 与 cleanup program digest',
        path: ['fullPlaywrightPrograms', index, 'cleanupPlanId'],
      })
    }
    if (cleanupPlan?.schemaVersion === '2.0.0') {
      const networkIntentIds = new Set(program.networkRequests.map((request) => request.intentId))
      cleanupPlan.cleanupRequestIntentIds.forEach((intentId, intentIndex) => {
        if (!networkIntentIds.has(intentId)) {
          context.addIssue({
            code: 'custom', message: 'full Playwright cleanup request intent 必须属于 program networkRequests',
            path: ['fullPlaywrightPrograms', index, 'cleanupPlanId', 'cleanupRequestIntentIds', intentIndex],
          })
        }
      })
    }
  })
}

export const RuntimeProvenanceSchema = z.object({
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  runtimeInstallationDigest: DigestSchema,
  protocolVersion: z.literal('1.0.0'),
  contractsVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  playwrightVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  chromiumDigest: DigestSchema,
  gatewayPolicyDigest: DigestSchema,
  authorityPublicKeyDigest: DigestSchema,
  authorityStateProtectionLevel: z.enum(['local-crash-integrity', 'trusted-monotonic']),
  projectIdentityDigest: DigestSchema,
  sourceRevisionDigest: DigestSchema,
  sourceRepositoryIndependent: z.literal(true),
  isolationProofDigest: DigestSchema,
}).strict()

export type RuntimeProvenance = z.infer<typeof RuntimeProvenanceSchema>

export const ARTIFACT_TYPES = [
  'project-policy', 'prd-request', 'prd-manifest', 'prd-diff', 'semantic-generation',
  'acceptance-scope', 'requirement-model', 'interaction-flow', 'coverage-universe', 'test-cases',
  'design-audit', 'execution-contract', 'approval-grants', 'manual-results', 'data-leases',
  'browser-preflight', 'browser-action-map', 'regression-manifest', 'run-bundle', 'workflow-events',
  'browser-results', 'gateway-audit', 'browser-evidence', 'diagnosis', 'cleanup-results',
  'final-report', 'generation-manifest',
] as const

export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES)
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>

const GraphNodeSchema = z.object({
  kind: SafeIdSchema,
  id: SafeIdSchema,
}).strict()

export const ArtifactGraphSchema = z.object({
  defines: z.array(GraphNodeSchema).max(100_000),
  references: z.array(GraphNodeSchema).max(100_000),
}).strict()

const FileRecordSchema = z.object({
  relativePath: RelativePathSchema,
  digest: DigestSchema,
  byteLength: z.number().int().nonnegative(),
}).strict()

const IdDigestSchema = z.object({ id: SafeIdSchema, digest: DigestSchema }).strict()
const PendingDecisionSchema = z.object({
  decisionId: SafeIdSchema,
  status: z.literal('pending'),
}).strict()
const TerminalDecisionSchema = z.object({
  decisionId: SafeIdSchema,
  status: z.enum(['approved', 'rejected']),
  receipt: DecisionReceiptSchema,
}).strict()
const DecisionSchema = z.discriminatedUnion('status', [PendingDecisionSchema, TerminalDecisionSchema])

function decisionFor(kind: DecisionReceipt['kind']) {
  return DecisionSchema.superRefine((decision, context) => {
    if (decision.status === 'pending') return
    if (decision.receipt.kind !== kind || decision.receipt.decisionId !== decision.decisionId
      || decision.receipt.decisionStatus !== decision.status) {
      context.addIssue({
        code: 'custom', path: ['receipt'],
        message: 'Decision receipt 的 kind、decisionId 与 decisionStatus 必须和外层决定一致',
      })
    }
  })
}
const FindingSchema = z.object({
  code: SafeIdSchema, severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), ref: NonEmptyTextSchema,
}).strict()

const projectPolicyContent = z.object({
  policyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  environments: z.array(z.object({
    environmentId: SafeIdSchema,
    baseOrigin: z.string().url(),
    riskTier: z.enum(['local', 'test', 'staging', 'production']).optional(),
  }).strict()).min(1).max(256),
  originPolicies: z.array(z.object({ origin: z.string().url(), allowRead: z.boolean(), allowWrite: z.boolean() }).strict()).min(1).max(256),
  browserMatrix: z.array(z.object({ browserId: SafeIdSchema, channel: SafeIdSchema, required: z.boolean() }).strict()).min(1).max(64),
  coveragePolicy: IdDigestSchema,
  evidencePolicy: IdDigestSchema,
  retentionPolicy: IdDigestSchema,
  riskPolicy: IdDigestSchema,
  timeoutPolicy: IdDigestSchema,
  runtimePolicy: IdDigestSchema,
}).strict()

export const PrdRequestContentSchema = z.object({
  productSpace: SafeIdSchema,
  title: NonEmptyTextSchema,
  sourceDescriptors: z.array(z.object({ sourceId: SafeIdSchema, kind: z.enum(['file', 'url', 'text']), ref: NonEmptyTextSchema }).strict()).min(1).max(1_000),
  userRequest: NonEmptyTextSchema,
  testWorkspaceId: SafeIdSchema,
  secretRefs: z.array(SafeIdSchema).max(1_000),
  understanding: PrdUnderstandingProjectionSchema,
}).strict()

const prdRequestContent = PrdRequestContentSchema

export const PrdSourceSpanSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
}).strict().superRefine((span, context) => {
  if (span.endLine < span.startLine
    || (span.endLine === span.startLine && span.endColumn < span.startColumn)) {
    context.addIssue({ code: 'custom', message: 'PRD Clause sourceSpan 结束位置不得早于开始位置' })
  }
})

export const PrdClauseKindSchema = z.enum([
  'functional', 'validation', 'state', 'error', 'visual', 'permission',
  'non-functional', 'out-of-scope', 'context',
])

const PrdClauseDigestInputSchema = z.object({
  clauseId: SafeIdSchema,
  sourceId: SafeIdSchema,
  kind: PrdClauseKindSchema,
  sourceSpan: PrdSourceSpanSchema,
  originalText: NonEmptyTextSchema,
  normalizedText: NonEmptyTextSchema,
}).strict()

export function digestPrdClause(input: z.input<typeof PrdClauseDigestInputSchema>): string {
  return digestText('prd-clause/v1', canonicalizeJson(input))
}

export const PrdClauseSchema = PrdClauseDigestInputSchema.extend({
  textDigest: DigestSchema,
}).strict().superRefine((clause, context) => {
  const { textDigest, ...material } = clause
  if (textDigest !== digestPrdClause(material)) {
    context.addIssue({ code: 'custom', path: ['textDigest'], message: 'PRD Clause 文本摘要不匹配' })
  }
})

export type PrdClause = z.infer<typeof PrdClauseSchema>

export function digestPrdClauseInventory(clauses: PrdClause[]): string {
  return digestText('prd-clause-inventory/v1', canonicalizeJson(clauses))
}

export const PrdManifestContentSchema = z.object({
  prdId: SafeIdSchema,
  assetId: AssetIdSchema,
  revision: DigestSchema,
  normalizedPrdDigest: DigestSchema,
  sources: z.array(z.object({ sourceId: SafeIdSchema, digest: DigestSchema, byteLength: z.number().int().nonnegative() }).strict()).min(1).max(10_000),
  attachments: z.array(z.object({
    attachmentId: SafeIdSchema,
    digest: DigestSchema,
    byteLength: z.number().int().nonnegative(),
  }).strict()).max(10_000),
  sourceCacheIndexDigest: DigestSchema,
  clauses: z.array(PrdClauseSchema).min(1).max(100_000),
  clauseInventoryDigest: DigestSchema,
}).strict().superRefine((content, context) => {
  const sourceIds = new Set(content.sources.map((source) => source.sourceId))
  const clauseIds = content.clauses.map((clause) => clause.clauseId)
  if (new Set(clauseIds).size !== clauseIds.length) {
    context.addIssue({ code: 'custom', path: ['clauses'], message: 'PRD Clause ID 必须唯一' })
  }
  content.clauses.forEach((clause, index) => {
    if (!sourceIds.has(clause.sourceId)) {
      context.addIssue({ code: 'custom', path: ['clauses', index, 'sourceId'], message: 'PRD Clause 必须引用已登记来源' })
    }
  })
  if (content.clauseInventoryDigest !== digestPrdClauseInventory(content.clauses)) {
    context.addIssue({ code: 'custom', path: ['clauseInventoryDigest'], message: 'PRD Clause Inventory 摘要不匹配' })
  }
})

const prdManifestContent = PrdManifestContentSchema

const prdDiffContent = z.object({
  previousRevision: DigestSchema,
  currentRevision: DigestSchema,
  sectionChanges: z.array(z.object({ sectionId: SafeIdSchema, kind: z.enum(['added', 'changed', 'removed']), digest: DigestSchema }).strict()).max(10_000),
  lineageMappings: EntityLineageMappingsSchema,
  lineageReview: decisionFor('lineage'),
  impactedEntityIds: UniqueIdsSchema,
}).strict()

const semanticGenerationContent = z.object({
  modelProvider: SafeIdSchema,
  modelId: SafeIdSchema,
  modelVersion: NonEmptyTextSchema,
  systemPromptDigest: DigestSchema,
  toolOutputDigests: z.array(DigestSchema).max(10_000),
  sampling: z.object({ temperature: z.number().min(0).max(2), seed: z.number().int().nonnegative() }).strict(),
  candidateDigests: z.array(DigestSchema).min(1).max(1_000),
  selectedDigest: DigestSchema,
}).strict().refine(
  (value) => value.candidateDigests.includes(value.selectedDigest),
  { message: '选中候选必须存在于候选集合', path: ['selectedDigest'] },
)

export const ClauseDispositionSchema = z.discriminatedUnion('disposition', [
  z.object({
    clauseId: SafeIdSchema, disposition: z.literal('modeled'),
    requirementIds: z.array(SafeIdSchema).min(1).max(1_000)
      .refine((values) => new Set(values).size === values.length, 'Requirement ID 必须唯一'),
  }).strict(),
  z.object({
    clauseId: SafeIdSchema, disposition: z.literal('excluded'),
    reason: NonEmptyTextSchema, decisionId: SafeIdSchema,
  }).strict(),
  z.object({
    clauseId: SafeIdSchema, disposition: z.literal('not-applicable'),
    reason: NonEmptyTextSchema, decisionId: SafeIdSchema,
  }).strict(),
  z.object({
    clauseId: SafeIdSchema, disposition: z.literal('ambiguous'), ambiguityId: SafeIdSchema,
  }).strict(),
])

export const AcceptanceScopeContentSchema = z.object({
  includedReqCandidates: z.array(z.object({ reqId: SafeIdSchema, sourceRefs: z.array(NonEmptyTextSchema).min(1) }).strict()).max(100_000),
  exclusions: z.array(z.object({ reqId: SafeIdSchema, rationale: NonEmptyTextSchema, decisionId: SafeIdSchema }).strict()).max(100_000),
  ambiguities: z.array(z.object({
    ambiguityId: SafeIdSchema, question: NonEmptyTextSchema, status: z.enum(['resolved', 'pending']),
    decisionId: SafeIdSchema.optional(), resolution: NonEmptyTextSchema.optional(),
  }).strict().superRefine((ambiguity, context) => {
    if (ambiguity.status === 'resolved' && (!ambiguity.decisionId || !ambiguity.resolution)) {
      context.addIssue({ code: 'custom', message: 'resolved ambiguity 必须绑定 decisionId 与 resolution' })
    }
    if (ambiguity.status === 'pending' && ambiguity.resolution !== undefined) {
      context.addIssue({ code: 'custom', message: 'pending ambiguity 不得提前写入 resolution' })
    }
  })).max(100_000),
  dependencies: z.array(z.object({ dependencyId: SafeIdSchema, status: z.enum(['available', 'blocked']), digest: DigestSchema }).strict()).max(100_000),
  visualScope: z.object({ required: z.boolean(), refs: z.array(SafeIdSchema) }).strict(),
  browserScope: z.object({ browserIds: z.array(SafeIdSchema).min(1), viewportIds: z.array(SafeIdSchema).min(1) }).strict(),
  clauseDispositions: z.array(ClauseDispositionSchema).min(1).max(100_000)
    .refine((items) => new Set(items.map((item) => item.clauseId)).size === items.length,
      '每个 PRD Clause 只能有一个 Scope 处置'),
  scopeDecision: decisionFor('scope'),
}).strict()

const acceptanceScopeContent = AcceptanceScopeContentSchema

const requirementModelContent = RequirementModelSchema

const interactionFlowContent = z.object({
  flows: z.array(z.object({
    flowId: SafeIdSchema,
    contractNodeIds: z.array(SafeIdSchema).min(1).max(10_000)
      .refine((values) => new Set(values).size === values.length, 'contractNodeId 必须唯一').optional(),
    nodes: z.array(z.object({ nodeId: SafeIdSchema, reqId: SafeIdSchema, kind: z.enum(['entry', 'page', 'action', 'decision', 'state', 'feedback', 'exit']), effect: z.enum(['read', 'reversible-write', 'irreversible', 'unknown']), oracleIds: z.array(SafeIdSchema) }).strict()).min(2),
    edgeIds: z.array(SafeIdSchema).min(1), entryNodeId: SafeIdSchema, exitNodeIds: z.array(SafeIdSchema).min(1),
  }).strict()).max(100_000),
}).strict()

const coverageDisposition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('automated'), caseIds: z.array(SafeIdSchema).min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal('manual'), manualProcedureId: SafeIdSchema, blocking: z.boolean() }).strict(),
  z.object({
    kind: z.literal('not-applicable'), policyCode: SafeIdSchema,
    rationale: NonEmptyTextSchema, decisionGrantId: SafeIdSchema,
    decisionReceipt: CoverageDispositionDecisionReceiptSchema,
  }).strict(),
])

export const CoverageUniverseContentSchema = z.object({
  coveragePolicyDigest: DigestSchema,
  pairwiseSeed: z.number().int().nonnegative(),
  universeDigest: DigestSchema,
  obligations: z.array(z.object({
    obligationId: SafeIdSchema,
    reqId: SafeIdSchema,
    clauseIds: z.array(SafeIdSchema).min(1).max(10_000)
      .refine((values) => new Set(values).size === values.length, 'Clause ID 必须唯一'),
    ruleIds: z.array(SafeIdSchema).max(10_000),
    oracleIds: z.array(SafeIdSchema).min(1).max(10_000)
      .refine((values) => new Set(values).size === values.length, 'Oracle ID 必须唯一'),
    nodeIds: z.array(SafeIdSchema).max(10_000),
    actor: z.union([SafeIdSchema, z.literal('not-applicable')]),
    transitionId: z.union([SafeIdSchema, z.literal('not-applicable')]),
    scenario: NonEmptyTextSchema,
    necessity: z.enum(['required', 'advisory']),
    applicabilityRuleId: SafeIdSchema,
    disposition: coverageDisposition,
  }).strict()).max(100_000),
}).strict()

const coverageUniverseContent = CoverageUniverseContentSchema

const testCasesContent = z.object({
  cases: z.array(z.object({
    caseId: SafeIdSchema,
    revision: z.number().int().positive(),
    obligationIds: z.array(SafeIdSchema).min(1).max(10_000),
    title: NonEmptyTextSchema,
    actor: SafeIdSchema,
    necessity: z.enum(['required', 'advisory']),
    preconditions: z.array(NonEmptyTextSchema).max(10_000),
    dataNeedIds: z.array(SafeIdSchema).max(10_000),
    steps: z.array(z.object({
      stepId: SafeIdSchema,
      ordinal: z.number().int().nonnegative(),
      semanticAction: NonEmptyTextSchema,
      semanticTarget: NonEmptyTextSchema,
      oracles: z.array(z.object({ oracleId: SafeIdSchema, statement: NonEmptyTextSchema }).strict()).min(1).max(1_000),
      evidenceKinds: z.array(SafeIdSchema).min(1).max(32),
    }).strict()).min(1).max(10_000),
    mode: z.enum(['real-environment', 'gateway-injection']),
    effect: z.enum(['read', 'reversible-write', 'irreversible', 'unknown']),
    evidenceLevel: z.enum(['E1', 'E2', 'E3']),
    cleanupPlanId: z.union([SafeIdSchema, z.literal('not-applicable')]),
    timeoutMs: z.number().int().positive().max(3_600_000),
    retryPolicy: z.enum(['none', 'read-automation-max-2', 'verified-not-applied-max-1']),
    status: z.enum(['active', 'deprecated']),
    executionLane: E2ECaseExecutionFieldsSchema.shape.executionLane.optional(),
    fixture: E2ECaseExecutionFieldsSchema.shape.fixture.optional(),
    locatorCandidates: E2ECaseExecutionFieldsSchema.shape.locatorCandidates.optional(),
    pageIdentityPolicy: E2ECaseExecutionFieldsSchema.shape.pageIdentityPolicy.optional(),
  }).strict()).max(100_000),
  caseSetDigest: DigestSchema,
}).strict()

const designAuditContent = z.object({
  inputDigests: z.array(DigestSchema).min(1).max(10_000),
  metrics: z.array(z.object({ metricId: SafeIdSchema, numerator: z.number().nonnegative(), denominator: z.number().nonnegative() }).strict()).max(10_000),
  findings: z.array(FindingSchema).max(100_000),
  orphanIds: UniqueIdsSchema,
  weakIds: UniqueIdsSchema,
  status: z.enum(['passed', 'failed']),
}).strict()

const ExecutionActionIntentV10Schema = z.object({
  actionId: SafeIdSchema,
  effect: z.enum(['read', 'reversible-write', 'irreversible', 'unknown']),
  intentDigest: DigestSchema,
  runtimeHttpActionDigest: DigestSchema.optional(),
}).strict()

export const ExecutionContractV10ContentSchema = z.object({
  environment: SafeIdSchema,
  baseOrigin: z.string().url(),
  browserMatrix: z.array(z.object({ browserId: SafeIdSchema, channel: SafeIdSchema, viewportId: SafeIdSchema }).strict()).min(1).max(256),
  identities: z.array(z.object({ identityId: SafeIdSchema, roleIds: z.array(SafeIdSchema).min(1), secretRef: SafeIdSchema }).strict()).max(10_000),
  caseQueue: z.array(z.object({ ordinal: z.number().int().nonnegative(), caseId: SafeIdSchema }).strict()).max(100_000),
  actionIntents: z.array(ExecutionActionIntentV10Schema).max(100_000),
  dataNeeds: z.array(z.discriminatedUnion('mode', [
    z.object({ leaseId: SafeIdSchema, resourceKey: SafeIdSchema, mode: z.literal('read') }).strict(),
    z.object({ leaseId: SafeIdSchema, resourceKey: SafeIdSchema,
      resourceFingerprint: DigestSchema, mode: z.literal('write') }).strict(),
  ])).max(100_000),
  manualProcedures: z.array(z.object({ manualProcedureId: SafeIdSchema, instructionDigest: DigestSchema }).strict()).max(100_000),
  evidencePolicyDigest: DigestSchema,
  runtimeIsolation: RuntimeIsolationPolicySchema.nullable(),
  unresolvedItems: z.array(z.object({ itemId: SafeIdSchema, kind: SafeIdSchema, blocking: z.boolean() }).strict()).max(100_000),
}).strict()

export const ExecutionContractV11ContentSchema = ExecutionContractV10ContentSchema.extend({
  executionProfile: ExecutionProfileSchema.optional(),
  readHttpRequests: ReadHttpRequestSetSchema,
  writeHttpActions: z.array(RuntimeWriteHttpActionSchema).max(100_000).optional(),
  writeCleanupPlans: z.array(CleanupPlanDefinitionSchema).max(100_000).optional(),
  fullPlaywrightPrograms: z.array(FullPlaywrightProgramSchema).max(100_000).optional(),
  actionIntents: z.array(ExecutionActionIntentV10Schema.extend({
    requestIds: z.array(SafeIdSchema).max(1_000),
  }).strict()).max(100_000),
}).strict().superRefine((content, context) => {
  const actionIds = content.actionIntents.map((action) => action.actionId)
  if (new Set(actionIds).size !== actionIds.length) {
    context.addIssue({ code: 'custom', message: 'actionId 必须唯一', path: ['actionIntents'] })
  }
  const knownRequests = new Set(content.readHttpRequests.map((request) => request.requestId))
  const counts = new Map<string, number>()
  for (const [actionIndex, action] of content.actionIntents.entries()) {
    if (new Set(action.requestIds).size !== action.requestIds.length) {
      context.addIssue({ code: 'custom', message: 'requestId 引用必须唯一', path: ['actionIntents', actionIndex, 'requestIds'] })
    }
    for (const [requestIndex, requestId] of action.requestIds.entries()) {
      if (!knownRequests.has(requestId)) {
        context.addIssue({ code: 'custom', message: 'E2E_READ_HTTP_REQUEST_REFERENCE_UNKNOWN',
          path: ['actionIntents', actionIndex, 'requestIds', requestIndex] })
      }
      counts.set(requestId, (counts.get(requestId) ?? 0) + 1)
    }
  }
  for (const requestId of knownRequests) {
    if (counts.get(requestId) !== 1) {
      context.addIssue({ code: 'custom', message: 'E2E_READ_HTTP_REQUEST_REFERENCE_CARDINALITY', path: ['actionIntents'] })
    }
  }
  const writeActions = content.writeHttpActions ?? []
  const writeById = new Map(writeActions.map((action) => [action.actionId, action]))
  if (writeById.size !== writeActions.length) {
    context.addIssue({ code: 'custom', message: 'writeHttpActions.actionId 必须唯一', path: ['writeHttpActions'] })
  }
  for (const [index, action] of content.actionIntents.entries()) {
    const definition = writeById.get(action.actionId)
    if (action.runtimeHttpActionDigest !== undefined && (definition === undefined
      || action.runtimeHttpActionDigest !== digestRuntimeWriteHttpAction(definition))) {
      context.addIssue({
        code: 'custom', message: 'runtimeHttpActionDigest 与固定 HTTP action 不一致',
        path: ['actionIntents', index, 'runtimeHttpActionDigest'],
      })
    }
  }
  const cleanupPlans = content.writeCleanupPlans ?? []
  const cleanupById = new Map(cleanupPlans.map((plan) => [plan.cleanupPlanId, plan]))
  if (cleanupById.size !== cleanupPlans.length) {
    context.addIssue({ code: 'custom', message: 'writeCleanupPlans.cleanupPlanId 必须唯一', path: ['writeCleanupPlans'] })
  }
  for (const [index, action] of writeActions.entries()) {
    const cleanup = cleanupById.get(action.cleanupPlanId)
    if (cleanup !== undefined && (cleanup.schemaVersion !== '1.0.0' || cleanup.actionId !== action.actionId)) {
      context.addIssue({
        code: 'custom', message: 'HTTP write action 必须与 legacy cleanup plan 的 actionId 闭合',
        path: ['writeHttpActions', index, 'cleanupPlanId'],
      })
    }
  }
  refineFullPlaywrightPrograms({
    executionProfile: content.executionProfile,
    programs: content.fullPlaywrightPrograms ?? [],
    actionRefs: content.actionIntents.map((action) => ({ actionId: action.actionId, effect: action.effect,
      runtimeHttpActionDigest: action.runtimeHttpActionDigest })),
    caseIds: content.caseQueue.map((item) => item.caseId),
    writeLeaseIds: content.dataNeeds.filter((item) => item.mode === 'write').map((item) => item.leaseId),
    cleanupPlans,
  }, context)
})

const executionContractContent = ExecutionContractV11ContentSchema

export function migrateExecutionContractV10ToV11(
  candidate: unknown,
  requestCandidates: unknown,
  references: ReadHttpRequestReferences,
) {
  const legacy = ExecutionContractV10ContentSchema.parse(candidate)
  const readHttpRequests = validateReadHttpRequestSet(requestCandidates)
  const mapped = validateReadHttpActionReferences(
    legacy.actionIntents.map((action) => action.actionId), readHttpRequests, references,
  )
  return ExecutionContractV11ContentSchema.parse({
    ...legacy,
    readHttpRequests,
    actionIntents: legacy.actionIntents.map((action) => ({
      ...action, requestIds: mapped[action.actionId],
    })),
  })
}

const approvalGrantsContent = z.object({
  runBundleDigest: DigestSchema,
  approvalAssurance: ApprovalAssuranceSchema,
  grants: z.array(ApprovalFreshnessReceiptSchema).min(1).max(10_000),
}).strict()

const manualResultsContent = z.object({
  results: z.array(ManualResultSchema).max(10_000),
}).strict()

const dataLeasesContent = z.object({
  leases: z.array(z.object({
    leaseId: SafeIdSchema,
    resourceDigest: DigestSchema,
    cleanupPlanDigest: DigestSchema,
    status: z.enum(['reserved', 'active', 'released', 'cleanup-failed']),
  }).strict()).max(100_000),
  allocatorEpoch: z.number().int().nonnegative(),
}).strict()

const browserPreflightContent = z.object({
  discoveryGrantId: SafeIdSchema,
  authorityPreflightDigest: DigestSchema,
  observedActor: SafeIdSchema,
  checks: z.array(z.object({ code: SafeIdSchema, status: z.enum(['passed', 'failed']), digest: DigestSchema }).strict()).min(1).max(10_000),
  observedIdentity: z.object({ identityId: SafeIdSchema, digest: DigestSchema }).strict(),
  actorChecks: z.array(IdDigestSchema).max(10_000),
  leaseChecks: z.array(IdDigestSchema).max(100_000),
  gatewayChecks: z.array(IdDigestSchema).max(10_000),
  sandboxChecks: z.array(IdDigestSchema).max(10_000),
  status: z.enum(['passed', 'failed']),
}).strict()

const BrowserActionMapV20ActionSchema = z.object({
  caseId: SafeIdSchema,
  stepId: SafeIdSchema,
  actionId: SafeIdSchema,
  pageIdentityId: SafeIdSchema,
  locatorCandidates: z.array(z.object({ strategy: SafeIdSchema, value: NonEmptyTextSchema, confidence: z.number().min(0).max(1) }).strict()).max(32),
  playwrightAction: NonEmptyTextSchema,
  waits: z.array(z.object({ kind: SafeIdSchema, timeoutMs: z.number().int().positive().max(3_600_000) }).strict()).max(32),
  oracleIds: z.array(SafeIdSchema).min(1).max(1_000),
  effect: z.enum(['read', 'reversible-write', 'irreversible', 'unknown']),
  runtimeHttpActionDigest: DigestSchema.optional(),
  capabilities: z.array(z.object({
    operation: z.enum(['dom-read', 'screenshot', 'local-navigation', 'http-request']),
    capabilityId: SafeIdSchema,
  }).strict()).min(1).max(16).refine((items) =>
    new Set(items.map((item) => item.operation)).size === items.length,
  '同一 action 的 operation 必须唯一'),
}).strict()

export const BrowserActionMapV20ContentSchema = z.object({
  actionMapRevision: z.number().int().positive(),
  pageIdentities: z.array(z.object({ pageId: SafeIdSchema, origin: z.string().url(), assertionDigest: DigestSchema }).strict()).min(1).max(10_000),
  actions: z.array(BrowserActionMapV20ActionSchema).max(100_000),
  unmappedSteps: z.array(z.object({ caseId: SafeIdSchema, stepId: SafeIdSchema, reasonCode: SafeIdSchema }).strict()).max(100_000),
  discoveredRisks: z.array(FindingSchema).max(100_000),
}).strict()

export const BrowserActionMapV21ContentSchema = BrowserActionMapV20ContentSchema.extend({
  executionProfile: ExecutionProfileSchema.optional(),
  fullPlaywrightPrograms: z.array(FullPlaywrightProgramSchema).max(100_000).optional(),
  actions: z.array(BrowserActionMapV20ActionSchema.extend({
    capabilities: z.array(z.object({
      operation: z.enum(['dom-read', 'screenshot', 'local-navigation', 'http-request', 'full-playwright']),
      capabilityId: SafeIdSchema,
    }).strict()).min(1).max(16).refine((items) =>
      new Set(items.map((item) => item.operation)).size === items.length,
    '同一 action 的 operation 必须唯一'),
    requestIds: z.array(SafeIdSchema).max(1_000)
      .refine((values) => new Set(values).size === values.length, 'requestId 引用必须唯一'),
  }).strict()).max(100_000),
}).strict().superRefine((content, context) => {
  const actionIds = content.actions.map((action) => action.actionId)
  if (new Set(actionIds).size !== actionIds.length) {
    context.addIssue({ code: 'custom', message: 'actionId 必须唯一', path: ['actions'] })
  }
  const requestIds = content.actions.flatMap((action) => action.requestIds)
  if (new Set(requestIds).size !== requestIds.length) {
    context.addIssue({
      code: 'custom', message: 'E2E_READ_HTTP_REQUEST_REFERENCE_CARDINALITY', path: ['actions'],
    })
  }
  refineFullPlaywrightPrograms({
    executionProfile: content.executionProfile,
    programs: content.fullPlaywrightPrograms ?? [],
    actionRefs: content.actions.map((action) => ({
      actionId: action.actionId,
      caseId: action.caseId,
      stepId: action.stepId,
      effect: action.effect,
      runtimeHttpActionDigest: action.runtimeHttpActionDigest,
      capabilityOperations: action.capabilities.map((capability) => capability.operation),
    })),
  }, context)
})

const browserActionMapContent = BrowserActionMapV21ContentSchema

export function migrateBrowserActionMapV20ToV21(
  candidate: unknown,
  references: ReadHttpRequestReferences,
) {
  const legacy = BrowserActionMapV20ContentSchema.parse(candidate)
  const actionIds = legacy.actions.map((action) => action.actionId)
  const expected = [...actionIds].sort()
  const actual = Object.keys(references).sort()
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error('E2E_READ_HTTP_MIGRATION_MAPPING')
  }
  for (const actionId of actionIds) {
    const values = references[actionId]
    if (!Array.isArray(values) || new Set(values).size !== values.length
      || values.some((requestId) => !SafeIdSchema.safeParse(requestId).success)) {
      throw new Error('E2E_READ_HTTP_REQUEST_REFERENCE_UNKNOWN')
    }
  }
  const referenced = actionIds.flatMap((actionId) => references[actionId]!)
  if (new Set(referenced).size !== referenced.length) {
    throw new Error('E2E_READ_HTTP_REQUEST_REFERENCE_CARDINALITY')
  }
  return BrowserActionMapV21ContentSchema.parse({
    ...legacy,
    actions: legacy.actions.map((action) => ({ ...action, requestIds: [...references[action.actionId]!] })),
  })
}

export function validateReadHttpProtocolProjection(input: {
  executionContract: unknown
  browserActionMap: unknown
  approvalSubject: unknown
}): void {
  const execution = ExecutionContractV11ContentSchema.parse(input.executionContract)
  const actionMap = BrowserActionMapV21ContentSchema.parse(input.browserActionMap)
  const subjectResult = z.union([DiscoveryApprovalSubjectSchema, ReadApprovalSubjectSchema])
    .safeParse(input.approvalSubject)
  if (!subjectResult.success) throw new Error('E2E_READ_HTTP_APPROVAL_SUBJECT_INVALID')
  const subject = subjectResult.data

  const expectedRequests = new Map(execution.readHttpRequests.map((request) => [request.requestId, request]))
  const subjectRequests = new Map(subject.requests.map((request) => [request.requestId, request]))
  if (expectedRequests.size !== subjectRequests.size
    || [...expectedRequests].some(([requestId, request]) =>
      canonicalizeJson(request) !== canonicalizeJson(subjectRequests.get(requestId)))) {
    throw new Error('E2E_READ_HTTP_APPROVAL_REQUEST_SET_MISMATCH')
  }

  const executionReferences = new Map(execution.actionIntents
    .filter((action) => action.requestIds.length > 0).map((action) => [action.actionId, action.requestIds]))
  const actionMapReferences = new Map(actionMap.actions
    .filter((action) => action.requestIds.length > 0).map((action) => [action.actionId, action.requestIds]))
  const subjectReferences = new Map(subject.actions
    .filter((action) => action.requestIds.length > 0).map((action) => [action.actionId, action.requestIds]))
  for (const [actionId, requestIds] of executionReferences) {
    const mapped = actionMapReferences.get(actionId)
    const approved = subjectReferences.get(actionId)
    if (mapped === undefined || approved === undefined
      || canonicalizeJson(requestIds) !== canonicalizeJson(mapped)
      || canonicalizeJson(requestIds) !== canonicalizeJson(approved)) {
      throw new Error('E2E_READ_HTTP_ACTION_REFERENCE_MISMATCH')
    }
  }
  if (executionReferences.size !== actionMapReferences.size || executionReferences.size !== subjectReferences.size) {
    throw new Error('E2E_READ_HTTP_ACTION_REFERENCE_MISMATCH')
  }
}

const regressionManifestContent = z.object({
  testDomain: z.literal('prd-e2e-trusted-compiler'),
  executionProfile: ExecutionProfileSchema,
  templateDigest: DigestSchema,
  toolchain: RegressionToolchainSchema,
  sourceFiles: z.array(RegressionSourceFileSchema).max(100_000),
  caseMappings: z.array(z.object({ caseId: SafeIdSchema, relativePath: RelativePathSchema, testTitle: NonEmptyTextSchema }).strict()).max(100_000),
  blockedCases: RegressionBlockedCasesSchema,
  deprecatedCases: UniqueIdsSchema,
  // Compiler 运行前的候选 manifest 尚未产生 Discovery key，故契约层允许缺省；
  // Production finalization / GenerationAssembler 会强制本代发布资产必须携带并绑定该材料。
  discoveryVerifierMaterial: RegressionDiscoveryVerifierMaterialSchema.optional(),
  listResult: z.object({
    caseIds: UniqueIdsSchema,
    digest: DigestSchema,
    attestation: RegressionDiscoveryAttestationSchema,
  }).strict(),
}).strict().superRefine((content, context) => {
  const material = content.discoveryVerifierMaterial
  const attestation = content.listResult.attestation
  if (material !== undefined && (material.issuer !== attestation.issuer
    || material.keyId !== attestation.keyId
    || material.purpose !== attestation.purpose
    || material.algorithm !== attestation.algorithm)) {
    context.addIssue({
      code: 'custom',
      message: 'Discovery verifier material 必须与本代 attestation 的 issuer/key/purpose/algorithm 一致',
      path: ['discoveryVerifierMaterial'],
    })
  }
})

const runBundleContent = z.object({
  runId: SafeIdSchema,
  allInputRefs: z.array(z.object({ artifactId: SafeIdSchema, digest: DigestSchema }).strict()).min(1).max(100_000),
  schedule: z.array(z.object({ ordinal: z.number().int().nonnegative(), caseId: SafeIdSchema, stepIds: z.array(SafeIdSchema).min(1), actionIds: z.array(SafeIdSchema).min(1) }).strict()).max(100_000),
  attemptPlans: z.array(z.object({ caseId: SafeIdSchema, slots: z.number().int().positive().max(100) }).strict()).max(100_000),
  signedCapabilities: z.array(ApprovalCapabilityRecordSchema).max(100_000),
  secretRefs: z.array(SafeIdSchema).max(10_000),
  runtimePolicyDigest: DigestSchema,
  runtimeIsolationPolicyDigest: z.union([DigestSchema, z.literal('not-applicable')]),
}).strict()

const workflowEventsContent = WorkflowEventsV2ContentSchema

const browserResultsContent = z.object({
  runId: SafeIdSchema,
  trustedCompilerExecution: TrustedCompilerExecutionFactSchema.optional(),
  executedBrowserIds: UniqueIdsSchema.refine((values) => values.length > 0, '至少需要一个实际执行浏览器'),
  caseResults: z.array(z.object({
    resultId: SafeIdSchema.optional(),
    caseId: SafeIdSchema,
    attemptId: SafeIdSchema,
    eventChainDigest: DigestSchema,
    mode: z.enum(['real-environment', 'gateway-injection']),
    effect: z.enum(['read', 'reversible-write', 'irreversible-write']),
    status: z.enum(['passed', 'failed', 'input-blocked', 'environment-blocked', 'safety-blocked', 'automation-blocked', 'pending-decision', 'not-executed-user-declined', 'manual-required']),
    stepResults: z.array(z.object({
      stepId: SafeIdSchema,
      actionId: SafeIdSchema,
      status: z.enum(['passed', 'failed', 'skipped', 'unable']),
      actualDigest: DigestSchema.optional(),
      oracleResult: z.enum(['passed', 'failed', 'not-evaluated']),
      evidenceIds: z.array(SafeIdSchema).max(10_000),
      oracleCheckpoints: z.array(OracleCheckpointResultSchema).max(10_000).optional(),
    }).strict()).max(100_000),
    effectObservation: z.enum(['not-applicable', 'proven-not-applied', 'applied', 'unknown']),
    gatewayAuditRef: SafeIdSchema,
    evidenceRefs: z.array(SafeIdSchema).max(100_000),
    cleanupRef: SafeIdSchema.optional(),
    baselineResultId: SafeIdSchema.optional(),
    executionOutcomeReceipts: z.array(ExecutionOutcomeReceiptSchema).max(100_000).optional(),
  }).strict()).max(100_000),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
}).strict().superRefine((content, context) => {
  if (Date.parse(content.finishedAt) < Date.parse(content.startedAt)) {
    context.addIssue({ code: 'custom', message: 'finishedAt 不能早于 startedAt', path: ['finishedAt'] })
  }
  content.caseResults.forEach((caseResult, caseIndex) => {
    const receipts = caseResult.executionOutcomeReceipts ?? []
    if (new Set(receipts.map((receipt) => receipt.actionId)).size !== receipts.length) {
      context.addIssue({ code: 'custom', message: '同一 Case 的 ExecutionOutcomeReceipt actionId 必须唯一',
        path: ['caseResults', caseIndex, 'executionOutcomeReceipts'] })
    }
    caseResult.stepResults.forEach((step, stepIndex) => {
    if (['passed', 'failed'].includes(step.status)
      && (step.actualDigest === undefined || step.oracleResult === 'not-evaluated' || step.evidenceIds.length === 0)) {
      context.addIssue({
        code: 'custom', message: '终态步骤必须包含 actual、Oracle 结果和证据',
        path: ['caseResults', caseIndex, 'stepResults', stepIndex],
      })
    }
    })
  })
  const identitiesPresent = content.caseResults.filter((item) => item.resultId !== undefined).length
  if (identitiesPresent === 0) {
    const legacyCaseIds = content.caseResults.map((item) => item.caseId)
    if (content.caseResults.some((item) => item.mode !== 'real-environment' || item.baselineResultId !== undefined)
      || new Set(legacyCaseIds).size !== legacyCaseIds.length) {
      context.addIssue({ code: 'custom', message: '旧 BrowserResult 只能是 caseId 唯一的单 real 域', path: ['caseResults'] })
    }
  } else if (identitiesPresent !== content.caseResults.length) {
    context.addIssue({ code: 'custom', message: 'resultId 不允许部分迁移', path: ['caseResults'] })
  } else {
    try { assertExecutionResultIdentities(content.caseResults) }
    catch (error) {
      context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '执行结果身份无效', path: ['caseResults'] })
    }
  }
})

const gatewayPublicationAuditContent = z.object({
  gatewayInstance: z.object({ instanceId: SafeIdSchema, version: NonEmptyTextSchema, publicKeyDigest: DigestSchema }).strict(),
  policyDigest: DigestSchema,
  signedCounters: z.object({
    forwarded: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(),
    injected: z.number().int().nonnegative(), digest: DigestSchema, signature: ArtifactSignatureSchema,
  }).strict(),
  requestEvents: z.array(z.object({ sequence: z.number().int().nonnegative(), actionId: SafeIdSchema,
    executionSessionId: SafeIdSchema.optional(),
    decision: z.enum(['forwarded', 'blocked', 'injected']), digest: DigestSchema }).strict()).max(1_000_000),
  capabilityReservations: z.array(z.object({
    reservationId: SafeIdSchema, grantId: SafeIdSchema, capabilityId: SafeIdSchema,
    actionId: SafeIdSchema, attemptId: SafeIdSchema,
    attemptContext: z.object({ assetId: AssetIdSchema, generationId: SafeIdSchema, prdRevision: DigestSchema,
      runId: SafeIdSchema, caseId: SafeIdSchema }).strict().optional(),
    status: z.enum(['reserved', 'completed', 'unknown']), outcomeDigest: DigestSchema.optional(),
    observation: NonEmptyTextSchema.optional(), reservedAt: z.string().datetime(),
    consumed: z.boolean(), digest: DigestSchema,
  }).strict()).max(100_000),
}).strict()

const gatewayAuditContent = gatewayPublicationAuditContent.extend({
  sessions: z.array(z.object({
    resultId: SafeIdSchema,
    domain: z.enum(['real-environment', 'gateway-injection']),
    audit: gatewayPublicationAuditContent,
    verifierMaterial: z.object({
      issuer: SafeIdSchema, keyId: SafeIdSchema,
      gatewayInstance: gatewayPublicationAuditContent.shape.gatewayInstance,
      publicKeySpki: NonEmptyTextSchema,
    }).strict(),
    grant: SignedGrantSchema.optional(),
  }).strict()).min(1).max(100_000).optional(),
}).strict().superRefine((content, context) => {
  if (content.sessions === undefined) return
  const resultIds = content.sessions.map((session) => session.resultId)
  const domainKeys = content.sessions.map((session) => `${session.resultId}\0${session.domain}`)
  if (new Set(resultIds).size !== resultIds.length || new Set(domainKeys).size !== domainKeys.length) {
    context.addIssue({ code: 'custom', path: ['sessions'], message: 'Gateway session resultId/domain 必须唯一' })
  }
  content.sessions.forEach((session, index) => {
    if (session.domain === 'gateway-injection' && session.grant === undefined) {
      context.addIssue({ code: 'custom', path: ['sessions', index, 'grant'], message: '注入 Gateway session 必须携带独立签名 grant' })
    }
  })
})

const browserEvidenceContent = z.object({
  evidencePolicyDigest: DigestSchema,
  artifacts: z.array(z.object({
    evidenceId: SafeIdSchema,
    resultId: SafeIdSchema.optional(),
    caseId: SafeIdSchema,
    relativePath: RelativePathSchema,
    digest: DigestSchema,
    byteLength: z.number().int().nonnegative(),
    evidenceLevel: z.enum(['E1', 'E2', 'E3']),
    sanitizationRecord: SanitizationRecordSchema,
  }).strict()).max(1_000_000),
  caseCoverage: z.array(z.object({ caseId: SafeIdSchema, evidenceIds: z.array(SafeIdSchema).min(1) }).strict()).max(100_000),
  sanitizerProofs: z.array(z.object({
    evidenceId: SafeIdSchema, record: SanitizationRecordSchema, attestation: SanitizerAttestationSchema,
  }).strict()).max(1_000_000),
  privacyReviews: z.array(z.discriminatedUnion('status', [
    z.object({ evidenceId: SafeIdSchema, status: z.literal('not-required'), derivationDigest: DigestSchema }).strict(),
    z.object({ evidenceId: SafeIdSchema, status: z.literal('pending') }).strict(),
    z.object({ evidenceId: SafeIdSchema, status: z.enum(['approved', 'rejected']), receipt: PrivacyReviewReceiptSchema }).strict(),
  ])).max(1_000_000),
}).strict()

const diagnosisContent = z.object({
  caseDiagnoses: z.array(z.object({ caseId: SafeIdSchema, category: SafeIdSchema, retrySafe: z.boolean(), digest: DigestSchema }).strict()).max(100_000),
  healingAttempts: z.array(z.object({ caseId: SafeIdSchema, attemptId: SafeIdSchema, changeDigest: DigestSchema, status: z.enum(['accepted', 'rejected']) }).strict()).max(100_000),
  selectedAttemptExplanations: z.array(z.object({ caseId: SafeIdSchema, attemptId: SafeIdSchema, rationaleDigest: DigestSchema }).strict()).max(100_000),
}).strict()

const cleanupResultsContent = z.object({
  leaseResults: z.array(z.object({
    leaseId: SafeIdSchema,
    status: z.enum(['not-needed', 'verified-clean', 'failed', 'unknown']),
    digest: DigestSchema,
    leaseReceiptDigest: DigestSchema.optional(),
    plan: CleanupPlanDefinitionSchema.optional(),
  }).strict()).max(100_000),
}).strict()

const ReportStatusSchema = SafeIdSchema
const ReportFindingListSchema = z.array(FindingSchema).max(100_000)
export const ReportGatewayAuditSchema = z.object({
  status: z.enum(['valid', 'invalid', 'incomplete', 'not-required']),
  digest: DigestSchema,
  forwarded: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  injected: z.number().int().nonnegative(),
  findings: ReportFindingListSchema,
}).strict()

export const FinalReportContentSchema = z.object({
  runtimeProvenance: RuntimeProvenanceSchema,
  approvalAssurance: ApprovalAssuranceSchema,
  verdictRuleVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  verdictInputDigest: DigestSchema,
  verdict: VerdictResultSchema.shape.verdict,
  reasonCodes: z.array(SafeIdSchema).min(1).max(10_000),
  cannotClaim: z.array(NonEmptyTextSchema).max(10_000),
  businessFailuresObserved: UniqueIdsSchema,
  advisoryFailures: UniqueIdsSchema,
  metrics: VerdictResultSchema.shape.metrics,
  scope: z.array(IdDigestSchema).max(100_000),
  traceability: z.array(z.object({ fromId: SafeIdSchema, toId: SafeIdSchema, kind: SafeIdSchema }).strict()).max(1_000_000),
  semanticTraceability: z.array(z.object({
    clauseId: SafeIdSchema,
    sourceId: SafeIdSchema,
    sourceSpan: PrdSourceSpanSchema,
    originalText: NonEmptyTextSchema,
    disposition: z.enum(['modeled', 'excluded', 'not-applicable', 'ambiguous', 'missing']),
    requirementId: SafeIdSchema.optional(),
    ruleId: SafeIdSchema.optional(),
    oracleId: SafeIdSchema.optional(),
  }).strict()).min(1).max(1_000_000),
  realResults: z.array(IdDigestSchema).max(100_000),
  injectionResults: z.array(IdDigestSchema).max(100_000),
  manualResults: z.array(IdDigestSchema.extend({
    approvalMode: z.enum(['local-confirmation', 'webauthn']),
    identityVerified: z.boolean(), separationOfDutiesVerified: z.boolean(),
  }).strict()).max(100_000),
  risks: z.array(FindingSchema).max(100_000),
  regression: z.object({ manifestDigest: DigestSchema, command: NonEmptyTextSchema }).strict(),
  title: NonEmptyTextSchema,
  summaries: z.object({
    prdId: SafeIdSchema,
    prdTitle: NonEmptyTextSchema,
    scopeDigest: DigestSchema,
    executionContractDigest: DigestSchema,
    approvalGrantDigests: z.array(DigestSchema).max(100_000),
    generationDigest: DigestSchema,
  }).strict(),
  approvals: z.array(z.object({
    kind: z.enum(['scope', 'lineage', 'execution']),
    status: z.enum(['approved', 'rejected', 'pending', 'revoked', 'expired']),
    subjectDigest: DigestSchema,
    grantDigests: z.array(DigestSchema).max(100_000)
      .refine((values) => new Set(values).size === values.length, '审批 grant digest 必须唯一'),
    approvalMode: z.enum(['local-confirmation', 'webauthn']),
    identityVerified: z.boolean(), separationOfDutiesVerified: z.boolean(),
  }).strict()).length(3),
  policyDecisions: z.array(PolicyDecisionViewV1Schema).max(1_000_000)
    .refine((views) => new Set(views.map((view) => view.decisionId)).size === views.length,
      '策略决策 decisionId 必须唯一'),
  environment: z.object({
    environmentId: SafeIdSchema,
    origins: z.array(z.string().url()).min(1).max(256),
    browser: z.object({
      name: z.literal('chromium'), version: NonEmptyTextSchema, channel: SafeIdSchema,
    }).strict(),
    roles: z.array(z.object({ roleId: SafeIdSchema, status: ReportStatusSchema }).strict()).max(10_000),
    dataLeases: z.array(z.object({
      leaseId: SafeIdSchema, status: ReportStatusSchema, resourceFingerprint: DigestSchema,
    }).strict()).max(100_000),
  }).strict(),
  dispositions: z.array(z.object({
    kind: z.enum(['excluded', 'not-applicable', 'manual', 'declined', 'blocked']),
    id: SafeIdSchema,
    title: NonEmptyTextSchema,
    status: ReportStatusSchema,
    reason: NonEmptyTextSchema,
    refs: z.array(SafeIdSchema).max(100_000),
  }).strict()).max(100_000),
  coverageUniverse: z.object({
    universeDigest: DigestSchema,
    obligations: z.array(z.object({
      obligationId: SafeIdSchema,
      title: NonEmptyTextSchema,
      necessity: z.enum(['required', 'advisory']),
      disposition: z.enum(['automated', 'manual', 'not-applicable']),
      caseIds: z.array(SafeIdSchema).max(256)
        .refine((values) => new Set(values).size === values.length, 'obligation caseId 必须唯一'),
    }).strict()).max(100_000),
  }).strict(),
  traceabilityMatrix: z.array(z.object({
    reqId: SafeIdSchema,
    ruleId: SafeIdSchema,
    obligationId: SafeIdSchema,
    caseId: SafeIdSchema,
    stepId: SafeIdSchema,
    evidenceId: SafeIdSchema,
    evidencePath: RelativePathSchema,
  }).strict()).max(1_000_000),
  caseDetails: z.array(z.object({
    resultId: SafeIdSchema,
    baselineResultId: SafeIdSchema.optional(),
    caseId: SafeIdSchema,
    title: NonEmptyTextSchema,
    executionMode: z.enum(['real-environment', 'browser-injection', 'manual']),
    necessity: z.enum(['required', 'advisory']),
    status: ReportStatusSchema,
    preconditions: z.array(NonEmptyTextSchema).max(10_000),
    steps: z.array(z.object({
      stepId: SafeIdSchema,
      action: NonEmptyTextSchema,
      expected: NonEmptyTextSchema,
      actual: NonEmptyTextSchema,
      oracle: NonEmptyTextSchema,
      status: ReportStatusSchema,
      evidenceLinks: z.array(RelativePathSchema).max(10_000),
      oracleCheckpoints: z.array(OracleCheckpointResultSchema).max(10_000).optional(),
      assertionResults: z.array(AssertionResultV1Schema).max(10_000).optional(),
    }).strict()).max(100_000),
  }).strict()).max(100_000),
  injectionBoundary: NonEmptyTextSchema,
  gatewayAudit: ReportGatewayAuditSchema,
  browserHealth: ReportFindingListSchema,
  diagnostics: z.array(z.object({
    resultId: SafeIdSchema,
    caseId: SafeIdSchema,
    category: SafeIdSchema,
    selectedAttemptId: SafeIdSchema.nullable(),
    rationale: NonEmptyTextSchema,
    attempts: z.array(z.object({
      attemptId: SafeIdSchema,
      slot: z.number().int().nonnegative().max(99),
      status: ReportStatusSchema,
      mode: z.enum(['real-environment', 'gateway-injection']),
      effect: z.enum(['read', 'reversible-write', 'irreversible-write']),
      eventChainDigest: DigestSchema,
      reservationSafeToVoid: z.boolean(),
      changeDigest: DigestSchema.nullable(),
      sideEffectState: z.enum(['proven-not-applied', 'applied', 'unknown', 'not-applicable']),
    }).strict()).max(1_000),
  }).strict()).max(100_000),
  sideEffects: z.array(z.object({
    actionId: SafeIdSchema,
    effect: z.enum(['read', 'reversible-write', 'irreversible', 'unknown']),
    status: ReportStatusSchema,
    verification: NonEmptyTextSchema,
    cleanupStatus: ReportStatusSchema,
    digest: DigestSchema,
  }).strict()).max(100_000),
  regressionDetails: z.object({
    testDomain: z.literal('prd-e2e-trusted-compiler'),
    executionProfile: ExecutionProfileSchema,
    generationId: SafeIdSchema,
    manifestDigest: DigestSchema,
    command: NonEmptyTextSchema,
    caseIds: z.array(SafeIdSchema).max(100_000),
    trustedCompiler: z.object({
      compilerInputDigest: DigestSchema,
      compilerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      compilerDigest: DigestSchema,
      templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      templateDigest: DigestSchema,
      sourceSetDigest: DigestSchema,
      discoverySignedDigest: DigestSchema,
      nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      playwrightVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      playwrightCliDigest: DigestSchema,
      executionDigest: DigestSchema,
    }).strict(),
  }).strict(),
  recommendations: z.array(NonEmptyTextSchema).max(100_000),
}).strict().superRefine((content, context) => {
  const assurance = content.approvalAssurance
  const assuranceInvalid = assurance.approvalMode === 'local-confirmation'
    && (assurance.identityVerified || assurance.separationOfDutiesVerified)
  if (assuranceInvalid) context.addIssue({ code: 'custom', path: ['approvalAssurance'],
    message: '本地确认报告不得声明身份验证或职责分离' })
  for (const [collection, values] of [
    ['approvals', content.approvals], ['manualResults', content.manualResults],
  ] as const) values.forEach((value, index) => {
    if (value.approvalMode !== assurance.approvalMode
      || value.identityVerified !== assurance.identityVerified
      || value.separationOfDutiesVerified !== assurance.separationOfDutiesVerified) {
      context.addIssue({ code: 'custom', path: [collection, index],
        message: '逐项审批保证必须与报告总体保证一致' })
    }
  })
  const casesByResultId = new Map(content.caseDetails.map((item) => [item.resultId, item]))
  const resultIds = content.caseDetails.map((item) => item.resultId)
  if (casesByResultId.size !== resultIds.length) {
    context.addIssue({ code: 'custom', message: 'caseDetails 的 resultId 必须唯一', path: ['caseDetails'] })
  }
  const domainKeys = content.caseDetails.map((item) => `${item.caseId}\0${item.executionMode}`)
  if (new Set(domainKeys).size !== domainKeys.length) {
    context.addIssue({ code: 'custom', message: 'caseDetails 的 (caseId, executionMode) 必须唯一', path: ['caseDetails'] })
  }
  try {
    assertExecutionResultIdentities(content.caseDetails
      .filter((item) => item.executionMode !== 'manual')
      .map((item) => ({
        resultId: item.resultId,
        caseId: item.caseId,
        mode: item.executionMode === 'real-environment' ? 'real-environment' as const : 'gateway-injection' as const,
        status: item.status,
        ...(item.baselineResultId === undefined ? {} : { baselineResultId: item.baselineResultId }),
      })))
  } catch {
    context.addIssue({
      code: 'custom',
      message: '自动化 Case 必须使用确定性 resultId，且注入结果必须绑定同 Case 已通过的真实基线',
      path: ['caseDetails'],
    })
  }
  const approvalKinds = content.approvals.map((item) => item.kind)
  if (new Set(approvalKinds).size !== approvalKinds.length
    || [...approvalKinds].sort().join('\0') !== ['execution', 'lineage', 'scope'].join('\0')) {
    context.addIssue({ code: 'custom', message: 'scope、lineage 和 execution 审批必须且只能各有一条', path: ['approvals'] })
  }
  const obligationIds = content.coverageUniverse.obligations.map((item) => item.obligationId)
  if (new Set(obligationIds).size !== obligationIds.length) {
    context.addIssue({ code: 'custom', message: 'coverage obligationId 必须唯一', path: ['coverageUniverse', 'obligations'] })
  }
  for (const [obligationIndex, obligation] of content.coverageUniverse.obligations.entries()) {
    if (obligation.disposition === 'automated' && obligation.caseIds.length === 0) {
      context.addIssue({ code: 'custom', message: '自动化 obligation 必须引用 Case', path: ['coverageUniverse', 'obligations', obligationIndex, 'caseIds'] })
    }
    if (obligation.disposition !== 'automated' && obligation.caseIds.length > 0) {
      context.addIssue({ code: 'custom', message: '非自动化 obligation 不得引用 Case', path: ['coverageUniverse', 'obligations', obligationIndex, 'caseIds'] })
    }
    for (const [caseIndex, caseId] of obligation.caseIds.entries()) {
      if (!content.caseDetails.some((item) => item.caseId === caseId)) {
        context.addIssue({ code: 'custom', message: 'obligation 引用了不存在的 Case', path: ['coverageUniverse', 'obligations', obligationIndex, 'caseIds', caseIndex] })
      }
    }
  }
  for (const [field, expectedNecessity] of [
    ['businessFailuresObserved', 'required'], ['advisoryFailures', 'advisory'],
  ] as const) {
    for (const [failureIndex, caseId] of content[field].entries()) {
      const testCase = field === 'businessFailuresObserved'
        ? content.caseDetails.find((item) => item.caseId === caseId && item.executionMode === 'real-environment')
        : casesByResultId.get(caseId)
      const necessityValid = field === 'advisoryFailures'
        ? testCase?.executionMode === 'browser-injection' || testCase?.necessity === expectedNecessity
        : testCase?.necessity === expectedNecessity
      if (!testCase || !necessityValid || testCase.status !== 'failed') {
        context.addIssue({
          code: 'custom', message: `${field} 必须只引用已失败的 ${expectedNecessity} Case`, path: [field, failureIndex],
        })
      }
    }
  }
  compareReportIds(
    content.realResults.map((item) => item.id),
    content.caseDetails.filter((item) => item.executionMode === 'real-environment'
      && item.status !== 'not-executed').map((item) => item.resultId),
    ['realResults'],
    'realResults 必须与 real-environment Case 完全一致',
  )
  compareReportIds(
    content.injectionResults.map((item) => item.id),
    content.caseDetails.filter((item) => item.executionMode === 'browser-injection'
      && item.status !== 'not-executed').map((item) => item.resultId),
    ['injectionResults'],
    'injectionResults 必须与 browser-injection Case 完全一致',
  )
  compareReportIds(
    content.regressionDetails.caseIds,
    [...new Set(content.caseDetails.filter((item) => item.executionMode !== 'manual').map((item) => item.caseId))],
    ['regressionDetails', 'caseIds'],
    'regressionDetails.caseIds 必须覆盖全部自动化 Case 且不得包含手工 Case',
  )
  if (content.regressionDetails.manifestDigest !== content.regression.manifestDigest
    || content.regressionDetails.command !== content.regression.command) {
    context.addIssue({
      code: 'custom', message: '回归摘要与 regressionDetails 不一致', path: ['regressionDetails'],
    })
  }
  for (const [caseIndex, testCase] of content.caseDetails.entries()) {
    const stepIds = testCase.steps.map((step) => step.stepId)
    if (new Set(stepIds).size !== stepIds.length) {
      context.addIssue({
        code: 'custom', message: '同一 Case 的 stepId 必须唯一', path: ['caseDetails', caseIndex, 'steps'],
      })
    }
    for (const [stepIndex, step] of testCase.steps.entries()) {
      const expected = step.oracleCheckpoints?.map(projectAssertionResultV1)
      if (canonicalizeJson(step.assertionResults ?? null) !== canonicalizeJson(expected ?? null)) {
        context.addIssue({
          code: 'custom', message: 'AssertionResultV1 必须由同 Step OracleCheckpointResult 确定性投影',
          path: ['caseDetails', caseIndex, 'steps', stepIndex, 'assertionResults'],
        })
      }
    }
  }
  for (const [rowIndex, row] of content.traceabilityMatrix.entries()) {
    const testCase = content.caseDetails.find((item) =>
      item.caseId === row.caseId && item.executionMode === 'real-environment')
    const step = testCase?.steps.find((candidate) => candidate.stepId === row.stepId)
    if (!testCase || !step || !step.evidenceLinks.includes(row.evidencePath)) {
      context.addIssue({
        code: 'custom',
        message: '追踪行必须指向同一 Case 中存在且登记该 evidencePath 的 Step',
        path: ['traceabilityMatrix', rowIndex],
      })
    }
  }

  function compareReportIds(actual: string[], expected: string[], path: Array<string | number>, message: string): void {
    const left = [...actual].sort()
    const right = [...expected].sort()
    if (left.length !== new Set(left).size || left.length !== right.length
      || left.some((value, index) => value !== right[index])) {
      context.addIssue({ code: 'custom', message, path })
    }
  }
})

export type FinalReportContent = z.infer<typeof FinalReportContentSchema>

const generationManifestContent = z.object({
  runtimeProvenance: RuntimeProvenanceSchema,
  generationId: SafeIdSchema,
  fencingToken: z.number().int().positive(),
  finalizationSnapshotDigest: DigestSchema,
  // generation-manifest 不索引自身，避免真实文件摘要形成不可解的自引用；自身由 Envelope/Authority/active pointer 校验。
  artifacts: z.array(z.object({
    artifactId: SafeIdSchema,
    artifactType: ArtifactTypeSchema,
    relativePath: RelativePathSchema,
    digest: DigestSchema,
  }).strict()).length(26),
  files: z.array(FileRecordSchema).min(1).max(1_000_000),
  rootDigest: DigestSchema,
  terminalVerdict: VerdictResultSchema.shape.verdict,
  authoritySignature: ArtifactSignatureSchema,
}).strict().superRefine((content, context) => {
  const expectedTypes = ARTIFACT_TYPES.filter((type) => type !== 'generation-manifest')
  const artifactIds = content.artifacts.map((artifact) => artifact.artifactId)
  const artifactTypes = content.artifacts.map((artifact) => artifact.artifactType)
  const artifactPaths = content.artifacts.map((artifact) => artifact.relativePath)
  const filePaths = content.files.map((file) => file.relativePath)
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({ code: 'custom', message: 'manifest artifactId 必须唯一', path: ['artifacts'] })
  }
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    context.addIssue({ code: 'custom', message: 'manifest Artifact 路径必须唯一', path: ['artifacts'] })
  }
  if ([...artifactTypes].sort().join('\0') !== [...expectedTypes].sort().join('\0')) {
    context.addIssue({ code: 'custom', message: 'manifest 必须且只能索引其余 26 类 Artifact', path: ['artifacts'] })
  }
  if (new Set(filePaths).size !== filePaths.length) {
    context.addIssue({ code: 'custom', message: 'manifest 文件路径必须唯一', path: ['files'] })
  }
  if (content.authoritySignature.signedDigest !== content.rootDigest) {
    context.addIssue({ code: 'custom', message: 'manifest Authority 签名必须绑定 rootDigest', path: ['authoritySignature', 'signedDigest'] })
  }
})

const ContentSchemaRegistry = {
  'project-policy': projectPolicyContent,
  'prd-request': prdRequestContent,
  'prd-manifest': prdManifestContent,
  'prd-diff': prdDiffContent,
  'semantic-generation': semanticGenerationContent,
  'acceptance-scope': acceptanceScopeContent,
  'requirement-model': requirementModelContent,
  'interaction-flow': interactionFlowContent,
  'coverage-universe': coverageUniverseContent,
  'test-cases': testCasesContent,
  'design-audit': designAuditContent,
  'execution-contract': executionContractContent,
  'approval-grants': approvalGrantsContent,
  'manual-results': manualResultsContent,
  'data-leases': dataLeasesContent,
  'browser-preflight': browserPreflightContent,
  'browser-action-map': browserActionMapContent,
  'regression-manifest': regressionManifestContent,
  'run-bundle': runBundleContent,
  'workflow-events': workflowEventsContent,
  'browser-results': browserResultsContent,
  'gateway-audit': gatewayAuditContent,
  'browser-evidence': browserEvidenceContent,
  diagnosis: diagnosisContent,
  'cleanup-results': cleanupResultsContent,
  'final-report': FinalReportContentSchema,
  'generation-manifest': generationManifestContent,
} satisfies Record<ArtifactType, z.ZodTypeAny>

type ArtifactSchemaShape<T extends ArtifactType> = Omit<
  typeof ArtifactEnvelopeSchema.shape,
  'artifactType' | 'schemaVersion' | 'graph'
> & {
  artifactType: z.ZodLiteral<T>
  schemaVersion: z.ZodTypeAny
  graph: typeof ArtifactGraphSchema
  content: (typeof ContentSchemaRegistry)[T]
}

function createArtifactSchema<T extends ArtifactType>(
  artifactType: T,
): z.ZodObject<ArtifactSchemaShape<T>, 'strict'> {
  return ArtifactEnvelopeSchema.extend({
    artifactType: z.literal(artifactType),
    schemaVersion: artifactType === 'execution-contract'
      ? z.literal('1.1.0')
      : artifactType === 'browser-action-map'
        ? z.literal('2.1.0')
        : artifactType === 'final-report'
          ? z.literal('3.0.0')
      : artifactType === 'generation-manifest'
            ? z.literal('2.0.0')
          : artifactType === 'prd-request'
            ? z.literal('2.0.0')
        : artifactType === 'cleanup-results'
      || artifactType === 'approval-grants' || artifactType === 'browser-preflight'
      || artifactType === 'run-bundle'
      || artifactType === 'project-policy' || artifactType === 'browser-evidence'
      || artifactType === 'acceptance-scope' || artifactType === 'prd-diff'
      || artifactType === 'regression-manifest' || artifactType === 'workflow-events'
      || artifactType === 'browser-results'
      ? z.literal('2.0.0')
      : ArtifactEnvelopeSchema.shape.schemaVersion,
    graph: ArtifactGraphSchema,
    content: ContentSchemaRegistry[artifactType],
  }).strict() as unknown as z.ZodObject<ArtifactSchemaShape<T>, 'strict'>
}

export const ArtifactSchemaRegistry = Object.fromEntries(
  ARTIFACT_TYPES.map((artifactType) => [artifactType, createArtifactSchema(artifactType)]),
) as { [T in ArtifactType]: ReturnType<typeof createArtifactSchema<T>> }

export type ArtifactDocument = z.infer<(typeof ArtifactSchemaRegistry)[ArtifactType]>
export type FinalReportArtifact = z.infer<(typeof ArtifactSchemaRegistry)['final-report']>

export function parseArtifactDocument(candidate: unknown): ArtifactDocument {
  const typeResult = z.object({ artifactType: ArtifactTypeSchema }).passthrough().safeParse(candidate)
  if (!typeResult.success) {
    throw new E2EError({
      code: 'E2E_ARTIFACT_TYPE_INVALID', category: 'artifact', retryable: false,
      message: '资产类型缺失或不在固定注册表中', cause: typeResult.error,
    })
  }
  const versionResult = z.object({ schemaVersion: z.string() }).passthrough().safeParse(candidate)
  if ((typeResult.data.artifactType === 'final-report'
      && (!versionResult.success || versionResult.data.schemaVersion !== '3.0.0'))
    || (typeResult.data.artifactType === 'generation-manifest'
      && (!versionResult.success || versionResult.data.schemaVersion !== '2.0.0'))) {
    throw new E2EError({
      code: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED', category: 'artifact', retryable: false,
      message: `E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED: ${typeResult.data.artifactType} 必须携带严格 Runtime provenance`,
    })
  }
  if (typeResult.data.artifactType === 'prd-request'
    && (!versionResult.success || versionResult.data.schemaVersion !== '2.0.0')) {
    throw new E2EError({
      code: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED', category: 'artifact', retryable: false,
      message: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED: prd-request 必须迁移到 understand-prd 契约投影 v2',
    })
  }
  if ((typeResult.data.artifactType === 'execution-contract'
      && (!versionResult.success || versionResult.data.schemaVersion !== '1.1.0'))
    || (typeResult.data.artifactType === 'browser-action-map'
      && (!versionResult.success || versionResult.data.schemaVersion !== '2.1.0'))) {
    throw new E2EError({
      code: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED', category: 'artifact', retryable: false,
      message: `E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED: ${typeResult.data.artifactType} 必须显式迁移到严格只读请求协议版本`,
    })
  }
  if ((typeResult.data.artifactType === 'acceptance-scope' || typeResult.data.artifactType === 'prd-diff')
    && (!versionResult.success || versionResult.data.schemaVersion !== '2.0.0')) {
    throw new E2EError({
      code: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED', category: 'artifact', retryable: false,
      message: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED: acceptance-scope 与 prd-diff v1 必须迁移到 v2 DecisionReceipt',
    })
  }
  if ((typeResult.data.artifactType === 'workflow-events' || typeResult.data.artifactType === 'browser-results')
    && (!versionResult.success || versionResult.data.schemaVersion !== '2.0.0')) {
    throw new E2EError({ code: 'E2E_ARTIFACT_SCHEMA_MIGRATION_REQUIRED', category: 'artifact', retryable: false,
      message: `${typeResult.data.artifactType} v1 缺少可独立复验的 Attempt 落盘事实，必须迁移至 v2` })
  }
  return ArtifactSchemaRegistry[typeResult.data.artifactType].parse(candidate) as ArtifactDocument
}
