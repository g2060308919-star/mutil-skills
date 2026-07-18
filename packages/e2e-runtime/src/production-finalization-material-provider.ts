import {
  ARTIFACT_TYPES,
  RuntimeProvenanceSchema,
  canonicalizeJson,
  digestBytes,
  digestText,
  E2EError,
  parseArtifactDocument,
  type ArtifactDocument,
  type RuntimeProvenance,
} from '@mutil-skills/e2e-contracts'
import type {
  CompleteArtifactDraft,
  CompleteGenerationAuthority,
  ReportPresentation,
} from '@mutil-skills/e2e-engine'
import { createAttemptEventProofVerifier } from '@mutil-skills/e2e-authority'
import { createSanitizerAttestationVerifier } from '@mutil-skills/e2e-engine'
import {
  LocalExecutionOutcomeVerifier,
  LocalGatewayAuditVerifier,
  type GatewayPublicationAudit,
} from '@mutil-skills/e2e-gateway'
import { createRegressionDiscoveryVerifier, type TrustedCompilerInput } from '@mutil-skills/e2e-playwright-runtime'
import { RuntimeExecutionBatch, type RuntimeInjectionExecutionOutput,
  type RuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import type { RegressionPublicationResult } from './regression-publisher.js'
import type {
  PreparedRuntimeGenerationMaterial,
  RuntimeFinalizationMaterialProvider,
} from './production-generation-finalizer.js'
import type { RuntimeGenerationFinalizationInput } from './runtime-generation-finalizer.js'
import type { RuntimeCleanupResult, SanitizedRuntimeEvidence } from './generation-assembler.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const FACT_TYPES = ARTIFACT_TYPES.filter((type) =>
  type !== 'final-report' && type !== 'generation-manifest')

export interface PersistedRuntimeFinalizationArtifact {
  artifact: ArtifactDocument
  relativePath: string
}

export interface PersistedRuntimeEvidenceReference {
  evidenceId: string
  relativePath: string
  quarantinePath: string
  byteLength: number
  digest: string
}

export interface PersistedRuntimeFinalizationMaterial {
  schemaVersion: '1.0.0'
  runId: string
  attemptId: string
  materialDigest: string
  artifacts: PersistedRuntimeFinalizationArtifact[]
  execution: {
    runId: string
    attemptId: string
    realEnvironmentResults: RuntimeWriteExecutionOutput[]
    injectionResults: RuntimeInjectionExecutionOutput[]
  }
  gatewayAudit: unknown
  evidence: PersistedRuntimeEvidenceReference[]
  cleanup: RuntimeCleanupResult[]
  provenance: RuntimeProvenance
  reportPresentation: ReportPresentation
  /** 仅保存 JSON-safe 公钥材料与来源标签；禁止保存 verifier callback。 */
  verifierMaterials: Record<string, unknown>
}

export function createPersistedRuntimeFinalizationMaterial(input: {
  runId: string
  attemptId: string
  artifacts: PersistedRuntimeFinalizationArtifact[]
  execution: PersistedRuntimeFinalizationMaterial['execution']
  gatewayAudit: unknown
  evidence: PersistedRuntimeEvidenceReference[]
  cleanup: RuntimeCleanupResult[]
  provenance: RuntimeProvenance
  reportPresentation: ReportPresentation
  verifierMaterials: Record<string, unknown>
}): PersistedRuntimeFinalizationMaterial {
  const unsigned = parseUnsignedMaterial({ schemaVersion: '1.0.0', ...structuredClone(input) })
  const materialDigest = digestText('runtime-finalization-material/v1', canonicalizeJson(unsigned))
  return Object.freeze({ ...unsigned, materialDigest }) as PersistedRuntimeFinalizationMaterial
}

