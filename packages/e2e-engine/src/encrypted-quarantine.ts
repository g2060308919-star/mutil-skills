import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  E2EError,
  QuarantineRunManifestSchema,
  SealedEvidenceEnvelopeSchema,
  canonicalizeJson,
  digestBytes,
  digestText,
  type QuarantineActor,
  type QuarantineAuditEvent,
  type QuarantineEvidenceRecord,
  type QuarantineRunManifest,
  type PrivacyUnlockGrant,
} from '@mutil-skills/e2e-contracts'
import type { QuarantineAuditSink } from './quarantine-audit.js'
import type { QuarantineSecretProvider } from './quarantine-secret-provider.js'

const MAX_TTL_MS = 24 * 60 * 60 * 1000
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024

export type { QuarantineActor } from '@mutil-skills/e2e-contracts'

export class EncryptedQuarantine {
  readonly #root: string
  readonly #secrets: QuarantineSecretProvider
  readonly #audit: QuarantineAuditSink
  readonly #now: () => Date

  constructor(input: {
    root: string
    secrets: QuarantineSecretProvider
    audit: QuarantineAuditSink
    now: () => Date
  }) {
    this.#root = input.root
    this.#secrets = input.secrets
    this.#audit = input.audit
    this.#now = input.now
  }

  async createRun(input: { runId: string; ttlMs: number; actor: QuarantineActor }): Promise<QuarantineRunManifest> {
    requireRole(input.actor, 'e2e-runner')
    validateRunId(input.runId)
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > MAX_TTL_MS) {
      throw quarantineError('E2E_QUARANTINE_TTL_INVALID', 'Quarantine TTL 必须在 1ms 到 24 小时之间')
    }
    await this.assertSecureRoot()
    await this.record(input.runId, input.actor, 'create', 'allowed', 'E2E_QUARANTINE_CREATE_AUTHORIZED')
    const createdAt = this.#now()
    const expiresAt = new Date(createdAt.getTime() + input.ttlMs).toISOString()
    const directory = this.runDirectory(input.runId)
    await mkdir(directory, { mode: 0o700 })
    await mkdir(join(directory, 'objects'), { mode: 0o700 })
    const key = await this.#secrets.createRunKey({ runId: input.runId, expiresAt })
    const manifest: QuarantineRunManifest = {
      schemaVersion: '1.0.0', runId: input.runId, keyId: key.keyId, status: 'open',
      createdAt: createdAt.toISOString(), expiresAt, files: [],
    }
    try {
      await writeExclusive(join(directory, 'manifest.json'), Buffer.from(canonicalizeJson(manifest)), 0o600)
      return copyManifest(manifest)
    } catch (error) {
      await this.#secrets.destroyKey(key.keyId)
      throw error
    }
  }

  async writeEvidence(input: {
    runId: string
    relativePath: string
    plaintext: Uint8Array
    actor: QuarantineActor
  }): Promise<QuarantineEvidenceRecord> {
    const targetDigest = digestText('quarantine-path/v1', input.relativePath)
    if (!input.actor.roles.includes('e2e-runner')) {
      await this.record(input.runId, input.actor, 'write', 'denied', 'E2E_QUARANTINE_ACCESS_DENIED', targetDigest)
      throw quarantineError('E2E_QUARANTINE_ACCESS_DENIED', '只有 e2e-runner 可以写入原始证据')
    }
    try {
      validateRunId(input.runId)
      validateRelativePath(input.relativePath)
    } catch (error) {
      await this.record(input.runId, input.actor, 'write', 'denied', errorCode(error), targetDigest)
      throw error
    }
    if (input.plaintext.byteLength > MAX_EVIDENCE_BYTES) {
      throw quarantineError('E2E_QUARANTINE_EVIDENCE_TOO_LARGE', '单个原始证据不得超过 64MiB')
    }
    const manifest = await this.loadActiveManifest(input.runId)
    if (manifest.status !== 'open') {
      throw quarantineError('E2E_QUARANTINE_RUN_NOT_WRITABLE', '隐私解锁后的恢复 Run 不允许继续捕获原始证据')
    }
    const plaintextDigest = digestBytes('quarantine-plaintext/v1', input.plaintext)
    const existing = manifest.files.find((record) => record.relativePath === input.relativePath)
    if (existing !== undefined) {
      if (existing.byteLength !== input.plaintext.byteLength
        || existing.plaintextDigest !== plaintextDigest) {
        throw quarantineError('E2E_QUARANTINE_EVIDENCE_EXISTS', '同一路径的原始证据已存在且内容不同')
      }
      await this.assertSecureRunDirectories(input.runId)
      const aad = evidenceAad({
        runId: input.runId, keyId: manifest.keyId, relativePath: existing.relativePath,
        pathDigest: existing.pathDigest, plaintextDigest: existing.plaintextDigest,
        byteLength: existing.byteLength,
      })
      const envelope = SealedEvidenceEnvelopeSchema.parse(
        JSON.parse((await readNoFollow(
          join(this.runDirectory(input.runId), existing.ciphertextFile),
        )).toString('utf8')),
      )
      if (envelope.aadDigest !== digestBytes('quarantine-aad/v1', aad)) {
        throw quarantineError(
          'E2E_QUARANTINE_AUTHENTICATION_FAILED',
          '幂等证据重放发现密文 AAD 不匹配',
        )
      }
      await this.record(
        input.runId, input.actor, 'write', 'allowed',
        'E2E_QUARANTINE_WRITE_IDEMPOTENT_REPLAY', targetDigest,
      )
      return { ...existing }
    }
    await this.assertSecureRunDirectories(input.runId)
    await this.record(input.runId, input.actor, 'write', 'allowed', 'E2E_QUARANTINE_WRITE_AUTHORIZED', targetDigest)

    const aad = evidenceAad({
      runId: input.runId, keyId: manifest.keyId, relativePath: input.relativePath,
      pathDigest: targetDigest, plaintextDigest, byteLength: input.plaintext.byteLength,
    })
    const aadDigest = digestBytes('quarantine-aad/v1', aad)
    const envelope = await this.#secrets.seal({
      keyId: manifest.keyId, plaintext: input.plaintext, aad, aadDigest,
    })
    const ciphertextFile = `objects/${targetDigest.slice('sha256:'.length)}.sealed.json`
    await writeExclusive(
      join(this.runDirectory(input.runId), ciphertextFile),
      Buffer.from(canonicalizeJson(envelope)),
      0o600,
    )
    const record: QuarantineEvidenceRecord = {
      relativePath: input.relativePath, pathDigest: targetDigest, ciphertextFile,
      plaintextDigest, byteLength: input.plaintext.byteLength, createdAt: this.#now().toISOString(),
    }
    manifest.files.push(record)
    await this.writeManifest(manifest)
    return { ...record }
  }

  async readEvidence(input: {
    runId: string
    relativePath: string
    actor: QuarantineActor
  }): Promise<Buffer> {
    const targetDigest = digestText('quarantine-path/v1', input.relativePath)
    if (!input.actor.roles.some((role) => role === 'e2e-sanitizer' || role === 'privacy-approver')) {
      await this.record(input.runId, input.actor, 'read', 'denied', 'E2E_QUARANTINE_ACCESS_DENIED', targetDigest)
      throw quarantineError('E2E_QUARANTINE_ACCESS_DENIED', '只有 sanitizer 或隐私审批人可以读取 Quarantine')
    }
    validateRunId(input.runId)
    validateRelativePath(input.relativePath)
    const manifest = await this.loadActiveManifest(input.runId)
    const privacyUnlockValid = manifest.status === 'privacy-unlocked'
      && manifest.privacyUnlock !== undefined
      && this.#now().getTime() < Date.parse(manifest.privacyUnlock.expiresAt)
    const sanitizerAllowed = input.actor.roles.includes('e2e-sanitizer')
      && (manifest.status === 'open' || privacyUnlockValid)
    const privacyApproverAllowed = input.actor.roles.includes('privacy-approver')
      && privacyUnlockValid
      && input.actor.subject === manifest.privacyUnlock?.approverSubject
    if (!sanitizerAllowed && !privacyApproverAllowed) {
      const reason = manifest.status === 'privacy-unlocked'
        ? 'E2E_QUARANTINE_PRIVACY_UNLOCK_EXPIRED'
        : 'E2E_QUARANTINE_ACCESS_DENIED'
      await this.record(input.runId, input.actor, 'read', 'denied', reason, targetDigest)
      throw quarantineError(reason, '当前 Run 状态或隐私解锁期限不允许该主体读取')
    }
    const record = manifest.files.find((candidate) => candidate.relativePath === input.relativePath)
    if (!record) throw quarantineError('E2E_QUARANTINE_EVIDENCE_UNKNOWN', '原始证据不存在')
    await this.assertSecureRunDirectories(input.runId)
    await this.record(input.runId, input.actor, 'read', 'allowed', 'E2E_QUARANTINE_READ_AUTHORIZED', targetDigest)
    try {
      const envelope = SealedEvidenceEnvelopeSchema.parse(JSON.parse(
        (await readNoFollow(join(this.runDirectory(input.runId), record.ciphertextFile))).toString('utf8'),
      ))
      const aad = evidenceAad({
        runId: input.runId, keyId: manifest.keyId, relativePath: record.relativePath,
        pathDigest: record.pathDigest, plaintextDigest: record.plaintextDigest, byteLength: record.byteLength,
      })
      if (envelope.aadDigest !== digestBytes('quarantine-aad/v1', aad)) throw new Error('AAD digest mismatch')
      const plaintext = await this.#secrets.open({ keyId: manifest.keyId, envelope, aad })
      if (
        plaintext.byteLength !== record.byteLength
        || digestBytes('quarantine-plaintext/v1', plaintext) !== record.plaintextDigest
      ) throw new Error('Plaintext digest mismatch')
      return Buffer.from(plaintext)
    } catch (cause) {
      await this.record(input.runId, input.actor, 'decrypt', 'denied', 'E2E_QUARANTINE_AUTHENTICATION_FAILED', targetDigest)
      throw quarantineError('E2E_QUARANTINE_AUTHENTICATION_FAILED', '证据密文、认证标签或 AAD 校验失败', cause)
    }
  }

  async destroyAfterPublication(input: {
    runId: string
    generationDigest: string
    actor: QuarantineActor
  }): Promise<void> {
    if (!input.actor.roles.includes('e2e-publisher')) {
      await this.record(input.runId, input.actor, 'destroy', 'denied', 'E2E_QUARANTINE_ACCESS_DENIED')
      throw quarantineError('E2E_QUARANTINE_ACCESS_DENIED', '发布后销毁需要 e2e-publisher 角色')
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.generationDigest)) {
      throw quarantineError('E2E_QUARANTINE_GENERATION_DIGEST_INVALID', '发布 generation digest 无效')
    }
    const manifest = await this.loadActiveManifest(input.runId)
    if (manifest.status === 'committed-pending-erasure') {
      if (manifest.generationDigest !== input.generationDigest) {
        throw quarantineError('E2E_QUARANTINE_GENERATION_DIGEST_MISMATCH', '已提交 generation digest 不匹配')
      }
    } else {
      manifest.status = 'committed-pending-erasure'
      manifest.generationDigest = input.generationDigest
      delete manifest.privacyUnlock
      await this.record(
        input.runId, input.actor, 'publication-committed', 'allowed',
        'E2E_QUARANTINE_COMMITTED_PENDING_ERASURE', input.generationDigest,
      )
      await this.writeManifest(manifest)
    }
    await this.record(
      input.runId, input.actor, 'destroy', 'allowed',
      'E2E_QUARANTINE_PUBLICATION_CRYPTO_ERASURE', input.generationDigest,
    )
    await this.cryptoErase(manifest)
  }

  /** Runtime 重启后只恢复已确认提交 generation 的 crypto-erasure，不恢复发布。 */
  async resumePendingErasure(actor: QuarantineActor): Promise<string[]> {
    requireRole(actor, 'e2e-publisher')
    await this.assertSecureRoot()
    const erased: string[] = []
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue
      let manifest: QuarantineRunManifest
      try { manifest = await this.loadManifest(entry.name) } catch { continue }
      if (manifest.status !== 'committed-pending-erasure' || manifest.generationDigest === undefined) continue
      await this.record(
        manifest.runId, actor, 'destroy', 'allowed',
        'E2E_QUARANTINE_RESUMED_CRYPTO_ERASURE', manifest.generationDigest,
      )
      await this.cryptoErase(manifest)
      erased.push(manifest.runId)
    }
    return erased.sort()
  }

  async recoverRun(input:
    | {
        runId: string
        action: 'unlock'
        actor: QuarantineActor
        grant: PrivacyUnlockGrant
        verifyGrant: (grant: PrivacyUnlockGrant) => boolean | Promise<boolean>
      }
    | { runId: string; action: 'destroy'; actor: QuarantineActor }
  ): Promise<QuarantineRunManifest | void> {
    validateRunId(input.runId)
    if (!['unlock', 'destroy'].includes(input.action)) {
      throw quarantineError('E2E_QUARANTINE_RECOVERY_ACTION_DENIED', '崩溃恢复只允许 unlock 或 destroy，禁止自动发布')
    }
    const manifest = await this.loadManifest(input.runId)
    if (this.#now().getTime() >= Date.parse(manifest.expiresAt)) {
      await this.expireManifest(manifest)
      throw quarantineError('E2E_QUARANTINE_EXPIRED', 'Quarantine 已过期并完成 crypto-erasure')
    }
    if (input.action === 'destroy') {
      if (!input.actor.roles.includes('e2e-privacy-admin')) {
        await this.record(input.runId, input.actor, 'recovery-destroy', 'denied', 'E2E_QUARANTINE_ACCESS_DENIED')
        throw quarantineError('E2E_QUARANTINE_ACCESS_DENIED', '恢复销毁需要 e2e-privacy-admin 角色')
      }
      await this.record(input.runId, input.actor, 'recovery-destroy', 'allowed', 'E2E_QUARANTINE_RECOVERY_DESTROYED')
      await this.cryptoErase(manifest)
      return
    }

    const grant = input.grant
    const validScope = input.actor.roles.includes('privacy-approver')
      && input.actor.subject === grant.approver.subject
      && grant.approver.roles.includes('privacy-approver')
      && grant.runId === manifest.runId
      && grant.quarantineKeyId === manifest.keyId
      && this.#now().getTime() >= Date.parse(grant.issuedAt)
      && this.#now().getTime() < Date.parse(grant.expiresAt)
      && await input.verifyGrant(grant)
    if (!validScope || manifest.status !== 'open') {
      await this.record(input.runId, input.actor, 'recovery-unlock', 'denied', 'E2E_QUARANTINE_PRIVACY_GRANT_INVALID')
      throw quarantineError('E2E_QUARANTINE_PRIVACY_GRANT_INVALID', '隐私解锁 Grant 无效、过期或与 Run/Key 不匹配')
    }
    manifest.status = 'privacy-unlocked'
    manifest.privacyUnlock = {
      grantId: grant.grantId,
      approverSubject: grant.approver.subject,
      expiresAt: grant.expiresAt,
    }
    await this.record(input.runId, input.actor, 'recovery-unlock', 'allowed', 'E2E_QUARANTINE_PRIVACY_UNLOCKED')
    await this.writeManifest(manifest)
    return copyManifest(manifest)
  }

  async expireRuns(): Promise<string[]> {
    await this.assertSecureRoot()
    const expired: string[] = []
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue
      let manifest: QuarantineRunManifest
      try {
        manifest = await this.loadManifest(entry.name)
      } catch {
        continue
      }
      if (this.#now().getTime() >= Date.parse(manifest.expiresAt)) {
        await this.expireManifest(manifest)
        expired.push(manifest.runId)
      }
    }
    return expired.sort()
  }

  private async loadActiveManifest(runId: string): Promise<QuarantineRunManifest> {
    const manifest = await this.loadManifest(runId)
    if (this.#now().getTime() >= Date.parse(manifest.expiresAt)) {
      await this.expireManifest(manifest)
      throw quarantineError('E2E_QUARANTINE_EXPIRED', 'Quarantine 已过期并完成 crypto-erasure')
    }
    return manifest
  }

  private async loadManifest(runId: string): Promise<QuarantineRunManifest> {
    const manifest = QuarantineRunManifestSchema.parse(JSON.parse(
      (await readNoFollow(join(this.runDirectory(runId), 'manifest.json'))).toString('utf8'),
    ))
    if (manifest.runId !== runId) throw quarantineError('E2E_QUARANTINE_MANIFEST_MISMATCH', 'Manifest Run ID 不匹配')
    return manifest
  }

  private async expireManifest(manifest: QuarantineRunManifest): Promise<void> {
    const system: QuarantineActor = { subject: 'system:quarantine-ttl', roles: ['e2e-privacy-admin'] }
    await this.record(manifest.runId, system, 'expire', 'allowed', 'E2E_QUARANTINE_TTL_CRYPTO_ERASURE')
    await this.cryptoErase(manifest)
  }

  private async cryptoErase(manifest: QuarantineRunManifest): Promise<void> {
    await this.#secrets.destroyKey(manifest.keyId)
    await rm(this.runDirectory(manifest.runId), { recursive: true, force: true })
  }

  private async writeManifest(manifest: QuarantineRunManifest): Promise<void> {
    const directory = this.runDirectory(manifest.runId)
    const current = await lstat(join(directory, 'manifest.json'))
    if (!current.isFile() || current.isSymbolicLink()) throw quarantineError('E2E_QUARANTINE_SYMLINK_DENIED', 'Manifest 必须是普通文件')
    const temporary = join(directory, `.manifest-${randomUUID()}.tmp`)
    await writeExclusive(temporary, Buffer.from(canonicalizeJson(manifest)), 0o600)
    await rename(temporary, join(directory, 'manifest.json'))
  }

  private async assertSecureRoot(): Promise<void> {
    const info = await lstat(this.#root)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw quarantineError('E2E_QUARANTINE_ROOT_PERMISSIONS_INSECURE', 'Quarantine root 必须是非 symlink 且 group/other 无权限的目录')
    }
    let directory = this.#root
    while (true) {
      try {
        await lstat(join(directory, '.git'))
        throw quarantineError('E2E_QUARANTINE_GIT_WORKTREE_DENIED', 'Quarantine root 必须位于 Git 工作区之外')
      } catch (error) {
        if (error instanceof E2EError) throw error
        if (!isMissingFileError(error)) throw error
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  private async assertSecureRunDirectories(runId: string): Promise<void> {
    for (const directory of [this.runDirectory(runId), join(this.runDirectory(runId), 'objects')]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw quarantineError('E2E_QUARANTINE_DIRECTORY_INSECURE', 'Quarantine run 目录不安全')
      }
    }
  }

  private runDirectory(runId: string): string {
    return join(this.#root, runId)
  }

  private async record(
    runId: string,
    actor: QuarantineActor,
    action: QuarantineAuditEvent['action'],
    decision: QuarantineAuditEvent['decision'],
    reasonCode: string,
    targetDigest?: string,
  ): Promise<void> {
    await this.#audit.append({
      runId, actorSubject: actor.subject, actorRoles: [...actor.roles], action, decision, reasonCode,
      ...(targetDigest === undefined ? {} : { targetDigest }), timestamp: this.#now().toISOString(),
    })
  }
}

