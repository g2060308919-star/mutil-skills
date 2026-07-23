import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { describe, expect, test, vi } from 'vitest'
import { createRuntimeTestRoots } from './fixtures.js'
import {
  ControlledBrowserHost,
  chromiumLaunchOptions,
  getControlledBrowserSessionBinding,
  type BrowserHostDriver,
  type BrowserProfileSupervisor,
} from '../src/browser-host.js'
import {
  authorizeRuntimeWriteProduction,
  createRuntimeWriteOwnedResourceLifecycle,
} from '../src/runtime-write-production.js'
import { createRuntimeOwnedResourceMarker } from '../src/write-attempt.js'
import { NodeBrowserProfileSupervisor } from '../src/browser-profile-supervisor.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('Controlled Browser Host', () => {
  test('生产 supervisor 在 Browser 启动前持有 owner lock，确认停止后删除 lock', async () => {
    const roots = await createRuntimeTestRoots()
    const profileDir = `${roots.source}/supervised-profile`
    await mkdir(profileDir, { mode: 0o700 })
    const supervisor = await new NodeBrowserProfileSupervisor().start(profileDir)
    expect(supervisor.ownerProcess).toMatchObject({
      role: 'supervisor', pid: expect.any(Number), startIdentity: expect.any(String),
    })
    await expect(access(`${profileDir}/.supervisor.lock`)).resolves.toBeUndefined()
    await supervisor.stop()
    await expect(access(`${profileDir}/.supervisor.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('supervisor 忽略 SIGTERM 时升级 SIGKILL、回收进程并删除自己的残留 lock', async () => {
    const roots = await createRuntimeTestRoots()
    const profileDir = `${roots.source}/stopped-supervisor-profile`
    await mkdir(profileDir, { mode: 0o700 })
    const supervisor = await new NodeBrowserProfileSupervisor({
      stopGraceMs: 25,
      killWaitMs: 2_000,
    }).start(profileDir)

    process.kill(supervisor.ownerProcess.pid, 'SIGSTOP')
    await supervisor.stop()

    expect(() => process.kill(supervisor.ownerProcess.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(access(`${profileDir}/.supervisor.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('uses a closed fixed launch profile without caller args/env/profile', () => {
    const options = chromiumLaunchOptions({
      executablePath: '/runtime/browsers/chromium',
      proxyEndpoint: 'http://127.0.0.1:43111',
      caSpkiFingerprint: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
    })
    expect(options).toMatchObject({
      executablePath: '/runtime/browsers/chromium', chromiumSandbox: true,
      proxy: { server: 'http://127.0.0.1:43111', bypass: '<-loopback>' },
      serviceWorkers: 'block', acceptDownloads: false, permissions: [],
    })
    expect(options.args).toEqual(expect.arrayContaining([
      '--enable-automation',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--ignore-certificate-errors-spki-list=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
    ]))
    expect(options.args).not.toContain('--disable-extensions')
    expect(options.args).not.toContain('--disable-background-networking')
    expect(options.args).not.toContain('--no-sandbox')
    expect(Object.keys(options.env!)).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'])
  })

  test.each([
    'http://user@127.0.0.1:43111',
    'http://127.0.0.1:43111/',
    'http://127.0.0.1:43111/proxy',
    'http://127.0.0.1:43111?mode=proxy',
    'http://127.0.0.1:43111#fragment',
    'http://127.0.0.1:043111',
  ])('rejects non-canonical Gateway endpoint %s', (proxyEndpoint) => {
    expect(() => chromiumLaunchOptions({
      executablePath: '/runtime/browsers/chromium', proxyEndpoint,
      caSpkiFingerprint: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
    })).toThrow(/E2E_BROWSER_LAUNCH_INPUT_INVALID/)
  })

  test('verifies actual command line and proves gateway enforcement with the controlled page', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    const canary = vi.fn(async (input) => {
      expect(await input.executeThroughControlledBrowser({
        url: 'http://canary.test/approved', correlation: correlation(),
      })).toEqual({ status: 204 })
      expect(await input.executeThroughControlledBrowser({
        url: 'http://canary.test/denied',
      })).toEqual({ status: 403 })
      return { approved: true as const, denied: true as const, proofDigest: digest('c') }
    })
    const host = new ControlledBrowserHost(driver)
    const session = await host.open({
      homeDir: roots.home, runId: 'RUN-1', installation: installation(),
      gateway: gateway(canary),
    })

    expect(session.measurement).toMatchObject({
      browserClosureDigest: digest('b'), gatewaySessionMeasurementDigest: digest('g'),
      canaryProofDigest: digest('c'), sandboxVerified: true,
      actualCommandLineDigest: expect.stringMatching(/^sha256:/),
    })
    expect(canary).toHaveBeenCalledOnce()
    expect(driver.correlationLeaks).toBe(0)
    expect(getControlledBrowserSessionBinding(session).runId).toBe('RUN-1')
    const launchInput = driver.launchInput!
    expect(launchInput.options.env).toMatchObject({
      HOME: launchInput.profileDir,
      TMPDIR: `${launchInput.profileDir}/tmp`,
    })
    await session.close()
  })

  test('surfaces Gateway correlation rejection through the browser operation and closes cleanly', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    const controlledGateway = gateway(vi.fn(async (input) => {
      await input.executeThroughControlledBrowser({
        url: 'http://canary.test/approved', correlation: correlation(),
      })
      return { approved: true, denied: true, proofDigest: digest('c') }
    })) as any
    controlledGateway.browserBinding.continueCorrelatedRequest.mockRejectedValue(
      new Error('E2E_GATEWAY_BROWSER_CORRELATION_DENIED'),
    )

    await expect(new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId: 'RUN-CORRELATION-DENIED', installation: installation(),
      gateway: controlledGateway,
    })).rejects.toThrow(/E2E_GATEWAY_BROWSER_CORRELATION_DENIED/)
    expect(driver.close).toHaveBeenCalledOnce()
  })

  test('system Chrome uses the identical isolated profile and Gateway policy with source-bound measurement', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    const session = await new ControlledBrowserHost(driver).open({
      homeDir: roots.home,
      runId: 'RUN-SYSTEM-CHROME',
      installation: systemChromeInstallation(),
      gateway: gateway(vi.fn(async () => ({ approved: true, denied: true, proofDigest: digest('c') }))),
    })

    expect(driver.launchInput?.options.executablePath).toBe('/Applications/Google Chrome')
    expect(driver.launchInput?.profileDir).toMatch(/\/state\/RUN-SYSTEM-CHROME\/browser\/profile-/)
    expect(driver.launchInput?.options.proxy.server).toBe('http://127.0.0.1:43111')
    expect(session.measurement.browserExecutableDigest).toBe(digest('a'))
    expect(session.measurement.browserClosureDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(session.measurement.browserClosureDigest).not.toBe(digest('a'))
    await session.close()
    await expect(access(driver.launchInput!.profileDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('生产 profile 在 mkdir 前持久登记，正常关闭删除后才写 cleaned tombstone', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    let activeRecord: any
    const complete = vi.fn(async (input: any) => ({
      ...activeRecord, revision: 2, status: 'cleaned' as const,
      cleanupReceiptDigest: input.cleanupReceiptDigest,
    }))
    const register = vi.fn(async (record: any) => {
      await expect(access(record.descriptor.profileDir)).rejects.toMatchObject({ code: 'ENOENT' })
      activeRecord = { ...record, revision: 1, status: 'active' as const }
      return activeRecord
    })
    const marker = createRuntimeOwnedResourceMarker({
      runtimeInstallationDigest: digest('a'), projectIdentityDigest: digest('b'),
      runId: 'RUN-WRITE-PROFILE', attemptId: 'ATTEMPT-WRITE-PROFILE', ownerNonce: 'OWNER-1',
    })
    const lifecycle = createRuntimeWriteOwnedResourceLifecycle(authorizeRuntimeWriteProduction({
      recovery: { recover: vi.fn() }, ownedResources: { register, complete }, prepareCleanup: vi.fn(),
    }), marker, () => new Date('2026-07-18T00:00:00.000Z'))
    const order: string[] = []
    const originalLaunch = driver.launch.getMockImplementation()!
    driver.launch.mockImplementation(async (profile: string, options: Parameters<BrowserHostDriver['launch']>[1]) => {
      order.push('browser-launch')
      await originalLaunch(profile, options)
    })
    const stop = vi.fn(async () => { order.push('supervisor-stop') })
    const supervisor: BrowserProfileSupervisor = {
      start: vi.fn(async () => {
        order.push('supervisor-start')
        return { ownerProcess: { role: 'supervisor' as const, pid: 4242, startIdentity: 'test-start:100' }, stop }
      }),
    }
    const session = await new ControlledBrowserHost(driver, { profileSupervisor: supervisor }).open({
      homeDir: roots.home, runId: marker.runId, installation: installation(),
      gateway: gateway(vi.fn(async () => ({ approved: true, denied: true, proofDigest: digest('c') }))),
      ownedResourceLifecycle: lifecycle,
    })
    const owner = JSON.parse(await readFile(`${driver.launchInput!.profileDir}/.owner.json`, 'utf8'))
    expect(owner).toMatchObject({
      schemaVersion: '1.0.0', kind: 'browser-profile-lock', ownerMarker: marker,
      descriptorDigest: expect.stringMatching(/^sha256:/),
      phase: 'launched',
      profileParent: { canonicalPath: expect.any(String), device: expect.stringMatching(/^\d+$/), inode: expect.stringMatching(/^\d+$/) },
      profile: { device: expect.stringMatching(/^\d+$/), inode: expect.stringMatching(/^\d+$/) },
      ownerProcess: { role: 'supervisor', pid: 4242, startIdentity: 'test-start:100' },
    })
    expect(order).toEqual(['supervisor-start', 'browser-launch'])
    expect(register).toHaveBeenCalledOnce()
    await session.close()
    await expect(access(driver.launchInput!.profileDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: expect.stringMatching(/^browser-profile-lock:/), expectedRevision: 1,
      ownerMarkerDigest: marker.markerDigest, cleanupReceiptDigest: expect.stringMatching(/^sha256:/),
    }))
    expect(stop).toHaveBeenCalledOnce()
    expect(order).toEqual(['supervisor-start', 'browser-launch', 'supervisor-stop'])
  })

  test('action-scoped resolver 仅关联已签页面/API 请求一次，并拒绝未知、重复与跨 action 请求', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    const session = await new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId: 'RUN-RESOLVER', installation: installation(),
      gateway: gateway(vi.fn(async () => ({ approved: true, denied: true, proofDigest: digest('c') }))),
    })
    const binding = getControlledBrowserSessionBinding(session) as any
    const base = {
      channel: 'http', bodyDigest: digest('2'), signedBodyDigest: digest('3'),
      actionId: 'ACTION-1', capabilityId: 'CAP-HTTP', headers: {}, maxUses: 1,
      redirectRequestIds: [],
    }
    const outcomes = await binding.executeWithCorrelations([
      { ...base, requestId: 'REQUEST-PAGE', ruleId: digest('4'), stepOrdinal: 1,
        method: 'GET', url: 'https://example.test/orders', navigation: true },
      { ...base, requestId: 'REQUEST-API', ruleId: digest('5'), stepOrdinal: 2,
        method: 'GET', url: 'https://example.test/api/orders', navigation: false },
    ], async () => await driver.dispatchRequests!([
      request('https://example.test/orders', 'document', true, true),
      request('https://example.test/api/orders', 'xhr', false, true),
      request('https://example.test/unapproved', 'fetch', false, true),
      request('https://example.test/api/orders', 'xhr', false, true),
    ]))

    expect(outcomes).toEqual([true, true, false, false])
    await expect(binding.executeWithCorrelations([
      { ...base, requestId: 'REQUEST-1', ruleId: digest('6'), stepOrdinal: 1,
        method: 'GET', url: 'https://example.test/one', navigation: false },
      { ...base, actionId: 'ACTION-2', requestId: 'REQUEST-2', ruleId: digest('7'), stepOrdinal: 2,
        method: 'GET', url: 'https://example.test/two', navigation: false },
    ], async () => undefined)).rejects.toThrow(/E2E_BROWSER_ACTION_RESOLVER_INVALID/)
    await session.close()
  })

  test('GET 子资源依据 Playwright navigation/resourceType 关联，不被方法误判成 document', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    const session = await new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId: 'RUN-SUBRESOURCES', installation: installation(),
      gateway: gateway(vi.fn(async () => ({ approved: true, denied: true, proofDigest: digest('c') }))),
    })
    const binding = getControlledBrowserSessionBinding(session) as any
    const base = { channel: 'http', bodyDigest: digest('2'), signedBodyDigest: digest('3'),
      actionId: 'ACTION-1', capabilityId: 'CAP-HTTP', headers: {}, maxUses: 1,
      redirectRequestIds: [], navigation: true }
    const definitions = [
      ['DOC', 'https://example.test/', 'document', true],
      ['SCRIPT', 'https://example.test/app.js', 'script', false],
      ['CSS', 'https://example.test/app.css', 'stylesheet', false],
      ['IMAGE', 'https://example.test/logo.png', 'image', false],
      ['FETCH', 'https://example.test/api/data', 'fetch', false],
    ] as const
    const outcomes = await binding.executeWithCorrelations(definitions.map(([id, url], index) => ({
      ...base, requestId: `REQUEST-${id}`, ruleId: digest(String(index + 1)), stepOrdinal: index + 1,
      method: 'GET', url,
    })), async () => await driver.dispatchRequests!(definitions.map(([, url, resourceType, navigation]) =>
      request(url, resourceType, navigation, navigation))))

    expect(outcomes).toEqual([true, true, true, true, true])
    await session.close()
  })

  test.each(['.', '..'])('rejects path-special runId %s before creating a profile', async (runId) => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    await expect(new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId, installation: installation(), gateway: gateway(vi.fn()),
    })).rejects.toThrow(/E2E_BROWSER_HOST_INPUT_INVALID/)
    expect(driver.launch).not.toHaveBeenCalled()
  })

  test('bounds Browser close and preserves profile until process closure is confirmed', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver()
    driver.close.mockImplementation(async () => await new Promise<void>(() => undefined))
    driver.isClosed.mockReturnValue(false)
    const session = await new ControlledBrowserHost(driver, { closeTimeoutMs: 20 }).open({
      homeDir: roots.home, runId: 'RUN-CLOSE-TIMEOUT', installation: installation(),
      gateway: gateway(vi.fn(async () => ({ approved: true, denied: true, proofDigest: digest('c') }))),
    })

    await expect(session.close()).rejects.toThrow(/E2E_BROWSER_CLOSE_TIMEOUT/)
    await expect(access(driver.launchInput!.profileDir)).resolves.toBeUndefined()
    await rm(driver.launchInput!.profileDir, { recursive: true, force: true })
  })

  test('open failure preserves profile when Browser process closure cannot be confirmed', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver(['chromium', '--no-sandbox'])
    driver.close.mockRejectedValue(new Error('close failed'))
    driver.isClosed.mockReturnValue(false)
    await expect(new ControlledBrowserHost(driver, { closeTimeoutMs: 20 }).open({
      homeDir: roots.home, runId: 'RUN-OPEN-FAIL', installation: installation(), gateway: gateway(vi.fn()),
    })).rejects.toThrow(/E2E_BROWSER_OPEN_CLEANUP_FAILED/)
    await expect(access(driver.launchInput!.profileDir)).resolves.toBeUndefined()
    await rm(driver.launchInput!.profileDir, { recursive: true, force: true })
  })

  test('fails closed when Chromium reports --no-sandbox in the actual command line', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver(['chromium', '--no-sandbox'])
    await expect(new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId: 'RUN-1', installation: installation(),
      gateway: gateway(vi.fn()),
    })).rejects.toThrow(/E2E_BROWSER_SANDBOX_NOT_ENFORCED/)
    expect(driver.close).toHaveBeenCalledOnce()
  })

  test('拒绝额外 proxy/SPKI/user-data-dir/host-resolver 冲突参数', async () => {
    for (const conflicting of [
      '--proxy-server=http://127.0.0.1:49999',
      '--ignore-certificate-errors-spki-list=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      '--user-data-dir=/tmp/attacker-profile',
      '--host-resolver-rules=MAP * 127.0.0.1',
    ]) {
      const roots = await createRuntimeTestRoots()
      const driver = fakeDriver([...fixedCommandLine(), conflicting])
      await expect(new ControlledBrowserHost(driver).open({
        homeDir: roots.home, runId: 'RUN-1', installation: installation(),
        gateway: gateway(vi.fn()),
      })).rejects.toThrow(/E2E_BROWSER_LAUNCH_POLICY_MISMATCH/)
      expect(driver.close).toHaveBeenCalledOnce()
    }
  })

  test('拒绝实际 Chromium command line 缺失固定 host resolver policy', async () => {
    const roots = await createRuntimeTestRoots()
    const driver = fakeDriver(fixedCommandLine().filter((argument) => !argument.startsWith('--host-resolver-rules=')))
    await expect(new ControlledBrowserHost(driver).open({
      homeDir: roots.home, runId: 'RUN-DNS-POLICY', installation: installation(),
      gateway: gateway(vi.fn()),
    })).rejects.toThrow(/E2E_BROWSER_LAUNCH_POLICY_MISMATCH/)
    expect(driver.close).toHaveBeenCalledOnce()
  })
})

