import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E2EError,
  digestText,
  findForbiddenRegressionTestDispositions,
  type CompilerInputV1,
} from '@mutil-skills/e2e-contracts'
import { inspectTrustedCompilerInput, TRUSTED_TYPESCRIPT_VERSION,
  type TrustedCompilerInput } from './compiler-input-projector.js'
import { validateFullPlaywrightFunctionBody } from './full-playwright-source-validation.js'
import { assertFreshOutputRoot } from './regression-source-set.js'
import { auditTrustedRegressionSourceSet } from './trusted-source-audit.js'

type CompilerAction = CompilerInputV1['cases'][number]['actions'][number]

export interface CompileTrustedProjectInput {
  outputDir: string
  compilerInput: TrustedCompilerInput
}

export interface CompileTrustedProjectResult {
  generatedFiles: string[]
  sourceDigests: Record<string, string>
}

export type CompileReadOnlyProjectInput = CompileTrustedProjectInput
export type CompileReadOnlyProjectResult = CompileTrustedProjectResult

export async function compileTrustedProject(input: CompileTrustedProjectInput): Promise<CompileTrustedProjectResult> {
  if (!input || typeof input !== 'object'
    || Object.keys(input).sort().join('\0') !== ['compilerInput', 'outputDir'].join('\0')) {
    throw compilerError('Compiler 只接受可信 Projector 输入与输出目录')
  }
  const compilerInput = inspectTrustedCompilerInput(input.compilerInput)
  await assertFreshOutputRoot(input.outputDir)
  const blockedCases = [...compilerInput.blockedCases].sort((left, right) => left.caseId.localeCompare(right.caseId))
  const files = new Map<string, string>()
  files.set('package.json', prettyJson({
    name: `biztest-${slug(compilerInput.assetId)}`,
    private: true,
    type: 'module',
    scripts: { test: 'playwright test' },
    devDependencies: { '@playwright/test': compilerInput.playwrightVersion },
  }))
  files.set('package-lock.json', prettyJson({
    name: `biztest-${slug(compilerInput.assetId)}`, version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: `biztest-${slug(compilerInput.assetId)}`, version: '0.0.0',
      devDependencies: { '@playwright/test': compilerInput.playwrightVersion } } },
  }))
  files.set('playwright.config.ts', [
    "import { defineConfig } from '@playwright/test'",
    "import process from 'node:process'",
    '',
    "const executablePath = process.env.BIZTEST_CHROME_EXECUTABLE",
    "const proxyServer = process.env.BIZTEST_BROWSER_PROXY",
    "const outputDir = process.env.BIZTEST_RUNTIME_OUTPUT_DIR",
    "export default defineConfig({ testDir: './tests', fullyParallel: false,",
    "  outputDir,",
    "  use: { launchOptions: executablePath ? { executablePath } : {},",
    "    proxy: proxyServer ? { server: proxyServer } : undefined } })",
    '',
  ].join('\n'))
  const writeMode = compilerInput.cases.some((testCase) => testCase.actions.some((action) => action.kind === 'reversibleWrite'))
  const fullPlaywrightMode = compilerInput.executionProfile === 'full-playwright'
  if (fullPlaywrightMode) assertFullPlaywrightFragments(compilerInput)
  if (!fullPlaywrightMode) files.set('fixtures/safe-page.ts', renderSafePageFixture(writeMode))
  else files.set('fixtures/full-playwright-runtime.ts', renderFullPlaywrightRuntime())
  const generatedSpec = fullPlaywrightMode ? renderFullPlaywrightSpec(compilerInput) : renderSpec(compilerInput)
  if (findForbiddenRegressionTestDispositions(generatedSpec).length > 0) {
    throw compilerError('受信编译器不得生成 skip/fixme/fail/only/todo 测试')
  }
  files.set('tests/generated.spec.ts', generatedSpec)
  files.set('README.md', renderReadme(compilerInput, writeMode, fullPlaywrightMode))
  files.set('safety-policy.json', prettyJson({
    schemaVersion: '1.0.0', failClosed: true, runGateRequired: true,
    directBusinessPageAccess: fullPlaywrightMode, nativeNetworkForbidden: true,
    executionOutcomeReceipt: fullPlaywrightMode || writeMode
      ? 'independent-ed25519-verification-required' : 'not-applicable',
    readExecution: fullPlaywrightMode ? 'not-applicable' : writeMode ? 'not-applicable' : 'loopback-controlled-runner-bridge',
    writeExecution: fullPlaywrightMode ? 'trusted-full-playwright-runtime'
      : writeMode ? 'loopback-controlled-runner-bridge' : 'not-applicable',
    ...(fullPlaywrightMode ? {
      executionProfile: 'full-playwright', programTimeoutOutcome: 'unknown',
      programTimeoutContext: 'retired-before-cleanup', sameContextCleanupAfterProgramTimeout: 'forbidden',
      leaseAfterProgramTimeout: 'quarantine', retryAfterProgramTimeout: 'forbidden',
      independentCleanupSession: 'task4-required',
    } : {}),
  }))
  files.set('network-policy.json', prettyJson({
    schemaVersion: '1.0.0', transport: 'external-safety-gateway',
    browserDirectEgress: 'forbidden', allowedBridge: fullPlaywrightMode
      ? { protocol: 'gateway-proxy', authorization: 'frozen-program-request-set' }
      : writeMode
      ? { protocol: 'http:', hostname: '127.0.0.1', exactPath: '/v1/reversible-write' }
      : { protocol: 'http:', hostname: '127.0.0.1', exactPath: '/v1/read-assertion' },
    ...(fullPlaywrightMode ? { executionProfile: 'full-playwright' } : {}),
  }))
  files.set('evidence-policy.json', prettyJson({
    schemaVersion: '1.0.0', required: ['screenshot', 'dom', 'gateway-audit'],
    sanitizationRequired: true, rawEvidencePublication: 'forbidden',
  }))
  files.set('toolchain-manifest.json', prettyJson({
    schemaVersion: '1.0.0', node: `v${compilerInput.nodeVersion}`, playwright: compilerInput.playwrightVersion,
    typescriptVersion: TRUSTED_TYPESCRIPT_VERSION,
    packageManager: 'npm-lockfile-v3', installScripts: 'forbidden',
  }))
  files.set('template-manifest.json', prettyJson({
    schemaVersion: '1.0.0', template: 'mutil-skills-controlled-regression', templateVersion: '2.3.0',
    actionKinds: fullPlaywrightMode ? ['fullPlaywright'] : writeMode ? ['reversibleWrite'] : ['assertText'],
    ...(fullPlaywrightMode ? { executionProfile: 'full-playwright' } : {}),
  }))
  files.set('run-bundle.json', prettyJson({
    schemaVersion: '1.0.0',
    assetId: compilerInput.assetId,
    runId: compilerInput.runId,
    prdRevision: compilerInput.prdRevision,
    scopeDigest: compilerInput.scopeDigest,
    lineageDecisionDigest: compilerInput.lineageDecisionDigest,
    generationId: compilerInput.generationId,
    baseOrigin: compilerInput.baseOrigin,
    approvalDigest: compilerInput.approvalDigest,
    approvalFreshnessReceipt: compilerInput.approvalFreshnessReceipt,
    mode: fullPlaywrightMode ? 'full-playwright' : writeMode ? 'controlled-reversible-write' : 'read-only',
    ...(fullPlaywrightMode ? { executionProfile: 'full-playwright' } : {}),
    runGateRequired: true,
    caseIds: compilerInput.cases.map((testCase) => testCase.caseId),
    blockedCases,
    cases: compilerInput.cases,
  }))

  const sourceDigests = Object.fromEntries(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => [path, digestText(`generated-source:${path}`, content)]),
  )
  files.set('source-integrity.json', prettyJson({ schemaVersion: '1.0.0', files: sourceDigests }))

  for (const [relativePath, content] of files) {
    const absolutePath = join(input.outputDir, relativePath)
    await mkdir(join(absolutePath, '..'), { recursive: true })
    await writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' })
  }

  return { generatedFiles: [...files.keys()].sort(), sourceDigests }
}

