import {
  computeRegressionSourceSetDigest,
  digestArtifactContent,
  digestText,
  type ArtifactDocument,
  type DiscoveryApprovalSubject,
  type ReadApprovalSubject,
} from '@mutil-skills/e2e-contracts'

const d = (label: string) => digestText('runtime-real-golden/v1', label)

export function runtimeReadOnlyFixture(input: {
  runId: string
  assetId: string
  prdRevision: string
  installationDigest: string
  url: string
  now: Date
}) {
  const origin = new URL(input.url).origin
  const testCases = artifact(input, 'test-cases', {
    cases: [{
      caseId: 'CASE-1', revision: 1, obligationIds: ['OBL-1'], title: '订单列表', actor: 'auditor',
      necessity: 'required', preconditions: [], dataNeedIds: [],
      steps: [{ stepId: 'STEP-1', ordinal: 0, semanticAction: '查看', semanticTarget: '订单列表',
        oracles: [{ oracleId: 'ORACLE-1', statement: '页面显示待审核订单' }], evidenceKinds: ['screenshot'] }],
      mode: 'real-environment', effect: 'read', evidenceLevel: 'E2', cleanupPlanId: 'not-applicable',
      timeoutMs: 10_000, retryPolicy: 'read-automation-max-2', status: 'active',
    }], caseSetDigest: d('case-set'),
  })
  const executionContract = artifact(input, 'execution-contract', {
    environment: 'test', baseOrigin: origin,
    browserMatrix: [{ browserId: 'chromium', channel: 'chromium', viewportId: 'desktop' }],
    identities: [], caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }],
    actionIntents: [{ actionId: 'ACTION-1', effect: 'read', intentDigest: d('intent') }],
    dataNeeds: [], manualProcedures: [], evidencePolicyDigest: d('evidence-policy'),
    runtimeIsolation: null, unresolvedItems: [],
  })
  const actionMap = artifact(input, 'browser-action-map', {
    actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-1', origin, assertionDigest: d('page') }],
    actions: [{
      caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
      locatorCandidates: [{ strategy: 'role', value: 'main', confidence: 1 }],
      playwrightAction: 'read-page/v1', waits: [], oracleIds: ['ORACLE-1'], effect: 'read',
      capabilities: [
        { operation: 'local-navigation', capabilityId: 'CAP-NAV' },
        { operation: 'dom-read', capabilityId: 'CAP-DOM' },
        { operation: 'screenshot', capabilityId: 'CAP-SHOT' },
      ],
    }], unmappedSteps: [], discoveredRisks: [],
  })
  const discoverySubject: DiscoveryApprovalSubject = {
    schemaVersion: '1.0.0', assetId: input.assetId, prdRevision: input.prdRevision, scopeDigest: d('scope'),
    environment: 'test', baseOrigin: origin, actor: 'auditor',
    expectedPageIdentity: { url: input.url, title: '订单', heading: '订单列表', ariaSignals: [] },
    bootstrapIntentsDigest: d('bootstrap'),
    actions: [{ actionId: 'PREFLIGHT-1', operation: 'local-navigation', maxUses: 1 }],
  }
  const readSubject = (discoveryGrantId: string, preflightDigest: string): ReadApprovalSubject => ({
    schemaVersion: '2.0.0', assetId: input.assetId, prdRevision: input.prdRevision, scopeDigest: d('scope'),
    requirementModelDigest: d('model'), coveragePolicyDigest: d('coverage-policy'), universeDigest: d('universe'),
    caseDigest: testCases.contentDigest, actionMapDigest: actionMap.contentDigest, policyDigest: d('policy'),
    executionContractDigest: executionContract.contentDigest, runBundleProjectionDigest: d('run-bundle'),
    environment: 'test', baseOrigin: origin, actor: 'auditor', discoveryGrantId, preflightDigest,
    actions: [
      { actionId: 'ACTION-1', operation: 'local-navigation', maxUses: 1 },
      { actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1 },
      { actionId: 'ACTION-1', operation: 'screenshot', maxUses: 1 },
    ],
  })
  const sourceFiles = [{
    relativePath: 'regression/tests/generated.spec.ts', digest: d('source'), byteLength: 1,
    mediaType: 'text/typescript' as const,
  }]
  const caseMappings = [{
    caseId: 'CASE-1', relativePath: sourceFiles[0]!.relativePath, testTitle: '订单列表',
  }]
  const toolchain = {
    nodeVersion: '24.0.0', playwrightVersion: '1.61.1',
    compilerDigest: d('compiler'), playwrightCliDigest: d('playwright-cli'),
  }
  const regressionManifest = artifact(input, 'regression-manifest', {
    testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
    templateDigest: d('template'), toolchain, sourceFiles, caseMappings,
    blockedCases: [], deprecatedCases: [],
    listResult: { caseIds: ['CASE-1'], digest: d('list-result'), attestation: {
      schemaVersion: '2.0.0', testDomain: 'prd-e2e-trusted-compiler',
      executionProfile: 'trusted-read-only', assetId: input.assetId, generationId: input.runId,
      prdRevision: input.prdRevision, compilerVersion: '0.1.0', templateVersion: '0.1.0',
      contractsVersion: '2.0.0', environmentId: 'TEST', approvalDigest: d('approval'),
      policyDigest: d('policy'), templateDigest: d('template'), compilerInputDigest: d('compiler-input'),
      sourceFiles, caseMappings, toolchain,
      isolation: { command: ['node', '@playwright/test/cli', 'test', '--list', '--reporter=json'],
        exitCode: 0, stdoutDigest: d('list-output') },
      discoveredCaseIds: ['CASE-1'], blockedCases: [],
      sourceSetDigest: computeRegressionSourceSetDigest(sourceFiles),
      issuer: 'runtime-golden', keyId: 'runtime-golden-key',
      purpose: 'regression-discovery-attestation/v2', algorithm: 'Ed25519',
      signedDigest: d('discovery-attestation'), signature: 'golden-attestation',
    } },
  })
  return {
    semanticArtifacts: {
      'prd-request': semanticArtifact(input, 'prd-request', '1.0.0', {
        productSpace: 'PRODUCT', title: '订单验收 PRD',
        sourceDescriptors: [{ sourceId: 'PRD-BODY', kind: 'file', ref: 'inputs/prd.md' }],
        userRequest: '验证订单列表展示待审核订单', testWorkspaceId: 'WORKSPACE-1', secretRefs: [],
      }),
      'acceptance-scope': semanticArtifact(input, 'acceptance-scope', '2.0.0', {
        includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['inputs/prd.md'] }],
        exclusions: [], ambiguities: [], dependencies: [], visualScope: { required: false, refs: [] },
        browserScope: { browserIds: ['chromium'], viewportIds: ['desktop'] },
        scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
      }),
      'requirement-model': semanticArtifact(input, 'requirement-model', '1.0.0', {
        modelRevision: 1,
        requirements: [{
          reqId: 'REQ-1', revision: 1, title: '订单列表', actors: ['auditor'], entities: ['order'],
          preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business',
            statement: '显示待审核订单', sourceRefs: ['inputs/prd.md'], certainty: 'explicit' }],
          states: [], transitions: [], observableOutcomes: [{ oracleId: 'ORACLE-1',
            statement: '页面显示待审核订单' }], applicability: [], sourceRefs: ['inputs/prd.md'], status: 'active',
        }],
        coupledDimensions: [], applicabilityRules: ['RULE-1'], modelDecisionDigest: d('model-decision'),
      }),
      'coverage-universe': semanticArtifact(input, 'coverage-universe', '1.0.0', {
        coveragePolicyDigest: d('coverage-policy'), pairwiseSeed: 1,
        universeDigest: d('universe'), obligations: [],
      }),
    },
    frozenArtifacts: {
      'test-cases': testCases, 'execution-contract': executionContract, 'browser-action-map': actionMap,
    },
    discoverySubject,
    readSubject,
    regressionManifest,
  }
}

