import ts from 'typescript'

export interface TrustedRegressionSource {
  relativePath: string
  bytes: Uint8Array
}

export interface TrustedSourceFinding { relativePath: string; code: string; detail: string }

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/

type Profile = 'trusted-read-only' | 'trusted-reversible-write' | 'full-playwright'
type ReferenceKind = 'unknown' | 'host' | 'dynamic' | 'function-constructor'
  | 'host-fetch' | 'browser-fetch' | 'browser-object' | 'playwright-request'
type Scope = Map<string, ReferenceKind>

export function auditTrustedRegressionSourceSet(
  files: TrustedRegressionSource[],
  profile: Profile,
): { valid: boolean; findings: TrustedSourceFinding[] } {
  const findings: TrustedSourceFinding[] = []
  for (const file of files.filter((item) => SOURCE_EXTENSION.test(item.relativePath))) {
    auditFile(file, profile, findings)
  }
  findings.sort((left, right) => left.relativePath.localeCompare(right.relativePath)
    || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail))
  return { valid: findings.length === 0, findings }
}

function auditFile(file: TrustedRegressionSource, profile: Profile, findings: TrustedSourceFinding[]): void {
  const source = Buffer.from(file.bytes).toString('utf8')
  const sourceFile = ts.createSourceFile(file.relativePath, source, ts.ScriptTarget.Latest, true,
    file.relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (diagnostics.length > 0) add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'syntax-invalid')

  const allowedImports = importsFor(file.relativePath, profile)
  const rootScope: Scope = new Map()
  let hostFetchReferences = 0

  visit(sourceFile, rootScope, false)

  if (hostFetchReferences > 0) {
    const bridgePath = profile === 'trusted-reversible-write' ? '/v1/reversible-write' : '/v1/read-assertion'
    const bridgeError = profile === 'trusted-reversible-write'
      ? 'BIZTEST_CONTROLLED_WRITE_BRIDGE_INVALID' : 'BIZTEST_CONTROLLED_READ_BRIDGE_INVALID'
    const tokens = tokenizeSource(source)
    const exactBridgeFetch = file.relativePath.endsWith('/fixtures/safe-page.ts') && hostFetchReferences === 1
      && containsTokenSequence(tokens, [
        'const', 'url', '=', 'new', 'URL', '(', 'endpoint', ')',
        'if', '(', 'url', '.', 'protocol', '!==', 'str:http:', '||',
        'url', '.', 'hostname', '!==', 'str:127.0.0.1', '||',
        'url', '.', 'pathname', '!==', `str:${bridgePath}`, ')', '{',
        'throw', 'new', 'Error', '(', `str:${bridgeError}`, ')', '}',
        'const', 'response', '=', 'await', 'fetch', '(', 'url', ',',
      ])
    if (!exactBridgeFetch) add('E2E_COMPILER_SOURCE_NETWORK_FORBIDDEN', 'fetch')
  }

  function add(code: string, detail: string): void {
    if (!findings.some((finding) => finding.relativePath === file.relativePath
      && finding.code === code && finding.detail === detail)) {
      findings.push({ relativePath: file.relativePath, code, detail })
    }
  }

  function visit(node: ts.Node, scope: Scope, browserScope: boolean): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier && ts.isStringLiteralLike(specifier) && !allowedImports.has(specifier.text)) {
        add('E2E_COMPILER_SOURCE_IMPORT_FORBIDDEN', specifier.text)
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'dynamic-import')
      }
      const calleeKind = classify(node.expression, scope, browserScope)
      flagInvocation(calleeKind)
      if (isReflectApply(node.expression)) flagInvocation(classify(node.arguments[0]!, scope, browserScope))
      const browserCallback = isBrowserCallbackCall(node.expression, scope, browserScope)
      visit(node.expression, scope, browserScope)
      for (const argument of node.arguments) {
        if (browserCallback && isFunctionLike(argument)) visitFunction(argument, scope, true)
        else visit(argument, scope, browserScope)
      }
      return
    }
    if (ts.isNewExpression(node)) {
      flagInvocation(classify(node.expression, scope, browserScope))
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer, scope, browserScope)
      declareBinding(node.name, node.initializer, scope, browserScope)
      return
    }
    if (isFunctionLike(node)) {
      visitFunction(node, scope, browserScope)
      return
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const kind = classify(node, scope, browserScope)
      if (kind === 'host-fetch' && !isCallCalleeReference(node)) hostFetchReferences += 1
      else if (kind === 'dynamic') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'dynamic-execution')
      else if (kind === 'function-constructor') {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'function-constructor')
      } else if (kind === 'host' && hostReferenceForbidden(node.text, browserScope)) {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', `host-${node.text}`)
      }
    }
    if (isProcessEnvironmentAccess(node)) {
      const environmentName = environmentProperty(node)
      const allowed = environmentFor(file.relativePath, profile)
      if (environmentName === undefined || !allowed.has(environmentName)) {
        add('E2E_COMPILER_SOURCE_ENV_FORBIDDEN', environmentName ?? 'computed-env')
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope, browserScope))
  }

  function visitFunction(node: ts.FunctionLikeDeclaration, parentScope: Scope, browserScope: boolean): void {
    const scope = new Map(parentScope)
    for (const parameter of node.parameters) declareBinding(parameter.name, undefined, scope, browserScope)
    if (node.body) visit(node.body, scope, browserScope)
  }

  function flagInvocation(kind: ReferenceKind): void {
    if (kind === 'host-fetch') hostFetchReferences += 1
    else if (kind === 'dynamic') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'dynamic-execution')
    else if (kind === 'function-constructor') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'function-constructor')
    else if (kind === 'host' && !file.relativePath.endsWith('/fixtures/safe-page.ts')) {
      add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-api')
    }
  }

  function hostReferenceForbidden(name: string, browserScope: boolean): boolean {
    if (browserScope && ['globalThis', 'window', 'document', 'navigator', 'location'].includes(name)) return false
    if (file.relativePath.endsWith('/playwright.config.ts') && name === 'process') return false
    if (file.relativePath.endsWith('/fixtures/safe-page.ts') && ['process', 'Buffer'].includes(name)) return false
    return profile === 'full-playwright' || ['globalThis', 'global', 'module', 'exports', '__dirname', '__filename'].includes(name)
  }
}

