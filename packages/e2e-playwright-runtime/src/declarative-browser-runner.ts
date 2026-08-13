import { createHash } from 'node:crypto'
import type { ConsoleMessage, Download, Locator, Page, Request, Response } from 'playwright'
import {
  DeclarativeExecutionBindingV1Schema,
  digestBytes,
  digestText,
  type DeclarativeBrowserAction,
  type DeclarativeExecutionBindingV1,
  type DeclarativeOracleObservation,
} from '@mutil-skills/e2e-contracts'
import { PlaywrightPageAdapter } from './playwright-page-adapter.js'
import type { PageIdentityEvaluation } from './page-identity-policy.js'

type DeclarativeCase = DeclarativeExecutionBindingV1['cases'][number]

export interface DeclarativeOracleResult {
  oracleId: string
  passed: boolean
  expected: string
  actual: string
}

export interface DeclarativeBrowserCaseResult {
  caseId: string
  actionId: string
  status: 'passed' | 'failed' | 'environment-blocked' | 'safety-blocked'
  reasonCode?: string
  oracleResults: DeclarativeOracleResult[]
  evidence: Array<{ kind: 'screenshot' | 'dom'; byteLength: number; digest: string }>
  rawEvidence?: { screenshot: Uint8Array; dom: Uint8Array }
}

/**
 * 执行已冻结的声明式 Case。调用方仍负责 Authority reservation、Gateway correlation、
 * Profile 与 Evidence quarantine；本模块只解释版本化 action/oracle 契约。
 */
export async function runDeclarativeBrowserCase(input: {
  page: Page
  testCase: DeclarativeCase
  evaluatePageIdentity?: (policy: DeclarativeCase['pageIdentityPolicy']) => Promise<PageIdentityEvaluation>
  runAction?: (action: DeclarativeBrowserAction, operation: () => Promise<void>) => Promise<void>
  preparePage?: () => Promise<{ executedActionId?: string }>
  signal?: AbortSignal
}): Promise<DeclarativeBrowserCaseResult> {
  const testCase = DeclarativeExecutionBindingV1Schema.parse({
    schemaVersion: 'declarative-execution-binding/v1',
    planCompilerDigest: `sha256:${'0'.repeat(64)}`,
    targetProbeDigest: `sha256:${'1'.repeat(64)}`,
    cases: [input.testCase],
  }).cases[0]!
  const adapter = new PlaywrightPageAdapter(input.page)
  const preparedPage = await input.preparePage?.()
  const identity = await (input.evaluatePageIdentity === undefined
    ? adapter.evaluateIdentity(testCase.pageIdentityPolicy)
    : input.evaluatePageIdentity(testCase.pageIdentityPolicy))
  if (!identity.matched) return blocked(testCase, 'environment-blocked', 'E2E_RUNTIME_PAGE_IDENTITY_CHANGED')

  const oracleResults: DeclarativeOracleResult[] = []
  try {
    for (const action of testCase.actions) {
      throwIfCancelled(input.signal)
      assertMainCurrentScope(action)
      const boundOracles = testCase.oracles.filter((oracle) => oracle.actionId === action.actionId)
      const prepared = prepareEventOracles(input.page, boundOracles)
      if (preparedPage?.executedActionId !== action.actionId) {
        const operation = async () => await executeAction(input.page, action)
        await abortable(input.signal, async () => input.runAction === undefined
          ? await operation() : await input.runAction(action, operation))
      }
      for (const oracle of boundOracles) {
        throwIfCancelled(input.signal)
        oracleResults.push(await abortable(input.signal,
          async () => await evaluateOracle(input.page, oracle, prepared)))
      }
    }
  } catch (error) {
    if (error instanceof DeclarativeRunnerError) {
      return { ...blocked(testCase, 'safety-blocked', error.code), oracleResults }
    }
    const evidence = await captureEvidence(adapter)
    return { caseId: testCase.caseId, actionId: lastActionId(testCase), status: 'failed',
      reasonCode: 'E2E_RUNTIME_DECLARATIVE_ACTION_FAILED', oracleResults, ...evidence }
  }
  const evidence = await captureEvidence(adapter)
  return { caseId: testCase.caseId, actionId: lastActionId(testCase),
    status: oracleResults.every((oracle) => oracle.passed) ? 'passed' : 'failed',
    ...(!oracleResults.every((oracle) => oracle.passed)
      ? { reasonCode: 'E2E_RUNTIME_DECLARATIVE_ORACLE_FAILED' } : {}),
    oracleResults, ...evidence }
}

