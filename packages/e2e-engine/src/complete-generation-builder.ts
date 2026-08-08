import {
  ARTIFACT_TYPES,
  ArtifactSchemaRegistry,
  canonicalizeJson,
  digestArtifactContent,
  digestBytes,
  digestText,
  deriveExecutionResultId,
  migrateLegacyBrowserResultIdentities,
  parseArtifactDocument,
  type ArtifactDocument,
  type ArtifactSignature,
  type ArtifactType,
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerification,
  type DecisionReceipt,
  type DecisionReceiptVerificationBinding,
  digestDecisionSubject,
  projectLineageDecisionSubject,
  projectScopeDecisionSubject,
  type FinalReportContent,
  type PrivacyReviewReceipt,
  type PrivacyReviewReceiptBinding,
  type SanitizerAttestation,
  type SanitizerAttestationBinding,
  type RegressionDiscoveryAttestation,
  type RegressionDiscoverySubject,
  type VerdictInput,
  type AttemptEventAuthorityProof,
  type ExecutionOutcomeReceipt,
  RuntimeProvenanceSchema,
  type RuntimeProvenance,
  projectAssertionResultV1,
  projectApprovalPolicyDecisionViews,
  projectGatewayPolicyDecisionViews,
  type PolicyDecisionViewV1,
} from '@mutil-skills/e2e-contracts'
import {
  computeFinalizationSnapshotDigest,
  computeGenerationRootDigest,
  auditDecisionReceipts,
  deriveVerdictInputFromArtifacts,
  validateGeneration,
  type AuditableFile,
  type ValidateGenerationInput,
  type ApprovalFreshnessAuditBinding,
} from './generation-audit.js'
import { computeVerdict, type VerdictDependencies } from './verdict.js'
import { deriveBrowserCannotClaim } from './browser-claims.js'
import { auditSemanticCompleteness } from './semantic-completeness.js'
import { deriveRuntimeProvenanceCannotClaim } from './runtime-provenance-claims.js'
import { auditPersistedAttemptFacts, createPersistedAttemptVerdictDependencies,
  type PersistedAttemptProjection } from './persisted-attempt-audit.js'
import { types as utilTypes } from 'node:util'

type FactArtifactType = Exclude<ArtifactType, 'final-report' | 'generation-manifest'>
type ArtifactOf<T extends ArtifactType> = Extract<ArtifactDocument, { artifactType: T }>

export interface CompleteGenerationContext {
  assetId: string
  generationId: string
  prdRevision: string
  engineVersion: string
  createdAt: string
  fencingToken: number
}

export interface CompleteArtifactDraft {
  content: unknown
  graph: {
    defines: Array<{ kind: string; id: string }>
    references: Array<{ kind: string; id: string }>
  }
  dependencies: Array<{
    artifactId: string
    artifactType: string
    schemaVersion: string
    relativePath: string
    digest: string
  }>
  relativePath: string
  files?: Array<{ relativePath: string; base64: string }>
}

export interface ReportPresentation {
  title: string
  injectionBoundary: string
  recommendations: string[]
  regressionCommand: string
  browser: { version: string; channel: string }
}

export interface CompleteGenerationAuthority {
  signArtifactDigest(digest: string): ArtifactSignature
  verifyArtifactSignature(signature: ArtifactSignature, signedDigest: string): boolean
  verifyApprovalFreshnessReceipt(
    receipt: ApprovalFreshnessReceipt,
    binding: ApprovalFreshnessAuditBinding,
  ): ApprovalFreshnessVerification
  verifyDecisionReceipt(receipt: DecisionReceipt, binding: DecisionReceiptVerificationBinding): boolean
}

export interface CompleteGenerationFile {
  path: string
  bytes: Uint8Array
  digest: string
  byteLength: number
}

export interface BuildCompleteGenerationInput {
  context: CompleteGenerationContext
  /** Runtime Host 在隔离边界内测量并冻结的事实，不接受项目侧推导。 */
  provenance: RuntimeProvenance
  drafts: Record<FactArtifactType, CompleteArtifactDraft>
  reportPresentation: ReportPresentation
  authority: CompleteGenerationAuthority
  gatewayVerifier(signature: ArtifactSignature): boolean
  executionOutcomeVerifier?(receipt: ExecutionOutcomeReceipt): boolean
  sanitizerVerifier(attestation: SanitizerAttestation, binding: SanitizerAttestationBinding): boolean
  privacyReviewVerifier(receipt: PrivacyReviewReceipt, binding: PrivacyReviewReceiptBinding): boolean
  regressionDiscoveryVerifier(attestation: RegressionDiscoveryAttestation, subject: RegressionDiscoverySubject): boolean
  attemptProofVerifier(proof: AttemptEventAuthorityProof): boolean
  verdictDependencies?: VerdictDependencies
}

export interface CompleteGenerationBuild {
  files: CompleteGenerationFile[]
  terminalVerdict: ReturnType<typeof computeVerdict>['verdict']
  artifacts: ArtifactDocument[]
  artifactPaths: Record<string, string>
  verdictInput: VerdictInput
  verdictInputPath: string
  validationInput: Omit<ValidateGenerationInput, 'artifactCandidates' | 'actualFiles'>
}

const AUTHORITY_TYPES = new Set<ArtifactType>([
  'prd-manifest', 'acceptance-scope', 'execution-contract', 'approval-grants', 'run-bundle',
  'manual-results', 'generation-manifest',
])
const FACT_TYPES = ARTIFACT_TYPES.filter(
  (type): type is FactArtifactType => type !== 'final-report' && type !== 'generation-manifest',
)

