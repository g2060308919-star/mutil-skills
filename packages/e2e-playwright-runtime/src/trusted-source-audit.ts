import ts from 'typescript'

export interface TrustedRegressionSource {
  relativePath: string
  bytes: Uint8Array
}

export interface TrustedSourceFinding { relativePath: string; code: string; detail: string }

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/

type Profile = 'trusted-read-only' | 'trusted-reversible-write' | 'full-playwright'
type ReferenceKind = 'unknown' | 'intrinsic' | 'host' | 'dynamic' | 'function-constructor'
  | 'host-fetch' | 'browser-fetch' | 'browser-object' | 'playwright-request' | 'reflection'
  | 'object-primordial'
  | 'sensitive-property'
interface BindingState { kind: ReferenceKind }
type Scope = Map<string, BindingState>
type BindingIdentity = ts.Symbol | ts.Identifier

const PURE_ECMASCRIPT_INTRINSICS = new Set([
  'undefined', 'NaN', 'Infinity', 'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Error',
  'AggregateError', 'JSON', 'Map', 'Math', 'Number', 'Promise', 'RegExp', 'Set', 'String',
  'Symbol', 'Uint8Array', 'WeakMap', 'WeakSet', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'isFinite', 'isNaN', 'parseFloat',
  'parseInt',
])
const BROWSER_GLOBALS = new Set([
  'globalThis', 'window', 'document', 'navigator', 'location', 'URL', 'URLSearchParams',
])
const PURE_INTRINSIC_MEMBERS = new Set([
  'from', 'isArray', 'stringify', 'parse', 'max', 'min', 'abs', 'ceil', 'floor', 'round',
  'trunc', 'pow', 'sqrt', 'sign', 'imul', 'clz32', 'fround', 'hypot', 'isFinite',
  'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt', 'resolve', 'reject', 'all',
  'allSettled', 'any', 'race', 'fromCharCode', 'fromCodePoint', 'raw',
])

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
  const protectedDeclarationIdentifiers = new Set<ts.Identifier>()
  markCompilerProvidedBindings(sourceFile, checker, trustedPlaywrightBindings,
    protectedDeclarationIdentifiers)
  const identity = (identifier: ts.Identifier): BindingIdentity =>
    (ts.isShorthandPropertyAssignment(identifier.parent)
      ? checker.getShorthandAssignmentValueSymbol(identifier.parent) : undefined)
      ?? checker.getSymbolAtLocation(identifier) ?? identifier
  const trustedProcessBindings = collectTrustedProcessBindings(sourceFile, identity,
    file.relativePath, profile)
  if (trustedProcessBindings.size > 0) rootScope.set('process', { kind: 'host' })
  const protectedBindings = collectProtectedBindings(sourceFile, identity, protectedDeclarationIdentifiers)
  for (const binding of trustedPlaywrightBindings) protectedBindings.add(binding)
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
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
        && !ts.isVariableDeclarationList(node.initializer)) {
        invalidateWriteTarget(node.initializer, loopScope, browserScope)
      }
      ts.forEachChild(node, (child) => visit(child, loopScope, browserScope))
      return
    }
    if (ts.isCatchClause(node)) {
      const catchScope = new Map(scope)
      if (node.variableDeclaration) {
        declareBinding(node.variableDeclaration.name, undefined, catchScope, browserScope, checker)
      }
      visit(node.block, catchScope, browserScope)
      return
    }
    visitDecorators(node, scope, browserScope, visit)
    visitComputedMemberName(node, scope, browserScope, visit)
    if (ts.isMetaProperty(node)) add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-meta')
    if (ts.isImportEqualsDeclaration(node)) {
      add('E2E_COMPILER_SOURCE_IMPORT_FORBIDDEN', 'import-equals')
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      invalidateWriteTarget(node.left, scope, browserScope)
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      invalidateWriteTarget(node.operand, scope, browserScope)
    }
    if (ts.isDeleteExpression(node)) invalidateWriteTarget(node.expression, scope, browserScope)
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier && ts.isStringLiteralLike(specifier)
        && (!allowedImports.has(specifier.text) || !ts.isImportDeclaration(node)
          || !importShapeAllowed(node, file.relativePath, profile))) {
        add('E2E_COMPILER_SOURCE_IMPORT_FORBIDDEN', `${specifier.text}:binding`)
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'dynamic-import')
      }
      const calleeKind = classify(node.expression, scope, browserScope, checker)
      flagInvocation(calleeKind)
      if (isReflectApply(node.expression)) flagInvocation(classify(node.arguments[0]!, scope, browserScope, checker))
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
      flagInvocation(classify(node.expression, scope, browserScope, checker))
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && classify(node, scope, browserScope, checker) === 'reflection') {
      add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-reflection')
    }
    if (ts.isVariableDeclaration(node)) {
      invalidateDeclaredBinding(node.name)
      if (isAmbientDeclaration(node)) add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'ambient-binding')
      declareBinding(node.name, undefined, scope, browserScope, checker)
      visitBindingRuntimeChildren(node.name, scope, browserScope, visit)
      if (node.initializer && !(ts.isIdentifier(node.name) && browserOnlyCallbacks.has(identity(node.name))
        && isFunctionLike(node.initializer))) visit(node.initializer, scope, browserScope)
      inferBinding(node.name, node.initializer, scope, browserScope, checker)
      return
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      invalidateDeclaredIdentifier(node.name)
    }
    if (ts.isFunctionDeclaration(node) && node.name && browserOnlyCallbacks.has(identity(node.name))) return
    if (isFunctionLike(node)) {
      visitFunction(node, scope, browserScope)
      return
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const kind = classify(node, scope, browserScope, checker)
      if (kind === 'host-fetch' && !isCallCalleeReference(node)) hostFetchReferences += 1
      else if (kind === 'dynamic') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'dynamic-execution')
      else if (kind === 'function-constructor') {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'function-constructor')
      } else if (kind === 'reflection') {
        add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-reflection')
      } else if (kind === 'host' && !isAllowedProcessEnvironmentRoot(node)) {
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
    for (const parameter of node.parameters) declareBinding(parameter.name, undefined, scope, browserScope, checker)
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
    else if (kind === 'host') add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'host-api')
  }

  function invalidateWriteTarget(target: ts.Expression, scope: Scope, browserScope: boolean): void {
    const unwrapped = unwrap(target)
    const root = assignmentRootIdentifier(target)
    if (root) invalidateWrittenIdentifier(root)
    if (root && (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped))
      && ['intrinsic', 'object-primordial'].includes(classify(root, scope, browserScope, checker))) {
      add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'global-binding-write')
    }
    forEachAssignmentIdentifier(target, (identifier) => {
      invalidateWrittenIdentifier(identifier)
    })
  }

  function invalidateDeclaredBinding(name: ts.BindingName): void {
    forEachBindingIdentifier(name, invalidateDeclaredIdentifier)
  }

  function invalidateDeclaredIdentifier(identifier: ts.Identifier): void {
    if (!protectedDeclarationIdentifiers.has(identifier)) invalidateWrittenIdentifier(identifier)
  }

  function invalidateWrittenIdentifier(identifier: ts.Identifier): void {
    const binding = identity(identifier)
    if (protectedBindings.has(binding)) {
      trustedPlaywrightBindings.delete(binding)
      add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'trusted-binding-write')
    }
    if ((PURE_ECMASCRIPT_INTRINSICS.has(identifier.text) || identifier.text === 'Object')
      && !hasRuntimeLexicalBinding(identifier, checker)) {
      add('E2E_COMPILER_SOURCE_API_FORBIDDEN', 'global-binding-write')
    }
  }

  function isAllowedProcessEnvironmentRoot(identifier: ts.Identifier): boolean {
    if (!trustedProcessBindings.has(identity(identifier))) return false
    const environment = identifier.parent
    if ((!ts.isPropertyAccessExpression(environment) && !ts.isElementAccessExpression(environment))
      || environment.expression !== identifier || memberName(environment) !== 'env') return false
    const access = environment.parent
    if ((!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access))
      || access.expression !== environment) return false
    const name = environmentProperty(access)
    return name !== undefined && environmentFor(file.relativePath, profile).has(name)
  }
}

