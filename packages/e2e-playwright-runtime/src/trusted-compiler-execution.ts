import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import {
  E2EError,
  RegressionDiscoveryAttestationSchema,
  RegressionDiscoverySubjectSchema,
  ApprovalFreshnessReceiptSchema,
  canonicalizeJson,
  computeRegressionSourceSetDigest,
  digestBytes,
  digestText,
  TrustedCompilerExecutionFactSchema,
  type TrustedCompilerExecutionFact,
  type RegressionDiscoveryAttestation,
  type RegressionDiscoverySubject,
} from '@mutil-skills/e2e-contracts'
import { READ_ONLY_COMPILER_DIGEST, READ_ONLY_TEMPLATE_DIGEST,
  TRUSTED_COMPILER_VERSION, TRUSTED_TEMPLATE_VERSION } from './regression-discovery.js'
import { assertExpectedRegressionSourceSet, readRegressionSourceSet } from './regression-source-set.js'
import { auditTrustedRegressionSourceSet } from './trusted-source-audit.js'
import {
  getExecutionTrustBinding,
  verifyExecutionApprovalCurrent,
  type TrustedCompilerExecutionTrust,
} from './trusted-compiler-trust.js'
import {
  registerTrustedCompilerWriteRuntimeSession,
  revokeTrustedCompilerWriteRuntimeSession,
  type TrustedWriteRuntimeSession,
} from './production-isolation.js'
import {
  getTrustedCompilerControlledWriteBridgeBinding,
  type TrustedCompilerControlledWriteBridgeHandle,
} from './trusted-write-bridge-capability.js'
import {
  getTrustedCompilerControlledReadBridgeBinding,
  type TrustedCompilerControlledReadBridgeHandle,
} from './trusted-read-bridge-capability.js'

export interface TrustedCompilerRunSession extends TrustedWriteRuntimeSession {}

export interface TrustedCompilerRunBinding {
  testDomain: 'prd-e2e-trusted-compiler'
  executionProfile: 'trusted-read-only' | 'trusted-reversible-write' | 'production-isolated'
  assetId: string
  generationId: string
  prdRevision: string
  runId: string
  approvalDigest: string
  compilerInputDigest: string
  sourceSetDigest: string
  baseOrigin: string
  caseIds: string[]
  actionIds: string[]
  caseActions: Array<{ caseId: string; actionIds: string[] }>
}

export interface PrepareTrustedCompilerRunRequest {
  projectDir: string
  trust: TrustedCompilerExecutionTrust
  subject: RegressionDiscoverySubject
  attestation: RegressionDiscoveryAttestation
  expected: {
    assetId: string
    generationId: string
    prdRevision: string
    runId: string
    approvalDigest: string
    executionProfile: 'trusted-read-only' | 'trusted-reversible-write' | 'production-isolated'
  }
  authorityTransport: 'in-process-test' | 'authenticated-rpc'
  authorityRpcPublicKeyDigest?: string
}

interface TrustedCompilerRunRecord {
  binding: TrustedCompilerRunBinding
  sourceFiles: Awaited<ReturnType<typeof readRegressionSourceSet>>
  trust: NonNullable<ReturnType<typeof getExecutionTrustBinding>>
  subject: RegressionDiscoverySubject
  cliPath: string
  consumed: boolean
  readLauncherClaimed: boolean
  writeLauncherClaimed: boolean
}

const sessions = new WeakMap<object, TrustedCompilerRunRecord>()
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const trustedExecutionParent = join(
  dirname(dirname(dirname(dirname(require.resolve('@playwright/test/package.json'))))),
  '.tmp', '.trusted-execution',
)

