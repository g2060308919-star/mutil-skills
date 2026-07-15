import { describe, expect, test } from 'vitest'
import {
  appendAttemptEvent,
  selectFinalAttempt,
  type AttemptEvent,
  type AttemptEventAuthorityProof,
  type AttemptTerminalSnapshot,
} from '../src/index.js'

const initialDigest = `sha256:${'a'.repeat(64)}`

function signProof(signedDigest: string): AttemptEventAuthorityProof {
  return { purpose: 'attempt-event-authority-proof/v2', issuer: 'test-authority', keyId: 'test-key', algorithm: 'Ed25519', signedDigest, signature: `proof:${signedDigest}` }
}

function verifyProof(proof: AttemptEventAuthorityProof): boolean {
  return proof.issuer === 'test-authority' && proof.keyId === 'test-key' && proof.signature === `proof:${proof.signedDigest}`
}

function terminal(overrides: Partial<AttemptTerminalSnapshot> = {}): AttemptTerminalSnapshot {
  return {
    status: 'automation-blocked', mode: 'real-environment', effect: 'read',
    effectObservation: 'not-applicable', reservationSafeToVoid: false,
    ...overrides,
  }
}

type AppendInput = Parameters<typeof appendAttemptEvent>[0]
type AttemptSeed = AppendInput extends infer Input
  ? Input extends unknown ? Omit<Input, 'previousChainDigest' | 'sequence'> : never
  : never

function chain(cores: AttemptSeed[]): AttemptEvent[] {
  const events: AttemptEvent[] = []
  let previousChainDigest = initialDigest
  for (const [index, core] of cores.entries()) {
    const appended = core.kind === 'started'
      ? appendAttemptEvent({ ...core, sequence: index + 1, previousChainDigest }, signProof)
      : appendAttemptEvent({ ...core, sequence: index + 1, previousChainDigest }, signProof)
    events.push(appended.event)
    previousChainDigest = appended.eventChainDigest
  }
  return events
}

describe('selectFinalAttempt', () => {
  test('recomputes and selects the unique terminal result in the highest safely authorized slot', () => {
    const events = chain([
      { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:00.000Z' },
      { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:01.000Z', result: terminal() },
      { kind: 'started', caseId: 'CASE-1', slot: 1, attemptId: 'ATTEMPT-1', mode: 'real-environment', timestamp: '2026-07-11T10:00:02.000Z' },
      { kind: 'terminal', caseId: 'CASE-1', slot: 1, attemptId: 'ATTEMPT-1', timestamp: '2026-07-11T10:00:03.000Z', result: terminal({ status: 'passed' }) },
    ])

    expect(selectFinalAttempt({
      caseId: 'CASE-1', retryPolicy: 'read-automation-max-2', initialChainDigest: initialDigest, events,
      verifyAuthorityProof: verifyProof,
    })).toMatchObject({
      status: 'selected', attemptId: 'ATTEMPT-1', slot: 1,
      result: { status: 'passed' }, eventChainDigest: expect.stringMatching(/^sha256:/),
    })
  })

  test('rejects a retry after a business failure or unknown write effect', () => {
    for (const unsafe of [
      terminal({ status: 'failed' }),
      terminal({ status: 'automation-blocked', effect: 'reversible-write', effectObservation: 'unknown', reservationSafeToVoid: true }),
    ]) {
      const events = chain([
        { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:00.000Z' },
        { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:01.000Z', result: unsafe },
        { kind: 'started', caseId: 'CASE-1', slot: 1, attemptId: 'ATTEMPT-1', mode: 'real-environment', timestamp: '2026-07-11T10:00:02.000Z' },
      ])
      expect(selectFinalAttempt({
        caseId: 'CASE-1', retryPolicy: unsafe.effect === 'read' ? 'read-automation-max-2' : 'verified-not-applied-max-1',
        initialChainDigest: initialDigest, events, verifyAuthorityProof: verifyProof,
      })).toMatchObject({
        status: 'safety-blocked', reasonCodes: expect.arrayContaining(['E2E_ATTEMPT_RETRY_NOT_AUTHORIZED']),
      })
    }
  })

  test('rejects duplicate or missing terminal results', () => {
    const duplicate = chain([
      { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:00.000Z' },
      { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:01.000Z', result: terminal({ status: 'passed' }) },
      { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:02.000Z', result: terminal({ status: 'passed' }) },
    ])
    expect(selectFinalAttempt({
      caseId: 'CASE-1', retryPolicy: 'none', initialChainDigest: initialDigest, events: duplicate,
      verifyAuthorityProof: verifyProof,
    })).toMatchObject({ status: 'safety-blocked', reasonCodes: expect.arrayContaining(['E2E_ATTEMPT_DUPLICATE_TERMINAL']) })

    const missing = chain([
      { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:00.000Z' },
    ])
    expect(selectFinalAttempt({
      caseId: 'CASE-1', retryPolicy: 'none', initialChainDigest: initialDigest, events: missing,
      verifyAuthorityProof: verifyProof,
    })).toMatchObject({ status: 'safety-blocked', reasonCodes: expect.arrayContaining(['E2E_ATTEMPT_HIGHEST_SLOT_NOT_TERMINAL']) })
  })

  test('rejects a tampered or reordered event chain', () => {
    const events = chain([
      { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:00.000Z' },
      { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:01.000Z', result: terminal({ status: 'passed' }) },
    ])
    events[1] = { ...events[1]!, attemptId: 'TAMPERED' }

    expect(selectFinalAttempt({
      caseId: 'CASE-1', retryPolicy: 'none', initialChainDigest: initialDigest, events,
      verifyAuthorityProof: verifyProof,
    })).toMatchObject({ status: 'safety-blocked', reasonCodes: expect.arrayContaining(['E2E_ATTEMPT_EVENT_DIGEST_INVALID']) })

    const proofTampered = chain([
      { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:00.000Z' },
      { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:01.000Z', result: terminal({ status: 'passed' }) },
    ])
    proofTampered[1] = {
      ...proofTampered[1]!,
      authorityProof: { ...proofTampered[1]!.authorityProof, signature: 'forged' },
    }
    expect(selectFinalAttempt({
      caseId: 'CASE-1', retryPolicy: 'none', initialChainDigest: initialDigest, events: proofTampered,
      verifyAuthorityProof: verifyProof,
    })).toMatchObject({
      status: 'safety-blocked', reasonCodes: expect.arrayContaining(['E2E_ATTEMPT_AUTHORITY_PROOF_INVALID']),
    })
  })

  test('拒绝事件时间倒序与 terminal 早于 matching start', () => {
    const events = chain([
      { kind: 'started', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', mode: 'real-environment', timestamp: '2026-07-11T10:00:02.000Z' },
      { kind: 'terminal', caseId: 'CASE-1', slot: 0, attemptId: 'ATTEMPT-0', timestamp: '2026-07-11T10:00:01.000Z', result: terminal({ status: 'passed' }) },
    ])
    expect(selectFinalAttempt({ caseId: 'CASE-1', retryPolicy: 'none', initialChainDigest: initialDigest,
      events, verifyAuthorityProof: verifyProof })).toMatchObject({ status: 'safety-blocked',
      reasonCodes: expect.arrayContaining(['E2E_ATTEMPT_TIME_ORDER_INVALID']) })
  })
})
