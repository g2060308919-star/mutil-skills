import { expect, test, vi } from 'vitest'
import {
  isLoopbackApprovalClientAddress,
  startWebAuthnApprovalServer,
} from '../src/webauthn-approval-server.js'
import { createForTest } from './webauthn-user-presence.fixture.js'

const verificationMocks = vi.hoisted(() => ({ registration: vi.fn(), authentication: vi.fn() }))
vi.mock('@simplewebauthn/server', async () => {
  const actual = await vi.importActual<typeof import('@simplewebauthn/server')>('@simplewebauthn/server')
  return {
    ...actual,
    verifyRegistrationResponse: (input: unknown) => verificationMocks.registration(input),
    verifyAuthenticationResponse: (input: unknown) => verificationMocks.authentication(input),
  }
})

const installationDigest = `sha256:${'a'.repeat(64)}`
const subjectDigest = `sha256:${'b'.repeat(64)}`
const assets = {
  indexHtml: Buffer.from('<!doctype html><main id="summary"></main>'),
  approvalJavaScript: Buffer.from('globalThis.approvalLoaded=true'),
  simpleWebAuthnBrowser: Buffer.from('globalThis.SimpleWebAuthnBrowser={}'),
}

test('serves only local immutable assets with no-store and a strict CSP', async ({ skip }) => {
  const fixture = createForTest({ now: () => new Date('2026-07-16T00:00:00.000Z') }, verificationMocks)
  const server = await startOrSkip({
    authority: fixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'enrollment', subject: 'local:user' },
  }, skip)
  if (server === undefined) return
  try {
    expect(new URL(server.url).search).toBe('')
    expect(fragmentBearer(server.url)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const root = await fetch(server.url)
    expect(root.status).toBe(200)
    expect(Buffer.from(await root.arrayBuffer())).toEqual(assets.indexHtml)
    expect(root.headers.get('cache-control')).toBe('no-store')
    expect(root.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(root.headers.get('set-cookie')).toBeNull()
    const approval = await fetch(`${server.origin}/approval.js`)
    const bundle = await fetch(`${server.origin}/simplewebauthn-browser.js`)
    expect(Buffer.from(await approval.arrayBuffer())).toEqual(assets.approvalJavaScript)
    expect(Buffer.from(await bundle.arrayBuffer())).toEqual(assets.simpleWebAuthnBrowser)
    const sessionResponse = await fetch(`${server.origin}/session`, { headers: bearerHeader(server.url) })
    expect(sessionResponse.status).toBe(200)
    expect(await sessionResponse.json()).toMatchObject({
      kind: 'enrollment', sessionId: server.sessionId,
      summary: expect.stringContaining('local:user'),
    })
  } finally {
    await server.close()
  }
})

test('rejects non-loopback clients, wrong origin, wrong bearer and bodies above 64 KiB', async ({ skip }) => {
  expect(isLoopbackApprovalClientAddress('127.0.0.1')).toBe(true)
  expect(isLoopbackApprovalClientAddress('::ffff:127.0.0.1')).toBe(true)
  expect(isLoopbackApprovalClientAddress('192.168.1.10')).toBe(false)
  const fixture = createForTest({
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    verifyRegistration: async () => ({ verified: false }),
  }, verificationMocks)
  const server = await startOrSkip({
    authority: fixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'enrollment', subject: 'local:user' },
  }, skip)
  if (server === undefined) return
  try {
    const payload = await readSession(server)
    const bearer = fragmentBearer(server.url)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const lastIndex = alphabet.indexOf(bearer.at(-1)!)
    const nonCanonicalAlias = `${bearer.slice(0, -1)}${alphabet[lastIndex + 1]}`
    expect(Buffer.from(nonCanonicalAlias, 'base64url')).toEqual(Buffer.from(bearer, 'base64url'))
    expect((await fetch(`${server.origin}/session`, {
      headers: { authorization: `Bearer ${nonCanonicalAlias}` },
    })).status).toBe(401)
    expect((await fetch(`${server.origin}/submit`, {
      method: 'POST', headers: {
        origin: server.origin, authorization: 'Bearer wrong', 'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: server.sessionId, challenge: payload.challenge, response: {} }),
    })).status).toBe(401)
    expect((await fetch(`${server.origin}/submit`, {
      method: 'POST', headers: { origin: 'http://localhost:9', ...bearerHeader(server.url),
        'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: server.sessionId, challenge: payload.challenge, response: {} }),
    })).status).toBe(403)
    expect((await fetch(`${server.origin}/submit`, {
      method: 'POST', headers: { origin: server.origin, ...bearerHeader(server.url),
        'content-type': 'application/json', 'content-length': String(65 * 1024) },
      body: 'x'.repeat(65 * 1024),
    })).status).toBe(413)
  } finally {
    await server.close()
  }
})

test('fragment bearer is isolated across concurrent localhost sessions', async ({ skip }) => {
  const firstFixture = createForTest({ now: () => new Date() }, verificationMocks)
  const secondFixture = createForTest({ now: () => new Date() }, verificationMocks)
  const first = await startOrSkip({
    authority: firstFixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'enrollment', subject: 'local:first' },
  }, skip)
  if (first === undefined) return
  const second = await startWebAuthnApprovalServer({
    authority: secondFixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'enrollment', subject: 'local:second' },
  })
  try {
    expect(new URL(first.url).port).not.toBe(new URL(second.url).port)
    expect(fragmentBearer(first.url)).not.toBe(fragmentBearer(second.url))
    expect((await fetch(`${second.origin}/session`, { headers: bearerHeader(first.url) })).status).toBe(401)
    expect((await fetch(`${second.origin}/session`, { headers: bearerHeader(second.url) })).status).toBe(200)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('monotonic TTL expiration and explicit close always settle completion and stop the server', async ({ skip }) => {
  const fixture = createForTest({ now: () => new Date() }, verificationMocks)
  const expired = await startOrSkip({
    authority: fixture.authority, assets, ttlMs: 20,
    session: { kind: 'enrollment', subject: 'local:user' },
  }, skip)
  if (expired === undefined) return
  await expect(Promise.race([
    expired.completion,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 250)),
  ])).resolves.toEqual({ completed: false, code: 'E2E_APPROVAL_SESSION_EXPIRED' })
  await expect(fetch(expired.origin)).rejects.toThrow()

  const cancelled = await startWebAuthnApprovalServer({
    authority: fixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'enrollment', subject: 'local:user' },
  })
  await cancelled.close()
  await expect(cancelled.completion).resolves.toEqual({
    completed: false, code: 'E2E_APPROVAL_SESSION_CANCELLED',
  })
})

