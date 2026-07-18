import {
  ARTIFACT_TYPES,
  ArtifactSchemaRegistry,
  SignedGrantSchema,
  canonicalizeJson,
  digestApprovalProjection,
  digestArtifactContent,
  digestBytes,
  digestText,
  E2EError,
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
import type { EncryptedQuarantine } from '@mutil-skills/e2e-engine'
import type { RuntimeArtifactStoreAuthority } from './authority-host.js'
import {
  createPersistedRuntimeFinalizationMaterial,
  type PersistedRuntimeFinalizationArtifact,
  type PersistedRuntimeFinalizationMaterial,
} from './production-finalization-material-provider.js'
import { BrowserPreflightFactSchema } from './runtime-preflight.js'
import { parseRuntimeReadExecutionRecord } from './runtime-read-result.js'
import type { RuntimeRunSnapshot } from './run-store.js'

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
  }) {}

  async seal(snapshot: RuntimeRunSnapshot): Promise<PersistedRuntimeFinalizationMaterial> {
    const existing = snapshot.trustedExecutionFacts['finalization-material']
    if (existing !== undefined) return existing as PersistedRuntimeFinalizationMaterial
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
      actor: { subject: 'runtime:finalization-sealer', roles: ['e2e-publisher'] },
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
    for (const type of EXTERNAL_TYPES) documents.set(type, signArtifact(external[type], this.dependencies.authority))

    const executionContract = record(external['execution-contract'].content, 'E2E_RUNTIME_EXECUTION_CONTRACT_INVALID')
    const testCases = records(record(external['test-cases'].content, 'E2E_RUNTIME_TEST_CASES_INVALID').cases)
    const actionMap = records(record(external['browser-action-map'].content, 'E2E_RUNTIME_ACTION_MAP_INVALID').actions)
    const testCase = testCases.find((candidate) => candidate.caseId === read.caseId)
    const action = actionMap.find((candidate) => candidate.actionId === read.actionId)
    if (!testCase || !action) throw sealerError('E2E_RUNTIME_FINALIZATION_CASE_ACTION_BINDING_MISSING')
    const step = records(testCase.steps)[0]
    if (!step || step.stepId !== action.stepId) throw sealerError('E2E_RUNTIME_FINALIZATION_STEP_BINDING_MISSING')
    const capabilities = approvalCapabilities(executionGrant)
    const browserPreflight = createArtifact(snapshot, 'browser-preflight', {
      discoveryGrantId: discoveryGrant.grantId,
      authorityPreflightDigest: preflight.preflightDigest,
      observedActor: text((executionGrant.subject as Record<string, unknown>).actor, 'E2E_RUNTIME_EXECUTION_ACTOR_MISSING'),
      checks: [{ code: 'PREFLIGHT-READY', status: 'passed', digest: preflight.authorityOutcomeDigest }],
      observedIdentity: { identityId: 'OBSERVED-PAGE', digest: preflight.observedIdentityDigest },
      actorChecks: [], leaseChecks: [],
      gatewayChecks: [
        { id: gatewayInstanceId, digest: preflight.gatewayPolicyDigest },
        { id: 'TRUSTED-GATEWAY-PROXY', digest: preflight.gatewaySessionMeasurementDigest },
      ],
      sandboxChecks: [{ id: 'TRUSTED-CHROME-EXECUTABLE', digest: preflight.browserExecutableDigest }],
      status: 'passed',
    }, this.dependencies.authority)
    documents.set('browser-preflight', browserPreflight)
    const approvalInputTypes = [
      'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
      'test-cases', 'execution-contract', 'browser-action-map',
    ] as const
    const runBundleContent = {
      runId: snapshot.runId,
      allInputRefs: approvalInputTypes.map((type) => ({
        artifactId: artifactId(type), digest: digestApprovalProjection(type, external[type].content),
      })),
      schedule: [{ ordinal: 0, caseId: read.caseId, stepIds: [text(step.stepId)], actionIds: [read.actionId] }],
      attemptPlans: [{ caseId: read.caseId, slots: 1 }],
      signedCapabilities: capabilities,
      secretRefs: records(executionContract.identities).map((identity) => text(identity.secretRef)),
      runtimePolicyDigest: text(record(projectPolicy.runtimePolicy).digest),
      runtimeIsolationPolicyDigest: 'not-applicable',
    }
    const runBundle = createArtifact(snapshot, 'run-bundle', runBundleContent, this.dependencies.authority)
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
      runBundleDigest: runBundle.contentDigest, grants: [receipt],
    }, this.dependencies.authority))
    documents.set('manual-results', createArtifact(snapshot, 'manual-results', { results: [] }, this.dependencies.authority))
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

  private requireExternalArtifacts(snapshot: RuntimeRunSnapshot): Record<(typeof EXTERNAL_TYPES)[number], ArtifactDocument> {
    const result = {} as Record<(typeof EXTERNAL_TYPES)[number], ArtifactDocument>
    for (const type of EXTERNAL_TYPES) {
      const artifact = snapshot.frozenArtifacts[type]
      if (!artifact) throw sealerError(`E2E_RUNTIME_FINALIZATION_EXTERNAL_ARTIFACT_MISSING:${type}`)
      result[type] = artifact
    }
    return result
  }
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
): ArtifactDocument {
  const base = {
    artifactId: artifactId(type), artifactType: type, schemaVersion: schemaVersion(type),
    engineVersion: '0.1.0', assetId: snapshot.assetId,
    prdRevision: snapshot.artifactDigests['prd-source']!, generationId: snapshot.runId,
    createdAt: snapshot.updatedAt, contentDigest: '', signatures: [], dependencies: [],
    graph: { defines: [], references: [] }, content,
  }
  const contentDigest = digestArtifactContent(`artifact-content/${base.schemaVersion}/${type}`, base)
  const unsigned = ArtifactSchemaRegistry[type].parse({ ...base, contentDigest }) as ArtifactDocument
  return signArtifact(unsigned, authority)
}