/** 生产级完整代际构建入口：只接受事实草稿，裁决、报告与 manifest 均在边界内生成。 */
export function buildCompleteGeneration(candidate: BuildCompleteGenerationInput): CompleteGenerationBuild {
  const input = snapshotCompleteGenerationInput(candidate)
  assertExactKeys(input as unknown as Record<string, unknown>, [
    'context', 'provenance', 'drafts', 'reportPresentation', 'authority',
    'gatewayVerifier', 'sanitizerVerifier', 'privacyReviewVerifier', 'regressionDiscoveryVerifier', 'verdictDependencies',
    'attemptProofVerifier', 'executionOutcomeVerifier',
  ], 'E2E_COMPLETE_GENERATION_INPUT_KEYS_INVALID')
  assertExactKeys(input.context as unknown as Record<string, unknown>, [
    'assetId', 'generationId', 'prdRevision', 'engineVersion', 'createdAt', 'fencingToken',
  ], 'E2E_COMPLETE_GENERATION_CONTEXT_KEYS_INVALID')
  assertExactKeys(input.reportPresentation as unknown as Record<string, unknown>, [
    'title', 'injectionBoundary', 'recommendations', 'regressionCommand', 'browser',
  ], 'E2E_COMPLETE_GENERATION_PRESENTATION_KEYS_INVALID')
  assertExactKeys(input.reportPresentation.browser as unknown as Record<string, unknown>, [
    'version', 'channel',
  ], 'E2E_COMPLETE_GENERATION_BROWSER_PRESENTATION_KEYS_INVALID')
  assertContext(input.context)
  assertExactDraftTypes(input.drafts)
  input.drafts['browser-results'].content = migrateLegacyBrowserResultIdentities(
    input.drafts['browser-results'].content as { caseResults: unknown[] },
  )
  const artifactPaths: Record<string, string> = {}
  const artifacts: ArtifactDocument[] = []

  for (const artifactType of FACT_TYPES) {
    const draft = input.drafts[artifactType]
    assertExactKeys(draft as unknown as Record<string, unknown>, [
      'content', 'graph', 'dependencies', 'relativePath', 'files',
    ], `E2E_COMPLETE_GENERATION_DRAFT_KEYS_INVALID:${artifactType}`)
    const artifactId = artifactIdFor(artifactType)
    const candidate = createArtifact(input, artifactType, artifactId, draft)
    const artifact = ArtifactSchemaRegistry[artifactType].parse(candidate) as ArtifactDocument
    artifacts.push(artifact)
    artifactPaths[artifactId] = draft.relativePath
  }
  assertAuthorityFacts(artifacts, input.authority)

  const attemptAudit = auditPersistedAttemptFacts(artifacts, input.attemptProofVerifier)

  const verdictInput = deriveVerdictInputFromArtifacts({
    artifacts, assetId: input.context.assetId, generationId: input.context.generationId,
    prdRevision: input.context.prdRevision, createdAt: input.context.createdAt,
    verifyDecisionReceipt: input.authority.verifyDecisionReceipt,
  })
  const verdictDependencies = createPersistedAttemptVerdictDependencies(
    attemptAudit, input.verdictDependencies?.verifyManualResult,
  )
  const terminal = computeVerdict(verdictInput, verdictDependencies)
  const finalReport = renderFinalReport(input, artifacts, verdictInput, terminal, attemptAudit.selected)
  artifacts.push(finalReport)
  artifactPaths[finalReport.artifactId] = 'run/final-report.json'

  const verdictInputPath = 'run/verdict-input.json'
  const filesBeforeManifest = artifacts.map((artifact) => artifactFile(artifactPaths[artifact.artifactId]!, artifact))
  const supportingFiles = createSupportingFiles(input.drafts)
  const verdictFile = jsonFile(verdictInputPath, verdictInput)
  const manifestRecords = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType as ArtifactType,
    relativePath: artifactPaths[artifact.artifactId]!,
    digest: artifact.contentDigest,
  }))
  const finalizationSnapshotDigest = computeFinalizationSnapshotDigest(manifestRecords)
  const registeredFiles: AuditableFile[] = [...filesBeforeManifest, ...supportingFiles, verdictFile].map(({ path, digest, byteLength }) => ({
    relativePath: path, digest, byteLength,
  }))
  const rootDigest = computeGenerationRootDigest({
    generationId: input.context.generationId,
    fencingToken: input.context.fencingToken,
    finalizationSnapshotDigest,
    artifacts: manifestRecords,
    files: registeredFiles,
    terminalVerdict: terminal.verdict,
  })
  const rootSignature = input.authority.signArtifactDigest(rootDigest)
  if (!input.authority.verifyArtifactSignature(rootSignature, rootDigest)) {
    throw new Error('E2E_COMPLETE_GENERATION_ROOT_SIGNATURE_INVALID')
  }
  const manifestDraft: CompleteArtifactDraft = {
    relativePath: 'generation-manifest.json', dependencies: [], graph: { defines: [], references: [] },
    content: {
      runtimeProvenance: input.provenance,
      generationId: input.context.generationId,
      fencingToken: input.context.fencingToken,
      finalizationSnapshotDigest,
      artifacts: manifestRecords,
      files: registeredFiles,
      rootDigest,
      terminalVerdict: terminal.verdict,
      authoritySignature: rootSignature,
    },
  }
  const manifestId = artifactIdFor('generation-manifest')
  const manifest = ArtifactSchemaRegistry['generation-manifest'].parse(
    createArtifact(input, 'generation-manifest', manifestId, manifestDraft),
  ) as ArtifactDocument
  artifacts.push(manifest)
  artifactPaths[manifestId] = manifestDraft.relativePath

  const files = [...filesBeforeManifest, ...supportingFiles, verdictFile, artifactFile(manifestDraft.relativePath, manifest)]
    .sort((left, right) => left.path.localeCompare(right.path))
  const validationInput: CompleteGenerationBuild['validationInput'] = {
    artifactPaths,
    runtimeProvenance: input.provenance,
    verdictInput,
    verdictInputPath,
    verdictDependencies: input.verdictDependencies?.verifyManualResult
      ? { verifyManualResult: input.verdictDependencies.verifyManualResult } : undefined,
    verifyAttemptEventProof: input.attemptProofVerifier,
    verifyAuthoritySignature: (artifact) => artifact.signatures.length === 1
      && input.authority.verifyArtifactSignature(artifact.signatures[0]!, artifact.contentDigest),
    verifyManifestRootSignature: (signature, digest) => input.authority.verifyArtifactSignature(signature, digest),
    verifySanitizerAttestation: input.sanitizerVerifier,
    verifyPrivacyReviewReceipt: input.privacyReviewVerifier,
    verifyGatewayAuditSignature: input.gatewayVerifier,
    verifyExecutionOutcomeReceipt: input.executionOutcomeVerifier,
    verifyApprovalFreshnessReceipt: input.authority.verifyApprovalFreshnessReceipt,
    verifyDecisionReceipt: input.authority.verifyDecisionReceipt,
    verifyRegressionDiscoveryAttestation: input.regressionDiscoveryVerifier,
  }
  const audit = validateGeneration({
    ...validationInput,
    artifactCandidates: artifacts,
    actualFiles: files.map((file) => ({
      relativePath: file.path, digest: file.digest, byteLength: file.byteLength,
      sanitizerOutputDigest: digestBytes('sanitizer-output/v1', file.bytes),
      bytes: file.bytes,
    })),
  })
  if (!audit.valid) {
    throw new Error(`E2E_COMPLETE_GENERATION_INVALID:${audit.findings.map((finding) => `${finding.code}:${finding.ref}`).join('|')}`)
  }
  return { files, terminalVerdict: terminal.verdict, artifacts, artifactPaths,
    verdictInput, verdictInputPath, validationInput }
}

