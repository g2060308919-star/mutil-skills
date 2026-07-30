import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { digestText } from '@mutil-skills/e2e-contracts'
import { bootstrapInstalledBrowserRuntime } from '../packages/e2e-runtime/src/runtime-browser-wiring.js'
import { inspectRuntimeCapabilityProof } from '../packages/e2e-runtime/src/runtime-capability-proof.js'
import { openRuntimeArtifactStoreAuthority } from '../packages/e2e-runtime/src/authority-host.js'
import { inspectSystemChrome } from '../packages/e2e-runtime/src/system-chrome.js'
import { ControlledBrowserHost,
  getControlledBrowserSessionBinding } from '../packages/e2e-runtime/src/browser-host.js'
import { startGatewayProxyHostWithTestControl } from '../packages/e2e-runtime/src/gateway-proxy-host.js'
import { projectGatewayRules } from '../packages/e2e-runtime/src/gateway-rule-projector.js'
import { createFullPlaywrightBindingFacades } from
  '../packages/e2e-playwright-runtime/src/full-playwright-session-internal.js'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome-stable')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

test.runIf(existsSync(executablePath))(
  '系统 Chrome 完成受控 canary、隔离 Profile cleanup 与 capability proof',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-system-chrome-'))
    roots.push(root)
    const homeDir = join(root, 'home')
    const projectRoot = join(root, 'project')
    await Promise.all([
      mkdir(homeDir, { mode: 0o700 }),
      mkdir(projectRoot, { mode: 0o700 }),
    ])
    const installation = {
      version: '0.4.5',
      protocolMajor: 1 as const,
      versionRoot: sourceRoot,
      entrypoint: join(sourceRoot, 'packages', 'e2e-runtime', 'src', 'runtime-bin.ts'),
      installationDigest: `sha256:${'a'.repeat(64)}`,
      sourceRepositoryIndependent: true as const,
    }
    const browserInstallation = await inspectSystemChrome({
      executablePath,
      projectRoot,
      runtimeInstallationDigest: installation.installationDigest,
      controlledLaunchProofDigest: `sha256:${'0'.repeat(64)}`,
      configuredAt: '2026-07-19T00:00:00.000Z',
    })

    await bootstrapInstalledBrowserRuntime({
      homeDir,
      installation,
      browserInstallation,
      prepareAuthorityRoot: async () => {
        const authority = await openRuntimeArtifactStoreAuthority({
          homeDir, installation, subject: `local:uid:${process.getuid!()}`,
        })
        await authority.close()
      },
    })

    await expect(inspectRuntimeCapabilityProof({
      homeDir, runtimeInstallationDigest: installation.installationDigest,
    })).resolves.toMatchObject({
      runtimeInstallationDigest: installation.installationDigest,
      isolation: {
        browserExecutableDigest: browserInstallation.selection.executableDigest,
      },
    })
    expect(existsSync(join(homeDir, '.mutil-skills', 'runtime', 'e2e', 'browsers'))).toBe(false)
  },
  60_000,
)

