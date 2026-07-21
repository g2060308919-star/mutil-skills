import ts from 'typescript'

export interface TrustedRegressionSource {
  relativePath: string
  bytes: Uint8Array
}

export interface TrustedSourceFinding { relativePath: string; code: string; detail: string }

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/

type Profile = 'trusted-read-only' | 'trusted-reversible-write' | 'full-playwright'
type ReferenceKind = 'unknown' | 'host' | 'dynamic' | 'function-constructor'
  | 'host-fetch' | 'browser-fetch' | 'browser-object' | 'playwright-request' | 'reflection'
  | 'object-primordial'
  | 'sensitive-property'
interface BindingState { kind: ReferenceKind }
type Scope = Map<string, BindingState>
type BindingIdentity = ts.Symbol | ts.Identifier

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
  const { sourceFile, checker } = createAuditProgram(file.relativePath, source)
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (diagnostics.length > 0) add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'syntax-invalid')

  const allowedImports = importsFor(file.relativePath, profile)
  const rootScope: Scope = new Map()
  let hostFetchReferences = 0
  const trustedPlaywrightBindings = new Set<BindingIdentity>()
  markCompilerProvidedBindings(sourceFile, checker, trustedPlaywrightBindings)
  const identity = (identifier: ts.Identifier): BindingIdentity =>
    checker.getSymbolAtLocation(identifier) ?? identifier
  const namedCallbacks = collectNamedCallbacks(sourceFile, identity)
  const browserOnlyCallbacks = new Set([...namedCallbacks.entries()]
    .filter(([binding]) => {
      const references = callbackReferences(sourceFile, binding, identity)
      return references.length > 0 && references.every((reference) =>
        isBrowserCallbackArgument(reference, trustedPlaywrightBindings, identity))
    })
    .map(([binding]) => binding))

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
    if (ts.isBlock(node)) {
      const blockScope = new Map(scope)
      visitDecorators(node, blockScope, browserScope, visit)
      for (const statement of node.statements) visit(statement, blockScope, browserScope)
      return
    }
    if (ts.isCaseBlock(node)) {
      const blockScope = new Map(scope)
      for (const clause of node.clauses) visit(clause, blockScope, browserScope)
      return
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopScope = new Map(scope)
      ts.forEachChild(node, (child) => visit(child, loopScope, browserScope))
      return
    }
    if (ts.isCatchClause(node)) {
      const catchScope = new Map(scope)
      if (node.variableDeclaration) declareBinding(node.variableDeclaration.name, undefined, catchScope, browserScope)
      visit(node.block, catchScope, browserScope)
      return
    }
    visitDecorators(node, scope, browserScope, visit)
    visitComputedMemberName(node, scope, browserScope, visit)
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      forEachAssignmentIdentifier(node.left, (identifier) => {
        const binding = identity(identifier)
        if (trustedPlaywrightBindings.delete(binding)) {
          add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'trusted-binding-write')
        }
      })
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(node.operand)) {
      const binding = identity(node.operand)
      if (trustedPlaywrightBindings.delete(binding)) {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'trusted-binding-write')
      }
    }
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
      const browserCallback = isBrowserCallbackCall(node.expression, trustedPlaywrightBindings, identity)
      visit(node.expression, scope, browserScope)
      for (const argument of node.arguments) {
        if (browserCallback && isFunctionLike(argument)) visitFunction(argument, scope, true)
        else if (browserCallback && ts.isIdentifier(unwrap(argument))
          && browserOnlyCallbacks.has(identity(unwrap(argument) as ts.Identifier))) {
          visitFunction(namedCallbacks.get(identity(unwrap(argument) as ts.Identifier))!, scope, true)
        }
        else visit(argument, scope, browserScope)
      }
      return
    }
    if (ts.isNewExpression(node)) {
      flagInvocation(classify(node.expression, scope, browserScope))
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && classify(node, scope, browserScope) === 'reflection') {
      add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-reflection')
    }
    if (ts.isVariableDeclaration(node)) {
      declareBinding(node.name, undefined, scope, browserScope)
      visitBindingRuntimeChildren(node.name, scope, browserScope, visit)
      if (node.initializer && !(ts.isIdentifier(node.name) && browserOnlyCallbacks.has(identity(node.name))
        && isFunctionLike(node.initializer))) visit(node.initializer, scope, browserScope)
      inferBinding(node.name, node.initializer, scope, browserScope)
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name && browserOnlyCallbacks.has(identity(node.name))) return
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
      } else if (kind === 'reflection') {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-reflection')
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
    seedCompilerProvidedParameterKinds(node, checker, scope)
    for (const parameter of node.parameters) {
      visitDecorators(parameter, scope, browserScope, visit)
      visitBindingRuntimeChildren(parameter.name, scope, browserScope, visit)
      if (parameter.initializer) visit(parameter.initializer, scope, browserScope)
    }
    if (node.body) visit(node.body, scope, browserScope)
  }

  function flagInvocation(kind: ReferenceKind): void {
    if (kind === 'host-fetch') hostFetchReferences += 1
    else if (kind === 'dynamic') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'dynamic-execution')
    else if (kind === 'function-constructor') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'function-constructor')
    else if (kind === 'reflection') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-reflection')
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
  if (ts.isStringLiteralLike(unwrapped)
    && ['constructor', '__proto__', 'prototype'].includes(unwrapped.text)) return 'sensitive-property'
  if (ts.isIdentifier(unwrapped)) {
    const bound = scope.get(unwrapped.text)
    if (bound) return bound.kind
    if (unwrapped.text === 'fetch') return browserScope ? 'browser-fetch' : 'host-fetch'
    if (['eval', 'require'].includes(unwrapped.text)) return 'dynamic'
    if (unwrapped.text === 'Function') return 'function-constructor'
    if (['Reflect', 'Proxy'].includes(unwrapped.text)) return 'reflection'
    if (unwrapped.text === 'Object') return 'object-primordial'
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
    if (property === 'eval') return 'dynamic'
    if (property === 'Function' || property === 'constructor') return 'function-constructor'
    if (property === '__proto__' || property === 'prototype') return 'reflection'
    if (ts.isElementAccessExpression(unwrapped) && property === undefined && unwrapped.argumentExpression
      && classify(unwrapped.argumentExpression, scope, browserScope) === 'sensitive-property') return 'reflection'
    const root = rootIdentifier(unwrapped.expression)
    if (root === 'Reflect' || root === 'Proxy') return 'reflection'
    if ((root === 'Object' || receiver === 'object-primordial') && !['freeze', 'keys'].includes(property ?? '')) {
      return 'reflection'
    }
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
    scope.set(name.text, { kind: initializer ? classify(initializer, scope, browserScope) : 'unknown' })
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
    if (ts.isIdentifier(element.name)) scope.set(element.name.text, { kind: inferred })
    else declareBinding(element.name, undefined, scope, browserScope)
  }
}

