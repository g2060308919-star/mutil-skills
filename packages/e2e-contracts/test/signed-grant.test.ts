import { expect, test } from 'vitest'
import { SignedGrantSchema } from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const subjectDigest = 'sha256:3191dfcc27615dab80a790da4d5b0ad97135447a29813f6298548a31bf940953'

const grant = {
  grantId: 'GRANT-1', issuer: 'authority', keyId: 'key-1', proofScope: 'local-os-user',
  approver: { subject: 'local:user', roles: ['e2e-approver'] },
  approvalContext: {
    schemaVersion: '1.0.0', subject: 'local:user', runId: 'RUN-1', approvalType: 'discovery',
    subjectDigest, installationDigest: digest('2'), origin: 'http://localhost:43210',
    issuedAt: '2026-07-17T00:00:00.000Z', expiresAt: '2026-07-17T00:05:00.000Z',
  },
  subject: {
    schemaVersion: '1.0.0', assetId: 'ASSET-1', prdRevision: digest('3'), scopeDigest: digest('4'),
    environment: 'test', baseOrigin: 'https://test.example.com', actor: 'operator',
    expectedPageIdentity: {
      url: 'https://test.example.com/orders', title: 'Orders', heading: 'Orders', ariaSignals: [],
    },
    bootstrapIntentsDigest: digest('5'),
    actions: [{ actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1 }],
  },
  subjectDigest, issuedAt: '2026-07-17T00:00:00.000Z',
  expiresAt: '2026-07-17T00:01:00.000Z',
  capabilities: [{
    capabilityId: 'CAP-1', nonce: 'a'.repeat(64), transport: 'browser-local', effect: 'read',
    actionId: 'ACTION-1', operation: 'dom-read', targetUrl: 'https://test.example.com/orders',
    actor: 'operator', expectedPageIdentityDigest: digest('6'), bootstrapIntentsDigest: digest('5'), maxUses: 1,
  }],
  revocationSequence: 0, signature: 's'.repeat(86),
}

test('SignedGrantSchema accepts one complete discriminator and rejects extra or malformed IPC fields', () => {
  expect(SignedGrantSchema.parse(grant)).toEqual(grant)
  expect(() => SignedGrantSchema.parse({ ...grant, injected: true })).toThrow()
  expect(() => SignedGrantSchema.parse({ ...grant, capabilities: [{ ...grant.capabilities[0], maxUses: 0 }] }))
    .toThrow()
})