export function parsePersistedRuntimeFinalizationMaterial(
  candidate: unknown,
): PersistedRuntimeFinalizationMaterial {
  if (!plain(candidate) || !exact(candidate, [
    'artifacts', 'attemptId', 'cleanup', 'evidence', 'execution', 'gatewayAudit', 'materialDigest',
    'provenance', 'reportPresentation', 'runId', 'schemaVersion', 'verifierMaterials',
  ]) || candidate.schemaVersion !== '1.0.0' || typeof candidate.materialDigest !== 'string') {
    throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_INVALID')
  }
  const { materialDigest, ...unsignedCandidate } = candidate
  const unsigned = parseUnsignedMaterial(unsignedCandidate)
  if (materialDigest !== digestText('runtime-finalization-material/v1', canonicalizeJson(unsigned))) {
    throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_DIGEST_MISMATCH')
  }
  return structuredClone({ ...unsigned, materialDigest }) as PersistedRuntimeFinalizationMaterial
}

interface MaterialProviderDependencies {
  quarantine: {
    readEvidence(input: { runId: string; relativePath: string }): Promise<Uint8Array>
  }
  projectCompilerInput(input: {
    artifacts: ArtifactDocument[]
    material: PersistedRuntimeFinalizationMaterial
  }): TrustedCompilerInput
  authority: CompleteGenerationAuthority
  gatewayVerifier?: NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']>['gatewayVerifier']
  sanitizerVerifier?: NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']>['sanitizerVerifier']
  privacyReviewVerifier?: NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']>['privacyReviewVerifier']
  regressionDiscoveryVerifier?: NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']>['regressionDiscoveryVerifier']
  attemptProofVerifier?: NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']>['attemptProofVerifier']
  executionOutcomeVerifier?: NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']>['executionOutcomeVerifier']
}

/**
 * Production finalization 的唯一 material 入口。RPC 只提供 runId；本类只读取 Run Store
 * 已认证的 `finalization-material` 与 Git 外 Quarantine 中的 sanitized bytes。
 */
export class ProductionFinalizationMaterialProvider implements RuntimeFinalizationMaterialProvider {
  constructor(private readonly dependencies: MaterialProviderDependencies) {}

  async prepare(input: RuntimeGenerationFinalizationInput): Promise<PreparedRuntimeGenerationMaterial> {
    const candidate = input.snapshot.trustedExecutionFacts['finalization-material']
    if (candidate === undefined) throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_MISSING')
    const material = parsePersistedRuntimeFinalizationMaterial(candidate)
    assertSnapshotBinding(input, material)
    const artifacts = material.artifacts.map(({ artifact }) => artifact)
    assertArtifactAuthority(artifacts, this.dependencies.authority)
    const compilerInput = this.dependencies.projectCompilerInput({ artifacts, material })
    const evidence = await this.readSanitizedEvidence(material)
    const semanticDrafts = draftsFromMaterial(material, evidence)
    const execution = new RuntimeExecutionBatch({
      runId: material.execution.runId,
      attemptId: material.execution.attemptId,
      realEnvironmentResults: material.execution.realEnvironmentResults,
    })
    for (const injection of material.execution.injectionResults) execution.commitInjection(injection)
    let released = false
    return {
      compilerInput,
      bind: ({ regression, fencingToken }) => {
        if (released) throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_RELEASED')
        const boundDrafts = bindRegression(structuredClone(semanticDrafts), regression)
        return {
          context: {
            assetId: input.snapshot.assetId,
            generationId: input.snapshot.runId,
            prdRevision: artifacts[0]!.prdRevision,
            engineVersion: artifacts[0]!.engineVersion,
            createdAt: input.snapshot.updatedAt,
            fencingToken,
          },
          semanticDrafts: boundDrafts,
          execution,
          gatewayAudit: structuredClone(material.gatewayAudit) as GatewayPublicationAudit,
          evidence,
          cleanup: structuredClone(material.cleanup),
          provenance: structuredClone(material.provenance),
          authorities: this.dependencies.authority,
          reportPresentation: structuredClone(material.reportPresentation),
          verifiers: productionVerifiers(material, regression, this.dependencies),
        }
      },
      release: () => {
        if (released) return
        released = true
        for (const item of evidence) Buffer.from(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength).fill(0)
      },
    }
  }