function inferBinding(name: ts.BindingName, initializer: ts.Expression | undefined,
  scope: Scope, browserScope: boolean): void {
  if (!initializer) return
  if (ts.isIdentifier(name)) {
    const binding = scope.get(name.text)
    if (binding) binding.kind = classify(initializer, scope, browserScope)
    return
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    const property = element.propertyName && (ts.isIdentifier(element.propertyName)
      || ts.isStringLiteralLike(element.propertyName)) ? element.propertyName.text
      : ts.isIdentifier(element.name) ? element.name.text : undefined
    let kind: ReferenceKind = 'unknown'
    if (property === 'fetch') kind = browserScope ? 'browser-fetch' : 'host-fetch'
    else if (property === 'eval' || property === 'require') kind = 'dynamic'
    else if (property === 'Function') kind = 'function-constructor'
    if (ts.isIdentifier(element.name)) {
      const binding = scope.get(element.name.text)
      if (binding) binding.kind = kind
    } else inferBinding(element.name, initializer, scope, browserScope)
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

function isBrowserCallbackCall(expression: ts.Expression, trustedBindings: Set<BindingIdentity>,
  identity: (identifier: ts.Identifier) => BindingIdentity): boolean {
  const unwrapped = unwrap(expression)
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return false
  const property = memberName(unwrapped)
  return ['evaluate', 'evaluateHandle', 'addInitScript'].includes(property ?? '')
    && expressionHasTrustedPlaywrightRoot(unwrapped.expression, trustedBindings, identity)
}

function isReflectApply(expression: ts.Expression): boolean {
  const unwrapped = unwrap(expression)
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return false
  const receiver = unwrap(unwrapped.expression)
  return ts.isIdentifier(receiver) && receiver.text === 'Reflect'
    && memberName(unwrapped) === 'apply'
}

function rootIdentifier(expression: ts.Expression): string | undefined {
  const unwrapped = unwrap(expression)
  if (ts.isIdentifier(unwrapped)) return unwrapped.text
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return rootIdentifier(unwrapped.expression)
  }
  return undefined
}

function collectNamedCallbacks(sourceFile: ts.SourceFile,
  identity: (identifier: ts.Identifier) => BindingIdentity): Map<BindingIdentity, ts.FunctionLikeDeclaration> {
  const callbacks = new Map<BindingIdentity, ts.FunctionLikeDeclaration>()
  const duplicates = new Set<BindingIdentity>()
  walk(sourceFile)
  return callbacks
  function walk(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) add(identity(node.name), node)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && isFunctionLike(node.initializer)) add(identity(node.name), node.initializer)
    ts.forEachChild(node, walk)
  }
  function add(binding: BindingIdentity, node: ts.FunctionLikeDeclaration): void {
    if (duplicates.has(binding)) return
    if (callbacks.has(binding)) { callbacks.delete(binding); duplicates.add(binding); return }
    callbacks.set(binding, node)
  }
}

