import { describe, expect, test } from 'vitest'
import {
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  RuntimeStatusResultSchema,
} from '../src/runtime-host.js'

const doctorRequest = {
  schemaVersion: '1.0.0',
  requestId: 'REQ-1',
  client: { name: 'e2e-skill', version: '0.1.0' },
  command: 'doctor',
  payload: {},
}

const submitCandidateRequest = {
  ...doctorRequest,
  command: 'submit-candidate',
  projectRoot: '/tmp/project',
  payload: {
    runId: 'RUN-1',
    expectedState: 'created',
    artifactType: 'prd-request',
    candidate: { title: 'candidate', values: [null, true, 1, 'text'] },
  },
}

const resumeRunRequest = {
  ...doctorRequest,
  command: 'resume-run',
  projectRoot: '/tmp/project',
  payload: {
    runId: 'RUN-1',
    decision: { kind: 'continue', evidence: [null, false, 2, 'text'] },
  },
}

const executionSubject = {
  schemaVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: `sha256:${'1'.repeat(64)}`,
  executionDigest: `sha256:${'2'.repeat(64)}`, environment: 'test',
  baseOrigin: 'https://test.example.com',
  actions: [{ actionId: 'ACTION-1', origin: 'wss://test.example.com', path: '/events',
    maxInboundMessages: 1, maxBytes: 1024 }],
}
const manualDraft = {
  schemaVersion: '1.0.0', manualResultId: 'MANUAL-1', runId: 'RUN-1', assetId: 'ASSET-1',
  prdRevision: `sha256:${'1'.repeat(64)}`, generationId: 'RUN-1',
  runtimeInstallationDigest: `sha256:${'2'.repeat(64)}`, manualProcedureId: 'MANUAL-PROCEDURE-1',
  caseIds: ['CASE-MANUAL-1'], obligationIds: ['COV-MANUAL-1'],
  requirementModelDigest: `sha256:${'3'.repeat(64)}`,
  executor: { subject: 'manual:executor', roles: ['e2e-manual-executor'] },
  reviewer: { subject: 'manual:reviewer', roles: ['e2e-manual-reviewer'] },
  startedAt: '2026-07-18T01:00:00.000Z', finishedAt: '2026-07-18T01:05:00.000Z', outcome: 'passed',
  steps: [{ stepId: 'MANUAL-STEP-1', instructionDigest: `sha256:${'4'.repeat(64)}`,
    outcome: 'passed', observation: '人工验证通过', evidenceDigests: [`sha256:${'5'.repeat(64)}`] }],
  evidenceDigests: [`sha256:${'5'.repeat(64)}`], expiresAt: '2026-07-19T01:05:00.000Z',
}

