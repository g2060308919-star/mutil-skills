import {
  canonicalizeJson,
  deriveExecutionResultId,
  digestText,
  WorkflowEventsV2ContentSchema,
  type AttemptEventAuthorityProof,
  type PersistedAttemptCase,
  type VerdictInput,
  type ExecutionMode,
  type ExecutionEffect,
  type EffectObservation,
} from '@mutil-skills/e2e-contracts'
import { selectFinalAttempt } from './attempt-selection.js'
import type { VerdictDependencies } from './verdict.js'

interface AttemptArtifact {
  artifactType: string
  assetId: string
  generationId: string
  prdRevision: string
  content: unknown
}

export interface PersistedAttemptFinding { code: string; ref: string }
export interface PersistedAttemptProjection {
  resultId: string; caseId: string; attemptId: string; slot: number; eventChainDigest: string
  status: string; mode: ExecutionMode; effect: ExecutionEffect; effectObservation: EffectObservation
  attempts: Array<{ attemptId: string; slot: number; status: string; mode: ExecutionMode; effect: ExecutionEffect;
    effectObservation: EffectObservation; reservationSafeToVoid: boolean; eventChainDigest: string }>
}

export function auditPersistedAttemptFacts(
  artifacts: AttemptArtifact[],
  verifyProof: ((proof: AttemptEventAuthorityProof) => boolean) | undefined,
): { valid: boolean; findings: PersistedAttemptFinding[]; selected: PersistedAttemptProjection[] } {
  const findings: PersistedAttemptFinding[] = []
  const selected: PersistedAttemptProjection[] = []
  const byType = new Map(artifacts.map((item) => [item.artifactType, item]))
  const workflowArtifact = byType.get('workflow-events')
  const casesArtifact = byType.get('test-cases')
  const bundleArtifact = byType.get('run-bundle')
  const resultsArtifact = byType.get('browser-results')
  const gatewayArtifact = byType.get('gateway-audit')
  if (!workflowArtifact || !casesArtifact || !bundleArtifact || !resultsArtifact) {
    return { valid: false, findings: [{ code: 'E2E_ATTEMPT_ARTIFACT_MISSING', ref: 'workflow closure' }], selected }
  }
  const generationKey = (artifact: AttemptArtifact) => [artifact.assetId, artifact.generationId, artifact.prdRevision].join('\0')
  if (new Set([workflowArtifact, casesArtifact, bundleArtifact, resultsArtifact].map(generationKey)).size !== 1) {
    findings.push({ code: 'E2E_ATTEMPT_CROSS_GENERATION', ref: 'attempt artifacts' })
  }
  if (!verifyProof) add('E2E_ATTEMPT_VERIFIER_UNAVAILABLE', 'workflow-events')
  const parsedWorkflow = WorkflowEventsV2ContentSchema.safeParse(workflowArtifact.content)
  if (!parsedWorkflow.success) {
    add('E2E_ATTEMPT_WORKFLOW_SCHEMA_INVALID', parsedWorkflow.error.issues.map((issue) => issue.path.join('.')).join(','))
    return { valid: false, findings, selected }
  }
  const workflow = parsedWorkflow.data
  const testCases = array(object(casesArtifact.content).cases)
  const bundle = object(bundleArtifact.content)
  const results = object(resultsArtifact.content)
  const attemptCases = workflow.attemptCases as PersistedAttemptCase[]
  const runId = workflow.runId
  if (runId !== string(bundle.runId) || runId !== string(results.runId)) add('E2E_ATTEMPT_RUN_MISMATCH', runId)
  const expectedInitialContext = {
    assetId: workflowArtifact.assetId, generationId: workflowArtifact.generationId,
    prdRevision: workflowArtifact.prdRevision, runId,
  }
  const expectedWorkflowDigest = digestText('workflow-events/v2', canonicalizeJson({ runId, attemptCases }))
  if (workflow.workflowDigest !== expectedWorkflowDigest) add('E2E_ATTEMPT_WORKFLOW_DIGEST_INVALID', 'workflowDigest')
  const planItems = array(bundle.attemptPlans)
  const planIds = planItems.map((item) => string(object(item).caseId))
  if (new Set(planIds).size !== planIds.length) add('E2E_ATTEMPT_PLAN_DUPLICATE', 'attemptPlans')
  const plans = new Map(planItems.map((item) => [string(object(item).caseId), object(item)]))
  const cases = new Map(testCases.map((item) => [string(object(item).caseId), object(item)]))
  const resultMap = new Map(array(results.caseResults).map((item) => {
    const result = object(item)
    return [domainKey(string(result.caseId), string(result.mode)), result]
  }))
  const gatewayContent = gatewayArtifact ? object(gatewayArtifact.content) : {}
  const gatewaySessions = array(gatewayContent.sessions).map(object)
  const legacyGatewayReservations = array(gatewayContent.capabilityReservations).map(object)
  const ids = attemptCases.map((item) => domainKey(item.caseId, attemptMode(item)))
  if (new Set(ids).size !== ids.length) add('E2E_ATTEMPT_CASE_DUPLICATE', 'attemptCases')
  const expectedIds = [...resultMap.keys()].sort()
  if (canonicalizeJson([...ids].sort()) !== canonicalizeJson(expectedIds)) add('E2E_ATTEMPT_CASE_COVERAGE_INVALID', 'attemptCases')
  const scheduledIds = array(bundle.schedule).map((item) => string(object(item).caseId))
  if (new Set(scheduledIds).size !== scheduledIds.length) add('E2E_ATTEMPT_SCHEDULE_DUPLICATE', 'schedule')
  scheduledIds.sort()
  const expectedBusinessCaseIds = [...new Set(array(results.caseResults)
    .filter((item) => string(object(item).mode) === 'real-environment')
    .map((item) => string(object(item).caseId)))].sort()
  if (canonicalizeJson([...plans.keys()].sort()) !== canonicalizeJson(expectedBusinessCaseIds)
    || canonicalizeJson(scheduledIds) !== canonicalizeJson(expectedBusinessCaseIds)
    || expectedBusinessCaseIds.some((caseId) => !cases.has(caseId))) {
    add('E2E_ATTEMPT_CASE_COVERAGE_INVALID', 'test-cases/run-bundle/browser-results')
  }

  for (const attemptCase of attemptCases) {
    const caseId = attemptCase.caseId
    const testCase = cases.get(caseId)
    const plan = plans.get(caseId)
    if (!testCase || !plan) { add('E2E_ATTEMPT_CASE_BINDING_MISSING', caseId); continue }
    if (attemptCase.retryPolicy !== testCase.retryPolicy) add('E2E_ATTEMPT_RETRY_POLICY_MISMATCH', caseId)
    const expectedInitial = digestText('attempt-chain-initial/v2', canonicalizeJson({ ...expectedInitialContext, caseId }))
    if (attemptCase.initialChainDigest !== expectedInitial) add('E2E_ATTEMPT_INITIAL_CHAIN_CONTEXT_MISMATCH', caseId)
    const maxSlots = number(plan.slots)
    if (attemptCase.events.some((event) => event.slot >= maxSlots)) add('E2E_ATTEMPT_PLAN_EXCEEDED', caseId)
    const reselected = selectFinalAttempt({ caseId, retryPolicy: attemptCase.retryPolicy,
      initialChainDigest: attemptCase.initialChainDigest, events: attemptCase.events,
      verifyAuthorityProof: verifyProof ?? (() => false) })
    if (reselected.status !== 'selected') { add('E2E_ATTEMPT_SELECTION_BLOCKED', `${caseId}:${reselected.reasonCodes.join(',')}`); continue }
    const result = resultMap.get(domainKey(caseId, reselected.result.mode))
    if (!result) { add('E2E_ATTEMPT_CASE_BINDING_MISSING', `${caseId}:${reselected.result.mode}`); continue }
    if (attemptCase.selection.status !== 'selected' || attemptCase.selection.attemptId !== reselected.attemptId
      || attemptCase.selection.slot !== reselected.slot
      || attemptCase.selection.eventChainDigest !== reselected.eventChainDigest) add('E2E_ATTEMPT_PERSISTED_SELECTION_MISMATCH', caseId)
    const effect = string(testCase.effect) === 'irreversible' ? 'irreversible-write' : string(testCase.effect)
    if (reselected.result.mode === 'real-environment' && string(testCase.mode) !== reselected.result.mode) {
      add('E2E_ATTEMPT_CASE_MODE_MISMATCH', caseId)
    }
    if (string(result.attemptId) !== reselected.attemptId || string(result.eventChainDigest) !== reselected.eventChainDigest
      || string(result.status) !== reselected.result.status || string(result.mode) !== reselected.result.mode
      || string(result.effect) !== reselected.result.effect || effect !== reselected.result.effect
      || string(result.effectObservation) !== reselected.result.effectObservation) add('E2E_ATTEMPT_BROWSER_RESULT_MISMATCH', caseId)
    const terminals = attemptCase.events.filter((event) => event.kind === 'terminal')
    const expectedResultId = deriveExecutionResultId(caseId, reselected.result.mode)
    const persistedResultId = string(result.resultId)
    const resultId = persistedResultId || expectedResultId
    if (persistedResultId && persistedResultId !== expectedResultId) {
      add('E2E_ATTEMPT_RESULT_IDENTITY_INVALID', `${caseId}:${reselected.result.mode}`)
    }
    const matchingSessions = gatewaySessions.filter((session) => string(session.resultId) === resultId
      && string(session.domain) === reselected.result.mode)
    const gatewayReservations = gatewaySessions.length === 0
      ? (resultMap.size === 1 ? legacyGatewayReservations : [])
      : matchingSessions.length === 1
        ? array(object(matchingSessions[0]!.audit).capabilityReservations).map(object)
        : []
    if ((gatewaySessions.length > 0 && matchingSessions.length !== 1)
      || (gatewaySessions.length === 0 && resultMap.size > 1)) {
      add('E2E_ATTEMPT_GATEWAY_SESSION_BINDING_INVALID', `${resultId}:${reselected.result.mode}`)
    }
    for (const event of terminals) {
      if (!['passed', 'failed'].includes(event.result.status)) continue
      const bound = gatewayReservations.some((reservation) =>
        string(reservation.reservationId) === event.result.reservationId
        && string(reservation.attemptId) === event.attemptId
        && string(reservation.status) === 'completed'
        && string(reservation.outcomeDigest) === event.result.outcomeDigest)
      if (!bound) add('E2E_ATTEMPT_GATEWAY_RESERVATION_BINDING_INVALID', `${caseId}:${event.attemptId}`)
    }
    selected.push({ resultId, caseId, attemptId: reselected.attemptId, slot: reselected.slot,
      eventChainDigest: reselected.eventChainDigest, status: reselected.result.status,
      mode: reselected.result.mode, effect: reselected.result.effect,
      effectObservation: reselected.result.effectObservation,
      attempts: terminals.map((event) => ({ attemptId: event.attemptId, slot: event.slot,
        status: event.result.status, mode: event.result.mode, effect: event.result.effect,
        effectObservation: event.result.effectObservation,
        reservationSafeToVoid: event.result.reservationSafeToVoid,
        eventChainDigest: chainAt(attemptCase.initialChainDigest, attemptCase.events, event.sequence) })) })
  }
  findings.sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref))
  selected.sort((a, b) => a.resultId.localeCompare(b.resultId))
  return { valid: findings.length === 0, findings, selected }

  function add(code: string, ref: string): void { findings.push({ code, ref }) }
}

