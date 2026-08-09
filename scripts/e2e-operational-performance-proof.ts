import { execFile } from 'node:child_process'
import { access, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, homedir, platform, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { LocalArtifactStore } from '@mutil-skills/e2e-engine'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { classifyRunCondition } from '../packages/e2e-runtime/src/run-condition.js'
import { installRuntime } from '../packages/e2e-runtime/src/runtime-installer.js'
import { resolveRuntimeInstallation } from '../packages/e2e-runtime/src/runtime-resolver.js'
import { TufRuntimeUpdateClient, type TufUpdaterLike } from '../packages/e2e-runtime/src/tuf-runtime-update-client.js'
import {
  createOperationalPerformanceProof,
  OPERATIONAL_PERFORMANCE_PHASES,
  type OperationalPerformancePhase,
} from '../packages/e2e-runtime/src/operational-performance-proof.js'
import { createArtifactStoreAuthority } from '../packages/e2e-engine/test/artifact-store-authority.js'

const sampleCount = Number(process.env.E2E_OPERATIONAL_SAMPLES ?? '20')
if (!Number.isInteger(sampleCount) || sampleCount < 20 || sampleCount > 100) {
  throw new Error('E2E_OPERATIONAL_SAMPLE_COUNT_INVALID')
}
const b2bProofPath = process.env.E2E_B2B_COVERAGE_PROOF
if (b2bProofPath === undefined) throw new Error('E2E_B2B_COVERAGE_PROOF_REQUIRED')
const b2bProof = JSON.parse(await readFile(resolve(b2bProofPath), 'utf8')) as {
  passed?: boolean; flakyRate?: number; proofDigest?: string
}
if (!b2bProof.passed || typeof b2bProof.flakyRate !== 'number'
  || !/^sha256:[a-f0-9]{64}$/.test(b2bProof.proofDigest ?? '')) {
  throw new Error('E2E_B2B_COVERAGE_PROOF_INVALID')
}

const runtimeModule = pathToFileURL(resolve('packages/e2e-runtime/dist/src/index.js')).href
const baseline = await loadOperationalBaseline()
const stableResources = verifyStableRunnerBaseline(baseline)
const root = await mkdtemp(join(tmpdir(), 'mutil-e2e-operational-'))
const artifactRoot = join(root, 'artifacts')
await mkdir(artifactRoot, { recursive: true })
const runtimeHome = join(root, 'runtime-home')
const runtimeSource = join(root, 'runtime-source')
const runtimePackage = join(runtimeSource, 'node_modules', '@mutil-skills', 'e2e-runtime')
await Promise.all([
  mkdir(runtimeHome, { recursive: true }),
  mkdir(join(runtimePackage, 'dist', 'src', 'bin'), { recursive: true }),
])
await writeFile(join(runtimePackage, 'package.json'), JSON.stringify({
  name: '@mutil-skills/e2e-runtime', version: '0.7.0',
}))
await writeFile(join(runtimePackage, 'dist', 'src', 'bin', 'repo-e2e.js'), '#!/usr/bin/env node\n')
await installRuntime({ homeDir: runtimeHome, version: '0.7.0', installClosure: async ({ stagingPrefix }) => {
  await cp(runtimeSource, stagingPrefix, { recursive: true })
} })
const store = new LocalArtifactStore(await realpath(artifactRoot), createArtifactStoreAuthority())
let diagnosticCorrect = 0
let diagnosticTotal = 0
let artifactRetentionVerified = true
const phases = Object.fromEntries(OPERATIONAL_PERFORMANCE_PHASES.map((name) => [name, {
  budgetMs: baseline.budgetsMs[name], samples: [] as Array<{ ok: boolean; durationMs: number; reasonCode?: string }>,
}])) as Record<OperationalPerformancePhase, {
  budgetMs: number; samples: Array<{ ok: boolean; durationMs: number; reasonCode?: string }>
}>

try {
  const warmTuf = await createTufClient(join(root, 'tuf-warm'), stableResources)
  for (const phase of OPERATIONAL_PERFORMANCE_PHASES) {
    for (let index = 0; index < sampleCount; index += 1) {
      const started = performance.now()
      try {
        if (phase === 'runtime-module-cold-start') await runNode(`await import(process.argv[1])`, runtimeModule)
        else if (phase === 'tuf-update-cold') {
          const client = await createTufClient(join(root, `tuf-cold-${index}`), stableResources)
          await client.refresh()
        } else if (phase === 'tuf-update-warm') await warmTuf.refresh()
        else if (phase === 'concurrent-run-resolution') {
          const results = await Promise.all(Array.from({ length: 32 }, async () =>
            resolveRuntimeInstallation({ homeDir: runtimeHome, policy: { mode: 'offline' },
              existingRunRevocationChecker: async () => ({ status: 'revocation-checked', revoked: false }) })))
          if (results.some((item) => item.revocationStatus !== 'revocation-checked'
            || item.installation.version !== '0.7.0')) {
            throw new Error('E2E_CONCURRENT_RESULT_INVALID')
          }
        } else if (phase === 'diagnostic-classification') {
          const cases = [
            [{ workflow: { current: 'created' } }, 'ready'],
            [{ workflow: { current: 'preflight-readonly' },
              preflightBlocker: { reasonCode: 'E2E_PREFLIGHT_RETRY' } }, 'blocked-retryable'],
            [{ workflow: { current: 'pending-decision' }, pendingDecision: { decisionId: 'DECISION-1' } }, 'awaiting-user'],
            [{ workflow: { current: 'accepted' } }, 'terminal'],
          ] as const
          for (const [snapshot, expected] of cases) {
            diagnosticTotal += 1
            if (classifyRunCondition({ runId: 'RUN-BENCHMARK', ...snapshot } as never).kind === expected) {
              diagnosticCorrect += 1
            }
          }
        } else {
          const assetId = `ASSET-RETENTION-${index + 1}`
          const activeGenerationId = `GEN-RETENTION-${index + 1}-A`
          const validatingGenerationId = `GEN-RETENTION-${index + 1}-B`
          await store.publish({ assetId, generationId: activeGenerationId,
            terminalVerdict: 'accepted', files: {
              'run/report.json': JSON.stringify({ generationId: activeGenerationId, retentionDays: 30 }),
            } })
          let faultObserved = false
          try {
            await store.publish({ assetId, generationId: validatingGenerationId,
              terminalVerdict: 'accepted', faultAt: 'after-generation-durable', files: {
                'evidence/screenshot.png': Uint8Array.from([137, 80, 78, 71, index]),
                'evidence/trace.zip': Uint8Array.from([80, 75, 3, 4, index]),
                'run/report.json': JSON.stringify({ generationId: validatingGenerationId, retentionDays: 30 }),
              } })
          } catch (cause) {
            faultObserved = cause instanceof Error && 'code' in cause
              && (cause as Error & { code: string }).code === 'E2E_ARTIFACT_FAULT_INJECTED'
          }
          const validatingPath = join(artifactRoot, '.biztest', 'assets', assetId,
            'generations', validatingGenerationId)
          await store.setValidationReferences(assetId, [validatingGenerationId])
          await store.gcUsingPersistedValidationReferences(assetId)
          const persistedReferencePreserved = await exists(validatingPath)
          await store.setValidationReferences(assetId, [])
          await store.gcUsingPersistedValidationReferences(assetId)
          const persistedReferenceReleased = !await exists(validatingPath)
          const active = await store.readActive(assetId)
          artifactRetentionVerified &&= faultObserved && active?.generationId === activeGenerationId
            && persistedReferencePreserved && persistedReferenceReleased
            && JSON.parse(await readFile(join(active!.generationPath, 'run', 'report.json'), 'utf8')).generationId
              === activeGenerationId
        }
        phases[phase].samples.push({ ok: true, durationMs: performance.now() - started })
      } catch (cause) {
        phases[phase].samples.push({ ok: false, durationMs: performance.now() - started,
          reasonCode: reasonCode(cause) })
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const proof = createOperationalPerformanceProof({
  runner: {
    runnerId: process.env.E2E_OPERATIONAL_RUNNER_ID
      ?? `local-${platform()}-${arch()}-node${process.versions.node.split('.')[0]}`,
    stableResources,
    platform: platform(), arch: arch(), node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, totalMemoryBytes: totalmem(),
    baselineDigest: digestText('e2e-operational-baseline/v1', canonicalizeJson(baseline)),
  },
  sampleCount, phases, flakyRate: b2bProof.flakyRate,
  diagnosticRate: diagnosticTotal === 0 ? 0 : diagnosticCorrect / diagnosticTotal * 100,
  artifactRetentionVerified,
})
const outputPath = resolve(process.env.E2E_OPERATIONAL_OUTPUT
  ?? join(homedir(), '.mutil-skills', 'e2e', 'proofs', 'operational-performance-proof.json'))
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: proof.passed, gateEligible: proof.gateEligible,
  outputPath, proofDigest: proof.proofDigest })}\n`)
if (!proof.passed) process.exitCode = 1

async function runNode(source: string, argument: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => execFile(
    process.execPath, ['--input-type=module', '-e', source, argument],
    { cwd: process.cwd(), timeout: 10_000 },
    (error) => error === null ? resolvePromise() : rejectPromise(error),
  ))
}
function reasonCode(cause: unknown): string {
  const value = cause instanceof Error && 'code' in cause ? String((cause as Error & { code?: unknown }).code) : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(value) ? value : 'E2E_OPERATIONAL_SAMPLE_FAILED'
}

interface OperationalBaseline {
  schemaVersion: '1.0.0'; runnerName: string; platform: string; arch: string; nodeMajor: number
  browserChannel: string; cpuModel: string; minimumCpuCount: number; minimumMemoryBytes: number
  budgetsMs: Record<OperationalPerformancePhase, number>
}

async function loadOperationalBaseline(): Promise<OperationalBaseline> {
  const configured = process.env.E2E_OPERATIONAL_BASELINE
    ?? '.github/e2e-baselines/stable-macos-arm64-e2e-01.json'
  const baselineRoot = resolve('.github/e2e-baselines')
  const path = resolve(configured)
  if (!path.startsWith(`${baselineRoot}${sep}`)) throw new Error('E2E_OPERATIONAL_BASELINE_OUTSIDE_REPOSITORY')
  const candidate = JSON.parse(await readFile(path, 'utf8')) as OperationalBaseline
  if (candidate.schemaVersion !== '1.0.0'
    || Object.keys(candidate.budgetsMs ?? {}).sort().join(',')
      !== [...OPERATIONAL_PERFORMANCE_PHASES].sort().join(',')
    || Object.values(candidate.budgetsMs).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('E2E_OPERATIONAL_BASELINE_INVALID')
  }
  return candidate
}

function verifyStableRunnerBaseline(baseline: OperationalBaseline): boolean {
  const configured = process.env.E2E_STABLE_RUNNER_BASELINE
  if (configured === undefined || resolve(configured) !== resolve(
    process.env.E2E_OPERATIONAL_BASELINE ?? '.github/e2e-baselines/stable-macos-arm64-e2e-01.json')) return false
  return baseline.schemaVersion === '1.0.0'
    && baseline.runnerName === process.env.RUNNER_NAME
    && baseline.platform === platform() && baseline.arch === arch()
    && baseline.nodeMajor === Number(process.versions.node.split('.')[0])
    && baseline.browserChannel === (process.env.E2E_B2B_BROWSER_CHANNEL ?? 'chrome')
    && baseline.cpuModel === (cpus()[0]?.model ?? 'unknown')
    && cpus().length >= baseline.minimumCpuCount && totalmem() >= baseline.minimumMemoryBytes
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function createTufClient(homeDir: string, production: boolean): Promise<TufRuntimeUpdateClient> {
  if (production) {
    const trustedRootPath = process.env.E2E_TUF_TRUSTED_ROOT_PATH
    const metadataBaseUrl = process.env.E2E_TUF_METADATA_BASE_URL
    const targetBaseUrl = process.env.E2E_TUF_TARGET_BASE_URL
    const targetPath = process.env.E2E_TUF_TARGET_PATH
    if ([trustedRootPath, metadataBaseUrl, targetBaseUrl, targetPath].some((value) => value === undefined)) {
      throw new Error('E2E_STABLE_TUF_CONFIG_REQUIRED')
    }
    return new TufRuntimeUpdateClient({ homeDir, trustedRootPath: trustedRootPath!,
      metadataBaseUrl: metadataBaseUrl!, targetBaseUrl: targetBaseUrl!, targetPath: targetPath! })
  }
  const source = join(homeDir, 'fixture-source')
  await mkdir(source, { recursive: true })
  const trustedRootPath = join(source, 'root.json')
  const rootDocument = tufRootDocument()
  await writeFile(trustedRootPath, JSON.stringify(rootDocument))
  const targetPath = '@mutil-skills/e2e-runtime/-/e2e-runtime-0.7.0.tgz'
  const updaterFactory = (options: Record<string, unknown>): TufUpdaterLike => ({
    refresh: async () => {
      await mkdir(options.metadataDir as string, { recursive: true })
      for (const [roleName, version] of [['root', 1], ['timestamp', 2], ['snapshot', 3], ['targets', 4]] as const) {
        await writeFile(join(options.metadataDir as string, `${roleName}.json`), JSON.stringify(
          roleName === 'root' ? rootDocument : { signed: { _type: roleName, version,
            expires: '2027-08-09T00:00:00Z' } }))
      }
    },
    getTargetInfo: async () => ({ path: targetPath, length: 7,
      hashes: { sha512: Buffer.alloc(64, 1).toString('hex') }, custom: tufTargetCustom(targetPath) }),
    downloadTarget: async () => { throw new Error('E2E_OPERATIONAL_DOWNLOAD_NOT_EXPECTED') },
  })
  return new TufRuntimeUpdateClient({ homeDir, trustedRootPath,
    metadataBaseUrl: 'https://updates.example/metadata/', targetBaseUrl: 'https://registry.npmjs.org/',
    targetPath, updaterFactory })
}

function tufRootDocument() {
  return { signed: { _type: 'root', version: 1, expires: '2027-08-09T00:00:00Z',
    keys: Object.fromEntries(['ROOT-1', 'ROOT-2', 'ROOT-3', 'TARGETS-1', 'TARGETS-2', 'TARGETS-3']
      .map((keyId) => [keyId, { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: keyId } }])),
    roles: { root: { keyids: ['ROOT-1', 'ROOT-2', 'ROOT-3'], threshold: 2 },
      targets: { keyids: ['TARGETS-1', 'TARGETS-2', 'TARGETS-3'], threshold: 2 } } } }
}

function tufTargetCustom(targetPath: string) {
  return { schemaVersion: '1.0.0', packageName: '@mutil-skills/e2e-runtime', runtimeVersion: '0.7.0',
    protocolMajor: 1, channel: 'stable', npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    registryUrl: new URL(targetPath, 'https://registry.npmjs.org/').href,
    contentDigest: `sha256:${'1'.repeat(64)}`, executableDigest: `sha256:${'2'.repeat(64)}`,
    installationDigest: `sha256:${'3'.repeat(64)}`,
    supportedNode: [{ major: Number(process.versions.node.split('.')[0]), minimumPatch: process.versions.node }],
    supportedPlatforms: [{ platform: platform(), arch: arch() }], minimumBootstrapVersion: '0.6.0',
    revoked: false, revocationReasonCode: null }
}
