import { describe, expect, test } from 'vitest'
import { canonicalizeJson, digestText, type AppendAttemptEventInput } from '@mutil-skills/e2e-contracts'
import { createAttemptEventProofVerifier, LocalApprovalAuthority } from '../src/index.js'

const context = {
  assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: 'REV-1', runId: 'RUN-1', caseId: 'CASE-1',
}

type AppendApi = (input: { context: typeof context; event: AppendAttemptEventInput }) => {
  event: AppendAttemptEventInput & { eventDigest: string; authorityProof: { signedDigest: string } }
  eventChainDigest: string
}

describe('LocalApprovalAuthority attempt event proof', () => {
  test('Authority 自己追加并验签完整事件，且不再暴露任意摘要签名 oracle', () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const append = (authority as unknown as { appendAttemptEvent: AppendApi }).appendAttemptEvent.bind(authority)
    const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(context))
    const started = append({ context, event: {
      sequence: 1, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
      timestamp: '2026-07-11T10:00:00.000Z', previousChainDigest: initialChainDigest,
      kind: 'started', mode: 'real-environment',
    } })
    const terminal = append({ context, event: {
      sequence: 2, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
      timestamp: '2026-07-11T10:00:01.000Z', previousChainDigest: started.eventChainDigest,
      kind: 'terminal', result: { status: 'safety-blocked', mode: 'real-environment', effect: 'read',
        effectObservation: 'not-applicable', reservationSafeToVoid: true },
    } })
    const verifier = createAttemptEventProofVerifier(authority.attemptEventVerifierMaterial)

    expect((authority as unknown as Record<string, unknown>).signAttemptEventDigest).toBeUndefined()
    expect(verifier(terminal.event.authorityProof as never)).toBe(true)
    expect(terminal.event.authorityProof.signedDigest).toBe(terminal.event.eventDigest)
  })

  test('拒绝跳序、链断裂以及没有已完成 Authority reservation 的写入 passed 结果', () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const append = (authority as unknown as { appendAttemptEvent: AppendApi }).appendAttemptEvent.bind(authority)
    const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(context))
    const started = append({ context, event: {
      sequence: 1, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
      timestamp: '2026-07-11T10:00:00.000Z', previousChainDigest: initialChainDigest,
      kind: 'started', mode: 'real-environment',
    } })

    expect(() => append({ context, event: {
      sequence: 3, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
      timestamp: '2026-07-11T10:00:01.000Z', previousChainDigest: started.eventChainDigest,
      kind: 'terminal', result: { status: 'passed', mode: 'real-environment', effect: 'reversible-write',
        effectObservation: 'applied', reservationSafeToVoid: false },
    } })).toThrowError(expect.objectContaining({ code: 'E2E_ATTEMPT_AUTHORITY_LOG_SEQUENCE_INVALID' }))

    expect(() => append({ context, event: {
      sequence: 2, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
      timestamp: '2026-07-11T10:00:01.000Z', previousChainDigest: started.eventChainDigest,
      kind: 'terminal', result: { status: 'passed', mode: 'real-environment', effect: 'reversible-write',
        effectObservation: 'applied', reservationSafeToVoid: false },
    } })).toThrowError(expect.objectContaining({ code: 'E2E_ATTEMPT_OUTCOME_UNATTESTED' }))
  })
})
