import {
  DeclarativeBrowserActionSchema,
  DeclarativeOracleObservationSchema,
  E2EError,
  type DeclarativeBrowserAction,
  type DeclarativeOracleObservation,
} from '@mutil-skills/e2e-contracts'

export interface DeclarativeBrowserCaseProgram {
  caseId: string
  actions: DeclarativeBrowserAction[]
  oracles: DeclarativeOracleObservation[]
}

export function renderDeclarativeBrowserCase(input: DeclarativeBrowserCaseProgram): string {
  const actions = input.actions.map((candidate) => DeclarativeBrowserActionSchema.parse(candidate))
  const oracles = input.oracles.map((candidate) => DeclarativeOracleObservationSchema.parse(candidate))
  const lines: string[] = []
  for (const action of actions) {
    assertSupportedScope(action)
    for (const oracle of oracles.filter((candidate) => candidate.actionId === action.actionId)) {
      lines.push(...renderOraclePreparation(oracle))
    }
    lines.push(...renderAction(action))
    for (const oracle of oracles.filter((candidate) => candidate.actionId === action.actionId)) {
      lines.push(...renderOracle(oracle))
    }
  }
  return `${lines.join('\n')}\n`
}

function renderAction(action: DeclarativeBrowserAction): string[] {
  const timeout = `{ timeout: ${action.timeout.timeoutMs} }`
  if (action.kind === 'navigate') return [`await page.goto(${literal(action.url)}, ${timeout})`]
  if (action.kind === 'assert-only') return []
  const locator = renderLocator(action.locatorCandidates)
  if (action.kind === 'click') return [`await ${locator}.click(${timeout})`]
  if (action.kind === 'fill') return [`await ${locator}.fill(${literal(action.value)}, ${timeout})`]
  if (action.kind === 'select') return [`await ${locator}.selectOption(${literal(action.values)}, ${timeout})`]
  if (action.kind === 'check') return [`await ${locator}.${action.checked ? 'check' : 'uncheck'}(${timeout})`]
  if (action.kind === 'press') return [`await ${locator}.press(${literal(action.key)}, ${timeout})`]
  return [`await ${locator}.waitFor({ state: ${literal(action.state)}, timeout: ${action.timeout.timeoutMs} })`]
}