export async function prepareTrustedCompilerRun(
  request: PrepareTrustedCompilerRunRequest,
): Promise<TrustedCompilerRunSession> {
  assertExactRequest(request)
  const trust = getExecutionTrustBinding(request.trust)
  if (!trust) throw runError('E2E_RUN_TRUST_INVALID', '执行器缺少受信 Host 启动期固定的信任根')
  const subject = RegressionDiscoverySubjectSchema.parse(request.subject)
  const attestation = RegressionDiscoveryAttestationSchema.parse(request.attestation)
  let signatureValid = false
  try { signatureValid = trust.verifyDiscovery(attestation, subject) } catch { signatureValid = false }
  if (!signatureValid) throw runError('E2E_RUN_ATTESTATION_INVALID', 'Discovery 专用证明验签失败')
  const expected = request.expected
  if (subject.testDomain !== 'prd-e2e-trusted-compiler'
    || subject.assetId !== expected.assetId || subject.generationId !== expected.generationId
    || subject.prdRevision !== expected.prdRevision || subject.approvalDigest !== expected.approvalDigest
    || subject.executionProfile !== expected.executionProfile) {
    throw runError('E2E_RUN_BINDING_MISMATCH', 'Run 与 Discovery subject 的代际、审批或 Profile 不一致')
  }
  if (request.authorityTransport === 'authenticated-rpc'
    && !/^sha256:[a-f0-9]{64}$/.test(request.authorityRpcPublicKeyDigest ?? '')) {
    throw runError('E2E_RUN_AUTHORITY_TRANSPORT_INVALID', 'authenticated-rpc 缺少 Authority 公钥摘要')
  }
  if (request.authorityTransport === 'authenticated-rpc'
    && trust.approvalFreshnessClientKind !== 'authority-state') {
    throw runError('E2E_RUN_AUTHORITY_TRANSPORT_INVALID', 'authenticated-rpc 不接受 test-only freshness client')
  }
  const actualFiles = await readRegressionSourceSet(request.projectDir, 'regression')
  const actualSourceFiles = actualFiles.map(({ relativePath, digest, byteLength, mediaType }) =>
    ({ relativePath, digest, byteLength, mediaType }))
  if (canonicalizeJson(actualSourceFiles) !== canonicalizeJson(subject.sourceFiles)
    || computeRegressionSourceSetDigest(actualSourceFiles) !== subject.sourceSetDigest) {
    const expectedPaths = subject.sourceFiles.map((file) => file.relativePath)
    const actualPaths = actualSourceFiles.map((file) => file.relativePath)
    throw runError('E2E_RUN_SOURCE_CHANGED', `Discovery 后 Source Set 已变化；expected=${expectedPaths.join(',')} actual=${actualPaths.join(',')}`)
  }
  await assertTrustedToolchain(subject, trust)
  const runBundle = parseRunBundle(await readFile(join(request.projectDir, 'run-bundle.json'), 'utf8'))
  if (runBundle.assetId !== subject.assetId || runBundle.generationId !== subject.generationId
    || runBundle.prdRevision !== subject.prdRevision || runBundle.runId !== expected.runId) {
    throw runError('E2E_RUN_BINDING_MISMATCH', '生成 Run Bundle 与 Discovery subject 不一致')
  }
  const caseIds = strings(runBundle.caseIds).sort()
  const discoveredCaseIds = [...subject.discoveredCaseIds].sort()
  if (canonicalizeJson(caseIds) !== canonicalizeJson(discoveredCaseIds)) {
    throw runError('E2E_RUN_BINDING_MISMATCH', 'Run Bundle Case 与 Discovery 不闭合')
  }
  const approvalReceipt = ApprovalFreshnessReceiptSchema.safeParse(runBundle.approvalFreshnessReceipt)
  if (runBundle.approvalDigest !== subject.approvalDigest || !approvalReceipt.success
    || !verifyExecutionApprovalCurrent(trust, approvalReceipt.data)) {
    throw runError('E2E_RUN_APPROVAL_NOT_CURRENT', 'fresh Run 执行前审批已过期、撤销、换代或签名无效')
  }
  const caseActions = records(runBundle.cases).map((testCase) => ({
    caseId: text(testCase.caseId),
    actionIds: records(testCase.actions).map((action) => text(action.actionId)).sort(),
  })).sort((left, right) => left.caseId.localeCompare(right.caseId))
  const actionIds = caseActions.flatMap((item) => item.actionIds).sort()
  if (new Set(actionIds).size !== actionIds.length) {
    throw runError('E2E_RUN_BINDING_MISMATCH', 'Run Bundle actionId 不得重复')
  }
  if (canonicalizeJson(caseActions.map((item) => item.caseId)) !== canonicalizeJson(caseIds)) {
    throw runError('E2E_RUN_BINDING_MISMATCH', 'Run Bundle Case→Action 映射与 Case 集合不闭合')
  }
  const binding: TrustedCompilerRunBinding = {
    testDomain: subject.testDomain,
    executionProfile: subject.executionProfile,
    assetId: subject.assetId,
    generationId: subject.generationId,
    prdRevision: subject.prdRevision,
    runId: text(runBundle.runId),
    approvalDigest: subject.approvalDigest,
    compilerInputDigest: subject.compilerInputDigest,
    sourceSetDigest: subject.sourceSetDigest,
    baseOrigin: text(runBundle.baseOrigin),
    caseIds,
    actionIds,
    caseActions,
  }
  const session = Object.freeze({})
  sessions.set(session, { binding: structuredClone(binding),
    sourceFiles: actualFiles.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) })),
    trust, subject: structuredClone(subject), cliPath: require.resolve('@playwright/test/cli'),
    consumed: false, readLauncherClaimed: false, writeLauncherClaimed: false })
  registerTrustedCompilerWriteRuntimeSession(session, {
    mode: 'trusted-compiler', sandboxHealthy: true, gatewayConnected: true,
    authorityTransport: request.authorityTransport,
    ...(request.authorityRpcPublicKeyDigest === undefined
      ? {} : { authorityRpcPublicKeyDigest: request.authorityRpcPublicKeyDigest }),
    runId: text(runBundle.runId), sourceDigest: subject.sourceSetDigest,
  })
  return session
}

