import {
  InjectionGateway,
  LocalGatewayAuditSigner,
  ProtocolGuard,
  ReadOnlyGateway,
  ReversibleWriteGateway,
  canonicalizeHttpRequest,
  matchPayload,
  type GatewayPublicationAudit,
  type TrustedGatewayPublicationAuditRecorder,
  type CompleteExecutionOutcomeInput,
  type GatewayTerminalOutcome,
} from '@mutil-skills/e2e-gateway'
import {
  canonicalizeJson,
  digestText,
  type GatewayAuditSummary,
} from '@mutil-skills/e2e-contracts'
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCACertificate, generateSPKIFingerprint } from 'mockttp'
import { RUNTIME_PACKAGE_VERSION } from './protocol.js'
import {
  projectGatewayRules,
  assertGatewayModePolicy,
  selectProjectedRuleForBrowser,
  type ApprovedGatewayRequest,
  type ProjectedGatewayRule,
} from './gateway-rule-projector.js'
import {
  signGatewayIpcEnvelope,
  verifyGatewayIpcEnvelope,
  type GatewayIpcEnvelope,
} from './gateway-proxy-ipc.js'
import { GatewayWriteStateCoordinator } from './gateway-write-state.js'
import { websocketUnsupportedDisposition } from './gateway-websocket-transport.js'
import { freezeDrainAndFinalize } from './gateway-finalization.js'
import { discoverTrustedPython, reverifyTrustedPython, type TrustedPythonRuntime } from './trusted-python.js'
import type { RuntimeOwnedResourceRecord } from './runtime-owned-resource-registry.js'
import type { RuntimeWriteOwnedResourceLifecycle } from './runtime-write-production.js'

const START_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5_000
// full-playwright 的 program 与 cleanup 使用独立浏览器生命周期；每个生命周期都必须
// 在同一 Gateway 上完成正反 canary。该随机内部规则不授予业务访问，仅为受控 Host
// 提供有界的隔离证明容量，避免第二个合法浏览器被一次性规则误拒绝。
const MAX_BROWSER_CANARY_PROOFS = 64

export interface GatewaySessionMeasurement {
  runId: string
  policyDigest: string
  proxyEndpointDigest: string
  processEntrypointDigest: string
  canaryPolicyDigest: string
  gatewaySessionMeasurementDigest: string
}

export interface GatewayProxyProcessHandle {
  pid: number
  endpoint: string
  caCertPath: string
  caSpkiFingerprint: string
  measurement: GatewaySessionMeasurement
  auditSummary(): GatewayAuditSummary & { injected: number }
  freeze(): Promise<void>
  finalize(): Promise<GatewayPublicationAudit>
  close(): Promise<void>
}

export interface GatewayProxyPolicyObjects {
  /** 可逆写 policy 必须由 Runtime 使用 Authority execution RPC client 构造。 */
  writeGateways?: Record<string, ReversibleWriteGateway>
  /** 注入 policy 必须由 Runtime 使用 Authority execution RPC client 构造。 */
  injectionGateway?: InjectionGateway
  /** WebSocket/SSE 等协议授权由既有 ProtocolGuard 决定。 */
  protocolGuard?: ProtocolGuard
  auditSigner?: LocalGatewayAuditSigner
  factory?(input: {
    signer: LocalGatewayAuditSigner
    recorder: TrustedGatewayPublicationAuditRecorder
    policyDigest: string
  }): Omit<GatewayProxyPolicyObjects, 'auditSigner' | 'factory'>
}

export interface GatewayProxyStartOptions {
  runId: string
  mode: 'real-environment' | 'injection'
  authorityRoot: string
  approvedRequests: ApprovedGatewayRequest[]
  policyObjects?: GatewayProxyPolicyObjects
  ownedResource?: {
    markerPath: string
    lifecycle: RuntimeWriteOwnedResourceLifecycle
  }
}

interface TestControl {
  handle: GatewayProxyProcessHandle
  requestThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string; channel?: 'http' | 'beacon' | 'service-worker' },
    caCertPathOverride?: string,
  ): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }>
  openWebSocketThroughProxy(
    url: string,
    correlation: { actionId: string; capabilityId: string; authorized?: boolean },
  ): Promise<{ status: number; responseHead: string }>
  requestWithTokenHeaders(
    url: string,
    correlation: { actionId: string; capabilityId: string },
    tokenValues: string[],
  ): Promise<{ status: number; body: string }>
}

/** Runtime Browser Host 内部持有；不进入 package root exports。 */
export interface GatewayBrowserBinding {
  readonly gatewaySessionMeasurementDigest: string
  continueCorrelatedRequest(
    input: {
      url: string
      method: string
      ruleId: string
      stepOrdinal: number
      bodyDigest: string
      actionId: string
      capabilityId: string
      requestId?: string
      signedBodyDigest?: string
      channel: 'http' | 'beacon' | 'websocket'
      headers: Record<string, string>
    },
    continuation: { continueWithHeaders(headers: Record<string, string>): Promise<void> },
  ): Promise<void>
  runCanary(input: {
    browserMeasurementDigest: string
    executeThroughControlledBrowser(request: {
      url: string
      correlation?: {
        ruleId: string
        stepOrdinal: number
        method: string
        channel: 'http' | 'beacon' | 'websocket'
        bodyDigest: string
        actionId: string
        capabilityId: string
      }
    }): Promise<{ status: number }>
  }): Promise<{ approved: true; denied: true; proofDigest: string }>
}

export interface RuntimeGatewayProxyHost {
  handle: GatewayProxyProcessHandle
  browserBinding: GatewayBrowserBinding
  writeLifecycle: GatewayWriteLifecycle
}

export interface GatewayWriteLifecycle {
  reserveWrite(capabilityId: string): Promise<import('@mutil-skills/e2e-contracts').CapabilityReservation>
  writeAuditSummary(capabilityId: string): import('@mutil-skills/e2e-contracts').GatewayAuditSummary
  writeExecutionSessionId(capabilityId: string): string
  finalizeWriteOutcome(
    capabilityId: string,
    input: CompleteExecutionOutcomeInput,
  ): Promise<GatewayTerminalOutcome>
  markUnknownWithOutcome(capabilityId: string, input: CompleteExecutionOutcomeInput,
    observation: string): Promise<GatewayTerminalOutcome>
  markUnknown(capabilityId: string, observation: string): Promise<string>
}

export async function startGatewayProxyHost(options: GatewayProxyStartOptions): Promise<GatewayProxyProcessHandle> {
  return (await startGatewayProxyHostForRuntime(options)).handle
}

/** Runtime 内部装配 seam；不从 src/index.ts 导出。 */
export async function startGatewayProxyHostForRuntime(
  options: GatewayProxyStartOptions,
): Promise<RuntimeGatewayProxyHost> {
  const started = await startGatewayProxyHostInternal(options)
  return {
    handle: started.handle,
    browserBinding: started.browserBinding,
    writeLifecycle: started.writeLifecycle,
  }
}