test.runIf(existsSync(executablePath))(
  '同一 Gateway 下的 program/cleanup 系统 Chrome Profile 同时存活并可采集截图',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-system-chrome-dual-'))
    roots.push(root)
    const homeDir = join(root, 'home')
    const projectRoot = join(root, 'project')
    const authorityRoot = join(homeDir, '.mutil-skills', 'e2e', 'authority')
    await Promise.all([
      mkdir(homeDir, { recursive: true, mode: 0o700 }),
      mkdir(projectRoot, { recursive: true, mode: 0o700 }),
      mkdir(authorityRoot, { recursive: true, mode: 0o700 }),
    ])
    const runtimeInstallationDigest = `sha256:${'b'.repeat(64)}`
    const browserInstallation = await inspectSystemChrome({
      executablePath,
      projectRoot,
      runtimeInstallationDigest,
      controlledLaunchProofDigest: `sha256:${'0'.repeat(64)}`,
      configuredAt: '2026-07-24T00:00:00.000Z',
    })
    const fixture = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(request.url === '/popup'
        ? '<!doctype html><title>popup</title><h1>Popup</h1>'
        : '<!doctype html><title>root</title><a target="_blank" href="/popup">Details</a>')
    })
    await new Promise<void>((resolvePromise, reject) => {
      fixture.once('error', reject)
      fixture.listen(0, '127.0.0.1', () => resolvePromise())
    })
    const fixtureAddress = fixture.address()
    if (!fixtureAddress || typeof fixtureAddress === 'string') throw new Error('fixture address missing')
    const origin = `http://127.0.0.1:${fixtureAddress.port}`
    const approvedRequests = [
      { actionId: 'ACTION-POPUP', capabilityId: 'CAP-POPUP', requestId: 'ROOT',
        method: 'GET', url: `${origin}/`, maxUses: 1, headers: [], redirectRequestIds: [],
        signedBodyDigest: digestText('system-chrome-popup/v1', 'root'),
        behavior: { kind: 'pass-through' as const } },
      { actionId: 'ACTION-POPUP', capabilityId: 'CAP-POPUP', requestId: 'POPUP',
        method: 'GET', url: `${origin}/popup`, maxUses: 1, headers: [], redirectRequestIds: [],
        signedBodyDigest: digestText('system-chrome-popup/v1', 'popup'),
        behavior: { kind: 'pass-through' as const } },
    ]
    const gateway = await startGatewayProxyHostWithTestControl({
      runId: 'RUN-DUAL-SYSTEM-CHROME', mode: 'real-environment', approvedRequests, authorityRoot,
    })
    let program: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    let cleanup: Awaited<ReturnType<ControlledBrowserHost['open']>> | undefined
    try {
      program = await new ControlledBrowserHost().open({
        homeDir, runId: 'RUN-DUAL-PROGRAM', installation: browserInstallation, gateway,
      })
      cleanup = await new ControlledBrowserHost().open({
        homeDir, runId: 'RUN-DUAL-CLEANUP', installation: browserInstallation, gateway,
      })
      expect(program.page.isClosed()).toBe(false)
      expect(cleanup.page.isClosed()).toBe(false)
      expect((await program.page.screenshot()).byteLength).toBeGreaterThan(0)
      expect((await cleanup.page.screenshot()).byteLength).toBeGreaterThan(0)
      const correlations = projectGatewayRules({
        runId: 'RUN-DUAL-SYSTEM-CHROME', approvedRequests,
      }).rules.map((rule) => ({
        requestId: rule.requestId!, ruleId: rule.ruleId, stepOrdinal: rule.stepOrdinal,
        method: rule.method, url: rule.url, channel: 'http' as const, bodyDigest: rule.bodyDigest,
        actionId: rule.actionId, capabilityId: rule.capabilityId,
        signedBodyDigest: rule.signedBodyDigest!, redirectRequestIds: [], navigation: true,
        maxUses: rule.maxUses, headers: {},
      }))
      await getControlledBrowserSessionBinding(program).executeWithCorrelations(correlations, async () => {
        await program!.page.goto(`${origin}/`)
        const popupReady = program!.context.waitForEvent('page')
        await program!.page.getByRole('link', { name: 'Details' }).click()
        expect(await (await popupReady).title()).toBe('popup')
      })
      const rawBrowser = program.context.browser()
      expect(rawBrowser).not.toBeNull()
      const gatewayContext = bindMethodsProxy(program.context)
      const controlledBrowser = new Proxy(rawBrowser!, { get(target, property, receiver) {
        if (property === 'newContext') return async (...args: Parameters<typeof target.newContext>) =>
          bindMethodsProxy(await target.newContext(...args))
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const facade = createFullPlaywrightBindingFacades({
        page: program.page, context: gatewayContext, browser: controlledBrowser,
        request: gatewayContext.request, expect, testInfo: {}, state: {},
      }, {
        browserSessionId: 'BROWSER-SYSTEM-CHROME-PROGRAM',
        gatewaySessionId: 'GATEWAY-SYSTEM-CHROME', lifecycle: 'program',
      })
      const child = await (facade.browser as typeof rawBrowser).newContext()
      await child.close()
      expect(program.page.isClosed()).toBe(false)
      expect((await program.page.screenshot()).byteLength).toBeGreaterThan(0)
    } finally {
      await Promise.allSettled([
        ...(program === undefined ? [] : [program.close()]),
        ...(cleanup === undefined ? [] : [cleanup.close()]),
        gateway.handle.close(),
        new Promise<void>((resolvePromise) => fixture.close(() => resolvePromise())),
      ])
    }
  },
  120_000,
)

function bindMethodsProxy<T extends object>(target: T): T {
  return new Proxy(target, { get(object, property, receiver) {
    const value = Reflect.get(object, property, receiver)
    return typeof value === 'function' ? value.bind(object) : value
  } })
}
