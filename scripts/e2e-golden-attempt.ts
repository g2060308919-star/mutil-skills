import {
  canonicalizeJson,
  digestText,
  type AttemptEventAuthorityProof,
  type AppendAttemptEventInput,
  type AttemptEvent,
  type CaseVerdictStatus,
  type ExecutionEffect,
} from '@mutil-skills/e2e-contracts'
import { selectFinalAttempt } from '@mutil-skills/e2e-engine'

interface AttemptAuthority {
  appendAttemptEvent(input: {
    context: { assetId: string; generationId: string; prdRevision: string; runId: string; caseId: string }
    event: AppendAttemptEventInput
  }): { event: AttemptEvent; eventChainDigest: string }
  verifyAttemptEventProof(proof: AttemptEventAuthorityProof): boolean
}

export function createGoldenAttemptProof(input: {
  authority: AttemptAuthority
  assetId: string
  generationId: string
  prdRevision: string
  runId: string
  caseId: string
  attemptId: string
  status: CaseVerdictStatus
  effect: ExecutionEffect
  reservationId?: string
  outcomeDigest?: string
}): {
  attemptSelection: { status: 'valid'; attemptId: string; eventChainDigest: string }
  workflowEvents: { runId: string; attemptCases: Array<{
    caseId: string; retryPolicy: 'read-automation-max-2' | 'verified-not-applied-max-1'; initialChainDigest: string
    events: AttemptEvent[]
    selection: { status: 'selected'; attemptId: string; slot: number; eventChainDigest: string }
  }>; workflowDigest: string }
} {
  const retryPolicy = input.effect === 'read' ? 'read-automation-max-2' : 'verified-not-applied-max-1'
  const attemptContext = {
    assetId: input.assetId, generationId: input.generationId, prdRevision: input.prdRevision,
    runId: input.runId, caseId: input.caseId,
  }
  const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson({
    ...attemptContext,
  }))
  const started = input.authority.appendAttemptEvent({ context: attemptContext, event: {
    sequence: 1, caseId: input.caseId, slot: 0, attemptId: input.attemptId,
    timestamp: '2026-07-11T10:00:00.000Z', previousChainDigest: initialChainDigest,
    kind: 'started', mode: 'real-environment',
  } })
  const terminal = input.authority.appendAttemptEvent({ context: attemptContext, event: {
    sequence: 2, caseId: input.caseId, slot: 0, attemptId: input.attemptId,
    timestamp: '2026-07-11T10:00:01.000Z', previousChainDigest: started.eventChainDigest,
    kind: 'terminal', result: {
      status: input.status, mode: 'real-environment', effect: input.effect,
      effectObservation: input.effect === 'read' ? 'not-applicable' : 'applied',
      reservationSafeToVoid: input.effect === 'read',
      ...(['passed', 'failed'].includes(input.status)
        ? { reservationId: input.reservationId, outcomeDigest: input.outcomeDigest } : {}),
    },
  } })
  const events = [started.event, terminal.event]
  const selected = selectFinalAttempt({
    caseId: input.caseId, retryPolicy, initialChainDigest, events,
    verifyAuthorityProof: (proof) => input.authority.verifyAttemptEventProof(proof),
  })
  if (selected.status !== 'selected') throw new Error(`Golden attempt chain invalid: ${selected.reasonCodes.join(',')}`)
  const attemptSelection = {
    status: 'valid' as const,
    attemptId: selected.attemptId,
    eventChainDigest: selected.eventChainDigest,
  }
  const attemptCase = { caseId: input.caseId, retryPolicy,
    initialChainDigest, events, selection: { status: 'selected' as const, attemptId: selected.attemptId,
      slot: selected.slot, eventChainDigest: selected.eventChainDigest } }
  const workflowEvents = { runId: input.runId, attemptCases: [attemptCase],
    workflowDigest: digestText('workflow-events/v2', canonicalizeJson({ runId: input.runId,
      attemptCases: [attemptCase] })) }
  return { attemptSelection, workflowEvents }
}