  private async readSanitizedEvidence(
    material: PersistedRuntimeFinalizationMaterial,
  ): Promise<SanitizedRuntimeEvidence[]> {
    const evidence: SanitizedRuntimeEvidence[] = []
    try {
      for (const reference of material.evidence) {
        const bytes = Buffer.from(await this.dependencies.quarantine.readEvidence({
          runId: material.runId,
          relativePath: reference.quarantinePath,
        }))
        if (bytes.byteLength !== reference.byteLength
          || digestBytes(`generation-file:${reference.relativePath}`, bytes) !== reference.digest) {
          bytes.fill(0)
          throw materialError('E2E_RUNTIME_FINALIZATION_EVIDENCE_MISMATCH')
        }
        evidence.push({ evidenceId: reference.evidenceId, relativePath: reference.relativePath, bytes })
      }
      return evidence
    } catch (error) {
      for (const item of evidence) Buffer.from(item.bytes).fill(0)
      throw error
    }
  }
}

function productionVerifiers(
  material: PersistedRuntimeFinalizationMaterial,
  regression: RegressionPublicationResult,
  dependencies: MaterialProviderDependencies,
): NonNullable<ReturnType<PreparedRuntimeGenerationMaterial['bind']>['verifiers']> {
  const gatewayMaterials = materialList(material.verifierMaterials.gatewayAudit)
  const sanitizerMaterials = materialList(material.verifierMaterials.sanitizer)
  const attemptMaterial = material.verifierMaterials.attemptEvent as never
  const executionOutcomeMaterial = material.verifierMaterials.executionOutcome as never
  const gateways = dependencies.gatewayVerifier === undefined
    ? gatewayMaterials.map((candidate) => LocalGatewayAuditVerifier.create(candidate as never)) : []
  const sanitizers = dependencies.sanitizerVerifier === undefined
    ? sanitizerMaterials.map((candidate) => createSanitizerAttestationVerifier(
      candidate as never, (candidate as { publicKeyDigest: string }).publicKeyDigest,
    )) : []
  const requiresExecutionOutcome = material.execution.realEnvironmentResults.length > 0
  const executionOutcome = dependencies.executionOutcomeVerifier === undefined && requiresExecutionOutcome
    ? LocalExecutionOutcomeVerifier.create(executionOutcomeMaterial) : undefined
  return {
    gatewayVerifier: dependencies.gatewayVerifier
      ?? ((signature) => gateways.some((gateway) => gateway.verifySignature(signature))),
    sanitizerVerifier: dependencies.sanitizerVerifier
      ?? ((attestation, binding) => sanitizers.some((verify) => verify(attestation, binding))),
    privacyReviewVerifier: dependencies.privacyReviewVerifier ?? (() => false),
    regressionDiscoveryVerifier: dependencies.regressionDiscoveryVerifier
      ?? (regression.verifierMaterial === undefined ? () => false : createRegressionDiscoveryVerifier(
        regression.verifierMaterial, regression.verifierMaterial.publicKeyDigest,
      )),
    attemptProofVerifier: dependencies.attemptProofVerifier
      ?? createAttemptEventProofVerifier(attemptMaterial),
    ...(!requiresExecutionOutcome && dependencies.executionOutcomeVerifier === undefined ? {} : {
      executionOutcomeVerifier: dependencies.executionOutcomeVerifier
        ?? ((receipt) => executionOutcome!.verifyReceipt(receipt)),
    }),
  }
}

function materialList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value]
}

