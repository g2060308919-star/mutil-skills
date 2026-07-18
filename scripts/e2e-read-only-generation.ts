import {
  canonicalizeJson, digestArtifactContent, digestBytes, digestText,
  digestApprovalProjection,
  type CoverageUniverse, type SanitizerPolicy, type SignedDiscoveryGrant, type SignedReadGrant, type SignedWriteGrant,
  type ApproverIdentity, type PrivacyReviewReceipt,
  projectLineageDecisionSubject, projectScopeDecisionSubject, type DecisionReceipt,
  type RegressionDiscoveryAttestation, type RegressionDiscoverySubject,
  type PersistedAttemptCase,
  type ExecutionOutcomeReceipt,
  type CleanupPlanDefinition,
  type RuntimeIsolationPolicy,
  type TrustedCompilerExecutionFact,
  type ManualResult, type ManualResultDraft,
  parseArtifactDocument,
} from '@mutil-skills/e2e-contracts'
import {
  createSanitizerAttestationVerifier, LocalSanitizerAuthority,
  type BuildCompleteGenerationInput,
} from '@mutil-skills/e2e-engine'
import type { LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import type {
  GatewayPublicationAudit, LocalExecutionOutcomeVerifier, LocalGatewayAuditVerifier,
} from '@mutil-skills/e2e-gateway'
import type {
  CompileAndAttestRegressionResult, ReadOnlyCaseResult, ReversibleWriteCaseResult,
  TrustedCompilerRuntimeMeasurement,
} from '@mutil-skills/e2e-playwright-runtime'
import { inspectTrustedCompilerRuntimeMeasurement } from '@mutil-skills/e2e-playwright-runtime'

const createdAt = '2026-07-11T10:00:02.000Z'
const d = (value: string) => digestText('golden-fact/v1', value)
const base = () => ({ dependencies: [], graph: { defines: [], references: [] } })
const draft = (relativePath: string, content: unknown, files?: Array<{ relativePath: string; base64: string }>) => ({
  ...base(), relativePath, content, ...(files ? { files } : {}),
})

type GoldenDecision = { decisionId: string; status: 'pending' }
  | { decisionId: string; status: 'approved' | 'rejected'; receipt: DecisionReceipt }
export interface ReadOnlyGoldenDecisions {
  scopeDecision: GoldenDecision
  lineageDecision: GoldenDecision
}

export interface GoldenBlockedRegressionCase {
  caseId: string
  title: string
  stepId: string
  actionId: string
  reasonCode: string
}

function goldenScopeFacts() {
  return {
    includedReqCandidates: [{ reqId: 'REQ-ORDER-1', sourceRefs: ['PRD-ORDER-1'] }], exclusions: [], ambiguities: [],
    dependencies: [], visualScope: { required: true, refs: ['PAGE-ORDERS'] },
    browserScope: { browserIds: ['CHROMIUM'], viewportIds: ['DESKTOP'] },
  }
}

function goldenLineageFacts(currentRevision: string) {
  return { previousRevision: d('previous-prd'), currentRevision, sectionChanges: [], lineageMappings: [],
    impactedEntityIds: [] }
}

function goldenPrdManifest(revision: string) {
  return {
    prdId: 'PRD-ORDER-1', assetId: 'PRODUCT-PRD-1', revision,
    normalizedPrdDigest: revision,
    sources: [{ sourceId: 'PRD-ORDER-1', digest: revision, byteLength: 1 }],
    attachments: [], sourceCacheIndexDigest: d('source-cache-index'),
  }
}

export function createReadOnlyGoldenDecisions(input: {
  authority: LocalApprovalAuthority
  modelDigest: string
  scope: { status: 'approved' | 'rejected'; approver: ApproverIdentity }
  lineage: { status: 'approved' | 'rejected'; approver: ApproverIdentity }
}): ReadOnlyGoldenDecisions {
  return {
    scopeDecision: { decisionId: 'SCOPE-GOLDEN', status: input.scope.status,
      receipt: input.authority.issueDecisionReceipt({ kind: 'scope', decisionId: 'SCOPE-GOLDEN',
        decisionStatus: input.scope.status, decisionSubject: projectScopeDecisionSubject(goldenScopeFacts()),
        approver: input.scope.approver }) },
    lineageDecision: { decisionId: 'LINEAGE-GOLDEN', status: input.lineage.status,
      receipt: input.authority.issueDecisionReceipt({ kind: 'lineage', decisionId: 'LINEAGE-GOLDEN',
        decisionStatus: input.lineage.status,
        decisionSubject: projectLineageDecisionSubject(goldenLineageFacts(input.modelDigest)),
        approver: input.lineage.approver }) },
  }
}

export function createReadOnlyGoldenPendingDecisions(): ReadOnlyGoldenDecisions {
  return { scopeDecision: { decisionId: 'SCOPE-GOLDEN', status: 'pending' },
    lineageDecision: { decisionId: 'LINEAGE-GOLDEN', status: 'pending' } }
}

interface ReadOnlyApprovalFactsInput {
  modelDigest: string
  universe: CoverageUniverse
  fixtureOrigin: string
  runtimePolicyDigest: string
  decisions?: ReadOnlyGoldenDecisions
  blockedCase?: GoldenBlockedRegressionCase
}

function readOnlyApprovalContents(input: ReadOnlyApprovalFactsInput): Record<string, unknown> {
  const evidencePolicyDigest = digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(sanitizerPolicy())))
  const policy = {
    policyVersion: '1.0.0', environments: [{ environmentId: 'TEST', baseOrigin: input.fixtureOrigin }],
    originPolicies: [{ origin: input.fixtureOrigin, allowRead: true, allowWrite: false }],
    browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', required: true }],
    coveragePolicy: { id: 'COVERAGE-POLICY', digest: input.universe.coveragePolicyDigest },
    evidencePolicy: { id: 'EVIDENCE-POLICY', digest: evidencePolicyDigest },
    retentionPolicy: { id: 'RETENTION-POLICY', digest: d('retention') },
    riskPolicy: { id: 'RISK-POLICY', digest: d('risk') }, timeoutPolicy: { id: 'TIMEOUT-POLICY', digest: d('timeout') },
    runtimePolicy: { id: 'RUNTIME-POLICY', digest: input.runtimePolicyDigest },
  }
  const scope = { ...goldenScopeFacts(),
    scopeDecision: (input.decisions ?? createReadOnlyGoldenPendingDecisions()).scopeDecision }
  const prdManifest = goldenPrdManifest(input.modelDigest)
  const prdDiff = { ...goldenLineageFacts(input.modelDigest),
    lineageReview: (input.decisions ?? createReadOnlyGoldenPendingDecisions()).lineageDecision }
  const model = {
    modelRevision: 1, coupledDimensions: [], applicabilityRules: ['actor:auditor'], modelDecisionDigest: input.modelDigest,
    requirements: [{ reqId: 'REQ-ORDER-1', revision: 1, title: '展示订单列表', actors: ['auditor'], entities: ['order'],
      preconditions: [], states: [], transitions: [], sourceRefs: ['prd:审核流程'], status: 'active',
      observableOutcomes: [{ oracleId: 'ORACLE-ORDER-VISIBLE', statement: '显示待审核订单' }],
      applicability: [{ dimension: 'actor', value: 'auditor', required: true }],
      rules: [{ ruleId: 'RULE-ORDER-1', category: 'business', statement: '显示待审核订单',
        sourceRefs: ['prd:1'], certainty: 'explicit' }] }],
  }
  const coverage = { ...input.universe,
    obligations: input.universe.obligations.map(({ kind: _kind, ...obligation }) => obligation) }
  const automatedObligationIds = input.universe.obligations
    .filter((item) => item.disposition.kind === 'automated').map((item) => item.obligationId)
  const manualProcedures = input.universe.obligations
    .filter((item) => item.disposition.kind === 'manual')
    .map((item) => ({ manualProcedureId: item.disposition.kind === 'manual'
      ? item.disposition.manualProcedureId : '', instructionDigest: d(`manual:${item.obligationId}`) }))
  const cases = { cases: [{ caseId: 'CASE-READ-1', revision: 1,
    obligationIds: automatedObligationIds, title: '展示订单列表', actor: 'auditor',
    necessity: 'required', preconditions: [], dataNeedIds: [], steps: [{ stepId: 'STEP-READ-1', ordinal: 0,
      semanticAction: '打开订单列表', semanticTarget: '订单列表',
      oracles: [{ oracleId: 'ORACLE-ORDER-VISIBLE', statement: '待审核' }],
      evidenceKinds: ['screenshot', 'dom', 'console'] }], mode: 'real-environment', effect: 'read', evidenceLevel: 'E1',
    cleanupPlanId: 'not-applicable', timeoutMs: 30000, retryPolicy: 'read-automation-max-2', status: 'active' }],
    caseSetDigest: d('case-set') }
  const actionMap = { actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-ORDERS', origin: input.fixtureOrigin, assertionDigest: d('page-orders') }],
    actions: [{ caseId: 'CASE-READ-1', stepId: 'STEP-READ-1', actionId: 'ACTION-READ-1', pageIdentityId: 'PAGE-ORDERS',
      locatorCandidates: [{ strategy: 'text', value: '待审核', confidence: 1 }], playwrightAction: 'page.goto', waits: [],
      oracleIds: ['ORACLE-ORDER-VISIBLE'], effect: 'read', capabilities: [
        { operation: 'local-navigation', capabilityId: 'PENDING-NAV' },
        { operation: 'dom-read', capabilityId: 'PENDING-DOM' },
        { operation: 'screenshot', capabilityId: 'PENDING-SCREENSHOT' },
      ], requestIds: [] }], unmappedSteps: [], discoveredRisks: [] }
  const execution = { environment: 'TEST', baseOrigin: input.fixtureOrigin,
    browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', viewportId: 'DESKTOP' }],
    identities: [{ identityId: 'IDENTITY-AUDITOR', roleIds: ['auditor'], secretRef: 'SECRET-REF-LOCAL' }],
    caseQueue: [{ ordinal: 0, caseId: 'CASE-READ-1' }],
    actionIntents: [{ actionId: 'ACTION-READ-1', effect: 'read', intentDigest: d('read-intent'), requestIds: [] }],
    readHttpRequests: [],
    dataNeeds: [], manualProcedures, evidencePolicyDigest, runtimeIsolation: null, unresolvedItems: [] }
  if (input.blockedCase) {
    appendBlockedReadCase({ coverage, cases, actionMap, execution }, input.blockedCase,
      input.universe.obligations.map((item) => item.obligationId))
  }
  const approvalContents: Record<string, unknown> = {
    'project-policy': policy, 'prd-manifest': prdManifest, 'prd-diff': prdDiff,
    'acceptance-scope': scope, 'requirement-model': model,
    'coverage-universe': coverage, 'test-cases': cases, 'execution-contract': execution,
    'browser-action-map': actionMap,
  }
  const runBundle = { runId: 'RUN-READ-1',
    allInputRefs: Object.entries(approvalContents)
      .filter(([type]) => !['prd-manifest', 'prd-diff'].includes(type)).map(([type, content]) => ({
      artifactId: `ARTIFACT-${type.toUpperCase()}`, digest: digestApprovalProjection(type as any, content),
    })),
    schedule: [{ ordinal: 0, caseId: 'CASE-READ-1', stepIds: ['STEP-READ-1'], actionIds: ['ACTION-READ-1'] }],
    attemptPlans: [{ caseId: 'CASE-READ-1', slots: 1 }],
    signedCapabilities: [
      { capabilityId: 'PENDING-NAV', actionId: 'ACTION-READ-1', operation: 'local-navigation', effect: 'read', maxUses: 1, digest: d('pending-nav') },
      { capabilityId: 'PENDING-DOM', actionId: 'ACTION-READ-1', operation: 'dom-read', effect: 'read', maxUses: 1, digest: d('pending-dom') },
      { capabilityId: 'PENDING-SCREENSHOT', actionId: 'ACTION-READ-1', operation: 'screenshot', effect: 'read', maxUses: 1, digest: d('pending-screenshot') },
    ], secretRefs: ['SECRET-REF-LOCAL'], runtimePolicyDigest: input.runtimePolicyDigest,
    runtimeIsolationPolicyDigest: 'not-applicable' }
  return { ...approvalContents, 'run-bundle': runBundle }
}

