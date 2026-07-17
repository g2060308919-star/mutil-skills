import { SqliteSnapshotStore } from '@mutil-skills/e2e-authority'
import { E2EError } from '@mutil-skills/e2e-contracts'
import { randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep, join } from 'node:path'
import { deriveRuntimeSecretStateKeys, type RuntimeSecretStateKeys } from './authority-host.js'
import {
  MAX_SECRET_BYTES,
  MAX_SECRET_ENTRIES,
  SECRET_PROVIDER_IDS,
  assertSecretBinding,
  secretFailure,
  type SecretProviderId,
} from './secret-contract.js'
import {
  countSecretEntries,
  decryptSecret,
  encryptSecret,
  initialSecretState,
  isRetiredSecretRun,
  parseSecretState,
  secretRunKey,
  serializeSecretState,
  unwrapRunDataKey,
  wrapRunDataKey,
  type PersistedSecretEntry,
  type ActiveSecretRunState,
  type SecretStatePayload,
} from './secret-state.js'
import { assertSameProjectIdentity, resolveProjectIdentity, type ProjectIdentity } from './project-identity.js'
import {
  consumeRuntimeSecretRetirementCapability,
  ensureSecureUserStateRoot,
  RuntimeRunStore,
  type RuntimeSecretRetirementCapability,
} from './run-store.js'
import { runtimeLayout } from './runtime-layout.js'
import {
  createDefaultSystemSecretProviders,
  type SecretProvider,
} from './secret-providers.js'

const STATE_FILE = 'runtime-secrets.sqlite'
const STATE_NAMESPACE = 'e2e-runtime-secrets/v1'
const DEFAULT_RESERVATION_TTL_MS = 30_000

export type { SecretProviderId } from './secret-contract.js'

export interface OneTimeSecretHandle {
  readonly handleId: string
}

interface HandleBinding {
  runId: string
  secretRef: string
  providerId: SecretProviderId
  version: number
}

export interface RuntimeSecretBrokerOpenOptions {
  homeDir: string
  projectRoot: string
  providers?: SecretProvider[]
  now?: () => Date
  reservationTtlMs?: number
  /** 源码测试 seam；npm 根入口不导出。生产省略时固定打开 RuntimeRunStore。 */
  runAccess?: SecretRunAccess
}

export interface SecretRunAccess {
  withActiveSecretRun<T>(
    projectIdentityDigest: string,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T>
}

/** Runtime 内部秘密边界；故意不从包根导出。 */
export class RuntimeSecretBroker {
  readonly #store: SqliteSnapshotStore
  readonly #keys: RuntimeSecretStateKeys
  readonly #bindings = new WeakMap<OneTimeSecretHandle, HandleBinding>()
  readonly #consumedHandles = new WeakSet<OneTimeSecretHandle>()
  readonly #providers: ReadonlyMap<SecretProviderId, SecretProvider>
  readonly #projectIdentity: ProjectIdentity
  readonly #projectRoot: string
  readonly #now: () => Date
  readonly #reservationTtlMs: number
  readonly #runAccess: SecretRunAccess
  readonly #ownedRunStore: RuntimeRunStore | undefined
  #closed = false

  private constructor(input: {
    store: SqliteSnapshotStore
    keys: RuntimeSecretStateKeys
    providers: ReadonlyMap<SecretProviderId, SecretProvider>
    projectIdentity: ProjectIdentity
    projectRoot: string
    now: () => Date
    reservationTtlMs: number
    runAccess: SecretRunAccess
    ownedRunStore?: RuntimeRunStore
  }) {
    this.#store = input.store
    this.#keys = input.keys
    this.#providers = input.providers
    this.#projectIdentity = input.projectIdentity
    this.#projectRoot = input.projectRoot
    this.#now = input.now
    this.#reservationTtlMs = input.reservationTtlMs
    this.#runAccess = input.runAccess
    this.#ownedRunStore = input.ownedRunStore
  }

