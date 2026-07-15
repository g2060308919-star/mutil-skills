import { describe, expect, test } from 'vitest'
import { canonicalizeJson, digestText, type AttemptEventAuthorityProof } from '@mutil-skills/e2e-contracts'
import { appendAttemptEvent, auditPersistedAttemptFacts } from '../src/index.js'

const context = { assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: 'REV-1', runId: 'RUN-1', caseId: 'CASE-1' }
const outcomeDigest = digestText('attempt-audit-test/v1', 'outcome')

function facts() {
  const signProof = (signedDigest: string): AttemptEventAuthorityProof => ({ purpose: 'attempt-event-authority-proof/v2',
    issuer: 'authority', keyId: 'key:attempt-event', algorithm: 'Ed25519', signedDigest, signature: `proof:${signedDigest}` })
  const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(context))
  const started = appendAttemptEvent({
    sequence: 1, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
    timestamp: '2026-07-11T10:00:00.000Z', previousChainDigest: initialChainDigest,
    kind: 'started', mode: 'real-environment',
  }, signProof)
  const terminal = appendAttemptEvent({
    sequence: 2, caseId: context.caseId, slot: 0, attemptId: 'ATTEMPT-1',
    timestamp: '2026-07-11T10:00:01.000Z', previousChainDigest: started.eventChainDigest,
    kind: 'terminal', result: { status: 'passed', mode: 'real-environment', effect: 'read',
      effectObservation: 'not-applicable', reservationSafeToVoid: true,
      reservationId: 'RESERVATION-1', outcomeDigest },
  }, signProof)
  const attemptCase = { caseId: context.caseId, retryPolicy: 'none' as const, initialChainDigest,
    events: [started.event, terminal.event], selection: { status: 'selected' as const, attemptId: 'ATTEMPT-1',
      slot: 0, eventChainDigest: terminal.eventChainDigest } }
  const workflow = { runId: context.runId, attemptCases: [attemptCase],
    workflowDigest: digestText('workflow-events/v2', canonicalizeJson({ runId: context.runId, attemptCases: [attemptCase] })) }
  return { workflow, terminal }
}
const verifyProof = (proof: AttemptEventAuthorityProof) => proof.purpose === 'attempt-event-authority-proof/v2'
  && proof.signature === `proof:${proof.signedDigest}`

function artifacts(workflow: ReturnType<typeof facts>['workflow'], terminal: ReturnType<typeof facts>['terminal']) {
  const common = { assetId: context.assetId, generationId: context.generationId, prdRevision: context.prdRevision }
  return [
    { artifactType: 'test-cases', ...common, content: { cases: [{
      caseId: context.caseId, retryPolicy: 'none', mode: 'real-environment', effect: 'read',
    }] } },
    { artifactType: 'run-bundle', ...common, content: { runId: context.runId,
      schedule: [{ caseId: context.caseId }], attemptPlans: [{ caseId: context.caseId, slots: 1 }] } },
    { artifactType: 'workflow-events', ...common, content: workflow },
    { artifactType: 'browser-results', ...common, content: { runId: context.runId, executedBrowserIds: ['CHROMIUM'], caseResults: [{
      caseId: context.caseId, attemptId: 'ATTEMPT-1', eventChainDigest: terminal.eventChainDigest,
      mode: 'real-environment', status: 'passed', effect: 'read', effectObservation: 'not-applicable',
    }] } },
    { artifactType: 'gateway-audit', ...common, content: { capabilityReservations: [{
      reservationId: 'RESERVATION-1', attemptId: 'ATTEMPT-1', status: 'completed', outcomeDigest,
    }] } },
  ]
}

