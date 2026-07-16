import { describe, expect, test } from 'vitest'
import { auditBrowserExecutionBinding, deriveBrowserCannotClaim } from '../src/index.js'

describe('browser matrix claims', () => {
  test('只批准并执行 Chromium 时必须明确禁止跨浏览器宣称', () => {
    const facts = { approved: [{ browserId: 'CHROMIUM', required: true }],
      planned: [{ browserId: 'CHROMIUM' }], executed: ['CHROMIUM'] }
    expect(deriveBrowserCannotClaim(facts)).toEqual([
      '未完整批准、计划并执行浏览器：FIREFOX、WEBKIT；不能宣称跨浏览器兼容性',
    ])
    expect(auditBrowserExecutionBinding(facts)).toEqual([])
  })

  test('只有三个浏览器都批准、计划并实际执行时才移除限制', () => {
    const ids = ['CHROMIUM', 'FIREFOX', 'WEBKIT']
    expect(deriveBrowserCannotClaim({ approved: ids.map((browserId) => ({ browserId, required: true })),
      planned: ids.map((browserId) => ({ browserId })), executed: ids })).toEqual([])
  })

  test('实际浏览器越权或 required 未执行时发布审计 fail-closed', () => {
    expect(auditBrowserExecutionBinding({
      approved: [{ browserId: 'CHROMIUM', required: true }, { browserId: 'FIREFOX', required: true }],
      planned: [{ browserId: 'CHROMIUM' }], executed: ['CHROMIUM', 'WEBKIT'],
    })).toEqual(expect.arrayContaining([
      { code: 'E2E_BROWSER_EXECUTION_NOT_APPROVED', ref: 'WEBKIT' },
      { code: 'E2E_BROWSER_EXECUTION_NOT_PLANNED', ref: 'WEBKIT' },
      { code: 'E2E_BROWSER_REQUIRED_NOT_EXECUTED', ref: 'FIREFOX' },
      { code: 'E2E_BROWSER_REQUIRED_NOT_PLANNED', ref: 'FIREFOX' },
    ]))
  })
})
