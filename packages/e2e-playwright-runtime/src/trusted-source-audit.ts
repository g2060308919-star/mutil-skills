export interface TrustedRegressionSource {
  relativePath: string
  bytes: Uint8Array
}

export interface TrustedSourceFinding { relativePath: string; code: string; detail: string }

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/
const IMPORT_PATTERN = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)["']([^"']+)["']/g
const ENV_PATTERN = /process\.env\.([A-Z0-9_]+)/g

export function auditTrustedRegressionSourceSet(
  files: TrustedRegressionSource[],
  profile: 'trusted-read-only' | 'trusted-reversible-write',
): { valid: boolean; findings: TrustedSourceFinding[] } {
  const findings: TrustedSourceFinding[] = []
  for (const file of files.filter((item) => SOURCE_EXTENSION.test(item.relativePath))) {
    const source = Buffer.from(file.bytes).toString('utf8')
    const allowedImports = importsFor(file.relativePath, profile)
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      if (!allowedImports.has(match[1]!)) add(file, 'E2E_COMPILER_SOURCE_IMPORT_FORBIDDEN', match[1]!)
    }
    const forbidden = [
      [/\b(?:require|eval)\s*\(/, 'dynamic-execution'],
      [/\bnew\s+Function\b|\bFunction\s*\(/, 'function-constructor'],
      [/\bimport\s*\(/, 'dynamic-import'],
      [/\b(?:child_process|worker_threads|node:vm|node:fs|node:os|node:http|node:https|node:net|node:tls|node:dns)\b/, 'host-api'],
      [/\bpage\s*\.\s*(?:evaluate|addInitScript)\s*\(/, 'browser-code-execution'],
      [/\b(?:npx|npm\s+(?:install|exec)|pnpm\s+dlx|yarn\s+dlx)\b/, 'dynamic-tooling'],
    ] as const
    for (const [pattern, detail] of forbidden) if (pattern.test(source)) {
      add(file, 'E2E_COMPILER_SOURCE_API_FORBIDDEN', detail)
    }
    const allowedEnvironment = environmentFor(file.relativePath, profile)
    for (const match of source.matchAll(ENV_PATTERN)) {
      if (!allowedEnvironment.has(match[1]!)) add(file, 'E2E_COMPILER_SOURCE_ENV_FORBIDDEN', match[1]!)
    }
    if (/process\.env\s*\[/.test(source)) add(file, 'E2E_COMPILER_SOURCE_ENV_FORBIDDEN', 'computed-env')
    const tokens = tokenizeSource(source)
    const fetchCalls = tokens.filter((token, index) => token === 'fetch' && tokens[index + 1] === '(')
    const bridgePath = profile === 'trusted-reversible-write' ? '/v1/reversible-write' : '/v1/read-assertion'
    const bridgeError = profile === 'trusted-reversible-write'
      ? 'BIZTEST_CONTROLLED_WRITE_BRIDGE_INVALID' : 'BIZTEST_CONTROLLED_READ_BRIDGE_INVALID'
    const exactBridgeFetch = file.relativePath.endsWith('/fixtures/safe-page.ts') && fetchCalls.length === 1
      && containsTokenSequence(tokens, [
        'const', 'url', '=', 'new', 'URL', '(', 'endpoint', ')',
        'if', '(', 'url', '.', 'protocol', '!==', 'str:http:', '||',
        'url', '.', 'hostname', '!==', 'str:127.0.0.1', '||',
        'url', '.', 'pathname', '!==', `str:${bridgePath}`, ')', '{',
        'throw', 'new', 'Error', '(', `str:${bridgeError}`, ')', '}',
        'const', 'response', '=', 'await', 'fetch', '(', 'url', ',',
      ])
    if (fetchCalls.length > 0 && !exactBridgeFetch) {
      add(file, 'E2E_COMPILER_SOURCE_NETWORK_FORBIDDEN', 'fetch')
    }
  }
  findings.sort((left, right) => left.relativePath.localeCompare(right.relativePath)
    || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail))
  return { valid: findings.length === 0, findings }

  function add(file: TrustedRegressionSource, code: string, detail: string): void {
    findings.push({ relativePath: file.relativePath, code, detail })
  }
}

function importsFor(path: string, profile: string): Set<string> {
  if (path.endsWith('/playwright.config.ts')) return new Set(['@playwright/test'])
  if (path.endsWith('/tests/generated.spec.ts')) return new Set(['../fixtures/safe-page.js'])
  if (path.endsWith('/fixtures/safe-page.ts')) {
    return new Set(profile === 'trusted-reversible-write'
      ? ['node:crypto', '@playwright/test'] : ['@playwright/test'])
  }
  return new Set()
}

function environmentFor(path: string, profile: string): Set<string> {
  if (path.endsWith('/playwright.config.ts')) {
    return new Set(['BIZTEST_CHROME_EXECUTABLE', 'BIZTEST_BROWSER_PROXY', 'BIZTEST_RUNTIME_OUTPUT_DIR'])
  }
  if (path.endsWith('/fixtures/safe-page.ts')) {
    return new Set(profile === 'trusted-reversible-write'
      ? ['BIZTEST_RUN_BUNDLE', 'BIZTEST_CONTROLLED_WRITE_BRIDGE', 'BIZTEST_RUN_GATE',
        'BIZTEST_EXECUTION_OUTCOME_VERIFIER']
      : ['BIZTEST_RUN_BUNDLE', 'BIZTEST_CONTROLLED_READ_BRIDGE', 'BIZTEST_RUN_GATE'])
  }
  if (path.endsWith('/tests/generated.spec.ts') && profile === 'trusted-reversible-write') {
    return new Set(['BIZTEST_CONTROLLED_WRITE_BRIDGE', 'BIZTEST_RUN_GATE', 'BIZTEST_EXECUTION_OUTCOME_VERIFIER'])
  }
  return new Set()
}

function containsTokenSequence(tokens: string[], expected: string[]): boolean {
  return tokens.some((_, start) => expected.every((token, offset) => tokens[start + offset] === token))
}

/** 只为安全规则提供稳定 token；注释与字符串内容不会被误当成可执行 guard。 */
function tokenizeSource(source: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '/' && next === '/') {
      index = source.indexOf('\n', index + 2)
      if (index < 0) break
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      let value = ''
      index += 1
      while (index < source.length) {
        const current = source[index]!
        if (current === '\\') {
          value += source[index + 1] ?? ''
          index += 2
          continue
        }
        if (current === quote) { index += 1; break }
        value += current
        index += 1
      }
      tokens.push(`str:${value}`)
      continue
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))?.[0]
    if (identifier) {
      tokens.push(identifier)
      index += identifier.length
      continue
    }
    const operator = ['!==', '===', '=>', '||', '&&', '!=', '==', '?.', '??']
      .find((candidate) => source.startsWith(candidate, index))
    if (operator) {
      tokens.push(operator)
      index += operator.length
      continue
    }
    tokens.push(char)
    index += 1
  }
  return tokens
}