function parseUnsignedMaterial(candidate: unknown): Omit<PersistedRuntimeFinalizationMaterial, 'materialDigest'> {
  if (!plain(candidate) || !exact(candidate, [
    'artifacts', 'attemptId', 'cleanup', 'evidence', 'execution', 'gatewayAudit',
    'provenance', 'reportPresentation', 'runId', 'schemaVersion', 'verifierMaterials',
  ]) || candidate.schemaVersion !== '1.0.0' || typeof candidate.runId !== 'string'
    || !SAFE_ID.test(candidate.runId) || typeof candidate.attemptId !== 'string'
    || !SAFE_ID.test(candidate.attemptId) || !Array.isArray(candidate.artifacts)
    || !Array.isArray(candidate.evidence) || !Array.isArray(candidate.cleanup)
    || !plain(candidate.verifierMaterials) || !plain(candidate.execution)) {
    throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_INVALID')
  }
  const artifacts = candidate.artifacts.map((entry) => {
    if (!plain(entry) || !exact(entry, ['artifact', 'relativePath'])
      || typeof entry.relativePath !== 'string' || !safeRelativePath(entry.relativePath)) {
      throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_INVALID')
    }
    return { artifact: parseArtifactDocument(entry.artifact), relativePath: entry.relativePath }
  })
  const types = artifacts.map(({ artifact }) => artifact.artifactType).sort()
  if (canonicalizeJson(types) !== canonicalizeJson([...FACT_TYPES].sort())) {
    throw materialError('E2E_RUNTIME_FINALIZATION_ARTIFACT_SET_INCOMPLETE')
  }
  const first = artifacts[0]!.artifact
  if (artifacts.some(({ artifact }) => artifact.assetId !== first.assetId
    || artifact.generationId !== first.generationId || artifact.prdRevision !== first.prdRevision)) {
    throw materialError('E2E_RUNTIME_FINALIZATION_ARTIFACT_BINDING_MISMATCH')
  }
  const execution = parseExecution(candidate.execution, candidate.runId, candidate.attemptId)
  const evidence = candidate.evidence.map(parseEvidenceReference)
  if (new Set(evidence.map((item) => item.evidenceId)).size !== evidence.length
    || new Set(evidence.map((item) => item.quarantinePath)).size !== evidence.length) {
    throw materialError('E2E_RUNTIME_FINALIZATION_EVIDENCE_DUPLICATE')
  }
  const provenance = RuntimeProvenanceSchema.parse(candidate.provenance)
  const reportPresentation = parseReportPresentation(candidate.reportPresentation)
  // 通过 canonical round-trip 拒绝 Buffer、Date、class instance 与 callback。
  const verifierMaterials = jsonTree(candidate.verifierMaterials)
  const gatewayAudit = jsonTree(candidate.gatewayAudit)
  const cleanup = jsonTree(candidate.cleanup) as RuntimeCleanupResult[]
  return {
    schemaVersion: '1.0.0', runId: candidate.runId, attemptId: candidate.attemptId,
    artifacts: structuredClone(artifacts), execution, gatewayAudit, evidence, cleanup,
    provenance, reportPresentation, verifierMaterials,
  }
}

function parseExecution(
  candidate: Record<string, unknown>,
  runId: string,
  attemptId: string,
): PersistedRuntimeFinalizationMaterial['execution'] {
  if (!exact(candidate, ['attemptId', 'injectionResults', 'realEnvironmentResults', 'runId'])
    || candidate.runId !== runId || candidate.attemptId !== attemptId
    || !Array.isArray(candidate.realEnvironmentResults) || !Array.isArray(candidate.injectionResults)) {
    throw materialError('E2E_RUNTIME_FINALIZATION_EXECUTION_INVALID')
  }
  return jsonTree(candidate) as PersistedRuntimeFinalizationMaterial['execution']
}

function parseEvidenceReference(candidate: unknown): PersistedRuntimeEvidenceReference {
  if (!plain(candidate) || !exact(candidate,
    ['byteLength', 'digest', 'evidenceId', 'quarantinePath', 'relativePath'])
    || typeof candidate.evidenceId !== 'string' || !SAFE_ID.test(candidate.evidenceId)
    || typeof candidate.relativePath !== 'string' || !safeRelativePath(candidate.relativePath)
    || typeof candidate.quarantinePath !== 'string' || !safeRelativePath(candidate.quarantinePath)
    || typeof candidate.byteLength !== 'number' || !Number.isSafeInteger(candidate.byteLength)
    || candidate.byteLength < 0 || typeof candidate.digest !== 'string' || !DIGEST.test(candidate.digest)) {
    throw materialError('E2E_RUNTIME_FINALIZATION_EVIDENCE_REFERENCE_INVALID')
  }
  return { evidenceId: candidate.evidenceId, relativePath: candidate.relativePath,
    quarantinePath: candidate.quarantinePath, byteLength: candidate.byteLength, digest: candidate.digest }
}

