import {
  ArtifactSchemaRegistry,
  ReadApprovalSubjectSchema,
  SignedGrantSchema,
  canonicalizeJson,
  digestBytes,
  digestText,
  E2EError,
  type ArtifactDocument,
  type ReadApprovalSubject,
  type SignedReadGrant,
  type SignedDiscoveryGrant,
} from '@mutil-skills/e2e-contracts'
import {
  PlaywrightPageAdapter,
  runReadOnlyCase,
  type BrowserPageAdapter,
  type ReadAuthorityClient,
  type ReadOnlyCaseResult,
} from '@mutil-skills/e2e-playwright-runtime'
import { z } from 'zod'
import { projectGatewayRules } from './gateway-rule-projector.js'
import {
  getControlledBrowserSessionBinding,
  type ControlledBrowserSession,
} from './browser-host.js'
import type { GatewayProxyProcessHandle } from './gateway-proxy-host.js'
import type { RuntimeRunSnapshot } from './run-store.js'
import { BrowserPreflightFactSchema } from './runtime-preflight.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
export interface TrustedReadAction {
  readonly caseId: string
  readonly stepId: string
  readonly actionId: string
  readonly url: string
  readonly expectedIdentity: { url: string; title: string; heading: string; role: string }
  readonly expectedText: string
  readonly correlation: {
    ruleId: string
    stepOrdinal: number
    method: string
    url: string
    channel: 'http'
    bodyDigest: string
    actionId: string
    capabilityId: string
    headers: Record<string, string>
  }
}

const trustedActions = new WeakMap<object, string>()

declare const runtimeReadExecutorCapabilityBrand: unique symbol
export interface RuntimeReadExecutorCapability {
  readonly [runtimeReadExecutorCapabilityBrand]: true
}

export interface RuntimeReadExecutionOutput {
  status: 'passed' | 'failed' | 'input-blocked' | 'environment-blocked' | 'safety-blocked'
  result: ReadOnlyCaseResult
  gatewayAudit: { received: number; forwarded: number; blocked: number; byIntent: Record<string, number> }
  gatewayAuditDigest: string
  evidence?: { screenshot: Uint8Array; dom: Uint8Array }
}

type RuntimeReadExecutorBackend = (input: {
  snapshot: RuntimeRunSnapshot
  action: TrustedReadAction
  grant: SignedReadGrant
  currentSubject: ReadApprovalSubject
  attemptId: string
}) => Promise<RuntimeReadExecutionOutput>

const runtimeReadExecutors = new WeakMap<object, RuntimeReadExecutorBackend>()

/** 仅供 Runtime 内部装配层签发；Host 依赖只持有不可伪造的 WeakMap capability。 */
export function authorizeRuntimeReadExecutor(
  backend: RuntimeReadExecutorBackend,
): RuntimeReadExecutorCapability {
  const capability = Object.freeze({}) as RuntimeReadExecutorCapability
  runtimeReadExecutors.set(capability, backend)
  return capability
}

export async function executeRuntimeRead(
  capability: RuntimeReadExecutorCapability,
  input: { snapshot: RuntimeRunSnapshot; attemptId: string },
): Promise<RuntimeReadExecutionOutput> {
  const backend = runtimeReadExecutors.get(capability)
  if (!backend) throw trustedActionError(
    'E2E_RUNTIME_READ_EXECUTOR_CAPABILITY_INVALID', 'Read executor capability 伪造或来自其他进程',
  )
  const projected = projectRuntimeReadSnapshot(input.snapshot)
  const output = await backend({
    snapshot: structuredClone(input.snapshot), action: projected.action, grant: projected.grant,
    currentSubject: projected.grant.subject, attemptId: input.attemptId,
  })
  return parseRuntimeReadExecutionOutput(output, projected.action)
}

export function assertRuntimeReadSnapshotReady(snapshot: RuntimeRunSnapshot): void {
  projectRuntimeReadSnapshot(snapshot)
}

