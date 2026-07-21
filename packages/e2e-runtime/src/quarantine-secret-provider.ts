import { constants } from 'node:fs'
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  E2EError,
  canonicalizeJson,
  digestText,
  type SealedEvidenceEnvelope,
} from '@mutil-skills/e2e-contracts'
import type { QuarantineSecretProvider } from '@mutil-skills/e2e-engine'
import { deriveRuntimeQuarantineMasterKey } from './authority-host.js'
import { runtimeLayout } from './runtime-layout.js'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const KEY_PREFIX = 'runtime-quarantine-key.'
const WRAP_INFO = Buffer.from('mutil-skills/e2e/quarantine-key-wrap/v1', 'utf8')

interface PersistedKeyEnvelope {
  schemaVersion: '1.0.0'
  keyId: string
  runId: string
  expiresAt: string
  algorithm: 'HKDF-SHA256+AES-256-GCM'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
  aadDigest: string
}

/**
 * Runtime 的持久 Quarantine key provider。
 *
 * 项目目录永远不持有密钥；每个随机 data key 使用独立 HKDF domain 派生的 wrapping key
 * 包装，并且只在一次 seal/open 调用期间以明文 Buffer 存活。
 */
export class RuntimeQuarantineSecretProvider implements QuarantineSecretProvider {
  readonly #quarantineRoot: string
  readonly #projectRoot: string
  readonly #masterKey: Buffer
  #closed = false

  static async createForProject(input: {
    homeDir: string
    projectRoot: string
  }): Promise<RuntimeQuarantineSecretProvider> {
    const derived = await deriveRuntimeQuarantineMasterKey(input.homeDir)
    try {
      const quarantineRoot = runtimeLayout(input.homeDir).quarantine
      // EncryptedQuarantine 在 createRun 的第一步即验证根目录；Provider 必须先建立
      // 并验证该 Git 外安全边界，不能等到稍后的 createRunKey 才创建。
      await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
      await assertSecureDirectory(quarantineRoot, 'E2E_QUARANTINE_KEY_ROOT_INSECURE')
      return new RuntimeQuarantineSecretProvider({
        quarantineRoot,
        projectRoot: input.projectRoot,
        masterKey: derived.masterKey,
      })
    } finally {
      derived.clear()
    }
  }

  constructor(input: { quarantineRoot: string; projectRoot: string; masterKey: Uint8Array }) {
    if (!isAbsolute(input.quarantineRoot) || !isAbsolute(input.projectRoot)
      || input.masterKey.byteLength !== 32) {
      throw quarantineKeyError('E2E_QUARANTINE_KEY_CONFIGURATION_INVALID', 'Quarantine key provider 配置无效')
    }
    this.#quarantineRoot = resolve(input.quarantineRoot)
    this.#projectRoot = resolve(input.projectRoot)
    if (isWithin(this.#projectRoot, this.#quarantineRoot)) {
      throw quarantineKeyError(
        'E2E_QUARANTINE_PROJECT_ROOT_DENIED',
        'Quarantine key envelope 不得位于项目工作区内',
      )
    }
    this.#masterKey = Buffer.from(input.masterKey)
  }

  async createRunKey(input: { runId: string; expiresAt: string }): Promise<{ keyId: string }> {
    this.#assertOpen()
    validateRunInput(input)
    await this.#assertSecureRoot()
    const runDirectory = join(this.#quarantineRoot, input.runId)
    await mkdir(runDirectory, { recursive: true, mode: 0o700 })
    await assertSecureDirectory(runDirectory, 'E2E_QUARANTINE_KEY_RUN_DIRECTORY_INSECURE')
    const keyId = `${KEY_PREFIX}${Buffer.from(input.runId, 'utf8').toString('base64url')}.${randomUUID()}`
    const dataKey = randomBytes(32)
    const salt = randomBytes(32)
    const iv = randomBytes(12)
    let wrappingKey: Buffer | undefined
    try {
      wrappingKey = deriveWrappingKey(this.#masterKey, salt)
      const publicFields = {
        schemaVersion: '1.0.0' as const,
        keyId,
        runId: input.runId,
        expiresAt: new Date(input.expiresAt).toISOString(),
        algorithm: 'HKDF-SHA256+AES-256-GCM' as const,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
      }
      const aad = Buffer.from(canonicalizeJson(publicFields), 'utf8')
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv, { authTagLength: 16 })
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])
      const envelope: PersistedKeyEnvelope = {
        ...publicFields,
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        aadDigest: digestText('runtime-quarantine-key-aad/v1', aad.toString('utf8')),
      }
      await writeAtomicSecure(
        join(runDirectory, 'key-envelope.json'), Buffer.from(canonicalizeJson(envelope)),
      )
      return { keyId }
    } finally {
      dataKey.fill(0)
      salt.fill(0)
      iv.fill(0)
      wrappingKey?.fill(0)
    }
  }