describe('Runtime Host contracts', () => {
  test('验收语义查看与确认使用独立严格命令并绑定 reviewDigest', () => {
    const base = {
      schemaVersion: '1.0.0', client: { name: 'e2e-skill', version: '1.0.0' },
      projectRoot: '/project',
    }
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...base, requestId: 'REVIEW-1', command: 'get-acceptance-review', payload: { runId: 'RUN-1' },
    }).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...base, requestId: 'REVIEW-2', command: 'confirm-acceptance-review',
      payload: { runId: 'RUN-1', reviewDigest: `sha256:${'a'.repeat(64)}` },
    }).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...base, requestId: 'REVIEW-3', command: 'confirm-acceptance-review',
      payload: { runId: 'RUN-1', confirmed: true },
    }).success).toBe(false)
  })
  test('accepts the exact doctor envelope', () => {
    expect(RuntimeRequestEnvelopeSchema.parse(doctorRequest)).toEqual(doctorRequest)
  })

  test('rejects extra fields and unsupported protocol major', () => {
    expect(RuntimeRequestEnvelopeSchema.safeParse({ ...doctorRequest, shell: 'rm -rf /' }).success).toBe(false)
    expect(RuntimeRequestEnvelopeSchema.safeParse({ ...doctorRequest, schemaVersion: '2.0.0' }).success).toBe(false)
  })

  test('rejects approval booleans in machine payloads', () => {
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...doctorRequest,
      command: 'open-approval',
      projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', approvalType: 'execution', approved: true },
    }).success).toBe(false)
  })

  test('accepts only subject-bound confirm-approval requests', () => {
    expect(RuntimeRequestEnvelopeSchema.parse({
      ...doctorRequest, command: 'confirm-approval', projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', confirmationId: 'CONFIRM-1',
        subjectDigest: `sha256:${'a'.repeat(64)}` },
    })).toBeTruthy()
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...doctorRequest, command: 'confirm-approval', projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', confirmationId: 'CONFIRM-1' },
    }).success).toBe(false)
  })

  test('manual result commands accept only a draft and a role transition, never approval booleans or session proofs', () => {
    const prepare = {
      ...doctorRequest, command: 'prepare-manual-result', projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', draft: manualDraft },
    }
    const finalize = {
      ...doctorRequest, command: 'finalize-manual-result-role', projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', manualResultId: 'MANUAL-1',
        draftDigest: `sha256:${'6'.repeat(64)}`, role: 'executor' },
    }
    expect(RuntimeRequestEnvelopeSchema.safeParse(prepare).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse(finalize).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...prepare, payload: { ...prepare.payload, approved: true },
    }).success).toBe(false)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...finalize, payload: { ...finalize.payload, approvalSessionRef: 'CALLER-SESSION' },
    }).success).toBe(false)
  })

  test('discovery/execution approval requires one exact strict Grant subject', () => {
    const request = {
      ...doctorRequest, command: 'open-approval', projectRoot: '/tmp/project',
      payload: { runId: 'RUN-1', approvalType: 'execution', grantSubject: executionSubject },
    }
    expect(RuntimeRequestEnvelopeSchema.safeParse(request).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...request, payload: { runId: 'RUN-1', approvalType: 'execution' },
    }).success).toBe(false)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...request,
      payload: { ...request.payload, grantSubject: {
        ...executionSubject,
        actions: [{ ...executionSubject.actions[0], unreviewedMatcher: '**' }],
      } },
    }).success).toBe(false)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...request, payload: { ...request.payload, approvalType: 'scope' },
    }).success).toBe(false)
  })

  test('requires submit-candidate payloads to include candidate', () => {
    const { candidate: _candidate, ...payload } = submitCandidateRequest.payload
    expect(RuntimeRequestEnvelopeSchema.safeParse({ ...submitCandidateRequest, payload }).success).toBe(false)
  })

  test('compile-prd-run 只接受声明式设计，不接受调用者伪造编译事实', () => {
    const request = {
      ...doctorRequest,
      command: 'compile-prd-run',
      projectRoot: '/tmp/project',
      payload: {
        runId: 'RUN-1',
        design: {
          schemaVersion: '1.0.0',
          cases: [{
            caseKey: 'stable-product',
            title: '验证产品行为稳定',
            actor: 'auditor',
            contractNodeIds: ['REQ-1'],
            actions: [{
              actionKey: 'observe-product',
              kind: 'full-playwright',
              effect: 'read',
              statement: '打开产品并观察稳定行为',
            }],
            oracles: [{
              oracleKey: 'stable-product-oracle',
              actionKey: 'observe-product',
              contractNodeId: 'REQ-1',
              acceptanceCriterion: 'Product behavior is stable',
            }],
            failurePolicy: 'stop-required',
          }],
        },
      },
    }

    expect(RuntimeRequestEnvelopeSchema.safeParse(request).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...request,
      payload: { ...request.payload, compilerDigest: `sha256:${'a'.repeat(64)}` },
    }).success).toBe(false)
    expect(RuntimeRequestEnvelopeSchema.safeParse({
      ...request,
      payload: {
        ...request.payload,
        design: { ...request.payload.design, artifactDigests: { forged: `sha256:${'b'.repeat(64)}` } },
      },
    }).success).toBe(false)
  })

  test('requires resume-run payloads to include decision', () => {
    const { decision: _decision, ...payload } = resumeRunRequest.payload
    expect(RuntimeRequestEnvelopeSchema.safeParse({ ...resumeRunRequest, payload }).success).toBe(false)
  })

  test('accepts JSON values and rejects non-JSON candidate or decision values', () => {
    expect(RuntimeRequestEnvelopeSchema.safeParse(submitCandidateRequest).success).toBe(true)
    expect(RuntimeRequestEnvelopeSchema.safeParse(resumeRunRequest).success).toBe(true)

    const nonJsonValues = [
      undefined,
      () => undefined,
      Symbol('candidate'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { nested: undefined },
    ]
    for (const candidate of nonJsonValues) {
      expect(RuntimeRequestEnvelopeSchema.safeParse({
        ...submitCandidateRequest,
        payload: { ...submitCandidateRequest.payload, candidate },
      }).success).toBe(false)
    }
    for (const decision of nonJsonValues) {
      expect(RuntimeRequestEnvelopeSchema.safeParse({
        ...resumeRunRequest,
        payload: { ...resumeRunRequest.payload, decision },
      }).success).toBe(false)
    }
  })

  test('get-status 公共投影严格拒绝未知字段，通用响应拒绝非 JSON result', () => {
    const result = {
      runId: 'RUN-1', assetId: 'ASSET-1', projectIdentityDigest: `sha256:${'1'.repeat(64)}`,
      runtimeInstallationDigest: `sha256:${'2'.repeat(64)}`, generationId: 'RUN-1',
      prdRevision: `sha256:${'3'.repeat(64)}`,
      workflow: { current: 'created', sequence: 0, eventChainDigest: `sha256:${'4'.repeat(64)}` },
      artifactDigests: { 'prd-source': `sha256:${'3'.repeat(64)}` }, state: 'created',
      nextEdge: { command: 'submit-candidate', from: 'created', expectedState: 'created' },
      verifiedDigests: { workflowEventChain: `sha256:${'4'.repeat(64)}` },
      minimumMissingInput: ['prd-request'],
    }
    expect(RuntimeStatusResultSchema.parse(result)).toEqual(result)
    expect(RuntimeStatusResultSchema.safeParse({ ...result, guessedVerdict: 'accepted' }).success).toBe(false)
    expect(RuntimeResponseEnvelopeSchema.safeParse({
      schemaVersion: '1.0.0', requestId: 'REQ-1',
      runtime: { version: '0.1.0', installationDigest: `sha256:${'5'.repeat(64)}` },
      ok: true, result: { callback: () => undefined },
    }).success).toBe(false)
  })
})