function snapshotCompleteGenerationInput(candidate: unknown): BuildCompleteGenerationInput {
  assertPlainDataTree(candidate, '$')
  const source = candidate as BuildCompleteGenerationInput
  assertExactKeys(source as unknown as Record<string, unknown>, [
    'context', 'provenance', 'drafts', 'reportPresentation', 'authority',
    'gatewayVerifier', 'sanitizerVerifier', 'privacyReviewVerifier', 'regressionDiscoveryVerifier', 'verdictDependencies',
    'attemptProofVerifier', 'executionOutcomeVerifier',
  ], 'E2E_COMPLETE_GENERATION_INPUT_KEYS_INVALID')
  const signArtifactDigest = source.authority.signArtifactDigest.bind(source.authority)
  const verifyArtifactSignature = source.authority.verifyArtifactSignature.bind(source.authority)
  const verifyApprovalFreshnessReceipt = source.authority.verifyApprovalFreshnessReceipt.bind(source.authority)
  const verifyDecisionReceipt = source.authority.verifyDecisionReceipt.bind(source.authority)
  const gatewayVerifier = source.gatewayVerifier.bind(undefined)
  const sanitizerVerifier = source.sanitizerVerifier.bind(undefined)
  const privacyReviewVerifier = source.privacyReviewVerifier.bind(undefined)
  const regressionDiscoveryVerifier = source.regressionDiscoveryVerifier.bind(undefined)
  const attemptProofVerifier = source.attemptProofVerifier.bind(undefined)
  const executionOutcomeVerifier = source.executionOutcomeVerifier?.bind(undefined)
  const verifyManualResult = source.verdictDependencies?.verifyManualResult?.bind(source.verdictDependencies)
  let cloned: {
    context: CompleteGenerationContext
    provenance: RuntimeProvenance
    drafts: BuildCompleteGenerationInput['drafts']
    reportPresentation: ReportPresentation
  }
  try {
    cloned = structuredClone({
      context: source.context,
      provenance: source.provenance,
      drafts: source.drafts,
      reportPresentation: source.reportPresentation,
    })
    cloned = JSON.parse(canonicalizeJson(cloned)) as typeof cloned
  } catch (cause) {
    throw new Error('E2E_COMPLETE_GENERATION_UNSAFE_INPUT:SNAPSHOT_FAILED', { cause })
  }
  return {
    ...cloned,
    provenance: RuntimeProvenanceSchema.parse(cloned.provenance),
    authority: { signArtifactDigest, verifyArtifactSignature, verifyApprovalFreshnessReceipt, verifyDecisionReceipt },
    gatewayVerifier,
    sanitizerVerifier,
    privacyReviewVerifier,
    regressionDiscoveryVerifier,
    attemptProofVerifier,
    ...(executionOutcomeVerifier ? { executionOutcomeVerifier } : {}),
    ...(source.verdictDependencies === undefined ? {} : {
      verdictDependencies: {
        ...(verifyManualResult === undefined ? {} : { verifyManualResult }),
      },
    }),
  }
}