/** 仅供未发布的 test/fixtures.ts 使用；package exports 不暴露本模块。 */
export async function startGatewayProxyHostWithTestControl(
  options: GatewayProxyStartOptions,
): Promise<TestControl & { browserBinding: GatewayBrowserBinding; writeLifecycle: GatewayWriteLifecycle }> {
  return await startGatewayProxyHostInternal(options)
}

async function startGatewayProxyHostInternal(options: GatewayProxyStartOptions): Promise<TestControl & {
  browserBinding: GatewayBrowserBinding
  writeLifecycle: GatewayWriteLifecycle
}> {
  const projection = projectGatewayRules({ runId: options.runId, approvedRequests: options.approvedRequests })
  assertGatewayModePolicy(options.mode, projection.rules)
  const canaryNonce = randomBytes(16).toString('hex')
  const canaryApprovedUrl = `http://e2e-gateway-canary.invalid/${canaryNonce}/approved`
  const canaryDeniedUrl = `http://e2e-gateway-canary.invalid/${canaryNonce}/denied`
  const canaryProjection = projectGatewayRules({
    runId: options.runId,
    approvedRequests: [{
      actionId: `CANARY-${canaryNonce}`, capabilityId: `CANARY-CAP-${canaryNonce}`,
      method: 'GET', url: canaryApprovedUrl, maxUses: MAX_BROWSER_CANARY_PROOFS,
      // 204 导航会被 Chromium 表示为 ERR_ABORTED，Playwright 因而无法取得
      // response status；固定 200 静态体才能同时证明 Browser 与 Gateway 链路。
      behavior: { kind: 'http-response', status: 200, body: 'e2e-gateway-canary' },
    }],
  })
  const canaryRule = canaryProjection.rules[0]!
  const signer = options.policyObjects?.auditSigner ?? LocalGatewayAuditSigner.create({
    issuer: 'e2e-runtime-gateway', keyId: 'gateway-v1', instanceId: options.runId,
    version: RUNTIME_PACKAGE_VERSION,
  })
  const recorder = signer.createRecorder(projection.policyDigest)
  const factoryPolicies = options.policyObjects?.factory?.({
    signer, recorder, policyDigest: projection.policyDigest,
  })
  const policies = { ...options.policyObjects, ...factoryPolicies }
  if (options.mode === 'injection' && projection.rules.length > 0) {
    if (!policies.injectionGateway) throw gatewayHostError('E2E_GATEWAY_INJECTION_POLICY_REQUIRED')
    assertInjectionProjection(policies.injectionGateway, projection.rules)
  }
  const readGateway = new ReadOnlyGateway({ stage: 'case', intents: projection.readIntents, recorder })
  const counters = { received: 0, forwarded: 0, blocked: 0, injected: 0, byIntent: {} as Record<string, number> }
  const allRules = [...projection.rules, canaryRule]
  const rulesById = new Map(allRules.map((rule) => [rule.ruleId, rule]))
  const canaryCounters = { forwarded: 0, blocked: 0 }
  const writeState = new GatewayWriteStateCoordinator()
  let publication: GatewayPublicationAudit | undefined
  let closed = false
  let accepting = true

  const entrypoint = fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? './gateway-proxy-host-process.ts' : './gateway-proxy-host-process.js',
    import.meta.url,
  ))
  const entrypointBytes = await readFile(entrypoint)
  let ca: PreparedGatewayCa
  try {
    ca = await prepareGatewayCa(options.authorityRoot)
  } catch (error) {
    entrypointBytes.fill(0)
    throw error
  }
  const gatewaySessionNonce = randomBytes(32).toString('hex')
  let ownedResource: RuntimeOwnedResourceRecord | undefined
  let ownedMarker: GatewayOwnedResourceMarker | undefined
  try {
    if (options.ownedResource !== undefined) {
      if (!isAbsolute(options.ownedResource.markerPath)) {
        throw gatewayHostError('E2E_GATEWAY_OWNER_MARKER_PATH_INVALID')
      }
      const descriptor = Object.freeze({
        schemaVersion: '1.0.0' as const,
        markerPath: options.ownedResource.markerPath,
        sessionNonce: gatewaySessionNonce,
      })
      ownedResource = await options.ownedResource.lifecycle.register('loopback-endpoint', descriptor)
      ownedMarker = {
        schemaVersion: '1.0.0', kind: 'loopback-endpoint', phase: 'prepared',
        ownerMarker: ownedResource.ownerMarker,
        descriptorDigest: ownedResource.descriptorDigest,
        sessionNonce: gatewaySessionNonce,
      }
      await writeGatewayOwnedMarker(options.ownedResource.markerPath, ownedMarker, true)
    }
  } catch (error) {
    entrypointBytes.fill(0)
    await ca.directoryHandle.close().catch(() => undefined)
    throw error
  }
  let child: ChildProcess
  try {
    await reverifyTrustedPython(ca.python)
    child = spawn(ca.python.executable, [
      ca.wrapperPath, '3', ca.identity.device, ca.identity.inode, ca.identity.realPath,
      process.execPath,
      ...(import.meta.url.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx')] : []),
      entrypoint,
    ], {
      cwd: ca.identity.realPath,
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: dirname(process.execPath) },
      stdio: ['pipe', 'ignore', 'inherit', ca.directoryHandle.fd, 'ipc'],
      serialization: 'json',
    })
  } catch (error) {
    entrypointBytes.fill(0)
    await ca.directoryHandle.close().catch(() => undefined)
    throw error
  }
  if (ownedMarker !== undefined) {
    ownedMarker = { ...ownedMarker, phase: 'spawned', pid: child.pid! }
    try { await writeGatewayOwnedMarker(options.ownedResource!.markerPath, ownedMarker) }
    catch (error) {
      entrypointBytes.fill(0)
      child.kill('SIGKILL')
      await ca.directoryHandle.close().catch(() => undefined)
      throw error
    }
  }
  try {
    await ca.directoryHandle.close()
  } catch (error) {
    entrypointBytes.fill(0)
    child.kill('SIGKILL')
    throw error
  }
  const sessionKey = randomBytes(32)
  child.stdin!.end(sessionKey)
  let terminalSettlement: Promise<void> = Promise.resolve()
  let terminalStarted = false
  const ipc = createParentIpc(child, sessionKey, async (operation, payload) => {
    if (operation === 'authorize') {
      const input = parseAuthorizePayload(payload)
      const rule = rulesById.get(input.ruleId)
      if (!rule || input.method.toUpperCase() !== rule.method || input.url !== rule.url) return { allowed: false }
      if (rule.ruleId === canaryRule.ruleId) {
        canaryCounters.forwarded += 1
        return { allowed: true }
      }
      counters.received += 1
      if (input.channel === 'websocket') {
        // Mockttp 不提供 client frame 转发前 hook；在逐帧 bridge 可用前，匹配规则但固定拒绝，
        // 且不调用 ProtocolGuard.openWebSocket，避免创建永远无法安全 complete 的 reservation。
        const disposition = websocketUnsupportedDisposition(rule.behavior.kind)
        blockTransport(recorder, counters, rule, input)
        return { allowed: disposition.selectMatchedRule }
      }
      if (rule.behavior.kind !== 'pass-through') {
        const injection = policies.injectionGateway
        if (!injection || options.mode !== 'injection') return blockTransport(recorder, counters, rule, input)
        const body = Buffer.from(input.bodyBase64Url, 'base64url')
        try {
          const completedBefore = injection.getCompletedReservations().length
          const decision = await injection.decide({
            method: input.method, url: input.url, body,
            ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
          })
          if (decision.decision !== 'inject' || !injectionDecisionMatchesRule(decision.response, rule)) {
            return blockTransport(recorder, counters, rule, input)
          }
          const completed = injection.getCompletedReservations()
          if (completed.length !== completedBefore + 1) {
            throw gatewayHostError('E2E_GATEWAY_INJECTION_RESERVATION_AUDIT_INVALID')
          }
          const reservation = completed.at(-1)!
          if (reservation.capabilityId !== rule.capabilityId || reservation.actionId !== rule.actionId
            || reservation.status !== 'completed') {
            throw gatewayHostError('E2E_GATEWAY_INJECTION_RESERVATION_AUDIT_INVALID')
          }
          recorder.recordCapabilityReservation({ reservation, consumed: true })
          return accountDecision(decision, recorder, counters, rule, input)
        } finally { body.fill(0) }
      }
      const write = policies.writeGateways?.[rule.capabilityId]
      if (['GET', 'HEAD'].includes(rule.method) && !write) {
        const decision = readGateway.decide({ method: input.method, url: input.url }, rule.actionId)
        return accountDecision(decision, recorder, counters, rule, input, true)
      }
      if (!write) return blockTransport(recorder, counters, rule, input)
      const body = Buffer.from(input.bodyBase64Url, 'base64url')
      try {
        const decision = await write.decide({ method: input.method, url: input.url, body,
          ...(input.contentType === undefined ? {} : { contentType: input.contentType }) })
        const result = accountDecision(decision, recorder, counters, rule, input, true)
        if (result.allowed) {
          writeState.observeReservation(input.requestId, rule.capabilityId, write)
          if (terminalStarted) {
            await writeState.markRequestUnknown(input.requestId, 'gateway-child-disconnected-during-reservation')
          }
        }
        return result
      } finally { body.fill(0) }
    }
    if (operation === 'default-deny') {
      const input = parseDefaultDenyPayload(payload)
      if (input.url === canaryDeniedUrl) {
        canaryCounters.blocked += 1
        return { recorded: true }
      }
      counters.received += 1
      counters.blocked += 1
      recorder.recordReadDecision({
        actionId: input.actionId && /^[A-Za-z0-9._:-]{1,256}$/.test(input.actionId)
          ? input.actionId : 'GATEWAY-DEFAULT-DENY',
        decision: 'blocked', request: { method: input.method, url: input.url },
      })
      return { recorded: true }
    }
    if (operation === 'transport-complete') {
      const input = parseTransportComplete(payload)
      writeState.observeTransport(input.requestId)
      return { completed: true }
    }
    if (operation === 'transport-unknown') {
      const input = parseTransportUnknown(payload)
      await writeState.markRequestUnknown(input.requestId, input.observation)
      return { markedUnknown: true }
    }
    throw gatewayHostError('E2E_GATEWAY_IPC_OPERATION_UNKNOWN')
  }, () => {
    if (terminalStarted) return
    terminalStarted = true
    accepting = false
    terminalSettlement = writeState.settleAllUnknown('gateway-child-disconnected-before-response')
    void terminalSettlement.catch(() => undefined)
  })

  let freezePromise: Promise<void> | undefined
  const freezeTransport = (): Promise<void> => {
    accepting = false
    freezePromise ??= ipc.call('freeze', null, STOP_TIMEOUT_MS).then(() => undefined)
    return freezePromise
  }
  let closePromise: Promise<void> | undefined
  let finalizationPromise: Promise<GatewayPublicationAudit> | undefined

  try {
    const ready = await ipc.call('start', {
      caKeyPath: 'key.pem', caCertPath: 'cert.pem', rules: allRules,
    }, START_TIMEOUT_MS)
    const endpoint = parseReadyEndpoint(ready)
    if (ownedMarker !== undefined) {
      ownedMarker = { ...ownedMarker, phase: 'listening', endpoint }
      await writeGatewayOwnedMarker(options.ownedResource!.markerPath, ownedMarker)
    }
    const measurementBase = {
      runId: options.runId,
      policyDigest: projection.policyDigest,
      proxyEndpointDigest: digestText('gateway-proxy-endpoint/v1', endpoint),
      processEntrypointDigest: digestText('gateway-process-entrypoint/v1', entrypointBytes.toString('base64url')),
      canaryPolicyDigest: canaryProjection.policyDigest,
    }
    const measurement: GatewaySessionMeasurement = {
      ...measurementBase,
      gatewaySessionMeasurementDigest: digestText(
        'gateway-session-measurement/v1', canonicalizeJson(measurementBase),
      ),
    }
    entrypointBytes.fill(0)
    const handle: GatewayProxyProcessHandle = Object.freeze({
      pid: child.pid!, endpoint, caCertPath: join(ca.identity.realPath, 'cert.pem'),
      caSpkiFingerprint: ca.spkiFingerprint, measurement,
      auditSummary: () => ({ ...counters, byIntent: { ...counters.byIntent } }),
      freeze: async () => await freezeTransport(),
      finalize: async () => {
        if (publication) return structuredClone(publication)
        finalizationPromise ??= freezeDrainAndFinalize({
          freezeAndDrain: freezeTransport,
          waitForTerminalSettlement: async () => await terminalSettlement,
          assertWritesTerminal: () => {
            if (writeState.unsettledCount !== 0) throw gatewayHostError('E2E_GATEWAY_WRITE_TERMINAL_PENDING')
          },
          signAudit: () => {
            publication = recorder.finalize()
            return publication
          },
        })
        return structuredClone(await finalizationPromise)
      },
      close: async () => {
        if (closePromise) return await closePromise
        closePromise = (async () => {
          accepting = false
          const errors: unknown[] = []
          try { await freezeTransport() } catch (error) { errors.push(error) }
          try { await terminalSettlement } catch (error) { errors.push(error) }
          try { await writeState.settleAllUnknown('gateway-child-disconnected-before-response') }
          catch (error) { errors.push(error) }
          try { await ipc.close() } catch (error) { errors.push(error) }
          if (errors.length === 0 && ownedResource !== undefined && options.ownedResource !== undefined) {
            try {
              if (!await isLoopbackEndpointClosed(endpoint)) throw gatewayHostError(
                'E2E_GATEWAY_ENDPOINT_CLOSE_UNCONFIRMED',
              )
              await assertGatewayOwnedMarker(options.ownedResource.markerPath, ownedMarker!)
              await rm(options.ownedResource.markerPath, { force: true })
              await options.ownedResource.lifecycle.complete(
                ownedResource,
                digestText('runtime-gateway-endpoint-cleanup/v1', canonicalizeJson({
                  resourceId: ownedResource.resourceId,
                  descriptorDigest: ownedResource.descriptorDigest,
                  endpoint,
                  pid: child.pid,
                  sessionNonce: gatewaySessionNonce,
                })),
              )
            } catch (error) { errors.push(error) }
          }
          closed = true
          sessionKey.fill(0)
          for (const rule of allRules) rule.actionToken = ''
          if (errors.length > 0) throw new AggregateError(errors, 'E2E_GATEWAY_CLOSE_FAILED')
        })()
        return await closePromise
      },
    })
    const browserBinding: GatewayBrowserBinding = Object.freeze({
      gatewaySessionMeasurementDigest: measurement.gatewaySessionMeasurementDigest,
      continueCorrelatedRequest: async (
        input: Parameters<GatewayBrowserBinding['continueCorrelatedRequest']>[0],
        continuation: Parameters<GatewayBrowserBinding['continueCorrelatedRequest']>[1],
      ) => {
        if (closed || !accepting) throw gatewayHostError('E2E_GATEWAY_CLOSED')
        // Browser bootstrap canary 与业务规则走完全相同的 correlation 校验；canary
        // 是内部追加到 allRules 的固定规则，不能误用仅含业务规则的 projection.rules。
        const rule = selectProjectedRuleForBrowser(allRules, input)
        const headers = { ...input.headers }
        for (const forbidden of [
          'x-mutil-e2e-action-token', 'x-mutil-e2e-action-id', 'x-mutil-e2e-capability-id', 'proxy-authorization',
        ]) {
          for (const name of Object.keys(headers)) if (name.toLowerCase() === forbidden) delete headers[name]
        }
        for (const [name, value] of Object.entries(rule.requestHeaders)) {
          for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name) delete headers[existing]
          headers[name] = value
        }
        headers['x-mutil-e2e-action-token'] = rule.actionToken
        headers['x-mutil-e2e-action-id'] = rule.actionId
        headers['x-mutil-e2e-capability-id'] = rule.capabilityId
        try {
          await continuation.continueWithHeaders(headers)
        } finally {
          for (const name of Object.keys(headers)) {
            if (name.startsWith('x-mutil-e2e-') || name === 'proxy-authorization') headers[name] = ''
          }
        }
      },
      runCanary: async (input: Parameters<GatewayBrowserBinding['runCanary']>[0]) => {
        if (!/^sha256:[a-f0-9]{64}$/.test(input.browserMeasurementDigest)) {
          throw gatewayHostError('E2E_GATEWAY_BROWSER_MEASUREMENT_INVALID')
        }
        const before = { ...canaryCounters }
        const approved = await input.executeThroughControlledBrowser({
          url: canaryApprovedUrl,
          correlation: {
            ruleId: canaryRule.ruleId, stepOrdinal: canaryRule.stepOrdinal,
            method: canaryRule.method, channel: canaryRule.channel,
            bodyDigest: canaryRule.bodyDigest,
            actionId: canaryRule.actionId, capabilityId: canaryRule.capabilityId,
          },
        })
        const afterApproved = { ...canaryCounters }
        const denied = await input.executeThroughControlledBrowser({ url: canaryDeniedUrl })
        const afterDenied = { ...canaryCounters }
        if (approved.status < 200 || approved.status >= 400 || denied.status !== 403
          || afterApproved.forwarded !== before.forwarded + 1 || afterApproved.blocked !== before.blocked
          || afterDenied.forwarded !== afterApproved.forwarded || afterDenied.blocked !== afterApproved.blocked + 1) {
          throw Object.assign(new Error(`E2E_GATEWAY_ENFORCEMENT_UNPROVEN:${canonicalizeJson({
            approvedStatus: approved.status, deniedStatus: denied.status,
            before, afterApproved, afterDenied,
          })}`), { code: 'E2E_GATEWAY_ENFORCEMENT_UNPROVEN' })
        }
        return {
          approved: true as const, denied: true as const,
          proofDigest: digestText('gateway-browser-canary-proof/v1', canonicalizeJson({
            gatewaySessionMeasurementDigest: measurement.gatewaySessionMeasurementDigest,
            browserMeasurementDigest: input.browserMeasurementDigest,
            canaryPolicyDigest: canaryProjection.policyDigest,
            counterDelta: { forwarded: 1, blocked: 1 },
          })),
        }
      },
    })
    const writeLifecycle: GatewayWriteLifecycle = Object.freeze({
      writeAuditSummary: (capabilityId: string) => writeState.auditSummary(capabilityId),
      writeExecutionSessionId: (capabilityId: string) => {
        const writeGateway = policies.writeGateways?.[capabilityId]
        if (!writeGateway) throw gatewayHostError('E2E_GATEWAY_WRITE_CAPABILITY_NOT_ACTIVE')
        return writeGateway.getExecutionSessionId()
      },
      reserveWrite: async (capabilityId: string) => {
        const gateway = policies.writeGateways?.[capabilityId]
        if (!gateway) throw gatewayHostError('E2E_GATEWAY_WRITE_CAPABILITY_NOT_ACTIVE')
        return await gateway.reserve()
      },
      finalizeWriteOutcome: async (
        capabilityId: string,
        outcome: CompleteExecutionOutcomeInput,
      ) => {
        return await writeState.finalize(capabilityId, outcome)
      },
      markUnknownWithOutcome: async (capabilityId: string, outcome: CompleteExecutionOutcomeInput,
        observation: string) =>
        await writeState.markCapabilityUnknownWithOutcome(capabilityId, outcome, observation),
      markUnknown: async (capabilityId: string, observation: string) => {
        return await writeState.markCapabilityUnknown(capabilityId, observation)
      },
    })
    return {
      handle,
      browserBinding,
      writeLifecycle,
      requestThroughProxy: async (url, correlation, caCertPathOverride) => await requestThroughProxyForTest(
        endpoint, caCertPathOverride ?? join(ca.identity.realPath, 'cert.pem'), rulesById, url, correlation,
      ),
      openWebSocketThroughProxy: async (url, correlation) => await openWebSocketThroughProxyForTest(
        endpoint, rulesById, url, correlation,
      ),
      requestWithTokenHeaders: async (url, correlation, tokenValues) => await requestWithTokenHeadersForTest(
        endpoint, rulesById, url, correlation, tokenValues,
      ),
    }
  } catch (error) {
    entrypointBytes.fill(0)
    sessionKey.fill(0)
    for (const rule of allRules) rule.actionToken = ''
    await ipc.forceClose().catch(() => undefined)
    throw error
  }
}

