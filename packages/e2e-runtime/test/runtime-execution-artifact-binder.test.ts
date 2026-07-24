import { describe, expect, test } from 'vitest'
import {
  canonicalizeJson,
  canonicalGrantApprovalSubjectDigest,
  digestApprovalProjection,
  digestArtifactContent,
  digestText,
  type ArtifactDocument,
  type SignedWriteGrant,
} from '@mutil-skills/e2e-contracts'
import { bindRuntimeExecutionGrantArtifacts } from '../src/runtime-execution-artifact-binder.js'
import { projectRuntimeFullPlaywrightSnapshot } from '../src/runtime-full-playwright-projector.js'
import { runtimeFullPlaywrightProjectionFixture } from './runtime-full-playwright-projector.test.js'

const d = (value: string) => digestText('runtime-execution-binder-test/v1', value)

describe('Runtime execution approval artifact binding', () => {
  test('用 Authority 实际 capability 回填 Action Map 并在执行前冻结同投影 Run Bundle', () => {
    const snapshot = completeSnapshot()
    const actionMap = structuredClone(snapshot.frozenArtifacts['browser-action-map']!)
    const content = actionMap.content as { actions: Array<{ capabilities: Array<{ capabilityId: string }> }> }
    content.actions[0]!.capabilities[0]!.capabilityId = 'PENDING-CAPABILITY'
    actionMap.contentDigest = digestArtifactContent(
      `artifact-content/${actionMap.schemaVersion}/${actionMap.artifactType}`,
      actionMap,
    )
    snapshot.frozenArtifacts['browser-action-map'] = actionMap as ArtifactDocument
    delete snapshot.frozenArtifacts['run-bundle']
    delete snapshot.artifactDigests['run-bundle']

    const grant = structuredClone(
      snapshot.trustedExecutionFacts['signed-execution-grant'],
    ) as SignedWriteGrant
    const policy = snapshot.frozenArtifacts['project-policy']!.content as any
    grant.subject.runBundleProjectionDigest = digestApprovalProjection('run-bundle', {
      runId: snapshot.runId,
      allInputRefs: [
        'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
        'test-cases', 'execution-contract', 'browser-action-map',
      ].map((type) => {
        const artifact = snapshot.frozenArtifacts[type]!
        return { artifactId: artifact.artifactId,
          digest: digestApprovalProjection(type as any, artifact.content) }
      }),
      schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
      attemptPlans: [{ caseId: 'CASE-1', slots: 1 }],
      signedCapabilities: grant.capabilities.map((capability) => ({
        capabilityId: capability.capabilityId, actionId: capability.actionId,
        operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
        digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
      })),
      secretRefs: [], runtimePolicyDigest: policy.runtimePolicy.digest,
      runtimeIsolationPolicyDigest: 'not-applicable',
    })
    grant.subjectDigest = canonicalGrantApprovalSubjectDigest(grant.subject)
    grant.approvalContext.subjectDigest = grant.subjectDigest
    const bound = bindRuntimeExecutionGrantArtifacts({
      snapshot,
      grant,
      createdAt: '2026-07-23T00:00:00.000Z',
      engineVersion: '0.3.0',
    })

    expect((bound.frozenArtifacts['browser-action-map']!.content as any)
      .actions[0].capabilities[0].capabilityId).toBe(grant.capabilities[0]!.capabilityId)
    expect(bound.frozenArtifacts['run-bundle']).toBeDefined()
    expect(bound.artifactDigests['run-bundle'])
      .toBe(bound.frozenArtifacts['run-bundle']!.contentDigest)
    expect(projectRuntimeFullPlaywrightSnapshot(bound)).toMatchObject({
      capability: { capabilityId: grant.capabilities[0]!.capabilityId },
    })
  })

  test('Grant 的 Run Bundle 审批投影与冻结资产不一致时拒绝接通执行', () => {
    const snapshot = completeSnapshot()
    const grant = structuredClone(
      snapshot.trustedExecutionFacts['signed-execution-grant'],
    ) as SignedWriteGrant
    grant.subject.runBundleProjectionDigest = `sha256:${'f'.repeat(64)}`

    expect(() => bindRuntimeExecutionGrantArtifacts({
      snapshot,
      grant,
      createdAt: '2026-07-23T00:00:00.000Z',
      engineVersion: '0.3.0',
    })).toThrow(/E2E_RUNTIME_RUN_BUNDLE_APPROVAL_MISMATCH/)
  })
})

