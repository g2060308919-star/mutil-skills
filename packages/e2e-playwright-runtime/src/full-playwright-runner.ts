import {
  CleanupPlanDefinitionSchema,
  AttemptExecutionContextSchema,
  ExecutionOutcomeBindingSchema,
  ExecutionOutcomeReceiptSchema,
  FullPlaywrightProgramSchema,
  OracleCheckpointResultSchema,
  canonicalizeJson,
  digestBytes,
  digestCleanupPlanDefinition,
  digestExecutionOutcomeBinding,
  digestOracleCheckpointValue,
  digestText,
  type ApprovalFreshnessReceipt,
  type BrowserLocalReversibleWriteCapability,
  type CleanupPlanDefinition,
  type ExecutionOutcomeBinding,
  type ExecutionOutcomeReceipt,
  type FullPlaywrightProgram,
  type OracleCheckpointResult,
  type GatewayAuditSummary,
  type SignedWriteGrant,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import {
  getTrustedExecutionClientBinding,
  isTrustedLeaseClient,
  isTrustedWriteApprovalClient,
  verifyTrustedApprovalFreshnessCurrent,
  type TrustedApprovalFreshnessClient,
  type TrustedLeaseClient,
  type TrustedWriteApprovalClient,
} from '@mutil-skills/e2e-authority'
import { validateFullPlaywrightFunctionBody } from './full-playwright-source-validation.js'
import { getWriteRuntimeSessionBinding, type TrustedWriteRuntimeSession } from './production-isolation.js'
import { auditTrustedRegressionSourceSet } from './trusted-source-audit.js'
import {
  getFullPlaywrightControlledSession,
  type FullPlaywrightControlledSessionBackend,
} from './full-playwright-session-internal.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const HostPromise = Promise
const HostPromiseRace = Promise.race.bind(Promise)
const HostSetTimeout = setTimeout
const HostClearTimeout = clearTimeout
const HostError = Error
const HostAggregateError = AggregateError
const HostAsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...parameters: string[]
) => (...values: unknown[]) => Promise<unknown>
const programDeadlines = new WeakSet<object>()
const cleanupDeadlines = new WeakSet<object>()
const pendingFinalizations = new WeakMap<object, Map<string, () => Promise<FullPlaywrightCaseResult>>>()

export interface FullPlaywrightBindings {
  page: unknown
  context: unknown
  browser: unknown
  request: unknown
  expect: unknown
  testInfo: unknown
  state: Record<string, unknown>
}

export type FullPlaywrightEvidenceStage = 'before' | 'checkpoint' | 'after' | 'cleanup'

export interface FullPlaywrightEvidenceSummary {
  evidenceId: string
  stage: FullPlaywrightEvidenceStage
  kind: 'screenshot' | 'dom' | 'url' | 'trace' | 'gateway-audit'
  byteLength: number
  digest: string
  references?: string[]
  checkpointId?: string
}

export interface FullPlaywrightGatewayObservation {
  executionSessionId: string
  policyDigest: string
  summary: GatewayAuditSummary
}

export interface FullPlaywrightGatewayResult extends FullPlaywrightGatewayObservation {
  auditDigest: string
}

export interface FullPlaywrightTerminalOutcomeInput {
  status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
  effectObservation: 'proven-not-applied' | 'applied' | 'unknown'
  runnerResultDigest: string
  cleanupPlanId: string
  cleanup: FullPlaywrightCleanupResult
  evidenceIds: string[]
  oracleCheckpoints: OracleCheckpointResult[]
  completedAt: string
}

export interface FullPlaywrightGatewayTerminalResult {
  outcome: ExecutionOutcomeReceipt
  authorityReceiptDigest: string
}

export interface FullPlaywrightCleanupResult {
  status: 'verified-clean' | 'failed' | 'unknown'
  resultDigest: string
  leaseReceiptDigest: string
}

export interface FullPlaywrightErrorSummary {
  present: true
  type: 'error' | 'undefined' | 'null' | 'value'
  name?: string
  message?: string
}

export interface FullPlaywrightCaseResult {
  caseId: string
  stepId: string
  actionId: string
  status: 'passed' | 'failed' | 'safety-blocked'
  effectObservation: 'proven-not-applied' | 'applied' | 'unknown'
  retryAllowed: boolean
  reasonCode?: string
  reservationId?: string
  evidence: FullPlaywrightEvidenceSummary[]
  oracleCheckpoints: OracleCheckpointResult[]
  cleanup?: FullPlaywrightCleanupResult
  primaryError?: FullPlaywrightErrorSummary
  cleanupError?: FullPlaywrightErrorSummary
  retireError?: FullPlaywrightErrorSummary
  resultDigest: string
  outcome?: ExecutionOutcomeReceipt
  finalization?: FullPlaywrightFinalizationResult
}

export interface FullPlaywrightFinalizationResult {
  state: 'completed' | 'unknown' | 'terminal-failed'
  terminalIntentDigest: string
  leaseReceiptDigest?: string
  outcomeReceiptDigest?: string
  authorityReceiptDigest?: string
  errors: FullPlaywrightErrorSummary[]
}