function renderOracle(oracle: DeclarativeOracleObservation): string[] {
  const note = `// Oracle ${oracle.oracleId}`
  if (oracle.kind === 'network') return [note,
    `const __response_${safe(oracle.oracleId)} = await __network_${safe(oracle.oracleId)}`,
    `expect(__response_${safe(oracle.oracleId)}.status()).toBe(${oracle.response.status})`,
    ...(oracle.request.bodyDigest === undefined ? [] : [
      `expect(__requestBodyDigest(__response_${safe(oracle.oracleId)}.request())).toBe(${literal(oracle.request.bodyDigest)})`,
    ]),
    ...(oracle.response.bodyDigest === undefined ? [] : [
      `expect(__bytesDigest(await __response_${safe(oracle.oracleId)}.body())).toBe(${literal(oracle.response.bodyDigest)})`,
    ])]
  if (oracle.kind === 'download') return [note,
    `const __downloadResult_${safe(oracle.oracleId)} = await __download_${safe(oracle.oracleId)}`,
    `expect(__downloadResult_${safe(oracle.oracleId)}.suggestedFilename()).toBe(${literal(oracle.fileName)})`,
    ...(oracle.contentDigest === undefined ? [] : [
      `expect(__bytesDigest(await __downloadResult_${safe(oracle.oracleId)}.createReadStream())).toBe(${literal(oracle.contentDigest)})`,
    ])]
  if (oracle.kind === 'console') return [note,
    `expect(__console_${safe(oracle.oracleId)}.filter((message) => message.type() === ${literal(oracle.severity)}`
      + ` && !${literal(oracle.allowlist)}.some((allowed) => message.text().includes(allowed))).length).toBe(${oracle.expectedCount})`]
  if (oracle.kind === 'composite') {
    const conditions = oracle.conditions.map(renderCompositeCondition)
    return [note, `expect([${conditions.join(', ')}].${oracle.operator === 'and' ? 'every' : 'some'}(Boolean)).toBe(true)`]
  }
  if (oracle.kind === 'url') return [note, renderStringExpectation('page.url()', oracle.comparator, oracle.expected)]
  if (oracle.kind === 'reload-state') return [note, `await page.reload({ timeout: ${oracle.deadlineMs} })`,
    ...renderReloadOracle(oracle)]
  const locator = renderLocator(oracle.locatorCandidates)
  if (oracle.kind === 'absence') return [note, `await expect(${locator}).toHaveCount(0, { timeout: ${oracle.deadlineMs} })`]
  if (oracle.kind === 'text') return [note, renderLocatorTextExpectation(locator, oracle.comparator,
    oracle.expected, oracle.deadlineMs)]
  if (oracle.kind === 'element-state') return [note, renderElementState(locator, oracle.state,
    oracle.expected, oracle.deadlineMs)]
  if (oracle.observation === 'absence') return [note,
    `await expect(${locator}).toHaveCount(0, { timeout: ${oracle.deadlineMs} })`]
  if (oracle.observation === 'element-state') {
    if (typeof oracle.expected !== 'boolean') throw rendererError('E2E_COMPILER_DECLARATIVE_ORACLE_INVALID')
    return [note, renderElementState(locator, 'visible', oracle.expected, oracle.deadlineMs)]
  }
  if (typeof oracle.expected !== 'string' || oracle.comparator === undefined) {
    throw rendererError('E2E_COMPILER_DECLARATIVE_ORACLE_INVALID')
  }
  return [note, renderLocatorTextExpectation(locator, oracle.comparator, oracle.expected, oracle.deadlineMs)]
}

function renderOraclePreparation(oracle: DeclarativeOracleObservation): string[] {
  if (oracle.kind === 'network') return [
    `const __network_${safe(oracle.oracleId)} = page.waitForResponse((response) => response.request().method() === ${literal(oracle.request.method)}`
      + ` && new RegExp(${literal(oracle.request.urlPattern)}).test(response.url()), { timeout: ${oracle.deadlineMs} })`,
  ]
  if (oracle.kind === 'download') return [
    `const __download_${safe(oracle.oracleId)} = page.waitForEvent('download', { timeout: ${oracle.deadlineMs} })`,
  ]
  if (oracle.kind === 'console') return [
    `const __console_${safe(oracle.oracleId)}: import('playwright').ConsoleMessage[] = []`,
    `page.on('console', (message) => __console_${safe(oracle.oracleId)}.push(message))`,
  ]
  return []
}

function renderCompositeCondition(condition: Extract<DeclarativeOracleObservation,
  { kind: 'composite' }>['conditions'][number]): string {
  if (condition.kind === 'url') return stringPredicate('page.url()', condition.comparator, condition.expected)
  const locator = renderLocator(condition.locatorCandidates)
  if (condition.kind === 'absence') return `(await ${locator}.count()) === 0`
  if (condition.kind === 'text') return stringPredicate(`(await ${locator}.first().textContent()) ?? ''`,
    condition.comparator, condition.expected)
  const method: Record<string, string> = { visible: 'isVisible', hidden: 'isHidden', enabled: 'isEnabled',
    disabled: 'isDisabled', checked: 'isChecked', unchecked: 'isChecked' }
  const expression = `await ${locator}.first().${method[condition.state]}()`
  const effective = condition.state === 'unchecked' ? `!(${expression})` : expression
  return condition.expected ? `(${effective})` : `!(${effective})`
}

function stringPredicate(actual: string, comparator: 'equals' | 'contains' | 'matches', expected: string): string {
  if (comparator === 'equals') return `(${actual}) === ${literal(expected)}`
  if (comparator === 'contains') return `(${actual}).includes(${literal(expected)})`
  return `new RegExp(${literal(expected)}).test(${actual})`
}

