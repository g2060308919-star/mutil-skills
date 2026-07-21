import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { E2EError } from '@mutil-skills/e2e-contracts'
import { runtimeErrorResponse } from '../packages/e2e-runtime/src/protocol.js'
import { E2E_RUNTIME_SECURITY_MATRIX } from './e2e-runtime-security-matrix.js'

const EXPECTED_THREATS = [
  '恶意 PRD shell 文本',
  'path traversal / symlink swap / hardlink',
  '恶意 project node_modules / NODE_PATH / NODE_OPTIONS',
  'SSH key canary / env secret / project .env',
  'Gateway 直连',
  '未批准 redirect',
  '未批准 WebSocket / Beacon / Service Worker',
  '审批 challenge 错绑 / stale / replay / 无 UV',
  'Runtime package version skew',
  'Runtime manifest tamper',
  'raw evidence canary',
  'report absolute path',
  'Host crash / effect unknown',
  'publication kill point',
  '同版安装内容冲突',
  'active version 卸载',
  '缺失 state 迁移器',
  '系统 Chrome 替换 / 权限漂移',
  '一次性 Profile 未确认关闭',
  '本地确认错绑 / 过期 / replay',
  '本地确认伪造身份或职责分离',
]

describe('E2E Runtime 发行安全矩阵', () => {
  test('完整枚举发布规范攻击面并固定 fail-closed 终态', () => {
    expect(E2E_RUNTIME_SECURITY_MATRIX.map((row) => row.threat)).toEqual(EXPECTED_THREATS)
    expect(new Set(E2E_RUNTIME_SECURITY_MATRIX.map((row) => row.threat)).size)
      .toBe(E2E_RUNTIME_SECURITY_MATRIX.length)
    for (const row of E2E_RUNTIME_SECURITY_MATRIX) {
      expect(row.reasonCode).toMatch(/^E2E_[A-Z0-9_]+$/)
      expect(['input-blocked', 'environment-blocked', 'safety-blocked', 'artifact-blocked',
        'migration-required']).toContain(row.terminalState)
      expect(row.coverage.length).toBeGreaterThan(0)
    }
  })

  test('每个矩阵项绑定到存在且断言对应 reason code 的行为测试', async () => {
    for (const row of E2E_RUNTIME_SECURITY_MATRIX) {
      const files = row.coverage.map((path) => resolve(process.cwd(), path))
      await Promise.all(files.map(async (file) => await access(file)))
      const text = (await Promise.all(files.map(async (file) => await readFile(file, 'utf8')))).join('\n')
      expect(text, `${row.threat} 缺少 ${row.reasonCode} 行为断言`).toContain(row.reasonCode)
    }
  })

  test('每个稳定 reason code 经公开协议编码后仍是矩阵声明的 fail-closed 终态', () => {
    for (const row of E2E_RUNTIME_SECURITY_MATRIX) {
      const response = runtimeErrorResponse('SECURITY-MATRIX', new E2EError({
        code: row.reasonCode,
        category: row.errorCategory,
        message: '安全矩阵验证',
        retryable: false,
      }))
      expect(response.ok).toBe(false)
      expect(response.error).toMatchObject({
        code: row.reasonCode,
        terminalState: row.terminalState,
        retryable: false,
      })
    }
  })
})