export function createReadOnlyApprovalProjection(input: ReadOnlyApprovalFactsInput):
Pick<SignedReadGrant['subject'], 'scopeDigest' | 'requirementModelDigest' | 'coveragePolicyDigest'
  | 'universeDigest' | 'caseDigest' | 'actionMapDigest' | 'policyDigest' | 'executionContractDigest'
  | 'runBundleProjectionDigest'> {
  const contents = readOnlyApprovalContents(input)
  return {
    scopeDigest: digestApprovalProjection('acceptance-scope', contents['acceptance-scope']),
    requirementModelDigest: digestApprovalProjection('requirement-model', contents['requirement-model']),
    coveragePolicyDigest: input.universe.coveragePolicyDigest,
    universeDigest: (contents['coverage-universe'] as CoverageUniverse).universeDigest,
    caseDigest: digestApprovalProjection('test-cases', contents['test-cases']),
    actionMapDigest: digestApprovalProjection('browser-action-map', contents['browser-action-map']),
    policyDigest: digestApprovalProjection('project-policy', contents['project-policy']),
    executionContractDigest: digestApprovalProjection('execution-contract', contents['execution-contract']),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', contents['run-bundle']),
  }
}

export function createWriteApprovalProjection(input: {
  modelDigest: string
  universe: CoverageUniverse
  fixtureOrigin: string
  runtimePolicyDigest: string
  dataLeaseId: string
  resourceKey: string
  cleanupPlanDigest: string
  runtimeIsolationPolicy: RuntimeIsolationPolicy
  decisions?: ReadOnlyGoldenDecisions
}): Pick<SignedWriteGrant['subject'], 'scopeDigest' | 'requirementModelDigest' | 'coveragePolicyDigest'
  | 'universeDigest' | 'caseDigest' | 'actionMapDigest' | 'policyDigest' | 'executionContractDigest'
  | 'runBundleProjectionDigest'> {
  const evidencePolicyDigest = digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(sanitizerPolicy())))
  const contents = writeApprovalContents({ ...input, evidencePolicyDigest })
  return {
    scopeDigest: digestApprovalProjection('acceptance-scope', contents['acceptance-scope']),
    requirementModelDigest: digestApprovalProjection('requirement-model', contents['requirement-model']),
    coveragePolicyDigest: input.universe.coveragePolicyDigest,
    universeDigest: input.universe.universeDigest,
    caseDigest: digestApprovalProjection('test-cases', contents['test-cases']),
    actionMapDigest: digestApprovalProjection('browser-action-map', contents['browser-action-map']),
    policyDigest: digestApprovalProjection('project-policy', contents['project-policy']),
    executionContractDigest: digestApprovalProjection('execution-contract', contents['execution-contract']),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', contents['run-bundle']),
  }
}

