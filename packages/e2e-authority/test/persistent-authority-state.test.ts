import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { digestText, type WriteApprovalSubject } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, LocalLeaseAuthority, SqliteSnapshotStore } from '../src/index.js'

const directories: string[] = []
const now = () => new Date('2026-07-13T00:00:00.000Z')
const approver = { subject: 'os-user:persistent', roles: ['e2e-approver'] }
const digest = (value: string) => digestText('persistent-authority-test/v1', value)
const stateEncryptionKey = Buffer.alloc(32, 7)
const testWorkspaceRoots = [process.cwd()]

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function writeSubject(
  authority: LocalApprovalAuthority, leaseId: string, fencingToken: number, suffix = leaseId,
): Promise<WriteApprovalSubject> {
  const discoverySubject = {
    schemaVersion: '1.0.0' as const, assetId: 'ASSET-1', prdRevision: digest('prd'), scopeDigest: digest('scope'),
    environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'operator',
    expectedPageIdentity: { url: 'https://example.test/orders/1', title: 'Order', heading: 'Order 1', ariaSignals: ['main'] },
    bootstrapIntentsDigest: digest('bootstrap'),
    actions: [{ actionId: `DISCOVERY-${suffix}`, operation: 'local-navigation' as const, maxUses: 1 }],
  }
  const discovery = await authority.issueDiscoveryGrant({ subject: discoverySubject, approver,
    approvalSessionRef: 'persistent-session', ttlMs: 60_000 })
  const reservation = await authority.reserveForSubject({ grant: discovery, currentSubject: discoverySubject,
    capabilityId: discovery.capabilities[0]!.capabilityId, actionId: `DISCOVERY-${suffix}`,
    attemptId: `ATTEMPT-DISCOVERY-${suffix}` })
  const preflightDigest = await authority.completeDiscoveryPreflight({ grant: discovery, currentSubject: discoverySubject,
    reservationId: reservation.reservationId, capabilityId: discovery.capabilities[0]!.capabilityId,
    outcome: { status: 'ready', observedIdentity: { url: 'https://example.test/orders/1', title: 'Order',
      headings: ['Order 1'], role: 'operator', ariaSignals: ['main'] } } })
  return {
    schemaVersion: '2.0.0', assetId: 'ASSET-1', prdRevision: digest('prd'),
    executionDigest: digest('execution'), environment: 'test', baseOrigin: 'https://example.test',
    scopeDigest: digest('scope'), requirementModelDigest: digest('model'), coveragePolicyDigest: digest('coverage'),
    universeDigest: digest('universe'), caseDigest: digest('cases'), actionMapDigest: digest('actions'),
    policyDigest: digest('policy'), executionContractDigest: digest('execution-contract'),
    runBundleProjectionDigest: digest('run-bundle'), actor: 'operator', discoveryGrantId: discovery.grantId,
    preflightDigest,
    actions: [{
      actionId: 'ACTION-WRITE', effect: 'reversible-write', dataLeaseId: leaseId, fencingToken,
      cleanupPlanDigest: digest('cleanup'), requests: [{
        intentId: 'INTENT-WRITE', method: 'POST', canonicalOrigin: 'https://example.test',
        exactPath: '/orders/1', query: [], payload: { kind: 'json', digest: digest('payload') },
        targetFingerprint: digest('target'), maxRequests: 1, expectedOrder: 1,
      }],
    }],
  }
}

const attemptContext = {
  assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: digest('prd'), runId: 'RUN-1', caseId: 'CASE-1',
}

