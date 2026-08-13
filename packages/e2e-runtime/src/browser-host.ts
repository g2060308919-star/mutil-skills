import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { chromium, type BrowserContext, type Page, type Request } from 'playwright'
import { mkdir, rename, rm } from 'node:fs/promises'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserInstallation } from './browser-installer.js'
import type { GatewayBrowserBinding, RuntimeGatewayProxyHost } from './gateway-proxy-host.js'
import type { RuntimeOwnedResourceRecord } from './runtime-owned-resource-registry.js'
import type { RuntimeWriteOwnedResourceLifecycle } from './runtime-write-production.js'
import {
  NodeBrowserProfileSupervisor,
  type BrowserProfileSupervisor,
  type BrowserProfileSupervisorHandle,
} from './browser-profile-supervisor.js'
import { currentProcessStartIdentity } from './runtime-install-recovery.js'
import { systemChromeClosureDigest } from './system-chrome.js'
export type { BrowserProfileSupervisor } from './browser-profile-supervisor.js'

const HOST_RESOLVER_POLICY = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
const REQUIRED_FLAGS = [
  '--enable-automation',
  '--disable-quic',
  '--disable-extensions',
  '--disable-background-networking',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  HOST_RESOLVER_POLICY,
] as const

export interface ChromiumLaunchOptionsInput {
  executablePath: string
  proxyEndpoint: string
  caSpkiFingerprint: string
  homeDir?: string
  tempDir?: string
}

export function chromiumLaunchOptions(input: ChromiumLaunchOptionsInput) {
  assertFixedLaunchInput(input)
  return {
    executablePath: input.executablePath,
    chromiumSandbox: true,
    headless: true,
    acceptDownloads: false,
    serviceWorkers: 'block' as const,
    permissions: [] as string[],
    ignoreHTTPSErrors: false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    proxy: { server: input.proxyEndpoint, bypass: '<-loopback>' },
    env: {
      HOME: input.homeDir ?? '/runtime/browser-home',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: dirname(process.execPath),
      TMPDIR: input.tempDir ?? '/runtime/browser-tmp',
    },
    args: [
      '--enable-automation',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-features=WebRtcAllowInputVolumeAdjustment,WebRtcHideLocalIpsWithMdns',
      HOST_RESOLVER_POLICY,
      `--ignore-certificate-errors-spki-list=${input.caSpkiFingerprint}`,
    ],
  }
}

export interface BrowserHostRequest {
  url: string
  method: string
  headers: Record<string, string>
  isNavigationRequest: boolean
  isMainFrame: boolean
  resourceType: string
  redirectedFromUrl?: string
  continueWithHeaders(headers: Record<string, string>): Promise<void>
  abort(): Promise<void>
}

export interface BrowserHostDriver {
  readonly page: Page
  readonly context: BrowserContext
  launch(profileDir: string, options: ReturnType<typeof chromiumLaunchOptions>): Promise<void>
  actualCommandLine(): Promise<string[]>
  installRequestInterceptor(handler: (request: BrowserHostRequest) => Promise<void>): Promise<void>
  requestThroughPage(url: string): Promise<{ status: number }>
  close(): Promise<void>
  isClosed(): boolean
}

export interface BrowserSessionMeasurement {
  browserClosureDigest: string
  browserExecutableDigest: string
  gatewaySessionMeasurementDigest: string
  launchPolicyDigest: string
  actualCommandLineDigest: string
  sandboxVerified: true
  sandboxProfileDigest: string
  canaryProofDigest: string
  browserMeasurementDigest: string
}

export interface ControlledBrowserSession {
  readonly page: Page
  readonly context: BrowserContext
  readonly measurement: BrowserSessionMeasurement
  close(): Promise<void>
}

type RequestCorrelation = Parameters<GatewayBrowserBinding['continueCorrelatedRequest']>[0]
type ActionRequestCorrelation = RequestCorrelation & {
  requestId: string
  signedBodyDigest: string
  redirectRequestIds: readonly string[]
  navigation: boolean
  maxUses: number
}

interface TrustedBrowserSessionBinding {
  runId: string
  gatewaySessionMeasurementDigest: string
  executeWithCorrelation<T>(correlation: RequestCorrelation, operation: () => Promise<T>): Promise<T>
  executeWithCorrelations<T>(correlations: readonly ActionRequestCorrelation[], operation: () => Promise<T>): Promise<T>
  executeWithoutNetwork<T>(operation: () => Promise<T>): Promise<T>
}