export interface ControlledFullPlaywrightSessionBinding {
  executionProfile: 'full-playwright'
  assetId: string
  generationId: string
  prdRevision: string
  runId: string
  caseId: string
  stepId: string
  actionId: string
  capabilityId: string
  programArtifactDigest: string
  programDigest: string
  cleanupProgramDigest: string
  cleanupPlanDigest: string
  leaseId: string
  fencingToken: number
  targetFingerprint: string
  approvedRequestSetDigest: string
  gatewayPolicyDigest: string
  executionSessionId: string
  sourceSetDigest: string
  programBrowserSessionId: string
  cleanupBrowserSessionId: string
}

export interface ControlledFullPlaywrightSession {}

export interface RunFullPlaywrightCaseInput {
  program: FullPlaywrightProgram
  cleanupPlan: CleanupPlanDefinition
  attemptId: string
  attemptContext: { assetId: string; generationId: string; prdRevision: string; runId: string; caseId: string }
  authorization: {
    grant: SignedWriteGrant
    currentSubject: WriteApprovalSubject
    freshnessReceipt: ApprovalFreshnessReceipt
    freshnessAuthority: TrustedApprovalFreshnessClient
    authority: TrustedWriteApprovalClient
  }
  lease: {
    leaseId: string
    fencingToken: number
    targetFingerprint: string
    authority: TrustedLeaseClient
  }
  runtime: TrustedWriteRuntimeSession
  session: ControlledFullPlaywrightSession
}