function classify(expression: ts.Expression, scope: Scope, browserScope: boolean,
  checker: ts.TypeChecker): ReferenceKind {
  const unwrapped = unwrap(expression)
  if (ts.isStringLiteralLike(unwrapped)
    && ['constructor', '__proto__', 'prototype'].includes(unwrapped.text)) return 'sensitive-property'
  if (ts.isIdentifier(unwrapped)) {
    const bound = scope.get(unwrapped.text)
    if (bound) return bound.kind
    if (hasRuntimeLexicalBinding(unwrapped, checker)) return 'unknown'
    if (unwrapped.text === 'fetch') return browserScope ? 'browser-fetch' : 'host-fetch'
    if (['eval', 'require'].includes(unwrapped.text)) return 'dynamic'
    if (unwrapped.text === 'Function') return 'function-constructor'
    if (['Reflect', 'Proxy'].includes(unwrapped.text)) return 'reflection'
    if (unwrapped.text === 'Object') return 'object-primordial'
    if (BROWSER_GLOBALS.has(unwrapped.text)) return browserScope ? 'browser-object' : 'host'
    if (PURE_ECMASCRIPT_INTRINSICS.has(unwrapped.text)) return 'intrinsic'
    return 'host'
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const receiver = classify(unwrapped.expression, scope, browserScope, checker)
    const property = memberName(unwrapped)
    if (property === 'eval') return 'dynamic'
    if (property === 'Function' || property === 'constructor') return 'function-constructor'
    if (property === '__proto__' || property === 'prototype') return 'reflection'
    if (ts.isElementAccessExpression(unwrapped) && property === undefined) return 'reflection'
    if (receiver === 'object-primordial'
      && !['freeze', 'keys', 'entries'].includes(property ?? '')) {
      return 'reflection'
    }
    if ((receiver === 'host' || receiver === 'browser-object') && property === 'fetch') {
      return browserScope ? 'browser-fetch' : 'host-fetch'
    }
    if (receiver === 'host' && property === 'env') return 'unknown'
    if (receiver === 'host' && property === 'eval') return 'dynamic'
    if (receiver === 'host' && property === 'Function') return 'function-constructor'
    if (['call', 'apply', 'bind'].includes(property ?? '')
      && ['host-fetch', 'browser-fetch', 'dynamic', 'function-constructor'].includes(receiver)) return receiver
    if (receiver === 'playwright-request') return 'unknown'
    if (receiver === 'host') return 'host'
    if (receiver === 'browser-object') return 'browser-object'
    if (receiver === 'intrinsic') return PURE_INTRINSIC_MEMBERS.has(property ?? '') ? 'unknown' : 'host'
    return 'unknown'
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return classify(unwrapped.right, scope, browserScope, checker)
  }
  if (ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)) return 'unknown'
  return 'unknown'
}