function artifact(
  input: { runId: string; assetId: string; prdRevision: string },
  type: 'test-cases' | 'execution-contract' | 'browser-action-map' | 'regression-manifest',
  content: unknown,
) {
  const schemaVersion = type === 'browser-action-map' || type === 'regression-manifest' ? '2.0.0' : '1.0.0'
  const document: Record<string, unknown> = {
    artifactId: `ARTIFACT-${type}`, artifactType: type, schemaVersion, engineVersion: '0.1.0',
    assetId: input.assetId, prdRevision: input.prdRevision, generationId: input.runId,
    createdAt: '2026-07-17T00:00:00.000Z', contentDigest: d('placeholder'),
    signatures: [], dependencies: [], graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}

function semanticArtifact(
  input: { runId: string; assetId: string; prdRevision: string },
  type: 'prd-request' | 'acceptance-scope' | 'requirement-model' | 'coverage-universe',
  schemaVersion: string,
  content: unknown,
): ArtifactDocument {
  const document: Record<string, unknown> = {
    artifactId: `ARTIFACT-${type}`, artifactType: type, schemaVersion, engineVersion: '0.1.0',
    assetId: input.assetId, prdRevision: input.prdRevision, generationId: input.runId,
    createdAt: '2026-07-17T00:00:00.000Z', contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}