interface GatewayOwnedResourceMarker {
  schemaVersion: '1.0.0'
  kind: 'loopback-endpoint'
  phase: 'prepared' | 'spawned' | 'listening'
  ownerMarker: RuntimeOwnedResourceRecord['ownerMarker']
  descriptorDigest: string
  sessionNonce: string
  pid?: number
  endpoint?: string
}

async function writeGatewayOwnedMarker(
  markerPath: string,
  marker: GatewayOwnedResourceMarker,
  exclusive = false,
): Promise<void> {
  const parent = dirname(markerPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentMetadata = await lstat(parent)
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
    || (parentMetadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && parentMetadata.uid !== process.getuid())
    || await realpath(parent) !== parent) throw gatewayHostError('E2E_GATEWAY_OWNER_MARKER_PATH_INVALID')
  if (exclusive) {
    const handle = await open(markerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${canonicalizeJson(marker)}\n`)
      await handle.chmod(0o600)
      await handle.sync()
    } finally { await handle.close() }
    return
  }
  const temporary = `${markerPath}.tmp-${randomUUID()}`
  const handle = await open(temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${canonicalizeJson(marker)}\n`)
    await handle.chmod(0o600)
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, markerPath) }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
}

async function assertGatewayOwnedMarker(
  markerPath: string,
  expected: GatewayOwnedResourceMarker,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { throw gatewayHostError('E2E_GATEWAY_OWNER_MARKER_MISMATCH') }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (await handle.readFile('utf8')).trim() !== canonicalizeJson(expected)) {
      throw gatewayHostError('E2E_GATEWAY_OWNER_MARKER_MISMATCH')
    }
  } finally { await handle.close() }
}

