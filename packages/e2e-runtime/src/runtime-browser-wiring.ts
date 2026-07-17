import {
  computeDiscoveryPreflightDigest,
  createAuthenticatedRpcHttpTransport,
  createAuthorityDiscoveryRpcClient,
  createAuthorityReadRpcClient,
} from '@mutil-skills/e2e-authority'
import { PlaywrightPageAdapter, runBrowserPreflight } from '@mutil-skills/e2e-playwright-runtime'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { ControlledBrowserHost, getControlledBrowserSessionBinding } from './browser-host.js'
import { inspectChromiumInstallation, type ChromiumInstallation } from './browser-installer.js'
import { startGatewayProxyHostForRuntime } from './gateway-proxy-host.js'
import { projectGatewayRules } from './gateway-rule-projector.js'
import { runtimeLayout } from './runtime-layout.js'
import { recordRuntimeCapabilityProof } from './runtime-capability-proof.js'
import type { RuntimeAuthorityHost } from './authority-host.js'
import type { RuntimeInstallation } from './runtime-discovery.js'
import { authorizeRuntimePreflight, type RuntimePreflightCapability } from './runtime-preflight.js'
import {
  TrustedActionRunner,
  authorizeRuntimeReadExecutor,
  type RuntimeReadExecutorCapability,
} from './trusted-action-runner.js'

export function createProductionBrowserCapabilities(input: {
  homeDir: string
  browserHomeDir?: string
  installation: RuntimeInstallation
  authorityHost(): Promise<RuntimeAuthorityHost>
}): { preflight: RuntimePreflightCapability; read: RuntimeReadExecutorCapability } {
  const browserInstallation = async () => await inspectChromiumInstallation({
    homeDir: input.browserHomeDir ?? input.homeDir, runtimeVersion: input.installation.version,
    runtimeInstallationDigest: input.installation.installationDigest,
  })
  const preflight = authorizeRuntimePreflight({
    prepare: async ({ snapshot, grant, attemptId }) => {
    const navigation = grant.capabilities.filter((capability) => capability.operation === 'local-navigation')
    if (navigation.length !== 1) throw new Error('E2E_RUNTIME_DISCOVERY_CAPABILITY_AMBIGUOUS')
    const capability = navigation[0]!
    const authorityHost = await input.authorityHost()
    await authorityHost.activateGrant({ grant, approvalBinding: grant.approvalContext })
    const connection = authorityHost.executionRpcConnection(grant.approvalContext)
    const authority = consumeRpcConnectionCredential(connection, (consumed) =>
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
    try {
      gateway = await startGatewayProxyHostForRuntime({
        runId: snapshot.runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
        approvedRequests,
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
          browserMeasurement: browser.measurement,
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
      await authorityHost.activateGrant({ grant, approvalBinding: grant.approvalContext })
      const connection = authorityHost.executionRpcConnection(grant.approvalContext)
      const authority = consumeRpcConnectionCredential(connection, (consumed) =>
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
    const navigation = currentSubject.actions.filter((candidate) => candidate.actionId === action.actionId
      && candidate.operation === 'local-navigation')
    if (navigation.length !== 1) throw new Error('E2E_RUNTIME_READ_NAVIGATION_CAPABILITY_AMBIGUOUS')
    const authorityHost = await input.authorityHost()
    await authorityHost.activateGrant({ grant, approvalBinding: grant.approvalContext })
    const connection = authorityHost.executionRpcConnection(grant.approvalContext)
    const authority = consumeRpcConnectionCredential(connection, (consumed) =>
      createAuthorityReadRpcClient({
        credential: consumed.credential, verifierMaterial: consumed.verifierMaterial,
        expectedPublicKeyDigest: consumed.verifierMaterial.publicKeyDigest,
        transport: createAuthenticatedRpcHttpTransport(consumed.endpoint),
        approvalBinding: consumed.approvalBinding,
      }))
    const approvedRequests = [{
      actionId: action.correlation.actionId, capabilityId: action.correlation.capabilityId,
      method: action.correlation.method, url: action.correlation.url,
      maxUses: navigation[0]!.maxUses,
      behavior: { kind: 'pass-through' as const },
    }]
    let gateway: Awaited<ReturnType<typeof startGatewayProxyHostForRuntime>> | undefined
    let browser: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let operationError: unknown
    let proofInput: Parameters<typeof recordRuntimeCapabilityProof>[0] | undefined
    try {
      gateway = await startGatewayProxyHostForRuntime({
        runId: snapshot.runId, mode: 'real-environment', authorityRoot: runtimeLayout(input.homeDir).authority,
        approvedRequests,
      })
      browser = await new ControlledBrowserHost().open({
        homeDir: input.homeDir, runId: snapshot.runId,
        installation: await browserInstallation(), gateway,
      })
      const executed = await new TrustedActionRunner().executeReadOnly({
        action, grant, currentSubject, authority, browser, gateway: gateway.handle, attemptId,
      })
      const publication = await gateway.handle.finalize()
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
        gatewayAudit: gateway.handle.auditSummary(),
        gatewayAuditDigest,
        ...(executed.evidence === undefined ? {} : { evidence: executed.evidence }),
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
  })
  return { preflight, read }
}

export async function bootstrapInstalledBrowserRuntime(input: {
  homeDir: string
  installation: RuntimeInstallation
  browserInstallation: ChromiumInstallation
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
): Promise<void> {
  await settleRuntimeBrowserResources(primary, cleanups)
  if (primary === undefined && proofInput !== undefined) await recordProof(proofInput)
}

export function consumeRpcConnectionCredential<T, C extends {
  credential: { sessionKeyBase64Url: string }
}>(connection: C, create: (connection: C) => T): T {
  try { return create(connection) }
  finally { connection.credential.sessionKeyBase64Url = '' }
}