  static async open(options: RuntimeSecretBrokerOpenOptions): Promise<RuntimeSecretBroker> {
    validateOpenOptions(options)
    const stateRoot = runtimeLayout(options.homeDir).state
    assertOutsideProject(stateRoot, options.projectRoot)
    const projectIdentity = await resolveProjectIdentity(options.projectRoot)
    const providers = validateProviders(options.providers ?? createDefaultSystemSecretProviders())
    let ownedRunStore: RuntimeRunStore | undefined
    let keys: RuntimeSecretStateKeys | undefined
    let store: SqliteSnapshotStore | undefined
    try {
      ownedRunStore = options.runAccess === undefined
        ? await RuntimeRunStore.open({ homeDir: options.homeDir, projectRoot: options.projectRoot })
        : undefined
      const runAccess = options.runAccess ?? ownedRunStore!
      const expectedStateDirectory = await ensureSecureUserStateRoot(options.homeDir, stateRoot)
      keys = await deriveRuntimeSecretStateKeys(options.homeDir)
      store = new SqliteSnapshotStore(join(stateRoot, STATE_FILE), STATE_NAMESPACE, {
        forbiddenRoots: ['/dev', projectIdentity.realRoot],
        expectedStateDirectory,
      })
      store.initialize(initialSecretState(keys.macKey))
      const broker = new RuntimeSecretBroker({
        store,
        keys,
        providers,
        projectIdentity,
        projectRoot: options.projectRoot,
        now: options.now ?? (() => new Date()),
        reservationTtlMs: options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
        runAccess,
        ...(ownedRunStore === undefined ? {} : { ownedRunStore }),
      })
      await broker.#readVerifiedState()
      return broker
    } catch (cause) {
      const cleanupErrors: unknown[] = []
      try { store?.close() } catch (error) { cleanupErrors.push(error) }
      try { await ownedRunStore?.close() } catch (error) { cleanupErrors.push(error) }
      keys?.clear()
      if (cleanupErrors.length > 0) {
        throw new AggregateError([cause, ...cleanupErrors], 'E2E_SECRET_OPEN_CLEANUP_FAILED')
      }
      if (cause instanceof E2EError) throw cause
      throw secretFailure('E2E_SECRET_STATE_INTEGRITY_FAILED', 'Secret state 无法认证或打开', cause)
    }
  }

