import { describe, expect, test } from 'vitest'
import {
  CleanupPlanDefinitionSchema,
  RuntimeWriteHttpActionSchema,
  digestRuntimeHttpBodyTemplate,
  digestRuntimeHttpResponseBody,
  digestRuntimeWriteHttpAction,
} from '../src/index.js'

const responseDigest = digestRuntimeHttpResponseBody(Buffer.from('{"ok":true}'))
const bodyTemplate = {
  kind: 'segments' as const,
  contentType: 'application/json',
  segments: [
    { kind: 'literal' as const, value: '{"token":"' },
    { kind: 'secretRef' as const, secretRef: 'SECRET.API' },
    { kind: 'literal' as const, value: '"}' },
  ],
}

const action = {
  schemaVersion: '1.0.0' as const,
  caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', cleanupPlanId: 'CLEANUP-1',
  writeRequest: {
    requestId: 'REQUEST-WRITE', intentId: 'INTENT-WRITE', method: 'POST',
    url: 'https://test.example.com/api/orders/1', headers: [],
    body: { ...bodyTemplate, templateDigest: digestRuntimeHttpBodyTemplate(bodyTemplate) },
    expectedStatus: 201, expectedResponseBodyDigest: responseDigest,
  },
  effectProbe: {
    requestId: 'REQUEST-EFFECT', intentId: 'INTENT-EFFECT', method: 'GET' as const,
    url: 'https://test.example.com/api/orders/1', headers: [], expectedStatus: 200,
    expectedResponseBodyDigest: responseDigest,
  },
}

describe('Runtime 固定 HTTP action 合同', () => {
  test('literal/secretRef 模板与完整 action 都产生确定摘要', () => {
    expect(RuntimeWriteHttpActionSchema.parse(action)).toEqual(action)
    expect(digestRuntimeWriteHttpAction(action)).toMatch(/^sha256:/)
    expect(digestRuntimeWriteHttpAction({ ...action, writeRequest: {
      ...action.writeRequest, expectedStatus: 202,
    } })).not.toBe(digestRuntimeWriteHttpAction(action))
  })

  test('拒绝模板摘要漂移、凭据 header、非 canonical URL 与 GET 写请求', () => {
    expect(() => RuntimeWriteHttpActionSchema.parse({ ...action, writeRequest: {
      ...action.writeRequest, body: { ...action.writeRequest.body, templateDigest: responseDigest },
    } })).toThrow(/templateDigest/)
    expect(() => RuntimeWriteHttpActionSchema.parse({ ...action, writeRequest: {
      ...action.writeRequest, headers: [{ name: 'authorization', value: 'secret' }],
    } })).toThrow(/header/)
    expect(() => RuntimeWriteHttpActionSchema.parse({ ...action, writeRequest: {
      ...action.writeRequest, url: 'https://test.example.com/api/../orders/1',
    } })).toThrow(/URL/)
    expect(() => RuntimeWriteHttpActionSchema.parse({ ...action, writeRequest: {
      ...action.writeRequest, method: 'GET',
    } })).toThrow(/非 GET/)
  })

  test('cleanup 固定请求和 verified read probe 必须与 plan ID、摘要闭合', () => {
    const plan = {
      schemaVersion: '1.0.0' as const, cleanupPlanId: 'CLEANUP-1', actionId: 'ACTION-1',
      leaseId: 'LEASE-1', executorId: 'runtime-http-cleanup.v1',
      cleanupRequestIntentIds: ['INTENT-CLEANUP'],
      verificationProbes: [{
        probeId: 'REQUEST-VERIFY', kind: 'http-response' as const, expectedDigest: responseDigest,
      }],
      timeoutMs: 30_000,
      runtimeHttpCleanup: {
        request: {
          requestId: 'REQUEST-CLEANUP', intentId: 'INTENT-CLEANUP', method: 'DELETE',
          url: 'https://test.example.com/api/orders/1', headers: [], body: { kind: 'no-body' as const },
          expectedStatus: 204, expectedResponseBodyDigest: digestRuntimeHttpResponseBody(Buffer.alloc(0)),
        },
        verificationProbe: {
          requestId: 'REQUEST-VERIFY', intentId: 'INTENT-VERIFY', method: 'GET' as const,
          url: 'https://test.example.com/api/orders/1', headers: [], expectedStatus: 404,
          expectedResponseBodyDigest: responseDigest,
        },
      },
    }
    expect(CleanupPlanDefinitionSchema.parse(plan)).toEqual(plan)
    expect(() => CleanupPlanDefinitionSchema.parse({
      ...plan, cleanupRequestIntentIds: ['INTENT-OTHER'],
    })).toThrow(/cleanupRequestIntentId/)
  })
})
