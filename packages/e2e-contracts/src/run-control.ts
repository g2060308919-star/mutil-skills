import { z } from 'zod'
import { WorkflowNodeSchema } from './workflow.js'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/)
const Reason = z.string().regex(/^E2E_[A-Z0-9_]+$/)

export const RunCancellationPhaseV1Schema = z.enum([
  'pre-dispatch', 'read-running', 'write-known', 'write-unknown', 'cleanup-running', 'terminal',
])

export const RunCancellationResultV1Schema = z.object({
  schemaVersion: z.literal('run-cancellation-result/v1'), runId: Id, requestId: Id,
  phase: RunCancellationPhaseV1Schema,
  disposition: z.enum(['cancelled', 'cancelling', 'reconcile-required', 'cleanup-continuing', 'already-terminal']),
  repeated: z.boolean(), cleanupRequired: z.boolean(), requestedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const expected = value.phase === 'pre-dispatch' ? 'cancelled'
    : value.phase === 'read-running' || value.phase === 'write-known' ? 'cancelling'
      : value.phase === 'write-unknown' ? 'reconcile-required'
        : value.phase === 'cleanup-running' ? 'cleanup-continuing' : 'already-terminal'
  if (value.disposition !== expected) context.addIssue({ code: 'custom', path: ['disposition'],
    message: '取消处置必须由当前副作用阶段推导' })
  const mustCleanup = ['write-known', 'write-unknown', 'cleanup-running'].includes(value.phase)
  if (value.cleanupRequired !== mustCleanup) context.addIssue({ code: 'custom', path: ['cleanupRequired'],
    message: '写与 cleanup 阶段取消不得跳过安全收敛' })
})

export const RunHealthSnapshotV1Schema = z.object({
  schemaVersion: z.literal('run-health-snapshot/v1'), runId: Id,
  observedWorkflowState: WorkflowNodeSchema, observedWorkflowSequence: z.number().int().nonnegative(),
  lastProgressAt: z.string().datetime(),
  status: z.enum(['idle', 'running', 'waiting', 'cancelling', 'cleanup', 'reconcile', 'terminal']),
  active: z.object({ caseId: Id.optional(), actionId: Id.optional(), attemptId: Id.optional(),
    pageIdentity: z.string().min(1).max(8_192).optional(), frameIdentity: z.string().min(1).max(2_048).optional() }).strict(),
  wait: z.object({ reasonCode: Reason, deadlineAt: z.string().datetime(),
    elapsedMs: z.number().int().nonnegative() }).strict().optional(),
  cancel: z.object({ requested: z.boolean(), phase: RunCancellationPhaseV1Schema.optional() }).strict(),
  cleanup: z.object({ status: z.enum(['not-applicable', 'pending', 'running', 'verified', 'failed', 'unknown']),
    residualCount: z.number().int().nonnegative() }).strict(),
  resources: z.object({ queueDepth: z.number().int().nonnegative(), lockCount: z.number().int().nonnegative(),
    gatewayReservations: z.number().int().nonnegative(), childProcesses: z.number().int().nonnegative(),
    rssBytes: z.number().int().nonnegative(), evidenceBytes: z.number().int().nonnegative() }).strict(),
}).strict()

export type RunCancellationPhaseV1 = z.infer<typeof RunCancellationPhaseV1Schema>
export type RunCancellationResultV1 = z.infer<typeof RunCancellationResultV1Schema>
export type RunHealthSnapshotV1 = z.infer<typeof RunHealthSnapshotV1Schema>
