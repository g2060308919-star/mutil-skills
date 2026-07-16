import {
  E2EError,
  canonicalizeJson,
  digestText,
  type ArtifactSignature,
  type WorkflowNode,
  type WorkflowState,
  type WorkflowTransitionEvent,
} from '@mutil-skills/e2e-contracts'

const allowedTransitions: Readonly<Record<WorkflowNode, readonly WorkflowNode[]>> = {
  created: ['source-frozen'],
  'source-frozen': ['awaiting-scope-approval'],
  'awaiting-scope-approval': ['scope-approved', 'pending-decision'],
  'scope-approved': ['modeled'],
  modeled: ['coverage-audited'],
  'coverage-audited': ['discovery-approved'],
  'discovery-approved': ['preflight-readonly'],
  'preflight-readonly': ['binding-draft', 'input-blocked', 'environment-blocked', 'safety-blocked'],
  'binding-draft': ['lease-reserved', 'awaiting-execution-approval', 'input-blocked', 'safety-blocked'],
  'lease-reserved': ['awaiting-execution-approval', 'input-blocked', 'safety-blocked'],
  'awaiting-execution-approval': ['execution-approved', 'pending-decision'],
  'execution-approved': ['compiled', 'binding-draft', 'safety-blocked'],
  compiled: ['running-real', 'awaiting-execution-approval', 'safety-blocked'],
  'running-real': ['running-injection', 'diagnosing', 'safety-blocked', 'environment-blocked', 'automation-blocked'],
  'running-injection': ['diagnosing', 'safety-blocked', 'environment-blocked', 'automation-blocked'],
  diagnosing: ['finalizing', 'pending-decision', 'input-blocked', 'environment-blocked', 'safety-blocked', 'automation-blocked'],
  finalizing: ['publication-ready', 'artifact-blocked', 'migration-required'],
  'publication-ready': [
    'accepted', 'rejected', 'incomplete', 'pending-decision', 'input-blocked',
    'environment-blocked', 'safety-blocked', 'automation-blocked', 'artifact-blocked', 'migration-required',
  ],
  'input-blocked': ['preflight-readonly'],
  accepted: [],
  rejected: [],
  incomplete: [],
  'pending-decision': [],
  'environment-blocked': [],
  'safety-blocked': [],
  'automation-blocked': [],
  'artifact-blocked': [],
  'migration-required': [],
}

export function createWorkflow(): WorkflowState {
  return {
    current: 'created',
    sequence: 0,
    eventChainDigest: digestText(
      'workflow-event-chain/v1',
      canonicalizeJson({ initial: 'created' }),
    ),
  }
}

export interface TransitionWorkflowInput {
  state: WorkflowState
  next: WorkflowNode
  reason: string
  timestamp?: string
  engineVersion?: string
  executionGrantValid?: boolean
  approvalSubjectChanged?: boolean
  grantRevoked?: boolean
  commitVerified?: boolean
}

export interface TransitionWorkflowResult {
  state: WorkflowState
  event: WorkflowTransitionEvent
}

export interface PendingWorkflowDecision {
  decisionId: string
  resumeState: WorkflowNode
  pausedSequence: number
  pausedChainDigest: string
  pauseEventDigest: string
  reason: string
  pendingDigest: string
}

export interface PausedWorkflowResult {
  accepted: false
  terminalState: 'pending-decision'
  resumeState: WorkflowNode
  state: WorkflowState
  pending: PendingWorkflowDecision
  event: WorkflowTransitionEvent
}

