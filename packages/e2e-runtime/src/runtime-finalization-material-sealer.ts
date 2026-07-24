import {
  ARTIFACT_TYPES,
  ArtifactSchemaRegistry,
  CleanupPlanDefinitionSchema,
  ExecutionOutcomeReceiptSchema,
  SignedGrantSchema,
  canonicalizeJson,
  deriveExecutionResultId,
  digestApprovalProjection,
  digestArtifactContent,
  digestBytes,
  digestCleanupPlanDefinition,
  digestText,
  E2EError,
  approvalAssuranceForMode,
  type ApprovalCapabilityRecord,
  type ArtifactDocument,
  type ArtifactType,
  type RuntimeProvenance,
  type QuarantineActor,
  type SanitizerPolicy,
  type SignedGrant,
} from '@mutil-skills/e2e-contracts'
import {
  LocalSanitizerAuthority,
  PatternPrivacyScanner,
} from '@mutil-skills/e2e-engine'
import {
  LocalGatewayAuditVerifier,
  verifyGatewayPublicationAudit,
  type GatewayPublicationAudit,
  type GatewayAuditVerifierMaterial,
} from '@mutil-skills/e2e-gateway'
import type { EncryptedQuarantine } from '@mutil-skills/e2e-engine'
import type { RuntimeArtifactStoreAuthority } from './authority-host.js'
import {
  createPersistedRuntimeFinalizationMaterial,
  type PersistedRuntimeFinalizationArtifact,
  type PersistedRuntimeFinalizationMaterial,
} from './production-finalization-material-provider.js'
import { BrowserPreflightFactSchema } from './runtime-preflight.js'
import { parseRuntimeReadExecutionRecord } from './runtime-read-result.js'
import { parseRuntimeInjectionExecutionOutput, parseRuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import type { RuntimeInjectionExecutionOutput, RuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import type { RuntimeRunSnapshot } from './run-store.js'
import { bindManualResultToRuntimeSnapshot } from './runtime-manual-results.js'
import { approvalModeFromTrustedFacts } from './local-approval-confirmations.js'

const EXTERNAL_TYPES = [
  'project-policy', 'prd-request', 'prd-manifest', 'prd-diff', 'semantic-generation',
  'acceptance-scope', 'requirement-model', 'interaction-flow', 'coverage-universe',
  'test-cases', 'design-audit', 'execution-contract', 'browser-action-map',
  'regression-manifest',
] as const satisfies readonly ArtifactType[]
const FACT_TYPES = ARTIFACT_TYPES.filter((type) =>
  type !== 'final-report' && type !== 'generation-manifest')
const PATHS: Record<(typeof FACT_TYPES)[number], string> = {
  'project-policy': 'design/project-policy.json',
  'prd-request': 'prd/prd-request.json',
  'prd-manifest': 'prd/prd-manifest.json',
  'prd-diff': 'prd/prd-diff.json',
  'semantic-generation': 'design/semantic-generation.json',
  'acceptance-scope': 'design/acceptance-scope.json',
  'requirement-model': 'design/requirement-model.json',
  'interaction-flow': 'design/interaction-flow.json',
  'coverage-universe': 'design/coverage-universe.json',
  'test-cases': 'design/test-cases.json',
  'design-audit': 'design/design-audit.json',
  'execution-contract': 'run/execution-contract.json',
  'approval-grants': 'run/approval-grants.json',
  'manual-results': 'run/manual-results.json',
  'data-leases': 'run/data-leases.json',
  'browser-preflight': 'run/browser-preflight.json',
  'browser-action-map': 'run/browser-action-map.json',
  'regression-manifest': 'run/regression-manifest.json',
  'run-bundle': 'run/run-bundle.json',
  'workflow-events': 'run/workflow-events.json',
  'browser-results': 'run/browser-results.json',
  'gateway-audit': 'run/gateway-audit.json',
  'browser-evidence': 'run/browser-evidence.json',
  diagnosis: 'run/diagnosis.json',
  'cleanup-results': 'run/cleanup-results.json',
}

export class RuntimeFinalizationMaterialSealer {
  constructor(private readonly dependencies: {
    quarantine: Pick<EncryptedQuarantine, 'readEvidence' | 'writeEvidence'>
    authority: RuntimeArtifactStoreAuthority
    runtimeVersion: string
    contractsVersion: string
    engineVersion: string
    playwrightVersion: string
    now?: () => Date
  }) {}

  async seal(snapshot: RuntimeRunSnapshot): Promise<PersistedRuntimeFinalizationMaterial> {
    const existing = snapshot.trustedExecutionFacts['finalization-material']
    if (existing !== undefined) return existing as PersistedRuntimeFinalizationMaterial
    const writeResults = Object.values(snapshot.executionResults?.realEnvironment ?? {})
    const injectionResults = Object.values(snapshot.executionResults?.gatewayInjection ?? {})
    const injection = injectionResults.length === 1
      ? parseRuntimeInjectionExecutionOutput(injectionResults[0]) : undefined
    if (injection !== undefined && injection.finalizationFacts === undefined) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_SIGNED_AUDIT_MISSING')
    }
    if (writeResults.length > 0) {
      if (writeResults.length !== 1) throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_RESULT_SET_INCOMPLETE')
      const write = parseRuntimeWriteExecutionOutput(writeResults[0])
      if (write.finalizationFacts === undefined) {
        throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_FACTS_MISSING')
      }
      const material = await this.sealWrite(snapshot, write)
      if (injectionResults.length === 0) return material
      if (injectionResults.length !== 1) throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_RESULT_SET_INCOMPLETE')
      return await this.sealInjection(snapshot, material, write, injection!)
    }
    if (injectionResults.length > 0) throw sealerError('E2E_RUNTIME_INJECTION_REAL_RESULT_REQUIRED')
    const external = this.requireExternalArtifacts(snapshot)
    const readResults = Object.values(snapshot.executionResults?.readEnvironment ?? {})
    if (readResults.length !== 1) throw sealerError('E2E_RUNTIME_FINALIZATION_READ_RESULT_SET_INCOMPLETE')
    const read = parseRuntimeReadExecutionRecord(readResults[0])
    const preflight = BrowserPreflightFactSchema.parse(snapshot.trustedExecutionFacts['browser-preflight'])
    const discoveryGrant = SignedGrantSchema.parse(snapshot.trustedExecutionFacts['signed-discovery-grant'])
    const executionGrant = SignedGrantSchema.parse(snapshot.trustedExecutionFacts['signed-execution-grant'])
    const executionFacts = record(snapshot.trustedExecutionFacts['finalization-execution-facts'],
      'E2E_RUNTIME_FINALIZATION_EXECUTION_FACTS_MISSING')
    const gatewayAudit = record(executionFacts.gatewayAudit, 'E2E_RUNTIME_GATEWAY_AUDIT_MISSING')
    const gatewayInstanceId = text(record(gatewayAudit.gatewayInstance,
      'E2E_RUNTIME_GATEWAY_AUDIT_MISSING').instanceId)
    const quarantineFacts = record(snapshot.trustedExecutionFacts['quarantined-evidence'],
      'E2E_RUNTIME_FINALIZATION_QUARANTINE_FACTS_MISSING')
    const rawDom = requireQuarantineRecord(quarantineFacts, 'dom')
    const sanitizerPolicy = productionSanitizerPolicy()
    const policyDigest = digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(sanitizerPolicy)))
    const projectPolicy = record(external['project-policy'].content, 'E2E_RUNTIME_PROJECT_POLICY_INVALID')
    if (record(projectPolicy.evidencePolicy, 'E2E_RUNTIME_PROJECT_POLICY_INVALID').digest !== policyDigest) {
      throw sealerError('E2E_RUNTIME_EVIDENCE_POLICY_DIGEST_MISMATCH')
    }
    const evidenceId = `EVIDENCE-${read.actionId}`
    const evidencePath = `evidence/${read.actionId}.dom.json`
    const rawBytes = Buffer.from(await this.dependencies.quarantine.readEvidence({
      runId: snapshot.runId, relativePath: rawDom.quarantinePath,
      actor: sanitizerReaderActor(),
    }))
    if (rawBytes.byteLength !== rawDom.byteLength
      || digestBytes('quarantine-plaintext/v1', rawBytes) !== rawDom.plaintextDigest) {
      rawBytes.fill(0)
      throw sealerError('E2E_RUNTIME_FINALIZATION_RAW_EVIDENCE_MISMATCH')
    }
    const sanitizer = LocalSanitizerAuthority.create({
      issuer: 'e2e-runtime-sanitizer', keyId: `sanitizer-${snapshot.runId}`,
      policy: sanitizerPolicy, scanner: new PatternPrivacyScanner(sanitizerPolicy.scannerVersion),
    })
    const sanitized = sanitizer.sanitizeDom({ evidenceId, relativePath: evidencePath, raw: rawBytes })
    rawBytes.fill(0)
    if (sanitized.status !== 'publishable') throw sealerError(
      sanitized.status === 'review-required'
        ? 'E2E_RUNTIME_PRIVACY_REVIEW_REQUIRED' : sanitized.reasonCodes[0] ?? 'E2E_RUNTIME_EVIDENCE_SANITIZATION_BLOCKED',
    )
    const sanitizedPath = `sanitized/${evidenceId}.json`
    await writeOrVerifySanitized(this.dependencies.quarantine, {
      runId: snapshot.runId, relativePath: sanitizedPath, bytes: sanitized.bytes,
    })
    const documents = new Map<ArtifactType, ArtifactDocument>()
    addResolvedExternalArtifacts(documents, external, executionGrant, this.dependencies.authority)

    const executionContract = record(external['execution-contract'].content, 'E2E_RUNTIME_EXECUTION_CONTRACT_INVALID')
    if (records(executionContract.actionIntents).some((intent) => intent.effect !== 'read')
      || records(executionContract.dataNeeds).length > 0) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_EXECUTION_MODE_UNSUPPORTED')
    }
    const testCases = records(record(external['test-cases'].content, 'E2E_RUNTIME_TEST_CASES_INVALID').cases)
    const actionMap = records(record(external['browser-action-map'].content, 'E2E_RUNTIME_ACTION_MAP_INVALID').actions)
    const testCase = testCases.find((candidate) => candidate.caseId === read.caseId)
    const action = actionMap.find((candidate) => candidate.actionId === read.actionId)
    if (!testCase || !action) throw sealerError('E2E_RUNTIME_FINALIZATION_CASE_ACTION_BINDING_MISSING')
    const step = records(testCase.steps)[0]
    if (!step || step.stepId !== action.stepId) throw sealerError('E2E_RUNTIME_FINALIZATION_STEP_BINDING_MISSING')
    const capabilities = approvalCapabilities(executionGrant)
    const generationEnvelope = finalizationArtifactEnvelope(snapshot)
    const browserPreflight = createArtifact(snapshot, 'browser-preflight', {
      discoveryGrantId: discoveryGrant.grantId,
      authorityPreflightDigest: preflight.preflightDigest,
      observedActor: text((executionGrant.subject as Record<string, unknown>).actor, 'E2E_RUNTIME_EXECUTION_ACTOR_MISSING'),
      checks: [{ code: 'PREFLIGHT-READY', status: 'passed', digest: preflight.authorityOutcomeDigest }],
      observedIdentity: { identityId: 'OBSERVED-PAGE', digest: preflight.observedIdentityDigest },
      actorChecks: [], leaseChecks: [],
      gatewayChecks: [
        { id: gatewayInstanceId, digest: text(gatewayAudit.policyDigest, 'E2E_RUNTIME_GATEWAY_POLICY_MISSING') },
        { id: 'TRUSTED-GATEWAY-PROXY', digest: preflight.gatewaySessionMeasurementDigest },
      ],
      sandboxChecks: [{ id: 'TRUSTED-CHROME-EXECUTABLE', digest: preflight.browserExecutableDigest }],
      status: 'passed',
    }, this.dependencies.authority, generationEnvelope.createdAt, generationEnvelope.engineVersion)
    documents.set('browser-preflight', browserPreflight)
    const approvalInputTypes = [
      'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
      'test-cases', 'execution-contract', 'browser-action-map',
    ] as const
    const runBundleContent = {
      runId: snapshot.runId,
      allInputRefs: approvalInputTypes.map((type) => ({
        artifactId: external[type].artifactId,
        digest: digestApprovalProjection(type, external[type].content),
      })),
      schedule: [{ ordinal: 0, caseId: read.caseId, stepIds: [text(step.stepId)], actionIds: [read.actionId] }],
      attemptPlans: [{ caseId: read.caseId, slots: 1 }],
      signedCapabilities: capabilities,
      secretRefs: records(executionContract.identities).map((identity) => text(identity.secretRef)),
      runtimePolicyDigest: text(record(projectPolicy.runtimePolicy).digest),
      runtimeIsolationPolicyDigest: 'not-applicable',
    }
    const runBundle = resolveFrozenRunBundle(
      snapshot, runBundleContent, this.dependencies.authority,
    )
    documents.set('run-bundle', runBundle)
    const receipt = await this.dependencies.authority.issueApprovalFreshnessReceipt({
      grant: executionGrant,
      currentSubject: executionGrant.subject,
      expectedCapabilities: capabilities,
      browserPreflight: {
        artifactDigest: browserPreflight.contentDigest,
        discoveryGrantId: discoveryGrant.grantId,
        authorityPreflightDigest: preflight.preflightDigest,
      },
      runBundle: { artifactDigest: runBundle.contentDigest, content: runBundle.content },
    })
    documents.set('approval-grants', createArtifact(snapshot, 'approval-grants', {
      runBundleDigest: runBundle.contentDigest,
      approvalAssurance: approvalAssuranceForMode(
        approvalModeFromTrustedFacts(snapshot.trustedExecutionFacts),
      ),
      grants: [receipt],
    }, this.dependencies.authority, receipt.checkedAt))
    documents.set('manual-results', createArtifact(snapshot, 'manual-results', {
      results: this.requireManualResults(snapshot, external),
    }, this.dependencies.authority))
    documents.set('data-leases', createArtifact(snapshot, 'data-leases', { leases: [], allocatorEpoch: 1 }, this.dependencies.authority))

    const attemptContext = {
      assetId: snapshot.assetId, generationId: snapshot.runId,
      prdRevision: external['prd-request'].prdRevision,
      runId: snapshot.runId, caseId: read.caseId,
    }
    const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(attemptContext))
    const started = this.dependencies.authority.appendAttemptEvent({ context: attemptContext, event: {
      sequence: 1, caseId: read.caseId, slot: 0, attemptId: read.attemptId,
      timestamp: snapshot.updatedAt, previousChainDigest: initialChainDigest,
      kind: 'started', mode: 'real-environment',
    } })
    const terminal = this.dependencies.authority.appendAttemptEvent({ context: attemptContext, event: {
      sequence: 2, caseId: read.caseId, slot: 0, attemptId: read.attemptId,
      timestamp: snapshot.updatedAt, previousChainDigest: started.eventChainDigest,
      kind: 'terminal', result: {
        status: read.status, mode: 'real-environment', effect: 'read',
        effectObservation: 'not-applicable', reservationSafeToVoid: true,
        ...(read.result.reservationIds?.[0] ? { reservationId: read.result.reservationIds[0] } : {}),
        ...(read.result.outcomeDigest ? { outcomeDigest: read.result.outcomeDigest } : {}),
      },
    } })
    const attemptCase = {
      caseId: read.caseId, retryPolicy: testCase.retryPolicy,
      initialChainDigest, events: [started.event, terminal.event],
      selection: { status: 'selected', attemptId: read.attemptId, slot: 0,
        eventChainDigest: terminal.eventChainDigest },
    }
    documents.set('workflow-events', createArtifact(snapshot, 'workflow-events', {
      runId: snapshot.runId, attemptCases: [attemptCase],
      workflowDigest: digestText('workflow-events/v2', canonicalizeJson({
        runId: snapshot.runId, attemptCases: [attemptCase],
      })),
    }, this.dependencies.authority))
    const actualDigest = read.result.outcomeDigest
      ?? digestText('runtime-read-actual/v1', canonicalizeJson(read.result.actual))
    documents.set('browser-results', createArtifact(snapshot, 'browser-results', {
      runId: snapshot.runId,
      executedBrowserIds: [text(records(executionContract.browserMatrix)[0]?.browserId)],
      caseResults: [{
        caseId: read.caseId, attemptId: read.attemptId, eventChainDigest: terminal.eventChainDigest,
        mode: 'real-environment', effect: 'read', status: read.status,
        stepResults: [{ stepId: text(step.stepId), actionId: read.actionId,
          status: read.status === 'passed' ? 'passed' : read.status === 'failed' ? 'failed' : 'unable',
          ...(read.status === 'passed' || read.status === 'failed' ? {
            actualDigest, oracleResult: read.status === 'passed' ? 'passed' : 'failed',
            evidenceIds: [evidenceId],
          } : { oracleResult: 'not-evaluated', evidenceIds: [] }) }],
        effectObservation: 'not-applicable', gatewayAuditRef: artifactId('gateway-audit'),
        evidenceRefs: read.status === 'passed' || read.status === 'failed' ? [evidenceId] : [],
      }],
      startedAt: snapshot.executionAttempt?.startedAt ?? snapshot.updatedAt,
      finishedAt: snapshot.updatedAt,
    }, this.dependencies.authority))
    documents.set('gateway-audit', createArtifact(snapshot, 'gateway-audit', gatewayAudit, this.dependencies.authority))
    const evidenceDigest = digestBytes(`generation-file:${evidencePath}`, sanitized.bytes)
    const privacyDerivationDigest = digestText('privacy-review-not-required/v1', canonicalizeJson({
      evidenceId,
      recordDigest: digestText('sanitization-record/v1', canonicalizeJson(sanitized.record)),
      sanitizerProofDigest: digestText('sanitizer-attestation/v1', canonicalizeJson(sanitized.attestation)),
      policyDigest: sanitized.record.policyDigest,
      status: 'not-required',
    }))
    documents.set('browser-evidence', createArtifact(snapshot, 'browser-evidence', {
      evidencePolicyDigest: policyDigest,
      artifacts: [{ evidenceId, caseId: read.caseId, relativePath: evidencePath,
        digest: evidenceDigest, byteLength: sanitized.bytes.byteLength,
        evidenceLevel: testCase.evidenceLevel, sanitizationRecord: sanitized.record }],
      caseCoverage: [{ caseId: read.caseId, evidenceIds: [evidenceId] }],
      sanitizerProofs: [{ evidenceId, record: sanitized.record, attestation: sanitized.attestation }],
      privacyReviews: [{ evidenceId, status: 'not-required', derivationDigest: privacyDerivationDigest }],
    }, this.dependencies.authority))
    documents.set('diagnosis', createArtifact(snapshot, 'diagnosis', {
      caseDiagnoses: [], healingAttempts: [], selectedAttemptExplanations: [],
    }, this.dependencies.authority))
    documents.set('cleanup-results', createArtifact(snapshot, 'cleanup-results', { leaseResults: [] }, this.dependencies.authority))

    const artifacts = FACT_TYPES.map((type): PersistedRuntimeFinalizationArtifact => {
      const artifact = documents.get(type)
      if (!artifact) throw sealerError(`E2E_RUNTIME_FINALIZATION_ARTIFACT_MISSING:${type}`)
      return { artifact, relativePath: PATHS[type] }
    })
    const provenance = runtimeProvenance(snapshot, preflight, executionFacts, this.dependencies)
    return createPersistedRuntimeFinalizationMaterial({
      runId: snapshot.runId,
      attemptId: read.attemptId,
      artifacts,
      execution: { runId: snapshot.runId, attemptId: read.attemptId,
        realEnvironmentResults: [], injectionResults: [] },
      gatewayAudit,
      evidence: [{ evidenceId, relativePath: evidencePath, quarantinePath: sanitizedPath,
        byteLength: sanitized.bytes.byteLength, digest: evidenceDigest }],
      cleanup: [],
      provenance,
      reportPresentation: {
        title: 'E2E 验收报告',
        injectionBoundary: '本代报告仅采用真实环境执行结果；故障注入结果独立展示，不覆盖真实结果。',
        recommendations: read.status === 'passed' ? ['保持本代回归测试持续运行。'] : ['修复失败项后创建新一代验收。'],
        regressionCommand: 'npx playwright test',
        browser: { version: this.dependencies.playwrightVersion, channel: 'chromium' },
      },
      verifierMaterials: {
        artifactAuthority: this.dependencies.authority.artifactVerifierMaterial,
        approvalFreshness: this.dependencies.authority.approvalFreshnessVerifierMaterial,
        decision: this.dependencies.authority.decisionVerifierMaterial,
        privacyReview: this.dependencies.authority.privacyReviewVerifierMaterial,
        attemptEvent: this.dependencies.authority.attemptEventVerifierMaterial,
        gatewayAudit: record(executionFacts.gatewayAuditVerifierMaterial,
          'E2E_RUNTIME_GATEWAY_VERIFIER_MATERIAL_MISSING'),
        sanitizer: sanitizer.verifierMaterial,
      },
    })
  }

  private async sealWrite(
    snapshot: RuntimeRunSnapshot,
    write: RuntimeWriteExecutionOutput,
  ): Promise<PersistedRuntimeFinalizationMaterial> {
    const external = this.requireExternalArtifacts(snapshot)
    const executionContract = record(external['execution-contract'].content,
      'E2E_RUNTIME_EXECUTION_CONTRACT_INVALID')
    if (Object.keys(snapshot.executionResults?.readEnvironment ?? {}).length > 0) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_MIXED_REAL_RESULT_SET_UNSUPPORTED')
    }
    const intents = records(executionContract.actionIntents)
    const dataNeeds = records(executionContract.dataNeeds)
    if (intents.length !== 1 || intents[0]!.actionId !== write.actionId
      || intents[0]!.effect !== 'reversible-write' || dataNeeds.length !== 1) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_CONTRACT_INCOMPLETE')
    }
    const resultId = deriveExecutionResultId(write.caseId, 'real-environment')
    const facts = write.finalizationFacts!
    const persistedFacts = trustedFactForResult(
      snapshot.trustedExecutionFacts['finalization-execution-facts'], 'realEnvironment', resultId,
    )
    if (persistedFacts === undefined || canonicalizeJson(persistedFacts) !== canonicalizeJson(facts)) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_FACTS_REBOUND')
    }
    const preflight = BrowserPreflightFactSchema.parse(snapshot.trustedExecutionFacts['browser-preflight'])
    const discoveryGrant = SignedGrantSchema.parse(snapshot.trustedExecutionFacts['signed-discovery-grant'])
    const executionGrant = SignedGrantSchema.parse(
      facts.executionGrant ?? snapshot.trustedExecutionFacts['signed-execution-grant'],
    )
    const receipt = ExecutionOutcomeReceiptSchema.parse(facts.executionOutcomeReceipt)
    const cleanupPlans = records(executionContract.writeCleanupPlans)
    if (cleanupPlans.length !== 1) throw sealerError('E2E_RUNTIME_FINALIZATION_CLEANUP_PLAN_MISSING')
    const cleanupPlan = CleanupPlanDefinitionSchema.parse(cleanupPlans[0])
    const capabilities = executionGrant.capabilities.filter((candidate) => candidate.actionId === write.actionId)
    const capability = capabilities[0]
    const dataNeed = dataNeeds[0]!
    if (capabilities.length !== 1 || capability === undefined || !('effect' in capability)
      || capability.effect !== 'reversible-write'
      || !('dataLeaseId' in capability) || !('cleanupPlanDigest' in capability)
      || !('fencingToken' in capability) || !('requests' in capability)
      || dataNeed.leaseId !== capability.dataLeaseId || dataNeed.mode !== 'write'
      || cleanupPlan.actionId !== write.actionId || cleanupPlan.leaseId !== capability.dataLeaseId
      || digestCleanupPlanDefinition(cleanupPlan) !== capability.cleanupPlanDigest) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_LEASE_BINDING_INVALID')
    }
    const targetFingerprints = [...new Set(capability.requests.map((request) => request.targetFingerprint))]
    const expectedEvidenceId = `EVIDENCE-${write.actionId}`
    if (targetFingerprints.length !== 1 || receipt.grantId !== executionGrant.grantId
      || receipt.capabilityId !== capability.capabilityId || receipt.actionId !== write.actionId
      || canonicalizeJson(receipt.capability) !== canonicalizeJson(capability)
      || receipt.attemptContext.runId !== snapshot.runId || receipt.attemptContext.caseId !== write.caseId
      || receipt.status !== write.status || receipt.effectObservation !== write.effectObservation
      || receipt.runnerResultDigest !== write.resultDigest
      || receipt.reservationId !== write.gatewayCommit.reservationId
      || receipt.signedDigest !== write.gatewayCommit.outcomeReceiptDigest
      || receipt.cleanup.leaseId !== capability.dataLeaseId
      || receipt.cleanup.cleanupPlanDigest !== capability.cleanupPlanDigest
      || receipt.cleanup.cleanupPlanId !== cleanupPlan.cleanupPlanId
      || receipt.cleanup.status !== write.cleanup.status
      || receipt.cleanup.resultDigest !== write.cleanup.resultDigest
      || receipt.cleanup.leaseReceiptDigest !== write.cleanup.leaseReceiptDigest
      || !validWriteOutcomeEvidenceIds(receipt.evidenceIds,
        receipt.gateway.executionSessionId, expectedEvidenceId,
        capability.transport, capability.operation)) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_OUTCOME_BINDING_INVALID')
    }
    const gatewayAudit = record(facts.gatewayAudit, 'E2E_RUNTIME_GATEWAY_AUDIT_MISSING')
    const gatewayInstanceId = text(record(gatewayAudit.gatewayInstance,
      'E2E_RUNTIME_GATEWAY_AUDIT_MISSING').instanceId)
    const quarantineFacts = record(trustedFactForResult(
      snapshot.trustedExecutionFacts['quarantined-evidence'], 'realEnvironment', resultId,
    ),
      'E2E_RUNTIME_FINALIZATION_QUARANTINE_FACTS_MISSING')
    if (quarantineFacts.attemptId !== receipt.attemptId) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_WRITE_EVIDENCE_ATTEMPT_MISMATCH')
    }
    const rawDom = requireQuarantineRecord(quarantineFacts, 'dom')
    const sanitizerPolicy = productionSanitizerPolicy()
    const policyDigest = digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(sanitizerPolicy)))
    const projectPolicy = record(external['project-policy'].content, 'E2E_RUNTIME_PROJECT_POLICY_INVALID')
    if (record(projectPolicy.evidencePolicy, 'E2E_RUNTIME_PROJECT_POLICY_INVALID').digest !== policyDigest) {
      throw sealerError('E2E_RUNTIME_EVIDENCE_POLICY_DIGEST_MISMATCH')
    }
    const evidencePath = `evidence/${write.actionId}.dom.json`
    const rawBytes = Buffer.from(await this.dependencies.quarantine.readEvidence({
      runId: snapshot.runId, relativePath: rawDom.quarantinePath,
      actor: sanitizerReaderActor(),
    }))
    if (rawBytes.byteLength !== rawDom.byteLength
      || digestBytes('quarantine-plaintext/v1', rawBytes) !== rawDom.plaintextDigest) {
      rawBytes.fill(0)
      throw sealerError('E2E_RUNTIME_FINALIZATION_RAW_EVIDENCE_MISMATCH')
    }
    const sanitizer = LocalSanitizerAuthority.create({
      issuer: 'e2e-runtime-sanitizer', keyId: `sanitizer-${snapshot.runId}`,
      policy: sanitizerPolicy, scanner: new PatternPrivacyScanner(sanitizerPolicy.scannerVersion),
    })
    const sanitized = sanitizer.sanitizeDom({ evidenceId: expectedEvidenceId, relativePath: evidencePath, raw: rawBytes })
    rawBytes.fill(0)
    if (sanitized.status !== 'publishable') throw sealerError(
      sanitized.status === 'review-required'
        ? 'E2E_RUNTIME_PRIVACY_REVIEW_REQUIRED' : sanitized.reasonCodes[0] ?? 'E2E_RUNTIME_EVIDENCE_SANITIZATION_BLOCKED',
    )
    const sanitizedPath = `sanitized/${expectedEvidenceId}.json`
    await writeOrVerifySanitized(this.dependencies.quarantine, {
      runId: snapshot.runId, relativePath: sanitizedPath, bytes: sanitized.bytes,
    })
    const documents = new Map<ArtifactType, ArtifactDocument>()
    addResolvedExternalArtifacts(documents, external, executionGrant, this.dependencies.authority)
    const testCases = records(record(external['test-cases'].content, 'E2E_RUNTIME_TEST_CASES_INVALID').cases)
    const actionMap = records(record(external['browser-action-map'].content, 'E2E_RUNTIME_ACTION_MAP_INVALID').actions)
    const testCase = testCases.find((candidate) => candidate.caseId === write.caseId)
    const action = actionMap.find((candidate) => candidate.actionId === write.actionId)
    const step = testCase === undefined ? undefined
      : records(testCase.steps).find((candidate) => candidate.stepId === action?.stepId)
    if (!testCase || !action || !step || testCase.effect !== 'reversible-write'
      || testCase.cleanupPlanId !== cleanupPlan.cleanupPlanId) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_CASE_ACTION_BINDING_MISSING')
    }
    const generationEnvelope = finalizationArtifactEnvelope(snapshot)
    const browserPreflight = createArtifact(snapshot, 'browser-preflight', {
      discoveryGrantId: discoveryGrant.grantId,
      authorityPreflightDigest: preflight.preflightDigest,
      observedActor: text((executionGrant.subject as Record<string, unknown>).actor,
        'E2E_RUNTIME_EXECUTION_ACTOR_MISSING'),
      checks: [{ code: 'PREFLIGHT-READY', status: 'passed', digest: preflight.authorityOutcomeDigest }],
      observedIdentity: { identityId: 'OBSERVED-PAGE', digest: preflight.observedIdentityDigest },
      actorChecks: [], leaseChecks: [{ id: capability.dataLeaseId, digest: targetFingerprints[0] }],
      gatewayChecks: [
        { id: gatewayInstanceId, digest: text(gatewayAudit.policyDigest, 'E2E_RUNTIME_GATEWAY_POLICY_MISSING') },
        { id: 'TRUSTED-GATEWAY-PROXY', digest: preflight.gatewaySessionMeasurementDigest },
      ],
      sandboxChecks: [{ id: 'TRUSTED-CHROME-EXECUTABLE', digest: preflight.browserExecutableDigest }],
      status: 'passed',
    }, this.dependencies.authority, generationEnvelope.createdAt, generationEnvelope.engineVersion)
    documents.set('browser-preflight', browserPreflight)
    const approvalInputTypes = [
      'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
      'test-cases', 'execution-contract', 'browser-action-map',
    ] as const
    const runBundleContent = {
      runId: snapshot.runId,
      allInputRefs: approvalInputTypes.map((type) => ({
        artifactId: external[type].artifactId,
        digest: digestApprovalProjection(type, external[type].content),
      })),
      schedule: [{ ordinal: 0, caseId: write.caseId, stepIds: [text(step.stepId)], actionIds: [write.actionId] }],
      attemptPlans: [{ caseId: write.caseId, slots: 1 }],
      signedCapabilities: approvalCapabilities(executionGrant),
      secretRefs: records(executionContract.identities).map((identity) => text(identity.secretRef)),
      runtimePolicyDigest: text(record(projectPolicy.runtimePolicy).digest),
      runtimeIsolationPolicyDigest: 'not-applicable',
    }
    const runBundle = resolveFrozenRunBundle(
      snapshot, runBundleContent, this.dependencies.authority,
    )
    documents.set('run-bundle', runBundle)
    const freshness = await this.dependencies.authority.issueApprovalFreshnessReceipt({
      grant: executionGrant, currentSubject: executionGrant.subject,
      expectedCapabilities: approvalCapabilities(executionGrant),
      browserPreflight: { artifactDigest: browserPreflight.contentDigest,
        discoveryGrantId: discoveryGrant.grantId, authorityPreflightDigest: preflight.preflightDigest },
      runBundle: { artifactDigest: runBundle.contentDigest, content: runBundle.content },
    })
    documents.set('approval-grants', createArtifact(snapshot, 'approval-grants', {
      runBundleDigest: runBundle.contentDigest,
      approvalAssurance: approvalAssuranceForMode(
        approvalModeFromTrustedFacts(snapshot.trustedExecutionFacts),
      ),
      grants: [freshness],
    }, this.dependencies.authority, freshness.checkedAt))
    documents.set('manual-results', createArtifact(snapshot, 'manual-results', {
      results: this.requireManualResults(snapshot, external),
    }, this.dependencies.authority))
    const leaseStatus = write.cleanup.status === 'verified-clean' ? 'released' : 'cleanup-failed'
    const lease = { leaseId: capability.dataLeaseId, resourceDigest: targetFingerprints[0],
      cleanupPlanDigest: capability.cleanupPlanDigest, status: leaseStatus }
    documents.set('data-leases', createArtifact(snapshot, 'data-leases', {
      leases: [lease], allocatorEpoch: capability.fencingToken,
    }, this.dependencies.authority))
    const attemptContext = { assetId: snapshot.assetId, generationId: snapshot.runId,
      prdRevision: external['prd-request'].prdRevision, runId: snapshot.runId, caseId: write.caseId }
    const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(attemptContext))
    const started = this.dependencies.authority.appendAttemptEvent({ context: attemptContext, event: {
      sequence: 1, caseId: write.caseId, slot: 0, attemptId: receipt.attemptId,
      timestamp: snapshot.updatedAt, previousChainDigest: initialChainDigest,
      kind: 'started', mode: 'real-environment',
    } })
    const terminal = this.dependencies.authority.appendAttemptEvent({ context: attemptContext, event: {
      sequence: 2, caseId: write.caseId, slot: 0, attemptId: receipt.attemptId,
      timestamp: snapshot.updatedAt, previousChainDigest: started.eventChainDigest,
      kind: 'terminal', result: { status: write.status, mode: 'real-environment',
        effect: 'reversible-write', effectObservation: write.effectObservation,
        reservationSafeToVoid: write.cleanup.status === 'verified-clean',
        reservationId: receipt.reservationId, outcomeDigest: receipt.signedDigest },
    } })
    const attemptCase = { caseId: write.caseId, retryPolicy: testCase.retryPolicy,
      initialChainDigest, events: [started.event, terminal.event], selection: {
        status: 'selected', attemptId: receipt.attemptId, slot: 0,
        eventChainDigest: terminal.eventChainDigest,
      } }
    documents.set('workflow-events', createArtifact(snapshot, 'workflow-events', {
      runId: snapshot.runId, attemptCases: [attemptCase],
      workflowDigest: digestText('workflow-events/v2', canonicalizeJson({
        runId: snapshot.runId, attemptCases: [attemptCase],
      })),
    }, this.dependencies.authority))
    const stepStatus = write.status === 'passed' ? 'passed' : write.status === 'failed' ? 'failed' : 'unable'
    documents.set('browser-results', createArtifact(snapshot, 'browser-results', {
      runId: snapshot.runId,
      executedBrowserIds: [text(records(executionContract.browserMatrix)[0]?.browserId)],
      caseResults: [{ resultId, caseId: write.caseId, attemptId: receipt.attemptId,
        eventChainDigest: terminal.eventChainDigest, mode: 'real-environment', effect: 'reversible-write',
        status: write.status, stepResults: [{ stepId: text(step.stepId), actionId: write.actionId,
          status: stepStatus,
          ...(stepStatus === 'unable' ? { oracleResult: 'not-evaluated', evidenceIds: [] } : {
            actualDigest: write.resultDigest, oracleResult: write.status === 'passed' ? 'passed' : 'failed',
            evidenceIds: [expectedEvidenceId],
          }) }], effectObservation: write.effectObservation,
        gatewayAuditRef: artifactId('gateway-audit'),
        evidenceRefs: stepStatus === 'unable' ? [] : [expectedEvidenceId],
        cleanupRef: capability.dataLeaseId, executionOutcomeReceipts: [receipt] }],
      startedAt: snapshot.executionAttempt?.startedAt ?? snapshot.updatedAt, finishedAt: snapshot.updatedAt,
    }, this.dependencies.authority))
    documents.set('gateway-audit', createArtifact(snapshot, 'gateway-audit', gatewayAudit, this.dependencies.authority))
    const evidenceDigest = digestBytes(`generation-file:${evidencePath}`, sanitized.bytes)
    const privacyDerivationDigest = digestText('privacy-review-not-required/v1', canonicalizeJson({
      evidenceId: expectedEvidenceId,
      recordDigest: digestText('sanitization-record/v1', canonicalizeJson(sanitized.record)),
      sanitizerProofDigest: digestText('sanitizer-attestation/v1', canonicalizeJson(sanitized.attestation)),
      policyDigest: sanitized.record.policyDigest, status: 'not-required',
    }))
    documents.set('browser-evidence', createArtifact(snapshot, 'browser-evidence', {
      evidencePolicyDigest: policyDigest,
      artifacts: [{ evidenceId: expectedEvidenceId, resultId, caseId: write.caseId, relativePath: evidencePath,
        digest: evidenceDigest, byteLength: sanitized.bytes.byteLength,
        evidenceLevel: testCase.evidenceLevel, sanitizationRecord: sanitized.record }],
      caseCoverage: [{ caseId: write.caseId, evidenceIds: [expectedEvidenceId] }],
      sanitizerProofs: [{ evidenceId: expectedEvidenceId, record: sanitized.record,
        attestation: sanitized.attestation }],
      privacyReviews: [{ evidenceId: expectedEvidenceId, status: 'not-required',
        derivationDigest: privacyDerivationDigest }],
    }, this.dependencies.authority))
    documents.set('diagnosis', createArtifact(snapshot, 'diagnosis', {
      caseDiagnoses: [], healingAttempts: [], selectedAttemptExplanations: [],
    }, this.dependencies.authority))
    const cleanupResult = { leaseId: capability.dataLeaseId, status: write.cleanup.status,
      digest: write.cleanup.resultDigest, leaseReceiptDigest: write.cleanup.leaseReceiptDigest,
      plan: cleanupPlan }
    documents.set('cleanup-results', createArtifact(snapshot, 'cleanup-results', {
      leaseResults: [cleanupResult],
    }, this.dependencies.authority))
    const artifacts = FACT_TYPES.map((type): PersistedRuntimeFinalizationArtifact => {
      const artifact = documents.get(type)
      if (!artifact) throw sealerError(`E2E_RUNTIME_FINALIZATION_ARTIFACT_MISSING:${type}`)
      return { artifact, relativePath: PATHS[type] }
    })
    return createPersistedRuntimeFinalizationMaterial({
      runId: snapshot.runId, attemptId: receipt.attemptId, artifacts,
      execution: { runId: snapshot.runId, attemptId: receipt.attemptId,
        realEnvironmentResults: [write], injectionResults: [] },
      gatewayAudit,
      evidence: [{ evidenceId: expectedEvidenceId, relativePath: evidencePath,
        quarantinePath: sanitizedPath, byteLength: sanitized.bytes.byteLength, digest: evidenceDigest }],
      cleanup: [cleanupResult], provenance: runtimeProvenance(
        snapshot, preflight, facts as unknown as Record<string, unknown>, this.dependencies,
      ),
      reportPresentation: {
        title: 'E2E 验收报告',
        injectionBoundary: '真实可逆写结果与故障注入结果分域保存；本代未包含故障注入结果。',
        recommendations: write.status === 'passed' ? ['持续验证 cleanup 与回归测试。'] : ['修复写执行失败后创建新一代验收。'],
        regressionCommand: 'npx playwright test',
        browser: { version: this.dependencies.playwrightVersion, channel: 'chromium' },
      },
      verifierMaterials: {
        artifactAuthority: this.dependencies.authority.artifactVerifierMaterial,
        approvalFreshness: this.dependencies.authority.approvalFreshnessVerifierMaterial,
        decision: this.dependencies.authority.decisionVerifierMaterial,
        privacyReview: this.dependencies.authority.privacyReviewVerifierMaterial,
        attemptEvent: this.dependencies.authority.attemptEventVerifierMaterial,
        gatewayAudit: facts.gatewayAuditVerifierMaterial,
        executionOutcome: facts.executionOutcomeVerifierMaterial,
        sanitizer: sanitizer.verifierMaterial,
      },
    })
  }

  private async sealInjection(
    snapshot: RuntimeRunSnapshot,
    base: PersistedRuntimeFinalizationMaterial,
    write: RuntimeWriteExecutionOutput,
    injection: RuntimeInjectionExecutionOutput,
  ): Promise<PersistedRuntimeFinalizationMaterial> {
    const expectedBaseline = deriveExecutionResultId(write.caseId, 'real-environment')
    if (write.status !== 'passed' || injection.caseId !== write.caseId
      || injection.actionId !== write.actionId || injection.baselineResultId !== expectedBaseline) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_BASELINE_INVALID')
    }
    const facts = record(trustedFactForResult(
      snapshot.trustedExecutionFacts['finalization-execution-facts'],
      'gatewayInjection', injection.resultId,
    ), 'E2E_RUNTIME_FINALIZATION_INJECTION_FACTS_MISSING')
    if (injection.finalizationFacts === undefined
      || canonicalizeJson(facts) !== canonicalizeJson(injection.finalizationFacts)) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_FACTS_REBOUND')
    }
    const grant = SignedGrantSchema.parse(facts.executionGrant)
    const capabilities = records(grant.capabilities)
    const capability = capabilities.find((item) => item.actionId === injection.actionId
      && item.caseId === injection.caseId && item.transport === 'gateway-injection')
    if (capability === undefined || capabilities.length !== 1) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_GRANT_BINDING_INVALID')
    }
    const gatewayAudit = record(facts.gatewayAudit,
      'E2E_RUNTIME_FINALIZATION_INJECTION_GATEWAY_AUDIT_MISSING') as GatewayPublicationAudit
    const gatewayVerifierMaterial = record(facts.gatewayAuditVerifierMaterial,
      'E2E_RUNTIME_FINALIZATION_INJECTION_GATEWAY_VERIFIER_MISSING') as GatewayAuditVerifierMaterial
    let gatewayVerifier: LocalGatewayAuditVerifier
    try {
      gatewayVerifier = LocalGatewayAuditVerifier.create(gatewayVerifierMaterial)
    } catch (cause) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_GATEWAY_VERIFIER_INVALID', cause)
    }
    if (!verifyGatewayPublicationAudit(gatewayAudit, gatewayVerifier)
      || gatewayAudit.signedCounters.forwarded !== 0
      || gatewayAudit.signedCounters.blocked !== 0
      || gatewayAudit.signedCounters.injected < 1
      || gatewayAudit.requestEvents.some((event) => event.actionId !== injection.actionId
        || event.decision !== 'injected')) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_GATEWAY_AUDIT_INVALID')
    }
    const reservations = gatewayAudit.capabilityReservations.filter((item) =>
      injection.completedReservationIds.includes(item.reservationId))
    if (reservations.length !== injection.completedReservationIds.length || reservations.length !== 1
      || reservations.some((item) => item.grantId !== grant.grantId
        || item.capabilityId !== capability.capabilityId || item.actionId !== injection.actionId
        || item.attemptId !== injection.attemptId || item.status !== 'completed'
        || item.consumed !== true || item.outcomeDigest === undefined)) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_RESERVATION_BINDING_INVALID')
    }
    const quarantineFacts = record(trustedFactForResult(
      snapshot.trustedExecutionFacts['quarantined-evidence'], 'gatewayInjection', injection.resultId,
    ), 'E2E_RUNTIME_FINALIZATION_INJECTION_QUARANTINE_FACTS_MISSING')
    if (quarantineFacts.attemptId !== injection.attemptId) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_EVIDENCE_ATTEMPT_MISMATCH')
    }
    const rawDom = requireQuarantineRecord(quarantineFacts, 'dom')
    const evidenceId = `EVIDENCE-INJECTION-${injection.actionId}`
    const evidencePath = `evidence/injection/${injection.actionId}.dom.json`
    const rawBytes = Buffer.from(await this.dependencies.quarantine.readEvidence({
      runId: snapshot.runId, relativePath: rawDom.quarantinePath,
      actor: sanitizerReaderActor(),
    }))
    if (rawBytes.byteLength !== rawDom.byteLength
      || digestBytes('quarantine-plaintext/v1', rawBytes) !== rawDom.plaintextDigest) {
      rawBytes.fill(0)
      throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_RAW_EVIDENCE_MISMATCH')
    }
    const sanitizerPolicy = productionSanitizerPolicy()
    const sanitizer = LocalSanitizerAuthority.create({
      issuer: 'e2e-runtime-injection-sanitizer', keyId: `injection-sanitizer-${snapshot.runId}`,
      policy: sanitizerPolicy, scanner: new PatternPrivacyScanner(sanitizerPolicy.scannerVersion),
    })
    const sanitized = sanitizer.sanitizeDom({ evidenceId, relativePath: evidencePath, raw: rawBytes })
    rawBytes.fill(0)
    if (sanitized.status !== 'publishable') throw sealerError(
      sanitized.status === 'review-required'
        ? 'E2E_RUNTIME_PRIVACY_REVIEW_REQUIRED' : sanitized.reasonCodes[0] ?? 'E2E_RUNTIME_EVIDENCE_SANITIZATION_BLOCKED',
    )
    const sanitizedPath = `sanitized/${evidenceId}.json`
    await writeOrVerifySanitized(this.dependencies.quarantine, {
      runId: snapshot.runId, relativePath: sanitizedPath, bytes: sanitized.bytes,
    })

    const byType = new Map(base.artifacts.map((entry) => [entry.artifact.artifactType, entry.artifact]))
    const workflow = record(byType.get('workflow-events')?.content)
    const attemptContext = {
      assetId: snapshot.assetId, generationId: snapshot.runId,
      prdRevision: text(byType.get('prd-request')?.prdRevision), runId: snapshot.runId,
      caseId: injection.caseId,
    }
    const initialChainDigest = digestText('attempt-chain-initial/v2', canonicalizeJson(attemptContext))
    const started = this.dependencies.authority.appendAttemptEvent({ context: attemptContext, event: {
      sequence: 1, caseId: injection.caseId, slot: 0, attemptId: injection.attemptId,
      timestamp: snapshot.updatedAt, previousChainDigest: initialChainDigest,
      kind: 'started', mode: 'gateway-injection',
    } })
    const reservation = reservations[0]!
    const terminal = this.dependencies.authority.appendAttemptEvent({ context: attemptContext, event: {
      sequence: 2, caseId: injection.caseId, slot: 0, attemptId: injection.attemptId,
      timestamp: snapshot.updatedAt, previousChainDigest: started.eventChainDigest,
      kind: 'terminal', result: {
        status: injection.status, mode: 'gateway-injection', effect: 'reversible-write',
        effectObservation: 'proven-not-applied', reservationSafeToVoid: true,
        reservationId: reservation.reservationId, outcomeDigest: reservation.outcomeDigest,
      },
    } })
    const testCases = records(record(byType.get('test-cases')?.content).cases)
    const testCase = testCases.find((item) => item.caseId === injection.caseId)
    if (!testCase) throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_CASE_MISSING')
    const attemptCase = {
      caseId: injection.caseId, retryPolicy: testCase.retryPolicy, initialChainDigest,
      events: [started.event, terminal.event], selection: {
        status: 'selected', attemptId: injection.attemptId, slot: 0,
        eventChainDigest: terminal.eventChainDigest,
      },
    }
    const attemptCases = [...records(workflow.attemptCases), attemptCase]
    const workflowContent = {
      runId: snapshot.runId, attemptCases,
      workflowDigest: digestText('workflow-events/v2', canonicalizeJson({ runId: snapshot.runId, attemptCases })),
    }

    const browserResults = record(byType.get('browser-results')?.content)
    const realResult = records(browserResults.caseResults).find((item) => item.resultId === expectedBaseline)
    if (!realResult) throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_BASELINE_ARTIFACT_MISSING')
    const realStep = records(realResult.stepResults).find((item) => item.actionId === injection.actionId)
    if (!realStep) throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_STEP_MISSING')
    const stepStatus = injection.status === 'passed' ? 'passed'
      : injection.status === 'failed' ? 'failed' : 'unable'
    const injectionResult = {
      resultId: injection.resultId, baselineResultId: injection.baselineResultId,
      caseId: injection.caseId, attemptId: injection.attemptId,
      eventChainDigest: terminal.eventChainDigest, mode: 'gateway-injection', effect: 'reversible-write',
      status: injection.status, stepResults: [{ stepId: realStep.stepId, actionId: injection.actionId,
        status: stepStatus,
        ...(stepStatus === 'unable' ? { oracleResult: 'not-evaluated', evidenceIds: [] } : {
          actualDigest: injection.resultDigest,
          oracleResult: injection.status === 'passed' ? 'passed' : 'failed', evidenceIds: [evidenceId],
        }) }], effectObservation: 'proven-not-applied', gatewayAuditRef: artifactId('gateway-audit'),
      evidenceRefs: stepStatus === 'unable' ? [] : [evidenceId],
    }
    const browserResultsContent = {
      ...browserResults, caseResults: [...records(browserResults.caseResults), injectionResult],
    }

    const baseGateway = record(byType.get('gateway-audit')?.content) as GatewayPublicationAudit & {
      sessions?: unknown[]
    }
    const baseGatewayVerifier = record(base.verifierMaterials.gatewayAudit) as GatewayAuditVerifierMaterial
    const gatewayContent = {
      ...baseGateway,
      sessions: [
        { resultId: expectedBaseline, domain: 'real-environment', audit: stripGatewaySessions(baseGateway),
          verifierMaterial: baseGatewayVerifier },
        { resultId: injection.resultId, domain: 'gateway-injection', audit: gatewayAudit,
          verifierMaterial: gatewayVerifierMaterial, grant },
      ],
    }

    const evidenceContent = record(byType.get('browser-evidence')?.content)
    const evidenceDigest = digestBytes(`generation-file:${evidencePath}`, sanitized.bytes)
    const privacyDerivationDigest = digestText('privacy-review-not-required/v1', canonicalizeJson({
      evidenceId, recordDigest: digestText('sanitization-record/v1', canonicalizeJson(sanitized.record)),
      sanitizerProofDigest: digestText('sanitizer-attestation/v1', canonicalizeJson(sanitized.attestation)),
      policyDigest: sanitized.record.policyDigest, status: 'not-required',
    }))
    const coverage = records(evidenceContent.caseCoverage)
    const caseCoverage = coverage.map((item) => item.caseId === injection.caseId
      ? { ...item, evidenceIds: [...new Set([...strings(item.evidenceIds), evidenceId])] } : item)
    if (!caseCoverage.some((item) => item.caseId === injection.caseId)) {
      caseCoverage.push({ caseId: injection.caseId, evidenceIds: [evidenceId] })
    }
    const evidenceContentUpdated = {
      ...evidenceContent,
      artifacts: [...records(evidenceContent.artifacts), {
        evidenceId, resultId: injection.resultId, caseId: injection.caseId, relativePath: evidencePath,
        digest: evidenceDigest, byteLength: sanitized.bytes.byteLength,
        evidenceLevel: testCase.evidenceLevel, sanitizationRecord: sanitized.record,
      }],
      caseCoverage,
      sanitizerProofs: [...records(evidenceContent.sanitizerProofs), {
        evidenceId, record: sanitized.record, attestation: sanitized.attestation,
      }],
      privacyReviews: [...records(evidenceContent.privacyReviews), {
        evidenceId, status: 'not-required', derivationDigest: privacyDerivationDigest,
      }],
    }
    const replacements = new Map<ArtifactType, ArtifactDocument>([
      ['workflow-events', createArtifact(snapshot, 'workflow-events', workflowContent, this.dependencies.authority)],
      ['browser-results', createArtifact(snapshot, 'browser-results', browserResultsContent, this.dependencies.authority)],
      ['gateway-audit', createArtifact(snapshot, 'gateway-audit', gatewayContent, this.dependencies.authority)],
      ['browser-evidence', createArtifact(snapshot, 'browser-evidence', evidenceContentUpdated, this.dependencies.authority)],
    ])
    const artifacts = base.artifacts.map((entry) => ({
      ...entry, artifact: replacements.get(entry.artifact.artifactType) ?? entry.artifact,
    }))
    return createPersistedRuntimeFinalizationMaterial({
      runId: base.runId, attemptId: base.attemptId, artifacts,
      execution: { ...base.execution, injectionResults: [injection] },
      gatewayAudit: gatewayContent,
      evidence: [...base.evidence, { evidenceId, relativePath: evidencePath, quarantinePath: sanitizedPath,
        byteLength: sanitized.bytes.byteLength, digest: evidenceDigest }],
      cleanup: base.cleanup, provenance: base.provenance,
      reportPresentation: {
        ...base.reportPresentation,
        injectionBoundary: '真实环境结果与 Gateway 故障注入结果按 resultId 独立保存；注入结果只参与 resilience/advisory，不改变业务 verdict。',
      },
      verifierMaterials: {
        ...base.verifierMaterials,
        gatewayAudit: [baseGatewayVerifier, gatewayVerifierMaterial],
        sanitizer: [base.verifierMaterials.sanitizer, sanitizer.verifierMaterial],
      },
    })
  }

  private requireExternalArtifacts(snapshot: RuntimeRunSnapshot): Record<(typeof EXTERNAL_TYPES)[number], ArtifactDocument> {
    const result = {} as Record<(typeof EXTERNAL_TYPES)[number], ArtifactDocument>
    for (const type of EXTERNAL_TYPES) {
      const artifact = snapshot.frozenArtifacts[type]
      if (!artifact) throw sealerError(`E2E_RUNTIME_FINALIZATION_EXTERNAL_ARTIFACT_MISSING:${type}`)
      result[type] = artifact
    }
    return result
  }

  private requireManualResults(
    snapshot: RuntimeRunSnapshot,
    external: Record<(typeof EXTERNAL_TYPES)[number], ArtifactDocument>,
  ) {
    const execution = record(external['execution-contract'].content,
      'E2E_RUNTIME_EXECUTION_CONTRACT_INVALID')
    const procedures = records(execution.manualProcedures)
    const procedureIds = procedures.map((procedure) => text(procedure.manualProcedureId))
    if (new Set(procedureIds).size !== procedureIds.length) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_MANUAL_PROCEDURE_DUPLICATE')
    }
    const coverage = record(external['coverage-universe'].content,
      'E2E_RUNTIME_COVERAGE_UNIVERSE_INVALID')
    const manualObligations = records(coverage.obligations).filter((obligation) =>
      record(obligation.disposition).kind === 'manual')
    const raw = snapshot.trustedExecutionFacts['manual-results-by-id']
    const resultMap = raw === undefined ? {} : record(raw, 'E2E_RUNTIME_FINALIZATION_MANUAL_RESULTS_INVALID')
    if (manualObligations.length === 0 && procedures.length === 0 && Object.keys(resultMap).length === 0) return []
    if (manualObligations.length === 0 || procedures.length === 0 || Object.keys(resultMap).length === 0) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_MANUAL_RESULTS_MISSING')
    }
    const now = this.dependencies.now?.() ?? new Date()
    const results = Object.entries(resultMap).map(([manualResultId, candidate]) => {
      const result = bindManualResultToRuntimeSnapshot(snapshot, candidate, now)
      if (result.manualResultId !== manualResultId) {
        throw sealerError('E2E_RUNTIME_FINALIZATION_MANUAL_RESULT_KEY_MISMATCH')
      }
      const verification = this.dependencies.authority.verifyManualResult(result)
      if (!verification.valid) throw sealerError(verification.code)
      return result
    }).sort((left, right) => left.manualResultId.localeCompare(right.manualResultId))
    const obligationIds = new Set(manualObligations.map((obligation) => text(obligation.obligationId)))
    for (const obligation of manualObligations) {
      const disposition = record(obligation.disposition)
      const manualProcedureId = text(disposition.manualProcedureId)
      if (!procedureIds.includes(manualProcedureId)) {
        throw sealerError('E2E_RUNTIME_FINALIZATION_MANUAL_PROCEDURE_MISSING')
      }
      const matches = results.filter((result) => result.obligationIds.includes(text(obligation.obligationId)))
      if (matches.length !== 1 || matches[0]!.manualProcedureId !== manualProcedureId) {
        throw sealerError(matches.length === 0
          ? 'E2E_RUNTIME_FINALIZATION_MANUAL_RESULTS_MISSING'
          : 'E2E_RUNTIME_FINALIZATION_MANUAL_RESULT_AMBIGUOUS')
      }
    }
    if (results.some((result) => result.obligationIds.some((id) => !obligationIds.has(id)))) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_MANUAL_RESULT_REBOUND')
    }
    return results
  }
}