export async function runFullPlaywrightCase(input: RunFullPlaywrightCaseInput): Promise<FullPlaywrightCaseResult> {
  if (input.session && typeof input.session === 'object') {
    const pending = pendingFinalizations.get(input.session as object)?.get(input.attemptId)
    if (pending) return await pending()
  }
  const checked = await safetyPrecondition(input)
  if ('reasonCode' in checked) return blocked(input, checked.reasonCode)
  const { program, cleanupPlan, capability, session, grant, currentSubject } = checked
  let reservation
  try {
    reservation = await session.reserveCapability()
  } catch (error) {
    return blocked(input, errorCode(error, 'E2E_FULL_PLAYWRIGHT_RESERVATION_DENIED'))
  }
  if (reservation.status !== 'reserved' || reservation.grantId !== grant.grantId
    || reservation.capabilityId !== capability.capabilityId || reservation.actionId !== program.actionId
    || reservation.attemptId !== input.attemptId
    || reservation.attemptContext === undefined
    || canonicalizeJson(reservation.attemptContext) !== canonicalizeJson(input.attemptContext)) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, [],
      'full-playwright-reservation-owner-mismatch',
      new HostError('E2E_FULL_PLAYWRIGHT_RESERVATION_OWNER_MISMATCH'))
  }
  try {
    await session.checkpoint?.('reserved', immutableSnapshot({
      reservation, binding: session.binding, attemptContext: input.attemptContext,
    }))
  } catch (error) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, [],
      'pre-effect-checkpoint-failed', error)
  }

  const evidence: FullPlaywrightEvidenceSummary[] = []
  let primaryCaught = false
  let primaryError: unknown
  let programTimedOut = false
  let cleanupCaught = false
  let cleanupError: unknown
  let cleanupTimedOut = false
  let cleanupValue: unknown
  let retireCaught = false
  let retireError: unknown
  let programRetireAttempted = false
  let cleanupRetireAttempted = false
  let infrastructureError: unknown

  const recordRetireFailure = (error: unknown): void => {
    if (!retireCaught) { retireCaught = true; retireError = error }
    else retireError = new HostAggregateError([retireError, error], 'E2E_FULL_PLAYWRIGHT_RETIRE_FAILED')
  }
  const retireProgram = async (): Promise<void> => {
    if (programRetireAttempted) return
    programRetireAttempted = true
    try { await session.retireProgram() } catch (error) { recordRetireFailure(error) }
  }
  const retireCleanup = async (): Promise<void> => {
    if (cleanupRetireAttempted) return
    cleanupRetireAttempted = true
    try { await session.retireCleanup() } catch (error) { recordRetireFailure(error) }
  }

  try { evidence.push(...await captureChecked(session, 'before')) }
  catch (error) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, evidence,
      'before-evidence-failed', error)
  }

  const checkpointPlans = new Map(program.oracleCheckpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]))
  const oracleCheckpoints: OracleCheckpointResult[] = []
  const checkpoint = async (candidate: unknown): Promise<void> => {
    const input = checkpointInput(candidate)
    const plan = checkpointPlans.get(input.checkpointId)
    if (!plan || plan.oracleId !== input.oracleId
      || oracleCheckpoints.some((item) => item.checkpointId === input.checkpointId)) {
      throw new HostError('E2E_ORACLE_CHECKPOINT_BINDING_INVALID')
    }
    const actualJson = canonicalCheckpointJson(input.actual)
    const actualDigest = digestOracleCheckpointValue(actualJson)
    const captured = await captureCheckpointChecked(session, input.checkpointId)
    evidence.push(...captured)
    const result = OracleCheckpointResultSchema.parse({
      checkpointId: plan.checkpointId, oracleId: plan.oracleId,
      expectedJson: plan.expectedJson, actualJson,
      expectedDigest: plan.expectedDigest, actualDigest,
      status: plan.expectedDigest === actualDigest ? 'passed' : 'failed',
      evidenceIds: captured.map((item) => item.evidenceId),
    })
    oracleCheckpoints.push(result)
    if (result.status === 'failed') throw new HostError('E2E_ORACLE_CHECKPOINT_FAILED')
  }

  try {
    await withDeadline(
      () => executeSource(program.source, session.programBindings, checkpoint), program.timeoutMs, 'program',
    )
    if (oracleCheckpoints.length !== program.oracleCheckpoints.length) {
      throw new HostError('E2E_ORACLE_CHECKPOINT_MISSING')
    }
  } catch (error) {
    primaryCaught = true
    primaryError = error
    programTimedOut = isDeadline(error, 'program')
    if (programTimedOut) await retireProgram()
  }

  try { evidence.push(...await captureChecked(session, 'after')) }
  catch (error) {
    infrastructureError = error
    if (!primaryCaught) { primaryCaught = true; primaryError = error }
  }

  try {
    cleanupValue = await withDeadline(
      () => executeSource(program.cleanupSource, session.cleanupBindings), cleanupPlan.timeoutMs, 'cleanup',
    )
  } catch (error) {
    cleanupCaught = true
    cleanupError = error
    cleanupTimedOut = isDeadline(error, 'cleanup')
  }
  if (!cleanupCaught && cleanupValue !== 'verified-clean') {
    cleanupCaught = true
    cleanupError = new HostError('E2E_FULL_PLAYWRIGHT_CLEANUP_NOT_VERIFIED')
  }
  if (cleanupCaught) await retireCleanup()
  try { evidence.push(...await captureChecked(session, 'cleanup')) }
  catch (error) {
    infrastructureError ??= error
    if (!cleanupCaught) { cleanupCaught = true; cleanupError = error }
  }
  if (infrastructureError !== undefined) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, evidence,
      'evidence-capture-failed', infrastructureError)
  }

  // No browser operation is permitted after cleanup evidence. Retiring both independent
  // lifecycles here closes HTTPS CONNECT tunnels before Gateway freeze/publication; otherwise
  // a successful public-site run can leave the audit drain waiting on live browser sockets.
  await Promise.all([retireProgram(), retireCleanup()])

  let gateway: FullPlaywrightGatewayObservation
  try { gateway = await session.freezeGateway() }
  catch (error) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, evidence,
      'gateway-freeze-failed', error)
  }
  if (gateway.executionSessionId !== session.binding.executionSessionId
    || gateway.policyDigest !== session.binding.gatewayPolicyDigest
    || !validGatewayObservation(gateway)) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, evidence,
      'gateway-binding-invalid', new HostError('E2E_FULL_PLAYWRIGHT_GATEWAY_BINDING_MISMATCH'))
  }

  let observedEffect: ReturnType<FullPlaywrightControlledSessionBackend['observeEffect']>
  try { observedEffect = session.observeEffect() }
  catch (error) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, evidence,
      'effect-observation-failed', error)
  }
  const unknown = programTimedOut || cleanupCaught || retireCaught
    || gateway.summary.blocked > 0 || observedEffect === 'unknown'
  const effectObservation = unknown ? 'unknown' as const : observedEffect
  const status = !primaryCaught && !unknown && effectObservation === 'applied' ? 'passed' as const : 'failed' as const
  const cleanupStatus = cleanupCaught ? (cleanupTimedOut ? 'unknown' as const : 'failed' as const)
    : 'verified-clean' as const
  let evidenceIds: string[]
  try {
    assertCompleteEvidenceSet(evidence)
    evidenceIds = uniqueEvidenceIds([...evidence, gatewayEvidence(gateway,
      digestText('full-playwright-gateway-publication-pending/v1', gateway.executionSessionId))])
  } catch (error) {
    return await finalizeUnexpectedUnknown(input, session, reservation.reservationId, evidence,
      'evidence-set-invalid', error)
  }
  const evidenceSetDigest = digestText('execution-outcome-evidence-set/v1', canonicalizeJson([...evidenceIds].sort()))
  const cleanupResultDigest = digestText('full-playwright-cleanup-result/v1', canonicalizeJson({
    actionId: program.actionId, cleanupProgramDigest: program.cleanupSourceDigest,
    status: cleanupStatus, evidenceSetDigest,
  }))
  const runnerResultDigest = digestText('full-playwright-runner-result/v1', canonicalizeJson({
    caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
    reservationId: reservation.reservationId, status, effectObservation, cleanupStatus,
    gatewaySummaryDigest: digestText('full-playwright-gateway-summary/v1', canonicalizeJson(gateway)),
    evidenceSetDigest,
    oracleCheckpoints,
    primaryError: primaryCaught ? errorSummary(primaryError) : null,
    cleanupError: cleanupCaught ? errorSummary(cleanupError) : null,
    retireError: retireCaught ? errorSummary(retireError) : null,
  }))

  const terminalErrors: FullPlaywrightErrorSummary[] = []
  let leaseReceiptDigest: string | undefined
  let cleanup: FullPlaywrightCleanupResult | undefined
  let resultDigest = runnerResultDigest
  let terminalResult: FullPlaywrightGatewayTerminalResult | undefined
  let publishedGateway: FullPlaywrightGatewayResult | undefined
  const unknownObservation = unknown
    ? programTimedOut ? 'full-playwright-program-timeout-effect-unknown'
      : retireCaught ? 'full-playwright-browser-retire-failed-effect-unknown'
      : gateway.summary.blocked > 0 ? 'full-playwright-gateway-blocked-effect-unknown'
        : 'full-playwright-cleanup-unverified-effect-unknown'
    : undefined
  const settleLease = async (): Promise<string> => unknown
    ? await retryTerminal('quarantine', terminalErrors, () => session.terminal.quarantineLease({
      leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken,
      targetFingerprint: input.lease.targetFingerprint, reason: unknownObservation!,
    }))
    : await retryTerminal('release', terminalErrors, () => session.terminal.releaseLease({
      leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken,
      targetFingerprint: input.lease.targetFingerprint, cleanupDigest: cleanupResultDigest,
    }))
  const finish = async (): Promise<FullPlaywrightCaseResult> => {
    await session.checkpoint?.('lease-terminal-intent', immutableSnapshot({
      reservationId: reservation.reservationId, runnerResultDigest, cleanupResultDigest,
      cleanupStatus, unknown, unknownObservation: unknownObservation ?? null,
      lease: { leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken,
        targetFingerprint: input.lease.targetFingerprint }, gateway, evidence,
    }))
    leaseReceiptDigest ??= await settleLease()
    if (!DIGEST.test(leaseReceiptDigest)) throw new HostError('E2E_FULL_PLAYWRIGHT_LEASE_RECEIPT_INVALID')
    cleanup ??= { status: cleanupStatus, resultDigest: cleanupResultDigest, leaseReceiptDigest }
    const terminalInput: FullPlaywrightTerminalOutcomeInput = {
      status, effectObservation, runnerResultDigest, cleanupPlanId: cleanupPlan.cleanupPlanId,
      cleanup, evidenceIds, oracleCheckpoints, completedAt: new Date().toISOString(),
    }
    await session.checkpoint?.('write-terminal-intent', immutableSnapshot({
      reservationId: reservation.reservationId, terminalInput,
      observation: unknown ? `${unknownObservation}:${runnerResultDigest}` : null,
    }))
    terminalResult ??= unknown
      ? await retryTerminal('markUnknown', terminalErrors, () => session.terminal.markWriteUnknownWithOutcome(
        terminalInput, `${unknownObservation}:${runnerResultDigest}`))
      : await retryTerminal('complete', terminalErrors, () => session.terminal.finalizeWriteOutcome(terminalInput))
    const outcome = ExecutionOutcomeReceiptSchema.parse(terminalResult.outcome)
    const authorityReceiptDigest = terminalResult.authorityReceiptDigest
    if (!DIGEST.test(authorityReceiptDigest) || outcome.reservationId !== reservation.reservationId) {
      throw new HostError('E2E_FULL_PLAYWRIGHT_AUTHORITY_RECEIPT_INVALID')
    }
    await session.checkpoint?.('authority-terminal', immutableSnapshot({
      reservationId: reservation.reservationId, terminalInput, outcome, authorityReceiptDigest,
    }))
    resultDigest = outcome.signedDigest
    if (!publishedGateway) {
      const publication = await retryTerminal('publish', terminalErrors, () => session.publishGateway())
      publishedGateway = { ...gateway, auditDigest: publication.auditDigest }
      if (!validGatewayResult(publishedGateway)) throw new HostError('E2E_FULL_PLAYWRIGHT_GATEWAY_PUBLICATION_INVALID')
      evidence.push(gatewayEvidence(publishedGateway, publishedGateway.auditDigest))
    }
    await session.checkpoint?.('published', immutableSnapshot({
      reservationId: reservation.reservationId, terminalInput, outcome, authorityReceiptDigest,
      publishedGateway, evidence,
    }))
    pendingFinalizations.get(input.session as object)?.delete(input.attemptId)
    const finalization: FullPlaywrightFinalizationResult = {
      state: unknown ? 'unknown' : 'completed', terminalIntentDigest: runnerResultDigest,
      leaseReceiptDigest, outcomeReceiptDigest: outcome.signedDigest, authorityReceiptDigest,
      errors: terminalErrors,
    }
    return {
      caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
      status, effectObservation, retryAllowed: effectObservation === 'proven-not-applied',
      reservationId: reservation.reservationId, evidence, oracleCheckpoints, cleanup,
      ...(primaryCaught ? { primaryError: errorSummary(primaryError) } : {}),
      ...(cleanupCaught ? { cleanupError: errorSummary(cleanupError) } : {}),
      ...(retireCaught ? { retireError: errorSummary(retireError) } : {}),
      resultDigest, outcome, finalization,
    }
  }
  const recover = async (): Promise<FullPlaywrightCaseResult> => {
    try { return await finish() } catch (error) {
      terminalErrors.push(errorSummary(error))
      let attempts = pendingFinalizations.get(input.session as object)
      if (!attempts) { attempts = new Map(); pendingFinalizations.set(input.session as object, attempts) }
      attempts.set(input.attemptId, recover)
      return {
      caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
      status: 'failed', effectObservation: 'unknown', retryAllowed: false,
      reservationId: reservation.reservationId, evidence, oracleCheckpoints,
      ...(cleanup ? { cleanup } : {}), resultDigest,
      finalization: { state: 'terminal-failed', terminalIntentDigest: runnerResultDigest,
        ...(leaseReceiptDigest ? { leaseReceiptDigest } : {}), errors: terminalErrors },
      }
    }
  }
  return await recover()
}