export function createPersistedAttemptVerdictDependencies(
  audit: ReturnType<typeof auditPersistedAttemptFacts>, manual?: VerdictDependencies['verifyManualResult'],
): VerdictDependencies {
  const selected = new Map(audit.selected.map((item) => [item.resultId, item]))
  return {
    ...(manual ? { verifyManualResult: manual } : {}),
    verifyAttemptSelection: ({ caseResult }) => {
      const expected = selected.get(caseResult.resultId)
      return audit.valid && expected !== undefined && caseResult.attemptSelection.status === 'valid'
        && caseResult.attemptSelection.attemptId === expected.attemptId
        && caseResult.attemptSelection.eventChainDigest === expected.eventChainDigest
    },
  }
}

function attemptMode(attemptCase: PersistedAttemptCase): ExecutionMode | '' {
  const started = attemptCase.events.find((event) => event.kind === 'started')
  return started?.mode ?? ''
}
function domainKey(caseId: string, mode: string): string { return `${caseId}\0${mode}` }

function chainAt(initial: string, events: PersistedAttemptCase['events'], sequence: number): string {
  let digest = initial
  for (const event of events.slice(0, sequence)) {
    digest = digestText('attempt-event-chain/v1', canonicalizeJson({ previous: digest, event: event.eventDigest }))
  }
  return digest
}
function object(value: unknown): Record<string, any> { return typeof value === 'object' && value !== null ? value as Record<string, any> : {} }
function array(value: unknown): any[] { return Array.isArray(value) ? value : [] }
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function number(value: unknown): number { return typeof value === 'number' ? value : -1 }
