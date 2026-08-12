import { describe, expect, test } from 'vitest'
import { ArtifactSchemaRegistry, digestArtifactContent, digestText, type ArtifactDocument } from '@mutil-skills/e2e-contracts'
import { auditArtifactGraph, auditExecutableCompilationClosure, type AuditableArtifact } from '@mutil-skills/e2e-engine'
import { projectRuntimeExecutableArtifacts } from '../src/runtime-executable-artifact-projector.js'
import type { ExecutableRunCompilation } from '../src/prd-run-compiler.js'
import type { RuntimeRunSnapshot } from '../src/run-store.js'

const d = (value: string) => digestText('runtime-executable-projector-test/v1', value)

describe('Runtime executable artifact projector', () => {
  test('从 Runtime 编译结果确定性生成完整可执行 Artifact 集与可审计依赖图', () => {
    const first = projectRuntimeExecutableArtifacts({ snapshot: snapshot(), compilation: compilation(),
      createdAt: '2026-08-12T00:00:00.000Z', engineVersion: '0.8.0' })
    const second = projectRuntimeExecutableArtifacts({ snapshot: snapshot(), compilation: compilation(),
      createdAt: '2026-08-12T00:00:00.000Z', engineVersion: '0.8.0' })
    expect(first).toEqual(second)
    expect(Object.keys(first.artifacts).sort()).toEqual([
      'browser-action-map', 'execution-contract', 'run-bundle', 'test-cases',
    ])
    for (const [type, artifact] of Object.entries(first.artifacts)) {
      expect(ArtifactSchemaRegistry[type as keyof typeof ArtifactSchemaRegistry].safeParse(artifact).success).toBe(true)
      expect(artifact.contentDigest).toBe(digestArtifactContent(
        `artifact-content/${artifact.schemaVersion}/${artifact.artifactType}`, artifact,
      ))
    }
    expect(first.runBundleRecipe.schedule).toEqual([{
      ordinal: 0, caseId: 'CASE-0001', stepIds: ['STEP-CASE-0001-0001'], actionIds: ['ACTION-0001-0001'],
    }])
    const execution = first.artifacts['execution-contract'].content as any
    const actionMap = first.artifacts['browser-action-map'].content as any
    expect(execution.readHttpRequests).toEqual([
      expect.objectContaining({ requestId: 'REQUEST-DISCOVERED-0001', method: 'GET',
        url: 'https://example.test/orders' }),
      expect.objectContaining({ requestId: 'REQUEST-DISCOVERED-0002', method: 'GET',
        url: 'https://example.test/app.js' }),
    ])
    expect(actionMap.actions[0]).toMatchObject({ requestIds: [
      'REQUEST-DISCOVERED-0001', 'REQUEST-DISCOVERED-0002',
    ], capabilities: expect.arrayContaining([
      expect.objectContaining({ operation: 'local-navigation' }),
      expect.objectContaining({ operation: 'dom-read' }),
      expect.objectContaining({ operation: 'screenshot' }),
      expect.objectContaining({ operation: 'http-request' }),
    ]) })
    const graphArtifacts = [...Object.values(snapshot().frozenArtifacts), ...Object.values(first.artifacts)]
    const paths = new Map(graphArtifacts.map((artifact) => [
      artifact.artifactId, `artifacts/${artifact.artifactType}.json`,
    ]))
    expect(auditArtifactGraph(graphArtifacts as AuditableArtifact[], paths)).toEqual({ valid: true, findings: [] })
    expect(auditExecutableCompilationClosure({
      plan: { cases: [{ caseId: 'CASE-0001', actionIds: ['ACTION-0001-0001'],
        oracleIds: ['ORACLE-0001-0001'] }] },
      binding: { cases: [{ caseId: 'CASE-0001', actionIds: ['ACTION-0001-0001'],
        oracleIds: ['ORACLE-0001-0001'] }] },
      artifacts: first.closure,
    })).toEqual({ valid: true, findings: [] })
  })

  test('写 Case 未完成 DataLease/Cleanup 投影时 fail closed', () => {
    const value = compilation()
    value.executableCases[0]!.actions[0]!.effect = 'reversible-write'
    expect(() => projectRuntimeExecutableArtifacts({ snapshot: snapshot(), compilation: value,
      createdAt: '2026-08-12T00:00:00.000Z', engineVersion: '0.8.0' }))
      .toThrow(/E2E_RUNTIME_EXECUTABLE_WRITE_PROJECTION_INCOMPLETE/)
  })

  test('healing 重投影使用单调 Action Map revision 并重算下游摘要', () => {
    const baseline = projectRuntimeExecutableArtifacts({ snapshot: snapshot(), compilation: compilation(),
      createdAt: '2026-08-12T00:00:00.000Z', engineVersion: '0.8.0' })
    const revised = projectRuntimeExecutableArtifacts({ snapshot: snapshot(), compilation: compilation(),
      actionMapRevision: 2, createdAt: '2026-08-12T00:00:00.000Z', engineVersion: '0.8.0' })
    expect((revised.artifacts['browser-action-map'].content as any).actionMapRevision).toBe(2)
    expect(revised.artifacts['browser-action-map'].contentDigest)
      .not.toBe(baseline.artifacts['browser-action-map'].contentDigest)
    expect(revised.artifacts['execution-contract'].contentDigest)
      .not.toBe(baseline.artifacts['execution-contract'].contentDigest)
    expect(revised.artifacts['run-bundle'].contentDigest)
      .not.toBe(baseline.artifacts['run-bundle'].contentDigest)
  })
})