describe('auditPersistedAttemptFacts', () => {
  test('只从持久 Artifact 重建唯一最终 attempt，并 exact 绑定 browser result', () => {
    const value = facts()
    const result = auditPersistedAttemptFacts(artifacts(value.workflow, value.terminal),
      verifyProof)
    expect(result).toMatchObject({ valid: true, selected: [{ caseId: 'CASE-1', attemptId: 'ATTEMPT-1', slot: 0 }] })
  })

  test.each([
    ['delete', (value: ReturnType<typeof facts>) => value.workflow.attemptCases[0]!.events.pop()],
    ['reorder', (value: ReturnType<typeof facts>) => value.workflow.attemptCases[0]!.events.reverse()],
    ['break previous', (value: ReturnType<typeof facts>) => { value.workflow.attemptCases[0]!.events[1]!.previousChainDigest = `sha256:${'b'.repeat(64)}` }],
    ['forge selection', (value: ReturnType<typeof facts>) => { value.workflow.attemptCases[0]!.selection.attemptId = 'ATTEMPT-X' }],
  ])('拒绝持久事件攻击：%s', (_name, mutate) => {
    const value = facts(); mutate(value)
    const result = auditPersistedAttemptFacts(artifacts(value.workflow, value.terminal),
      verifyProof)
    expect(result.valid).toBe(false)
  })

  test('缺少专用 verifier 时 fail closed', () => {
    const value = facts()
    expect(auditPersistedAttemptFacts(artifacts(value.workflow, value.terminal), undefined).valid).toBe(false)
  })

  test.each([
    ['proof', (value: ReturnType<typeof facts>) => { value.workflow.attemptCases[0]!.events[1]!.authorityProof.signature = 'forged' }],
    ['event core', (value: ReturnType<typeof facts>) => { value.workflow.attemptCases[0]!.events[1]!.timestamp = '2026-07-11T10:00:02.000Z' }],
    ['time travel', (value: ReturnType<typeof facts>) => { value.workflow.attemptCases[0]!.events[1]!.timestamp = '2026-07-11T09:59:59.000Z' }],
  ])('即使重算 workflow digest，仍拒绝 %s 替换', (_name, mutate) => {
    const value = facts(); mutate(value)
    value.workflow.workflowDigest = digestText('workflow-events/v2', canonicalizeJson({
      runId: value.workflow.runId, attemptCases: value.workflow.attemptCases }))
    expect(auditPersistedAttemptFacts(artifacts(value.workflow, value.terminal), verifyProof).valid).toBe(false)
  })

  test('拒绝重复 plan/schedule，但允许 test-cases 存在未调度 deprecated 超集', () => {
    const value = facts(); const candidates: any[] = artifacts(value.workflow, value.terminal)
    candidates[0].content.cases.push({ caseId: 'CASE-OLD', retryPolicy: 'none', effect: 'read', status: 'deprecated' })
    expect(auditPersistedAttemptFacts(candidates, verifyProof).valid).toBe(true)
    candidates[1].content.attemptPlans.push({ caseId: context.caseId, slots: 1 })
    candidates[1].content.schedule.push({ caseId: context.caseId })
    expect(auditPersistedAttemptFacts(candidates, verifyProof).findings.map((item) => item.code))
      .toEqual(expect.arrayContaining(['E2E_ATTEMPT_PLAN_DUPLICATE', 'E2E_ATTEMPT_SCHEDULE_DUPLICATE']))
  })

  test('拒绝跨代 workflow 与 browser result status/effect/mode 不一致', () => {
    const value = facts(); const candidates: any[] = artifacts(value.workflow, value.terminal)
    candidates[3].generationId = 'GEN-OLD'
    candidates[3].content.caseResults[0].status = 'failed'
    candidates[3].content.caseResults[0].effect = 'reversible-write'
    expect(auditPersistedAttemptFacts(candidates, verifyProof).findings.map((item) => item.code))
      .toEqual(expect.arrayContaining(['E2E_ATTEMPT_CROSS_GENERATION', 'E2E_ATTEMPT_BROWSER_RESULT_MISMATCH']))
  })

  test('拒绝把 injection Case 的持久 Attempt 改标为真实环境结果', () => {
    const value = facts(); const candidates: any[] = artifacts(value.workflow, value.terminal)
    candidates[0].content.cases[0].mode = 'gateway-injection'

    expect(auditPersistedAttemptFacts(candidates, verifyProof).findings.map((item) => item.code))
      .toContain('E2E_ATTEMPT_CASE_MODE_MISMATCH')
  })

  test.each([
    ['reservationId', (candidates: any[]) => { candidates[4].content.capabilityReservations[0].reservationId = 'RESERVATION-X' }],
    ['outcomeDigest', (candidates: any[]) => { candidates[4].content.capabilityReservations[0].outcomeDigest = digestText('attempt-audit-test/v1', 'forged') }],
    ['attemptId', (candidates: any[]) => { candidates[4].content.capabilityReservations[0].attemptId = 'ATTEMPT-X' }],
  ])('拒绝 Attempt terminal 与 Gateway reservation 的 %s 错绑', (_name, mutate) => {
    const value = facts(); const candidates: any[] = artifacts(value.workflow, value.terminal)
    mutate(candidates)
    expect(auditPersistedAttemptFacts(candidates, verifyProof).findings.map((item) => item.code))
      .toContain('E2E_ATTEMPT_GATEWAY_RESERVATION_BINDING_INVALID')
  })
})