  async seal(input: {
    keyId: string
    plaintext: Uint8Array
    aad: Uint8Array
    aadDigest: string
  }): Promise<SealedEvidenceEnvelope> {
    this.#assertOpen()
    if (!DIGEST.test(input.aadDigest)) {
      throw quarantineKeyError('E2E_QUARANTINE_EVIDENCE_AAD_INVALID', 'Evidence AAD digest 无效')
    }
    return await this.#withDataKey(input.keyId, async (key) => {
      const iv = randomBytes(12)
      try {
        const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
        cipher.setAAD(input.aad)
        const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
        return {
          schemaVersion: '1.0.0', keyId: input.keyId, algorithm: 'AES-256-GCM',
          iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'), aadDigest: input.aadDigest,
        }
      } finally {
        iv.fill(0)
      }
    })
  }

  async open(input: {
    keyId: string
    envelope: SealedEvidenceEnvelope
    aad: Uint8Array
  }): Promise<Uint8Array> {
    this.#assertOpen()
    if (input.envelope.keyId !== input.keyId || input.envelope.algorithm !== 'AES-256-GCM') {
      throw quarantineKeyError('E2E_QUARANTINE_EVIDENCE_KEY_MISMATCH', 'Evidence envelope 与 key 不匹配')
    }
    return await this.#withDataKey(input.keyId, async (key) => {
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm', key, decodeBase64(input.envelope.iv, 12), { authTagLength: 16 },
        )
        decipher.setAAD(input.aad)
        decipher.setAuthTag(decodeBase64(input.envelope.authTag, 16))
        return Buffer.concat([
          decipher.update(decodeBase64(input.envelope.ciphertext)),
          decipher.final(),
        ])
      } catch (cause) {
        throw quarantineKeyError(
          'E2E_QUARANTINE_EVIDENCE_AUTHENTICATION_FAILED', 'Evidence 密文认证失败', cause,
        )
      }
    })
  }

  async destroyKey(keyId: string): Promise<void> {
    this.#assertOpen()
    const runId = parseRunIdFromKeyId(keyId)
    await this.#assertSecureRoot()
    const runDirectory = join(this.#quarantineRoot, runId)
    const path = join(runDirectory, 'key-envelope.json')
    await rm(path, { force: true })
    await syncDirectoryIfPresent(runDirectory)
  }

  async hasKey(keyId: string): Promise<boolean> {
    this.#assertOpen()
    const runId = parseRunIdFromKeyId(keyId)
    await this.#assertSecureRoot()
    try {
      const envelope = await readEnvelope(join(this.#quarantineRoot, runId, 'key-envelope.json'))
      if (envelope.keyId !== keyId || envelope.runId !== runId) {
        throw quarantineKeyError('E2E_QUARANTINE_KEY_BINDING_MISMATCH', 'Key envelope 绑定不一致')
      }
      const key = unwrapDataKey(envelope, this.#masterKey)
      key.fill(0)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  /** Runtime shutdown 时主动清零本实例持有的 Authority 派生 key。 */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#masterKey.fill(0)
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw quarantineKeyError('E2E_QUARANTINE_KEY_PROVIDER_CLOSED', 'Quarantine key provider 已关闭')
    }
  }

  async #withDataKey<T>(keyId: string, use: (key: Buffer) => Promise<T>): Promise<T> {
    const runId = parseRunIdFromKeyId(keyId)
    await this.#assertSecureRoot()
    const runDirectory = join(this.#quarantineRoot, runId)
    await assertSecureDirectory(runDirectory, 'E2E_QUARANTINE_KEY_RUN_DIRECTORY_INSECURE')
    const envelope = await readEnvelope(join(runDirectory, 'key-envelope.json'))
    if (envelope.keyId !== keyId || envelope.runId !== runId) {
      throw quarantineKeyError('E2E_QUARANTINE_KEY_BINDING_MISMATCH', 'Key envelope 绑定不一致')
    }
    const dataKey = unwrapDataKey(envelope, this.#masterKey)
    try {
      return await use(dataKey)
    } finally {
      dataKey.fill(0)
    }
  }

  async #assertSecureRoot(): Promise<void> {
    await mkdir(this.#quarantineRoot, { recursive: true, mode: 0o700 })
    await assertSecureDirectory(this.#quarantineRoot, 'E2E_QUARANTINE_KEY_ROOT_INSECURE')
    const [actualRoot, actualProject] = await Promise.all([
      realpath(this.#quarantineRoot), realpath(this.#projectRoot),
    ])
    if (isWithin(actualProject, actualRoot)) {
      throw quarantineKeyError('E2E_QUARANTINE_PROJECT_ROOT_DENIED', 'Quarantine 实路径落入项目工作区')
    }
  }
}

function validateRunInput(input: { runId: string; expiresAt: string }): void {
  const expiresAt = Date.parse(input.expiresAt)
  if (!RUN_ID.test(input.runId) || Number.isNaN(expiresAt)
    || new Date(expiresAt).toISOString() !== input.expiresAt) {
    throw quarantineKeyError('E2E_QUARANTINE_KEY_INPUT_INVALID', 'Run key 输入无效')
  }
}

function deriveWrappingKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, salt, WRAP_INFO, 32))
}

function unwrapDataKey(envelope: PersistedKeyEnvelope, masterKey: Buffer): Buffer {
  const salt = decodeBase64(envelope.salt, 32)
  const iv = decodeBase64(envelope.iv, 12)
  const tag = decodeBase64(envelope.authTag, 16)
  let wrappingKey: Buffer | undefined
  try {
    const publicFields = {
      schemaVersion: envelope.schemaVersion,
      keyId: envelope.keyId,
      runId: envelope.runId,
      expiresAt: envelope.expiresAt,
      algorithm: envelope.algorithm,
      salt: envelope.salt,
      iv: envelope.iv,
    }
    const aadText = canonicalizeJson(publicFields)
    if (digestText('runtime-quarantine-key-aad/v1', aadText) !== envelope.aadDigest) {
      throw new Error('AAD digest mismatch')
    }
    wrappingKey = deriveWrappingKey(masterKey, salt)
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(aadText, 'utf8'))
    decipher.setAuthTag(tag)
    const key = Buffer.concat([decipher.update(decodeBase64(envelope.ciphertext, 32)), decipher.final()])
    if (key.byteLength !== 32) throw new Error('Key length mismatch')
    return key
  } catch (cause) {
    throw quarantineKeyError('E2E_QUARANTINE_KEY_AUTHENTICATION_FAILED', 'Run data key 认证失败', cause)
  } finally {
    salt.fill(0)
    iv.fill(0)
    tag.fill(0)
    wrappingKey?.fill(0)
  }
}

async function readEnvelope(path: string): Promise<PersistedKeyEnvelope> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > 64 * 1024) {
      throw quarantineKeyError('E2E_QUARANTINE_KEY_ENVELOPE_INSECURE', 'Key envelope 必须是 0600 单链接普通文件')
    }
    const value = JSON.parse((await handle.readFile()).toString('utf8')) as unknown
    return parsePersistedEnvelope(value)
  } catch (error) {
    if (error instanceof E2EError) throw error
    throw quarantineKeyError('E2E_QUARANTINE_KEY_ENVELOPE_INVALID', 'Key envelope 无效', error)
  } finally {
    await handle.close()
  }
}