interface PreparedEvents {
  network: Map<string, Promise<Response>>
  downloads: Map<string, Promise<Download>>
  downloadResponses: Map<string, Response[]>
  console: Map<string, ConsoleMessage[]>
}

function prepareEventOracles(page: Page, oracles: DeclarativeOracleObservation[]): PreparedEvents {
  const network = new Map<string, Promise<Response>>()
  const downloads = new Map<string, Promise<Download>>()
  const downloadResponses = new Map<string, Response[]>()
  const console = new Map<string, ConsoleMessage[]>()
  for (const oracle of oracles) {
    if (oracle.kind === 'network') network.set(oracle.oracleId, page.waitForResponse((response) =>
      response.request().method() === oracle.request.method
      && new RegExp(oracle.request.urlPattern, 'u').test(response.url()), { timeout: oracle.deadlineMs }))
    if (oracle.kind === 'download') {
      downloads.set(oracle.oracleId, page.waitForEvent('download', { timeout: oracle.deadlineMs }))
      const responses: Response[] = []
      page.on('response', (response) => responses.push(response))
      downloadResponses.set(oracle.oracleId, responses)
    }
    if (oracle.kind === 'console') {
      const messages: ConsoleMessage[] = []
      page.on('console', (message) => messages.push(message))
      console.set(oracle.oracleId, messages)
    }
  }
  return { network, downloads, downloadResponses, console }
}

async function executeAction(page: Page, action: DeclarativeBrowserAction): Promise<void> {
  const timeout = { timeout: action.timeout.timeoutMs }
  if (action.kind === 'navigate') { await page.goto(action.url, timeout); return }
  if (action.kind === 'assert-only') return
  const locator = locate(page, action.locatorCandidates)
  if (action.kind === 'click') { await locator.click(timeout); return }
  if (action.kind === 'fill') { await locator.fill(action.value, timeout); return }
  if (action.kind === 'select') { await locator.selectOption(action.values, timeout); return }
  if (action.kind === 'check') {
    if (action.checked) await locator.check(timeout)
    else await locator.uncheck(timeout)
    return
  }
  if (action.kind === 'press') { await locator.press(action.key, timeout); return }
  await locator.waitFor({ state: action.state, timeout: action.timeout.timeoutMs })
}

