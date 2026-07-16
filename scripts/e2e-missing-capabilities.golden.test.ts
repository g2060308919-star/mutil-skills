import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, test } from 'vitest'
import { chromium, firefox } from 'playwright'
import { canonicalizeJson, digestText, type SanitizerPolicy } from '@mutil-skills/e2e-contracts'
import { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { LocalArtifactStore, LocalSanitizerAuthority } from '@mutil-skills/e2e-engine'
import {
  LocalGatewayAuditSigner, LocalGatewayAuditVerifier, ReadOnlyGateway,
  verifyGatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import { resolveChromeExecutablePath } from './e2e-browser-runtime.js'

const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('关键 E2E 能力缺失时 fail-closed', () => {
  test.each([
    { kind: 'browser' as const, expectedCode: 'E2E_BROWSER_EXECUTABLE_UNAVAILABLE', verdict: 'environment-blocked' as const },
    { kind: 'gateway' as const, expectedCode: 'E2E_RUNTIME_GATEWAY_UNAVAILABLE', verdict: 'environment-blocked' as const },
    { kind: 'sanitizer' as const, expectedCode: 'E2E_VISUAL_ADAPTER_UNAVAILABLE', verdict: 'safety-blocked' as const },
  ])('缺少 $kind 能力时发布明确阻塞事实且不伪造 accepted', async ({ kind, expectedCode, verdict }) => {
    const fixture = createServer((request, response) => {
      if (request.url !== '/capability-probe') {
        response.writeHead(404).end('not found')
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html><head><title>能力探针</title><link rel="icon" href="data:,"></head>'
        + '<body><main><h1>能力探针</h1></main></body></html>')
    })
    const fixturePort = await listen(fixture)
    const fixtureOrigin = `http://fixture.test:${fixturePort}`
    const signer = LocalGatewayAuditSigner.create({
      issuer: `capability-gateway-${kind}`, keyId: `capability-key-${kind}`,
      instanceId: `GATEWAY-CAPABILITY-${kind.toUpperCase()}`, version: '1.0.0',
    })
    const verifier = LocalGatewayAuditVerifier.create(structuredClone(signer.exportVerifierMaterial()))
    const recorder = signer.createRecorder(digestText('gateway-policy/v1', `missing-${kind}`))
    const gateway = new ReadOnlyGateway({
      stage: 'bootstrap', recorder, intents: [{
        intentId: `INTENT-CAPABILITY-${kind.toUpperCase()}`, stage: 'bootstrap', methods: ['GET'],
        actionId: `ACTION-CAPABILITY-${kind.toUpperCase()}`, origin: fixtureOrigin,
        exactPath: '/capability-probe', query: [], maxRequests: 1,
      }],
    })
    const proxy = createServer((request, response) => {
      const decision = gateway.decide({ method: request.method ?? 'GET', url: request.url ?? '' },
        `ACTION-CAPABILITY-${kind.toUpperCase()}`)
      if (decision.decision === 'block') {
        response.writeHead(403).end(decision.code)
        return
      }
      const target = new URL(request.url!)
      const forwarded = httpRequest({ hostname: '127.0.0.1', port: fixturePort,
        path: `${target.pathname}${target.search}`, method: request.method,
        headers: { ...request.headers, host: `fixture.test:${fixturePort}` } }, (upstream) => {
        response.writeHead(upstream.statusCode ?? 500, upstream.headers)
        upstream.pipe(response)
      })
      forwarded.on('error', (error) => response.writeHead(502).end(error.message))
      request.pipe(forwarded)
    })
    const proxyPort = await listen(proxy)
    const browser = await chromium.launch({
      executablePath: resolveChromeExecutablePath(), headless: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
    })
    const authority = LocalApprovalAuthority.create({
      issuer: `capability-authority-${kind}`, keyId: `authority-key-${kind}`,
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    })
    try {
      const page = await browser.newPage()
      let observedCode = ''
      if (kind === 'browser') {
        await page.goto(`${fixtureOrigin}/capability-probe`, { waitUntil: 'domcontentloaded' })
        await expect(firefox.launch({ executablePath: '/definitely/missing/e2e-firefox', headless: true }))
          .rejects.toThrow()
        observedCode = 'E2E_BROWSER_EXECUTABLE_UNAVAILABLE'
      } else if (kind === 'gateway') {
        await closeServer(proxy)
        await expect(page.goto(`${fixtureOrigin}/capability-probe`, { waitUntil: 'domcontentloaded', timeout: 1_000 }))
          .rejects.toThrow()
        observedCode = 'E2E_RUNTIME_GATEWAY_UNAVAILABLE'
      } else {
        await page.goto(`${fixtureOrigin}/capability-probe`, { waitUntil: 'domcontentloaded' })
        const screenshot = await page.screenshot()
        const policy = sanitizerPolicy()
        const sanitizer = LocalSanitizerAuthority.create({
          issuer: 'missing-visual-adapter', keyId: 'missing-visual-adapter-key', policy,
        })
        const result = sanitizer.sanitizeVisual({
          evidenceId: 'EVIDENCE-CAPABILITY', relativePath: 'evidence/capability.png', evidenceType: 'screenshot',
          raw: Buffer.from(canonicalizeJson({ format: 'png-v1', mediaBase64: screenshot.toString('base64'),
            width: 1, height: 1, masks: [] })),
        })
        expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['E2E_VISUAL_ADAPTER_UNAVAILABLE'] })
        observedCode = result.status === 'blocked' ? result.reasonCodes[0]! : 'UNEXPECTED_SANITIZER_RESULT'
      }
      expect(observedCode).toBe(expectedCode)
      const audit = recorder.finalize()
      expect(verifyGatewayPublicationAudit(audit, verifier)).toBe(true)

      const workspace = await mkdtemp(join(process.cwd(), '.tmp', `e2e-missing-${kind}-`))
      directories.push(workspace)
      const store = new LocalArtifactStore(workspace, {
        auditStagedGeneration: async (staged) => {
          expect(staged.terminalVerdict).toBe(verdict)
          const persisted = JSON.parse(Buffer.from(await staged.readFile('run/capability-block.json')).toString('utf8'))
          expect(persisted).toEqual({ kind, reasonCode: expectedCode, accepted: false,
            gatewayAuditDigest: audit.signedCounters.digest })
        },
        signDigest: (digest) => authority.signArtifactDigest(digest),
        verifySignature: (signature) => authority.verifyArtifactSignature(signature),
      })
      await store.publish({
        assetId: `PRODUCT-MISSING-${kind.toUpperCase()}`, generationId: `GENERATION-MISSING-${kind.toUpperCase()}`,
        terminalVerdict: verdict, files: { 'run/capability-block.json': Buffer.from(canonicalizeJson({
          kind, reasonCode: observedCode, accepted: false, gatewayAuditDigest: audit.signedCounters.digest,
        })) },
      })
      expect(await store.readActive(`PRODUCT-MISSING-${kind.toUpperCase()}`)).toMatchObject({
        terminalVerdict: verdict,
      })
    } finally {
      await browser.close()
      authority.close()
    }
  }, 30_000)
})

function sanitizerPolicy(): SanitizerPolicy {
  return {
    schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.0.0', scannerVersion: '1.0.0',
    network: { formatVersions: ['network-v1'], approvedPaths: ['/capability-probe'], queryFields: [],
      requestHeaderFields: [], responseHeaderFields: [], requestBodyFields: [], responseBodyFields: [] },
    dom: { formatVersions: ['dom-v1'], allowedTags: ['main'], allowedAttributes: [],
      assertionTextClassification: 'public' },
    console: { formatVersions: ['console-v1'], allowedObjectFields: [], primitiveArgumentClassification: 'public' },
    screenshot: { formatVersions: ['png-v1'] }, video: { formatVersions: ['webm-v1'] },
    trace: { formatVersions: ['trace-v1'] }, maxInputBytes: 16 * 1024 * 1024, requireManualReviewFor: [],
  }
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  const index = servers.indexOf(server)
  if (index >= 0) servers.splice(index, 1)
}
