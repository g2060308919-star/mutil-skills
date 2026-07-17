import { SqliteSnapshotStore, type SqliteStateDirectoryIdentity } from '@mutil-skills/e2e-authority'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runtimeLayout } from './runtime-layout.js'
import type { SecretProvider } from './secret-providers.js'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SECRET_REF = /^[A-Z][A-Z0-9_-]{0,127}$/
const PROVIDERS = new Set<SecretProviderId>(['interactive', 'macos-keychain', 'linux-secret-service'])
const MAX_SECRET_BYTES = 64 * 1024
const MAX_ENTRIES = 1024
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const STATE_FILE = 'runtime-secrets.sqlite'
const MASTER_KEY_FILE = 'runtime-secrets.key'

export type SecretProviderId = 'interactive' | 'macos-keychain' | 'linux-secret-service'

export interface OneTimeSecretHandle {
  readonly handleId: string
}

interface HandleBinding {
  runId: string
  secretRef: string
  providerId: SecretProviderId
  version: number
  consumed: boolean
}

interface EncryptedValue {
  nonce: string
  ciphertext: string
  tag: string
}

interface AvailableEntry {
  version: number
  providerId: SecretProviderId
  status: 'available'
  encrypted: EncryptedValue
}

interface ConsumedEntry {
  version: number
  providerId: SecretProviderId
  status: 'consumed'
}

interface ResolvingEntry {
  version: number
  providerId: Exclude<SecretProviderId, 'interactive'>
  status: 'resolving'
  reservationId: string
}

interface SecretRunState {
  projectIdentityDigest: string
  wrappedDataKey: EncryptedValue
  entries: Record<string, AvailableEntry | ConsumedEntry | ResolvingEntry>
}

interface SecretStoreSnapshot {
  schemaVersion: '1.0.0'
  runs: Record<string, SecretRunState>
}

export interface RuntimeSecretBrokerOpenOptions {
  homeDir: string
  projectRoot: string
  projectIdentityDigest?: string
  providers?: SecretProvider[]
}

/** Runtime 内部秘密边界；故意不从包根导出。 */
export class RuntimeSecretBroker {
  readonly #store: SqliteSnapshotStore
  readonly #masterKey: Buffer
  readonly #bindings = new WeakMap<OneTimeSecretHandle, HandleBinding>()
  readonly #providers: ReadonlyMap<SecretProviderId, SecretProvider>
  readonly #projectIdentityDigest: string
  #closed = false

  private constructor(
    store: SqliteSnapshotStore,
    masterKey: Buffer,
    providers: ReadonlyMap<SecretProviderId, SecretProvider>,
    projectIdentityDigest: string,
  ) {
    this.#store = store
    this.#masterKey = masterKey
    this.#providers = providers
    this.#projectIdentityDigest = projectIdentityDigest
  }

  static async open(options: RuntimeSecretBrokerOpenOptions): Promise<RuntimeSecretBroker> {
    validateOpenOptions(options)
    const stateRoot = runtimeLayout(options.homeDir).state
    assertOutsideProject(stateRoot, options.projectRoot)
    const projectIdentityDigest = options.projectIdentityDigest ?? await physicalProjectBinding(options.projectRoot)
    const identity = await ensurePrivateStateRoot(options.homeDir, stateRoot)
    const masterKey = openMasterKey(join(stateRoot, MASTER_KEY_FILE))
    let store: SqliteSnapshotStore | undefined
    try {
      store = new SqliteSnapshotStore(join(stateRoot, STATE_FILE), 'e2e-runtime-secrets/v1', {
        forbiddenRoots: ['/dev', options.projectRoot],
        expectedStateDirectory: identity,
      })
      store.initialize(canonicalizeJson(emptySnapshot()))
      const broker = new RuntimeSecretBroker(
        store, masterKey, validateProviders(options.providers ?? []), projectIdentityDigest,
      )
      await broker.#readVerifiedSnapshot()
      return broker
    } catch (cause) {
      masterKey.fill(0)
      try { store?.close() } catch { /* preserve original fail-closed cause */ }
      if (cause instanceof E2EError) throw cause
      throw secretError('E2E_SECRET_STATE_INTEGRITY_FAILED', 'Secret state 无法认证或打开', cause)
    }
  }