function assertPlainDataTree(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return
  if (typeof value === 'function') {
    if (utilTypes.isProxy(value)) throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:PROXY_CALLBACK:${path}`)
    if (!isAllowedCallbackPath(path)) throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:FUNCTION:${path}`)
    return
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:TYPE:${path}`)
  }
  if (ancestors.has(value)) throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:CYCLE:${path}`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== Array.prototype) {
    throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:PROTOTYPE:${path}`)
  }
  ancestors.add(value)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:SYMBOL:${path}`)
      if (Array.isArray(value) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`E2E_COMPLETE_GENERATION_UNSAFE_INPUT:DESCRIPTOR:${path}.${key}`)
      }
      assertPlainDataTree(descriptor.value, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function isAllowedCallbackPath(path: string): boolean {
  return path === '$.authority.signArtifactDigest'
    || path === '$.authority.verifyArtifactSignature'
    || path === '$.authority.verifyApprovalFreshnessReceipt'
    || path === '$.authority.verifyDecisionReceipt'
    || path === '$.gatewayVerifier'
    || path === '$.sanitizerVerifier'
    || path === '$.privacyReviewVerifier'
    || path === '$.regressionDiscoveryVerifier'
    || path === '$.attemptProofVerifier'
    || path === '$.executionOutcomeVerifier'
    || path === '$.verdictDependencies.verifyManualResult'
}

function createArtifact(
  input: BuildCompleteGenerationInput,
  artifactType: ArtifactType,
  artifactId: string,
  draft: CompleteArtifactDraft,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    artifactId, artifactType,
    schemaVersion: artifactType === 'final-report' ? '3.0.0'
      : artifactType === 'generation-manifest' ? '2.0.0'
      : artifactType === 'execution-contract' ? '1.1.0'
      : artifactType === 'browser-action-map' ? '2.1.0'
      : artifactType === 'prd-request' ? '2.0.0'
      : ['cleanup-results', 'approval-grants', 'browser-preflight',
      'run-bundle', 'project-policy', 'browser-evidence',
      'acceptance-scope', 'prd-diff', 'regression-manifest', 'workflow-events', 'browser-results'].includes(artifactType) ? '2.0.0' : '1.0.0',
    engineVersion: input.context.engineVersion, assetId: input.context.assetId,
    prdRevision: input.context.prdRevision, generationId: input.context.generationId,
    createdAt: input.context.createdAt, contentDigest: '', signatures: [],
    dependencies: draft.dependencies, graph: draft.graph, content: draft.content,
  }
  const contentDigest = digestArtifactContent(
    `artifact-content/${base.schemaVersion}/${artifactType}`, base,
  )
  // 先验证无签名候选，避免把 Authority 变成畸形或越界事实的签名 Oracle。
  parseArtifactDocument({ ...base, contentDigest, signatures: [] })
  const signatures = AUTHORITY_TYPES.has(artifactType)
    ? [input.authority.signArtifactDigest(contentDigest)] : []
  if (signatures.some((signature) => !input.authority.verifyArtifactSignature(signature, contentDigest))) {
    throw new Error(`E2E_COMPLETE_GENERATION_AUTHORITY_SIGNATURE_INVALID:${artifactType}`)
  }
  return { ...base, contentDigest, signatures }
}

