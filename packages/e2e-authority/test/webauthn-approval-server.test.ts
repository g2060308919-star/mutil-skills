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
    const root = await fetch(server.url)
    expect(root.status).toBe(200)
    expect(Buffer.from(await root.arrayBuffer())).toEqual(assets.indexHtml)
    expect(root.headers.get('cache-control')).toBe('no-store')
    expect(root.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(root.headers.get('set-cookie')).toMatch(/^e2e_approval=[A-Za-z0-9_-]{43};/)
    const approval = await fetch(`${server.origin}/approval.js`, { headers: cookieHeader(server.url) })
    const bundle = await fetch(`${server.origin}/simplewebauthn-browser.js`, { headers: cookieHeader(server.url) })
    expect(Buffer.from(await approval.arrayBuffer())).toEqual(assets.approvalJavaScript)
    expect(Buffer.from(await bundle.arrayBuffer())).toEqual(assets.simpleWebAuthnBrowser)
    expect(new URL(server.url).hash.length).toBeGreaterThan(40)
    expect(decodeFragment(server.url)).toMatchObject({
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
    const payload = decodeFragment(server.url)
    expect((await fetch(`${server.origin}/submit`, {
      method: 'POST', headers: { origin: server.origin, cookie: 'e2e_approval=wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: server.sessionId, challenge: payload.challenge, response: {} }),
    })).status).toBe(401)
    expect((await fetch(`${server.origin}/submit`, {
      method: 'POST', headers: { origin: 'http://localhost:9', ...cookieHeader(server.url),
        'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: server.sessionId, challenge: payload.challenge, response: {} }),
    })).status).toBe(403)
    expect((await fetch(`${server.origin}/submit`, {
      method: 'POST', headers: { origin: server.origin, ...cookieHeader(server.url),
        'content-type': 'application/json', 'content-length': String(65 * 1024) },
      body: 'x'.repeat(65 * 1024),
    })).status).toBe(413)
  } finally {
    await server.close()
  }
})

test('accepts exactly one POST and rejects expiration and a second submission', async ({ skip }) => {
  let now = new Date('2026-07-16T00:00:00.000Z')
  const fixture = createForTest({
    now: () => now,
    verifyAuthentication: async () => ({ verified: true, newCounter: 1 }),
  }, verificationMocks)
  fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
  const expired = await startOrSkip({
    authority: fixture.authority, assets, ttlMs: 1,
    session: { kind: 'approval', runId: 'RUN-1', approvalType: 'execution',
      subjectDigest, installationDigest },
  }, skip)
  if (expired === undefined) return
  const expiredPayload = decodeFragment(expired.url)
  now = new Date(now.getTime() + 2)
  try {
    expect((await submit(expired, expiredPayload)).status).toBe(410)
  } finally { await expired.close() }

  now = new Date('2026-07-16T00:00:00.000Z')
  const server = await startWebAuthnApprovalServer({
    authority: fixture.authority, assets, ttlMs: 300_000,
    session: { kind: 'approval', runId: 'RUN-2', approvalType: 'scope',
      subjectDigest, installationDigest },
  })
  const payload = decodeFragment(server.url)
  try {
    expect((await submit(server, payload)).status).toBe(204)
    await expect(server.completion).resolves.toEqual({ completed: true })
    expect((await submit(server, payload)).status).toBe(409)
  } finally { await server.close() }
})

function cookieHeader(url: string): Record<string, string> {
  return { cookie: `e2e_approval=${new URL(url).searchParams.get('bearer')}` }
}

function decodeFragment(url: string): Record<string, any> {
  return JSON.parse(Buffer.from(new URL(url).hash.slice(1), 'base64url').toString('utf8'))
}

async function submit(
  server: { origin: string; url: string; sessionId: string },
  payload: Record<string, any>,
) {
  return await fetch(`${server.origin}/submit`, {
    method: 'POST',
    headers: { origin: server.origin, ...cookieHeader(server.url), 'content-type': 'application/json' },
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