function installation() {
  return {
    root: '/browser-root', executablePath: '/browser-root/chromium-1234/chrome',
    manifest: {
      closureDigest: digest('b'), executableDigest: digest('e'),
      runtimeInstallationDigest: digest('r'), playwrightVersion: '1.61.1',
    },
  } as never
}

function systemChromeInstallation() {
  return {
    selection: {
      schemaVersion: '1.0.0',
      source: { kind: 'system-chrome', executablePath: '/Applications/Google Chrome' },
      browserVersion: 'Google Chrome 126.0.6478.127',
      executableDigest: digest('a'),
      runtimeInstallationDigest: digest('b'),
      controlledLaunchProofDigest: digest('p'),
      configuredAt: '2026-07-19T00:00:00.000Z',
    },
    identity: { device: 1, inode: 2, uid: 501, byteLength: 1024 },
  } as never
}

function correlation() {
  return {
    ruleId: digest('1'), stepOrdinal: 1, method: 'GET', channel: 'http' as const,
    bodyDigest: digest('2'), actionId: 'ACTION-1', capabilityId: 'CAP-1',
  }
}

function gateway(runCanary: ReturnType<typeof vi.fn>) {
  return {
    handle: {
      endpoint: 'http://127.0.0.1:43111', caSpkiFingerprint: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
      measurement: { gatewaySessionMeasurementDigest: digest('g') },
    },
    browserBinding: {
      gatewaySessionMeasurementDigest: digest('g'), runCanary,
      continueCorrelatedRequest: vi.fn(async (_input, continuation) => {
        await continuation.continueWithHeaders({ 'x-trusted': '1' })
      }),
    },
  } as never
}

