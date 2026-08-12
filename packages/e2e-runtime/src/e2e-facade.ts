import {
  RuntimeAcceptanceReviewResultSchema,
  RuntimeCompileExecutableRunResultSchema,
  RunCancellationResultV1Schema,
  RunHealthSnapshotV1Schema,
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  RuntimeStatusResultSchema,
  TaskStateViewV1Schema,
  canonicalizeJson,
  type RunHandle,
  type ApprovalGrantSubject,
  type RuntimeAcceptanceReviewResult,
  type RuntimeCompileExecutableRunResult,
  type RunCancellationResultV1,
  type RunHealthSnapshotV1,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RuntimeStatusResult,
  type TaskStateViewV1,
  type TargetContract,
  type DeclarativeExecutionBindingV1,
} from '@mutil-skills/e2e-contracts'
import { randomUUID } from 'node:crypto'
import { RUNTIME_PACKAGE_VERSION } from './protocol.js'
import {
  E2EInputPreparer,
  type E2EInputDraft,
  type PreparedE2EInput,
} from './e2e-input-preparer.js'

type CreateRunRequest = Extract<RuntimeRequestEnvelope, { command: 'create-run' }>

export interface E2EFacadeHost {
  handle(request: RuntimeRequestEnvelope, requestBytes: Uint8Array): Promise<RuntimeResponseEnvelope>
}

export interface E2EFacadeOptions {
  projectRoot: string
  host: E2EFacadeHost
  requestId?: () => string
  clientVersion?: string
  inputPreparer?: Pick<E2EInputPreparer, 'prepare'>
}

export interface E2EJourneyResult {
  schemaVersion: 'e2e-journey-result/v1'
  status: 'pending-decision' | 'completed'
  handle: RunHandle
  runtimeState: RuntimeStatusResult['state']
  pending?: {
    kind: 'acceptance-review' | 'semantic-generation' | 'execution-binding' | 'scope-approval'
      | 'lineage-approval' | 'execution-approval' | 'target-probe' | 'manual-input'
    command: RuntimeStatusResult['nextEdge'] extends infer _ ? string : never
    missingInput: string[]
  }
  metrics: { generatorCalls: number; humanInteractions: number }
}

export class E2EFacadeError extends Error {
  readonly code: string
  readonly category: string
  readonly retryable: boolean
  readonly requestId: string
  readonly runId?: string
  readonly remediation?: string
  readonly details?: unknown

  constructor(input: {
    code: string
    category: string
    message: string
    retryable: boolean
    requestId: string
    runId?: string
    remediation?: string
    details?: unknown
  }) {
    super(input.message)
    this.name = 'E2EFacadeError'
    this.code = input.code
    this.category = input.category
    this.retryable = input.retryable
    this.requestId = input.requestId
    if (input.runId !== undefined) this.runId = input.runId
    if (input.remediation !== undefined) this.remediation = input.remediation
    if (input.details !== undefined) this.details = input.details
  }
}

/** Skill 使用的高层门面：生成 envelope/requestId，跟随 Runtime 状态，不自己实现状态机。 */
export class E2EFacade {
  #projectRoot: string
  readonly #host: E2EFacadeHost
  readonly #requestId: () => string
  readonly #clientVersion: string
  readonly #inputPreparer: Pick<E2EInputPreparer, 'prepare'>

  constructor(options: E2EFacadeOptions) {
    this.#projectRoot = options.projectRoot
    this.#host = options.host
    this.#requestId = options.requestId ?? (() => `FACADE-${randomUUID()}`)
    this.#clientVersion = options.clientVersion ?? RUNTIME_PACKAGE_VERSION
    this.#inputPreparer = options.inputPreparer ?? new E2EInputPreparer(options.projectRoot)
  }

  async prepareInput(input: E2EInputDraft): Promise<PreparedE2EInput> {
    return await this.#inputPreparer.prepare(input)
  }

  async startFromInput(input: {
    intake: E2EInputDraft
    targetContract?: TargetContract
  }): Promise<RuntimeStatusResult> {
    const prepared = await this.prepareInput(input.intake)
    this.#projectRoot = prepared.projectRoot
    return await this.start({
      create: prepared.create,
      ...(input.targetContract === undefined ? {} : { targetContract: input.targetContract }),
    })
  }

  async start(input: {
    create: CreateRunRequest['payload']
    targetContract?: TargetContract
  }): Promise<RuntimeStatusResult> {
    const created = await this.#invoke('create-run', input.create)
    const runId = requireString(created, 'runId')
    if (input.targetContract !== undefined) {
      await this.#invoke('configure-target', { runId, targetContract: input.targetContract }, runId)
    }
    return await this.#statusByRunId(runId)
  }

  async status(handle: RunHandle): Promise<RuntimeStatusResult> {
    return await this.#statusByRunId(handle.runId, handle)
  }

