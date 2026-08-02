import {
  RunConditionSchema,
  RunStageSchema,
  type RunCondition,
  type RunStage,
  type WorkflowNode,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

const STAGE_BY_WORKFLOW: Record<WorkflowNode, RunStage> = {
  created: 'requirements',
  'source-frozen': 'requirements',
  'awaiting-scope-approval': 'requirements',
  'scope-approved': 'planning',
  modeled: 'planning',
  'coverage-audited': 'acceptance-review',
  'discovery-approved': 'preflight',
  'preflight-readonly': 'preflight',
  'binding-draft': 'execution-approval',
  'lease-reserved': 'execution-approval',
  'awaiting-execution-approval': 'execution-approval',
  'execution-approved': 'execution-approval',
  compiled: 'compiled',
  'running-real': 'execution',
  'running-injection': 'execution',
  diagnosing: 'finalization',
  finalizing: 'finalization',
  'publication-ready': 'finalization',
  'pending-decision': 'execution',
  accepted: 'completed',
  rejected: 'completed',
  incomplete: 'completed',
  'input-blocked': 'requirements',
  'environment-blocked': 'preflight',
  'safety-blocked': 'finalization',
  'automation-blocked': 'execution',
  'artifact-blocked': 'finalization',
  'migration-required': 'requirements',
}

export function projectRunStage(workflow: WorkflowNode): RunStage {
  return RunStageSchema.parse(STAGE_BY_WORKFLOW[workflow])
}

export function classifyRunCondition(snapshot: RuntimeRunSnapshot): RunCondition {
  if (snapshot.preflightBlocker !== undefined) return RunConditionSchema.parse({
    kind: 'blocked-retryable',
    reasonCode: snapshot.preflightBlocker.reasonCode,
    resumeStage: 'preflight',
  })
  if (snapshot.workflow.current === 'accepted'
    || snapshot.workflow.current === 'rejected'
    || snapshot.workflow.current === 'incomplete') return RunConditionSchema.parse({
    kind: 'terminal', verdict: snapshot.workflow.current,
  })
  if (snapshot.workflow.current === 'pending-decision' && snapshot.pendingDecision !== undefined) {
    return RunConditionSchema.parse({
      kind: 'awaiting-user', decisionId: snapshot.pendingDecision.decisionId,
    })
  }
  if (snapshot.workflow.current === 'running-real'
    || snapshot.workflow.current === 'running-injection') return RunConditionSchema.parse({
    kind: 'running', attemptId: snapshot.executionAttempt?.attemptId ?? snapshot.runId,
  })
  if (snapshot.workflow.current.endsWith('-blocked')
    || snapshot.workflow.current === 'migration-required') return RunConditionSchema.parse({
    kind: 'blocked-requires-change',
    reasonCode: terminalReasonCode(snapshot.workflow.current),
    resumeStage: projectRunStage(snapshot.workflow.current),
  })
  return RunConditionSchema.parse({ kind: 'ready' })
}

function terminalReasonCode(workflow: WorkflowNode): string {
  return `E2E_RUN_${workflow.replaceAll('-', '_').toUpperCase()}`
}
