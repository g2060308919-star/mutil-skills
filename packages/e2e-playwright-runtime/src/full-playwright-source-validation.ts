import ts from 'typescript'

const FUNCTION_NAME = '__biztest_full_playwright_fragment__'
const FUNCTION_PREFIX = `async function ${FUNCTION_NAME}() {\n`
const FUNCTION_SUFFIX = '\n}\n'

export function validateFullPlaywrightFunctionBody(source: string): string | undefined {
  const wrapped = `${FUNCTION_PREFIX}${source}${FUNCTION_SUFFIX}`
  const sourceFile = ts.createSourceFile('approved-fragment.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (diagnostics.length > 0) return 'parse-diagnostic'
  if (sourceFile.statements.length !== 1) return 'wrapper-escape'
  const declaration = sourceFile.statements[0]
  if (!declaration || !ts.isFunctionDeclaration(declaration) || declaration.name?.text !== FUNCTION_NAME
    || !declaration.body || declaration.body.end !== wrapped.length - 1) return 'wrapper-escape'
  let hook: string | undefined
  visit(declaration.body)
  return hook

  function visit(node: ts.Node): void {
    if (hook) return
    if (ts.isIdentifier(node) && (node.text.startsWith('__biztest')
      || ['executeFullPlaywrightAction', 'FullPlaywrightBindings', 'Reflect', 'Proxy', 'Object',
        'Promise', 'AggregateError', 'setTimeout', 'clearTimeout'].includes(node.text))) {
      hook = `reserved-${node.text}`
      return
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const property = memberName(node)
      if (['constructor', '__proto__', 'prototype', 'Object', 'Reflect', 'Proxy',
        'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames',
        'getOwnPropertySymbols', 'getPrototypeOf', 'setPrototypeOf', 'defineProperty',
        'defineProperties', 'create', 'Promise', 'AggregateError', 'setTimeout', 'clearTimeout']
        .includes(property ?? '')
        || (ts.isElementAccessExpression(node) && property === undefined)) {
        hook = `reflection-${property ?? 'computed'}`
        return
      }
    }
    if (ts.isIdentifier(node) && ['test', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(node.text)) {
      hook = node.text
      return
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (ts.isIdentifier(callee) && ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(callee.text)) {
        hook = callee.text
        return
      }
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        && rootIdentifier(callee.expression) === 'test') {
        hook = memberName(callee) ?? 'test-hook'
        return
      }
    }
    ts.forEachChild(node, visit)
  }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

function rootIdentifier(expression: ts.Expression): string | undefined {
  const unwrapped = unwrap(expression)
  if (ts.isIdentifier(unwrapped)) return unwrapped.text
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return rootIdentifier(unwrapped.expression)
  }
  return undefined
}

function memberName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  const argument = expression.argumentExpression && unwrap(expression.argumentExpression)
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined
}
