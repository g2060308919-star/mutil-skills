import { canonicalizeJson, digestApprovalProjection, digestArtifactContent, digestBytes, digestText,
  digestCleanupPlanDefinition,
  digestCanonicalGrantApprovalSubject,
  digestDecisionSubject, projectLineageDecisionSubject, projectScopeDecisionSubject,
  computeRegressionSourceSetDigest, type DecisionReceipt, type DecisionReceiptVerificationBinding,
  type RegressionDiscoveryAttestation, type RegressionDiscoverySubject,
  type AttemptEventAuthorityProof, type ExecutionOutcomeReceipt } from '@mutil-skills/e2e-contracts'
import { createSanitizerAttestationVerifier, LocalSanitizerAuthority,
  appendAttemptEvent, type BuildCompleteGenerationInput, type CompleteGenerationAuthority } from '../src/index.js'
import type { SanitizerPolicy } from '@mutil-skills/e2e-contracts'
import { generateKeyPairSync, sign, verify } from 'node:crypto'

const d = (value: string) => digestText('fixture/v1', value)
const context = {
  assetId: 'ASSET-1', generationId: 'GEN-1', prdRevision: d('prd'),
  engineVersion: '1.0.0', createdAt: '2026-07-12T00:00:00.000Z', fencingToken: 7,
}
const authorityKeys = generateKeyPairSync('ed25519')
const freshnessKeys = generateKeyPairSync('ed25519')
const decisionKeys = generateKeyPairSync('ed25519')
const regressionDiscoveryKeys = generateKeyPairSync('ed25519')
const attemptKeys = generateKeyPairSync('ed25519')
const gatewayKeysByInput = new WeakMap<BuildCompleteGenerationInput, ReturnType<typeof generateKeyPairSync>>()
const signature = (digest: string) => ({
  issuer: 'fixture-authority', keyId: 'fixture-key', algorithm: 'Ed25519' as const,
  signedDigest: digest, signature: sign(null, Buffer.from(digest, 'utf8'), authorityKeys.privateKey).toString('base64url'),
})

export const fixtureAuthority: CompleteGenerationAuthority = {
  signArtifactDigest: signature,
  verifyArtifactSignature: (proof, digest) => proof.signedDigest === digest
    && verify(null, Buffer.from(digest, 'utf8'), authorityKeys.publicKey, Buffer.from(proof.signature, 'base64url')),
  verifyApprovalFreshnessReceipt: (receipt, binding) => {
    const proof = receipt.authorityProof
    const payload = Buffer.from(canonicalizeJson({ purpose: 'approval-freshness-receipt/v1',
      issuer: proof.issuer, keyId: proof.keyId, signedDigest: proof.signedDigest }))
    const authentic = proof.issuer === 'fixture-authority' && proof.keyId === 'fixture-key:approval-freshness'
      && verify(null, payload, freshnessKeys.publicKey, Buffer.from(proof.signature, 'base64url'))
      && canonicalizeJson(receipt.executionSubjectSnapshot) === canonicalizeJson(binding.currentSubject)
      && canonicalizeJson(receipt.capabilities) === canonicalizeJson(binding.expectedCapabilities)
      && receipt.browserPreflightArtifactDigest === binding.browserPreflight.artifactDigest
      && receipt.runBundleDigest === binding.runBundle.artifactDigest
      && digestApprovalProjection('run-bundle', binding.runBundle.content)
        === receipt.executionSubjectSnapshot.runBundleProjectionDigest
    return authentic
      ? { authentic: true, current: true, allowed: receipt.status === 'valid', status: receipt.status }
      : { authentic: false, current: false, allowed: false, status: 'invalid' }
  },
  verifyDecisionReceipt: (receipt: DecisionReceipt, binding: DecisionReceiptVerificationBinding) => {
    const { signedDigest, signature: proof, ...unsigned } = receipt
    const expectedDigest = digestText('decision-receipt-binding/v1', canonicalizeJson(unsigned))
    return receipt.issuer === 'fixture-authority' && receipt.keyId === 'fixture-key:decision'
      && receipt.purpose === `${receipt.kind}-decision-receipt/v1`
      && receipt.kind === binding.kind && receipt.decisionId === binding.decisionId
      && receipt.decisionStatus === binding.decisionStatus
      && receipt.decisionSubjectDigest === binding.decisionSubjectDigest
      && signedDigest === expectedDigest
      && verify(null, Buffer.from(canonicalizeJson({ purpose: receipt.purpose,
        issuer: receipt.issuer, keyId: receipt.keyId, signedDigest })), decisionKeys.publicKey,
      Buffer.from(proof, 'base64url'))
  },
}

function fixtureDecisionReceipt(input: {
  kind: 'scope' | 'lineage'
  decisionId: string
  decisionStatus: 'approved' | 'rejected'
  decisionSubjectDigest: string
}): DecisionReceipt {
  const unsigned = {
    schemaVersion: '1.0.0' as const, ...input, checkedAt: context.createdAt, nonce: 'a'.repeat(64),
    approver: { subject: `${input.kind}-fixture-approver`, roles: [`${input.kind}-approver`] },
    issuer: 'fixture-authority', keyId: 'fixture-key:decision',
    purpose: `${input.kind}-decision-receipt/v1` as const, algorithm: 'Ed25519' as const,
  }
  const signedDigest = digestText('decision-receipt-binding/v1', canonicalizeJson(unsigned))
  return { ...unsigned, signedDigest,
    signature: sign(null, Buffer.from(canonicalizeJson({ purpose: unsigned.purpose,
      issuer: unsigned.issuer, keyId: unsigned.keyId, signedDigest })), decisionKeys.privateKey).toString('base64url') } as DecisionReceipt
}

const empty = () => ({ dependencies: [], graph: { defines: [], references: [] } })
const draft = (relativePath: string, content: unknown, files?: Array<{ relativePath: string; base64: string }>) => ({
  ...empty(), relativePath, content, ...(files === undefined ? {} : { files }),
})

