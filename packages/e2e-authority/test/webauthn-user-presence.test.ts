import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { LocalApprovalAuthority } from '../src/local-approval-authority.js'
import * as publicAuthorityApi from '../src/index.js'
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
const fixedNow = new Date('2026-07-16T00:00:00.000Z')

describe('WebAuthn user presence authority', () => {
  test('does not export test credential or verifier seams from the package entrypoint', () => {
    expect(publicAuthorityApi).not.toHaveProperty('createWebAuthnUserPresenceAuthorityForTest')
    expect(publicAuthorityApi).not.toHaveProperty('registerTestCredential')
    expect(() => new (publicAuthorityApi.WebAuthnUserPresenceAuthority as any)({
      now: () => fixedNow,
      credentialRepository: { list: async () => [], get: async () => undefined, put: async () => undefined },
      verifyAuthentication: async () => ({ verified: true, newCounter: 0 }),
    })).toThrow(/E2E_APPROVAL_AUTHORITY_CONSTRUCTION_INVALID/)
  })
  test('authentication session is one-time and bound to the approval subject', async () => {
    const fixture = createForTest({
      now: () => fixedNow,
      verifyAuthentication: async (input) => ({
        verified: input.response === 'valid-assertion'
          && input.requireUserVerification
          && input.expectedOrigin === 'http://localhost:43210'
          && input.expectedRPID === 'localhost',
        newCounter: 2,
      }),
    }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 1 })
    const session = await fixture.authority.beginApproval({
      runId: 'RUN-1', approvalType: 'execution', subjectDigest,
      installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
    })

    const sessionRef = await fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'valid-assertion',
    })
    expect(fixture.authority.authenticateSession(sessionRef)).toBe('local:user')
    expect(fixture.authority.authenticateSession(sessionRef)).toBeUndefined()
    expect(fixture.readCredential('CRED-1')?.counter).toBe(2)
    await expect(fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'valid-assertion',
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_CONSUMED/)
  })

  test('rejects a response without verified user presence and consumes the challenge', async () => {
    const fixture = createForTest({
      now: () => fixedNow,
      verifyAuthentication: async () => ({ verified: false, newCounter: 0 }),
    }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
    const session = await fixture.authority.beginApproval({
      runId: 'RUN-1', approvalType: 'scope', subjectDigest,
      installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
    })
    await expect(fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'no-user-verification',
    })).rejects.toThrow(/E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE/)
    await expect(fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'no-user-verification',
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_CONSUMED/)
  })

  test('rejects challenge, subject, origin, TTL and expiry mismatches', async () => {
    let now = fixedNow
    const fixture = createForTest({
      now: () => now,
      verifyAuthentication: async () => ({ verified: true, newCounter: 1 }),
    }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
    await expect(fixture.authority.beginApproval({
      runId: 'RUN-1', approvalType: 'scope', subjectDigest,
      installationDigest, origin: 'https://localhost:43210', ttlMs: 300_001,
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_INVALID/)

    const mismatch = await fixture.authority.beginApproval({
      runId: 'RUN-1', approvalType: 'scope', subjectDigest,
      installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
    })
    await expect(fixture.authority.completeApproval({
      sessionId: mismatch.sessionId, challenge: 'wrong', credentialId: 'CRED-1', response: 'valid',
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_BINDING_MISMATCH/)

    const expired = await fixture.authority.beginApproval({
      runId: 'RUN-2', approvalType: 'execution', subjectDigest,
      installationDigest, origin: 'http://localhost:43210', ttlMs: 1,
    })
    now = new Date(fixedNow.getTime() + 2)
    await expect(fixture.authority.completeApproval({
      sessionId: expired.sessionId, challenge: expired.challenge,
      credentialId: 'CRED-1', response: 'valid',
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_EXPIRED/)
  })

  test('registration requires UV, fixed algorithms, and persists the complete credential state', async () => {
    const fixture = createForTest({
      now: () => fixedNow,
      verifyRegistration: async (input) => ({
        verified: input.requireUserVerification
          && input.expectedRPID === 'localhost'
          && input.expectedOrigin === 'http://localhost:43210'
          && input.supportedAlgorithmIDs.join(',') === '-7,-257',
        credential: {
          id: 'CRED-NEW', publicKey: new Uint8Array([9, 8, 7]), counter: 4, transports: ['internal'],
        },
      }),
    }, verificationMocks)
    const session = await fixture.authority.beginEnrollment({
      subject: 'local:user', origin: 'http://localhost:43210', ttlMs: 300_000,
    })
    expect(session.options.attestation).toBe('none')
    expect(session.options.authenticatorSelection?.userVerification).toBe('required')
    expect(session.options.pubKeyCredParams.map((item) => item.alg)).toEqual([-7, -257])
    await fixture.authority.completeEnrollment({
      sessionId: session.sessionId,
      challenge: session.challenge,
      response: { response: { transports: ['internal'] } },
    })
    expect(fixture.readCredential('CRED-NEW')).toMatchObject({
      id: 'CRED-NEW', counter: 4, transports: ['internal'], subject: 'local:user',
    })
  })

  test('shutdown revokes every unconsumed challenge', async () => {
    const fixture = createForTest({ now: () => fixedNow }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
    const session = await fixture.authority.beginApproval({
      runId: 'RUN-1', approvalType: 'privacy', subjectDigest,
      installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
    })
    fixture.authority.revokePendingSessions()
    await expect(fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'valid',
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_CONSUMED/)
  })

  test('credential state is encrypted inside the persistent Authority snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-webauthn-state-'))
    const statePath = join(directory, 'authority.sqlite')
    const stateEncryptionKey = randomBytes(32)
    const options = {
      issuer: 'authority', keyId: 'key-1', now: () => fixedNow, statePath, stateEncryptionKey,
      testWorkspaceRoots: [process.cwd()],
      approvalIdentities: [{ subject: 'local:user', roles: ['e2e-approver'] }],
    }
    try {
      const authority = await LocalApprovalAuthority.open(options)
      await authority.createWebAuthnCredentialRepository().put({
        id: 'CRED-SECRET', publicKey: Buffer.from('PUBLIC-KEY-SECRET').toString('base64url'),
        counter: 7, transports: ['internal'], subject: 'local:user',
      })
      authority.close()

      const rawState = await readFile(statePath)
      expect(rawState.includes(Buffer.from('CRED-SECRET'))).toBe(false)
      expect(rawState.includes(Buffer.from('PUBLIC-KEY-SECRET'))).toBe(false)
      expect(rawState.includes(Buffer.from('local:user'))).toBe(false)

      const reopened = await LocalApprovalAuthority.open(options)
      await expect(reopened.createWebAuthnCredentialRepository().get('CRED-SECRET')).resolves.toEqual({
        id: 'CRED-SECRET', publicKey: Buffer.from('PUBLIC-KEY-SECRET').toString('base64url'),
        counter: 7, transports: ['internal'], subject: 'local:user',
      })
      reopened.close()
    } finally {
      stateEncryptionKey.fill(0)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