async function writeExclusive(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw quarantineError('E2E_QUARANTINE_FILE_INVALID', 'Quarantine 对象必须是普通文件')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function evidenceAad(input: {
  runId: string
  keyId: string
  relativePath: string
  pathDigest: string
  plaintextDigest: string
  byteLength: number
}): Buffer {
  return Buffer.from(canonicalizeJson({ schemaVersion: '1.0.0', ...input }), 'utf8')
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw quarantineError('E2E_QUARANTINE_RUN_ID_INVALID', 'Run ID 包含非法字符')
  }
}

function validateRelativePath(relativePath: string): void {
  const segments = relativePath.split('/')
  if (
    relativePath.length > 4096
    || relativePath.startsWith('/')
    || segments.length < 2
    || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment))
  ) throw quarantineError('E2E_QUARANTINE_PATH_INVALID', '证据路径必须是安全的多段相对路径')
}

function requireRole(actor: QuarantineActor, role: QuarantineActor['roles'][number]): void {
  if (!actor.subject || !actor.roles.includes(role)) throw quarantineError('E2E_QUARANTINE_ACCESS_DENIED', `需要角色 ${role}`)
}

function copyManifest(manifest: QuarantineRunManifest): QuarantineRunManifest {
  return { ...manifest, files: manifest.files.map((record) => ({ ...record })) }
}

function errorCode(error: unknown): string {
  return error instanceof E2EError ? error.code : 'E2E_QUARANTINE_INTERNAL_ERROR'
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function quarantineError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable: false, cause })
}
