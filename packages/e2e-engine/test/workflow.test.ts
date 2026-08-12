import { describe, expect, test } from 'vitest'
import type { WorkflowState } from '@mutil-skills/e2e-contracts'
import {
  createWorkflow, invalidateForHealingRevision, invalidatePreflightForTargetChange, pauseWorkflow, resumeWorkflow,
  transitionWorkflow, workflowResumeAuthorizationDigest,
} from '../src/index.js'

function state(current: WorkflowState['current']): WorkflowState {
  return { current, sequence: 1, eventChainDigest: `sha256:${'a'.repeat(64)}` }
}

describe('transitionWorkflow', () => {
  test('creates the stable initial workflow state inside the Engine boundary', () => {
    const first = createWorkflow()
    const second = createWorkflow()

    expect(first).toEqual(second)
    expect(first).toEqual({
      current: 'created',
      sequence: 0,
      eventChainDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
  })

  test('歧义暂停保留原节点，且只能用有效决定从同一事件链恢复', () => {
    const original = state('awaiting-scope-approval')
    const paused = pauseWorkflow({
      state: original, decisionId: 'DECISION-SCOPE-1', reason: 'PRD 对审核角色存在歧义',
      timestamp: '2026-07-12T10:00:00.000Z',
    })

    expect(paused).toMatchObject({
      accepted: false, terminalState: 'pending-decision', resumeState: 'awaiting-scope-approval',
      state: { current: 'pending-decision', sequence: original.sequence + 1 },
      pending: { decisionId: 'DECISION-SCOPE-1', resumeState: 'awaiting-scope-approval' },
    })
    expect(paused.state.eventChainDigest).not.toBe(original.eventChainDigest)
    expect(() => transitionWorkflow({
      state: paused.state, next: 'scope-approved', reason: '暂停期间绕过决定',
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_TRANSITION_DENIED' }))

    const decisionDigest = `sha256:${'b'.repeat(64)}`
    const authorizationDigest = workflowResumeAuthorizationDigest(paused.pending, decisionDigest)
    expect(() => resumeWorkflow({
      state: paused.state, pending: paused.pending, decisionId: 'DECISION-SCOPE-1',
      decisionDigest,
      decisionProof: artifactProof(`sha256:${'c'.repeat(64)}`), verifyDecisionProof: () => true,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_DECISION_DIGEST_MISMATCH' }))
    expect(() => resumeWorkflow({
      state: paused.state, pending: paused.pending, decisionId: 'DECISION-SCOPE-1',
      decisionDigest,
      decisionProof: artifactProof(authorizationDigest), verifyDecisionProof: () => false,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_DECISION_PROOF_REQUIRED' }))
    expect(() => resumeWorkflow({
      state: paused.state,
      pending: { ...paused.pending, resumeState: 'accepted' },
      decisionId: 'DECISION-SCOPE-1', decisionDigest,
      decisionProof: artifactProof(authorizationDigest), verifyDecisionProof: () => true,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_PENDING_TICKET_INVALID' }))
    let resumeStateReads = 0
    const changingTicket = new Proxy(paused.pending, {
      get(target, property, receiver) {
        if (property === 'resumeState') {
          resumeStateReads += 1
          return resumeStateReads === 1 ? target.resumeState : 'accepted'
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const proxyResumed = resumeWorkflow({
      state: paused.state, pending: changingTicket, decisionId: 'DECISION-SCOPE-1', decisionDigest,
      decisionProof: artifactProof(authorizationDigest), verifyDecisionProof: () => true,
    })
    expect(proxyResumed.state.current).toBe('awaiting-scope-approval')

    const resumed = resumeWorkflow({
      state: paused.state, pending: paused.pending, decisionId: 'DECISION-SCOPE-1',
      decisionDigest,
      decisionProof: artifactProof(authorizationDigest), verifyDecisionProof: () => true,
      timestamp: '2026-07-12T10:01:00.000Z',
    })
    expect(resumed.state).toMatchObject({ current: 'awaiting-scope-approval', sequence: original.sequence + 2 })
    expect(resumed.state.eventChainDigest).not.toBe(paused.state.eventChainDigest)

    expect(() => resumeWorkflow({
      state: resumed.state, pending: paused.pending, decisionId: 'DECISION-SCOPE-1',
      decisionDigest,
      decisionProof: artifactProof(authorizationDigest), verifyDecisionProof: () => true,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_RESUME_STATE_MISMATCH' }))
  })

  test('rejects skipping the model, coverage, discovery, and binding gates', () => {
    expect(() => transitionWorkflow({
      state: state('scope-approved'),
      next: 'execution-approved',
      reason: 'skip',
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_TRANSITION_DENIED' }))
  })

  test('requires a valid execution grant after binding and lease reservation', () => {
    expect(() => transitionWorkflow({
      state: state('awaiting-execution-approval'),
      next: 'execution-approved',
      reason: 'approve',
      executionGrantValid: false,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_GRANT_REQUIRED' }))

    expect(transitionWorkflow({
      state: state('awaiting-execution-approval'),
      next: 'execution-approved',
      reason: 'approve',
      executionGrantValid: true,
    }).state.current).toBe('execution-approved')
  })

  test('returns compiled work to approval when its subject changes', () => {
    expect(transitionWorkflow({
      state: state('compiled'),
      next: 'awaiting-execution-approval',
      reason: 'action map changed',
      approvalSubjectChanged: true,
    }).state.current).toBe('awaiting-execution-approval')

    expect(() => transitionWorkflow({
      state: state('compiled'),
      next: 'awaiting-execution-approval',
      reason: 'silent return',
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_SUBJECT_CHANGE_REQUIRED' }))
  })

  test('healing 修订只能从 diagnosing 回到执行审批且必须显式撤销旧 Grant', () => {
    expect(invalidateForHealingRevision({
      state: state('diagnosing'), reason: 'bounded locator repair',
      approvalSubjectChanged: true, grantRevoked: true,
    }).state.current).toBe('awaiting-execution-approval')
    expect(() => invalidateForHealingRevision({
      state: state('diagnosing'), reason: 'silent repair',
      approvalSubjectChanged: true, grantRevoked: false,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_HEALING_GRANT_REVOCATION_REQUIRED' }))
    expect(() => invalidateForHealingRevision({
      state: state('compiled'), reason: 'wrong recovery point',
      approvalSubjectChanged: true, grantRevoked: true,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_HEALING_INVALIDATION_DENIED' }))
  })

  test('目标身份变化以审计事件回退到 Discovery 前且不能从任意状态调用', () => {
    const original = state('preflight-readonly')
    const invalidated = invalidatePreflightForTargetChange({
      state: original,
      reason: 'page identity policy changed',
      timestamp: '2026-08-02T08:00:00.000Z',
      engineVersion: '0.5.0',
    })

    expect(invalidated.state).toMatchObject({
      current: 'coverage-audited', sequence: original.sequence + 1,
    })
    expect(invalidated.event).toMatchObject({
      previous: 'preflight-readonly', next: 'coverage-audited', commitVerified: false,
    })
    expect(() => invalidatePreflightForTargetChange({
      state: state('running-real'), reason: 'unsafe rewind',
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_TARGET_INVALIDATION_DENIED' }))
  })

  test('publishes a verdict only after a verified atomic commit', () => {
    expect(() => transitionWorkflow({
      state: state('publication-ready'),
      next: 'accepted',
      reason: 'publish',
      commitVerified: false,
    })).toThrowError(expect.objectContaining({ code: 'E2E_WORKFLOW_COMMIT_REQUIRED' }))

    expect(transitionWorkflow({
      state: state('publication-ready'),
      next: 'accepted',
      reason: 'publish',
      commitVerified: true,
    }).state.current).toBe('accepted')
  })

  test('allows artifact failure to terminate without publication', () => {
    const result = transitionWorkflow({
      state: state('finalizing'),
      next: 'artifact-blocked',
      reason: 'generation validation failed',
    })

    expect(result.state.current).toBe('artifact-blocked')
    expect(result.event.commitVerified).toBe(false)
  })
})

function artifactProof(signedDigest: string) {
  return {
    issuer: 'test-authority', keyId: 'test-key', algorithm: 'Ed25519' as const,
    signedDigest, signature: 'test-signature',
  }
}