async function safetyPrecondition(input: RunFullPlaywrightCaseInput): Promise<{
  program: FullPlaywrightProgram
  cleanupPlan: CleanupPlanDefinition
  capability: BrowserLocalReversibleWriteCapability
  session: FullPlaywrightControlledSessionBackend
  grant: SignedWriteGrant
  currentSubject: WriteApprovalSubject
} | { reasonCode: string }> {
  const parsedAttempt = AttemptExecutionContextSchema.safeParse(input.attemptContext)
  if (!parsedAttempt.success) return { reasonCode: 'E2E_FULL_PLAYWRIGHT_ATTEMPT_CONTEXT_INVALID' }
  const attempt = parsedAttempt.data
  const parsedProgram = FullPlaywrightProgramSchema.safeParse(input.program)
  const parsedPlan = CleanupPlanDefinitionSchema.safeParse(input.cleanupPlan)
  if (!parsedProgram.success) return { reasonCode: 'E2E_FULL_PLAYWRIGHT_PROGRAM_INVALID' }
  if (!parsedPlan.success || parsedPlan.data.schemaVersion !== '2.0.0') {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_CLEANUP_PLAN_INVALID' }
  }
  const program = parsedProgram.data
  const cleanupPlan = parsedPlan.data
  if (attempt.caseId !== program.caseId
    || attempt.prdRevision !== input.authorization.grant.subject.prdRevision
    || attempt.assetId !== input.authorization.grant.subject.assetId
    || attempt.runId !== input.authorization.grant.approvalContext.runId) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_ATTEMPT_CONTEXT_MISMATCH' }
  }
  const session = getFullPlaywrightControlledSession(input.session)
  if (!session) return { reasonCode: 'E2E_FULL_PLAYWRIGHT_CONTROLLED_SESSION_REQUIRED' }
  const runtime = getWriteRuntimeSessionBinding(input.runtime)
  if (!runtime || runtime.mode === 'test-only' || !runtime.sandboxHealthy || !runtime.gatewayConnected) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_TRUSTED_RUNTIME_REQUIRED' }
  }
  if (!isTrustedWriteApprovalClient(input.authorization.authority)
    || !isTrustedLeaseClient(input.lease.authority)) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_TRUSTED_AUTHORITY_REQUIRED' }
  }
  const grant = immutableSnapshot(input.authorization.grant)
  const currentSubject = immutableSnapshot(input.authorization.currentSubject)
  const capability = grant.capabilities.find((candidate): candidate is BrowserLocalReversibleWriteCapability =>
    candidate.actionId === program.actionId && candidate.transport === 'browser-local'
      && candidate.operation === 'full-playwright')
  if (!capability || grant.capabilities.filter((candidate) => candidate.actionId === program.actionId).length !== 1) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_CAPABILITY_REQUIRED' }
  }
  const subjectAction = currentSubject.actions.find((action) => action.actionId === program.actionId)
  if (!subjectAction || !('transport' in subjectAction) || subjectAction.transport !== 'browser-local') {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_SUBJECT_ACTION_REQUIRED' }
  }
  const sourceIssue = validateFullPlaywrightFunctionBody(program.source)
  const cleanupIssue = validateFullPlaywrightFunctionBody(program.cleanupSource)
  if (sourceIssue || cleanupIssue || !auditFragments(program).valid) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_HOST_SOURCE_AUDIT_DENIED' }
  }
  const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan)
  if (capability.programDigest !== program.sourceDigest
    || capability.cleanupProgramDigest !== program.cleanupSourceDigest
    || capability.dataLeaseId !== program.dataLeaseId
    || capability.dataLeaseId !== input.lease.leaseId
    || capability.fencingToken !== input.lease.fencingToken
    || capability.cleanupPlanDigest !== cleanupPlanDigest
    || cleanupPlan.cleanupProgramDigest !== program.cleanupSourceDigest
    || cleanupPlan.cleanupPlanId !== program.cleanupPlanId
    || cleanupPlan.actionId !== program.actionId
    || cleanupPlan.leaseId !== program.dataLeaseId
    || canonicalizeJson(capability.requests) !== canonicalizeJson(program.networkRequests)
    || canonicalizeJson(subjectAction.requests) !== canonicalizeJson(program.networkRequests)
    || subjectAction.programDigest !== program.sourceDigest
    || subjectAction.cleanupProgramDigest !== program.cleanupSourceDigest
    || subjectAction.cleanupPlanDigest !== cleanupPlanDigest) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_FROZEN_BINDING_MISMATCH' }
  }
  const binding = session.binding
  if (binding.executionProfile !== 'full-playwright' || binding.runId !== attempt.runId
    || binding.assetId !== attempt.assetId || binding.generationId !== attempt.generationId
    || binding.prdRevision !== attempt.prdRevision
    || binding.caseId !== program.caseId || binding.stepId !== program.stepId
    || binding.actionId !== program.actionId || binding.capabilityId !== capability.capabilityId
    || binding.programArtifactDigest !== fullPlaywrightProgramDigest(program)
    || binding.programDigest !== program.sourceDigest || binding.cleanupProgramDigest !== program.cleanupSourceDigest
    || binding.cleanupPlanDigest !== cleanupPlanDigest || binding.leaseId !== input.lease.leaseId
    || binding.fencingToken !== input.lease.fencingToken || binding.targetFingerprint !== input.lease.targetFingerprint
    || binding.approvedRequestSetDigest !== approvedRequestSetDigest(program.networkRequests)) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_SESSION_BINDING_MISMATCH' }
  }
  if (runtime.runId !== attempt.runId || runtime.sourceDigest !== binding.sourceSetDigest
    || runtime.assetId !== attempt.assetId || runtime.generationId !== attempt.generationId
    || runtime.prdRevision !== attempt.prdRevision) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_RUNTIME_BINDING_MISMATCH' }
  }
  const writeBinding = getTrustedExecutionClientBinding(input.authorization.authority)
  const leaseBinding = getTrustedExecutionClientBinding(input.lease.authority)
  if (!writeBinding || !leaseBinding || !writeBinding.approvalBinding || !leaseBinding.approvalBinding
    || writeBinding.transport !== runtime.authorityTransport || leaseBinding.transport !== runtime.authorityTransport
    || (runtime.authorityTransport === 'authenticated-rpc'
      && (writeBinding.transport !== 'authenticated-rpc' || leaseBinding.transport !== 'authenticated-rpc'
        || writeBinding.authorityPublicKeyDigest !== runtime.authorityRpcPublicKeyDigest
        || leaseBinding.authorityPublicKeyDigest !== runtime.authorityRpcPublicKeyDigest))) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_AUTHORITY_TRANSPORT_MISMATCH' }
  }
  const expectedApprovalBinding = { runId: grant.approvalContext.runId,
    installationDigest: grant.approvalContext.installationDigest,
    approvalType: grant.approvalContext.approvalType, subjectDigest: grant.approvalContext.subjectDigest }
  if (canonicalizeJson(writeBinding.approvalBinding) !== canonicalizeJson(expectedApprovalBinding)
    || canonicalizeJson(leaseBinding.approvalBinding) !== canonicalizeJson(expectedApprovalBinding)) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_APPROVAL_CONTEXT_MISMATCH' }
  }
  const freshness = immutableSnapshot(input.authorization.freshnessReceipt)
  if (!verifyTrustedApprovalFreshnessCurrent(input.authorization.freshnessAuthority, freshness)
    || freshness.grantType !== 'reversible-write' || freshness.grantId !== grant.grantId
    || freshness.subjectDigest !== grant.subjectDigest
    || canonicalizeJson(freshness.executionSubjectSnapshot) !== canonicalizeJson(currentSubject)
    || !freshness.capabilities.some((record) => record.capabilityId === capability.capabilityId
      && record.actionId === capability.actionId && record.operation === 'full-playwright')) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_APPROVAL_FRESHNESS_INVALID' }
  }
  try {
    const decision = await input.authorization.authority.verifyForSubject(grant, currentSubject)
    if (!decision.allowed) return { reasonCode: decision.code }
    if (!await input.lease.authority.verifyTarget(input.lease.leaseId,
      input.lease.fencingToken, input.lease.targetFingerprint)) {
      return { reasonCode: 'E2E_FULL_PLAYWRIGHT_ACTIVE_LEASE_REQUIRED' }
    }
  } catch (error) { return { reasonCode: errorCode(error, 'E2E_FULL_PLAYWRIGHT_PRECONDITION_FAILED') } }
  return { program, cleanupPlan, capability, session, grant, currentSubject }
}