function renderFinalReport(
  input: BuildCompleteGenerationInput,
  artifacts: ArtifactDocument[],
  verdictInput: VerdictInput,
  terminal: ReturnType<typeof computeVerdict>,
  attemptSelections: PersistedAttemptProjection[],
): ArtifactDocument {
  const byType = new Map(artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const artifact = <T extends ArtifactType>(type: T): ArtifactOf<T> => byType.get(type) as ArtifactOf<T>
  const content = <T extends ArtifactType>(type: T): ArtifactOf<T>['content'] =>
    artifact(type).content as unknown as ArtifactOf<T>['content']
  const cases = content('test-cases').cases
  const browserResults = [...content('browser-results').caseResults]
    .sort((left, right) => left.resultId!.localeCompare(right.resultId!))
  const results = new Map(browserResults.map((result) => [result.resultId!, result]))
  const realResultsByCase = new Map(browserResults
    .filter((result) => result.mode === 'real-environment')
    .map((result) => [result.caseId, result]))
  const evidence = new Map(content('browser-evidence').artifacts
    .map((item) => [item.evidenceId, item]))
  const reportCases = cases.filter((item) => item.status === 'active').flatMap((testCase) => {
    const domainResults = browserResults.filter((result) => result.caseId === testCase.caseId)
    const projected = domainResults.length > 0 ? domainResults : [undefined]
    return projected.map((result) => ({
      resultId: result?.resultId ?? deriveExecutionResultId(testCase.caseId, 'real-environment'),
      ...(result?.baselineResultId ? { baselineResultId: result.baselineResultId } : {}),
      caseId: testCase.caseId, title: testCase.title,
      executionMode: result?.mode === 'gateway-injection'
        ? 'browser-injection' as const : 'real-environment' as const,
      necessity: testCase.necessity, status: result?.status ?? 'not-executed',
      preconditions: testCase.preconditions,
      steps: testCase.steps.map((step) => {
        const stepResult = result?.stepResults.find((item) => item.stepId === step.stepId)
        const evidenceLinks = (stepResult?.evidenceIds ?? []).map((id: string) => evidence.get(id)?.relativePath)
          .filter((path: unknown): path is string => typeof path === 'string')
        return {
          stepId: step.stepId, action: step.semanticAction,
          expected: step.oracles.map((oracle) => oracle.statement).join('；'),
          actual: stepResult?.oracleCheckpoints?.map((checkpoint) =>
            `${checkpoint.oracleId}: ${checkpoint.actualJson}`).join('；')
            || stepResult?.actualDigest || '未产生终态执行事实',
          oracle: stepResult?.oracleResult ?? 'not-evaluated', status: stepResult?.status ?? 'not-executed',
          evidenceLinks,
          ...(stepResult?.oracleCheckpoints === undefined ? {} : {
            oracleCheckpoints: stepResult.oracleCheckpoints,
            assertionResults: stepResult.oracleCheckpoints.map(projectAssertionResultV1),
          }),
        }
      }),
    }))
  })
  const realResults = reportCases.filter((item) => item.executionMode === 'real-environment')
    .filter((item) => results.has(item.resultId))
    .map((item) => ({ id: item.resultId, digest: results.get(item.resultId)!.eventChainDigest }))
  const injectionResults = reportCases.filter((item) => item.executionMode === 'browser-injection')
    .filter((item) => results.has(item.resultId))
    .map((item) => ({ id: item.resultId, digest: results.get(item.resultId)!.eventChainDigest }))
  const regressionDigest = byType.get('regression-manifest')!.contentDigest
  const grantContent = content('approval-grants')
  const approvalAssurance = grantContent.approvalAssurance
  const scopeContent = content('acceptance-scope')
  const diffContent = content('prd-diff')
  const gateway = content('gateway-audit')
  const reportGateway = projectReportGatewayAudit(gateway)
  const policyDecisions = projectReportPolicyDecisions(grantContent.grants, gateway)
  const semanticAudit = auditSemanticCompleteness({
    manifest: content('prd-manifest'), scope: content('acceptance-scope'),
    model: content('requirement-model'), flows: content('interaction-flow'),
    coverage: content('coverage-universe'), cases: content('test-cases'),
  })
  const clausesById = new Map(content('prd-manifest').clauses.map((clause) => [clause.clauseId, clause]))
  const semanticTraceability: FinalReportContent['semanticTraceability'] = semanticAudit.traceability.map((row) => {
    const clause = clausesById.get(row.clauseId)
    if (!clause) throw new Error(`E2E_COMPLETE_GENERATION_REPORT_CLAUSE_MISSING:${row.clauseId}`)
    return {
      ...row,
      sourceId: clause.sourceId,
      sourceSpan: clause.sourceSpan,
      originalText: clause.originalText,
    }
  })
  const executionApprovalStatus = grantContent.grants.some((grant) => grant.status === 'revoked')
    ? 'revoked' as const : grantContent.grants.some((grant) => grant.status === 'expired')
      ? 'expired' as const : grantContent.grants.some((grant) => grant.status === 'denied')
        ? 'rejected' as const : 'approved' as const
  const cleanupByLease = new Map(content('cleanup-results').leaseResults.map((item) => [item.leaseId, item.status]))
  const traceabilityMatrix: FinalReportContent['traceabilityMatrix'] = []
  const traceabilityEdges = new Map<string, FinalReportContent['traceability'][number]>()
  const requirements = new Map(content('requirement-model').requirements
    .filter((requirement) => requirement.status === 'active')
    .map((requirement) => [requirement.reqId, requirement]))
  const casesById = new Map(cases.filter((testCase) => testCase.status === 'active')
    .map((testCase) => [testCase.caseId, testCase]))
  const addEdge = (fromId: string, toId: string, kind: string): void => {
    traceabilityEdges.set(`${kind}\0${fromId}\0${toId}`, { fromId, toId, kind })
  }
  for (const obligation of content('coverage-universe').obligations) {
    if (obligation.disposition.kind !== 'automated' || !requirements.has(obligation.reqId)) continue
    for (const ruleId of obligation.ruleIds) {
      addEdge(obligation.reqId, ruleId, 'defines')
      addEdge(ruleId, obligation.obligationId, 'covered-by')
      for (const caseId of obligation.disposition.caseIds) {
        const testCase = casesById.get(caseId)
        if (!testCase) continue
        addEdge(obligation.obligationId, caseId, 'implemented-by')
        const result = realResultsByCase.get(caseId)
        for (const step of testCase.steps) {
          addEdge(caseId, step.stepId, 'executes')
          const stepResult = result?.stepResults.find((item) => item.stepId === step.stepId)
          if (!stepResult) continue
          if (['passed', 'failed'].includes(stepResult.status) && stepResult.evidenceIds.length === 0) {
            throw new Error(`E2E_COMPLETE_GENERATION_TRACEABILITY_EVIDENCE_MISSING:${caseId}:${step.stepId}`)
          }
          for (const evidenceId of stepResult.evidenceIds) {
            const item = evidence.get(evidenceId)
            if (!item || item.caseId !== caseId) {
              throw new Error(`E2E_COMPLETE_GENERATION_TRACEABILITY_EVIDENCE_INVALID:${caseId}:${step.stepId}:${evidenceId}`)
            }
            addEdge(step.stepId, evidenceId, 'evidenced-by')
            traceabilityMatrix.push({
              reqId: obligation.reqId, ruleId, obligationId: obligation.obligationId,
              caseId, stepId: step.stepId, evidenceId, evidencePath: item.relativePath,
            })
          }
        }
      }
    }
  }
  const edgeOrder = new Map([
    ['defines', 0], ['covered-by', 1], ['implemented-by', 2], ['executes', 3], ['evidenced-by', 4],
  ])
  const traceability = [...traceabilityEdges.values()].sort((left, right) =>
    (edgeOrder.get(left.kind) ?? 99) - (edgeOrder.get(right.kind) ?? 99)
      || left.fromId.localeCompare(right.fromId) || left.toId.localeCompare(right.toId))
  traceabilityMatrix.sort((left, right) => [left.reqId, left.ruleId, left.obligationId, left.caseId,
    left.stepId, left.evidenceId, left.evidencePath].join('\0').localeCompare(
    [right.reqId, right.ruleId, right.obligationId, right.caseId,
      right.stepId, right.evidenceId, right.evidencePath].join('\0')))
  const dispositions = projectReportDispositions({
    scope: scopeContent,
    coverage: content('coverage-universe'),
    cases,
    regression: content('regression-manifest'),
    results: content('browser-results'),
    manualResults: content('manual-results'),
    execution: content('execution-contract'),
  })
  const browserCannotClaim = deriveBrowserCannotClaim({
    approved: content('project-policy').browserMatrix,
    planned: content('execution-contract').browserMatrix,
    executed: content('browser-results').executedBrowserIds,
  })
  const regressionAttestation = content('regression-manifest').listResult.attestation
  const trustedCompilerExecution = content('browser-results').trustedCompilerExecution
  if (!trustedCompilerExecution) throw new Error('E2E_TRUSTED_COMPILER_EXECUTION_FACT_REQUIRED')
  const report: FinalReportContent = {
    runtimeProvenance: input.provenance,
    approvalAssurance,
    ...terminal,
    cannotClaim: [...new Set([
      ...terminal.cannotClaim,
      ...browserCannotClaim,
      ...deriveRuntimeProvenanceCannotClaim(input.provenance),
    ])].sort(),
    verdictInputDigest: digestText('verdict-input/v2', canonicalizeJson(verdictInput)),
    scope: scopeContent.includedReqCandidates.map((item) => ({ id: item.reqId, digest: artifact('acceptance-scope').contentDigest })),
    traceability, semanticTraceability, realResults, injectionResults,
    manualResults: content('manual-results').results.map((item) => ({
      id: item.manualResultId, digest: item.authorityProof.signedDigest,
      ...item.authorityProof.approvalAssurance,
    })),
    risks: content('design-audit').findings,
    regression: { manifestDigest: regressionDigest, command: input.reportPresentation.regressionCommand },
    title: input.reportPresentation.title,
    summaries: {
      prdId: content('prd-manifest').prdId, prdTitle: content('prd-request').title,
      scopeDigest: artifact('acceptance-scope').contentDigest,
      executionContractDigest: artifact('execution-contract').contentDigest,
      approvalGrantDigests: grantContent.grants.map((grant) => grant.authorityProof.signedDigest),
      generationDigest: digestText('generation-facts/v1', canonicalizeJson(artifacts.map((artifact) => artifact.contentDigest))),
    },
    approvals: [
      { kind: 'scope', status: scopeContent.scopeDecision.status,
        ...approvalAssurance,
        subjectDigest: digestDecisionSubject(projectScopeDecisionSubject(scopeContent)),
        grantDigests: scopeContent.scopeDecision.status === 'pending'
          ? [] : [scopeContent.scopeDecision.receipt.signedDigest] },
      { kind: 'lineage', status: diffContent.lineageReview.status,
        ...approvalAssurance,
        subjectDigest: digestDecisionSubject(projectLineageDecisionSubject(diffContent)),
        grantDigests: diffContent.lineageReview.status === 'pending'
          ? [] : [diffContent.lineageReview.receipt.signedDigest] },
      { kind: 'execution', status: executionApprovalStatus, subjectDigest: grantContent.runBundleDigest,
        ...approvalAssurance,
        grantDigests: grantContent.grants.map((grant) => grant.authorityProof.signedDigest) },
    ],
    policyDecisions,
    environment: {
      environmentId: content('execution-contract').environment,
      origins: [content('execution-contract').baseOrigin],
      browser: { name: 'chromium', ...input.reportPresentation.browser },
      roles: content('execution-contract').identities.flatMap((identity) =>
        identity.roleIds.map((roleId: string) => ({ roleId, status: 'configured' }))),
      dataLeases: content('data-leases').leases.map((lease) => ({
        leaseId: lease.leaseId, status: lease.status, resourceFingerprint: lease.resourceDigest,
      })),
    },
    dispositions,
    coverageUniverse: {
      universeDigest: content('coverage-universe').universeDigest,
      obligations: content('coverage-universe').obligations.map((obligation) => ({
        obligationId: obligation.obligationId, title: obligation.scenario,
        necessity: obligation.necessity, disposition: obligation.disposition.kind,
        caseIds: obligation.disposition.kind === 'automated' ? obligation.disposition.caseIds : [],
      })),
    },
    traceabilityMatrix, caseDetails: reportCases,
    injectionBoundary: input.reportPresentation.injectionBoundary,
    gatewayAudit: {
      status: verdictInput.gatewayAudit.status,
      digest: reportGateway.digest,
      forwarded: reportGateway.forwarded, blocked: reportGateway.blocked,
      injected: reportGateway.injected, findings: [],
    },
    browserHealth: content('browser-preflight').checks.filter((check) => check.status === 'failed')
      .map((check) => ({ code: check.code, severity: 'high' as const, ref: check.digest })),
    diagnostics: attemptSelections.map((selection) => {
      const diagnosis = content('diagnosis').caseDiagnoses.find((item) => item.caseId === selection.caseId)
      return { resultId: selection.resultId, caseId: selection.caseId, category: diagnosis?.category ?? 'not-required',
      selectedAttemptId: selection.attemptId,
      rationale: diagnosis?.digest ?? selection.eventChainDigest,
      attempts: selection.attempts.map((attempt) => ({
        attemptId: attempt.attemptId, slot: attempt.slot, status: attempt.status, mode: attempt.mode,
        effect: attempt.effect,
        eventChainDigest: attempt.eventChainDigest, changeDigest: null,
        sideEffectState: attempt.effectObservation,
        reservationSafeToVoid: attempt.reservationSafeToVoid,
      })),
    }}),
    sideEffects: content('browser-action-map').actions.map((action) => {
      const caseResult = realResultsByCase.get(action.caseId)
      const stepResult = caseResult?.stepResults.find((step) => step.actionId === action.actionId)
      return {
        actionId: action.actionId, effect: action.effect, status: stepResult?.status ?? 'not-executed',
        verification: stepResult?.actualDigest ?? `oracle:${stepResult?.oracleResult ?? 'not-evaluated'}`,
        cleanupStatus: action.effect === 'read' ? 'not-applicable'
          : cleanupByLease.get(caseResult?.cleanupRef ?? '') ?? 'cleanup-missing',
        digest: digestText('action/v1', canonicalizeJson({ action, stepResult: stepResult ?? null })),
      }
    }),
    regressionDetails: {
      testDomain: content('regression-manifest').testDomain,
      executionProfile: content('regression-manifest').executionProfile,
      generationId: input.context.generationId, manifestDigest: regressionDigest,
      command: input.reportPresentation.regressionCommand,
      caseIds: [...new Set(reportCases.map((item) => item.caseId))],
      trustedCompiler: {
        compilerInputDigest: regressionAttestation.compilerInputDigest,
        compilerVersion: regressionAttestation.compilerVersion,
        compilerDigest: regressionAttestation.toolchain.compilerDigest,
        templateVersion: regressionAttestation.templateVersion,
        templateDigest: regressionAttestation.templateDigest,
        sourceSetDigest: regressionAttestation.sourceSetDigest,
        discoverySignedDigest: regressionAttestation.signedDigest,
        nodeVersion: regressionAttestation.toolchain.nodeVersion,
        playwrightVersion: regressionAttestation.toolchain.playwrightVersion,
        playwrightCliDigest: regressionAttestation.toolchain.playwrightCliDigest,
        executionDigest: digestText('trusted-compiler-execution-fact/v1', canonicalizeJson(trustedCompilerExecution)),
      },
    },
    recommendations: input.reportPresentation.recommendations,
  }
  const draft: CompleteArtifactDraft = {
    content: report, graph: { defines: [], references: [] }, dependencies: [], relativePath: 'run/final-report.json',
  }
  return ArtifactSchemaRegistry['final-report'].parse(
    createArtifact(input, 'final-report', artifactIdFor('final-report'), draft),
  ) as ArtifactDocument
}

function projectReportPolicyDecisions(
  grants: unknown[],
  gateway: Record<string, any>,
): PolicyDecisionViewV1[] {
  const approvals = grants.flatMap(projectApprovalPolicyDecisionViews)
  const sessions = Array.isArray(gateway.sessions) ? gateway.sessions as Array<Record<string, any>> : []
  const gatewayViews = sessions.length === 0
    ? projectGatewayPolicyDecisionViews(gateway)
    : sessions.flatMap((session) => projectGatewayPolicyDecisionViews(session.audit, {
      executionResultId: session.resultId,
      executionDomain: session.domain,
    }))
  return [...approvals, ...gatewayViews].sort((left, right) => left.decisionId.localeCompare(right.decisionId))
}

function projectReportGatewayAudit(gateway: Record<string, any>): {
  digest: string; forwarded: number; blocked: number; injected: number
} {
  const sessions = Array.isArray(gateway.sessions) ? gateway.sessions as Array<Record<string, any>> : []
  if (sessions.length === 0) return {
    digest: gateway.signedCounters.digest,
    forwarded: gateway.signedCounters.forwarded,
    blocked: gateway.signedCounters.blocked,
    injected: gateway.signedCounters.injected,
  }
  const projection = sessions.map((session) => ({
    resultId: session.resultId, domain: session.domain,
    digest: session.audit.signedCounters.digest,
    forwarded: session.audit.signedCounters.forwarded,
    blocked: session.audit.signedCounters.blocked,
    injected: session.audit.signedCounters.injected,
  })).sort((left, right) => left.resultId.localeCompare(right.resultId))
  return {
    digest: digestText('gateway-audit-sessions/v1', canonicalizeJson(projection)),
    forwarded: projection.reduce((sum, item) => sum + item.forwarded, 0),
    blocked: projection.reduce((sum, item) => sum + item.blocked, 0),
    injected: projection.reduce((sum, item) => sum + item.injected, 0),
  }
}

interface ReportDispositionSources {
  scope: ArtifactOf<'acceptance-scope'>['content']
  coverage: ArtifactOf<'coverage-universe'>['content']
  cases: ArtifactOf<'test-cases'>['content']['cases']
  regression: ArtifactOf<'regression-manifest'>['content']
  results: ArtifactOf<'browser-results'>['content']
  manualResults: ArtifactOf<'manual-results'>['content']
  execution: ArtifactOf<'execution-contract'>['content']
}

/** 固定优先级为 scope→coverage→regression blocked→deprecated→declined→manual result→unresolved。 */
function projectReportDispositions(sources: ReportDispositionSources): FinalReportContent['dispositions'] {
  const projected: FinalReportContent['dispositions'] = []
  const seen = new Set<string>()
  const add = (item: FinalReportContent['dispositions'][number]): void => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    projected.push(item)
  }
  const caseTitle = new Map(sources.cases.map((testCase) => [testCase.caseId, testCase.title]))
  for (const item of sources.scope.exclusions) add({
    kind: 'excluded', id: item.reqId, title: item.reqId, status: 'excluded',
    reason: item.rationale, refs: [item.decisionId],
  })
  for (const obligation of sources.coverage.obligations) {
    if (obligation.disposition.kind === 'manual') add({
      kind: 'manual', id: obligation.obligationId, title: obligation.scenario, status: 'manual-required',
      reason: 'coverage-disposition:manual', refs: [obligation.disposition.manualProcedureId],
    })
    if (obligation.disposition.kind === 'not-applicable') add({
      kind: 'not-applicable', id: obligation.obligationId, title: obligation.scenario, status: 'not-applicable',
      reason: obligation.disposition.rationale,
      refs: [obligation.disposition.policyCode, obligation.disposition.decisionGrantId],
    })
  }
  for (const item of sources.regression.blockedCases) add({
    kind: 'blocked', id: item.caseId, title: caseTitle.get(item.caseId) ?? item.caseId, status: 'blocked',
    reason: item.reasonCode, refs: [],
  })
  for (const caseId of sources.regression.deprecatedCases) add({
    kind: 'excluded', id: caseId, title: caseTitle.get(caseId) ?? caseId, status: 'deprecated',
    reason: 'deprecated', refs: [],
  })
  for (const result of sources.results.caseResults) {
    if (result.status === 'not-executed-user-declined') add({
      kind: 'declined', id: result.caseId, title: caseTitle.get(result.caseId) ?? result.caseId,
      status: result.status, reason: 'user-declined', refs: [result.attemptId],
    })
    if (['input-blocked', 'environment-blocked', 'safety-blocked', 'automation-blocked',
      'pending-decision'].includes(result.status)) add({
      kind: 'blocked', id: result.caseId, title: caseTitle.get(result.caseId) ?? result.caseId,
      status: result.status, reason: result.status, refs: [result.attemptId],
    })
    if (result.status === 'manual-required') add({
      kind: 'manual', id: result.caseId, title: caseTitle.get(result.caseId) ?? result.caseId,
      status: result.status, reason: result.status, refs: [result.attemptId],
    })
  }
  for (const result of sources.manualResults.results) add({
    kind: 'manual', id: result.manualResultId, title: result.manualProcedureId, status: result.outcome,
    reason: 'manual-result', refs: [...result.obligationIds].sort(),
  })
  for (const item of sources.execution.unresolvedItems.filter((item) => item.blocking)) add({
    kind: 'blocked', id: item.itemId, title: item.itemId, status: 'blocked', reason: item.kind, refs: [],
  })
  return projected.sort((left, right) => left.id.localeCompare(right.id)
    || left.kind.localeCompare(right.kind))
}