export function getTrustedCompilerRunBinding(value: unknown): TrustedCompilerRunBinding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = sessions.get(value)
  return record ? structuredClone(record.binding) : undefined
}

/** @internal 由可信写 launcher 单次认领；防止一个 Run session 派生多个写执行入口。 */
export function claimTrustedCompilerWriteLauncherSession(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = sessions.get(value)
  if (!record || record.consumed || record.writeLauncherClaimed
    || record.binding.executionProfile !== 'trusted-reversible-write') return false
  record.writeLauncherClaimed = true
  return true
}

/** @internal 由可信只读 launcher 单次认领；同一 Run 只能建立一个受控浏览器执行入口。 */
export function claimTrustedCompilerReadLauncherSession(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = sessions.get(value)
  if (!record || record.consumed || record.readLauncherClaimed
    || record.binding.executionProfile !== 'trusted-read-only') return false
  record.readLauncherClaimed = true
  return true
}

export interface ExecuteTrustedCompilerProjectRequest {
  session: TrustedCompilerRunSession
  readBridge?: TrustedCompilerControlledReadBridgeHandle
  writeBridge?: TrustedCompilerControlledWriteBridgeHandle
  timeoutMs?: number
}

export interface ExecuteTrustedCompilerProjectResult {
  exitCode: number
  stdout: string
  stderr: string
  execution: TrustedCompilerExecutionFact
}

export async function discardTrustedCompilerRun(session: TrustedCompilerRunSession): Promise<void> {
  const record = sessions.get(session as object)
  if (!record) return
  sessions.delete(session as object)
  revokeTrustedCompilerWriteRuntimeSession(session as object)
}