function auditFragments(program: FullPlaywrightProgram) {
  return auditTrustedRegressionSourceSet([
    fragment(`${program.actionId}-source`, program.source, 'Run'),
    fragment(`${program.actionId}-cleanup`, program.cleanupSource, 'Cleanup'),
  ], 'full-playwright')
}

function fragment(relativePath: string, source: string, kind: 'Run' | 'Cleanup') {
  return { relativePath: `regression/fragments/${relativePath}.ts`, bytes: Buffer.from([
    "import { test, expect } from '@playwright/test'",
    "test('trusted fragment', async ({ page, context, browser, request }, testInfo) => {",
    '  const state = {} as Record<string, unknown>', `  const __biztest${kind}0 = async () => {`,
    '  const checkpoint = async (_input: { checkpointId: string; oracleId: string; actual: unknown }) => undefined',
    source, '  }', `  await __biztest${kind}0()`, '})', '',
  ].join('\n'), 'utf8') }
}

async function executeSource(source: string, bindings: FullPlaywrightBindings,
  checkpoint?: (input: unknown) => Promise<void>): Promise<unknown> {
  const run = new HostAsyncFunction('page', 'context', 'browser', 'request', 'expect', 'testInfo', 'state', 'checkpoint',
    `"use strict";\n${source}\n`)
  return await run(bindings.page, bindings.context, bindings.browser, bindings.request,
    bindings.expect, bindings.testInfo, bindings.state, checkpoint)
}