const controlledSessions = new WeakMap<object, TrustedBrowserSessionBinding>()

interface ActionRequestResolver {
  correlations: readonly ActionRequestCorrelation[]
  remaining: Map<string, number>
  consumed: Map<string, number>
}

function createActionRequestResolver(candidates: readonly ActionRequestCorrelation[]): ActionRequestResolver {
  const correlations = structuredClone(candidates)
  const actionIds = new Set(correlations.map((candidate) => candidate.actionId))
  const requestIds = new Set(correlations.map((candidate) => candidate.requestId))
  if (correlations.length === 0 || correlations.length > 10_000 || actionIds.size !== 1
    || requestIds.size !== correlations.length
    || correlations.some((candidate) => !/^[A-Za-z0-9._:-]{1,256}$/.test(candidate.requestId)
      || !Number.isSafeInteger(candidate.maxUses) || candidate.maxUses < 1 || candidate.maxUses > 100_000
      || !Array.isArray(candidate.redirectRequestIds)
      || candidate.redirectRequestIds.some((requestId) => !requestIds.has(requestId)))) {
    throw browserHostError('E2E_BROWSER_ACTION_RESOLVER_INVALID', 'Action request resolver 非法或跨 action')
  }
  return {
    correlations,
    remaining: new Map(correlations.map((candidate) => [candidate.requestId, candidate.maxUses])),
    consumed: new Map(correlations.map((candidate) => [candidate.requestId, 0])),
  }
}

function resolveActionRequest(
  resolver: ActionRequestResolver,
  request: BrowserHostRequest,
): ActionRequestCorrelation | undefined {
  const method = request.method.toUpperCase()
  const candidates = resolver.correlations.filter((candidate) => candidate.method === method
    && candidate.url === request.url && (resolver.remaining.get(candidate.requestId) ?? 0) > 0)
  const eligible = candidates.filter((candidate) => {
    if (request.redirectedFromUrl !== undefined) {
      return request.isNavigationRequest && resolver.correlations.some((source) =>
        source.url === request.redirectedFromUrl
        && (resolver.consumed.get(source.requestId) ?? 0) > 0
        && source.redirectRequestIds.includes(candidate.requestId))
    }
    // Playwright owns the request classification. HTTP method cannot distinguish a document GET
    // from script/style/image/fetch GETs, so correlation uses the observed navigation/resource
    // properties and the frozen exact URL instead of the caller's historical method-derived hint.
    return request.isNavigationRequest
      ? request.isMainFrame && request.resourceType === 'document'
      : request.resourceType !== 'document'
  })
  if (eligible.length === 0) return undefined
  // effect probe 与 cleanup verification 合法地复用同一 GET URL；按已签 stepOrdinal
  // 消费下一条候选，避免仅凭 method/url 产生歧义或越序。
  const nextOrdinal = Math.min(...eligible.map((candidate) => candidate.stepOrdinal))
  const next = eligible.filter((candidate) => candidate.stepOrdinal === nextOrdinal)
  if (next.length !== 1) return undefined
  const selected = next[0]!
  resolver.remaining.set(selected.requestId, resolver.remaining.get(selected.requestId)! - 1)
  resolver.consumed.set(selected.requestId, (resolver.consumed.get(selected.requestId) ?? 0) + 1)
  return selected
}

export class ControlledBrowserHost {
  constructor(
    private readonly driver: BrowserHostDriver = new PlaywrightBrowserHostDriver(),
    private readonly options: {
      closeTimeoutMs?: number
      profileSupervisor?: BrowserProfileSupervisor
    } = {},
  ) {}

