import { z } from 'zod'
import { ArtifactTypeSchema } from './artifacts.js'
import {
  PrdUnderstandingContractHeaderSchema,
  PrdUnderstandingProjectionDraftSchema,
  PrdUnderstandingProjectionSchema,
} from './prd-understanding.js'
import { WorkflowNodeSchema, WorkflowStateSchema } from './workflow.js'
import { ApprovalGrantSubjectSchema, canonicalGrantApprovalType } from './approval-subject.js'
import { ManualResultDraftSchema } from './manual-result.js'
import { AnyDeclarativePrdRunDesignSchema } from './declarative-prd-run.js'
import {
  AcceptanceReviewSchema,
  E2ECaseExecutionFieldsSchema,
  RunConditionSchema,
  RunHandleSchema,
  RunStageSchema,
  TargetContractSchema,
  TargetProbeDiagnosticsSchema,
} from './e2e-flow.js'
import { TaskStateViewV1Schema } from './task-state-view.js'
import { DeclarativeExecutionBindingV1Schema } from './declarative-execution-binding.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const EmptySchema = z.object({}).strict()
const RunIdPayloadSchema = z.object({ runId: SafeIdSchema }).strict()

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.custom<Record<string, JsonValue>>(isPlainJsonObject, 'JSON object 必须是只含可枚举数据属性的普通对象')
    .pipe(z.record(JsonValueSchema)),
]))

const RuntimeRequestHeaderShape = {
  schemaVersion: z.literal('1.0.0'),
  requestId: SafeIdSchema,
  client: z.object({
    name: SafeIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }).strict(),
}