function writeApprovalContents(input: {
  modelDigest: string
  universe: CoverageUniverse
  fixtureOrigin: string
  runtimePolicyDigest: string
  dataLeaseId: string
  resourceKey: string
  cleanupPlanDigest: string
  runtimeIsolationPolicy: RuntimeIsolationPolicy
  evidencePolicyDigest: string
  decisions?: ReadOnlyGoldenDecisions
}) {
  const policy = {
    policyVersion: '1.0.0', environments: [{ environmentId: 'TEST', baseOrigin: input.fixtureOrigin }],
    originPolicies: [{ origin: input.fixtureOrigin, allowRead: true, allowWrite: true }],
    browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', required: true }],
    coveragePolicy: { id: 'COVERAGE-POLICY', digest: input.universe.coveragePolicyDigest },
    evidencePolicy: { id: 'EVIDENCE-POLICY', digest: input.evidencePolicyDigest },
    retentionPolicy: { id: 'RETENTION-POLICY', digest: d('retention') },
    riskPolicy: { id: 'RISK-POLICY', digest: d('risk') }, timeoutPolicy: { id: 'TIMEOUT-POLICY', digest: d('timeout') },
    runtimePolicy: { id: 'RUNTIME-POLICY', digest: input.runtimePolicyDigest },
  }
  const scope = { ...goldenScopeFacts(),
    scopeDecision: (input.decisions ?? createReadOnlyGoldenPendingDecisions()).scopeDecision }
  const prdManifest = goldenPrdManifest(input.modelDigest)
  const prdDiff = { ...goldenLineageFacts(input.modelDigest),
    lineageReview: (input.decisions ?? createReadOnlyGoldenPendingDecisions()).lineageDecision }
  const model = {
    modelRevision: 1, coupledDimensions: [], applicabilityRules: ['actor:operator'], modelDecisionDigest: input.modelDigest,
    requirements: [{ reqId: 'REQ-ORDER-1', revision: 1, title: '批准订单并恢复测试数据', actors: ['operator'],
      entities: ['order'], preconditions: ['订单待审核'],
      states: [{ stateId: 'pending', title: '待审核' }, { stateId: 'approved', title: '已批准' }],
      transitions: [{ transitionId: 'TRANSITION-APPROVE', from: 'pending', action: '批准订单', to: 'approved' }],
      sourceRefs: ['prd:审核流程'], status: 'active',
      observableOutcomes: [{ oracleId: 'ORACLE-ORDER-APPROVED', statement: '订单显示已批准' }],
      applicability: [{ dimension: 'actor', value: 'operator', required: true }],
      rules: [{ ruleId: 'RULE-ORDER-1', category: 'business', statement: '授权操作员可以批准待审核订单',
        sourceRefs: ['prd:1'], certainty: 'explicit' }] }],
  }
  const coverage = { ...input.universe,
    obligations: input.universe.obligations.map(({ kind: _kind, ...obligation }) => obligation) }
  const cases = { cases: [{ caseId: 'CASE-WRITE-1', revision: 1,
    obligationIds: input.universe.obligations.map((item) => item.obligationId), title: '批准订单并恢复测试数据',
    actor: 'operator', necessity: 'required', preconditions: ['待审核'], dataNeedIds: [input.dataLeaseId],
    steps: [{ stepId: 'STEP-WRITE-1', ordinal: 0, semanticAction: '批准订单', semanticTarget: '订单 100',
      oracles: [{ oracleId: 'ORACLE-ORDER-APPROVED', statement: '已批准' }],
      evidenceKinds: ['screenshot', 'dom', 'console'] }], mode: 'real-environment', effect: 'reversible-write',
    evidenceLevel: 'E1', cleanupPlanId: 'CLEANUP-ORDER-RESET', timeoutMs: 30000,
    retryPolicy: 'verified-not-applied-max-1', status: 'active' }], caseSetDigest: d('write-case-set') }
  const actionMap = { actionMapRevision: 1,
    pageIdentities: [{ pageId: 'PAGE-ORDERS', origin: input.fixtureOrigin, assertionDigest: d('page-orders') }],
    actions: [{ caseId: 'CASE-WRITE-1', stepId: 'STEP-WRITE-1', actionId: 'ACTION-APPROVE',
      pageIdentityId: 'PAGE-ORDERS', locatorCandidates: [{ strategy: 'role', value: 'button:批准订单', confidence: 1 }],
      playwrightAction: 'page.getByRole(button).click', waits: [], oracleIds: ['ORACLE-ORDER-APPROVED'],
      effect: 'reversible-write', capabilities: [{ operation: 'http-request', capabilityId: 'PENDING-WRITE' }],
      requestIds: [] }],
    unmappedSteps: [], discoveredRisks: [] }
  const execution = { environment: 'TEST', baseOrigin: input.fixtureOrigin,
    browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', viewportId: 'DESKTOP' }],
    identities: [{ identityId: 'IDENTITY-OPERATOR', roleIds: ['operator'], secretRef: 'SECRET-REF-LOCAL' }],
    caseQueue: [{ ordinal: 0, caseId: 'CASE-WRITE-1' }],
    actionIntents: [{ actionId: 'ACTION-APPROVE', effect: 'reversible-write', intentDigest: d('write-intent'), requestIds: [] }],
    readHttpRequests: [],
    dataNeeds: [{ leaseId: input.dataLeaseId, resourceKey: input.resourceKey, mode: 'write' }],
    manualProcedures: [], evidencePolicyDigest: input.evidencePolicyDigest,
    runtimeIsolation: null, unresolvedItems: [] }
  const approvalContents: Record<string, unknown> = {
    'project-policy': policy, 'prd-manifest': prdManifest, 'prd-diff': prdDiff,
    'acceptance-scope': scope, 'requirement-model': model,
    'coverage-universe': coverage, 'test-cases': cases, 'execution-contract': execution,
    'browser-action-map': actionMap,
  }
  const runBundle = { runId: 'RUN-WRITE-1',
    allInputRefs: Object.entries(approvalContents)
      .filter(([type]) => !['prd-manifest', 'prd-diff'].includes(type)).map(([type, content]) => ({
      artifactId: `ARTIFACT-${type.toUpperCase()}`, digest: digestApprovalProjection(type as any, content),
    })),
    schedule: [{ ordinal: 0, caseId: 'CASE-WRITE-1', stepIds: ['STEP-WRITE-1'], actionIds: ['ACTION-APPROVE'] }],
    attemptPlans: [{ caseId: 'CASE-WRITE-1', slots: 1 }],
    signedCapabilities: [{ capabilityId: 'PENDING-WRITE', actionId: 'ACTION-APPROVE', operation: 'http-request',
      effect: 'reversible-write', maxUses: 1, digest: d('pending-write') }],
    secretRefs: ['SECRET-REF-LOCAL'], runtimePolicyDigest: input.runtimePolicyDigest,
    runtimeIsolationPolicyDigest: 'not-applicable' }
  return { ...approvalContents, 'run-bundle': runBundle }
}

interface GoldenCompilerApprovalBinding {
  authority: LocalApprovalAuthority
  grant: SignedReadGrant | SignedWriteGrant
  discoveryGrantId: string
  preflightDigest: string
  generationId: string
}

export async function createReadOnlyGoldenCompilerArtifacts(
  input: ReadOnlyApprovalFactsInput & GoldenCompilerApprovalBinding,
): Promise<unknown[]> {
  return createGoldenCompilerArtifacts(readOnlyApprovalContents(input), input)
}

export async function createWriteGoldenCompilerArtifacts(
  input: Parameters<typeof createWriteApprovalProjection>[0] & GoldenCompilerApprovalBinding,
): Promise<unknown[]> {
  const evidencePolicyDigest = digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(sanitizerPolicy())))
  return createGoldenCompilerArtifacts(writeApprovalContents({ ...input, evidencePolicyDigest }), input)
}

async function createGoldenCompilerArtifacts(
  contents: Record<string, unknown>,
  binding: GoldenCompilerApprovalBinding,
): Promise<unknown[]> {
  const context = {
    assetId: 'PRODUCT-PRD-1', generationId: binding.generationId,
    prdRevision: binding.grant.subject.prdRevision, engineVersion: '1.0.0', createdAt,
  }
  const runBundleDraft = draft('compiler/run-bundle.json', contents['run-bundle'])
  const runBundleDigest = predictedContentDigest(context, 'run-bundle', runBundleDraft)
  const preflightDraft = draft('compiler/browser-preflight.json', {
    discoveryGrantId: binding.discoveryGrantId,
    authorityPreflightDigest: binding.preflightDigest,
    observedActor: binding.grant.subject.actor,
    checks: [{ code: 'PREFLIGHT-READY', status: 'passed', digest: d('compiler-preflight-ready') }],
    observedIdentity: { identityId: 'IDENTITY-COMPILER', digest: d('compiler-observed-identity') },
    actorChecks: [], leaseChecks: [], gatewayChecks: [], sandboxChecks: [], status: 'passed',
  })
  const browserPreflightArtifactDigest = predictedContentDigest(context, 'browser-preflight', preflightDraft)
  const capabilityRecords = binding.grant.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId, actionId: capability.actionId,
    operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
    digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
  }))
  const receipt = await binding.authority.issueApprovalFreshnessReceipt({
    grant: binding.grant,
    currentSubject: binding.grant.subject,
    expectedCapabilities: capabilityRecords,
    browserPreflight: {
      artifactDigest: browserPreflightArtifactDigest,
      discoveryGrantId: binding.discoveryGrantId,
      authorityPreflightDigest: binding.preflightDigest,
    },
    runBundle: { artifactDigest: runBundleDigest, content: contents['run-bundle'] },
  })
  const compilerContents: Record<string, unknown> = {
    ...contents,
    'approval-grants': { runBundleDigest, grants: [receipt] },
  }
  const requiredTypes = [
    'prd-manifest', 'prd-diff', 'acceptance-scope', 'project-policy', 'requirement-model',
    'coverage-universe', 'test-cases', 'browser-action-map', 'execution-contract',
    'run-bundle', 'approval-grants',
  ]
  return requiredTypes.map((artifactType) => {
    const artifactDraft = draft(`compiler/${artifactType}.json`, compilerContents[artifactType])
    const schemaVersion = artifactSchemaVersion(artifactType)
    const unsigned = parseArtifactDocument({
      artifactId: `ARTIFACT-${artifactType.toUpperCase()}`,
      artifactType,
      schemaVersion,
      engineVersion: context.engineVersion,
      assetId: context.assetId,
      prdRevision: context.prdRevision,
      generationId: context.generationId,
      createdAt: context.createdAt,
      contentDigest: predictedContentDigest(context, artifactType, artifactDraft),
      signatures: [],
      dependencies: artifactDraft.dependencies,
      graph: artifactDraft.graph,
      content: artifactDraft.content,
    })
    return parseArtifactDocument({
      ...unsigned,
      signatures: [binding.authority.signArtifactDigest(unsigned.contentDigest)],
    })
  })
}