async function isLoopbackEndpointClosed(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint)
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connectTcp({ host: url.hostname, port: Number(url.port) })
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(false) }, 500)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolvePromise(false) })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolvePromise(error.code === 'ECONNREFUSED')
    })
  })
}

function accountDecision(
  decision: { decision: string; intentId?: string; code?: string },
  recorder: TrustedGatewayPublicationAuditRecorder,
  counters: GatewayAuditSummary & { injected: number },
  rule: ProjectedGatewayRule,
  request: { method: string; url: string },
  alreadyRecorded = false,
): { allowed: boolean } {
  if (decision.decision === 'forward' || decision.decision === 'accept-websocket') {
    counters.forwarded += 1
    counters.byIntent[decision.intentId ?? rule.capabilityId] = (counters.byIntent[decision.intentId ?? rule.capabilityId] ?? 0) + 1
    if (!alreadyRecorded) recorder.recordReadDecision({ actionId: rule.actionId, decision: 'forwarded', request })
    return { allowed: true }
  }
  if (decision.decision === 'inject') {
    counters.injected += 1
    recorder.recordInjectionDecision({ actionId: rule.actionId, request })
    return { allowed: true }
  }
  counters.blocked += 1
  if (!alreadyRecorded) recorder.recordReadDecision({ actionId: rule.actionId, decision: 'blocked', request })
  return { allowed: false }
}