  async provide(input: {
    runId: string
    secretRef: string
    value: Uint8Array
    providerId?: SecretProviderId
  }): Promise<void> {
    this.#requireOpen()
    const providerId = input.providerId ?? 'interactive'
    validateBinding(input.runId, input.secretRef, providerId)
    if (input.value.byteLength === 0) throw secretError('E2E_SECRET_INPUT_INVALID', '秘密不能为空')
    if (input.value.byteLength > MAX_SECRET_BYTES) {
      throw secretError('E2E_SECRET_VALUE_TOO_LARGE', '秘密超过 64KiB 上限')
    }
    const plaintext = Buffer.from(input.value)
    try {
      await this.#mutate((snapshot) => {
        let run = snapshot.runs[input.runId]
        let dataKey: Buffer
        if (run === undefined) {
          if (countEntries(snapshot) >= MAX_ENTRIES) {
            throw secretError('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret state 已达到容量上限')
          }
          dataKey = randomBytes(32)
          run = {
            projectIdentityDigest: this.#projectIdentityDigest,
            wrappedDataKey: encrypt(
              this.#masterKey, dataKey, dataKeyAad(input.runId, this.#projectIdentityDigest),
            ),
            entries: {},
          }
          snapshot.runs[input.runId] = run
        } else {
          this.#assertRunProject(run)
          dataKey = decrypt(
            this.#masterKey, run.wrappedDataKey, dataKeyAad(input.runId, this.#projectIdentityDigest),
          )
        }
        try {
          const previous = run.entries[input.secretRef]
          if (previous === undefined && countEntries(snapshot) >= MAX_ENTRIES) {
            throw secretError('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret state 已达到容量上限')
          }
          const version = (previous?.version ?? 0) + 1
          if (!Number.isSafeInteger(version)) throw secretError('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret version 已耗尽')
          run.entries[input.secretRef] = {
            version,
            providerId,
            status: 'available',
            encrypted: encrypt(dataKey, plaintext, secretAad(input.runId, input.secretRef, providerId)),
          }
        } finally {
          dataKey.fill(0)
        }
      })
    } finally {
      plaintext.fill(0)
    }
  }

  async resolve(input: {
    runId: string
    secretRef: string
    providerId?: SecretProviderId
  }): Promise<OneTimeSecretHandle> {
    this.#requireOpen()
    const providerId = input.providerId ?? 'interactive'
    validateBinding(input.runId, input.secretRef, providerId)
    let entry = await this.#read((snapshot) => {
      const run = snapshot.runs[input.runId]
      if (run !== undefined) this.#assertRunProject(run)
      return run?.entries[input.secretRef]
    })
    if (entry === undefined && providerId !== 'interactive') {
      const provider = this.#providers.get(providerId)
      if (provider === undefined) throw secretError('E2E_SECRET_PROVIDER_UNAVAILABLE', '未配置请求的系统 provider')
      const reservationId = randomUUID()
      const reservation = await this.#mutate((snapshot) => {
        const existing = snapshot.runs[input.runId]?.entries[input.secretRef]
        if (snapshot.runs[input.runId] !== undefined) this.#assertRunProject(snapshot.runs[input.runId]!)
        if (existing !== undefined) return { kind: 'existing' as const, entry: existing }
        if (countEntries(snapshot) >= MAX_ENTRIES) {
          throw secretError('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret state 已达到容量上限')
        }
        let run = snapshot.runs[input.runId]
        if (run === undefined) {
          const dataKey = randomBytes(32)
          try {
            run = {
              projectIdentityDigest: this.#projectIdentityDigest,
              wrappedDataKey: encrypt(
                this.#masterKey, dataKey, dataKeyAad(input.runId, this.#projectIdentityDigest),
              ),
              entries: {},
            }
            snapshot.runs[input.runId] = run
          } finally { dataKey.fill(0) }
        }
        const resolving: ResolvingEntry = { version: 1, providerId, status: 'resolving', reservationId }
        run.entries[input.secretRef] = resolving
        return { kind: 'reserved' as const, entry: resolving }
      })
      entry = reservation.entry
      if (reservation.kind === 'reserved') {
        let systemValue: Buffer | undefined
        try {
          systemValue = await provider.resolve(input.secretRef)
          if (systemValue === undefined || systemValue.byteLength === 0 || systemValue.byteLength > MAX_SECRET_BYTES) {
            await this.#finishProviderReservation(input.runId, input.secretRef, reservationId, undefined)
            throw secretError('E2E_SECRET_NOT_PROVIDED', '系统 provider 未返回可用值')
          }
          await this.#finishProviderReservation(input.runId, input.secretRef, reservationId, systemValue)
        } catch (cause) {
          if (systemValue === undefined) {
            await this.#finishProviderReservation(input.runId, input.secretRef, reservationId, undefined).catch(() => undefined)
          }
          throw cause
        } finally { systemValue?.fill(0) }
        entry = await this.#read((snapshot) => {
          const run = snapshot.runs[input.runId]
          if (run !== undefined) this.#assertRunProject(run)
          return run?.entries[input.secretRef]
        })
      }
    }
    if (entry?.status === 'resolving') {
      throw secretError('E2E_SECRET_PROVIDER_RESOLUTION_PENDING', '系统 provider 读取已被另一进程保留')
    }
    if (entry === undefined || entry.status !== 'available' || entry.providerId !== providerId) {
      throw secretError('E2E_SECRET_NOT_PROVIDED', '未找到可用的一次性秘密')
    }
    const handle: OneTimeSecretHandle = Object.freeze({ handleId: randomUUID() })
    this.#bindings.set(handle, {
      runId: input.runId,
      secretRef: input.secretRef,
      providerId,
      version: entry.version,
      consumed: false,
    })
    return handle
  }

  async consume(handle: OneTimeSecretHandle): Promise<Buffer> {
    this.#requireOpen()
    const binding = this.#bindings.get(handle)
    if (binding === undefined) throw secretError('E2E_SECRET_HANDLE_INVALID', 'handle 不是由当前 Broker 签发')
    if (binding.consumed) throw secretError('E2E_SECRET_HANDLE_CONSUMED', 'handle 已消费')
    let plaintext: Buffer | undefined
    try {
      await this.#mutate((snapshot) => {
        const run = snapshot.runs[binding.runId]
        if (run !== undefined) this.#assertRunProject(run)
        const entry = run?.entries[binding.secretRef]
        if (entry === undefined || entry.status === 'consumed') {
          binding.consumed = true
          throw secretError('E2E_SECRET_HANDLE_CONSUMED', '秘密已由其他消费者消费')
        }
        if (entry.status === 'resolving') {
          throw secretError('E2E_SECRET_HANDLE_STALE', 'handle 对应的 provider reservation 已改变')
        }
        if (entry.version !== binding.version || entry.providerId !== binding.providerId) {
          throw secretError('E2E_SECRET_HANDLE_STALE', 'handle 已被新的 provide 版本替代')
        }
        const dataKey = decrypt(
          this.#masterKey,
          run.wrappedDataKey,
          dataKeyAad(binding.runId, this.#projectIdentityDigest),
        )
        try {
          plaintext = decrypt(
            dataKey,
            entry.encrypted,
            secretAad(binding.runId, binding.secretRef, binding.providerId),
          )
          run.entries[binding.secretRef] = {
            version: entry.version,
            providerId: entry.providerId,
            status: 'consumed',
          }
        } finally {
          dataKey.fill(0)
        }
      })
      binding.consumed = true
      return plaintext!
    } catch (cause) {
      plaintext?.fill(0)
      throw cause
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try { this.#store.close() } finally { this.#masterKey.fill(0) }
  }

  async #finishProviderReservation(
    runId: string,
    secretRef: string,
    reservationId: string,
    value: Buffer | undefined,
  ): Promise<void> {
    await this.#mutate((snapshot) => {
      const run = snapshot.runs[runId]
      if (run !== undefined) this.#assertRunProject(run)
      const entry = run?.entries[secretRef]
      if (entry?.status !== 'resolving' || entry.reservationId !== reservationId) {
        throw secretError('E2E_SECRET_PROVIDER_RESERVATION_LOST', '系统 provider reservation 已改变')
      }
      if (value === undefined) {
        run.entries[secretRef] = { version: entry.version, providerId: entry.providerId, status: 'consumed' }
        return
      }
      const dataKey = decrypt(
        this.#masterKey, run.wrappedDataKey, dataKeyAad(runId, this.#projectIdentityDigest),
      )
      try {
        run.entries[secretRef] = {
          version: entry.version,
          providerId: entry.providerId,
          status: 'available',
          encrypted: encrypt(dataKey, value, secretAad(runId, secretRef, entry.providerId)),
        }
      } finally { dataKey.fill(0) }
    })
  }

  async #read<T>(project: (snapshot: SecretStoreSnapshot) => T): Promise<T> {
    return await this.#store.runExclusive(async () => {
      const raw = this.#store.begin()
      try {
        const snapshot = parseSnapshot(raw)
        verifySnapshotCryptography(snapshot, this.#masterKey)
        const projected = project(snapshot)
        this.#store.rollback()
        return projected === undefined ? projected : structuredClone(projected)
      } catch (cause) {
        this.#store.rollback()
        throw normalizeStateError(cause)
      }
    })
  }

  async #readVerifiedSnapshot(): Promise<void> {
    await this.#read(() => undefined)
  }

  async #mutate<T>(operation: (snapshot: SecretStoreSnapshot) => T): Promise<T> {
    return await this.#store.runExclusive(async () => {
      const raw = this.#store.begin()
      try {
        const snapshot = parseSnapshot(raw)
        verifySnapshotCryptography(snapshot, this.#masterKey)
        const result = operation(snapshot)
        this.#store.commit(serializeSnapshot(snapshot))
        return result
      } catch (cause) {
        this.#store.rollback()
        throw normalizeStateError(cause)
      }
    })
  }

  #requireOpen(): void {
    if (this.#closed) throw secretError('E2E_SECRET_BROKER_CLOSED', 'Secret Broker 已关闭')
  }

  #assertRunProject(run: SecretRunState): void {
    if (run.projectIdentityDigest !== this.#projectIdentityDigest) {
      throw secretError('E2E_SECRET_PROJECT_BINDING_MISMATCH', 'Secret Run 不属于当前项目身份')
    }
  }
}