  async taskState(handle: RunHandle): Promise<TaskStateViewV1> {
    const status = await this.#statusByRunId(handle.runId, handle, true)
    if (status.taskState === undefined) throw new E2EFacadeError({
      code: 'E2E_FACADE_TASK_STATE_UNAVAILABLE', category: 'migration',
      message: '当前 Runtime 未返回 TaskStateViewV1，请升级 Runtime', retryable: false,
      requestId: 'FACADE-LOCAL', runId: handle.runId,
    })
    return TaskStateViewV1Schema.parse(status.taskState)
  }

  async review(handle: RunHandle): Promise<RuntimeAcceptanceReviewResult> {
    await this.status(handle)
    return RuntimeAcceptanceReviewResultSchema.parse(
      await this.#invoke('get-acceptance-review', { runId: handle.runId }, handle.runId),
    )
  }

  async confirmReview(handle: RunHandle, reviewDigest: string): Promise<RuntimeStatusResult> {
    await this.status(handle)
    await this.#invoke('confirm-acceptance-review', {
      runId: handle.runId, reviewDigest,
    }, handle.runId)
    return await this.#statusByRunId(handle.runId)
  }

  async compileExecutable(
    handle: RunHandle,
    binding: DeclarativeExecutionBindingV1,
  ): Promise<RuntimeCompileExecutableRunResult> {
    const status = await this.status(handle)
    if (status.nextEdge?.command !== 'compile-executable-run') throw new E2EFacadeError({
      code: 'E2E_FACADE_EXECUTABLE_COMPILE_EDGE_UNAVAILABLE', category: 'input',
      message: 'Runtime 当前状态不允许编译声明式执行绑定', retryable: false,
      requestId: 'FACADE-LOCAL', runId: handle.runId,
      details: { nextEdge: status.nextEdge, minimumMissingInput: status.minimumMissingInput },
    })
    return RuntimeCompileExecutableRunResultSchema.parse(
      await this.#invoke('compile-executable-run', { runId: handle.runId, binding }, handle.runId),
    )
  }

  async approveExecution(
    handle: RunHandle,
    grantSubject: ApprovalGrantSubject,
  ): Promise<Record<string, unknown>> {
    await this.status(handle)
    return asRecord(await this.#invoke('open-approval', {
      runId: handle.runId, approvalType: 'execution', grantSubject,
    }, handle.runId))
  }

  async confirmApproval(
    handle: RunHandle,
    confirmationId: string,
    subjectDigest: string,
  ): Promise<RuntimeStatusResult> {
    await this.status(handle)
    await this.#invoke('confirm-approval', {
      runId: handle.runId, confirmationId, subjectDigest,
    }, handle.runId)
    return await this.#statusByRunId(handle.runId)
  }

  async configureTarget(handle: RunHandle, targetContract: TargetContract): Promise<RuntimeStatusResult> {
    await this.status(handle)
    await this.#invoke('configure-target', { runId: handle.runId, targetContract }, handle.runId)
    return await this.#statusByRunId(handle.runId)
  }

  async probeTarget(handle: RunHandle): Promise<RuntimeStatusResult> {
    await this.status(handle)
    await this.#invoke('probe-target', { runId: handle.runId }, handle.runId)
    return await this.#statusByRunId(handle.runId)
  }

  async execute(handle: RunHandle): Promise<RuntimeStatusResult> {
    await this.status(handle)
    await this.#invoke('execute-run', { runId: handle.runId }, handle.runId)
    return await this.#statusByRunId(handle.runId)
  }

  async retry(handle: RunHandle): Promise<RuntimeStatusResult> {
    const status = await this.status(handle)
    if (status.condition?.kind !== 'blocked-retryable') {
      throw new E2EFacadeError({
        code: 'E2E_FACADE_RETRY_NOT_ALLOWED', category: 'input',
        message: '当前 Run 没有可安全重试的 blocker', retryable: false,
        requestId: 'FACADE-LOCAL', runId: handle.runId,
      })
    }
    const command = status.nextEdge?.command
    if (command !== 'run-preflight' && command !== 'probe-target') {
      throw new E2EFacadeError({
        code: 'E2E_FACADE_RETRY_EDGE_UNSUPPORTED', category: 'safety',
        message: '当前 blocker 不能通过通用 retry 重放', retryable: false,
        requestId: 'FACADE-LOCAL', runId: handle.runId,
      })
    }
    await this.#invoke(command, { runId: handle.runId }, handle.runId)
    return await this.#statusByRunId(handle.runId)
  }

  async report(handle: RunHandle, outputRoot?: string): Promise<Record<string, unknown>> {
    await this.status(handle)
    return asRecord(await this.#invoke('render-report', {
      runId: handle.runId, ...(outputRoot === undefined ? {} : { outputRoot }),
    }, handle.runId))
  }

  async cancel(handle: RunHandle): Promise<RunCancellationResultV1> {
    await this.status(handle)
    return RunCancellationResultV1Schema.parse(
      await this.#invoke('cancel-run', { runId: handle.runId }, handle.runId),
    )
  }

  async health(handle: RunHandle): Promise<RunHealthSnapshotV1> {
    await this.status(handle)
    return RunHealthSnapshotV1Schema.parse(
      await this.#invoke('get-health', { runId: handle.runId }, handle.runId),
    )
  }

  /**
   * 只解释 Runtime 的当前投影，不在 Facade 复制 workflow 或自动批准高风险边。
   * 具体输入准备仍通过已有窄方法提交；恢复时始终重新读取 Runtime nextEdge。
   */
  async continueJourney(handle: RunHandle): Promise<E2EJourneyResult> {
    const status = await this.status(handle)
    const currentHandle = status.handle!
    if (['accepted', 'rejected', 'incomplete'].includes(status.state)) return {
      schemaVersion: 'e2e-journey-result/v1', status: 'completed', handle: currentHandle,
      runtimeState: status.state, metrics: { generatorCalls: 0, humanInteractions: 0 },
    }
    const command = status.nextEdge?.command
    return {
      schemaVersion: 'e2e-journey-result/v1', status: 'pending-decision', handle: currentHandle,
      runtimeState: status.state,
      pending: { kind: pendingKind(command), command: command ?? 'get-status',
        missingInput: status.minimumMissingInput },
      metrics: { generatorCalls: 0, humanInteractions: humanEdge(command) ? 1 : 0 },
    }
  }

  /** Frozen replay 只复用已冻结语义；不接触 generator，当次 Target/Approval/Lease 仍由 Runtime 要求。 */
  async replayRegression(input: { handle: RunHandle; generator?: () => unknown }): Promise<E2EJourneyResult> {
    return await this.continueJourney(input.handle)
  }

  async #statusByRunId(
    runId: string,
    expected?: RunHandle,
    includeTaskState = false,
  ): Promise<RuntimeStatusResult> {
    const result = RuntimeStatusResultSchema.parse(
      await this.#invoke('get-status', {
        runId, ...(includeTaskState ? { includeTaskState: true } : {}),
      }, runId),
    )
    if (result.handle === undefined) throw new E2EFacadeError({
      code: 'E2E_FACADE_RUN_HANDLE_REQUIRED', category: 'migration',
      message: '当前 Runtime 未返回 RunHandle，请升级 Runtime', retryable: false,
      requestId: 'FACADE-LOCAL', runId,
    })
    if (expected !== undefined && canonicalizeJson(result.handle) !== canonicalizeJson(expected)) {
      throw new E2EFacadeError({
        code: result.handle.revision !== expected.revision
          ? 'E2E_RUN_HANDLE_REVISION_STALE' : 'E2E_RUN_HANDLE_BINDING_MISMATCH',
        category: 'safety', message: '调用者 RunHandle 与 Runtime 当前快照不一致', retryable: false,
        requestId: 'FACADE-LOCAL', runId,
      })
    }
    return result
  }

  async #invoke(
    command: RuntimeRequestEnvelope['command'],
    payload: Record<string, unknown>,
    runId?: string,
  ): Promise<unknown> {
    const requestId = this.#requestId()
    const request = RuntimeRequestEnvelopeSchema.parse({
      schemaVersion: '1.0.0', requestId,
      client: { name: 'e2e-facade', version: this.#clientVersion },
      command, projectRoot: this.#projectRoot, payload,
    })
    const bytes = Buffer.from(canonicalizeJson(request), 'utf8')
    const response = RuntimeResponseEnvelopeSchema.parse(await this.#host.handle(request, bytes))
    if (!response.ok) {
      const error = response.error!
      const details = asOptionalRecord(error.details)
      throw new E2EFacadeError({
        code: error.code, category: error.category, message: error.message,
        retryable: error.retryable, requestId: response.requestId,
        ...(runId === undefined ? {} : { runId }),
        ...(typeof details?.remediation === 'string'
          ? { remediation: details.remediation } : {}),
        ...(error.details === undefined ? {} : { details: error.details }),
      })
    }
    return response.result
  }
}

type JourneyCommand = NonNullable<RuntimeStatusResult['nextEdge']>['command'] | undefined

function pendingKind(command: JourneyCommand): NonNullable<E2EJourneyResult['pending']>['kind'] {
  if (command === 'get-acceptance-review' || command === 'confirm-acceptance-review') return 'acceptance-review'
  if (command === 'compile-prd-run' || command === 'prepare-prd-understanding'
    || command === 'submit-candidate') return 'semantic-generation'
  if (command === 'compile-executable-run') return 'execution-binding'
  if (command === 'probe-target' || command === 'configure-target' || command === 'run-preflight') return 'target-probe'
  if (command === 'open-approval' || command === 'confirm-approval') return 'execution-approval'
  return 'manual-input'
}

function humanEdge(command: JourneyCommand): boolean {
  return command === 'get-acceptance-review' || command === 'confirm-acceptance-review'
    || command === 'open-approval' || command === 'confirm-approval'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Runtime result 必须是对象')
  }
  return value as Record<string, unknown>
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function requireString(value: unknown, key: string): string {
  const result = asRecord(value)[key]
  if (typeof result !== 'string') throw new Error(`Runtime result 缺少 ${key}`)
  return result
}