  async open(input: {
    homeDir: string
    runId: string
    installation: BrowserInstallation
    gateway: Pick<RuntimeGatewayProxyHost, 'handle' | 'browserBinding'>
    ownedResourceLifecycle?: RuntimeWriteOwnedResourceLifecycle
  }): Promise<ControlledBrowserSession> {
    const browser = browserInstallationBinding(input.installation)
    if (!isAbsolute(input.homeDir)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.runId)
      || input.runId === '.' || input.runId === '..'
      || browser.runtimeInstallationDigest.length === 0
      || input.gateway.browserBinding.gatewaySessionMeasurementDigest
        !== input.gateway.handle.measurement.gatewaySessionMeasurementDigest) {
      throw browserHostError('E2E_BROWSER_HOST_INPUT_INVALID', 'Browser Host binding 非法')
    }
    const profileParent = await ensurePrivateTree(input.homeDir, [
      '.mutil-skills', 'e2e', 'state', input.runId, 'browser',
    ])
    const profileParentReal = await realpath(profileParent)
    const profileParentIdentity = await lstat(profileParentReal)
    const profileCandidate = join(profileParentReal, `profile-${randomUUID()}`)
    const descriptor = Object.freeze({
      schemaVersion: '1.0.0' as const,
      profileDir: profileCandidate,
      markerPath: join(profileCandidate, '.owner.json'),
      profileParent: Object.freeze({ canonicalPath: profileParentReal,
        device: String(profileParentIdentity.dev), inode: String(profileParentIdentity.ino) }),
    })
    const ownedResource = input.ownedResourceLifecycle === undefined ? undefined
      : await input.ownedResourceLifecycle.register('browser-profile-lock', descriptor)
    await mkdir(profileCandidate, { mode: 0o700 })
    await assertPrivateDirectory(profileCandidate)
    const profileDir = await realpath(profileCandidate)
    assertWithin(profileParentReal, profileDir, 'E2E_BROWSER_PROFILE_DIRECTORY_UNSAFE')
    const tempDir = join(profileDir, 'tmp')
    let profileMarker: Awaited<ReturnType<typeof writeOwnerMarker>> | undefined
    let supervisor: BrowserProfileSupervisorHandle | undefined
    try {
      profileMarker = await writeOwnerMarker(
        profileDir, input.runId, ownedResource, descriptor.profileParent,
      )
      await mkdir(tempDir, { mode: 0o700 })
    } catch (error) {
      let cleanupError: unknown
      try {
        await rm(profileDir, { recursive: true, force: true })
        if (ownedResource !== undefined && input.ownedResourceLifecycle !== undefined) {
          await input.ownedResourceLifecycle.complete(
            ownedResource,
            digestText('runtime-browser-profile-prelaunch-cleanup/v1', canonicalizeJson({
              resourceId: ownedResource.resourceId,
              descriptorDigest: ownedResource.descriptorDigest,
              profileDir,
            })),
          )
        }
      } catch (closeError) { cleanupError = closeError }
      if (cleanupError !== undefined) throw browserHostError(
        'E2E_BROWSER_OPEN_CLEANUP_FAILED', 'Browser profile 准备失败且未能闭合 owned resource',
        new AggregateError([error, cleanupError]),
      )
      throw error
    }
    const options = chromiumLaunchOptions({
      executablePath: browser.executablePath,
      proxyEndpoint: input.gateway.handle.endpoint,
      caSpkiFingerprint: input.gateway.handle.caSpkiFingerprint,
      homeDir: profileDir,
      tempDir,
    })
    let currentCorrelation: RequestCorrelation | undefined
    let currentResolver: ActionRequestResolver | undefined
    let interceptionFailure: unknown
    const runBrowserOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
      let result: T | undefined
      let primary: unknown
      try { result = await operation() } catch (error) { primary = error }
      const intercepted = interceptionFailure
      interceptionFailure = undefined
      if (primary !== undefined && intercepted !== undefined) {
        throw new AggregateError([primary, intercepted], 'E2E_BROWSER_INTERCEPTION_FAILED')
      }
      if (primary !== undefined) throw primary
      if (intercepted !== undefined) throw intercepted
      return result as T
    }
    let launchStarted = false
    try {
      if (ownedResource !== undefined && profileMarker !== undefined) {
        supervisor = await (this.options.profileSupervisor ?? new NodeBrowserProfileSupervisor()).start(profileDir)
        profileMarker = await replaceOwnerMarker(profileDir, profileMarker, {
          ...profileMarker, phase: 'supervising', ownerProcess: supervisor.ownerProcess,
        })
      }
      launchStarted = true
      await this.driver.launch(profileDir, options)
      if (ownedResource !== undefined && profileMarker !== undefined && supervisor !== undefined) {
        profileMarker = await replaceOwnerMarker(profileDir, profileMarker, { ...profileMarker, phase: 'launched' })
      }
      await this.driver.installRequestInterceptor(async (request) => {
        const correlation = currentResolver === undefined
          ? currentCorrelation
          : resolveActionRequest(currentResolver, request)
        if (correlation === undefined && currentResolver === undefined && currentCorrelation === undefined) {
          await request.continueWithHeaders({ ...request.headers })
          return
        }
        if (correlation === undefined || (currentResolver === undefined
          && (!request.isNavigationRequest || !request.isMainFrame || request.resourceType !== 'document'
            || request.url !== correlation.url || request.method.toUpperCase() !== correlation.method))) {
          if (currentResolver !== undefined) interceptionFailure ??= browserHostError(
            'E2E_BROWSER_UNAPPROVED_REQUEST',
            `Action 发起了未被已签请求闭包批准的网络请求：${request.method.toUpperCase()} ${request.url}`,
          )
          await request.abort()
          return
        }
        try {
          await input.gateway.browserBinding.continueCorrelatedRequest({
            ...correlation,
            url: request.url,
            method: request.method.toUpperCase(),
            headers: { ...request.headers },
          }, { continueWithHeaders: request.continueWithHeaders })
        } catch (error) {
          if (currentResolver !== undefined && typeof correlation.requestId === 'string') {
            currentResolver.remaining.set(correlation.requestId, (currentResolver.remaining.get(correlation.requestId) ?? 0) + 1)
            currentResolver.consumed.set(
              correlation.requestId, Math.max(0, (currentResolver.consumed.get(correlation.requestId) ?? 1) - 1),
            )
          }
          interceptionFailure ??= error
          try { await request.abort() } catch (abortError) {
            interceptionFailure = new AggregateError([interceptionFailure, abortError],
              'E2E_BROWSER_INTERCEPTION_ABORT_FAILED')
          }
        }
      })
      const commandLine = await this.driver.actualCommandLine()
      verifyActualCommandLine(commandLine, options, profileDir)
      const launchPolicyDigest = digestText('e2e-browser-launch-policy/v1', canonicalizeJson(options))
      const actualCommandLineDigest = digestText(
        'e2e-browser-actual-command-line/v1', canonicalizeJson(commandLine),
      )
      const preCanary = {
        browserClosureDigest: browser.browserClosureDigest,
        browserExecutableDigest: browser.browserExecutableDigest,
        gatewaySessionMeasurementDigest: input.gateway.handle.measurement.gatewaySessionMeasurementDigest,
        launchPolicyDigest,
        actualCommandLineDigest,
        sandboxVerified: true as const,
        sandboxProfileDigest: digestText('e2e-browser-sandbox-profile/v1', canonicalizeJson({
          profileDir, home: options.env.HOME, tmpdir: options.env.TMPDIR,
          chromiumSandbox: options.chromiumSandbox,
        })),
      }
      const preCanaryDigest = digestText('e2e-browser-measurement-pre-canary/v1', canonicalizeJson(preCanary))
      const canary = await input.gateway.browserBinding.runCanary({
        browserMeasurementDigest: preCanaryDigest,
        executeThroughControlledBrowser: async (request) => {
          const previous = currentCorrelation
          currentCorrelation = request.correlation === undefined ? undefined : {
            ...request.correlation, url: request.url, headers: {},
          }
          try { return await runBrowserOperation(async () => await this.driver.requestThroughPage(request.url)) }
          finally { currentCorrelation = previous }
        },
      })
      const measurementBase = { ...preCanary, canaryProofDigest: canary.proofDigest }
      const measurement: BrowserSessionMeasurement = Object.freeze({
        ...measurementBase,
        browserMeasurementDigest: digestText(
          'e2e-browser-session-measurement/v1', canonicalizeJson(measurementBase),
        ),
      })
      let closed = false
      let closePromise: Promise<void> | undefined
      const session: ControlledBrowserSession = Object.freeze({
        page: this.driver.page,
        context: this.driver.context,
        measurement,
        close: async () => {
          if (closePromise !== undefined) return await closePromise
          closed = true
          controlledSessions.delete(session)
          closePromise = this.closeAndCleanup(
            profileDir, ownedResource, input.ownedResourceLifecycle, supervisor,
          )
          return await closePromise
        },
      })
      controlledSessions.set(session, {
        runId: input.runId,
        gatewaySessionMeasurementDigest: measurement.gatewaySessionMeasurementDigest,
        executeWithCorrelation: async <T>(correlation: RequestCorrelation, operation: () => Promise<T>) => {
          if (closed || currentCorrelation !== undefined || currentResolver !== undefined) {
            throw browserHostError('E2E_BROWSER_SESSION_BUSY', 'Browser session 已关闭或存在并发 Action')
          }
          currentCorrelation = structuredClone(correlation)
          try { return await runBrowserOperation(operation) } finally { currentCorrelation = undefined }
        },
        executeWithCorrelations: async <T>(
          correlations: readonly ActionRequestCorrelation[],
          operation: () => Promise<T>,
        ) => {
          if (closed || currentCorrelation !== undefined || currentResolver !== undefined) {
            throw browserHostError('E2E_BROWSER_SESSION_BUSY', 'Browser session 已关闭或存在并发 Action')
          }
          currentResolver = createActionRequestResolver(correlations)
          try { return await runBrowserOperation(operation) } finally { currentResolver = undefined }
        },
        executeWithoutNetwork: async <T>(operation: () => Promise<T>) => {
          if (closed || currentCorrelation !== undefined || currentResolver !== undefined) {
            throw browserHostError('E2E_BROWSER_SESSION_BUSY', 'Browser session 已关闭或存在并发 Action')
          }
          // 空 resolver 表示当前 action 明确没有任何已批准网络请求；发生请求即 abort，
          // runBrowserOperation 会把 interceptor failure 同步返回调用方。
          currentResolver = { correlations: [], remaining: new Map(), consumed: new Map() }
          try { return await runBrowserOperation(operation) } finally { currentResolver = undefined }
        },
      })
      return session
    } catch (error) {
      let cleanupError: unknown
      if (launchStarted) {
        try {
          await this.closeAndCleanup(profileDir, ownedResource, input.ownedResourceLifecycle, supervisor)
        }
        catch (closeError) { cleanupError = closeError }
      } else if (this.driver.isClosed()) {
        try {
          await supervisor?.stop()
          await rm(profileDir, { recursive: true, force: true })
          if (ownedResource !== undefined && input.ownedResourceLifecycle !== undefined) {
            await input.ownedResourceLifecycle.complete(
              ownedResource,
              digestText('runtime-browser-profile-prelaunch-cleanup/v1', canonicalizeJson({
                resourceId: ownedResource.resourceId,
                descriptorDigest: ownedResource.descriptorDigest,
                profileDir,
              })),
            )
          }
        } catch (closeError) { cleanupError = closeError }
      }
      if (cleanupError !== undefined) throw browserHostError(
        'E2E_BROWSER_OPEN_CLEANUP_FAILED',
        'Browser open 失败后未能确认进程关闭；profile 已保留以避免与存活进程竞态',
        new AggregateError([error, cleanupError]),
      )
      throw error
    }
  }

  private async closeAndCleanup(
    profileDir: string,
    ownedResource?: RuntimeOwnedResourceRecord,
    lifecycle?: RuntimeWriteOwnedResourceLifecycle,
    supervisor?: BrowserProfileSupervisorHandle,
  ): Promise<void> {
    const timeoutMs = this.options.closeTimeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const closeOutcome = this.driver.close().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const outcome = await Promise.race([
      closeOutcome,
      new Promise<{ timeout: true }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ timeout: true }), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if ('timeout' in outcome) throw browserHostError(
      'E2E_BROWSER_CLOSE_TIMEOUT', 'Browser close 超时；profile 保留直到进程关闭可确认',
    )
    if (!this.driver.isClosed()) throw browserHostError(
      'E2E_BROWSER_CLOSE_UNCONFIRMED', 'Browser close 未确认进程关闭；profile 保留',
      outcome.ok ? undefined : outcome.error,
    )
    await supervisor?.stop()
    if (ownedResource !== undefined) await assertOwnedProfileForCleanup(profileDir, ownedResource)
    await rm(profileDir, { recursive: true, force: true })
    if (ownedResource !== undefined && lifecycle !== undefined) await lifecycle.complete(
      ownedResource,
      digestText('runtime-browser-profile-cleanup/v1', canonicalizeJson({
        resourceId: ownedResource.resourceId,
        descriptorDigest: ownedResource.descriptorDigest,
        profileDir,
      })),
    )
    if (!outcome.ok) throw browserHostError(
      'E2E_BROWSER_CLOSE_FAILED', 'Browser 已确认关闭，但 close 返回失败', outcome.error,
    )
  }
}