function declareBinding(name: ts.BindingName, initializer: ts.Expression | undefined,
  scope: Scope, browserScope: boolean, checker: ts.TypeChecker): void {
  if (ts.isIdentifier(name)) {
    scope.set(name.text, { kind: initializer ? classify(initializer, scope, browserScope, checker) : 'unknown' })
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
    else declareBinding(element.name, undefined, scope, browserScope, checker)
  }
}

function inferBinding(name: ts.BindingName, initializer: ts.Expression | undefined,
  scope: Scope, browserScope: boolean, checker: ts.TypeChecker): void {
  if (!initializer) return
  if (ts.isIdentifier(name)) {
    const binding = scope.get(name.text)
    if (binding) binding.kind = classify(initializer, scope, browserScope, checker)
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
    } else inferBinding(element.name, initializer, scope, browserScope, checker)
  }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

function hasRuntimeLexicalBinding(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(identifier)
  return symbol?.declarations?.some((declaration) => declaration.getSourceFile() === identifier.getSourceFile()
    && !isAmbientDeclaration(declaration)
    && (isRuntimeImportBinding(declaration) || (symbol.flags & ts.SymbolFlags.Value) !== 0)) ?? false
}

function isRuntimeImportBinding(declaration: ts.Declaration): boolean {
  if (ts.isImportClause(declaration)) return !declaration.isTypeOnly
  if (ts.isImportSpecifier(declaration)) {
    const clause = declaration.parent.parent
    return !declaration.isTypeOnly && ts.isImportClause(clause) && !clause.isTypeOnly
  }
  if (ts.isNamespaceImport(declaration)) {
    const clause = declaration.parent
    return ts.isImportClause(clause) && !clause.isTypeOnly
  }
  return false
}