/** @deprecated Use compileTrustedProject; this alias remains for API compatibility. */
export const compileReadOnlyProject = compileTrustedProject

function renderSafePageFixture(writeMode: boolean): string {
  return [
    ...(writeMode ? ["import { createHash, createPublicKey, verify } from 'node:crypto'"] : []),
    ...(writeMode ? ["import { Buffer } from 'node:buffer'"] : []),
    "import process from 'node:process'",
    "import { URL } from 'node:url'",
    "import { test as base } from '@playwright/test'",
    '',
    'interface SafePage {',
    '  assertText(actionId: string, target: string, expected: string): Promise<void>',
    '  reversibleWrite(input: { actionId: string; buttonName: string; beforeText: string; afterText: string; dataLeaseId: string; cleanupPlanId: string }): Promise<void>',
    '  complete(): Promise<void>',
    '}',
    '',
    ...(writeMode ? renderExecutionOutcomeVerifier() : []),
    'export const test = base.extend<{ safePage: SafePage }>({',
    '  safePage: async ({}, use) => {',
    "    if (!process.env.BIZTEST_RUN_BUNDLE) throw new Error('BIZTEST_RUN_BUNDLE_REQUIRED')",
    ...(writeMode ? [] : ['    const readFailures: string[] = []']),
    '    await use({',
    '      async assertText(actionId, target, expected) {',
    writeMode
      ? "        throw new Error('BIZTEST_MIXED_READ_WRITE_PROJECT_FORBIDDEN')"
      : [
        "        const endpoint = process.env.BIZTEST_CONTROLLED_READ_BRIDGE",
        "        const runGate = process.env.BIZTEST_RUN_GATE",
        "        if (!endpoint || !runGate) throw new Error('BIZTEST_CONTROLLED_READ_BRIDGE_REQUIRED')",
        '        const url = new URL(endpoint)',
        "        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1/read-assertion') {",
        "          throw new Error('BIZTEST_CONTROLLED_READ_BRIDGE_INVALID')",
        '        }',
        "        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',",
        "          authorization: `Bearer ${runGate}` }, body: JSON.stringify({ actionId, target, expected }) })",
        "        if (!response.ok) throw new Error('BIZTEST_CONTROLLED_READ_DENIED')",
        '        const result = await response.json() as Record<string, unknown>',
        "        if (result.status === 'failed') readFailures.push(actionId)",
        "        else if (result.status !== 'passed') {",
        "          const reasonCode = typeof result.reasonCode === 'string' ? result.reasonCode : 'E2E_RUNTIME_REASON_UNKNOWN'",
        "          throw new Error(`BIZTEST_READ_EXECUTION_BLOCKED:${String(result.status)}:${reasonCode}`)",
        '        }',
      ].join('\n'),
    '      },',
    ...(writeMode ? [
    '      async reversibleWrite(input) {',
    "        const endpoint = process.env.BIZTEST_CONTROLLED_WRITE_BRIDGE",
    "        const runGate = process.env.BIZTEST_RUN_GATE",
    "        if (!endpoint || !runGate) throw new Error('BIZTEST_CONTROLLED_WRITE_BRIDGE_REQUIRED')",
    '        const url = new URL(endpoint)',
    "        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1/reversible-write') {",
    "          throw new Error('BIZTEST_CONTROLLED_WRITE_BRIDGE_INVALID')",
    '        }',
    "        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',",
    "          authorization: `Bearer ${runGate}` }, body: JSON.stringify(input) })",
    "        if (!response.ok) throw new Error('BIZTEST_CONTROLLED_WRITE_DENIED')",
    '        const result = await response.json() as Record<string, unknown>',
    "        const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)",
    '        const receipt = result.executionOutcomeReceipt',
    "        if (result.status !== 'passed' || result.effectObservation !== 'applied'",
    "          || result.cleanupStatus !== 'verified-clean' || !digest(result.authorityReceiptDigest)",
    "          || !digest(result.leaseReceiptDigest) || !digest(result.gatewayAuditDigest)",
    "          || !Array.isArray(result.evidenceIds) || result.evidenceIds.length === 0",
    '          || !verifyExecutionOutcomeReceipt(receipt) || !isRecord(receipt.cleanup)',
    '          || result.authorityReceiptDigest !== receipt.signedDigest',
    '          || result.leaseReceiptDigest !== receipt.cleanup.leaseReceiptDigest',
    '          || canonicalJson(result.evidenceIds) !== canonicalJson(receipt.evidenceIds)',
    '          || receipt.actionId !== input.actionId || receipt.cleanup.leaseId !== input.dataLeaseId',
    '          || receipt.cleanup.cleanupPlanId !== input.cleanupPlanId) {',
    "          throw new Error('BIZTEST_CONTROLLED_WRITE_PROOF_INCOMPLETE')",
    '        }',
    '      },',
    ] : [
      '      async reversibleWrite(_input) {',
      "        throw new Error('BIZTEST_MIXED_READ_WRITE_PROJECT_FORBIDDEN')",
      '      },',
    ]),
    '      async complete() {',
    writeMode
      ? '        return undefined'
      : "        if (readFailures.length > 0) throw new Error(`BIZTEST_READ_ASSERTION_FAILED:${readFailures.join(',')}`)",
    '      },',
    '    })',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderExecutionOutcomeVerifier(): string[] {
  return [
    'function isRecord(value: unknown): value is Record<string, any> {',
    "  return typeof value === 'object' && value !== null && !Array.isArray(value)",
    '}',
    '',
    'function canonicalJson(value: unknown): string {',
    '  if (value === null || typeof value === \'boolean\' || typeof value === \'string\') return JSON.stringify(value)',
    "  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)",
    "  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`",
    "  if (!isRecord(value)) throw new Error('BIZTEST_EXECUTION_OUTCOME_JSON_INVALID')",
    '  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))',
    '  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(\',\')}}`',
    '}',
    '',
    'function domainDigest(domain: string, text: string): string {',
    "  const normalized = text.normalize('NFC').replace(/\\r\\n?/g, '\\n')",
    "  const bytes = Buffer.from(normalized, 'utf8')",
    "  const prefix = Buffer.from(`BIZTEST\\0${domain}\\0${bytes.byteLength}\\0`, 'utf8')",
    "  return `sha256:${createHash('sha256').update(prefix).update(bytes).digest('hex')}`",
    '}',
    '',
    'function verifyExecutionOutcomeReceipt(candidate: unknown): boolean {',
    '  try {',
    "    const encodedMaterial = process.env.BIZTEST_EXECUTION_OUTCOME_VERIFIER",
    '    if (!encodedMaterial || !isRecord(candidate)) return false',
    "    const material = JSON.parse(Buffer.from(encodedMaterial, 'base64url').toString('utf8')) as Record<string, unknown>",
    '    if (!isRecord(material) || material.purpose !== \'execution-outcome-receipt/v1\'',
    "      || material.algorithm !== 'Ed25519' || candidate.purpose !== material.purpose",
    '      || candidate.algorithm !== material.algorithm || candidate.issuer !== material.issuer',
    '      || candidate.keyId !== material.keyId || typeof candidate.signature !== \'string\'',
    "      || typeof candidate.signedDigest !== 'string' || typeof material.publicKeySpkiBase64 !== 'string'",
    "      || typeof material.publicKeyDigest !== 'string') return false",
    '    const { issuer: _issuer, keyId: _keyId, purpose: _purpose, algorithm: _algorithm,',
    '      signedDigest: _signedDigest, signature: _signature, ...binding } = candidate',
    "    const expectedDigest = domainDigest('execution-outcome-receipt-binding/v1', canonicalJson(binding))",
    '    if (candidate.signedDigest !== expectedDigest) return false',
    "    const publicKeyBytes = Buffer.from(material.publicKeySpkiBase64, 'base64url')",
    "    if (publicKeyBytes.toString('base64url') !== material.publicKeySpkiBase64) return false",
    "    const publicKeyPrefix = Buffer.from(`BIZTEST\\0gateway-public-key/v1\\0${publicKeyBytes.byteLength}\\0`, 'utf8')",
    "    const publicKeyDigest = `sha256:${createHash('sha256').update(publicKeyPrefix).update(publicKeyBytes).digest('hex')}`",
    '    if (publicKeyDigest !== material.publicKeyDigest) return false',
    "    const signatureBytes = Buffer.from(candidate.signature, 'base64url')",
    "    if (signatureBytes.toString('base64url') !== candidate.signature) return false",
    '    const payload = Buffer.from(canonicalJson({ purpose: candidate.purpose, issuer: candidate.issuer,',
    "      keyId: candidate.keyId, algorithm: 'Ed25519', signedDigest: candidate.signedDigest }))",
    "    const publicKey = createPublicKey({ key: publicKeyBytes, type: 'spki', format: 'der' })",
    "    return publicKey.asymmetricKeyType === 'ed25519' && verify(null, payload, publicKey, signatureBytes)",
    '  } catch { return false }',
    '}',
    '',
  ]
}

function renderSpec(input: CompilerInputV1): string {
  const lines = ["import { test } from '../fixtures/safe-page.js'", '']
  const writeMode = input.cases.some((testCase) => testCase.actions.some((action) => action.kind === 'reversibleWrite'))
  if (writeMode) {
    lines.splice(1, 0, "import process from 'node:process'")
    lines.push('test.beforeAll(() => {')
    lines.push("  if (!process.env.BIZTEST_CONTROLLED_WRITE_BRIDGE || !process.env.BIZTEST_RUN_GATE) {")
    lines.push("    throw new Error('BIZTEST_CONTROLLED_WRITE_BRIDGE_REQUIRED')")
    lines.push('  }')
    lines.push('})', '')
    lines.push('test.beforeAll(() => {')
    lines.push("  if (!process.env.BIZTEST_EXECUTION_OUTCOME_VERIFIER) {")
    lines.push("    throw new Error('BIZTEST_EXECUTION_OUTCOME_VERIFIER_REQUIRED')")
    lines.push('  }')
    lines.push('})', '')
  }
  for (const testCase of input.cases) {
    lines.push(`test(${literal(`${testCase.caseId} ${testCase.title}`)}, async ({ safePage }) => {`)
    lines.push("  test.info().annotations.push(")
    lines.push(`    { type: 'assetId', description: ${literal(input.assetId)} },`)
    lines.push(`    { type: 'prdRevision', description: ${literal(input.prdRevision)} },`)
    lines.push(`    { type: 'caseId', description: ${literal(testCase.caseId)} },`)
    for (const reqId of testCase.reqIds) lines.push(`    { type: 'reqId', description: ${literal(reqId)} },`)
    for (const ruleId of testCase.ruleIds) lines.push(`    { type: 'ruleId', description: ${literal(ruleId)} },`)
    for (const obligationId of testCase.obligationIds) {
      lines.push(`    { type: 'obligationId', description: ${literal(obligationId)} },`)
    }
    lines.push(`    { type: 'mode', description: ${literal(testCase.mode)} },`)
    lines.push('  )')
    for (const action of testCase.actions) {
      if (action.kind === 'assertText') {
        lines.push(`  await safePage.assertText(${literal(action.actionId)}, ${literal(action.target)}, ${literal(action.expected)})`)
      } else if (action.kind === 'reversibleWrite') {
        lines.push(`  await safePage.reversibleWrite(${JSON.stringify({ actionId: action.actionId,
          buttonName: action.buttonName, beforeText: action.beforeText, afterText: action.afterText,
          dataLeaseId: action.dataLeaseId, cleanupPlanId: action.cleanupPlanId })})`)
      }
    }
    if (!writeMode) lines.push('  await safePage.complete()')
    lines.push('})', '')
  }
  return `${lines.join('\n')}\n`
}

function renderFullPlaywrightSpec(input: CompilerInputV1): string {
  const lines = [
    "import { test, expect } from '@playwright/test'",
    "import { executeFullPlaywrightAction } from '../fixtures/full-playwright-runtime.js'",
    '',
  ]
  let ordinal = 0
  for (const testCase of input.cases) {
    const timeoutMs = Math.min(2_147_483_647, 5_000 + testCase.actions.reduce((total, action) =>
      total + (action.kind === 'fullPlaywright' ? action.timeoutMs + action.cleanupTimeoutMs : 0), 0))
    lines.push(`test(${literal(`${testCase.caseId} ${testCase.title}`)}, async ({ page, context, browser, request }, testInfo) => {`)
    lines.push(`  test.setTimeout(${timeoutMs})`)
    lines.push('  testInfo.annotations.push(')
    lines.push(`    { type: 'assetId', description: ${literal(input.assetId)} },`)
    lines.push(`    { type: 'prdRevision', description: ${literal(input.prdRevision)} },`)
    lines.push(`    { type: 'caseId', description: ${literal(testCase.caseId)} },`)
    for (const reqId of testCase.reqIds) lines.push(`    { type: 'reqId', description: ${literal(reqId)} },`)
    for (const ruleId of testCase.ruleIds) lines.push(`    { type: 'ruleId', description: ${literal(ruleId)} },`)
    for (const obligationId of testCase.obligationIds) {
      lines.push(`    { type: 'obligationId', description: ${literal(obligationId)} },`)
    }
    lines.push(`    { type: 'mode', description: ${literal(testCase.mode)} },`)
    lines.push("    { type: 'executionProfile', description: 'full-playwright' },")
    lines.push('  )')
    lines.push('  const __biztestRetire = Object.freeze(context.close.bind(context))')
    for (const action of testCase.actions) {
      if (action.kind !== 'fullPlaywright') throw compilerError('full-playwright Project 不得混合 legacy action')
      const actionOrdinal = ordinal++
      lines.push('  {')
      lines.push('    const state = {} as Record<string, unknown>')
      lines.push('    const checkpoint = async (_input: { checkpointId: string; oracleId: string; actual: unknown }): Promise<void> => undefined')
      lines.push(`    const __biztestRun${actionOrdinal} = async (): Promise<unknown> => {`)
      lines.push(action.source)
      lines.push('    }')
      lines.push(`    const __biztestCleanup${actionOrdinal} = async (): Promise<unknown> => {`)
      lines.push(action.cleanupSource)
      lines.push('    }')
      lines.push('    await executeFullPlaywrightAction({')
      lines.push(`      run: () => __biztestRun${actionOrdinal}(),`)
      lines.push(`      cleanup: () => __biztestCleanup${actionOrdinal}(),`)
      lines.push('      retire: __biztestRetire,')
      lines.push(`      programTimeoutMs: ${action.timeoutMs}, cleanupTimeoutMs: ${action.cleanupTimeoutMs},`)
      lines.push('    })')
      lines.push('  }')
    }
    lines.push('})', '')
  }
  return `${lines.join('\n')}\n`
}

function assertFullPlaywrightFragments(input: CompilerInputV1): void {
  for (const testCase of input.cases) {
    for (const action of testCase.actions) {
      if (action.kind !== 'fullPlaywright') throw compilerError('full-playwright Project 不得混合 legacy action')
      const sourceIssue = validateFullPlaywrightFunctionBody(action.source)
      const cleanupIssue = validateFullPlaywrightFunctionBody(action.cleanupSource)
      if (sourceIssue || cleanupIssue) throw compilerError(
        `full Playwright Action ${action.actionId} 不是密封 FunctionBody：${sourceIssue ?? cleanupIssue}`)
      const audit = auditTrustedRegressionSourceSet([
        trustedFragment(`${action.actionId}:source`, action.source, 'Run'),
        trustedFragment(`${action.actionId}:cleanup`, action.cleanupSource, 'Cleanup'),
      ], 'full-playwright')
      if (!audit.valid) throw compilerError(
        `full Playwright Action ${action.actionId} 不是密封 FunctionBody：${audit.findings[0]?.code ?? 'audit-failed'}`)
    }
  }
}

function trustedFragment(relativePath: string, source: string, kind: 'Run' | 'Cleanup'):
{ relativePath: string; bytes: Uint8Array } {
  const wrapped = [
    "import { test, expect } from '@playwright/test'",
    "test('trusted fragment', async ({ page, context, browser, request }, testInfo) => {",
    '  const state = {} as Record<string, unknown>',
    '  const checkpoint = async (_input: { checkpointId: string; oracleId: string; actual: unknown }) => undefined',
    `  const __biztest${kind}0 = async () => {`, source, '  }',
    `  await __biztest${kind}0()`,
    '})', '',
  ].join('\n')
  return { relativePath: `regression/fragments/${relativePath}.ts`, bytes: Buffer.from(wrapped, 'utf8') }
}

function renderFullPlaywrightRuntime(): string {
  return [
    "import { clearTimeout as __biztestHostClearTimeout, setTimeout as __biztestHostSetTimeout } from 'node:timers'",
    '',
    'const __biztestPromise = Promise',
    'const __biztestPromiseRace = Promise.race.bind(Promise)',
    'const __biztestSetTimeout = __biztestHostSetTimeout',
    'const __biztestClearTimeout = __biztestHostClearTimeout',
    'const __biztestError = Error',
    'const __biztestAggregateError = AggregateError',
    'const __biztestProgramDeadlines = new WeakSet<object>()',
    'const __biztestCleanupDeadlines = new WeakSet<object>()',
    'const __biztestWeakSetAdd = __biztestProgramDeadlines.add.call.bind(__biztestProgramDeadlines.add) as',
    '  (set: WeakSet<object>, value: object) => WeakSet<object>',
    'const __biztestWeakSetHas = __biztestProgramDeadlines.has.call.bind(__biztestProgramDeadlines.has) as',
    '  (set: WeakSet<object>, value: object) => boolean',
    '',
    'interface FullPlaywrightExecutionInput {',
    '  run(): Promise<unknown>',
    '  cleanup(): Promise<unknown>',
    '  retire(): Promise<void>',
    '  programTimeoutMs: number',
    '  cleanupTimeoutMs: number',
    '}',
    '',
    "type DeadlineKind = 'program' | 'cleanup'",
    '',
    'function deadlineError(kind: DeadlineKind): Error {',
    "  const error = new __biztestError(kind === 'program'",
    "    ? 'BIZTEST_FULL_PLAYWRIGHT_PROGRAM_TIMEOUT_OUTCOME_UNKNOWN_CONTEXT_RETIRED_LEASE_QUARANTINED_NO_RETRY'",
    "    : 'BIZTEST_FULL_PLAYWRIGHT_CLEANUP_TIMEOUT_OUTCOME_UNKNOWN')",
    "  error.name = 'BizTestFullPlaywrightDeadlineError'",
    '  __biztestWeakSetAdd(kind === \'program\' ? __biztestProgramDeadlines : __biztestCleanupDeadlines, error)',
    '  return error',
    '}',
    '',
    'async function withDeadline(operation: () => Promise<unknown>, timeoutMs: number, kind: DeadlineKind): Promise<unknown> {',
    '  let timer: ReturnType<typeof __biztestSetTimeout> | undefined',
    '  const deadline = new __biztestPromise<never>((_resolve, reject) => {',
    '    timer = __biztestSetTimeout(() => reject(deadlineError(kind)), timeoutMs)',
    '  })',
    '  try { return await __biztestPromiseRace([operation(), deadline]) }',
    '  finally { if (timer !== undefined) __biztestClearTimeout(timer) }',
    '}',
    '',
    'function isDeadline(error: unknown, kind: DeadlineKind): boolean {',
    "  return typeof error === 'object' && error !== null",
    '    && __biztestWeakSetHas(kind === \'program\' ? __biztestProgramDeadlines : __biztestCleanupDeadlines, error)',
    '}',
    '',
    'export async function executeFullPlaywrightAction(input: FullPlaywrightExecutionInput): Promise<void> {',
    '  let primaryCaught = false',
    '  let primaryError: unknown',
    '  let primaryTimedOut = false',
    '  let cleanupCaught = false',
    '  let cleanupError: unknown',
    '  let cleanupResult: unknown',
    '  let retireCaught = false',
    '  let retireError: unknown',
    "  try { await withDeadline(input.run, input.programTimeoutMs, 'program') }",
    '  catch (error) {',
    "    primaryCaught = true; primaryError = error; primaryTimedOut = isDeadline(error, 'program')",
    '    if (primaryTimedOut) {',
    '      try { await input.retire() } catch (retireFailure) { retireCaught = true; retireError = retireFailure }',
    '    }',
    '  }',
    '  if (!primaryTimedOut) {',
    '    try {',
    "      try { cleanupResult = await withDeadline(input.cleanup, input.cleanupTimeoutMs, 'cleanup') }",
    '      catch (error) { cleanupCaught = true; cleanupError = error }',
    '    } finally {',
    "      if (cleanupCaught || cleanupResult !== 'verified-clean') {",
    '        try { await input.retire() } catch (error) { retireCaught = true; retireError = error }',
    '      }',
    '    }',
    '  }',
    '  if (primaryTimedOut) {',
    '    if (retireCaught) throw new __biztestAggregateError([primaryError, retireError],',
    "      'BIZTEST_FULL_PLAYWRIGHT_PROGRAM_TIMEOUT_AND_RETIRE_FAILED_LEASE_QUARANTINED_NO_RETRY')",
    '    throw primaryError',
    '  }',
    '  let cleanupFailureCaught = cleanupCaught',
    '  let cleanupFailure = cleanupError',
    "  if (!cleanupCaught && cleanupResult !== 'verified-clean') {",
    '    cleanupFailureCaught = true',
    "    cleanupFailure = new __biztestError('BIZTEST_FULL_PLAYWRIGHT_CLEANUP_NOT_VERIFIED')",
    '  }',
    '  if (retireCaught) {',
    '    cleanupFailure = cleanupFailureCaught',
    "      ? new __biztestAggregateError([cleanupFailure, retireError], 'BIZTEST_FULL_PLAYWRIGHT_CLEANUP_AND_RETIRE_FAILED')",
    '      : retireError',
    '    cleanupFailureCaught = true',
    '  }',
    '  if (primaryCaught && cleanupFailureCaught) {',
    "    throw new __biztestAggregateError([primaryError, cleanupFailure], 'BIZTEST_FULL_PLAYWRIGHT_PROGRAM_AND_CLEANUP_FAILED')",
    '  }',
    '  if (cleanupFailureCaught) throw cleanupFailure',
    '  if (primaryCaught) throw primaryError',
    '}',
    '',
  ].join('\n')
}

function renderReadme(input: CompilerInputV1, writeMode: boolean, fullPlaywrightMode: boolean): string {
  return [
    '# 受控 E2E 回归项目',
    '',
    `- Asset：${input.assetId}`,
    `- Generation：${input.generationId}`,
    `- PRD Revision：${input.prdRevision}`,
    `- 模式：${fullPlaywrightMode ? '完整 Playwright（冻结程序、Gateway、Lease 与 Cleanup）'
      : writeMode ? '可恢复写（必须经 fresh RunGate、loopback bridge 与独立 Ed25519 结果验签）' : '只读'}`,
    '',
    '此目录由确定性编译器生成。不得手工修改源码、绕过 Safety Gateway、复用旧审批或在缺少受控 launcher 时执行写操作。',
    '',
  ].join('\n')
}

function literal(value: string): string {
  return JSON.stringify(value)
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function compilerError(message: string): E2EError {
  return new E2EError({ code: 'E2E_COMPILER_INPUT_INVALID', category: 'validation', message, retryable: false })
}
