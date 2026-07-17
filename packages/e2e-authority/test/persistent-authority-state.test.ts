import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createDecipheriv, createPrivateKey, sign } from 'node:crypto'
import {
  canonicalGrantApprovalSubjectDigest,
  canonicalizeJson,
  digestText,
  type WriteApprovalSubject,
} from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority, LocalLeaseAuthority, SqliteSnapshotStore } from '../src/index.js'
import { testApprovalReceipt } from './approval-authority.fixture.js'

const directories: string[] = []
const now = () => new Date('2026-07-13T00:00:00.000Z')
const approver = { subject: 'os-user:persistent', roles: ['e2e-approver'] }
const digest = (value: string) => digestText('persistent-authority-test/v1', value)
const stateEncryptionKey = Buffer.alloc(32, 7)
const testWorkspaceRoots = [process.cwd()]
const authenticatePersistentApprover = (
  sessionRef: string,
  expected: { approvalType: 'discovery' | 'execution'; subjectDigest: string },
) => sessionRef === 'persistent-session' ? testApprovalReceipt(approver.subject, expected) : undefined

function convertToRealLegacySnapshot(snapshot: Record<string, any>, encryptionKey: Buffer): void {
  const encrypted = snapshot.privateKeys.primary
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(encrypted.iv, 'base64'))
  decipher.setAAD(Buffer.from('e2e-authority-private-key/v1:primary'))
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ])
  try {
    const privateKey = createPrivateKey({ key: plaintext, type: 'pkcs8', format: 'der' })
    for (const [, grant] of snapshot.grants as Array<[string, Record<string, any>]>) {
      delete grant.approvalContext
      grant.subjectDigest = digestText('approval-subject/v1', canonicalizeJson(grant.subject))
      const { signature: _signature, ...payload } = grant
      grant.signature = sign(null, Buffer.from(canonicalizeJson(payload)), privateKey).toString('base64url')
    }
  } finally { plaintext.fill(0) }
}

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
  test('current snapshot rejects a finalization outbox larger than the production cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-finalization-oversized-'))
    directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
    }
    const authority = await LocalApprovalAuthority.open(options)
    authority.close()
    const database = new DatabaseSync(statePath)
    const row = database.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    const snapshot = JSON.parse(row.snapshot) as Record<string, any>
    snapshot.grantFinalizations = Array.from({ length: 1_025 }, (_, index) => [`FINALIZE-${index}`, {}])
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(snapshot))
    database.close()

    await expect(LocalApprovalAuthority.open(options)).rejects.toMatchObject({
      code: 'E2E_AUTHORITY_STATE_CORRUPT',
    })
  })

  test('a full finalization outbox rejects a new entry without committing its newly issued Grant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-finalization-capacity-'))
    directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
    }
    const subject = {
      schemaVersion: '1.0.0' as const, assetId: 'ASSET-CAPACITY', prdRevision: digest('capacity-prd'),
      scopeDigest: digest('capacity-scope'), environment: 'test' as const,
      baseOrigin: 'https://example.test', actor: 'operator',
      expectedPageIdentity: {
        url: 'https://example.test/orders', title: 'Orders', heading: 'Orders', ariaSignals: ['main'],
      },
      bootstrapIntentsDigest: digest('capacity-bootstrap'),
      actions: [{ actionId: 'DISCOVERY-CAPACITY', operation: 'dom-read' as const, maxUses: 1 as const }],
    }
    const authority = await LocalApprovalAuthority.open(options)
    const grant = await authority.issueDiscoveryGrant({
      subject, approver, approvalSessionRef: 'persistent-session', ttlMs: 60_000,
    })
    authority.close()
    const database = new DatabaseSync(statePath)
    const row = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get() as {
      revision: number; snapshot: string
    }
    const snapshot = JSON.parse(row.snapshot) as Record<string, any>
    const stored = {
      requestDigest: digest('capacity-request'), subject,
      approvalBinding: {
        runId: grant.approvalContext.runId,
        approvalType: grant.approvalContext.approvalType,
        subjectDigest: grant.approvalContext.subjectDigest,
        installationDigest: grant.approvalContext.installationDigest,
      },
      grantId: grant.grantId, approvalSessionRef: 'persistent-session',
    }
    snapshot.grantFinalizations = Array.from(
      { length: 1_024 }, (_, index) => [`FINALIZE-CAPACITY-${index}`, stored],
    )
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(snapshot))
    database.close()

    const full = await LocalApprovalAuthority.open(options)
    await expect(full.finalizeApprovalGrant({
      subject, approvalSessionRef: 'persistent-session', ttlMs: 60_000,
      finalizationId: 'FINALIZE-CAPACITY-NEW', requestDigest: digest('capacity-new-request'),
      approvalBinding: stored.approvalBinding,
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_FINALIZATION_CAPACITY_EXCEEDED' })
    full.close()
    const after = new DatabaseSync(statePath)
    const committed = after.prepare('SELECT revision, snapshot FROM authority_snapshots').get() as {
      revision: number; snapshot: string
    }
    expect(committed.revision).toBe(row.revision)
    expect((JSON.parse(committed.snapshot) as Record<string, any>).grants).toHaveLength(1)
    after.close()
  })

  test('an unacknowledged expired finalization is pruned and a new user-presence session can issue a new Grant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-finalization-expiry-'))
    directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    let current = now()
    const options = {
      issuer: 'authority', keyId: 'key-1', now: () => current,
      statePath, stateEncryptionKey, testWorkspaceRoots, approvalIdentities: [approver],
      authenticateApproverSession: (_sessionRef: string, expected: {
        approvalType: 'discovery' | 'execution'; subjectDigest: string
      }) => testApprovalReceipt(approver.subject, expected),
    }
    const subject = {
      schemaVersion: '1.0.0' as const, assetId: 'ASSET-EXPIRY', prdRevision: digest('expiry-prd'),
      scopeDigest: digest('expiry-scope'), environment: 'test' as const,
      baseOrigin: 'https://example.test', actor: 'operator',
      expectedPageIdentity: {
        url: 'https://example.test/orders', title: 'Orders', heading: 'Orders', ariaSignals: ['main'],
      },
      bootstrapIntentsDigest: digest('expiry-bootstrap'),
      actions: [{ actionId: 'DISCOVERY-EXPIRY', operation: 'dom-read' as const, maxUses: 1 as const }],
    }
    const authority = await LocalApprovalAuthority.open(options)
    const approvalBinding = {
      runId: 'RUN-TEST', approvalType: 'discovery' as const,
      subjectDigest: canonicalGrantApprovalSubjectDigest(subject),
      installationDigest: `sha256:${'a'.repeat(64)}`,
    }
    const first = await authority.finalizeApprovalGrant({
      subject, approvalSessionRef: 'USER-PRESENCE-1', ttlMs: 1_000,
      finalizationId: 'FINALIZE-EXPIRY-1', requestDigest: digest('expiry-request-1'), approvalBinding,
    })
    current = new Date(current.getTime() + 2_000)
    await expect(authority.recoverFinalizedGrant({
      finalizationId: 'FINALIZE-EXPIRY-1', requestDigest: digest('expiry-request-1'),
      subject, approvalBinding,
    })).resolves.toBeUndefined()
    const second = await authority.finalizeApprovalGrant({
      subject, approvalSessionRef: 'USER-PRESENCE-2', ttlMs: 1_000,
      finalizationId: 'FINALIZE-EXPIRY-2', requestDigest: digest('expiry-request-2'), approvalBinding,
    })
    expect(second.grantId).not.toBe(first.grantId)
    authority.close()
  })

  test('持久 Grant 激活要求签名内容与当前 Authority 存储态完全一致', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-stored-grant-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
    }
    const authority = await LocalApprovalAuthority.open(options)
    const subject = {
      schemaVersion: '1.0.0' as const,
      assetId: 'ASSET-STORED-GRANT', prdRevision: digest('stored-prd'), scopeDigest: digest('stored-scope'),
      environment: 'test' as const, baseOrigin: 'https://example.test', actor: 'operator',
      expectedPageIdentity: {
        url: 'https://example.test/orders', title: 'Orders', heading: 'Orders', ariaSignals: ['main'],
      },
      bootstrapIntentsDigest: digest('stored-bootstrap'),
      actions: [{ actionId: 'DISCOVERY-STORED', operation: 'dom-read' as const, maxUses: 1 as const }],
    }
    const grant = await authority.issueDiscoveryGrant({
      subject, approver, approvalSessionRef: 'persistent-session', ttlMs: 60_000,
    })
    authority.close()

    const database = new DatabaseSync(statePath)
    const row = database.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    const snapshot = JSON.parse(row.snapshot) as Record<string, unknown>
    snapshot.grants = []
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(snapshot))
    database.close()

    const reopened = await LocalApprovalAuthority.open(options)
    await expect(reopened.activatePersistedGrant({
      grant,
      approvalBinding: {
        runId: grant.approvalContext.runId,
        approvalType: grant.approvalContext.approvalType,
        subjectDigest: grant.approvalContext.subjectDigest,
        installationDigest: grant.approvalContext.installationDigest,
      },
    })).rejects.toMatchObject({ code: 'E2E_APPROVAL_GRANT_STATE_MISMATCH' })
    reopened.close()
  })

  test.each(['2.0.0', '2.1.0'] as const)(
    '将真实 %s snapshot 幂等迁移到 2.3.0，并对未知版本 fail closed', async (legacyVersion) => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-migration-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
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
    legacy.schemaVersion = legacyVersion
    if (legacyVersion === '2.0.0') delete legacy.webAuthnCredentials
    delete legacy.webAuthnReceipts
    delete legacy.grantFinalizations
    convertToRealLegacySnapshot(legacy, stateEncryptionKey)
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(legacy))
    database.close()

    const migrated = await LocalApprovalAuthority.open(options)
    expect(migrated.artifactVerifierMaterial).toEqual(verifierBefore)
    expect(await migrated.verify(grant)).toMatchObject({ allowed: false, code: 'E2E_APPROVAL_REVOKED' })
    await expect(migrated.createWebAuthnCredentialRepository().list()).resolves.toEqual([])
    migrated.close()

    const migratedDatabase = new DatabaseSync(statePath)
    const migratedRow = migratedDatabase.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    const persisted = JSON.parse(migratedRow.snapshot) as Record<string, unknown>
    expect(persisted.schemaVersion).toBe('2.3.0')
    expect(persisted.webAuthnCredentials).toMatchObject({ algorithm: 'aes-256-gcm' })
    expect(persisted).toMatchObject({ grants: [], uses: [], reservations: [], completedPreflights: [], attemptLogs: [] })
    persisted.schemaVersion = '9.9.9'
    migratedDatabase.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(persisted))
    migratedDatabase.close()

    await expect(LocalApprovalAuthority.open(options)).rejects.toMatchObject({
      code: 'E2E_AUTHORITY_STATE_CORRUPT',
    })
    },
  )

  test('2.2.0 snapshot preserves existing grants while adding an empty 2.3.0 finalization outbox', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-22-migration-')); directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
    }
    const first = await LocalApprovalAuthority.open(options)
    const subject = await writeSubject(first, 'LEASE-MIGRATION-22', 1)
    const grant = await first.issueWriteGrant({
      subject, approver, approvalSessionRef: 'persistent-session', ttlMs: 60_000,
    })
    first.close()
    const database = new DatabaseSync(statePath)
    const row = database.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    const old = JSON.parse(row.snapshot) as Record<string, unknown>
    old.schemaVersion = '2.2.0'
    delete old.grantFinalizations
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(old))
    database.close()

    const migrated = await LocalApprovalAuthority.open(options)
    await expect(migrated.verify(grant)).resolves.toEqual({ allowed: true })
    migrated.close()
    const migratedDatabase = new DatabaseSync(statePath)
    const migratedRow = migratedDatabase.prepare('SELECT snapshot FROM authority_snapshots').get() as { snapshot: string }
    expect(JSON.parse(migratedRow.snapshot)).toMatchObject({
      schemaVersion: '2.3.0', grantFinalizations: [],
    })
    migratedDatabase.close()
  })

  test('2.0.0 migration validates the supplied key before commit and wrong-key rollback preserves exact bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-wrong-key-migration-'))
    directories.push(directory)
    const statePath = join(directory, 'authority.sqlite')
    const options = {
      issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
    }
    const authority = await LocalApprovalAuthority.open(options)
    authority.close()
    const database = new DatabaseSync(statePath)
    const row = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get() as {
      revision: number; snapshot: string
    }
    const legacy = JSON.parse(row.snapshot) as Record<string, unknown>
    legacy.schemaVersion = '2.0.0'
    delete legacy.webAuthnCredentials
    delete legacy.webAuthnReceipts
    delete legacy.grantFinalizations
    const legacyBytes = JSON.stringify(legacy)
    database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(legacyBytes)
    const before = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get()
    database.close()

    const wrongKey = Buffer.alloc(32, 0x55)
    await expect(LocalApprovalAuthority.open({ ...options, stateEncryptionKey: wrongKey }))
      .rejects.toMatchObject({ code: 'E2E_AUTHORITY_STATE_DECRYPTION_FAILED' })
    const afterWrongKeyDatabase = new DatabaseSync(statePath)
    expect(afterWrongKeyDatabase.prepare('SELECT revision, snapshot FROM authority_snapshots').get()).toEqual(before)
    afterWrongKeyDatabase.close()

    const migrated = await LocalApprovalAuthority.open(options)
    migrated.close()
    const migratedDatabase = new DatabaseSync(statePath)
    const migratedRow = migratedDatabase.prepare('SELECT revision, snapshot FROM authority_snapshots').get() as {
      revision: number; snapshot: string
    }
    expect(migratedRow.revision).toBe(row.revision + 1)
    expect(JSON.parse(migratedRow.snapshot)).toMatchObject({ schemaVersion: '2.3.0' })
    migratedDatabase.close()
  })

  test('2.0.0 migration rejects malformed nested state and rolls back without committing', async () => {
    const corruptions: Array<[string, (snapshot: Record<string, any>) => void]> = [
      ['private encrypted blob', (snapshot) => { snapshot.privateKeys.primary.extra = true }],
      ['grant tuple', (snapshot) => { snapshot.grants = [['GRANT-1', { grantId: 'GRANT-1' }]] }],
      ['revocation tuple', (snapshot) => { snapshot.revoked = [['GRANT-1', 7]] }],
      ['use tuple', (snapshot) => { snapshot.uses = [['GRANT-1:CAP-1', -1]] }],
      ['reservation tuple', (snapshot) => { snapshot.reservations = [['RES-1', { reservationId: 'OTHER' }]] }],
      ['preflight tuple', (snapshot) => { snapshot.completedPreflights = [['PREFLIGHT-1', { status: 'ready' }]] }],
      ['manual result id', (snapshot) => { snapshot.manualResultIds = [7] }],
      ['attempt log tuple', (snapshot) => { snapshot.attemptLogs = [['LOG-1', { events: [] }]] }],
    ]
    for (const [name, corrupt] of corruptions) {
      const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-strict-legacy-'))
      directories.push(directory)
      const statePath = join(directory, 'authority.sqlite')
      const options = {
        issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
        approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
      }
      const authority = await LocalApprovalAuthority.open(options)
      authority.close()
      const database = new DatabaseSync(statePath)
      const current = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get() as {
        revision: number; snapshot: string
      }
      const legacy = JSON.parse(current.snapshot) as Record<string, any>
      legacy.schemaVersion = '2.0.0'
      delete legacy.webAuthnCredentials
      delete legacy.webAuthnReceipts
      delete legacy.grantFinalizations
      corrupt(legacy)
      database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(JSON.stringify(legacy))
      const before = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get()
      database.close()

      await expect(LocalApprovalAuthority.open(options), name).rejects.toMatchObject({
        code: 'E2E_AUTHORITY_STATE_CORRUPT',
      })
      const afterDatabase = new DatabaseSync(statePath)
      expect(afterDatabase.prepare('SELECT revision, snapshot FROM authority_snapshots').get(), name).toEqual(before)
      afterDatabase.close()
    }
  })

  test.each(['delete', 'reorder'] as const)(
    '2.0.0 migration replays attempt logs and rejects %s tampering without commit',
    async (mutation) => {
      const directory = await mkdtemp(join(tmpdir(), 'e2e-authority-attempt-replay-'))
      directories.push(directory)
      const statePath = join(directory, 'authority.sqlite')
      const options = {
        issuer: 'authority', keyId: 'key-1', now, statePath, stateEncryptionKey, testWorkspaceRoots,
        approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
      }
      const authority = await LocalApprovalAuthority.open(options)
      const initial = digestText('attempt-chain-initial/v2', canonicalizeJson(attemptContext))
      const started = authority.appendAttemptEvent({ context: attemptContext, event: {
        kind: 'started', sequence: 1, caseId: attemptContext.caseId, slot: 0,
        attemptId: 'ATTEMPT-MIGRATION', mode: 'real-environment',
        timestamp: '2026-07-13T00:00:00.000Z', previousChainDigest: initial,
      } })
      authority.appendAttemptEvent({ context: attemptContext, event: {
        kind: 'terminal', sequence: 2, caseId: attemptContext.caseId, slot: 0,
        attemptId: 'ATTEMPT-MIGRATION', timestamp: '2026-07-13T00:00:01.000Z',
        previousChainDigest: started.eventChainDigest,
        result: { status: 'automation-blocked', mode: 'real-environment', effect: 'read',
          effectObservation: 'not-applicable', reservationSafeToVoid: true },
      } })
      authority.close()

      const database = new DatabaseSync(statePath)
      const row = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get() as {
        revision: number; snapshot: string
      }
      const legacy = JSON.parse(row.snapshot) as Record<string, any>
      legacy.schemaVersion = '2.0.0'
      delete legacy.webAuthnCredentials
      delete legacy.webAuthnReceipts
      delete legacy.grantFinalizations
      const events = legacy.attemptLogs[0][1].events as unknown[]
      if (mutation === 'delete') events.splice(0, 1)
      else events.reverse()
      const tampered = JSON.stringify(legacy)
      database.prepare('UPDATE authority_snapshots SET snapshot = ?').run(tampered)
      const before = database.prepare('SELECT revision, snapshot FROM authority_snapshots').get()
      database.close()

      await expect(LocalApprovalAuthority.open(options)).rejects.toMatchObject({
        code: 'E2E_AUTHORITY_STATE_CORRUPT',
      })
      const after = new DatabaseSync(statePath)
      expect(after.prepare('SELECT revision, snapshot FROM authority_snapshots').get()).toEqual(before)
      after.close()
    },
  )

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
      authenticateApproverSession: authenticatePersistentApprover,
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
      authenticateApproverSession: authenticatePersistentApprover,
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
      authenticateApproverSession: authenticatePersistentApprover,
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
      approvalIdentities: [approver], authenticateApproverSession: authenticatePersistentApprover,
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

    const hardlinkDirectory = await mkdtemp(join(tmpdir(), 'e2e-authority-hardlink-'))
    directories.push(hardlinkDirectory)
    const hardlinkCanary = join(hardlinkDirectory, 'canary.sqlite')
    const hardlinkedStatePath = join(hardlinkDirectory, 'authority.sqlite')
    await writeFile(hardlinkCanary, 'CANARY', { mode: 0o600 })
    await link(hardlinkCanary, hardlinkedStatePath)
    await expect(LocalApprovalAuthority.open({
      ...options, statePath: hardlinkedStatePath,
    })).rejects.toThrow('E2E_AUTHORITY_STATE_LEAF_INVALID')
    expect(await readFile(hardlinkCanary, 'utf8')).toBe('CANARY')
    expect((await stat(hardlinkCanary)).mode & 0o777).toBe(0o600)
  })
})
