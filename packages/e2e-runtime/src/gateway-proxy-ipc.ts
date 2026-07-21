import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import { createHmac, timingSafeEqual } from 'node:crypto'

export type GatewayIpcDirection = 'parent-request' | 'parent-response' | 'child-request' | 'child-response'

export interface GatewayIpcEnvelope {
  schemaVersion: '1.0.0'
  direction: GatewayIpcDirection
  requestId: string
  sequence: number
  operation: string
  payload: unknown
  mac: string
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

export function signGatewayIpcEnvelope(input: Omit<GatewayIpcEnvelope, 'mac'>, key: Uint8Array): GatewayIpcEnvelope {
  const unsigned = parseUnsigned(input)
  return { ...unsigned, mac: createHmac('sha256', key).update(canonicalizeJson(unsigned)).digest('base64url') }
}

export function verifyGatewayIpcEnvelope(
  value: unknown,
  key: Uint8Array,
  expected: { direction: GatewayIpcDirection; sequence?: number },
): GatewayIpcEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, [
    'direction', 'mac', 'operation', 'payload', 'requestId', 'schemaVersion', 'sequence',
  ])) invalid()
  const unsigned = parseUnsigned(value)
  if (unsigned.direction !== expected.direction || (expected.sequence !== undefined && unsigned.sequence !== expected.sequence)
    || typeof value.mac !== 'string') invalid()
  const supplied = Buffer.from(value.mac, 'base64url')
  const wanted = createHmac('sha256', key).update(canonicalizeJson(unsigned)).digest()
  try {
    if (supplied.byteLength !== 32 || supplied.toString('base64url') !== value.mac
      || !timingSafeEqual(supplied, wanted)) invalid()
  } finally { supplied.fill(0); wanted.fill(0) }
  return { ...unsigned, mac: value.mac }
}

function parseUnsigned(value: Record<string, unknown>): Omit<GatewayIpcEnvelope, 'mac'> {
  if (value.schemaVersion !== '1.0.0'
    || !['parent-request', 'parent-response', 'child-request', 'child-response'].includes(String(value.direction))
    || typeof value.requestId !== 'string' || !SAFE_ID.test(value.requestId)
    || typeof value.operation !== 'string' || !SAFE_ID.test(value.operation)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > Number.MAX_SAFE_INTEGER) invalid()
  return {
    schemaVersion: '1.0.0',
    direction: value.direction as GatewayIpcDirection,
    requestId: value.requestId,
    sequence: Number(value.sequence),
    operation: value.operation,
    payload: structuredClone(value.payload),
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(): never {
  throw Object.assign(new Error('E2E_GATEWAY_IPC_INVALID'), { code: 'E2E_GATEWAY_IPC_INVALID' })
}
