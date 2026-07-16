import {
  canonicalizeJson,
  digestText,
  type AppendAttemptEventInput,
  type AttemptEvent,
  type AttemptEventAuthorityProof,
  type AttemptTerminalSnapshot,
  type FinalAttemptSelection,
  type SelectFinalAttemptInput,
} from '@mutil-skills/e2e-contracts'
import { evaluateRetrySafety } from './diagnosis.js'

const DigestPattern = /^sha256:[a-f0-9]{64}$/

export type { AttemptEvent, AttemptEventAuthorityProof, AttemptTerminalSnapshot } from '@mutil-skills/e2e-contracts'

export function appendAttemptEvent(
  input: AppendAttemptEventInput,
  signAuthorityProof: (eventDigest: string) => AttemptEventAuthorityProof,
): { event: AttemptEvent; eventChainDigest: string } {
  const eventDigest = digestAttemptEvent(input)
  const authorityProof = signAuthorityProof(eventDigest)
  const event = { ...input, eventDigest, authorityProof } as AttemptEvent
  return { event, eventChainDigest: extendAttemptChain(input.previousChainDigest, eventDigest) }
}

export function selectFinalAttempt(input: SelectFinalAttemptInput): FinalAttemptSelection {
  const reasons: string[] = []
  const started = new Map<number, Extract<AttemptEvent, { kind: 'started' }>>()
  const terminals = new Map<number, Extract<AttemptEvent, { kind: 'terminal' }>>()
  const attemptIds = new Set<string>()
  let chainDigest = input.initialChainDigest
  let previousTimestamp = Number.NEGATIVE_INFINITY

  if (!DigestPattern.test(chainDigest)) reasons.push('E2E_ATTEMPT_INITIAL_CHAIN_INVALID')
  for (const [index, event] of input.events.entries()) {
    if (event.sequence !== index + 1) reasons.push('E2E_ATTEMPT_SEQUENCE_INVALID')
    if (event.caseId !== input.caseId) reasons.push('E2E_ATTEMPT_CASE_MISMATCH')
    if (event.previousChainDigest !== chainDigest) reasons.push('E2E_ATTEMPT_CHAIN_BROKEN')
    const { eventDigest, authorityProof, ...eventCore } = event
    if (eventDigest !== digestAttemptEvent(eventCore)) reasons.push('E2E_ATTEMPT_EVENT_DIGEST_INVALID')
    if (authorityProof.signedDigest !== eventDigest || !input.verifyAuthorityProof(authorityProof)) {
      reasons.push('E2E_ATTEMPT_AUTHORITY_PROOF_INVALID')
    }
    chainDigest = extendAttemptChain(event.previousChainDigest, eventDigest)

    const timestamp = Date.parse(event.timestamp)
    if (!Number.isSafeInteger(event.slot) || event.slot < 0 || !event.attemptId || Number.isNaN(timestamp)) {
      reasons.push('E2E_ATTEMPT_EVENT_INVALID')
      continue
    }
    if (timestamp < previousTimestamp) reasons.push('E2E_ATTEMPT_TIME_ORDER_INVALID')
    previousTimestamp = timestamp
    if (event.kind === 'started') {
      if (started.has(event.slot) || attemptIds.has(event.attemptId)) {
        reasons.push('E2E_ATTEMPT_DUPLICATE_START')
        continue
      }
      if (event.slot === 0) {
        if (started.size !== 0) reasons.push('E2E_ATTEMPT_SLOT_ORDER_INVALID')
      } else {
        const previousStart = started.get(event.slot - 1)
        const previousTerminal = terminals.get(event.slot - 1)
        if (!previousStart || !previousTerminal) {
          reasons.push('E2E_ATTEMPT_PREVIOUS_SLOT_INCOMPLETE')
        } else {
          const retry = evaluateRetrySafety({
            ...previousTerminal.result,
            retryPolicy: input.retryPolicy,
            currentSlot: event.slot - 1,
          })
          if (!retry.allowed || retry.nextSlot !== event.slot || retry.nextMode !== event.mode) {
            reasons.push('E2E_ATTEMPT_RETRY_NOT_AUTHORIZED')
          }
        }
      }
      started.set(event.slot, event)
      attemptIds.add(event.attemptId)
      continue
    }

    const start = started.get(event.slot)
    if (!start || start.attemptId !== event.attemptId || start.mode !== event.result.mode) {
      reasons.push('E2E_ATTEMPT_TERMINAL_WITHOUT_MATCHING_START')
    }
    if (start && timestamp < Date.parse(start.timestamp)) reasons.push('E2E_ATTEMPT_TIME_ORDER_INVALID')
    if (terminals.has(event.slot)) reasons.push('E2E_ATTEMPT_DUPLICATE_TERMINAL')
    else terminals.set(event.slot, event)
  }

  const highestSlot = started.size === 0 ? undefined : Math.max(...started.keys())
  if (highestSlot === undefined) reasons.push('E2E_ATTEMPT_NO_STARTED_SLOT')
  const finalTerminal = highestSlot === undefined ? undefined : terminals.get(highestSlot)
  if (highestSlot !== undefined && !finalTerminal) reasons.push('E2E_ATTEMPT_HIGHEST_SLOT_NOT_TERMINAL')

  const reasonCodes = [...new Set(reasons)].sort()
  if (reasonCodes.length > 0 || highestSlot === undefined || !finalTerminal) {
    return { status: 'safety-blocked', reasonCodes, eventChainDigest: chainDigest }
  }
  return {
    status: 'selected', attemptId: finalTerminal.attemptId, slot: highestSlot,
    result: { ...finalTerminal.result }, eventChainDigest: chainDigest,
  }
}

function digestAttemptEvent(event: AppendAttemptEventInput): string {
  return digestText('attempt-event/v1', canonicalizeJson(event))
}

function extendAttemptChain(previousChainDigest: string, eventDigest: string): string {
  return digestText('attempt-event-chain/v1', canonicalizeJson({ previous: previousChainDigest, event: eventDigest }))
}
