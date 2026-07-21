import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalizeJson, digestApprovalProjection, digestArtifactContent,
  digestBytes, digestCanonicalGrantApprovalSubject, digestDecisionSubject, digestText, projectLineageDecisionSubject,
  projectScopeDecisionSubject, type DecisionReceipt,
  type DecisionReceiptVerificationBinding } from '@mutil-skills/e2e-contracts'
import { createTestOnlyApprovalFreshnessClient, LocalApprovalAuthority } from '@mutil-skills/e2e-authority'
import { createTrustedCompilerReadiness } from '@mutil-skills/e2e-engine'
import {
  createTrustedCompilerExecutionTrust,
  createTrustedCompilerProjectorTrust,
} from '../src/trusted-compiler-trust.js'
import type { RegressionDiscoveryVerifierMaterial } from '@mutil-skills/e2e-contracts'

const digest = (value: string) => digestText('compiler-artifact-fixture/v1', value)
const artifactAuthority = LocalApprovalAuthority.create({
  issuer: 'COMPILER-FIXTURE-AUTHORITY', keyId: 'COMPILER-FIXTURE-KEY',
  now: () => new Date('2026-07-15T00:00:00.000Z'),
})
const freshness = generateKeyPairSync('ed25519')
const freshnessSpki = freshness.publicKey.export({ type: 'spki', format: 'der' })
const freshnessMaterial = {
  schemaVersion: '1.0.0' as const, purpose: 'approval-freshness-receipt/v1' as const,
  issuer: 'FIXTURE', keyId: 'FIXTURE-KEY', algorithm: 'Ed25519' as const,
  publicKeySpkiBase64: freshnessSpki.toString('base64'),
  publicKeyDigest: digestBytes('approval-freshness-public-key/v1', freshnessSpki),
}
const compilerApprovalFreshnessTestClient = createTestOnlyApprovalFreshnessClient({
  material: freshnessMaterial, expectedPublicKeyDigest: freshnessMaterial.publicKeyDigest,
  now: '2026-07-15T00:00:00.000Z',
})

export function createCompilerTestExecutionTrust(material: RegressionDiscoveryVerifierMaterial) {
  return createTrustedCompilerExecutionTrust({
    discoveryAuthority: { material, expectedPublicKeyDigest: material.publicKeyDigest },
    approvalFreshnessClient: compilerApprovalFreshnessTestClient,
    browserExecutablePath: process.execPath,
    gatewayProxyEndpoint: 'http://127.0.0.1:1/',
  })
}