export function pauseWorkflow(input: {
  state: WorkflowState
  decisionId: string
  reason: string
  timestamp?: string
  engineVersion?: string
}): PausedWorkflowResult {
  if (!['awaiting-scope-approval', 'awaiting-execution-approval', 'diagnosing'].includes(input.state.current)) {
    throw workflowError('E2E_WORKFLOW_PAUSE_DENIED', `节点 ${input.state.current} 不允许因未决事项暂停`)
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.decisionId) || input.reason.trim() === '') {
    throw workflowError('E2E_WORKFLOW_DECISION_INVALID', '暂停需要合法 decisionId 和非空理由')
  }
  const result = recordWorkflowEvent({
    state: input.state,
    next: 'pending-decision',
    reason: input.reason,
    timestamp: input.timestamp,
    engineVersion: input.engineVersion,
  })
  const pendingBase = {
    decisionId: input.decisionId,
    resumeState: input.state.current,
    pausedSequence: result.state.sequence,
    pausedChainDigest: result.state.eventChainDigest,
    pauseEventDigest: result.event.eventDigest,
    reason: input.reason,
  }
  return {
    accepted: false,
    terminalState: 'pending-decision',
    resumeState: input.state.current,
    state: result.state,
    event: result.event,
    pending: { ...pendingBase, pendingDigest: pendingWorkflowDecisionDigest(pendingBase) },
  }
}

export function workflowResumeAuthorizationDigest(
  pending: PendingWorkflowDecision,
  decisionDigest: string,
): string {
  return digestText('workflow-resume-authorization/v1', canonicalizeJson({
    pendingDigest: pending.pendingDigest,
    decisionDigest,
  }))
}

export function resumeWorkflow(input: {
  state: WorkflowState
  pending: PendingWorkflowDecision
  decisionId: string
  decisionDigest: string
  decisionProof: ArtifactSignature
  verifyDecisionProof(proof: ArtifactSignature): boolean
  timestamp?: string
  engineVersion?: string
}): TransitionWorkflowResult {
  const pending = Object.freeze({
    decisionId: input.pending.decisionId,
    resumeState: input.pending.resumeState,
    pausedSequence: input.pending.pausedSequence,
    pausedChainDigest: input.pending.pausedChainDigest,
    pauseEventDigest: input.pending.pauseEventDigest,
    reason: input.pending.reason,
    pendingDigest: input.pending.pendingDigest,
  })
  const decisionProof = Object.freeze({
    issuer: input.decisionProof.issuer,
    keyId: input.decisionProof.keyId,
    algorithm: input.decisionProof.algorithm,
    signedDigest: input.decisionProof.signedDigest,
    signature: input.decisionProof.signature,
  })
  if (!['awaiting-scope-approval', 'awaiting-execution-approval', 'diagnosing'].includes(pending.resumeState)
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(pending.decisionId)
    || !Number.isSafeInteger(pending.pausedSequence) || pending.pausedSequence < 1
    || !/^sha256:[a-f0-9]{64}$/.test(pending.pausedChainDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(pending.pauseEventDigest)
    || pending.reason.trim() === '') {
    throw workflowError('E2E_WORKFLOW_PENDING_TICKET_INVALID', '暂停 ticket 结构无效')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.decisionDigest)) {
    throw workflowError('E2E_WORKFLOW_DECISION_PROOF_REQUIRED', '恢复工作流需要通过 Authority 验证的决定摘要')
  }
  const { pendingDigest, ...pendingBase } = pending
  if (pendingDigest !== pendingWorkflowDecisionDigest(pendingBase)) {
    throw workflowError('E2E_WORKFLOW_PENDING_TICKET_INVALID', '暂停 ticket 字段与其摘要不一致')
  }
  const authorizationDigest = workflowResumeAuthorizationDigest(pending, input.decisionDigest)
  if (decisionProof.signedDigest !== authorizationDigest) {
    throw workflowError('E2E_WORKFLOW_DECISION_DIGEST_MISMATCH', 'Authority proof 必须同时绑定暂停 ticket 和当前决定摘要')
  }
  let proofValid = false
  try { proofValid = input.verifyDecisionProof(decisionProof) } catch { proofValid = false }
  if (!proofValid) {
    throw workflowError('E2E_WORKFLOW_DECISION_PROOF_REQUIRED', '恢复工作流需要通过 Authority 验证的决定证明')
  }
  if (input.decisionId !== pending.decisionId) {
    throw workflowError('E2E_WORKFLOW_DECISION_MISMATCH', '恢复决定与暂停时的 decisionId 不一致')
  }
  if (input.state.current !== 'pending-decision'
    || input.state.sequence !== pending.pausedSequence
    || input.state.eventChainDigest !== pending.pausedChainDigest) {
    throw workflowError('E2E_WORKFLOW_RESUME_STATE_MISMATCH', '只能从暂停时冻结的原节点和原事件链恢复')
  }
  return recordWorkflowEvent({
    state: input.state,
    next: pending.resumeState,
    reason: `已解决 ${input.decisionId}：${input.decisionDigest}`,
    timestamp: input.timestamp,
    engineVersion: input.engineVersion,
  })
}

