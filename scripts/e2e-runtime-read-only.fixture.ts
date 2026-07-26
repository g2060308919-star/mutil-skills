import {
  canonicalizeJson,
  computeFullPlaywrightCleanupSourceDigest,
  computeFullPlaywrightSourceDigest,
  computeRegressionSourceSetDigest,
  digestApprovalProjection,
  digestArtifactContent,
  digestCleanupPlanDefinition,
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
        statement: '显示待审核订单', sourceRefs: ['PRD-ORDER-1'], certainty: 'explicit',
        oracleIds: ['ORACLE-1'] }],
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

export function runtimeFullPlaywrightFixture(input: {
  runId: string
  assetId: string
  prdRevision: string
  installationDigest: string
  url: string
  now: Date
  evidencePolicyDigest?: string
  runtimePolicyDigest?: string
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
      reqId: 'REQ-ORDER-1', revision: 1, title: '完整浏览器交互与清理', actors: ['auditor'],
      entities: ['form'], preconditions: [], rules: [{
        ruleId: 'RULE-ORDER-1', category: 'business',
        statement: '表单写入后必须执行独立清理并通过 reload 验证',
        sourceRefs: ['PRD-ORDER-1'], certainty: 'explicit', oracleIds: ['ORACLE-1'],
      }], states: [], transitions: [], observableOutcomes: [{
        oracleId: 'ORACLE-1', statement: '写操作成功且清理后页面恢复 clean',
      }], applicability: [], sourceRefs: ['PRD-ORDER-1'], status: 'active',
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
    targetFingerprint, maxRequests: 4, expectedOrder: index === 0 ? 1 : 2,
  }))
  const originalExecution = base.frozenArtifacts['execution-contract'].content as any
  const originalProgram = originalExecution.fullPlaywrightPrograms[0]
  const source = [
    `await page.goto('${input.url}')`,
    "await expect(page).toHaveTitle('React • TodoMVC')",
    "await expect(page.getByRole('heading', { name: 'todos' })).toBeVisible()",
    "await expect(page.locator('.todo-list li')).toHaveCount(0)",
    "await expect(page.locator('.main')).toHaveCount(0)",
    "await expect(page.locator('.footer')).toHaveCount(0)",
    "const input = page.locator('.new-todo')",
    "await input.fill('  E2E-RUN-TODOMVC-A  ')", "await input.press('Enter')",
    "await input.fill('E2E-RUN-TODOMVC-B')", "await input.press('Enter')",
    "await input.fill('E2E-RUN-TODOMVC-C')", "await input.press('Enter')",
    "await input.fill('   ')", "await input.press('Enter')",
    "await expect(page.locator('.todo-list li')).toHaveCount(3)",
    "const items = page.locator('.todo-list li')",
    "await expect(items.locator('label')).toHaveText(['E2E-RUN-TODOMVC-A', 'E2E-RUN-TODOMVC-B', 'E2E-RUN-TODOMVC-C'])",
    "await expect(page.locator('.todo-count')).toHaveText('3 items left')",
    "await items.nth(0).locator('.toggle').check()",
    "await expect(items.nth(0)).toHaveClass(/completed/)",
    "await expect(page.locator('.todo-count')).toHaveText('2 items left')",
    "await items.nth(0).locator('.toggle').uncheck()",
    "await expect(page.locator('.todo-count')).toHaveText('3 items left')",
    "await page.locator('.toggle-all').check()",
    "await expect(page.locator('.todo-count')).toHaveText('0 items left')",
    "await page.locator('.toggle-all').uncheck()",
    "await expect(page.locator('.todo-count')).toHaveText('3 items left')",
    "await items.nth(1).locator('.toggle').check()",
    "await page.getByRole('link', { name: 'Completed' }).click()",
    "await expect(page).toHaveURL(/#\\/completed$/)",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    "await page.getByRole('link', { name: 'Active' }).click()",
    "await expect(page).toHaveURL(/#\\/active$/)",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-A', 'E2E-RUN-TODOMVC-C'])",
    "await page.getByRole('link', { name: 'All' }).click()",
    "await expect(page).toHaveURL(/#\\/$/)",
    "await page.locator('.todo-list li').nth(0).locator('label').dblclick()",
    "await page.locator('.todo-list li').nth(0).locator('.edit').fill('E2E-RUN-TODOMVC-A-EDITED')",
    "await page.locator('.todo-list li').nth(0).locator('.edit').press('Enter')",
    "await expect(page.locator('.todo-list label').nth(0)).toHaveText('E2E-RUN-TODOMVC-A-EDITED')",
    "await page.locator('.todo-list li').nth(2).locator('label').dblclick()",
    "await page.locator('.todo-list li').nth(2).locator('.edit').fill('E2E-RUN-TODOMVC-C-DISCARDED')",
    "await page.locator('.todo-list li').nth(2).locator('.edit').press('Escape')",
    "await expect(page.locator('.todo-list label').nth(2)).toHaveText('E2E-RUN-TODOMVC-C')",
    "await page.locator('.todo-list li').nth(2).locator('label').dblclick()",
    "await page.locator('.todo-list li').nth(2).locator('.edit').fill('E2E-RUN-TODOMVC-C-BLUR')",
    "await page.getByRole('heading', { name: 'todos' }).click()",
    "await expect(page.locator('.todo-list label').nth(2)).toHaveText('E2E-RUN-TODOMVC-C-BLUR')",
    "await page.locator('.todo-list li').nth(2).locator('label').dblclick()",
    "await page.locator('.todo-list li').nth(2).locator('.edit').fill('   ')",
    "await page.locator('.todo-list li').nth(2).locator('.edit').press('Enter')",
    "await expect(page.locator('.todo-list li')).toHaveCount(2)",
    "await page.locator('.todo-list li').nth(0).hover()",
    "await page.locator('.todo-list li').nth(0).locator('.destroy').click()",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    "await input.fill('E2E-RUN-TODOMVC-PERSIST')", "await input.press('Enter')",
    "await page.getByRole('link', { name: 'Completed' }).click()",
    "await page.reload()",
    "await expect(page).toHaveURL(/#\\/completed$/)",
    "await expect(page.locator('.todo-list label')).toHaveText(['E2E-RUN-TODOMVC-B'])",
    "const stored = await page.evaluate(() => window.localStorage.getItem('react-todos'))",
    "const records = JSON.parse(stored || '[]')",
    "expect(records.map(item => item.title)).toEqual(['E2E-RUN-TODOMVC-B', 'E2E-RUN-TODOMVC-PERSIST'])",
    "expect(records.map(item => item.completed)).toEqual([true, false])",
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
      caseId: program.caseId, revision: 1, obligationIds: ['COV-TODOMVC-FUNCTIONAL'],
      title: 'TodoMVC 官方功能与持久化验收', actor: 'visitor', necessity: 'required', preconditions: [],
      dataNeedIds: [program.dataLeaseId], steps: [{
        stepId: program.stepId, ordinal: 0,
        semanticAction: '新增、完成、过滤、编辑、删除、持久化并清理 Todo',
        semanticTarget: 'TodoMVC 列表',
        oracles: [{ oracleId: 'ORACLE-TODOMVC-FUNCTIONAL',
          statement: '全部功能符合官方规格，reload 保持状态，cleanup reload 后列表为空' }],
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
      oracleIds: ['ORACLE-TODOMVC-FUNCTIONAL'], effect: 'reversible-write',
      capabilities: [{ operation: 'full-playwright', capabilityId: 'PENDING-TODOMVC-FULL' }],
      requestIds: [],
    }],
    unmappedSteps: [], discoveredRisks: [],
  })
  const projectPolicy = replaceArtifactContent(base.semanticArtifacts['project-policy'], {
    ...(base.semanticArtifacts['project-policy'].content as Record<string, unknown>),
    originPolicies: [{ origin, allowRead: true, allowWrite: true }],
  })
  const prdRequest = replaceArtifactContent(base.semanticArtifacts['prd-request'], {
    ...(base.semanticArtifacts['prd-request'].content as Record<string, unknown>),
    title: 'TodoMVC 官方 Application Specification 验收',
    userRequest: '依据官方 PRD 验证 TodoMVC 全部交互、持久化和清理',
  })
  const prdManifest = replaceArtifactContent(base.semanticArtifacts['prd-manifest'], {
    ...(base.semanticArtifacts['prd-manifest'].content as Record<string, unknown>),
    prdId: 'PRD-TODOMVC-OFFICIAL',
    sources: [{ sourceId: 'PRD-TODOMVC-OFFICIAL', digest: input.prdRevision, byteLength: 1 }],
  })
  const acceptanceScope = replaceArtifactContent(base.semanticArtifacts['acceptance-scope'], {
    ...(base.semanticArtifacts['acceptance-scope'].content as Record<string, unknown>),
    includedReqCandidates: [{ reqId: 'REQ-TODOMVC-FUNCTIONAL',
      sourceRefs: ['PRD-TODOMVC-OFFICIAL'] }],
  })
  const requirementModel = replaceArtifactContent(base.semanticArtifacts['requirement-model'], {
    ...(base.semanticArtifacts['requirement-model'].content as Record<string, unknown>),
    requirements: [{
      reqId: 'REQ-TODOMVC-FUNCTIONAL', revision: 1, title: 'TodoMVC 完整功能验收',
      actors: ['visitor'], entities: ['todo'], preconditions: [], rules: [{
        ruleId: 'RULE-TODOMVC-FUNCTIONAL', category: 'business',
        statement: '访客可以新增、完成、过滤、编辑、删除并清理 Todo',
        sourceRefs: ['PRD-TODOMVC-OFFICIAL'], certainty: 'explicit',
        oracleIds: ['ORACLE-TODOMVC-FUNCTIONAL'],
      }], states: [], transitions: [], observableOutcomes: [{
        oracleId: 'ORACLE-TODOMVC-FUNCTIONAL',
        statement: '全部功能操作符合官方规格且 cleanup reload 后列表为空',
      }], applicability: [], sourceRefs: ['PRD-TODOMVC-OFFICIAL'], status: 'active',
    }],
  })
  const interactionFlow = replaceArtifactContent(base.semanticArtifacts['interaction-flow'], {
    flows: [{
      flowId: 'FLOW-TODOMVC-FUNCTIONAL',
      nodes: [
        { nodeId: 'NODE-TODOMVC-ENTRY', reqId: 'REQ-TODOMVC-FUNCTIONAL', kind: 'entry',
          effect: 'reversible-write', oracleIds: ['ORACLE-TODOMVC-FUNCTIONAL'] },
        { nodeId: 'NODE-TODOMVC-EXIT', reqId: 'REQ-TODOMVC-FUNCTIONAL', kind: 'exit',
          effect: 'reversible-write', oracleIds: ['ORACLE-TODOMVC-FUNCTIONAL'] },
      ],
      edgeIds: ['EDGE-TODOMVC-FUNCTIONAL'], entryNodeId: 'NODE-TODOMVC-ENTRY',
      exitNodeIds: ['NODE-TODOMVC-EXIT'],
    }],
  })
  const coverageContent = structuredClone(
    base.semanticArtifacts['coverage-universe'].content,
  ) as Record<string, any>
  coverageContent.obligations = [{
    obligationId: 'COV-TODOMVC-FUNCTIONAL', reqId: 'REQ-TODOMVC-FUNCTIONAL',
    ruleIds: ['RULE-TODOMVC-FUNCTIONAL'], nodeIds: ['NODE-TODOMVC-ENTRY', 'NODE-TODOMVC-EXIT'],
    actor: 'visitor', transitionId: 'not-applicable', scenario: 'TodoMVC 官方完整功能验收',
    necessity: 'required', applicabilityRuleId: 'RULE-TODOMVC-FUNCTIONAL',
    disposition: { kind: 'automated' as const, caseIds: [program.caseId] },
  }]
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