export async function createReadOnlyGoldenGenerationInput(input: {
  fencingToken: number
  modelDigest: string
  universe: CoverageUniverse
  authority: LocalApprovalAuthority
  caseResult: ReadOnlyCaseResult | ReversibleWriteCaseResult
  attempt: {
    attemptSelection: { status: 'valid'; attemptId: string; eventChainDigest: string }
    workflowEvents: { runId: string; attemptCases: PersistedAttemptCase[]; workflowDigest: string }
  }
  gatewayAudit: GatewayPublicationAudit
  gatewayVerifier: LocalGatewayAuditVerifier
  executionOutcomeVerifier?: LocalExecutionOutcomeVerifier
  capturedEvidence: { screenshot: Uint8Array; dom: Uint8Array }
  regressionDiscovery: Pick<CompileAndAttestRegressionResult, 'files' | 'attestation'>
  trustedCompilerExecution: TrustedCompilerExecutionFact
  trustedRuntimeMeasurement: TrustedCompilerRuntimeMeasurement
  regressionDiscoveryVerifier(attestation: RegressionDiscoveryAttestation, subject: RegressionDiscoverySubject): boolean
  fixtureOrigin: string
  discoveryGrant: SignedDiscoveryGrant
  readGrant: SignedReadGrant | SignedWriteGrant
  authorityPreflightDigest: string
  privacyDecisions: Array<{ evidenceId: string; decision: 'approved' | 'rejected'; approver: ApproverIdentity }>
  decisions?: ReadOnlyGoldenDecisions
  blockedCase?: GoldenBlockedRegressionCase
  sanitizerCanaryDetected?: boolean
  reportTitle?: string
  manualResultDrafts?: Array<Omit<ManualResultDraft, 'requirementModelDigest'>>
  write?: {
    generationId: string
    runId: string
    caseId: string
    stepId: string
    actionId: string
    actor: string
    dataLeaseId: string
    resourceKey: string
    resourceDigest: string
    cleanupPlanDigest: string
    cleanupPlanDefinition: CleanupPlanDefinition
    cleanupResultDigest: string
    executionOutcomeReceipt: ExecutionOutcomeReceipt
    runtimeIsolationPolicy: RuntimeIsolationPolicy
  }
}): Promise<BuildCompleteGenerationInput> {
  if (input.write && input.caseResult.status !== 'passed') {
    throw new Error('Write Golden 只允许发布完成验证与清理的真实 passed 事实')
  }
  if (!input.write && !['passed', 'failed'].includes(input.caseResult.status)) {
    throw new Error('Read-only Golden 只允许发布真实 passed/failed 业务事实')
  }
  const trustedCase = input.trustedCompilerExecution.caseResults.find((item) => item.caseId === input.caseResult.caseId)
  if (!trustedCase || trustedCase.status !== input.caseResult.status) {
    throw new Error('Golden BrowserResult 必须与固定 Compiler launcher 的同一 Case 终态一致')
  }
  if (input.capturedEvidence.screenshot.byteLength === 0 || input.capturedEvidence.dom.byteLength === 0) {
    throw new Error('Golden 原始浏览器证据不能为空')
  }
  const runtimeMeasurement = inspectTrustedCompilerRuntimeMeasurement(input.trustedRuntimeMeasurement)
  if (!runtimeMeasurement) throw new Error('Golden 缺少 Host 执行前独立运行时测量能力')
  const runtimeEvidence = new Map(input.caseResult.evidence.map((item) => [item.kind, item]))
  const screenshotEvidence = runtimeEvidence.get('screenshot')
  const domEvidence = runtimeEvidence.get('dom')
  const gatewayEvidence = runtimeEvidence.get('gateway-audit')
  if (screenshotEvidence?.byteLength !== input.capturedEvidence.screenshot.byteLength
    || screenshotEvidence.digest !== digestBytes('runtime-evidence/screenshot/v1', input.capturedEvidence.screenshot)
    || domEvidence?.byteLength !== input.capturedEvidence.dom.byteLength
    || domEvidence.digest !== digestText('runtime-evidence/dom/v1', Buffer.from(input.capturedEvidence.dom).toString('utf8'))
    || !gatewayEvidence || gatewayEvidence.byteLength <= 0) {
    throw new Error('Golden 捕获 bytes 与同次 runtime evidence digest 不一致')
  }
  const policy = sanitizerPolicy()
  const { sanitized, sanitizerAuthority } = sanitizeEvidence(input, policy)
  const evidencePolicyDigest = digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(policy)))
  const evidenceIds = sanitized.map((item) => item.evidenceId)
  const obligationIds = input.universe.obligations
    .filter((item) => item.disposition.kind === 'automated').map((item) => item.obligationId)
  const manualProcedures = input.universe.obligations
    .filter((item) => item.disposition.kind === 'manual')
    .map((item) => ({ manualProcedureId: item.disposition.kind === 'manual'
      ? item.disposition.manualProcedureId : '', instructionDigest: d(`manual:${item.obligationId}`) }))
  const context = {
    assetId: 'PRODUCT-PRD-1', generationId: input.write?.generationId ?? 'GENERATION-1', prdRevision: input.modelDigest,
    engineVersion: '1.0.0', createdAt, fencingToken: input.fencingToken,
  }
  const drafts: any = {
    'project-policy': draft('design/project-policy.json', {
      policyVersion: '1.0.0', environments: [{ environmentId: 'TEST', baseOrigin: input.fixtureOrigin }],
      originPolicies: [{ origin: input.fixtureOrigin, allowRead: true, allowWrite: false }],
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', required: true }],
      coveragePolicy: { id: 'COVERAGE-POLICY', digest: input.universe.coveragePolicyDigest },
      evidencePolicy: { id: 'EVIDENCE-POLICY', digest: evidencePolicyDigest },
      retentionPolicy: { id: 'RETENTION-POLICY', digest: d('retention') },
      riskPolicy: { id: 'RISK-POLICY', digest: d('risk') },
      timeoutPolicy: { id: 'TIMEOUT-POLICY', digest: d('timeout') },
      runtimePolicy: { id: 'RUNTIME-POLICY', digest: input.gatewayAudit.policyDigest },
    }),
    'prd-request': draft('prd/prd-request.json', {
      productSpace: 'ORDER-AUDIT', title: '订单列表 E2E 验收',
      sourceDescriptors: [{ sourceId: 'SOURCE-PRD', kind: 'text', ref: 'golden:prd' }],
      userRequest: '验证订单列表展示待审核订单', testWorkspaceId: 'WORKSPACE-GOLDEN', secretRefs: [],
    }),
    'prd-manifest': draft('prd/prd-manifest.json', {
      prdId: 'PRD-ORDER-1', assetId: context.assetId, revision: context.prdRevision,
      normalizedPrdDigest: d('normalized-prd'),
      sources: [{ sourceId: 'SOURCE-PRD', digest: d('source-prd'), byteLength: 18 }], attachments: [],
      sourceCacheIndexDigest: d('source-cache'),
    }),
    'prd-diff': draft('prd/prd-diff.json', {
      ...goldenLineageFacts(context.prdRevision),
      lineageReview: (input.decisions ?? createReadOnlyGoldenPendingDecisions()).lineageDecision,
    }),
    'semantic-generation': draft('design/semantic-generation.json', {
      modelProvider: 'deterministic-golden', modelId: 'MODEL-GOLDEN', modelVersion: '1.0.0',
      systemPromptDigest: d('system-prompt'), toolOutputDigests: [], sampling: { temperature: 0, seed: 1 },
      candidateDigests: [input.modelDigest], selectedDigest: input.modelDigest,
    }),
    'acceptance-scope': draft('design/acceptance-scope.json', {
      ...goldenScopeFacts(),
      scopeDecision: (input.decisions ?? createReadOnlyGoldenPendingDecisions()).scopeDecision,
    }),
    'requirement-model': draft('design/requirement-model.json', {
      modelRevision: 1, coupledDimensions: [], applicabilityRules: ['actor:auditor'],
      modelDecisionDigest: input.modelDigest, requirements: [{
        reqId: 'REQ-ORDER-1', revision: 1, title: '展示订单列表', actors: ['auditor'], entities: ['order'],
        preconditions: [], states: [], transitions: [], sourceRefs: ['prd:审核流程'], status: 'active',
        observableOutcomes: [{ oracleId: 'ORACLE-ORDER-VISIBLE', statement: '显示待审核订单' }],
        applicability: [{ dimension: 'actor', value: 'auditor', required: true }],
        rules: [{ ruleId: 'RULE-ORDER-1', category: 'business', statement: '显示待审核订单',
          sourceRefs: ['prd:1'], certainty: 'explicit' }],
      }],
    }),
    'interaction-flow': draft('design/interaction-flow.json', { flows: [{
      flowId: 'FLOW-ORDER-LIST', nodes: [
        { nodeId: 'NODE-LIST', reqId: 'REQ-ORDER-1', kind: 'page', effect: 'read', oracleIds: ['ORACLE-ORDER-VISIBLE'] },
        { nodeId: 'NODE-FINISH', reqId: 'REQ-ORDER-1', kind: 'page', effect: 'read', oracleIds: [] },
      ], edgeIds: ['EDGE-LIST-FINISH'], entryNodeId: 'NODE-LIST', exitNodeIds: ['NODE-FINISH'],
    }] }),
    'coverage-universe': draft('design/coverage-universe.json', {
      ...input.universe,
      obligations: input.universe.obligations.map(({ kind: _kind, ...obligation }) => obligation),
    }),
    'test-cases': draft('design/test-cases.json', { cases: [{
      caseId: 'CASE-READ-1', revision: 1, obligationIds, title: '展示订单列表', actor: 'auditor',
      necessity: 'required', preconditions: [], dataNeedIds: [],
      steps: [{ stepId: 'STEP-READ-1', ordinal: 0, semanticAction: '打开订单列表', semanticTarget: '订单列表',
        oracles: [{ oracleId: 'ORACLE-ORDER-VISIBLE', statement: '待审核' }],
        evidenceKinds: ['screenshot', 'dom', 'console'] }],
      mode: 'real-environment', effect: 'read', evidenceLevel: 'E1', cleanupPlanId: 'not-applicable',
      timeoutMs: 30000, retryPolicy: 'read-automation-max-2', status: 'active',
    }], caseSetDigest: d('case-set') }),
    'design-audit': draft('design/design-audit.json', {
      inputDigests: [input.modelDigest, input.universe.universeDigest], metrics: [], findings: [],
      orphanIds: [], weakIds: [], status: 'passed',
    }),
    'execution-contract': draft('run/execution-contract.json', {
      environment: 'TEST', baseOrigin: input.fixtureOrigin,
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chrome', viewportId: 'DESKTOP' }],
      identities: [{ identityId: 'IDENTITY-AUDITOR', roleIds: ['auditor'], secretRef: 'SECRET-REF-LOCAL' }],
      caseQueue: [{ ordinal: 0, caseId: 'CASE-READ-1' }],
      actionIntents: [{ actionId: 'ACTION-READ-1', effect: 'read', intentDigest: d('read-intent'), requestIds: [] }],
      readHttpRequests: [],
      dataNeeds: [], manualProcedures, evidencePolicyDigest, runtimeIsolation: null, unresolvedItems: [],
    }),
    'approval-grants': draft('run/approval-grants.json', {
      runBundleDigest: d('pending-run-bundle'), grants: [],
    }),
    'manual-results': draft('run/manual-results.json', { results: [] }),
    'data-leases': draft('run/data-leases.json', { leases: [], allocatorEpoch: 1 }),
    'browser-preflight': draft('run/browser-preflight.json', {
      discoveryGrantId: input.discoveryGrant.grantId,
      authorityPreflightDigest: input.authorityPreflightDigest,
      observedActor: input.readGrant.subject.actor,
      checks: [{ code: 'PREFLIGHT-READY', status: 'passed', digest: d('preflight-ready') }],
      observedIdentity: { identityId: 'IDENTITY-AUDITOR', digest: d('observed-identity') },
      actorChecks: [], leaseChecks: [], gatewayChecks: [{ id: input.gatewayAudit.gatewayInstance.instanceId,
        digest: input.gatewayAudit.policyDigest }, { id: 'TRUSTED-GATEWAY-PROXY',
        digest: runtimeMeasurement.gatewayProxyEndpointDigest }],
      sandboxChecks: [{ id: 'TRUSTED-CHROME-EXECUTABLE',
        digest: runtimeMeasurement.browserExecutableDigest }], status: 'passed',
    }),
    'browser-action-map': draft('run/browser-action-map.json', {
      actionMapRevision: 1,
      pageIdentities: [{ pageId: 'PAGE-ORDERS', origin: input.fixtureOrigin, assertionDigest: d('page-orders') }],
      actions: [{ caseId: 'CASE-READ-1', stepId: 'STEP-READ-1', actionId: 'ACTION-READ-1',
        pageIdentityId: 'PAGE-ORDERS', locatorCandidates: [{ strategy: 'text', value: '待审核', confidence: 1 }],
        playwrightAction: 'page.goto', waits: [], oracleIds: ['ORACLE-ORDER-VISIBLE'], effect: 'read',
        capabilities: input.readGrant.capabilities.map((capability) => ({
          operation: capability.operation, capabilityId: capability.capabilityId,
        })), requestIds: [] }], unmappedSteps: [], discoveredRisks: [],
    }),
    'regression-manifest': draft('run/regression-manifest.json', {
      testDomain: input.regressionDiscovery.attestation.testDomain,
      executionProfile: input.regressionDiscovery.attestation.executionProfile,
      templateDigest: input.regressionDiscovery.attestation.templateDigest,
      toolchain: input.regressionDiscovery.attestation.toolchain,
      sourceFiles: input.regressionDiscovery.attestation.sourceFiles,
      caseMappings: input.regressionDiscovery.attestation.caseMappings,
      blockedCases: input.regressionDiscovery.attestation.blockedCases,
      deprecatedCases: [], listResult: {
        caseIds: input.regressionDiscovery.attestation.discoveredCaseIds,
        digest: input.regressionDiscovery.attestation.isolation.stdoutDigest,
        attestation: input.regressionDiscovery.attestation,
      },
    }, input.regressionDiscovery.files.map((file) => ({ relativePath: file.relativePath,
      base64: Buffer.from(file.bytes).toString('base64') }))),
    'run-bundle': draft('run/run-bundle.json', {
      runId: 'RUN-READ-1', allInputRefs: [{ artifactId: 'ARTIFACT-TEST-CASES', digest: d('test-case-ref') }],
      schedule: [{ ordinal: 0, caseId: 'CASE-READ-1', stepIds: ['STEP-READ-1'], actionIds: ['ACTION-READ-1'] }],
      attemptPlans: [{ caseId: 'CASE-READ-1', slots: 1 }],
      signedCapabilities: input.readGrant.capabilities.map((capability) => ({
        capabilityId: capability.capabilityId, actionId: capability.actionId,
        operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
        digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
      })),
      secretRefs: ['SECRET-REF-LOCAL'], runtimePolicyDigest: input.gatewayAudit.policyDigest,
      runtimeIsolationPolicyDigest: 'not-applicable',
    }),
    'workflow-events': draft('run/workflow-events.json', {
      ...input.attempt.workflowEvents,
    }),
    'browser-results': draft('run/browser-results.json', {
      runId: 'RUN-READ-1', trustedCompilerExecution: input.trustedCompilerExecution,
      executedBrowserIds: ['CHROMIUM'], caseResults: [{
        caseId: 'CASE-READ-1', attemptId: input.attempt.attemptSelection.attemptId,
        eventChainDigest: input.attempt.attemptSelection.eventChainDigest,
        mode: 'real-environment', effect: 'read', status: input.caseResult.status, stepResults: [{
          stepId: 'STEP-READ-1', actionId: 'ACTION-READ-1', status: input.caseResult.status,
          actualDigest: digestText('read-only-actual/v1', canonicalizeJson(input.caseResult.actual)),
          oracleResult: input.caseResult.status, evidenceIds,
        }], effectObservation: 'not-applicable', gatewayAuditRef: 'ARTIFACT-GATEWAY-AUDIT', evidenceRefs: evidenceIds,
      }], startedAt: '2026-07-11T10:00:00.000Z', finishedAt: createdAt,
    }),
    'gateway-audit': draft('run/gateway-audit.json', input.gatewayAudit),
    'browser-evidence': draft('run/browser-evidence.json', {
      evidencePolicyDigest,
      artifacts: sanitized.map((item) => ({
        evidenceId: item.evidenceId, caseId: 'CASE-READ-1', relativePath: item.relativePath,
        digest: item.fileDigest, byteLength: item.bytes.byteLength, evidenceLevel: 'E1',
        sanitizationRecord: item.record,
      })),
      caseCoverage: [{ caseId: 'CASE-READ-1', evidenceIds }],
      sanitizerProofs: sanitized.map((item) => ({ evidenceId: item.evidenceId,
        record: item.record, attestation: item.attestation })),
      privacyReviews: createPrivacyReviewEntries({ sanitized, decisions: input.privacyDecisions,
        issueReceipt: (facts) => input.authority.issuePrivacyReviewReceipt(facts) }),
    }, sanitized.map((item) => ({ relativePath: item.relativePath, base64: item.bytes.toString('base64') }))),
    diagnosis: draft('run/diagnosis.json', { caseDiagnoses: [], healingAttempts: [], selectedAttemptExplanations: [] }),
    'cleanup-results': draft('run/cleanup-results.json', { leaseResults: [] }),
  }
  const manualResults: ManualResult[] = []
  for (const manualDraft of input.manualResultDrafts ?? []) {
    const candidate = {
      ...manualDraft,
      requirementModelDigest: predictedContentDigest(context, 'requirement-model', drafts['requirement-model']),
    }
    const prepareFinalizationId = `PREPARE-${candidate.manualResultId}`
    const prepared = await input.authority.prepareManualResult({
      draft: candidate,
      finalizationId: prepareFinalizationId,
      requestDigest: digestText('manual-result-request/v1', prepareFinalizationId),
    })
    for (const role of ['executor', 'reviewer'] as const) {
      const finalizationId = `FINALIZE-${candidate.manualResultId}-${role}`
      const finalized = await input.authority.finalizeManualResultRole({
        manualResultId: candidate.manualResultId,
        draftDigest: prepared.draftDigest,
        role,
        approvalSessionRef: `GOLDEN-MANUAL-${role.toUpperCase()}-${candidate.manualResultId}`,
        finalizationId,
        requestDigest: digestText('manual-result-request/v1', finalizationId),
      })
      if (role === 'reviewer') {
        if (finalized.status !== 'issued') throw new Error('Golden ManualResult reviewer 未签发终态结果')
        manualResults.push(finalized.result)
      }
    }
  }
  drafts['manual-results'].content.results = manualResults
  if (!input.write) {
    const projected = readOnlyApprovalContents({
      modelDigest: input.modelDigest, universe: input.universe, fixtureOrigin: input.fixtureOrigin,
      runtimePolicyDigest: input.gatewayAudit.policyDigest, decisions: input.decisions,
    })
    drafts['prd-manifest'].content = structuredClone(projected['prd-manifest'])
    drafts['prd-diff'].content = structuredClone(projected['prd-diff'])
  }
  if (input.blockedCase) {
    appendBlockedReadCase({
      coverage: drafts['coverage-universe'].content,
      cases: drafts['test-cases'].content,
      actionMap: drafts['browser-action-map'].content,
      execution: drafts['execution-contract'].content,
    }, input.blockedCase, obligationIds)
    const attestedBlocked = input.regressionDiscovery.attestation.blockedCases
    if (canonicalizeJson(attestedBlocked) !== canonicalizeJson([{
      caseId: input.blockedCase.caseId, reasonCode: input.blockedCase.reasonCode,
    }])) throw new Error(`Blocked Case 与 Discovery 证明不一致：${canonicalizeJson(attestedBlocked)}`)
  }
  if (input.write) applyWriteGoldenScenario(drafts, input)
  const capabilityRecords = drafts['run-bundle'].content.signedCapabilities
  drafts['run-bundle'].content.allInputRefs = [
    'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
    'test-cases', 'execution-contract', 'browser-action-map',
  ].map((type) => ({ artifactId: `ARTIFACT-${type.toUpperCase()}`,
    digest: digestApprovalProjection(type as any, drafts[type].content) }))
  const approvalProjectionFacts = {
    scopeDigest: digestApprovalProjection('acceptance-scope', drafts['acceptance-scope'].content),
    requirementModelDigest: digestApprovalProjection('requirement-model', drafts['requirement-model'].content),
    universeDigest: drafts['coverage-universe'].content.universeDigest as string,
    caseDigest: digestApprovalProjection('test-cases', drafts['test-cases'].content),
    actionMapDigest: digestApprovalProjection('browser-action-map', drafts['browser-action-map'].content),
    policyDigest: digestApprovalProjection('project-policy', drafts['project-policy'].content),
    executionContractDigest: digestApprovalProjection('execution-contract', drafts['execution-contract'].content),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', drafts['run-bundle'].content),
  }
  for (const [key, actual] of Object.entries(approvalProjectionFacts)) {
    const approved = input.readGrant.subject[key as keyof typeof approvalProjectionFacts]
    if (approved !== actual) throw new Error(`Golden 批准投影与最终执行事实不一致：${key}`)
  }
  const browserPreflightArtifactDigest = predictedContentDigest(context, 'browser-preflight', drafts['browser-preflight'])
  const receipt = await input.authority.issueApprovalFreshnessReceipt({
    grant: input.readGrant, currentSubject: input.readGrant.subject, expectedCapabilities: capabilityRecords,
    browserPreflight: { artifactDigest: browserPreflightArtifactDigest,
      discoveryGrantId: input.discoveryGrant.grantId, authorityPreflightDigest: input.authorityPreflightDigest },
    runBundle: { artifactDigest: predictedContentDigest(context, 'run-bundle', drafts['run-bundle']),
      content: drafts['run-bundle'].content },
  })
  drafts['approval-grants'].content = {
    runBundleDigest: predictedContentDigest(context, 'run-bundle', drafts['run-bundle']), grants: [receipt],
  }
  return {
    context,
    provenance: {
      runtimeVersion: '0.0.0',
      runtimeInstallationDigest: d('golden-runtime-installation'),
      protocolVersion: '1.0.0',
      contractsVersion: input.regressionDiscovery.attestation.contractsVersion,
      engineVersion: context.engineVersion,
      playwrightVersion: input.regressionDiscovery.attestation.toolchain.playwrightVersion,
      chromiumDigest: runtimeMeasurement.browserExecutableDigest,
      gatewayPolicyDigest: input.gatewayAudit.policyDigest,
      authorityPublicKeyDigest: input.write?.runtimeIsolationPolicy.authorityRpcPublicKeyDigest
        ?? d('golden-authority-public-key'),
      projectIdentityDigest: d('golden-project-identity'),
      sourceRevisionDigest: context.prdRevision,
      sourceRepositoryIndependent: true,
      authorityStateProtectionLevel: 'local-crash-integrity',
      isolationProofDigest: digestText('runtime-isolation-proof/v1', canonicalizeJson([
        { id: 'TRUSTED-CHROME-EXECUTABLE', digest: runtimeMeasurement.browserExecutableDigest },
      ])),
    },
    drafts,
    reportPresentation: {
      title: input.reportTitle
        ?? (input.write ? '订单审批可恢复写 E2E 验收报告' : '订单列表 E2E 验收报告'),
      injectionBoundary: '本代没有浏览器注入结果。',
      recommendations: [input.write ? '保持租约、清理验证与写授权同步复验。' : '保持只读回归用例。'],
      regressionCommand: 'npm run e2e:golden',
      browser: { version: '1.61.1', channel: 'chrome' },
    },
    authority: {
      signArtifactDigest: (digest) => input.authority.signArtifactDigest(digest),
      verifyArtifactSignature: (signature) => input.authority.verifyArtifactSignature(signature),
      verifyApprovalFreshnessReceipt: (candidate, binding) =>
        input.authority.verifyApprovalFreshnessReceipt({ receipt: candidate,
          currentSubject: binding.currentSubject, expectedCapabilities: binding.expectedCapabilities,
          browserPreflight: binding.browserPreflight, runBundle: binding.runBundle }),
      verifyDecisionReceipt: (receipt, binding) => input.authority.verifyDecisionReceipt(receipt, binding),
    },
    gatewayVerifier: (signature) => input.gatewayVerifier.verifySignature(signature),
    ...(input.executionOutcomeVerifier ? {
      executionOutcomeVerifier: (receipt: ExecutionOutcomeReceipt) =>
        input.executionOutcomeVerifier!.verifyReceipt(receipt),
    } : {}),
    sanitizerVerifier: createSanitizerAttestationVerifier(sanitizerAuthority.verifierMaterial,
      sanitizerAuthority.verifierMaterial.publicKeyDigest),
    privacyReviewVerifier: (receipt, binding) => input.authority.verifyPrivacyReviewReceipt(receipt, binding),
    regressionDiscoveryVerifier: input.regressionDiscoveryVerifier,
    attemptProofVerifier: (proof) => input.authority.verifyAttemptEventProof(proof),
    ...(manualResults.length > 0 ? {
      verdictDependencies: { verifyManualResult: (result: ManualResult) => input.authority.verifyManualResult(result) },
    } : {}),
  }
}

