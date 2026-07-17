import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { mkdir, rm } from 'node:fs/promises'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChromiumInstallation } from './browser-installer.js'
import type { GatewayBrowserBinding, RuntimeGatewayProxyHost } from './gateway-proxy-host.js'

const HOST_RESOLVER_POLICY = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
const REQUIRED_FLAGS = [
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

interface TrustedBrowserSessionBinding {
  runId: string
  gatewaySessionMeasurementDigest: string
  executeWithCorrelation<T>(correlation: RequestCorrelation, operation: () => Promise<T>): Promise<T>
}

const controlledSessions = new WeakMap<object, TrustedBrowserSessionBinding>()

export class ControlledBrowserHost {
  constructor(
    private readonly driver: BrowserHostDriver = new PlaywrightBrowserHostDriver(),
    private readonly options: { closeTimeoutMs?: number } = {},
  ) {}

  async open(input: {
    homeDir: string
    runId: string
    installation: ChromiumInstallation
    gateway: Pick<RuntimeGatewayProxyHost, 'handle' | 'browserBinding'>
  }): Promise<ControlledBrowserSession> {
    if (!isAbsolute(input.homeDir)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.runId)
      || input.runId === '.' || input.runId === '..'
      || input.installation.manifest.runtimeInstallationDigest.length === 0
      || input.gateway.browserBinding.gatewaySessionMeasurementDigest
        !== input.gateway.handle.measurement.gatewaySessionMeasurementDigest) {
      throw browserHostError('E2E_BROWSER_HOST_INPUT_INVALID', 'Browser Host binding 非法')
    }
    const profileParent = await ensurePrivateTree(input.homeDir, [
      '.mutil-skills', 'e2e', 'state', input.runId, 'browser',
    ])
    const profileParentReal = await realpath(profileParent)
    const profileCandidate = join(profileParentReal, `profile-${randomUUID()}`)
    await mkdir(profileCandidate, { mode: 0o700 })
    await assertPrivateDirectory(profileCandidate)
    const profileDir = await realpath(profileCandidate)
    assertWithin(profileParentReal, profileDir, 'E2E_BROWSER_PROFILE_DIRECTORY_UNSAFE')
    await writeOwnerMarker(profileDir, input.runId)
    const tempDir = join(profileDir, 'tmp')
    await mkdir(tempDir, { mode: 0o700 })
    const options = chromiumLaunchOptions({
      executablePath: input.installation.executablePath,
      proxyEndpoint: input.gateway.handle.endpoint,
      caSpkiFingerprint: input.gateway.handle.caSpkiFingerprint,
      homeDir: profileDir,
      tempDir,
    })
    let currentCorrelation: RequestCorrelation | undefined
    let launchStarted = false
    try {
      launchStarted = true
      await this.driver.launch(profileDir, options)
      await this.driver.installRequestInterceptor(async (request) => {
        const correlation = currentCorrelation
        if (correlation === undefined) {
          await request.continueWithHeaders({ ...request.headers })
          return
        }
        if (!request.isNavigationRequest || !request.isMainFrame || request.resourceType !== 'document'
          || request.url !== correlation.url || request.method.toUpperCase() !== correlation.method) {
          await request.abort()
          return
        }
        await input.gateway.browserBinding.continueCorrelatedRequest({
          ...correlation,
          url: request.url,
          method: request.method.toUpperCase(),
          headers: { ...request.headers },
        }, { continueWithHeaders: request.continueWithHeaders })
      })
      const commandLine = await this.driver.actualCommandLine()
      verifyActualCommandLine(commandLine, options, profileDir)
      const launchPolicyDigest = digestText('e2e-browser-launch-policy/v1', canonicalizeJson(options))
      const actualCommandLineDigest = digestText(
        'e2e-browser-actual-command-line/v1', canonicalizeJson(commandLine),
      )
      const preCanary = {
        browserClosureDigest: input.installation.manifest.closureDigest,
        browserExecutableDigest: input.installation.manifest.executableDigest,
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
          try { return await this.driver.requestThroughPage(request.url) }
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
          closePromise = this.closeAndCleanup(profileDir)
          return await closePromise
        },
      })
      controlledSessions.set(session, {
        runId: input.runId,
        gatewaySessionMeasurementDigest: measurement.gatewaySessionMeasurementDigest,
        executeWithCorrelation: async <T>(correlation: RequestCorrelation, operation: () => Promise<T>) => {
          if (closed || currentCorrelation !== undefined) {
            throw browserHostError('E2E_BROWSER_SESSION_BUSY', 'Browser session 已关闭或存在并发 Action')
          }
          currentCorrelation = structuredClone(correlation)
          try { return await operation() } finally { currentCorrelation = undefined }
        },
      })
      return session
    } catch (error) {
      let cleanupError: unknown
      if (launchStarted) {
        try { await this.closeAndCleanup(profileDir) }
        catch (closeError) { cleanupError = closeError }
      } else if (this.driver.isClosed()) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
      }
      if (cleanupError !== undefined) throw browserHostError(
        'E2E_BROWSER_OPEN_CLEANUP_FAILED',
        'Browser open 失败后未能确认进程关闭；profile 已保留以避免与存活进程竞态',
        new AggregateError([error, cleanupError]),
      )
      throw error
    }
  }

  private async closeAndCleanup(profileDir: string): Promise<void> {
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
    await rm(profileDir, { recursive: true, force: true })
    if (!outcome.ok) throw browserHostError(
      'E2E_BROWSER_CLOSE_FAILED', 'Browser 已确认关闭，但 close 返回失败', outcome.error,
    )
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
      const result = await session.send('Browser.getBrowserCommandLine') as { arguments?: unknown }
      if (!Array.isArray(result.arguments) || !result.arguments.every((value) => typeof value === 'string')) {
        throw browserHostError('E2E_BROWSER_COMMAND_LINE_UNAVAILABLE', 'CDP 未返回实际 command line')
      }
      return result.arguments
    } finally { await session.detach() }
  }
  async installRequestInterceptor(handler: (request: BrowserHostRequest) => Promise<void>): Promise<void> {
    await this.context.route('**/*', async (route) => {
      const request = route.request()
      await handler({
        url: request.url(), method: request.method(), headers: await request.allHeaders(),
        isNavigationRequest: request.isNavigationRequest(),
        isMainFrame: request.frame() === this.page.mainFrame(),
        resourceType: request.resourceType(),
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

async function writeOwnerMarker(profileDir: string, runId: string): Promise<void> {
  const handle = await open(join(profileDir, '.owner.json'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${canonicalizeJson({ schemaVersion: '1.0.0', runId })}\n`)
    await handle.chmod(0o600)
    await handle.sync()
  } finally { await handle.close() }
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