function classify(expression: ts.Expression, scope: Scope, browserScope: boolean): ReferenceKind {
  const unwrapped = unwrap(expression)
  if (ts.isIdentifier(unwrapped)) {
    const bound = scope.get(unwrapped.text)
    if (bound) return bound
    if (unwrapped.text === 'fetch') return browserScope ? 'browser-fetch' : 'host-fetch'
    if (['eval', 'require'].includes(unwrapped.text)) return 'dynamic'
    if (unwrapped.text === 'Function') return 'function-constructor'
    if (['page', 'context', 'browser'].includes(unwrapped.text)) return 'browser-object'
    if (unwrapped.text === 'request') return 'playwright-request'
    if (['process', 'global', 'globalThis', 'module', 'exports', 'Buffer', '__dirname', '__filename',
      'Bun', 'Deno', 'setImmediate', 'clearImmediate']
      .includes(unwrapped.text)) return 'host'
    return 'unknown'
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const receiver = classify(unwrapped.expression, scope, browserScope)
    const property = memberName(unwrapped)
    if (property === 'constructor') return 'function-constructor'
    if (receiver === 'host' && property === 'fetch') return browserScope ? 'browser-fetch' : 'host-fetch'
    if (receiver === 'host' && property === 'env') return 'unknown'
    if (receiver === 'host' && property === 'eval') return 'dynamic'
    if (receiver === 'host' && property === 'Function') return 'function-constructor'
    if (['call', 'apply', 'bind'].includes(property ?? '')
      && ['host-fetch', 'browser-fetch', 'dynamic', 'function-constructor'].includes(receiver)) return receiver
    if (receiver === 'playwright-request') return 'unknown'
    if (receiver === 'host') return 'host'
    return receiver === 'browser-object' ? 'browser-object' : 'unknown'
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return classify(unwrapped.right, scope, browserScope)
  }
  if (ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)) return 'unknown'
  return 'unknown'
}