export function completeGenerationFixture(): BuildCompleteGenerationInput {
  const gatewayKeys = generateKeyPairSync('ed25519')
  const gatewayInstance = { instanceId: 'GATEWAY-1', version: '1.0.0', publicKeyDigest: d('gateway-key') }
  const requestEvents = [{ sequence: 0, actionId: 'ACTION-1', decision: 'forwarded' as const,
    digest: digestText('gateway-canonical-request/v1', canonicalizeJson({ method: 'GET', url: 'https://example.test/' })) }]
  const capabilityReservation = { reservationId: 'RESERVATION-1', grantId: 'GRANT-1',
    capabilityId: 'CAPABILITY-1', actionId: 'ACTION-1',
    attemptId: 'ATTEMPT-1', status: 'completed' as const, outcomeDigest: d('gateway-outcome'),
    reservedAt: context.createdAt }
  const capabilityReservations = [{ ...capabilityReservation, consumed: true,
    digest: digestText('gateway-capability-reservation/v1', canonicalizeJson({
      reservation: capabilityReservation, consumed: true,
    })) }]
  const gatewayCounterDigest = digestText('gateway-audit-counters/v1', canonicalizeJson({
    gatewayInstance, policyDigest: d('runtime-policy'), forwarded: 1, blocked: 0, injected: 0,
    requestEvents, capabilityReservations,
  }))
  const gatewaySignature = {
    issuer: 'fixture-gateway', keyId: 'fixture-gateway-key', algorithm: 'Ed25519' as const,
    signedDigest: gatewayCounterDigest,
    signature: sign(null, Buffer.from(gatewayCounterDigest, 'utf8'), gatewayKeys.privateKey).toString('base64url'),
  }
  const gatewayAudit = {
    gatewayInstance, policyDigest: d('runtime-policy'), requestEvents, capabilityReservations,
    signedCounters: { forwarded: 1, blocked: 0, injected: 0, digest: gatewayCounterDigest, signature: gatewaySignature },
  }
  const evidencePath = 'evidence/case-1.json'
  const sanitizerPolicy: SanitizerPolicy = {
    schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.0.0', scannerVersion: '1.0.0',
    network: { formatVersions: ['network-json/1'], approvedPaths: ['/'], queryFields: [], requestHeaderFields: [], responseHeaderFields: [], requestBodyFields: [], responseBodyFields: [] },
    dom: { formatVersions: ['dom-tree/1'], allowedTags: ['main'], allowedAttributes: [], assertionTextClassification: 'public' },
    console: { formatVersions: ['console-json/1'], allowedObjectFields: [], primitiveArgumentClassification: 'public' },
    screenshot: { formatVersions: ['png/1'] }, video: { formatVersions: ['webm/1'] }, trace: { formatVersions: ['playwright-trace/1'] },
    maxInputBytes: 100_000, requireManualReviewFor: ['contact'],
  }
  const sanitizerAuthority = LocalSanitizerAuthority.create({ issuer: 'fixture-sanitizer', keyId: 'fixture-sanitizer-key', policy: sanitizerPolicy })
  const sanitized = sanitizerAuthority.sanitizeDom({ evidenceId: 'EVIDENCE-1', relativePath: evidencePath,
    raw: Buffer.from(JSON.stringify({ format: 'dom-tree/1', roots: [{ tag: 'main', text: 'Home', assertionRelevant: true }] })) })
  if (sanitized.status !== 'publishable') throw new Error('fixture sanitizer failed')
  const evidenceBytes = sanitized.bytes
  const evidenceDigest = digestBytes(`generation-file:${evidencePath}`, evidenceBytes)
  const sanitizerOutputDigest = digestBytes('sanitizer-output/v1', evidenceBytes)
  const sanitizationRecord = sanitized.record
  const sanitizerProofDigest = digestText('sanitizer-attestation/v1', canonicalizeJson(sanitized.attestation))
  const privacyReviewDigest = digestText('privacy-review-not-required/v1', canonicalizeJson({
    evidenceId: 'EVIDENCE-1', recordDigest: digestText('sanitization-record/v1', canonicalizeJson(sanitizationRecord)),
    sanitizerProofDigest, policyDigest: sanitizationRecord.policyDigest, status: 'not-required',
  }))
  const regressionPath = 'regression/tests/generated.spec.ts'
  const regressionBytes = Buffer.from("// trusted fixture\ntest('CASE-1 首页只读检查', () => {})\n")
  const regressionSourceFiles = [{ relativePath: regressionPath,
    digest: digestBytes(`generation-file:${regressionPath}`, regressionBytes), byteLength: regressionBytes.byteLength,
    mediaType: 'text/typescript' as const }]
  const regressionSubject: RegressionDiscoverySubject = {
    schemaVersion: '2.0.0', testDomain: 'prd-e2e-trusted-compiler', executionProfile: 'trusted-read-only',
    assetId: context.assetId, generationId: context.generationId,
    prdRevision: context.prdRevision, templateDigest: d('template'), compilerInputDigest: d('compiler-input'),
    compilerVersion: '4.0.0', templateVersion: '3.0.0', contractsVersion: '2.0.0',
    environmentId: 'TEST', approvalDigest: d('approval'), policyDigest: d('policy'),
    sourceFiles: regressionSourceFiles,
    caseMappings: [{ caseId: 'CASE-1', relativePath: regressionPath, testTitle: '首页只读检查' }],
    toolchain: { nodeVersion: '24.0.0', playwrightVersion: '1.0.0',
      compilerDigest: d('compiler'), playwrightCliDigest: d('playwright-cli') },
    isolation: { command: ['node', '@playwright/test/cli', 'test', '--list', '--reporter=json'],
      exitCode: 0, stdoutDigest: d('playwright-list') },
    discoveredCaseIds: ['CASE-1'], blockedCases: [],
    sourceSetDigest: computeRegressionSourceSetDigest(regressionSourceFiles),
  }
  const regressionSignedDigest = digestText('regression-discovery-subject/v2', canonicalizeJson(regressionSubject))
  const regressionAttestation: RegressionDiscoveryAttestation = { ...regressionSubject,
    issuer: 'fixture-discovery', keyId: 'fixture-discovery-key', purpose: 'regression-discovery-attestation/v2',
    algorithm: 'Ed25519', signedDigest: regressionSignedDigest,
    signature: sign(null, Buffer.from(canonicalizeJson({ purpose: 'regression-discovery-attestation/v2',
      issuer: 'fixture-discovery', keyId: 'fixture-discovery-key', signedDigest: regressionSignedDigest })),
    regressionDiscoveryKeys.privateKey).toString('base64url') }
  const attemptId = 'ATTEMPT-1'
  const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson({
    assetId: context.assetId, generationId: context.generationId, prdRevision: context.prdRevision,
    runId: 'RUN-1', caseId: 'CASE-1',
  }))
  const signAttemptProof = (signedDigest: string): AttemptEventAuthorityProof => ({
    purpose: 'attempt-event-authority-proof/v2', issuer: 'fixture-authority',
    keyId: 'fixture-key:attempt-event', algorithm: 'Ed25519', signedDigest,
    signature: sign(null, Buffer.from(canonicalizeJson({ purpose: 'attempt-event-authority-proof/v2',
      issuer: 'fixture-authority', keyId: 'fixture-key:attempt-event', signedDigest })),
    attemptKeys.privateKey).toString('base64url'),
  })
  const attemptStarted = appendAttemptEvent({ sequence: 1, caseId: 'CASE-1', slot: 0, attemptId,
    timestamp: context.createdAt, previousChainDigest: initialChainDigest,
    kind: 'started', mode: 'real-environment' }, signAttemptProof)
  const attemptTerminal = appendAttemptEvent({ sequence: 2, caseId: 'CASE-1', slot: 0, attemptId,
    timestamp: context.createdAt, previousChainDigest: attemptStarted.eventChainDigest,
    kind: 'terminal', result: { status: 'passed', mode: 'real-environment', effect: 'read',
      effectObservation: 'not-applicable', reservationSafeToVoid: true,
      reservationId: 'RESERVATION-1', outcomeDigest: d('gateway-outcome') } }, signAttemptProof)
  const eventChainDigest = attemptTerminal.eventChainDigest
  const attemptCase = { caseId: 'CASE-1', retryPolicy: 'read-automation-max-2' as const, initialChainDigest,
    events: [attemptStarted.event, attemptTerminal.event], selection: {
      status: 'selected' as const, attemptId, slot: 0, eventChainDigest } }
  const drafts: any = {
    'project-policy': draft('design/project-policy.json', {
      policyVersion: '1.0.0', environments: [{ environmentId: 'TEST', baseOrigin: 'https://example.test' }],
      originPolicies: [{ origin: 'https://example.test', allowRead: true, allowWrite: false }],
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chromium', required: true }],
      coveragePolicy: { id: 'COVERAGE-POLICY', digest: d('coverage-policy') },
      evidencePolicy: { id: 'EVIDENCE-POLICY', digest: sanitizationRecord.policyDigest },
      retentionPolicy: { id: 'RETENTION-POLICY', digest: d('retention-policy') },
      riskPolicy: { id: 'RISK-POLICY', digest: d('risk-policy') },
      timeoutPolicy: { id: 'TIMEOUT-POLICY', digest: d('timeout-policy') },
      runtimePolicy: { id: 'RUNTIME-POLICY', digest: d('runtime-policy') },
    }),
    'prd-request': draft('prd/prd-request.json', {
      productSpace: 'PRODUCT', title: '最小完整 PRD',
      sourceDescriptors: [{ sourceId: 'SOURCE-1', kind: 'text', ref: 'fixture' }],
      userRequest: '验证只读页面', testWorkspaceId: 'WORKSPACE-1', secretRefs: [],
    }),
    'prd-manifest': draft('prd/prd-manifest.json', {
      prdId: 'PRD-1', assetId: context.assetId, revision: context.prdRevision,
      normalizedPrdDigest: d('normalized-prd'),
      sources: [{ sourceId: 'SOURCE-1', digest: d('source'), byteLength: 7 }], attachments: [],
      sourceCacheIndexDigest: d('source-cache'),
    }),
    'prd-diff': draft('prd/prd-diff.json', {
      previousRevision: d('previous-prd'), currentRevision: context.prdRevision, sectionChanges: [],
      lineageMappings: [],
      lineageReview: { decisionId: 'LINEAGE-1', status: 'pending' },
      impactedEntityIds: [],
    }),
    'semantic-generation': draft('design/semantic-generation.json', {
      modelProvider: 'fixture', modelId: 'MODEL', modelVersion: '1.0.0',
      systemPromptDigest: d('prompt'), toolOutputDigests: [], sampling: { temperature: 0, seed: 1 },
      candidateDigests: [d('candidate')], selectedDigest: d('candidate'),
    }),
    'acceptance-scope': draft('design/acceptance-scope.json', {
      includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['PRD-1'] }], exclusions: [], ambiguities: [],
      dependencies: [], visualScope: { required: false, refs: [] },
      browserScope: { browserIds: ['CHROMIUM'], viewportIds: ['DESKTOP'] },
      scopeDecision: { decisionId: 'SCOPE-1', status: 'pending' },
    }),
    'requirement-model': draft('design/requirement-model.json', {
      modelRevision: 1, coupledDimensions: [], applicabilityRules: ['APPLICABILITY-1'],
      modelDecisionDigest: d('model-decision'), requirements: [{
        reqId: 'REQ-1', revision: 1, title: '读取首页', actors: ['USER'], entities: ['PAGE'],
        preconditions: [], rules: [{ ruleId: 'RULE-1', category: 'business', statement: '首页可见',
          sourceRefs: ['PRD-1'], certainty: 'explicit' }], states: [], transitions: [],
        observableOutcomes: [{ oracleId: 'ORACLE-1', statement: '标题可见' }], applicability: [],
        sourceRefs: ['PRD-1'], status: 'active',
      }],
    }),
    'interaction-flow': draft('design/interaction-flow.json', { flows: [{
      flowId: 'FLOW-1', nodes: [
        { nodeId: 'NODE-ENTRY', reqId: 'REQ-1', kind: 'entry', effect: 'read', oracleIds: ['ORACLE-1'] },
        { nodeId: 'NODE-EXIT', reqId: 'REQ-1', kind: 'exit', effect: 'read', oracleIds: ['ORACLE-1'] },
      ], edgeIds: ['EDGE-1'], entryNodeId: 'NODE-ENTRY', exitNodeIds: ['NODE-EXIT'],
    }] }),
    'coverage-universe': draft('design/coverage-universe.json', {
      coveragePolicyDigest: d('coverage-policy'), pairwiseSeed: 1, universeDigest: d('universe'),
      obligations: [{ obligationId: 'COV-1', reqId: 'REQ-1', ruleIds: ['RULE-1'],
        nodeIds: ['NODE-ENTRY', 'NODE-EXIT'], actor: 'USER', transitionId: 'not-applicable',
        scenario: '读取首页', necessity: 'required', applicabilityRuleId: 'APPLICABILITY-1',
        disposition: { kind: 'automated', caseIds: ['CASE-1'] } }],
    }),
    'test-cases': draft('design/test-cases.json', { cases: [{
      caseId: 'CASE-1', revision: 1, obligationIds: ['COV-1'], title: '首页只读检查', actor: 'USER',
      necessity: 'required', preconditions: [], dataNeedIds: [], steps: [{ stepId: 'STEP-1', ordinal: 0,
        semanticAction: '打开', semanticTarget: '首页',
        oracles: [{ oracleId: 'ORACLE-1', statement: '标题可见' }], evidenceKinds: ['dom'] }],
      mode: 'real-environment', effect: 'read', evidenceLevel: 'E1', cleanupPlanId: 'not-applicable',
      timeoutMs: 30000, retryPolicy: 'read-automation-max-2', status: 'active',
    }], caseSetDigest: d('case-set') }),
    'design-audit': draft('design/design-audit.json', {
      inputDigests: [d('design-input')], metrics: [], findings: [], orphanIds: [], weakIds: [], status: 'passed',
    }),
    'execution-contract': draft('run/execution-contract.json', {
      environment: 'TEST', baseOrigin: 'https://example.test',
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chromium', viewportId: 'DESKTOP' }],
      identities: [{ identityId: 'IDENTITY-1', roleIds: ['USER'], secretRef: 'SECRET-REF-1' }],
      caseQueue: [{ ordinal: 0, caseId: 'CASE-1' }],
      actionIntents: [{ actionId: 'ACTION-1', effect: 'read', intentDigest: d('intent') }],
      dataNeeds: [], manualProcedures: [], evidencePolicyDigest: sanitizationRecord.policyDigest,
      runtimeIsolation: null, unresolvedItems: [],
    }),
    'approval-grants': draft('run/approval-grants.json', {
      runBundleDigest: d('placeholder'), grants: [],
    }),
    'manual-results': draft('run/manual-results.json', { results: [] }),
    'data-leases': draft('run/data-leases.json', { leases: [], allocatorEpoch: 1 }),
    'browser-preflight': draft('run/browser-preflight.json', {
      discoveryGrantId: 'DISCOVERY-1', authorityPreflightDigest: d('authority-preflight'), observedActor: 'USER',
      checks: [{ code: 'PREFLIGHT-OK', status: 'passed', digest: d('preflight') }],
      observedIdentity: { identityId: 'IDENTITY-1', digest: d('identity') }, actorChecks: [], leaseChecks: [],
      gatewayChecks: [{ id: 'GATEWAY-1', digest: d('runtime-policy') },
        { id: 'TRUSTED-GATEWAY-PROXY', digest: d('gateway-proxy') }],
      sandboxChecks: [{ id: 'TRUSTED-CHROME-EXECUTABLE', digest: d('browser-executable') }], status: 'passed',
    }),
    'browser-action-map': draft('run/browser-action-map.json', {
      actionMapRevision: 1,
      pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://example.test', assertionDigest: d('page') }],
      actions: [{ caseId: 'CASE-1', stepId: 'STEP-1', actionId: 'ACTION-1', pageIdentityId: 'PAGE-1',
        locatorCandidates: [{ strategy: 'role', value: 'main', confidence: 1 }],
        playwrightAction: 'page.goto', waits: [], oracleIds: ['ORACLE-1'], effect: 'read',
        capabilities: [{ operation: 'dom-read', capabilityId: 'CAPABILITY-1' }] }], unmappedSteps: [], discoveredRisks: [],
    }),
    'regression-manifest': draft('run/regression-manifest.json', {
      testDomain: regressionSubject.testDomain, executionProfile: regressionSubject.executionProfile,
      templateDigest: regressionSubject.templateDigest, toolchain: regressionSubject.toolchain,
      sourceFiles: regressionSourceFiles, caseMappings: regressionSubject.caseMappings,
      blockedCases: [], deprecatedCases: [], listResult: { caseIds: ['CASE-1'], digest: d('playwright-list'),
        attestation: regressionAttestation },
    }, [{ relativePath: regressionPath, base64: regressionBytes.toString('base64') }]),
    'run-bundle': draft('run/run-bundle.json', {
      runId: 'RUN-1', allInputRefs: [{ artifactId: 'ARTIFACT-TEST-CASES', digest: d('input-ref') }],
      schedule: [{ ordinal: 0, caseId: 'CASE-1', stepIds: ['STEP-1'], actionIds: ['ACTION-1'] }],
      attemptPlans: [{ caseId: 'CASE-1', slots: 1 }],
      signedCapabilities: [{ capabilityId: 'CAPABILITY-1', actionId: 'ACTION-1', operation: 'dom-read',
        effect: 'read', maxUses: 1, digest: d('capability') }],
      secretRefs: ['SECRET-REF-1'], runtimePolicyDigest: d('runtime-policy'),
      runtimeIsolationPolicyDigest: 'not-applicable',
    }),
    'workflow-events': draft('run/workflow-events.json', {
      runId: 'RUN-1', attemptCases: [attemptCase],
      workflowDigest: digestText('workflow-events/v2', canonicalizeJson({ runId: 'RUN-1', attemptCases: [attemptCase] })),
    }),
    'browser-results': draft('run/browser-results.json', {
      runId: 'RUN-1', trustedCompilerExecution: {
        schemaVersion: '1.0.0', runId: 'RUN-1', compilerInputDigest: regressionSubject.compilerInputDigest,
        sourceSetDigest: regressionSubject.sourceSetDigest, approvalDigest: regressionSubject.approvalDigest,
        browserExecutableDigest: d('browser-executable'), gatewayProxyEndpointDigest: d('gateway-proxy'),
        exitCode: 0, stdoutDigest: d('execution-stdout'), stderrDigest: d('execution-stderr'),
        caseResults: [{ caseId: 'CASE-1', status: 'passed' }],
      }, executedBrowserIds: ['CHROMIUM'], caseResults: [{
        caseId: 'CASE-1', attemptId, eventChainDigest, mode: 'real-environment', effect: 'read', status: 'passed',
        stepResults: [{ stepId: 'STEP-1', actionId: 'ACTION-1', status: 'passed',
          actualDigest: d('actual-home'), oracleResult: 'passed', evidenceIds: ['EVIDENCE-1'] }],
        effectObservation: 'not-applicable', gatewayAuditRef: 'ARTIFACT-GATEWAY-AUDIT',
        evidenceRefs: ['EVIDENCE-1'],
      }], startedAt: context.createdAt, finishedAt: context.createdAt,
    }),
    'gateway-audit': draft('run/gateway-audit.json', {
      ...gatewayAudit,
    }),
    'browser-evidence': draft('run/browser-evidence.json', {
      evidencePolicyDigest: sanitizationRecord.policyDigest,
      artifacts: [{ evidenceId: 'EVIDENCE-1', caseId: 'CASE-1', relativePath: evidencePath,
        digest: evidenceDigest, byteLength: evidenceBytes.byteLength, evidenceLevel: 'E1', sanitizationRecord }],
      caseCoverage: [{ caseId: 'CASE-1', evidenceIds: ['EVIDENCE-1'] }],
      sanitizerProofs: [{ evidenceId: 'EVIDENCE-1', record: sanitizationRecord, attestation: sanitized.attestation }],
      privacyReviews: [{ evidenceId: 'EVIDENCE-1', status: 'not-required', derivationDigest: privacyReviewDigest }],
    }, [{ relativePath: evidencePath, base64: evidenceBytes.toString('base64') }]),
    diagnosis: draft('run/diagnosis.json', {
      caseDiagnoses: [], healingAttempts: [], selectedAttemptExplanations: [],
    }),
    'cleanup-results': draft('run/cleanup-results.json', { leaseResults: [] }),
  }
  refreshFixtureDecisionsForDrafts(drafts, { scope: 'approved', lineage: 'approved' })
  drafts['run-bundle'].content.allInputRefs = fixtureApprovalInputRefs(drafts)
  const runBundleDigest = predictedContentDigest('run-bundle', drafts['run-bundle'])
  const subject = {
    schemaVersion: '2.0.0', assetId: context.assetId, prdRevision: context.prdRevision,
    scopeDigest: digestApprovalProjection('acceptance-scope', drafts['acceptance-scope'].content),
    requirementModelDigest: digestApprovalProjection('requirement-model', drafts['requirement-model'].content),
    coveragePolicyDigest: d('coverage-policy'),
    universeDigest: drafts['coverage-universe'].content.universeDigest,
    caseDigest: digestApprovalProjection('test-cases', drafts['test-cases'].content),
    actionMapDigest: digestApprovalProjection('browser-action-map', drafts['browser-action-map'].content),
    policyDigest: digestApprovalProjection('project-policy', drafts['project-policy'].content),
    executionContractDigest: digestApprovalProjection('execution-contract', drafts['execution-contract'].content),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', drafts['run-bundle'].content),
    environment: 'test', baseOrigin: 'https://example.test', actor: 'USER',
    discoveryGrantId: 'DISCOVERY-1', preflightDigest: d('authority-preflight'),
    actions: [{ actionId: 'ACTION-1', operation: 'dom-read', maxUses: 1 }],
  }
  const capabilities = drafts['run-bundle'].content.signedCapabilities
  const receiptBody = {
    schemaVersion: '1.0.0', grantType: 'read', grantId: 'GRANT-1',
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', subject),
    runBundleDigest,
    executionSubjectSnapshot: subject,
    browserPreflightArtifactDigest: predictedContentDigest('browser-preflight', drafts['browser-preflight']),
    capabilities, capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(capabilities)),
    expiresAt: '2026-07-13T00:00:00.000Z', checkedAt: context.createdAt,
    revocationSequence: 0, status: 'valid', reasonCodes: [],
  }
  const receiptDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(receiptBody))
  drafts['approval-grants'].content = { runBundleDigest, grants: [{ ...receiptBody, authorityProof: {
    purpose: 'approval-freshness-receipt/v1', issuer: 'fixture-authority',
    keyId: 'fixture-key:approval-freshness', algorithm: 'Ed25519', signedDigest: receiptDigest,
    signature: sign(null, Buffer.from(canonicalizeJson({ purpose: 'approval-freshness-receipt/v1',
      issuer: 'fixture-authority', keyId: 'fixture-key:approval-freshness', signedDigest: receiptDigest })),
    freshnessKeys.privateKey).toString('base64url'),
  } }] }

  const result: BuildCompleteGenerationInput = {
    context: { ...context }, drafts,
    reportPresentation: {
      title: 'E2E 验收报告', injectionBoundary: '本代没有浏览器注入结果。', recommendations: ['执行 CASE-1。'],
      regressionCommand: 'npx playwright test', browser: { version: '1.0.0', channel: 'chromium' },
    },
    authority: { ...fixtureAuthority },
    gatewayVerifier: (proof) => verify(null, Buffer.from(proof.signedDigest, 'utf8'), gatewayKeys.publicKey,
        Buffer.from(proof.signature, 'base64url')),
    sanitizerVerifier: createSanitizerAttestationVerifier(sanitizerAuthority.verifierMaterial,
      sanitizerAuthority.verifierMaterial.publicKeyDigest),
    privacyReviewVerifier: () => false,
    regressionDiscoveryVerifier: (attestation, subject) => {
      const { issuer, keyId, purpose, algorithm, signedDigest, signature: proof, ...unsigned } = attestation
      return issuer === 'fixture-discovery' && keyId === 'fixture-discovery-key'
        && purpose === 'regression-discovery-attestation/v2' && algorithm === 'Ed25519'
        && canonicalizeJson(unsigned) === canonicalizeJson(subject)
        && signedDigest === digestText('regression-discovery-subject/v2', canonicalizeJson(subject))
        && verify(null, Buffer.from(canonicalizeJson({ purpose, issuer, keyId, signedDigest })),
          regressionDiscoveryKeys.publicKey, Buffer.from(proof, 'base64url'))
    },
    attemptProofVerifier: (proof) => proof.purpose === 'attempt-event-authority-proof/v2'
      && proof.issuer === 'fixture-authority' && proof.keyId === 'fixture-key:attempt-event'
      && verify(null, Buffer.from(canonicalizeJson({ purpose: proof.purpose, issuer: proof.issuer,
        keyId: proof.keyId, signedDigest: proof.signedDigest })), attemptKeys.publicKey,
      Buffer.from(proof.signature, 'base64url')),
  }
  gatewayKeysByInput.set(result, gatewayKeys)
  return result
}