function appendBlockedReadCase(
  contents: { coverage: any; cases: any; actionMap: any; execution: any },
  blocked: GoldenBlockedRegressionCase,
  obligationIds: string[],
): void {
  for (const obligation of contents.coverage.obligations) {
    if (obligationIds.includes(obligation.obligationId) && obligation.disposition?.kind === 'automated') {
      obligation.disposition.caseIds = [...new Set([...obligation.disposition.caseIds, blocked.caseId])].sort()
    }
  }
  contents.coverage.universeDigest = digestText('coverage-universe/v1', canonicalizeJson({
    coveragePolicyDigest: contents.coverage.coveragePolicyDigest,
    pairwiseSeed: contents.coverage.pairwiseSeed,
    obligations: contents.coverage.obligations,
  }))
  contents.cases.cases.push({
    caseId: blocked.caseId, revision: 1, obligationIds, title: blocked.title, actor: 'auditor',
    necessity: 'required', preconditions: [], dataNeedIds: [], steps: [{
      stepId: blocked.stepId, ordinal: 0, semanticAction: '验证画布订单图', semanticTarget: '订单趋势画布',
      oracles: [{ oracleId: 'ORACLE-BLOCKED-CANVAS', statement: '画布订单趋势可验证' }],
      evidenceKinds: ['screenshot'],
    }], mode: 'real-environment', effect: 'read', evidenceLevel: 'E1', cleanupPlanId: 'not-applicable',
    timeoutMs: 30000, retryPolicy: 'none', status: 'active',
  })
  contents.cases.caseSetDigest = digestText('test-case-set/v1', canonicalizeJson(contents.cases.cases))
  contents.actionMap.actions.push({
    caseId: blocked.caseId, stepId: blocked.stepId, actionId: blocked.actionId,
    pageIdentityId: 'PAGE-ORDERS',
    locatorCandidates: [{ strategy: 'semantic-canvas', value: '订单趋势画布', confidence: 1 }],
    playwrightAction: 'unsupported:canvas-semantic-assertion', waits: [],
    oracleIds: ['ORACLE-BLOCKED-CANVAS'], effect: 'read',
    capabilities: [{ operation: 'screenshot', capabilityId: 'PENDING-BLOCKED-SCREENSHOT' }], requestIds: [],
  })
  contents.actionMap.unmappedSteps.push({
    caseId: blocked.caseId, stepId: blocked.stepId, reasonCode: blocked.reasonCode,
  })
  contents.execution.caseQueue.push({
    ordinal: contents.execution.caseQueue.length, caseId: blocked.caseId,
  })
  contents.execution.actionIntents.push({
    actionId: blocked.actionId, effect: 'read', intentDigest: d('blocked-read-intent'), requestIds: [],
  })
}