function blockTransport(
  recorder: TrustedGatewayPublicationAuditRecorder,
  counters: GatewayAuditSummary & { injected: number },
  rule: ProjectedGatewayRule,
  request: { method: string; url: string },
): { allowed: false } {
  counters.blocked += 1
  recorder.recordReadDecision({ actionId: rule.actionId, decision: 'blocked', request })
  return { allowed: false }
}

function injectionDecisionMatchesRule(
  response: import('@mutil-skills/e2e-contracts').CanonicalInjectionResponse,
  rule: ProjectedGatewayRule,
): boolean {
  if (response.kind === 'connection-reset' || response.kind === 'timeout') return response.kind === rule.behavior.kind
  if (rule.behavior.kind !== 'http-response') return false
  const headers = Object.fromEntries(response.headers.map((header) => [header.name, header.value]))
  const body = response.body.kind === 'utf8' ? response.body.value : ''
  return canonicalizeJson({
    status: response.status, headers, body, delayMs: response.delayMs,
  }) === canonicalizeJson({
    status: rule.behavior.status, headers: rule.behavior.headers ?? {}, body: rule.behavior.body ?? '',
    delayMs: rule.behavior.delayMs ?? 0,
  })
}

export function assertInjectionProjection(gateway: InjectionGateway, rules: ProjectedGatewayRule[]): void {
  const capabilities = gateway.getApprovedCapabilities()
  if (capabilities.length !== rules.length || gateway.getCompletedReservations().length !== 0
    || gateway.getAuditSummary().received !== 0) {
    throw gatewayHostError('E2E_GATEWAY_INJECTION_PROJECTION_MISMATCH')
  }
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index]!
    const rule = rules[index]!
    const canonical = canonicalizeHttpRequest({ method: rule.method, url: rule.url })
    const body = rule.bodyBase64Url === undefined ? Buffer.alloc(0) : Buffer.from(rule.bodyBase64Url, 'base64url')
    try {
      if (capability.expectedOrder !== index + 1 || rule.stepOrdinal !== index + 1
        || capability.capabilityId !== rule.capabilityId || capability.actionId !== rule.actionId
        || capability.expectedMatches !== rule.maxUses || capability.request.method !== canonical.method
        || capability.request.canonicalOrigin !== canonical.origin || capability.request.exactPath !== canonical.path
        || canonicalizeJson(capability.request.query) !== canonicalizeJson(canonical.query)
        || !matchPayload(capability.request.payload, {
          method: rule.method, url: rule.url, body,
          ...(rule.contentType === undefined ? {} : { contentType: rule.contentType }),
        }).allowed
        || !injectionDecisionMatchesRule(capability.response, rule)) {
        throw gatewayHostError('E2E_GATEWAY_INJECTION_PROJECTION_MISMATCH')
      }
    } finally { body.fill(0) }
  }
}