function signArtifact(artifact: ArtifactDocument, authority: RuntimeArtifactStoreAuthority): ArtifactDocument {
  return ArtifactSchemaRegistry[artifact.artifactType].parse({
    ...structuredClone(artifact), signatures: [authority.signArtifactDigest(artifact.contentDigest)],
  }) as ArtifactDocument
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
    gatewayPolicyDigest: preflight.gatewayPolicyDigest,
    authorityPublicKeyDigest: dependencies.authority.artifactVerifierMaterial.publicKeyDigest,
    authorityStateProtectionLevel: dependencies.authority.stateProtectionLevel,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    sourceRevisionDigest: snapshot.artifactDigests['prd-source']!, sourceRepositoryIndependent: true,
    isolationProofDigest: digestText('runtime-isolation-proof/v1', canonicalizeJson({
      preflight: {
        browserMeasurementDigest: preflight.browserMeasurementDigest,
        browserClosureDigest: preflight.browserClosureDigest,
        canaryProofDigest: preflight.canaryProofDigest,
      },
      execution: executionFacts.isolationMeasurements,
    })),
  }
}

function requireQuarantineRecord(facts: Record<string, unknown>, type: 'dom' | 'screenshot'):
{ quarantinePath: string; plaintextDigest: string; byteLength: number } {
  const value = records(facts.records).find((candidate) => candidate.evidenceType === type)
  if (!value || typeof value.quarantinePath !== 'string' || typeof value.plaintextDigest !== 'string'
    || typeof value.byteLength !== 'number') throw sealerError('E2E_RUNTIME_FINALIZATION_QUARANTINE_RECORD_MISSING')
  return value as never
}

async function writeOrVerifySanitized(
  quarantine: Pick<EncryptedQuarantine, 'readEvidence' | 'writeEvidence'>,
  input: { runId: string; relativePath: string; bytes: Uint8Array },
): Promise<void> {
  const actor: QuarantineActor = { subject: 'runtime:finalization-sealer', roles: ['e2e-publisher'] }
  try {
    await quarantine.writeEvidence({ runId: input.runId, relativePath: input.relativePath,
      plaintext: input.bytes, actor })
  } catch (error) {
    if (!(error instanceof E2EError) || error.code !== 'E2E_QUARANTINE_EVIDENCE_EXISTS') throw error
    const existing = Buffer.from(await quarantine.readEvidence({
      runId: input.runId, relativePath: input.relativePath, actor,
    }))
    const matches = existing.equals(Buffer.from(input.bytes))
    existing.fill(0)
    if (!matches) throw sealerError('E2E_RUNTIME_FINALIZATION_SANITIZED_EVIDENCE_REBOUND')
  }
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
function sealerError(code: string): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false })
}
