import {
  E2EError,
  canonicalizeJson,
  digestText,
  type CapabilityReservation,
  type GrantDecision,
  type InjectionCapability,
  type InjectionGatewayAuditSummary,
  type InjectionGatewayDecision,
  type ReadIntent,
  type SignedInjectionGrant,
} from '@mutil-skills/e2e-contracts'
import { ReadOnlyGateway, canonicalizeHttpRequest } from './read-policy.js'
import {
  matchPayload,
  requestMatchesMetadata,
  type RawWriteHttpRequest,
} from './write-policy.js'

export interface InjectionAuthorityClient {
  verify(grant: SignedInjectionGrant): Promise<GrantDecision>
  reserveForSubject(input: {
    grant: SignedInjectionGrant; currentSubject: SignedInjectionGrant['subject']
    capabilityId: string; actionId: string; attemptId: string
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<void>
  markUnknown(reservationId: string, observation: string): Promise<void>
}

export class InjectionGateway {
  readonly #grant: SignedInjectionGrant
  readonly #attemptId: string
  readonly #authority: InjectionAuthorityClient
  readonly #bootstrap: ReadOnlyGateway
  readonly #caseReads: ReadOnlyGateway
  readonly #capabilities: InjectionCapability[]
  readonly #matches = new Map<string, number>()
  readonly #completedReservations: CapabilityReservation[] = []
  readonly #audit: InjectionGatewayAuditSummary = {
    source: 'egress-gateway', received: 0, matched: 0, forwarded: 0, blocked: 0,
    bootstrapForwarded: 0, injectionTargetForwarded: 0, byIntent: {},
  }
  #stage: 'bootstrap' | 'case'
  #capabilityIndex = 0

  constructor(input: {
    stage: 'bootstrap' | 'case'
    grant: SignedInjectionGrant
    attemptId: string
    authority: InjectionAuthorityClient
    bootstrapIntents: ReadIntent[]
    caseReadIntents: ReadIntent[]
  }) {
    const capabilities = [...input.grant.capabilities].sort((left, right) => left.expectedOrder - right.expectedOrder)
    if (
      capabilities.length === 0
      || capabilities.some((item, index) => item.expectedOrder !== index + 1 || item.expectedMatches < 1)
    ) {
      throw injectionError('E2E_GATEWAY_INJECTION_SEQUENCE_INVALID', '注入 capability 必须从 1 开始连续排序且匹配次数为正数')
    }
    this.#stage = input.stage
    this.#grant = input.grant
    this.#attemptId = input.attemptId
    this.#authority = input.authority
    this.#capabilities = capabilities
    this.#bootstrap = new ReadOnlyGateway({ stage: 'bootstrap', intents: input.bootstrapIntents })
    this.#caseReads = new ReadOnlyGateway({ stage: 'case', intents: input.caseReadIntents })
  }

  switchToCaseStage(): void {
    this.#stage = 'case'
  }

  async decide(raw: RawWriteHttpRequest): Promise<InjectionGatewayDecision> {
    this.#audit.received += 1
    if (this.#stage === 'bootstrap') return this.decideRead(this.#bootstrap, raw, true)

    let request
    try {
      request = canonicalizeHttpRequest(raw)
    } catch (error) {
      return this.block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_REQUEST_INVALID', String(error))
    }

    const expected = this.#capabilities[this.#capabilityIndex]
    const metadataMatch = this.#capabilities.find((item) => requestMatchesMetadata(item.request, request))
    if (!expected) {
      if (metadataMatch) return this.block('E2E_GATEWAY_INJECTION_MATCHES_EXCEEDED', '注入匹配次数已耗尽', request)
      return this.decideRead(this.#caseReads, raw, false)
    }
    if (metadataMatch && metadataMatch.capabilityId !== expected.capabilityId) {
      return this.block('E2E_GATEWAY_INJECTION_OUT_OF_ORDER', '注入请求顺序与签名 capability 不一致', request)
    }
    if (!requestMatchesMetadata(expected.request, request)) {
      return this.decideRead(this.#caseReads, raw, false)
    }
    const payloadDecision = matchPayload(expected.request.payload, raw)
    if (!payloadDecision.allowed) return this.block(payloadDecision.code, payloadDecision.reason, request)

    try {
      const grantDecision = await this.#authority.verify(this.#grant)
      if (!grantDecision.allowed) return this.block(grantDecision.code, grantDecision.reason, request)
      const reservation = await this.#authority.reserveForSubject({
        grant: this.#grant, currentSubject: this.#grant.subject,
        capabilityId: expected.capabilityId,
        actionId: expected.actionId,
        attemptId: `${this.#attemptId}:${this.#audit.matched + 1}`,
      })
      const outcomeDigest = digestText('injection-outcome/v1', canonicalizeJson({
        capabilityId: expected.capabilityId,
        request: expected.request,
        response: expected.response,
      }))
      await this.#authority.complete(reservation.reservationId, outcomeDigest)
      this.#completedReservations.push({ ...reservation, status: 'completed', outcomeDigest })
    } catch (error) {
      return this.block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_AUTHORITY_FAILURE', String(error), request)
    }

    const count = (this.#matches.get(expected.capabilityId) ?? 0) + 1
    this.#matches.set(expected.capabilityId, count)
    if (count >= expected.expectedMatches) this.#capabilityIndex += 1
    this.#audit.matched += 1
    this.#audit.byIntent[expected.request.intentId] = (this.#audit.byIntent[expected.request.intentId] ?? 0) + 1
    return {
      decision: 'inject', source: 'egress-gateway', capabilityId: expected.capabilityId,
      intentId: expected.request.intentId, request, response: copyResponse(expected.response),
    }
  }

  getAuditSummary(): InjectionGatewayAuditSummary {
    return { ...this.#audit, byIntent: { ...this.#audit.byIntent } }
  }

  getCompletedReservations(): CapabilityReservation[] {
    return this.#completedReservations.map((reservation) => ({ ...reservation }))
  }

  private decideRead(gateway: ReadOnlyGateway, raw: RawWriteHttpRequest, bootstrap: boolean): InjectionGatewayDecision {
    const decision = gateway.decide(raw)
    if (decision.decision === 'forward') {
      this.#audit.forwarded += 1
      if (bootstrap) this.#audit.bootstrapForwarded += 1
      this.#audit.byIntent[decision.intentId] = (this.#audit.byIntent[decision.intentId] ?? 0) + 1
      return decision
    }
    const code = bootstrap ? decision.code : 'E2E_GATEWAY_INJECTION_INTENT_NOT_FOUND'
    const reason = bootstrap ? decision.reason : '请求既不匹配注入 capability，也不匹配已批准 case read intent'
    return this.block(code, reason, decision.request)
  }

  private block(
    code: string,
    reason: string,
    request?: Extract<InjectionGatewayDecision, { decision: 'block' }>['request'],
  ): InjectionGatewayDecision {
    this.#audit.blocked += 1
    return { decision: 'block', code, reason, ...(request ? { request } : {}) }
  }
}

export function evaluateInjectionSafety(input: {
  audit: InjectionGatewayAuditSummary
  expectedMatches: number
}): { status: 'passed' | 'safety-blocked'; reasonCodes: string[] } {
  const reasons: string[] = []
  if (input.audit.source !== 'egress-gateway') reasons.push('E2E_INJECTION_SOURCE_UNTRUSTED')
  if (input.audit.received !== input.audit.matched + input.audit.blocked + input.audit.forwarded) {
    reasons.push('E2E_INJECTION_AUDIT_EQUATION_INVALID')
  }
  if (input.audit.matched !== input.expectedMatches) reasons.push('E2E_INJECTION_MATCH_COUNT_INVALID')
  if (input.audit.injectionTargetForwarded !== 0) reasons.push('E2E_INJECTION_TARGET_FORWARDED')
  if (input.audit.blocked !== 0) reasons.push('E2E_INJECTION_BLOCKED_REQUESTS_PRESENT')
  return { status: reasons.length === 0 ? 'passed' : 'safety-blocked', reasonCodes: reasons }
}

function copyResponse(response: InjectionCapability['response']): InjectionCapability['response'] {
  if (response.kind !== 'http-response') return { ...response, headers: [], body: { kind: 'no-body' } }
  return { ...response, headers: response.headers.map((header) => ({ ...header })), body: { ...response.body } }
}

function injectionError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