export function refreshFixtureApproval(input: BuildCompleteGenerationInput): void {
  const drafts = input.drafts as any
  refreshFixtureAttemptFacts(input)
  refreshFixtureDecisionsForDrafts(drafts)
  drafts['run-bundle'].content.allInputRefs = fixtureApprovalInputRefs(drafts)
  const previous = drafts['approval-grants'].content.grants[0]
  const subject = {
    ...previous.executionSubjectSnapshot,
    assetId: input.context.assetId, prdRevision: input.context.prdRevision,
    scopeDigest: digestApprovalProjection('acceptance-scope', drafts['acceptance-scope'].content),
    requirementModelDigest: digestApprovalProjection('requirement-model', drafts['requirement-model'].content),
    coveragePolicyDigest: drafts['coverage-universe'].content.coveragePolicyDigest,
    universeDigest: drafts['coverage-universe'].content.universeDigest,
    caseDigest: digestApprovalProjection('test-cases', drafts['test-cases'].content),
    actionMapDigest: digestApprovalProjection('browser-action-map', drafts['browser-action-map'].content),
    policyDigest: digestApprovalProjection('project-policy', drafts['project-policy'].content),
    executionContractDigest: digestApprovalProjection('execution-contract', drafts['execution-contract'].content),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', drafts['run-bundle'].content),
    environment: String(drafts['execution-contract'].content.environment).toLowerCase(),
    baseOrigin: drafts['execution-contract'].content.baseOrigin,
    actor: drafts['browser-preflight'].content.observedActor,
    discoveryGrantId: drafts['browser-preflight'].content.discoveryGrantId,
    preflightDigest: drafts['browser-preflight'].content.authorityPreflightDigest,
  }
  const capabilities = drafts['run-bundle'].content.signedCapabilities
  const body = {
    ...previous, authorityProof: undefined,
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', subject),
    runBundleDigest: predictedContentDigestFor(input.context, 'run-bundle', drafts['run-bundle']),
    executionSubjectSnapshot: subject,
    browserPreflightArtifactDigest: predictedContentDigestFor(input.context, 'browser-preflight', drafts['browser-preflight']),
    capabilities, capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(capabilities)),
    checkedAt: input.context.createdAt,
  }
  delete body.authorityProof
  const signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(body))
  drafts['approval-grants'].content = {
    runBundleDigest: predictedContentDigestFor(input.context, 'run-bundle', drafts['run-bundle']),
    grants: [{ ...body, authorityProof: { purpose: 'approval-freshness-receipt/v1', issuer: 'fixture-authority',
      keyId: 'fixture-key:approval-freshness', algorithm: 'Ed25519', signedDigest,
      signature: sign(null, Buffer.from(canonicalizeJson({ purpose: 'approval-freshness-receipt/v1',
        issuer: 'fixture-authority', keyId: 'fixture-key:approval-freshness', signedDigest })),
      freshnessKeys.privateKey).toString('base64url') } }],
  }
}