function callbackReferences(sourceFile: ts.SourceFile, binding: BindingIdentity,
  identity: (identifier: ts.Identifier) => BindingIdentity): ts.Identifier[] {
  const references: ts.Identifier[] = []
  walk(sourceFile)
  return references
  function walk(node: ts.Node): void {
    if (ts.isIdentifier(node) && identity(node) === binding && isReferenceIdentifier(node)) references.push(node)
    ts.forEachChild(node, walk)
  }
}

function isBrowserCallbackArgument(identifier: ts.Identifier, trustedBindings: Set<BindingIdentity>,
  identity: (identifier: ts.Identifier) => BindingIdentity): boolean {
  let current: ts.Expression = identifier
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent)) {
    current = current.parent
  }
  const call = current.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(current)) return false
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
  return ['evaluate', 'evaluateHandle', 'addInitScript'].includes(memberName(callee) ?? '')
    && expressionHasTrustedPlaywrightRoot(callee.expression, trustedBindings, identity)
}

function expressionHasTrustedPlaywrightRoot(expression: ts.Expression,
  trustedBindings: Set<BindingIdentity>, identity: (identifier: ts.Identifier) => BindingIdentity): boolean {
  const unwrapped = unwrap(expression)
  return ts.isIdentifier(unwrapped) && trustedBindings.has(identity(unwrapped))
}

function createAuditProgram(relativePath: string, source: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
    noLib: true, noResolve: true, allowJs: true }
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const host: ts.CompilerHost = {
    fileExists: (name) => name === relativePath,
    readFile: (name) => name === relativePath ? source : undefined,
    getSourceFile: (name) => name === relativePath ? sourceFile : undefined,
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram([relativePath], options, host)
  return { sourceFile: program.getSourceFile(relativePath) ?? sourceFile, checker: program.getTypeChecker() }
}

