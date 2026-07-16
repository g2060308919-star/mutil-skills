import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const processTransactionTails = new Map<string, Promise<void>>()

export interface SqliteStateDirectoryIdentity {
  realPath: string
  device: string
  inode: string
}

export interface SqliteSnapshotStoreOptions {
  forbiddenRoots: string[]
  expectedStateDirectory?: SqliteStateDirectoryIdentity
}

/** 单主机 Authority 状态的同步事务容器；调用方在事务内完成内存重建和 CAS。 */
export class SqliteSnapshotStore {
  readonly #database: DatabaseSync
  readonly #namespace: string
  readonly #processLockKey: string
  readonly #stateLeafDescriptor: number
  #closed = false

  constructor(statePath: string, namespace: string, options: SqliteSnapshotStoreOptions) {
    if (!statePath || !namespace) throw new Error('E2E_AUTHORITY_STATE_CONFIG_INVALID')
    if (options.forbiddenRoots.length === 0) throw new Error('E2E_AUTHORITY_STATE_FORBIDDEN_ROOTS_REQUIRED')
    if (options.expectedStateDirectory === undefined) {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    }
    assertExpectedStateDirectory(dirname(statePath), options.expectedStateDirectory)
    if (existsSync(statePath) && lstatSync(statePath).isSymbolicLink()) {
      throw new Error('E2E_AUTHORITY_STATE_SYMLINK_FORBIDDEN')
    }
    const realStateDirectory = realpathSync(dirname(statePath))
    for (const root of options.forbiddenRoots) {
      const realRoot = realpathSync(root)
      const pathFromRoot = relative(realRoot, realStateDirectory)
      if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
        throw new Error('E2E_AUTHORITY_STATE_INSIDE_TEST_WORKSPACE')
      }
    }
    const pinnedLeaf = openPinnedSqliteLeaf(statePath)
    this.#stateLeafDescriptor = pinnedLeaf.descriptor
    try {
      this.#database = new DatabaseSync(statePath)
    } catch (error) {
      const cleanupErrors = closeDescriptor(this.#stateLeafDescriptor)
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'E2E_AUTHORITY_STATE_OPEN_CLEANUP_FAILED')
      }
      throw error
    }
    try {
      assertExpectedStateDirectory(dirname(statePath), options.expectedStateDirectory)
      assertPinnedSqliteLeaf(statePath, pinnedLeaf)
      if (lstatSync(statePath).isSymbolicLink()) {
        throw new Error('E2E_AUTHORITY_STATE_SYMLINK_FORBIDDEN')
      }
      const realStatePath = realpathSync(statePath)
      for (const root of options.forbiddenRoots) {
        const realRoot = realpathSync(root)
        const pathFromRoot = relative(realRoot, realStatePath)
        if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
          throw new Error('E2E_AUTHORITY_STATE_INSIDE_TEST_WORKSPACE')
        }
      }
      this.#namespace = namespace
      this.#processLockKey = `${resolve(statePath)}\u0000${namespace}`
      this.#database.exec(`
        PRAGMA busy_timeout = 10000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS authority_snapshots (
          namespace TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          snapshot TEXT NOT NULL
        ) STRICT;
      `)
    } catch (error) {
      const cleanupErrors = closeDatabaseAndDescriptor(this.#database, this.#stateLeafDescriptor)
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'E2E_AUTHORITY_STATE_OPEN_CLEANUP_FAILED')
      }
      throw error
    }
  }

  /**
   * DatabaseSync 的 busy_timeout 会阻塞当前事件循环。相同进程中的多个实例先在这里异步排队，
   * SQLite 锁只负责不同进程之间的互斥，避免持锁 await 与同步重试形成事件循环死锁。
   */
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error('E2E_AUTHORITY_STATE_STORE_CLOSED')
    const previous = processTransactionTails.get(this.#processLockKey) ?? Promise.resolve()
    let release!: () => void
    const reservation = new Promise<void>((resolveReservation) => { release = resolveReservation })
    const tail = previous.then(() => reservation)
    processTransactionTails.set(this.#processLockKey, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (processTransactionTails.get(this.#processLockKey) === tail) {
        processTransactionTails.delete(this.#processLockKey)
      }
    }
  }

  /** 同步 API 不能等待同进程异步事务；检测到竞争时快速失败，禁止阻塞事件循环。 */
  runExclusiveSync<T>(operation: () => T): T {
    if (this.#closed) throw new Error('E2E_AUTHORITY_STATE_STORE_CLOSED')
    if (processTransactionTails.has(this.#processLockKey)) {
      throw new Error('E2E_AUTHORITY_STATE_BUSY')
    }
    return operation()
  }

  initialize(snapshot: string): string {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#read()
      if (existing !== undefined) {
        this.#database.exec('COMMIT')
        return existing
      }
      this.#database.prepare(
        'INSERT INTO authority_snapshots(namespace, revision, snapshot) VALUES (?, 1, ?)',
      ).run(this.#namespace, snapshot)
      this.#database.exec('COMMIT')
      return snapshot
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  begin(): string {
    if (this.#closed) throw new Error('E2E_AUTHORITY_STATE_STORE_CLOSED')
    this.#database.exec('BEGIN IMMEDIATE')
    const snapshot = this.#read()
    if (snapshot === undefined) {
      this.#database.exec('ROLLBACK')
      throw new Error('E2E_AUTHORITY_STATE_MISSING')
    }
    return snapshot
  }

  commit(snapshot: string): void {
    try {
      const result = this.#database.prepare(
        'UPDATE authority_snapshots SET revision = revision + 1, snapshot = ? WHERE namespace = ?',
      ).run(snapshot, this.#namespace)
      if (result.changes !== 1) throw new Error('E2E_AUTHORITY_STATE_UPDATE_FAILED')
      this.#database.exec('COMMIT')
    } catch (error) {
      try { this.#database.exec('ROLLBACK') } catch { /* transaction 已结束 */ }
      throw error
    }
  }

  rollback(): void {
    try { this.#database.exec('ROLLBACK') } catch { /* commit 失败时可能已经完成回滚 */ }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const errors = closeDatabaseAndDescriptor(this.#database, this.#stateLeafDescriptor)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'E2E_AUTHORITY_STATE_CLOSE_FAILED')
  }

  #read(): string | undefined {
    const row = this.#database.prepare(
      'SELECT snapshot FROM authority_snapshots WHERE namespace = ?',
    ).get(this.#namespace) as { snapshot?: unknown } | undefined
    return typeof row?.snapshot === 'string' ? row.snapshot : undefined
  }
}

interface PinnedSqliteLeaf {
  descriptor: number
  device: string
  inode: string
}

function closeDescriptor(descriptor: number): unknown[] {
  try { closeSync(descriptor); return [] }
  catch (error) { return [error] }
}

function closeDatabaseAndDescriptor(database: DatabaseSync, descriptor: number): unknown[] {
  const errors: unknown[] = []
  try { database.close() } catch (error) { errors.push(error) }
  errors.push(...closeDescriptor(descriptor))
  return errors
}

function openPinnedSqliteLeaf(statePath: string): PinnedSqliteLeaf {
  let descriptor: number
  try {
    descriptor = openSync(
      statePath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    descriptor = openSync(statePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  }
  try {
    const metadata = fstatSync(descriptor)
    const pathMetadata = lstatSync(statePath)
    if (!metadata.isFile() || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || metadata.nlink !== 1 || pathMetadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || pathMetadata.uid !== process.getuid?.()
      || String(metadata.dev) !== String(pathMetadata.dev)
      || String(metadata.ino) !== String(pathMetadata.ino)) {
      throw new Error('E2E_AUTHORITY_STATE_LEAF_INVALID')
    }
    fchmodSync(descriptor, 0o600)
    if ((fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new Error('E2E_AUTHORITY_STATE_LEAF_INVALID')
    }
    return { descriptor, device: String(metadata.dev), inode: String(metadata.ino) }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function assertPinnedSqliteLeaf(statePath: string, expected: PinnedSqliteLeaf): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(statePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    const metadata = fstatSync(descriptor)
    const pathMetadata = lstatSync(statePath)
    if (!metadata.isFile() || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || metadata.nlink !== 1 || pathMetadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || pathMetadata.uid !== process.getuid?.()
      || String(metadata.dev) !== expected.device || String(metadata.ino) !== expected.inode
      || String(metadata.dev) !== String(pathMetadata.dev)
      || String(metadata.ino) !== String(pathMetadata.ino)
      || (metadata.mode & 0o777) !== 0o600) {
      throw new Error('E2E_AUTHORITY_STATE_LEAF_REBOUND')
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertExpectedStateDirectory(
  stateDirectory: string,
  expected: SqliteStateDirectoryIdentity | undefined,
): void {
  if (expected === undefined) return
  const metadata = statSync(stateDirectory)
  if (realpathSync(stateDirectory) !== expected.realPath
    || String(metadata.dev) !== expected.device
    || String(metadata.ino) !== expected.inode) {
    throw new Error('E2E_AUTHORITY_STATE_DIRECTORY_REBOUND')
  }
}
