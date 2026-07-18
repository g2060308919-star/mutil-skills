import { describe, expect, test } from 'vitest'
import {
  ArtifactSchemaRegistry,
  deriveExecutionResultId,
  migrateLegacyBrowserResultIdentities,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function result(mode: 'real-environment' | 'gateway-injection', overrides: Record<string, unknown> = {}) {
  const caseId = 'CASE-1'
  return {
    resultId: deriveExecutionResultId(caseId, mode),
    caseId,
    attemptId: mode === 'real-environment' ? 'ATTEMPT-REAL' : 'ATTEMPT-INJECTION',
    eventChainDigest: mode === 'real-environment' ? digest('1') : digest('2'),
    mode,
    effect: 'read',
    status: mode === 'real-environment' ? 'passed' : 'failed',
    stepResults: [{
      stepId: 'STEP-1', actionId: 'ACTION-1', status: mode === 'real-environment' ? 'passed' : 'failed',
      actualDigest: digest(mode === 'real-environment' ? '3' : '4'),
      oracleResult: mode === 'real-environment' ? 'passed' : 'failed',
      evidenceIds: [mode === 'real-environment' ? 'EVIDENCE-REAL' : 'EVIDENCE-INJECTION'],
    }],
    effectObservation: 'not-applicable', gatewayAuditRef: 'ARTIFACT-GATEWAY-AUDIT',
    evidenceRefs: [mode === 'real-environment' ? 'EVIDENCE-REAL' : 'EVIDENCE-INJECTION'],
    ...(mode === 'gateway-injection'
      ? { baselineResultId: deriveExecutionResultId(caseId, 'real-environment') }
      : {}),
    ...overrides,
  }
}

function content(caseResults: unknown[]) {
  return {
    runId: 'RUN-1', executedBrowserIds: ['CHROMIUM'], caseResults,
    startedAt: '2026-07-18T00:00:00.000Z', finishedAt: '2026-07-18T00:01:00.000Z',
  }
}

describe('执行结果双域身份', () => {
  test('同一 Case 可同时保存 real 与 injection，且 injection 必须绑定 passed real baseline', () => {
    const parsed = ArtifactSchemaRegistry['browser-results'].shape.content.safeParse(content([
      result('real-environment'), result('gateway-injection'),
    ]))
    expect(parsed.success).toBe(true)
  })

  test('重复 resultId、重复 (caseId, mode)、缺失或错误 baseline 都 fail closed', () => {
    const real = result('real-environment')
    const injection = result('gateway-injection')
    const cases = [
      [real, { ...injection, resultId: real.resultId }],
      [real, { ...injection, resultId: 'RESULT-INJECTION-2' }, { ...injection, resultId: 'RESULT-INJECTION-3' }],
      [real, { ...injection, baselineResultId: undefined }],
      [{ ...real, status: 'failed' }, injection],
      [real, { ...injection, baselineResultId: 'RESULT-UNKNOWN' }],
    ]
    for (const candidate of cases) {
      expect(ArtifactSchemaRegistry['browser-results'].shape.content.safeParse(content(candidate)).success)
        .toBe(false)
    }
  })

  test('旧单域 real 资产确定性迁移 resultId；旧注入、混合身份和碰撞拒绝迁移', () => {
    const legacy = result('real-environment') as Record<string, unknown>
    delete legacy.resultId
    const first = migrateLegacyBrowserResultIdentities(content([legacy]))
    const second = migrateLegacyBrowserResultIdentities(content([legacy]))
    expect(first).toEqual(second)
    expect(first.caseResults[0]).toMatchObject({
      resultId: deriveExecutionResultId('CASE-1', 'real-environment'),
    })

    const legacyInjection = result('gateway-injection') as Record<string, unknown>
    delete legacyInjection.resultId
    delete legacyInjection.baselineResultId
    expect(() => migrateLegacyBrowserResultIdentities(content([legacyInjection]))).toThrow()
    expect(() => migrateLegacyBrowserResultIdentities(content([
      legacy, result('gateway-injection'),
    ]))).toThrow()
  })
})