test('accepts exactly one POST and rejects a second submission', async ({ skip }) => {
  let now = new Date('2026-07-16T00:00:00.000Z')
  const fixture = createForTest({
    now: () => now,
    verifyAuthentication: async () => ({ verified: true, newCounter: 1 }),
  }, verificationMocks)
  fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
  const server = await startOrSkip({
    authority: fixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'approval', runId: 'RUN-2', approvalType: 'scope',
      subjectDigest, installationDigest },
  }, skip)
  if (server === undefined) return
  const payload = await readSession(server)
  try {
    expect((await submit(server, payload)).status).toBe(204)
    await expect(server.completion).resolves.toEqual({ completed: true })
    expect((await submit(server, payload)).status).toBe(401)
  } finally { await server.close() }
})

function bearerHeader(url: string): Record<string, string> {
  return { authorization: `Bearer ${fragmentBearer(url)}` }
}

function fragmentBearer(url: string): string {
  return new URL(url).hash.slice(1)
}

async function readSession(server: { origin: string; url: string }): Promise<Record<string, any>> {
  const response = await fetch(`${server.origin}/session`, { headers: bearerHeader(server.url) })
  expect(response.status).toBe(200)
  return await response.json()
}

async function submit(
  server: { origin: string; url: string; sessionId: string },
  payload: Record<string, any>,
) {
  return await fetch(`${server.origin}/submit`, {
    method: 'POST',
    headers: { origin: server.origin, ...bearerHeader(server.url), 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: server.sessionId, challenge: payload.challenge,
      credentialId: 'CRED-1', response: 'valid',
    }),
  })
}

async function startOrSkip(
  options: Parameters<typeof startWebAuthnApprovalServer>[0],
  skip: (note?: string) => never,
) {
  try {
    return await startWebAuthnApprovalServer(options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      skip('当前 sandbox 禁止绑定 127.0.0.1；loopback 套件在可绑定环境运行')
    }
    throw error
  }
}