function applyWriteGoldenScenario(
  drafts: Record<string, any>,
  input: Parameters<typeof createReadOnlyGoldenGenerationInput>[0],
): void {
  const write = input.write
  if (!write) throw new Error('Write Golden 配置缺失')
  if (!('executionDigest' in input.readGrant.subject)) throw new Error('Write Golden 必须使用 SignedWriteGrant')
  const evidencePolicyDigest = drafts['execution-contract'].content.evidencePolicyDigest as string
  const projected = writeApprovalContents({
    modelDigest: input.modelDigest, universe: input.universe, fixtureOrigin: input.fixtureOrigin,
    runtimePolicyDigest: input.gatewayAudit.policyDigest, dataLeaseId: write.dataLeaseId,
    resourceKey: write.resourceKey, cleanupPlanDigest: write.cleanupPlanDigest,
    evidencePolicyDigest, runtimeIsolationPolicy: write.runtimeIsolationPolicy, decisions: input.decisions,
  })
  for (const type of [
    'project-policy', 'prd-manifest', 'prd-diff', 'acceptance-scope', 'requirement-model', 'coverage-universe',
    'test-cases', 'execution-contract', 'browser-action-map', 'run-bundle',
  ]) drafts[type].content = structuredClone(projected[type])

  drafts['prd-request'].content = {
    productSpace: 'ORDER-AUDIT', title: '订单审批可恢复写 E2E 验收',
    sourceDescriptors: [{ sourceId: 'SOURCE-PRD', kind: 'text', ref: 'golden:prd' }],
    userRequest: '验证操作员批准订单后系统可确认副作用并恢复测试数据',
    testWorkspaceId: 'WORKSPACE-GOLDEN', secretRefs: [],
  }
  drafts['interaction-flow'].content = { flows: [{
    flowId: 'FLOW-ORDER-APPROVAL', nodes: [
      { nodeId: 'NODE-APPROVE', reqId: 'REQ-ORDER-1', kind: 'action', effect: 'reversible-write',
        oracleIds: ['ORACLE-ORDER-APPROVED'] },
      { nodeId: 'NODE-RESTORED', reqId: 'REQ-ORDER-1', kind: 'state', effect: 'read', oracleIds: [] },
    ], edgeIds: ['EDGE-APPROVE-RESTORE'], entryNodeId: 'NODE-APPROVE', exitNodeIds: ['NODE-RESTORED'],
  }] }
  drafts['data-leases'].content = { leases: [{
    leaseId: write.dataLeaseId, resourceDigest: write.resourceDigest,
    cleanupPlanDigest: write.cleanupPlanDigest, status: 'released',
  }], allocatorEpoch: 1 }
  drafts['browser-preflight'].content.observedActor = write.actor
  drafts['browser-preflight'].content.observedIdentity = {
    identityId: 'IDENTITY-OPERATOR', digest: d('observed-write-identity'),
  }
  drafts['browser-preflight'].content.actorChecks = [{ id: write.actor, digest: d('actor-check') }]
  drafts['browser-preflight'].content.leaseChecks = [{
    id: write.dataLeaseId, digest: digestText('lease-preflight/v1', canonicalizeJson({
      leaseId: write.dataLeaseId, resourceDigest: write.resourceDigest,
      cleanupPlanDigest: write.cleanupPlanDigest,
    })),
  }]
  drafts['browser-action-map'].content.actions[0].capabilities = input.readGrant.capabilities.map((capability) => ({
    operation: capability.operation, capabilityId: capability.capabilityId,
  }))
  drafts['run-bundle'].content.signedCapabilities = input.readGrant.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId, actionId: capability.actionId,
    operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
    digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
  }))
  const evidenceIds = drafts['browser-evidence'].content.artifacts.map((item: { evidenceId: string }) => item.evidenceId)
  drafts['browser-results'].content = {
    runId: write.runId, trustedCompilerExecution: input.trustedCompilerExecution,
    executedBrowserIds: ['CHROMIUM'], caseResults: [{
      caseId: write.caseId, attemptId: input.attempt.attemptSelection.attemptId,
      eventChainDigest: input.attempt.attemptSelection.eventChainDigest,
      mode: 'real-environment', effect: 'reversible-write', status: 'passed', stepResults: [{
        stepId: write.stepId, actionId: write.actionId, status: 'passed',
        actualDigest: digestText('write-actual/v1', canonicalizeJson(input.caseResult.actual)),
        oracleResult: 'passed', evidenceIds,
      }], effectObservation: 'applied', gatewayAuditRef: 'ARTIFACT-GATEWAY-AUDIT',
      evidenceRefs: evidenceIds, cleanupRef: write.dataLeaseId,
      executionOutcomeReceipts: [write.executionOutcomeReceipt],
    }], startedAt: '2026-07-11T10:00:00.000Z', finishedAt: createdAt,
  }
  for (const artifact of drafts['browser-evidence'].content.artifacts) artifact.caseId = write.caseId
  drafts['browser-evidence'].content.caseCoverage = [{ caseId: write.caseId, evidenceIds }]
  drafts['cleanup-results'].content = { leaseResults: [{
    leaseId: write.dataLeaseId, status: 'verified-clean', digest: write.cleanupResultDigest,
    leaseReceiptDigest: write.executionOutcomeReceipt.cleanup.leaseReceiptDigest,
    plan: write.cleanupPlanDefinition,
  }] }
}