export function approvedCompilerArtifacts(options: {
  effect?: 'read' | 'reversible-write'
  generationId?: string
  mismatchedApprovalProjection?: boolean
  additionalReadAction?: boolean
} = {}): unknown[] {
  const effect = options.effect ?? 'read'
  const additionalReadAction = effect === 'read' && options.additionalReadAction === true
  const generationId = options.generationId ?? 'GEN-1'
  const context = { assetId: 'PRODUCT/PRD-1', prdRevision: digest('prd'), generationId }
  const approvalContext = { assetId: context.assetId, prdRevision: context.prdRevision }
  const caseId = effect === 'read' ? 'CASE-READ-1' : 'CASE-WRITE-1'
  const actionId = effect === 'read' ? 'ACTION-READ-1' : 'ACTION-WRITE-1'
  const obligationId = effect === 'read' ? 'COV-READ-1' : 'COV-WRITE-1'
  const stepId = effect === 'read' ? 'STEP-READ-1' : 'STEP-WRITE-1'
  const scopeFacts = {
    includedReqCandidates: [{ reqId: 'REQ-1', sourceRefs: ['prd:1'] }], exclusions: [], ambiguities: [],
    dependencies: [], visualScope: { required: false, refs: [] },
    browserScope: { browserIds: ['CHROMIUM'], viewportIds: ['DESKTOP'] },
  }
  const lineageFacts = { previousRevision: digest('previous-prd'), currentRevision: context.prdRevision,
    sectionChanges: [], lineageMappings: [], impactedEntityIds: [] }
  const scopeReceipt = fixtureDecisionReceipt('scope', 'SCOPE-FIXTURE', digestDecisionSubject(
    projectScopeDecisionSubject(scopeFacts)))
  const lineageReceipt = fixtureDecisionReceipt('lineage', 'LINEAGE-FIXTURE', digestDecisionSubject(
    projectLineageDecisionSubject(lineageFacts)))
  const actionIds = additionalReadAction ? [actionId, 'ACTION-READ-2'] : [actionId]
  const stepIds = additionalReadAction ? [stepId, 'STEP-READ-2'] : [stepId]
  const capabilities = effect === 'read'
    ? actionIds.map((currentActionId, index) => ({
      capabilityId: `CAP-READ-${index + 1}`, actionId: currentActionId, operation: 'dom-read',
      effect: 'read', maxUses: 1, digest: digest(`cap-read-${index + 1}`),
    }))
    : [{ capabilityId: 'CAP-WRITE-1', actionId, operation: 'http-request',
      effect: 'reversible-write', maxUses: 1, digest: digest('cap-write') }]
  const capability = capabilities[0]!
  const approvalSubject = effect === 'read' ? {
    schemaVersion: '2.1.0', ...approvalContext,
    scopeDigest: digest('scope'), requirementModelDigest: digest('model'), coveragePolicyDigest: digest('coverage-policy'),
    universeDigest: digest('universe'), caseDigest: digest('cases'), actionMapDigest: digest('action-map'),
    policyDigest: digest('policy'), executionContractDigest: digest('execution'), runBundleProjectionDigest: digest('run-bundle'),
    environment: 'test', baseOrigin: 'https://example.test', actor: 'USER', discoveryGrantId: 'DISCOVERY-1',
    preflightDigest: digest('preflight'),
    requests: [],
    actions: actionIds.map((currentActionId) => ({
      actionId: currentActionId, operation: 'dom-read', maxUses: 1, requestIds: [],
    })),
  } : {
    schemaVersion: '2.0.0', ...approvalContext,
    executionDigest: digest('execution-approval'), scopeDigest: digest('scope'), requirementModelDigest: digest('model'),
    coveragePolicyDigest: digest('coverage-policy'), universeDigest: digest('universe'), caseDigest: digest('cases'),
    actionMapDigest: digest('action-map'), policyDigest: digest('policy'), executionContractDigest: digest('execution'),
    runBundleProjectionDigest: digest('run-bundle'), environment: 'test', baseOrigin: 'https://example.test', actor: 'USER',
    discoveryGrantId: 'DISCOVERY-1', preflightDigest: digest('preflight'), actions: [{
      actionId, effect: 'reversible-write', dataLeaseId: 'LEASE-1', fencingToken: 1,
      cleanupPlanDigest: digest('cleanup-plan'), requests: [{ intentId: 'INTENT-1', method: 'POST',
        canonicalOrigin: 'https://example.test', exactPath: '/orders/1/approve', query: [],
        payload: { kind: 'no-body' }, targetFingerprint: digest('target'), maxRequests: 1, expectedOrder: 1 }],
    }],
  }
  const receiptBody = {
    schemaVersion: '1.0.0', grantType: effect === 'read' ? 'read' : 'reversible-write', grantId: 'GRANT-1',
    subjectDigest: digestCanonicalGrantApprovalSubject('execution', approvalSubject),
    runBundleDigest: digest('run-bundle-artifact'), browserPreflightArtifactDigest: digest('browser-preflight-artifact'),
    capabilities, capabilitySetDigest: digestText('approval-capability-set/v1', canonicalizeJson(capabilities)),
    expiresAt: '2026-07-16T00:00:00.000Z', checkedAt: '2026-07-15T00:00:00.000Z',
    revocationSequence: 0, status: 'valid', reasonCodes: [], executionSubjectSnapshot: approvalSubject,
  }
  const approvalReceipt = { ...receiptBody, authorityProof: {
    purpose: 'approval-freshness-receipt/v1', issuer: 'FIXTURE', keyId: 'FIXTURE-KEY', algorithm: 'Ed25519',
    signedDigest: digestText('approval-freshness-receipt/v1', canonicalizeJson(receiptBody)), signature: 'fixture-proof',
  } }
  const contents: Record<string, unknown> = {
    'prd-manifest': {
      prdId: 'PRD-1', assetId: context.assetId, revision: context.prdRevision,
      normalizedPrdDigest: context.prdRevision,
      sources: [{ sourceId: 'PRD-1', digest: context.prdRevision, byteLength: 1 }],
      attachments: [], sourceCacheIndexDigest: digest('source-cache'),
    },
    'prd-diff': { ...lineageFacts,
      lineageReview: { decisionId: 'LINEAGE-FIXTURE', status: 'approved', receipt: lineageReceipt } },
    'acceptance-scope': { ...scopeFacts,
      scopeDecision: { decisionId: 'SCOPE-FIXTURE', status: 'approved', receipt: scopeReceipt } },
    'project-policy': {
      policyVersion: '1.0.0', environments: [{ environmentId: 'TEST', baseOrigin: 'https://example.test' }],
      originPolicies: [{ origin: 'https://example.test', allowRead: true, allowWrite: effect !== 'read' }],
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chromium', required: true }],
      coveragePolicy: { id: 'COVERAGE', digest: digest('coverage-policy') },
      evidencePolicy: { id: 'EVIDENCE', digest: digest('evidence-policy') },
      retentionPolicy: { id: 'RETENTION', digest: digest('retention-policy') },
      riskPolicy: { id: 'RISK', digest: digest('risk-policy') },
      timeoutPolicy: { id: 'TIMEOUT', digest: digest('timeout-policy') },
      runtimePolicy: { id: 'RUNTIME', digest: digest('runtime-policy') },
    },
    'requirement-model': {
      modelRevision: 1, coupledDimensions: [], applicabilityRules: ['actor:USER'], modelDecisionDigest: digest('model'),
      requirements: [{ reqId: 'REQ-1', revision: 1, title: '订单状态', actors: ['USER'], entities: ['ORDER'],
        preconditions: effect === 'read' ? [] : ['待审核'], rules: [{ ruleId: 'RULE-1', category: 'business',
          statement: '订单状态必须可见', sourceRefs: ['prd:1'], certainty: 'explicit' }],
        states: [], transitions: [], observableOutcomes: [{ oracleId: 'ORACLE-1',
          statement: effect === 'read' ? '待审核' : '已批准' }],
        applicability: [{ dimension: 'actor', value: 'USER', required: true }], sourceRefs: ['prd:1'], status: 'active' }],
    },
    'coverage-universe': {
      coveragePolicyDigest: digest('coverage-policy'), pairwiseSeed: 1, universeDigest: digest('universe'),
      obligations: [{ obligationId, reqId: 'REQ-1', ruleIds: ['RULE-1'], nodeIds: ['NODE-1'], actor: 'USER',
        transitionId: 'not-applicable', scenario: '订单状态', necessity: 'required', applicabilityRuleId: 'actor:USER',
        disposition: { kind: 'automated', caseIds: [caseId] } }],
    },
    'test-cases': {
      cases: [{ caseId, revision: 1, obligationIds: [obligationId], title: effect === 'read' ? '读取订单' : '批准订单',
        actor: 'USER', necessity: 'required', preconditions: effect === 'read' ? [] : ['待审核'],
        dataNeedIds: effect === 'read' ? [] : ['LEASE-1'], steps: stepIds.map((currentStepId, index) => ({
          stepId: currentStepId, ordinal: index,
          semanticAction: effect === 'read' ? `查看订单${index + 1}` : '批准订单',
          semanticTarget: index === 0 ? '订单状态' : '订单状态详情',
          oracles: [{ oracleId: 'ORACLE-1', statement: effect === 'read'
            ? (index === 0 ? '待审核' : '待审核详情') : '已批准' }],
          evidenceKinds: ['dom'],
        })), mode: 'real-environment', effect,
        evidenceLevel: 'E1', cleanupPlanId: effect === 'read' ? 'not-applicable' : 'CLEANUP-1',
        timeoutMs: 30_000, retryPolicy: effect === 'read' ? 'read-automation-max-2' : 'verified-not-applied-max-1',
        status: 'active' }], caseSetDigest: digest('case-set'),
    },
    'browser-action-map': {
      actionMapRevision: 1, pageIdentities: [{ pageId: 'PAGE-1', origin: 'https://example.test', assertionDigest: digest('page') }],
      actions: actionIds.map((currentActionId, index) => ({
        caseId, stepId: stepIds[index]!, actionId: currentActionId, pageIdentityId: 'PAGE-1',
        locatorCandidates: [{ strategy: 'role',
          value: effect === 'read' ? (index === 0 ? '待审核' : '待审核详情') : 'button:批准订单', confidence: 1 }],
        playwrightAction: effect === 'read' ? 'page.goto' : 'page.getByRole(button).click', waits: [],
        oracleIds: ['ORACLE-1'], effect,
        capabilities: [{ operation: effect === 'read' ? 'dom-read' : 'http-request',
          capabilityId: capabilities[index]!.capabilityId }],
        requestIds: [],
      })),
      unmappedSteps: [], discoveredRisks: [],
    },
    'execution-contract': {
      environment: 'TEST', baseOrigin: 'https://example.test',
      browserMatrix: [{ browserId: 'CHROMIUM', channel: 'chromium', viewportId: 'DESKTOP' }],
      identities: [{ identityId: 'IDENTITY-1', roleIds: ['USER'], secretRef: 'SECRET-1' }],
      caseQueue: [{ ordinal: 0, caseId }], actionIntents: actionIds.map((currentActionId, index) => ({
      actionId: currentActionId, effect, intentDigest: digest(`intent-${index + 1}`), requestIds: [],
      })),
      readHttpRequests: [],
      dataNeeds: effect === 'read' ? [] : [{ leaseId: 'LEASE-1', resourceKey: 'ORDER-1', mode: 'write' }],
      manualProcedures: [], evidencePolicyDigest: digest('evidence-policy'), runtimeIsolation: null, unresolvedItems: [],
    },
    'run-bundle': {
      runId: 'RUN-1', allInputRefs: [{ artifactId: 'ARTIFACT-TEST-CASES', digest: digest('input-ref') }],
      schedule: [{ ordinal: 0, caseId, stepIds, actionIds }],
      attemptPlans: [{ caseId, slots: 1 }], signedCapabilities: capabilities, secretRefs: ['SECRET-1'],
      runtimePolicyDigest: digest('runtime-policy'), runtimeIsolationPolicyDigest: 'not-applicable',
    },
    'approval-grants': {
      runBundleDigest: digest('run-bundle-artifact'),
      approvalAssurance: {
        approvalMode: 'webauthn', identityVerified: true, separationOfDutiesVerified: true,
      },
      grants: [approvalReceipt],
    },
  }
  Object.assign(approvalSubject, {
    scopeDigest: digestApprovalProjection('acceptance-scope', contents['acceptance-scope']),
    requirementModelDigest: digestApprovalProjection('requirement-model', contents['requirement-model']),
    coveragePolicyDigest: digest('coverage-policy'),
    universeDigest: digest('universe'),
    caseDigest: digestApprovalProjection('test-cases', contents['test-cases']),
    actionMapDigest: digestApprovalProjection('browser-action-map', contents['browser-action-map']),
    policyDigest: digestApprovalProjection('project-policy', contents['project-policy']),
    executionContractDigest: digestApprovalProjection('execution-contract', contents['execution-contract']),
    runBundleProjectionDigest: digestApprovalProjection('run-bundle', contents['run-bundle']),
  })
  const runBundleArtifact = seal({
    artifactId: 'ARTIFACT-RUN-BUNDLE', artifactType: 'run-bundle', schemaVersion: '2.0.0',
    engineVersion: '1.0.0', ...context, createdAt: '2026-07-15T00:00:00.000Z',
    contentDigest: digest('placeholder'), signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content: contents['run-bundle'],
  })
  receiptBody.runBundleDigest = runBundleArtifact.contentDigest as string
  approvalReceipt.runBundleDigest = receiptBody.runBundleDigest
  ;(contents['approval-grants'] as Record<string, unknown>).runBundleDigest = receiptBody.runBundleDigest
  receiptBody.subjectDigest = digestCanonicalGrantApprovalSubject('execution', approvalSubject)
  approvalReceipt.subjectDigest = receiptBody.subjectDigest
  approvalReceipt.authorityProof.signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(receiptBody))
  if (options.mismatchedApprovalProjection) {
    approvalSubject.policyDigest = digest('mismatched-policy')
    receiptBody.subjectDigest = digestCanonicalGrantApprovalSubject('execution', approvalSubject)
    approvalReceipt.subjectDigest = receiptBody.subjectDigest
    approvalReceipt.authorityProof.signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(receiptBody))
  }
  signFixtureFreshnessReceipt(approvalReceipt)
  const schemaVersions: Record<string, string> = {
    'prd-manifest': '1.0.0', 'prd-diff': '2.0.0', 'acceptance-scope': '2.0.0',
    'project-policy': '2.0.0', 'requirement-model': '1.0.0', 'coverage-universe': '1.0.0',
    'test-cases': '1.0.0', 'browser-action-map': '2.1.0', 'execution-contract': '1.1.0', 'approval-grants': '2.0.0',
    'run-bundle': '2.0.0',
  }
  return Object.entries(contents).map(([artifactType, content]) => seal({
    artifactId: `ARTIFACT-${artifactType.toUpperCase()}`, artifactType, schemaVersion: schemaVersions[artifactType],
    engineVersion: '1.0.0', ...context, createdAt: '2026-07-15T00:00:00.000Z',
    contentDigest: digest('placeholder'), signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }))
}

