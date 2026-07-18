import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { expect, test } from 'vitest'
import {
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  digestText,
  type ManualResultDraft,
  type WriteApprovalSubjectV2,
} from '@mutil-skills/e2e-contracts'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import {
  LocalApprovalAuthority,
  LocalLeaseAuthority,
  createAuthenticatedRpcHttpTransport,
  createAuthorityExecutionRpcClients,
  createAuthorityMaintenanceRpcClient,
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
const manualIdentities = [
  { subject: 'manual:executor', roles: ['e2e-manual-executor'] },
  { subject: 'manual:reviewer', roles: ['e2e-manual-reviewer'] },
]

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
      statePath: approvalPath, stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()],
      manualIdentities })
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
          stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()], manualIdentities },
        lease: { statePath: leasePath, testWorkspaceRoots: [process.cwd()] },
        clock: { kind: 'fixed-test-only', now: fixedNow },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED') { skip(); return }
      throw error
    }
    expect(host.pid).not.toBe(process.pid)
    const clients = createAuthorityExecutionRpcClients({ credential: host.credential,
      approvalBinding,
      verifierMaterial: host.verifierMaterial,
      expectedPublicKeyDigest: host.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(host.endpoint), now })
    // 仅启动 Host 不得隐式激活 execution context；即使 Lease 本身真实存在也必须先有持久 Grant。
    await expect(clients.lease.verifyTarget(active.leaseId, active.fencingToken, fingerprint))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_CONTEXT_MISMATCH' })
    await expect(clients.lease.verifyTarget(active.leaseId, active.fencingToken + 1, fingerprint))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_CONTEXT_MISMATCH' })
    const manual = await host.prepareManualResult({
      draft: manualDraft(), finalizationId: 'PREPARE-MANUAL-HOST-1',
      requestDigest: digestText('authority-host-manual-request/v1', 'PREPARE-MANUAL-HOST-1'),
    })
    expect(manual).toMatchObject({
      manualResultId: 'MANUAL-HOST-1', nextRole: 'executor', draftDigest: expect.stringMatching(/^sha256:/),
    })
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

