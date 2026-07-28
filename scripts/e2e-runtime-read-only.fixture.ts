import {
  canonicalizeJson,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  computeRegressionSourceSetDigest,
  digestApprovalProjection,
  digestArtifactContent,
  digestCleanupPlanDefinition,
  digestOracleCheckpointValue,
  digestPrdClause,
  digestPrdClauseInventory,
  digestPrdUnderstandingProjection,
  digestText,
  type ArtifactDocument,
  type DecisionReceipt,
  type DiscoveryApprovalSubject,
  type ReadApprovalSubject,
} from '@mutil-skills/e2e-contracts'

const d = (label: string) => digestText('runtime-real-golden/v1', label)

interface RuntimeUnderstandingInput {
  prdRevision: string
  understandingContractDigest?: string
  sourceBundle?: Array<{
    sourceId: string
    kind: 'file'
    ref: string
    mediaType: string
    origin: { kind: 'file' | 'url' | 'text'; ref: string }
    relevance: 'target' | 'necessary-dependency'
    digest: string
    byteLength: number
  }>
}

function understandingProjection(input: RuntimeUnderstandingInput) {
  const value = {
    schemaVersion: '1.0.0' as const, contractId: 'CONTRACT-RUNTIME-GOLDEN', contractVersion: 1,
    contractStatus: 'confirmed-by-caller' as const, sourceRevision: input.prdRevision,
    contractSourceDigest: input.understandingContractDigest ?? d('understanding-contract'),
    sources: input.sourceBundle?.map((source) => ({
      sourceId: source.sourceId, kind: source.kind, ref: source.ref,
      origin: source.origin,
      relevance: source.relevance,
      digest: source.digest, byteLength: source.byteLength,
    })) ?? [{ sourceId: 'PRD-BODY', kind: 'file' as const, ref: 'inputs/prd.md',
      origin: { kind: 'file' as const, ref: 'inputs/prd.md' }, relevance: 'target' as const,
      digest: d('understanding-source'), byteLength: 1 }],
    nodes: [{ nodeId: 'REQ-ORDER-1', kind: 'REQ' as const, statement: '验证订单验收行为',
      provenance: { kind: 'confirmed-decision' as const, decisionId: 'DECISION-GOLDEN-1',
        decisionRef: 'fixture:runtime-golden' }, responsibility: '订单页面',
      upstreamNodeIds: [], downstreamNodeIds: [], acceptanceCriteria: ['订单验收行为符合预期'] }],
    pendingQuestions: [], route: { skillName: 'e2e' as const, steps: [{ stepId: 'E2E-GOLDEN-1',
      inputNodeIds: ['REQ-ORDER-1'], output: 'E2E Golden 报告', constraints: [],
      dependencyStepIds: [], completionCondition: 'REQ-ORDER-1 已覆盖' }] },
    authorization: { status: 'confirmed-by-caller' as const, contractVersion: 1,
      authorizedNodeIds: ['REQ-ORDER-1'], confirmedAt: '2026-07-17T00:00:00.000Z' },
    projectionDigest: '',
  }
  return { ...value, projectionDigest: digestPrdUnderstandingProjection(value) }
}