function isAmbientDeclaration(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isSourceFile(current)) return current.isDeclarationFile
    if (ts.canHaveModifiers(current)
      && ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true
    current = current.parent
  }
  return false
}

function assignmentRootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  const unwrapped = unwrap(expression)
  if (ts.isIdentifier(unwrapped)) return unwrapped
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return assignmentRootIdentifier(unwrapped.expression)
  }
  return undefined
}

function memberName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  const argument = expression.argumentExpression && unwrap(expression.argumentExpression)
  return argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text : undefined
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
  trustedBindings: Set<BindingIdentity>, protectedDeclarations: Set<ts.Identifier>): void {
  walk(sourceFile)
  function walk(node: ts.Node): void {
    if (isFunctionLike(node) && isCompilerProvidedFunction(node, checker)) {
      forEachPlaywrightFixtureBinding(node, (identifier) => {
        trustedBindings.add(checker.getSymbolAtLocation(identifier) ?? identifier)
        protectedDeclarations.add(identifier)
      })
    }
    ts.forEachChild(node, walk)
  }
}

function seedCompilerProvidedParameterKinds(node: ts.FunctionLikeDeclaration, checker: ts.TypeChecker,
  scope: Scope): void {
  if (!isCompilerProvidedFunction(node, checker)) return
  forEachPlaywrightFixtureBinding(node, (identifier, fixture) => {
    const binding = scope.get(identifier.text)
    if (!binding) return
    if (['page', 'context', 'browser'].includes(fixture)) binding.kind = 'browser-object'
    else if (fixture === 'request') binding.kind = 'playwright-request'
  })
}

function forEachPlaywrightFixtureBinding(node: ts.FunctionLikeDeclaration,
  callback: (identifier: ts.Identifier, fixture: string) => void): void {
  const first = node.parameters[0]?.name
  if (!first || !ts.isObjectBindingPattern(first)) return
  for (const element of first.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue
    const fixture = element.propertyName
      ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
        ? element.propertyName.text : undefined
      : element.name.text
    if (fixture && ['page', 'context', 'browser', 'request'].includes(fixture)) {
      callback(element.name, fixture)
    }
  }
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
  if (ts.isSpreadElement(unwrapped)) {
    forEachAssignmentIdentifier(unwrapped.expression, callback)
    return
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    forEachAssignmentIdentifier(unwrapped.left, callback)
    return
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (!ts.isOmittedExpression(element)) forEachAssignmentIdentifier(element, callback)
    }
    return
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) callback(property.name)
      else if (ts.isPropertyAssignment(property)) forEachAssignmentIdentifier(property.initializer, callback)
      else if (ts.isSpreadAssignment(property)) forEachAssignmentIdentifier(property.expression, callback)
    }
  }
}

function collectProtectedBindings(sourceFile: ts.SourceFile,
  identity: (identifier: ts.Identifier) => BindingIdentity,
  protectedDeclarations: Set<ts.Identifier>): Set<BindingIdentity> {
  const bindings = new Set<BindingIdentity>()
  walk(sourceFile)
  return bindings

  function protect(identifier: ts.Identifier): void {
    const binding = identity(identifier)
    if (!bindings.has(binding)) protectedDeclarations.add(identifier)
    bindings.add(binding)
  }
  function protectReserved(name: ts.BindingName): void {
    forEachBindingIdentifier(name, (identifier) => {
      if (identifier.text.startsWith('__biztest')) protect(identifier)
    })
  }
  function walk(node: ts.Node): void {
    if (ts.isImportClause(node) && node.name) protect(node.name)
    if (ts.isNamespaceImport(node)) protect(node.name)
    if (ts.isImportSpecifier(node)) protect(node.name)
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) protectReserved(node.name)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name
      && node.name.text.startsWith('__biztest')) protect(node.name)
    ts.forEachChild(node, walk)
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
    || ts.isTypeAliasDeclaration(parent) || ts.isTypeParameterDeclaration(parent)
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
  if (path.endsWith('/playwright.config.ts')) return new Set(['@playwright/test', 'node:process'])
  if (path.endsWith('/tests/generated.spec.ts')) return new Set(profile === 'full-playwright'
    ? ['@playwright/test', '../fixtures/full-playwright-runtime.js']
    : ['../fixtures/safe-page.js', 'node:process'])
  if (path.endsWith('/fixtures/safe-page.ts')) {
    return new Set(profile === 'trusted-reversible-write'
      ? ['node:crypto', 'node:buffer', 'node:process', 'node:url', '@playwright/test']
      : ['node:process', 'node:url', '@playwright/test'])
  }
  if (path.endsWith('/fixtures/full-playwright-runtime.ts')) return new Set(['node:timers'])
  if (path.includes('/fragments/')) return new Set(['@playwright/test'])
  return new Set()
}