async function evaluateOracle(
  page: Page,
  oracle: DeclarativeOracleObservation,
  prepared: PreparedEvents,
): Promise<DeclarativeOracleResult> {
  if (oracle.kind === 'url') return compared(oracle, page.url(), oracle.expected, oracle.comparator)
  if (oracle.kind === 'text') return await locatorText(oracle, locate(page, oracle.locatorCandidates))
  if (oracle.kind === 'absence') {
    const actual = await locate(page, oracle.locatorCandidates).count()
    return result(oracle, actual === 0, 'count=0', `count=${actual}`)
  }
  if (oracle.kind === 'element-state') {
    const actual = await elementState(locate(page, oracle.locatorCandidates), oracle.state)
    return result(oracle, actual === oracle.expected, String(oracle.expected), String(actual))
  }
  if (oracle.kind === 'eventually') return await evaluateEventually(page, oracle)
  if (oracle.kind === 'reload-state') {
    await page.reload({ timeout: oracle.deadlineMs })
    if (oracle.observation === 'url') return compared(oracle, page.url(), String(oracle.expected), 'equals')
    if (oracle.observation === 'text') return await locatorText({ ...oracle,
      comparator: 'contains', expected: String(oracle.expected) }, locate(page, oracle.locatorCandidates))
    const actual = await locate(page, oracle.locatorCandidates).first().isVisible()
    return result(oracle, actual === oracle.expected, String(oracle.expected), String(actual))
  }
  if (oracle.kind === 'network') {
    const response = await requirePrepared(prepared.network, oracle.oracleId)
    const bodyDigest = oracle.response.bodyDigest === undefined ? undefined
      : rawSha256(await response.body())
    const requestBodyDigest = oracle.request.bodyDigest === undefined ? undefined
      : requestBody(response.request())
    const passed = response.status() === oracle.response.status
      && (oracle.response.bodyDigest === undefined || bodyDigest === oracle.response.bodyDigest)
      && (oracle.request.bodyDigest === undefined || requestBodyDigest === oracle.request.bodyDigest)
    return result(oracle, passed, `${oracle.request.method} ${oracle.request.urlPattern} -> ${oracle.response.status}`,
      `${response.request().method()} ${response.url()} -> ${response.status()}`)
  }
  if (oracle.kind === 'download') {
    const download = await requirePrepared(prepared.downloads, oracle.oracleId)
    const fileName = download.suggestedFilename()
    const requiresBody = oracle.contentDigest !== undefined || oracle.structuredContent !== undefined
    const bytes = requiresBody ? await readDownloadBytes(download) : undefined
    const contentDigest = oracle.contentDigest === undefined || bytes === undefined
      ? undefined : rawSha256(bytes)
    const structuredContent = oracle.structuredContent === undefined || bytes === undefined
      ? undefined : parseStructuredDownload(bytes)
    const response = (prepared.downloadResponses.get(oracle.oracleId) ?? [])
      .find((candidate) => candidate.url() === download.url())
    const mediaType = response?.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    const passed = fileName === oracle.fileName
      && (oracle.mediaType === undefined || mediaType === oracle.mediaType.toLowerCase())
      && (oracle.contentDigest === undefined || contentDigest === oracle.contentDigest)
      && (oracle.structuredContent === undefined
        || canonicalJson(structuredContent) === canonicalJson(oracle.structuredContent))
    return result(oracle, passed, JSON.stringify({ fileName: oracle.fileName,
      ...(oracle.mediaType === undefined ? {} : { mediaType: oracle.mediaType }),
      ...(oracle.contentDigest === undefined ? {} : { contentDigest: oracle.contentDigest }),
      ...(oracle.structuredContent === undefined ? {} : { structuredContent: oracle.structuredContent }) }),
    JSON.stringify({ fileName, ...(mediaType === undefined ? {} : { mediaType }),
      ...(contentDigest === undefined ? {} : { contentDigest }),
      ...(structuredContent === undefined ? {} : { structuredContent }) }))
  }
  if (oracle.kind === 'console') {
    const messages = prepared.console.get(oracle.oracleId) ?? []
    const actual = messages.filter((message) => message.type() === oracle.severity
      && !oracle.allowlist.some((allowed) => message.text().includes(allowed))).length
    return result(oracle, actual === oracle.expectedCount, String(oracle.expectedCount), String(actual))
  }
  const observations = await Promise.all(oracle.conditions.map(async (condition) =>
    await evaluateComposite(page, condition)))
  const passed = oracle.operator === 'and' ? observations.every(Boolean) : observations.some(Boolean)
  return result(oracle, passed, `${oracle.operator}(${oracle.conditions.length})`, JSON.stringify(observations))
}

async function evaluateEventually(
  page: Page,
  oracle: Extract<DeclarativeOracleObservation, { kind: 'eventually' }>,
): Promise<DeclarativeOracleResult> {
  const locator = locate(page, oracle.locatorCandidates)
  try {
    await locator.first().waitFor({ state: oracle.observation === 'absence' ? 'detached' : 'visible',
      timeout: oracle.deadlineMs })
  } catch { /* 由下面的最终 observation 形成可解释失败 */ }
  if (oracle.observation === 'absence') {
    const count = await locator.count()
    return result(oracle, count === 0, 'count=0', `count=${count}`)
  }
  if (oracle.observation === 'element-state') {
    const actual = await locator.first().isVisible()
    return result(oracle, actual === oracle.expected, String(oracle.expected), String(actual))
  }
  return await locatorText({ ...oracle, comparator: oracle.comparator ?? 'equals',
    expected: String(oracle.expected) }, locator)
}

async function evaluateComposite(
  page: Page,
  condition: Extract<DeclarativeOracleObservation, { kind: 'composite' }>['conditions'][number],
): Promise<boolean> {
  if (condition.kind === 'url') return compare(page.url(), condition.expected, condition.comparator)
  const locator = locate(page, condition.locatorCandidates)
  if (condition.kind === 'absence') return await locator.count() === 0
  if (condition.kind === 'text') return compare((await locator.first().textContent()) ?? '',
    condition.expected, condition.comparator)
  return (await elementState(locator, condition.state)) === condition.expected
}

async function locatorText(
  oracle: { oracleId: string; comparator: 'equals' | 'contains' | 'matches'; expected: string },
  locator: Locator,
): Promise<DeclarativeOracleResult> {
  const actual = (await locator.first().textContent()) ?? ''
  return result(oracle, compare(actual, oracle.expected, oracle.comparator), oracle.expected, actual)
}

