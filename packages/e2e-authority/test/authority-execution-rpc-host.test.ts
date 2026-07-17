import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
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