export function setFixtureRegressionProfile(
  input: BuildCompleteGenerationInput,
  executionProfile: RegressionDiscoverySubject['executionProfile'],
  testDomain: 'prd-e2e-trusted-compiler' = 'prd-e2e-trusted-compiler',
): void {
  const manifest = input.drafts['regression-manifest'].content as any
  const previous = manifest.listResult.attestation as RegressionDiscoveryAttestation
  const { issuer, keyId, purpose: _purpose, algorithm, signedDigest: _signedDigest,
    signature: _signature, ...previousSubject } = previous
  const subject: RegressionDiscoverySubject = { ...previousSubject, testDomain, executionProfile }
  const signedDigest = digestText('regression-discovery-subject/v2', canonicalizeJson(subject))
  const purpose = 'regression-discovery-attestation/v2' as const
  const attestation: RegressionDiscoveryAttestation = { ...subject, issuer, keyId, purpose, algorithm,
    signedDigest, signature: sign(null, Buffer.from(canonicalizeJson({ purpose, issuer, keyId, signedDigest })),
      regressionDiscoveryKeys.privateKey).toString('base64url') }
  manifest.testDomain = testDomain
  manifest.executionProfile = executionProfile
  manifest.listResult.attestation = attestation
}

export function refreshFixtureAttemptFacts(input: BuildCompleteGenerationInput): void {
  const drafts = input.drafts as any
  const testCase = drafts['test-cases'].content.cases[0]
  const result = drafts['browser-results'].content.caseResults[0]
  if (!result) return
  const runId = drafts['run-bundle'].content.runId
  const caseId = testCase.caseId
  const attemptId = result.attemptId || 'ATTEMPT-1'
  const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson({
    assetId: input.context.assetId, generationId: input.context.generationId,
    prdRevision: input.context.prdRevision, runId, caseId,
  }))
  const signProof = (signedDigest: string): AttemptEventAuthorityProof => ({
    purpose: 'attempt-event-authority-proof/v2', issuer: 'fixture-authority', keyId: 'fixture-key:attempt-event',
    algorithm: 'Ed25519', signedDigest, signature: sign(null, Buffer.from(canonicalizeJson({
      purpose: 'attempt-event-authority-proof/v2', issuer: 'fixture-authority',
      keyId: 'fixture-key:attempt-event', signedDigest })), attemptKeys.privateKey).toString('base64url'),
  })
  const started = appendAttemptEvent({ sequence: 1, caseId, slot: 0, attemptId,
    timestamp: drafts['browser-results'].content.startedAt, previousChainDigest: initialChainDigest,
    kind: 'started', mode: result.mode }, signProof)
  const effect = testCase.effect === 'irreversible' ? 'irreversible-write' : testCase.effect
  result.effect = effect
  const terminal = appendAttemptEvent({ sequence: 2, caseId, slot: 0, attemptId,
    timestamp: drafts['browser-results'].content.finishedAt, previousChainDigest: started.eventChainDigest,
    kind: 'terminal', result: { status: result.status, mode: result.mode, effect,
      effectObservation: result.effectObservation, reservationSafeToVoid: true,
      ...(['passed', 'failed'].includes(result.status) ? {
        reservationId: drafts['gateway-audit'].content.capabilityReservations[0].reservationId,
        outcomeDigest: drafts['gateway-audit'].content.capabilityReservations[0].outcomeDigest,
      } : {}) } }, signProof)
  result.eventChainDigest = terminal.eventChainDigest
  const attemptCase = { caseId, retryPolicy: testCase.retryPolicy, initialChainDigest,
    events: [started.event, terminal.event], selection: { status: 'selected', attemptId, slot: 0,
      eventChainDigest: terminal.eventChainDigest } }
  drafts['workflow-events'].content = { runId, attemptCases: [attemptCase],
    workflowDigest: digestText('workflow-events/v2', canonicalizeJson({ runId, attemptCases: [attemptCase] })) }
}