function emptySnapshot(): SecretStoreSnapshot {
  return { schemaVersion: '1.0.0', runs: {} }
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedValue {
  const nonce = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    try {
      return {
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: tag.toString('base64url'),
      }
    } finally {
      ciphertext.fill(0)
      tag.fill(0)
    }
  } finally {
    nonce.fill(0)
    aad.fill(0)
  }
}

function decrypt(key: Buffer, encrypted: EncryptedValue, aad: Buffer): Buffer {
  const nonce = decodeCanonicalBase64Url(encrypted.nonce, 12)
  const ciphertext = decodeCanonicalBase64Url(encrypted.ciphertext, MAX_SECRET_BYTES + 32)
  const tag = decodeCanonicalBase64Url(encrypted.tag, 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } finally {
    nonce.fill(0)
    ciphertext.fill(0)
    tag.fill(0)
    aad.fill(0)
  }
}

function secretAad(runId: string, secretRef: string, providerId: SecretProviderId): Buffer {
  return Buffer.from(canonicalizeJson({ runId, secretRef, providerId }), 'utf8')
}

function dataKeyAad(runId: string, projectIdentityDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: 'e2e-secret-data-key/v1', runId, projectIdentityDigest,
  }), 'utf8')
}

function parseSnapshot(raw: string): SecretStoreSnapshot {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('snapshot too large')
  const value = JSON.parse(raw) as unknown
  if (!plainRecord(value) || !exactKeys(value, ['runs', 'schemaVersion']) || value.schemaVersion !== '1.0.0'
    || !plainRecord(value.runs) || Object.keys(value.runs).length > MAX_ENTRIES) throw new Error('invalid snapshot')
  let total = 0
  for (const [runId, runValue] of Object.entries(value.runs)) {
    if (!RUN_ID.test(runId) || !plainRecord(runValue)
      || !exactKeys(runValue, ['entries', 'projectIdentityDigest', 'wrappedDataKey'])
      || typeof runValue.projectIdentityDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(runValue.projectIdentityDigest)
      || !validEncrypted(runValue.wrappedDataKey, 32) || !plainRecord(runValue.entries)) throw new Error('invalid run')
    for (const [secretRef, entry] of Object.entries(runValue.entries)) {
      total += 1
      if (total > MAX_ENTRIES || !SECRET_REF.test(secretRef) || !plainRecord(entry)
        || !Number.isSafeInteger(entry.version) || (entry.version as number) < 1
        || !PROVIDERS.has(entry.providerId as SecretProviderId)) throw new Error('invalid entry')
      if (entry.status === 'available') {
        if (!exactKeys(entry, ['encrypted', 'providerId', 'status', 'version'])
          || !validEncrypted(entry.encrypted, MAX_SECRET_BYTES)) throw new Error('invalid available entry')
      } else if (entry.status === 'consumed') {
        if (!exactKeys(entry, ['providerId', 'status', 'version'])) throw new Error('invalid consumed entry')
      } else if (entry.status === 'resolving') {
        if (!exactKeys(entry, ['providerId', 'reservationId', 'status', 'version'])
          || entry.providerId === 'interactive' || typeof entry.reservationId !== 'string'
          || !/^[0-9a-f-]{36}$/.test(entry.reservationId)) throw new Error('invalid resolving entry')
      } else throw new Error('invalid entry status')
    }
  }
  return value as unknown as SecretStoreSnapshot
}

