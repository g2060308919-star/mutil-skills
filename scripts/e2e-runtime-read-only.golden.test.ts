import {
  AuthenticatedRpcServer,
  LocalApprovalAuthority,
  registerAuthorityExecutionRpcOperations,
  startAuthenticatedRpcLoopbackServer,
} from '@mutil-skills/e2e-authority'
import {
  RuntimeRequestEnvelopeSchema,
  RuntimeResponseEnvelopeSchema,
  ReadApprovalSubjectSchema,
  SignedGrantSchema,
  canonicalizeJson,
  type ApprovalGrantSubject,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { runCli as RuntimeCliRunner, RuntimeCliDependencies } from '../packages/e2e-runtime/src/cli.js'
import type { RuntimeAuthorityHost } from '../packages/e2e-runtime/src/authority-host.js'
import type { runRuntimeDoctor as RuntimeDoctorRunner } from '../packages/e2e-runtime/src/runtime-doctor.js'
import { inspectRuntimeInstallation } from '../packages/e2e-runtime/src/runtime-discovery.js'
import { runtimeLayout } from '../packages/e2e-runtime/src/runtime-layout.js'
import { runtimeReadOnlyFixture } from './e2e-runtime-read-only.fixture.js'
import { copyVerifiedCapabilityProof } from './e2e-runtime-read-only-installation.js'

const browserHome = process.env.E2E_RUNTIME_REAL_GOLDEN_HOME
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('self-contained Runtime CLI read-only real Golden', () => {
  test.skipIf(!browserHome)(
    'CLI RPC 从 create-run 公开链运行到真实 Authority/Gateway/Chromium execute',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'e2e-runtime-real-golden-'))
      roots.push(root)
      const homeDir = join(root, 'home')
      const projectRoot = join(root, 'project')
      await Promise.all([
        mkdir(homeDir, { recursive: true, mode: 0o700 }),
        mkdir(join(projectRoot, '.biztest'), { recursive: true, mode: 0o700 }),
        mkdir(join(projectRoot, 'inputs'), { recursive: true, mode: 0o700 }),
      ])
      await Promise.all([
        writeFile(join(projectRoot, '.biztest', 'project.json'), JSON.stringify({
          schemaVersion: '1.0.0', projectId: 'RUNTIME-REAL-GOLDEN',
        })),
        writeFile(join(projectRoot, 'inputs', 'prd.md'), '# 订单验收\n\n审计员应能看到待审核订单。\n'),
        writeFile(join(projectRoot, 'inputs', 'policy.json'), JSON.stringify({
          schemaVersion: '1.0.0', environment: 'test', browser: 'chromium',
        })),
      ])

      const externalInstallation = await inspectRuntimeInstallation({ homeDir: browserHome! })
      await copyInstalledRuntimeClosure(browserHome!, homeDir, externalInstallation)
      await copyVerifiedCapabilityProof(
        browserHome!, homeDir, externalInstallation.installationDigest,
      )
      const installation = await inspectRuntimeInstallation({ homeDir })
      expect(installation).toMatchObject({
        version: externalInstallation.version,
        installationDigest: externalInstallation.installationDigest,
      })
      const installedRuntime = await loadInstalledRuntime(installation.entrypoint)
      const runCli = installedRuntime.runCli

      const pageServer = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html data-e2e-role="auditor"><head><title>订单</title></head><body><main><h1>订单列表</h1>页面显示待审核订单</main></body></html>')
      })
      await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
      const address = pageServer.address()
      if (!address || typeof address === 'string') throw new Error('fixture page server missing port')
      const url = `http://127.0.0.1:${address.port}/orders`

      const authorityRoot = runtimeLayout(homeDir).authority
      await mkdir(authorityRoot, { recursive: true, mode: 0o700 })
      await chmod(authorityRoot, 0o700)
      const now = new Date()
      let runId = ''
      const approver = { subject: 'os-user:runtime-golden', roles: ['e2e-approver'] }
      const stateEncryptionKey = randomBytes(32)
      const approvalAuthority = await LocalApprovalAuthority.open({
        issuer: 'runtime-golden-authority', keyId: 'runtime-golden-key',
        now: () => new Date(), statePath: join(authorityRoot, 'approval.sqlite'),
        stateEncryptionKey, testWorkspaceRoots: [root], approvalIdentities: [approver],
        authenticateApproverSession: (_sessionId, expected) => ({
          subject: approver.subject, runId, approvalType: expected.approvalType,
          subjectDigest: expected.subjectDigest, installationDigest: installation.installationDigest,
          origin: 'http://127.0.0.1:43210', issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        }),
      })
      const rpc = AuthenticatedRpcServer.create({
        issuer: 'runtime-golden-rpc', keyId: 'runtime-golden-rpc-key', now: () => new Date(),
      })
      registerAuthorityExecutionRpcOperations(rpc, {
        writeAuthority: approvalAuthority,
        leaseAuthority: { async verifyTarget() { return false } },
        discoveryAuthority: approvalAuthority,
        readAuthority: approvalAuthority,
      })
      const rpcHttp = await startAuthenticatedRpcLoopbackServer(rpc)
      let activeApprovalContext: SignedGrant['approvalContext'] | undefined
      let rpcClientOrdinal = 0
      const authorityAdapter = {
        async requestApproval(input: Parameters<RuntimeAuthorityHost['requestApproval']>[0]) {
          return {
            sessionId: `SESSION-${input.approvalType}`,
            url: `http://127.0.0.1/approval/${input.approvalType}`,
            async wait() {},
            async finalize(subject: ApprovalGrantSubject) {
              const grant = 'expectedPageIdentity' in subject
                ? await approvalAuthority.issueDiscoveryGrant({
                    subject, approvalSessionRef: `golden:${input.approvalType}`, ttlMs: 10 * 60_000,
                  })
                : await approvalAuthority.issueReadGrant({
                    subject: ReadApprovalSubjectSchema.parse(subject),
                    approvalSessionRef: `golden:${input.approvalType}`,
                    ttlMs: 10 * 60_000,
                  })
              return {
                grant,
                approvalBinding: {
                  runId: grant.approvalContext.runId,
                  approvalType: grant.approvalContext.approvalType,
                  subjectDigest: grant.approvalContext.subjectDigest,
                  installationDigest: grant.approvalContext.installationDigest,
                },
              }
            },
          }
        },
        async activateGrant(input: { grant: SignedGrant }) {
          const decision = await approvalAuthority.verify(input.grant)
          if (!decision.allowed) throw new Error(
            `Golden grant activation denied: ${'code' in decision ? decision.code : 'unknown'}`,
          )
          activeApprovalContext = structuredClone(input.grant.approvalContext)
        },
        executionRpcConnection(approvalBinding: SignedGrant['approvalContext']) {
          expect(canonicalizeJson(approvalBinding)).toBe(canonicalizeJson(activeApprovalContext))
          rpcClientOrdinal += 1
          const credential = rpc.registerClient(
            `runtime-golden-${rpcClientOrdinal}`,
            randomBytes(32),
            { approvalContext: approvalBinding },
          )
          return {
            endpoint: rpcHttp.endpoint,
            credential,
            verifierMaterial: rpc.verifierMaterial,
            approvalBinding,
          }
        },
        async close() {},
      }
      const dependencies: RuntimeCliDependencies = {
        homeDir,
        installRuntime: async () => { throw new Error('unused installRuntime') },
        uninstallRuntime: async () => { throw new Error('unused uninstallRuntime') },
        inspectRuntimeInstallation: async () => installation,
        runRuntimeDoctor: async () => {
          const report = await installedRuntime.runRuntimeDoctor({ installation, homeDir })
          const task8Ready = ['gateway', 'chromium', 'isolation'].every(
            (probe) => report.probes[probe]?.status === 'passed',
          )
          return { ...report, ready: task8Ready }
        },
        startAuthorityHost: async () => authorityAdapter as unknown as RuntimeAuthorityHost,
      }

      try {
        const doctor = await invokeCli(runCli, dependencies, projectRoot, 'DOCTOR-REAL-GOLDEN', 'doctor', {})
        expect(doctor.ready).toBe(true)
        expect(doctor.probes).toMatchObject({
          gateway: { status: 'passed' },
          chromium: { status: 'passed' },
          isolation: { status: 'passed' },
        })
        const created = await invokeCli(runCli, dependencies, projectRoot, 'CREATE-REAL-GOLDEN', 'create-run', {
          assetId: 'ASSET-1',
          prdSource: { kind: 'file', path: 'inputs/prd.md' },
          projectPolicyPath: 'inputs/policy.json',
        })
        runId = requiredString(created, 'runId')
        const fixture = runtimeReadOnlyFixture({
          runId,
          assetId: requiredString(created, 'assetId'),
          prdRevision: requiredString(created, 'prdRevision'),
          installationDigest: installation.installationDigest,
          url,
          now,
        })

        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-PRD', 'created',
          'prd-request', fixture.semanticArtifacts['prd-request'])
        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-SCOPE', 'source-frozen',
          'acceptance-scope', fixture.semanticArtifacts['acceptance-scope'])
        await invokeCli(runCli, dependencies, projectRoot, 'APPROVE-SCOPE', 'open-approval', {
          runId, approvalType: 'scope',
        })
        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-MODEL', 'scope-approved',
          'requirement-model', fixture.semanticArtifacts['requirement-model'])
        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-UNIVERSE', 'modeled',
          'coverage-universe', fixture.semanticArtifacts['coverage-universe'])

        const discovery = await invokeCli(runCli, dependencies, projectRoot, 'APPROVE-DISCOVERY', 'open-approval', {
          runId, approvalType: 'discovery', grantSubject: fixture.discoverySubject,
        })
        const discoveryGrant = SignedGrantSchema.parse(discovery.signedGrant)
        const preflight = await invokeCli(runCli, dependencies, projectRoot, 'RUN-PREFLIGHT', 'run-preflight', { runId })
        expect(preflight).toMatchObject({ status: 'ready', workflow: { current: 'preflight-readonly' } })
        const preflightFact = preflight.preflightFact as { preflightDigest?: unknown }
        const preflightDigest = requiredString(preflightFact as Record<string, unknown>, 'preflightDigest')

        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-ACTION-MAP', 'preflight-readonly',
          'browser-action-map', fixture.frozenArtifacts['browser-action-map'])
        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-TEST-CASES', 'binding-draft',
          'test-cases', fixture.frozenArtifacts['test-cases'])
        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-EXECUTION-CONTRACT', 'binding-draft',
          'execution-contract', fixture.frozenArtifacts['execution-contract'])

        const execution = await invokeCli(runCli, dependencies, projectRoot, 'APPROVE-EXECUTION', 'open-approval', {
          runId,
          approvalType: 'execution',
          grantSubject: fixture.readSubject(discoveryGrant.grantId, preflightDigest),
        })
        expect(execution).toMatchObject({ approvalType: 'execution' })
        await submit(runCli, dependencies, projectRoot, runId, 'SUBMIT-REGRESSION', 'execution-approved',
          'regression-manifest', fixture.regressionManifest)

        const executed = await invokeCli(runCli, dependencies, projectRoot, 'EXECUTE-REAL-GOLDEN', 'execute-run', { runId })
        expect(executed).toMatchObject({
          runId,
          status: 'passed',
          loadedGeneratedSourceFiles: [],
          workflow: { current: 'diagnosing' },
          gatewayAuditDigest: expect.stringMatching(/^sha256:/),
        })
        expect(executed.loadedGeneratedSourceFiles).toEqual([])
      } finally {
        const cleanup = await Promise.allSettled([
          rpcHttp.close(),
          Promise.resolve().then(() => approvalAuthority.close()),
          new Promise<void>((resolve, reject) => pageServer.close((error) => error ? reject(error) : resolve())),
        ])
        stateEncryptionKey.fill(0)
        const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failures.length > 0) throw new AggregateError(
          failures.map((result) => result.reason), 'Golden cleanup failed',
        )
      }
    },
    120_000,
  )
})