interface BrowserInstallationBinding {
  source: 'system-chrome' | 'managed-chromium'
  executablePath: string
  runtimeInstallationDigest: string
  browserClosureDigest: string
  browserExecutableDigest: string
}

function browserInstallationBinding(installation: BrowserInstallation): BrowserInstallationBinding {
  if ('manifest' in installation) {
    return {
      source: 'managed-chromium', executablePath: installation.executablePath,
      runtimeInstallationDigest: installation.manifest.runtimeInstallationDigest,
      browserClosureDigest: installation.manifest.closureDigest,
      browserExecutableDigest: installation.manifest.executableDigest,
    }
  }
  const { selection, identity } = installation
  if (selection.source.kind !== 'system-chrome' || !isAbsolute(selection.source.executablePath)
    || !/^sha256:[a-f0-9]{64}$/.test(selection.executableDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(selection.runtimeInstallationDigest)
    || !Number.isSafeInteger(identity.device) || identity.device < 0
    || !Number.isSafeInteger(identity.inode) || identity.inode <= 0
    || !Number.isSafeInteger(identity.byteLength) || identity.byteLength <= 0) {
    throw browserHostError('E2E_BROWSER_HOST_INPUT_INVALID', '系统 Chrome installation binding 非法')
  }
  return {
    source: 'system-chrome', executablePath: selection.source.executablePath,
    runtimeInstallationDigest: selection.runtimeInstallationDigest,
    browserExecutableDigest: selection.executableDigest,
    browserClosureDigest: systemChromeClosureDigest(installation),
  }
}

export function getControlledBrowserSessionBinding(
  session: ControlledBrowserSession,
): TrustedBrowserSessionBinding {
  const binding = controlledSessions.get(session)
  if (binding === undefined) throw browserHostError(
    'E2E_BROWSER_SESSION_UNTRUSTED', 'Browser session 不是本进程 ControlledBrowserHost 产生的可信 session',
  )
  return binding
}

class PlaywrightBrowserHostDriver implements BrowserHostDriver {
  #context?: BrowserContext
  #page?: Page
  #closed = true
  get context(): BrowserContext {
    if (!this.#context) throw browserHostError('E2E_BROWSER_NOT_OPEN', 'Browser context 尚未启动')
    return this.#context
  }
  get page(): Page {
    if (!this.#page) throw browserHostError('E2E_BROWSER_NOT_OPEN', 'Browser page 尚未启动')
    return this.#page
  }
  async launch(profileDir: string, options: ReturnType<typeof chromiumLaunchOptions>): Promise<void> {
    this.#closed = false
    this.#context = await chromium.launchPersistentContext(profileDir, options)
    this.#context.once('close', () => { this.#closed = true })
    this.#page = this.#context.pages()[0] ?? await this.#context.newPage()
  }
  async actualCommandLine(): Promise<string[]> {
    const session = await this.context.newCDPSession(this.page)
    try {
      const result = await session.send('Browser.getBrowserCommandLine').catch((cause) => {
        throw browserHostError('E2E_BROWSER_COMMAND_LINE_UNAVAILABLE',
          'CDP 无法返回实际 Browser command line', cause)
      }) as { arguments?: unknown }
      if (!Array.isArray(result.arguments) || !result.arguments.every((value) => typeof value === 'string')) {
        throw browserHostError('E2E_BROWSER_COMMAND_LINE_UNAVAILABLE', 'CDP 未返回实际 command line')
      }
      return result.arguments
    } finally { await session.detach() }
  }
  async installRequestInterceptor(handler: (request: BrowserHostRequest) => Promise<void>): Promise<void> {
    await this.context.route('**/*', async (route) => {
      const request = route.request()
      const headers = await request.allHeaders()
      await handler({
        url: request.url(), method: request.method(), headers,
        isNavigationRequest: request.isNavigationRequest(),
        isMainFrame: isPlaywrightMainFrameRequest(request, headers),
        resourceType: request.resourceType(),
        ...(request.redirectedFrom() === null ? {} : { redirectedFromUrl: request.redirectedFrom()!.url() }),
        continueWithHeaders: async (headers) => await route.continue({ headers }),
        abort: async () => await route.abort('blockedbyclient'),
      })
    })
  }
  async requestThroughPage(url: string): Promise<{ status: number }> {
    try { return { status: (await this.page.goto(url, { waitUntil: 'commit' }))?.status() ?? 0 } }
    catch { return { status: 0 } }
  }
  async close(): Promise<void> { await this.#context?.close() }
  isClosed(): boolean { return this.#closed }
}

export function isPlaywrightMainFrameRequest(
  request: Pick<Request, 'frame' | 'isNavigationRequest' | 'resourceType'>,
  headers: Readonly<Record<string, string>>,
): boolean {
  try {
    const frame = request.frame()
    return frame === frame.page().mainFrame()
  } catch {
    return request.isNavigationRequest()
      && request.resourceType() === 'document'
      // Chromium 的 Popup 首次导航可能发生在 Page/Frame 对象创建之前，且
      // Playwright allHeaders() 不保证暴露 sec-fetch-dest。此时 navigation +
      // document 是 Playwright 提供的可信分类；若浏览器明确标记 iframe 则拒绝。
      && headers['sec-fetch-dest']?.toLowerCase() !== 'iframe'
  }
}

function verifyActualCommandLine(
  commandLine: string[],
  options: ReturnType<typeof chromiumLaunchOptions>,
  profileDir: string,
): void {
  const forbidden = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox']
  if (commandLine.some((argument) => forbidden.some((flag) => argument === flag || argument.startsWith(`${flag}=`)))) {
    throw browserHostError('E2E_BROWSER_SANDBOX_NOT_ENFORCED', '实际 Chromium command line 包含 --no-sandbox')
  }
  const required = [
    ...REQUIRED_FLAGS,
    `--proxy-server=${options.proxy.server}`,
    '--proxy-bypass-list=<-loopback>',
    options.args.at(-1)!,
    `--user-data-dir=${profileDir}`,
  ]
  const singletonPrefixes = [
    '--proxy-server=', '--proxy-bypass-list=',
    '--ignore-certificate-errors-spki-list=', '--user-data-dir=', '--host-resolver-rules=',
  ]
  if (required.some((flag) => commandLine.filter((argument) => argument === flag).length !== 1)
    || singletonPrefixes.some((prefix) => commandLine.filter((argument) => argument.startsWith(prefix)).length !== 1)) {
    throw browserHostError('E2E_BROWSER_LAUNCH_POLICY_MISMATCH', '实际 Chromium command line 缺少固定安全参数')
  }
}

function assertFixedLaunchInput(input: ChromiumLaunchOptionsInput): void {
  let proxy: URL
  try { proxy = new URL(input.proxyEndpoint) } catch {
    throw browserHostError('E2E_BROWSER_LAUNCH_INPUT_INVALID', 'Gateway proxy endpoint 非法')
  }
  const port = Number(proxy.port)
  const canonicalEndpoint = `http://127.0.0.1:${String(port)}`
  if (!isAbsolute(input.executablePath) || proxy.protocol !== 'http:'
    || proxy.hostname !== '127.0.0.1' || proxy.port === ''
    || !Number.isInteger(port) || port < 1 || port > 65_535
    || proxy.username !== '' || proxy.password !== '' || proxy.pathname !== '/'
    || proxy.search !== '' || proxy.hash !== '' || input.proxyEndpoint !== canonicalEndpoint
    || !isCanonicalSpki(input.caSpkiFingerprint)) {
    throw browserHostError('E2E_BROWSER_LAUNCH_INPUT_INVALID', 'executable、loopback proxy 或 SPKI binding 非法')
  }
}

function isCanonicalSpki(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  const bytes = Buffer.from(value, 'base64')
  return bytes.byteLength === 32 && bytes.toString('base64') === value
}

async function ensurePrivateTree(root: string, segments: string[]): Promise<string> {
  let current = root
  await assertPrivateDirectory(current, false)
  for (const segment of segments) {
    current = join(current, segment)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (!isNodeError(error, 'EEXIST')) throw error }
    await assertPrivateDirectory(current)
  }
  return current
}

async function assertPrivateDirectory(path: string, requirePrivateMode = true): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (requirePrivateMode && (metadata.mode & 0o777) !== 0o700)) {
    throw browserHostError('E2E_BROWSER_PROFILE_DIRECTORY_UNSAFE', 'Browser profile 每级目录必须是当前用户 0700 真实目录')
  }
}

async function writeOwnerMarker(
  profileDir: string,
  runId: string,
  ownedResource?: RuntimeOwnedResourceRecord,
  profileParent?: { canonicalPath: string; device: string; inode: string },
): Promise<OwnedBrowserProfileMarker | undefined> {
  const profileIdentity = await lstat(profileDir)
  const marker: OwnedBrowserProfileMarker | undefined = ownedResource === undefined ? undefined : {
    schemaVersion: '1.0.0', kind: 'browser-profile-lock', ownerMarker: ownedResource.ownerMarker,
    descriptorDigest: ownedResource.descriptorDigest, phase: 'prepared',
    profileParent: profileParent!,
    profile: { device: String(profileIdentity.dev), inode: String(profileIdentity.ino) },
    ownerProcess: { role: 'host', pid: process.pid, startIdentity: await currentProcessStartIdentity() },
  }
  const handle = await open(join(profileDir, '.owner.json'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${canonicalizeJson(ownedResource === undefined
      ? { schemaVersion: '1.0.0', runId }
      : marker)}\n`)
    await handle.chmod(0o600)
    await handle.sync()
  } finally { await handle.close() }
  return marker
}

interface OwnedBrowserProfileMarker {
  schemaVersion: '1.0.0'
  kind: 'browser-profile-lock'
  ownerMarker: RuntimeOwnedResourceRecord['ownerMarker']
  descriptorDigest: string
  phase: 'prepared' | 'supervising' | 'launched'
  profileParent: { canonicalPath: string; device: string; inode: string }
  profile: { device: string; inode: string }
  ownerProcess: { role: 'host' | 'supervisor'; pid: number; startIdentity: string }
}

async function replaceOwnerMarker(
  profileDir: string,
  expected: OwnedBrowserProfileMarker,
  next: OwnedBrowserProfileMarker,
): Promise<OwnedBrowserProfileMarker> {
  const path = join(profileDir, '.owner.json')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if ((await handle.readFile('utf8')).trim() !== canonicalizeJson(expected)) {
      throw browserHostError('E2E_BROWSER_PROFILE_CLEANUP_FENCED', 'owner marker phase CAS 不匹配')
    }
  } finally { await handle.close() }
  const temporary = join(profileDir, `.owner-${randomUUID()}.tmp`)
  const replacement = await open(temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await replacement.writeFile(`${canonicalizeJson(next)}\n`)
    await replacement.chmod(0o600)
    await replacement.sync()
  } finally { await replacement.close() }
  await rename(temporary, path)
  return next
}

async function assertOwnedProfileForCleanup(
  profileDir: string,
  record: RuntimeOwnedResourceRecord,
): Promise<void> {
  await assertPrivateDirectory(profileDir)
  try {
    await lstat(join(profileDir, 'SingletonLock'))
    throw browserHostError('E2E_BROWSER_PROFILE_CLEANUP_FENCED', 'Chromium SingletonLock 仍存在')
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  const markerPath = join(profileDir, '.owner.json')
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    throw browserHostError('E2E_BROWSER_PROFILE_CLEANUP_FENCED', 'owner marker 不可安全读取', error)
  }
  try {
    const metadata = await handle.stat()
    const profileMetadata = await lstat(profileDir)
    let marker: unknown
    try { marker = JSON.parse((await handle.readFile('utf8')).trim()) } catch { marker = undefined }
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || !isOwnedBrowserProfileMarker(marker, record, profileMetadata)) throw browserHostError(
      'E2E_BROWSER_PROFILE_CLEANUP_FENCED', 'owner marker 与 registry record 不一致',
    )
  } finally { await handle.close() }
}

function isOwnedBrowserProfileMarker(
  value: unknown,
  record: RuntimeOwnedResourceRecord,
  profile: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const marker = value as Partial<OwnedBrowserProfileMarker>
  return marker.schemaVersion === '1.0.0' && marker.kind === 'browser-profile-lock'
    && marker.descriptorDigest === record.descriptorDigest
    && canonicalizeJson(marker.ownerMarker) === canonicalizeJson(record.ownerMarker)
    && ['prepared', 'supervising', 'launched'].includes(String(marker.phase))
    && marker.profile?.device === String(profile.dev) && marker.profile?.inode === String(profile.ino)
    && typeof marker.ownerProcess?.pid === 'number'
    && typeof marker.ownerProcess.startIdentity === 'string'
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function assertWithin(root: string, candidate: string, code: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw browserHostError(code, '路径逃逸固定 Browser profile root')
  }
}

function browserHostError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