const readinessFixtureArtifacts = approvedCompilerArtifacts().filter((artifact) =>
  ['prd-manifest', 'prd-diff', 'acceptance-scope'].includes((artifact as { artifactType: string }).artifactType))
const fixtureReadiness = createTrustedCompilerReadiness({
  artifacts: readinessFixtureArtifacts,
  contractsVersion: '2.0.0',
  verifyArtifactSignature: artifactAuthority.verifyArtifactSignature.bind(artifactAuthority),
  verifyDecisionReceipt: verifyFixtureDecisionReceipt,
})
export const compilerArtifactVerification = { trust: createTrustedCompilerProjectorTrust({
  artifactAuthority: { material: artifactAuthority.artifactVerifierMaterial,
    expectedPublicKeyDigest: artifactAuthority.artifactVerifierMaterial.publicKeyDigest },
  approvalFreshnessAuthority: { material: freshnessMaterial,
    expectedPublicKeyDigest: freshnessMaterial.publicKeyDigest },
  readiness: fixtureReadiness,
}) }

export function approvedCompilerArtifactsWithBlockedCase(): unknown[] {
  const artifacts = approvedCompilerArtifacts()
  const content = (artifactType: string) => (artifacts.find((candidate) =>
    (candidate as Record<string, unknown>).artifactType === artifactType) as { content: Record<string, unknown> }).content
  ;(content('coverage-universe').obligations as Array<Record<string, unknown>>).push({
    obligationId: 'COV-BLOCKED-1', reqId: 'REQ-1', ruleIds: ['RULE-1'], nodeIds: ['NODE-2'], actor: 'USER',
    transitionId: 'not-applicable', scenario: 'Canvas 内容', necessity: 'required', applicabilityRuleId: 'actor:USER',
    disposition: { kind: 'automated', caseIds: ['CASE-BLOCKED'] },
  })
  ;(content('test-cases').cases as Array<Record<string, unknown>>).push({
    caseId: 'CASE-BLOCKED', revision: 1, obligationIds: ['COV-BLOCKED-1'], title: 'Canvas 内容', actor: 'USER',
    necessity: 'required', preconditions: [], dataNeedIds: [], steps: [{ stepId: 'STEP-BLOCKED', ordinal: 0,
      semanticAction: '读取 Canvas', semanticTarget: 'Canvas',
      oracles: [{ oracleId: 'ORACLE-1', statement: '图形可见' }], evidenceKinds: ['dom'] }],
    mode: 'real-environment', effect: 'read', evidenceLevel: 'E1', cleanupPlanId: 'not-applicable',
    timeoutMs: 30_000, retryPolicy: 'read-automation-max-2', status: 'active',
  })
  ;(content('browser-action-map').unmappedSteps as Array<Record<string, unknown>>).push({
    caseId: 'CASE-BLOCKED', stepId: 'STEP-BLOCKED', reasonCode: 'E2E_COMPILER_ACTION_UNSUPPORTED',
  })
  ;(content('execution-contract').caseQueue as Array<Record<string, unknown>>).push({ ordinal: 1, caseId: 'CASE-BLOCKED' })
  const approval = content('approval-grants') as { grants: Array<Record<string, any>> }
  const receipt = approval.grants[0]!
  Object.assign(receipt.executionSubjectSnapshot, {
    universeDigest: (content('coverage-universe') as { universeDigest: string }).universeDigest,
    caseDigest: digestApprovalProjection('test-cases', content('test-cases')),
    actionMapDigest: digestApprovalProjection('browser-action-map', content('browser-action-map')),
    executionContractDigest: digestApprovalProjection('execution-contract', content('execution-contract')),
  })
  receipt.subjectDigest = digestCanonicalGrantApprovalSubject('execution', receipt.executionSubjectSnapshot)
  const { authorityProof, ...receiptBody } = receipt
  authorityProof.signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(receiptBody))
  signFixtureFreshnessReceipt(receipt)
  for (let index = 0; index < artifacts.length; index += 1) {
    artifacts[index] = seal(artifacts[index] as Record<string, unknown>)
  }
  return artifacts
}

