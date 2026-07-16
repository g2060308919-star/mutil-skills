import { describe, expect, test } from 'vitest'
import { RuntimeRequestEnvelopeSchema } from '../src/runtime-host.js'

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

describe('Runtime Host contracts', () => {
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
})
