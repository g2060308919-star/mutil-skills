import type { AuthenticatorTransportFuture, WebAuthnCredential } from '@simplewebauthn/server'
import {
  createWebAuthnUserPresenceAuthority,
  type StoredWebAuthnCredential,
  type StoredWebAuthnApprovalReceipt,
} from '../src/webauthn-user-presence.js'

interface TestRegistrationResult {
  verified: boolean
  credential?: {
    id: string
    publicKey: Uint8Array
    counter: number
    transports?: AuthenticatorTransportFuture[]
  }
}

interface TestAuthenticationResult { verified: boolean; newCounter: number }

interface TestVerificationOptions {
  now(): Date
  verifyRegistration?(input: Record<string, any>): Promise<TestRegistrationResult>
  verifyAuthentication?(input: Record<string, any>): Promise<TestAuthenticationResult>
}

export interface TestVerificationMocks {
  registration: { mockImplementation(implementation: (input: Record<string, any>) => Promise<unknown>): void }
  authentication: { mockImplementation(implementation: (input: Record<string, any>) => Promise<unknown>): void }
}

export function createForTest(
  dependencies: TestVerificationOptions,
  verificationMocks: TestVerificationMocks,
) {
  const credentials = new Map<string, StoredWebAuthnCredential>()
  const receipts = new Map<string, StoredWebAuthnApprovalReceipt>()
  verificationMocks.registration.mockImplementation(async (input: Record<string, any>) => {
    const result = await (dependencies.verifyRegistration?.(input) ?? Promise.resolve({ verified: false }))
    if (!result.verified || result.credential === undefined) return { verified: false }
    return {
      verified: true,
      registrationInfo: {
        fmt: 'none', aaguid: '00000000-0000-0000-0000-000000000000',
        credential: result.credential as WebAuthnCredential,
        credentialType: 'public-key', attestationObject: new Uint8Array(), userVerified: true,
        credentialDeviceType: 'singleDevice', credentialBackedUp: false,
        origin: input.expectedOrigin, rpID: input.expectedRPID,
      },
    }
  })
  verificationMocks.authentication.mockImplementation(async (input: Record<string, any>) => {
    const result = await (dependencies.verifyAuthentication?.(input)
      ?? Promise.resolve({ verified: false, newCounter: input.credential?.counter ?? 0 }))
    return {
      verified: result.verified,
      authenticationInfo: {
        credentialID: input.credential?.id ?? '', newCounter: result.newCounter,
        userVerified: result.verified, credentialDeviceType: 'singleDevice',
        credentialBackedUp: false, origin: input.expectedOrigin, rpID: input.expectedRPID,
      },
    }
  })
  const authority = createWebAuthnUserPresenceAuthority({
    now: dependencies.now,
    credentialRepository: {
      async list() { return [...credentials.values()].map(cloneCredential) },
      async get(credentialId) {
        const credential = credentials.get(credentialId)
        return credential === undefined ? undefined : cloneCredential(credential)
      },
      async insert(credential) {
        if (credentials.has(credential.id)) {
          throw Object.assign(new Error('E2E_APPROVAL_CREDENTIAL_DUPLICATE'), {
            code: 'E2E_APPROVAL_CREDENTIAL_DUPLICATE',
          })
        }
        credentials.set(credential.id, cloneCredential(credential))
      },
      async compareAndSet(expected, next) {
        const current = credentials.get(expected.id)
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected)
          || next.counter <= expected.counter) {
          throw Object.assign(new Error('E2E_APPROVAL_CREDENTIAL_STATE_CONFLICT'), {
            code: 'E2E_APPROVAL_CREDENTIAL_STATE_CONFLICT',
          })
        }
        credentials.set(next.id, cloneCredential(next))
      },
      async completeAuthentication(expected, next, sessionId, receipt) {
        const current = credentials.get(expected.id)
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected)
          || next.counter <= expected.counter || receipts.has(sessionId)) {
          throw Object.assign(new Error('E2E_APPROVAL_CREDENTIAL_STATE_CONFLICT'), {
            code: 'E2E_APPROVAL_CREDENTIAL_STATE_CONFLICT',
          })
        }
        credentials.set(next.id, cloneCredential(next))
        receipts.set(sessionId, structuredClone(receipt))
      },
      async takeApprovalReceipt(sessionId) {
        const receipt = receipts.get(sessionId)
        receipts.delete(sessionId)
        return receipt === undefined ? undefined : structuredClone(receipt)
      },
    },
  })
  return {
    authority,
    registerTestCredential(input: {
      subject: string
      credentialId: string
      counter: number
      publicKey?: Uint8Array
      transports?: AuthenticatorTransportFuture[]
    }) {
      credentials.set(input.credentialId, {
        id: input.credentialId,
        publicKey: Buffer.from(input.publicKey ?? new Uint8Array([1, 2, 3])).toString('base64url'),
        counter: input.counter,
        transports: input.transports ?? ['internal'],
        subject: input.subject,
      })
    },
    readCredential(credentialId: string) {
      const credential = credentials.get(credentialId)
      return credential === undefined ? undefined : cloneCredential(credential)
    },
  }
}

function cloneCredential(credential: StoredWebAuthnCredential): StoredWebAuthnCredential {
  return structuredClone(credential)
}
