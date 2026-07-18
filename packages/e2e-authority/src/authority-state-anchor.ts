import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'

const CURRENT_ANCHOR_FILE = 'current.anchor'

export interface AuthorityStateAnchorRecord {
  schemaVersion: '1.0.0'
  revision: number
  snapshotDigest: string
  mac: string
}

export interface AuthorityStateAnchorPoint {
  revision: number
  snapshotDigest: string
}

/**
 * 由独立信任域实现的单调状态 provider 契约。只有 securityLevel 为
 * trusted-monotonic、并且 provider 的存储权限与 Authority DB/密钥相互独立时，
 * 调用方才能声明抵抗同 UID 对 Authority 状态的整体回滚。
 *
 * 方法必须同步、线性化并且失败关闭：compareAndAdvance 只能把精确 expected
 * 原子推进到 revision + 1 的 next，不能接受跳号、回退或隐式初始化。
 */
export interface TrustedMonotonicAuthorityStateAnchor {
  readonly securityLevel: 'trusted-monotonic'
  read(): AuthorityStateAnchorPoint | undefined
  initialize(initial: AuthorityStateAnchorPoint): void
  compareAndAdvance(expected: AuthorityStateAnchorPoint, next: AuthorityStateAnchorPoint): void
  close(): void
}

/** @internal LocalApprovalAuthority 通过 SQLite 单写者串行调用本地 provider。 */
export interface AuthorityStateAnchorProvider {
  readonly securityLevel: 'trusted-monotonic' | 'local-crash-integrity'
  read(): AuthorityStateAnchorPoint | undefined
  initialize(initial: AuthorityStateAnchorPoint): void
  compareAndAdvance(expected: AuthorityStateAnchorPoint, next: AuthorityStateAnchorPoint): void
  close(): void
}

/**
 * 有界的本地 crash/integrity provider。它只保存一个认证高水位，因此空间与读取
 * 成本恒定。它与 SQLite 处于相同 UID/文件系统信任域，不能抵抗攻击者整体回滚
 * DB、stateEncryptionKey 与 anchor；生产若要求该威胁能力必须注入独立可信 provider。
 */
export class AuthorityStateAnchor implements AuthorityStateAnchorProvider {
  readonly securityLevel = 'local-crash-integrity' as const
  readonly #directory: string
  readonly #path: string
  readonly #key: Buffer
  readonly #directoryDescriptor: number
  readonly #directoryIdentity: { device: string; inode: string }
  #closed = false

