import { describe, expect, test } from 'vitest'
import { TrustedCompilerExecutionFactSchema } from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`

function fact() {
  return {
    schemaVersion: '1.0.0' as const,
    runId: 'RUN-1',
    compilerInputDigest: digest('1'),
    sourceSetDigest: digest('2'),
    approvalDigest: digest('3'),
    browserExecutableDigest: digest('4'),
    gatewayProxyEndpointDigest: digest('5'),
    exitCode: 0,
    stdoutDigest: digest('6'),
    stderrDigest: digest('7'),
    caseResults: [{ caseId: 'CASE-1', status: 'passed' as const }],
  }
}

describe('TrustedCompilerExecutionFact execution profile', () => {
  test('新执行事实携带 full-playwright profile', () => {
    expect(TrustedCompilerExecutionFactSchema.parse({
      ...fact(), executionProfile: 'full-playwright',
    }).executionProfile).toBe('full-playwright')
  })

  test('历史 1.0.0 fact 迁移窗口内仍可读取缺省 profile', () => {
    expect(TrustedCompilerExecutionFactSchema.parse(fact())).not.toHaveProperty('executionProfile')
  })
})