const commandSchemas = [
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('doctor'),
    payload: EmptySchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('confirm-approval'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      confirmationId: SafeIdSchema,
      subjectDigest: DigestSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('create-run'),
    projectRoot: z.string().min(1),
    payload: z.object({
      assetId: SafeIdSchema,
      prdSource: z.object({
        kind: z.literal('file'), path: z.string().min(1),
        origin: z.object({ kind: z.enum(['file', 'url', 'text']), ref: z.string().min(1) }).strict(),
      }).strict(),
      supportingSources: z.array(z.object({
        sourceId: SafeIdSchema,
        kind: z.literal('file'),
        path: z.string().min(1),
        mediaType: z.string().min(1).max(256),
        origin: z.object({ kind: z.enum(['file', 'url', 'text']), ref: z.string().min(1) }).strict(),
        relevance: z.literal('necessary-dependency'),
      }).strict()).max(100).optional(),
      understandingContract: z.object({
        header: PrdUnderstandingContractHeaderSchema,
        source: z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
      }).strict(),
      projectPolicyPath: z.string().min(1),
      runtimePolicy: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('offline') }).strict(),
        z.object({ mode: z.literal('stable') }).strict(),
        z.object({ mode: z.literal('pinned'), version: z.string().regex(/^\d+\.\d+\.\d+$/),
          installationDigest: DigestSchema.optional() }).strict(),
      ]).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('prepare-prd-understanding'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      projection: PrdUnderstandingProjectionDraftSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('compile-prd-run'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      design: AnyDeclarativePrdRunDesignSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('compile-executable-run'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      binding: DeclarativeExecutionBindingV1Schema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('get-acceptance-review'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('confirm-acceptance-review'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema.extend({ reviewDigest: DigestSchema }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('configure-target'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema.extend({ targetContract: TargetContractSchema }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('probe-target'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('submit-candidate'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      expectedState: WorkflowNodeSchema,
      artifactType: ArtifactTypeSchema,
      candidate: JsonValueSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('open-approval'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      approvalType: z.enum(['scope', 'lineage', 'discovery', 'execution', 'privacy']),
      grantSubject: ApprovalGrantSubjectSchema.optional(),
    }).strict().superRefine((value, context) => {
      const grantsCapability = value.approvalType === 'discovery' || value.approvalType === 'execution'
      if (grantsCapability !== (value.grantSubject !== undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'discovery/execution approval 必须且只能携带严格 grantSubject',
          path: ['grantSubject'],
        })
      } else if (value.grantSubject !== undefined
        && canonicalGrantApprovalType(value.grantSubject) !== value.approvalType) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'grantSubject 类型与 approvalType 不一致',
          path: ['grantSubject'],
        })
      }
    }),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('run-preflight'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('prepare-manual-result'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      draft: ManualResultDraftSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('finalize-manual-result-role'),
    projectRoot: z.string().min(1),
    payload: z.object({
      runId: SafeIdSchema,
      manualResultId: SafeIdSchema,
      draftDigest: DigestSchema,
      role: z.enum(['executor', 'reviewer']),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('execute-run'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('resume-run'),
    projectRoot: z.string().min(1),
    payload: z.object({ runId: SafeIdSchema, decision: JsonValueSchema }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('get-status'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema.extend({ includeTaskState: z.boolean().optional() }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('render-report'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema.extend({
      outputRoot: z.string().min(1).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...RuntimeRequestHeaderShape,
    command: z.literal('finalize-run'),
    projectRoot: z.string().min(1),
    payload: RunIdPayloadSchema,
  }).strict(),
] as const

export const RuntimeRequestEnvelopeSchema = z.discriminatedUnion('command', commandSchemas)

export const RuntimeErrorSchema = z.object({
  code: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  category: z.enum(['input', 'environment', 'safety', 'automation', 'artifact', 'migration', 'internal']),
  terminalState: z.enum([
    'input-blocked',
    'environment-blocked',
    'safety-blocked',
    'automation-blocked',
    'artifact-blocked',
    'migration-required',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
  resumeState: WorkflowNodeSchema.optional(),
  details: z.record(z.unknown()).optional(),
}).strict()

export const RuntimeDoctorProbeSchema = z.object({
  status: z.enum(['passed', 'blocked', 'not-installed']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  proofDigest: DigestSchema.optional(),
  remediation: z.string().min(1),
  recoverability: z.enum([
    'none', 'retry', 'repair-then-retry', 'reinstall', 'user-action-required',
  ]).optional(),
  expected: z.string().min(1).max(16 * 1024).optional(),
  actual: z.string().min(1).max(16 * 1024).optional(),
  preservedState: z.array(SafeIdSchema).max(100).optional(),
}).strict()

export const RuntimeDoctorReportSchema = z.object({
  ready: z.boolean(),
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  installationDigest: DigestSchema,
  browserSource: z.enum(['system-chrome', 'managed-chromium', 'unconfigured']),
  approvalMode: z.enum(['local-confirmation', 'webauthn']),
  probes: z.record(RuntimeDoctorProbeSchema),
}).strict()

export const RuntimeStatusNextEdgeSchema = z.object({
  command: z.enum([
    'prepare-prd-understanding', 'compile-prd-run', 'compile-executable-run',
    'submit-candidate', 'open-approval', 'confirm-approval',
    'get-acceptance-review', 'confirm-acceptance-review',
    'configure-target', 'probe-target',
    'run-preflight', 'prepare-manual-result',
    'finalize-manual-result-role', 'execute-run', 'resume-run', 'finalize-run', 'render-report',
  ]),
  from: WorkflowNodeSchema,
  expectedState: WorkflowNodeSchema,
}).strict()

export const RuntimePreflightBlockerSchema = z.object({
  status: z.enum(['input-blocked', 'environment-blocked']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  blockedAt: z.string().datetime(),
  attemptCount: z.number().int().positive(),
  resumeState: z.literal('preflight-readonly'),
}).strict()

export const RuntimeStatusResultSchema = z.object({
  runId: SafeIdSchema,
  assetId: SafeIdSchema,
  projectIdentityDigest: DigestSchema,
  runtimeInstallationDigest: DigestSchema,
  generationId: SafeIdSchema,
  prdRevision: DigestSchema,
  workflow: WorkflowStateSchema,
  artifactDigests: z.record(DigestSchema),
  state: WorkflowNodeSchema,
  nextEdge: RuntimeStatusNextEdgeSchema.nullable(),
  verifiedDigests: z.record(DigestSchema),
  minimumMissingInput: z.array(z.string().min(1)).max(32),
  preflightBlocker: RuntimePreflightBlockerSchema.optional(),
  acceptanceReview: AcceptanceReviewSchema.optional(),
  acceptanceReviewConfirmation: z.object({
    status: z.enum(['required', 'confirmed']),
    receiptDigest: DigestSchema.optional(),
  }).strict().optional(),
  handle: RunHandleSchema.optional(),
  stage: RunStageSchema.optional(),
  condition: RunConditionSchema.optional(),
  preservedAssets: z.array(z.string().min(1)).max(100_000).optional(),
  invalidatedAssets: z.array(z.string().min(1)).max(100_000).optional(),
  semanticCases: z.array(z.object({
    caseId: SafeIdSchema,
    title: z.string().min(1).max(64 * 1024),
    actor: SafeIdSchema,
    contractNodeIds: z.array(SafeIdSchema).max(10_000),
    oracleIds: z.array(SafeIdSchema).max(10_000),
    executionLane: z.enum([
      'preview-readonly', 'real-reversible-write', 'injection-simulated',
    ]).optional(),
    fixture: E2ECaseExecutionFieldsSchema.shape.fixture.optional(),
    locatorCandidates: E2ECaseExecutionFieldsSchema.shape.locatorCandidates.optional(),
    pageIdentityPolicy: E2ECaseExecutionFieldsSchema.shape.pageIdentityPolicy.optional(),
    bindingStatus: z.enum(['pending', 'ready', 'blocked']),
    blockerReasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
  }).strict()).max(1_000).optional(),
  remediation: z.array(z.string().min(1).max(64 * 1024)).max(32).optional(),
  target: z.object({
    schemaVersion: z.literal('1.0.0'),
    contract: TargetContractSchema,
    contractDigest: DigestSchema,
    environmentIdentityDigest: DigestSchema,
  }).strict().optional(),
  targetProbe: z.object({
    schemaVersion: z.literal('1.0.0'),
    trust: z.literal('untrusted-diagnostic'),
    runId: SafeIdSchema,
    targetContractDigest: DigestSchema,
    status: z.enum(['ready', 'environment-blocked', 'page-identity-mismatch']),
    reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
    observedUrl: z.string().url(),
    observedTitle: z.string(),
    identityMatched: z.boolean(),
    diagnostics: TargetProbeDiagnosticsSchema.optional(),
    probedAt: z.string().datetime(),
    diagnosticDigest: DigestSchema,
  }).strict().optional(),
  pendingDecision: JsonValueSchema.optional(),
  taskState: TaskStateViewV1Schema.optional(),
}).strict()

export const RuntimeCreateRunResultSchema = z.object({
  runId: SafeIdSchema,
  assetId: SafeIdSchema,
  projectIdentityDigest: DigestSchema,
  generationId: SafeIdSchema,
  prdRevision: DigestSchema,
  sourceRevision: DigestSchema,
  understandingContractDigest: DigestSchema,
  sourceBundle: z.array(z.object({
    sourceId: SafeIdSchema,
    kind: z.literal('file'),
    ref: z.string().min(1),
    mediaType: z.string().min(1).max(256),
    origin: z.object({ kind: z.enum(['file', 'url', 'text']), ref: z.string().min(1) }).strict(),
    relevance: z.enum(['target', 'necessary-dependency']),
    digest: DigestSchema,
    byteLength: z.number().int().positive().max(16 * 1024 * 1024),
  }).strict()).min(1).max(101),
  workflow: WorkflowStateSchema,
}).strict()

export const RuntimePreparePrdUnderstandingResultSchema = z.object({
  runId: SafeIdSchema,
  sourceRevision: DigestSchema,
  understanding: PrdUnderstandingProjectionSchema,
}).strict()

export const RuntimeCompilePrdRunResultSchema = z.object({
  runId: SafeIdSchema,
  compilerDigest: DigestSchema,
  caseCount: z.number().int().positive().max(1_000),
  review: z.object({
    contractProjectionDigest: DigestSchema,
    caseIds: z.array(SafeIdSchema).min(1).max(1_000),
    mappedAcceptanceCount: z.number().int().positive(),
    oracleCount: z.number().int().positive(),
  }).strict(),
  unresolvedItems: z.array(z.string().min(1)).max(10_000),
  nextRequiredDecision: z.literal('scope'),
}).strict()

export const RuntimeCompileExecutableRunResultSchema = z.object({
  runId: SafeIdSchema,
  compilerDigest: DigestSchema,
  projectionDigest: DigestSchema,
  artifactDigests: z.object({
    'test-cases': DigestSchema,
    'browser-action-map': DigestSchema,
    'execution-contract': DigestSchema,
  }).strict(),
  executableCaseIds: z.array(SafeIdSchema).max(1_000),
  blockedCases: z.array(z.object({
    caseId: SafeIdSchema,
    reason: z.enum(['needs-binding', 'unsupported']),
    missingActionIds: z.array(SafeIdSchema).max(10_000),
    missingOracleIds: z.array(SafeIdSchema).max(10_000),
  }).strict()).max(1_000),
  workflow: WorkflowStateSchema,
}).strict()

export const RuntimeAcceptanceReviewResultSchema = z.object({
  review: AcceptanceReviewSchema,
  confirmation: z.object({
    status: z.enum(['required', 'confirmed']),
    receiptDigest: DigestSchema.optional(),
  }).strict(),
}).strict()

export const RuntimeResponseEnvelopeSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  requestId: SafeIdSchema,
  runtime: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    installationDigest: DigestSchema,
  }).strict(),
  ok: z.boolean(),
  result: JsonValueSchema.optional(),
  error: RuntimeErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.ok === (value.error !== undefined) || value.ok !== (value.result !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'response 必须且只能包含 result 或 error',
    })
  }
})

export type RuntimeRequestEnvelope = z.infer<typeof RuntimeRequestEnvelopeSchema>
export type RuntimeResponseEnvelope = z.infer<typeof RuntimeResponseEnvelopeSchema>
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>
export type RuntimeDoctorProbe = z.infer<typeof RuntimeDoctorProbeSchema>
export type RuntimeDoctorReport = z.infer<typeof RuntimeDoctorReportSchema>
export type RuntimeStatusNextEdge = z.infer<typeof RuntimeStatusNextEdgeSchema>
export type RuntimeStatusResult = z.infer<typeof RuntimeStatusResultSchema>
export type RuntimePreflightBlocker = z.infer<typeof RuntimePreflightBlockerSchema>
export type RuntimeCreateRunResult = z.infer<typeof RuntimeCreateRunResultSchema>
export type RuntimePreparePrdUnderstandingResult = z.infer<
  typeof RuntimePreparePrdUnderstandingResultSchema
>
export type RuntimeCompilePrdRunResult = z.infer<typeof RuntimeCompilePrdRunResultSchema>
export type RuntimeCompileExecutableRunResult = z.infer<typeof RuntimeCompileExecutableRunResultSchema>
export type RuntimeAcceptanceReviewResult = z.infer<typeof RuntimeAcceptanceReviewResultSchema>

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}
