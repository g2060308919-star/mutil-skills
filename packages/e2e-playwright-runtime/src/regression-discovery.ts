import { execFile } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  E2EError,
  RegressionDiscoveryAttestationSchema,
  RegressionDiscoverySubjectSchema,
  RegressionDiscoveryVerifierMaterialSchema,
  canonicalizeJson,
  computeCompilerInputDigest,
  computeRegressionSourceSetDigest,
  digestBytes,
  digestText,
  findForbiddenRegressionTestDispositions,
  type RegressionDiscoveryAttestation,
  type RegressionDiscoverySubject,
  type RegressionDiscoveryVerifierMaterial,
} from '@mutil-skills/e2e-contracts'
import { compileReadOnlyProject } from './compiler.js'
import { inspectTrustedCompilerInput, TRUSTED_TYPESCRIPT_VERSION,
  type TrustedCompilerInput } from './compiler-input-projector.js'
import { assertExpectedRegressionSourceSet, readRegressionSourceSet } from './regression-source-set.js'
import { auditTrustedRegressionSourceSet } from './trusted-source-audit.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const DISCOVERY_COMMAND = ['node', '@playwright/test/cli', 'test', '--list', '--reporter=json'] as const
const SOURCE_ROOT = 'regression'
const DISCOVERY_PURPOSE = 'regression-discovery-attestation/v2' as const
export const TRUSTED_COMPILER_VERSION = '4.0.0'
export const TRUSTED_TEMPLATE_VERSION = '3.0.0'
export const READ_ONLY_COMPILER_DIGEST = digestText('controlled-regression-compiler/v4', `mutil-skills/controlled-regression-compiler/${TRUSTED_COMPILER_VERSION}`)
export const READ_ONLY_TEMPLATE_DIGEST = digestText('controlled-regression-template/v3', canonicalizeJson({
  version: TRUSTED_TEMPLATE_VERSION, files: ['README.md', 'package.json', 'package-lock.json', 'playwright.config.ts',
    'fixtures/safe-page.ts', 'tests/generated.spec.ts', 'run-bundle.json', 'safety-policy.json',
    'network-policy.json', 'evidence-policy.json', 'toolchain-manifest.json', 'template-manifest.json',
    'source-integrity.json'],
  actionKinds: ['assertText', 'reversibleWrite'], writeExecution: 'loopback-controlled-runner-bridge',
}))
export const FULL_PLAYWRIGHT_TEMPLATE_DIGEST = digestText('controlled-regression-template/full-playwright/v1', canonicalizeJson({
  version: TRUSTED_TEMPLATE_VERSION, files: ['README.md', 'package.json', 'package-lock.json', 'playwright.config.ts',
    'fixtures/full-playwright-runtime.ts', 'tests/generated.spec.ts', 'run-bundle.json', 'safety-policy.json', 'network-policy.json',
    'evidence-policy.json', 'toolchain-manifest.json', 'template-manifest.json', 'source-integrity.json'],
  executionProfile: 'full-playwright', actionKinds: ['fullPlaywright'],
  writeExecution: 'trusted-full-playwright-runtime',
}))

export interface CompileAndAttestRegressionInput {
  tempParent: string
  compilerInput: TrustedCompilerInput
}

export interface AttestedRegressionFile {
  relativePath: string
  bytes: Uint8Array
  digest: string
  byteLength: number
}

export interface CompileAndAttestRegressionResult {
  projectDir: string
  files: AttestedRegressionFile[]
  subject: RegressionDiscoverySubject
  attestation: RegressionDiscoveryAttestation
  isolationProof?: { backend: 'macos-sandbox-exec' | 'linux-bwrap'; proofDigest: string }
}

export interface RegressionDiscoverySandboxExecutor {
  execute(input: {
    command: string
    args: string[]
    cwd: string
    readOnlyRoots: string[]
    timeoutMs: number
  }): Promise<{
    backend: 'macos-sandbox-exec' | 'linux-bwrap'
    stdout: string
    stderr: string
    exitCode: number
    proofDigest: string
  }>
}

export class LocalRegressionDiscoveryAuthority {
  readonly #issuer: string
  readonly #keyId: string
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject
  readonly #sandboxExecutor?: RegressionDiscoverySandboxExecutor

  private constructor(issuer: string, keyId: string, privateKey: KeyObject, publicKey: KeyObject,
    sandboxExecutor?: RegressionDiscoverySandboxExecutor) {
    this.#issuer = issuer
    this.#keyId = keyId
    this.#privateKey = privateKey
    this.#publicKey = publicKey
    this.#sandboxExecutor = sandboxExecutor
  }

