import { createServer } from 'node:http'
import { describe, expect, test } from 'vitest'
import { runRealProjectFixture } from './e2e-real-project.js'

const loopbackAvailable = await canBindLoopback()
if (process.env.E2E_REQUIRED_TEST_CAPABILITIES?.split(',').includes('loopback') && !loopbackAvailable) {
  throw new Error('E2E_HOST_CAPABILITY_NOT_EXECUTED:loopback')
}

describe.skipIf(!loopbackAvailable)('真实复杂前端项目 Chrome proof（无 loopback 时不计功能通过）', () => {
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

async function canBindLoopback(): Promise<boolean> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) return false
    throw error
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