export async function executeTrustedCompilerProject(
  request: ExecuteTrustedCompilerProjectRequest,
): Promise<ExecuteTrustedCompilerProjectResult> {
  if (!request || typeof request !== 'object'
    || !Object.prototype.hasOwnProperty.call(request, 'session')
    || Object.keys(request).some((key) => !['session', 'readBridge', 'timeoutMs', 'writeBridge'].includes(key))) {
    throw runError('E2E_RUN_INPUT_INVALID', '固定 launcher 输入字段非法')
  }
  const record = sessions.get(request.session as object)
  if (!record || record.consumed) throw runError('E2E_RUN_SESSION_INVALID', '可信 Run session 不存在或已消费')
  if (record.binding.executionProfile === 'trusted-reversible-write' && !record.writeLauncherClaimed) {
    throw runError('E2E_RUN_WRITE_LAUNCHER_REQUIRED', '可逆写 session 尚未由唯一受控 launcher 认领')
  }
  if (record.binding.executionProfile === 'trusted-read-only' && !record.readLauncherClaimed) {
    throw runError('E2E_RUN_READ_LAUNCHER_REQUIRED', '只读 session 尚未由唯一受控 launcher 认领')
  }
  record.consumed = true
  const bridge = getTrustedCompilerControlledWriteBridgeBinding(request.writeBridge)
  const readBridge = getTrustedCompilerControlledReadBridgeBinding(request.readBridge)
  const isRead = record.binding.executionProfile === 'trusted-read-only'
  const validRead = isRead && request.writeBridge === undefined && readBridge?.session === request.session
  const validWrite = !isRead && request.readBridge === undefined && bridge?.session === request.session
  if (!validRead && !validWrite) {
    sessions.delete(request.session as object)
    revokeTrustedCompilerWriteRuntimeSession(request.session as object)
    throw runError('E2E_RUN_ENVIRONMENT_INVALID', '固定 launcher 只接受当前 Profile 的最小运行环境')
  }
  let executionDir = ''
  let runtimeDir = ''
  const runtimeEnvironment: Record<string, string> = isRead
    ? { BIZTEST_CONTROLLED_READ_BRIDGE: readBridge!.endpoint, BIZTEST_RUN_GATE: readBridge!.runGate }
    : {
      BIZTEST_CONTROLLED_WRITE_BRIDGE: bridge!.endpoint,
      BIZTEST_RUN_GATE: bridge!.runGate,
      BIZTEST_EXECUTION_OUTCOME_VERIFIER: Buffer.from(JSON.stringify(
        bridge!.executionOutcomeVerifierMaterial,
      )).toString('base64url'),
    }
  try {
    await assertTrustedToolchain(record.subject, record.trust)
    executionDir = await createExecutionSnapshot(record.sourceFiles, record.binding.executionProfile)
    runtimeDir = await mkdtemp(join(tmpdir(), 'mutil-e2e-runtime-'))
    const result = await execFileAsync(process.execPath, [record.cliPath, 'test', '--reporter=json'], {
      cwd: executionDir, encoding: 'utf8', timeout: request.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: runtimeDir, TMPDIR: runtimeDir,
        CI: '1', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', npm_config_offline: 'true',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', FORCE_COLOR: '0', BIZTEST_RUN_BUNDLE: 'run-bundle.json',
        BIZTEST_RUNTIME_OUTPUT_DIR: runtimeDir,
        BIZTEST_BROWSER_PROXY: record.trust.gatewayProxyEndpoint,
        BIZTEST_CHROME_EXECUTABLE: record.trust.browserExecutablePath,
        ...runtimeEnvironment },
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr,
      execution: buildExecutionFact(record, 0, result.stdout, result.stderr) }
  } catch (cause) {
    const failed = cause as Error & { stdout?: string; stderr?: string }
    const processFailure = cause as { code?: unknown; killed?: unknown; signal?: unknown }
    if (typeof processFailure.code === 'number' && processFailure.code > 0
      && processFailure.killed !== true && processFailure.signal == null) {
      const stdout = failed.stdout ?? ''
      const stderr = failed.stderr ?? ''
      return { exitCode: processFailure.code, stdout, stderr,
        execution: buildExecutionFact(record, processFailure.code, stdout, stderr) }
    }
    throw runError('E2E_RUN_EXECUTION_FAILED',
      `${failed.message}\nstdout:\n${failed.stdout ?? ''}\nstderr:\n${failed.stderr ?? ''}`, cause)
  } finally {
    sessions.delete(request.session as object)
    revokeTrustedCompilerWriteRuntimeSession(request.session as object)
    if (executionDir) await removeExecutionSnapshot(executionDir, record.sourceFiles)
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true })
  }
}

