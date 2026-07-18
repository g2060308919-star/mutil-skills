import {
  E2EError,
  canonicalizeJson,
  digestBytes,
  digestText,
  type CapabilityReservation,
  type DiscoveryApprovalSubject,
  type DiscoveryPreflightOutcome,
  type GatewayAuditSummary,
  type ReadApprovalSubject,
  type SignedDiscoveryGrant,
  type SignedReadGrant,
} from '@mutil-skills/e2e-contracts'

export interface ObservedPageIdentity {
  url: string
  title: string
  headings: string[]
  role?: string
  ariaSignals?: string[]
}

export interface BrowserPageAdapter {
  goto(url: string): Promise<void>
  identity(): Promise<ObservedPageIdentity>
  containsText(text: string): Promise<boolean>
  screenshot(): Promise<Uint8Array>
  domSnapshot(): Promise<string>
}

export interface DiscoveryAuthorityClient {
  reserveForSubject(input: {
    grant: SignedDiscoveryGrant
    currentSubject: DiscoveryApprovalSubject
    capabilityId: string
    actionId: string
    attemptId: string
  }): Promise<CapabilityReservation>
  completeDiscoveryPreflight(input: {
    grant: SignedDiscoveryGrant
    currentSubject: DiscoveryApprovalSubject
    reservationId: string
    capabilityId: string
    outcome: DiscoveryPreflightOutcome
  }): Promise<string>
}

export interface BrowserPreflightResult {
  status: 'ready' | 'input-blocked' | 'environment-blocked' | 'safety-blocked'
  reasonCode?: string
  observedIdentity?: ObservedPageIdentity
  reservationId?: string
  preflightDigest?: string
}