function renderReloadOracle(oracle: Extract<DeclarativeOracleObservation, { kind: 'reload-state' }>): string[] {
  if (oracle.observation === 'url') {
    if (typeof oracle.expected !== 'string') throw rendererError('E2E_COMPILER_DECLARATIVE_ORACLE_INVALID')
    return [`await expect(page).toHaveURL(${literal(oracle.expected)}, { timeout: ${oracle.deadlineMs} })`]
  }
  const locator = renderLocator(oracle.locatorCandidates)
  if (oracle.observation === 'text') {
    if (typeof oracle.expected !== 'string') throw rendererError('E2E_COMPILER_DECLARATIVE_ORACLE_INVALID')
    return [`await expect(${locator}).toContainText(${literal(oracle.expected)}, { timeout: ${oracle.deadlineMs} })`]
  }
  if (typeof oracle.expected !== 'boolean') throw rendererError('E2E_COMPILER_DECLARATIVE_ORACLE_INVALID')
  return [renderElementState(locator, 'visible', oracle.expected, oracle.deadlineMs)]
}

function renderLocator(candidates: DeclarativeBrowserAction['locatorCandidates']): string {
  const locator = candidates[0]
  if (!locator) throw rendererError('E2E_COMPILER_DECLARATIVE_LOCATOR_REQUIRED')
  if (locator.kind === 'role') return `page.getByRole(${literal(locator.role)}, { name: ${literal(locator.name)} })`
  if (locator.kind === 'test-id') return `page.getByTestId(${literal(locator.value)})`
  if (locator.kind === 'css') return `page.locator(${literal(locator.selector)})`
  return `page.getByText(${literal(locator.value)}, { exact: ${locator.exact} })`
}

function renderStringExpectation(actual: string, comparator: 'equals' | 'contains' | 'matches', expected: string): string {
  if (comparator === 'equals') return `expect(${actual}).toBe(${literal(expected)})`
  if (comparator === 'contains') return `expect(${actual}).toContain(${literal(expected)})`
  return `expect(${actual}).toMatch(new RegExp(${literal(expected)}))`
}

function renderLocatorTextExpectation(locator: string, comparator: 'equals' | 'contains' | 'matches',
  expected: string, deadlineMs: number): string {
  const options = `{ timeout: ${deadlineMs} }`
  if (comparator === 'equals') return `await expect(${locator}).toHaveText(${literal(expected)}, ${options})`
  if (comparator === 'contains') return `await expect(${locator}).toContainText(${literal(expected)}, ${options})`
  return `await expect(${locator}).toHaveText(new RegExp(${literal(expected)}), ${options})`
}

function renderElementState(locator: string, state: string, expected: boolean, deadlineMs: number): string {
  const positive: Record<string, string> = {
    visible: 'toBeVisible', hidden: 'toBeHidden', enabled: 'toBeEnabled', disabled: 'toBeDisabled',
    checked: 'toBeChecked', unchecked: 'not.toBeChecked',
  }
  const matcher = positive[state]
  if (!matcher) throw rendererError('E2E_COMPILER_DECLARATIVE_ORACLE_INVALID')
  const expression = expected ? matcher : matcher.startsWith('not.') ? matcher.slice(4) : `not.${matcher}`
  return `await expect(${locator}).${expression}({ timeout: ${deadlineMs} })`
}

function assertSupportedScope(action: DeclarativeBrowserAction): void {
  if (action.pageScope.page !== 'current' || action.pageScope.frame.kind !== 'main') {
    throw rendererError('E2E_COMPILER_DECLARATIVE_SCOPE_UNSUPPORTED')
  }
}

function literal(value: unknown): string { return JSON.stringify(value) }
function safe(value: string): string { return value.replaceAll(/[^A-Za-z0-9_]/g, '_') }
function rendererError(code: string): E2EError {
  return new E2EError({ code, category: 'validation', message: code, retryable: false })
}
