import {
  CleanupPlanDefinitionSchema,
  ExecutionOutcomeBindingSchema,
  ExecutionOutcomeReceiptSchema,
  FullPlaywrightProgramSchema,
  canonicalizeJson,
  digestBytes,
  digestCleanupPlanDefinition,
  digestExecutionOutcomeBinding,
  digestText,
  type ApprovalFreshnessReceipt,
  type BrowserLocalReversibleWriteCapability,
  type CleanupPlanDefinition,
  type ExecutionOutcomeBinding,
  type ExecutionOutcomeReceipt,
  type FullPlaywrightProgram,
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

export interface FullPlaywrightBindings {
  page: unknown
  context: unknown
  browser: unknown
  request: unknown
  expect: unknown
  testInfo: unknown
  state: Record<string, unknown>
}

export type FullPlaywrightEvidenceStage = 'before' | 'after' | 'cleanup'

export interface FullPlaywrightEvidenceSummary {
  evidenceId: string
  stage: FullPlaywrightEvidenceStage
  kind: 'screenshot' | 'dom' | 'url' | 'trace' | 'gateway-audit'
  byteLength: number
  digest: string
  references?: string[]
}

export interface FullPlaywrightGatewayResult {
  executionSessionId: string
  policyDigest: string
  summary: GatewayAuditSummary
  auditDigest: string
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
  cleanup?: FullPlaywrightCleanupResult
  primaryError?: FullPlaywrightErrorSummary
  cleanupError?: FullPlaywrightErrorSummary
  retireError?: FullPlaywrightErrorSummary
  resultDigest: string
  outcome?: ExecutionOutcomeReceipt
}

export interface FullPlaywrightLeaseTerminalAuthority {
  releaseForTarget(input: {
    leaseId: string; fencingToken: number; targetFingerprint: string; cleanupDigest: string
  }): Promise<string>
  quarantineForTarget(input: {
    leaseId: string; fencingToken: number; targetFingerprint: string; reason: string
  }): Promise<string>
}

interface ControlledSessionBackend {
  binding: ControlledFullPlaywrightSessionBinding
  programBindings: FullPlaywrightBindings
  cleanupBindings: FullPlaywrightBindings
  capture(stage: FullPlaywrightEvidenceStage): Promise<FullPlaywrightEvidenceSummary[]>
  retireProgram(): Promise<void>
  retireCleanup(): Promise<void>
  observeEffect(): 'proven-not-applied' | 'applied' | 'unknown'
  finalizeGateway(): Promise<FullPlaywrightGatewayResult>
  issueOutcome(binding: ExecutionOutcomeBinding): ExecutionOutcomeReceipt
}

export interface ControlledFullPlaywrightSessionBinding {
  executionProfile: 'full-playwright'
  runId: string
  caseId: string
  stepId: string
  actionId: string
  capabilityId: string
  programDigest: string
  cleanupProgramDigest: string
  cleanupPlanDigest: string
  leaseId: string
  fencingToken: number
  targetFingerprint: string
  approvedRequestSetDigest: string
  gatewayPolicyDigest: string
  executionSessionId: string
}

export interface ControlledFullPlaywrightSession {}
const controlledSessions = new WeakMap<object, ControlledSessionBackend>()

/** Test/Golden assembly seam. Production launcher wiring is intentionally Task 5. */
export function createTestControlledFullPlaywrightSession(
  backend: ControlledSessionBackend,
): ControlledFullPlaywrightSession {
  validateControlledBackend(backend)
  const session = Object.freeze({})
  controlledSessions.set(session, Object.freeze({
    binding: Object.freeze(structuredClone(backend.binding)),
    programBindings: backend.programBindings,
    cleanupBindings: backend.cleanupBindings,
    capture: backend.capture.bind(backend),
    retireProgram: backend.retireProgram.bind(backend),
    retireCleanup: backend.retireCleanup.bind(backend),
    observeEffect: backend.observeEffect.bind(backend),
    finalizeGateway: backend.finalizeGateway.bind(backend),
    issueOutcome: backend.issueOutcome.bind(backend),
  }))
  return session
}

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
    terminalAuthority: FullPlaywrightLeaseTerminalAuthority
  }
  runtime: TrustedWriteRuntimeSession
  session: ControlledFullPlaywrightSession
}