function parseReportPresentation(candidate: unknown): ReportPresentation {
  if (!plain(candidate) || !exact(candidate,
    ['browser', 'injectionBoundary', 'recommendations', 'regressionCommand', 'title'])
    || typeof candidate.title !== 'string' || typeof candidate.injectionBoundary !== 'string'
    || typeof candidate.regressionCommand !== 'string' || !Array.isArray(candidate.recommendations)
    || candidate.recommendations.some((item) => typeof item !== 'string') || !plain(candidate.browser)
    || !exact(candidate.browser, ['channel', 'version'])
    || typeof candidate.browser.channel !== 'string' || typeof candidate.browser.version !== 'string') {
    throw materialError('E2E_RUNTIME_FINALIZATION_PRESENTATION_INVALID')
  }
  return structuredClone(candidate) as unknown as ReportPresentation
}

function assertSnapshotBinding(
  input: RuntimeGenerationFinalizationInput,
  material: PersistedRuntimeFinalizationMaterial,
): void {
  const artifacts = material.artifacts.map(({ artifact }) => artifact)
  if (material.runId !== input.snapshot.runId || artifacts.some((artifact) =>
    artifact.assetId !== input.snapshot.assetId || artifact.generationId !== input.snapshot.runId)
    || material.provenance.projectIdentityDigest !== input.snapshot.projectIdentityDigest
    || material.provenance.runtimeInstallationDigest !== input.snapshot.runtimeInstallationDigest
    || material.provenance.sourceRevisionDigest !== artifacts[0]!.prdRevision) {
    throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_BINDING_MISMATCH')
  }
  for (const [type, frozen] of Object.entries(input.snapshot.frozenArtifacts)) {
    const persisted = artifacts.find((artifact) => artifact.artifactType === type)
    if (persisted === undefined || canonicalizeJson({ ...persisted, signatures: [] })
      !== canonicalizeJson({ ...frozen, signatures: [] })) {
      throw materialError('E2E_RUNTIME_FINALIZATION_FROZEN_ARTIFACT_MISMATCH')
    }
  }
}

function assertArtifactAuthority(
  artifacts: ArtifactDocument[],
  authority: CompleteGenerationAuthority,
): void {
  for (const artifact of artifacts) {
    // 权威事实必须由 complete-generation builder 再按 artifact type 做强制签名校验；
    // 派生事实按契约允许无签名，但一旦携带签名就必须全部真实有效。
    if (artifact.signatures.some((signature) => signature.signedDigest !== artifact.contentDigest
      || !authority.verifyArtifactSignature(signature, artifact.contentDigest))) {
      throw materialError('E2E_RUNTIME_FINALIZATION_ARTIFACT_AUTHORITY_INVALID')
    }
  }
}

function draftsFromMaterial(
  material: PersistedRuntimeFinalizationMaterial,
  evidence: SanitizedRuntimeEvidence[],
): Record<string, CompleteArtifactDraft> {
  const drafts: Record<string, CompleteArtifactDraft> = {}
  for (const { artifact, relativePath } of material.artifacts) {
    drafts[artifact.artifactType] = {
      relativePath,
      content: structuredClone(artifact.content),
      dependencies: structuredClone(artifact.dependencies),
      graph: structuredClone(artifact.graph),
      files: [],
    }
  }
  drafts['browser-evidence']!.files = evidence.map((item) => ({
    relativePath: item.relativePath,
    base64: Buffer.from(item.bytes).toString('base64'),
  }))
  return drafts
}

