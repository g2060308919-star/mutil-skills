import { describe, expect, test } from 'vitest'
import { runRealProjectFixture } from './e2e-real-project.js'

describe('真实复杂前端项目 Chrome proof', () => {
  test('组件式复杂 DOM 应用通过 browser-product 主链且准确披露 Mock 替代边界', async () => {
    const proof = await runRealProjectFixture({ stack: 'react-like', defect: 'none' })
    expect(proof).toMatchObject({ proofKind: 'real-project',
      application: { stack: 'Component-style DOM application' },
      gate: { eligible: true, passed: true, reasons: [] } })
    expect(proof.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'browser-product', mode: 'real', claim: 'verified' }),
      expect.objectContaining({ component: 'backend', mode: 'substituted', claim: 'not-verified' }),
      expect.objectContaining({ component: 'database', mode: 'substituted', claim: 'not-verified' }),
      expect.objectContaining({ component: 'idp', mode: 'substituted', claim: 'not-verified' }),
    ]))
    expect(proof.scenarios.map((item) => item.scenarioId)).toEqual(expect.arrayContaining([
      'ROLE-NEGATIVE', 'FILTER-SORT-PAGE', 'DYNAMIC-FORM', 'CRUD-RELOAD-CLEANUP',
      'PORTAL-ASYNC', 'DOWNLOAD-CONTENT',
    ]))
  }, 30_000)

  test('普通用户错误显示审核按钮与 Reload 丢状态会被业务 Oracle 拒绝', async () => {
    const permission = await runRealProjectFixture({ stack: 'react-like', defect: 'permission-leak' })
    expect(permission.gate.passed).toBe(false)
    expect(permission.scenarios).toContainEqual(expect.objectContaining({
      scenarioId: 'ROLE-NEGATIVE', status: 'failed', oracleStatus: 'failed',
    }))
    const reload = await runRealProjectFixture({ stack: 'react-like', defect: 'reload-loss' })
    expect(reload.gate.passed).toBe(false)
    expect(reload.scenarios).toContainEqual(expect.objectContaining({
      scenarioId: 'CRUD-RELOAD-CLEANUP', status: 'failed', oracleStatus: 'failed',
    }))
  }, 60_000)

  test('第二种交互栈使用 shadow DOM 与 dialog，证明 locator/actionability 差异', async () => {
    const proof = await runRealProjectFixture({ stack: 'web-components', defect: 'none' })
    expect(proof).toMatchObject({ proofKind: 'real-project',
      application: { stack: 'Web Components shadow-dom application' },
      gate: { eligible: true, passed: true } })
    expect(proof.scenarios.map((item) => item.scenarioId)).toEqual([
      'SHADOW-DIALOG', 'SHADOW-RELOAD',
    ])
  }, 30_000)
})
