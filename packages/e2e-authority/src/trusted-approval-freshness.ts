import {
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerifierMaterial,
} from '@mutil-skills/e2e-contracts'
import { createApprovalFreshnessVerifier } from './approval-freshness-verifier.js'

export interface TrustedApprovalFreshnessClient {}

const clients = new WeakMap<object, {
  kind: 'authority-state' | 'test-only-fixed-clock'
  verify(receipt: ApprovalFreshnessReceipt): boolean
}>()

/** @internal 只能由 Authority 实例用其私有状态注册。 */
export function registerTrustedApprovalFreshnessClient(
  verifyCurrent: (receipt: ApprovalFreshnessReceipt) => boolean,
): TrustedApprovalFreshnessClient {
  const client = Object.freeze({})
  clients.set(client, { kind: 'authority-state', verify: verifyCurrent })
  return client
}

export function createTestOnlyApprovalFreshnessClient(input: {
  material: ApprovalFreshnessVerifierMaterial
  expectedPublicKeyDigest: string
  now: string
}): TrustedApprovalFreshnessClient {
  const now = Date.parse(input.now)
  if (!Number.isFinite(now)) throw new Error('E2E_APPROVAL_TEST_CLOCK_INVALID')
  const verifyProof = createApprovalFreshnessVerifier(input.material, input.expectedPublicKeyDigest)
  const client = Object.freeze({})
  clients.set(client, { kind: 'test-only-fixed-clock', verify: (receipt) =>
    verifyProof(receipt) && receipt.status === 'valid'
      && Date.parse(receipt.checkedAt) <= now && now < Date.parse(receipt.expiresAt) })
  return client
}

export function verifyTrustedApprovalFreshnessCurrent(
  client: TrustedApprovalFreshnessClient,
  receipt: ApprovalFreshnessReceipt,
): boolean {
  const binding = client && typeof client === 'object' ? clients.get(client as object) : undefined
  if (!binding) return false
  try { return binding.verify(receipt) } catch { return false }
}

export function getTrustedApprovalFreshnessClientKind(
  client: TrustedApprovalFreshnessClient,
): 'authority-state' | 'test-only-fixed-clock' | undefined {
  return client && typeof client === 'object' ? clients.get(client as object)?.kind : undefined
}