async function elementState(locator: Locator, state: string): Promise<boolean> {
  const first = locator.first()
  if (state === 'visible') return await first.isVisible()
  if (state === 'hidden') return await first.isHidden()
  if (state === 'enabled') return await first.isEnabled()
  if (state === 'disabled') return await first.isDisabled()
  const checked = await first.isChecked()
  return state === 'checked' ? checked : !checked
}

function locate(page: Page, candidates: DeclarativeBrowserAction['locatorCandidates']): Locator {
  const candidate = candidates[0]
  if (candidate === undefined) throw new DeclarativeRunnerError('E2E_RUNTIME_DECLARATIVE_LOCATOR_REQUIRED')
  if (candidate.kind === 'role') return page.getByRole(candidate.role, { name: candidate.name })
  if (candidate.kind === 'test-id') return page.getByTestId(candidate.value)
  if (candidate.kind === 'label') return page.getByLabel(candidate.value)
  if (candidate.kind === 'css') return page.locator(candidate.selector)
  return page.getByText(candidate.value, { exact: candidate.exact })
}

function compared(
  oracle: { oracleId: string }, actual: string, expected: string,
  comparator: 'equals' | 'contains' | 'matches',
): DeclarativeOracleResult {
  return result(oracle, compare(actual, expected, comparator), expected, actual)
}
function compare(actual: string, expected: string, comparator: 'equals' | 'contains' | 'matches'): boolean {
  return comparator === 'equals' ? actual === expected
    : comparator === 'contains' ? actual.includes(expected) : new RegExp(expected, 'u').test(actual)
}
function result(oracle: { oracleId: string }, passed: boolean, expected: string, actual: string): DeclarativeOracleResult {
  return { oracleId: oracle.oracleId, passed, expected, actual }
}
async function requirePrepared<T>(map: Map<string, Promise<T>>, oracleId: string): Promise<T> {
  const pending = map.get(oracleId)
  if (pending === undefined) throw new DeclarativeRunnerError('E2E_RUNTIME_DECLARATIVE_EVENT_NOT_PREPARED')
  return await pending
}
function requestBody(request: Request): string | undefined {
  const body = request.postDataBuffer()
  return body === null ? undefined : rawSha256(body)
}
function rawSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
async function readDownloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream()
  if (stream === null) throw new DeclarativeRunnerError('E2E_RUNTIME_DECLARATIVE_DOWNLOAD_UNREADABLE')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function parseStructuredDownload(bytes: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) }
  catch { return undefined }
}
function canonicalJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try { return JSON.stringify(sortJson(value)) } catch { return undefined }
}
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, candidate]) => [key, sortJson(candidate)]))
}
async function captureEvidence(adapter: PlaywrightPageAdapter) {
  const [screenshot, domText] = await Promise.all([adapter.screenshot(), adapter.domSnapshot()])
  const dom = Buffer.from(domText, 'utf8')
  return { evidence: [
    { kind: 'screenshot' as const, byteLength: screenshot.byteLength,
      digest: digestBytes('runtime-evidence/screenshot/v1', screenshot) },
    { kind: 'dom' as const, byteLength: dom.byteLength, digest: digestText('runtime-evidence/dom/v1', domText) },
  ], rawEvidence: { screenshot, dom } }
}
function blocked(testCase: DeclarativeCase, status: 'environment-blocked' | 'safety-blocked', reasonCode: string) {
  return { caseId: testCase.caseId, actionId: lastActionId(testCase), status, reasonCode,
    oracleResults: [] as DeclarativeOracleResult[], evidence: [] as DeclarativeBrowserCaseResult['evidence'] }
}
function lastActionId(testCase: DeclarativeCase): string { return testCase.actions.at(-1)!.actionId }
function assertMainCurrentScope(action: DeclarativeBrowserAction): void {
  if (action.pageScope.page !== 'current' || action.pageScope.frame.kind !== 'main') {
    throw new DeclarativeRunnerError('E2E_RUNTIME_DECLARATIVE_SCOPE_UNSUPPORTED')
  }
}
function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DeclarativeRunnerError('E2E_BROWSER_EXECUTOR_CANCELLED_DURING_ACTION')
}
async function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  throwIfCancelled(signal)
  if (signal === undefined) return await operation()
  let listener: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new DeclarativeRunnerError('E2E_BROWSER_EXECUTOR_CANCELLED_DURING_ACTION'))
    signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([operation(), cancelled]) }
  finally { if (listener !== undefined) signal.removeEventListener('abort', listener) }
}
class DeclarativeRunnerError extends Error { constructor(readonly code: string) { super(code) } }