function compilation(): ExecutableRunCompilation {
  const action = { kind: 'assert-only' as const, actionId: 'ACTION-0001-0001', effect: 'read' as const,
    pageScope: { page: 'current' as const, frame: { kind: 'main' as const } },
    locatorCandidates: [{ kind: 'text' as const, value: '待审核', exact: true }],
    timeout: { timeoutMs: 5_000, retry: 'read-only-max-2' as const } }
  const oracle = { kind: 'text' as const, oracleId: 'ORACLE-0001-0001', actionId: action.actionId,
    locatorCandidates: action.locatorCandidates, comparator: 'contains' as const, expected: '待审核',
    deadlineMs: 5_000, evidenceKinds: ['dom' as const] }
  const testCase = { caseId: 'CASE-0001', executionLane: 'trusted-read-only' as const,
    pageIdentityPolicy: { schemaVersion: '1.0.0' as const,
      url: { origin: 'https://example.test', pathPattern: '/orders' },
      signals: [{ kind: 'role' as const, role: 'main' as const, name: '订单' }], match: { mode: 'all' as const } },
    actions: [action], oracles: [oracle], dataNeeds: [], cleanupIntents: [] }
  const normalizedBinding = { schemaVersion: 'declarative-execution-binding/v1' as const,
    planCompilerDigest: d('plan'), targetProbeDigest: d('probe'), cases: [testCase], bindingDigest: d('binding') }
  return { schemaVersion: 'executable-run-compilation/v1', planCompilerDigest: d('plan'),
    targetProbeDigest: d('probe'), normalizedBinding, executableCases: [testCase], blockedCases: [],
    diagnostics: [], compilerDigest: d('compiler') }
}

function snapshot(): RuntimeRunSnapshot {
  const anchor = artifact('coverage-universe', '1.0.0', { coveragePolicyDigest: d('coverage'), pairwiseSeed: 1,
    universeDigest: d('universe'), obligations: [{ obligationId: 'OBL-1', reqId: 'REQ-1', clauseIds: ['CLAUSE-1'],
      ruleIds: ['RULE-1'], oracleIds: ['ORACLE-0001-0001'], nodeIds: ['REQ-1'], actor: 'USER',
      transitionId: 'not-applicable', scenario: '查看订单', necessity: 'required', applicabilityRuleId: 'RULE-1',
      disposition: { kind: 'automated', caseIds: ['CASE-0001'] } }] })
  const projectPolicy = artifact('project-policy', '2.0.0', { policyVersion: '1.0.0',
    environments: [{ environmentId: 'RUNTIME-TARGET', baseOrigin: 'https://example.test', riskTier: 'test' }],
    originPolicies: [{ origin: 'https://example.test', allowRead: true, allowWrite: false }],
    browserMatrix: [{ browserId: 'CHROME', channel: 'chrome', required: true }],
    coveragePolicy: { id: 'COVERAGE', digest: d('coverage-policy') },
    evidencePolicy: { id: 'EVIDENCE', digest: d('evidence-policy') },
    retentionPolicy: { id: 'RETENTION', digest: d('retention-policy') },
    riskPolicy: { id: 'RISK', digest: d('risk-policy') },
    timeoutPolicy: { id: 'TIMEOUT', digest: d('timeout-policy') },
    runtimePolicy: { id: 'RUNTIME', digest: d('runtime-policy') } })
  return { schemaVersion: '1.8.0', runId: 'RUN-1', assetId: 'PRODUCT/PRD-1', projectIdentityDigest: d('project'),
    runtimeInstallationDigest: d('runtime'), workflow: {
      current: 'preflight-readonly', sequence: 1, eventChainDigest: d('workflow'),
    },
    artifactDigests: { 'prd-source': d('prd'), 'coverage-universe': anchor.contentDigest,
      'project-policy': projectPolicy.contentDigest },
    frozenArtifacts: { 'coverage-universe': anchor, 'project-policy': projectPolicy }, trustedExecutionFacts: {},
    targetProbe: { schemaVersion: '1.0.0', trust: 'untrusted-diagnostic', runId: 'RUN-1',
      targetContractDigest: d('target'), status: 'ready', observedUrl: 'https://example.test/orders',
      observedTitle: '订单', identityMatched: true, diagnostics: { strategy: 'resource-closure', attempt: 1,
        domPresent: true, visibleTextSummary: '订单', consoleErrors: [], failedRequests: [], pendingResources: [],
        unapprovedResources: [], persistentConnections: [], observedResources: [
          { method: 'GET', url: 'https://example.test/orders', resourceType: 'document' },
          { method: 'GET', url: 'https://example.test/app.js', resourceType: 'script' },
        ], advisories: [], resourceSummary: { observedCount: 2,
          approvedCount: 1, pendingCount: 0, unapprovedCount: 0, persistentConnectionCount: 0, closureComplete: true } },
      probedAt: '2026-08-12T00:00:00.000Z', diagnosticDigest: d('probe') },
    requestResponses: {}, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }
}

function artifact(type: string, schemaVersion: string, content: unknown): ArtifactDocument {
  const value: any = { artifactId: `ARTIFACT-${type.toUpperCase()}`, artifactType: type, schemaVersion,
    engineVersion: '0.8.0', assetId: 'PRODUCT/PRD-1', prdRevision: d('prd'), generationId: 'RUN-1',
    createdAt: '2026-08-12T00:00:00.000Z', contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content }
  value.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, value)
  return value
}