function validWriteOutcomeEvidenceIds(
  actual: string[],
  executionSessionId: string,
  sanitizedEvidenceId: string,
  transport: string,
  operation: string,
): boolean {
  if (transport === 'http' && operation === 'http-request') {
    return canonicalizeJson(actual) === canonicalizeJson([sanitizedEvidenceId])
  }
  if (transport !== 'browser-local' || operation !== 'full-playwright') return false
  const fullPlaywright = (['BEFORE', 'AFTER', 'CLEANUP'] as const).flatMap((stage) =>
    ['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `${stage}-${kind}`))
  fullPlaywright.push(`GATEWAY-${executionSessionId}`)
  return canonicalizeJson(actual) === canonicalizeJson(fullPlaywright)
}

declare const runtimeFinalizationMaterialSealerBrand: unique symbol
export interface RuntimeFinalizationMaterialSealerCapability {
  readonly [runtimeFinalizationMaterialSealerBrand]: true
}
const sealerCapabilities = new WeakMap<object, RuntimeFinalizationMaterialSealer>()

export function authorizeRuntimeFinalizationMaterialSealer(
  sealer: RuntimeFinalizationMaterialSealer,
): RuntimeFinalizationMaterialSealerCapability {
  const capability = Object.freeze({}) as RuntimeFinalizationMaterialSealerCapability
  sealerCapabilities.set(capability, sealer)
  return capability
}

export async function sealRuntimeFinalizationMaterial(
  capability: RuntimeFinalizationMaterialSealerCapability,
  snapshot: RuntimeRunSnapshot,
): Promise<PersistedRuntimeFinalizationMaterial> {
  const sealer = sealerCapabilities.get(capability)
  if (!sealer) throw sealerError('E2E_RUNTIME_FINALIZATION_SEALER_CAPABILITY_UNTRUSTED')
  return await sealer.seal(structuredClone(snapshot))
}

function productionSanitizerPolicy(): SanitizerPolicy {
  return {
    schemaVersion: '1.0.0', policyVersion: '1.0.0', sanitizerVersion: '1.0.0', scannerVersion: '1.0.0',
    network: { formatVersions: ['network-json/1'], approvedPaths: ['/'], queryFields: [], requestHeaderFields: [],
      responseHeaderFields: [], requestBodyFields: [], responseBodyFields: [] },
    dom: { formatVersions: ['dom-tree/1'],
      allowedTags: ['main', 'nav', 'section', 'article', 'header', 'footer', 'div', 'span', 'p',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'a', 'ul', 'ol', 'li', 'label', 'form'],
      allowedAttributes: [
        { name: 'role', classification: 'public' },
        { name: 'aria-label', classification: 'public' },
        { name: 'data-testid', classification: 'public' },
      ], assertionTextClassification: 'public' },
    console: { formatVersions: ['console-json/1'], allowedObjectFields: [],
      primitiveArgumentClassification: 'public' },
    screenshot: { formatVersions: ['png/1'] }, video: { formatVersions: ['webm/1'] },
    trace: { formatVersions: ['playwright-trace/1'] }, maxInputBytes: 4 * 1024 * 1024,
    requireManualReviewFor: ['contact'],
  }
}

export function runtimeProductionSanitizerPolicyDigest(): string {
  return digestBytes('sanitizer-policy/v1', Buffer.from(canonicalizeJson(productionSanitizerPolicy())))
}

function createArtifact(
  snapshot: RuntimeRunSnapshot,
  type: ArtifactType,
  content: unknown,
  authority: RuntimeArtifactStoreAuthority,
  createdAt = snapshot.updatedAt,
  engineVersion = '0.3.0',
): ArtifactDocument {
  const base = {
    artifactId: artifactId(type), artifactType: type, schemaVersion: schemaVersion(type),
    engineVersion, assetId: snapshot.assetId,
    prdRevision: snapshot.artifactDigests['prd-source']!, generationId: snapshot.runId,
    createdAt, contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
  const contentDigest = digestArtifactContent(`artifact-content/${base.schemaVersion}/${type}`, base)
  const unsigned = ArtifactSchemaRegistry[type].parse({ ...base, contentDigest }) as ArtifactDocument
  return signArtifact(unsigned, authority)
}

function finalizationArtifactEnvelope(
  snapshot: RuntimeRunSnapshot,
): Pick<ArtifactDocument, 'createdAt' | 'engineVersion'> {
  const frozen = snapshot.frozenArtifacts['run-bundle']
  if (frozen === undefined) return { createdAt: snapshot.updatedAt, engineVersion: '0.3.0' }
  const parsed = ArtifactSchemaRegistry['run-bundle'].safeParse(frozen)
  if (!parsed.success) throw sealerError('E2E_RUNTIME_FINALIZATION_RUN_BUNDLE_DRIFT')
  return { createdAt: parsed.data.createdAt, engineVersion: parsed.data.engineVersion }
}

function signArtifact(artifact: ArtifactDocument, authority: RuntimeArtifactStoreAuthority): ArtifactDocument {
  return ArtifactSchemaRegistry[artifact.artifactType].parse({
    ...structuredClone(artifact), signatures: [authority.signArtifactDigest(artifact.contentDigest)],
  }) as ArtifactDocument
}

function resolveFrozenRunBundle(
  snapshot: RuntimeRunSnapshot,
  content: unknown,
  authority: RuntimeArtifactStoreAuthority,
): ArtifactDocument {
  const frozen = snapshot.frozenArtifacts['run-bundle']
  // 旧 Run 在 execution approval 阶段尚未持久化 run-bundle；仅为迁移兼容重建。
  // 新 Run 一旦由 binder 冻结，Finalizer 必须签署原文档而不能另造 envelope。
  if (frozen === undefined) return createArtifact(snapshot, 'run-bundle', content, authority)
  const parsed = ArtifactSchemaRegistry['run-bundle'].safeParse(frozen)
  if (!parsed.success
    || digestApprovalProjection('run-bundle', parsed.data.content)
      !== digestApprovalProjection('run-bundle', content)) {
    throw sealerError('E2E_RUNTIME_FINALIZATION_RUN_BUNDLE_DRIFT')
  }
  return signArtifact(parsed.data as ArtifactDocument, authority)
}

function addResolvedExternalArtifacts(
  documents: Map<ArtifactType, ArtifactDocument>,
  external: Record<(typeof EXTERNAL_TYPES)[number], ArtifactDocument>,
  executionGrant: SignedGrant,
  authority: RuntimeArtifactStoreAuthority,
): void {
  for (const type of EXTERNAL_TYPES) {
    documents.set(type, type === 'browser-action-map'
      ? resolveBrowserActionMap(external[type], executionGrant, authority)
      : signArtifact(external[type], authority))
  }
}

function resolveBrowserActionMap(
  artifact: ArtifactDocument,
  executionGrant: SignedGrant,
  authority: RuntimeArtifactStoreAuthority,
): ArtifactDocument {
  const content = structuredClone(record(artifact.content, 'E2E_RUNTIME_ACTION_MAP_INVALID'))
  const grantCapabilities = records(executionGrant.capabilities)
  content.actions = records(content.actions).map((action) => {
    const actionId = text(action.actionId, 'E2E_RUNTIME_ACTION_MAP_INVALID')
    const actionGrantCapabilities = grantCapabilities.filter((candidate) => candidate.actionId === actionId)
    if (actionGrantCapabilities.length === 0) return action
    return {
      ...action,
      capabilities: records(action.capabilities).map((candidate) => {
        const operation = text(candidate.operation, 'E2E_RUNTIME_ACTION_MAP_INVALID')
        const matches = actionGrantCapabilities.filter((grantCapability) =>
          grantCapability.operation === operation)
        if (matches.length !== 1) {
          throw sealerError('E2E_RUNTIME_ACTION_MAP_CAPABILITY_BINDING_INVALID')
        }
        return { ...candidate, capabilityId: text(matches[0]!.capabilityId) }
      }),
    }
  })
  const unsigned = { ...structuredClone(artifact), content, contentDigest: '', signatures: [] }
  const contentDigest = digestArtifactContent(
    `artifact-content/${artifact.schemaVersion}/${artifact.artifactType}`, unsigned,
  )
  return signArtifact(ArtifactSchemaRegistry['browser-action-map'].parse({
    ...unsigned, contentDigest,
  }) as ArtifactDocument, authority)
}

function schemaVersion(type: ArtifactType): string {
  if (type === 'execution-contract') return '1.1.0'
  if (type === 'browser-action-map') return '2.1.0'
  if (['cleanup-results', 'approval-grants', 'browser-preflight', 'run-bundle', 'project-policy',
    'browser-evidence', 'acceptance-scope', 'prd-diff', 'regression-manifest', 'workflow-events',
    'browser-results'].includes(type)) return '2.0.0'
  return '1.0.0'
}

function artifactId(type: ArtifactType): string { return `ARTIFACT-${type.toUpperCase()}` }

function approvalCapabilities(grant: SignedGrant): ApprovalCapabilityRecord[] {
  return grant.capabilities.map((capability) => {
    if (!('operation' in capability) || !('effect' in capability)) {
      throw sealerError('E2E_RUNTIME_FINALIZATION_GRANT_KIND_UNSUPPORTED')
    }
    return {
      capabilityId: capability.capabilityId, actionId: capability.actionId,
      operation: capability.operation, effect: capability.effect, maxUses: capability.maxUses,
      digest: digestText('approval-capability/v1', canonicalizeJson(capability)),
    } as ApprovalCapabilityRecord
  })
}

function runtimeProvenance(
  snapshot: RuntimeRunSnapshot,
  preflight: ReturnType<typeof BrowserPreflightFactSchema.parse>,
  executionFacts: Record<string, unknown>,
  dependencies: RuntimeFinalizationMaterialSealer['dependencies'],
): RuntimeProvenance {
  return {
    runtimeVersion: dependencies.runtimeVersion,
    runtimeInstallationDigest: snapshot.runtimeInstallationDigest,
    protocolVersion: '1.0.0', contractsVersion: dependencies.contractsVersion,
    engineVersion: dependencies.engineVersion, playwrightVersion: dependencies.playwrightVersion,
    chromiumDigest: preflight.browserExecutableDigest,
    gatewayPolicyDigest: text(record(executionFacts.gatewayAudit,
      'E2E_RUNTIME_GATEWAY_AUDIT_MISSING').policyDigest, 'E2E_RUNTIME_GATEWAY_POLICY_MISSING'),
    authorityPublicKeyDigest: dependencies.authority.artifactVerifierMaterial.publicKeyDigest,
    authorityStateProtectionLevel: dependencies.authority.stateProtectionLevel,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    sourceRevisionDigest: snapshot.artifactDigests['prd-source']!, sourceRepositoryIndependent: true,
    isolationProofDigest: digestText('runtime-isolation-proof/v1', canonicalizeJson([
      { id: 'TRUSTED-CHROME-EXECUTABLE', digest: preflight.browserExecutableDigest },
    ])),
  }
}

function requireQuarantineRecord(facts: Record<string, unknown>, type: 'dom' | 'screenshot'):
{ quarantinePath: string; plaintextDigest: string; byteLength: number } {
  const value = records(facts.records).find((candidate) => candidate.evidenceType === type)
  if (!value || typeof value.quarantinePath !== 'string' || typeof value.plaintextDigest !== 'string'
    || typeof value.byteLength !== 'number') throw sealerError('E2E_RUNTIME_FINALIZATION_QUARANTINE_RECORD_MISSING')
  return value as never
}

function trustedFactForResult(
  value: unknown,
  domain: 'realEnvironment' | 'gatewayInjection',
  resultId: string,
): unknown {
  if (isTrustedFactDomainContainer(value)) {
    const selected = record(value[domain], 'E2E_RUNTIME_FINALIZATION_FACT_DOMAIN_INVALID')[resultId]
    if (selected === undefined) throw sealerError('E2E_RUNTIME_FINALIZATION_RESULT_FACT_MISSING')
    return selected
  }
  if (domain === 'gatewayInjection') {
    throw sealerError('E2E_RUNTIME_FINALIZATION_INJECTION_FACT_DOMAIN_REQUIRED')
  }
  return value
}

function isTrustedFactDomainContainer(value: unknown): value is {
  schemaVersion: '2.0.0'
  realEnvironment: Record<string, unknown>
  gatewayInjection: Record<string, unknown>
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === '2.0.0'
    && typeof (value as Record<string, unknown>).realEnvironment === 'object'
    && (value as Record<string, unknown>).realEnvironment !== null
    && typeof (value as Record<string, unknown>).gatewayInjection === 'object'
    && (value as Record<string, unknown>).gatewayInjection !== null
}

function stripGatewaySessions(value: GatewayPublicationAudit & { sessions?: unknown[] }): GatewayPublicationAudit {
  const { sessions: _sessions, ...audit } = value
  return structuredClone(audit)
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw sealerError('E2E_RUNTIME_FINALIZATION_FACT_INVALID')
  }
  return [...value]
}

async function writeOrVerifySanitized(
  quarantine: Pick<EncryptedQuarantine, 'readEvidence' | 'writeEvidence'>,
  input: { runId: string; relativePath: string; bytes: Uint8Array },
): Promise<void> {
  const writer: QuarantineActor = { subject: 'runtime:finalization-sealer', roles: ['e2e-runner'] }
  try {
    await quarantine.writeEvidence({ runId: input.runId, relativePath: input.relativePath,
      plaintext: input.bytes, actor: writer })
  } catch (error) {
    if (!(error instanceof E2EError) || error.code !== 'E2E_QUARANTINE_EVIDENCE_EXISTS') throw error
    const existing = Buffer.from(await quarantine.readEvidence({
      runId: input.runId, relativePath: input.relativePath, actor: sanitizerReaderActor(),
    }))
    const matches = existing.equals(Buffer.from(input.bytes))
    existing.fill(0)
    if (!matches) throw sealerError('E2E_RUNTIME_FINALIZATION_SANITIZED_EVIDENCE_REBOUND')
  }
}

function sanitizerReaderActor(): QuarantineActor {
  return { subject: 'runtime:finalization-sealer', roles: ['e2e-sanitizer'] }
}

function record(value: unknown, code = 'E2E_RUNTIME_FINALIZATION_FACT_INVALID'): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw sealerError(code)
  return value as Record<string, any>
}
function records(value: unknown): Array<Record<string, any>> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
    throw sealerError('E2E_RUNTIME_FINALIZATION_FACT_INVALID')
  }
  return value as Array<Record<string, any>>
}
function text(value: unknown, code = 'E2E_RUNTIME_FINALIZATION_FACT_INVALID'): string {
  if (typeof value !== 'string' || value.length === 0) throw sealerError(code)
  return value
}
function sealerError(code: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false, cause })
}
