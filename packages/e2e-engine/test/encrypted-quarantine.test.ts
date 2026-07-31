import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import {
  EncryptedQuarantine,
  InMemoryQuarantineAuditLog,
  InMemorySecretProvider,
  type QuarantineActor,
  type QuarantineSecretProvider,
  verifyQuarantineAuditChain,
} from '../src/index.js'
import {
  QuarantineRunManifestSchema,
  SealedEvidenceEnvelopeSchema,
  digestText,
  type PrivacyUnlockGrant,
} from '@mutil-skills/e2e-contracts'

const roots: string[] = []
const runner: QuarantineActor = { subject: 'runner:1', roles: ['e2e-runner'] }
const sanitizer: QuarantineActor = { subject: 'sanitizer:1', roles: ['e2e-sanitizer'] }

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'e2e-quarantine-test-'))
  roots.push(root)
  const secrets = new InMemorySecretProvider()
  const audit = new InMemoryQuarantineAuditLog()
  const quarantine = new EncryptedQuarantine({
    root, secrets, audit, now: () => new Date('2026-07-11T10:00:00.000Z'),
  })
  return { root, secrets, audit, quarantine }
}

describe('EncryptedQuarantine encryption boundary', () => {
  test('stores only authenticated ciphertext under 0700/0600 permissions and decrypts for the sanitizer role', async () => {
    const { root, quarantine } = await fixture()
    const plaintext = Buffer.from('customer secret: 4111-1111-1111-1111')
    const run = await quarantine.createRun({ runId: 'RUN-1', ttlMs: 60_000, actor: runner })
    const record = await quarantine.writeEvidence({
      runId: run.runId, relativePath: 'raw/dom.snapshot', plaintext, actor: runner,
    })

    expect((await stat(join(root, 'RUN-1'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'RUN-1', record.ciphertextFile))).mode & 0o777).toBe(0o600)
    const bytesOnDisk = await readFile(join(root, 'RUN-1', record.ciphertextFile))
    expect(bytesOnDisk.includes(plaintext)).toBe(false)
    await expect(quarantine.readEvidence({
      runId: 'RUN-1', relativePath: 'raw/dom.snapshot', actor: sanitizer,
    })).resolves.toEqual(plaintext)
  })

  test('精确重放同一路径时返回原记录，内容漂移时拒绝覆盖', async () => {
    const { quarantine } = await fixture()
    await quarantine.createRun({ runId: 'RUN-1', ttlMs: 60_000, actor: runner })
    const input = {
      runId: 'RUN-1',
      relativePath: 'raw/ATTEMPT-1/screenshot.bin',
      plaintext: Buffer.from('same-evidence'),
      actor: runner,
    }
    const first = await quarantine.writeEvidence(input)

    await expect(quarantine.writeEvidence(input)).resolves.toEqual(first)
    await expect(quarantine.writeEvidence({
      ...input,
      plaintext: Buffer.from('changed-evidence'),
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_EVIDENCE_EXISTS' })
  })

  test('fails authentication after ciphertext tampering and records the denied access', async () => {
    const { root, audit, quarantine } = await fixture()
    await quarantine.createRun({ runId: 'RUN-1', ttlMs: 60_000, actor: runner })
    const record = await quarantine.writeEvidence({
      runId: 'RUN-1', relativePath: 'raw/trace.zip', plaintext: Buffer.from('trace-secret'), actor: runner,
    })
    const path = join(root, 'RUN-1', record.ciphertextFile)
    const envelope = JSON.parse(await readFile(path, 'utf8')) as { ciphertext: string }
    const tampered = Buffer.from(envelope.ciphertext, 'base64')
    tampered[0] = tampered[0]! ^ 1
    envelope.ciphertext = tampered.toString('base64')
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 })

    await expect(quarantine.readEvidence({
      runId: 'RUN-1', relativePath: 'raw/trace.zip', actor: sanitizer,
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_AUTHENTICATION_FAILED' })
    expect(audit.events.some((event) => event.action === 'decrypt' && event.decision === 'denied')).toBe(true)
    expect(verifyQuarantineAuditChain(audit.events)).toBe(true)
    const tamperedAudit = audit.events
    tamperedAudit[0] = { ...tamperedAudit[0]!, reasonCode: 'FORGED' }
    expect(verifyQuarantineAuditChain(tamperedAudit)).toBe(false)
  })

  test('denies unauthorized reads, unsafe paths, symlink-style traversal, and insecure root permissions', async () => {
    const { root, audit, quarantine } = await fixture()
    await quarantine.createRun({ runId: 'RUN-1', ttlMs: 60_000, actor: runner })
    await quarantine.writeEvidence({
      runId: 'RUN-1', relativePath: 'raw/dom.snapshot', plaintext: Buffer.from('secret'), actor: runner,
    })
    await expect(quarantine.readEvidence({
      runId: 'RUN-1', relativePath: 'raw/dom.snapshot', actor: runner,
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_ACCESS_DENIED' })
    await expect(quarantine.writeEvidence({
      runId: 'RUN-1', relativePath: '../escape', plaintext: Buffer.from('secret'), actor: runner,
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_PATH_INVALID' })
    await expect(quarantine.writeEvidence({
      runId: 'RUN-1', relativePath: 'raw/link/../../escape', plaintext: Buffer.from('secret'), actor: runner,
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_PATH_INVALID' })
    expect(audit.events.some((event) => event.action === 'read' && event.decision === 'denied')).toBe(true)

    await chmod(root, 0o755)
    await expect(new EncryptedQuarantine({
      root, secrets: new InMemorySecretProvider(), audit: new InMemoryQuarantineAuditLog(),
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    }).createRun({ runId: 'RUN-2', ttlMs: 60_000, actor: runner }))
      .rejects.toMatchObject({ code: 'E2E_QUARANTINE_ROOT_PERMISSIONS_INSECURE' })
  })

  test('refuses to create raw evidence quarantine inside a Git worktree', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp', 'quarantine-in-worktree-'))
    roots.push(root)
    const quarantine = new EncryptedQuarantine({
      root, secrets: new InMemorySecretProvider(), audit: new InMemoryQuarantineAuditLog(),
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    })

    await expect(quarantine.createRun({ runId: 'RUN-GIT', ttlMs: 60_000, actor: runner }))
      .rejects.toMatchObject({ code: 'E2E_QUARANTINE_GIT_WORKTREE_DENIED' })
  })
})

describe('EncryptedQuarantine lifecycle', () => {
  test('先持久化 committed-pending-erasure，崩溃后只恢复 crypto-erasure', async () => {
    const { root, secrets, audit, quarantine } = await fixture()
    const run = await quarantine.createRun({ runId: 'RUN-PENDING-ERASURE', ttlMs: 60_000, actor: runner })
    let failOnce = true
    const failingSecrets: QuarantineSecretProvider = {
      createRunKey: (input) => secrets.createRunKey(input),
      seal: (input) => secrets.seal(input),
      open: (input) => secrets.open(input),
      hasKey: (keyId) => secrets.hasKey(keyId),
      destroyKey: async (keyId) => {
        if (failOnce) { failOnce = false; throw new Error('simulated crash before key erasure') }
        await secrets.destroyKey(keyId)
      },
    }
    const crashing = new EncryptedQuarantine({
      root, secrets: failingSecrets, audit, now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    const generationDigest = digestText('generation/v1', 'committed')
    await expect(crashing.destroyAfterPublication({
      runId: run.runId, generationDigest, actor: { subject: 'publisher:1', roles: ['e2e-publisher'] },
    })).rejects.toThrow('simulated crash')
    expect(QuarantineRunManifestSchema.parse(JSON.parse(
      await readFile(join(root, run.runId, 'manifest.json'), 'utf8'),
    ))).toMatchObject({ status: 'committed-pending-erasure', generationDigest })

    const restarted = new EncryptedQuarantine({
      root, secrets, audit, now: () => new Date('2026-07-11T10:00:01.000Z'),
    })
    await expect(restarted.resumePendingErasure({ subject: 'publisher:recovery', roles: ['e2e-publisher'] }))
      .resolves.toEqual([run.runId])
    expect(await secrets.hasKey(run.keyId)).toBe(false)
    await expect(stat(join(root, run.runId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('destroys the data key after publication so retained ciphertext is cryptographically unreadable', async () => {
    const { root, secrets, quarantine } = await fixture()
    const run = await quarantine.createRun({ runId: 'RUN-PUBLISH', ttlMs: 60_000, actor: runner })
    const record = await quarantine.writeEvidence({
      runId: run.runId, relativePath: 'raw/trace.zip', plaintext: Buffer.from('retained-secret'), actor: runner,
    })
    const envelope = SealedEvidenceEnvelopeSchema.parse(JSON.parse(
      await readFile(join(root, run.runId, record.ciphertextFile), 'utf8'),
    ))
    await quarantine.destroyAfterPublication({
      runId: run.runId, generationDigest: digestText('generation/v1', 'published'),
      actor: { subject: 'publisher:1', roles: ['e2e-publisher'] },
    })

    expect(await secrets.hasKey(run.keyId)).toBe(false)
    await expect(stat(join(root, run.runId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(secrets.open({ keyId: run.keyId, envelope, aad: Buffer.alloc(0) }))
      .rejects.toMatchObject({ code: 'E2E_SECRET_KEY_UNAVAILABLE' })
  })

  test('enforces the 24 hour maximum and crypto-erases expired runs on access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-quarantine-expiry-'))
    roots.push(root)
    let now = new Date('2026-07-11T10:00:00.000Z')
    const secrets = new InMemorySecretProvider()
    const audit = new InMemoryQuarantineAuditLog()
    const quarantine = new EncryptedQuarantine({ root, secrets, audit, now: () => now })
    await expect(quarantine.createRun({ runId: 'RUN-TOO-LONG', ttlMs: 24 * 60 * 60 * 1000 + 1, actor: runner }))
      .rejects.toMatchObject({ code: 'E2E_QUARANTINE_TTL_INVALID' })
    const run = await quarantine.createRun({ runId: 'RUN-EXPIRE', ttlMs: 1_000, actor: runner })
    await quarantine.writeEvidence({
      runId: run.runId, relativePath: 'raw/dom.snapshot', plaintext: Buffer.from('expires'), actor: runner,
    })
    now = new Date('2026-07-11T10:00:02.000Z')

    await expect(quarantine.readEvidence({
      runId: run.runId, relativePath: 'raw/dom.snapshot', actor: sanitizer,
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_EXPIRED' })
    expect(await secrets.hasKey(run.keyId)).toBe(false)
    await expect(stat(join(root, run.runId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(audit.events.some((event) => event.action === 'expire' && event.decision === 'allowed')).toBe(true)
  })

  test('recovers a crashed run only by privacy unlock or destruction and never by auto-publication', async () => {
    const { root, secrets, audit, quarantine } = await fixture()
    const run = await quarantine.createRun({ runId: 'RUN-RECOVER', ttlMs: 60_000, actor: runner })
    await quarantine.writeEvidence({
      runId: run.runId, relativePath: 'raw/dom.snapshot', plaintext: Buffer.from('privacy-review'), actor: runner,
    })
    await expect(quarantine.readEvidence({
      runId: run.runId, relativePath: 'raw/dom.snapshot', actor: { subject: 'privacy:alice', roles: ['privacy-approver'] },
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_ACCESS_DENIED' })
    const grant: PrivacyUnlockGrant = {
      grantId: 'PRIVACY-GRANT-1', issuer: 'authority', keyId: 'authority-key', proofScope: 'local-os-user',
      runId: run.runId, quarantineKeyId: run.keyId,
      approver: { subject: 'privacy:alice', roles: ['privacy-approver'] },
      issuedAt: '2026-07-11T10:00:00.000Z', expiresAt: '2026-07-11T10:05:00.000Z', signature: 'signature',
    }
    const recovered = new EncryptedQuarantine({
      root, secrets, audit, now: () => new Date('2026-07-11T10:00:30.000Z'),
    })
    await expect(recovered.recoverRun({
      runId: run.runId, action: 'publish' as 'unlock', actor: { subject: 'privacy:alice', roles: ['privacy-approver'] },
      grant, verifyGrant: () => true,
    })).rejects.toMatchObject({ code: 'E2E_QUARANTINE_RECOVERY_ACTION_DENIED' })
    await expect(recovered.recoverRun({
      runId: run.runId, action: 'unlock', actor: { subject: 'privacy:alice', roles: ['privacy-approver'] },
      grant, verifyGrant: () => true,
    })).resolves.toMatchObject({ status: 'privacy-unlocked' })

    const manifest = QuarantineRunManifestSchema.parse(JSON.parse(
      await readFile(join(root, run.runId, 'manifest.json'), 'utf8'),
    ))
    expect(manifest.status).toBe('privacy-unlocked')
    await expect(recovered.readEvidence({
      runId: run.runId, relativePath: 'raw/dom.snapshot', actor: { subject: 'privacy:alice', roles: ['privacy-approver'] },
    })).resolves.toEqual(Buffer.from('privacy-review'))
    await recovered.recoverRun({
      runId: run.runId, action: 'destroy', actor: { subject: 'privacy-admin:1', roles: ['e2e-privacy-admin'] },
    })
    expect(await secrets.hasKey(run.keyId)).toBe(false)
  })
})