function pendingWorkflowDecisionDigest(
  pending: Omit<PendingWorkflowDecision, 'pendingDigest'>,
): string {
  return digestText('workflow-pending-decision/v1', canonicalizeJson(pending))
}

export function transitionWorkflow(input: TransitionWorkflowInput): TransitionWorkflowResult {
  if (input.next === 'pending-decision' && input.state.current !== 'publication-ready') {
    throw workflowError(
      'E2E_WORKFLOW_PAUSE_API_REQUIRED',
      '运行中的未决事项必须通过 pauseWorkflow 保留可恢复原节点',
    )
  }
  if (!allowedTransitions[input.state.current].includes(input.next)) {
    throw workflowError('E2E_WORKFLOW_TRANSITION_DENIED', `不允许从 ${input.state.current} 进入 ${input.next}`)
  }
  if (input.state.current === 'awaiting-execution-approval' && input.next === 'execution-approved' && input.executionGrantValid !== true) {
    throw workflowError('E2E_WORKFLOW_GRANT_REQUIRED', '进入 execution-approved 需要有效执行 Grant')
  }
  if (input.state.current === 'compiled' && input.next === 'awaiting-execution-approval' && input.approvalSubjectChanged !== true) {
    throw workflowError('E2E_WORKFLOW_SUBJECT_CHANGE_REQUIRED', '编译结果只有在审批主题变化时才能回到审批')
  }
  if (input.state.current === 'execution-approved' && input.next === 'binding-draft' && input.grantRevoked !== true) {
    throw workflowError('E2E_WORKFLOW_GRANT_REVOCATION_REQUIRED', '重新绑定前必须撤销现有 Grant')
  }
  if (input.state.current === 'publication-ready' && isPublishedTerminal(input.next) && input.commitVerified !== true) {
    throw workflowError('E2E_WORKFLOW_COMMIT_REQUIRED', '发布型终态需要已验证的原子提交')
  }

  return recordWorkflowEvent(input)
}

function recordWorkflowEvent(input: {
  state: WorkflowState
  next: WorkflowNode
  reason: string
  timestamp?: string
  engineVersion?: string
  commitVerified?: boolean
}): TransitionWorkflowResult {
  const timestamp = input.timestamp ?? new Date().toISOString()
  const sequence = input.state.sequence + 1
  const eventCore = {
    sequence,
    previous: input.state.current,
    next: input.next,
    reason: input.reason,
    timestamp,
    engineVersion: input.engineVersion ?? '0.1.0',
    commitVerified: input.commitVerified === true,
    previousChainDigest: input.state.eventChainDigest,
  }
  const eventDigest = digestText('workflow-event/v1', canonicalizeJson(eventCore))
  const event: WorkflowTransitionEvent = { ...eventCore, eventDigest }
  const eventChainDigest = digestText('workflow-event-chain/v1', canonicalizeJson({
    previous: input.state.eventChainDigest,
    event: eventDigest,
  }))

  return { state: { current: input.next, sequence, eventChainDigest }, event }
}

function isPublishedTerminal(node: WorkflowNode): boolean {
  return !['artifact-blocked', 'migration-required'].includes(node)
}

function workflowError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'decision', message, retryable: false })
}