export async function runFullPlaywrightCase(input: RunFullPlaywrightCaseInput): Promise<FullPlaywrightCaseResult> {
  const checked = await safetyPrecondition(input)
  if ('reasonCode' in checked) return blocked(input, checked.reasonCode)
  const { program, cleanupPlan, capability, session, grant, currentSubject } = checked
  let reservation
  try {
    reservation = await input.authorization.authority.reserveForSubject({
      grant, currentSubject, capabilityId: capability.capabilityId, actionId: program.actionId,
      attemptId: input.attemptId, attemptContext: structuredClone(input.attemptContext),
    })
  } catch (error) {
    return blocked(input, errorCode(error, 'E2E_FULL_PLAYWRIGHT_RESERVATION_DENIED'))
  }
  if (reservation.status !== 'reserved' || reservation.grantId !== grant.grantId
    || reservation.capabilityId !== capability.capabilityId || reservation.actionId !== program.actionId
    || reservation.attemptId !== input.attemptId
    || reservation.attemptContext === undefined
    || canonicalizeJson(reservation.attemptContext) !== canonicalizeJson(input.attemptContext)) {
    try { await input.authorization.authority.markUnknown(reservation.reservationId,
      'full-playwright-reservation-owner-mismatch') } catch { /* fail closed below */ }
    return blocked(input, 'E2E_FULL_PLAYWRIGHT_RESERVATION_OWNER_MISMATCH')
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

  try { evidence.push(...await captureChecked(session, 'before')) }
  catch (error) {
    await unknownTerminal(input, reservation.reservationId, 'before-evidence-failed', error)
    return failedUnknown(input, reservation.reservationId, evidence, 'E2E_FULL_PLAYWRIGHT_EVIDENCE_FAILED', {
      primary: error,
    })
  }

  try {
    await withDeadline(() => executeSource(program.source, session.programBindings), program.timeoutMs, 'program')
  } catch (error) {
    primaryCaught = true
    primaryError = error
    programTimedOut = isDeadline(error, 'program')
    if (programTimedOut) {
      try { await session.retireProgram() } catch (retireFailure) { retireCaught = true; retireError = retireFailure }
    }
  }

  try { evidence.push(...await captureChecked(session, 'after')) }
  catch (error) {
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
  if (cleanupCaught) {
    try { await session.retireCleanup() } catch (error) {
      if (!retireCaught) { retireCaught = true; retireError = error }
      else retireError = new HostAggregateError([retireError, error], 'E2E_FULL_PLAYWRIGHT_RETIRE_FAILED')
    }
  }
  try { evidence.push(...await captureChecked(session, 'cleanup')) }
  catch (error) {
    if (!cleanupCaught) { cleanupCaught = true; cleanupError = error }
  }

  let gateway: FullPlaywrightGatewayResult
  try { gateway = await session.finalizeGateway() }
  catch (error) {
    cleanupError = cleanupCaught
      ? new HostAggregateError([cleanupError, error], 'E2E_FULL_PLAYWRIGHT_CLEANUP_AND_GATEWAY_FAILED') : error
    cleanupCaught = true
    gateway = emptyGateway(session.binding)
  }
  if (gateway.executionSessionId !== session.binding.executionSessionId
    || gateway.policyDigest !== session.binding.gatewayPolicyDigest
    || !DIGEST.test(gateway.auditDigest)) {
    const bindingError = new HostError('E2E_FULL_PLAYWRIGHT_GATEWAY_BINDING_MISMATCH')
    cleanupError = cleanupCaught
      ? new HostAggregateError([cleanupError, bindingError], 'E2E_FULL_PLAYWRIGHT_CLEANUP_AND_GATEWAY_FAILED')
      : bindingError
    cleanupCaught = true
    gateway = emptyGateway(session.binding)
  }
  evidence.push(gatewayEvidence(gateway))

  const observedEffect = session.observeEffect()
  const unknown = programTimedOut || cleanupCaught || gateway.summary.blocked > 0 || observedEffect === 'unknown'
  const effectObservation = unknown ? 'unknown' as const : observedEffect
  const status = !primaryCaught && !unknown && effectObservation === 'applied' ? 'passed' as const : 'failed' as const
  const cleanupStatus = cleanupCaught ? (cleanupTimedOut ? 'unknown' as const : 'failed' as const)
    : 'verified-clean' as const
  const evidenceIds = uniqueEvidenceIds(evidence)
  const evidenceSetDigest = digestText('execution-outcome-evidence-set/v1', canonicalizeJson([...evidenceIds].sort()))
  const cleanupResultDigest = digestText('full-playwright-cleanup-result/v1', canonicalizeJson({
    actionId: program.actionId, cleanupProgramDigest: program.cleanupSourceDigest,
    status: cleanupStatus, evidenceSetDigest,
  }))
  const runnerResultDigest = digestText('full-playwright-runner-result/v1', canonicalizeJson({
    caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
    reservationId: reservation.reservationId, status, effectObservation, cleanupStatus,
    gatewayAuditDigest: gateway.auditDigest, evidenceSetDigest,
    primaryError: primaryCaught ? errorSummary(primaryError) : null,
    cleanupError: cleanupCaught ? errorSummary(cleanupError) : null,
    retireError: retireCaught ? errorSummary(retireError) : null,
  }))

  let leaseReceiptDigest: string
  if (unknown) {
    const observation = programTimedOut ? 'full-playwright-program-timeout-effect-unknown'
      : gateway.summary.blocked > 0 ? 'full-playwright-gateway-blocked-effect-unknown'
        : 'full-playwright-cleanup-unverified-effect-unknown'
    try {
      await input.authorization.authority.markUnknown(reservation.reservationId, observation)
      leaseReceiptDigest = await input.lease.terminalAuthority.quarantineForTarget({
        leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken,
        targetFingerprint: input.lease.targetFingerprint, reason: observation,
      })
    } catch (terminalError) {
      leaseReceiptDigest = digestText('full-playwright-terminal-failure/v1', errorText(terminalError))
      if (!retireCaught) { retireCaught = true; retireError = terminalError }
    }
  } else {
    await input.authorization.authority.complete(reservation.reservationId, runnerResultDigest)
    leaseReceiptDigest = await input.lease.terminalAuthority.releaseForTarget({
      leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken,
      targetFingerprint: input.lease.targetFingerprint, cleanupDigest: cleanupResultDigest,
    })
  }

  const cleanup: FullPlaywrightCleanupResult = {
    status: cleanupStatus, resultDigest: cleanupResultDigest, leaseReceiptDigest,
  }
  const binding = ExecutionOutcomeBindingSchema.parse({
    schemaVersion: '1.0.0', attemptContext: input.attemptContext,
    grantId: grant.grantId, capabilityId: capability.capabilityId, actionId: program.actionId,
    attemptId: input.attemptId, reservationId: reservation.reservationId, capability,
    effect: 'reversible-write', status, effectObservation, runnerResultDigest,
    gateway: {
      executionSessionId: gateway.executionSessionId, policyDigest: gateway.policyDigest,
      approvedRequestSetDigest: approvedRequestSetDigest(capability.requests),
      received: gateway.summary.received, forwarded: gateway.summary.forwarded, blocked: gateway.summary.blocked,
    },
    cleanup: { cleanupPlanId: cleanupPlan.cleanupPlanId, cleanupPlanDigest: capability.cleanupPlanDigest,
      leaseId: capability.dataLeaseId, ...cleanup },
    evidenceIds, evidenceSetDigest, completedAt: new Date().toISOString(),
  } satisfies ExecutionOutcomeBinding)
  const outcome = ExecutionOutcomeReceiptSchema.parse(session.issueOutcome(binding))
  const resultDigest = digestExecutionOutcomeBinding(binding)
  return {
    caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
    status, effectObservation, retryAllowed: effectObservation === 'proven-not-applied',
    reservationId: reservation.reservationId, evidence, cleanup,
    ...(primaryCaught ? { primaryError: errorSummary(primaryError) } : {}),
    ...(cleanupCaught ? { cleanupError: errorSummary(cleanupError) } : {}),
    ...(retireCaught ? { retireError: errorSummary(retireError) } : {}),
    resultDigest, outcome,
  }
}

async function safetyPrecondition(input: RunFullPlaywrightCaseInput): Promise<{
  program: FullPlaywrightProgram
  cleanupPlan: CleanupPlanDefinition
  capability: BrowserLocalReversibleWriteCapability
  session: ControlledSessionBackend
  grant: SignedWriteGrant
  currentSubject: WriteApprovalSubject
} | { reasonCode: string }> {
  const parsedProgram = FullPlaywrightProgramSchema.safeParse(input.program)
  const parsedPlan = CleanupPlanDefinitionSchema.safeParse(input.cleanupPlan)
  if (!parsedProgram.success) return { reasonCode: 'E2E_FULL_PLAYWRIGHT_PROGRAM_INVALID' }
  if (!parsedPlan.success || parsedPlan.data.schemaVersion !== '2.0.0') {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_CLEANUP_PLAN_INVALID' }
  }
  const program = parsedProgram.data
  const cleanupPlan = parsedPlan.data
  if (input.attemptContext.caseId !== program.caseId
    || input.attemptContext.prdRevision !== input.authorization.grant.subject.prdRevision
    || input.attemptContext.assetId !== input.authorization.grant.subject.assetId
    || input.attemptContext.runId !== input.authorization.grant.approvalContext.runId) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_ATTEMPT_CONTEXT_MISMATCH' }
  }
  const session = input.session && typeof input.session === 'object'
    ? controlledSessions.get(input.session as object) : undefined
  if (!session) return { reasonCode: 'E2E_FULL_PLAYWRIGHT_CONTROLLED_SESSION_REQUIRED' }
  const runtime = getWriteRuntimeSessionBinding(input.runtime)
  if (!runtime || !runtime.sandboxHealthy || !runtime.gatewayConnected) {
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
  if (binding.executionProfile !== 'full-playwright' || binding.runId !== input.attemptContext.runId
    || binding.caseId !== program.caseId || binding.stepId !== program.stepId
    || binding.actionId !== program.actionId || binding.capabilityId !== capability.capabilityId
    || binding.programDigest !== program.sourceDigest || binding.cleanupProgramDigest !== program.cleanupSourceDigest
    || binding.cleanupPlanDigest !== cleanupPlanDigest || binding.leaseId !== input.lease.leaseId
    || binding.fencingToken !== input.lease.fencingToken || binding.targetFingerprint !== input.lease.targetFingerprint
    || binding.approvedRequestSetDigest !== approvedRequestSetDigest(program.networkRequests)) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_SESSION_BINDING_MISMATCH' }
  }
  if (runtime.mode === 'trusted-compiler'
    && (runtime.runId !== input.attemptContext.runId || runtime.sourceDigest !== program.sourceDigest)) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_RUNTIME_BINDING_MISMATCH' }
  }
  const writeBinding = getTrustedExecutionClientBinding(input.authorization.authority)
  const leaseBinding = getTrustedExecutionClientBinding(input.lease.authority)
  if (!writeBinding || !leaseBinding || writeBinding.transport !== runtime.authorityTransport
    || leaseBinding.transport !== runtime.authorityTransport) {
    return { reasonCode: 'E2E_FULL_PLAYWRIGHT_AUTHORITY_TRANSPORT_MISMATCH' }
  }
  if (writeBinding.approvalBinding
    && (writeBinding.approvalBinding.runId !== input.attemptContext.runId
      || writeBinding.approvalBinding.subjectDigest !== grant.subjectDigest)) {
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
    source, '  }', `  await __biztest${kind}0()`, '})', '',
  ].join('\n'), 'utf8') }
}