function createParentIpc(
  child: ChildProcess,
  key: Buffer,
  handleChildRequest: (operation: string, payload: unknown) => Promise<unknown>,
  onTerminal: (error: Error) => void,
): {
  call(operation: string, payload: unknown, timeoutMs?: number): Promise<unknown>
  close(): Promise<void>
  forceClose(): Promise<void>
} {
  let parentSequence = 0
  let childSequence = 0
  let terminalError: Error | undefined
  const pending = new Map<string, {
    sequence: number; operation: string; resolve(value: unknown): void; reject(error: Error): void
  }>()
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const fail = (error: Error) => {
    const first = terminalError === undefined
    terminalError ??= error
    for (const waiter of pending.values()) waiter.reject(terminalError)
    pending.clear()
    if (first) onTerminal(terminalError)
  }
  child.once('error', () => fail(gatewayHostError('E2E_GATEWAY_CHILD_EXITED')))
  child.once('exit', () => fail(gatewayHostError('E2E_GATEWAY_CHILD_EXITED')))
  child.on('message', (value) => {
    void (async () => {
      try {
        if (isRecord(value) && value.direction === 'child-response') {
          const response = verifyGatewayIpcEnvelope(value, key, { direction: 'child-response' })
          const waiter = pending.get(response.requestId)
          if (!waiter || waiter.sequence !== response.sequence) throw gatewayHostError('E2E_GATEWAY_IPC_INVALID')
          pending.delete(response.requestId)
          const payload = parseIpcResponsePayload(response.payload)
          if (!payload.ok) waiter.reject(gatewayHostError(payload.code))
          else waiter.resolve(parseChildOperationResult(waiter.operation, payload.result))
          return
        }
        const request = verifyGatewayIpcEnvelope(value, key, {
          direction: 'child-request', sequence: childSequence + 1,
        })
        childSequence = request.sequence
        try {
          const result = await handleChildRequest(request.operation, request.payload)
          child.send(signGatewayIpcEnvelope({
            schemaVersion: '1.0.0', direction: 'parent-response', requestId: request.requestId,
            sequence: request.sequence, operation: request.operation, payload: { ok: true, result },
          }, key))
        } catch (error) {
          child.send(signGatewayIpcEnvelope({
            schemaVersion: '1.0.0', direction: 'parent-response', requestId: request.requestId,
            sequence: request.sequence, operation: request.operation,
            payload: { ok: false, code: safeCode(error) },
          }, key))
        }
      } catch (error) {
        fail(error instanceof Error ? error : gatewayHostError('E2E_GATEWAY_IPC_INVALID'))
        child.kill('SIGKILL')
      }
    })()
  })
  const call = async (operation: string, payload: unknown, timeoutMs = 5_000): Promise<unknown> => {
    if (terminalError) throw terminalError
    const requestId = randomUUID()
    const sequence = ++parentSequence
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId)
        reject(gatewayHostError('E2E_GATEWAY_CHILD_TIMEOUT'))
      }, timeoutMs)
      pending.set(requestId, {
        sequence,
        operation,
        resolve(value) { clearTimeout(timeout); resolve(value) },
        reject(error) { clearTimeout(timeout); reject(error) },
      })
      child.send(signGatewayIpcEnvelope({
        schemaVersion: '1.0.0', direction: 'parent-request', requestId, sequence, operation, payload,
      }, key))
    })
  }
  const forceClose = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    if (await settlesWithin(exit, STOP_TIMEOUT_MS)) return
    child.kill('SIGKILL')
    await exit
  }
  return {
    call,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try { await call('shutdown', null, STOP_TIMEOUT_MS) }
      catch (error) {
        await forceClose().catch(() => undefined)
        if (terminalError) throw terminalError
        throw error
      }
      if (!await settlesWithin(exit, STOP_TIMEOUT_MS)) await forceClose()
    },
    forceClose,
  }
}

function parseIpcResponsePayload(value: unknown): { ok: true; result: unknown } | { ok: false; code: string } {
  if (!isRecord(value)) throw gatewayHostError('E2E_GATEWAY_IPC_RESPONSE_INVALID')
  if (value.ok === true && hasOnlyAndRequiredKeys(value, ['ok', 'result'], [])) {
    return { ok: true, result: value.result }
  }
  if (value.ok === false && hasOnlyAndRequiredKeys(value, ['code', 'ok'], [])
    && typeof value.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(value.code)) {
    return { ok: false, code: value.code }
  }
  throw gatewayHostError('E2E_GATEWAY_IPC_RESPONSE_INVALID')
}

function parseChildOperationResult(operation: string, value: unknown): unknown {
  if (operation === 'start') return { endpoint: parseReadyEndpoint(value) }
  if (operation === 'freeze' && isRecord(value) && hasOnlyAndRequiredKeys(value, ['frozen'], [])
    && value.frozen === true) return { frozen: true }
  if (operation === 'shutdown' && isRecord(value) && hasOnlyAndRequiredKeys(value, ['closed'], [])
    && value.closed === true) return { closed: true }
  throw gatewayHostError('E2E_GATEWAY_IPC_RESPONSE_INVALID')
}

async function requestThroughProxyForTest(
  endpoint: string,
  caCertPath: string,
  rules: Map<string, ProjectedGatewayRule>,
  url: string,
  correlation: { actionId: string; capabilityId: string; channel?: 'http' | 'beacon' | 'service-worker' },
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  const rule = [...rules.values()].find((candidate) => candidate.actionId === correlation.actionId
    && candidate.capabilityId === correlation.capabilityId)
  const proxy = new URL(endpoint)
  const target = new URL(url)
  if (target.protocol === 'https:') {
    const headers = {
      host: target.host,
      'x-mutil-e2e-action-id': correlation.actionId,
      'x-mutil-e2e-capability-id': correlation.capabilityId,
      ...(correlation.channel === 'service-worker' ? {} : {
        'x-mutil-e2e-action-token': rule?.actionToken ?? 'invalid',
      }),
      ...(rule?.contentType === undefined ? {} : { 'content-type': rule.contentType }),
    }
    const body = rule?.bodyBase64Url ? Buffer.from(rule.bodyBase64Url, 'base64url') : Buffer.alloc(0)
    try {
      return await requestHttpsThroughConnect(proxy, target, rule?.method ?? 'GET', headers, body, caCertPath)
    } finally { body.fill(0) }
  }
  const body = rule?.bodyBase64Url ? Buffer.from(rule.bodyBase64Url, 'base64url') : Buffer.alloc(0)
  try {
    return await new Promise((resolve, reject) => {
      const request = httpRequest({
      host: proxy.hostname, port: Number(proxy.port), method: rule?.method ?? 'GET', path: target.href,
      headers: {
        host: target.host,
        'x-mutil-e2e-action-id': correlation.actionId,
        'x-mutil-e2e-capability-id': correlation.capabilityId,
        ...(correlation.channel === 'service-worker' ? {} : {
          'x-mutil-e2e-action-token': rule?.actionToken ?? 'invalid',
        }),
        ...(body.byteLength === 0 ? {} : {
          'content-length': String(body.byteLength),
          ...(rule?.contentType === undefined ? {} : { 'content-type': rule.contentType }),
        }),
      },
    }, (response: import('node:http').IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers as Record<string, string | string[]>,
      }))
    })
      request.once('error', reject)
      if (body.byteLength > 0) request.write(body)
      request.end()
    })
  } finally { body.fill(0) }
}

async function requestHttpsThroughConnect(
  proxy: URL,
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  caCertPath: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  const ca = await readFile(caCertPath)
  try {
    return await new Promise((resolve, reject) => {
      const connect = httpRequest({
        host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: target.host,
      })
      connect.once('connect', (_response, socket) => {
        const tls = connectTls({ socket, servername: target.hostname, ca, rejectUnauthorized: true })
        const chunks: Buffer[] = []
        tls.once('secureConnect', () => {
          const allHeaders = { ...headers, ...(body.byteLength === 0 ? {} : {
            'content-length': String(body.byteLength),
          }) }
          const headerText = Object.entries(allHeaders).map(([name, value]) => `${name}: ${value}`).join('\r\n')
          tls.write(`${method} ${target.pathname}${target.search} HTTP/1.1\r\n${headerText}\r\nConnection: close\r\n\r\n`)
          if (body.byteLength > 0) tls.write(body)
        })
        tls.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        tls.once('error', reject)
        tls.once('end', () => {
          const response = Buffer.concat(chunks).toString('utf8')
          for (const chunk of chunks) chunk.fill(0)
          const [head = '', body = ''] = response.split('\r\n\r\n', 2)
          const lines = head.split('\r\n')
          const parsedHeaders: Record<string, string | string[]> = {}
          for (const line of lines.slice(1)) {
            const at = line.indexOf(':')
            if (at > 0) parsedHeaders[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
          }
          resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0), body, headers: parsedHeaders })
        })
      })
      connect.once('error', reject)
      connect.end()
    })
  } finally { ca.fill(0) }
}