function bindRegression(
  drafts: Record<string, CompleteArtifactDraft>,
  regression: RegressionPublicationResult,
): Record<string, CompleteArtifactDraft> {
  const draft = drafts['regression-manifest']
  if (!draft || !plain(draft.content)) throw materialError('E2E_RUNTIME_FINALIZATION_REGRESSION_DRAFT_MISSING')
  if (regression.verifierMaterial === undefined) {
    throw materialError('E2E_RUNTIME_FINALIZATION_REGRESSION_VERIFIER_MISSING')
  }
  const content = structuredClone(draft.content) as Record<string, unknown>
  content.sourceFiles = structuredClone(regression.discoveryAttestation.sourceFiles)
  content.caseMappings = structuredClone(regression.discoveryAttestation.caseMappings)
  content.testDomain = regression.discoveryAttestation.testDomain
  content.executionProfile = regression.discoveryAttestation.executionProfile
  content.templateDigest = regression.discoveryAttestation.templateDigest
  content.toolchain = structuredClone(regression.discoveryAttestation.toolchain)
  content.discoveryVerifierMaterial = structuredClone(regression.verifierMaterial)
  content.listResult = {
    caseIds: [...regression.caseIds],
    digest: digestText('playwright-list-result/v1', canonicalizeJson(regression.caseIds)),
    attestation: structuredClone(regression.discoveryAttestation),
  }
  drafts['regression-manifest'] = {
    ...draft,
    content,
    files: regression.files.map((file) => ({
      relativePath: file.relativePath,
      base64: Buffer.from(file.bytes).toString('base64'),
    })),
  }
  const browserResults = drafts['browser-results']
  const preflight = drafts['browser-preflight']
  if (!browserResults || !plain(browserResults.content) || !preflight || !plain(preflight.content)) {
    throw materialError('E2E_RUNTIME_FINALIZATION_BROWSER_RESULT_DRAFT_MISSING')
  }
  const caseResults = Array.isArray(browserResults.content.caseResults)
    ? browserResults.content.caseResults as Array<Record<string, unknown>> : []
  const executableCheck = Array.isArray(preflight.content.sandboxChecks)
    ? (preflight.content.sandboxChecks as Array<Record<string, unknown>>)
      .find((item) => item.id === 'TRUSTED-CHROME-EXECUTABLE') : undefined
  const gatewayCheck = Array.isArray(preflight.content.gatewayChecks)
    ? (preflight.content.gatewayChecks as Array<Record<string, unknown>>)
      .find((item) => item.id === 'TRUSTED-GATEWAY-PROXY') : undefined
  if (caseResults.length === 0 || executableCheck === undefined || gatewayCheck === undefined) {
    throw materialError('E2E_RUNTIME_FINALIZATION_TRUSTED_EXECUTION_BINDING_MISSING')
  }
  const executionCaseResults = caseResults
    .filter((item) => item.mode === 'real-environment')
    .map((item) => ({
      caseId: item.caseId,
      status: item.status === 'passed' ? 'passed' : 'failed',
    })).sort((left, right) => String(left.caseId).localeCompare(String(right.caseId)))
  const allPassed = executionCaseResults.every((item) => item.status === 'passed')
  drafts['browser-results'] = {
    ...browserResults,
    content: {
      ...structuredClone(browserResults.content),
      trustedCompilerExecution: {
        schemaVersion: '1.0.0', runId: browserResults.content.runId,
        compilerInputDigest: regression.discoveryAttestation.compilerInputDigest,
        sourceSetDigest: regression.discoveryAttestation.sourceSetDigest,
        approvalDigest: regression.discoveryAttestation.approvalDigest,
        browserExecutableDigest: executableCheck.digest,
        gatewayProxyEndpointDigest: gatewayCheck.digest,
        exitCode: allPassed ? 0 : 1,
        stdoutDigest: digestText('runtime-trusted-execution-stdout/v1', canonicalizeJson(executionCaseResults)),
        stderrDigest: digestText('runtime-trusted-execution-stderr/v1', allPassed ? '' : 'case-failure'),
        caseResults: executionCaseResults,
      },
    },
  }
  return drafts
}

function jsonTree<T>(value: T): T {
  try {
    const canonical = canonicalizeJson(value)
    return JSON.parse(canonical) as T
  } catch (cause) {
    throw materialError('E2E_RUNTIME_FINALIZATION_MATERIAL_NON_JSON', cause)
  }
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith('/')
    && !value.includes('\\') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function plain(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function materialError(code: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false, cause })
}