function parsePersistedEnvelope(value: unknown): PersistedKeyEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw quarantineKeyError('E2E_QUARANTINE_KEY_ENVELOPE_INVALID', 'Key envelope 不是对象')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const expected = ['aadDigest', 'algorithm', 'authTag', 'ciphertext', 'expiresAt', 'iv', 'keyId', 'runId', 'salt', 'schemaVersion'].sort()
  if (canonicalizeJson(keys) !== canonicalizeJson(expected)
    || candidate.schemaVersion !== '1.0.0'
    || candidate.algorithm !== 'HKDF-SHA256+AES-256-GCM'
    || typeof candidate.keyId !== 'string'
    || typeof candidate.runId !== 'string' || !RUN_ID.test(candidate.runId)
    || typeof candidate.expiresAt !== 'string'
    || Number.isNaN(Date.parse(candidate.expiresAt))
    || typeof candidate.salt !== 'string'
    || typeof candidate.iv !== 'string'
    || typeof candidate.authTag !== 'string'
    || typeof candidate.ciphertext !== 'string'
    || typeof candidate.aadDigest !== 'string' || !DIGEST.test(candidate.aadDigest)) {
    throw quarantineKeyError('E2E_QUARANTINE_KEY_ENVELOPE_INVALID', 'Key envelope 字段无效')
  }
  return candidate as unknown as PersistedKeyEnvelope
}