async function requestWithTokenHeadersForTest(
  endpoint: string,
  rules: Map<string, ProjectedGatewayRule>,
  url: string,
  correlation: { actionId: string; capabilityId: string },
  tokenValues: string[],
): Promise<{ status: number; body: string }> {
  const proxy = new URL(endpoint)
  const target = new URL(url)
  const rule = [...rules.values()].find((candidate) => candidate.actionId === correlation.actionId
    && candidate.capabilityId === correlation.capabilityId)
  const rawHeaders = [
    `GET ${target.href} HTTP/1.1`,
    `Host: ${target.host}`,
    `x-mutil-e2e-action-id: ${correlation.actionId}`,
    `x-mutil-e2e-capability-id: ${correlation.capabilityId}`,
    ...tokenValues.map((value) => `x-mutil-e2e-action-token: ${value === '$VALID' ? rule?.actionToken ?? '' : value}`),
    'Connection: close', '', '',
  ].join('\r\n')
  const response = await exchangeRaw(proxy, rawHeaders)
  const separator = response.indexOf('\r\n\r\n')
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1] ?? 0)
  return { status, body: separator === -1 ? '' : response.slice(separator + 4) }
}

async function openWebSocketThroughProxyForTest(
  endpoint: string,
  rules: Map<string, ProjectedGatewayRule>,
  url: string,
  correlation: { actionId: string; capabilityId: string; authorized?: boolean },
): Promise<{ status: number; responseHead: string }> {
  const proxy = new URL(endpoint)
  const target = new URL(url)
  const rule = [...rules.values()].find((candidate) => candidate.actionId === correlation.actionId
    && candidate.capabilityId === correlation.capabilityId && candidate.channel === 'websocket')
  const key = randomBytes(16).toString('base64')
  const proxyTarget = new URL(target.href)
  proxyTarget.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
  const raw = [
    `GET ${proxyTarget.href} HTTP/1.1`, `Host: ${target.host}`,
    'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
    ...(correlation.authorized === false ? [] : [
      `X-Mutil-E2E-Action-Token: ${rule?.actionToken ?? 'invalid'}`,
      `X-Mutil-E2E-Action-Id: ${correlation.actionId}`,
      `X-Mutil-E2E-Capability-Id: ${correlation.capabilityId}`,
    ]),
    '', '',
  ].join('\r\n')
  const response = await exchangeRaw(proxy, raw, true)
  const head = response.split('\r\n\r\n', 1)[0] ?? response
  return { status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0), responseHead: head }
}

async function exchangeRaw(proxy: URL, request: string, stopAtHeaders = false): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connectTcp({ host: proxy.hostname, port: Number(proxy.port) })
    const chunks: Buffer[] = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      const value = Buffer.concat(chunks).toString('utf8')
      for (const chunk of chunks) chunk.fill(0)
      socket.destroy()
      resolve(value)
    }
    const timeout = setTimeout(() => finish(), 2_000)
    socket.once('error', (error) => { clearTimeout(timeout); if (!settled) { settled = true; reject(error) } })
    socket.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk))
      if (stopAtHeaders && Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) {
        clearTimeout(timeout)
        finish()
      }
    })
    socket.once('end', () => { clearTimeout(timeout); finish() })
    socket.once('connect', () => socket.write(request))
  })
}

interface PreparedGatewayCa {
  directoryHandle: FileHandle
  identity: { realPath: string; device: string; inode: string }
  spkiFingerprint: string
  python: TrustedPythonRuntime
  wrapperPath: string
}

async function prepareGatewayCa(authorityRoot: string): Promise<PreparedGatewayCa> {
  const canonicalRoot = await realpath(authorityRoot)
  const suppliedRoot = await lstat(authorityRoot)
  if (!suppliedRoot.isDirectory() || suppliedRoot.isSymbolicLink()) {
    throw gatewayHostError('E2E_GATEWAY_CA_STATE_INVALID')
  }
  const python = await discoverTrustedPython()
  const helperPath = await secureGatewayScriptPath('gateway-ca-openat.py')
  const wrapperPath = await secureGatewayScriptPath('authority-child-fchdir.py')
  let result = await runGatewayCaHelper(python, helperPath, canonicalRoot, 'read')
  if (!result.ok && result.code === 'E2E_GATEWAY_CA_NOT_FOUND') {
    const generated = await generateCACertificate({
      subject: { commonName: 'mutil-skills local E2E CA', organizationName: 'mutil-skills' },
    })
    const key = Buffer.from(generated.key, 'utf8')
    const cert = Buffer.from(generated.cert, 'utf8')
    generated.key = ''
    generated.cert = ''
    let input: Buffer | undefined
    try {
      input = Buffer.from(JSON.stringify({
        keyBase64Url: key.toString('base64url'), certBase64Url: cert.toString('base64url'),
      }))
      result = await runGatewayCaHelper(python, helperPath, canonicalRoot, 'create', input)
    } finally {
      input?.fill(0)
      key.fill(0)
      cert.fill(0)
    }
  }
  if (!result.ok) throw gatewayHostError(result.code)
  const parsed = parseGatewayCaResult(result.value, canonicalRoot)
  let directoryHandle: FileHandle | undefined
  let cert: Buffer | undefined
  try {
    directoryHandle = await open(parsed.identity.realPath,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    const descriptor = await directoryHandle.stat()
    const path = await lstat(parsed.identity.realPath)
    if (!descriptor.isDirectory() || path.isSymbolicLink() || descriptor.dev !== path.dev || descriptor.ino !== path.ino
      || descriptor.nlink < 1 || descriptor.uid !== process.getuid?.() || (descriptor.mode & 0o777) !== 0o700
      || String(descriptor.dev) !== parsed.identity.device || String(descriptor.ino) !== parsed.identity.inode) {
      throw gatewayHostError('E2E_GATEWAY_CA_STATE_INVALID')
    }
    cert = parsed.cert
    return {
      directoryHandle,
      identity: parsed.identity,
      spkiFingerprint: await generateSPKIFingerprint(cert.toString('utf8')),
      python,
      wrapperPath,
    }
  } catch (error) {
    await directoryHandle?.close()
    throw error
  } finally { cert?.fill(0) }
}

async function secureGatewayScriptPath(name: 'gateway-ca-openat.py' | 'authority-child-fchdir.py'): Promise<string> {
  const candidate = fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? `../scripts/${name}` : `../../scripts/${name}`,
    import.meta.url,
  ))
  const metadata = await lstat(candidate)
  const resolved = await realpath(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || resolved !== candidate) {
    throw gatewayHostError('E2E_GATEWAY_CA_HELPER_INVALID')
  }
  return resolved
}