function refreshFixtureDecisionsForDrafts(
  drafts: any,
  defaults?: { scope: 'approved' | 'rejected'; lineage: 'approved' | 'rejected' },
): void {
  const scope = drafts['acceptance-scope'].content
  const scopeStatus = scope.scopeDecision.status === 'pending' && defaults ? defaults.scope : scope.scopeDecision.status
  scope.scopeDecision = scopeStatus === 'pending'
    ? { decisionId: scope.scopeDecision.decisionId, status: 'pending' }
    : { decisionId: scope.scopeDecision.decisionId, status: scopeStatus,
      receipt: fixtureDecisionReceipt({ kind: 'scope', decisionId: scope.scopeDecision.decisionId,
        decisionStatus: scopeStatus,
        decisionSubjectDigest: digestDecisionSubject(projectScopeDecisionSubject(scope)) }) }
  const diff = drafts['prd-diff'].content
  const lineageStatus = diff.lineageReview.status === 'pending' && defaults ? defaults.lineage : diff.lineageReview.status
  diff.lineageReview = lineageStatus === 'pending'
    ? { decisionId: diff.lineageReview.decisionId, status: 'pending' }
    : { decisionId: diff.lineageReview.decisionId, status: lineageStatus,
      receipt: fixtureDecisionReceipt({ kind: 'lineage', decisionId: diff.lineageReview.decisionId,
        decisionStatus: lineageStatus,
        decisionSubjectDigest: digestDecisionSubject(projectLineageDecisionSubject(diff)) }) }
}