function manualDraft(): ManualResultDraft {
  const digest = (value: string) => digestText('authority-host-manual/v1', value)
  return {
    schemaVersion: '1.0.0', manualResultId: 'MANUAL-HOST-1', runId: 'RUN-1', assetId: 'ASSET-1',
    prdRevision: digest('prd'), generationId: 'GEN-1', runtimeInstallationDigest: digest('runtime'),
    manualProcedureId: 'MANUAL-PROCEDURE-1', caseIds: ['CASE-MANUAL-1'], obligationIds: ['COV-MANUAL-1'],
    requirementModelDigest: digest('requirement'), executor: manualIdentities[0]!, reviewer: manualIdentities[1]!,
    startedAt: '2026-07-14T09:50:00.000Z', finishedAt: '2026-07-14T09:55:00.000Z', outcome: 'passed',
    steps: [{ stepId: 'MANUAL-STEP-1', instructionDigest: digest('instruction'), outcome: 'passed',
      observation: '人工验证通过', evidenceDigests: [digest('evidence')] }],
    evidenceDigests: [digest('evidence')], expiresAt: '2026-07-15T09:55:00.000Z',
  }
}

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
      if ((error as NodeJS.ErrnoException).code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED') { skip(); return }
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
      schemaVersion: '1.1.0' as const, assetId: 'ASSET-1', prdRevision: digest('prd'),
      scopeDigest: digest('scope'), environment: 'test' as const,
      baseOrigin: 'https://example.test', actor: 'operator',
      expectedPageIdentity: {
        url: 'https://example.test/orders/1', title: 'Order', heading: 'Order 1', ariaSignals: ['main'],
      },
      bootstrapIntentsDigest: digest('bootstrap'),
      requests: [],
      actions: [{
        actionId: 'DISCOVERY-1', operation: 'local-navigation' as const, maxUses: 1 as const, requestIds: [],
      }],
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
    const normalLeaseFingerprint = digest('normal-active-lease')
    const normalTentativeLease = await lease.acquire({ runId: 'RUN-1', resourceKey: 'normal:1',
      resourceFingerprint: normalLeaseFingerprint, exclusive: true, ttlMs: 300_000 })
    const normalActiveLease = await lease.activate(normalTentativeLease.leaseId)
    lease.close()

    const hostOptions: Parameters<typeof startAuthorityExecutionRpcHostProcess>[0] = {
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
    }
    try {
      host = await startAuthorityExecutionRpcHostProcess(hostOptions)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'E2E_APPROVAL_PLATFORM_PERMISSION_DENIED') { skip(); return }
      throw error
    }
    const subjectDigest = canonicalGrantApprovalSubjectDigest(writeSubject)
    const finalization = {
      finalizationId: 'FINALIZE-PRODUCTION-1', requestDigest: digest('finalization-request'),
    }
    const session = await host.openApprovalSession({
      runId: 'RUN-1', approvalType: 'execution', subjectDigest, installationDigest,
    })
    await expect(host.finalizeApproval({ sessionId: session.sessionId, grantSubject: writeSubject, ...finalization }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_INVALID' })

    await completeWebAuthnApproval(session, credential)
    await host.waitForSession(session.sessionId)
    const reboundSubject: WriteApprovalSubjectV2 = {
      ...writeSubject,
      actions: [{ ...writeSubject.actions[0]!, cleanupPlanDigest: digest('rebound-cleanup') }],
    }
    await expect(host.finalizeApproval({ sessionId: session.sessionId, grantSubject: reboundSubject, ...finalization }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' })

    const finalized = await host.finalizeApproval({
      sessionId: session.sessionId, grantSubject: writeSubject, ...finalization,
    })
    expect(finalized).toMatchObject({
      grant: { subject: writeSubject, subjectDigest, approver },
      approvalBinding: { runId: 'RUN-1', installationDigest, approvalType: 'execution', subjectDigest },
    })
    await expect(host.finalizeApproval({ sessionId: session.sessionId, grantSubject: writeSubject, ...finalization }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_INVALID' })

    const firstSessionKey = host.credential.sessionKeyBase64Url
    await host.close()
    host = await startAuthorityExecutionRpcHostProcess(hostOptions)
    expect(host.credential.sessionKeyBase64Url).not.toBe(firstSessionKey)
    await expect(host.activateGrant({
      grant: finalized.grant,
      approvalBinding: { ...finalized.approvalBinding, runId: 'RUN-REBOUND' },
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' })
    await expect(host.activateGrant({
      grant: { ...finalized.grant, extra: true } as never,
      approvalBinding: finalized.approvalBinding,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_GRANT_INVALID' })
    const concurrentControls = await Promise.allSettled([
      host.activateGrant({ grant: finalized.grant, approvalBinding: finalized.approvalBinding }),
      host.activateGrant({
        grant: finalized.grant,
        approvalBinding: { ...finalized.approvalBinding, runId: 'RUN-CONCURRENT-REBOUND' },
      }),
    ])
    expect(concurrentControls[0]).toEqual({ status: 'fulfilled', value: undefined })
    expect(concurrentControls[1]).toMatchObject({
      status: 'rejected', reason: { code: 'E2E_APPROVAL_SESSION_BINDING_MISMATCH' },
    })
    await expect(host.activateGrant({
      grant: finalized.grant, approvalBinding: finalized.approvalBinding,
    })).resolves.toBeUndefined()

    const clients = createAuthorityExecutionRpcClients({
      credential: host.credential, approvalBinding: finalized.approvalBinding,
      verifierMaterial: host.verifierMaterial,
      expectedPublicKeyDigest: host.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(host.endpoint), now,
    })
    try {
      await expect(clients.lease.verifyTarget(
        normalActiveLease.leaseId, normalActiveLease.fencingToken, normalLeaseFingerprint,
      )).resolves.toBe(true)
      await expect(clients.gatewayAuthority.verifyForSubject(finalized.grant as never, writeSubject))
        .resolves.toEqual({ allowed: true })
      const writeReservation = await clients.gatewayAuthority.reserveForSubject({
        grant: finalized.grant as never, currentSubject: writeSubject,
        capabilityId: finalized.grant.capabilities[0]!.capabilityId,
        actionId: writeSubject.actions[0]!.actionId, attemptId: 'ATTEMPT-WRITE-1',
        attemptContext: {
          assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: writeSubject.prdRevision,
          runId: 'RUN-1', caseId: 'CASE-1',
        },
      })
      expect(writeReservation).toMatchObject({ status: 'reserved', attemptId: 'ATTEMPT-WRITE-1' })
    } finally { clients.destroy() }

    // 模拟 Grant 过期且撤销后才重启恢复：只开放 maintenance allowlist。
    await host.close()
    host = undefined
    const revoked = await LocalApprovalAuthority.open({
      issuer: 'authority', keyId: 'key-1', now, statePath: approvalPath,
      stateEncryptionKey: encryptionKey, testWorkspaceRoots: [process.cwd()], approvalIdentities: [approver],
    })
    await revoked.revoke(finalized.grant.grantId, 'late-recovery-test')
    revoked.close()
    const leaseAuthority = await LocalLeaseAuthority.open({
      now, statePath: leasePath, testWorkspaceRoots: [process.cwd()],
    })
    const recoveryFingerprint = digest('recovery-target')
    const tentative = await leaseAuthority.acquire({ runId: 'RUN-1', resourceKey: 'recovery:1',
      resourceFingerprint: recoveryFingerprint, exclusive: true, ttlMs: 300_000 })
    const recoveryLease = await leaseAuthority.activate(tentative.leaseId)
    leaseAuthority.close()

    const expiredNow = '2026-07-17T04:10:00.000Z'
    host = await startAuthorityExecutionRpcHostProcess({
      ...hostOptions, clock: { kind: 'fixed-test-only', now: expiredNow },
    })
    await expect(host.activateGrant({ grant: finalized.grant, approvalBinding: finalized.approvalBinding }))
      .rejects.toMatchObject({ code: 'E2E_APPROVAL_REVOKED' })
    await expect(host.activateRecoveryGrant({
      grant: finalized.grant, approvalBinding: finalized.approvalBinding,
    })).resolves.toBeUndefined()
    const maintenance = createAuthorityMaintenanceRpcClient({
      credential: host.credential, approvalBinding: finalized.approvalBinding,
      verifierMaterial: host.verifierMaterial,
      expectedPublicKeyDigest: host.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(host.endpoint), now: () => new Date(expiredNow),
    })
    const recoveryExecution = createAuthorityExecutionRpcClients({
      credential: host.credential, approvalBinding: finalized.approvalBinding,
      verifierMaterial: host.verifierMaterial,
      expectedPublicKeyDigest: host.verifierMaterial.publicKeyDigest,
      transport: createAuthenticatedRpcHttpTransport(host.endpoint), now: () => new Date(expiredNow),
    })
    try {
      const query = { attemptId: 'ATTEMPT-WRITE-1', grantId: finalized.grant.grantId,
        capabilityId: finalized.grant.capabilities[0]!.capabilityId,
        actionId: writeSubject.actions[0]!.actionId }
      await expect(maintenance.queryReservation(query)).resolves.toMatchObject({ status: 'reserved' })
      await expect(maintenance.markReservationUnknown(query, 'late recovery'))
        .resolves.toMatch(/^sha256:/)
      await expect(maintenance.queryLease(recoveryLease.leaseId, recoveryLease.fencingToken, recoveryFingerprint))
        .resolves.toMatchObject({ status: 'active' })
      await expect(maintenance.quarantineLease({ leaseId: recoveryLease.leaseId,
        fencingToken: recoveryLease.fencingToken, targetFingerprint: recoveryFingerprint,
        reason: 'late recovery effect unknown' })).resolves.toMatch(/^sha256:/)
      await expect(maintenance.completeReservation(query, digest('must-not-complete')))
        .rejects.toMatchObject({ code: 'E2E_RPC_RECOVERY_OPERATION_DENIED' })
      await expect(maintenance.releaseLease({ leaseId: recoveryLease.leaseId,
        fencingToken: recoveryLease.fencingToken, targetFingerprint: recoveryFingerprint,
        cleanupDigest: digest('must-not-release') }))
        .rejects.toMatchObject({ code: 'E2E_RPC_RECOVERY_OPERATION_DENIED' })
      await expect(recoveryExecution.gatewayAuthority.verifyForSubject(finalized.grant as never, writeSubject))
        .resolves.toMatchObject({ allowed: false, code: 'E2E_APPROVAL_CONTEXT_MISMATCH' })
      await expect(recoveryExecution.gatewayAuthority.reserveForSubject({
        grant: finalized.grant as never, currentSubject: writeSubject,
        capabilityId: finalized.grant.capabilities[0]!.capabilityId,
        actionId: writeSubject.actions[0]!.actionId, attemptId: 'ATTEMPT-FORBIDDEN',
      })).rejects.toMatchObject({ code: 'E2E_APPROVAL_CONTEXT_MISMATCH' })
    } finally { maintenance.destroy(); recoveryExecution.destroy() }
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