function buildExecutionFact(
  record: TrustedCompilerRunRecord,
  exitCode: number,
  stdout: string,
  stderr: string,
): TrustedCompilerExecutionFact {
  let report: unknown
  try { report = JSON.parse(stdout) } catch {
    throw runError('E2E_RUN_REPORT_INVALID', '固定 Playwright JSON reporter 未返回合法 JSON')
  }
  const statuses = new Map<string, 'passed' | 'failed'>()
  visit(report)
  const caseResults = [...record.binding.caseIds].sort().map((caseId) => {
    const status = statuses.get(caseId)
    if (!status) throw runError('E2E_RUN_REPORT_INVALID', `JSON reporter 缺少 ${caseId}`)
    return { caseId, status }
  })
  return TrustedCompilerExecutionFactSchema.parse({
    schemaVersion: '1.0.0', runId: record.binding.runId,
    compilerInputDigest: record.binding.compilerInputDigest,
    sourceSetDigest: record.binding.sourceSetDigest,
    approvalDigest: record.binding.approvalDigest,
    browserExecutableDigest: record.trust.browserExecutableDigest,
    gatewayProxyEndpointDigest: digestText('trusted-gateway-proxy-endpoint/v1', record.trust.gatewayProxyEndpoint),
    exitCode, stdoutDigest: digestText('trusted-compiler-execution-stdout/v1', stdout),
    stderrDigest: digestText('trusted-compiler-execution-stderr/v1', stderr), caseResults,
  })

  function visit(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    if (typeof item.title === 'string' && Array.isArray(item.tests)) {
      const title = item.title
      const caseId = record.binding.caseIds.find((candidate) =>
        title === candidate || title.startsWith(`${candidate} `))
      if (caseId) {
        const testStatuses = item.tests.flatMap((test) => {
          if (!test || typeof test !== 'object') return []
          const testRecord = test as Record<string, unknown>
          if (!Array.isArray(testRecord.results)) return []
          return testRecord.results.map((result) => result && typeof result === 'object'
            ? (result as Record<string, unknown>).status : undefined)
        })
        statuses.set(caseId, testStatuses.length > 0 && testStatuses.every((status) => status === 'passed')
          ? 'passed' : 'failed')
      }
    }
    for (const child of Object.values(item)) visit(child)
  }
}

async function assertTrustedToolchain(
  subject: RegressionDiscoverySubject,
  trust: NonNullable<ReturnType<typeof getExecutionTrustBinding>>,
): Promise<void> {
  const cliPath = require.resolve('@playwright/test/cli')
  const packagePath = require.resolve('@playwright/test/package.json')
  const [cliBytes, packageText, browserBytes] = await Promise.all([
    readFile(cliPath), readFile(packagePath, 'utf8'), readFile(trust.browserExecutablePath),
  ])
  let installedVersion = ''
  try { installedVersion = (JSON.parse(packageText) as { version?: string }).version ?? '' } catch {}
  if (subject.compilerVersion !== TRUSTED_COMPILER_VERSION
    || subject.templateVersion !== TRUSTED_TEMPLATE_VERSION
    || subject.templateDigest !== READ_ONLY_TEMPLATE_DIGEST
    || subject.toolchain.compilerDigest !== READ_ONLY_COMPILER_DIGEST
    || subject.toolchain.nodeVersion !== process.versions.node
    || subject.toolchain.playwrightVersion !== installedVersion
    || subject.toolchain.playwrightCliDigest !== digestBytes('playwright-cli/v1', cliBytes)
    || trust.browserExecutableDigest !== digestBytes('trusted-browser-executable/v1', browserBytes)) {
    throw runError('E2E_RUN_TOOLCHAIN_CHANGED', '执行前本地 Compiler、模板、Node 或 Playwright CLI 已变化')
  }
}