export function createPrivacyReviewEntries(input: {
  sanitized: Array<{ evidenceId: string; relativePath: string; fileDigest: string; record: {
    outputDigest: string; policyDigest: string; manualReview: { required: boolean; status: string }
  }; attestation: unknown }>
  decisions: Array<{ evidenceId: string; decision: 'approved' | 'rejected'; approver: ApproverIdentity }>
  issueReceipt(facts: {
    evidenceId: string; relativePath: string; fileDigest: string; outputDigest: string;
    sanitizerProofDigest: string; policyDigest: string; decision: 'approved' | 'rejected'; approver: ApproverIdentity
  }): PrivacyReviewReceipt
}) {
  const decisions = new Map(input.decisions.map((decision) => [decision.evidenceId, decision]))
  if (decisions.size !== input.decisions.length) throw new Error('E2E_PRIVACY_REVIEW_DECISION_DUPLICATE')
  const requiredIds = new Set(input.sanitized.filter((item) => item.record.manualReview.required)
    .map((item) => item.evidenceId))
  if ([...decisions.keys()].some((id) => !requiredIds.has(id))) {
    throw new Error('E2E_PRIVACY_REVIEW_DECISION_NOT_REQUIRED')
  }
  return input.sanitized.map((item) => {
    const sanitizerProofDigest = digestText('sanitizer-attestation/v1', canonicalizeJson(item.attestation))
    if (item.record.manualReview.required) {
      if (item.record.manualReview.status !== 'pending') throw new Error('E2E_PRIVACY_REVIEW_RECORD_NOT_PENDING')
      const decision = decisions.get(item.evidenceId)
      if (!decision) throw new Error(`E2E_PRIVACY_REVIEW_DECISION_MISSING:${item.evidenceId}`)
      const receipt = input.issueReceipt({
        evidenceId: item.evidenceId, relativePath: item.relativePath, fileDigest: item.fileDigest,
        outputDigest: item.record.outputDigest, sanitizerProofDigest, policyDigest: item.record.policyDigest,
        decision: decision.decision, approver: decision.approver,
      })
      return { evidenceId: item.evidenceId, status: decision.decision, receipt }
    }
    if (item.record.manualReview.status !== 'not-required') throw new Error('E2E_PRIVACY_REVIEW_DERIVATION_INVALID')
    const derivationDigest = digestText('privacy-review-not-required/v1', canonicalizeJson({
      evidenceId: item.evidenceId,
      recordDigest: digestText('sanitization-record/v1', canonicalizeJson(item.record)),
      sanitizerProofDigest, policyDigest: item.record.policyDigest, status: 'not-required',
    }))
    return { evidenceId: item.evidenceId, status: 'not-required' as const, derivationDigest }
  })
}