function projectRuntimeReadSnapshot(snapshot: RuntimeRunSnapshot): {
  action: TrustedReadAction
  grant: SignedReadGrant
} {
  const actionMap = parseFrozen(snapshot.frozenArtifacts, 'browser-action-map')
  const actions = (actionMap.content as Record<string, unknown>).actions
  if (!Array.isArray(actions) || actions.length !== 1
    || typeof (actions[0] as Record<string, unknown>).actionId !== 'string') throw trustedActionError(
    'E2E_RUNTIME_READ_ACTION_SET_UNSUPPORTED', 'Task 8 只允许冻结且唯一的 read action',
  )
  const grant = parseReadGrant(snapshot.trustedExecutionFacts['signed-execution-grant'])
  const action = new TrustedReadActionProjector().project({
    runId: snapshot.runId,
    actionId: (actions[0] as Record<string, unknown>).actionId as string,
    frozenArtifacts: snapshot.frozenArtifacts,
    trustedExecutionFacts: snapshot.trustedExecutionFacts,
    grant,
    currentSubject: grant.subject,
    runtimeInstallationDigest: snapshot.runtimeInstallationDigest,
  })
  return { action, grant }
}

export class TrustedReadActionProjector {
  project(input: {
    runId: string
    actionId: string
    frozenArtifacts: Readonly<Record<string, ArtifactDocument>>
    trustedExecutionFacts: Readonly<Record<string, unknown>>
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    runtimeInstallationDigest: string
  }): TrustedReadAction {
    SignedGrantSchema.parse(input.grant)
    const grant = input.grant
    const subject = ReadApprovalSubjectSchema.parse(input.currentSubject)
    const discovery = parseDiscoveryGrant(input.trustedExecutionFacts['signed-discovery-grant'])
    const preflight = BrowserPreflightFactSchema.safeParse(
      input.trustedExecutionFacts['browser-preflight'],
    )
    const discoveryIdentityDigest = digestText(
      'expected-page-identity/v1', canonicalizeJson(discovery.subject.expectedPageIdentity),
    )
    const discoveryNavigation = discovery.capabilities.filter((capability) =>
      capability.operation === 'local-navigation'
      && capability.targetUrl === discovery.subject.expectedPageIdentity.url
      && capability.actor === discovery.subject.actor
      && capability.expectedPageIdentityDigest === discoveryIdentityDigest
      && capability.bootstrapIntentsDigest === discovery.subject.bootstrapIntentsDigest)
    if (canonicalizeJson(grant.subject) !== canonicalizeJson(subject)
      || grant.approvalContext.runId !== input.runId
      || grant.approvalContext.installationDigest !== input.runtimeInstallationDigest
      || discovery.approvalContext.runId !== input.runId
      || discovery.approvalContext.installationDigest !== input.runtimeInstallationDigest
      || discovery.grantId !== subject.discoveryGrantId
      || !preflight.success
      || preflight.data.runId !== input.runId
      || preflight.data.discoveryGrantId !== subject.discoveryGrantId
      || preflight.data.preflightDigest !== subject.preflightDigest
      || discovery.subject.assetId !== subject.assetId
      || discovery.subject.prdRevision !== subject.prdRevision
      || discovery.subject.scopeDigest !== subject.scopeDigest
      || discovery.subject.environment !== subject.environment
      || discovery.subject.baseOrigin !== subject.baseOrigin
      || discovery.subject.actor !== subject.actor) {
      throw trustedActionError('E2E_RUNTIME_READ_GRANT_BINDING_MISMATCH', 'Grant/current subject/run 不一致')
    }
    if (discoveryNavigation.length !== 1) throw trustedActionError(
      'E2E_RUNTIME_DISCOVERY_CAPABILITY_BINDING_MISMATCH', 'Discovery grant capability 未闭合绑定 subject',
    )
    const testCases = parseFrozen(input.frozenArtifacts, 'test-cases')
    const executionContract = parseFrozen(input.frozenArtifacts, 'execution-contract')
    const actionMap = parseFrozen(input.frozenArtifacts, 'browser-action-map')
    if (subject.caseDigest !== testCases.contentDigest
      || subject.executionContractDigest !== executionContract.contentDigest
      || subject.actionMapDigest !== actionMap.contentDigest) {
      throw trustedActionError('E2E_RUNTIME_READ_ARTIFACT_BINDING_MISMATCH', 'Grant 未绑定冻结执行资产')
    }
    const mapContent = actionMap.content as Record<string, unknown>
    const mapActions = mapContent.actions as Array<Record<string, unknown>>
    const selected = mapActions.filter((action) => action.actionId === input.actionId)
    if (selected.length !== 1) throw trustedActionError('E2E_RUNTIME_READ_ACTION_AMBIGUOUS', 'Action Map 必须唯一命中 actionId')
    const action = selected[0]!
    if (action.effect !== 'read') throw trustedActionError('E2E_RUNTIME_READ_EFFECT_REQUIRED', '只读 Runner 拒绝非 read Action')
    if (action.playwrightAction !== 'read-page/v1') throw trustedActionError(
      'E2E_RUNTIME_READ_ACTION_DSL_INVALID', 'playwrightAction 必须是固定 read-page/v1 声明',
    )
    const expectedPage = discovery.subject.expectedPageIdentity
    const url = new URL(expectedPage.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || url.origin !== subject.baseOrigin) {
      throw trustedActionError('E2E_RUNTIME_READ_TARGET_BINDING_MISMATCH', 'Action URL/origin/actor 未绑定审批 subject')
    }
    const cases = (testCases.content as Record<string, unknown>).cases as Array<Record<string, unknown>>
    const matchingCase = cases.find((candidate) => candidate.caseId === action.caseId)
    const matchingStep = (matchingCase?.steps as Array<Record<string, unknown>> | undefined)
      ?.find((step) => step.stepId === action.stepId)
    const oracles = matchingStep?.oracles as Array<Record<string, unknown>> | undefined
    if (matchingCase?.effect !== 'read' || matchingStep === undefined
      || oracles?.length !== 1 || typeof oracles[0]!.statement !== 'string') {
      throw trustedActionError('E2E_RUNTIME_READ_CASE_BINDING_MISMATCH', 'Action 未绑定冻结只读 Case/Step/semantic target')
    }
    const contract = executionContract.content as Record<string, unknown>
    const intent = (contract.actionIntents as Array<Record<string, unknown>>)
      .filter((candidate) => candidate.actionId === input.actionId)
    const queued = (contract.caseQueue as Array<Record<string, unknown>>)
      .some((candidate) => candidate.caseId === action.caseId)
    if (intent.length !== 1 || intent[0]!.effect !== 'read' || !queued
      || contract.baseOrigin !== subject.baseOrigin || contract.environment !== subject.environment) {
      throw trustedActionError('E2E_RUNTIME_READ_CONTRACT_BINDING_MISMATCH', 'Action 未绑定 Execution Contract')
    }
    const pageIdentity = (mapContent.pageIdentities as Array<Record<string, unknown>>)
      .filter((candidate) => candidate.pageId === action.pageIdentityId)
    if (pageIdentity.length !== 1 || new URL(String(pageIdentity[0]!.origin)).origin !== url.origin) {
      throw trustedActionError('E2E_RUNTIME_READ_PAGE_IDENTITY_MISMATCH', 'Action 页面身份未绑定目标 origin')
    }
    const requiredOperations = ['local-navigation', 'dom-read', 'screenshot'] as const
    const actionCapabilities = action.capabilities as Array<{ operation: string; capabilityId: string }>
    const subjectActions = subject.actions.filter((candidate) => candidate.actionId === input.actionId)
    const grantCapabilities = grant.capabilities.filter((candidate) => candidate.actionId === input.actionId)
    if (requiredOperations.some((operation) =>
      actionCapabilities.filter((candidate) => candidate.operation === operation).length !== 1
      || subjectActions.filter((candidate) => candidate.operation === operation).length !== 1
      || grantCapabilities.filter((candidate) => candidate.operation === operation).length !== 1)) {
      throw trustedActionError('E2E_RUNTIME_READ_CAPABILITY_BINDING_MISMATCH', 'Action/subject/grant capability 不闭合')
    }
    const navigation = grantCapabilities.find((capability) => capability.operation === 'local-navigation')!
    const approved = subjectActions.find((subjectAction) => subjectAction.operation === 'local-navigation')!
    const approvedRequests = [{
      actionId: input.actionId, capabilityId: navigation.capabilityId,
      method: 'GET', url: expectedPage.url, maxUses: approved.maxUses,
      channel: 'http' as const, behavior: { kind: 'pass-through' as const },
    }]
    const rule = projectGatewayRules({ runId: input.runId, approvedRequests }).rules
      .find((candidate) => candidate.actionId === input.actionId)
    if (!rule) throw trustedActionError('E2E_RUNTIME_READ_GATEWAY_RULE_MISSING', '无法投影 Gateway rule')
    const projected: TrustedReadAction = Object.freeze({
      caseId: String(action.caseId), stepId: String(action.stepId), actionId: input.actionId,
      url: expectedPage.url,
      expectedIdentity: {
        url: expectedPage.url, title: expectedPage.title, heading: expectedPage.heading, role: subject.actor,
      },
      expectedText: oracles[0]!.statement as string,
      correlation: Object.freeze({
        ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal, method: rule.method,
        url: rule.url, channel: 'http' as const, bodyDigest: rule.bodyDigest,
        actionId: rule.actionId, capabilityId: rule.capabilityId, headers: {},
      }),
    })
    trustedActions.set(projected, digestText('e2e-trusted-read-action/v1', canonicalizeJson(projected)))
    return projected
  }
}