async function createExecutionSnapshot(
  sourceFiles: Awaited<ReturnType<typeof readRegressionSourceSet>>,
  profile: TrustedCompilerRunBinding['executionProfile'],
): Promise<string> {
  await mkdir(trustedExecutionParent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(trustedExecutionParent, 'run-'))
  try {
    const directories = new Set<string>([root])
    for (const file of sourceFiles) {
      const localPath = file.relativePath.replace(/^regression\//, '')
      const target = join(root, localPath)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      let current = dirname(target)
      while (current.startsWith(root)) {
        directories.add(current)
        if (current === root) break
        current = dirname(current)
      }
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 })
    }
    const copied = await readRegressionSourceSet(root, 'regression')
    assertExpectedRegressionSourceSet(copied,
      sourceFiles.map((file) => file.relativePath.replace(/^regression\//, '')))
    const copiedFacts = copied.map(({ relativePath, digest, byteLength, mediaType }) =>
      ({ relativePath, digest, byteLength, mediaType }))
    const sourceFacts = sourceFiles.map(({ relativePath, digest, byteLength, mediaType }) =>
      ({ relativePath, digest, byteLength, mediaType }))
    if (canonicalizeJson(copiedFacts) !== canonicalizeJson(sourceFacts)) {
      throw runError('E2E_RUN_SOURCE_CHANGED', '私有执行快照与已验证 Source Set 不一致')
    }
    const audit = auditTrustedRegressionSourceSet(copied.map((file) => ({
      relativePath: file.relativePath, bytes: file.bytes,
    })), profile === 'trusted-reversible-write' ? 'trusted-reversible-write' : 'trusted-read-only')
    if (!audit.valid) throw runError('E2E_RUN_SOURCE_UNSAFE', canonicalizeJson(audit.findings))
    for (const file of copied) await chmod(join(root, file.relativePath.replace(/^regression\//, '')), 0o400)
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await chmod(directory, 0o500)
    }
    return root
  } catch (cause) {
    await removeExecutionSnapshot(root, sourceFiles)
    throw cause
  }
}

async function removeExecutionSnapshot(
  root: string,
  sourceFiles: Awaited<ReturnType<typeof readRegressionSourceSet>>,
): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined)
  const directories = new Set<string>([root])
  for (const file of sourceFiles) {
    const target = join(root, file.relativePath.replace(/^regression\//, ''))
    let current = dirname(target)
    while (current.startsWith(root)) {
      directories.add(current)
      if (current === root) break
      current = dirname(current)
    }
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    await chmod(directory, 0o700).catch(() => undefined)
  }
  await rm(root, { recursive: true, force: true })
}

function assertExactRequest(request: PrepareTrustedCompilerRunRequest): void {
  const expectedKeys = ['attestation', 'authorityRpcPublicKeyDigest', 'authorityTransport',
    'expected', 'projectDir', 'subject', 'trust']
  const actualKeys = Object.keys(request).sort()
  const allowedWithoutOptional = expectedKeys.filter((key) => key !== 'authorityRpcPublicKeyDigest')
  if (!request || typeof request !== 'object'
    || (actualKeys.join('\0') !== expectedKeys.join('\0')
      && actualKeys.join('\0') !== allowedWithoutOptional.join('\0'))
    || Object.keys(request.expected).sort().join('\0')
      !== ['approvalDigest', 'assetId', 'executionProfile', 'generationId', 'prdRevision', 'runId'].join('\0')) {
    throw runError('E2E_RUN_INPUT_INVALID', '执行前复验输入字段不满足严格契约')
  }
}

function parseRunBundle(textValue: string): Record<string, unknown> {
  try {
    const value = JSON.parse(textValue) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object')
    return value as Record<string, unknown>
  } catch (cause) {
    throw runError('E2E_RUN_BUNDLE_INVALID', '生成 Run Bundle 不是合法 JSON 对象', cause)
  }
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw runError('E2E_RUN_BUNDLE_INVALID', 'Run Bundle 对象数组字段非法')
  }
  return value as Record<string, unknown>[]
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw runError('E2E_RUN_BUNDLE_INVALID', 'Run Bundle 字符串数组字段非法')
  }
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw runError('E2E_RUN_BUNDLE_INVALID', 'Run Bundle ID 非法')
  return value
}

function runError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'safety', message: `${code}: ${message}`, retryable: false, cause })
}