describe('SQLite 持久 Authority 状态', () => {
  test('将真实 2.0.0 snapshot 幂等迁移到 2.1.0，并对未知版本 fail closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-migration-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: () => approver.subject,
    }
    const first = await LocalApprovalAuthority.open(options)
    const subject = await writeSubject(first, 'LEASE-MIGRATION', 1)
    const grant = await first.issueWriteGrant({
      subject, approver, approvalSessionRef: 'persistent-session', ttlMs: 60_000,
    })
    const verifierBefore = first.artifactVerifierMaterial
    first.close()

    const database = new DatabaseSync(statePath)
    const row = database.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    const legacy = JSON.parse(row.snapshot) as Record<string, unknown>
    legacy.schemaVersion = '2.0.0'
    delete legacy.webAuthnCredentials
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(legacy))
    database.close()

    const migrated = await LocalApprovalAuthority.open(options)
    expect(migrated.artifactVerifierMaterial).toEqual(verifierBefore)
    expect(await migrated.verify(grant)).toEqual({ allowed: true })
    await expect(migrated.createWebAuthnCredentialRepository().list()).resolves.toEqual([])
    migrated.close()

    const migratedDatabase = new DatabaseSync(statePath)
    const migratedRow = migratedDatabase.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    const persisted = JSON.parse(migratedRow.snapshot) as Record<string, unknown>
    expect(persisted.schemaVersion).toBe('2.1.0')
    expect(persisted.webAuthnCredentials).toMatchObject({ algorithm: 'aes-256-gcm' })
    persisted.schemaVersion = '9.9.9'
    migratedDatabase.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(persisted))
    migratedDatabase.close()

    await expect(LocalApprovalAuthority.open(options)).rejects.toMatchObject({
      code: 'E2E_AUTHORITY_STATE_CORRUPT',
    })
  })

  test('拒绝 expected state directory 被同 pathname 的真实目录替换', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-state-parent-binding-'))
    directories.push(directory)
    const stateDirectory = join(directory, 'state')
    await mkdir(stateDirectory, { mode: 0o700 })
    const metadata = await stat(stateDirectory)
    const expectedStateDirectory = {
      realPath: await realpath(stateDirectory),
      device: String(metadata.dev),
      inode: String(metadata.ino),
    }
    await rename(stateDirectory, join(directory, 'state-original'))
    await mkdir(stateDirectory, { mode: 0o700 })

    expect(() => new SqliteSnapshotStore(
      join(stateDirectory, 'authority.sqlite'),
      'state-parent-binding-test',
      { forbiddenRoots: ['/dev'], expectedStateDirectory },
    )).toThrow('E2E_AUTHORITY_STATE_DIRECTORY_REBOUND')
  })

  test('重启后保留 key、Grant、unknown reservation 和防重放计数', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-state-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const first = await LocalApprovalAuthority.open({
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver],
      authenticateApproverSession: (sessionRef) => sessionRef === 'persistent-session' ? approver.subject : undefined,
    })
    const grant = await first.issueWriteGrant({
      subject: await writeSubject(first, 'LEASE-1', 1), approver, approvalSessionRef: 'persistent-session', ttlMs: 60_000,
    })
    const capability = grant.capabilities[0]!
    const reservation = await first.reserveForSubject({
      grant, currentSubject: grant.subject, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-1', attemptContext,
    })
    await first.markUnknown(reservation.reservationId, 'connection lost')
    const material = first.attemptEventVerifierMaterial
    first.close()

    const second = await LocalApprovalAuthority.open({
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver],
      authenticateApproverSession: (sessionRef) => sessionRef === 'persistent-session' ? approver.subject : undefined,
    })
    expect(second.attemptEventVerifierMaterial).toEqual(material)
    expect(await second.verify(grant)).toEqual({ allowed: true })
    expect(second.getReservation(reservation.reservationId)).toMatchObject({ status: 'unknown' })
    await expect(second.reserveForSubject({
      grant, currentSubject: grant.subject, capabilityId: capability.capabilityId,
      actionId: capability.actionId, attemptId: 'ATTEMPT-2', attemptContext,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_CAPABILITY_EXHAUSTED' })
    second.close()
  })

  test('Lease 重启后仍保持 exclusive owner 和单调 fencing token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-lease-state-')); directories.push(directory)
    const statePath = join(directory, 'lease.sqlite')
    const first = await LocalLeaseAuthority.open({ now, statePath, testWorkspaceRoots })
    const acquired = await first.acquire({
      runId: 'RUN-1', resourceKey: 'order:1', resourceFingerprint: digest('target'), exclusive: true, ttlMs: 60_000,
    })
    const active = await first.activate(acquired.leaseId)
    first.close()

    const second = await LocalLeaseAuthority.open({ now, statePath, testWorkspaceRoots })
    expect(await second.verifyTarget(active.leaseId, active.fencingToken, digest('target'))).toBe(true)
    await expect(second.acquire({
      runId: 'RUN-2', resourceKey: 'order:1', resourceFingerprint: digest('target'), exclusive: true, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' })
    await second.release(active.leaseId, digest('cleanup'))
    const next = await second.acquire({
      runId: 'RUN-2', resourceKey: 'order:1', resourceFingerprint: digest('target'), exclusive: true, ttlMs: 60_000,
    })
    expect((await second.activate(next.leaseId)).fencingToken).toBeGreaterThan(active.fencingToken)
    second.close()
  })

  test('同一实例和同一状态文件的多个 Approval Authority 会串行提交，且不会丢失并发签发', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-concurrent-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver],
      authenticateApproverSession: (sessionRef: string) =>
        sessionRef === 'persistent-session' ? approver.subject : undefined,
    }
    const first = await LocalApprovalAuthority.open(options)
    const second = await LocalApprovalAuthority.open(options)

    const [subject1, subject2, subject3] = await Promise.all([
      writeSubject(first, 'LEASE-1', 1, '1'), writeSubject(first, 'LEASE-2', 2, '2'),
      writeSubject(second, 'LEASE-3', 3, '3'),
    ])
    const [firstGrant, sameInstanceGrant, secondGrant] = await Promise.all([
      first.issueWriteGrant({ subject: subject1, approver,
        approvalSessionRef: 'persistent-session', ttlMs: 60_000 }),
      first.issueWriteGrant({ subject: subject2, approver,
        approvalSessionRef: 'persistent-session', ttlMs: 60_000 }),
      second.issueWriteGrant({ subject: subject3, approver,
        approvalSessionRef: 'persistent-session', ttlMs: 60_000 }),
    ])
    first.close()
    second.close()

    const reopened = await LocalApprovalAuthority.open(options)
    expect(await reopened.verify(firstGrant)).toEqual({ allowed: true })
    expect(await reopened.verify(sameInstanceGrant)).toEqual({ allowed: true })
    expect(await reopened.verify(secondGrant)).toEqual({ allowed: true })
    reopened.close()
  }, 3_000)

  test('同一状态文件的多个 Lease Authority 并发竞争时只有一个获得资源', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-lease-concurrent-')); directories.push(directory)
    const statePath = join(directory, 'lease.sqlite')
    const first = await LocalLeaseAuthority.open({ now, statePath, testWorkspaceRoots })
    const second = await LocalLeaseAuthority.open({ now, statePath, testWorkspaceRoots })
    const request = {
      resourceKey: 'order:1', resourceFingerprint: digest('target'), exclusive: true, ttlMs: 60_000,
    }

    const outcomes = await Promise.allSettled([
      first.acquire({ ...request, runId: 'RUN-1' }),
      second.acquire({ ...request, runId: 'RUN-2' }),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: { code: 'E2E_LEASE_RESOURCE_UNAVAILABLE' } })
    first.close()
    second.close()
  }, 3_000)

  test('私钥只以认证加密密文持久化，错误密钥与 testWorkspace 内状态路径均 fail-closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-encrypted-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: () => approver.subject,
    }
    const authority = await LocalApprovalAuthority.open(options)
    authority.close()

    const database = new DatabaseSync(statePath, { readOnly: true })
    const row = database.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    database.close()
    const snapshot = JSON.parse(row.snapshot)
    expect(snapshot.privateKeys.primary).toMatchObject({ algorithm: 'aes-256-gcm' })
    expect(typeof snapshot.privateKeys.primary.ciphertext).toBe('string')
    expect(Object.values(snapshot.privateKeys).every((value) => typeof value !== 'string')).toBe(true)

    await expect(LocalApprovalAuthority.open({
      ...options, stateEncryptionKey: Buffer.alloc(32, 9),
    })).rejects.toMatchObject({ code: 'E2E_AUTHORITY_STATE_DECRYPTION_FAILED' })

    const workspaceDirectory = await mkdtemp(join(process.cwd(), '.tmp', 'e2e-authority-forbidden-'))
    directories.push(workspaceDirectory)
    await expect(LocalApprovalAuthority.open({
      ...options, statePath: join(workspaceDirectory, 'authority.sqlite'),
    })).rejects.toThrow('E2E_AUTHORITY_STATE_INSIDE_TEST_WORKSPACE')

    const symlinkDirectory = await mkdtemp(join(tmpdir(), 'e2e-authority-symlink-'))
    directories.push(symlinkDirectory)
    const forbiddenTarget = join(workspaceDirectory, 'linked-authority.sqlite')
    await writeFile(forbiddenTarget, '')
    const linkedStatePath = join(symlinkDirectory, 'authority.sqlite')
    await symlink(forbiddenTarget, linkedStatePath)
    await expect(LocalApprovalAuthority.open({
      ...options, statePath: linkedStatePath,
    })).rejects.toThrow('E2E_AUTHORITY_STATE_SYMLINK_FORBIDDEN')
  })
})
