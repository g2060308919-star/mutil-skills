import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { canonicalGrantApprovalSubjectDigest } from '@mutil-skills/e2e-contracts'
import { describe, expect, test, vi } from 'vitest'
import { LocalApprovalAuthority } from '../src/local-approval-authority.js'
import { createWebAuthnUserPresenceAuthority } from '../src/webauthn-user-presence.js'
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

type CallerBindingAbsent<T> = 'approvalSessionBinding' extends keyof T ? never : false
const discoveryBindingAbsent: CallerBindingAbsent<Parameters<LocalApprovalAuthority['issueDiscoveryGrant']>[0]> = false
const readBindingAbsent: CallerBindingAbsent<Parameters<LocalApprovalAuthority['issueReadGrant']>[0]> = false
const writeBindingAbsent: CallerBindingAbsent<Parameters<LocalApprovalAuthority['issueWriteGrant']>[0]> = false
const injectionBindingAbsent: CallerBindingAbsent<Parameters<LocalApprovalAuthority['issueInjectionGrant']>[0]> = false
const webSocketBindingAbsent: CallerBindingAbsent<Parameters<LocalApprovalAuthority['issueWebSocketReadGrant']>[0]> = false
const sseBindingAbsent: CallerBindingAbsent<Parameters<LocalApprovalAuthority['issueSseReadGrant']>[0]> = false
const allGrantInputsDeriveReceiptBindingInternally: [false, false, false, false, false, false] = [
  discoveryBindingAbsent, readBindingAbsent, writeBindingAbsent,
  injectionBindingAbsent, webSocketBindingAbsent, sseBindingAbsent,
]

