import {
  ArtifactSchemaRegistry,
  ExecutionOutcomeBindingSchema,
  ExecutionOutcomeReceiptSchema,
  ExecutionOutcomeVerifierMaterialSchema,
  canonicalizeJson,
  digestExecutionOutcomeBinding,
  digestBytes,
  digestText,
  type ArtifactSignature,
  type CapabilityReservation,
  type CanonicalHttpRequest,
  type ExecutionOutcomeBinding,
  type ExecutionOutcomeReceipt,
  type ExecutionOutcomeVerifierMaterial,
} from '@mutil-skills/e2e-contracts'
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

export interface GatewayAuditRequestEvent {
  sequence: number
  actionId: string
  executionSessionId?: string
  decision: 'forwarded' | 'blocked' | 'injected'
  digest: string
}

export interface GatewayAuditCapabilityReservation {
  reservationId: string
  grantId: string
  capabilityId: string
  actionId: string
  attemptId: string
  attemptContext?: CapabilityReservation['attemptContext']
  status: CapabilityReservation['status']
  outcomeDigest?: string
  observation?: string
  reservedAt: string
  consumed: boolean
  digest: string
}

export interface GatewayPublicationAudit {
  gatewayInstance: { instanceId: string; version: string; publicKeyDigest: string }
  policyDigest: string
  signedCounters: {
    forwarded: number
    blocked: number
    injected: number
    digest: string
    signature: ArtifactSignature
  }
  requestEvents: GatewayAuditRequestEvent[]
  capabilityReservations: GatewayAuditCapabilityReservation[]
}

export interface GatewayAuditVerifierMaterial {
  issuer: string
  keyId: string
  gatewayInstance: GatewayPublicationAudit['gatewayInstance']
  publicKeySpki: string
}

export interface GatewayPublicationAuditRecorder {
  recordReadDecision(input: {
    actionId: string
    executionSessionId?: string
    decision: 'forwarded' | 'blocked'
    request: CanonicalHttpRequest | { method: string; url: string }
  }): void
  recordCapabilityReservation(input: { reservation: CapabilityReservation; consumed: boolean }): void
  finalize(): GatewayPublicationAudit
}

declare const trustedGatewayRecorderBrand: unique symbol
export type TrustedGatewayPublicationAuditRecorder = GatewayPublicationAuditRecorder & {
  readonly [trustedGatewayRecorderBrand]: true
}
const trustedGatewayRecorders = new WeakSet<object>()
const gatewayRecorderOwners = new WeakMap<object, LocalGatewayAuditSigner>()
const gatewayRecorderPolicyDigests = new WeakMap<object, string>()

export function isTrustedGatewayPublicationAuditRecorder(
  candidate: unknown,
): candidate is TrustedGatewayPublicationAuditRecorder {
  return typeof candidate === 'object' && candidate !== null && trustedGatewayRecorders.has(candidate)
}

export class LocalGatewayAuditSigner {
  readonly #issuer: string
  readonly #keyId: string
  readonly #privateKey: KeyObject
  readonly #publicKeySpki: Buffer
  readonly #gatewayInstance: GatewayPublicationAudit['gatewayInstance']