async function withDeadline(operation: () => Promise<unknown>, timeoutMs: number,
  kind: 'program' | 'cleanup'): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new HostPromise<never>((_resolve, reject) => {
    timer = HostSetTimeout(() => {
      const error = new HostError(kind === 'program'
        ? 'E2E_FULL_PLAYWRIGHT_PROGRAM_TIMEOUT_EFFECT_UNKNOWN_NO_RETRY'
        : 'E2E_FULL_PLAYWRIGHT_CLEANUP_TIMEOUT_EFFECT_UNKNOWN_NO_RETRY')
      ;(kind === 'program' ? programDeadlines : cleanupDeadlines).add(error)
      reject(error)
    }, timeoutMs)
  })
  try { return await HostPromiseRace([operation(), deadline]) }
  finally { if (timer !== undefined) HostClearTimeout(timer) }
}

function isDeadline(error: unknown, kind: 'program' | 'cleanup'): boolean {
  return typeof error === 'object' && error !== null
    && (kind === 'program' ? programDeadlines : cleanupDeadlines).has(error)
}

async function captureChecked(session: FullPlaywrightControlledSessionBackend, stage: FullPlaywrightEvidenceStage) {
  if (stage === 'checkpoint') throw new HostError('E2E_FULL_PLAYWRIGHT_CHECKPOINT_CAPTURE_PATH_REQUIRED')
  const evidence = await session.capture(stage)
  const requiredKinds = new Set(['screenshot', 'dom', 'url', 'trace'])
  if (!Array.isArray(evidence) || evidence.length === 0
    || evidence.some((item) => item.stage !== stage || !/^[A-Za-z0-9._:-]{1,256}$/.test(item.evidenceId)
      || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0)
    || [...requiredKinds].some((kind) => !evidence.some((item) => item.kind === kind))) {
    throw new HostError('E2E_FULL_PLAYWRIGHT_EVIDENCE_INVALID')
  }
  return immutableSnapshot(evidence)
}