function sanitizerPolicy(): SanitizerPolicy {
  return {
    schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.0.0', scannerVersion: '1.0.0',
    network: { formatVersions: ['network-v1'], approvedPaths: ['/orders'], queryFields: [], requestHeaderFields: [],
      responseHeaderFields: [], requestBodyFields: [], responseBodyFields: [] },
    dom: { formatVersions: ['dom-v1'], allowedTags: ['main'], allowedAttributes: [], assertionTextClassification: 'public' },
    console: { formatVersions: ['console-v1'], allowedObjectFields: [], primitiveArgumentClassification: 'public' },
    screenshot: { formatVersions: ['png-v1'] }, video: { formatVersions: ['webm-v1'] },
    trace: { formatVersions: ['trace-v1'] }, maxInputBytes: 16 * 1024 * 1024, requireManualReviewFor: [],
  }
}

function sanitizeEvidence(
  input: Parameters<typeof createReadOnlyGoldenGenerationInput>[0], policy: SanitizerPolicy,
) {
  const screenshotEnvelope = Buffer.from(canonicalizeJson({
    format: 'png-v1', mediaBase64: Buffer.from(input.capturedEvidence.screenshot).toString('base64'),
    width: 1, height: 1, masks: [],
  }))
  const sanitizerAuthority = LocalSanitizerAuthority.create({
    issuer: 'golden-sanitizer', keyId: 'golden-sanitizer-key', policy,
    visualAdapter: {
      version: '1.0.0', supportedFormats: ['png-v1'],
      sanitize: ({ media }) => ({ bytes: appendSanitizedPngMarker(media), maskVerification: { verified: true, failedMaskIds: [] },
        ocr: { performed: true, engineVersion: 'golden-ocr/1.0.0', text: '订单列表 待审核', regions: ['full-page'] },
        frames: { strategy: 'not-applicable', inspectedFrames: [] },
        canaries: [{ canaryId: 'visual-pipeline-canary', expectedClassification: 'public',
          detected: input.sanitizerCanaryDetected ?? true }],
      }),
    },
  })
  const screenshot = sanitizerAuthority.sanitizeVisual({ evidenceId: 'EVIDENCE-SCREENSHOT',
    relativePath: 'evidence/read-only.png', raw: screenshotEnvelope, evidenceType: 'screenshot' })
  const dom = sanitizerAuthority.sanitizeDom({ evidenceId: 'EVIDENCE-DOM', relativePath: 'evidence/read-only-dom.json',
    raw: Buffer.from(canonicalizeJson({
    format: 'dom-v1', roots: [{ tag: 'main', assertionRelevant: true,
      text: Buffer.from(input.capturedEvidence.dom).toString('utf8'), children: [] }],
  })) })
  const gateway = sanitizerAuthority.sanitizeConsole({ evidenceId: 'EVIDENCE-GATEWAY', relativePath: 'evidence/gateway-audit.json',
    raw: Buffer.from(canonicalizeJson({
    format: 'console-v1', entries: [{ level: 'info', args: [canonicalizeJson({
      instanceId: input.gatewayAudit.gatewayInstance.instanceId,
      forwarded: input.gatewayAudit.signedCounters.forwarded,
      blocked: input.gatewayAudit.signedCounters.blocked,
      injected: input.gatewayAudit.signedCounters.injected,
      actionIds: input.gatewayAudit.requestEvents.map((event) => event.actionId),
      reservationActionIds: input.gatewayAudit.capabilityReservations.map((reservation) => reservation.actionId),
    })] }],
  })) })
  const outcomes = [
    { evidenceId: 'EVIDENCE-SCREENSHOT', relativePath: 'evidence/read-only.png', outcome: screenshot },
    { evidenceId: 'EVIDENCE-DOM', relativePath: 'evidence/read-only-dom.json', outcome: dom },
    { evidenceId: 'EVIDENCE-GATEWAY', relativePath: 'evidence/gateway-audit.json', outcome: gateway },
  ]
  const sanitized = outcomes.map(({ evidenceId, relativePath, outcome }) => {
    if (outcome.status === 'blocked') throw new Error(`证据脱敏失败：${evidenceId}:${outcome.reasonCodes.join(',')}`)
    return { evidenceId, relativePath, bytes: Buffer.from(outcome.bytes), record: outcome.record,
      attestation: outcome.attestation,
      fileDigest: digestBytes(`generation-file:${relativePath}`, outcome.bytes) }
  })
  return { sanitized, sanitizerAuthority }
}

function appendSanitizedPngMarker(media: Uint8Array): Buffer {
  const png = Buffer.from(media)
  const signature = Buffer.from('89504e470d0a1a0a', 'hex')
  if (png.byteLength < 20 || !png.subarray(0, 8).equals(signature)
    || png.subarray(png.byteLength - 8, png.byteLength - 4).toString('ascii') !== 'IEND') {
    throw new Error('真实截图不是可识别 PNG')
  }
  const type = Buffer.from('tEXt', 'ascii')
  const data = Buffer.from('e2e-sanitized\0true', 'latin1')
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.byteLength)
  return Buffer.concat([png.subarray(0, png.byteLength - 12), chunk, png.subarray(png.byteLength - 12)])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function predictedContentDigest(context: {
  assetId: string; generationId: string; prdRevision: string; engineVersion: string; createdAt: string
}, artifactType: string, artifactDraft: any): string {
  const schemaVersion = artifactSchemaVersion(artifactType)
  return digestArtifactContent(`artifact-content/${schemaVersion}/${artifactType}`, {
    artifactId: `ARTIFACT-${artifactType.toUpperCase()}`, artifactType, schemaVersion,
    engineVersion: context.engineVersion, assetId: context.assetId, prdRevision: context.prdRevision,
    generationId: context.generationId, createdAt: context.createdAt,
    contentDigest: '', signatures: [], dependencies: artifactDraft.dependencies,
    graph: artifactDraft.graph, content: artifactDraft.content,
  })
}

function artifactSchemaVersion(artifactType: string): string {
  if (artifactType === 'browser-action-map') return '2.1.0'
  if (artifactType === 'execution-contract') return '1.1.0'
  return ['approval-grants', 'browser-preflight', 'run-bundle',
    'project-policy', 'browser-evidence', 'acceptance-scope', 'prd-diff'].includes(artifactType) ? '2.0.0' : '1.0.0'
}