export class TrustedActionRunner {
  async executeReadOnly(input: {
    action: TrustedReadAction
    grant: SignedReadGrant
    currentSubject: ReadApprovalSubject
    authority: ReadAuthorityClient
    browser: ControlledBrowserSession
    gateway: GatewayProxyProcessHandle
    attemptId: string
  }): Promise<{
    result: ReadOnlyCaseResult
    evidence?: { screenshot: Uint8Array; dom: Uint8Array }
  }> {
    if (trustedActions.get(input.action)
      !== digestText('e2e-trusted-read-action/v1', canonicalizeJson(input.action))) throw trustedActionError(
      'E2E_RUNTIME_READ_ACTION_UNTRUSTED', 'Runner 只接受本进程 TrustedReadActionProjector 投影结果',
    )
    if (!SafeIdSchema.safeParse(input.attemptId).success) throw trustedActionError(
      'E2E_RUNTIME_READ_ATTEMPT_INVALID', 'attemptId 非法',
    )
    const browser = getControlledBrowserSessionBinding(input.browser)
    if (browser.runId !== input.grant.approvalContext.runId
      || browser.gatewaySessionMeasurementDigest
        !== input.gateway.measurement.gatewaySessionMeasurementDigest) {
      throw trustedActionError('E2E_RUNTIME_READ_SESSION_BINDING_MISMATCH', 'Browser/Gateway/Grant/Run 不闭合')
    }
    const capture = new CapturingPageAdapter(new PlaywrightPageAdapter(input.browser.page))
    try {
      const result = await browser.executeWithCorrelation(input.action.correlation, async () => await runReadOnlyCase({
        caseId: input.action.caseId, actionId: input.action.actionId, url: input.action.url,
        expectedIdentity: input.action.expectedIdentity, expectedText: input.action.expectedText,
        authorization: { grant: input.grant, currentSubject: input.currentSubject, authority: input.authority },
        attemptId: input.attemptId,
        runtime: { sandboxHealthy: true, gatewayConnected: true },
        gatewayAudit: () => input.gateway.auditSummary(), page: capture,
      }))
      const evidence = capture.releaseVerified(result)
      return { result, ...(evidence === undefined ? {} : { evidence }) }
    } catch (error) {
      capture.clear()
      throw error
    }
  }
}