function importShapeAllowed(declaration: ts.ImportDeclaration, path: string, profile: Profile): boolean {
  if (!ts.isStringLiteralLike(declaration.moduleSpecifier)) return false
  const actual = importShape(declaration)
  const allowed = allowedImportShapes(path, profile).get(declaration.moduleSpecifier.text)
  return actual !== undefined && allowed !== undefined
    && actual.split('|').every((binding) => allowed.split('|').includes(binding))
}

function importShape(declaration: ts.ImportDeclaration): string | undefined {
  const clause = declaration.importClause
  if (!clause || clause.isTypeOnly || declaration.attributes) return undefined
  const bindings: string[] = []
  if (clause.name) bindings.push(`default:${clause.name.text}`)
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push(`namespace:${clause.namedBindings.name.text}`)
    } else {
      for (const specifier of clause.namedBindings.elements) {
        if (specifier.isTypeOnly) return undefined
        bindings.push(`named:${specifier.propertyName?.text ?? specifier.name.text}:${specifier.name.text}`)
      }
    }
  }
  return bindings.sort().join('|') || undefined
}

function allowedImportShapes(path: string, profile: Profile): Map<string, string> {
  if (path.endsWith('/playwright.config.ts')) return new Map([
    ['@playwright/test', 'named:defineConfig:defineConfig'],
    ['node:process', 'default:process'],
  ])
  if (path.endsWith('/tests/generated.spec.ts')) return new Map(profile === 'full-playwright' ? [
    ['@playwright/test', 'named:expect:expect|named:test:test'],
    ['../fixtures/full-playwright-runtime.js', 'named:executeFullPlaywrightAction:executeFullPlaywrightAction'],
  ] : [
    ['../fixtures/safe-page.js', 'named:test:test'],
    ['node:process', 'default:process'],
  ])
  if (path.endsWith('/fixtures/safe-page.ts')) return new Map(profile === 'trusted-reversible-write' ? [
    ['node:crypto', 'named:createHash:createHash|named:createPublicKey:createPublicKey|named:verify:verify'],
    ['node:buffer', 'named:Buffer:Buffer'],
    ['node:process', 'default:process'],
    ['node:url', 'named:URL:URL'],
    ['@playwright/test', 'named:test:base'],
  ] : [
    ['node:process', 'default:process'],
    ['node:url', 'named:URL:URL'],
    ['@playwright/test', 'named:test:base'],
  ])
  if (path.endsWith('/fixtures/full-playwright-runtime.ts')) return new Map([
    ['node:timers', 'named:clearTimeout:__biztestHostClearTimeout|named:setTimeout:__biztestHostSetTimeout'],
  ])
  if (path.includes('/fragments/')) return new Map([
    ['@playwright/test', 'named:expect:expect|named:test:test'],
  ])
  return new Map()
}

function collectTrustedProcessBindings(sourceFile: ts.SourceFile,
  identity: (identifier: ts.Identifier) => BindingIdentity, path: string, profile: Profile): Set<BindingIdentity> {
  const bindings = new Set<BindingIdentity>()
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'node:process' && importShapeAllowed(statement, path, profile)
      && statement.importClause?.name) bindings.add(identity(statement.importClause.name))
  }
  return bindings
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
