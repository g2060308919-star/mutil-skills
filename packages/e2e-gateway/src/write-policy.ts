import {
  E2EError,
  canonicalizeJson,
  digestBytes,
  digestText,
  type CapabilityReservation,
  type AttemptExecutionContext,
  type GatewayAuditSummary,
  type GatewayDecision,
  type GrantDecision,
  type HttpIntent,
  type ExecutionOutcomeReceipt,
  type ReversibleWriteCapability,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import { canonicalizeHttpRequest, type RawHttpRequest } from './read-policy.js'
import {
  isTrustedGatewayPublicationAuditRecorder,
  LocalGatewayAuditSigner,
  type TrustedGatewayPublicationAuditRecorder,
} from './publication-audit.js'

export interface RawWriteHttpRequest extends RawHttpRequest {
  body?: Uint8Array
  contentType?: string
}

export interface WriteAuthorityClient {
  verifyForSubject(grant: SignedWriteGrant, currentSubject: SignedWriteGrant['subject']): Promise<GrantDecision>
  reserveForSubject(input: {
    grant: SignedWriteGrant; currentSubject: SignedWriteGrant['subject']
    capabilityId: string; actionId: string; attemptId: string
    attemptContext?: AttemptExecutionContext
  }): Promise<CapabilityReservation>
  complete(reservationId: string, outcomeDigest: string): Promise<string>
  markUnknown(reservationId: string, observation: string): Promise<string>
}

export interface LeaseTargetVerifier {
  verifyTarget(leaseId: string, fencingToken: number, targetFingerprint: string): Promise<boolean>
}

export interface CompleteExecutionOutcomeInput {
  status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
  effectObservation: 'proven-not-applied' | 'applied' | 'unknown'
  runnerResultDigest: string
  cleanupPlanId: string
  cleanup: {
    status: 'verified-clean' | 'failed' | 'unknown'
    resultDigest: string
    leaseReceiptDigest: string
  }
  evidenceIds: string[]
  completedAt: string
}

export interface GatewayTerminalOutcome {
  outcome: ExecutionOutcomeReceipt
  authorityReceiptDigest: string
}

export function digestJsonHttpPayload(value: unknown): string {
  return digestText('http-json-payload/v1', canonicalizeJson(value))
}

export function digestBinaryHttpPayload(value: Uint8Array): string {
  return digestBytes('http-binary-payload/v1', value)
}

export class ReversibleWriteGateway {
  readonly #grant: SignedWriteGrant
  readonly #currentSubject: SignedWriteGrant['subject']
  readonly #capability: ReversibleWriteCapability
  readonly #attemptId: string
  readonly #attemptContext: AttemptExecutionContext
  readonly #executionSessionId: string
  readonly #authority: WriteAuthorityClient
  readonly #leaseAuthority: LeaseTargetVerifier
  readonly #recorder: TrustedGatewayPublicationAuditRecorder
  readonly #outcomeSigner?: LocalGatewayAuditSigner
  readonly #gatewayPolicyDigest?: string
  readonly #requests: ReversibleWriteCapability['requests']
  readonly #resolvedTemplatePayloadDigests: Readonly<Record<string, string>>
  readonly #uses = new Map<string, number>()
  readonly #audit: GatewayAuditSummary = { received: 0, forwarded: 0, blocked: 0, byIntent: {} }
  #requestIndex = 0
  #reservation?: CapabilityReservation
  #final = false

  constructor(input: {
    grant: SignedWriteGrant
    currentSubject: SignedWriteGrant['subject']
    capability: ReversibleWriteCapability
    attemptId: string
    attemptContext: AttemptExecutionContext
    authority: WriteAuthorityClient
    leaseAuthority: LeaseTargetVerifier
    recorder: TrustedGatewayPublicationAuditRecorder
    outcomeSigner?: LocalGatewayAuditSigner
    resolvedTemplatePayloadDigests?: Readonly<Record<string, string>>
  }) {
    if (!isTrustedGatewayPublicationAuditRecorder(input.recorder)) {
      throw gatewayError('E2E_GATEWAY_TRUSTED_AUDIT_RECORDER_REQUIRED', '可恢复写必须绑定 Gateway 签名发布审计 recorder')
    }
    if (input.attemptContext.runId !== input.grant.approvalContext.runId
      || input.grant.approvalContext.approvalType !== 'execution') {
      throw gatewayError('E2E_APPROVAL_CONTEXT_MISMATCH',
        'Gateway AttemptContext 与签名 Grant 的审批执行上下文不一致')
    }
    if (input.outcomeSigner && !input.outcomeSigner.ownsRecorder(input.recorder)) {
      throw gatewayError(
        'E2E_GATEWAY_OUTCOME_SIGNER_MISMATCH',
        'ExecutionOutcome 签发器与 Gateway 审计 recorder 不属于同一实例',
      )
    }
    const embedded = input.grant.capabilities.find((item) => item.capabilityId === input.capability.capabilityId)
    if (!embedded || canonicalizeJson(embedded) !== canonicalizeJson(input.capability)) {
      throw gatewayError('E2E_GATEWAY_CAPABILITY_NOT_IN_GRANT', 'Capability 与签名 Grant 不一致')
    }
    const requests = [...input.capability.requests].sort((left, right) => left.expectedOrder - right.expectedOrder)
    if (requests.length === 0 || requests.some((request, index) => request.expectedOrder !== index + 1 || request.maxRequests < 1)) {
      throw gatewayError('E2E_GATEWAY_REQUEST_SEQUENCE_INVALID', 'Capability 请求序列必须从 1 开始连续且请求次数为正数')
    }
    const templateIntentIds = requests.filter((request) => request.payload.kind === 'template')
      .map((request) => request.intentId).sort()
    const resolvedDigests = input.resolvedTemplatePayloadDigests ?? {}
    const resolvedIntentIds = Object.keys(resolvedDigests).sort()
    if (canonicalizeJson(templateIntentIds) !== canonicalizeJson(resolvedIntentIds)
      || Object.values(resolvedDigests).some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) {
      throw gatewayError(
        'E2E_GATEWAY_TEMPLATE_PAYLOAD_BINDING_INVALID',
        '所有且仅有 template intent 必须绑定运行时解析后的 payload 摘要',
      )
    }
    this.#grant = input.grant
    this.#currentSubject = structuredClone(input.currentSubject)
    this.#capability = input.capability
    this.#attemptId = input.attemptId
    this.#attemptContext = { ...input.attemptContext }
    this.#executionSessionId = digestText('gateway-write-execution-session/v1', canonicalizeJson({
      grantId: input.grant.grantId,
      capabilityId: input.capability.capabilityId,
      actionId: input.capability.actionId,
      attemptId: input.attemptId,
      attemptContext: input.attemptContext,
    }))
    this.#authority = input.authority
    this.#leaseAuthority = input.leaseAuthority
    this.#recorder = input.recorder
    this.#outcomeSigner = input.outcomeSigner
    this.#gatewayPolicyDigest = input.outcomeSigner?.policyDigestFor(input.recorder)
    this.#requests = requests
    this.#resolvedTemplatePayloadDigests = Object.freeze({ ...resolvedDigests })
  }

  /** Runtime pre-effect reservation; transport decisions reuse this exact reservation. */
  async reserve(): Promise<CapabilityReservation> {
    if (this.#final) throw gatewayError('E2E_GATEWAY_ACTION_FINAL', 'Action 已进入终态')
    if (this.#reservation) return { ...this.#reservation }
    const grantDecision = await this.#authority.verifyForSubject(this.#grant, this.#currentSubject)
    if (!grantDecision.allowed) throw gatewayError(grantDecision.code, grantDecision.reason)
    for (const targetFingerprint of new Set(this.#requests.map((request) => request.targetFingerprint))) {
      const targetAllowed = await this.#leaseAuthority.verifyTarget(
        this.#capability.dataLeaseId, this.#capability.fencingToken, targetFingerprint,
      )
      if (!targetAllowed) {
        throw gatewayError('E2E_GATEWAY_LEASE_TARGET_INVALID', 'Lease、fencing token 或目标指纹不再有效')
      }
    }
    return await this.#reserveAfterVerification()
  }

  async decide(raw: RawWriteHttpRequest): Promise<GatewayDecision> {
    this.#audit.received += 1
    if (this.#final) return this.block('E2E_GATEWAY_ACTION_FINAL', 'Action 已进入终态')

    let request
    try {
      request = canonicalizeHttpRequest(raw)
    } catch (error) {
      return this.block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_REQUEST_INVALID', String(error))
    }

    const expected = this.#requests[this.#requestIndex]
    if (!expected) return this.block('E2E_GATEWAY_REQUEST_SEQUENCE_EXHAUSTED', '已批准请求序列已耗尽', request)
    const matchingIntent = this.#requests.find((intent) => requestMatchesMetadata(intent, request))
    if (matchingIntent && matchingIntent.intentId !== expected.intentId) {
      return this.block('E2E_GATEWAY_REQUEST_OUT_OF_ORDER', '请求顺序与已批准序列不一致', request)
    }
    if (!requestMatchesMetadata(expected, request)) {
      return this.block('E2E_GATEWAY_INTENT_NOT_FOUND', '请求不匹配当前已批准 intent', request)
    }

    const payloadDecision = matchPayload(
      expected.payload,
      raw,
      expected.payload.kind === 'template'
        ? this.#resolvedTemplatePayloadDigests[expected.intentId]
        : undefined,
    )
    if (!payloadDecision.allowed) return this.block(payloadDecision.code, payloadDecision.reason, request)

    try {
      const grantDecision = await this.#authority.verifyForSubject(this.#grant, this.#currentSubject)
      if (!grantDecision.allowed) return this.block(grantDecision.code, grantDecision.reason, request)
      const targetAllowed = await this.#leaseAuthority.verifyTarget(
        this.#capability.dataLeaseId,
        this.#capability.fencingToken,
        expected.targetFingerprint,
      )
      if (!targetAllowed) return this.block('E2E_GATEWAY_LEASE_TARGET_INVALID', 'Lease、fencing token 或目标指纹不再有效', request)
      if (!this.#reservation) await this.#reserveAfterVerification()
    } catch (error) {
      return this.block(error instanceof E2EError ? error.code : 'E2E_GATEWAY_AUTHORITY_FAILURE', String(error), request)
    }

    const used = (this.#uses.get(expected.intentId) ?? 0) + 1
    this.#uses.set(expected.intentId, used)
    if (used >= expected.maxRequests) this.#requestIndex += 1
    this.#audit.forwarded += 1
    this.#audit.byIntent[expected.intentId] = (this.#audit.byIntent[expected.intentId] ?? 0) + 1
    this.#recorder.recordReadDecision({ actionId: this.#capability.actionId,
      executionSessionId: this.#executionSessionId, decision: 'forwarded', request })
    return { decision: 'forward', intentId: expected.intentId, request }
  }

  async complete(outcomeDigest: string): Promise<string> {
    if (this.#final) throw gatewayError('E2E_GATEWAY_ACTION_FINAL', 'Action 已进入终态')
    if (!this.#reservation) throw gatewayError('E2E_GATEWAY_RESERVATION_MISSING', 'Action 尚未产生 capability reservation')
    if (this.#requestIndex !== this.#requests.length) {
      throw gatewayError('E2E_GATEWAY_REQUEST_SEQUENCE_INCOMPLETE', '已批准请求序列尚未完整执行')
    }
    const authorityReceiptDigest = await this.#authority.complete(this.#reservation.reservationId, outcomeDigest)
    this.#recorder.recordCapabilityReservation({
      reservation: { ...this.#reservation, status: 'completed', outcomeDigest }, consumed: true,
    })
    this.#final = true
    return authorityReceiptDigest
  }

  async completeWithExecutionOutcome(input: CompleteExecutionOutcomeInput): Promise<ExecutionOutcomeReceipt> {
    return (await this.completeWithExecutionOutcomeResult(input)).outcome
  }

  async completeWithExecutionOutcomeResult(input: CompleteExecutionOutcomeInput): Promise<GatewayTerminalOutcome> {
    if (this.#final) throw gatewayError('E2E_GATEWAY_ACTION_FINAL', 'Action 已进入终态')
    if (!this.#reservation) throw gatewayError('E2E_GATEWAY_RESERVATION_MISSING', 'Action 尚未产生 capability reservation')
    if (this.#requestIndex !== this.#requests.length) {
      throw gatewayError('E2E_GATEWAY_REQUEST_SEQUENCE_INCOMPLETE', '已批准请求序列尚未完整执行')
    }
    if (!this.#outcomeSigner || !this.#gatewayPolicyDigest) {
      throw gatewayError('E2E_GATEWAY_OUTCOME_SIGNER_REQUIRED', '结构化 ExecutionOutcome 完成事务需要同实例签发器')
    }
    const receipt = this.#issueExecutionOutcome(input)
    const authorityReceiptDigest = await this.#authority.complete(this.#reservation.reservationId, receipt.signedDigest)
    if (!/^sha256:[a-f0-9]{64}$/.test(authorityReceiptDigest)) {
      throw gatewayError('E2E_GATEWAY_AUTHORITY_RECEIPT_INVALID', 'Authority terminal receipt 摘要无效')
    }
    this.#recorder.recordCapabilityReservation({
      reservation: {
        ...this.#reservation,
        status: 'completed',
        outcomeDigest: receipt.signedDigest,
      },
      consumed: true,
    })
    this.#final = true
    return { outcome: receipt, authorityReceiptDigest }
  }

  async markUnknown(observation: string): Promise<string> {
    if (this.#final) throw gatewayError('E2E_GATEWAY_ACTION_FINAL', 'Action 已进入终态')
    if (!this.#reservation) throw gatewayError('E2E_GATEWAY_RESERVATION_MISSING', 'Action 尚未产生 capability reservation')
    const authorityReceiptDigest = await this.#authority.markUnknown(this.#reservation.reservationId, observation)
    this.#recorder.recordCapabilityReservation({
      reservation: { ...this.#reservation, status: 'unknown', observation }, consumed: false,
    })
    this.#final = true
    return authorityReceiptDigest
  }

  async markUnknownWithExecutionOutcome(
    input: CompleteExecutionOutcomeInput,
    observation: string,
  ): Promise<GatewayTerminalOutcome> {
    if (this.#final) throw gatewayError('E2E_GATEWAY_ACTION_FINAL', 'Action 已进入终态')
    if (!this.#reservation) throw gatewayError('E2E_GATEWAY_RESERVATION_MISSING', 'Action 尚未产生 capability reservation')
    if (!this.#outcomeSigner || !this.#gatewayPolicyDigest) {
      throw gatewayError('E2E_GATEWAY_OUTCOME_SIGNER_REQUIRED', '结构化 ExecutionOutcome 需要同实例签发器')
    }
    const outcome = this.#issueExecutionOutcome(input)
    const authorityReceiptDigest = await this.#authority.markUnknown(this.#reservation.reservationId, observation)
    if (!/^sha256:[a-f0-9]{64}$/.test(authorityReceiptDigest)) {
      throw gatewayError('E2E_GATEWAY_AUTHORITY_RECEIPT_INVALID', 'Authority terminal receipt 摘要无效')
    }
    this.#recorder.recordCapabilityReservation({
      reservation: { ...this.#reservation, status: 'unknown', observation }, consumed: false,
    })
    this.#final = true
    return { outcome, authorityReceiptDigest }
  }

  #issueExecutionOutcome(input: CompleteExecutionOutcomeInput): ExecutionOutcomeReceipt {
    if (!this.#reservation || !this.#outcomeSigner || !this.#gatewayPolicyDigest) {
      throw gatewayError('E2E_GATEWAY_OUTCOME_SIGNER_REQUIRED', '结构化 ExecutionOutcome 需要 reservation 与同实例签发器')
    }
    const evidenceIds = [...input.evidenceIds]
    return this.#outcomeSigner.issueExecutionOutcomeReceipt({
      schemaVersion: '1.0.0',
      attemptContext: { ...this.#attemptContext },
      grantId: this.#grant.grantId,
      capabilityId: this.#capability.capabilityId,
      actionId: this.#capability.actionId,
      attemptId: this.#attemptId,
      reservationId: this.#reservation.reservationId,
      capability: structuredClone(this.#capability),
      effect: 'reversible-write',
      status: input.status,
      effectObservation: input.effectObservation,
      runnerResultDigest: input.runnerResultDigest,
      gateway: {
        executionSessionId: this.#executionSessionId,
        policyDigest: this.#gatewayPolicyDigest,
        approvedRequestSetDigest: digestText(
          'execution-outcome-approved-request-set/v1',
          canonicalizeJson(this.#requests),
        ),
        received: this.#audit.received,
        forwarded: this.#audit.forwarded,
        blocked: this.#audit.blocked,
      },
      cleanup: {
        cleanupPlanId: input.cleanupPlanId,
        cleanupPlanDigest: this.#capability.cleanupPlanDigest,
        leaseId: this.#capability.dataLeaseId,
        status: input.cleanup.status,
        resultDigest: input.cleanup.resultDigest,
        leaseReceiptDigest: input.cleanup.leaseReceiptDigest,
      },
      evidenceIds,
      evidenceSetDigest: digestText(
        'execution-outcome-evidence-set/v1',
        canonicalizeJson([...evidenceIds].sort()),
      ),
      completedAt: input.completedAt,
    })
  }

  getAuditSummary(): GatewayAuditSummary {
    return { ...this.#audit, byIntent: { ...this.#audit.byIntent } }
  }

  getReservation(): CapabilityReservation | undefined {
    return this.#reservation ? { ...this.#reservation } : undefined
  }

  /** Transport Host 用于避免在多步已批准请求序列完成前开放 outcome finalization。 */
  isRequestSequenceComplete(): boolean {
    return this.#requestIndex === this.#requests.length
  }

  async #reserveAfterVerification(): Promise<CapabilityReservation> {
    if (!this.#reservation) {
      this.#reservation = await this.#authority.reserveForSubject({
        grant: this.#grant, currentSubject: this.#currentSubject,
        capabilityId: this.#capability.capabilityId,
        actionId: this.#capability.actionId,
        attemptId: this.#attemptId,
        attemptContext: this.#attemptContext,
      })
    }
    return { ...this.#reservation }
  }

  private block(code: string, reason: string, request?: GatewayDecision extends { request?: infer T } ? T : never): GatewayDecision {
    this.#audit.blocked += 1
    if (request) this.#recorder.recordReadDecision({
      actionId: this.#capability.actionId, executionSessionId: this.#executionSessionId,
      decision: 'blocked', request,
    })
    return { decision: 'block', code, reason, ...(request ? { request } : {}) }
  }
}

export function requestMatchesMetadata(
  intent: HttpIntent,
  request: { method: string; origin: string; path: string; query: Array<[string, string]> },
): boolean {
  return intent.method.toUpperCase() === request.method
    && intent.canonicalOrigin === request.origin
    && intent.exactPath === request.path
    && canonicalizeJson(intent.query) === canonicalizeJson(request.query)
}

export function matchPayload(
  expected: HttpIntent['payload'],
  request: RawWriteHttpRequest,
  resolvedTemplatePayloadDigest?: string,
): { allowed: true } | { allowed: false; code: string; reason: string } {
  const body = request.body ?? new Uint8Array()
  if (expected.kind === 'no-body') {
    return body.byteLength === 0
      ? { allowed: true }
      : { allowed: false, code: 'E2E_GATEWAY_PAYLOAD_MISMATCH', reason: '该 intent 不允许请求体' }
  }
  let actualDigest: string
  if (expected.kind === 'json') {
    if (!request.contentType?.toLowerCase().startsWith('application/json')) {
      return { allowed: false, code: 'E2E_GATEWAY_CONTENT_TYPE_MISMATCH', reason: 'JSON intent 要求 application/json' }
    }
    try {
      actualDigest = digestJsonHttpPayload(JSON.parse(Buffer.from(body).toString('utf8')))
    } catch {
      return { allowed: false, code: 'E2E_GATEWAY_PAYLOAD_INVALID', reason: '请求体不是有效 JSON' }
    }
  } else {
    actualDigest = digestBinaryHttpPayload(body)
  }
  const expectedDigest = expected.kind === 'template' ? resolvedTemplatePayloadDigest : expected.digest
  return actualDigest === expectedDigest
    ? { allowed: true }
    : { allowed: false, code: 'E2E_GATEWAY_PAYLOAD_MISMATCH', reason: '请求体摘要与已批准 intent 不一致' }
}

function gatewayError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false })
}