  private constructor(input: {
    issuer: string
    keyId: string
    instanceId: string
    version: string
  }, privateKey: KeyObject, publicKey: KeyObject) {
    this.#issuer = input.issuer
    this.#keyId = input.keyId
    this.#privateKey = privateKey
    this.#publicKeySpki = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))
    this.#gatewayInstance = Object.freeze({
      instanceId: input.instanceId,
      version: input.version,
      publicKeyDigest: digestBytes('gateway-public-key/v1', this.#publicKeySpki),
    })
  }

  static create(input: {
    issuer: string
    keyId: string
    instanceId: string
    version: string
  }): LocalGatewayAuditSigner {
    const snapshot = {
      issuer: snapshotText(input.issuer, 'issuer'),
      keyId: snapshotText(input.keyId, 'keyId'),
      instanceId: snapshotText(input.instanceId, 'instanceId'),
      version: snapshotText(input.version, 'version'),
    }
    validateIdentity(snapshot)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    return new LocalGatewayAuditSigner(snapshot, privateKey, publicKey)
  }

  createRecorder(policyDigest: string): TrustedGatewayPublicationAuditRecorder {
    const policyDigestSnapshot = snapshotText(policyDigest, 'policyDigest')
    validateDigest(policyDigestSnapshot, 'policyDigest')
    const recorder = new InMemoryGatewayPublicationAuditRecorder({
      gatewayInstance: { ...this.#gatewayInstance },
      policyDigest: policyDigestSnapshot,
      signCounters: (digest) => this.#signCounters(digest),
    })
    trustedGatewayRecorders.add(recorder)
    gatewayRecorderOwners.set(recorder, this)
    gatewayRecorderPolicyDigests.set(recorder, policyDigestSnapshot)
    return recorder as unknown as TrustedGatewayPublicationAuditRecorder
  }

  ownsRecorder(recorder: TrustedGatewayPublicationAuditRecorder): boolean {
    return gatewayRecorderOwners.get(recorder) === this
  }

  policyDigestFor(recorder: TrustedGatewayPublicationAuditRecorder): string | undefined {
    return this.ownsRecorder(recorder) ? gatewayRecorderPolicyDigests.get(recorder) : undefined
  }

  exportVerifierMaterial(): GatewayAuditVerifierMaterial {
    return {
      issuer: this.#issuer,
      keyId: this.#keyId,
      gatewayInstance: { ...this.#gatewayInstance },
      publicKeySpki: this.#publicKeySpki.toString('base64url'),
    }
  }

  issueExecutionOutcomeReceipt(binding: ExecutionOutcomeBinding): ExecutionOutcomeReceipt {
    const snapshot = ExecutionOutcomeBindingSchema.parse(binding)
    const signedDigest = digestExecutionOutcomeBinding(snapshot)
    const purpose = 'execution-outcome-receipt/v1' as const
    return ExecutionOutcomeReceiptSchema.parse({
      ...snapshot,
      issuer: this.#issuer,
      keyId: this.#keyId,
      purpose,
      algorithm: 'Ed25519',
      signedDigest,
      signature: sign(
        null,
        executionOutcomeSignaturePayload(purpose, this.#issuer, this.#keyId, signedDigest),
        this.#privateKey,
      ).toString('base64url'),
    })
  }

  exportExecutionOutcomeVerifierMaterial(): ExecutionOutcomeVerifierMaterial {
    return ExecutionOutcomeVerifierMaterialSchema.parse({
      schemaVersion: '1.0.0',
      issuer: this.#issuer,
      keyId: this.#keyId,
      purpose: 'execution-outcome-receipt/v1',
      algorithm: 'Ed25519',
      publicKeySpkiBase64: this.#publicKeySpki.toString('base64url'),
      publicKeyDigest: this.#gatewayInstance.publicKeyDigest,
    })
  }

  #signCounters(signedDigest: string): ArtifactSignature {
    return {
      issuer: this.#issuer,
      keyId: this.#keyId,
      algorithm: 'Ed25519',
      signedDigest,
      signature: sign(null, signaturePayload(this.#issuer, this.#keyId, signedDigest), this.#privateKey)
        .toString('base64url'),
    }
  }
}

export class LocalExecutionOutcomeVerifier {
  readonly #material: ExecutionOutcomeVerifierMaterial
  readonly #publicKey: KeyObject
  readonly #materialMatchesKey: boolean

  private constructor(
    material: ExecutionOutcomeVerifierMaterial,
    publicKey: KeyObject,
    publicKeyBytes: Buffer,
  ) {
    this.#material = { ...material }
    this.#publicKey = publicKey
    this.#materialMatchesKey = material.publicKeyDigest
      === digestBytes('gateway-public-key/v1', publicKeyBytes)
  }

  static create(material: ExecutionOutcomeVerifierMaterial): LocalExecutionOutcomeVerifier {
    const snapshot = ExecutionOutcomeVerifierMaterialSchema.parse(material)
    let publicKeyBytes: Buffer
    let publicKey: KeyObject
    try {
      publicKeyBytes = Buffer.from(snapshot.publicKeySpkiBase64, 'base64url')
      publicKey = createPublicKey({ key: publicKeyBytes, type: 'spki', format: 'der' })
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    } catch (cause) {
      throw new Error('ExecutionOutcome verifier publicKeySpkiBase64 is invalid', { cause })
    }
    return new LocalExecutionOutcomeVerifier(snapshot, publicKey, publicKeyBytes)
  }

  verifyReceipt(candidate: unknown, expectedBinding?: ExecutionOutcomeBinding): boolean {
    const parsed = ExecutionOutcomeReceiptSchema.safeParse(candidate)
    if (!parsed.success || !this.#materialMatchesKey) return false
    const receipt = parsed.data
    if (receipt.issuer !== this.#material.issuer
      || receipt.keyId !== this.#material.keyId
      || receipt.purpose !== this.#material.purpose
      || receipt.algorithm !== this.#material.algorithm) return false
    if (expectedBinding !== undefined) {
      const expected = ExecutionOutcomeBindingSchema.safeParse(expectedBinding)
      if (!expected.success
        || canonicalizeJson(executionOutcomeBindingOf(receipt)) !== canonicalizeJson(expected.data)) return false
    }
    try {
      const signatureBytes = Buffer.from(receipt.signature, 'base64url')
      if (signatureBytes.toString('base64url') !== receipt.signature) return false
      return verify(
        null,
        executionOutcomeSignaturePayload(
          receipt.purpose,
          receipt.issuer,
          receipt.keyId,
          receipt.signedDigest,
        ),
        this.#publicKey,
        signatureBytes,
      )
    } catch {
      return false
    }
  }
}

export class LocalGatewayAuditVerifier {
  readonly #issuer: string
  readonly #keyId: string
  readonly #gatewayInstance: GatewayPublicationAudit['gatewayInstance']
  readonly #publicKey: KeyObject
  readonly #materialMatchesInstance: boolean

  private constructor(material: GatewayAuditVerifierMaterial, publicKey: KeyObject, publicKeyBytes: Buffer) {
    this.#issuer = material.issuer
    this.#keyId = material.keyId
    this.#gatewayInstance = { ...material.gatewayInstance }
    this.#publicKey = publicKey
    this.#materialMatchesInstance = material.gatewayInstance.publicKeyDigest
      === digestBytes('gateway-public-key/v1', publicKeyBytes)
  }

  static create(material: GatewayAuditVerifierMaterial): LocalGatewayAuditVerifier {
    const snapshot = snapshotVerifierMaterial(material)
    validateIdentity({
      issuer: snapshot.issuer,
      keyId: snapshot.keyId,
      instanceId: snapshot.gatewayInstance.instanceId,
      version: snapshot.gatewayInstance.version,
    })
    validateDigest(snapshot.gatewayInstance.publicKeyDigest, 'publicKeyDigest')
    let publicKeyBytes: Buffer
    let publicKey: KeyObject
    try {
      publicKeyBytes = Buffer.from(snapshot.publicKeySpki, 'base64url')
      publicKey = createPublicKey({ key: publicKeyBytes, type: 'spki', format: 'der' })
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    } catch (cause) {
      throw new Error('Gateway verifier publicKeySpki is invalid', { cause })
    }
    return new LocalGatewayAuditVerifier(snapshot, publicKey, publicKeyBytes)
  }

  acceptsInstance(instance: GatewayPublicationAudit['gatewayInstance']): boolean {
    return this.#materialMatchesInstance
      && canonicalizeJson(instance) === canonicalizeJson(this.#gatewayInstance)
  }

  verifySignature(signature: ArtifactSignature): boolean {
    if (!this.#materialMatchesInstance
      || signature.issuer !== this.#issuer
      || signature.keyId !== this.#keyId
      || signature.algorithm !== 'Ed25519') return false
    try {
      return verify(
        null,
        signaturePayload(signature.issuer, signature.keyId, signature.signedDigest),
        this.#publicKey,
        Buffer.from(signature.signature, 'base64url'),
      )
    } catch {
      return false
    }
  }
}

class InMemoryGatewayPublicationAuditRecorder implements GatewayPublicationAuditRecorder {
  readonly #gatewayInstance: GatewayPublicationAudit['gatewayInstance']
  readonly #policyDigest: string
  readonly #signCounters: (digest: string) => ArtifactSignature
  readonly #requestEvents: GatewayAuditRequestEvent[] = []
  readonly #capabilityReservations: GatewayAuditCapabilityReservation[] = []
  readonly #reservationDigests = new Set<string>()
  #finalized = false

  constructor(input: {
    gatewayInstance: GatewayPublicationAudit['gatewayInstance']
    policyDigest: string
    signCounters: (digest: string) => ArtifactSignature
  }) {
    this.#gatewayInstance = { ...input.gatewayInstance }
    this.#policyDigest = input.policyDigest
    this.#signCounters = input.signCounters
  }

  recordReadDecision(input: {
    actionId: string
    executionSessionId?: string
    decision: 'forwarded' | 'blocked'
    request: CanonicalHttpRequest | { method: string; url: string }
  }): void {
    this.#assertOpen()
    const snapshot = snapshotRequest(input.request)
    const digest = digestText('gateway-canonical-request/v1', canonicalizeJson(snapshot))
    this.#requestEvents.push({
      sequence: this.#requestEvents.length,
      actionId: snapshotText(input.actionId, 'actionId'),
      ...(input.executionSessionId ? {
        executionSessionId: snapshotSessionId(input.executionSessionId),
      } : {}),
      decision: input.decision,
      digest,
    })
  }

  recordCapabilityReservation(input: { reservation: CapabilityReservation; consumed: boolean }): void {
    this.#assertOpen()
    const reservation = snapshotReservation(input.reservation)
    const consumed = input.consumed
    validateReservation(reservation, consumed)
    const digest = digestText('gateway-capability-reservation/v1', canonicalizeJson({ reservation, consumed }))
    if (this.#reservationDigests.has(digest)) throw new Error('Gateway audit reservation digest must be unique')
    this.#reservationDigests.add(digest)
    this.#capabilityReservations.push({
      reservationId: reservation.reservationId,
      grantId: reservation.grantId,
      capabilityId: reservation.capabilityId,
      actionId: reservation.actionId,
      attemptId: reservation.attemptId,
      ...(reservation.attemptContext ? { attemptContext: { ...reservation.attemptContext } } : {}),
      status: reservation.status,
      ...(reservation.outcomeDigest ? { outcomeDigest: reservation.outcomeDigest } : {}),
      ...(reservation.observation ? { observation: reservation.observation } : {}),
      reservedAt: reservation.reservedAt,
      consumed,
      digest,
    })
  }

  finalize(): GatewayPublicationAudit {
    this.#assertOpen()
    this.#finalized = true
    const requestEvents = this.#requestEvents.map((event) => ({ ...event }))
    const capabilityReservations = this.#capabilityReservations.map((reservation) => ({ ...reservation }))
    const counters = countDecisions(requestEvents)
    const unsigned = {
      gatewayInstance: { ...this.#gatewayInstance },
      policyDigest: this.#policyDigest,
      requestEvents,
      capabilityReservations,
    }
    const digest = countersDigest(unsigned)
    const candidate = {
      ...unsigned,
      signedCounters: { ...counters, digest, signature: this.#signCounters(digest) },
    }
    return ArtifactSchemaRegistry['gateway-audit'].shape.content.parse(candidate) as GatewayPublicationAudit
  }

  #assertOpen(): void {
    if (this.#finalized) throw new Error('Gateway publication audit recorder already finalized')
  }
}

export function verifyGatewayPublicationAudit(
  candidate: GatewayPublicationAudit,
  verifier: LocalGatewayAuditVerifier,
): boolean {
  const parsed = ArtifactSchemaRegistry['gateway-audit'].shape.content.safeParse(candidate)
  if (!parsed.success) return false
  const audit = parsed.data as GatewayPublicationAudit
  if (!verifier.acceptsInstance(audit.gatewayInstance)) return false
  if (audit.requestEvents.some((event, index) => event.sequence !== index)) return false
  if (new Set(audit.requestEvents.map((event) => event.sequence)).size !== audit.requestEvents.length) return false
  if (new Set(audit.capabilityReservations.map((item) => item.digest)).size
    !== audit.capabilityReservations.length) return false
  if (audit.capabilityReservations.some((item) => item.digest !== digestText(
    'gateway-capability-reservation/v1', canonicalizeJson({
      reservation: {
        reservationId: item.reservationId, grantId: item.grantId, capabilityId: item.capabilityId,
        actionId: item.actionId, attemptId: item.attemptId,
        ...(item.attemptContext ? { attemptContext: item.attemptContext } : {}),
        status: item.status, ...(item.outcomeDigest ? { outcomeDigest: item.outcomeDigest } : {}),
        ...(item.observation ? { observation: item.observation } : {}), reservedAt: item.reservedAt,
      }, consumed: item.consumed,
    }),
  ))) return false
  const counters = countDecisions(audit.requestEvents)
  if (audit.signedCounters.forwarded !== counters.forwarded
    || audit.signedCounters.blocked !== counters.blocked
    || audit.signedCounters.injected !== counters.injected) return false
  const expectedDigest = countersDigest(audit)
  return audit.signedCounters.digest === expectedDigest
    && audit.signedCounters.signature.signedDigest === expectedDigest
    && verifier.verifySignature(audit.signedCounters.signature)
}

function countDecisions(events: GatewayAuditRequestEvent[]): {
  forwarded: number; blocked: number; injected: number
} {
  return {
    forwarded: events.filter((event) => event.decision === 'forwarded').length,
    blocked: events.filter((event) => event.decision === 'blocked').length,
    injected: events.filter((event) => event.decision === 'injected').length,
  }
}

function countersDigest(input: Pick<
GatewayPublicationAudit, 'gatewayInstance' | 'policyDigest' | 'requestEvents' | 'capabilityReservations'
>): string {
  return digestText('gateway-audit-counters/v1', canonicalizeJson({
    gatewayInstance: input.gatewayInstance,
    policyDigest: input.policyDigest,
    ...countDecisions(input.requestEvents),
    requestEvents: input.requestEvents,
    capabilityReservations: input.capabilityReservations,
  }))
}

function snapshotRequest(request: CanonicalHttpRequest | { method: string; url: string }): CanonicalHttpRequest | {
  method: string; url: string
} {
  if ('origin' in request) {
    return {
      method: snapshotText(request.method, 'method'),
      origin: snapshotText(request.origin, 'origin'),
      path: snapshotText(request.path, 'path'),
      query: request.query.map(([name, value]) => [snapshotText(name, 'query name'), snapshotText(value, 'query value')]),
    }
  }
  return { method: snapshotText(request.method, 'method'), url: snapshotText(request.url, 'url') }
}

function snapshotReservation(reservation: CapabilityReservation): CapabilityReservation {
  const snapshot: CapabilityReservation = {
    reservationId: snapshotText(reservation.reservationId, 'reservationId'),
    grantId: snapshotText(reservation.grantId, 'grantId'),
    capabilityId: snapshotText(reservation.capabilityId, 'capabilityId'),
    actionId: snapshotText(reservation.actionId, 'actionId'),
    attemptId: snapshotText(reservation.attemptId, 'attemptId'),
    status: reservation.status,
    reservedAt: snapshotText(reservation.reservedAt, 'reservedAt'),
    ...(reservation.attemptContext ? { attemptContext: {
      assetId: snapshotText(reservation.attemptContext.assetId, 'attemptContext.assetId'),
      generationId: snapshotText(reservation.attemptContext.generationId, 'attemptContext.generationId'),
      prdRevision: snapshotText(reservation.attemptContext.prdRevision, 'attemptContext.prdRevision'),
      runId: snapshotText(reservation.attemptContext.runId, 'attemptContext.runId'),
      caseId: snapshotText(reservation.attemptContext.caseId, 'attemptContext.caseId'),
    } } : {}),
  }
  const observation = reservation.observation
  const outcomeDigest = reservation.outcomeDigest
  if (observation !== undefined) snapshot.observation = snapshotText(observation, 'observation')
  if (outcomeDigest !== undefined) snapshot.outcomeDigest = snapshotText(outcomeDigest, 'outcomeDigest')
  return snapshot
}

function validateReservation(reservation: CapabilityReservation, consumed: boolean): void {
  for (const [field, value] of [
    ['reservationId', reservation.reservationId],
    ['grantId', reservation.grantId],
    ['capabilityId', reservation.capabilityId],
    ['actionId', reservation.actionId],
    ['attemptId', reservation.attemptId],
  ] as const) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`Gateway reservation ${field} is invalid`)
  }
  if (!['reserved', 'completed', 'unknown'].includes(reservation.status)) {
    throw new Error('Gateway reservation status is invalid')
  }
  if (!isValidDateTime(reservation.reservedAt)) {
    throw new Error('Gateway reservation reservedAt is invalid')
  }
  if (reservation.status === 'completed') {
    if (!consumed || reservation.observation !== undefined || reservation.outcomeDigest === undefined) {
      throw new Error('Completed Gateway reservation requires only an outcome digest and consumed=true')
    }
    validateDigest(reservation.outcomeDigest, 'reservation outcomeDigest')
    return
  }
  if (consumed || reservation.outcomeDigest !== undefined) {
    throw new Error('Non-completed Gateway reservation cannot be consumed or have an outcome digest')
  }
  if (reservation.status === 'reserved' && reservation.observation !== undefined) {
    throw new Error('Reserved Gateway reservation cannot have an observation')
  }
  if (reservation.status === 'unknown' && reservation.observation === undefined) {
    throw new Error('Unknown Gateway reservation requires an observation')
  }
}

function isValidDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)
  return month >= 1 && month <= 12
    && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value))
}