function fixtureApprovalInputRefs(drafts: any): Array<{ artifactId: string; digest: string }> {
  return ['project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
    'test-cases', 'execution-contract', 'browser-action-map'].map((type) => ({
    artifactId: `ARTIFACT-${type.toUpperCase()}`,
    digest: digestApprovalProjection(type as any, drafts[type].content),
  }))
}

/** 攻击夹具：只重算外层 runBundleDigest，故意复用旧 freshness receipt。 */
export function rebindFixtureApprovalOuterOnly(input: BuildCompleteGenerationInput): void {
  const drafts = input.drafts as any
  drafts['approval-grants'].content.runBundleDigest = predictedContentDigestFor(
    input.context, 'run-bundle', drafts['run-bundle'],
  )
}

export function rebindFixtureApprovalInputsOuterOnly(input: BuildCompleteGenerationInput): void {
  const drafts = input.drafts as any
  drafts['run-bundle'].content.allInputRefs = fixtureApprovalInputRefs(drafts)
  rebindFixtureApprovalOuterOnly(input)
}

export function resignFixtureGatewayAudit(input: BuildCompleteGenerationInput): void {
  const keys = gatewayKeysByInput.get(input)
  if (!keys) throw new Error('FIXTURE_GATEWAY_KEYS_MISSING')
  const gateway = input.drafts['gateway-audit'].content as any
  for (const item of gateway.capabilityReservations) {
    const { consumed, digest: _digest, ...reservation } = item
    item.digest = digestText('gateway-capability-reservation/v1', canonicalizeJson({ reservation, consumed }))
  }
  const forwarded = gateway.requestEvents.filter((item: any) => item.decision === 'forwarded').length
  const blocked = gateway.requestEvents.filter((item: any) => item.decision === 'blocked').length
  const injected = gateway.requestEvents.filter((item: any) => item.decision === 'injected').length
  const digest = digestText('gateway-audit-counters/v1', canonicalizeJson({
    gatewayInstance: gateway.gatewayInstance, policyDigest: gateway.policyDigest,
    forwarded, blocked, injected, requestEvents: gateway.requestEvents,
    capabilityReservations: gateway.capabilityReservations,
  }))
  gateway.signedCounters = { forwarded, blocked, injected, digest, signature: {
    issuer: 'fixture-gateway', keyId: 'fixture-gateway-key', algorithm: 'Ed25519', signedDigest: digest,
    signature: sign(null, Buffer.from(digest, 'utf8'), keys.privateKey).toString('base64url'),
  } }
}