function fixedCommandLine() { return [
  'chromium', '--enable-automation', '--disable-quic', '--disable-extensions', '--disable-background-networking',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-server=http://127.0.0.1:43111',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--ignore-certificate-errors-spki-list=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=', '--user-data-dir=$PROFILE',
] }

function fakeDriver(commandLine = fixedCommandLine()): BrowserHostDriver & {
  close: ReturnType<typeof vi.fn>
  isClosed: ReturnType<typeof vi.fn>
  launch: ReturnType<typeof vi.fn>
  launchInput?: { profileDir: string; options: Parameters<BrowserHostDriver['launch']>[1] }
  correlationLeaks: number
  dispatchRequests?(requests: any[]): Promise<boolean[]>
} {
  let interceptor: ((request: any) => Promise<void>) | undefined
  let profileDir = ''
  const close = vi.fn(async () => undefined)
  const isClosed = vi.fn(() => true)
  const launch = vi.fn(async (profile: string, options: Parameters<BrowserHostDriver['launch']>[1]) => {
    profileDir = profile
    driver.launchInput = { profileDir: profile, options }
  })
  const driver: BrowserHostDriver & {
    close: ReturnType<typeof vi.fn>
    isClosed: ReturnType<typeof vi.fn>
    launch: ReturnType<typeof vi.fn>
    launchInput?: { profileDir: string; options: Parameters<BrowserHostDriver['launch']>[1] }
    correlationLeaks: number
    dispatchRequests?(requests: any[]): Promise<boolean[]>
  } = {
    correlationLeaks: 0,
    page: {} as never, context: {} as never, close, isClosed, launch,
    actualCommandLine: async () => commandLine.map((argument) => argument.replace('$PROFILE', profileDir)),
    installRequestInterceptor: async (handler) => { interceptor = handler },
    requestThroughPage: async (url) => {
      let continuedTrusted = false
      for (const request of [
        { isNavigationRequest: true, isMainFrame: false, resourceType: 'document' },
        { isNavigationRequest: false, isMainFrame: true, resourceType: 'xhr' },
      ]) await interceptor!({
        url, method: 'GET', headers: {}, ...request,
        continueWithHeaders: async (headers: Record<string, string>) => {
          if (headers['x-trusted'] === '1') driver.correlationLeaks += 1
        },
        abort: async () => undefined,
      })
      await interceptor!({
        url, method: 'GET', headers: {},
        isNavigationRequest: true, isMainFrame: true, resourceType: 'document',
        continueWithHeaders: async (headers: Record<string, string>) => { continuedTrusted = headers['x-trusted'] === '1' },
        abort: async () => undefined,
      })
      return { status: continuedTrusted ? 204 : 403 }
    },
    dispatchRequests: async (requests) => await Promise.all(requests.map(async (request) => {
      let trusted = false
      await interceptor!({
        ...request, headers: request.actionId === undefined ? {} : { 'x-test-action-id': request.actionId },
        continueWithHeaders: async (headers: Record<string, string>) => { trusted = headers['x-trusted'] === '1' },
        abort: async () => undefined,
      })
      return trusted
    })),
  }
  return driver
}

function request(
  url: string,
  resourceType: string,
  isNavigationRequest: boolean,
  isMainFrame: boolean,
) {
  return { url, method: 'GET', resourceType, isNavigationRequest, isMainFrame }
}