async function captureCheckpointChecked(session: FullPlaywrightControlledSessionBackend, checkpointId: string) {
  const evidence = await session.captureCheckpoint(checkpointId)
  const requiredKinds = new Set(['screenshot', 'dom', 'url', 'trace'])
  if (!Array.isArray(evidence) || evidence.length === 0
    || evidence.some((item) => item.stage !== 'checkpoint' || item.checkpointId !== checkpointId
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(item.evidenceId)
      || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0)
    || [...requiredKinds].some((kind) => !evidence.some((item) => item.kind === kind))) {
    throw new HostError('E2E_ORACLE_CHECKPOINT_EVIDENCE_INVALID')
  }
  return immutableSnapshot(evidence)
}

function checkpointInput(value: unknown): { checkpointId: string; oracleId: string; actual: unknown } {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HostError('E2E_ORACLE_CHECKPOINT_INPUT_INVALID')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 3 || !['actual', 'checkpointId', 'oracleId'].every((key) => keys.includes(key))) {
    throw new HostError('E2E_ORACLE_CHECKPOINT_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)) {
    throw new HostError('E2E_ORACLE_CHECKPOINT_INPUT_INVALID')
  }
  const checkpointId = descriptors.checkpointId?.value
  const oracleId = descriptors.oracleId?.value
  if (typeof checkpointId !== 'string' || typeof oracleId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(checkpointId) || !/^[A-Za-z0-9._:-]{1,256}$/.test(oracleId)) {
    throw new HostError('E2E_ORACLE_CHECKPOINT_INPUT_INVALID')
  }
  return { checkpointId, oracleId, actual: descriptors.actual?.value }
}

function canonicalCheckpointJson(value: unknown): string {
  let result: string
  try { result = canonicalizeJson(value) } catch { throw new HostError('E2E_ORACLE_CHECKPOINT_VALUE_INVALID') }
  if (Buffer.byteLength(result, 'utf8') > 64 * 1024) throw new HostError('E2E_ORACLE_CHECKPOINT_VALUE_TOO_LARGE')
  return result
}

function gatewayEvidence(
  gateway: FullPlaywrightGatewayObservation,
  auditDigest: string,
): FullPlaywrightEvidenceSummary {
  const bytes = Buffer.from(canonicalizeJson({ executionSessionId: gateway.executionSessionId,
    policyDigest: gateway.policyDigest, summary: gateway.summary }), 'utf8')
  return { evidenceId: `GATEWAY-${gateway.executionSessionId}`, stage: 'cleanup', kind: 'gateway-audit',
    byteLength: bytes.byteLength, digest: auditDigest }
}

function approvedRequestSetDigest(requests: BrowserLocalReversibleWriteCapability['requests']): string {
  return digestText('execution-outcome-approved-request-set/v1', canonicalizeJson(requests))
}

function fullPlaywrightProgramDigest(program: FullPlaywrightProgram): string {
  return digestText('full-playwright-program/v1', canonicalizeJson(program))
}

function uniqueEvidenceIds(evidence: FullPlaywrightEvidenceSummary[]): string[] {
  const ids = evidence.map((item) => item.evidenceId)
  if (new Set(ids).size !== ids.length) throw new HostError('E2E_FULL_PLAYWRIGHT_EVIDENCE_ID_DUPLICATE')
  return ids
}

function immutableSnapshot<T>(value: T): T { return JSON.parse(canonicalizeJson(value)) as T }

function errorSummary(value: unknown): FullPlaywrightErrorSummary {
  if (value === undefined) return { present: true, type: 'undefined' }
  if (value === null) return { present: true, type: 'null' }
  if (value instanceof HostError) return { present: true, type: 'error', name: value.name, message: value.message }
  return { present: true, type: 'value' }
}

