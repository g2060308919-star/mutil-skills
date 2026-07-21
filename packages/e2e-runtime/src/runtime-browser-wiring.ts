import {
  computeDiscoveryPreflightDigest,
  createAuthenticatedRpcHttpTransport,
  createAuthorityDiscoveryRpcClient,
  createAuthorityExecutionRpcClients,
  createAuthorityInjectionRpcClient,
  createAuthorityMaintenanceRpcClient,
  createAuthorityReadRpcClient,
} from '@mutil-skills/e2e-authority'
import { PlaywrightPageAdapter, runBrowserPreflight } from '@mutil-skills/e2e-playwright-runtime'
import {
  canonicalizeJson,
  deriveExecutionResultId,
  digestCleanupPlanDefinition,
  digestRuntimeHttpResponseBody,
  digestText,
  E2EError,
  SignedGrantSchema,
  type RuntimeFixedHttpRequest,
  type RuntimeHttpReadProbe,
  type SignedInjectionGrant,
  type SignedGrant,
  type CapabilityReservation,
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
import { projectGatewayRules } from './gateway-rule-projector.js'
import { runtimeLayout } from './runtime-layout.js'
import {
  inspectRuntimeCapabilityProof,
  recordRuntimeCapabilityProof,
  type RuntimeCapabilityProof,
} from './runtime-capability-proof.js'
import { runtimeApprovalExecutionBinding, type RuntimeAuthorityHost } from './authority-host.js'
import type { RuntimeInstallation } from './runtime-discovery.js'
import { authorizeRuntimePreflight, type RuntimePreflightCapability } from './runtime-preflight.js'
import {
  TrustedActionRunner,
  authorizeRuntimeReadExecutor,
  projectRuntimeReadGatewayAudit,
  authorizeRuntimeInjectionExecutor,
  authorizeRuntimeWriteExecutor,
  type RuntimeInjectionExecutorCapability,
  type RuntimeReadExecutorCapability,
  type RuntimeWriteExecutorCapability,
} from './trusted-action-runner.js'
import { projectRuntimeWriteSnapshot } from './runtime-write-projector.js'
import { executeSecretTemplateAtBridge, type SecretTemplateBroker } from './secret-template.js'
import { GatewayCleanupTransport, authorizeGatewayCleanupTransport } from './gateway-cleanup-transport.js'
import {
  createRuntimeWriteOwnedResourceLifecycle,
  prepareRuntimeWriteCleanup,
  type RuntimeWriteProductionCapability,
} from './runtime-write-production.js'
import { join } from 'node:path'

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
    const navigation = grant.capabilities.filter((capability) => capability.operation === 'local-navigation')
    if (navigation.length !== 1) throw new Error('E2E_RUNTIME_DISCOVERY_CAPABILITY_AMBIGUOUS')
    const capability = navigation[0]!
    const authorityHost = await input.authorityHost()
    const activated = await activateRuntimeGrant(authorityHost, grant)
    const authority = activated.consumeConnection((consumed) =>
      createAuthorityDiscoveryRpcClient({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const approvedRequests = [{
      actionId: capability.actionId, capabilityId: capability.capabilityId,
      method: 'GET', url: grant.subject.expectedPageIdentity.url, maxUses: capability.maxUses,
      behavior: { kind: 'pass-through' as const },
    }]
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
      const rule = projectGatewayRules({ runId: snapshot.runId, approvedRequests }).rules[0]!
      const page = new PlaywrightPageAdapter(browser.page)
      const binding = getControlledBrowserSessionBinding(browser)
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
          goto: async (url) => await binding.executeWithCorrelation({
            ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal, method: rule.method,
            url: rule.url, channel: 'http', bodyDigest: rule.bodyDigest,
            actionId: rule.actionId, capabilityId: rule.capabilityId, headers: {},
          }, async () => await page.goto(url)),
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
        gatewayAudit: projectRuntimeReadGatewayAudit(gateway.handle.auditSummary()),
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
        const outcome = await gateway!.writeLifecycle.finalizeWriteOutcome(
          projection.capability.capabilityId,
          {
            status, effectObservation, runnerResultDigest: resultDigest,
            cleanupPlanId: projection.cleanupPlan.cleanupPlanId,
            cleanup, evidenceIds: [writeEvidence.evidenceId], completedAt: new Date().toISOString(),
          },
        )
        const gatewayAudit = await gateway!.handle.finalize()
        if (!gatewayAuditVerifierMaterial || !executionOutcomeVerifierMaterial) {
          throw writeWiringError('E2E_RUNTIME_WRITE_VERIFIER_MATERIAL_MISSING')
        }
        const reservationReceiptDigest = digestText(
          'authority-reservation-terminal-receipt/v1', canonicalizeJson({
            reservationId: outcome.reservationId,
            grantId: projection.grant.grantId,
            capabilityId: projection.capability.capabilityId,
            actionId,
            attemptId,
            terminalStatus: 'completed',
            outcomeDigest: outcome.signedDigest,
          }),
        )
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