  async provide(input: {
    runId: string
    secretRef: string
    value: Uint8Array
    providerId?: SecretProviderId
  }): Promise<void> {
    this.#requireOpen()
    await this.#assertCurrentProjectIdentity()
    const providerId = input.providerId ?? 'interactive'
    assertSecretBinding(input.runId, input.secretRef, providerId)
    if (input.value.byteLength === 0) throw secretFailure('E2E_SECRET_INPUT_INVALID', '秘密不能为空')
    if (input.value.byteLength > MAX_SECRET_BYTES) {
      throw secretFailure('E2E_SECRET_VALUE_TOO_LARGE', '秘密超过 64KiB 上限')
    }
    const plaintext = Buffer.from(input.value)
    try {
      await this.#withActiveRun(input.runId, async () => await this.#mutate((state) => {
        const run = this.#getOrCreateRun(state, input.runId)
        const previous = run.entries[input.secretRef]
        if (previous === undefined && countSecretEntries(state) >= MAX_SECRET_ENTRIES) {
          throw secretFailure('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret state 已达到容量上限')
        }
        const version = (previous?.version ?? 0) + 1
        if (!Number.isSafeInteger(version)) {
          throw secretFailure('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret version 已耗尽')
        }
        const dataKey = unwrapRunDataKey(
          this.#keys.wrappingKey,
          run.wrappedDataKey,
          this.#projectIdentity.digest,
          input.runId,
        )
        try {
          run.entries[input.secretRef] = {
            version,
            providerId,
            status: 'available',
            encrypted: encryptSecret(dataKey, plaintext, input.runId, input.secretRef, providerId),
          }
        } finally { dataKey.fill(0) }
      }))
    } finally { plaintext.fill(0) }
  }

  async resolve(input: {
    runId: string
    secretRef: string
    providerId?: SecretProviderId
  }): Promise<OneTimeSecretHandle> {
    this.#requireOpen()
    await this.#assertCurrentProjectIdentity()
    const providerId = input.providerId ?? 'interactive'
    assertSecretBinding(input.runId, input.secretRef, providerId)
    const now = this.#now()
    const attemptId = randomUUID()
    const reservation = await this.#withActiveRun(input.runId, async () => await this.#mutate((state) => {
      const run = state.runs[secretRunKey(this.#projectIdentity.digest, input.runId)]
      if (run !== undefined && isRetiredSecretRun(run)) throw retiredRunFailure()
      let existing = run?.entries[input.secretRef]
      if (existing?.status === 'resolving' && Date.parse(existing.expiresAt) <= now.getTime()) {
        run!.entries[input.secretRef] = {
          ...existing,
          status: 'abandoned',
          terminalAt: now.toISOString(),
        }
        existing = run!.entries[input.secretRef]
      }
      if (existing !== undefined || providerId === 'interactive') {
        return { kind: 'existing' as const, entry: existing }
      }
      const provider = this.#providers.get(providerId)
      if (provider === undefined) {
        throw secretFailure('E2E_SECRET_PROVIDER_UNAVAILABLE', '未配置请求的系统 provider')
      }
      if (countSecretEntries(state) >= MAX_SECRET_ENTRIES) {
        throw secretFailure('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret state 已达到容量上限')
      }
      const targetRun = this.#getOrCreateRun(state, input.runId)
      const resolving = {
        version: 1,
        providerId,
        status: 'resolving' as const,
        attemptId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#reservationTtlMs).toISOString(),
      }
      targetRun.entries[input.secretRef] = resolving
      return { kind: 'reserved' as const, entry: resolving, provider }
    }))

    let entry: PersistedSecretEntry | undefined = reservation.entry
    if (reservation.kind === 'reserved') {
      let providerValue: Buffer | undefined
      try {
        try {
          providerValue = await reservation.provider.resolve(input.secretRef)
        } catch (cause) {
          await this.#finishReservation(input.runId, input.secretRef, attemptId, undefined)
            .catch(() => undefined)
          throw cause
        }
        if (providerValue === undefined || providerValue.byteLength === 0
          || providerValue.byteLength > MAX_SECRET_BYTES) {
          await this.#finishReservation(input.runId, input.secretRef, attemptId, undefined)
          throw secretFailure('E2E_SECRET_NOT_PROVIDED', '系统 provider 未返回可用值')
        }
        try {
          entry = await this.#withActiveRun(input.runId, async () => await this.#finishReservation(
            input.runId, input.secretRef, attemptId, providerValue,
          ))
        } catch (cause) {
          if (isTerminalRunFailure(cause)) {
            await this.#finishReservation(input.runId, input.secretRef, attemptId, undefined)
              .catch(() => undefined)
          }
          throw cause
        }
      } finally { providerValue?.fill(0) }
    }

    if (entry?.status === 'resolving') {
      throw secretFailure('E2E_SECRET_PROVIDER_RESOLUTION_PENDING', '系统 provider 读取已被另一进程保留')
    }
    if (entry === undefined || entry.status !== 'available' || entry.providerId !== providerId) {
      throw secretFailure('E2E_SECRET_NOT_PROVIDED', '未找到可用的一次性秘密')
    }
    const handle: OneTimeSecretHandle = Object.freeze({ handleId: randomUUID() })
    this.#bindings.set(handle, {
      runId: input.runId,
      secretRef: input.secretRef,
      providerId,
      version: entry.version,
    })
    return handle
  }

  async consume(handle: OneTimeSecretHandle): Promise<Buffer> {
    this.#requireOpen()
    await this.#assertCurrentProjectIdentity()
    if (this.#consumedHandles.has(handle)) {
      throw secretFailure('E2E_SECRET_HANDLE_CONSUMED', 'handle 已消费')
    }
    const binding = this.#bindings.get(handle)
    if (binding === undefined) {
      throw secretFailure('E2E_SECRET_HANDLE_INVALID', 'handle 不是由当前 Broker 签发')
    }
    let plaintext: Buffer | undefined
    let consumedExternally = false
    try {
      await this.#withActiveRun(binding.runId, async () => await this.#mutate((state) => {
        const run = state.runs[secretRunKey(this.#projectIdentity.digest, binding.runId)]
        if (run !== undefined && isRetiredSecretRun(run)) throw retiredRunFailure()
        const entry = run?.entries[binding.secretRef]
        if (entry === undefined || entry.status === 'consumed' || entry.status === 'abandoned') {
          consumedExternally = true
          return
        }
        if (entry.status === 'resolving') {
          throw secretFailure('E2E_SECRET_HANDLE_STALE', 'handle 对应的 provider reservation 已改变')
        }
        if (entry.version !== binding.version || entry.providerId !== binding.providerId) {
          throw secretFailure('E2E_SECRET_HANDLE_STALE', 'handle 已被新的 provide 版本替代')
        }
        const dataKey = unwrapRunDataKey(
          this.#keys.wrappingKey,
          run!.wrappedDataKey,
          this.#projectIdentity.digest,
          binding.runId,
        )
        try {
          plaintext = decryptSecret(
            dataKey, entry.encrypted, binding.runId, binding.secretRef, binding.providerId,
          )
          run!.entries[binding.secretRef] = {
            version: entry.version,
            providerId: entry.providerId,
            status: 'consumed',
            terminalAt: this.#now().toISOString(),
          }
        } finally { dataKey.fill(0) }
      }))
      this.#bindings.delete(handle)
      this.#consumedHandles.add(handle)
      if (consumedExternally) {
        throw secretFailure('E2E_SECRET_HANDLE_CONSUMED', '秘密已由其他消费者消费')
      }
      return plaintext!
    } catch (cause) {
      plaintext?.fill(0)
      throw cause
    }
  }

  async retireRunSecrets(capability: RuntimeSecretRetirementCapability): Promise<void> {
    this.#requireOpen()
    await this.#assertCurrentProjectIdentity()
    await consumeRuntimeSecretRetirementCapability(
      capability,
      this.#projectIdentity.digest,
      async (binding) => await this.#mutate((state) => {
        const key = secretRunKey(binding.projectIdentityDigest, binding.runId)
        const existing = state.runs[key]
        if (existing !== undefined && isRetiredSecretRun(existing)) return
        state.runs[key] = {
          projectIdentityDigest: binding.projectIdentityDigest,
          runId: binding.runId,
          status: 'retired',
          terminalAt: this.#now().toISOString(),
        }
      }),
    )
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const errors: unknown[] = []
    try { this.#store.close() } catch (error) { errors.push(error) }
    try { await this.#ownedRunStore?.close() } catch (error) { errors.push(error) }
    this.#keys.clear()
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'E2E_SECRET_CLOSE_FAILED')
  }

  async #finishReservation(
    runId: string,
    secretRef: string,
    attemptId: string,
    value: Buffer | undefined,
  ): Promise<PersistedSecretEntry> {
    await this.#assertCurrentProjectIdentity()
    return await this.#mutate((state) => {
      const run = state.runs[secretRunKey(this.#projectIdentity.digest, runId)]
      if (run !== undefined && isRetiredSecretRun(run)) throw retiredRunFailure()
      const entry = run?.entries[secretRef]
      if (entry?.status !== 'resolving' || entry.attemptId !== attemptId) {
        throw secretFailure('E2E_SECRET_PROVIDER_RESERVATION_LOST', '系统 provider reservation 已改变')
      }
      if (value === undefined) {
        const abandoned: PersistedSecretEntry = {
          ...entry,
          status: 'abandoned',
          terminalAt: this.#now().toISOString(),
        }
        run!.entries[secretRef] = abandoned
        return abandoned
      }
      const dataKey = unwrapRunDataKey(
        this.#keys.wrappingKey,
        run!.wrappedDataKey,
        this.#projectIdentity.digest,
        runId,
      )
      try {
        const available: PersistedSecretEntry = {
          version: entry.version,
          providerId: entry.providerId,
          status: 'available',
          encrypted: encryptSecret(dataKey, value, runId, secretRef, entry.providerId),
        }
        run!.entries[secretRef] = available
        return available
      } finally { dataKey.fill(0) }
    })
  }

  #getOrCreateRun(state: SecretStatePayload, runId: string): ActiveSecretRunState {
    const key = secretRunKey(this.#projectIdentity.digest, runId)
    const existing = state.runs[key]
    if (existing !== undefined && isRetiredSecretRun(existing)) throw retiredRunFailure()
    if (existing !== undefined) return existing
    const dataKey = randomBytes(32)
    try {
      const run: ActiveSecretRunState = {
        projectIdentityDigest: this.#projectIdentity.digest,
        runId,
        wrappedDataKey: wrapRunDataKey(
          this.#keys.wrappingKey, dataKey, this.#projectIdentity.digest, runId,
        ),
        entries: {},
      }
      state.runs[key] = run
      return run
    } finally { dataKey.fill(0) }
  }

  async #read<T>(project: (state: SecretStatePayload) => T): Promise<T> {
    return await this.#store.runExclusive(async () => {
      const transaction = this.#store.beginVersioned()
      try {
        const state = parseSecretState(
          transaction.snapshot,
          transaction.revision,
          this.#keys.wrappingKey,
          this.#keys.macKey,
        )
        const result = project(state)
        this.#store.rollback()
        return result === undefined ? result : structuredClone(result)
      } catch (cause) {
        this.#store.rollback()
        throw normalizeStateError(cause)
      }
    })
  }

  async #readVerifiedState(): Promise<void> {
    await this.#read(() => undefined)
  }

  async #mutate<T>(operation: (state: SecretStatePayload) => T): Promise<T> {
    return await this.#store.runExclusive(async () => {
      const transaction = this.#store.beginVersioned()
      try {
        const state = parseSecretState(
          transaction.snapshot,
          transaction.revision,
          this.#keys.wrappingKey,
          this.#keys.macKey,
        )
        const result = operation(state)
        this.#store.commit(serializeSecretState(state, transaction.revision + 1, this.#keys.macKey))
        return result
      } catch (cause) {
        this.#store.rollback()
        throw normalizeStateError(cause)
      }
    })
  }

  async #assertCurrentProjectIdentity(): Promise<void> {
    assertSameProjectIdentity(this.#projectIdentity, await resolveProjectIdentity(this.#projectRoot))
  }

  async #withActiveRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return await this.#runAccess.withActiveSecretRun(
      this.#projectIdentity.digest,
      runId,
      operation,
    )
  }

  #requireOpen(): void {
    if (this.#closed) throw secretFailure('E2E_SECRET_BROKER_CLOSED', 'Secret Broker 已关闭')
  }
}