export function bindFixtureExecutionOutcomeReceipt(input: BuildCompleteGenerationInput): void {
  const keys = gatewayKeysByInput.get(input)
  if (!keys) throw new Error('FIXTURE_GATEWAY_KEYS_MISSING')
  const drafts = input.drafts as any
  const caseResult = drafts['browser-results'].content.caseResults[0]
  const step = caseResult.stepResults[0]
  const testCase = drafts['test-cases'].content.cases[0]
  const gateway = drafts['gateway-audit'].content
  for (const event of gateway.requestEvents.filter((item: any) => item.actionId === step.actionId)) {
    event.executionSessionId = 'SESSION-FIXTURE'
  }
  const reservation = gateway.capabilityReservations[0]
  const leaseId = caseResult.cleanupRef
  const lease = drafts['data-leases'].content.leases.find((item: any) => item.leaseId === leaseId)
  const cleanup = drafts['cleanup-results'].content.leaseResults.find((item: any) => item.leaseId === leaseId)
  if (!lease || !cleanup) throw new Error('FIXTURE_EXECUTION_OUTCOME_CLEANUP_MISSING')
  cleanup.leaseReceiptDigest ??= cleanup.digest
  cleanup.plan ??= {
    schemaVersion: '1.0.0', cleanupPlanId: testCase.cleanupPlanId, actionId: step.actionId,
    leaseId, executorId: 'EXECUTOR-FIXTURE', cleanupRequestIntentIds: ['INTENT-CLEANUP'],
    verificationProbes: [{ probeId: 'PROBE-FIXTURE', kind: 'resource-state',
      expectedDigest: d('cleanup-expected') }], timeoutMs: 30_000,
  }
  lease.cleanupPlanDigest = digestCleanupPlanDefinition(cleanup.plan)
  const requests = [{ intentId: 'INTENT-WRITE-FIXTURE', method: 'POST', canonicalOrigin: 'https://example.test',
    exactPath: '/api/write', query: [] as Array<[string, string]>, payload: { kind: 'no-body' as const },
    targetFingerprint: d('write-target'), maxRequests: 1, expectedOrder: 1 }]
  const capability = { capabilityId: reservation.capabilityId, nonce: 'fixture-nonce', transport: 'http' as const,
    effect: 'reversible-write' as const, operation: 'http-request' as const, actionId: step.actionId,
    dataLeaseId: leaseId, fencingToken: 1, cleanupPlanDigest: lease.cleanupPlanDigest,
    requests, maxUses: 1 as const }
  const capabilityRecord = drafts['run-bundle'].content.signedCapabilities.find(
    (item: any) => item.capabilityId === reservation.capabilityId,
  )
  Object.assign(capabilityRecord, { operation: 'http-request', effect: 'reversible-write',
    digest: digestText('approval-capability/v1', canonicalizeJson(capability)) })
  const mappedCapability = drafts['browser-action-map'].content.actions[0].capabilities.find(
    (item: any) => item.capabilityId === reservation.capabilityId,
  )
  mappedCapability.operation = 'http-request'
  const evidenceIds = [...step.evidenceIds]
  const binding = {
    schemaVersion: '1.0.0' as const,
    attemptContext: { assetId: input.context.assetId, generationId: input.context.generationId,
      prdRevision: input.context.prdRevision, runId: drafts['run-bundle'].content.runId,
      caseId: caseResult.caseId },
    grantId: reservation.grantId, capabilityId: reservation.capabilityId,
    actionId: step.actionId, attemptId: caseResult.attemptId, reservationId: reservation.reservationId,
    capability,
    effect: 'reversible-write' as const, status: caseResult.status,
    effectObservation: caseResult.effectObservation,
    runnerResultDigest: d('write-runner-result'),
    gateway: { executionSessionId: 'SESSION-FIXTURE', policyDigest: gateway.policyDigest,
      approvedRequestSetDigest: digestText(
      'execution-outcome-approved-request-set/v1', canonicalizeJson(requests)),
      received: 1, forwarded: 1, blocked: 0 },
    cleanup: { cleanupPlanId: testCase.cleanupPlanId, cleanupPlanDigest: lease.cleanupPlanDigest,
      leaseId, status: cleanup.status, resultDigest: cleanup.digest,
      leaseReceiptDigest: cleanup.leaseReceiptDigest },
    evidenceIds,
    evidenceSetDigest: digestText('execution-outcome-evidence-set/v1', canonicalizeJson([...evidenceIds].sort())),
    completedAt: input.context.createdAt,
  }
  const signedDigest = digestText('execution-outcome-receipt-binding/v1', canonicalizeJson(binding))
  const receipt: ExecutionOutcomeReceipt = {
    ...binding, issuer: 'fixture-gateway', keyId: 'fixture-gateway-key',
    purpose: 'execution-outcome-receipt/v1', algorithm: 'Ed25519', signedDigest,
    signature: sign(null, Buffer.from(canonicalizeJson({ purpose: 'execution-outcome-receipt/v1',
      issuer: 'fixture-gateway', keyId: 'fixture-gateway-key', algorithm: 'Ed25519', signedDigest })),
    keys.privateKey).toString('base64url'),
  }
  caseResult.executionOutcomeReceipts = [receipt]
  reservation.outcomeDigest = signedDigest
  input.executionOutcomeVerifier = (candidate) => {
    if (candidate.issuer !== receipt.issuer || candidate.keyId !== receipt.keyId
      || candidate.purpose !== receipt.purpose || candidate.algorithm !== receipt.algorithm) return false
    const { issuer, keyId, purpose, algorithm, signedDigest: digest, signature: proof, ...actualBinding } = candidate
    if (digestText('execution-outcome-receipt-binding/v1', canonicalizeJson(actualBinding)) !== digest) return false
    return verify(null, Buffer.from(canonicalizeJson({ purpose, issuer, keyId, algorithm, signedDigest: digest })),
      keys.publicKey, Buffer.from(proof, 'base64url'))
  }
  resignFixtureGatewayAudit(input)
  refreshFixtureAttemptFacts(input)
}

function predictedContentDigest(artifactType: string, artifactDraft: any): string {
  return predictedContentDigestFor(context, artifactType, artifactDraft)
}

function predictedContentDigestFor(contextValue: BuildCompleteGenerationInput['context'], artifactType: string, artifactDraft: any): string {
  const schemaVersion = ['approval-grants', 'browser-preflight', 'browser-action-map', 'run-bundle', 'project-policy']
    .includes(artifactType) ? '2.0.0' : '1.0.0'
  const envelope = {
    artifactId: `ARTIFACT-${artifactType.toUpperCase()}`, artifactType, schemaVersion,
    engineVersion: contextValue.engineVersion, assetId: contextValue.assetId, prdRevision: contextValue.prdRevision,
    generationId: contextValue.generationId, createdAt: contextValue.createdAt, contentDigest: '', signatures: [],
    dependencies: artifactDraft.dependencies, graph: artifactDraft.graph, content: artifactDraft.content,
  }
  return digestArtifactContent(`artifact-content/${schemaVersion}/${artifactType}`, envelope)
}