async function executeSource(source: string, bindings: FullPlaywrightBindings): Promise<unknown> {
  const run = new HostAsyncFunction('page', 'context', 'browser', 'request', 'expect', 'testInfo', 'state',
    `"use strict";\n${source}\n`)
  return await run(bindings.page, bindings.context, bindings.browser, bindings.request,
    bindings.expect, bindings.testInfo, bindings.state)
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

async function captureChecked(session: ControlledSessionBackend, stage: FullPlaywrightEvidenceStage) {
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

function gatewayEvidence(gateway: FullPlaywrightGatewayResult): FullPlaywrightEvidenceSummary {
  const bytes = Buffer.from(canonicalizeJson({ executionSessionId: gateway.executionSessionId,
    policyDigest: gateway.policyDigest, summary: gateway.summary }), 'utf8')
  return { evidenceId: `GATEWAY-${gateway.executionSessionId}`, stage: 'cleanup', kind: 'gateway-audit',
    byteLength: bytes.byteLength, digest: gateway.auditDigest }
}

function emptyGateway(binding: ControlledFullPlaywrightSessionBinding): FullPlaywrightGatewayResult {
  const summary = { received: 0, forwarded: 0, blocked: 1, byIntent: {} }
  return { executionSessionId: binding.executionSessionId, policyDigest: binding.gatewayPolicyDigest,
    summary, auditDigest: digestText('full-playwright-gateway-failure/v1', canonicalizeJson(summary)) }
}

function validateControlledBackend(backend: ControlledSessionBackend): void {
  if (!backend || typeof backend !== 'object' || backend.binding.executionProfile !== 'full-playwright'
    || backend.programBindings === backend.cleanupBindings
    || backend.programBindings.context === backend.cleanupBindings.context
    || backend.programBindings.page === backend.cleanupBindings.page
    || !['capture', 'retireProgram', 'retireCleanup', 'observeEffect', 'finalizeGateway', 'issueOutcome']
      .every((method) => typeof backend[method as keyof ControlledSessionBackend] === 'function')) {
    throw new HostError('E2E_FULL_PLAYWRIGHT_CONTROLLED_SESSION_INVALID')
  }
}

function approvedRequestSetDigest(requests: BrowserLocalReversibleWriteCapability['requests']): string {
  return digestText('execution-outcome-approved-request-set/v1', canonicalizeJson(requests))
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
    effectObservation: 'proven-not-applied' as const, retryAllowed: false, reasonCode, evidence: [] }
  return { ...core, resultDigest: digestText('full-playwright-runner-result/v1', canonicalizeJson(core)) }
}

async function unknownTerminal(input: RunFullPlaywrightCaseInput, reservationId: string,
  observation: string, error: unknown): Promise<void> {
  try { await input.authorization.authority.markUnknown(reservationId, observation) } catch { /* preserve original */ }
  try { await input.lease.terminalAuthority.quarantineForTarget({ leaseId: input.lease.leaseId,
    fencingToken: input.lease.fencingToken, targetFingerprint: input.lease.targetFingerprint,
    reason: `${observation}:${errorText(error)}`.slice(0, 16 * 1024) }) } catch { /* preserve original */ }
}

function failedUnknown(input: RunFullPlaywrightCaseInput, reservationId: string,
  evidence: FullPlaywrightEvidenceSummary[], reasonCode: string,
  errors: { primary?: unknown; cleanup?: unknown; retire?: unknown }): FullPlaywrightCaseResult {
  const core = { caseId: input.program.caseId, stepId: input.program.stepId, actionId: input.program.actionId,
    status: 'failed' as const, effectObservation: 'unknown' as const, retryAllowed: false,
    reasonCode, reservationId, evidence,
    ...(Object.hasOwn(errors, 'primary') ? { primaryError: errorSummary(errors.primary) } : {}),
    ...(Object.hasOwn(errors, 'cleanup') ? { cleanupError: errorSummary(errors.cleanup) } : {}),
    ...(Object.hasOwn(errors, 'retire') ? { retireError: errorSummary(errors.retire) } : {}),
  }
  return { ...core, resultDigest: digestText('full-playwright-runner-result/v1', canonicalizeJson(core)) }
}