function serializeSnapshot(snapshot: SecretStoreSnapshot): string {
  const serialized = canonicalizeJson(snapshot)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw secretError('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret snapshot 超过 4MiB 上限')
  }
  return serialized
}

function verifySnapshotCryptography(snapshot: SecretStoreSnapshot, masterKey: Buffer): void {
  for (const [runId, run] of Object.entries(snapshot.runs)) {
    const dataKey = decrypt(masterKey, run.wrappedDataKey, dataKeyAad(runId, run.projectIdentityDigest))
    try {
      if (dataKey.byteLength !== 32) throw new Error('invalid data key')
      for (const [secretRef, entry] of Object.entries(run.entries)) {
        if (entry.status !== 'available') continue
        const plaintext = decrypt(dataKey, entry.encrypted, secretAad(runId, secretRef, entry.providerId))
        try {
          if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_BYTES) throw new Error('invalid secret')
        } finally { plaintext.fill(0) }
      }
    } finally { dataKey.fill(0) }
  }
}

function validEncrypted(value: unknown, maxCiphertext: number): value is EncryptedValue {
  if (!plainRecord(value) || !exactKeys(value, ['ciphertext', 'nonce', 'tag'])
    || typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string' || typeof value.tag !== 'string') return false
  try {
    const nonce = decodeCanonicalBase64Url(value.nonce, 12)
    const ciphertext = decodeCanonicalBase64Url(value.ciphertext, maxCiphertext)
    const tag = decodeCanonicalBase64Url(value.tag, 16)
    const valid = nonce.byteLength === 12 && ciphertext.byteLength > 0 && ciphertext.byteLength <= maxCiphertext
      && tag.byteLength === 16
    nonce.fill(0); ciphertext.fill(0); tag.fill(0)
    return valid
  } catch { return false }
}

function decodeCanonicalBase64Url(value: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3) + 2) throw new Error('invalid base64url')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength > maxBytes || decoded.toString('base64url') !== value) {
    decoded.fill(0)
    throw new Error('invalid base64url')
  }
  return decoded
}