export async function runBrowserPreflight(input: {
  authorization: {
    grant: SignedDiscoveryGrant
    currentSubject: DiscoveryApprovalSubject
    authority: DiscoveryAuthorityClient
  }
  runtime: { sandboxHealthy: boolean; gatewayConnected: boolean }
  gatewayAudit: GatewayAuditSummary | (() => GatewayAuditSummary)
  page: BrowserPageAdapter
  actionId: string
  attemptId: string
}): Promise<BrowserPreflightResult> {
  if (!input.runtime.sandboxHealthy) return { status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_SANDBOX_REQUIRED' }
  if (!input.runtime.gatewayConnected) return { status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_GATEWAY_REQUIRED' }
  const grant = immutableJsonSnapshot<SignedDiscoveryGrant>(input.authorization.grant)
  const currentSubject = immutableJsonSnapshot<DiscoveryApprovalSubject>(input.authorization.currentSubject)
  const identityDigest = digestText(
    'expected-page-identity/v1', canonicalizeJson(currentSubject.expectedPageIdentity),
  )
  const capability = grant.capabilities.find((candidate) =>
    candidate.actionId === input.actionId
    && candidate.operation === 'local-navigation'
    && canonicalPageUrl(candidate.targetUrl) === canonicalPageUrl(currentSubject.expectedPageIdentity.url)
    && candidate.actor === currentSubject.actor
    && candidate.expectedPageIdentityDigest === identityDigest
    && candidate.bootstrapIntentsDigest === currentSubject.bootstrapIntentsDigest)
  if (!capability) return { status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_DISCOVERY_CAPABILITY_REQUIRED' }

  let reservation: CapabilityReservation
  try {
    reservation = await input.authorization.authority.reserveForSubject({
      grant,
      currentSubject,
      capabilityId: capability.capabilityId,
      actionId: input.actionId,
      attemptId: input.attemptId,
    })
  } catch (error) {
    return {
      status: 'safety-blocked',
      reasonCode: error instanceof E2EError ? error.code : 'E2E_RUNTIME_DISCOVERY_AUTHORIZATION_DENIED',
    }
  }

  let result: Omit<BrowserPreflightResult, 'reservationId' | 'preflightDigest'>
  try {
    await input.page.goto(currentSubject.expectedPageIdentity.url)
    const observedIdentity = await input.page.identity()
    const expected = currentSubject.expectedPageIdentity
    const gatewayAudit = typeof input.gatewayAudit === 'function' ? input.gatewayAudit() : input.gatewayAudit
    if (gatewayAudit.received <= 0 || gatewayAudit.forwarded <= 0) {
      result = { status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_GATEWAY_AUDIT_INCOMPLETE', observedIdentity }
    } else if (canonicalPageUrl(observedIdentity.url) !== canonicalPageUrl(expected.url)) {
      result = { status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_URL_MISMATCH', observedIdentity }
    } else if (observedIdentity.title !== expected.title || !observedIdentity.headings.includes(expected.heading)
      || expected.ariaSignals.some((signal) => !(observedIdentity.ariaSignals ?? []).includes(signal))) {
      result = { status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', observedIdentity }
    } else if (observedIdentity.role !== currentSubject.actor) {
      result = { status: 'input-blocked', reasonCode: 'E2E_RUNTIME_ROLE_MISMATCH', observedIdentity }
    } else result = { status: 'ready', observedIdentity }
  } catch {
    result = { status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_UNAVAILABLE' }
  }

  let preflightDigest: string
  try {
    preflightDigest = await input.authorization.authority.completeDiscoveryPreflight({
      grant, currentSubject, reservationId: reservation.reservationId,
      capabilityId: capability.capabilityId, outcome: result,
    })
  } catch {
    return {
      status: 'safety-blocked', reasonCode: 'E2E_RUNTIME_DISCOVERY_RESERVATION_FINALIZE_FAILED',
      reservationId: reservation.reservationId,
    }
  }
  return { ...result, reservationId: reservation.reservationId, preflightDigest }
}

export interface RunReadOnlyCaseInput {
  caseId: string
  actionId: string
  url: string
  expectedIdentity: { url?: string; title: string; heading: string; role?: string }
  expectedText: string
  authorization: {
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    authority: ReadAuthorityClient
  }
  attemptId: string
  runtime: { sandboxHealthy: boolean; gatewayConnected: boolean }
  gatewayAudit: GatewayAuditSummary | (() => GatewayAuditSummary)
  page: BrowserPageAdapter
}

export interface ReadAuthorityClient {
  reserveForSubject(input: {
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    capabilityId: string
    actionId: string
    attemptId: string
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<void>
  markUnknown(reservationId: string, observation: string): Promise<void>
}

export interface RuntimeEvidenceSummary {
  kind: 'screenshot' | 'dom' | 'gateway-audit'
  byteLength: number
  digest: string
}

export interface ReadOnlyCaseResult {
  caseId: string
  actionId: string
  status: 'passed' | 'failed' | 'input-blocked' | 'environment-blocked' | 'safety-blocked'
  reasonCode?: string
  expected: string[]
  actual: string[]
  observedIdentity?: ObservedPageIdentity
  evidence: RuntimeEvidenceSummary[]
  reservationIds?: string[]
  outcomeDigest?: string
}

export async function runReadOnlyCase(input: RunReadOnlyCaseInput): Promise<ReadOnlyCaseResult> {
  const blocked = safetyPrecondition(input)
  if (blocked) return baseResult(input, 'safety-blocked', blocked)

  const grant = immutableJsonSnapshot<SignedReadGrant>(input.authorization.grant)
  const currentSubject = immutableJsonSnapshot<ReadApprovalSubject>(input.authorization.currentSubject)
  const requiredOperations = ['local-navigation', 'dom-read', 'screenshot'] as const
  const capabilities = requiredOperations.map((operation) => grant.capabilities.find((candidate) =>
    candidate.actionId === input.actionId && candidate.operation === operation))
  if (capabilities.some((capability) => capability === undefined)) {
    return baseResult(input, 'safety-blocked', 'E2E_RUNTIME_READ_CAPABILITY_REQUIRED')
  }

  const reservations: CapabilityReservation[] = []
  try {
    for (const capability of capabilities) {
      reservations.push(await input.authorization.authority.reserveForSubject({
        grant, currentSubject, capabilityId: capability!.capabilityId,
        actionId: input.actionId, attemptId: input.attemptId,
      }))
    }
  } catch (error) {
    const reasonCode = error instanceof E2EError ? error.code : 'E2E_RUNTIME_READ_AUTHORIZATION_DENIED'
    if (reservations.length > 0) {
      const compensationDigest = digestText('read-reservation-compensation/v1', canonicalizeJson({
        caseId: input.caseId, actionId: input.actionId, attemptId: input.attemptId,
        reasonCode, reservationIds: reservations.map((reservation) => reservation.reservationId),
        executionStarted: false,
      }))
      const compensated = await Promise.allSettled(reservations.map(async (reservation) =>
        await input.authorization.authority.complete(reservation.reservationId, compensationDigest)))
      if (compensated.some((result) => result.status === 'rejected')) {
        const unresolved = reservations.filter((_reservation, index) => compensated[index]?.status === 'rejected')
        await Promise.allSettled(unresolved.map(async (reservation) =>
          await input.authorization.authority.markUnknown(
            reservation.reservationId, `reserve-compensation-failed:${compensationDigest}`,
          )))
        return {
          ...baseResult(input, 'safety-blocked', 'E2E_RUNTIME_READ_RESERVATION_COMPENSATION_FAILED'),
          reservationIds: reservations.map((reservation) => reservation.reservationId),
          outcomeDigest: compensationDigest,
        }
      }
    }
    return {
      ...baseResult(input, 'safety-blocked', reasonCode),
      ...(reservations.length === 0 ? {} : {
        reservationIds: reservations.map((reservation) => reservation.reservationId),
      }),
    }
  }

  let result: ReadOnlyCaseResult
  try {
    await input.page.goto(input.url)
    const observedIdentity = await input.page.identity()
    if (input.expectedIdentity.url !== undefined
      && canonicalPageUrl(observedIdentity.url) !== canonicalPageUrl(input.expectedIdentity.url)) {
      result = {
        ...baseResult(input, 'environment-blocked', 'E2E_RUNTIME_PAGE_URL_MISMATCH'),
        observedIdentity,
      }
    } else if (observedIdentity.title !== input.expectedIdentity.title || !observedIdentity.headings.includes(input.expectedIdentity.heading)) {
      result = {
        ...baseResult(input, 'environment-blocked', 'E2E_RUNTIME_PAGE_MISMATCH'),
        observedIdentity,
      }
    } else if (observedIdentity.role !== currentSubject.actor
      || (input.expectedIdentity.role !== undefined && observedIdentity.role !== input.expectedIdentity.role)) {
      result = {
        ...baseResult(input, 'input-blocked', 'E2E_RUNTIME_ROLE_MISMATCH'),
        observedIdentity,
      }
    } else {
      const matched = await input.page.containsText(input.expectedText)
      const screenshot = await input.page.screenshot()
      const dom = await input.page.domSnapshot()
      const gatewayAudit = typeof input.gatewayAudit === 'function' ? input.gatewayAudit() : input.gatewayAudit
      if (gatewayAudit.received <= 0 || gatewayAudit.forwarded <= 0) {
        result = {
          ...baseResult(input, 'safety-blocked', 'E2E_RUNTIME_GATEWAY_AUDIT_INCOMPLETE'),
          observedIdentity,
        }
      } else {
        const gatewayAuditText = canonicalizeJson(gatewayAudit)
        const evidence: RuntimeEvidenceSummary[] = [
          { kind: 'screenshot', byteLength: screenshot.byteLength,
            digest: digestBytes('runtime-evidence/screenshot/v1', screenshot) },
          { kind: 'dom', byteLength: Buffer.byteLength(dom, 'utf8'),
            digest: digestText('runtime-evidence/dom/v1', dom) },
          { kind: 'gateway-audit', byteLength: Buffer.byteLength(gatewayAuditText, 'utf8'),
            digest: digestText('runtime-evidence/gateway-audit/v1', gatewayAuditText) },
        ]
        result = {
          caseId: input.caseId,
          actionId: input.actionId,
          status: matched ? 'passed' : 'failed',
          expected: [`页面包含文本：${input.expectedText}`],
          actual: [matched ? `页面包含文本：${input.expectedText}` : `页面不包含文本：${input.expectedText}`],
          observedIdentity,
          evidence,
        }
      }
    }
  } catch (error) {
    result = error instanceof E2EError && error.code === 'E2E_RUNTIME_EVIDENCE_SIZE_LIMIT'
      ? baseResult(input, 'safety-blocked', error.code)
      : baseResult(input, 'environment-blocked', 'E2E_RUNTIME_PAGE_UNAVAILABLE')
  }

  const outcomeDigest = digestText('read-only-case-result/v1', canonicalizeJson(result))
  for (const [index, reservation] of reservations.entries()) {
    try {
      await input.authorization.authority.complete(reservation.reservationId, outcomeDigest)
    } catch {
      const unresolved = reservations.slice(index)
      const marked = await Promise.allSettled(unresolved.map(async (candidate) =>
        await input.authorization.authority.markUnknown(
          candidate.reservationId, `read-complete-failed:${outcomeDigest}`,
        )))
      return {
        ...baseResult(input, 'safety-blocked', marked.some((item) => item.status === 'rejected')
          ? 'E2E_RUNTIME_READ_RESERVATION_UNKNOWN_MARK_FAILED'
          : 'E2E_RUNTIME_READ_RESERVATION_FINALIZE_FAILED'),
        reservationIds: reservations.map((candidate) => candidate.reservationId),
        outcomeDigest,
      }
    }
  }
  return { ...result, reservationIds: reservations.map((reservation) => reservation.reservationId), outcomeDigest }
}

function canonicalPageUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return value
  }
}

function safetyPrecondition(input: RunReadOnlyCaseInput): string | undefined {
  if (!input.runtime.sandboxHealthy) return 'E2E_RUNTIME_SANDBOX_REQUIRED'
  if (!input.runtime.gatewayConnected) return 'E2E_RUNTIME_GATEWAY_REQUIRED'
  return undefined
}

function immutableJsonSnapshot<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T
}

function baseResult(
  input: RunReadOnlyCaseInput,
  status: ReadOnlyCaseResult['status'],
  reasonCode: string,
): ReadOnlyCaseResult {
  return {
    caseId: input.caseId,
    actionId: input.actionId,
    status,
    reasonCode,
    expected: [`页面包含文本：${input.expectedText}`],
    actual: [],
    evidence: [],
  }
}