function errorText(error: unknown): string { return canonicalizeJson(errorSummary(error)) }

function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : fallback
}

function blocked(input: Pick<RunFullPlaywrightCaseInput, 'program'>, reasonCode: string): FullPlaywrightCaseResult {
  const core = { caseId: input.program.caseId, stepId: input.program.stepId,
    actionId: input.program.actionId, status: 'safety-blocked' as const,
    effectObservation: 'proven-not-applied' as const, retryAllowed: false, reasonCode,
    evidence: [], oracleCheckpoints: [] }
  return { ...core, resultDigest: digestText('full-playwright-runner-result/v1', canonicalizeJson(core)) }
}

async function retryTerminal<T>(stage: string, errors: FullPlaywrightErrorSummary[], operation: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await operation() }
    catch (error) { last = error; errors.push({ ...errorSummary(error), message: `${stage}:${errorText(error)}` }) }
  }
  throw last
}

async function finalizeUnexpectedUnknown(
  input: RunFullPlaywrightCaseInput,
  session: FullPlaywrightControlledSessionBackend,
  reservationId: string,
  evidence: FullPlaywrightEvidenceSummary[],
  observation: string,
  error: unknown,
): Promise<FullPlaywrightCaseResult> {
  const terminalIntentDigest = digestText('full-playwright-terminal-intent/v1', canonicalizeJson({
    reservationId, actionId: input.program.actionId, terminal: 'unknown', observation,
    error: errorSummary(error),
  }))
  const errors: FullPlaywrightErrorSummary[] = [errorSummary(error)]
  const reason = `${observation}:${terminalIntentDigest}`
  const [leaseResult, authorityResult] = await Promise.allSettled([
    retryTerminal('quarantine', errors, () => session.terminal.quarantineLease({
      leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken,
      targetFingerprint: input.lease.targetFingerprint, reason,
    })),
    retryTerminal('markUnknown', errors, () => session.terminal.markWriteUnknown(reason)),
  ])
  const leaseReceiptDigest = leaseResult.status === 'fulfilled' && DIGEST.test(leaseResult.value)
    ? leaseResult.value : undefined
  const authorityReceiptDigest = authorityResult.status === 'fulfilled' && DIGEST.test(authorityResult.value)
    ? authorityResult.value : undefined
  const publicationResult = authorityReceiptDigest
    ? await Promise.allSettled([retryTerminal('publish', errors, () => session.publishGateway())])
      .then(([result]) => result)
    : undefined
  const result = failedUnknown(input, reservationId, evidence, 'E2E_FULL_PLAYWRIGHT_POST_RESERVATION_FAILED', {
    primary: error,
  })
  return { ...result, finalization: {
    state: leaseReceiptDigest && authorityReceiptDigest && publicationResult?.status === 'fulfilled'
      ? 'unknown' : 'terminal-failed',
    terminalIntentDigest,
    ...(leaseReceiptDigest ? { leaseReceiptDigest } : {}),
    ...(authorityReceiptDigest ? { authorityReceiptDigest } : {}),
    errors,
  } }
}

function validGatewayResult(gateway: FullPlaywrightGatewayResult): boolean {
  return DIGEST.test(gateway.auditDigest) && validGatewayObservation(gateway)
}

function validGatewayObservation(gateway: FullPlaywrightGatewayObservation): boolean {
  const summary = gateway.summary
  return [summary.received, summary.forwarded, summary.blocked]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    && summary.received >= summary.forwarded + summary.blocked
    && summary.byIntent && typeof summary.byIntent === 'object'
    && Object.values(summary.byIntent).every((value) => Number.isSafeInteger(value) && value >= 0)
}

function assertCompleteEvidenceSet(evidence: FullPlaywrightEvidenceSummary[]): void {
  for (const stage of ['before', 'after', 'cleanup'] as const) {
    for (const kind of ['screenshot', 'dom', 'url', 'trace'] as const) {
      if (!evidence.some((item) => item.stage === stage && item.kind === kind)) {
        throw new HostError(`E2E_FULL_PLAYWRIGHT_EVIDENCE_MISSING:${stage}:${kind}`)
      }
    }
  }
}

function failedUnknown(input: RunFullPlaywrightCaseInput, reservationId: string,
  evidence: FullPlaywrightEvidenceSummary[], reasonCode: string,
  errors: { primary?: unknown; cleanup?: unknown; retire?: unknown }): FullPlaywrightCaseResult {
  const core = { caseId: input.program.caseId, stepId: input.program.stepId, actionId: input.program.actionId,
    status: 'failed' as const, effectObservation: 'unknown' as const, retryAllowed: false,
    reasonCode, reservationId, evidence, oracleCheckpoints: [],
    ...(Object.hasOwn(errors, 'primary') ? { primaryError: errorSummary(errors.primary) } : {}),
    ...(Object.hasOwn(errors, 'cleanup') ? { cleanupError: errorSummary(errors.cleanup) } : {}),
    ...(Object.hasOwn(errors, 'retire') ? { retireError: errorSummary(errors.retire) } : {}),
  }
  return { ...core, resultDigest: digestText('full-playwright-runner-result/v1', canonicalizeJson(core)) }
}
