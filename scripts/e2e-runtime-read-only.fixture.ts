import {
  canonicalizeJson,
  computeRegressionSourceSetDigest,
  digestApprovalProjection,
  digestArtifactContent,
  digestText,
  type ArtifactDocument,
  type DecisionReceipt,
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
  evidencePolicyDigest?: string
  runtimePolicyDigest?: string
}) {
  const origin = new URL(input.url).origin
  const evidencePolicyDigest = input.evidencePolicyDigest ?? d('evidence-policy')
  const runtimePolicyDigest = input.runtimePolicyDigest ?? d('runtime-policy')
  const readRequest = {
    requestId: 'REQUEST-1', method: 'GET' as const, url: input.url,
    headers: [], bodyDigest: d('empty-body'), redirectPolicy: { mode: 'deny' as const },
  }
  const testCases = artifact(input, 'test-cases', {
    cases: [{
      caseId: 'CASE-ORDER-1', revision: 1, obligationIds: ['COV-ORDER-1'], title: '订单列表', actor: 'auditor',
      necessity: 'required', preconditions: [], dataNeedIds: [],
      steps: [{ stepId: 'STEP-ORDER-1', ordinal: 0, semanticAction: '查看', semanticTarget: '订单列表',
        oracles: [{ oracleId: 'ORACLE-1', statement: '页面显示待审核订单' }], evidenceKinds: ['screenshot'] }],
      mode: 'real-environment', effect: 'read', evidenceLevel: 'E2', cleanupPlanId: 'not-applicable',
      timeoutMs: 10_000, retryPolicy: 'read-automation-max-2', status: 'active',
    }], caseSetDigest: d('case-set'),
  })
  const executionContract = artifact(input, 'execution-contract', {
    environment: 'test', baseOrigin: origin,
    browserMatrix: [{ browserId: 'chromium', channel: 'chromium', viewportId: 'desktop' }],
    identities: [{
      identityId: 'IDENTITY-AUDITOR', roleIds: ['auditor'], secretRef: 'SECRET-REF-LOCAL',
    }],
    caseQueue: [{ ordinal: 0, caseId: 'CASE-ORDER-1' }],
    actionIntents: [{
      actionId: 'ACTION-ORDER-1', effect: 'read', intentDigest: d('intent'), requestIds: ['REQUEST-1'],
    }],
    readHttpRequests: [readRequest],
    dataNeeds: [], manualProcedures: [], evidencePolicyDigest,
    runtimeIsolation: null, unresolvedItems: [],
  })
  const actionMap = artifact(input, 'browser-action-map', {
    actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-1', origin, assertionDigest: d('page') }],
    actions: [{
      caseId: 'CASE-ORDER-1', stepId: 'STEP-ORDER-1', actionId: 'ACTION-ORDER-1', pageIdentityId: 'PAGE-1',
      locatorCandidates: [{ strategy: 'role', value: 'main', confidence: 1 }],
      playwrightAction: 'read-page/v1', waits: [], oracleIds: ['ORACLE-1'], effect: 'read',
      capabilities: [
        { operation: 'local-navigation', capabilityId: 'CAP-NAV' },
        { operation: 'dom-read', capabilityId: 'CAP-DOM' },
        { operation: 'screenshot', capabilityId: 'CAP-SHOT' },
        { operation: 'http-request', capabilityId: 'CAP-HTTP' },
      ],
      requestIds: ['REQUEST-1'],
    }], unmappedSteps: [], discoveredRisks: [],
  })
  const projectPolicy = semanticArtifact(input, 'project-policy', '2.0.0', {
    policyVersion: '1.0.0', environments: [{
      environmentId: 'test', baseOrigin: origin, riskTier: 'test',
    }],
    originPolicies: [{ origin, allowRead: true, allowWrite: false }],
    browserMatrix: [{ browserId: 'chromium', channel: 'chromium', required: true }],
    coveragePolicy: { id: 'COVERAGE-POLICY', digest: d('coverage-policy') },
    evidencePolicy: { id: 'EVIDENCE-POLICY', digest: evidencePolicyDigest },
    retentionPolicy: { id: 'RETENTION-POLICY', digest: d('retention-policy') },
    riskPolicy: { id: 'RISK-POLICY', digest: d('risk-policy') },
    timeoutPolicy: { id: 'TIMEOUT-POLICY', digest: d('timeout-policy') },
    runtimePolicy: { id: 'RUNTIME-POLICY', digest: runtimePolicyDigest },
  })
  const prdManifest = semanticArtifact(input, 'prd-manifest', '1.0.0', {
    prdId: 'PRD-ORDER-1', assetId: input.assetId, revision: input.prdRevision,
    normalizedPrdDigest: input.prdRevision,
    sources: [{ sourceId: 'PRD-ORDER-1', digest: input.prdRevision, byteLength: 1 }],
    attachments: [], sourceCacheIndexDigest: d('source-cache-index'),
  })
  const prdDiff = semanticArtifact(input, 'prd-diff', '2.0.0', {
    previousRevision: d('previous-prd'), currentRevision: input.prdRevision,
    sectionChanges: [], lineageMappings: [], impactedEntityIds: [],
    lineageReview: { decisionId: 'LINEAGE-ORDER-1', status: 'pending' },
  })
  const semanticGeneration = semanticArtifact(input, 'semantic-generation', '1.0.0', {
    modelProvider: 'runtime-cross-repo', modelId: 'DETERMINISTIC', modelVersion: '1.0.0',
    systemPromptDigest: d('system-prompt'), toolOutputDigests: [], sampling: { temperature: 0, seed: 1 },
    candidateDigests: [d('model-candidate')], selectedDigest: d('model-candidate'),
  })
  const acceptanceScope = semanticArtifact(input, 'acceptance-scope', '2.0.0', {
    includedReqCandidates: [{ reqId: 'REQ-ORDER-1', sourceRefs: ['PRD-ORDER-1'] }],
    exclusions: [], ambiguities: [], dependencies: [], visualScope: { required: false, refs: [] },
    browserScope: { browserIds: ['chromium'], viewportIds: ['desktop'] },
    scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
  })
  const requirementModel = semanticArtifact(input, 'requirement-model', '1.0.0', {
    modelRevision: 1,
    requirements: [{
      reqId: 'REQ-ORDER-1', revision: 1, title: '订单列表', actors: ['auditor'], entities: ['order'],
      preconditions: [], rules: [{ ruleId: 'RULE-ORDER-1', category: 'business',
        statement: '显示待审核订单', sourceRefs: ['PRD-ORDER-1'], certainty: 'explicit' }],
      states: [], transitions: [], observableOutcomes: [{ oracleId: 'ORACLE-1',
        statement: '页面显示待审核订单' }], applicability: [], sourceRefs: ['PRD-ORDER-1'], status: 'active',
    }],
    coupledDimensions: [], applicabilityRules: ['RULE-ORDER-1'], modelDecisionDigest: d('model-decision'),
  })
  const interactionFlow = semanticArtifact(input, 'interaction-flow', '1.0.0', { flows: [{
    flowId: 'FLOW-ORDER-1', nodes: [
      { nodeId: 'NODE-ORDER-ENTRY', reqId: 'REQ-ORDER-1', kind: 'entry', effect: 'read', oracleIds: ['ORACLE-1'] },
      { nodeId: 'NODE-ORDER-EXIT', reqId: 'REQ-ORDER-1', kind: 'exit', effect: 'read', oracleIds: ['ORACLE-1'] },
    ], edgeIds: ['EDGE-ORDER-1'], entryNodeId: 'NODE-ORDER-ENTRY', exitNodeIds: ['NODE-ORDER-EXIT'],
  }] })
  const obligations = [{
    obligationId: 'COV-ORDER-1', reqId: 'REQ-ORDER-1', ruleIds: ['RULE-ORDER-1'],
    nodeIds: ['NODE-ORDER-ENTRY', 'NODE-ORDER-EXIT'], actor: 'auditor', transitionId: 'not-applicable',
    scenario: '订单列表显示待审核订单', necessity: 'required', applicabilityRuleId: 'RULE-ORDER-1',
    disposition: { kind: 'automated' as const, caseIds: ['CASE-ORDER-1'] },
  }]
  const coverageUniverse = semanticArtifact(input, 'coverage-universe', '1.0.0', {
    coveragePolicyDigest: d('coverage-policy'), pairwiseSeed: 1,
    universeDigest: digestText('coverage-universe/v1', canonicalizeJson({
      coveragePolicyDigest: d('coverage-policy'), pairwiseSeed: 1, obligations,
    })), obligations,
  })
  const designAudit = semanticArtifact(input, 'design-audit', '1.0.0', {
    inputDigests: [requirementModel.contentDigest, coverageUniverse.contentDigest], metrics: [], findings: [],
    orphanIds: [], weakIds: [], status: 'passed',
  })
  const decidedScopeContent = (scopeReceipt?: DecisionReceipt): Record<string, unknown> => {
    const content = structuredClone(acceptanceScope.content) as Record<string, unknown>
    if (scopeReceipt) content.scopeDecision = {
      decisionId: 'SCOPE-1', status: 'approved', receipt: scopeReceipt,
    }
    return content
  }
  const discoverySubject = (
    decisions?: { scopeReceipt?: DecisionReceipt },
  ): DiscoveryApprovalSubject => ({
    schemaVersion: '1.1.0', assetId: input.assetId, prdRevision: input.prdRevision,
    scopeDigest: digestApprovalProjection('acceptance-scope',
      decidedScopeContent(decisions?.scopeReceipt)),
    environment: 'test', baseOrigin: origin, actor: 'auditor',
    expectedPageIdentity: { url: input.url, title: '订单', heading: '订单列表', ariaSignals: [] },
    bootstrapIntentsDigest: d('bootstrap'),
    requests: [],
    actions: [{ actionId: 'PREFLIGHT-1', operation: 'local-navigation', maxUses: 1, requestIds: [] }],
  })
  const readSubject = (
    discoveryGrantId: string,
    preflightDigest: string,
    decisions?: { scopeReceipt?: DecisionReceipt },
  ): ReadApprovalSubject => {
    const scopeContent = decidedScopeContent(decisions?.scopeReceipt)
    const runBundleProjection = {
      runId: input.runId,
      allInputRefs: [
        ['project-policy', projectPolicy.content], ['acceptance-scope', scopeContent],
        ['requirement-model', requirementModel.content], ['coverage-universe', coverageUniverse.content],
        ['test-cases', testCases.content], ['execution-contract', executionContract.content],
        ['browser-action-map', actionMap.content],
      ].map(([artifactType, content]) => ({
        artifactId: `ARTIFACT-${String(artifactType).toUpperCase()}`,
        digest: digestApprovalProjection(
          artifactType as Parameters<typeof digestApprovalProjection>[0], content,
        ),
      })),
      schedule: [{ ordinal: 0, caseId: 'CASE-ORDER-1', stepIds: ['STEP-ORDER-1'], actionIds: ['ACTION-ORDER-1'] }],
      attemptPlans: [{ caseId: 'CASE-ORDER-1', slots: 1 }],
      signedCapabilities: [
        { capabilityId: 'PENDING-NAV', actionId: 'ACTION-ORDER-1', operation: 'local-navigation', effect: 'read', maxUses: 1, digest: d('pending-nav') },
        { capabilityId: 'PENDING-DOM', actionId: 'ACTION-ORDER-1', operation: 'dom-read', effect: 'read', maxUses: 1, digest: d('pending-dom') },
        { capabilityId: 'PENDING-SHOT', actionId: 'ACTION-ORDER-1', operation: 'screenshot', effect: 'read', maxUses: 1, digest: d('pending-shot') },
        { capabilityId: 'PENDING-HTTP', actionId: 'ACTION-ORDER-1', operation: 'http-request', effect: 'read', maxUses: 1, digest: d('pending-http') },
      ],
      secretRefs: ['SECRET-REF-LOCAL'], runtimePolicyDigest, runtimeIsolationPolicyDigest: 'not-applicable',
    }
    return {
      schemaVersion: '2.1.0', assetId: input.assetId, prdRevision: input.prdRevision,
      scopeDigest: digestApprovalProjection('acceptance-scope', scopeContent),
      requirementModelDigest: digestApprovalProjection('requirement-model', requirementModel.content),
      coveragePolicyDigest: d('coverage-policy'),
      universeDigest: (coverageUniverse.content as { universeDigest: string }).universeDigest,
      caseDigest: digestApprovalProjection('test-cases', testCases.content),
      actionMapDigest: digestApprovalProjection('browser-action-map', actionMap.content),
      policyDigest: digestApprovalProjection('project-policy', projectPolicy.content),
      executionContractDigest: digestApprovalProjection('execution-contract', executionContract.content),
      runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundleProjection),
      environment: 'test', baseOrigin: origin, actor: 'auditor', discoveryGrantId, preflightDigest,
      requests: [readRequest],
      actions: [
        { actionId: 'ACTION-ORDER-1', operation: 'local-navigation', maxUses: 1, requestIds: [] },
        { actionId: 'ACTION-ORDER-1', operation: 'dom-read', maxUses: 1, requestIds: [] },
        { actionId: 'ACTION-ORDER-1', operation: 'screenshot', maxUses: 1, requestIds: [] },
        { actionId: 'ACTION-ORDER-1', operation: 'http-request', maxUses: 1, requestIds: ['REQUEST-1'] },
      ],
    }
  }
  const sourceFiles = [{
    relativePath: 'regression/tests/generated.spec.ts', digest: d('source'), byteLength: 1,
    mediaType: 'text/typescript' as const,
  }]
  const caseMappings = [{
    caseId: 'CASE-ORDER-1', relativePath: sourceFiles[0]!.relativePath, testTitle: '订单列表',
  }]
  const toolchain = {
    nodeVersion: '24.0.0', playwrightVersion: '1.61.1', typescriptVersion: '5.9.3',
    compilerDigest: d('compiler'), playwrightCliDigest: d('playwright-cli'),
  }
  const regressionManifest = artifact(input, 'regression-manifest', {
    testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
    templateDigest: d('template'), toolchain, sourceFiles, caseMappings,
    blockedCases: [], deprecatedCases: [],
    listResult: { caseIds: ['CASE-ORDER-1'], digest: d('list-result'), attestation: {
      schemaVersion: '2.1.0', testDomain: 'prd-e2e-trusted-compiler',
      executionProfile: 'trusted-read-only', assetId: input.assetId, generationId: input.runId,
      prdRevision: input.prdRevision, compilerVersion: '0.1.0', templateVersion: '0.1.0',
      contractsVersion: '2.0.0', environmentId: 'TEST', approvalDigest: d('approval'),
      policyDigest: d('policy'), templateDigest: d('template'), compilerInputDigest: d('compiler-input'),
      sourceFiles, caseMappings, toolchain,
      isolation: { command: ['node', '@playwright/test/cli', 'test', '--list', '--reporter=json'],
        exitCode: 0, stdoutDigest: d('list-output') },
      discoveredCaseIds: ['CASE-ORDER-1'], blockedCases: [],
      sourceSetDigest: computeRegressionSourceSetDigest(sourceFiles),
      issuer: 'runtime-golden', keyId: 'runtime-golden-key',
      purpose: 'regression-discovery-attestation/v2', algorithm: 'Ed25519',
      signedDigest: d('discovery-attestation'), signature: 'golden-attestation',
    } },
  })
  return {
    semanticArtifacts: {
      'project-policy': projectPolicy,
      'prd-request': semanticArtifact(input, 'prd-request', '1.0.0', {
        productSpace: 'PRODUCT', title: '订单验收 PRD',
        sourceDescriptors: [{ sourceId: 'PRD-BODY', kind: 'file', ref: 'inputs/prd.md' }],
        userRequest: '验证订单列表展示待审核订单', testWorkspaceId: 'WORKSPACE-1', secretRefs: [],
      }),
      'prd-manifest': prdManifest,
      'prd-diff': prdDiff,
      'semantic-generation': semanticGeneration,
      'acceptance-scope': acceptanceScope,
      'requirement-model': requirementModel,
      'interaction-flow': interactionFlow,
      'coverage-universe': coverageUniverse,
      'design-audit': designAudit,
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
  const schemaVersion = type === 'browser-action-map' ? '2.1.0'
    : type === 'execution-contract' ? '1.1.0'
      : type === 'regression-manifest' ? '2.0.0' : '1.0.0'
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
  type: 'project-policy' | 'prd-request' | 'prd-manifest' | 'prd-diff' | 'semantic-generation'
    | 'acceptance-scope' | 'requirement-model' | 'interaction-flow' | 'coverage-universe'
    | 'design-audit',
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
