import { z } from 'zod'
import { RunConditionSchema, RunStageSchema } from './e2e-flow.js'
import { WorkflowStateSchema } from './workflow.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ReasonCodeSchema = z.string().regex(/^E2E_[A-Z0-9_]+$/)

export const TaskStateCaseAttemptV1Schema = z.object({
  queueOrdinal: z.number().int().nonnegative(),
  caseId: SafeIdSchema,
  actor: SafeIdSchema,
  failurePolicy: z.enum(['stop-required', 'continue']),
  state: z.enum(['pending', 'running', 'cleanup', 'passed', 'failed', 'unable', 'safety-blocked']),
  attemptId: SafeIdSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  effectObservation: z.enum(['not-applicable', 'not-applied', 'applied', 'unknown']).optional(),
  cleanupStatus: z.enum(['not-applicable', 'verified-clean', 'failed', 'unknown']).optional(),
  terminalReason: z.string().min(1).max(16 * 1024).optional(),
}).strict()

export const TaskStateArtifactValidityV1Schema = z.object({
  assetKey: z.string().min(1).max(256),
  validity: z.enum(['preserved', 'invalidated']),
  contentDigest: DigestSchema.optional(),
}).strict()

export const TaskStateRecoveryV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('retry'),
    command: z.enum(['probe-target', 'run-preflight']),
    reasonCode: ReasonCodeSchema,
  }).strict(),
  z.object({
    kind: z.literal('resume'), command: z.literal('resume-run'), attemptId: SafeIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('reconcile'), command: z.literal('resume-run'), attemptId: SafeIdSchema,
    reasonCode: ReasonCodeSchema,
  }).strict(),
  z.object({
    kind: z.literal('new-run'),
    changedBinding: z.enum(['source', 'target', 'runtime-installation']),
    reasonCode: ReasonCodeSchema,
  }).strict(),
  z.object({
    kind: z.literal('migration-required'), reasonCode: ReasonCodeSchema,
  }).strict(),
])

/**
 * RuntimeRunSnapshot 的只读、无持久化投影。它只能解释权威事实，不能作为状态写入口。
 */
export const TaskStateViewV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runId: SafeIdSchema,
  assetId: SafeIdSchema,
  snapshotRevision: z.number().int().nonnegative(),
  workflow: WorkflowStateSchema,
  stage: RunStageSchema,
  condition: RunConditionSchema,
  caseAttempts: z.array(TaskStateCaseAttemptV1Schema).max(1_000),
  artifactValidity: z.array(TaskStateArtifactValidityV1Schema).max(100_000),
  verifiedDigests: z.record(DigestSchema),
  minimumMissingInput: z.array(z.string().min(1).max(16 * 1024)).max(32),
  recovery: TaskStateRecoveryV1Schema,
}).strict()

export type TaskStateCaseAttemptV1 = z.infer<typeof TaskStateCaseAttemptV1Schema>
export type TaskStateArtifactValidityV1 = z.infer<typeof TaskStateArtifactValidityV1Schema>
export type TaskStateRecoveryV1 = z.infer<typeof TaskStateRecoveryV1Schema>
export type TaskStateViewV1 = z.infer<typeof TaskStateViewV1Schema>