function assertContext(context: CompleteGenerationContext): void {
  if (!Number.isSafeInteger(context.fencingToken) || context.fencingToken <= 0) {
    throw new Error('E2E_COMPLETE_GENERATION_FENCING_TOKEN_INVALID')
  }
}

function assertExactDraftTypes(drafts: Record<string, unknown>): void {
  const keys = Object.keys(drafts).sort()
  const expected = [...FACT_TYPES].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('E2E_COMPLETE_GENERATION_DRAFT_SET_INVALID')
  }
}

function assertExactKeys(candidate: Record<string, unknown>, allowed: string[], code: string): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(candidate).some((key) => !allowedSet.has(key))) throw new Error(code)
}

function assertAuthorityFacts(artifacts: ArtifactDocument[], authority: CompleteGenerationAuthority): void {
  for (const artifact of artifacts.filter((item) => AUTHORITY_TYPES.has(item.artifactType as ArtifactType))) {
    if (artifact.signatures.length !== 1
      || !authority.verifyArtifactSignature(artifact.signatures[0]!, artifact.contentDigest)) {
      throw new Error(`E2E_COMPLETE_GENERATION_AUTHORITY_SIGNATURE_INVALID:${artifact.artifactType}`)
    }
  }
  const decisionAudit = auditDecisionReceipts(artifacts, authority.verifyDecisionReceipt)
  if (!decisionAudit.valid) {
    throw new Error(`E2E_COMPLETE_GENERATION_DECISION_INVALID:${decisionAudit.findings
      .map((finding) => `${finding.code}:${finding.artifactId}:${finding.ref}`).join('|')}`)
  }
}