  constructor(statePath: string, namespace: string, key: Uint8Array) {
    const namespaceDigest = digestText('authority-state-anchor-namespace/v1', namespace).slice('sha256:'.length, 24)
    this.#directory = join(dirname(statePath), `.${basename(statePath)}.${namespaceDigest}.anchors`)
    this.#path = join(this.#directory, CURRENT_ANCHOR_FILE)
    this.#key = Buffer.from(key)
    if (this.#key.byteLength !== 32) anchorError('E2E_AUTHORITY_STATE_ANCHOR_KEY_INVALID')
    let directoryDescriptor: number | undefined
    try {
      if (!existsSync(this.#directory)) mkdirSync(this.#directory, { mode: 0o700 })
      const before = lstatSync(this.#directory)
      directoryDescriptor = openSync(this.#directory,
        constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(directoryDescriptor)
      if (!validOwnedNode(before, 'directory', 0o700) || !validOwnedNode(opened, 'directory', 0o700)
        || !sameNode(before, opened)) anchorError('E2E_AUTHORITY_STATE_ANCHOR_DIRECTORY_INVALID')
      if (directoryEntryExists(join(this.#directory, '.pending.anchor'))) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_RECOVERY_REQUIRED')
      }
      this.#directoryDescriptor = directoryDescriptor
      this.#directoryIdentity = { device: String(opened.dev), inode: String(opened.ino) }
      directoryDescriptor = undefined
    } catch (error) {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
      this.#key.fill(0)
      throw error
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#key.fill(0)
    closeSync(this.#directoryDescriptor)
  }

  read(): AuthorityStateAnchorRecord | undefined {
    this.#assertDirectoryIdentity()
    let before: Stats
    try { before = lstatSync(this.#path) }
    catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    if (!validOwnedNode(before, 'file', 0o600) || before.nlink !== 1) {
      anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
    }
    let descriptor: number | undefined
    let candidate: unknown
    try {
      descriptor = openSync(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(descriptor)
      if (!validOwnedNode(before, 'file', 0o600) || !validOwnedNode(opened, 'file', 0o600)
        || before.nlink !== 1 || opened.nlink !== 1 || opened.size < 1 || opened.size > 16 * 1024
        || !sameNode(before, opened)) anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
      try { candidate = JSON.parse(readFileSync(descriptor, 'utf8')) }
      catch { anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID') }
      const after = lstatSync(this.#path)
      const afterOpened = fstatSync(descriptor)
      if (!sameNode(opened, after) || !sameNode(opened, afterOpened)
        || !validOwnedNode(after, 'file', 0o600) || after.nlink !== 1) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    this.#assertDirectoryIdentity()
    return this.#parse(candidate)
  }

  initialize(initial: AuthorityStateAnchorPoint): void {
    const existing = this.read()
    if (existing !== undefined) {
      if (!samePoint(existing, initial)) anchorError('E2E_AUTHORITY_STATE_ANCHOR_FORK')
      return
    }
    this.#replace(undefined, initial)
  }

  compareAndAdvance(expected: AuthorityStateAnchorPoint, next: AuthorityStateAnchorPoint): void {
    validatePoint(expected)
    validatePoint(next)
    if (next.revision !== expected.revision + 1) {
      anchorError('E2E_AUTHORITY_STATE_ANCHOR_SEQUENCE_INVALID')
    }
    const current = this.read()
    if (current === undefined) anchorError('E2E_AUTHORITY_STATE_ANCHOR_MISSING')
    if (!samePoint(current, expected)) anchorError('E2E_AUTHORITY_STATE_ROLLBACK_DETECTED')
    this.#replace(expected, next)
  }

  #replace(expected: AuthorityStateAnchorPoint | undefined, next: AuthorityStateAnchorPoint): void {
    const record = this.#record(next)
    const temporary = join(this.#directory, '.pending.anchor')
    let descriptor: number | undefined
    let temporaryCreated = false
    let temporaryIdentity: { device: string; inode: string } | undefined
    try {
      // 再次读取缩短进程内竞态窗口；独立可信 provider 必须自行提供真正 CAS。
      const current = this.read()
      if (expected === undefined ? current !== undefined : current === undefined || !samePoint(current, expected)) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_FORK')
      }
      descriptor = openSync(temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
      temporaryCreated = true
      fchmodSync(descriptor, 0o600)
      const temporaryStat = fstatSync(descriptor)
      if (!validOwnedNode(temporaryStat, 'file', 0o600) || temporaryStat.nlink !== 1) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
      }
      temporaryIdentity = { device: String(temporaryStat.dev), inode: String(temporaryStat.ino) }
      writeFileSync(descriptor, canonicalizeJson(record), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      const beforeRename = this.read()
      if (expected === undefined ? beforeRename !== undefined
        : beforeRename === undefined || !samePoint(beforeRename, expected)) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_FORK')
      }
      const temporaryPathStat = lstatSync(temporary)
      if (!validOwnedNode(temporaryPathStat, 'file', 0o600) || temporaryPathStat.nlink !== 1
        || temporaryIdentity === undefined
        || String(temporaryPathStat.dev) !== temporaryIdentity.device
        || String(temporaryPathStat.ino) !== temporaryIdentity.inode) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
      }
      this.#assertDirectoryIdentity()
      renameSync(temporary, this.#path)
      fsyncSync(this.#directoryDescriptor)
      const committed = this.read()
      if (committed === undefined || !samePoint(committed, next)) {
        anchorError('E2E_AUTHORITY_STATE_ANCHOR_FORK')
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (temporaryCreated) {
        try { unlinkSync(temporary) } catch { /* 已 rename 或本次临时文件清理 */ }
      }
    }
  }

  #assertDirectoryIdentity(): void {
    const pathNode = lstatSync(this.#directory)
    const opened = fstatSync(this.#directoryDescriptor)
    if (!validOwnedNode(pathNode, 'directory', 0o700) || !validOwnedNode(opened, 'directory', 0o700)
      || String(pathNode.dev) !== this.#directoryIdentity.device
      || String(pathNode.ino) !== this.#directoryIdentity.inode
      || !sameNode(pathNode, opened)) anchorError('E2E_AUTHORITY_STATE_ANCHOR_DIRECTORY_INVALID')
  }

  #record(point: AuthorityStateAnchorPoint): AuthorityStateAnchorRecord {
    validatePoint(point)
    const core = { schemaVersion: '1.0.0' as const, ...point }
    return { ...core, mac: anchorMac(this.#key, core) }
  }

  #parse(value: unknown): AuthorityStateAnchorRecord {
    if (!plain(value) || Object.keys(value).sort().join('\0')
      !== ['mac', 'revision', 'schemaVersion', 'snapshotDigest'].sort().join('\0')
      || value.schemaVersion !== '1.0.0' || typeof value.mac !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(value.mac)) {
      anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
    }
    validatePoint(value as unknown as AuthorityStateAnchorPoint)
    const record = value as unknown as AuthorityStateAnchorRecord
    const expected = Buffer.from(anchorMac(this.#key, {
      schemaVersion: record.schemaVersion, revision: record.revision, snapshotDigest: record.snapshotDigest,
    }), 'base64url')
    const actual = Buffer.from(record.mac, 'base64url')
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
    }
    return record
  }
}

export function authoritySnapshotMac(key: Uint8Array, input: {
  revision: number; snapshotDigest: string
}): string {
  return createHmac('sha256', key).update(canonicalizeJson({
    purpose: 'authority-state-snapshot-proof/v1', ...input,
  })).digest('base64url')
}

function anchorMac(key: Uint8Array, input: Omit<AuthorityStateAnchorRecord, 'mac'>): string {
  return createHmac('sha256', key).update(canonicalizeJson({
    purpose: 'authority-state-monotonic-anchor/v1', ...input,
  })).digest('base64url')
}

function validatePoint(value: AuthorityStateAnchorPoint): void {
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.snapshotDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.snapshotDigest)) {
    anchorError('E2E_AUTHORITY_STATE_ANCHOR_INVALID')
  }
}

function samePoint(left: AuthorityStateAnchorPoint, right: AuthorityStateAnchorPoint): boolean {
  return left.revision === right.revision && left.snapshotDigest === right.snapshotDigest
}

function validOwnedNode(
  stat: Stats,
  kind: 'file' | 'directory',
  mode: number,
): boolean {
  const correctKind = kind === 'file' ? stat.isFile() : stat.isDirectory()
  return correctKind && !stat.isSymbolicLink() && (stat.mode & 0o777) === mode
    && (process.getuid === undefined || stat.uid === process.getuid())
}

function sameNode(
  left: Stats,
  right: Stats,
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function isMissing(value: unknown): boolean {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === 'ENOENT'
}

function directoryEntryExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function anchorError(code: string): never {
  throw new E2EError({ code, category: 'safety', message: code, retryable: false })
}
