import { describe, expect, test } from 'vitest'
import {
  digestInjectionResponseBody,
  digestText,
  type InjectionApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, testApprovalReceipt } from './approval-authority.fixture.js'
import { LocalApprovalAuthority as RuntimeApprovalAuthority } from '../src/index.js'

const digest = digestText('test/v1', 'injection')
const responseBody = JSON.stringify({ code: 'UPSTREAM_FAILURE' })

function subject(): InjectionApprovalSubject {
  return {
    schemaVersion: '1.0.0', assetId: 'PRODUCT-PRD-1', prdRevision: digest,
    executionDigest: digest, environment: 'test', baseOrigin: 'https://test.example.com',
    actions: [{
      actionId: 'ACTION-INJECT-500', caseId: 'CASE-INJECT-500', runId: 'RUN-1', attemptSlot: 1,
      request: {
        intentId: 'INTENT-INJECT-500', method: 'POST', canonicalOrigin: 'https://test.example.com',
        exactPath: '/api/orders/search', query: [],
        payload: { kind: 'json', digest }, targetFingerprint: 'not-applicable', maxRequests: 1, expectedOrder: 1,
      },
      response: {
        kind: 'http-response', status: 500, headers: [{ name: 'content-type', value: 'application/json' }],
        body: { kind: 'utf8', value: responseBody, digest: digestInjectionResponseBody(responseBody) }, delayMs: 0,
      },
      expectedMatches: 1, expectedOrder: 1, upstreamForwarding: 'forbidden',
    }],
  }
}

describe('LocalApprovalAuthority injection grants', () => {
  test('signs the exact request, response template, run, case, and attempt slot', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const grant = await authority.issueInjectionGrant({
      subject: subject(), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })

    expect(await authority.verify(grant)).toMatchObject({ allowed: true })
    expect(await authority.verify({
      ...grant,
      capabilities: [{ ...grant.capabilities[0]!, expectedMatches: 2 }],
    })).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_SIGNATURE_INVALID' })
  })

  test('签发冻结请求后不再从调用方 getter 二次读取 TTL', async () => {
    const authority = RuntimeApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
      approvalIdentities: [{ subject: 'os-user:qa', roles: ['e2e-approver'] }],
      authenticateApproverSession: (sessionRef, expected) => sessionRef === 'approval-session'
        ? testApprovalReceipt('os-user:qa', expected) : undefined,
    })
    let ttlReads = 0
    const grant = await authority.issueInjectionGrant({
      subject: subject(), approver: { subject: 'os-user:qa', roles: ['e2e-approver'] },
      approvalSessionRef: 'approval-session',
      get ttlMs() { ttlReads += 1; return ttlReads === 1 ? 60_000 : 15 * 60_000 + 1 },
    })

    expect(ttlReads).toBe(1)
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(60_000)
  })

  test('rejects production injection and a response body whose digest does not match', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const production = { ...subject(), environment: 'production' } as unknown as InjectionApprovalSubject
    const invalidBody = subject()
    invalidBody.actions[0]!.response = {
      kind: 'http-response', status: 500, headers: [],
      body: { kind: 'utf8', value: 'changed', digest: digestInjectionResponseBody('original') }, delayMs: 0,
    }

    await expect(authority.issueInjectionGrant({
      subject: production, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_INJECTION_SCOPE_INVALID', retryable: false })
    await expect(authority.issueInjectionGrant({
      subject: invalidBody, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_INJECTION_RESPONSE_INVALID', retryable: false })
  })

  test('accepts the exact response body boundary but rejects oversized bodies and header injection', async () => {
    const authority = LocalApprovalAuthority.create({
      issuer: 'local-authority', keyId: 'local-key-1', now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const boundary = 'x'.repeat(64 * 1024)
    const atLimit = subject()
    atLimit.actions[0]!.response = {
      kind: 'http-response', status: 599, headers: [{ name: 'content-type', value: 'text/plain' }],
      body: { kind: 'utf8', value: boundary, digest: digestInjectionResponseBody(boundary) }, delayMs: 30_000,
    }
    await expect(authority.issueInjectionGrant({
      subject: atLimit, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).resolves.toMatchObject({ capabilities: [{ response: { status: 599, delayMs: 30_000 } }] })

    const oversized = `${boundary}x`
    const overLimit = subject()
    overLimit.actions[0]!.response = {
      kind: 'http-response', status: 500, headers: [],
      body: { kind: 'utf8', value: oversized, digest: digestInjectionResponseBody(oversized) }, delayMs: 0,
    }
    await expect(authority.issueInjectionGrant({
      subject: overLimit, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_INJECTION_RESPONSE_INVALID' })

    const headerInjection = subject()
    headerInjection.actions[0]!.response = {
      kind: 'http-response', status: 500,
      headers: [{ name: 'content-type', value: 'text/plain\r\nx-escaped: true' }],
      body: { kind: 'no-body' }, delayMs: 0,
    }
    await expect(authority.issueInjectionGrant({
      subject: headerInjection, approver: { subject: 'os-user:qa', roles: ['e2e-approver'] }, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_INJECTION_RESPONSE_INVALID' })
  })
})
