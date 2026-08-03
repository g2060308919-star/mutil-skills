import {
  computeDiscoveryPreflightDigest,
  createAuthenticatedRpcHttpTransport,
  createAuthorityDiscoveryRpcClient,
  createAuthorityExecutionRpcClients,
  createAuthorityInjectionRpcClient,
  createAuthorityMaintenanceRpcClient,
  createAuthorityReadRpcClient,
  type TrustedApprovalFreshnessClient,
} from '@mutil-skills/e2e-authority'
import {
  PlaywrightPageAdapter,
  createRuntimeHostFullPlaywrightSession,
  runBrowserPreflight,
  runFullPlaywrightCase,
  type FullPlaywrightEvidenceStage,
} from '@mutil-skills/e2e-playwright-runtime'
import {
  ApprovalCapabilityRecordSchema,
  ApprovalFreshnessReceiptSchema,
  ArtifactSchemaRegistry,
  canonicalizeJson,
  digestBytes,
  deriveExecutionResultId,
  digestCleanupPlanDefinition,
  digestRuntimeHttpResponseBody,
  digestText,
  E2EError,
  FullPlaywrightProgramSchema,
  type TargetProbeDiagnostics,
  SignedGrantSchema,
  type RuntimeFixedHttpRequest,
  type RuntimeHttpReadProbe,
  type SignedInjectionGrant,
  type SignedDiscoveryGrant,
  type SignedGrant,
  type CapabilityReservation,
  type ApprovalFreshnessReceipt,
  type ArtifactAuthorityVerifierMaterial,
  type ArtifactSignature,
  type FullPlaywrightProgram,
} from '@mutil-skills/e2e-contracts'
import { InjectionGateway, LocalGatewayAuditSigner, ReversibleWriteGateway,
  digestBinaryHttpPayload, type TrustedGatewayPublicationAuditRecorder } from '@mutil-skills/e2e-gateway'
import { ControlledBrowserHost, getControlledBrowserSessionBinding } from './browser-host.js'
import {
  inspectChromiumInstallation,
  type BrowserInstallation,
  type ChromiumInstallation,
} from './browser-installer.js'
import {
  readBrowserSelection,
  writeBrowserSelection,
  type BrowserSelection,
} from './runtime-user-config.js'
import {
  revalidateSystemChrome,
  systemChromeClosureDigest,
  type InspectedSystemChrome,
  type SystemChromeSelection,
} from './system-chrome.js'
import { startGatewayProxyHostForRuntime } from './gateway-proxy-host.js'
import { projectGatewayRules, type ApprovedGatewayRequest } from './gateway-rule-projector.js'
import { runtimeLayout } from './runtime-layout.js'
import {
  inspectRuntimeCapabilityProof,
  recordRuntimeCapabilityProof,
  type RuntimeCapabilityProof,
} from './runtime-capability-proof.js'
import {
  runtimeApprovalExecutionBinding,
  type RuntimeArtifactStoreAuthority,
  type RuntimeAuthorityHost,
} from './authority-host.js'
import type { RuntimeInstallation } from './runtime-discovery.js'
import {
  authorizeRuntimePreflight,
  BrowserPreflightFactSchema,
  type RuntimePreflightCapability,
} from './runtime-preflight.js'
import {
  authorizeTargetProbe,
  type TargetProbeCapability,
} from './target-probe.js'
import {
  TrustedActionRunner,
  authorizeRuntimeReadExecutor,
  authorizeRuntimeInjectionExecutor,
  authorizeRuntimeWriteExecutor,
  type RuntimeInjectionExecutorCapability,
  type RuntimeReadExecutorCapability,
  type RuntimeWriteExecutorCapability,
  authorizeRuntimeFullPlaywrightExecutor,
  type RuntimeFullPlaywrightExecutorCapability,
} from './trusted-action-runner.js'
import {
  projectRuntimeFullPlaywrightCases,
  type RuntimeFullPlaywrightProjection,
} from './runtime-full-playwright-projector.js'
import type { RuntimeRunSnapshot } from './run-store.js'
import { RuntimeFullPlaywrightCheckpointStore } from './runtime-full-playwright-checkpoint.js'
import type { RuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import { projectRuntimeWriteSnapshot } from './runtime-write-projector.js'
import { executeSecretTemplateAtBridge, type SecretTemplateBroker } from './secret-template.js'
import { GatewayCleanupTransport, authorizeGatewayCleanupTransport } from './gateway-cleanup-transport.js'
import {
  createRuntimeWriteOwnedResourceLifecycle,
  prepareRuntimeWriteCleanup,
  type RuntimeWriteProductionCapability,
} from './runtime-write-production.js'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { expect as playwrightExpect, type APIRequestContext, type Browser, type BrowserContext,
  type Route } from '@playwright/test'

export function runtimeFullPlaywrightRunnerResultDigest(input: {
  resultDigest: string
  outcome?: { runnerResultDigest: string }
}): string {
  return input.outcome?.runnerResultDigest ?? input.resultDigest
}

export interface RuntimeBrowserInstallationOperations {
  readSelection(homeDir: string): Promise<BrowserSelection | undefined>
  inspectManaged(input: {
    homeDir: string
    runtimeVersion: string
    runtimeInstallationDigest: string
  }): Promise<ChromiumInstallation>
  revalidateSystem(
    selection: SystemChromeSelection,
    options: { projectRoot: string },
  ): Promise<InspectedSystemChrome>
  inspectCapabilityProof(input: {
    homeDir: string
    runtimeInstallationDigest: string
  }): Promise<RuntimeCapabilityProof>
}

/**
 * 生产浏览器解析只消费已验证的用户选择。旧版本只安装了托管 Chromium、尚无
 * selection 文件时保持原语义；系统 Chrome 每次 Run 都重新验证，绝不静默回退下载。
 */
export async function resolveRuntimeBrowserInstallation(
  input: {
    homeDir: string
    browserHomeDir?: string
    projectRoot: string
    installation: RuntimeInstallation
  },
  operations: RuntimeBrowserInstallationOperations = productionRuntimeBrowserInstallationOperations,
): Promise<BrowserInstallation> {
  const browserHomeDir = input.browserHomeDir ?? input.homeDir
  const selection = input.browserHomeDir !== undefined && input.browserHomeDir !== input.homeDir
    ? undefined : await operations.readSelection(input.homeDir)
  if (selection !== undefined
    && selection.runtimeInstallationDigest !== input.installation.installationDigest) {
    throw new E2EError({
      code: 'E2E_BROWSER_SELECTION_RUNTIME_MISMATCH', category: 'safety',
      message: 'Browser Selection 与当前 Runtime installation 不一致', retryable: false,
    })
  }
  const proof = await operations.inspectCapabilityProof({
    homeDir: input.homeDir,
    runtimeInstallationDigest: input.installation.installationDigest,
  })
  if (selection !== undefined
    && (selection.controlledLaunchProofDigest !== proof.proofDigest
      || selection.executableDigest !== proof.isolation.browserExecutableDigest)) {
    throw browserCapabilityProofMismatch()
  }
  if (selection?.source.kind === 'system-chrome') {
    const inspected = await operations.revalidateSystem(selection as SystemChromeSelection, {
      projectRoot: input.projectRoot,
    })
    if (proof.isolation.browserClosureDigest !== systemChromeClosureDigest(inspected)) {
      throw browserCapabilityProofMismatch()
    }
    return inspected
  }
  const managed = await operations.inspectManaged({
    homeDir: browserHomeDir,
    runtimeVersion: input.installation.version,
    runtimeInstallationDigest: input.installation.installationDigest,
  })
  if (managed.manifest.executableDigest !== proof.isolation.browserExecutableDigest
    || managed.manifest.closureDigest !== proof.isolation.browserClosureDigest) {
    throw browserCapabilityProofMismatch()
  }
  return managed
}

const productionRuntimeBrowserInstallationOperations: RuntimeBrowserInstallationOperations = Object.freeze({
  readSelection: async (homeDir: string) => await readBrowserSelection(homeDir).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }),
  inspectManaged: async (input: {
    homeDir: string; runtimeVersion: string; runtimeInstallationDigest: string
  }) => await inspectChromiumInstallation(input),
  revalidateSystem: async (selection: SystemChromeSelection, options: { projectRoot: string }) =>
    await revalidateSystemChrome(selection, options),
  inspectCapabilityProof: async (input: { homeDir: string; runtimeInstallationDigest: string }) =>
    await inspectRuntimeCapabilityProof(input),
})

function browserCapabilityProofMismatch(): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CAPABILITY_PROOF_BROWSER_MISMATCH', category: 'safety',
    message: 'Browser selection、当前浏览器闭包与可信 capability proof 不一致；请重新配置浏览器',
    retryable: false,
  })
}

type RuntimeReadAuthority = ReturnType<typeof createAuthorityReadRpcClient>

async function activateRuntimeGrant(
  authorityHost: RuntimeAuthorityHost,
  grant: SignedGrant,
): Promise<{
  consumeConnection<T>(create: (
    connection: ReturnType<RuntimeAuthorityHost['executionRpcConnection']>,
  ) => T): T
}> {
  const approvalBinding = runtimeApprovalExecutionBinding(grant.approvalContext)
  await authorityHost.activateGrant({ grant, approvalBinding })
  return Object.freeze({
    consumeConnection<T>(create: (
      connection: ReturnType<RuntimeAuthorityHost['executionRpcConnection']>,
    ) => T): T {
      return consumeRpcConnectionCredential(
        authorityHost.executionRpcConnection(approvalBinding),
        create,
      )
    },
  })
}

/**
 * Read Runner 的 capability reservation 发生在 Authority RPC，而 HTTP 决策发生在 Gateway。
 * 可信装配层在 Authority 终态成功后把同一 reservation 交给 Gateway recorder，供最终
 * attempt 审计闭合；调用方不能自行伪造 completed/unknown 事实。
 */
export function createAuditedRuntimeReadAuthority(
  authority: RuntimeReadAuthority,
  recorder: TrustedGatewayPublicationAuditRecorder,
): RuntimeReadAuthority {
  const pending = new Map<string, CapabilityReservation>()
  const requirePending = (reservationId: string): CapabilityReservation => {
    const reservation = pending.get(reservationId)
    if (reservation === undefined) throw new E2EError({
      code: 'E2E_RUNTIME_READ_RESERVATION_AUDIT_MISSING', category: 'safety',
      message: 'Read reservation 未在可信装配层登记', retryable: false,
    })
    return reservation
  }
  return Object.freeze({
    async reserveForSubject(input: Parameters<RuntimeReadAuthority['reserveForSubject']>[0]) {
      const reservation = await authority.reserveForSubject(input)
      if (pending.has(reservation.reservationId)) throw new E2EError({
        code: 'E2E_RUNTIME_READ_RESERVATION_AUDIT_DUPLICATE', category: 'safety',
        message: 'Read reservationId 重复', retryable: false,
      })
      pending.set(reservation.reservationId, structuredClone(reservation))
      return reservation
    },
    async complete(reservationId: string, outcomeDigest: string) {
      const reservation = requirePending(reservationId)
      await authority.complete(reservationId, outcomeDigest)
      recorder.recordCapabilityReservation({
        reservation: { ...reservation, status: 'completed', outcomeDigest }, consumed: true,
      })
      pending.delete(reservationId)
    },
    async markUnknown(reservationId: string, observation: string) {
      const reservation = requirePending(reservationId)
      await authority.markUnknown(reservationId, observation)
      recorder.recordCapabilityReservation({
        reservation: { ...reservation, status: 'unknown', observation }, consumed: false,
      })
      pending.delete(reservationId)
    },
    destroy() {
      pending.clear()
      authority.destroy()
    },
  })
}

export function projectDiscoveryPreflightRequests(grant: SignedDiscoveryGrant): {
  navigation: Extract<SignedDiscoveryGrant['capabilities'][number], { transport: 'browser-local' }>
  approvedRequests: ApprovedGatewayRequest[]
  usesSignedRequestClosure: boolean
} {
  const navigation = grant.capabilities.filter((capability) => capability.operation === 'local-navigation')
  if (navigation.length !== 1 || navigation[0]!.transport !== 'browser-local') {
    throw new Error('E2E_RUNTIME_DISCOVERY_CAPABILITY_AMBIGUOUS')
  }
  const subject = grant.subject
  if (subject.requests.length === 0) {
    return {
      navigation: navigation[0], usesSignedRequestClosure: false,
      approvedRequests: [{
        actionId: navigation[0].actionId, capabilityId: navigation[0].capabilityId,
        method: 'GET', url: subject.expectedPageIdentity.url, maxUses: navigation[0].maxUses,
        behavior: { kind: 'pass-through' },
      }],
    }
  }
  const requests = new Map(subject.requests.map((request) => [request.requestId, request]))
  const mappings = new Map<string, { actionId: string; capabilityId: string; maxUses: number }>()
  for (const action of subject.actions.filter((candidate) => candidate.operation === 'http-request')) {
    const capabilities = grant.capabilities.filter((candidate): candidate is Extract<
      SignedDiscoveryGrant['capabilities'][number], { transport: 'http' }
    > => candidate.operation === 'http-request'
      && candidate.actionId === action.actionId && candidate.transport === 'http')
    if (capabilities.length !== 1
      || canonicalizeJson(capabilities[0]!.requestIds) !== canonicalizeJson(action.requestIds)) {
      throw new Error('E2E_RUNTIME_DISCOVERY_HTTP_CAPABILITY_MISMATCH')
    }
    for (const requestId of action.requestIds) {
      if (mappings.has(requestId)) throw new Error('E2E_RUNTIME_DISCOVERY_REQUEST_DUPLICATE')
      mappings.set(requestId, {
        actionId: action.actionId, capabilityId: capabilities[0]!.capabilityId,
        maxUses: capabilities[0]!.maxUses,
      })
    }
  }
  if (mappings.size !== requests.size
    || !subject.requests.some((request) => request.method === 'GET'
      && request.url === subject.expectedPageIdentity.url)) {
    throw new Error('E2E_RUNTIME_DISCOVERY_REQUEST_CLOSURE_INCOMPLETE')
  }
  return {
    navigation: navigation[0], usesSignedRequestClosure: true,
    approvedRequests: subject.requests.map((request) => {
      const mapping = mappings.get(request.requestId)
      if (!mapping) throw new Error('E2E_RUNTIME_DISCOVERY_REQUEST_CAPABILITY_MISSING')
      return {
        ...mapping, requestId: request.requestId, method: request.method, url: request.url,
        signedBodyDigest: request.bodyDigest,
        headers: request.headers.map(({ name, value }) => ({ name, value })),
        redirectRequestIds: request.redirectPolicy.mode === 'follow-approved'
          ? [...request.redirectPolicy.requestIds] : [],
        behavior: { kind: 'pass-through' as const },
      }
    }),
  }
}