function snapshotVerifierMaterial(material: GatewayAuditVerifierMaterial): GatewayAuditVerifierMaterial {
  return {
    issuer: snapshotText(material.issuer, 'issuer'),
    keyId: snapshotText(material.keyId, 'keyId'),
    gatewayInstance: {
      instanceId: snapshotText(material.gatewayInstance.instanceId, 'instanceId'),
      version: snapshotText(material.gatewayInstance.version, 'version'),
      publicKeyDigest: snapshotText(material.gatewayInstance.publicKeyDigest, 'publicKeyDigest'),
    },
    publicKeySpki: snapshotText(material.publicKeySpki, 'publicKeySpki'),
  }
}

function validateIdentity(input: {
  issuer: string; keyId: string; instanceId: string; version: string
}): void {
  if (!input.issuer || !input.keyId) throw new Error('Gateway signer issuer and keyId must be non-empty')
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.instanceId)) throw new Error('Gateway instanceId is invalid')
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error('Gateway version is invalid')
}

function validateDigest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Gateway ${field} is invalid`)
}

function snapshotText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Gateway ${field} is invalid`)
  return value
}

function snapshotSessionId(value: unknown): string {
  const sessionId = snapshotText(value, 'executionSessionId')
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
    throw new Error('Gateway executionSessionId is invalid')
  }
  return sessionId
}

function signaturePayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ issuer, keyId, algorithm: 'Ed25519', signedDigest }))
}

function executionOutcomeSignaturePayload(
  purpose: ExecutionOutcomeReceipt['purpose'],
  issuer: string,
  keyId: string,
  signedDigest: string,
): Buffer {
  return Buffer.from(canonicalizeJson({ purpose, issuer, keyId, algorithm: 'Ed25519', signedDigest }))
}

function executionOutcomeBindingOf(receipt: ExecutionOutcomeReceipt): ExecutionOutcomeBinding {
  const {
    issuer: _issuer,
    keyId: _keyId,
    purpose: _purpose,
    algorithm: _algorithm,
    signedDigest: _signedDigest,
    signature: _signature,
    ...binding
  } = receipt
  return ExecutionOutcomeBindingSchema.parse(binding)
}
