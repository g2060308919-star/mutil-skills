import { z } from 'zod'

export const WorkflowNodeSchema = z.enum([
  'created',
  'source-frozen',
  'awaiting-scope-approval',
  'scope-approved',
  'modeled',
  'coverage-audited',
  'discovery-approved',
  'preflight-readonly',
  'binding-draft',
  'lease-reserved',
  'awaiting-execution-approval',
  'execution-approved',
  'compiled',
  'running-real',
  'running-injection',
  'diagnosing',
  'finalizing',
  'publication-ready',
  'accepted',
  'rejected',
  'incomplete',
  'pending-decision',
  'input-blocked',
  'environment-blocked',
  'safety-blocked',
  'automation-blocked',
  'artifact-blocked',
  'migration-required',
  'cancelled',
])

export const WorkflowStateSchema = z.object({
  current: WorkflowNodeSchema,
  sequence: z.number().int().nonnegative(),
  eventChainDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowState = z.infer<typeof WorkflowStateSchema>

export interface WorkflowTransitionEvent {
  sequence: number
  previous: WorkflowNode
  next: WorkflowNode
  reason: string
  timestamp: string
  engineVersion: string
  commitVerified: boolean
  previousChainDigest: string
  eventDigest: string
}
