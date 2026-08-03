import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { createTargetContractFact } from '../packages/e2e-runtime/src/target-contract.js'
import { runTargetProbe } from '../packages/e2e-runtime/src/target-probe.js'
import { RUNTIME_PACKAGE_VERSION } from '../packages/e2e-runtime/src/protocol.js'
import {
  bootstrapInstalledBrowserRuntime,
  createProductionTargetProbeCapability,
} from '../packages/e2e-runtime/src/runtime-browser-wiring.js'
import { openRuntimeArtifactStoreAuthority } from '../packages/e2e-runtime/src/authority-host.js'
import { inspectSystemChrome } from '../packages/e2e-runtime/src/system-chrome.js'
import { inspectRuntimeCapabilityProof } from '../packages/e2e-runtime/src/runtime-capability-proof.js'
import { writeBrowserSelection } from '../packages/e2e-runtime/src/runtime-user-config.js'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.E2E_RUNTIME_SYSTEM_CHROME_EXECUTABLE
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome-stable')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

test('真实 localhost SPA 经 Gateway 加载静态资源，并在同一 Run 修订非标题页面身份', async () => {
  if (!existsSync(executablePath)) throw new Error(`Golden 要求系统 Chrome：${executablePath}`)
  const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-recoverable-localhost-'))
  roots.push(root)
  const homeDir = join(root, 'home')
  const projectRoot = join(root, 'project')
  await Promise.all([
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(projectRoot, { recursive: true, mode: 0o700 }),
  ])

  let scriptRequests = 0
  let chainedScriptRequests = 0
  let writeRequests = 0
  const fixture = createServer((request, response) => {
    if (request.method === 'POST') {
      writeRequests += 1
      response.statusCode = 204
      response.end()
      return
    }
    if (request.url === '/app.js') {
      scriptRequests += 1
      response.setHeader('content-type', 'text/javascript; charset=utf-8')
      response.end([
        "document.querySelector('#root').innerHTML = '<section data-testid=\"orders-card\">订单工作台</section>'",
        "fetch('/mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"unsafe\":true}' }).catch(() => undefined)",
      ].join(';'))
      return
    }
    if (request.url === '/persistent-app.js') {
      chainedScriptRequests += 1
      response.setHeader('content-type', 'text/javascript; charset=utf-8')
      response.end([
        "document.querySelector('#root').innerHTML = '<section data-testid=\"persistent-card\">开发预览已就绪</section>'",
        `fetch('/hmr-poll-${chainedScriptRequests}.json').catch(() => undefined)`,
      ].join(';'))
      return
    }
    if (/^\/hmr-poll-\d+\.json$/u.test(request.url ?? '')) {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end('{"ok":true}')
      return
    }
    if (request.url === '/persistent') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><title>开发预览</title><main id="root">加载中</main><script src="/persistent-app.js"></script>')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>本地应用</title><main id="root">加载中</main><script src="/app.js"></script>')
  })
  await new Promise<void>((resolvePromise, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = fixture.address()
  if (!address || typeof address === 'string') throw new Error('localhost fixture address missing')
  const origin = `http://127.0.0.1:${address.port}`
  const installation = {
    version: RUNTIME_PACKAGE_VERSION, protocolMajor: 1 as const, versionRoot: sourceRoot,
    entrypoint: join(sourceRoot, 'packages', 'e2e-runtime', 'src', 'runtime-bin.ts'),
    installationDigest: `sha256:${'7'.repeat(64)}`, sourceRepositoryIndependent: true as const,
  }
  const browserInstallation = await inspectSystemChrome({
    executablePath, projectRoot, runtimeInstallationDigest: installation.installationDigest,
    controlledLaunchProofDigest: `sha256:${'0'.repeat(64)}`,
    configuredAt: '2026-08-02T00:00:00.000Z',
  })
  await bootstrapInstalledBrowserRuntime({
    homeDir, installation, browserInstallation,
    prepareAuthorityRoot: async () => {
      const authority = await openRuntimeArtifactStoreAuthority({
        homeDir, installation, subject: `local:uid:${process.getuid!()}`,
      })
      await authority.close()
    },
  })
  const capabilityProof = await inspectRuntimeCapabilityProof({
    homeDir, runtimeInstallationDigest: installation.installationDigest,
  })
  await writeBrowserSelection(homeDir, {
    ...browserInstallation.selection,
    controlledLaunchProofDigest: capabilityProof.proofDigest,
  })
  const capability = createProductionTargetProbeCapability({
    homeDir, projectRoot, installation,
  })
  const contract = (testId: string) => createTargetContractFact({
    schemaVersion: '1.0.0', targetUrl: `${origin}/app`, baseOrigin: origin,
    environmentLabel: 'local-golden', allowedNavigationOrigins: [origin],
    pageIdentityPolicy: {
      schemaVersion: '1.0.0', url: { origin, pathPattern: '/app' },
      signals: [{ kind: 'test-id', value: testId }], match: { mode: 'all' },
    },
  })

  try {
    const firstTarget = contract('legacy-orders-card')
    const first = await runTargetProbe(capability, {
      runId: 'RUN-RECOVERABLE-LOCALHOST', target: firstTarget,
      probedAt: '2026-08-02T00:00:01.000Z',
    })
    expect(first).toMatchObject({
      runId: 'RUN-RECOVERABLE-LOCALHOST', status: 'page-identity-mismatch',
      reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', identityMatched: false,
      trust: 'untrusted-diagnostic',
    })

    const revisedTarget = contract('orders-card')
    const recovered = await runTargetProbe(capability, {
      runId: 'RUN-RECOVERABLE-LOCALHOST', target: revisedTarget,
      probedAt: '2026-08-02T00:00:02.000Z',
    })
    expect(recovered).toMatchObject({
      runId: 'RUN-RECOVERABLE-LOCALHOST', status: 'ready', identityMatched: true,
      observedUrl: `${origin}/app`, observedTitle: '本地应用', trust: 'untrusted-diagnostic',
    })
    expect(revisedTarget.environmentIdentityDigest).toBe(firstTarget.environmentIdentityDigest)
    expect(revisedTarget.contractDigest).not.toBe(firstTarget.contractDigest)
    expect(scriptRequests).toBeGreaterThanOrEqual(2)
    expect(writeRequests).toBe(0)

    const persistentTarget = createTargetContractFact({
      schemaVersion: '1.0.0', targetUrl: `${origin}/persistent`, baseOrigin: origin,
      environmentLabel: 'local-persistent-golden', allowedNavigationOrigins: [origin],
      pageIdentityPolicy: {
        schemaVersion: '1.0.0', url: { origin, pathPattern: '/persistent' },
        signals: [{ kind: 'test-id', value: 'persistent-card' }], match: { mode: 'all' },
      },
    })
    const persistent = await runTargetProbe(capability, {
      runId: 'RUN-PERSISTENT-LOCALHOST', target: persistentTarget,
      probedAt: '2026-08-02T00:00:03.000Z', strategy: 'application-ready',
    })
    expect(persistent).toMatchObject({
      status: 'ready', identityMatched: true, observedTitle: '开发预览',
      diagnostics: {
        resourceSummary: { closureComplete: false },
      },
    })
    expect(chainedScriptRequests).toBeGreaterThan(0)
  } finally {
    await new Promise<void>((resolvePromise) => fixture.close(() => resolvePromise()))
  }
}, 120_000)