  static create(options: { issuer: string; keyId: string; sandboxExecutor?: RegressionDiscoverySandboxExecutor }): LocalRegressionDiscoveryAuthority {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(options.issuer) || !/^[A-Za-z0-9._:-]{1,256}$/.test(options.keyId)) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_AUTHORITY_INVALID', 'Discovery Authority 标识非法')
    }
    const keys = generateKeyPairSync('ed25519')
    return new LocalRegressionDiscoveryAuthority(
      options.issuer, options.keyId, keys.privateKey, keys.publicKey, options.sandboxExecutor,
    )
  }

  async compileAndAttest(candidate: CompileAndAttestRegressionInput): Promise<CompileAndAttestRegressionResult> {
    validateExactInput(candidate)
    let input
    try { input = inspectTrustedCompilerInput(candidate.compilerInput) } catch (cause) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_INPUT_INVALID', 'Discovery 只接受可信 Projector 产物', cause)
    }
    if (input.nodeVersion !== process.versions.node) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_TOOLCHAIN_MISMATCH',
        '冻结 Compiler Input 的 Node 版本与本地可信工具链不一致')
    }
    input.blockedCases.sort(byCaseId)
    await mkdir(candidate.tempParent, { recursive: true })
    const projectDir = await mkdtemp(join(candidate.tempParent, 'e2e-regression-discovery-'))
    let completed = false
    try {
    const compiled = await compileReadOnlyProject({ outputDir: projectDir, compilerInput: candidate.compilerInput })
    const generatedPaths = [...compiled.generatedFiles].sort()
    const files = await readRegressionSourceSet(projectDir, SOURCE_ROOT)
    assertExpectedRegressionSourceSet(files, generatedPaths, SOURCE_ROOT)
    verifyTrustedCompilerOutput(compiled.sourceDigests, files, projectDir)
    const executionProfile = input.executionProfile === 'full-playwright' ? 'full-playwright'
      : input.cases[0]!.actions[0]!.kind === 'reversibleWrite'
        ? 'trusted-reversible-write' : 'trusted-read-only'
    const sourceAudit = auditTrustedRegressionSourceSet(files, executionProfile)
    if (!sourceAudit.valid) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_SOURCE_UNSAFE', sourceAudit.findings
        .map((finding) => `${finding.relativePath}:${finding.code}:${finding.detail}`).join('|'))
    }
    const generatedSpec = files.find((file) => file.relativePath === `${SOURCE_ROOT}/tests/generated.spec.ts`)
    if (!generatedSpec || findForbiddenRegressionTestDispositions(Buffer.from(generatedSpec.bytes).toString('utf8')).length > 0) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_FORBIDDEN_DISPOSITION',
        '回归源码包含 skip/fixme/fail/only/todo，不能作为 blocked Case 的替代品')
    }

    const cliPath = require.resolve('@playwright/test/cli')
    const packagePath = require.resolve('@playwright/test/package.json')
    const [cliBytes, packageDocument] = await Promise.all([readFile(cliPath), readFile(packagePath, 'utf8')])
    const installedVersion = parseInstalledVersion(packageDocument)
    if (installedVersion !== input.playwrightVersion) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_TOOLCHAIN_MISMATCH', '请求的 Playwright 版本与本地可信 CLI 不一致')
    }
    let stdout: string
    let isolationProof: CompileAndAttestRegressionResult['isolationProof']
    const trustedModulesRoot = dirname(dirname(dirname(packagePath)))
    const moduleResolutionLink = join(projectDir, 'node_modules')
    // staging 位于 Git 外独立目录，不能依赖 cwd 的祖先 node_modules。此链接只用于
    // 可信 Playwright --list，目标同时作为沙箱只读根；源集已在创建链接前冻结审计。
    await symlink(trustedModulesRoot, moduleResolutionLink, 'dir')
    try {
    if (this.#sandboxExecutor !== undefined) {
      try {
        const result = await this.#sandboxExecutor.execute({
          command: process.execPath,
          args: [cliPath, 'test', '--list', '--reporter=json'],
          cwd: projectDir,
          readOnlyRoots: [projectDir, trustedModulesRoot, dirname(process.execPath)],
          timeoutMs: 30_000,
        })
        if (result.exitCode !== 0) throw discoveryError(
          classifyTrustedListFailure(result.stderr), 'OS 沙箱内 Playwright --list 返回非零状态',
        )
        stdout = result.stdout
        isolationProof = { backend: result.backend, proofDigest: result.proofDigest }
      } catch (cause) {
        if (cause instanceof E2EError) throw cause
        throw discoveryError('E2E_REGRESSION_DISCOVERY_LIST_FAILED', 'OS 沙箱内 Playwright --list 未成功', cause)
      }
    } else {
      const listHome = await mkdtemp(join(candidate.tempParent, 'e2e-regression-list-home-'))
      try {
        try {
        const result = await execFileAsync(process.execPath,
          [cliPath, 'test', '--list', '--reporter=json'], {
            cwd: projectDir, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
            env: sanitizedEnvironment(listHome), windowsHide: true,
          })
          stdout = result.stdout
        } catch (cause) {
          throw discoveryError('E2E_REGRESSION_DISCOVERY_LIST_FAILED', '隔离 Playwright --list 未成功', cause)
        }
      } finally {
        await rm(listHome, { recursive: true, force: true })
      }
    }
    } finally {
      await rm(moduleResolutionLink, { force: true })
    }
    const discovered = parseJsonReporter(stdout)
    const expectedCaseIds = [...input.cases.map((item) => item.caseId)].sort()
    if (!sameStrings(discovered.caseIds, expectedCaseIds)) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_CASE_MISMATCH', 'Playwright discovery 与受信编译输入不一致')
    }
    const caseMappings = input.cases.map((item) => ({ caseId: item.caseId,
      relativePath: `${SOURCE_ROOT}/tests/generated.spec.ts`, testTitle: item.title })).sort(byCaseId)
    const sourceFiles = files.map(({ relativePath, digest, byteLength, mediaType }) =>
      ({ relativePath, digest, byteLength, mediaType }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    const compilerInputDigest = computeCompilerInputDigest(input)
    const sourceSetDigest = computeRegressionSourceSetDigest(sourceFiles)
    const subject = RegressionDiscoverySubjectSchema.parse({
      schemaVersion: '2.0.0', testDomain: 'prd-e2e-trusted-compiler', executionProfile,
      assetId: input.assetId, generationId: input.generationId,
      prdRevision: input.prdRevision, compilerVersion: TRUSTED_COMPILER_VERSION,
      templateVersion: TRUSTED_TEMPLATE_VERSION, contractsVersion: input.contractsVersion,
      environmentId: input.environmentId, approvalDigest: input.approvalDigest, policyDigest: input.policyDigest,
      templateDigest: executionProfile === 'full-playwright'
        ? FULL_PLAYWRIGHT_TEMPLATE_DIGEST : READ_ONLY_TEMPLATE_DIGEST,
      compilerInputDigest,
      sourceFiles, caseMappings,
      toolchain: { nodeVersion: process.versions.node, playwrightVersion: installedVersion,
        typescriptVersion: TRUSTED_TYPESCRIPT_VERSION,
        compilerDigest: READ_ONLY_COMPILER_DIGEST, playwrightCliDigest: digestBytes('playwright-cli/v1', cliBytes) },
      isolation: { command: DISCOVERY_COMMAND, exitCode: 0,
        stdoutDigest: digestBytes('playwright-list-stdout/v1', Buffer.from(stdout, 'utf8')) },
      discoveredCaseIds: discovered.caseIds,
      blockedCases: [...input.blockedCases].sort(byCaseId), sourceSetDigest,
    })
    const signedDigest = digestText('regression-discovery-subject/v2', canonicalizeJson(subject))
    const attestation = RegressionDiscoveryAttestationSchema.parse({ ...subject, issuer: this.#issuer,
      keyId: this.#keyId, purpose: DISCOVERY_PURPOSE, algorithm: 'Ed25519', signedDigest,
      signature: sign(null, proofPayload(this.#issuer, this.#keyId, signedDigest), this.#privateKey).toString('base64url') })
      completed = true
      return { projectDir, files, subject, attestation, ...(isolationProof === undefined ? {} : { isolationProof }) }
    } finally {
      if (!completed) await rm(projectDir, { recursive: true, force: true })
    }
  }

  get verifierMaterial(): RegressionDiscoveryVerifierMaterial {
    const spki = this.#publicKey.export({ type: 'spki', format: 'der' })
    return RegressionDiscoveryVerifierMaterialSchema.parse({ schemaVersion: '1.0.0', issuer: this.#issuer,
      keyId: this.#keyId, purpose: DISCOVERY_PURPOSE, algorithm: 'Ed25519',
      publicKeySpkiBase64: spki.toString('base64'), publicKeyDigest: digestBytes('regression-discovery-public-key/v1', spki) })
  }
}

export function createRegressionDiscoveryVerifier(materialCandidate: RegressionDiscoveryVerifierMaterial,
  expectedPublicKeyDigest: string): (attestation: RegressionDiscoveryAttestation, subject: RegressionDiscoverySubject) => boolean {
  const material = RegressionDiscoveryVerifierMaterialSchema.safeParse(materialCandidate)
  if (!material.success || material.data.publicKeyDigest !== expectedPublicKeyDigest) return () => false
  let publicKey: KeyObject
  try {
    const spki = Buffer.from(material.data.publicKeySpkiBase64, 'base64')
    if (digestBytes('regression-discovery-public-key/v1', spki) !== material.data.publicKeyDigest) return () => false
    publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
  } catch { return () => false }
  return (attestationCandidate, subjectCandidate) => {
    const attestation = RegressionDiscoveryAttestationSchema.safeParse(attestationCandidate)
    const subject = RegressionDiscoverySubjectSchema.safeParse(subjectCandidate)
    if (!attestation.success || !subject.success) return false
    const { issuer, keyId, purpose, algorithm, signedDigest, signature, ...actualSubject } = attestation.data
    if (issuer !== material.data.issuer || keyId !== material.data.keyId || purpose !== material.data.purpose
      || algorithm !== material.data.algorithm || canonicalizeJson(actualSubject) !== canonicalizeJson(subject.data)) return false
    const expectedDigest = digestText('regression-discovery-subject/v2', canonicalizeJson(subject.data))
    if (signedDigest !== expectedDigest) return false
    try { return verify(null, proofPayload(issuer, keyId, signedDigest), publicKey, Buffer.from(signature, 'base64url')) }
    catch { return false }
  }
}

function validateExactInput(input: CompileAndAttestRegressionInput): void {
  const expected = ['compilerInput', 'tempParent']
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join('\0') !== expected.join('\0')) {
    throw discoveryError('E2E_REGRESSION_DISCOVERY_INPUT_INVALID', 'Discovery 只接受 Projector token，不接受 caller 源码或 Case IDs')
  }
}

function verifyTrustedCompilerOutput(sourceDigests: Record<string, string>, files: AttestedRegressionFile[], projectDir: string): void {
  for (const [localPath, expectedDigest] of Object.entries(sourceDigests)) {
    const file = files.find((candidate) => candidate.relativePath === `${SOURCE_ROOT}/${localPath}`)
    if (!file) throw discoveryError('E2E_REGRESSION_DISCOVERY_COMPILER_OUTPUT_INVALID', `编译器输出缺失：${localPath}`)
    const generatedDigest = digestBytes(`generated-source:${localPath}`, file.bytes)
    if (generatedDigest !== expectedDigest) {
      throw discoveryError('E2E_REGRESSION_DISCOVERY_COMPILER_OUTPUT_INVALID', `编译器输出摘要不一致：${projectDir}/${localPath}`)
    }
  }
}

function parseInstalledVersion(text: string): string {
  try {
    const value = JSON.parse(text) as { version?: unknown }
    if (typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version)) return value.version
  } catch { /* 转为统一错误。 */ }
  throw discoveryError('E2E_REGRESSION_DISCOVERY_TOOLCHAIN_INVALID', '无法读取本地 Playwright 版本')
}

function parseJsonReporter(stdout: string): { caseIds: string[] } {
  let report: unknown
  try { report = JSON.parse(stdout) } catch (cause) {
    throw discoveryError('E2E_REGRESSION_DISCOVERY_REPORT_INVALID', 'Playwright JSON reporter 输出无效', cause)
  }
  const titles: string[] = []
  visit(report)
  const caseIds = titles.map((title) => /^([A-Za-z0-9._:-]+)(?:\s|$)/.exec(title)?.[1] ?? '')
  if (caseIds.some((id) => id === '') || new Set(caseIds).size !== caseIds.length) {
    throw discoveryError('E2E_REGRESSION_DISCOVERY_REPORT_INVALID', 'Playwright list 标题缺少唯一 Case ID')
  }
  return { caseIds: caseIds.sort() }

  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (Array.isArray(record.tests) && typeof record.title === 'string') titles.push(record.title)
    for (const nested of Object.values(record)) visit(nested)
  }
}

function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, CI: '1', NO_PROXY: '*', no_proxy: '*',
    npm_config_offline: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', FORCE_COLOR: '0' }
}

function proofPayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ purpose: DISCOVERY_PURPOSE, issuer, keyId, signedDigest }))
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function byCaseId(left: { caseId: string }, right: { caseId: string }): number {
  return left.caseId.localeCompare(right.caseId)
}

function discoveryError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'automation', message: `${code}: ${message}`, retryable: false, cause })
}

function classifyTrustedListFailure(stderr: string): string {
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/i.test(stderr)) {
    return 'E2E_REGRESSION_DISCOVERY_MODULE_RESOLUTION_FAILED'
  }
  if (/Operation not permitted|Permission denied|EACCES|EPERM|sandbox/i.test(stderr)) {
    return 'E2E_REGRESSION_DISCOVERY_SANDBOX_POLICY_DENIED'
  }
  if (/No tests found/i.test(stderr)) return 'E2E_REGRESSION_DISCOVERY_NO_TESTS'
  return 'E2E_REGRESSION_DISCOVERY_LIST_EXIT_NONZERO'
}