async function copyInstalledRuntimeClosure(
  sourceHome: string,
  targetHome: string,
  installation: Awaited<ReturnType<typeof inspectRuntimeInstallation>>,
): Promise<void> {
  const source = runtimeLayout(sourceHome)
  const target = runtimeLayout(targetHome)
  await mkdir(dirname(target.root), { recursive: true, mode: 0o700 })
  await cp(source.root, target.root, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    dereference: false,
  })
  const copiedVersionRoot = await realpath(join(target.versions, installation.version))
  await writeFile(target.current, `${canonicalizeJson({
    schemaVersion: '1.0.0',
    runtimeVersion: installation.version,
    runtimeManifestDigest: installation.installationDigest,
    protocolMajor: installation.protocolMajor,
    versionRoot: copiedVersionRoot,
  })}\n`, { mode: 0o600 })
  await chmod(target.current, 0o600)
}

async function loadInstalledRuntime(entrypoint: string): Promise<{
  runCli: typeof RuntimeCliRunner
  runRuntimeDoctor: typeof RuntimeDoctorRunner
}> {
  const sourceRoot = join(dirname(entrypoint), '..')
  const [cli, doctor] = await Promise.all([
    import(pathToFileURL(join(sourceRoot, 'cli.js')).href) as Promise<{ runCli?: unknown }>,
    import(pathToFileURL(join(sourceRoot, 'runtime-doctor.js')).href) as Promise<{ runRuntimeDoctor?: unknown }>,
  ])
  if (typeof cli.runCli !== 'function') throw new Error('Installed Runtime CLI module does not export runCli')
  if (typeof doctor.runRuntimeDoctor !== 'function') {
    throw new Error('Installed Runtime Doctor module does not export runRuntimeDoctor')
  }
  return {
    runCli: cli.runCli as typeof RuntimeCliRunner,
    runRuntimeDoctor: doctor.runRuntimeDoctor as typeof RuntimeDoctorRunner,
  }
}