async function runGatewayCaHelper(
  python: TrustedPythonRuntime,
  helperPath: string,
  authorityRoot: string,
  operation: 'read' | 'create',
  input?: Buffer,
): Promise<{ ok: true; value: unknown } | { ok: false; code: string }> {
  await reverifyTrustedPython(python)
  const child = spawn(python.executable, [helperPath, authorityRoot, operation], {
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: dirname(process.execPath) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  let stdoutSize = 0
  let stderrSize = 0
  let overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutSize += chunk.byteLength
    if (stdoutSize > 256 * 1024) { overflow = true; child.kill('SIGKILL') }
    else stdout.push(Buffer.from(chunk))
    chunk.fill(0)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrSize += chunk.byteLength
    if (stderrSize > 8 * 1024) { overflow = true; child.kill('SIGKILL') }
    chunk.fill(0)
  })
  child.stdin.end(input)
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { overflow = true; child.kill('SIGKILL') }, 10_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (exitCode) => { clearTimeout(timeout); resolve(exitCode) })
  })
  const output = Buffer.concat(stdout)
  for (const chunk of stdout) chunk.fill(0)
  try {
    if (overflow || output.byteLength === 0) return { ok: false, code: 'E2E_GATEWAY_CA_HELPER_FAILED' }
    const value = JSON.parse(output.toString('utf8')) as unknown
    if (code === 0) return { ok: true, value }
    return { ok: false, code: isRecord(value) && typeof value.code === 'string'
      ? value.code : 'E2E_GATEWAY_CA_HELPER_FAILED' }
  } catch {
    return { ok: false, code: 'E2E_GATEWAY_CA_HELPER_FAILED' }
  } finally { output.fill(0) }
}

function parseGatewayCaResult(value: unknown, authorityRoot: string): {
  identity: { realPath: string; device: string; inode: string }
  cert: Buffer
} {
  if (!isRecord(value) || value.ok !== true || value.schemaVersion !== '1.0.0'
    || Object.keys(value).sort().join('\0') !== ['certBase64Url', 'directory', 'ok', 'schemaVersion'].join('\0')
    || !isRecord(value.directory)
    || Object.keys(value.directory).sort().join('\0') !== ['device', 'inode', 'realPath'].join('\0')
    || value.directory.realPath !== join(authorityRoot, 'gateway-ca')
    || typeof value.directory.device !== 'string' || !/^\d+$/.test(value.directory.device)
    || typeof value.directory.inode !== 'string' || !/^\d+$/.test(value.directory.inode)
    || typeof value.certBase64Url !== 'string') throw gatewayHostError('E2E_GATEWAY_CA_STATE_INVALID')
  const cert = Buffer.from(value.certBase64Url, 'base64url')
  if (cert.byteLength === 0 || cert.byteLength > 64 * 1024 || cert.toString('base64url') !== value.certBase64Url) {
    cert.fill(0)
    throw gatewayHostError('E2E_GATEWAY_CA_STATE_INVALID')
  }
  return {
    identity: {
      realPath: value.directory.realPath,
      device: value.directory.device,
      inode: value.directory.inode,
    },
    cert,
  }
}

function parseReadyEndpoint(value: unknown): string {
  if (!isRecord(value) || !hasOnlyAndRequiredKeys(value, ['endpoint'], []) || typeof value.endpoint !== 'string') {
    throw gatewayHostError('E2E_GATEWAY_READY_INVALID')
  }
  let url: URL
  try { url = new URL(value.endpoint) }
  catch { throw gatewayHostError('E2E_GATEWAY_READY_INVALID') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash) throw gatewayHostError('E2E_GATEWAY_ENDPOINT_NOT_LOOPBACK')
  return value.endpoint
}

function parseAuthorizePayload(value: unknown): {
  ruleId: string; requestId: string; channel: string; method: string; url: string
  bodyBase64Url: string; contentType?: string
} {
  if (!isRecord(value)
    || !hasOnlyAndRequiredKeys(value,
      ['bodyBase64Url', 'channel', 'method', 'requestId', 'ruleId', 'url'], ['contentType'])
    || typeof value.ruleId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.ruleId)
    || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 256
    || !['http', 'beacon', 'websocket'].includes(String(value.channel))
    || typeof value.method !== 'string' || !/^[A-Z]{1,32}$/.test(value.method)
    || typeof value.url !== 'string' || value.url.length < 1 || value.url.length > 8 * 1024
    || typeof value.bodyBase64Url !== 'string' || value.bodyBase64Url.length > 1_398_104
    || (value.contentType !== undefined && (typeof value.contentType !== 'string'
      || value.contentType.length > 8 * 1024 || /[\r\n\0]/.test(value.contentType)))) {
    throw gatewayHostError('E2E_GATEWAY_AUTHORIZE_INVALID')
  }
  return value as ReturnType<typeof parseAuthorizePayload>
}

function parseDefaultDenyPayload(value: unknown): { method: string; url: string; actionId?: string } {
  if (!isRecord(value) || !hasOnlyAndRequiredKeys(value, ['method', 'url'], ['actionId', 'capabilityId'])
    || typeof value.method !== 'string' || value.method.length < 1 || value.method.length > 32
    || typeof value.url !== 'string' || value.url.length < 1 || value.url.length > 8 * 1024
    || (value.actionId !== undefined && (typeof value.actionId !== 'string' || value.actionId.length > 256))
    || (value.capabilityId !== undefined && (typeof value.capabilityId !== 'string' || value.capabilityId.length > 256))) {
    throw gatewayHostError('E2E_GATEWAY_DENY_INVALID')
  }
  return { method: value.method, url: value.url, ...(value.actionId ? { actionId: value.actionId } : {}) }
}

function parseTransportComplete(value: unknown): { requestId: string; status: number } {
  if (!isRecord(value) || !hasOnlyAndRequiredKeys(value, ['requestId', 'status'], ['ruleId'])
    || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 256
    || (value.ruleId !== undefined && (typeof value.ruleId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.ruleId)))
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) {
    throw gatewayHostError('E2E_GATEWAY_TRANSPORT_RESULT_INVALID')
  }
  return { requestId: value.requestId, status: Number(value.status) }
}

function parseTransportUnknown(value: unknown): { requestId: string; observation: string } {
  if (!isRecord(value) || !hasOnlyAndRequiredKeys(value, ['observation', 'requestId'], [])
    || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 256
    || typeof value.observation !== 'string' || value.observation.length < 1 || value.observation.length > 256) {
    throw gatewayHostError('E2E_GATEWAY_TRANSPORT_RESULT_INVALID')
  }
  return { requestId: value.requestId, observation: value.observation }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))])
}

function safeCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'E2E_GATEWAY_INTERNAL_ERROR'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyAndRequiredKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function gatewayHostError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
