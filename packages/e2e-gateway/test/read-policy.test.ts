import { describe, expect, test } from 'vitest'
import { ReadOnlyGateway, canonicalizeHttpRequest } from '../src/index.js'

describe('canonicalizeHttpRequest', () => {
  test('normalizes origin, default port, dot segments, and unreserved encoding', () => {
    expect(canonicalizeHttpRequest({
      method: 'get',
      url: 'HTTPS://TEST.Example.COM:443/assets/../app/%7Eindex.js?lang=zh&lang=en',
    })).toEqual({
      method: 'GET',
      origin: 'https://test.example.com',
      path: '/app/~index.js',
      query: [['lang', 'zh'], ['lang', 'en']],
    })
  })

  test('rejects credentials, fragments, and invalid percent encoding', () => {
    expect(() => canonicalizeHttpRequest({ method: 'GET', url: 'https://user@test.example.com/app' })).toThrow()
    expect(() => canonicalizeHttpRequest({ method: 'GET', url: 'https://test.example.com/app#fragment' })).toThrow()
    expect(() => canonicalizeHttpRequest({ method: 'GET', url: 'https://test.example.com/%ZZ' })).toThrow()
  })
})

describe('ReadOnlyGateway', () => {
  test('forwards only a signed exact read intent within its maximum count', () => {
    const gateway = new ReadOnlyGateway({
      stage: 'bootstrap',
      intents: [{
        intentId: 'INTENT-APP-JS',
        stage: 'bootstrap',
        methods: ['GET'],
        origin: 'https://test.example.com',
        exactPath: '/app.js',
        query: [],
        maxRequests: 1,
      }],
    })

    expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/app.js' })).toMatchObject({ decision: 'forward' })
    expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/app.js' })).toMatchObject({
      decision: 'block',
      code: 'E2E_GATEWAY_MAX_REQUESTS_EXCEEDED',
    })
  })

  test('blocks unknown origins, undeclared business GETs, and non-read methods', () => {
    const gateway = new ReadOnlyGateway({ stage: 'case', intents: [] })

    expect(gateway.decide({ method: 'GET', url: 'https://evil.example.com/app.js' })).toMatchObject({ decision: 'block' })
    expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/api/orders' })).toMatchObject({
      decision: 'block',
      code: 'E2E_GATEWAY_INTENT_NOT_FOUND',
    })
    expect(gateway.decide({ method: 'POST', url: 'https://test.example.com/api/orders' })).toMatchObject({
      decision: 'block',
      code: 'E2E_GATEWAY_METHOD_NOT_READ_ONLY',
    })
  })

  test('does not reuse bootstrap intents after switching to the case stage', () => {
    const gateway = new ReadOnlyGateway({
      stage: 'bootstrap',
      intents: [{
        intentId: 'INTENT-DOCUMENT',
        stage: 'bootstrap',
        methods: ['GET'],
        origin: 'https://test.example.com',
        exactPath: '/',
        query: [],
        maxRequests: 1,
      }],
    })
    gateway.switchToCaseStage()

    expect(gateway.decide({ method: 'GET', url: 'https://test.example.com/' })).toMatchObject({
      decision: 'block',
      code: 'E2E_GATEWAY_INTENT_NOT_FOUND',
    })
  })
})