export function createProductionBrowserCapabilities(input: {
  homeDir: string
  browserHomeDir?: string
  projectRoot: string
  installation: RuntimeInstallation
  authorityHost(): Promise<RuntimeAuthorityHost>
}): { preflight: RuntimePreflightCapability; read: RuntimeReadExecutorCapability } {
  const browserInstallation = async () => await resolveRuntimeBrowserInstallation(input)
  const preflight = authorizeRuntimePreflight({
    prepare: async ({ snapshot, grant, attemptId }) => {
    const projection = projectDiscoveryPreflightRequests(grant)
    const capability = projection.navigation
    const authorityHost = await input.authorityHost()
    const activated = await activateRuntimeGrant(authorityHost, grant)
    const authority = activated.consumeConnection((consumed) =>
      createAuthorityDiscoveryRpcClient({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const approvedRequests = projection.approvedRequests
    let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
    let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let operationError: unknown
    let proofInput: Parameters<typeof recordRuntimeCapabilityProof>[0] | undefined
    let gatewayAuditVerifierMaterial: Record<string, unknown> | undefined
    try {
      gateway = await startGatewayProxyHostForRuntime({
        runId: snapshot.runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
        approvedRequests,
        policyObjects: { factory: ({ signer }) => {
          gatewayAuditVerifierMaterial = signer.exportVerifierMaterial() as unknown as Record<string, unknown>
          return {}
        } },
      })
      browser = await new ControlledBrowserHost().open({
        homeDir: input.homeDir, runId: snapshot.runId,
        installation: await browserInstallation(), gateway,
      })
      const rules = projectGatewayRules({ runId: snapshot.runId, approvedRequests }).rules
      const page = new PlaywrightPageAdapter(browser.page)
      const binding = getControlledBrowserSessionBinding(browser)
      const navigate = async (url: string) => projection.usesSignedRequestClosure
        ? await binding.executeWithCorrelations(rules.map((rule) => ({
            requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
            method: rule.method, url: rule.url, channel: 'http' as const, bodyDigest: rule.bodyDigest,
            actionId: rule.actionId, capabilityId: rule.capabilityId,
            signedBodyDigest: rule.signedBodyDigest!, redirectRequestIds: [...rule.redirectRequestIds],
            navigation: rule.method === 'GET' && rule.url === grant.subject.expectedPageIdentity.url,
            maxUses: rule.maxUses, headers: { ...rule.requestHeaders },
          })), async () => await page.goto(url))
        : await binding.executeWithCorrelation({
            ruleId: rules[0]!.ruleId, stepOrdinal: rules[0]!.stepOrdinal,
            method: rules[0]!.method, url: rules[0]!.url, channel: 'http',
            bodyDigest: rules[0]!.bodyDigest, actionId: rules[0]!.actionId,
            capabilityId: rules[0]!.capabilityId, headers: {},
          }, async () => await page.goto(url))
      const outcome = await runBrowserPreflight({
        authorization: { grant, currentSubject: grant.subject, authority: {
          reserveForSubject: async (reservationInput) =>
            await authority.reserveForSubject(reservationInput),
          completeDiscoveryPreflight: async (completionInput) =>
            computeDiscoveryPreflightDigest(completionInput),
        } },
        runtime: { sandboxHealthy: true, gatewayConnected: true },
        gatewayAudit: () => gateway!.handle.auditSummary(),
        page: {
          goto: navigate,
          identity: async () => await page.identity(),
          containsText: async (text) => await page.containsText(text),
          screenshot: async () => await page.screenshot(),
          domSnapshot: async () => await page.domSnapshot(),
        },
        actionId: capability.actionId,
        attemptId,
      })
      if (outcome.status !== 'ready') return {
        capabilityId: capability.capabilityId,
        output: {
          status: outcome.status, reasonCode: outcome.reasonCode ?? 'E2E_RUNTIME_PREFLIGHT_NOT_READY',
          ...(outcome.reservationId ? { reservationId: outcome.reservationId } : {}),
          ...(outcome.observedIdentity ? { observedIdentity: outcome.observedIdentity } : {}),
        },
      }
      if (!outcome.reservationId || !outcome.preflightDigest || !outcome.observedIdentity) {
        throw new E2EError({
          code: 'E2E_RUNTIME_PREFLIGHT_PREPARATION_INVALID', category: 'safety',
          message: 'ready preflight 缺少 reservation、digest 或 observed identity', retryable: false,
        })
      }
      const publication = await gateway.handle.finalize()
      if (gatewayAuditVerifierMaterial === undefined) {
        throw new E2EError({
          code: 'E2E_RUNTIME_READ_VERIFIER_MATERIAL_MISSING', category: 'safety',
          message: '只读执行缺少 Gateway audit verifier material', retryable: false,
        })
      }
      const gatewayAuditDigest = digestText('gateway-publication-audit/v1', canonicalizeJson(publication))
      proofInput = {
        homeDir: input.homeDir, runtimeInstallationDigest: input.installation.installationDigest,
        gateway: {
          sessionMeasurementDigest: gateway.handle.measurement.gatewaySessionMeasurementDigest,
          policyDigest: gateway.handle.measurement.policyDigest, auditDigest: gatewayAuditDigest,
        },
        isolation: {
          browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
          sandboxProfileDigest: browser.measurement.sandboxProfileDigest,
          canaryProofDigest: browser.measurement.canaryProofDigest,
          browserClosureDigest: browser.measurement.browserClosureDigest,
          browserExecutableDigest: browser.measurement.browserExecutableDigest,
        },
        verifiedAt: new Date().toISOString(),
      }
      return {
        capabilityId: capability.capabilityId,
        output: {
          status: 'ready', reservationId: outcome.reservationId,
          observedIdentity: outcome.observedIdentity,
          browserMeasurement: {
            browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
            browserClosureDigest: browser.measurement.browserClosureDigest,
            browserExecutableDigest: browser.measurement.browserExecutableDigest,
            gatewaySessionMeasurementDigest: browser.measurement.gatewaySessionMeasurementDigest,
            canaryProofDigest: browser.measurement.canaryProofDigest,
          },
          gatewayPolicyDigest: gateway.handle.measurement.policyDigest,
          gatewayAuditDigest,
        },
      }
    } catch (error) {
      operationError = error
      throw error
    } finally {
      await settleRuntimeBrowserResourcesThenRecordProof(operationError, [
        ...(browser === undefined ? [] : [async () => await browser!.close()]),
        ...(gateway === undefined ? [] : [async () => await gateway!.handle.close()]),
        async () => authority.destroy(),
      ], proofInput)
    }
    },
    finalize: async ({ grant, preparation }) => {
      const output = preparation.output
      if (output.reservationId === undefined) return output
      const authorityHost = await input.authorityHost()
      const activated = await activateRuntimeGrant(authorityHost, grant)
      const authority = activated.consumeConnection((consumed) =>
        createAuthorityDiscoveryRpcClient({
          credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
          expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
          transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
          approvalBinding: consumed.approvalBinding,
        }))
      try {
        const authorityOutcome = {
          status: output.status,
          ...(!('reasonCode' in output) || output.reasonCode === undefined
            ? {} : { reasonCode: output.reasonCode }),
          ...(output.observedIdentity === undefined ? {} : { observedIdentity: output.observedIdentity }),
        }
        const preflightDigest = await authority.completeDiscoveryPreflight({
          grant, currentSubject: grant.subject,
          reservationId: output.reservationId,
          capabilityId: preparation.capabilityId,
          outcome: authorityOutcome,
        })
        const expectedDigest = computeDiscoveryPreflightDigest({
          grant, capabilityId: preparation.capabilityId,
          reservationId: output.reservationId, outcome: authorityOutcome,
        })
        if (preflightDigest !== expectedDigest) {
          throw new E2EError({
            code: 'E2E_RUNTIME_PREFLIGHT_RECEIPT_MISMATCH', category: 'safety',
            message: 'Authority preflight receipt 与持久 preparation 不一致', retryable: false,
          })
        }
        if (output.status !== 'ready') return { ...output, preflightDigest }
        const authorityOutcomeDigest = digestText(
          'authority-preflight-outcome/v1', canonicalizeJson({ ...output, preflightDigest }),
        )
        return {
          ...output, preflightDigest, authorityOutcomeDigest,
          authorityReceiptDigest: digestText('authority-preflight-receipt/v1', canonicalizeJson({
            reservationId: output.reservationId, preflightDigest, authorityOutcomeDigest,
          })),
        }
      } finally {
        authority.destroy()
      }
    },
  })

  const read = authorizeRuntimeReadExecutor(async ({ snapshot, action, grant, currentSubject, attemptId }) => {
    const authorityHost = await input.authorityHost()
    const activated = await activateRuntimeGrant(authorityHost, grant)
    const authority = activated.consumeConnection((consumed) =>
      createAuthorityReadRpcClient({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const approvedRequests = action.requestCorrelations.map((correlation) => ({
      actionId: correlation.actionId, capabilityId: correlation.capabilityId,
      requestId: correlation.requestId, method: correlation.method, url: correlation.url,
      maxUses: correlation.maxUses, signedBodyDigest: correlation.signedBodyDigest,
      headers: Object.entries(correlation.headers).map(([name, value]) => ({ name, value })),
      redirectRequestIds: [...correlation.redirectRequestIds],
      behavior: { kind: 'pass-through' as const },
    }))
    let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
    let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let operationError: unknown
    let proofInput: Parameters<typeof recordRuntimeCapabilityProof>[0] | undefined
    let gatewayAuditVerifierMaterial: Record<string, unknown> | undefined
    let gatewayAuditRecorder: TrustedGatewayPublicationAuditRecorder | undefined
    let auditedAuthority: RuntimeReadAuthority | undefined
    try {
      gateway = await startGatewayProxyHostForRuntime({
        runId: snapshot.runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
        approvedRequests,
        policyObjects: { factory: ({ signer, recorder }) => {
          gatewayAuditVerifierMaterial = signer.exportVerifierMaterial() as unknown as Record<string, unknown>
          gatewayAuditRecorder = recorder
          return {}
        } },
      })
      if (gatewayAuditRecorder === undefined) throw new E2EError({
        code: 'E2E_RUNTIME_READ_AUDIT_RECORDER_MISSING', category: 'safety',
        message: '只读执行缺少可信 Gateway audit recorder', retryable: false,
      })
      auditedAuthority = createAuditedRuntimeReadAuthority(authority, gatewayAuditRecorder)
      browser = await new ControlledBrowserHost().open({
        homeDir: input.homeDir, runId: snapshot.runId,
        installation: await browserInstallation(), gateway,
      })
      const executed = await new TrustedActionRunner().executeReadOnly({
        action, grant, currentSubject, authority: auditedAuthority,
        browser, gateway: gateway.handle, attemptId,
      })
      const publication = await gateway.handle.finalize()
      if (gatewayAuditVerifierMaterial === undefined) {
        throw new E2EError({
          code: 'E2E_RUNTIME_READ_VERIFIER_MATERIAL_MISSING', category: 'safety',
          message: '只读执行缺少 Gateway audit verifier material', retryable: false,
        })
      }
      const gatewayAuditDigest = digestText('gateway-publication-audit/v1', canonicalizeJson(publication))
      proofInput = {
        homeDir: input.homeDir, runtimeInstallationDigest: input.installation.installationDigest,
        gateway: {
          sessionMeasurementDigest: gateway.handle.measurement.gatewaySessionMeasurementDigest,
          policyDigest: gateway.handle.measurement.policyDigest, auditDigest: gatewayAuditDigest,
        },
        isolation: {
          browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
          sandboxProfileDigest: browser.measurement.sandboxProfileDigest,
          canaryProofDigest: browser.measurement.canaryProofDigest,
          browserClosureDigest: browser.measurement.browserClosureDigest,
          browserExecutableDigest: browser.measurement.browserExecutableDigest,
        },
        verifiedAt: new Date().toISOString(),
      }
      return {
        status: executed.result.status, result: executed.result,
        gatewayAudit: executed.gatewayAudit,
        gatewayAuditDigest,
        ...(executed.evidence === undefined ? {} : { evidence: executed.evidence }),
        finalizationFacts: {
          gatewayAudit: publication as unknown as Record<string, unknown>,
          gatewayAuditVerifierMaterial,
          browserMeasurements: browser.measurement as unknown as Record<string, unknown>,
          isolationMeasurements: {
            browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
            sandboxProfileDigest: browser.measurement.sandboxProfileDigest,
            canaryProofDigest: browser.measurement.canaryProofDigest,
            browserClosureDigest: browser.measurement.browserClosureDigest,
            browserExecutableDigest: browser.measurement.browserExecutableDigest,
          },
        },
      }
    } catch (error) {
      operationError = error
      throw error
    } finally {
      await settleRuntimeBrowserResourcesThenRecordProof(operationError, [
        ...(browser === undefined ? [] : [async () => await browser!.close()]),
        ...(gateway === undefined ? [] : [async () => await gateway!.handle.close()]),
        async () => (auditedAuthority ?? authority).destroy(),
      ], proofInput)
    }
  })
  return { preflight, read }
}

export function createProductionTargetProbeCapability(input: {
  homeDir: string
  browserHomeDir?: string
  projectRoot: string
  installation: RuntimeInstallation
}): TargetProbeCapability {
  const browserInstallation = async () => await resolveRuntimeBrowserInstallation(input)
  return authorizeTargetProbe(async ({ runId, contract, strategy, attempt }) => {
    const discoveredRequests = new Map<string, {
      method: 'GET' | 'HEAD'; url: string; resourceType: string
    }>()
    discoveredRequests.set(`GET\0${contract.targetUrl}`, {
      method: 'GET', url: contract.targetUrl, resourceType: 'document',
    })
    let observedUrl = contract.targetUrl
    let observedTitle = ''
    let lastIdentityMatched = false
    let lastDiagnostics = emptyProductionTargetProbeDiagnostics(strategy, attempt)
    try {
      for (let round = 0; round < 5; round += 1) {
        const approvedRequests = targetProbeApprovedRequests([...discoveredRequests.values()])
        let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
        let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
        try {
          gateway = await startGatewayProxyHostForRuntime({
            runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
            approvedRequests,
          })
          browser = await new ControlledBrowserHost().open({
            homeDir: input.homeDir, runId,
            installation: await browserInstallation(), gateway,
          })
          const observed = new Map<string, {
            method: 'GET' | 'HEAD'; url: string; resourceType: string
          }>()
          const consoleErrors: string[] = []
          const pageErrors: string[] = []
          const failedRequests: TargetProbeDiagnostics['failedRequests'] = []
          const activeRequests = new Map<object, { url: string; resourceType: string }>()
          const persistentConnections = new Map<object, { url: string; resourceType: string }>()
          browser.page.on('request', (request) => {
            const observedMethod = request.method().toUpperCase()
            if (observedMethod !== 'GET' && observedMethod !== 'HEAD') return
            const method: 'GET' | 'HEAD' = observedMethod === 'GET' ? 'GET' : 'HEAD'
            let url: URL
            try { url = new URL(request.url()) } catch { return }
            if (!contract.allowedNavigationOrigins.includes(url.origin)
              || !['http:', 'https:'].includes(url.protocol)) return
            url.hash = ''
            const resource = {
              method, url: url.href, resourceType: request.resourceType(),
            }
            observed.set(`${method}\0${url.href}`, resource)
            activeRequests.set(request, { url: resource.url, resourceType: resource.resourceType })
            if (resource.resourceType === 'eventsource' && persistentConnections.size < 50) {
              persistentConnections.set(request, {
                url: resource.url, resourceType: 'eventsource',
              })
            }
          })
          browser.page.on('console', (message) => {
            if (message.type() === 'error' && consoleErrors.length < 20) {
              consoleErrors.push(message.text().slice(0, 4_096))
            }
          })
          browser.page.on('pageerror', (error) => {
            if (pageErrors.length < 20) {
              pageErrors.push(`[pageerror] ${String(error)}`.slice(0, 4_096))
            }
          })
          browser.page.on('requestfailed', (request) => {
            if (failedRequests.length < 50) {
              failedRequests.push({
                method: request.method().slice(0, 16), url: request.url(),
                resourceType: request.resourceType().slice(0, 64),
                errorText: (request.failure()?.errorText ?? 'request failed').slice(0, 4_096),
              })
            }
            activeRequests.delete(request)
            persistentConnections.delete(request)
          })
          browser.page.on('requestfinished', (request) => {
            activeRequests.delete(request)
            persistentConnections.delete(request)
          })
          browser.page.on('response', (response) => {
            const contentType = response.headers()['content-type']?.toLowerCase() ?? ''
            if (!contentType.includes('text/event-stream') || persistentConnections.size >= 50) return
            persistentConnections.set(response.request(), {
              url: response.url(), resourceType: 'eventsource',
            })
          })
          browser.page.on('websocket', (socket) => {
            if (persistentConnections.size >= 50) return
            const item = { url: socket.url(), resourceType: 'websocket' }
            persistentConnections.set(socket, item)
            socket.on('close', () => persistentConnections.delete(socket))
          })
          const rules = projectGatewayRules({ runId, approvedRequests }).rules
          await getControlledBrowserSessionBinding(browser).executeWithCorrelations(
            rules.map((rule) => ({
              requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
              method: rule.method, url: rule.url, channel: 'http' as const,
              bodyDigest: rule.bodyDigest, actionId: rule.actionId,
              capabilityId: rule.capabilityId, signedBodyDigest: rule.signedBodyDigest!,
              redirectRequestIds: [...rule.redirectRequestIds],
              navigation: rule.url === contract.targetUrl, maxUses: rule.maxUses,
              headers: { ...rule.requestHeaders },
            })),
            async () => {
              await browser!.page.goto(contract.targetUrl, { waitUntil: 'domcontentloaded' })
              if (strategy !== 'dom-identity') {
                await browser!.page.waitForLoadState('networkidle', { timeout: 2_000 })
                  .catch(() => undefined)
              }
            },
          )
          const additions = [...observed.entries()].filter(([key]) => !discoveredRequests.has(key))
          const page = new PlaywrightPageAdapter(browser.page)
          const evaluation = await page.evaluateIdentity(contract.pageIdentityPolicy)
          lastIdentityMatched = evaluation.matched
          observedUrl = browser.page.url()
          observedTitle = await browser.page.title().catch(() => '')
          const visibleTextSummary = await browser.page.locator('body').innerText({ timeout: 500 })
            .then((text) => text.replace(/\s+/gu, ' ').trim().slice(0, 4_096))
            .catch(() => '')
          const diagnosticErrors = [...pageErrors, ...consoleErrors].slice(0, 20)
          lastDiagnostics = {
            strategy, attempt,
            domPresent: await browser.page.locator('html').count().then((count) => count > 0)
              .catch(() => false),
            visibleTextSummary,
            consoleErrors: diagnosticErrors,
            failedRequests,
            pendingResources: [...activeRequests.values()].slice(0, 256),
            unapprovedResources: additions.slice(0, 256).map(([, request]) => ({
              url: request.url, resourceType: request.resourceType,
            })),
            persistentConnections: [...persistentConnections.values()],
            advisories: [
              ...(additions.length > 0 ? ['E2E_TARGET_PROBE_RESOURCE_CLOSURE_LIMIT'] : []),
              ...(activeRequests.size > 0 ? ['E2E_TARGET_PROBE_RESOURCE_TIMEOUT'] : []),
              ...(persistentConnections.size > 0
                ? ['E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION'] : []),
              ...(hasPageRuntimeError(diagnosticErrors)
                ? ['E2E_TARGET_PROBE_PAGE_RUNTIME_ERROR'] : []),
            ],
            resourceSummary: {
              observedCount: observed.size,
              approvedCount: discoveredRequests.size,
              pendingCount: activeRequests.size,
              unapprovedCount: additions.length,
              persistentConnectionCount: persistentConnections.size,
              closureComplete: additions.length === 0
                && activeRequests.size === 0 && persistentConnections.size === 0,
            },
          }
          if (evaluation.matched && strategy !== 'resource-closure'
            && !hasPageRuntimeError(diagnosticErrors)) {
            await gateway.handle.finalize()
            return {
              status: 'ready', observedUrl, observedTitle, identityMatched: true,
              diagnostics: lastDiagnostics,
            }
          }
          if (additions.length > 0) {
            if (round === 4 || discoveredRequests.size + additions.length > 256) {
              throw new E2EError({
                code: 'E2E_TARGET_PROBE_RESOURCE_CLOSURE_LIMIT', category: 'environment',
                message: 'Target Probe 静态资源闭包超过有限发现范围', retryable: true,
              })
            }
            for (const [key, request] of additions) discoveredRequests.set(key, request)
            continue
          }
          if (strategy === 'resource-closure'
            && (activeRequests.size > 0 || persistentConnections.size > 0)) {
            throw new E2EError({
              code: persistentConnections.size > 0
                ? 'E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION'
                : 'E2E_TARGET_PROBE_RESOURCE_TIMEOUT',
              category: 'environment', message: 'Target Probe 仍有未结束资源', retryable: true,
            })
          }
          await gateway.handle.finalize()
          if (evaluation.matched && hasPageRuntimeError(diagnosticErrors)) return {
            status: 'environment-blocked', reasonCode: 'E2E_TARGET_PROBE_PAGE_RUNTIME_ERROR',
            observedUrl, observedTitle, identityMatched: true, diagnostics: lastDiagnostics,
          }
          return evaluation.matched ? {
            status: 'ready',
            observedUrl, observedTitle, identityMatched: true, diagnostics: lastDiagnostics,
          } : {
            status: targetProbeBlockedStatus(lastDiagnostics),
            reasonCode: targetProbeBlockedReason(lastDiagnostics),
            observedUrl, observedTitle, identityMatched: false, diagnostics: lastDiagnostics,
          }
        } finally {
          await settleRuntimeBrowserResources(undefined, [
            ...(browser === undefined ? [] : [async () => await browser!.close()]),
            ...(gateway === undefined ? [] : [async () => await gateway!.handle.close()]),
          ])
        }
      }
    } catch (error) {
      return {
        status: 'environment-blocked',
        reasonCode: targetProbeFailureReason(error, lastDiagnostics),
        observedUrl, observedTitle, identityMatched: lastIdentityMatched,
        diagnostics: lastDiagnostics,
      }
    }
    return {
      status: 'environment-blocked', reasonCode: 'E2E_TARGET_BROWSER_NAVIGATION_FAILED',
      observedUrl, observedTitle, identityMatched: lastIdentityMatched,
      diagnostics: lastDiagnostics,
    }
  })
}

function emptyProductionTargetProbeDiagnostics(
  strategy: TargetProbeDiagnostics['strategy'], attempt: number,
): TargetProbeDiagnostics {
  return {
    strategy, attempt, domPresent: false, visibleTextSummary: '', consoleErrors: [],
    failedRequests: [], pendingResources: [], unapprovedResources: [],
    persistentConnections: [], advisories: [],
    resourceSummary: {
      observedCount: 0, approvedCount: 0, pendingCount: 0,
      unapprovedCount: 0, persistentConnectionCount: 0, closureComplete: true,
    },
  }
}

function targetProbeBlockedStatus(diagnostics: TargetProbeDiagnostics):
  'environment-blocked' | 'page-identity-mismatch' {
  const environmentBlocked = hasPageRuntimeError(diagnostics.consoleErrors)
    || diagnostics.failedRequests.some((request) => request.resourceType === 'script')
    || diagnostics.pendingResources.length > 0
    || diagnostics.persistentConnections.length > 0
  return diagnostics.domPresent && !environmentBlocked
    ? 'page-identity-mismatch' : 'environment-blocked'
}

function targetProbeBlockedReason(diagnostics: TargetProbeDiagnostics): string {
  if (!diagnostics.domPresent) return 'E2E_TARGET_PROBE_PAGE_NOT_READY'
  if (hasPageRuntimeError(diagnostics.consoleErrors)) return 'E2E_TARGET_PROBE_PAGE_RUNTIME_ERROR'
  if (diagnostics.failedRequests.some((request) => request.resourceType === 'script')) {
    return 'E2E_TARGET_PROBE_PENDING_SCRIPT'
  }
  if (diagnostics.pendingResources.some((request) => request.resourceType === 'script')) {
    return 'E2E_TARGET_PROBE_PENDING_SCRIPT'
  }
  if (diagnostics.persistentConnections.length > 0) {
    return 'E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION'
  }
  if (diagnostics.pendingResources.length > 0) return 'E2E_TARGET_PROBE_RESOURCE_TIMEOUT'
  return 'E2E_RUNTIME_PAGE_MISMATCH'
}

function targetProbeFailureReason(error: unknown, diagnostics: TargetProbeDiagnostics): string {
  if (hasPageRuntimeError(diagnostics.consoleErrors)) return 'E2E_TARGET_PROBE_PAGE_RUNTIME_ERROR'
  if (diagnostics.failedRequests.some((request) => request.resourceType === 'script')) {
    return 'E2E_TARGET_PROBE_PENDING_SCRIPT'
  }
  if (diagnostics.pendingResources.some((request) => request.resourceType === 'script')) {
    return 'E2E_TARGET_PROBE_PENDING_SCRIPT'
  }
  if (diagnostics.persistentConnections.length > 0) {
    return 'E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION'
  }
  return error instanceof E2EError ? error.code : 'E2E_TARGET_BROWSER_NAVIGATION_FAILED'
}

function hasPageRuntimeError(consoleErrors: readonly string[]): boolean {
  return consoleErrors.some((message) => message.startsWith('[pageerror] '))
}

function targetProbeApprovedRequests(
  requests: Array<{ method: 'GET' | 'HEAD'; url: string }>,
): ApprovedGatewayRequest[] {
  return requests.map((request, index) => ({
    actionId: 'TARGET-PROBE', capabilityId: 'TARGET-PROBE-NAVIGATION',
    requestId: `TARGET-PROBE-REQUEST-${index + 1}`,
    method: request.method, url: request.url, maxUses: 4,
    signedBodyDigest: digestText('target-probe-request-body/v1', ''),
    headers: [], redirectRequestIds: [], behavior: { kind: 'pass-through' },
  }))
}

/**
 * 生产可逆写能力：只解释 RuntimeWriteHttpActionSchema，不接受项目生成的 locator、脚本或裸网络函数。
 * 所有请求均由 ControlledBrowserHost 发起，并在 Gateway 内经 Signed Grant、Authority RPC 与 Lease RPC 复验。
 */
export function createProductionWriteBrowserCapability(input: {
  homeDir: string
  browserHomeDir?: string
  projectRoot: string
  installation: RuntimeInstallation
  authorityHost(): Promise<RuntimeAuthorityHost>
  secretBroker: SecretTemplateBroker
  writeProduction: RuntimeWriteProductionCapability
}): RuntimeWriteExecutorCapability {
  const browserInstallation = async () => await resolveRuntimeBrowserInstallation(input)
  return authorizeRuntimeWriteExecutor(async ({ snapshot, attemptId, caseId, actionId }) => {
    if (snapshot === undefined) throw writeWiringError('E2E_RUNTIME_WRITE_SNAPSHOT_REQUIRED')
    const runtimeSnapshot = snapshot
    const writeAttempt = runtimeSnapshot.writeAttempts?.[attemptId]
    if (writeAttempt === undefined || writeAttempt.state !== 'prepared') {
      throw writeWiringError('E2E_RUNTIME_WRITE_ATTEMPT_NOT_PREPARED')
    }
    const ownedResourceLifecycle = createRuntimeWriteOwnedResourceLifecycle(
      input.writeProduction, writeAttempt.ownerMarker,
    )
    const projection = projectRuntimeWriteSnapshot(runtimeSnapshot)
    if (projection.caseId !== caseId || projection.actionId !== actionId) {
      throw writeWiringError('E2E_RUNTIME_WRITE_PROJECTED_ACTION_MISMATCH')
    }
    const authorityHost = await input.authorityHost()
    const activated = await activateRuntimeGrant(authorityHost, projection.grant)
    const authority = activated.consumeConnection((consumed) =>
      createAuthorityExecutionRpcClients({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const maintenance = activated.consumeConnection((consumed) =>
      createAuthorityMaintenanceRpcClient({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))

    const requests = [
      projection.action.writeRequest,
      projection.action.effectProbe,
      projection.cleanupPlan.runtimeHttpCleanup.request,
      projection.cleanupPlan.runtimeHttpCleanup.verificationProbe,
    ] as const
    let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
    let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let operationError: unknown
    try {
      return await withRenderedRequestBodies(runtimeSnapshot.runId, requests, input.secretBroker, async (bodies) => {
        const intents = [...projection.capability.requests].sort((left, right) => left.expectedOrder - right.expectedOrder)
        const resolvedTemplatePayloadDigests = Object.fromEntries(intents.flatMap((intent, index) =>
          intent.payload.kind === 'template'
            ? [[intent.intentId, digestBinaryHttpPayload(bodies[index]!)] as const] : []))
        const approvedRequests = requests.map((request, index) => {
          const intent = intents[index]!
          const body = 'body' in request ? request.body : { kind: 'no-body' as const }
          return {
            actionId, capabilityId: projection.capability.capabilityId,
            requestId: request.requestId, method: request.method, url: request.url, maxUses: 1,
            signedBodyDigest: digestText('runtime-http-signed-payload/v1', canonicalizeJson(intent.payload)),
            headers: request.headers, redirectRequestIds: [], channel: 'http' as const,
            ...(body.kind === 'segments' ? {
              resolvedBodyDigest: digestText('gateway-request-body/v1', bodies[index]!.toString('base64url')),
              contentType: body.contentType,
            } : {}),
            behavior: { kind: 'pass-through' as const },
          }
        })
        let gatewayAuditVerifierMaterial: Record<string, unknown> | undefined
        let executionOutcomeVerifierMaterial: Record<string, unknown> | undefined
        gateway = await startGatewayProxyHostForRuntime({
          runId: runtimeSnapshot.runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
          approvedRequests,
          ownedResource: {
            markerPath: join(
              runtimeLayout(input.homeDir).state,
              runtimeSnapshot.runId,
              'gateway',
              `session-${writeAttempt.ownerMarker.markerDigest.slice(7, 31)}.owner.json`,
            ),
            lifecycle: ownedResourceLifecycle,
          },
          policyObjects: { factory: ({ signer, recorder }) => {
            gatewayAuditVerifierMaterial = signer.exportVerifierMaterial() as unknown as Record<string, unknown>
            executionOutcomeVerifierMaterial = signer.exportExecutionOutcomeVerifierMaterial() as unknown as Record<string, unknown>
            return { writeGateways: {
              [projection.capability.capabilityId]: new ReversibleWriteGateway({
                grant: projection.grant, currentSubject: projection.grant.subject,
                capability: projection.capability, attemptId,
                attemptContext: {
                  assetId: runtimeSnapshot.assetId,
                  generationId: runtimeSnapshot.frozenArtifacts['browser-action-map']!.generationId,
                  prdRevision: projection.grant.subject.prdRevision,
                  runId: runtimeSnapshot.runId, caseId,
                },
                authority: authority.gatewayAuthority, leaseAuthority: authority.lease,
                recorder, outcomeSigner: signer, resolvedTemplatePayloadDigests,
              }),
            } }
          } },
        })
        browser = await new ControlledBrowserHost().open({
          homeDir: input.homeDir, runId: runtimeSnapshot.runId,
          installation: await browserInstallation(), gateway,
          ownedResourceLifecycle,
        })
        const rules = projectGatewayRules({ runId: runtimeSnapshot.runId, approvedRequests }).rules
        const correlations = rules.map((rule) => ({
          requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
          method: rule.method, url: rule.url, channel: 'http' as const, bodyDigest: rule.bodyDigest,
          actionId: rule.actionId, capabilityId: rule.capabilityId,
          signedBodyDigest: rule.signedBodyDigest!, redirectRequestIds: [], navigation: false, maxUses: 1,
          headers: { ...rule.requestHeaders },
        }))
        const observations = await getControlledBrowserSessionBinding(browser).executeWithCorrelations(
          correlations,
          async () => {
            const values: FixedHttpObservation[] = []
            for (let index = 0; index < requests.length; index += 1) {
              values.push(await executeFixedBrowserHttp(browser!.page, requests[index]!, bodies[index]!))
            }
            return values
          },
        )
        const matches = observations.map((observation, index) => responseMatches(observation, requests[index]!))
        const effectObservation = matches[1] ? 'applied' as const : 'unknown' as const
        const cleanupStatus = matches[2] && matches[3] ? 'verified-clean' as const : 'unknown' as const
        const resultDigest = digestText('runtime-fixed-http-write-result/v1', canonicalizeJson({
          runId: runtimeSnapshot.runId, attemptId, caseId, actionId, observations, matches,
        }))
        const targetFingerprints = [...new Set(intents.map((intent) => intent.targetFingerprint))]
        if (targetFingerprints.length !== 1) throw writeWiringError('E2E_RUNTIME_WRITE_LEASE_TARGET_AMBIGUOUS')
        const cleanupResultDigest = digestText('runtime-fixed-http-cleanup-result/v1', canonicalizeJson({
          cleanupPlanId: projection.cleanupPlan.cleanupPlanId,
          cleanupRequest: observations[2], verificationProbe: observations[3], status: cleanupStatus,
        }))
        if (cleanupStatus === 'verified-clean') await prepareRuntimeWriteCleanup(input.writeProduction, {
          projectIdentityDigest: writeAttempt.ownerMarker.projectIdentityDigest,
          runId: runtimeSnapshot.runId, attemptId, cleanupDigest: cleanupResultDigest,
          preparedAt: new Date().toISOString(),
        })
        const cleanup = await new GatewayCleanupTransport({
          gateway: authorizeGatewayCleanupTransport(async () => ({
            status: cleanupStatus, resultDigest: cleanupResultDigest,
          })),
          authority: maintenance,
        }).execute({
          runId: runtimeSnapshot.runId, actionId, cleanupPlanId: projection.cleanupPlan.cleanupPlanId,
          cleanupPlanDigest: digestCleanupPlanDefinition(projection.cleanupPlan), outcomeDigest: resultDigest,
          leaseId: projection.capability.dataLeaseId, fencingToken: projection.capability.fencingToken,
          targetFingerprint: targetFingerprints[0]!,
        })
        const status = matches.every(Boolean) && cleanup.status === 'verified-clean'
          ? 'passed' as const : 'failed' as const
        const writeEvidence = createRuntimeFixedHttpWriteEvidence({
          actionId, observations, matches, cleanupStatus: cleanup.status,
          screenshot: await new PlaywrightPageAdapter(browser!.page).screenshot(),
        })
        const terminal = await gateway!.writeLifecycle.finalizeWriteOutcome(
          projection.capability.capabilityId,
          {
            status, effectObservation, runnerResultDigest: resultDigest,
            cleanupPlanId: projection.cleanupPlan.cleanupPlanId,
            cleanup, evidenceIds: [writeEvidence.evidenceId], completedAt: new Date().toISOString(),
          },
        )
        const outcome = terminal.outcome
        const gatewayAudit = await gateway!.handle.finalize()
        if (!gatewayAuditVerifierMaterial || !executionOutcomeVerifierMaterial) {
          throw writeWiringError('E2E_RUNTIME_WRITE_VERIFIER_MATERIAL_MISSING')
        }
        const reservationReceiptDigest = terminal.authorityReceiptDigest
        return {
          caseId, actionId, status, effectObservation, resultDigest,
          gatewayCommit: {
            reservationId: outcome.reservationId, reservationReceiptDigest,
            outcomeReceiptDigest: outcome.signedDigest, committed: true as const,
          },
          cleanup,
          evidence: writeEvidence.evidence,
          finalizationFacts: {
            executionGrant: projection.grant as unknown as Record<string, unknown>,
            gatewayAudit: gatewayAudit as unknown as Record<string, unknown>,
            cleanup: cleanup as unknown as Record<string, unknown>,
            executionOutcomeReceipt: outcome as unknown as Record<string, unknown>,
            executionOutcomeVerifierMaterial,
            gatewayAuditVerifierMaterial,
            browserMeasurements: browser!.measurement as unknown as Record<string, unknown>,
            isolationMeasurements: {
              browserMeasurementDigest: browser!.measurement.browserMeasurementDigest,
              sandboxProfileDigest: browser!.measurement.sandboxProfileDigest,
              canaryProofDigest: browser!.measurement.canaryProofDigest,
              browserClosureDigest: browser!.measurement.browserClosureDigest,
              browserExecutableDigest: browser!.measurement.browserExecutableDigest,
            },
          },
        }
      })
    } catch (error) {
      operationError = error
      if (gateway !== undefined) {
        await gateway.writeLifecycle.markUnknown(
          projection.capability.capabilityId, `runtime-fixed-http-failure:${safeWriteErrorCode(error)}`,
        ).catch(() => undefined)
      }
      throw error
    } finally {
      await settleRuntimeBrowserResources(operationError, [
        ...(browser === undefined ? [] : [async () => await browser!.close()]),
        ...(gateway === undefined ? [] : [async () => await gateway!.handle.close()]),
        async () => authority.destroy(),
        async () => maintenance.destroy(),
      ])
    }
  })
}

/** Production full-playwright: real Gateway proxy plus independent program/cleanup Chromium lifecycles. */
export async function issueRuntimeFullPlaywrightExecutionFreshness(input: {
  snapshot: RuntimeRunSnapshot
  projection: RuntimeFullPlaywrightProjection
  issuer: Pick<RuntimeArtifactStoreAuthority, 'issueApprovalFreshnessReceipt'>
}): Promise<ApprovalFreshnessReceipt> {
  const preflight = BrowserPreflightFactSchema.parse(
    input.snapshot.trustedExecutionFacts['browser-preflight'],
  )
  const runBundle = ArtifactSchemaRegistry['run-bundle'].parse(
    input.snapshot.frozenArtifacts['run-bundle'],
  )
  const runBundleContent = runBundle.content as Record<string, unknown>
  const expectedCapabilities = ApprovalCapabilityRecordSchema.array().min(1).max(100_000)
    .parse(runBundleContent.signedCapabilities)
  const receipt = await input.issuer.issueApprovalFreshnessReceipt({
    grant: input.projection.grant,
    currentSubject: input.projection.grant.subject,
    expectedCapabilities,
    browserPreflight: {
      artifactDigest: digestText(
        'runtime-browser-preflight-fact/v1', canonicalizeJson(preflight),
      ),
      discoveryGrantId: preflight.discoveryGrantId,
      authorityPreflightDigest: preflight.preflightDigest,
    },
    runBundle: {
      artifactDigest: runBundle.contentDigest,
      content: runBundle.content,
    },
  })
  return ApprovalFreshnessReceiptSchema.parse(
    JSON.parse(canonicalizeJson(receipt)),
  )
}

export function createProductionFullPlaywrightBrowserCapability(input: {
  homeDir: string
  browserHomeDir?: string
  projectRoot: string
  installation: RuntimeInstallation
  authorityHost(): Promise<RuntimeAuthorityHost>
  writeProduction: RuntimeWriteProductionCapability
  freshnessAuthority: TrustedApprovalFreshnessClient
  freshnessIssuer: Pick<RuntimeArtifactStoreAuthority, 'issueApprovalFreshnessReceipt'>
  checkpointSigner: { signDigest(digest: string): ArtifactSignature }
  checkpointAuthority: {
    material: ArtifactAuthorityVerifierMaterial
    expectedPublicKeyDigest: string
  }
  secretBroker?: SecretTemplateBroker
}): RuntimeFullPlaywrightExecutorCapability {
  const browserInstallation = async () => await resolveRuntimeBrowserInstallation(input)
  return authorizeRuntimeFullPlaywrightExecutor(async ({ snapshot, attemptId, projection }) => {
    const writeAttempt = snapshot.writeAttempts?.[attemptId]
    if (writeAttempt === undefined || writeAttempt.state !== 'prepared') {
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_ATTEMPT_NOT_PREPARED')
    }
    assertRuntimeFullPlaywrightProjectionCurrent(snapshot, projection)
    const freshnessReceipt = await issueRuntimeFullPlaywrightExecutionFreshness({
      snapshot, projection, issuer: input.freshnessIssuer,
    })
    const renderedBodies = await renderRuntimeFullPlaywrightRequestBodies(
      snapshot.runId, projection.program, input.secretBroker,
    )
    try {
    const ownedResourceLifecycle = createRuntimeWriteOwnedResourceLifecycle(
      input.writeProduction, writeAttempt.ownerMarker,
    )
    const authorityHost = await input.authorityHost()
    const activated = await activateRuntimeGrant(authorityHost, projection.grant)
    let authorityPublicKeyDigest = ''
    const authority = activated.consumeConnection((consumed) => {
      authorityPublicKeyDigest = consumed.verifierMaterial.publicKeyDigest
      return createAuthorityExecutionRpcClients({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      })
    })
    const maintenance = activated.consumeConnection((consumed) =>
      createAuthorityMaintenanceRpcClient({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const freshnessAuthority = input.freshnessAuthority
    const approvedRequests = projection.program.networkRequests
      .slice().sort((left, right) => left.expectedOrder - right.expectedOrder)
      .map((request) => {
        const body = renderedBodies.get(request.intentId)
        return ({
        actionId: projection.actionId, capabilityId: projection.capability.capabilityId,
        requestId: request.intentId, method: request.method,
        url: canonicalFullPlaywrightIntentUrl(request), maxUses: request.maxRequests,
        signedBodyDigest: digestText('runtime-http-signed-payload/v1', canonicalizeJson(request.payload)),
        headers: request.headers ?? [], redirectRequestIds: [], channel: 'http' as const,
        ...(body === undefined ? {} : {
          resolvedBodyDigest: digestText('gateway-request-body/v1', body.bytes.toString('base64url')),
          contentType: body.contentType,
        }),
        behavior: { kind: 'pass-through' as const },
      }) })
    const projectedRules = projectGatewayRules({ runId: snapshot.runId, approvedRequests }).rules
    const correlations = projectedRules.map((rule) => ({
      requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
      method: rule.method, url: rule.url, channel: 'http' as const, bodyDigest: rule.bodyDigest,
      actionId: rule.actionId, capabilityId: rule.capabilityId, signedBodyDigest: rule.signedBodyDigest!,
      redirectRequestIds: [] as string[], navigation: ['GET', 'HEAD'].includes(rule.method),
      maxUses: rule.maxUses, headers: { ...rule.requestHeaders },
      ...(renderedBodies.get(rule.requestId!) === undefined ? {} : {
        body: renderedBodies.get(rule.requestId!),
      }),
    }))
    let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
    let programBrowser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let cleanupBrowser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let gatewayAuditVerifierMaterial: Record<string, unknown> | undefined
    let executionOutcomeVerifierMaterial: Record<string, unknown> | undefined
    let operationError: unknown
    let checkpointStore: RuntimeFullPlaywrightCheckpointStore | undefined
    let checkpointBindingDigest: string | undefined
    let checkpointTerminalIntentDigest: string | undefined
    let publishedGatewayAudit: Record<string, unknown> | undefined
    const captured = new Map<FullPlaywrightEvidenceStage, { screenshot: Uint8Array; dom: Uint8Array }>()
    try {
      checkpointBindingDigest = digestText('runtime-full-playwright-checkpoint-binding/v1', canonicalizeJson({
        attemptId, runId: snapshot.runId, assetId: snapshot.assetId, generationId: projection.generationId,
        prdRevision: projection.grant.subject.prdRevision, actionId: projection.actionId,
        capabilityId: projection.capability.capabilityId, programDigest: projection.program.sourceDigest,
        cleanupProgramDigest: projection.program.cleanupSourceDigest, sourceSetDigest: projection.sourceSetDigest,
        requests: projection.program.networkRequests, authorityPublicKeyDigest,
        gatewayPolicyDigest: projectGatewayRules({ runId: snapshot.runId, approvedRequests }).policyDigest,
      }))
      checkpointStore = RuntimeFullPlaywrightCheckpointStore.open({
        statePath: join(runtimeLayout(input.homeDir).state, 'full-playwright-terminal.sqlite'),
        forbiddenRoots: [input.projectRoot], signDigest: (digest) => input.checkpointSigner.signDigest(digest),
        artifactAuthority: input.checkpointAuthority,
      })
      checkpointTerminalIntentDigest = digestText('runtime-full-playwright-terminal-intent/v1', canonicalizeJson({
        attemptId, bindingDigest: checkpointBindingDigest, actionId: projection.actionId,
        capabilityId: projection.capability.capabilityId,
      }))
      const recovered = await checkpointStore.find(attemptId, checkpointBindingDigest)
      if (recovered) {
        const output = recovered.recovery.output
        const evidenceArtifacts = recovered.recovery.evidenceArtifacts
        if (output && typeof output === 'object' && !Array.isArray(output)
          && evidenceArtifacts && typeof evidenceArtifacts === 'object' && !Array.isArray(evidenceArtifacts)) {
          return await restoreRuntimeFullPlaywrightRecoveryOutput({
            stateRoot: runtimeLayout(input.homeDir).state, output: output as Record<string, unknown>,
            evidenceArtifacts: evidenceArtifacts as never,
          })
        }
        const recovery = recovered.recovery
        const material = plainRecord(recovery.material) ? recovery.material : {}
        const terminalInput = plainRecord(material.terminalInput) ? material.terminalInput : undefined
        const signedOutcome = plainRecord(material.outcome) ? material.outcome : undefined
        const reservationQuery = { attemptId, grantId: projection.grant.grantId,
          capabilityId: projection.capability.capabilityId, actionId: projection.actionId }
        const reservation = await maintenance.queryReservation(reservationQuery)
        if (reservation === undefined) throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_RECOVERY_RESERVATION_MISSING')
        const recoveryObservation = `full-playwright-checkpoint-recovery:${recovered.checkpointDigest}`
        const authorityReceiptDigest = reservation.status === 'completed' && reservation.outcomeDigest
          ? await maintenance.completeReservation(reservationQuery, reservation.outcomeDigest)
          : await maintenance.markReservationUnknown(reservationQuery, recoveryObservation)
        const lease = await maintenance.queryLease(projection.capability.dataLeaseId,
          projection.capability.fencingToken, projection.targetFingerprint)
        const cleanupFromTerminal = terminalInput && plainRecord(terminalInput.cleanup)
          ? terminalInput.cleanup : undefined
        const leaseReceiptDigest = lease.status === 'released' && cleanupFromTerminal
          && typeof cleanupFromTerminal.resultDigest === 'string'
          ? await maintenance.releaseLease({ leaseId: lease.leaseId, fencingToken: lease.fencingToken,
            targetFingerprint: projection.targetFingerprint, cleanupDigest: cleanupFromTerminal.resultDigest })
          : await maintenance.quarantineLease({ leaseId: lease.leaseId, fencingToken: lease.fencingToken,
            targetFingerprint: projection.targetFingerprint, reason: recoveryObservation })
        const completed = reservation.status === 'completed'
        const resultDigest = reservation.outcomeDigest ?? recovered.terminalIntentDigest
        const recoveredOutput: RuntimeWriteExecutionOutput = {
          caseId: projection.caseId, actionId: projection.actionId,
          status: completed && terminalInput && typeof terminalInput.status === 'string'
            ? terminalInput.status as RuntimeWriteExecutionOutput['status'] : 'failed',
          effectObservation: completed && terminalInput && typeof terminalInput.effectObservation === 'string'
            ? terminalInput.effectObservation as RuntimeWriteExecutionOutput['effectObservation'] : 'unknown',
          resultDigest,
          gatewayCommit: { reservationId: reservation.reservationId, reservationReceiptDigest: authorityReceiptDigest,
            outcomeReceiptDigest: resultDigest, committed: true },
          cleanup: completed && cleanupFromTerminal
            && typeof cleanupFromTerminal.status === 'string' && typeof cleanupFromTerminal.resultDigest === 'string'
            ? { status: cleanupFromTerminal.status as RuntimeWriteExecutionOutput['cleanup']['status'],
              resultDigest: cleanupFromTerminal.resultDigest, leaseReceiptDigest }
            : { status: 'unknown', resultDigest: digestText('runtime-full-playwright-recovery-cleanup/v1',
              canonicalizeJson({ attemptId, checkpointDigest: recovered.checkpointDigest })), leaseReceiptDigest },
          finalizationFacts: {
            executionGrant: projection.grant as unknown as Record<string, unknown>,
            gatewayAudit: plainRecord(material.publishedGateway) ? material.publishedGateway
              : { recovery: true, stage: recovery.phase, checkpointDigest: recovered.checkpointDigest,
                ...(plainRecord(material.gateway) ? { observation: material.gateway } : {}) },
            cleanup: cleanupFromTerminal ?? { status: 'unknown', leaseReceiptDigest },
            executionOutcomeReceipt: signedOutcome ?? { recovery: true, reservationId: reservation.reservationId,
              status: reservation.status, outcomeDigest: reservation.outcomeDigest ?? null },
            executionOutcomeVerifierMaterial: plainRecord(recovery.executionOutcomeVerifierMaterial)
              ? recovery.executionOutcomeVerifierMaterial : { recovery: true },
            gatewayAuditVerifierMaterial: plainRecord(recovery.gatewayAuditVerifierMaterial)
              ? recovery.gatewayAuditVerifierMaterial : { recovery: true },
            browserMeasurements: plainRecord(recovery.browserMeasurements)
              ? recovery.browserMeasurements : { recovery: true },
            isolationMeasurements: { recoveryCheckpointDigest: recovered.checkpointDigest },
          },
        }
        await checkpointStore.put({ attemptId, terminalIntentDigest: checkpointTerminalIntentDigest,
          bindingDigest: checkpointBindingDigest, terminal: completed ? 'completed' : 'unknown',
          recovery: { ...recovery, phase: completed ? 'recovered-completed' : 'recovered-unknown',
            output: recoveredOutput, authorityReceiptDigest, leaseReceiptDigest } })
        if (evidenceArtifacts && plainRecord(evidenceArtifacts)) {
          return await restoreRuntimeFullPlaywrightRecoveryOutput({ stateRoot: runtimeLayout(input.homeDir).state,
            output: recoveredOutput as unknown as Record<string, unknown>, evidenceArtifacts: evidenceArtifacts as never })
        }
        return recoveredOutput
      }
      await checkpointStore.put({ attemptId, terminalIntentDigest: checkpointTerminalIntentDigest,
        bindingDigest: checkpointBindingDigest, terminal: 'terminal-failed',
        recovery: { phase: 'prepared', actionId: projection.actionId, capabilityId: projection.capability.capabilityId,
          lease: { leaseId: projection.capability.dataLeaseId, fencingToken: projection.capability.fencingToken,
            targetFingerprint: projection.targetFingerprint }, requests: projection.program.networkRequests } })
      gateway = await startGatewayProxyHostForRuntime({
        runId: snapshot.runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
        approvedRequests,
        ownedResource: { markerPath: join(runtimeLayout(input.homeDir).state, snapshot.runId, 'gateway',
          `full-${writeAttempt.ownerMarker.markerDigest.slice(7, 31)}.owner.json`), lifecycle: ownedResourceLifecycle },
        policyObjects: { factory: ({ signer, recorder }) => {
          gatewayAuditVerifierMaterial = signer.exportVerifierMaterial() as unknown as Record<string, unknown>
          executionOutcomeVerifierMaterial = signer.exportExecutionOutcomeVerifierMaterial() as unknown as Record<string, unknown>
          return { writeGateways: { [projection.capability.capabilityId]: new ReversibleWriteGateway({
            grant: projection.grant, currentSubject: projection.grant.subject, capability: projection.capability,
            attemptId, attemptContext: { assetId: snapshot.assetId, generationId: projection.generationId,
              prdRevision: projection.grant.subject.prdRevision, runId: snapshot.runId, caseId: projection.caseId },
            authority: authority.browserLocalAuthority, leaseAuthority: authority.lease, recorder, outcomeSigner: signer,
            resolvedTemplatePayloadDigests: Object.fromEntries(projection.program.networkRequests
              .filter((request) => request.payload.kind === 'template')
              .map((request) => [request.intentId,
                digestBinaryHttpPayload(renderedBodies.get(request.intentId)!.bytes)])),
          }) } }
        } },
      })
      const installation = await browserInstallation()
      programBrowser = await new ControlledBrowserHost().open({ homeDir: input.homeDir,
        runId: `${snapshot.runId}-PROGRAM`, installation, gateway, ownedResourceLifecycle })
      cleanupBrowser = await new ControlledBrowserHost().open({ homeDir: input.homeDir,
        runId: `${snapshot.runId}-CLEANUP`, installation, gateway, ownedResourceLifecycle })
      const programRawBrowser = programBrowser.context.browser()
      const cleanupRawBrowser = cleanupBrowser.context.browser()
      if (!programRawBrowser || !cleanupRawBrowser || programRawBrowser === cleanupRawBrowser) {
        throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_BROWSER_LIFECYCLE_NOT_INDEPENDENT')
      }
      const traceStateRoot = runtimeLayout(input.homeDir).state
      const programTrace = new RuntimeFullPlaywrightTraceRecorder({ context: programBrowser.context,
        stateRoot: traceStateRoot, attemptId, lifecycle: 'program' })
      const cleanupTrace = new RuntimeFullPlaywrightTraceRecorder({ context: cleanupBrowser.context,
        stateRoot: traceStateRoot, attemptId, lifecycle: 'cleanup' })
      await Promise.all([programTrace.start(), cleanupTrace.start()])
      const state = Object.create(null) as Record<string, unknown>
      const programBindings = fullPlaywrightBindings(programRawBrowser, programBrowser.context,
        programBrowser.page, gateway, correlations, state, 'program')
      const cleanupBindings = fullPlaywrightBindings(cleanupRawBrowser, cleanupBrowser.context,
        cleanupBrowser.page, gateway, correlations, state, 'cleanup')
      const gatewaySessionId = gateway.writeLifecycle.writeExecutionSessionId(
        projection.capability.capabilityId,
      )
      const assembled = createRuntimeHostFullPlaywrightSession({
        authorityRpcPublicKeyDigest: authorityPublicKeyDigest,
        binding: { executionProfile: 'full-playwright', assetId: snapshot.assetId,
          generationId: projection.generationId, prdRevision: projection.grant.subject.prdRevision,
          runId: snapshot.runId, caseId: projection.caseId, stepId: projection.stepId,
          actionId: projection.actionId, capabilityId: projection.capability.capabilityId,
          programArtifactDigest: digestText('full-playwright-program/v1', canonicalizeJson(projection.program)),
          programDigest: projection.program.sourceDigest, cleanupProgramDigest: projection.program.cleanupSourceDigest,
          cleanupPlanDigest: digestCleanupPlanDefinition(projection.cleanupPlan),
          leaseId: projection.capability.dataLeaseId, fencingToken: projection.capability.fencingToken,
          targetFingerprint: projection.targetFingerprint,
          approvedRequestSetDigest: digestText('execution-outcome-approved-request-set/v1',
            canonicalizeJson(projection.program.networkRequests)),
          gatewayPolicyDigest: gateway.handle.measurement.policyDigest, executionSessionId: gatewaySessionId,
          sourceSetDigest: projection.sourceSetDigest,
          programBrowserSessionId: `BROWSER-PROGRAM-${randomUUID()}`,
          cleanupBrowserSessionId: `BROWSER-CLEANUP-${randomUUID()}` },
        programBindings, cleanupBindings,
        reserveCapability: async () => await gateway!.writeLifecycle.reserveWrite(
          projection.capability.capabilityId,
        ),
        capture: async (stage) => {
          if (stage === 'checkpoint') throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_PATH_REQUIRED')
          const session = stage === 'cleanup' ? cleanupBrowser! : programBrowser!
          const adapter = new PlaywrightPageAdapter(session.page)
          const screenshot = await adapter.screenshot()
          const dom = Buffer.from(await adapter.domSnapshot(), 'utf8')
          captured.set(stage, { screenshot, dom })
          const url = session.page.url()
          return [
            runtimeFullEvidence(stage, 'screenshot', screenshot), runtimeFullEvidence(stage, 'dom', dom),
            runtimeFullEvidence(stage, 'url', Buffer.from(url, 'utf8')),
            await (stage === 'cleanup' ? cleanupTrace : programTrace).capture(stage, stage === 'before'),
          ]
        },
        captureCheckpoint: async (checkpointId) => {
          const adapter = new PlaywrightPageAdapter(programBrowser!.page)
          const screenshot = await adapter.screenshot()
          const dom = Buffer.from(await adapter.domSnapshot(), 'utf8')
          const url = programBrowser!.page.url()
          return [
            runtimeFullEvidence('checkpoint', 'screenshot', screenshot, checkpointId),
            runtimeFullEvidence('checkpoint', 'dom', dom, checkpointId),
            runtimeFullEvidence('checkpoint', 'url', Buffer.from(url, 'utf8'), checkpointId),
            await programTrace.capture('checkpoint', true, checkpointId),
          ]
        },
        retireProgram: async () => await programBrowser!.close(),
        retireCleanup: async () => await cleanupBrowser!.close(),
        observeEffect: () => gateway!.writeLifecycle.writeAuditSummary(projection.capability.capabilityId).forwarded > 0
          ? 'applied' : 'proven-not-applied',
        freezeGateway: async () => {
          await gateway!.handle.freeze()
          const summary = gateway!.writeLifecycle.writeAuditSummary(projection.capability.capabilityId)
          return { executionSessionId: gatewaySessionId, policyDigest: gateway!.handle.measurement.policyDigest,
            summary: { received: summary.received, forwarded: summary.forwarded, blocked: summary.blocked,
              byIntent: { ...summary.byIntent } } }
        },
        publishGateway: async () => {
          const publication = await gateway!.handle.finalize()
          publishedGatewayAudit = publication as unknown as Record<string, unknown>
          return { auditDigest: digestText('gateway-publication-audit/v1', canonicalizeJson(publication)) }
        },
        checkpoint: async (stage, material) => {
          const recoverableEvidence = captured.get('after') ?? captured.get('cleanup') ?? captured.get('before')
          const evidenceArtifacts = recoverableEvidence === undefined ? undefined
            : await persistRuntimeFullPlaywrightRecoveryEvidence({
              stateRoot: runtimeLayout(input.homeDir).state, attemptId, evidence: recoverableEvidence,
            })
          await checkpointStore!.put({ attemptId, terminalIntentDigest: checkpointTerminalIntentDigest!,
            bindingDigest: checkpointBindingDigest!, terminal: 'terminal-failed',
            recovery: { phase: stage, material,
              ...(evidenceArtifacts === undefined ? {} : { evidenceArtifacts }),
              gatewayAuditVerifierMaterial: gatewayAuditVerifierMaterial ?? null,
              executionOutcomeVerifierMaterial: executionOutcomeVerifierMaterial ?? null,
              browserMeasurements: { program: programBrowser!.measurement, cleanup: cleanupBrowser!.measurement } } })
        },
        terminal: {
          releaseLease: async (value) => await maintenance.releaseLease(value),
          quarantineLease: async (value) => await maintenance.quarantineLease(value),
          finalizeWriteOutcome: async (value) => await gateway!.writeLifecycle.finalizeWriteOutcome(
            projection.capability.capabilityId, value,
          ),
          markWriteUnknownWithOutcome: async (value, observation) =>
            await gateway!.writeLifecycle.markUnknownWithOutcome(
              projection.capability.capabilityId, value, observation,
            ),
          markWriteUnknown: async (observation) => await gateway!.writeLifecycle.markUnknown(
            projection.capability.capabilityId, observation,
          ),
        },
      })
      const result = await getControlledBrowserSessionBinding(programBrowser).executeWithCorrelations(correlations,
        async () => await getControlledBrowserSessionBinding(cleanupBrowser!).executeWithCorrelations(correlations,
          async () => await runFullPlaywrightCase({ program: projection.program,
            cleanupPlan: projection.cleanupPlan, attemptId,
            attemptContext: { assetId: snapshot.assetId, generationId: projection.generationId,
              prdRevision: projection.grant.subject.prdRevision, runId: snapshot.runId, caseId: projection.caseId },
            authorization: { grant: projection.grant, currentSubject: projection.grant.subject,
              freshnessReceipt, freshnessAuthority, authority: authority.writeApproval },
            lease: { leaseId: projection.capability.dataLeaseId, fencingToken: projection.capability.fencingToken,
              targetFingerprint: projection.targetFingerprint, authority: authority.lease },
            runtime: assembled.runtime, session: assembled.session })))
      if (!result.reservationId || !result.cleanup || !result.finalization?.leaseReceiptDigest) {
        throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_TERMINAL_RECOVERY_REQUIRED')
      }
      const after = captured.get('after') ?? captured.get('cleanup')
      if (!after) throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_AFTER_EVIDENCE_MISSING')
      if (!publishedGatewayAudit) {
        const terminalErrors = canonicalizeJson(result.finalization?.errors ?? [])
        const safeTerminalCode = terminalErrors.match(/E2E_[A-Z0-9_]+/g)?.[0]
        if (safeTerminalCode) throw writeWiringError(safeTerminalCode)
        throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_GATEWAY_PUBLICATION_MISSING')
      }
      if (!gatewayAuditVerifierMaterial) {
        throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_GATEWAY_VERIFIER_MISSING')
      }
      if (!executionOutcomeVerifierMaterial) {
        throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_OUTCOME_VERIFIER_MISSING')
      }
      const output: RuntimeWriteExecutionOutput = { caseId: result.caseId, actionId: result.actionId,
        status: result.status === 'safety-blocked' ? 'safety-blocked' : result.status,
        effectObservation: result.effectObservation,
        resultDigest: runtimeFullPlaywrightRunnerResultDigest(result),
        oracleCheckpoints: result.oracleCheckpoints,
        gatewayCommit: { reservationId: result.reservationId,
          reservationReceiptDigest: result.finalization.authorityReceiptDigest ?? result.finalization.terminalIntentDigest,
          outcomeReceiptDigest: result.outcome?.signedDigest ?? result.resultDigest, committed: true as const },
        cleanup: result.cleanup, evidence: { screenshot: after.screenshot, dom: after.dom },
        finalizationFacts: { executionGrant: projection.grant as unknown as Record<string, unknown>,
          gatewayAudit: publishedGatewayAudit, cleanup: result.cleanup as unknown as Record<string, unknown>,
          executionOutcomeReceipt: (result.outcome ?? { terminal: result.finalization }) as unknown as Record<string, unknown>,
          executionOutcomeVerifierMaterial, gatewayAuditVerifierMaterial,
          browserMeasurements: { program: programBrowser.measurement, cleanup: cleanupBrowser.measurement },
          isolationMeasurements: { programBrowserMeasurementDigest: programBrowser.measurement.browserMeasurementDigest,
            cleanupBrowserMeasurementDigest: cleanupBrowser.measurement.browserMeasurementDigest } } }
      const { evidence: _ephemeralEvidence, ...durableOutput } = output
      const evidenceArtifacts = await persistRuntimeFullPlaywrightRecoveryEvidence({
        stateRoot: runtimeLayout(input.homeDir).state, attemptId, evidence: output.evidence!,
      })
      await checkpointStore.put({ attemptId, terminalIntentDigest: checkpointTerminalIntentDigest,
        bindingDigest: checkpointBindingDigest, terminal: result.finalization.state,
        recovery: { phase: 'completed', output: durableOutput, evidenceArtifacts,
          actualTerminalIntentDigest: result.finalization.terminalIntentDigest,
          authorityReceiptDigest: result.finalization.authorityReceiptDigest,
          leaseReceiptDigest: result.finalization.leaseReceiptDigest,
          outcomeReceiptDigest: result.finalization.outcomeReceiptDigest } })
      return output
    } catch (error) {
      operationError = error
      if (checkpointStore) {
        const code = safeWriteErrorCode(error)
        const bindingDigest = checkpointBindingDigest ?? digestText('runtime-full-playwright-failed-binding/v1', canonicalizeJson({
          attemptId, runId: snapshot.runId, actionId: projection.actionId, sourceSetDigest: projection.sourceSetDigest,
          authorityPublicKeyDigest,
        }))
        await checkpointStore.put({ attemptId,
          terminalIntentDigest: checkpointTerminalIntentDigest ?? digestText(
            'runtime-full-playwright-infrastructure-unknown/v1', canonicalizeJson({
              attemptId, actionId: projection.actionId, code })), bindingDigest, terminal: 'terminal-failed',
          recovery: { phase: 'infrastructure-unknown', code } }).catch(() => undefined)
      }
      throw error
    } finally {
      await settleRuntimeBrowserResources(operationError, [
        ...(programBrowser ? [async () => await programBrowser!.close()] : []),
        ...(cleanupBrowser ? [async () => await cleanupBrowser!.close()] : []),
        ...(gateway ? [async () => await gateway!.handle.close()] : []),
        async () => authority.destroy(), async () => maintenance.destroy(),
        ...(checkpointStore ? [async () => checkpointStore!.close()] : []),
      ])
    }
    } finally {
      for (const body of renderedBodies.values()) body.bytes.fill(0)
    }
  })
}

export function assertRuntimeFullPlaywrightProjectionCurrent(
  snapshot: RuntimeRunSnapshot,
  projection: RuntimeFullPlaywrightProjection,
): void {
  const matches = projectRuntimeFullPlaywrightCases(snapshot).filter((candidate) =>
    candidate.caseId === projection.caseId && candidate.actionId === projection.actionId)
  if (matches.length !== 1 || matches[0]!.sourceSetDigest !== projection.sourceSetDigest) {
    throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_PROJECTION_CHANGED')
  }
}

export async function renderRuntimeFullPlaywrightRequestBodies(
  runId: string,
  candidateProgram: FullPlaywrightProgram,
  broker?: SecretTemplateBroker,
): Promise<Map<string, { bytes: Buffer; contentType: string }>> {
  const program = FullPlaywrightProgramSchema.parse(candidateProgram)
  const materials = new Map((program.networkRequestBodies ?? []).map((body) => [body.intentId, body]))
  const rendered = new Map<string, { bytes: Buffer; contentType: string }>()
  try {
    for (const request of program.networkRequests.slice().sort((left, right) => left.expectedOrder - right.expectedOrder)) {
      if (request.payload.kind === 'no-body') continue
      const material = materials.get(request.intentId)
      if (material === undefined || material.kind !== request.payload.kind) {
        throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_BODY_MATERIAL_REQUIRED')
      }
      if (material.kind === 'json') {
        rendered.set(request.intentId, {
          bytes: Buffer.from(material.canonicalJson, 'utf8'), contentType: 'application/json',
        })
      } else if (material.kind === 'binary') {
        rendered.set(request.intentId, {
          bytes: Buffer.from(material.bodyBase64Url, 'base64url'), contentType: material.contentType,
        })
      } else {
        if (broker === undefined) throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_SECRET_BROKER_REQUIRED')
        await executeSecretTemplateAtBridge({ runId, template: material.segments, broker,
          dispatch: async (payload) => {
            rendered.set(request.intentId, {
              bytes: Buffer.from(payload), contentType: material.contentType,
            })
          } })
      }
    }
    return rendered
  } catch (error) {
    for (const body of rendered.values()) body.bytes.fill(0)
    throw error
  }
}

interface RuntimeFullPlaywrightRecoveryArtifactRef {
  kind: 'screenshot' | 'dom'
  relativePath: string
  byteLength: number
  digest: string
}

export async function persistRuntimeFullPlaywrightRecoveryEvidence(input: {
  stateRoot: string
  attemptId: string
  evidence: { screenshot: Uint8Array; dom: Uint8Array }
}): Promise<{ screenshot: RuntimeFullPlaywrightRecoveryArtifactRef; dom: RuntimeFullPlaywrightRecoveryArtifactRef }> {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.attemptId)) {
    throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_RECOVERY_ATTEMPT_INVALID')
  }
  const directoryName = digestText('runtime-full-playwright-recovery-directory/v1', input.attemptId).slice(7, 39)
  const relativeDirectory = join('full-playwright-recovery', directoryName)
  const directory = join(input.stateRoot, relativeDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const persist = async (kind: 'screenshot' | 'dom', bytes: Uint8Array) => {
    const relativePath = join(relativeDirectory, `${kind}.bin`)
    const path = join(input.stateRoot, relativePath)
    const digest = digestBytes(`runtime-full-playwright-recovery-${kind}/v1`, bytes)
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!nodeErrorCode(error, 'EEXIST')) throw error
      const existing = await readFile(path)
      try {
        if (existing.byteLength !== bytes.byteLength
          || digestBytes(`runtime-full-playwright-recovery-${kind}/v1`, existing) !== digest) {
          throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_RECOVERY_ARTIFACT_CONFLICT')
        }
      } finally { existing.fill(0) }
    }
    return { kind, relativePath, byteLength: bytes.byteLength, digest }
  }
  return { screenshot: await persist('screenshot', input.evidence.screenshot),
    dom: await persist('dom', input.evidence.dom) }
}

export async function restoreRuntimeFullPlaywrightRecoveryOutput(input: {
  stateRoot: string
  output: Record<string, unknown>
  evidenceArtifacts: { screenshot: RuntimeFullPlaywrightRecoveryArtifactRef; dom: RuntimeFullPlaywrightRecoveryArtifactRef }
}): Promise<RuntimeWriteExecutionOutput> {
  const load = async (kind: 'screenshot' | 'dom', maxBytes: number): Promise<Buffer> => {
    const ref = input.evidenceArtifacts[kind]
    const expectedPrefix = join('full-playwright-recovery', '')
    if (!ref || ref.kind !== kind || !ref.relativePath.startsWith(expectedPrefix)
      || ref.relativePath.includes('..') || ref.byteLength < 0 || ref.byteLength > maxBytes
      || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)) {
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_RECOVERY_ARTIFACT_REF_INVALID')
    }
    const bytes = await readFile(join(input.stateRoot, ref.relativePath))
    if (bytes.byteLength !== ref.byteLength
      || digestBytes(`runtime-full-playwright-recovery-${kind}/v1`, bytes) !== ref.digest) {
      bytes.fill(0)
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_RECOVERY_ARTIFACT_INVALID')
    }
    return bytes
  }
  const screenshot = await load('screenshot', 16 * 1024 * 1024)
  let dom: Buffer | undefined
  try {
    dom = await load('dom', 4 * 1024 * 1024)
    return { ...structuredClone(input.output), evidence: { screenshot, dom } } as unknown as RuntimeWriteExecutionOutput
  } catch (error) {
    screenshot.fill(0)
    dom?.fill(0)
    throw error
  }
}

function nodeErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === code
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalFullPlaywrightIntentUrl(intent: {
  canonicalOrigin: string; exactPath: string; query: Array<[string, string]>
}): string {
  const url = new URL(intent.exactPath, intent.canonicalOrigin)
  for (const [name, value] of intent.query) url.searchParams.append(name, value)
  return url.toString()
}

function runtimeFullEvidence(stage: FullPlaywrightEvidenceStage,
  kind: 'screenshot' | 'dom' | 'url' | 'trace', bytes: Uint8Array, checkpointId?: string) {
  const identity = checkpointId === undefined ? stage.toUpperCase() : checkpointId
  return { evidenceId: `${identity}-${kind.toUpperCase()}`, stage, kind,
    ...(checkpointId === undefined ? {} : { checkpointId }),
    byteLength: bytes.byteLength, digest: digestBytes(`runtime-evidence/${kind}/v1`, bytes) }
}

const MAX_FULL_PLAYWRIGHT_TRACE_BYTES = 256 * 1024 * 1024

/**
 * 将 Playwright 自身生成的 trace.zip 持久化到 Runtime 状态目录。
 * `before` 截止后立即开启下一段，因此 `after` 覆盖实际 program 交互；cleanup 使用独立 Context/trace。
 */
export class RuntimeFullPlaywrightTraceRecorder {
  readonly #context: Pick<BrowserContext, 'tracing'>
  readonly #stateRoot: string
  readonly #attemptId: string
  readonly #lifecycle: 'program' | 'cleanup'
  #active = false

  constructor(input: { context: Pick<BrowserContext, 'tracing'>; stateRoot: string; attemptId: string;
    lifecycle: 'program' | 'cleanup' }) {
    if (!isAbsolute(input.stateRoot) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.attemptId)) {
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_TRACE_INPUT_INVALID')
    }
    this.#context = input.context
    this.#stateRoot = input.stateRoot
    this.#attemptId = input.attemptId
    this.#lifecycle = input.lifecycle
  }

  async start(): Promise<void> {
    if (this.#active) throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_TRACE_ALREADY_ACTIVE')
    await this.#context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    await this.#context.tracing.startChunk()
    this.#active = true
  }

  async capture(stage: FullPlaywrightEvidenceStage, restart: boolean,
    checkpointId?: string): Promise<ReturnType<typeof runtimeFullEvidence>
    & { references: string[] }> {
    if (!this.#active || (this.#lifecycle === 'program' ? stage === 'cleanup' : stage !== 'cleanup')) {
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_TRACE_STAGE_INVALID')
    }
    if ((stage === 'checkpoint') !== (checkpointId !== undefined)
      || checkpointId !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(checkpointId)) {
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_TRACE_CHECKPOINT_INVALID')
    }
    const fileIdentity = checkpointId === undefined ? stage : `checkpoint-${checkpointId}`
    const relativePath = join('full-playwright-traces', this.#attemptId,
      `${this.#lifecycle}-${fileIdentity}.zip`)
    const directory = join(this.#stateRoot, 'full-playwright-traces', this.#attemptId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(this.#stateRoot, relativePath)
    await this.#context.tracing.stopChunk({ path })
    this.#active = false
    const bytes = await readFile(path)
    if (bytes.byteLength < 4 || bytes.byteLength > MAX_FULL_PLAYWRIGHT_TRACE_BYTES
      || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_TRACE_INVALID')
    }
    const evidence = runtimeFullEvidence(stage, 'trace', bytes, checkpointId)
    if (restart) {
      await this.#context.tracing.startChunk()
      this.#active = true
    } else {
      await this.#context.tracing.stop()
    }
    return { ...evidence,
      references: [`runtime-artifact://full-playwright-traces/${this.#attemptId}/${this.#lifecycle}-${fileIdentity}.zip`] }
  }
}

function fullPlaywrightBindings(browser: Browser, context: BrowserContext, page: unknown,
  gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>>,
  correlations: Array<{ requestId: string; ruleId: string; stepOrdinal: number; method: string; url: string;
    channel: 'http'; bodyDigest: string; actionId: string; capabilityId: string; signedBodyDigest: string;
    redirectRequestIds: string[]; navigation: boolean; maxUses: number; headers: Record<string, string>;
    body?: { bytes: Buffer; contentType: string } }>,
  state: Record<string, unknown>, lifecycle: 'program' | 'cleanup') {
  const controlledRequest = runtimeGatewayRequest(context.request, gateway, correlations)
  const controlledBrowser = new Proxy(browser, { get(target, property, receiver) {
    if (property === 'newContext') return async (...args: Parameters<Browser['newContext']>) => {
      const child = await target.newContext(...args)
      await installRuntimeGatewayRoute(child, gateway, correlations)
      return runtimeGatewayContext(child, gateway, correlations)
    }
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { page, context: runtimeGatewayContext(context, gateway, correlations), browser: controlledBrowser,
    request: controlledRequest, expect: playwrightExpect, testInfo: Object.freeze({ title: `Runtime ${lifecycle}` }), state }
}

function runtimeGatewayContext(context: BrowserContext,
  gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>>,
  correlations: Parameters<typeof fullPlaywrightBindings>[4]): BrowserContext {
  return new Proxy(context, { get(target, property, receiver) {
    if (property === 'request') return runtimeGatewayRequest(target.request, gateway, correlations)
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

function runtimeGatewayRequest(request: APIRequestContext,
  gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>>,
  correlations: Parameters<typeof fullPlaywrightBindings>[4]): APIRequestContext {
  return new Proxy(request, { get(target, property, receiver) {
    if (['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'].includes(String(property))) {
      return async (url: string, options: Record<string, unknown> = {}) => {
        const method = property === 'fetch' ? String(options.method ?? 'GET').toUpperCase() : String(property).toUpperCase()
        const correlation = correlations.find((candidate) => candidate.method === method && candidate.url === url)
        if (!correlation) throw writeWiringError('E2E_RUNTIME_FULL_PLAYWRIGHT_REQUEST_OUT_OF_SET')
        let response: unknown
        await gateway.browserBinding.continueCorrelatedRequest(correlation, { continueWithHeaders: async (headers) => {
          const execute = Reflect.get(target, property, receiver) as (url: string, options: unknown) => Promise<unknown>
          response = await execute.call(target, url, { ...options,
            ...(correlation.body === undefined ? {} : { data: correlation.body.bytes }),
            headers: { ...(options.headers as object ?? {}), ...headers,
              ...(correlation.body === undefined ? {} : { 'content-type': correlation.body.contentType }) } })
        } })
        return response
      }
    }
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as APIRequestContext
}

async function installRuntimeGatewayRoute(context: BrowserContext,
  gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>>,
  correlations: Parameters<typeof fullPlaywrightBindings>[4]): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const request = route.request()
    const correlation = correlations.find((candidate) => candidate.method === request.method()
      && candidate.url === request.url())
    if (!correlation) { await route.abort('blockedbyclient'); return }
    await gateway.browserBinding.continueCorrelatedRequest(correlation, {
      continueWithHeaders: async (headers) => await route.continue({
        ...(correlation.body === undefined ? {} : { postData: correlation.body.bytes }),
        headers: { ...request.headers(), ...headers,
          ...(correlation.body === undefined ? {} : { 'content-type': correlation.body.contentType }) },
      }),
    })
  })
}

/**
 * 故障注入生产装配。首发只执行 SignedInjectionGrant 中的 GET + no-body
 * 请求；固定 Browser 请求只能命中 InjectionGateway，不存在 pass-through 规则。
 */
export function createProductionInjectionBrowserCapability(input: {
  homeDir: string
  browserHomeDir?: string
  projectRoot: string
  installation: RuntimeInstallation
  authorityHost(): Promise<RuntimeAuthorityHost>
}): RuntimeInjectionExecutorCapability {
  const browserInstallation = async () => await resolveRuntimeBrowserInstallation(input)
  return authorizeRuntimeInjectionExecutor(async ({ snapshot, attemptId, caseId, actionId }) => {
    if (snapshot === undefined) throw writeWiringError('E2E_RUNTIME_INJECTION_SNAPSHOT_REQUIRED')
    const parsed = SignedGrantSchema.safeParse(
      snapshot.trustedExecutionFacts['signed-execution-grant'],
    )
    if (!parsed.success || !parsed.data.capabilities.every((item) => item.transport === 'gateway-injection')) {
      throw writeWiringError('E2E_RUNTIME_INJECTION_GRANT_REQUIRED')
    }
    const grant = parsed.data as SignedInjectionGrant
    const capabilities = grant.capabilities.filter((item) => item.caseId === caseId && item.actionId === actionId)
    if (capabilities.length !== 1 || grant.capabilities.length !== 1) {
      throw writeWiringError('E2E_RUNTIME_INJECTION_CAPABILITY_AMBIGUOUS')
    }
    const capability = capabilities[0]!
    if (capability.request.method !== 'GET'
      || capability.request.payload.kind !== 'no-body'
      || capability.expectedMatches !== 1 || capability.maxUses !== 1 || capability.expectedOrder !== 1) {
      throw writeWiringError('E2E_RUNTIME_INJECTION_REQUEST_UNSUPPORTED')
    }
    const target = new URL(capability.request.exactPath, capability.request.canonicalOrigin)
    for (const [name, value] of capability.request.query) target.searchParams.append(name, value)
    if (target.origin !== grant.subject.baseOrigin) {
      throw writeWiringError('E2E_RUNTIME_INJECTION_ORIGIN_MISMATCH')
    }
    const behavior = injectionBehavior(capability.response)
    const signedBodyDigest = digestText(
      'runtime-injection-no-body/v1', canonicalizeJson(capability.request.payload),
    )
    const approvedRequests = [{
      actionId, capabilityId: capability.capabilityId, method: capability.request.method,
      requestId: capability.request.intentId,
      signedBodyDigest,
      headers: [],
      redirectRequestIds: [],
      url: target.href, maxUses: capability.expectedMatches, behavior,
    }]
    const authorityHost = await input.authorityHost()
    const activated = await activateRuntimeGrant(authorityHost, grant)
    const authority = activated.consumeConnection((consumed) =>
      createAuthorityInjectionRpcClient({
        credential: consumed.credential,
        verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const injection = new InjectionGateway({
      stage: 'case', grant, attemptId,
      authority: {
        verify: async (candidate) => canonicalizeJson(candidate) === canonicalizeJson(grant)
          ? { allowed: true as const }
          : { allowed: false as const, code: 'E2E_INJECTION_GRANT_REBOUND', reason: 'grant rebound' },
        reserveForSubject: (value) => authority.reserveForSubject(value),
        complete: async (reservationId, outcomeDigest) => { await authority.complete(reservationId, outcomeDigest) },
        markUnknown: async (reservationId, observation) => { await authority.markUnknown(reservationId, observation) },
      },
      bootstrapIntents: [], caseReadIntents: [],
    })
    let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
    let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let operationError: unknown
    try {
      const auditSigner = LocalGatewayAuditSigner.create({
        issuer: 'e2e-runtime-injection-gateway', keyId: `injection-${actionId}`,
        instanceId: `${snapshot.runId}:injection:${actionId}`, version: input.installation.version,
      })
      gateway = await startGatewayProxyHostForRuntime({
        runId: snapshot.runId,
        mode: 'injection',
        authorityRoot: runtimeLayout(input.homeDir).authority,
        approvedRequests,
        policyObjects: { injectionGateway: injection, auditSigner },
      })
      browser = await new ControlledBrowserHost().open({
        homeDir: input.homeDir, runId: snapshot.runId,
        installation: await browserInstallation(), gateway,
      })
      const rule = projectGatewayRules({ runId: snapshot.runId, approvedRequests }).rules[0]!
      await getControlledBrowserSessionBinding(browser).executeWithCorrelations([{
        requestId: rule.requestId ?? capability.request.intentId,
        ruleId: rule.ruleId,
        stepOrdinal: rule.stepOrdinal,
        method: rule.method,
        url: rule.url,
        channel: 'http',
        bodyDigest: rule.bodyDigest,
        actionId: rule.actionId,
        capabilityId: rule.capabilityId,
        signedBodyDigest: rule.signedBodyDigest!,
        redirectRequestIds: [],
        navigation: true,
        maxUses: 1,
        headers: {},
      }], async () => {
        await browser!.page.goto(target.href, { waitUntil: 'domcontentloaded' })
      })
      const publication = await gateway.handle.finalize()
      const pageContentDigest = digestText('runtime-injection-page-content/v1', await browser.page.content())
      const evidence = {
        screenshot: Uint8Array.from(await new PlaywrightPageAdapter(browser.page).screenshot()),
        dom: Uint8Array.from(Buffer.from(canonicalizeJson({
          format: 'dom-tree/1', roots: [{ tag: 'main', text: `gateway-injection:${pageContentDigest}`,
            assertionRelevant: true }],
        }))),
      }
      const audit = injection.getAuditSummary()
      if (audit.source !== 'egress-gateway') {
        throw writeWiringError('E2E_RUNTIME_INJECTION_AUDIT_SOURCE_INVALID')
      }
      const gatewayAudit = {
        source: 'egress-gateway' as const,
        received: audit.received,
        matched: audit.matched,
        forwarded: audit.forwarded,
        blocked: audit.blocked,
        bootstrapForwarded: audit.bootstrapForwarded,
        injectionTargetForwarded: audit.injectionTargetForwarded,
        byIntent: { ...audit.byIntent },
      }
      const reservations = injection.getCompletedReservations()
      const passed = gatewayAudit.matched === 1 && gatewayAudit.injectionTargetForwarded === 0
        && gatewayAudit.forwarded === 0 && reservations.length === 1
      return {
        resultId: deriveExecutionResultId(caseId, 'gateway-injection'),
        baselineResultId: deriveExecutionResultId(caseId, 'real-environment'),
        attemptId, caseId, actionId,
        status: passed ? 'passed' : 'safety-blocked',
        resultDigest: digestText('runtime-injection-result/v1', canonicalizeJson({
          caseId, actionId, gatewayAudit, reservations,
          gatewayAuditDigest: digestText('gateway-publication-audit/v1', canonicalizeJson(publication)),
        })),
        completedReservationIds: reservations.map((item) => item.reservationId),
        gatewayAudit,
        evidence,
        finalizationFacts: {
          executionGrant: grant as unknown as Record<string, unknown>,
          gatewayAudit: publication as unknown as Record<string, unknown>,
          gatewayAuditVerifierMaterial: auditSigner.exportVerifierMaterial() as unknown as Record<string, unknown>,
          browserMeasurements: browser.measurement as unknown as Record<string, unknown>,
          isolationMeasurements: {
            browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
            sandboxProfileDigest: browser.measurement.sandboxProfileDigest,
            canaryProofDigest: browser.measurement.canaryProofDigest,
            browserClosureDigest: browser.measurement.browserClosureDigest,
            gatewaySessionMeasurementDigest: gateway.handle.measurement.gatewaySessionMeasurementDigest,
          },
        },
      }
    } catch (error) {
      operationError = error
      throw error
    } finally {
      await settleRuntimeBrowserResources(operationError, [
        ...(browser === undefined ? [] : [async () => await browser!.close()]),
        ...(gateway === undefined ? [] : [async () => await gateway!.handle.close()]),
        async () => authority.destroy(),
      ])
    }
  })
}

function injectionBehavior(
  response: SignedInjectionGrant['capabilities'][number]['response'],
): NonNullable<import('./gateway-rule-projector.js').ApprovedGatewayRequest['behavior']> {
  if (response.kind === 'connection-reset' || response.kind === 'timeout') return { kind: response.kind }
  const httpResponse = response as Extract<typeof response, { kind: 'http-response' }>
  return {
    kind: 'http-response', status: httpResponse.status,
    headers: Object.fromEntries(httpResponse.headers.map((header) => [header.name, header.value])),
    body: httpResponse.body.kind === 'utf8' ? httpResponse.body.value : '', delayMs: httpResponse.delayMs,
  }
}

interface FixedHttpObservation {
  status: number
  bodyDigest: string
}

export function createRuntimeFixedHttpWriteEvidence(input: {
  actionId: string
  observations: FixedHttpObservation[]
  matches: boolean[]
  cleanupStatus: 'verified-clean' | 'failed' | 'unknown'
  screenshot: Uint8Array
}): { evidenceId: string; evidence: { screenshot: Uint8Array; dom: Uint8Array } } {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.actionId)
    || input.observations.length !== 4 || input.matches.length !== input.observations.length
    || input.observations.some((item) => !Number.isSafeInteger(item.status) || item.status < 100 || item.status > 599
      || !/^sha256:[a-f0-9]{64}$/.test(item.bodyDigest))
    || input.matches.some((item) => typeof item !== 'boolean')
    || !['verified-clean', 'failed', 'unknown'].includes(input.cleanupStatus)
    || !(input.screenshot instanceof Uint8Array) || input.screenshot.byteLength > 16 * 1024 * 1024) {
    throw writeWiringError('E2E_RUNTIME_WRITE_EVIDENCE_INPUT_INVALID')
  }
  const dom = Buffer.from(canonicalizeJson({
    format: 'dom-tree/1',
    roots: [{
      tag: 'main', assertionRelevant: true,
      text: canonicalizeJson({
        protocol: 'runtime-fixed-http/v1', actionId: input.actionId,
        observations: input.observations, matches: input.matches, cleanupStatus: input.cleanupStatus,
      }),
    }],
  }), 'utf8')
  return {
    evidenceId: `EVIDENCE-${input.actionId}`,
    evidence: { screenshot: Uint8Array.from(input.screenshot), dom },
  }
}

async function executeFixedBrowserHttp(
  page: import('playwright').Page,
  request: RuntimeFixedHttpRequest | RuntimeHttpReadProbe,
  body: Buffer,
): Promise<FixedHttpObservation> {
  const bodyDefinition = 'body' in request ? request.body : { kind: 'no-body' as const }
  const response = await page.evaluate(async (input: {
    url: string; method: string; headers: Record<string, string>; bodyBase64Url?: string
  }) => {
    const decode = (value: string): Uint8Array => {
      const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
      return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    }
    const result = await fetch(input.url, {
      method: input.method, headers: input.headers,
      ...(input.bodyBase64Url === undefined ? {} : { body: decode(input.bodyBase64Url) as unknown as BodyInit }),
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    })
    const bytes = new Uint8Array(await result.arrayBuffer())
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('E2E_RUNTIME_HTTP_RESPONSE_SIZE_LIMIT')
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
    }
    return { status: result.status, bodyBase64: btoa(binary) }
  }, {
    url: request.url, method: request.method,
    headers: Object.fromEntries([
      ...request.headers.map((header) => [header.name, header.value] as const),
      ...(bodyDefinition.kind === 'segments' ? [['content-type', bodyDefinition.contentType] as const] : []),
    ]),
    ...(body.byteLength === 0 ? {} : { bodyBase64Url: body.toString('base64url') }),
  })
  const responseBody = Buffer.from(response.bodyBase64, 'base64')
  try { return { status: response.status, bodyDigest: digestRuntimeHttpResponseBody(responseBody) } }
  finally { responseBody.fill(0) }
}

function responseMatches(
  observation: FixedHttpObservation,
  request: RuntimeFixedHttpRequest | RuntimeHttpReadProbe,
): boolean {
  return observation.status === request.expectedStatus
    && observation.bodyDigest === request.expectedResponseBodyDigest
}

async function withRenderedRequestBodies<T>(
  runId: string,
  requests: readonly (RuntimeFixedHttpRequest | RuntimeHttpReadProbe)[],
  broker: SecretTemplateBroker,
  execute: (bodies: readonly Buffer[]) => Promise<T>,
): Promise<T> {
  const bodies: Buffer[] = []
  const visit = async (index: number): Promise<T> => {
    if (index === requests.length) return await execute(bodies)
    const request = requests[index]!
    const definition = 'body' in request ? request.body : { kind: 'no-body' as const }
    if (definition.kind === 'no-body') {
      const body = Buffer.alloc(0)
      bodies.push(body)
      try { return await visit(index + 1) } finally { bodies.pop(); body.fill(0) }
    }
    return await executeSecretTemplateAtBridge({
      runId, template: definition.segments, broker,
      dispatch: async (payload) => {
        const body = Buffer.from(payload)
        bodies.push(body)
        try { return await visit(index + 1) } finally { bodies.pop(); body.fill(0) }
      },
    })
  }
  return await visit(0)
}

function safeWriteErrorCode(error: unknown): string {
  return error instanceof E2EError ? error.code : error instanceof Error ? error.name : 'unknown'
}

function writeWiringError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}

export async function bootstrapInstalledBrowserRuntime(input: {
  homeDir: string
  installation: RuntimeInstallation
  browserInstallation: BrowserInstallation
  prepareAuthorityRoot(): Promise<void>
}): Promise<void> {
  await input.prepareAuthorityRoot()
  const runId = `RUNTIME-BOOTSTRAP-${input.installation.installationDigest.slice(-24)}`
  let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
  let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
  let primary: unknown
  let proofInput: Parameters<typeof recordRuntimeCapabilityProof>[0] | undefined
  try {
    gateway = await startGatewayProxyHostForRuntime({
      runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
      approvedRequests: [],
    })
    browser = await new ControlledBrowserHost().open({
      homeDir: input.homeDir, runId, installation: input.browserInstallation, gateway,
    })
    const publication = await gateway.handle.finalize()
    proofInput = {
      homeDir: input.homeDir,
      runtimeInstallationDigest: input.installation.installationDigest,
      gateway: {
        sessionMeasurementDigest: gateway.handle.measurement.gatewaySessionMeasurementDigest,
        policyDigest: gateway.handle.measurement.policyDigest,
        auditDigest: digestText('gateway-publication-audit/v1', canonicalizeJson(publication)),
      },
      isolation: {
        browserMeasurementDigest: browser.measurement.browserMeasurementDigest,
        sandboxProfileDigest: browser.measurement.sandboxProfileDigest,
        canaryProofDigest: browser.measurement.canaryProofDigest,
        browserClosureDigest: browser.measurement.browserClosureDigest,
        browserExecutableDigest: browser.measurement.browserExecutableDigest,
      },
      verifiedAt: new Date().toISOString(),
    }
  } catch (error) { primary = error }
  try {
    await settleRuntimeBrowserResources(primary, [
      ...(browser === undefined ? [] : [async () => await browser!.close()]),
      ...(gateway === undefined ? [] : [async () => await gateway!.handle.close()]),
    ])
  } catch (cleanup) { throw cleanup }
  if (primary !== undefined) throw primary
  if (proofInput === undefined) throw new E2EError({
    code: 'E2E_RUNTIME_BOOTSTRAP_PROOF_MISSING', category: 'safety',
    message: 'Browser bootstrap 未生成 capability proof 输入', retryable: false,
  })
  await recordRuntimeCapabilityProof(proofInput)
}

export async function settleRuntimeBrowserResources(
  primary: unknown,
  cleanups: Array<() => void | Promise<void>>,
): Promise<void> {
  const settled = await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()))
  const failures = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    .map((item) => item.reason)
  if (failures.length === 0) return
  throw new E2EError({
    code: 'E2E_RUNTIME_CLEANUP_FAILED', category: 'safety',
    message: 'E2E_RUNTIME_CLEANUP_FAILED: Browser/Gateway/Authority client 清理失败',
    retryable: false,
    cause: new AggregateError(primary === undefined ? failures : [primary, ...failures]),
  })
}

export async function settleRuntimeBrowserResourcesThenRecordProof(
  primary: unknown,
  cleanups: Array<() => void | Promise<void>>,
  proofInput: Parameters<typeof recordRuntimeCapabilityProof>[0] | undefined,
  recordProof: typeof recordRuntimeCapabilityProof = recordRuntimeCapabilityProof,
  bindProof: (homeDir: string, proof: RuntimeCapabilityProof) => Promise<void>
    = bindRuntimeCapabilityProofToBrowserSelection,
): Promise<void> {
  await settleRuntimeBrowserResources(primary, cleanups)
  if (primary === undefined && proofInput !== undefined) {
    const proof = await recordProof(proofInput)
    await bindProof(proofInput.homeDir, proof)
  }
}

export async function bindRuntimeCapabilityProofToBrowserSelection(
  homeDir: string,
  proof: RuntimeCapabilityProof,
): Promise<void> {
  const selection = await readBrowserSelection(homeDir).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (selection === undefined) return
  if (selection.runtimeInstallationDigest !== proof.runtimeInstallationDigest
    || selection.executableDigest !== proof.isolation.browserExecutableDigest) {
    throw browserCapabilityProofMismatch()
  }
  await writeBrowserSelection(homeDir, {
    ...selection,
    controlledLaunchProofDigest: proof.proofDigest,
  })
}

export function consumeRpcConnectionCredential<T, C extends {
  credential: { sessionKeyBase64Url: string }
}>(connection: C, create: (connection: C) => T): T {
  try { return create(connection) }
  finally { connection.credential.sessionKeyBase64Url = '' }
}
