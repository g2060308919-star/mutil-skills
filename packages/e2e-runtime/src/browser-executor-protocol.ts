import {
  BrowserExecutorDescriptorV1Schema,
  BrowserExecutorExecutionResultV1Schema,
  BrowserExecutorProgressV1Schema,
  canonicalizeJson,
  digestText,
  E2EError,
  type BrowserExecutorDescriptorV1,
  type BrowserExecutorExecutionResultV1,
  type BrowserExecutorProgressV1,
} from '@mutil-skills/e2e-contracts'
import {
  executeRuntimeFullPlaywright,
  executeRuntimeFullPlaywrightProjection,
  executeRuntimeInjection,
  executeRuntimeRead,
  executeRuntimeWrite,
  type RuntimeFullPlaywrightExecutorCapability,
  type RuntimeInjectionExecutorCapability,
  type RuntimeReadExecutionOutput,
  type RuntimeReadExecutorCapability,
  type RuntimeWriteExecutorCapability,
} from './trusted-action-runner.js'
import type { RuntimeInjectionExecutionOutput, RuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import { isRuntimeEvidenceUri } from './evidence-reference.js'
import { executeRuntimePreflight, type RuntimePreflightCapability } from './runtime-preflight.js'
import { runTargetProbe, type TargetProbeCapability } from './target-probe.js'

declare const browserExecutorProtocolCapabilityBrand: unique symbol
export interface BrowserExecutorProtocolCapabilityV1 {
  readonly [browserExecutorProtocolCapabilityBrand]: true
}

interface BrowserExecutorBackendV1 {
  descriptor: BrowserExecutorDescriptorV1
  execute(input: unknown): Promise<unknown>
}

const adapters = new WeakMap<object, BrowserExecutorBackendV1>()
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface BrowserExecutorInvocationV1 {
  executionId: string
  runId: string
  attemptId: string
  input: unknown
  deadlineAt?: string
  signal?: AbortSignal
  now?: () => string
  onProgress?: (event: BrowserExecutorProgressV1) => void | Promise<void>
}

export function describeBrowserExecutorV1(
  capability: BrowserExecutorProtocolCapabilityV1,
): BrowserExecutorDescriptorV1 {
  const backend = requireAdapter(capability)
  return structuredClone(backend.descriptor)
}

export async function executeBrowserExecutorV1(
  capability: BrowserExecutorProtocolCapabilityV1,
  invocation: BrowserExecutorInvocationV1,
): Promise<{ legacyOutput: unknown; result: BrowserExecutorExecutionResultV1 }> {
  const backend = requireAdapter(capability)
  assertInvocation(invocation)
  const now = invocation.now ?? (() => new Date().toISOString())
  let sequence = 0
  const progress = async (phase: BrowserExecutorProgressV1['phase']) => {
    const event = BrowserExecutorProgressV1Schema.parse({
      schemaVersion: '1.0.0', protocolVersion: '1.0.0', executionId: invocation.executionId,
      runId: invocation.runId, attemptId: invocation.attemptId, sequence: ++sequence, phase, at: now(),
    })
    await invocation.onProgress?.(event)
  }
  await progress('accepted')
  if (invocation.signal?.aborted) throw protocolError(
    'E2E_BROWSER_EXECUTOR_CANCELLED_BEFORE_DISPATCH', '浏览器执行在 dispatch 前已取消', true,
  )
  if (invocation.deadlineAt !== undefined
    && Date.parse(invocation.deadlineAt) <= Date.parse(now())) throw protocolError(
      'E2E_BROWSER_EXECUTOR_DEADLINE_EXPIRED', '浏览器执行 deadline 在 dispatch 前已过期', true,
    )
  await progress('dispatching')
  const legacyOutput = await backend.execute(invocation.input)
  await progress('executed')
  const result = projectLegacyBrowserExecutorResultV1({
    descriptor: backend.descriptor, executionId: invocation.executionId,
    runId: invocation.runId, attemptId: invocation.attemptId, output: legacyOutput,
  })
  if (result.recovery === 'reconcile') await progress('reconciling')
  await progress('completed')
  return { legacyOutput, result }
}

export function adaptTargetProbeExecutorV1(capability: TargetProbeCapability): BrowserExecutorProtocolCapabilityV1 {
  return createAdapter(descriptor('target-probe'), async (value) => {
    const input = value as Parameters<typeof runTargetProbe>[1]
    return await runTargetProbe(capability, input)
  })
}

export function adaptRuntimePreflightExecutorV1(
  capability: RuntimePreflightCapability,
): BrowserExecutorProtocolCapabilityV1 {
  return createAdapter(descriptor('preflight'), async (value) => {
    const input = value as Parameters<typeof executeRuntimePreflight>[1]
    return await executeRuntimePreflight(capability, input)
  })
}

export function adaptRuntimeReadExecutorV1(
  capability: RuntimeReadExecutorCapability,
): BrowserExecutorProtocolCapabilityV1 {
  return createAdapter(descriptor('read'), async (value) =>
    await executeRuntimeRead(capability, value as Parameters<typeof executeRuntimeRead>[1]))
}

export function adaptRuntimeWriteExecutorV1(
  capability: RuntimeWriteExecutorCapability,
): BrowserExecutorProtocolCapabilityV1 {
  return createAdapter(descriptor('reversible-write'), async (value) =>
    await executeRuntimeWrite(capability, value as Parameters<typeof executeRuntimeWrite>[1]))
}

export function adaptRuntimeInjectionExecutorV1(
  capability: RuntimeInjectionExecutorCapability,
): BrowserExecutorProtocolCapabilityV1 {
  return createAdapter(descriptor('injection'), async (value) =>
    await executeRuntimeInjection(capability, value as Parameters<typeof executeRuntimeInjection>[1]))
}

export function adaptRuntimeFullPlaywrightExecutorV1(
  capability: RuntimeFullPlaywrightExecutorCapability,
): BrowserExecutorProtocolCapabilityV1 {
  return createAdapter(descriptor('full-playwright'), async (value) =>
    await executeRuntimeFullPlaywright(capability, value as Parameters<typeof executeRuntimeFullPlaywright>[1]))
}

/** 只供仓库内覆盖证明持有的不可伪造能力；不从 package root 导出。 */
export interface B2BProofBrowserExecutorCapabilityV1 {
  readonly __brand: 'B2BProofBrowserExecutorCapabilityV1'
}

const b2bProofExecutors = new WeakMap<object, (input: unknown) => Promise<unknown>>()

export function authorizeB2BProofBrowserExecutorV1(
  execute: (input: unknown) => Promise<unknown>,
): B2BProofBrowserExecutorCapabilityV1 {
  const capability = Object.freeze({}) as B2BProofBrowserExecutorCapabilityV1
  b2bProofExecutors.set(capability, execute)
  return capability
}

/**
 * 仅供仓库内 B2B 生产能力证明使用的协议入口。它不从 package root 导出，
 * 后端仍被 WeakMap capability 封装；正式 Runtime Case 必须继续使用上述受信 adapter。
 */
export function adaptB2BProofBrowserExecutorV1(
  capability: B2BProofBrowserExecutorCapabilityV1,
): BrowserExecutorProtocolCapabilityV1 {
  const execute = b2bProofExecutors.get(capability)
  if (execute === undefined) throw protocolError(
    'E2E_BROWSER_EXECUTOR_CAPABILITY_INVALID', 'B2B proof executor capability 无效', false,
  )
  return createAdapter(descriptor('full-playwright'), execute)
}

/**
 * Phase 2 的 read 迁移入口。protocol 为默认权威路径；shadow 仍只执行一次浏览器动作，
 * 随后由旧结果和协议适配器各自投影语义并 fail-closed 比较，避免只读动作被重复执行。
 */
export async function executeRuntimeReadWithBrowserExecutorProtocolV1(
  capability: RuntimeReadExecutorCapability,
  input: Parameters<typeof executeRuntimeRead>[1] & {
    route?: 'legacy' | 'shadow' | 'protocol'
    executionId?: string
    deadlineAt?: string
    signal?: AbortSignal
    now?: () => string
    onProgress?: BrowserExecutorInvocationV1['onProgress']
  },
): Promise<RuntimeReadExecutionOutput> {
  return await executeRoutedRuntimeExecutor(
    capability, input, 'READ', executeRuntimeRead, adaptRuntimeReadExecutorV1,
  )
}

type RoutedExecutorInput = Parameters<typeof executeRuntimeRead>[1] & {
  route?: 'legacy' | 'shadow' | 'protocol'
  executionId?: string
  deadlineAt?: string
  signal?: AbortSignal
  now?: () => string
  onProgress?: BrowserExecutorInvocationV1['onProgress']
}

export async function executeRuntimeWriteWithBrowserExecutorProtocolV1(
  capability: RuntimeWriteExecutorCapability,
  input: RoutedExecutorInput,
): Promise<RuntimeWriteExecutionOutput> {
  return await executeRoutedRuntimeExecutor(
    capability, input, 'WRITE', executeRuntimeWrite, adaptRuntimeWriteExecutorV1,
  )
}

export async function executeRuntimeInjectionWithBrowserExecutorProtocolV1(
  capability: RuntimeInjectionExecutorCapability,
  input: RoutedExecutorInput,
): Promise<RuntimeInjectionExecutionOutput> {
  return await executeRoutedRuntimeExecutor(
    capability, input, 'INJECTION', executeRuntimeInjection, adaptRuntimeInjectionExecutorV1,
  )
}

export async function executeRuntimeFullPlaywrightWithBrowserExecutorProtocolV1(
  capability: RuntimeFullPlaywrightExecutorCapability,
  input: RoutedExecutorInput,
): Promise<RuntimeWriteExecutionOutput> {
  return await executeRoutedRuntimeExecutor(
    capability, input, 'FULL', executeRuntimeFullPlaywright, adaptRuntimeFullPlaywrightExecutorV1,
  )
}

export async function executeRuntimeFullPlaywrightProjectionWithBrowserExecutorProtocolV1(
  capability: RuntimeFullPlaywrightExecutorCapability,
  input: Parameters<typeof executeRuntimeFullPlaywrightProjection>[1] & Omit<RoutedExecutorInput, 'snapshot' | 'attemptId'>,
): Promise<RuntimeWriteExecutionOutput> {
  return await executeRoutedRuntimeExecutor(
    capability, input, 'FULL', executeRuntimeFullPlaywrightProjection,
    (value) => createAdapter(descriptor('full-playwright'), async (candidate) =>
      await executeRuntimeFullPlaywrightProjection(
        value,
        candidate as Parameters<typeof executeRuntimeFullPlaywrightProjection>[1],
      )),
  )
}

async function executeRoutedRuntimeExecutor<
  TCapability,
  TInput extends { snapshot: { runId: string }; attemptId: string },
  TOutput,
>(
  capability: TCapability,
  input: TInput & Omit<RoutedExecutorInput, 'snapshot' | 'attemptId'>,
  executionPrefix: string,
  legacy: (capability: TCapability, input: TInput) => Promise<TOutput>,
  adapt: (capability: TCapability) => BrowserExecutorProtocolCapabilityV1,
): Promise<TOutput> {
  const { route: _route, executionId: _executionId, deadlineAt: _deadlineAt,
    signal: _signal, now: _now, onProgress: _onProgress, ...legacyInput } = input
  const executableInput = legacyInput as unknown as TInput
  const route = input.route ?? 'protocol'
  if (route === 'legacy') return await legacy(capability, executableInput)
  const protocol = adapt(capability)
  const executed = await executeBrowserExecutorV1(protocol, {
    executionId: input.executionId ?? `${executionPrefix}-${input.attemptId}`,
    runId: input.snapshot.runId,
    attemptId: input.attemptId,
    input: executableInput,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  })
  if (route === 'shadow') assertLegacyBrowserExecutorSemanticEquivalentV1({
    descriptor: describeBrowserExecutorV1(protocol), legacyOutput: executed.legacyOutput,
    protocolResult: executed.result,
  })
  return executed.legacyOutput as TOutput
}

/** 独立读取旧输出字段，不调用协议结果 projector，用于 shadow fail-closed 对比。 */
export function assertLegacyBrowserExecutorSemanticEquivalentV1(input: {
  descriptor: BrowserExecutorDescriptorV1
  legacyOutput: unknown
  protocolResult: BrowserExecutorExecutionResultV1
}): void {
  const descriptorValue = BrowserExecutorDescriptorV1Schema.parse(input.descriptor)
  const result = BrowserExecutorExecutionResultV1Schema.parse(input.protocolResult)
  const source = unwrapOutput(input.legacyOutput)
  const expectedStatus = source.status === 'ready' ? 'passed'
    : source.status === 'page-identity-mismatch' ? 'failed' : source.status
  const expectedEffect = descriptorValue.effect === 'write' ? source.effectObservation : 'not-applicable'
  const expectedCleanup = descriptorValue.effect === 'write' && isRecord(source.cleanup)
    ? source.cleanup.status : 'not-applicable'
  const expectedRecovery = expectedEffect === 'unknown' ? 'reconcile'
    : expectedStatus === 'input-blocked' || expectedStatus === 'environment-blocked' ? 'retry' : 'none'
  const expectedEvidence = projectEvidence(source)
  const existingDigest = [source.resultDigest, source.gatewayAuditDigest, source.diagnosticDigest,
    source.outcomeDigest, source.preflightDigest].find((value) => typeof value === 'string' && DIGEST.test(value))
  const equivalent = result.executorId === descriptorValue.executorId
    && result.kind === descriptorValue.kind
    && result.status === expectedStatus
    && result.effectObservation === expectedEffect
    && result.cleanupStatus === expectedCleanup
    && result.recovery === expectedRecovery
    && (existingDigest === undefined || result.outcomeDigest === existingDigest)
    && canonicalizeJson(result.evidence) === canonicalizeJson(expectedEvidence)
  if (!equivalent) throw protocolError(
    'E2E_BROWSER_EXECUTOR_SHADOW_SEMANTIC_MISMATCH', 'legacy 与 BrowserExecutorProtocolV1 语义不一致', false,
  )
}

export function projectLegacyBrowserExecutorResultV1(input: {
  descriptor: BrowserExecutorDescriptorV1
  executionId: string
  runId: string
  attemptId: string
  output: unknown
}): BrowserExecutorExecutionResultV1 {
  const descriptorValue = BrowserExecutorDescriptorV1Schema.parse(input.descriptor)
  const source = unwrapOutput(input.output)
  const status = projectStatus(source.status)
  const effectObservation = descriptorValue.effect === 'write'
    ? projectEffect(source.effectObservation) : 'not-applicable'
  const cleanupStatus = descriptorValue.effect === 'write'
    ? projectCleanup(source.cleanup) : 'not-applicable'
  const recovery = effectObservation === 'unknown' ? 'reconcile'
    : status === 'input-blocked' || status === 'environment-blocked' ? 'retry' : 'none'
  const evidence = projectEvidence(source)
  const existingDigest = [source.resultDigest, source.gatewayAuditDigest, source.diagnosticDigest,
    source.outcomeDigest, source.preflightDigest].find((value) => typeof value === 'string' && DIGEST.test(value))
  const outcomeDigest = existingDigest as string | undefined ?? digestText(
    'browser-executor-protocol-outcome/v1', canonicalizeJson({
      kind: descriptorValue.kind, status, effectObservation, cleanupStatus, recovery,
    }),
  )
  return BrowserExecutorExecutionResultV1Schema.parse({
    schemaVersion: '1.0.0', protocolVersion: '1.0.0', executionId: input.executionId,
    executorId: descriptorValue.executorId, kind: descriptorValue.kind,
    runId: input.runId, attemptId: input.attemptId, status, outcomeDigest,
    effectObservation, cleanupStatus, recovery,
    evidence,
  })
}

function projectEvidence(source: Record<string, unknown>): BrowserExecutorExecutionResultV1['evidence'] {
  type Evidence = BrowserExecutorExecutionResultV1['evidence']
  type EvidenceKind = Evidence['materialKinds'][number]
  const supportedKinds: EvidenceKind[] = ['diagnostics', 'screenshot', 'dom', 'trace', 'gateway-audit']
  const materialKinds: EvidenceKind[] = []
  if (source.diagnostics !== undefined) materialKinds.push('diagnostics')
  if (isRecord(source.evidence)) {
    if (source.evidence.screenshot instanceof Uint8Array) materialKinds.push('screenshot')
    if (source.evidence.dom instanceof Uint8Array) materialKinds.push('dom')
  }
  if (source.gatewayAudit !== undefined) materialKinds.push('gateway-audit')
  const references: Evidence['references'] = []
  if (Array.isArray(source.evidenceReferences)) for (const reference of source.evidenceReferences) {
    if (!isRecord(reference) || typeof reference.kind !== 'string'
      || !supportedKinds.includes(reference.kind as EvidenceKind)
      || !isRuntimeEvidenceUri(reference.uri)
      || typeof reference.digest !== 'string' || !DIGEST.test(reference.digest)) throw protocolError(
      'E2E_BROWSER_EXECUTOR_OUTPUT_INVALID', '旧执行器 evidence reference 无法映射', false,
    )
    references.push({ kind: reference.kind as EvidenceKind, uri: reference.uri, digest: reference.digest })
  }
  for (const reference of references) {
    if (!materialKinds.includes(reference.kind)) materialKinds.push(reference.kind)
  }
  return { materialKinds, references }
}

function createAdapter(
  descriptorValue: BrowserExecutorDescriptorV1,
  execute: BrowserExecutorBackendV1['execute'],
): BrowserExecutorProtocolCapabilityV1 {
  const capability = Object.freeze({}) as BrowserExecutorProtocolCapabilityV1
  adapters.set(capability, { descriptor: BrowserExecutorDescriptorV1Schema.parse(descriptorValue), execute })
  return capability
}

function requireAdapter(capability: BrowserExecutorProtocolCapabilityV1): BrowserExecutorBackendV1 {
  const backend = adapters.get(capability)
  if (backend === undefined) throw protocolError(
    'E2E_BROWSER_EXECUTOR_PROTOCOL_CAPABILITY_INVALID', '协议 capability 未由 Runtime 适配层签发', false,
  )
  return backend
}

function descriptor(kind: BrowserExecutorDescriptorV1['kind']): BrowserExecutorDescriptorV1 {
  const write = kind === 'reversible-write' || kind === 'full-playwright'
  const effect = write ? 'write' : kind === 'read' ? 'read' : kind === 'injection' ? 'injection' : 'diagnostic'
  return BrowserExecutorDescriptorV1Schema.parse({
    schemaVersion: '1.0.0', protocolVersion: '1.0.0', executorId: `${kind}/v1`, kind, effect,
    inputSchemaVersion: `runtime-${kind}/v1`, outputSchemaVersion: `runtime-${kind}/v1`,
    control: { progress: true, timeout: 'deadline-before-dispatch', cancellation: 'pre-dispatch' },
    evidenceKinds: kind === 'target-probe' ? ['diagnostics']
      : kind === 'preflight' ? ['diagnostics', 'gateway-audit']
        : kind === 'full-playwright' ? ['screenshot', 'dom', 'trace', 'gateway-audit']
        : ['screenshot', 'dom', 'gateway-audit'],
    retrySafety: { beforeDispatch: 'safe', afterDispatch: write ? 'reconcile-required' : 'safe' },
    lifecycle: {
      cleanup: write ? 'required' : 'not-applicable',
      reconcile: write ? 'required-on-unknown' : 'not-applicable',
    },
  })
}

function assertInvocation(input: BrowserExecutorInvocationV1): void {
  if (![input.executionId, input.runId, input.attemptId].every((value) => SAFE_ID.test(value))) {
    throw protocolError('E2E_BROWSER_EXECUTOR_INVOCATION_INVALID', '执行身份非法', false)
  }
  if (input.deadlineAt !== undefined && !Number.isFinite(Date.parse(input.deadlineAt))) {
    throw protocolError('E2E_BROWSER_EXECUTOR_INVOCATION_INVALID', 'deadlineAt 非法', false)
  }
}

function unwrapOutput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError('E2E_BROWSER_EXECUTOR_OUTPUT_INVALID', '旧执行器输出不是对象', false)
  return isRecord(value.output) ? value.output : value
}

