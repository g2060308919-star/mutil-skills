import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const processTransactionTails = new Map<string, Promise<void>>()

/** 单主机 Authority 状态的同步事务容器；调用方在事务内完成内存重建和 CAS。 */
export class SqliteSnapshotStore {
  readonly #database: DatabaseSync
  readonly #namespace: string
  readonly #processLockKey: string
  #closed = false

  constructor(statePath: string, namespace: string, options: { forbiddenRoots: string[] }) {
    if (!statePath || !namespace) throw new Error('E2E_AUTHORITY_STATE_CONFIG_INVALID')
    if (options.forbiddenRoots.length === 0) throw new Error('E2E_AUTHORITY_STATE_FORBIDDEN_ROOTS_REQUIRED')
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
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
    this.#database = new DatabaseSync(statePath)
    if (lstatSync(statePath).isSymbolicLink()) {
      this.#database.close()
      throw new Error('E2E_AUTHORITY_STATE_SYMLINK_FORBIDDEN')
    }
    const realStatePath = realpathSync(statePath)
    for (const root of options.forbiddenRoots) {
      const realRoot = realpathSync(root)
      const pathFromRoot = relative(realRoot, realStatePath)
      if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
        this.#database.close()
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
    chmodSync(statePath, 0o600)
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
    this.#database.close()
  }

  #read(): string | undefined {
    const row = this.#database.prepare(
      'SELECT snapshot FROM authority_snapshots WHERE namespace = ?',
    ).get(this.#namespace) as { snapshot?: unknown } | undefined
    return typeof row?.snapshot === 'string' ? row.snapshot : undefined
  }
}