function artifactIdFor(type: ArtifactType): string {
  return `ARTIFACT-${type.toUpperCase()}`
}

function artifactFile(path: string, artifact: ArtifactDocument): CompleteGenerationFile {
  return jsonFile(path, artifact)
}

function createSupportingFiles(drafts: BuildCompleteGenerationInput['drafts']): CompleteGenerationFile[] {
  const files: CompleteGenerationFile[] = []
  const paths = new Set<string>()
  for (const type of FACT_TYPES) {
    for (const source of drafts[type].files ?? []) {
      const bytes = Buffer.from(source.base64, 'base64')
      if (bytes.toString('base64') !== source.base64 || paths.has(source.relativePath)) {
        throw new Error(`E2E_COMPLETE_GENERATION_SUPPORTING_FILE_INVALID:${source.relativePath}`)
      }
      paths.add(source.relativePath)
      files.push({
        path: source.relativePath, bytes,
        digest: digestBytes(`generation-file:${source.relativePath}`, bytes), byteLength: bytes.byteLength,
      })
    }
  }
  return files
}

function jsonFile(path: string, value: unknown): CompleteGenerationFile {
  const text = canonicalizeJson(value)
  const bytes = Buffer.from(text, 'utf8')
  return { path, bytes, digest: digestBytes(`generation-file:${path}`, bytes), byteLength: bytes.byteLength }
}
