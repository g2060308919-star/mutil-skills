import { describe, expect, test } from 'vitest'
import {
  ReadHttpRequestSchema,
  validateReadHttpRequestSet,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function request() {
  return {
    requestId: 'REQUEST-ORDERS-1',
    method: 'GET',
    url: 'https://example.test/api/orders?status=open',
    headers: [
      { name: 'accept', value: 'application/json' },
      { name: 'x-client-version', value: '1' },
    ],
    bodyDigest: digest('0'),
    redirectPolicy: { mode: 'deny' as const },
  }
}

describe('ReadHttpRequest 严格只读请求', () => {
  test('冻结 method、规范 URL、完整 headers、body digest 与 redirect policy', () => {
    expect(ReadHttpRequestSchema.parse(request())).toEqual(request())
    for (const changed of [
      { ...request(), method: 'get' },
      { ...request(), method: 'POST' },
      { ...request(), method: 'CONNECT' },
      { ...request(), url: 'https://user:pass@example.test/api/orders' },
      { ...request(), url: 'https://example.test/api/orders#fragment' },
      { ...request(), headers: [{ name: 'Accept', value: 'application/json' }] },
      { ...request(), headers: [{ name: 'connection', value: 'keep-alive' }] },
      { ...request(), headers: [{ name: 'authorization', value: 'Bearer plaintext-secret' }] },
      { ...request(), headers: [{ name: 'cookie', value: 'session=plaintext-secret' }] },
      { ...request(), headers: [{ name: 'x-api-key', value: 'plaintext-secret' }] },
      { ...request(), headers: [{ name: 'x-session-token', value: 'plaintext-secret' }] },
      { ...request(), headers: [{ name: 'x-test', value: 'ok\r\ninjected: yes' }] },
      { ...request(), headers: [{ name: 'x-test', value: 'ok\u0001unsafe' }] },
      { ...request(), bodyDigest: 'not-a-digest' },
      { ...request(), redirectPolicy: { mode: 'follow-approved', maxHops: 0, requestIds: [] } },
      { ...request(), unexpected: true },
    ]) expect(ReadHttpRequestSchema.safeParse(changed).success).toBe(false)
  })

  test('header 顺序、名称和 redirect requestId 都必须唯一且规范化', () => {
    expect(ReadHttpRequestSchema.safeParse({
      ...request(),
      headers: [
        { name: 'x-client-version', value: '1' },
        { name: 'accept', value: 'application/json' },
      ],
    }).success).toBe(false)
    expect(ReadHttpRequestSchema.safeParse({
      ...request(), headers: [{ name: 'accept', value: 'a' }, { name: 'accept', value: 'b' }],
    }).success).toBe(false)
    expect(ReadHttpRequestSchema.safeParse({
      ...request(), redirectPolicy: {
        mode: 'follow-approved', maxHops: 2,
        requestIds: ['REQUEST-REDIRECT-1', 'REQUEST-REDIRECT-1'],
      },
    }).success).toBe(false)
  })

  test('redirect 只能指向同一冻结集合中的另一条完整请求，集合 requestId 不得重复', () => {
    const redirected = {
      ...request(), requestId: 'REQUEST-REDIRECT-1', url: 'https://cdn.example.test/orders.json',
    }
    expect(validateReadHttpRequestSet([{
      ...request(), redirectPolicy: {
        mode: 'follow-approved' as const, maxHops: 1, requestIds: ['REQUEST-REDIRECT-1'],
      },
    }, redirected])).toHaveLength(2)
    expect(() => validateReadHttpRequestSet([{
      ...request(), redirectPolicy: {
        mode: 'follow-approved' as const, maxHops: 1, requestIds: ['REQUEST-MISSING'],
      },
    }])).toThrow('E2E_READ_HTTP_REDIRECT_REQUEST_UNKNOWN')
    expect(() => validateReadHttpRequestSet([request(), request()]))
      .toThrow('E2E_READ_HTTP_REQUEST_ID_DUPLICATE')
  })
})
