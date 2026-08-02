import { describe, expect, test } from 'vitest'
import type { RuntimeRunSnapshot } from '../src/run-store.js'
import { classifyRunCondition, projectRunStage } from '../src/run-condition.js'

const d = (value: string): string => `sha256:${value.repeat(64)}`

describe('Run stage and condition', () => {
  test.each([
    ['created', 'requirements'], ['coverage-audited', 'acceptance-review'],
    ['preflight-readonly', 'preflight'], ['compiled', 'compiled'],
    ['running-real', 'execution'], ['diagnosing', 'finalization'], ['accepted', 'completed'],
  ] as const)('%s 投影为稳定高层阶段 %s', (workflow, stage) => {
    expect(projectRunStage(workflow)).toBe(stage)
  })

  test('可恢复预检阻断与业务终态明确分类', () => {
    const blocked = fixture('preflight-readonly')
    blocked.preflightBlocker = {
      status: 'environment-blocked', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH',
      blockedAt: '2026-08-02T00:00:00.000Z', attemptCount: 1, resumeState: 'preflight-readonly',
    }
    expect(classifyRunCondition(blocked)).toEqual({
      kind: 'blocked-retryable', reasonCode: 'E2E_RUNTIME_PAGE_MISMATCH', resumeStage: 'preflight',
    })
    expect(classifyRunCondition(fixture('rejected'))).toEqual({ kind: 'terminal', verdict: 'rejected' })
  })
})

function fixture(current: RuntimeRunSnapshot['workflow']['current']): RuntimeRunSnapshot {
  return {
    schemaVersion: '1.8.0', runId: 'RUN-1', assetId: 'ASSET-1',
    projectIdentityDigest: d('1'), runtimeInstallationDigest: d('2'), runRevision: 1,
    workflow: { current, sequence: 1, eventChainDigest: d('3') },
    artifactDigests: { 'prd-source': d('4') }, frozenArtifacts: {}, trustedExecutionFacts: {},
    writeAttempts: {}, executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    requestResponses: {}, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  }
}
