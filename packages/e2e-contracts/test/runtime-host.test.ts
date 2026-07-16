import { describe, expect, test } from 'vitest'
import { RuntimeRequestEnvelopeSchema } from '../src/runtime-host.js'

const doctorRequest = {
  schemaVersion: '1.0.0',
  requestId: 'REQ-1',
  client: { name: 'e2e-skill', version: '0.1.0' },
  command: 'doctor',
  payload: {},
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
})