function validateOpenOptions(options: RuntimeSecretBrokerOpenOptions): void {
  if (!options.homeDir || !options.projectRoot
    || !isAbsolute(options.homeDir) || !isAbsolute(options.projectRoot)
    || options.reservationTtlMs !== undefined
      && (!Number.isSafeInteger(options.reservationTtlMs)
        || options.reservationTtlMs < 1 || options.reservationTtlMs > 60_000)) {
    throw secretFailure('E2E_SECRET_INPUT_INVALID', 'homeDir/projectRoot 或 reservation TTL 不合法')
  }
  if ('projectIdentityDigest' in options) {
    throw secretFailure('E2E_SECRET_INPUT_INVALID', '项目身份必须由 Broker 从 projectRoot 内部解析')
  }
}

function validateProviders(providers: SecretProvider[]): ReadonlyMap<SecretProviderId, SecretProvider> {
  const result = new Map<SecretProviderId, SecretProvider>()
  for (const provider of providers) {
    if (!(SECRET_PROVIDER_IDS as readonly string[]).includes(provider.id)
      || provider.id === 'interactive' || result.has(provider.id)
      || typeof provider.resolve !== 'function') {
      throw secretFailure('E2E_SECRET_PROVIDER_CONFIG_INVALID', '系统 provider 配置重复或不合法')
    }
    result.set(provider.id, provider)
  }
  return result
}

function normalizeStateError(cause: unknown): E2EError {
  return cause instanceof E2EError
    ? cause
    : secretFailure('E2E_SECRET_STATE_INTEGRITY_FAILED', 'Secret state schema 或认证失败', cause)
}

function retiredRunFailure(): E2EError {
  return secretFailure('E2E_SECRET_RUN_RETIRED', 'Run 的 Secret 已退役，禁止重建或读取')
}

function isTerminalRunFailure(error: unknown): boolean {
  return error instanceof E2EError
    && (error.code === 'E2E_SECRET_RUN_TERMINAL' || error.code === 'E2E_SECRET_RUN_NOT_FOUND')
}

function assertOutsideProject(stateRoot: string, projectRoot: string): void {
  const state = resolve(stateRoot)
  const project = resolve(projectRoot)
  if (contains(project, state) || contains(state, project)) {
    throw secretFailure('E2E_SECRET_STATE_INSIDE_PROJECT', 'Secret state 与项目目录不得重叠')
  }
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
