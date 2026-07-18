import type { AuthorityMaintenanceRpcClient } from '@mutil-skills/e2e-authority'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import type { CleanupExecutionResult } from '@mutil-skills/e2e-playwright-runtime'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface GatewayCleanupRequest {
  runId: string
  actionId: string
  cleanupPlanId: string
  cleanupPlanDigest: string
  outcomeDigest: string
  leaseId: string
  fencingToken: number
  targetFingerprint: string
}

export interface GatewayCleanupResponse {
  status: 'verified-clean' | 'failed' | 'unknown'
  resultDigest: string
}

type GatewayCleanupBackend = (request: GatewayCleanupRequest) => Promise<GatewayCleanupResponse>
declare const gatewayCleanupTransportBrand: unique symbol
export interface GatewayCleanupTransportCapability {
  readonly [gatewayCleanupTransportBrand]: true
}
const transports = new WeakMap<object, GatewayCleanupBackend>()

/** 只能由 Runtime 的 Gateway Bridge 装配层签发，项目测试代码不能传入裸 HTTP 直连函数。 */
export function authorizeGatewayCleanupTransport(
  backend: GatewayCleanupBackend,
): GatewayCleanupTransportCapability {
  if (typeof backend !== 'function') throw cleanupError('E2E_RUNTIME_GATEWAY_CLEANUP_TRANSPORT_INVALID')
  const capability = Object.freeze({}) as GatewayCleanupTransportCapability
  transports.set(capability, backend)
  return capability
}

export class GatewayCleanupTransport {
  readonly #backend: GatewayCleanupBackend
  readonly #authority: Pick<AuthorityMaintenanceRpcClient, 'releaseLease' | 'quarantineLease'>

  constructor(input: {
    gateway: GatewayCleanupTransportCapability
    authority: Pick<AuthorityMaintenanceRpcClient, 'releaseLease' | 'quarantineLease'>
  }) {
    const backend = transports.get(input.gateway)
    if (!backend || typeof input.authority?.releaseLease !== 'function'
      || typeof input.authority?.quarantineLease !== 'function') {
      throw cleanupError('E2E_RUNTIME_GATEWAY_CLEANUP_TRANSPORT_INVALID')
    }
    this.#backend = backend
    this.#authority = input.authority
  }

  async execute(candidate: GatewayCleanupRequest): Promise<CleanupExecutionResult> {
    const input = parseRequest(candidate)
    let response: GatewayCleanupResponse
    try {
      response = parseResponse(await this.#backend(structuredClone(input)))
    } catch (cause) {
      const resultDigest = digestText('runtime-gateway-cleanup-failure/v1', canonicalizeJson({
        cleanupPlanId: input.cleanupPlanId,
        code: errorCode(cause),
      }))
      const leaseReceiptDigest = await this.#authority.quarantineLease({
        leaseId: input.leaseId, fencingToken: input.fencingToken,
        targetFingerprint: input.targetFingerprint,
        reason: `cleanup:${input.cleanupPlanId}:gateway-failure:${errorCode(cause)}`,
      })
      requireDigest(leaseReceiptDigest)
      return { status: 'unknown', resultDigest, leaseReceiptDigest }
    }

    if (response.status === 'verified-clean') {
      const leaseReceiptDigest = await this.#authority.releaseLease({
        leaseId: input.leaseId, fencingToken: input.fencingToken,
        targetFingerprint: input.targetFingerprint, cleanupDigest: response.resultDigest,
      })
      requireDigest(leaseReceiptDigest)
      return { ...response, leaseReceiptDigest }
    }
    const leaseReceiptDigest = await this.#authority.quarantineLease({
      leaseId: input.leaseId, fencingToken: input.fencingToken,
      targetFingerprint: input.targetFingerprint,
      reason: `cleanup:${input.cleanupPlanId}:${response.status}:${response.resultDigest}`,
    })
    requireDigest(leaseReceiptDigest)
    return { ...response, leaseReceiptDigest }
  }
}

function parseRequest(value: GatewayCleanupRequest): GatewayCleanupRequest {
  if (!plain(value) || !exact(value, ['actionId', 'cleanupPlanDigest', 'cleanupPlanId', 'fencingToken',
    'leaseId', 'outcomeDigest', 'runId', 'targetFingerprint'])
    || ![value.runId, value.actionId, value.cleanupPlanId, value.leaseId].every(safeId)
    || ![value.cleanupPlanDigest, value.outcomeDigest, value.targetFingerprint].every(digest)
    || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
    throw cleanupError('E2E_RUNTIME_GATEWAY_CLEANUP_REQUEST_INVALID')
  }
  return structuredClone(value)
}
function parseResponse(value: unknown): GatewayCleanupResponse {
  if (!plain(value) || !exact(value, ['resultDigest', 'status'])
    || !['verified-clean', 'failed', 'unknown'].includes(String(value.status))
    || !digest(value.resultDigest)) throw cleanupError('E2E_RUNTIME_GATEWAY_CLEANUP_RESPONSE_INVALID')
  return structuredClone(value) as unknown as GatewayCleanupResponse
}
function requireDigest(value: unknown): asserts value is string {
  if (!digest(value)) throw cleanupError('E2E_RUNTIME_LEASE_RECEIPT_INVALID')
}
function errorCode(value: unknown): string {
  return value instanceof E2EError ? value.code : value instanceof Error ? value.name : 'unknown'
}
function safeId(value: unknown): value is string { return typeof value === 'string' && SAFE_ID.test(value) }
function digest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value) }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function cleanupError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