class CapturingPageAdapter implements BrowserPageAdapter {
  #screenshot?: Uint8Array
  #dom?: Uint8Array
  constructor(private readonly delegate: BrowserPageAdapter) {}
  goto(url: string) { return this.delegate.goto(url) }
  identity() { return this.delegate.identity() }
  containsText(text: string) { return this.delegate.containsText(text) }
  async screenshot(): Promise<Uint8Array> {
    const bytes = await this.delegate.screenshot()
    if (bytes.byteLength > 16 * 1024 * 1024) throw trustedActionError('E2E_RUNTIME_EVIDENCE_SIZE_LIMIT', 'screenshot 超限')
    this.#screenshot = bytes.slice()
    return bytes
  }
  async domSnapshot(): Promise<string> {
    const dom = await this.delegate.domSnapshot()
    const bytes = Buffer.from(dom, 'utf8')
    if (bytes.byteLength > 4 * 1024 * 1024) throw trustedActionError('E2E_RUNTIME_EVIDENCE_SIZE_LIMIT', 'DOM 超限')
    this.#dom = bytes
    return dom
  }
  releaseVerified(result: ReadOnlyCaseResult): { screenshot: Uint8Array; dom: Uint8Array } | undefined {
    const screenshotSummary = result.evidence.find((item) => item.kind === 'screenshot')
    const domSummary = result.evidence.find((item) => item.kind === 'dom')
    if (!screenshotSummary && !domSummary) { this.clear(); return undefined }
    if (!screenshotSummary || !domSummary || !this.#screenshot || !this.#dom) {
      this.clear()
      throw trustedActionError('E2E_RUNTIME_EVIDENCE_DIGEST_MISMATCH', 'capture 与 result evidence 不完整')
    }
    const screenshotDigest = digestBytes('runtime-evidence/screenshot/v1', this.#screenshot)
    const domDigest = digestText('runtime-evidence/dom/v1', Buffer.from(this.#dom).toString('utf8'))
    if (screenshotSummary.digest !== screenshotDigest || domSummary.digest !== domDigest) {
      this.clear()
      throw trustedActionError('E2E_RUNTIME_EVIDENCE_DIGEST_MISMATCH', 'capture bytes 与 result evidence digest 不一致')
    }
    const released = {
      screenshot: Uint8Array.from(this.#screenshot),
      dom: Uint8Array.from(this.#dom),
    }
    this.clear()
    return released
  }
  clear(): void {
    this.#screenshot?.fill(0); this.#dom?.fill(0)
    this.#screenshot = undefined; this.#dom = undefined
  }
}

function parseFrozen(
  artifacts: Readonly<Record<string, ArtifactDocument>>,
  artifactType: 'test-cases' | 'execution-contract' | 'browser-action-map',
): ArtifactDocument {
  const parsed = ArtifactSchemaRegistry[artifactType].safeParse(artifacts[artifactType])
  if (!parsed.success) throw trustedActionError(
    'E2E_RUNTIME_READ_FROZEN_ARTIFACT_REQUIRED', `缺少严格冻结 ${artifactType}`, parsed.error,
  )
  return parsed.data as ArtifactDocument
}

function parseDiscoveryGrant(value: unknown): SignedDiscoveryGrant {
  const parsed = SignedGrantSchema.safeParse(value)
  if (!parsed.success || !('expectedPageIdentity' in parsed.data.subject)) throw trustedActionError(
    'E2E_RUNTIME_DISCOVERY_GRANT_FACT_REQUIRED', '缺少 Runtime 内部持久化的 SignedDiscoveryGrant',
  )
  return parsed.data as SignedDiscoveryGrant
}

function parseReadGrant(value: unknown): SignedReadGrant {
  const parsed = SignedGrantSchema.safeParse(value)
  if (!parsed.success || !('caseDigest' in parsed.data.subject)
    || !('preflightDigest' in parsed.data.subject)) throw trustedActionError(
    'E2E_RUNTIME_EXECUTION_GRANT_FACT_REQUIRED', '缺少 Runtime 内部持久化的 SignedReadGrant',
  )
  return parsed.data as SignedReadGrant
}

const ObservedPageIdentitySchema = z.object({
  url: z.string(), title: z.string(), headings: z.array(z.string()),
  role: z.string().optional(), ariaSignals: z.array(z.string()).optional(),
}).strict()
const EvidenceSummarySchema = z.object({
  kind: z.enum(['screenshot', 'dom', 'gateway-audit']),
  byteLength: z.number().int().nonnegative(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()
const ReadOnlyCaseResultSchema = z.object({
  caseId: SafeIdSchema,
  actionId: SafeIdSchema,
  status: z.enum(['passed', 'failed', 'input-blocked', 'environment-blocked', 'safety-blocked']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
  expected: z.array(z.string()), actual: z.array(z.string()),
  observedIdentity: ObservedPageIdentitySchema.optional(),
  evidence: z.array(EvidenceSummarySchema),
  reservationIds: z.array(SafeIdSchema).optional(),
  outcomeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict()
const GatewayAuditSchema = z.object({
  received: z.number().int().nonnegative(), forwarded: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(), byIntent: z.record(z.number().int().nonnegative()),
}).strict()

function parseRuntimeReadExecutionOutput(
  value: unknown,
  expectedAction: TrustedReadAction,
): RuntimeReadExecutionOutput {
  const parsed = z.object({
    status: z.enum(['passed', 'failed', 'input-blocked', 'environment-blocked', 'safety-blocked']),
    result: ReadOnlyCaseResultSchema,
    gatewayAudit: GatewayAuditSchema,
    gatewayAuditDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    evidence: z.object({
      screenshot: z.custom<Uint8Array>((bytes) => bytes instanceof Uint8Array),
      dom: z.custom<Uint8Array>((bytes) => bytes instanceof Uint8Array),
    }).strict().optional(),
  }).strict().safeParse(value)
  if (!parsed.success || parsed.data.status !== parsed.data.result.status
    || parsed.data.result.caseId !== expectedAction.caseId
    || parsed.data.result.actionId !== expectedAction.actionId
    || (parsed.data.evidence?.screenshot.byteLength ?? 0) > 16 * 1024 * 1024
    || (parsed.data.evidence?.dom.byteLength ?? 0) > 4 * 1024 * 1024
    || (parsed.success && !runtimeEvidenceCloses(parsed.data))) throw trustedActionError(
    'E2E_RUNTIME_READ_EXECUTOR_OUTPUT_INVALID', 'Read executor 输出未通过严格 schema 与状态/容量闭合',
    parsed.success ? undefined : parsed.error,
  )
  return parsed.data as RuntimeReadExecutionOutput
}

function runtimeEvidenceCloses(output: RuntimeReadExecutionOutput): boolean {
  const gateway = output.gatewayAudit
  if (gateway.forwarded > gateway.received || gateway.blocked > gateway.received
    || gateway.forwarded + gateway.blocked !== gateway.received) return false
  const summaries = output.result.evidence
  const byKind = (kind: 'screenshot' | 'dom' | 'gateway-audit') =>
    summaries.filter((summary) => summary.kind === kind)
  if (output.evidence === undefined) {
    return byKind('screenshot').length === 0 && byKind('dom').length === 0
  }
  if (byKind('screenshot').length !== 1 || byKind('dom').length !== 1
    || byKind('gateway-audit').length !== 1) return false
  const screenshot = byKind('screenshot')[0]!
  const dom = byKind('dom')[0]!
  const audit = byKind('gateway-audit')[0]!
  const auditText = canonicalizeJson(gateway)
  return screenshot.byteLength === output.evidence.screenshot.byteLength
    && screenshot.digest === digestBytes('runtime-evidence/screenshot/v1', output.evidence.screenshot)
    && dom.byteLength === output.evidence.dom.byteLength
    && dom.digest === digestText('runtime-evidence/dom/v1', Buffer.from(output.evidence.dom).toString('utf8'))
    && audit.byteLength === Buffer.byteLength(auditText, 'utf8')
    && audit.digest === digestText('runtime-evidence/gateway-audit/v1', auditText)
}

function trustedActionError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