describe('WebAuthn user presence authority', () => {
  test('all six grant seams omit caller-controlled receipt bindings', () => {
    expect(allGrantInputsDeriveReceiptBindingInternally).toEqual([false, false, false, false, false, false])
  })
  test('does not export test credential or verifier seams from the package entrypoint', () => {
    expect(publicAuthorityApi).not.toHaveProperty('createWebAuthnUserPresenceAuthorityForTest')
    expect(publicAuthorityApi).not.toHaveProperty('registerTestCredential')
    expect(() => new (publicAuthorityApi.WebAuthnUserPresenceAuthority as any)({
      now: () => fixedNow,
      credentialRepository: {
        list: async () => [], get: async () => undefined, insert: async () => undefined,
        compareAndSet: async () => undefined,
      },
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

    await fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'valid-assertion',
    })
    await expect(fixture.authority.authenticateSession(session.sessionId)).resolves.toMatchObject({
      subject: 'local:user', runId: 'RUN-1', approvalType: 'execution', subjectDigest,
      installationDigest, origin: 'http://localhost:43210',
    })
    await expect(fixture.authority.authenticateSession(session.sessionId)).resolves.toBeUndefined()
    expect(fixture.readCredential('CRED-1')?.counter).toBe(2)
    await expect(fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'valid-assertion',
    })).rejects.toThrow(/E2E_APPROVAL_SESSION_CONSUMED/)
  })

  test('concurrent assertions for one credential use an atomic counter CAS', async () => {
    let verificationCalls = 0
    let release!: () => void
    const bothVerifying = new Promise<void>((resolve) => { release = resolve })
    const fixture = createForTest({
      now: () => fixedNow,
      verifyAuthentication: async () => {
        verificationCalls += 1
        if (verificationCalls === 2) release()
        await bothVerifying
        return { verified: true, newCounter: 2 }
      },
    }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 1 })
    const sessions = await Promise.all(['RUN-1', 'RUN-2'].map(async (runId) =>
      await fixture.authority.beginApproval({
        runId, approvalType: 'execution', subjectDigest,
        installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
      })))

    const results = await Promise.allSettled(sessions.map(async (session) =>
      await fixture.authority.completeApproval({
        sessionId: session.sessionId, challenge: session.challenge,
        credentialId: 'CRED-1', response: 'valid-assertion',
      })))

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'E2E_APPROVAL_CREDENTIAL_STATE_CONFLICT' },
    })
    expect(fixture.readCredential('CRED-1')?.counter).toBe(2)
  })

  test('grant issuance atomically consumes a receipt only when every expected binding field matches', async () => {
    const fixture = createForTest({
      now: () => fixedNow,
      verifyAuthentication: async (input) => ({
        verified: true,
        newCounter: Number(input.credential.counter) + 1,
      }),
    }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
    const approver = { subject: 'local:user', roles: ['e2e-approver'] }
    const authority = LocalApprovalAuthority.create({
      issuer: 'authority', keyId: 'key-1', now: () => fixedNow,
      approvalIdentities: [approver],
      authenticateApproverSession: (sessionId) => fixture.authority.authenticateSession(sessionId),
    })
    const approvalSubject = {
      schemaVersion: '1.0.0' as const,
      assetId: 'ASSET-1', prdRevision: subjectDigest, scopeDigest: installationDigest,
      environment: 'test' as const, baseOrigin: 'https://test.example.com', actor: 'qa',
      expectedPageIdentity: {
        url: 'https://test.example.com/orders', title: 'Orders', heading: 'Orders', ariaSignals: [],
      },
      bootstrapIntentsDigest: subjectDigest,
      actions: [{ actionId: 'ACTION-1', operation: 'dom-read' as const, maxUses: 1 as const }],
    }
    const approvalSubjectDigest = canonicalGrantApprovalSubjectDigest(approvalSubject)
    const openAndComplete = async (runId: string) => {
      const session = await fixture.authority.beginApproval({
        runId, approvalType: 'discovery', subjectDigest: approvalSubjectDigest,
        installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
      })
      await fixture.authority.completeApproval({
        sessionId: session.sessionId, challenge: session.challenge,
        credentialId: 'CRED-1', response: 'valid-assertion',
      })
      return {
        session,
        binding: {
          subject: approver.subject, runId, approvalType: 'discovery' as const,
          subjectDigest: approvalSubjectDigest, installationDigest, origin: 'http://localhost:43210',
        },
      }
    }

    const wrongGrantSubject = {
      ...approvalSubject,
      expectedPageIdentity: { ...approvalSubject.expectedPageIdentity, heading: 'Different order' },
    }
    const subjectMismatch = await openAndComplete('RUN-SUBJECT-MISMATCH')
    await expect(authority.issueDiscoveryGrant({
      subject: wrongGrantSubject, approver, approvalSessionRef: subjectMismatch.session.sessionId,
      approvalSessionBinding: subjectMismatch.binding, ttlMs: 60_000,
    } as Parameters<typeof authority.issueDiscoveryGrant>[0])).rejects.toMatchObject({
      code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH',
    })

    const valid = await openAndComplete('RUN-VALID')
    await expect(authority.issueDiscoveryGrant({
      subject: approvalSubject, approver, approvalSessionRef: valid.session.sessionId,
      ttlMs: 60_000,
    })).resolves.toMatchObject({ approver })
    await expect(authority.issueDiscoveryGrant({
      subject: approvalSubject, approver, approvalSessionRef: valid.session.sessionId,
      ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_APPROVER_UNTRUSTED' })
  })

  test('completed receipt expires at the original challenge deadline and cannot be retried', async () => {
    let now = fixedNow
    const fixture = createForTest({
      now: () => now,
      verifyAuthentication: async () => ({ verified: true, newCounter: 1 }),
    }, verificationMocks)
    fixture.registerTestCredential({ subject: 'local:user', credentialId: 'CRED-1', counter: 0 })
    const session = await fixture.authority.beginApproval({
      runId: 'RUN-EXPIRING', approvalType: 'scope', subjectDigest,
      installationDigest, origin: 'http://localhost:43210', ttlMs: 10,
    })
    await fixture.authority.completeApproval({
      sessionId: session.sessionId, challenge: session.challenge,
      credentialId: 'CRED-1', response: 'valid',
    })
    now = new Date(fixedNow.getTime() + 11)
    await expect(fixture.authority.authenticateSession(session.sessionId))
      .rejects.toThrow(/E2E_APPROVAL_SESSION_EXPIRED/)
    await expect(fixture.authority.authenticateSession(session.sessionId)).resolves.toBeUndefined()
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

  test('concurrent registration of the same credential is atomically rejected as duplicate', async () => {
    let calls = 0
    let release!: () => void
    const bothVerifying = new Promise<void>((resolve) => { release = resolve })
    const fixture = createForTest({
      now: () => fixedNow,
      verifyRegistration: async () => {
        calls += 1
        if (calls === 2) release()
        await bothVerifying
        return {
          verified: true,
          credential: { id: 'CRED-SAME', publicKey: new Uint8Array([4, 5, 6]), counter: 1 },
        }
      },
    }, verificationMocks)
    const sessions = await Promise.all(['local:first', 'local:second'].map(async (subject) =>
      await fixture.authority.beginEnrollment({
        subject, origin: 'http://localhost:43210', ttlMs: 300_000,
      })))

    const results = await Promise.allSettled(sessions.map(async (session) =>
      await fixture.authority.completeEnrollment({
        sessionId: session.sessionId, challenge: session.challenge, response: {},
      })))

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'E2E_APPROVAL_CREDENTIAL_DUPLICATE' } },
    ])
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
      await authority.createWebAuthnCredentialRepository().insert({
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

  test('已完成人机审批的完整回执跨 Authority 重启持久化，并在 Grant 提交中仅消费一次', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-webauthn-receipt-state-'))
    const statePath = join(directory, 'authority.sqlite')
    const stateEncryptionKey = randomBytes(32)
    const approver = { subject: 'local:user', roles: ['e2e-approver'] }
    let authorityNow = fixedNow
    const options = {
      issuer: 'authority', keyId: 'key-1', now: () => authorityNow, statePath, stateEncryptionKey,
      testWorkspaceRoots: [process.cwd()], approvalIdentities: [approver],
    }
    const grantSubject = {
      schemaVersion: '1.0.0' as const, assetId: 'ASSET-1', prdRevision: subjectDigest,
      scopeDigest: installationDigest, environment: 'test' as const,
      baseOrigin: 'https://test.example.com', actor: 'qa',
      expectedPageIdentity: {
        url: 'https://test.example.com/orders', title: 'Orders', heading: 'Orders', ariaSignals: [],
      },
      bootstrapIntentsDigest: subjectDigest,
      actions: [{ actionId: 'ACTION-1', operation: 'dom-read' as const, maxUses: 1 as const }],
    }
    const grantSubjectDigest = canonicalGrantApprovalSubjectDigest(grantSubject)
    const approvalBinding = {
      runId: 'RUN-PERSISTED', approvalType: 'discovery' as const,
      subjectDigest: grantSubjectDigest, installationDigest,
    }
    const finalizationId = 'FINALIZE-PERSISTED-1'
    const requestDigest = `sha256:${'f'.repeat(64)}`
    try {
      verificationMocks.authentication.mockImplementation(async (input: Record<string, any>) => ({
        verified: true,
        authenticationInfo: { newCounter: Number(input.credential.counter) + 1 },
      }))
      const first = await LocalApprovalAuthority.open(options)
      const firstRepository = first.createWebAuthnCredentialRepository()
      await firstRepository.insert({
        id: 'CRED-PERSISTED', publicKey: Buffer.from('PUBLIC-KEY').toString('base64url'),
        counter: 0, transports: ['internal'], subject: approver.subject,
      })
      const firstPresence = createWebAuthnUserPresenceAuthority({
        now: () => fixedNow, credentialRepository: firstRepository,
      })
      const session = await firstPresence.beginApproval({
        runId: 'RUN-PERSISTED', approvalType: 'discovery', subjectDigest: grantSubjectDigest,
        installationDigest, origin: 'http://localhost:43210', ttlMs: 300_000,
      })
      await firstPresence.completeApproval({
        sessionId: session.sessionId, challenge: session.challenge,
        credentialId: 'CRED-PERSISTED', response: {},
      })
      first.close()

      const rawState = await readFile(statePath)
      expect(rawState.includes(Buffer.from('RUN-PERSISTED'))).toBe(false)
      expect(rawState.includes(Buffer.from(grantSubjectDigest))).toBe(false)

      let secondPresence: ReturnType<typeof createWebAuthnUserPresenceAuthority>
      const second = await LocalApprovalAuthority.open({
        ...options,
        authenticateApproverSession: (sessionId) => secondPresence.authenticateSession(sessionId),
      })
      secondPresence = createWebAuthnUserPresenceAuthority({
        now: () => fixedNow, credentialRepository: second.createWebAuthnCredentialRepository(),
      })
      const [grant, concurrentGrant] = await Promise.all([0, 1].map(async () =>
        await second.finalizeApprovalGrant({
          subject: grantSubject, approvalSessionRef: session.sessionId, ttlMs: 60_000,
          finalizationId, requestDigest, approvalBinding,
        })))
      expect(concurrentGrant).toEqual(grant)
      const registerEphemeralGrant = vi.fn((_context: unknown) => {
        throw Object.assign(new Error('simulated ephemeral registration failure'), {
          code: 'E2E_RPC_REGISTRATION_FAILED',
        })
      })
      expect(() => registerEphemeralGrant(grant.approvalContext))
        .toThrow('simulated ephemeral registration failure')
      second.close()

      const third = await LocalApprovalAuthority.open(options)
      await expect(third.recoverFinalizedGrant({
        finalizationId, requestDigest, subject: grantSubject, approvalBinding,
      })).resolves.toEqual({ grant, approvalSessionRef: session.sessionId })
      await expect(third.finalizeApprovalGrant({
        subject: grantSubject, approvalSessionRef: session.sessionId, ttlMs: 60_000,
        finalizationId, requestDigest, approvalBinding,
      })).resolves.toEqual(grant)
      await expect(third.finalizeApprovalGrant({
        subject: grantSubject, approvalSessionRef: 'SESSION-REBOUND', ttlMs: 60_000,
        finalizationId, requestDigest, approvalBinding,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_FINALIZATION_MISMATCH' })
      await expect(third.recoverFinalizedGrant({
        finalizationId, requestDigest: `sha256:${'e'.repeat(64)}`,
        subject: grantSubject, approvalBinding,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_FINALIZATION_MISMATCH' })
      await expect(third.activatePersistedGrant({ grant, approvalBinding })).resolves.toEqual(
        grant.approvalContext,
      )
      await expect(third.activatePersistedGrant({
        grant, approvalBinding: { ...approvalBinding, runId: 'RUN-REBOUND' },
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' })
      await expect(third.activatePersistedGrant({
        grant: { ...grant, injected: true } as never, approvalBinding,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_GRANT_INVALID' })
      authorityNow = new Date(fixedNow.getTime() + 120_000)
      await expect(third.activatePersistedGrant({ grant, approvalBinding }))
        .rejects.toMatchObject({ code: 'E2E_APPROVAL_EXPIRED' })
      authorityNow = fixedNow
      await third.revoke(grant.grantId, 'test-revocation')
      await expect(third.activatePersistedGrant({ grant, approvalBinding }))
        .rejects.toMatchObject({ code: 'E2E_APPROVAL_REVOKED' })
      expect(grant.approvalContext).toMatchObject({
        subject: approver.subject, runId: 'RUN-PERSISTED', approvalType: 'discovery',
        subjectDigest: grantSubjectDigest, installationDigest, origin: 'http://localhost:43210',
      })
      third.close()

      let fourthPresence: ReturnType<typeof createWebAuthnUserPresenceAuthority>
      const fourth = await LocalApprovalAuthority.open({
        ...options,
        authenticateApproverSession: (sessionId) => fourthPresence.authenticateSession(sessionId),
      })
      fourthPresence = createWebAuthnUserPresenceAuthority({
        now: () => fixedNow, credentialRepository: fourth.createWebAuthnCredentialRepository(),
      })
      await expect(fourth.finalizeApprovalGrant({
        subject: grantSubject, approvalSessionRef: session.sessionId, ttlMs: 60_000,
        finalizationId: 'FINALIZE-PERSISTED-2', requestDigest, approvalBinding,
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_APPROVER_UNTRUSTED' })
      fourth.close()
    } finally {
      stateEncryptionKey.fill(0)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
