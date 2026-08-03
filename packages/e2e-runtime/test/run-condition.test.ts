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

  test('只读 Target Probe 可重试，含写 lane 的严格探测要求先修复环境', () => {
    const readonly = targetProbeBlocked('preview-readonly')
    expect(classifyRunCondition(readonly)).toMatchObject({ kind: 'blocked-retryable' })

    const write = targetProbeBlocked('real-reversible-write')
    expect(classifyRunCondition(write)).toMatchObject({ kind: 'blocked-requires-change' })

    const pageMismatch = targetProbeBlocked('preview-readonly')
    pageMismatch.targetProbe!.reasonCode = 'E2E_RUNTIME_PAGE_MISMATCH'
    expect(classifyRunCondition(pageMismatch)).toMatchObject({ kind: 'blocked-requires-change' })

    const pageNotReady = targetProbeBlocked('preview-readonly')
    pageNotReady.targetProbe!.reasonCode = 'E2E_TARGET_PROBE_PAGE_NOT_READY'
    expect(classifyRunCondition(pageNotReady)).toMatchObject({ kind: 'blocked-retryable' })
  })
})

function targetProbeBlocked(executionLane: 'preview-readonly' | 'real-reversible-write') {
  const snapshot = fixture('created')
  snapshot.compiledPrdRun = {
    schemaVersion: '1.0.0', contractProjectionDigest: d('5'), compilerDigest: d('6'),
    cases: [{ queueOrdinal: 0, caseId: 'CASE-0001', caseKey: 'case', title: 'case', actor: 'user',
      contractNodeIds: ['REQ-1'], failurePolicy: 'stop-required', executionLane,
      fixture: { actorRef: 'user', preconditions: [], seedStrategy: 'pre-existing' },
      locatorCandidates: [], pageIdentityPolicy: { schemaVersion: '1.0.0',
        url: { origin: 'http://localhost:3000', pathPattern: '/' },
        signals: [{ kind: 'test-id', value: 'app' }], match: { mode: 'all' } },
      actions: [{ actionId: 'ACTION-0001-0001', actionKey: 'read', kind: 'full-playwright',
        effect: executionLane === 'preview-readonly' ? 'read' : 'reversible-write', statement: '验证' }],
      oracles: [{ oracleId: 'ORACLE-0001-0001', oracleKey: 'oracle',
        actionId: 'ACTION-0001-0001', contractNodeId: 'REQ-1', acceptanceCriterion: '可用' }] }],
  }
  snapshot.targetProbe = {
    schemaVersion: '1.0.0', trust: 'untrusted-diagnostic', runId: snapshot.runId,
    targetContractDigest: d('7'), status: 'environment-blocked',
    reasonCode: 'E2E_TARGET_PROBE_RESOURCE_CLOSURE_LIMIT',
    observedUrl: 'http://localhost:3000', observedTitle: '', identityMatched: true,
    diagnostics: { strategy: 'resource-closure', attempt: 1, domPresent: true,
      visibleTextSummary: 'App', consoleErrors: [], failedRequests: [], pendingResources: [],
      unapprovedResources: [], persistentConnections: [], advisories: [], resourceSummary: { observedCount: 1,
        approvedCount: 1, pendingCount: 0, unapprovedCount: 1,
        persistentConnectionCount: 0, closureComplete: false } },
    probedAt: '2026-08-03T00:00:00.000Z', diagnosticDigest: d('8'),
  }
  return snapshot
}

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
