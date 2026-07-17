import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { expect, test } from 'vitest'
import {
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  digestText,
  type WriteApprovalSubjectV2,
} from '@mutil-skills/e2e-contracts'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import {
  LocalApprovalAuthority,
  LocalLeaseAuthority,
  createAuthenticatedRpcHttpTransport,
  createAuthorityExecutionRpcClients,
  startAuthorityExecutionRpcHostProcess,
} from '../src/index.js'

const approvalContext = {
  schemaVersion: '1.0.0' as const, subject: 'local:user', runId: 'RUN-1', approvalType: 'execution' as const,
  subjectDigest: `sha256:${'b'.repeat(64)}`, installationDigest: `sha256:${'a'.repeat(64)}`,
  origin: 'http://127.0.0.1:43210', issuedAt: '2026-07-14T10:00:00.000Z', expiresAt: '2026-07-14T10:01:00.000Z',
}
const approvalBinding = {
  runId: approvalContext.runId, installationDigest: approvalContext.installationDigest,
  approvalType: approvalContext.approvalType, subjectDigest: approvalContext.subjectDigest,
}

test('Authority/Lease Host 在独立 OS 进程打开持久状态并提供认证 RPC', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-rpc-host-'))
  const approvalPath = join(directory, 'approval.sqlite')
  const leasePath = join(directory, 'lease.sqlite')
  const encryptionKey = randomBytes(32)
  const fixedNow = '2026-07-14T10:00:00.000Z'
  const now = () => new Date(fixedNow)
  let host: Awaited<ReturnType<typeof startAuthorityExecutionRpcHostProcess>> | undefined
  try {
    const approval = await LocalApprovalAuthority.open({ issuer: 'authority', keyId: 'key-1', now,
      statePath: approvalPath, stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()] })
    approval.close()
    const lease = await LocalLeaseAuthority.open({ now, statePath: leasePath, testWorkspaceRoots: [process.cwd()] })
    const fingerprint = digestText('rpc-host-test/v1', 'resource')
    const acquired = await lease.acquire({ runId: 'RUN-1', resourceKey: 'order:1',
      resourceFingerprint: fingerprint, exclusive: true, ttlMs: 60_000 })
    const active = await lease.activate(acquired.leaseId)
    lease.close()

    try {
      host = await startAuthorityExecutionRpcHostProcess({
        rpc: { issuer: 'authority-host', keyId: 'rpc-key-1', clientId: 'runner-1' },
        approval: { issuer: 'authority', keyId: 'key-1', statePath: approvalPath,
          stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()] },
        lease: { statePath: leasePath, testWorkspaceRoots: [process.cwd()] },
        clock: { kind: 'fixed-test-only', now: fixedNow },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    expect(host.pid).not.toBe(process.pid)
    const clients = createAuthorityExecutionRpcClients({ credential: host.credential,
      approvalBinding,
      verifierMaterial: host.verifierMaterial,
      expectedPublicKeyDigest: host.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(host.endpoint), now })
    await expect(clients.lease.verifyTarget(active.leaseId, active.fencingToken, fingerprint)).resolves.toBe(true)
    await expect(clients.lease.verifyTarget(active.leaseId, active.fencingToken + 1, fingerprint)).resolves.toBe(false)
    const closedHost = host
    await closedHost.close()
    expect(closedHost.credential.sessionKeyBase64Url).toBe('')
    host = undefined
  } finally {
    await host?.close()
    encryptionKey.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('Authority child opens WebAuthn sessions while the parent receives only URL references', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-presence-host-'))
  const approvalPath = join(directory, 'approval.sqlite')
  const leasePath = join(directory, 'lease.sqlite')
  const encryptionKey = randomBytes(32)
  let host: Awaited<ReturnType<typeof startAuthorityExecutionRpcHostProcess>> | undefined
  try {
    const approval = await LocalApprovalAuthority.open({
      issuer: 'authority', keyId: 'key-1', now: () => new Date(), statePath: approvalPath,
      stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()],
      approvalIdentities: [{ subject: 'local:user', roles: ['e2e-approver'] }],
    })
    await approval.createWebAuthnCredentialRepository().insert({
      id: 'Q1JFRC0x', publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
      counter: 0, transports: ['internal'], subject: 'local:user',
    })
    approval.close()
    const lease = await LocalLeaseAuthority.open({
      now: () => new Date(), statePath: leasePath, testWorkspaceRoots: [process.cwd()],
    })
    lease.close()
    try {
      host = await startAuthorityExecutionRpcHostProcess({
        rpc: { issuer: 'authority-host', keyId: 'rpc-key-1', clientId: 'runner-1' },
        approval: {
          issuer: 'authority', keyId: 'key-1', statePath: approvalPath,
          stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()],
          approvalIdentities: [{ subject: 'local:user', roles: ['e2e-approver'] }],
        },
        lease: { statePath: leasePath, testWorkspaceRoots: [process.cwd()] },
        userPresence: {
          installationDigest: `sha256:${'a'.repeat(64)}`,
          assets: {
            indexHtml: Buffer.from('<!doctype html>'),
            approvalJavaScript: Buffer.from('void 0'),
            simpleWebAuthnBrowser: Buffer.from('void 0'),
          },
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    await expect(host.enrollIdentity({ subject: 'local:unregistered' }))
      .rejects.toThrow(/E2E_APPROVAL_ENROLLMENT_SUBJECT_UNTRUSTED/)
    const enrollment = await host.enrollIdentity({ subject: 'local:user' })
    expect(Object.keys(enrollment).sort()).toEqual(['sessionId', 'url'])
    expect(new URL(enrollment.url).hostname).toBe('localhost')
    const approvalSession = await host.openApprovalSession({
      runId: 'RUN-1', approvalType: 'execution',
      subjectDigest: `sha256:${'b'.repeat(64)}`,
      installationDigest: `sha256:${'a'.repeat(64)}`,
    })
    expect(Object.keys(approvalSession).sort()).toEqual(['sessionId', 'url'])
    expect('submitApproval' in host).toBe(false)

    const firstWait = host.waitForSession(enrollment.sessionId)
    const duplicateWait = host.waitForSession(enrollment.sessionId)
    process.kill(host.pid, 'SIGKILL')
    const waiterResults = await Promise.race([
      Promise.allSettled([firstWait, duplicateWait]),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ])
    expect(waiterResults).not.toBe('timeout')
    expect(waiterResults).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'E2E_RPC_HOST_EXITED' }) }),
      expect.objectContaining({
        status: 'rejected', reason: expect.objectContaining({ code: 'E2E_APPROVAL_SESSION_WAIT_DUPLICATE' }),
      }),
    ])
    await host.close()
    host = undefined
  } finally {
    await host?.close()
    encryptionKey.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('production Host completes WebAuthn, finalizes one Grant, and registers its full receipt for RPC use', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-production-finalize-'))
  const approvalPath = join(directory, 'approval.sqlite')
  const leasePath = join(directory, 'lease.sqlite')
  const encryptionKey = randomBytes(32)
  const installationDigest = `sha256:${'a'.repeat(64)}`
  const fixedNow = '2026-07-17T04:00:00.000Z'
  const now = () => new Date(fixedNow)
  const approver = { subject: 'local:user', roles: ['e2e-approver'] }
  const credential = createTestAuthenticatorCredential()
  let host: Awaited<ReturnType<typeof startAuthorityExecutionRpcHostProcess>> | undefined
  try {
    const seed = await LocalApprovalAuthority.open({
      issuer: 'authority', keyId: 'key-1', now, statePath: approvalPath,
      stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()],
      approvalIdentities: [approver],
      authenticateApproverSession: (_sessionId, expected) => ({
        subject: approver.subject, runId: 'RUN-PREFLIGHT', ...expected, installationDigest,
        origin: 'http://localhost:43210', issuedAt: fixedNow, expiresAt: '2026-07-17T04:05:00.000Z',
      }),
    })
    await seed.createWebAuthnCredentialRepository().insert({
      id: credential.id, publicKey: credential.publicKey, counter: 0,
      transports: ['internal'], subject: approver.subject,
    })
    const discoverySubject = {
      schemaVersion: '1.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('prd'),
      scopeDigest: digest('scope'), environment: 'test' as const,
      baseOrigin: 'https://example.test', actor: 'operator',
      expectedPageIdentity: {
        url: 'https://example.test/orders/1', title: 'Order', heading: 'Order 1', ariaSignals: ['main'],
      },
      bootstrapIntentsDigest: digest('bootstrap'),
      actions: [{ actionId: 'DISCOVERY-1', operation: 'local-navigation' as const, maxUses: 1 }],
    }
    const discovery = await seed.issueDiscoveryGrant({
      subject: discoverySubject, approvalSessionRef: 'seed-session', ttlMs: 120_000,
    })
    const discoveryReservation = await seed.reserveForSubject({
      grant: discovery, currentSubject: discoverySubject,
      capabilityId: discovery.capabilities[0]!.capabilityId,
      actionId: discovery.capabilities[0]!.actionId,
      attemptId: 'ATTEMPT-DISCOVERY-1',
    })
    const preflightDigest = await seed.completeDiscoveryPreflight({
      grant: discovery, currentSubject: discoverySubject,
      reservationId: discoveryReservation.reservationId,
      capabilityId: discovery.capabilities[0]!.capabilityId,
      outcome: { status: 'ready', observedIdentity: {
        url: discoverySubject.expectedPageIdentity.url,
        title: discoverySubject.expectedPageIdentity.title,
        headings: [discoverySubject.expectedPageIdentity.heading],
        role: discoverySubject.actor, ariaSignals: ['main'],
      } },
    })
    const writeSubject: WriteApprovalSubjectV2 = {
      schemaVersion: '2.0.0', assetId: discoverySubject.assetId,
      prdRevision: discoverySubject.prdRevision, scopeDigest: discoverySubject.scopeDigest,
      requirementModelDigest: digest('model'), coveragePolicyDigest: digest('coverage'),
      universeDigest: digest('universe'), caseDigest: digest('cases'), actionMapDigest: digest('actions'),
      policyDigest: digest('policy'), executionContractDigest: digest('contract'),
      runBundleProjectionDigest: digest('bundle'), executionDigest: digest('execution'),
      environment: 'test', baseOrigin: discoverySubject.baseOrigin, actor: discoverySubject.actor,
      discoveryGrantId: discovery.grantId, preflightDigest,
      actions: [{
        actionId: 'WRITE-1', effect: 'reversible-write', dataLeaseId: 'LEASE-1', fencingToken: 1,
        cleanupPlanDigest: digest('cleanup'), requests: [{
          intentId: 'INTENT-1', method: 'POST', canonicalOrigin: discoverySubject.baseOrigin,
          exactPath: '/orders/1', query: [], payload: { kind: 'no-body' },
          targetFingerprint: digest('target'), maxRequests: 1, expectedOrder: 1,
        }],
      }],
    }
    seed.close()
    const lease = await LocalLeaseAuthority.open({ now, statePath: leasePath, testWorkspaceRoots: [process.cwd()] })
    lease.close()

    try {
      host = await startAuthorityExecutionRpcHostProcess({
        rpc: { issuer: 'authority-host', keyId: 'rpc-key-1', clientId: 'runner-1' },
        approval: {
          issuer: 'authority', keyId: 'key-1', statePath: approvalPath,
          stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()],
          approvalIdentities: [approver],
        },
        lease: { statePath: leasePath, testWorkspaceRoots: [process.cwd()] },
        userPresence: {
          installationDigest,
          assets: {
            indexHtml: Buffer.from('<!doctype html>'), approvalJavaScript: Buffer.from('void 0'),
            simpleWebAuthnBrowser: Buffer.from('void 0'),
          },
        },
        clock: { kind: 'fixed-test-only', now: fixedNow },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { skip(); return }
      throw error
    }
    const subjectDigest = canonicalGrantApprovalSubjectDigest(writeSubject)
    const session = await host.openApprovalSession({
      runId: 'RUN-1', approvalType: 'execution', subjectDigest, installationDigest,
    })
    await expect(host.finalizeApproval({ sessionId: session.sessionId, grantSubject: writeSubject }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_INVALID' })

    await completeWebAuthnApproval(session, credential)
    await host.waitForSession(session.sessionId)
    const reboundSubject: WriteApprovalSubjectV2 = {
      ...writeSubject,
      actions: [{ ...writeSubject.actions[0]!, cleanupPlanDigest: digest('rebound-cleanup') }],
    }
    await expect(host.finalizeApproval({ sessionId: session.sessionId, grantSubject: reboundSubject }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' })

    const finalized = await host.finalizeApproval({ sessionId: session.sessionId, grantSubject: writeSubject })
    expect(finalized).toMatchObject({
      grant: { subject: writeSubject, subjectDigest, approver },
      approvalBinding: { runId: 'RUN-1', installationDigest, approvalType: 'execution', subjectDigest },
    })
    await expect(host.finalizeApproval({ sessionId: session.sessionId, grantSubject: writeSubject }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_INVALID' })

    const clients = createAuthorityExecutionRpcClients({
      credential: host.credential, approvalBinding: finalized.approvalBinding,
      verifierMaterial: host.verifierMaterial,
      expectedPublicKeyDigest: host.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(host.endpoint), now,
    })
    try {
      await expect(clients.gatewayAuthority.verifyForSubject(finalized.grant as never, writeSubject))
        .resolves.toEqual({ allowed: true })
      await expect(clients.gatewayAuthority.reserveForSubject({
        grant: finalized.grant as never, currentSubject: writeSubject,
        capabilityId: finalized.grant.capabilities[0]!.capabilityId,
        actionId: writeSubject.actions[0]!.actionId, attemptId: 'ATTEMPT-WRITE-1',
        attemptContext: {
          assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: writeSubject.prdRevision,
          runId: 'RUN-1', caseId: 'CASE-1',
        },
      })).resolves.toMatchObject({ status: 'reserved', attemptId: 'ATTEMPT-WRITE-1' })
    } finally { clients.destroy() }
  } finally {
    await host?.close()
    encryptionKey.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

const digest = (value: string): string => digestText('authority-production-finalize-test/v1', value)

function createTestAuthenticatorCredential(): {
  id: string
  publicKey: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
} {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = keys.publicKey.export({ format: 'jwk' })
  const x = Buffer.from(jwk.x!, 'base64url')
  const y = Buffer.from(jwk.y!, 'base64url')
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, x], [-3, y],
  ]))
  return {
    id: randomBytes(16).toString('base64url'),
    publicKey: Buffer.from(cose).toString('base64url'),
    privateKey: keys.privateKey,
  }
}

async function completeWebAuthnApproval(
  session: { url: string; sessionId: string },
  credential: ReturnType<typeof createTestAuthenticatorCredential>,
): Promise<void> {
  const url = new URL(session.url)
  const bearer = url.hash.slice(1)
  const sessionResponse = await fetch(`${url.origin}/session`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const approval = await sessionResponse.json() as { challenge: string; sessionId: string }
  const clientData = Buffer.from(canonicalizeJson({
    type: 'webauthn.get', challenge: approval.challenge, origin: url.origin,
  }))
  const authenticatorData = Buffer.alloc(37)
  createHash('sha256').update('localhost').digest().copy(authenticatorData)
  authenticatorData[32] = 0x05
  authenticatorData.writeUInt32BE(1, 33)
  const signatureBase = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientData).digest(),
  ])
  const signature = sign('sha256', signatureBase, credential.privateKey)
  const response = await fetch(`${url.origin}/submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`, origin: url.origin, 'content-type': 'application/json',
    },
    body: canonicalizeJson({
      sessionId: approval.sessionId, challenge: approval.challenge, credentialId: credential.id,
      response: {
        id: credential.id, rawId: credential.id, type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'), userHandle: null,
        },
      },
    }),
  })
  expect(response.status, await response.text()).toBe(204)
}