async function submit(
  runCli: typeof RuntimeCliRunner,
  dependencies: RuntimeCliDependencies,
  projectRoot: string,
  runId: string,
  requestId: string,
  expectedState: string,
  artifactType: string,
  candidate: unknown,
): Promise<Record<string, unknown>> {
  return await invokeCli(runCli, dependencies, projectRoot, requestId, 'submit-candidate', {
    runId, expectedState, artifactType, candidate,
  })
}

async function invokeCli(
  runCli: typeof RuntimeCliRunner,
  dependencies: RuntimeCliDependencies,
  projectRoot: string,
  requestId: string,
  command: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const request = RuntimeRequestEnvelopeSchema.parse({
    schemaVersion: '1.0.0',
    requestId,
    client: { name: 'runtime-golden', version: '1.0.0' },
    command,
    projectRoot,
    payload,
  }) as RuntimeRequestEnvelope
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  const exitCode = await runCli(
    ['rpc'],
    Readable.from([canonicalizeJson(request)]),
    stdout,
    stderr,
    dependencies,
  )
  const output = stdout.text().trim()
  expect(output.split('\n'), stderr.text()).toHaveLength(1)
  const response = RuntimeResponseEnvelopeSchema.parse(JSON.parse(output))
  expect(exitCode, `${stderr.text()}\n${output}`).toBe(0)
  return success(response)
}

function success(response: RuntimeResponseEnvelope): Record<string, unknown> {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok || !response.result || typeof response.result !== 'object') {
    throw new Error(`Runtime request failed: ${JSON.stringify(response)}`)
  }
  return response.result as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${key}`)
  return value
}

class CaptureStream extends Writable {
  readonly #chunks: Buffer[] = []

  override _write(
    chunk: string | Buffer | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(typeof chunk === 'string'
      ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk))
    callback()
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8')
  }
}