function projectStatus(value: unknown): BrowserExecutorExecutionResultV1['status'] {
  if (value === 'ready' || value === 'passed') return 'passed'
  if (value === 'failed' || value === 'page-identity-mismatch') return 'failed'
  if (value === 'input-blocked' || value === 'environment-blocked' || value === 'safety-blocked') return value
  throw protocolError('E2E_BROWSER_EXECUTOR_OUTPUT_INVALID', '旧执行器 status 无法映射', false)
}

function projectEffect(value: unknown): BrowserExecutorExecutionResultV1['effectObservation'] {
  if (value === 'proven-not-applied' || value === 'applied' || value === 'unknown') return value
  throw protocolError('E2E_BROWSER_EXECUTOR_OUTPUT_INVALID', '写执行器 effectObservation 无法映射', false)
}

function projectCleanup(value: unknown): BrowserExecutorExecutionResultV1['cleanupStatus'] {
  if (isRecord(value) && ['verified-clean', 'failed', 'unknown'].includes(String(value.status))) {
    return value.status as BrowserExecutorExecutionResultV1['cleanupStatus']
  }
  throw protocolError('E2E_BROWSER_EXECUTOR_OUTPUT_INVALID', '写执行器 cleanup 无法映射', false)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolError(code: string, message: string, retryable: boolean): E2EError {
  return new E2EError({ code, category: 'safety', message, retryable })
}