export function runtimeReadOnlyFixture(input: {
  runId: string
  assetId: string
  prdRevision: string
  installationDigest: string
  url: string
  now: Date
  evidencePolicyDigest?: string
  runtimePolicyDigest?: string
  understandingContractDigest?: string
  sourceBundle?: RuntimeUnderstandingInput['sourceBundle']
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
  const orderClauseMaterial = {
    clauseId: 'CLAUSE-ORDER-1', sourceId: 'PRD-ORDER-1', kind: 'functional' as const,
    sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 11 },
    originalText: '页面显示待审核订单', normalizedText: '页面显示待审核订单',
  }
  const orderClause = { ...orderClauseMaterial, textDigest: digestPrdClause(orderClauseMaterial) }
  const prdManifest = semanticArtifact(input, 'prd-manifest', '1.0.0', {
    prdId: 'PRD-ORDER-1', assetId: input.assetId, revision: input.prdRevision,
    normalizedPrdDigest: input.prdRevision,
    sources: [{ sourceId: 'PRD-ORDER-1', digest: input.prdRevision, byteLength: 1 }],
    attachments: [], sourceCacheIndexDigest: d('source-cache-index'),
    clauses: [orderClause], clauseInventoryDigest: digestPrdClauseInventory([orderClause]),
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
    includedReqCandidates: [{ reqId: 'REQ-ORDER-1', sourceRefs: ['CLAUSE-ORDER-1'] }],
    exclusions: [], ambiguities: [], dependencies: [], visualScope: { required: false, refs: [] },
    browserScope: { browserIds: ['chromium'], viewportIds: ['desktop'] },
    clauseDispositions: [{ clauseId: 'CLAUSE-ORDER-1', disposition: 'modeled',
      requirementIds: ['REQ-ORDER-1'] }],
    scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
  })
  const requirementModel = semanticArtifact(input, 'requirement-model', '1.0.0', {
    modelRevision: 1,
    requirements: [{
      reqId: 'REQ-ORDER-1', contractNodeIds: ['REQ-ORDER-1'], revision: 1,
      title: '订单列表', actors: ['auditor'], entities: ['order'],
      preconditions: [], rules: [{ ruleId: 'RULE-ORDER-1', category: 'business',
        contractNodeIds: ['REQ-ORDER-1'],
        statement: '显示待审核订单', sourceRefs: ['CLAUSE-ORDER-1'], certainty: 'explicit',
        oracleIds: ['ORACLE-1'] }],
      states: [], transitions: [], observableOutcomes: [{ oracleId: 'ORACLE-1',
        ruleId: 'RULE-ORDER-1', statement: '页面显示待审核订单', sourceRefs: ['CLAUSE-ORDER-1'],
        contractAcceptanceCriteria: [{ nodeId: 'REQ-ORDER-1', criterionIndex: 0 }] }],
      applicability: [], sourceRefs: ['CLAUSE-ORDER-1'], status: 'active',
    }],
    coupledDimensions: [], applicabilityRules: ['RULE-ORDER-1'], modelDecisionDigest: d('model-decision'),
  })
  const interactionFlow = semanticArtifact(input, 'interaction-flow', '1.0.0', { flows: [{
    flowId: 'FLOW-ORDER-1', contractNodeIds: ['REQ-ORDER-1'], nodes: [
      { nodeId: 'NODE-ORDER-ENTRY', reqId: 'REQ-ORDER-1', kind: 'entry', effect: 'read', oracleIds: ['ORACLE-1'] },
      { nodeId: 'NODE-ORDER-EXIT', reqId: 'REQ-ORDER-1', kind: 'exit', effect: 'read', oracleIds: ['ORACLE-1'] },
    ], edgeIds: ['EDGE-ORDER-1'], entryNodeId: 'NODE-ORDER-ENTRY', exitNodeIds: ['NODE-ORDER-EXIT'],
  }] })
  const obligations = [{
    obligationId: 'COV-ORDER-1', reqId: 'REQ-ORDER-1', ruleIds: ['RULE-ORDER-1'],
    clauseIds: ['CLAUSE-ORDER-1'], oracleIds: ['ORACLE-1'],
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
        ['project-policy', projectPolicy, projectPolicy.content],
        ['acceptance-scope', acceptanceScope, scopeContent],
        ['requirement-model', requirementModel, requirementModel.content],
        ['coverage-universe', coverageUniverse, coverageUniverse.content],
        ['test-cases', testCases, testCases.content],
        ['execution-contract', executionContract, executionContract.content],
        ['browser-action-map', actionMap, actionMap.content],
      ].map(([artifactType, document, content]) => ({
        artifactId: (document as ArtifactDocument).artifactId,
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
      'prd-request': semanticArtifact(input, 'prd-request', '2.0.0', {
        productSpace: 'PRODUCT', title: '订单验收 PRD',
        sourceDescriptors: [{ sourceId: 'PRD-BODY', kind: 'file', ref: 'inputs/prd.md' }],
        userRequest: '验证订单列表展示待审核订单', testWorkspaceId: 'WORKSPACE-1', secretRefs: [],
        understanding: understandingProjection(input),
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

export function runtimeFullPlaywrightFixture(input: {
  runId: string
  assetId: string
  prdRevision: string
  installationDigest: string
  url: string
  now: Date
  evidencePolicyDigest?: string
  runtimePolicyDigest?: string
  understandingContractDigest?: string
  sourceBundle?: RuntimeUnderstandingInput['sourceBundle']
}) {
  const base = runtimeReadOnlyFixture(input)
  const origin = new URL(input.url).origin
  const targetFingerprint = d('full-playwright-target')
  const jsonBody = canonicalizeJson({ enabled: true, name: 'Ada' })
  const requests = [
    request('DOCUMENT', 'GET', '/', 3, 1),
    request('POPUP', 'GET', '/popup', 1, 2),
    request('EXTRA', 'GET', '/extra', 1, 3),
    request('API', 'POST', '/api', 1, 4, {
      kind: 'json' as const, digest: digestText('http-json-payload/v1', jsonBody),
    }),
    request('RESET', 'POST', '/reset', 1, 5),
  ]
  const source = [
    `await page.goto('${origin}/')`,
    "await page.getByLabel('Name').fill('Ada')",
    "await page.getByLabel('Name').press('Enter')",
    "await page.getByLabel('Enabled').check()",
    "await expect(page.getByLabel('Name')).toHaveValue('Ada')",
    "await expect(page.getByLabel('Enabled')).toBeChecked()",
    "const popupReady = context.waitForEvent('page')",
    "await page.getByRole('link', { name: 'Details' }).click()",
    'const popup = await popupReady',
    "await expect(popup).toHaveTitle('popup')",
    "await page.locator('#row').dblclick()",
    "await page.locator('#remove').hover()",
    'const extra = await browser.newContext()',
    'const extraPage = await extra.newPage()',
    `await extraPage.goto('${origin}/extra')`,
    "await expect(extraPage).toHaveTitle('extra')",
    'await extra.close()',
    `const response = await request.post('${origin}/api', { data: { enabled: true, name: 'Ada' } })`,
    'await expect(response.ok()).toBeTruthy()',
    "await checkpoint({ checkpointId: 'CHECKPOINT-FULL-1', oracleId: 'ORACLE-1', actual: true })",
    'state.programCompleted = true',
  ].join('\n')
  const cleanupSource = [
    `const reset = await request.post('${origin}/reset')`,
    'await expect(reset.ok()).toBeTruthy()',
    `await page.goto('${origin}/')`,
    "await expect(page.locator('#state')).toHaveText('clean')",
    'await page.reload()',
    "await expect(page.locator('#state')).toHaveText('clean')",
    "return 'verified-clean'",
  ].join('\n')
  const program = {
    schemaVersion: 'full-playwright/v1' as const,
    caseId: 'CASE-FULL-1', stepId: 'STEP-FULL-1', actionId: 'ACTION-FULL-1',
    source, sourceDigest: computeFullPlaywrightSourceDigest(source),
    cleanupSource, cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource),
    dataLeaseId: 'LEASE-FULL-1', cleanupPlanId: 'CLEANUP-FULL-1', timeoutMs: 30_000,
    oracleCheckpoints: [{ checkpointId: 'CHECKPOINT-FULL-1', oracleId: 'ORACLE-1',
      expectedJson: 'true', expectedDigest: digestOracleCheckpointValue('true') }],
    networkRequests: requests,
    networkRequestBodies: [{ intentId: 'API', kind: 'json' as const, canonicalJson: jsonBody }],
  }
  const cleanupPlan = {
    schemaVersion: '2.0.0' as const, transport: 'browser-local' as const,
    cleanupPlanId: 'CLEANUP-FULL-1', actionId: 'ACTION-FULL-1', leaseId: 'LEASE-FULL-1',
    executorId: 'FULL-PLAYWRIGHT' as const, cleanupProgramDigest: program.cleanupSourceDigest,
    cleanupRequestIntentIds: ['RESET'],
    verificationProbes: [{ probeId: 'PROBE-CLEAN-1', kind: 'browser-observation' as const,
      expectedDigest: d('clean-state') }], timeoutMs: 30_000,
  }
  const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan)
  const testCases = artifact(input, 'test-cases', {
    cases: [{
      caseId: 'CASE-FULL-1', revision: 1, obligationIds: ['COV-ORDER-1'],
      title: '完整浏览器交互与清理', actor: 'auditor', necessity: 'required', preconditions: [],
      dataNeedIds: ['LEASE-FULL-1'], steps: [{
        stepId: 'STEP-FULL-1', ordinal: 0, semanticAction: '填写并提交表单', semanticTarget: '验收页面',
        oracles: [{ oracleId: 'ORACLE-1', statement: '写操作成功且清理后页面恢复 clean' }],
        evidenceKinds: ['screenshot', 'dom', 'trace', 'gateway-audit'],
      }], mode: 'real-environment', effect: 'reversible-write', evidenceLevel: 'E2',
      cleanupPlanId: 'CLEANUP-FULL-1', timeoutMs: 30_000,
      retryPolicy: 'verified-not-applied-max-1', status: 'active',
    }], caseSetDigest: d('full-case-set'),
  })
  const executionContract = artifact(input, 'execution-contract', {
    executionProfile: 'full-playwright', environment: 'test', baseOrigin: origin,
    browserMatrix: [{ browserId: 'chromium', channel: 'stable', viewportId: 'desktop' }],
    identities: [{
      identityId: 'IDENTITY-AUDITOR', roleIds: ['auditor'], secretRef: 'SECRET-REF-LOCAL',
    }],
    caseQueue: [{ ordinal: 0, caseId: 'CASE-FULL-1' }],
    actionIntents: [{ actionId: 'ACTION-FULL-1', effect: 'reversible-write',
      intentDigest: program.sourceDigest, requestIds: [] }],
    readHttpRequests: [], writeCleanupPlans: [cleanupPlan], fullPlaywrightPrograms: [program],
    dataNeeds: [{ leaseId: 'LEASE-FULL-1', resourceKey: 'full:fixture',
      resourceFingerprint: targetFingerprint, mode: 'write' }],
    manualProcedures: [], evidencePolicyDigest: input.evidencePolicyDigest ?? d('evidence-policy'),
    runtimeIsolation: null, unresolvedItems: [],
  })
  const actionMap = artifact(input, 'browser-action-map', {
    executionProfile: 'full-playwright', actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-FULL-1', origin, assertionDigest: d('full-page') }],
    fullPlaywrightPrograms: [program], actions: [{
      caseId: 'CASE-FULL-1', stepId: 'STEP-FULL-1', actionId: 'ACTION-FULL-1',
      pageIdentityId: 'PAGE-FULL-1', locatorCandidates: [], playwrightAction: 'full-playwright/v1',
      waits: [], oracleIds: ['ORACLE-1'], effect: 'reversible-write',
      capabilities: [{ operation: 'full-playwright', capabilityId: 'PENDING-FULL' }], requestIds: [],
    }], unmappedSteps: [], discoveredRisks: [],
  })
  const projectPolicy = replaceArtifactContent(base.semanticArtifacts['project-policy'], {
    ...(base.semanticArtifacts['project-policy'].content as Record<string, unknown>),
    originPolicies: [{ origin, allowRead: true, allowWrite: true }],
  })
  const requirementModel = replaceArtifactContent(base.semanticArtifacts['requirement-model'], {
    ...(base.semanticArtifacts['requirement-model'].content as Record<string, unknown>),
    requirements: [{
      reqId: 'REQ-ORDER-1', contractNodeIds: ['REQ-ORDER-1'], revision: 1,
      title: '完整浏览器交互与清理', actors: ['auditor'],
      entities: ['form'], preconditions: [], rules: [{
        ruleId: 'RULE-ORDER-1', contractNodeIds: ['REQ-ORDER-1'], category: 'business',
        statement: '表单写入后必须执行独立清理并通过 reload 验证',
        sourceRefs: ['CLAUSE-ORDER-1'], certainty: 'explicit', oracleIds: ['ORACLE-1'],
      }], states: [], transitions: [], observableOutcomes: [{
        oracleId: 'ORACLE-1', ruleId: 'RULE-ORDER-1',
        statement: '写操作成功且清理后页面恢复 clean', sourceRefs: ['CLAUSE-ORDER-1'],
        contractAcceptanceCriteria: [{ nodeId: 'REQ-ORDER-1', criterionIndex: 0 }],
      }], applicability: [], sourceRefs: ['CLAUSE-ORDER-1'], status: 'active',
    }],
  })
  const coverageContent = structuredClone(
    base.semanticArtifacts['coverage-universe'].content,
  ) as Record<string, any>
  coverageContent.obligations = coverageContent.obligations.map((obligation: Record<string, any>) => ({
    ...obligation,
    scenario: '完整浏览器交互与清理',
    disposition: obligation.disposition.kind === 'automated'
      ? { ...obligation.disposition, caseIds: ['CASE-FULL-1'] }
      : obligation.disposition,
  }))
  coverageContent.universeDigest = digestText('coverage-universe/v1', canonicalizeJson({
    coveragePolicyDigest: coverageContent.coveragePolicyDigest,
    pairwiseSeed: coverageContent.pairwiseSeed,
    obligations: coverageContent.obligations,
  }))
  const coverageUniverse = replaceArtifactContent(
    base.semanticArtifacts['coverage-universe'], coverageContent,
  )
  const designAudit = replaceArtifactContent(base.semanticArtifacts['design-audit'], {
    ...(base.semanticArtifacts['design-audit'].content as Record<string, unknown>),
    inputDigests: [requirementModel.contentDigest, coverageUniverse.contentDigest],
  })
  const decidedScope = (scopeReceipt?: DecisionReceipt) => {
    const content = structuredClone(base.semanticArtifacts['acceptance-scope'].content) as Record<string, unknown>
    if (scopeReceipt) content.scopeDecision = {
      decisionId: 'SCOPE-1', status: 'approved', receipt: scopeReceipt,
    }
    return content
  }
  const writeSubject = (discoveryGrantId: string, preflightDigest: string,
    decisions?: { scopeReceipt?: DecisionReceipt }) => {
    const scopeContent = decidedScope(decisions?.scopeReceipt)
    const allInputRefs = [
      ['project-policy', projectPolicy],
      ['acceptance-scope', { ...base.semanticArtifacts['acceptance-scope'], content: scopeContent }],
      ['requirement-model', requirementModel],
      ['coverage-universe', coverageUniverse],
      ['test-cases', testCases], ['execution-contract', executionContract], ['browser-action-map', actionMap],
    ].map(([artifactType, document]) => ({
      artifactId: (document as ArtifactDocument).artifactId,
      digest: digestApprovalProjection(artifactType as Parameters<typeof digestApprovalProjection>[0],
        (document as ArtifactDocument).content),
    }))
    const runBundleProjection = {
      runId: input.runId, allInputRefs,
      schedule: [{ ordinal: 0, caseId: 'CASE-FULL-1', stepIds: ['STEP-FULL-1'],
        actionIds: ['ACTION-FULL-1'] }],
      attemptPlans: [{ caseId: 'CASE-FULL-1', slots: 1 }],
      signedCapabilities: [{ capabilityId: 'PENDING-FULL', actionId: 'ACTION-FULL-1',
        operation: 'full-playwright', effect: 'reversible-write', maxUses: 1, digest: d('pending-full') }],
      secretRefs: ['SECRET-REF-LOCAL'],
      runtimePolicyDigest: ((projectPolicy.content as any).runtimePolicy as { digest: string }).digest,
      runtimeIsolationPolicyDigest: 'not-applicable',
    }
    return {
      schemaVersion: '2.0.0' as const, assetId: input.assetId, prdRevision: input.prdRevision,
      executionDigest: d('full-execution'),
      scopeDigest: digestApprovalProjection('acceptance-scope', scopeContent),
      requirementModelDigest: digestApprovalProjection('requirement-model', requirementModel.content),
      coveragePolicyDigest: d('coverage-policy'),
      universeDigest: (coverageUniverse.content as { universeDigest: string }).universeDigest,
      caseDigest: digestApprovalProjection('test-cases', testCases.content),
      actionMapDigest: digestApprovalProjection('browser-action-map', actionMap.content),
      policyDigest: digestApprovalProjection('project-policy', projectPolicy.content),
      executionContractDigest: digestApprovalProjection('execution-contract', executionContract.content),
      runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundleProjection),
      environment: 'test' as const, baseOrigin: origin, actor: 'auditor', discoveryGrantId, preflightDigest,
      actions: [{
        actionId: 'ACTION-FULL-1', effect: 'reversible-write' as const,
        dataLeaseId: 'LEASE-FULL-1', resourceKey: 'full:fixture', fencingToken: 1, cleanupPlanDigest,
        transport: 'browser-local' as const, operation: 'full-playwright' as const,
        programDigest: program.sourceDigest, cleanupProgramDigest: program.cleanupSourceDigest, requests,
      }],
    }
  }
  const regressionManifest = replaceArtifactContent(base.regressionManifest, (() => {
    const content = structuredClone(base.regressionManifest.content) as any
    content.executionProfile = 'full-playwright'
    content.caseMappings = content.caseMappings.map((item: any) => ({ ...item, caseId: 'CASE-FULL-1',
      testTitle: '完整浏览器交互与清理' }))
    content.listResult.caseIds = ['CASE-FULL-1']
    content.listResult.attestation.executionProfile = 'full-playwright'
    content.listResult.attestation.discoveredCaseIds = ['CASE-FULL-1']
    content.listResult.attestation.caseMappings = content.caseMappings
    return content
  })())
  return {
    semanticArtifacts: { ...base.semanticArtifacts, 'project-policy': projectPolicy,
      'requirement-model': requirementModel, 'coverage-universe': coverageUniverse,
      'design-audit': designAudit },
    frozenArtifacts: { 'test-cases': testCases, 'execution-contract': executionContract,
      'browser-action-map': actionMap },
    discoverySubject: base.discoverySubject,
    writeSubject,
    regressionManifest,
    expected: { jsonBody, cleanupState: 'clean', caseId: 'CASE-FULL-1', actionId: 'ACTION-FULL-1' },
  }

  function request(intentId: string, method: string, exactPath: string, maxRequests: number,
    expectedOrder: number, payload: { kind: 'json'; digest: string } | { kind: 'no-body' } = { kind: 'no-body' }) {
    return { intentId, method, canonicalOrigin: origin, exactPath, query: [] as Array<[string, string]>,
      payload, targetFingerprint, maxRequests, expectedOrder }
  }
}

export function runtimeTodoMvcFullPlaywrightFixture(
  input: Parameters<typeof runtimeFullPlaywrightFixture>[0],
) {
  const base = runtimeFullPlaywrightFixture(input)
  const origin = new URL(input.url).origin
  const targetFingerprint = d('todomvc-typescript-react-public-target')
  const modeledSpecs = [
    ['F01', 84, 'When there are no todos, `#main` and `#footer` should be hidden.', '无 Todo 时隐藏主区和页脚'],
    ['F02', 88, 'The input element should be focused when the page is loaded, preferably by using the `autofocus` input attribute.', '页面加载后新建输入框获得焦点'],
    ['F03', 88, 'Pressing Enter creates the todo, appends it to the todo list, and clears the input.', '按 Enter 新建 Todo、追加列表并清空输入'],
    ['F04', 88, "Make sure to `.trim()` the input and then check that it's not empty before creating a new todo.", '新建前 trim 且空白输入不创建 Todo'],
    ['F05', 92, 'This checkbox toggles all the todos to the same state as itself.', '全选框统一切换全部 Todo 状态'],
    ['F06', 92, 'The "Mark all as complete" checkbox should also be updated when single todo items are checked/unchecked.', '单项状态变化同步全选框'],
    ['F07', 98, 'Clicking the checkbox marks the todo as complete by updating its `completed` value and toggling the class `completed` on its parent `<li>`', '单项勾选更新 completed 与 CSS class'],
    ['F08', 100, 'Double-clicking the `<label>` activates editing mode, by toggling the `.editing` class on its `<li>`', '双击标签进入编辑模式'],
    ['F09', 102, 'Hovering over the todo shows the remove button (`.destroy`)', '悬停显示删除按钮'],
    ['F10', 106, 'When editing mode is activated it will hide the other controls and bring forward an input that contains the todo title, which should be focused (`.focus()`).', '编辑模式显示并聚焦包含标题的输入框'],
    ['F11', 106, 'The edit should be saved on both blur and enter, and the `editing` class should be removed.', 'Enter 与 blur 均保存编辑并退出编辑态'],
    ['F12', 106, "Make sure to `.trim()` the input and then check that it's not empty. If it's empty the todo should instead be destroyed.", '编辑值 trim 后为空则删除 Todo'],
    ['F13', 106, 'If escape is pressed during the edit, the edit state should be left and any changes be discarded.', 'Escape 放弃编辑并丢弃变更'],
    ['F14', 110, 'Displays the number of active todos in a pluralized form.', '计数器显示 active Todo 数量'],
    ['F15', 110, 'Also make sure to pluralize the `item` word correctly: `0 items`, `1 item`, `2 items`.', '计数器正确处理单复数'],
    ['F16', 114, 'Removes completed todos when clicked.', 'Clear completed 删除已完成 Todo'],
    ['F17', 114, 'Should be hidden when there are no completed todos.', '无已完成 Todo 时隐藏 Clear completed'],
    ['F18', 118, 'Your app should dynamically persist the todos to localStorage.', 'Todo 动态持久化到 localStorage'],
    ['F19', 118, 'If possible, use the keys `id`, `title`, `completed` for each item.', '持久化项包含 id、title、completed'],
    ['F20', 118, 'Make sure to use this format for the localStorage name: `todos-[framework]`.', 'localStorage 键名遵循 todos-[framework]'],
    ['F21', 118, 'Editing mode should not be persisted.', '编辑模式不持久化'],
    ['F22', 122, 'The following routes should be implemented: `#/` (all - default), `#/active` and `#/completed` (`#!/` is also allowed).', '实现 All、Active、Completed 路由'],
    ['F23', 122, 'When the route changes, the todo list should be filtered on a model level and the `selected` class on the filter links should be toggled.', '路由切换过滤列表并同步 selected class'],
    ['F24', 122, 'When an item is updated while in a filtered state, it should be updated accordingly.', '过滤状态下项目更新后列表同步变化'],
    ['F25', 122, 'Make sure the active filter is persisted on reload.', 'reload 后保持当前过滤器'],
  ] as const
  const excludedSpecs = [
    ['N01', 7, 'Our template should be used as the base when implementing a todo app.', '实现仓库与模板来源审查不属于浏览器功能验收'],
    ['N02', 28, 'Try to follow this structure as close as possible while still keeping to the framework’s best practices.', '目录结构需源码审查'],
    ['N03', 30, 'Components should be split up into separate files and placed into folders where it makes the most sense.', '组件拆分需源码审查'],
    ['N04', 47, 'All examples must include a README describing the framework, the general implementation, and the build process if required.', 'README 需仓库审查'],
    ['N05', 51, 'Unless it conflicts with the project\'s best practices, your example should use npm for package management.', '包管理需仓库审查'],
    ['N06', 64, 'You should `.gitignore` everything in `node_modules` except the files actually used by your example.', 'gitignore 需仓库审查'],
    ['N07', 68, 'Please try to keep the HTML as close to the template as possible.', '模板一致性需源码与视觉专项审查'],
    ['N08', 72, 'Follow our code style.', '代码风格需静态审查'],
    ['N09', 76, 'Apps should be written without any preprocessors (Sass/CoffeeScript/..) to reach the largest audience.', '构建技术选择需源码审查'],
    ['N10', 78, 'We require apps to work in every browser we support.', '当前 Policy 仅批准 Chromium，跨浏览器另行验收'],
  ] as const
  const clause = (prefix: string, line: number, originalText: string, kind: 'functional' | 'non-functional') => {
    const material = {
      clauseId: `CLAUSE-TODOMVC-${prefix}`, sourceId: 'PRD-TODOMVC-OFFICIAL', kind,
      sourceSpan: { startLine: line, startColumn: 1, endLine: line, endColumn: originalText.length + 1 },
      originalText, normalizedText: originalText,
    }
    return { ...material, textDigest: digestPrdClause(material) }
  }
  const modeledClauses = modeledSpecs.map(([id, line, original]) => clause(id, line, original, 'functional'))
  const excludedClauses = excludedSpecs.map(([id, line, original]) => clause(id, line, original, 'non-functional'))
  const allClauses = [...modeledClauses, ...excludedClauses]
  const requirementDefinitions = modeledSpecs.map(([id, _line, _original, title]) => ({
    reqId: `REQ-TODOMVC-${id}`, ruleId: `RULE-TODOMVC-${id}`, oracleId: `ORACLE-TODOMVC-${id}`,
    clauseId: `CLAUSE-TODOMVC-${id}`, title,
  }))
  const paths = [
    '/examples/typescript-react/',
    '/examples/typescript-react/node_modules/todomvc-common/base.css',
    '/examples/typescript-react/node_modules/todomvc-app-css/index.css',
    '/examples/typescript-react/node_modules/director/build/director.js',
    '/examples/typescript-react/js/bundle.js',
  ]
  const requests = paths.map((exactPath, index) => ({
    intentId: `TODOMVC-GET-${index + 1}`, method: 'GET', canonicalOrigin: origin, exactPath,
    query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const },
    // 主文档必须先出现；CSS/JS 由浏览器并发调度，属于同一个无序首次出现阶段。
    // program 初始加载 + 3 次 reload，cleanup 独立 Context 的初始加载 + reload，共最多 6 次。
    targetFingerprint, maxRequests: 6, expectedOrder: index === 0 ? 1 : 2,
  }))
  const originalExecution = base.frozenArtifacts['execution-contract'].content as any
  const originalProgram = originalExecution.fullPlaywrightPrograms[0]
  const verify = (id: string, actual = 'true') =>
    `await checkpoint({ checkpointId: 'CHECKPOINT-TODOMVC-${id}', oracleId: 'ORACLE-TODOMVC-${id}', actual: ${actual} })`
  const source = [
    `await page.goto('${input.url}')`,
    "await expect(page).toHaveTitle('React • TodoMVC')",
    "await expect(page.getByRole('heading', { name: 'todos' })).toBeVisible()",
    "await expect(page.locator('.todo-list li')).toHaveCount(0)",
    "await expect(page.locator('.main')).toHaveCount(0)",
    "await expect(page.locator('.footer')).toHaveCount(0)",
    verify('F01'),
    "const input = page.locator('.new-todo')",
    'await expect(input).toBeFocused()', verify('F02'),
    "await input.fill('  E2E-RUN-TODOMVC-A  ')", "await input.press('Enter')",
    "await input.fill('E2E-RUN-TODOMVC-B')", "await input.press('Enter')",
    "await input.fill('E2E-RUN-TODOMVC-C')", "await input.press('Enter')",
    "await input.fill('   ')", "await input.press('Enter')",
    "await expect(page.locator('.todo-list li')).toHaveCount(3)",
    "const items = page.locator('.todo-list li')",
    "const itemA = items.filter({ hasText: 'E2E-RUN-TODOMVC-A' })",
    "const itemB = items.filter({ hasText: 'E2E-RUN-TODOMVC-B' })",
    "const itemC = items.filter({ hasText: 'E2E-RUN-TODOMVC-C' })",
    "await expect(items.locator('label')).toHaveText(['E2E-RUN-TODOMVC-A', 'E2E-RUN-TODOMVC-B', 'E2E-RUN-TODOMVC-C'])",
    "await expect(page.locator('.todo-count')).toHaveText('3 items left')",
    verify('F03'), verify('F04'), verify('F14'), verify('F15'),
    "await itemA.locator('.toggle').check()",
    "await expect(itemA).toHaveClass(/completed/)",
    "await expect(page.locator('.todo-count')).toHaveText('2 items left')",
    "await itemA.locator('.toggle').uncheck()",
    "await expect(page.locator('.todo-count')).toHaveText('3 items left')",
    verify('F06'), verify('F07'),
    "await page.locator('.toggle-all').check()",
    "await expect(page.locator('.todo-count')).toHaveText('0 items left')",
    "await page.locator('.toggle-all').uncheck()",
    "await expect(page.locator('.todo-count')).toHaveText('3 items left')",
    verify('F05'),
    "await itemB.locator('.toggle').check()",
    "await page.getByRole('link', { name: 'Completed' }).click()",
    "await expect(page).toHaveURL(/#\\/completed$/)",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    "await page.getByRole('link', { name: 'Active' }).click()",
    "await expect(page).toHaveURL(/#\\/active$/)",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-A', 'E2E-RUN-TODOMVC-C'])",
    // 在 Active 过滤器内完成后元素会立刻离开 DOM；click 验证用户动作，避免 check 的终态复读指向消失元素。
    "await itemA.locator('.toggle').click()",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-C'])",
    verify('F24'),
    "await page.getByRole('link', { name: 'All' }).click()",
    "await expect(page).toHaveURL(/#\\/$/)",
    "await itemA.locator('.toggle').uncheck()",
    verify('F22'), verify('F23'),
    "await itemA.locator('label').dblclick()",
    "await expect(itemA).toHaveClass(/editing/)",
    "await expect(itemA.locator('.edit')).toBeFocused()",
    verify('F08'), verify('F10'),
    "await itemA.locator('.edit').fill('E2E-RUN-TODOMVC-A-EDITED')",
    "await itemA.locator('.edit').press('Enter')",
    "await expect(page.locator('.todo-list label').nth(0)).toHaveText('E2E-RUN-TODOMVC-A-EDITED')",
    "await itemC.locator('label').dblclick()",
    "await itemC.locator('.edit').fill('E2E-RUN-TODOMVC-C-DISCARDED')",
    "await itemC.locator('.edit').press('Escape')",
    "await expect(page.locator('.todo-list label').nth(2)).toHaveText('E2E-RUN-TODOMVC-C')",
    verify('F13'),
    "await itemC.locator('label').dblclick()",
    "await itemC.locator('.edit').fill('E2E-RUN-TODOMVC-C-BLUR')",
    "await page.getByRole('heading', { name: 'todos' }).click()",
    "await expect(page.locator('.todo-list label').nth(2)).toHaveText('E2E-RUN-TODOMVC-C-BLUR')",
    verify('F11'),
    "const itemCBlur = items.filter({ hasText: 'E2E-RUN-TODOMVC-C-BLUR' })",
    "await itemCBlur.locator('label').dblclick()",
    "await itemCBlur.locator('.edit').fill('   ')",
    "await itemCBlur.locator('.edit').press('Enter')",
    "await expect(page.locator('.todo-list li')).toHaveCount(2)",
    verify('F12'),
    "await page.locator('.todo-list li').nth(0).hover()",
    "await expect(page.locator('.todo-list li').nth(0).locator('.destroy')).toBeVisible()",
    verify('F09'),
    "await page.locator('.todo-list li').nth(0).locator('.destroy').click()",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    "await page.locator('.todo-list li').nth(0).locator('.toggle').uncheck()",
    "await expect(page.locator('.todo-count')).toHaveText('1 item left')",
    "await page.locator('.todo-list li').nth(0).locator('.toggle').check()",
    "await input.fill('E2E-RUN-TODOMVC-PERSIST')", "await input.press('Enter')",
    "await page.getByRole('link', { name: 'Completed' }).click()",
    "await page.reload()",
    "await expect(page).toHaveURL(/#\\/completed$/)",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    "const stored = await page.evaluate(() => window.localStorage.getItem('react-todos'))",
    "const records = JSON.parse(stored || '[]')",
    "expect(records.map(item => item.title)).toEqual(['E2E-RUN-TODOMVC-B', 'E2E-RUN-TODOMVC-PERSIST'])",
    "expect(records.map(item => item.completed)).toEqual([true, false])",
    verify('F18'), verify('F19'),
    "await page.getByRole('link', { name: 'All' }).click()",
    "await page.locator('.todo-list li').nth(1).locator('label').dblclick()",
    "await page.locator('.todo-list li').nth(1).locator('.edit').fill('NOT-PERSISTED-EDIT')",
    "await page.reload()",
    "await expect(page.locator('.todo-list li.editing')).toHaveCount(0)",
    "await expect(page.locator('.todo-list label').nth(1)).toHaveText('E2E-RUN-TODOMVC-PERSIST')",
    verify('F21'),
    "await page.getByRole('link', { name: 'Completed' }).click()",
    "await page.reload()",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    verify('F25'),
    "await page.getByRole('link', { name: 'All' }).click()",
    "await expect(page).toHaveURL(/#\\/$/)",
    "await page.locator('.toggle-all').check()",
    "await page.getByRole('button', { name: 'Clear completed' }).click()",
    "await expect(page.locator('.todo-list li')).toHaveCount(0)",
    "await expect(page.locator('.main')).toHaveCount(0)",
    "await expect(page.locator('.footer')).toHaveCount(0)",
    "state.programCompleted = true",
    "state.persistenceVerified = true",
    "state.storageKeyDeviation = 'react-todos'",
    verify('F16'), verify('F17'),
    verify('F20', "'react-todos'"),
  ].join('\n')
  const cleanupSource = [
    `await page.goto('${input.url}')`,
    "await expect(page).toHaveTitle('React • TodoMVC')",
    "await expect(page.locator('.todo-list li')).toHaveCount(0)",
    "const stored = await page.evaluate(() => window.localStorage.getItem('react-todos'))",
    "expect(JSON.parse(stored || '[]')).toEqual([])",
    "await page.reload()",
    "await expect(page.locator('.todo-list li')).toHaveCount(0)",
    "state.cleanupVerified = true",
    "return 'verified-clean'",
  ].join('\n')
  const program = {
    ...originalProgram,
    caseId: 'CASE-TODOMVC-FUNCTIONAL-1',
    stepId: 'STEP-TODOMVC-FUNCTIONAL-1',
    actionId: 'ACTION-TODOMVC-FUNCTIONAL-1',
    dataLeaseId: 'LEASE-TODOMVC-1',
    cleanupPlanId: 'CLEANUP-TODOMVC-1',
    timeoutMs: 60_000,
    source,
    sourceDigest: computeFullPlaywrightSourceDigest(source),
    cleanupSource,
    cleanupSourceDigest: computeFullPlaywrightCleanupSourceDigest(cleanupSource),
    networkRequests: requests,
    networkRequestBodies: [],
    oracleCheckpoints: requirementDefinitions.map((definition) => {
      const expectedJson = definition.oracleId.endsWith('F20') ? canonicalizeJson('todos-react') : 'true'
      return { checkpointId: `CHECKPOINT-TODOMVC-${definition.oracleId.slice(-3)}`,
        oracleId: definition.oracleId, expectedJson,
        expectedDigest: digestOracleCheckpointValue(expectedJson) }
    }),
  }
  const originalCleanupPlan = originalExecution.writeCleanupPlans[0]
  const cleanupPlan = {
    ...originalCleanupPlan,
    cleanupPlanId: program.cleanupPlanId,
    actionId: program.actionId,
    leaseId: program.dataLeaseId,
    cleanupProgramDigest: program.cleanupSourceDigest,
    cleanupRequestIntentIds: [],
    verificationProbes: [{
      probeId: 'PROBE-TODOMVC-EMPTY', kind: 'browser-observation' as const,
      expectedDigest: d('todomvc-empty-after-cleanup'),
    }],
  }
  const cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan)
  const testCases = replaceArtifactContent(base.frozenArtifacts['test-cases'], {
    cases: [{
      caseId: program.caseId, revision: 1,
      obligationIds: requirementDefinitions.map((definition) => `COV-${definition.reqId}`),
      title: 'TodoMVC 官方功能与持久化验收', actor: 'visitor', necessity: 'required', preconditions: [],
      dataNeedIds: [program.dataLeaseId], steps: [{
        stepId: program.stepId, ordinal: 0,
        semanticAction: '新增、完成、过滤、编辑、删除、持久化并清理 Todo',
        semanticTarget: 'TodoMVC 列表',
        oracles: requirementDefinitions.map((definition) => ({
          oracleId: definition.oracleId, statement: definition.title,
        })),
        evidenceKinds: ['screenshot', 'dom', 'trace', 'gateway-audit'],
      }], mode: 'real-environment', effect: 'reversible-write', evidenceLevel: 'E2',
      cleanupPlanId: program.cleanupPlanId, timeoutMs: 60_000,
      retryPolicy: 'verified-not-applied-max-1', status: 'active',
    }],
    caseSetDigest: d('todomvc-case-set'),
  })
  const executionContract = replaceArtifactContent(base.frozenArtifacts['execution-contract'], {
    ...originalExecution,
    baseOrigin: origin,
    identities: [{
      identityId: 'IDENTITY-VISITOR', roleIds: ['visitor'], secretRef: 'SECRET-REF-LOCAL',
    }],
    caseQueue: [{ ordinal: 0, caseId: program.caseId }],
    actionIntents: [{ actionId: program.actionId, effect: 'reversible-write',
      intentDigest: program.sourceDigest, requestIds: [] }],
    writeCleanupPlans: [cleanupPlan],
    fullPlaywrightPrograms: [program],
    dataNeeds: [{ leaseId: program.dataLeaseId, resourceKey: 'todomvc:react:session',
      resourceFingerprint: targetFingerprint, mode: 'write' }],
  })
  const originalActionMap = base.frozenArtifacts['browser-action-map'].content as any
  const actionMap = replaceArtifactContent(base.frozenArtifacts['browser-action-map'], {
    ...originalActionMap,
    executionProfile: 'full-playwright',
    pageIdentities: [{ pageId: 'PAGE-TODOMVC-1', origin,
      assertionDigest: d('todomvc-page-identity') }],
    fullPlaywrightPrograms: [program],
    actions: [{
      caseId: program.caseId, stepId: program.stepId, actionId: program.actionId,
      pageIdentityId: 'PAGE-TODOMVC-1', locatorCandidates: [],
      playwrightAction: 'full-playwright/v1', waits: [],
      oracleIds: requirementDefinitions.map((definition) => definition.oracleId), effect: 'reversible-write',
      capabilities: [{ operation: 'full-playwright', capabilityId: 'PENDING-TODOMVC-FULL' }],
      requestIds: [],
    }],
    unmappedSteps: [], discoveredRisks: [],
  })
  const projectPolicy = replaceArtifactContent(base.semanticArtifacts['project-policy'], {
    ...(base.semanticArtifacts['project-policy'].content as Record<string, unknown>),
    originPolicies: [{ origin, allowRead: true, allowWrite: true }],
  })
  const baseUnderstanding = (base.semanticArtifacts['prd-request'].content as any).understanding
  const todoContractNodeIds = requirementDefinitions.map((definition) => definition.reqId)
  const todoUnderstandingMaterial = {
    ...baseUnderstanding,
    nodes: requirementDefinitions.map((definition) => ({
      nodeId: definition.reqId, kind: 'REQ' as const, statement: definition.title,
      provenance: { kind: 'confirmed-decision' as const,
        decisionId: `DECISION-${definition.reqId}`, decisionRef: 'fixture:todomvc-official-prd' },
      responsibility: 'TodoMVC 页面', upstreamNodeIds: [], downstreamNodeIds: [],
      acceptanceCriteria: [definition.title],
    })),
    route: { skillName: 'e2e' as const, steps: [{ stepId: 'E2E-TODOMVC-ALL',
      inputNodeIds: todoContractNodeIds, output: 'TodoMVC 完整 E2E 报告', constraints: [],
      dependencyStepIds: [], completionCondition: '全部 TodoMVC 契约节点均有 Oracle 与测试证据' }] },
    authorization: { ...baseUnderstanding.authorization, authorizedNodeIds: todoContractNodeIds },
    projectionDigest: '',
  }
  const todoUnderstanding = {
    ...todoUnderstandingMaterial,
    projectionDigest: digestPrdUnderstandingProjection(todoUnderstandingMaterial),
  }
  const prdRequest = replaceArtifactContent(base.semanticArtifacts['prd-request'], {
    ...(base.semanticArtifacts['prd-request'].content as Record<string, unknown>),
    title: 'TodoMVC 官方 Application Specification 验收',
    userRequest: '依据官方 PRD 验证 TodoMVC 全部交互、持久化和清理',
    understanding: todoUnderstanding,
  })
  const prdManifest = replaceArtifactContent(base.semanticArtifacts['prd-manifest'], {
    ...(base.semanticArtifacts['prd-manifest'].content as Record<string, unknown>),
    prdId: 'PRD-TODOMVC-OFFICIAL',
    sources: [{ sourceId: 'PRD-TODOMVC-OFFICIAL', digest: input.prdRevision, byteLength: 1 }],
    clauses: allClauses,
    clauseInventoryDigest: digestPrdClauseInventory(allClauses),
  })
  const acceptanceScope = replaceArtifactContent(base.semanticArtifacts['acceptance-scope'], {
    ...(base.semanticArtifacts['acceptance-scope'].content as Record<string, unknown>),
    includedReqCandidates: requirementDefinitions.map((definition) => ({
      reqId: definition.reqId, sourceRefs: [definition.clauseId],
    })),
    clauseDispositions: [
      ...requirementDefinitions.map((definition) => ({
        clauseId: definition.clauseId, disposition: 'modeled' as const,
        requirementIds: [definition.reqId],
      })),
      ...excludedClauses.map((item) => ({ clauseId: item.clauseId, disposition: 'excluded' as const,
        reason: excludedSpecs.find(([id]) => item.clauseId.endsWith(id))?.[3] ?? '非浏览器验收范围',
        decisionId: `SCOPE-EXCLUDE-${item.clauseId.slice(-3)}` })),
    ],
  })
  const requirementModel = replaceArtifactContent(base.semanticArtifacts['requirement-model'], {
    ...(base.semanticArtifacts['requirement-model'].content as Record<string, unknown>),
    requirements: requirementDefinitions.map((definition) => ({
      reqId: definition.reqId, contractNodeIds: [definition.reqId], revision: 1, title: definition.title,
      actors: ['visitor'], entities: ['todo'], preconditions: [], rules: [{
        ruleId: definition.ruleId, contractNodeIds: [definition.reqId],
        category: 'business', statement: definition.title,
        sourceRefs: [definition.clauseId], certainty: 'explicit', oracleIds: [definition.oracleId],
      }], states: [], transitions: [], observableOutcomes: [{
        oracleId: definition.oracleId, ruleId: definition.ruleId,
        statement: definition.title, sourceRefs: [definition.clauseId],
        contractAcceptanceCriteria: [{ nodeId: definition.reqId, criterionIndex: 0 }],
      }], applicability: [], sourceRefs: [definition.clauseId], status: 'active',
    })),
    applicabilityRules: requirementDefinitions.map((definition) => definition.ruleId),
  })
  const interactionFlow = replaceArtifactContent(base.semanticArtifacts['interaction-flow'], {
    flows: [{
      flowId: 'FLOW-TODOMVC-FUNCTIONAL',
      contractNodeIds: todoContractNodeIds,
      nodes: [
        { nodeId: 'NODE-TODOMVC-ENTRY', reqId: requirementDefinitions[0]!.reqId, kind: 'entry',
          effect: 'reversible-write', oracleIds: [requirementDefinitions[0]!.oracleId] },
        { nodeId: 'NODE-TODOMVC-EXIT', reqId: requirementDefinitions.at(-1)!.reqId, kind: 'exit',
          effect: 'reversible-write', oracleIds: [requirementDefinitions.at(-1)!.oracleId] },
      ],
      edgeIds: ['EDGE-TODOMVC-FUNCTIONAL'], entryNodeId: 'NODE-TODOMVC-ENTRY',
      exitNodeIds: ['NODE-TODOMVC-EXIT'],
    }],
  })
  const coverageContent = structuredClone(
    base.semanticArtifacts['coverage-universe'].content,
  ) as Record<string, any>
  coverageContent.obligations = requirementDefinitions.map((definition, index) => ({
    obligationId: `COV-${definition.reqId}`, reqId: definition.reqId,
    clauseIds: [definition.clauseId], ruleIds: [definition.ruleId], oracleIds: [definition.oracleId],
    nodeIds: index === 0 ? ['NODE-TODOMVC-ENTRY']
      : index === requirementDefinitions.length - 1 ? ['NODE-TODOMVC-EXIT'] : [],
    actor: 'visitor', transitionId: 'not-applicable', scenario: definition.title,
    necessity: 'required', applicabilityRuleId: definition.ruleId,
    disposition: { kind: 'automated' as const, caseIds: [program.caseId] },
  }))
  coverageContent.universeDigest = digestText('coverage-universe/v1', canonicalizeJson({
    coveragePolicyDigest: coverageContent.coveragePolicyDigest,
    pairwiseSeed: coverageContent.pairwiseSeed,
    obligations: coverageContent.obligations,
  }))
  const coverageUniverse = replaceArtifactContent(
    base.semanticArtifacts['coverage-universe'], coverageContent,
  )
  const designAudit = replaceArtifactContent(base.semanticArtifacts['design-audit'], {
    ...(base.semanticArtifacts['design-audit'].content as Record<string, unknown>),
    inputDigests: [requirementModel.contentDigest, coverageUniverse.contentDigest],
  })
  const decidedScope = (scopeReceipt?: DecisionReceipt) => {
    const content = structuredClone(acceptanceScope.content) as Record<string, unknown>
    if (scopeReceipt) content.scopeDecision = {
      decisionId: 'SCOPE-1', status: 'approved', receipt: scopeReceipt,
    }
    return content
  }
  const bootstrapRequests = paths.map((exactPath, index) => ({
    requestId: `TODOMVC-BOOTSTRAP-${index + 1}`, method: 'GET' as const,
    url: new URL(exactPath, `${origin}/`).href, headers: [], bodyDigest: d('empty-body'),
    redirectPolicy: { mode: 'deny' as const },
  }))
  const discoverySubject = (
    decisions?: { scopeReceipt?: DecisionReceipt },
  ): DiscoveryApprovalSubject => ({
    schemaVersion: '1.1.0', assetId: input.assetId, prdRevision: input.prdRevision,
    scopeDigest: digestApprovalProjection('acceptance-scope', decidedScope(decisions?.scopeReceipt)),
    environment: 'test', baseOrigin: origin, actor: 'visitor',
    expectedPageIdentity: { url: input.url, title: 'React • TodoMVC', heading: 'todos', ariaSignals: [] },
    bootstrapIntentsDigest: digestText('todomvc-bootstrap/v1', canonicalizeJson(bootstrapRequests)),
    requests: bootstrapRequests,
    actions: [{ actionId: 'PREFLIGHT-TODOMVC-1', operation: 'local-navigation', maxUses: 1,
      requestIds: [] }, {
      actionId: 'PREFLIGHT-TODOMVC-RESOURCES', operation: 'http-request', maxUses: 1,
      requestIds: bootstrapRequests.map((request) => request.requestId),
    }],
  })
  const writeSubject = (discoveryGrantId: string, preflightDigest: string,
    decisions?: { scopeReceipt?: DecisionReceipt }) => {
    const scopeContent = decidedScope(decisions?.scopeReceipt)
    const allInputRefs = [
      ['project-policy', projectPolicy],
      ['acceptance-scope', { ...acceptanceScope, content: scopeContent }],
      ['requirement-model', requirementModel],
      ['coverage-universe', coverageUniverse],
      ['test-cases', testCases], ['execution-contract', executionContract],
      ['browser-action-map', actionMap],
    ].map(([artifactType, document]) => ({
      artifactId: (document as ArtifactDocument).artifactId,
      digest: digestApprovalProjection(artifactType as Parameters<typeof digestApprovalProjection>[0],
        (document as ArtifactDocument).content),
    }))
    const runBundleProjection = {
      runId: input.runId, allInputRefs,
      schedule: [{ ordinal: 0, caseId: program.caseId, stepIds: [program.stepId],
        actionIds: [program.actionId] }],
      attemptPlans: [{ caseId: program.caseId, slots: 1 }],
      signedCapabilities: [{ capabilityId: 'PENDING-TODOMVC-FULL', actionId: program.actionId,
        operation: 'full-playwright', effect: 'reversible-write', maxUses: 1,
        digest: d('pending-todomvc-full') }],
      secretRefs: ['SECRET-REF-LOCAL'],
      runtimePolicyDigest: ((projectPolicy.content as any).runtimePolicy as { digest: string }).digest,
      runtimeIsolationPolicyDigest: 'not-applicable',
    }
    return {
      schemaVersion: '2.0.0' as const, assetId: input.assetId, prdRevision: input.prdRevision,
      executionDigest: d('todomvc-execution'),
      scopeDigest: digestApprovalProjection('acceptance-scope', scopeContent),
      requirementModelDigest: digestApprovalProjection('requirement-model', requirementModel.content),
      coveragePolicyDigest: d('coverage-policy'),
      universeDigest: (coverageUniverse.content as { universeDigest: string }).universeDigest,
      caseDigest: digestApprovalProjection('test-cases', testCases.content),
      actionMapDigest: digestApprovalProjection('browser-action-map', actionMap.content),
      policyDigest: digestApprovalProjection('project-policy', projectPolicy.content),
      executionContractDigest: digestApprovalProjection('execution-contract', executionContract.content),
      runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundleProjection),
      environment: 'test' as const, baseOrigin: origin, actor: 'visitor', discoveryGrantId,
      preflightDigest, actions: [{
        actionId: program.actionId, effect: 'reversible-write' as const,
        dataLeaseId: program.dataLeaseId, resourceKey: 'todomvc:react:session', fencingToken: 1,
        cleanupPlanDigest, transport: 'browser-local' as const,
        operation: 'full-playwright' as const, programDigest: program.sourceDigest,
        cleanupProgramDigest: program.cleanupSourceDigest, requests,
      }],
    }
  }
  const regressionManifest = replaceArtifactContent(base.regressionManifest, (() => {
    const content = structuredClone(base.regressionManifest.content) as any
    content.executionProfile = 'full-playwright'
    content.caseMappings = content.caseMappings.map((item: any) => ({ ...item,
      caseId: program.caseId, testTitle: 'TodoMVC 官方功能与持久化验收' }))
    content.listResult.caseIds = [program.caseId]
    content.listResult.attestation.executionProfile = 'full-playwright'
    content.listResult.attestation.discoveredCaseIds = [program.caseId]
    content.listResult.attestation.caseMappings = content.caseMappings
    return content
  })())
  return {
    ...base,
    semanticArtifacts: { ...base.semanticArtifacts,
      'project-policy': projectPolicy, 'prd-request': prdRequest, 'prd-manifest': prdManifest,
      'acceptance-scope': acceptanceScope, 'requirement-model': requirementModel,
      'interaction-flow': interactionFlow, 'coverage-universe': coverageUniverse,
      'design-audit': designAudit },
    frozenArtifacts: { 'test-cases': testCases, 'execution-contract': executionContract,
      'browser-action-map': actionMap },
    discoverySubject,
    writeSubject,
    regressionManifest,
    expected: {
      ...base.expected,
      caseId: program.caseId,
      actionId: program.actionId,
      cleanupState: 'empty',
    },
  }
}

function replaceArtifactContent(document: ArtifactDocument, content: unknown): ArtifactDocument {
  const replaced = { ...structuredClone(document), content, contentDigest: '' }
  replaced.contentDigest = digestArtifactContent(
    `artifact-content/${replaced.schemaVersion}/${replaced.artifactType}`,
    replaced,
  )
  return replaced as ArtifactDocument
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
    artifactId: `ARTIFACT-${type.toUpperCase()}`, artifactType: type, schemaVersion, engineVersion: '0.1.0',
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
    artifactId: `ARTIFACT-${type.toUpperCase()}`, artifactType: type, schemaVersion, engineVersion: '0.1.0',
    assetId: input.assetId, prdRevision: input.prdRevision, generationId: input.runId,
    createdAt: '2026-07-17T00:00:00.000Z', contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
  document.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, document)
  return document as unknown as ArtifactDocument
}