function completeSnapshot() {
  const snapshot = runtimeFullPlaywrightProjectionFixture()
  const anchor = snapshot.frozenArtifacts['test-cases']!
  const origin = 'https://test.example.com'
  const semantic = {
    'project-policy': semanticArtifact(snapshot, anchor, 'project-policy', '2.0.0', {
      policyVersion: '1.0.0', environments: [{ environmentId: 'test', baseOrigin: origin, riskTier: 'test' }],
      originPolicies: [{ origin, allowRead: true, allowWrite: true }],
      browserMatrix: [{ browserId: 'chromium', channel: 'stable', required: true }],
      coveragePolicy: { id: 'COVERAGE', digest: d('coverage') },
      evidencePolicy: { id: 'EVIDENCE', digest: d('evidence') },
      retentionPolicy: { id: 'RETENTION', digest: d('retention') },
      riskPolicy: { id: 'RISK', digest: d('risk') },
      timeoutPolicy: { id: 'TIMEOUT', digest: d('timeout') },
      runtimePolicy: { id: 'RUNTIME', digest: d('runtime') },
    }),
    'acceptance-scope': semanticArtifact(snapshot, anchor, 'acceptance-scope', '2.0.0', {
      includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['PRD-1'] }], exclusions: [],
      ambiguities: [], dependencies: [], visualScope: { required: false, refs: [] },
      browserScope: { browserIds: ['chromium'], viewportIds: ['desktop'] },
      scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
    }),
    'requirement-model': semanticArtifact(snapshot, anchor, 'requirement-model', '1.0.0', {
      modelRevision: 1, requirements: [{ reqId: 'REQ-1', revision: 1, title: 'App', actors: ['qa'],
        entities: ['app'], preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business',
          statement: '状态可修改并清理', sourceRefs: ['PRD-1'], certainty: 'explicit' }], states: [],
        transitions: [], observableOutcomes: [{ oracleId: 'ORACLE-1', statement: '清理后状态恢复' }],
        applicability: [], sourceRefs: ['PRD-1'], status: 'active' }], coupledDimensions: [],
      applicabilityRules: ['RULE-1'], modelDecisionDigest: d('model'),
    }),
    'coverage-universe': semanticArtifact(snapshot, anchor, 'coverage-universe', '1.0.0', {
      coveragePolicyDigest: d('coverage'), pairwiseSeed: 1, universeDigest: d('universe'),
      obligations: [{ obligationId: 'OBL-1', reqId: 'REQ-1', ruleIds: ['RULE-1'], nodeIds: [],
        actor: 'qa', transitionId: 'not-applicable', scenario: '状态修改与清理', necessity: 'required',
        applicabilityRuleId: 'RULE-1', disposition: { kind: 'automated', caseIds: ['CASE-1'] } }],
    }),
  }
  for (const [type, artifact] of Object.entries(semantic)) {
    snapshot.frozenArtifacts[type] = artifact
    snapshot.artifactDigests[type] = artifact.contentDigest
  }
  return snapshot
}

function semanticArtifact(
  snapshot: ReturnType<typeof runtimeFullPlaywrightProjectionFixture>,
  anchor: ArtifactDocument,
  type: string,
  schemaVersion: string,
  content: unknown,
): ArtifactDocument {
  const document: Record<string, unknown> = {
    artifactId: `ART-${type}`, artifactType: type, schemaVersion, engineVersion: '0.3.0',
    assetId: snapshot.assetId, prdRevision: anchor.prdRevision, generationId: anchor.generationId,
    createdAt: '2026-07-23T00:00:00.000Z', contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}