async function writeAtomicSecure(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(target), `.key-envelope-${randomUUID()}.tmp`)
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  try {
    // POSIX link 是同文件系统、原子且 no-replace；rename 会静默覆盖现有 Run key，
    // 在重复 createRun 失败时破坏旧 Run 的可恢复性。
    await link(temporary, target)
    await rm(temporary)
    await syncDirectoryIfPresent(dirname(target))
  } catch (error) {
    await rm(temporary, { force: true })
    if (error instanceof Error && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw quarantineKeyError(
        'E2E_QUARANTINE_KEY_ALREADY_EXISTS', '同一 Run 的 data key 已存在', error,
      )
    }
    throw error
  }
}

async function assertSecureDirectory(path: string, code: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw quarantineKeyError(code, 'Quarantine key 目录必须是 0700 非符号链接目录')
  }
}

async function syncDirectoryIfPresent(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY | noFollowFlag())
    try { await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function parseRunIdFromKeyId(keyId: string): string {
  const match = new RegExp(`^${KEY_PREFIX.replace('.', '\\.') }([A-Za-z0-9_-]+)\\.[0-9a-f-]{36}$`).exec(keyId)
  if (!match) throw quarantineKeyError('E2E_QUARANTINE_KEY_ID_INVALID', 'Run key ID 无效')
  let runId: string
  try { runId = Buffer.from(match[1]!, 'base64url').toString('utf8') } catch {
    throw quarantineKeyError('E2E_QUARANTINE_KEY_ID_INVALID', 'Run key ID 无效')
  }
  if (!RUN_ID.test(runId) || Buffer.from(runId).toString('base64url') !== match[1]) {
    throw quarantineKeyError('E2E_QUARANTINE_KEY_ID_INVALID', 'Run key ID 不是规范编码')
  }
  return runId
}

function decodeBase64(value: string, exactLength?: number): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (exactLength !== undefined && decoded.byteLength !== exactLength)) {
    decoded.fill(0)
    throw new Error('Invalid base64 encoding')
  }
  return decoded
}

function isWithin(parent: string, child: string): boolean {
  const delta = relative(parent, child)
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta))
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function quarantineKeyError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