function markCompilerProvidedBindings(sourceFile: ts.SourceFile, checker: ts.TypeChecker,
  trustedBindings: Set<BindingIdentity>): void {
  walk(sourceFile)
  function walk(node: ts.Node): void {
    if (isFunctionLike(node) && isCompilerProvidedFunction(node, checker)) {
      for (const parameter of node.parameters) forEachBindingIdentifier(parameter.name, (identifier) => {
        if (['page', 'context', 'browser', 'request'].includes(identifier.text)) {
          trustedBindings.add(checker.getSymbolAtLocation(identifier) ?? identifier)
        }
      })
    }
    ts.forEachChild(node, walk)
  }
}

function seedCompilerProvidedParameterKinds(node: ts.FunctionLikeDeclaration, checker: ts.TypeChecker,
  scope: Scope): void {
  if (!isCompilerProvidedFunction(node, checker)) return
  for (const parameter of node.parameters) forEachBindingIdentifier(parameter.name, (identifier) => {
    const binding = scope.get(identifier.text)
    if (!binding) return
    if (['page', 'context', 'browser'].includes(identifier.text)) binding.kind = 'browser-object'
    else if (identifier.text === 'request') binding.kind = 'playwright-request'
  })
}

function isCompilerProvidedFunction(node: ts.FunctionLikeDeclaration, checker: ts.TypeChecker): boolean {
  return isImportedPlaywrightTestCallback(node, checker)
}

function isImportedPlaywrightTestCallback(node: ts.FunctionLikeDeclaration, checker: ts.TypeChecker): boolean {
  const parent = node.parent
  if (!ts.isCallExpression(parent) || !parent.arguments.includes(node as ts.Expression)) return false
  const callee = unwrap(parent.expression)
  if (!ts.isIdentifier(callee) || callee.text !== 'test') return false
  const symbol = checker.getSymbolAtLocation(callee)
  return symbol?.declarations?.some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false
    const importDeclaration = declaration.parent.parent.parent
    const importedName = declaration.propertyName?.text ?? declaration.name.text
    return importedName === 'test' && ts.isImportDeclaration(importDeclaration)
      && ts.isStringLiteralLike(importDeclaration.moduleSpecifier)
      && importDeclaration.moduleSpecifier.text === '@playwright/test'
  }) ?? false
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function forEachAssignmentIdentifier(expression: ts.Expression,
  callback: (identifier: ts.Identifier) => void): void {
  const unwrapped = unwrap(expression)
  if (ts.isIdentifier(unwrapped)) { callback(unwrapped); return }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (!ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
        forEachAssignmentIdentifier(element, callback)
      }
    }
    return
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) callback(property.name)
      else if (ts.isPropertyAssignment(property)) forEachAssignmentIdentifier(property.initializer, callback)
    }
  }
}

function forEachBindingIdentifier(name: ts.BindingName, callback: (identifier: ts.Identifier) => void): void {
  if (ts.isIdentifier(name)) { callback(name); return }
  for (const element of name.elements) if (!ts.isOmittedExpression(element)) {
    forEachBindingIdentifier(element.name, callback)
  }
}

function visitBindingRuntimeChildren(name: ts.BindingName, scope: Scope, browserScope: boolean,
  visit: (node: ts.Node, scope: Scope, browserScope: boolean) => void): void {
  if (ts.isIdentifier(name)) return
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      visit(element.propertyName.expression, scope, browserScope)
    }
    visitBindingRuntimeChildren(element.name, scope, browserScope, visit)
    if (element.initializer) visit(element.initializer, scope, browserScope)
  }
}

function visitDecorators(node: ts.Node, scope: Scope, browserScope: boolean,
  visit: (node: ts.Node, scope: Scope, browserScope: boolean) => void): void {
  if (!ts.canHaveDecorators(node)) return
  for (const decorator of ts.getDecorators(node) ?? []) visit(decorator.expression, scope, browserScope)
}

function visitComputedMemberName(node: ts.Node, scope: Scope, browserScope: boolean,
  visit: (node: ts.Node, scope: Scope, browserScope: boolean) => void): void {
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isPropertyDeclaration(node)) && ts.isComputedPropertyName(node.name)) {
    visit(node.name.expression, scope, browserScope)
  }
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
  if (path.includes('/fragments/')) return new Set(['@playwright/test'])
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