function declareBinding(name: ts.BindingName, initializer: ts.Expression | undefined,
  scope: Scope, browserScope: boolean): void {
  if (ts.isIdentifier(name)) {
    const inferred = initializer ? classify(initializer, scope, browserScope)
      : ['page', 'context', 'browser'].includes(name.text) ? 'browser-object'
        : name.text === 'request' ? 'playwright-request' : 'unknown'
    scope.set(name.text, inferred)
    return
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    const property = element.propertyName && (ts.isIdentifier(element.propertyName)
      || ts.isStringLiteralLike(element.propertyName)) ? element.propertyName.text
      : ts.isIdentifier(element.name) ? element.name.text : undefined
    let inferred: ReferenceKind = 'unknown'
    if (property === 'fetch') inferred = browserScope ? 'browser-fetch' : 'host-fetch'
    else if (property === 'eval' || property === 'require') inferred = 'dynamic'
    else if (property === 'Function') inferred = 'function-constructor'
    else if (['page', 'context', 'browser'].includes(property ?? '')) inferred = 'browser-object'
    else if (property === 'request') inferred = 'playwright-request'
    if (ts.isIdentifier(element.name)) scope.set(element.name.text, inferred)
    else declareBinding(element.name, undefined, scope, browserScope)
  }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

function memberName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  const argument = expression.argumentExpression && unwrap(expression.argumentExpression)
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined
}

function isBrowserCallbackCall(expression: ts.Expression, scope: Scope, browserScope: boolean): boolean {
  const unwrapped = unwrap(expression)
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return false
  const property = memberName(unwrapped)
  return ['evaluate', 'evaluateHandle', 'addInitScript'].includes(property ?? '')
    && classify(unwrapped.expression, scope, browserScope) === 'browser-object'
}

function isReflectApply(expression: ts.Expression): boolean {
  const unwrapped = unwrap(expression)
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return false
  const receiver = unwrap(unwrapped.expression)
  return ts.isIdentifier(receiver) && receiver.text === 'Reflect'
    && memberName(unwrapped) === 'apply'
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent) || ts.isBindingElement(parent) || ts.isVariableDeclaration(parent)
    || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isInterfaceDeclaration(parent)
    || ts.isTypeReferenceNode(parent) || ts.isPropertySignature(parent)) return false
  return true
}

function isCallCalleeReference(node: ts.Expression): boolean {
  let current: ts.Node = node
  while (current.parent && ((ts.isPropertyAccessExpression(current.parent)
      || ts.isElementAccessExpression(current.parent)) && current.parent.expression === current
    || ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent))) {
    current = current.parent
  }
  return !!current.parent && (ts.isCallExpression(current.parent) || ts.isNewExpression(current.parent))
    && current.parent.expression === current
}

function isProcessEnvironmentAccess(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
  const expression = unwrap(node.expression)
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false
  const receiver = unwrap(expression.expression)
  return ts.isIdentifier(receiver) && receiver.text === 'process' && memberName(expression) === 'env'
}

function environmentProperty(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return memberName(node)
}

function importsFor(path: string, profile: Profile): Set<string> {
  if (path.endsWith('/playwright.config.ts')) return new Set(['@playwright/test'])
  if (path.endsWith('/tests/generated.spec.ts')) return new Set(profile === 'full-playwright'
    ? ['@playwright/test', '../fixtures/full-playwright-runtime.js'] : ['../fixtures/safe-page.js'])
  if (path.endsWith('/fixtures/safe-page.ts')) {
    return new Set(profile === 'trusted-reversible-write'
      ? ['node:crypto', '@playwright/test'] : ['@playwright/test'])
  }
  return new Set()
}

function environmentFor(path: string, profile: Profile): Set<string> {
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

/** Legacy bridge guard canonicalization. Security semantics are otherwise AST-based. */
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