async function ensurePrivateStateRoot(homeDir: string, stateRoot: string): Promise<SqliteStateDirectoryIdentity> {
  const canonicalHome = await realpath(resolve(homeDir)).catch((cause) => {
    throw secretError('E2E_SECRET_STATE_ROOT_INVALID', 'homeDir 不存在', cause)
  })
  if (canonicalHome !== normalizePath(resolve(homeDir))) {
    throw secretError('E2E_SECRET_STATE_ROOT_INVALID', 'homeDir 不得是符号链接')
  }
  let current = canonicalHome
  for (const component of ['.mutil-skills', 'e2e', 'state']) {
    current = join(current, component)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid(metadata.uid)
      || (metadata.mode & 0o777) !== 0o700) {
      throw secretError('E2E_SECRET_STATE_ROOT_INVALID', 'Secret state 各层必须为当前 UID 的 0700 真实目录')
    }
  }
  const canonical = await realpath(stateRoot)
  const metadata = await lstat(stateRoot)
  if (canonical !== normalizePath(resolve(stateRoot))) throw secretError('E2E_SECRET_STATE_ROOT_INVALID', 'Secret state canonical path 不一致')
  return { realPath: canonical, device: String(metadata.dev), inode: String(metadata.ino) }
}

function openMasterKey(path: string): Buffer {
  let descriptor: number | undefined
  let created = false
  try {
    try {
      descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    }
    const before = fstatSync(descriptor)
    const pathMetadata = lstatSync(path)
    if (!validMasterKeyMetadata(before, pathMetadata, created ? 0 : 32)) {
      throw new Error('invalid master key metadata')
    }
    if (created) {
      const generated = randomBytes(32)
      try {
        let offset = 0
        while (offset < generated.byteLength) {
          const written = writeSync(descriptor, generated, offset, generated.byteLength - offset, offset)
          if (written <= 0) throw new Error('master key write made no progress')
          offset += written
        }
        fsyncSync(descriptor)
        const parentDescriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
        try { fsyncSync(parentDescriptor) } finally { closeSync(parentDescriptor) }
      } finally { generated.fill(0) }
    }
    const after = fstatSync(descriptor)
    const pathAfter = lstatSync(path)
    const key = Buffer.alloc(32)
    if (!validMasterKeyMetadata(after, pathAfter, 32)
      || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)
      || readSync(descriptor, key, 0, 32, 0) !== 32
      || !validMasterKeyMetadata(fstatSync(descriptor), lstatSync(path), 32)) {
      key.fill(0)
      throw new Error('invalid master key contents')
    }
    return key
  } catch (cause) {
    if (created) {
      try { unlinkSync(path) } catch { /* invalid partial key remains unusable */ }
    }
    throw secretError('E2E_SECRET_MASTER_KEY_INVALID', 'Secret master key 必须为当前 UID 独占的 0600 普通文件', cause)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function validMasterKeyMetadata(
  descriptorMetadata: KeyMetadata,
  pathMetadata: KeyMetadata,
  expectedSize: number,
): boolean {
  return descriptorMetadata.isFile() && pathMetadata.isFile() && !pathMetadata.isSymbolicLink()
    && descriptorMetadata.nlink === 1 && pathMetadata.nlink === 1
    && descriptorMetadata.uid === currentUid(descriptorMetadata.uid)
    && pathMetadata.uid === currentUid(pathMetadata.uid)
    && (descriptorMetadata.mode & 0o777) === 0o600 && (pathMetadata.mode & 0o777) === 0o600
    && String(descriptorMetadata.dev) === String(pathMetadata.dev)
    && String(descriptorMetadata.ino) === String(pathMetadata.ino)
    && descriptorMetadata.size === expectedSize && pathMetadata.size === expectedSize
}

interface KeyMetadata {
  isFile(): boolean
  isSymbolicLink(): boolean
  nlink: number
  uid: number
  mode: number
  dev: number | bigint
  ino: number | bigint
  size: number
}

function assertOutsideProject(stateRoot: string, projectRoot: string): void {
  const state = resolve(stateRoot)
  const project = resolve(projectRoot)
  if (contains(project, state) || contains(state, project)) {
    throw secretError('E2E_SECRET_STATE_INSIDE_PROJECT', 'Secret state 与项目目录不得重叠')
  }
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function validateOpenOptions(options: RuntimeSecretBrokerOpenOptions): void {
  if (!options.homeDir || !options.projectRoot || !isAbsolute(options.homeDir) || !isAbsolute(options.projectRoot)) {
    throw secretError('E2E_SECRET_INPUT_INVALID', 'homeDir/projectRoot 必须为绝对路径')
  }
  if (options.projectIdentityDigest !== undefined
    && !/^sha256:[a-f0-9]{64}$/.test(options.projectIdentityDigest)) {
    throw secretError('E2E_SECRET_INPUT_INVALID', 'projectIdentityDigest 不合法')
  }
}

async function physicalProjectBinding(projectRoot: string): Promise<string> {
  const [canonical, metadata] = await Promise.all([realpath(projectRoot), lstat(projectRoot)])
  if (canonical !== normalizePath(resolve(projectRoot)) || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw secretError('E2E_SECRET_PROJECT_BINDING_INVALID', 'projectRoot 必须为 canonical 真实目录')
  }
  return digestText('e2e-secret-project-binding/v1', canonicalizeJson({
    realRoot: canonical,
    device: String(metadata.dev),
    inode: String(metadata.ino),
  }))
}

function validateProviders(providers: SecretProvider[]): ReadonlyMap<SecretProviderId, SecretProvider> {
  const result = new Map<SecretProviderId, SecretProvider>()
  for (const provider of providers) {
    if (!PROVIDERS.has(provider.id) || provider.id === 'interactive' || result.has(provider.id)
      || typeof provider.resolve !== 'function') {
      throw secretError('E2E_SECRET_PROVIDER_CONFIG_INVALID', '系统 provider 配置重复或不合法')
    }
    result.set(provider.id, provider)
  }
  return result
}

function validateBinding(runId: string, secretRef: string, providerId: SecretProviderId): void {
  if (!RUN_ID.test(runId) || !SECRET_REF.test(secretRef) || !PROVIDERS.has(providerId)) {
    throw secretError('E2E_SECRET_INPUT_INVALID', 'runId、secretRef 或 providerId 不符合固定 grammar')
  }
}

function countEntries(snapshot: SecretStoreSnapshot): number {
  return Object.values(snapshot.runs).reduce((count, run) => count + Object.keys(run.entries).length, 0)
}

function normalizeStateError(cause: unknown): E2EError {
  return cause instanceof E2EError
    ? cause
    : secretError('E2E_SECRET_STATE_INTEGRITY_FAILED', 'Secret state schema 或认证失败', cause)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function currentUid(fallback: number): number {
  return typeof process.getuid === 'function' ? process.getuid() : fallback
}

function normalizePath(path: string): string {
  if (process.platform !== 'darwin') return path
  for (const alias of ['/etc', '/tmp', '/var']) {
    if (path === alias || path.startsWith(`${alias}/`)) return `/private${path}`
  }
  return path
}

function secretError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