function signFixtureFreshnessReceipt(receipt: Record<string, any>): void {
  const { authorityProof: _proof, ...body } = receipt
  const signedDigest = digestText('approval-freshness-receipt/v1', canonicalizeJson(body))
  receipt.authorityProof = {
    purpose: 'approval-freshness-receipt/v1', issuer: 'FIXTURE', keyId: 'FIXTURE-KEY', algorithm: 'Ed25519',
    signedDigest,
    signature: sign(null, Buffer.from(canonicalizeJson({ purpose: 'approval-freshness-receipt/v1',
      issuer: 'FIXTURE', keyId: 'FIXTURE-KEY', signedDigest })), freshness.privateKey)
      .toString('base64url'),
  }
}

function fixtureDecisionReceipt(
  kind: 'scope' | 'lineage',
  decisionId: string,
  decisionSubjectDigest: string,
): Record<string, unknown> {
  const binding = { kind, decisionId, decisionStatus: 'approved' as const, decisionSubjectDigest }
  return {
    schemaVersion: '1.0.0', kind, decisionId, decisionStatus: 'approved', decisionSubjectDigest,
    checkedAt: '2026-07-15T00:00:00.000Z', nonce: 'a'.repeat(64),
    approver: { subject: `FIXTURE-${kind.toUpperCase()}-APPROVER`, roles: [`${kind}-approver`] },
    issuer: 'COMPILER-FIXTURE-AUTHORITY', keyId: 'COMPILER-FIXTURE-DECISION-KEY',
    purpose: `${kind}-decision-receipt/v1`, algorithm: 'Ed25519',
    signedDigest: digestText('fixture-decision-receipt/v1', canonicalizeJson(binding)),
    signature: 'fixture-decision-signature',
  }
}

function verifyFixtureDecisionReceipt(
  receipt: DecisionReceipt,
  binding: DecisionReceiptVerificationBinding,
): boolean {
  return receipt.kind === binding.kind && receipt.decisionId === binding.decisionId
    && receipt.decisionStatus === binding.decisionStatus
    && receipt.decisionSubjectDigest === binding.decisionSubjectDigest
    && receipt.signedDigest === digestText('fixture-decision-receipt/v1', canonicalizeJson(binding))
}

function seal(candidate: Record<string, unknown>): Record<string, unknown> {
  const sealed = {
    ...candidate,
    contentDigest: digestArtifactContent(
      `artifact-content/${candidate.schemaVersion as string}/${candidate.artifactType as string}`,
      candidate,
    ),
  }
  return { ...sealed, signatures: [artifactAuthority.signArtifactDigest(sealed.contentDigest)] }
}
