import {
  ARTIFACT_TYPES,
  canonicalizeJson,
  digestBytes,
  digestArtifactContent,
  digestApprovalProjection,
  digestText,
  parseArtifactDocument,
  RelativePathSchema,
  type ArtifactDocument,
  type ArtifactType,
  type ApprovalCapabilityRecord,
  type ApprovalFreshnessReceipt,
  type ApprovalFreshnessVerification,
  type PrivacyReviewReceipt,
  type PrivacyReviewReceiptBinding,
  type SanitizerAttestation,
  type SanitizerAttestationBinding,
  type ReadApprovalSubject,
  type WriteApprovalSubject,
  type DecisionReceipt,
  type DecisionReceiptVerificationBinding,
  digestDecisionSubject,
  projectLineageDecisionSubject,
  projectScopeDecisionSubject,
  projectCoverageDispositionDecisionSubject,
  RegressionDiscoveryAttestationSchema,
  RegressionDiscoverySubjectSchema,
  findForbiddenRegressionTestDispositions,
  type RegressionDiscoveryAttestation,
  type RegressionDiscoverySubject,
  type VerdictInput,
  type VerdictResult,
  type AttemptEventAuthorityProof,
  type ExecutionOutcomeReceipt,
  VerdictInputSchema,
  E2EError,
  digestCleanupPlanDefinition,
  digestRuntimeIsolationPolicy,
  type CleanupPlanDefinition,
  RuntimeProvenanceSchema,
  type RuntimeProvenance,
} from '@mutil-skills/e2e-contracts'
import { computeVerdict, type VerdictDependencies } from './verdict.js'
import { auditSemanticCompleteness } from './semantic-completeness.js'
import { auditPersistedAttemptFacts, createPersistedAttemptVerdictDependencies } from './persisted-attempt-audit.js'
import { auditBrowserExecutionBinding, deriveBrowserCannotClaim } from './browser-claims.js'
import { deriveRuntimeProvenanceCannotClaim } from './runtime-provenance-claims.js'
import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export interface AuditableArtifactDependency {
  artifactId: string
  artifactType: string
  schemaVersion: string
  relativePath: string
  digest: string
}

export interface AuditableGraphNode { kind: string; id: string }

export interface AuditableArtifact {
  artifactId: string
  artifactType: string
  schemaVersion: string
  engineVersion: string
  assetId: string
  prdRevision: string
  generationId: string
  contentDigest: string
  dependencies: AuditableArtifactDependency[]
  graph: { defines: AuditableGraphNode[]; references: AuditableGraphNode[] }
}

export interface GenerationAuditFinding {
  code: string
  artifactId: string
  refs: string[]
}

export interface GenerationAuditResult {
  valid: boolean
  findings: GenerationAuditFinding[]
}

/** 审计已通过单体 Schema 校验的 Artifact 引用图。 */
export function auditArtifactGraph(
  artifacts: AuditableArtifact[],
  artifactPaths: ReadonlyMap<string, string>,
): GenerationAuditResult {
  const findings: GenerationAuditFinding[] = []
  const artifactById = new Map<string, AuditableArtifact>()
  const definitions = new Map<string, string>()
  const baseline = artifacts[0]

  for (const artifact of artifacts) {
    const existingArtifact = artifactById.get(artifact.artifactId)
    if (existingArtifact) add('E2E_GENERATION_DUPLICATE_ARTIFACT', artifact, [existingArtifact.artifactId])
    else artifactById.set(artifact.artifactId, artifact)

    if (baseline && (
      artifact.assetId !== baseline.assetId
      || artifact.prdRevision !== baseline.prdRevision
      || artifact.generationId !== baseline.generationId
      || artifact.engineVersion !== baseline.engineVersion
    )) add('E2E_GENERATION_CROSS_GENERATION', artifact, [baseline.artifactId])

    for (const definition of artifact.graph.defines) {
      const key = graphKey(definition)
      const owner = definitions.get(key)
      if (owner) add('E2E_GENERATION_DUPLICATE_ID', artifact, [key, owner])
      else definitions.set(key, artifact.artifactId)
    }
  }

  for (const artifact of artifacts) {
    for (const reference of artifact.graph.references) {
      const key = graphKey(reference)
      if (!definitions.has(key)) add('E2E_GENERATION_REFERENCE_BROKEN', artifact, [key])
    }
    for (const dependency of artifact.dependencies) {
      const target = artifactById.get(dependency.artifactId)
      if (!target) {
        add('E2E_GENERATION_DEPENDENCY_BROKEN', artifact, [dependency.artifactId])
        continue
      }
      if (target.artifactType !== dependency.artifactType || target.schemaVersion !== dependency.schemaVersion) {
        add('E2E_GENERATION_DEPENDENCY_SCHEMA_MISMATCH', artifact, [dependency.artifactId])
      }
      if (target.contentDigest !== dependency.digest) {
        add('E2E_GENERATION_DEPENDENCY_DIGEST_MISMATCH', artifact, [dependency.artifactId])
      }
      if (artifactPaths.get(dependency.artifactId) !== dependency.relativePath) {
        add('E2E_GENERATION_DEPENDENCY_PATH_MISMATCH', artifact, [dependency.artifactId])
      }
    }
  }

  findings.sort((left, right) =>
    left.code.localeCompare(right.code)
    || left.artifactId.localeCompare(right.artifactId)
    || left.refs.join('\0').localeCompare(right.refs.join('\0')))
  return { valid: findings.length === 0, findings }

  function add(code: string, artifact: AuditableArtifact, refs: string[]): void {
    findings.push({ code, artifactId: artifact.artifactId, refs })
  }
}

function graphKey(node: AuditableGraphNode): string {
  return `${node.kind}:${node.id}`
}

export interface AuditableFile {
  relativePath: string
  digest: string
  byteLength: number
  /** 同一实际 bytes 在 sanitizer-output/v1 域的独立摘要；不得由 Artifact 声明代填。 */
  sanitizerOutputDigest?: string
  /** 发布候选中的实际 bytes；browser-evidence 必须提供，审计器据此重建双域摘要。 */
  bytes?: Uint8Array
}

export interface GenerationFileFinding { code: string; relativePath: string }

export function auditGenerationFiles(
  registeredFiles: AuditableFile[],
  actualFiles: AuditableFile[],
): { valid: boolean; findings: GenerationFileFinding[] } {
  const findings: GenerationFileFinding[] = []
  const registered = indexFiles(registeredFiles, true)
  const actual = indexFiles(actualFiles, false)

  for (const [path, expected] of registered) {
    const observed = actual.get(path)
    if (!observed) {
      add('E2E_GENERATION_FILE_MISSING', path)
      continue
    }
    if (observed.digest !== expected.digest) add('E2E_GENERATION_FILE_DIGEST_MISMATCH', path)
    if (observed.byteLength !== expected.byteLength) add('E2E_GENERATION_FILE_SIZE_MISMATCH', path)
  }
  for (const path of actual.keys()) {
    if (!registered.has(path) && !isPublicationExempt(path)) add('E2E_GENERATION_FILE_UNREGISTERED', path)
  }
  findings.sort((left, right) => left.code.localeCompare(right.code) || left.relativePath.localeCompare(right.relativePath))
  return { valid: findings.length === 0, findings }

  function indexFiles(files: AuditableFile[], fromManifest: boolean): Map<string, AuditableFile> {
    const indexed = new Map<string, AuditableFile>()
    for (const file of files) {
      if (!isSafeRelativePath(file.relativePath)) add('E2E_GENERATION_FILE_PATH_INVALID', file.relativePath)
      if (indexed.has(file.relativePath)) add('E2E_GENERATION_FILE_DUPLICATE', file.relativePath)
      else indexed.set(file.relativePath, file)
      if (!fromManifest && (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0)) {
        add('E2E_GENERATION_FILE_SIZE_INVALID', file.relativePath)
      }
    }
    return indexed
  }

  function add(code: string, relativePath: string): void {
    findings.push({ code, relativePath })
  }
}

function isSafeRelativePath(path: string): boolean {
  return RelativePathSchema.safeParse(path).success
}

function isPublicationExempt(path: string): boolean {
  const root = path.split('/')[0]
  return root === 'journal.json' || root === 'lock' || root === 'quarantine' || root === 'generation-manifest.json'
}

export function auditFinalVerdict(
  input: VerdictInput,
  reported: VerdictResult,
  dependencies?: VerdictDependencies,
): { valid: boolean; findings: Array<{ code: string; path: string }> } {
  const expected = computeVerdict(input, dependencies)
  const paths = differingPaths(expected, reported)
  const findings = paths.map((path) => ({
    code: 'E2E_GENERATION_VERDICT_RECOMPUTE_MISMATCH',
    path,
  }))
  return { valid: findings.length === 0, findings }
}

/** 独立绑定 FinalReport 展示事实；不得复用 Builder renderer。 */
export function auditFinalReportFactBinding(
  artifacts: SemanticArtifact[],
): { valid: boolean; findings: Array<{ code: string; ref: string }> } {
  const findings: Array<{ code: string; ref: string }> = []
  const byType = new Map(artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const content = (type: string): Record<string, unknown> => {
    const value = byType.get(type)?.content
    return isPlainObject(value) ? value : {}
  }
  const report = content('final-report')
  const scopeDecision = objectAt(content('acceptance-scope'), 'scopeDecision')
  const lineageDecision = objectAt(content('prd-diff'), 'lineageReview')
  const grants = content('approval-grants')
  const grantItems = arrayAt(grants, 'grants')
  const approvalAssurance = objectAt(grants, 'approvalAssurance')
  const executionStatus = grantItems.some((grant) => stringAt(grant, 'status') === 'revoked')
    ? 'revoked' : grantItems.some((grant) => stringAt(grant, 'status') === 'expired')
      ? 'expired' : grantItems.some((grant) => stringAt(grant, 'status') === 'denied') ? 'rejected' : 'approved'
  const expectedApprovals = [
    { kind: 'scope', status: stringAt(scopeDecision, 'status'),
      ...approvalAssurance,
      subjectDigest: safeDecisionSubjectDigest(content('acceptance-scope')),
      grantDigests: stringAt(scopeDecision, 'status') === 'pending' ? []
        : [stringAt(objectAt(scopeDecision, 'receipt'), 'signedDigest')] },
    { kind: 'lineage', status: stringAt(lineageDecision, 'status'),
      ...approvalAssurance,
      subjectDigest: safeLineageDecisionSubjectDigest(content('prd-diff')),
      grantDigests: stringAt(lineageDecision, 'status') === 'pending' ? []
        : [stringAt(objectAt(lineageDecision, 'receipt'), 'signedDigest')] },
    { kind: 'execution', status: executionStatus,
      ...approvalAssurance,
      subjectDigest: stringAt(grants, 'runBundleDigest'),
      grantDigests: grantItems.map((grant) => stringAt(objectAt(grant, 'authorityProof'), 'signedDigest')) },
  ]
  if (!safeCanonicalEquals(report.approvals, expectedApprovals)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_APPROVALS_MISMATCH', ref: 'approvals' })
  }
  if (!safeCanonicalEquals(report.approvalAssurance, approvalAssurance)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_APPROVAL_ASSURANCE_MISMATCH', ref: 'approvalAssurance' })
  }
  const expectedManualResults = arrayAt(content('manual-results'), 'results').map((result) => ({
    id: stringAt(result, 'manualResultId'),
    digest: stringAt(objectAt(result, 'authorityProof'), 'signedDigest'),
    ...objectAt(objectAt(result, 'authorityProof'), 'approvalAssurance'),
  }))
  if (!safeCanonicalEquals(report.manualResults, expectedManualResults)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_MANUAL_ASSURANCE_MISMATCH', ref: 'manualResults' })
  }
  const traceabilityFacts = independentlyProjectReportTraceability(content)
  if (!safeCanonicalEquals(report.traceability, traceabilityFacts.edges)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_TRACEABILITY_MISMATCH', ref: 'traceability' })
  }
  if (!safeCanonicalEquals(report.traceabilityMatrix, traceabilityFacts.matrix)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_TRACEABILITY_MATRIX_MISMATCH', ref: 'traceabilityMatrix' })
  }
  if (traceabilityFacts.incomplete) {
    findings.push({ code: 'E2E_GENERATION_REPORT_TRACEABILITY_INCOMPLETE', ref: 'traceabilityMatrix' })
  }
  const semanticAudit = auditSemanticCompleteness({
    manifest: content('prd-manifest'), scope: content('acceptance-scope'),
    model: content('requirement-model'), flows: content('interaction-flow'),
    coverage: content('coverage-universe'), cases: content('test-cases'),
  })
  const clausesById = new Map(arrayAt(content('prd-manifest'), 'clauses')
    .map((clause) => [stringAt(clause, 'clauseId'), clause]))
  const expectedSemanticTraceability = semanticAudit.traceability.map((row) => {
    const clause = clausesById.get(row.clauseId) ?? {}
    return { ...row, sourceId: stringAt(clause, 'sourceId'), sourceSpan: objectAt(clause, 'sourceSpan'),
      originalText: stringAt(clause, 'originalText') }
  })
  if (!safeCanonicalEquals(report.semanticTraceability, expectedSemanticTraceability)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_SEMANTIC_TRACEABILITY_MISMATCH', ref: 'semanticTraceability' })
  }
  const expectedDispositions = independentlyProjectReportDispositions(content)
  if (!safeCanonicalEquals(report.dispositions, expectedDispositions)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_DISPOSITIONS_MISMATCH', ref: 'dispositions' })
  }
  const runBundle = content('run-bundle')
  const scheduledActions = arrayAt(runBundle, 'schedule').flatMap((item) => stringsAt(item, 'actionIds'))
  const gateway = content('gateway-audit')
  const gatewayActions = gatewayExecutionActionIds(gateway)
  const reportGateway = independentlyProjectReportGatewayAudit(gateway)
  const expectedGateway = {
    status: scheduledActions.every((actionId) => gatewayActions.has(actionId))
      && (stringAt(content('approval-grants'), 'runBundleDigest') === ''
        || gatewayExecutionClosureComplete(content('browser-action-map'), runBundle,
          content('browser-results'), gateway)) ? 'valid' : 'incomplete',
    digest: reportGateway.digest,
    forwarded: reportGateway.forwarded, blocked: reportGateway.blocked,
    injected: reportGateway.injected, findings: [],
  }
  if (!safeCanonicalEquals(report.gatewayAudit, expectedGateway)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_GATEWAY_MISMATCH', ref: 'gatewayAudit' })
  }
  const caseResults = arrayAt(content('browser-results'), 'caseResults')
  const expectedRealResults = caseResults.filter((item) => stringAt(item, 'mode') === 'real-environment')
    .map((item) => ({ id: stringAt(item, 'resultId'), digest: stringAt(item, 'eventChainDigest') }))
  const expectedInjectionResults = caseResults.filter((item) => stringAt(item, 'mode') === 'gateway-injection')
    .map((item) => ({ id: stringAt(item, 'resultId'), digest: stringAt(item, 'eventChainDigest') }))
  if (!safeCanonicalArrayEquals(arrayAt(report, 'realResults'), expectedRealResults, 'id')) {
    findings.push({ code: 'E2E_GENERATION_REPORT_REAL_RESULTS_MISMATCH', ref: 'realResults' })
  }
  if (!safeCanonicalArrayEquals(arrayAt(report, 'injectionResults'), expectedInjectionResults, 'id')) {
    findings.push({ code: 'E2E_GENERATION_REPORT_INJECTION_RESULTS_MISMATCH', ref: 'injectionResults' })
  }
  const attemptCases = arrayAt(content('workflow-events'), 'attemptCases')
  const diagnosisByCase = new Map(arrayAt(content('diagnosis'), 'caseDiagnoses')
    .map((item) => [stringAt(item, 'caseId'), item]))
  const expectedDiagnostics = attemptCases.map((attemptCase) => {
    const caseId = stringAt(attemptCase, 'caseId')
    const mode = stringAt(arrayAt(attemptCase, 'events').find((event) => stringAt(event, 'kind') === 'started') ?? {}, 'mode')
    const resultId = stringAt(caseResults.find((result) =>
      stringAt(result, 'caseId') === caseId && stringAt(result, 'mode') === mode) ?? {}, 'resultId')
    const diagnosis = diagnosisByCase.get(caseId)
    let chain = stringAt(attemptCase, 'initialChainDigest')
    const attempts: Array<Record<string, unknown>> = []
    for (const event of arrayAt(attemptCase, 'events')) {
      chain = digestText('attempt-event-chain/v1', canonicalizeJson({ previous: chain, event: stringAt(event, 'eventDigest') }))
      if (stringAt(event, 'kind') !== 'terminal') continue
      const terminal = objectAt(event, 'result')
      attempts.push({ attemptId: stringAt(event, 'attemptId'), slot: numberAt(event, 'slot'),
        status: stringAt(terminal, 'status'), mode: stringAt(terminal, 'mode'), effect: stringAt(terminal, 'effect'),
        eventChainDigest: chain, reservationSafeToVoid: terminal.reservationSafeToVoid === true,
        changeDigest: null, sideEffectState: stringAt(terminal, 'effectObservation') })
    }
    const selection = objectAt(attemptCase, 'selection')
    return { resultId, caseId, category: diagnosis ? stringAt(diagnosis, 'category') : 'not-required',
      selectedAttemptId: stringAt(selection, 'attemptId') || null,
      rationale: diagnosis ? stringAt(diagnosis, 'digest') : stringAt(selection, 'eventChainDigest'), attempts }
  }).sort((left, right) => left.resultId.localeCompare(right.resultId))
  if (!safeCanonicalEquals(report.diagnostics, expectedDiagnostics)) {
    findings.push({ code: 'E2E_GENERATION_REPORT_ATTEMPTS_MISMATCH', ref: 'diagnostics' })
  }
  const resultByCase = new Map(caseResults
    .filter((item) => stringAt(item, 'mode') === 'real-environment')
    .map((item) => [stringAt(item, 'caseId'), item]))
  const cleanupByLease = new Map(arrayAt(content('cleanup-results'), 'leaseResults')
    .map((item) => [stringAt(item, 'leaseId'), stringAt(item, 'status')]))
  const expectedSideEffects = arrayAt(content('browser-action-map'), 'actions').map((action) => {
    const caseResult = resultByCase.get(stringAt(action, 'caseId'))
    const stepResult = caseResult && arrayAt(caseResult, 'stepResults')
      .find((step) => stringAt(step, 'actionId') === stringAt(action, 'actionId'))
    const actionSnapshot = parseArtifactDocumentSafeAction(action)
    return {
      actionId: stringAt(action, 'actionId'), effect: stringAt(action, 'effect'),
      status: stepResult ? stringAt(stepResult, 'status') : 'not-executed',
      verification: stepResult
        ? stringAt(stepResult, 'actualDigest') || `oracle:${stringAt(stepResult, 'oracleResult')}`
        : 'oracle:not-evaluated',
      cleanupStatus: stringAt(action, 'effect') === 'read' ? 'not-applicable'
        : cleanupByLease.get(caseResult ? stringAt(caseResult, 'cleanupRef') : '') ?? 'cleanup-missing',
      digest: safeDigestJson('action/v1', { action: actionSnapshot, stepResult: stepResult ?? null }),
    }
  })
  if (!safeCanonicalArrayEquals(arrayAt(report, 'sideEffects'), expectedSideEffects, 'actionId')) {
    findings.push({ code: 'E2E_GENERATION_REPORT_SIDE_EFFECTS_MISMATCH', ref: 'sideEffects' })
  }
  const regressionDetails = objectAt(report, 'regressionDetails')
  const regressionManifest = content('regression-manifest')
  const regressionAttestation = objectAt(objectAt(regressionManifest, 'listResult'), 'attestation')
  const regressionToolchain = objectAt(regressionAttestation, 'toolchain')
  const trustedCompilerExecution = objectAt(content('browser-results'), 'trustedCompilerExecution')
  const expectedTrustedCompiler = {
    compilerInputDigest: stringAt(regressionAttestation, 'compilerInputDigest'),
    compilerVersion: stringAt(regressionAttestation, 'compilerVersion'),
    compilerDigest: stringAt(regressionToolchain, 'compilerDigest'),
    templateVersion: stringAt(regressionAttestation, 'templateVersion'),
    templateDigest: stringAt(regressionAttestation, 'templateDigest'),
    sourceSetDigest: stringAt(regressionAttestation, 'sourceSetDigest'),
    discoverySignedDigest: stringAt(regressionAttestation, 'signedDigest'),
    nodeVersion: stringAt(regressionToolchain, 'nodeVersion'),
    playwrightVersion: stringAt(regressionToolchain, 'playwrightVersion'),
    playwrightCliDigest: stringAt(regressionToolchain, 'playwrightCliDigest'),
    executionDigest: safeDigestJson('trusted-compiler-execution-fact/v1', trustedCompilerExecution),
  }
  const executionCaseResults = new Map(arrayAt(trustedCompilerExecution, 'caseResults')
    .map((item) => [stringAt(item, 'caseId'), stringAt(item, 'status')]))
  const browserCaseResults = arrayAt(content('browser-results'), 'caseResults')
    .filter((result) => stringAt(result, 'mode') === 'real-environment')
  const browserTerminalCaseResults = new Map(browserCaseResults
    .filter((result) => ['passed', 'failed'].includes(stringAt(result, 'status')))
    .map((result) => [stringAt(result, 'caseId'), stringAt(result, 'status')]))
  const browserPreflight = content('browser-preflight')
  const browserExecutableCheck = arrayAt(browserPreflight, 'sandboxChecks')
    .find((check) => stringAt(check, 'id') === 'TRUSTED-CHROME-EXECUTABLE')
  const gatewayProxyCheck = arrayAt(browserPreflight, 'gatewayChecks')
    .find((check) => stringAt(check, 'id') === 'TRUSTED-GATEWAY-PROXY')
  const exactCaseIds = safeCanonicalEquals(
    [...executionCaseResults.keys()].sort(), browserCaseResults.map((result) => stringAt(result, 'caseId')).sort(),
  )
  const terminalStatusesMatch = [...browserTerminalCaseResults.entries()]
    .every(([caseId, status]) => executionCaseResults.get(caseId) === status)
  const allPassed = [...executionCaseResults.values()].every((status) => status === 'passed')
  if (stringAt(trustedCompilerExecution, 'runId') !== stringAt(content('browser-results'), 'runId')
    || stringAt(trustedCompilerExecution, 'compilerInputDigest') !== stringAt(regressionAttestation, 'compilerInputDigest')
    || stringAt(trustedCompilerExecution, 'sourceSetDigest') !== stringAt(regressionAttestation, 'sourceSetDigest')
    || stringAt(trustedCompilerExecution, 'approvalDigest') !== stringAt(regressionAttestation, 'approvalDigest')
    || !exactCaseIds || !terminalStatusesMatch
    || ((numberAt(trustedCompilerExecution, 'exitCode') === 0) !== allPassed)
    || !browserExecutableCheck
    || stringAt(browserExecutableCheck, 'digest') !== stringAt(trustedCompilerExecution, 'browserExecutableDigest')
    || !gatewayProxyCheck
    || stringAt(gatewayProxyCheck, 'digest') !== stringAt(trustedCompilerExecution, 'gatewayProxyEndpointDigest')) {
    findings.push({ code: 'E2E_GENERATION_TRUSTED_EXECUTION_MISMATCH', ref: 'browser-results' })
  }
  if (stringAt(regressionDetails, 'testDomain') !== stringAt(regressionManifest, 'testDomain')
    || stringAt(regressionDetails, 'executionProfile') !== stringAt(regressionManifest, 'executionProfile')
    || !safeCanonicalEquals(regressionDetails.trustedCompiler, expectedTrustedCompiler)) {
    findings.push({
      code: 'E2E_GENERATION_REPORT_REGRESSION_PROFILE_MISMATCH',
      ref: 'regressionDetails',
    })
  }
  return { valid: findings.length === 0, findings }
}

function independentlyProjectReportGatewayAudit(gateway: Record<string, unknown>): {
  digest: string; forwarded: number; blocked: number; injected: number
} {
  const sessions = arrayAt(gateway, 'sessions')
  if (sessions.length === 0) {
    const counters = objectAt(gateway, 'signedCounters')
    return {
      digest: stringAt(counters, 'digest'),
      forwarded: finiteNumberAt(counters, 'forwarded'),
      blocked: finiteNumberAt(counters, 'blocked'),
      injected: finiteNumberAt(counters, 'injected'),
    }
  }
  const projection = sessions.map((session) => {
    const counters = objectAt(objectAt(session, 'audit'), 'signedCounters')
    return {
      resultId: stringAt(session, 'resultId'), domain: stringAt(session, 'domain'),
      digest: stringAt(counters, 'digest'), forwarded: finiteNumberAt(counters, 'forwarded'),
      blocked: finiteNumberAt(counters, 'blocked'), injected: finiteNumberAt(counters, 'injected'),
    }
  }).sort((left, right) => left.resultId.localeCompare(right.resultId))
  return {
    digest: digestText('gateway-audit-sessions/v1', canonicalizeJson(projection)),
    forwarded: projection.reduce((sum, item) => sum + item.forwarded, 0),
    blocked: projection.reduce((sum, item) => sum + item.blocked, 0),
    injected: projection.reduce((sum, item) => sum + item.injected, 0),
  }
}

function safeDecisionSubjectDigest(scope: Record<string, unknown>): string {
  try { return digestDecisionSubject(projectScopeDecisionSubject(scope)) } catch { return '' }
}

function safeLineageDecisionSubjectDigest(diff: Record<string, unknown>): string {
  try { return digestDecisionSubject(projectLineageDecisionSubject(diff)) } catch { return '' }
}

function independentlyProjectReportTraceability(
  content: (type: string) => Record<string, unknown>,
): { edges: Array<Record<string, string>>; matrix: Array<Record<string, string>>; incomplete: boolean } {
  const requirements = new Map(arrayAt(content('requirement-model'), 'requirements')
    .filter((item) => stringAt(item, 'status') === 'active')
    .map((item) => [stringAt(item, 'reqId'), item]))
  const cases = new Map(arrayAt(content('test-cases'), 'cases')
    .filter((item) => stringAt(item, 'status') === 'active')
    .map((item) => [stringAt(item, 'caseId'), item]))
  const results = new Map(arrayAt(content('browser-results'), 'caseResults')
    .filter((item) => stringAt(item, 'mode') === 'real-environment')
    .map((item) => [stringAt(item, 'caseId'), item]))
  const evidence = new Map(arrayAt(content('browser-evidence'), 'artifacts')
    .map((item) => [stringAt(item, 'evidenceId'), item]))
  const edgeMap = new Map<string, Record<string, string>>()
  const matrix: Array<Record<string, string>> = []
  let incomplete = false
  const addEdge = (fromId: string, toId: string, kind: string): void => {
    edgeMap.set(`${kind}\0${fromId}\0${toId}`, { fromId, toId, kind })
  }
  for (const obligation of arrayAt(content('coverage-universe'), 'obligations')) {
    const disposition = objectAt(obligation, 'disposition')
    const reqId = stringAt(obligation, 'reqId')
    const requirement = requirements.get(reqId)
    if (stringAt(disposition, 'kind') !== 'automated' || !requirement) continue
    const requirementRuleIds = new Set(arrayAt(requirement, 'rules').map((rule) => stringAt(rule, 'ruleId')))
    for (const ruleId of stringsAt(obligation, 'ruleIds')) {
      if (!requirementRuleIds.has(ruleId)) { incomplete = true; continue }
      addEdge(reqId, ruleId, 'defines')
      addEdge(ruleId, stringAt(obligation, 'obligationId'), 'covered-by')
      for (const caseId of stringsAt(disposition, 'caseIds')) {
        const testCase = cases.get(caseId)
        if (!testCase) { incomplete = true; continue }
        addEdge(stringAt(obligation, 'obligationId'), caseId, 'implemented-by')
        const result = results.get(caseId)
        for (const step of arrayAt(testCase, 'steps')) {
          const stepId = stringAt(step, 'stepId')
          addEdge(caseId, stepId, 'executes')
          const stepResult = result && arrayAt(result, 'stepResults')
            .find((item) => stringAt(item, 'stepId') === stepId)
          if (!stepResult) continue
          const evidenceIds = stringsAt(stepResult, 'evidenceIds')
          if (['passed', 'failed'].includes(stringAt(stepResult, 'status')) && evidenceIds.length === 0) {
            incomplete = true
          }
          for (const evidenceId of evidenceIds) {
            const item = evidence.get(evidenceId)
            if (!item || stringAt(item, 'caseId') !== caseId) { incomplete = true; continue }
            addEdge(stepId, evidenceId, 'evidenced-by')
            matrix.push({
              reqId, ruleId, obligationId: stringAt(obligation, 'obligationId'), caseId, stepId,
              evidenceId, evidencePath: stringAt(item, 'relativePath'),
            })
          }
        }
      }
    }
  }
  const order = new Map([
    ['defines', 0], ['covered-by', 1], ['implemented-by', 2], ['executes', 3], ['evidenced-by', 4],
  ])
  const edges = [...edgeMap.values()].sort((left, right) =>
    (order.get(left.kind!) ?? 99) - (order.get(right.kind!) ?? 99)
      || left.fromId!.localeCompare(right.fromId!) || left.toId!.localeCompare(right.toId!))
  matrix.sort((left, right) => [left.reqId, left.ruleId, left.obligationId, left.caseId,
    left.stepId, left.evidenceId, left.evidencePath].join('\0').localeCompare(
    [right.reqId, right.ruleId, right.obligationId, right.caseId,
      right.stepId, right.evidenceId, right.evidencePath].join('\0')))
  return { edges, matrix, incomplete }
}

function independentlyProjectReportDispositions(
  content: (type: string) => Record<string, unknown>,
): Array<Record<string, unknown>> {
  const projected: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const add = (item: Record<string, unknown>): void => {
    const id = stringAt(item, 'id')
    if (seen.has(id)) return
    seen.add(id)
    projected.push(item)
  }
  const testCases = arrayAt(content('test-cases'), 'cases')
  const caseTitles = new Map(testCases.map((item) => [stringAt(item, 'caseId'), stringAt(item, 'title')]))
  for (const item of arrayAt(content('acceptance-scope'), 'exclusions')) add({
    kind: 'excluded', id: stringAt(item, 'reqId'), title: stringAt(item, 'reqId'), status: 'excluded',
    reason: stringAt(item, 'rationale'), refs: [stringAt(item, 'decisionId')],
  })
  for (const obligation of arrayAt(content('coverage-universe'), 'obligations')) {
    const disposition = objectAt(obligation, 'disposition')
    if (stringAt(disposition, 'kind') === 'manual') add({
      kind: 'manual', id: stringAt(obligation, 'obligationId'), title: stringAt(obligation, 'scenario'),
      status: 'manual-required', reason: 'coverage-disposition:manual',
      refs: [stringAt(disposition, 'manualProcedureId')],
    })
    if (stringAt(disposition, 'kind') === 'not-applicable') add({
      kind: 'not-applicable', id: stringAt(obligation, 'obligationId'), title: stringAt(obligation, 'scenario'),
      status: 'not-applicable', reason: stringAt(disposition, 'rationale'),
      refs: [stringAt(disposition, 'policyCode'), stringAt(disposition, 'decisionGrantId')],
    })
  }
  const regression = content('regression-manifest')
  for (const item of arrayAt(regression, 'blockedCases')) {
    const caseId = stringAt(item, 'caseId')
    add({ kind: 'blocked', id: caseId, title: caseTitles.get(caseId) ?? caseId, status: 'blocked',
      reason: stringAt(item, 'reasonCode'), refs: [] })
  }
  for (const caseId of stringsAt(regression, 'deprecatedCases')) add({
    kind: 'excluded', id: caseId, title: caseTitles.get(caseId) ?? caseId, status: 'deprecated',
    reason: 'deprecated', refs: [],
  })
  for (const result of arrayAt(content('browser-results'), 'caseResults')) {
    const caseId = stringAt(result, 'caseId')
    const status = stringAt(result, 'status')
    if (status === 'not-executed-user-declined') add({
      kind: 'declined', id: caseId, title: caseTitles.get(caseId) ?? caseId,
      status, reason: 'user-declined', refs: [stringAt(result, 'attemptId')],
    })
    if (['input-blocked', 'environment-blocked', 'safety-blocked', 'automation-blocked',
      'pending-decision'].includes(status)) add({
      kind: 'blocked', id: caseId, title: caseTitles.get(caseId) ?? caseId,
      status, reason: status, refs: [stringAt(result, 'attemptId')],
    })
    if (status === 'manual-required') add({
      kind: 'manual', id: caseId, title: caseTitles.get(caseId) ?? caseId,
      status, reason: status, refs: [stringAt(result, 'attemptId')],
    })
  }
  for (const result of arrayAt(content('manual-results'), 'results')) add({
    kind: 'manual', id: stringAt(result, 'manualResultId'), title: stringAt(result, 'manualProcedureId'),
    status: stringAt(result, 'outcome'), reason: 'manual-result', refs: stringsAt(result, 'obligationIds').sort(),
  })
  for (const item of arrayAt(content('execution-contract'), 'unresolvedItems')) {
    if (item.blocking !== true) continue
    add({ kind: 'blocked', id: stringAt(item, 'itemId'), title: stringAt(item, 'itemId'), status: 'blocked',
      reason: stringAt(item, 'kind'), refs: [] })
  }
  return projected.sort((left, right) => stringAt(left, 'id').localeCompare(stringAt(right, 'id'))
    || stringAt(left, 'kind').localeCompare(stringAt(right, 'kind')))
}

function parseArtifactDocumentSafeAction(action: Record<string, unknown>): Record<string, unknown> | null {
  try { return structuredClone(action) as Record<string, unknown> } catch { return null }
}

function safeCanonicalEquals(left: unknown, right: unknown): boolean {
  try { return canonicalizeJson(left) === canonicalizeJson(right) } catch { return false }
}

function safeCanonicalArrayEquals(left: unknown[], right: unknown[], key: string): boolean {
  try { return canonicalArrayEquals(left, right, key) } catch { return false }
}

function safeDigestJson(domain: string, value: unknown): string {
  try { return digestText(domain, canonicalizeJson(value)) } catch { return '' }
}

export interface SemanticArtifact {
  artifactId: string
  artifactType: string
  assetId?: string
  schemaVersion?: string
  generationId?: string
  prdRevision?: string
  engineVersion?: string
  contentDigest?: string
  createdAt?: string
  content: unknown
}

/**
 * 不信任 report/manifest 的互相抄写：分别解析两份 provenance，再与 Host 冻结测量及
 * generation 中可独立复算的 Gateway、Browser、Engine、isolation 事实逐项核对。
 */
export function auditRuntimeProvenanceBinding(
  artifacts: SemanticArtifact[],
  hostMeasurement: RuntimeProvenance,
): { valid: boolean; findings: Array<{ code: string; ref: string }> } {
  const findings: Array<{ code: string; ref: string }> = []
  const byType = new Map(artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const report = byType.get('final-report')
  const manifest = byType.get('generation-manifest')
  const expected = RuntimeProvenanceSchema.safeParse(hostMeasurement)
  const reportValue = isPlainObject(report?.content)
    ? RuntimeProvenanceSchema.safeParse(report.content.runtimeProvenance) : undefined
  const manifestValue = isPlainObject(manifest?.content)
    ? RuntimeProvenanceSchema.safeParse(manifest.content.runtimeProvenance) : undefined
  if (!expected.success) findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_HOST_INVALID', ref: 'host' })
  if (!reportValue?.success) findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_REPORT_INVALID', ref: 'final-report' })
  if (!manifestValue?.success) findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_MANIFEST_INVALID', ref: 'generation-manifest' })
  if (!expected.success || !reportValue?.success || !manifestValue?.success) {
    return { valid: false, findings }
  }
  if (!safeCanonicalEquals(reportValue.data, manifestValue.data)) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_CROSS_ARTIFACT_MISMATCH', ref: 'runtimeProvenance' })
  }
  if (!safeCanonicalEquals(reportValue.data, expected.data)) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_HOST_MISMATCH', ref: 'runtimeProvenance' })
  }

  const provenance = reportValue.data
  const gateway = byType.get('gateway-audit')
  const regression = byType.get('regression-manifest')
  const preflight = byType.get('browser-preflight')
  const execution = byType.get('execution-contract')
  const browserResults = byType.get('browser-results')
  const gatewayContent = isPlainObject(gateway?.content) ? gateway.content : {}
  const regressionContent = isPlainObject(regression?.content) ? regression.content : {}
  const preflightContent = isPlainObject(preflight?.content) ? preflight.content : {}
  const executionContent = isPlainObject(execution?.content) ? execution.content : {}
  const browserResultsContent = isPlainObject(browserResults?.content) ? browserResults.content : {}
  const toolchain = objectAt(regressionContent, 'toolchain')
  const chromium = arrayAt(preflightContent, 'sandboxChecks')
    .find((check) => stringAt(check, 'id') === 'TRUSTED-CHROME-EXECUTABLE')
  const sandboxChecks = arrayAt(preflightContent, 'sandboxChecks')
  if (provenance.engineVersion !== report?.engineVersion
    || provenance.engineVersion !== manifest?.engineVersion) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_ENGINE_MISMATCH', ref: 'engineVersion' })
  }
  if (provenance.sourceRevisionDigest !== report?.prdRevision
    || provenance.sourceRevisionDigest !== manifest?.prdRevision) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_SOURCE_REVISION_MISMATCH', ref: 'sourceRevisionDigest' })
  }
  if (provenance.playwrightVersion !== stringAt(toolchain, 'playwrightVersion')) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_PLAYWRIGHT_MISMATCH', ref: 'playwrightVersion' })
  }
  if (!chromium || provenance.chromiumDigest !== stringAt(chromium, 'digest')) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_CHROMIUM_MISMATCH', ref: 'chromiumDigest' })
  }
  const gatewaySessions = arrayAt(gatewayContent, 'sessions')
  const realGatewaySessions = gatewaySessions
    .filter((session) => stringAt(session, 'domain') === 'real-environment')
  const resultCases = new Map(arrayAt(browserResultsContent, 'caseResults')
    .map((result) => [stringAt(result, 'resultId'), stringAt(result, 'caseId')]))
  const expectedGatewayPolicyDigest = realGatewaySessions.length <= 1
    ? stringAt(gatewayContent, 'policyDigest')
    : digestText(
      'runtime-multi-case-gateway-policy-set/v1',
      canonicalizeJson(realGatewaySessions.map((session) => {
          const resultId = stringAt(session, 'resultId')
          return {
            caseId: resultCases.get(resultId) ?? '',
            resultId,
            gatewayPolicyDigest: stringAt(objectAt(session, 'audit'), 'policyDigest'),
          }
        })),
    )
  if (provenance.gatewayPolicyDigest !== expectedGatewayPolicyDigest) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_GATEWAY_MISMATCH', ref: 'gatewayPolicyDigest' })
  }
  const expectedIsolationProof = safeDigestJson('runtime-isolation-proof/v1', sandboxChecks)
  if (provenance.isolationProofDigest !== expectedIsolationProof) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_ISOLATION_MISMATCH', ref: 'isolationProofDigest' })
  }
  const isolation = executionContent.runtimeIsolation
  if (isPlainObject(isolation)
    && provenance.authorityPublicKeyDigest !== stringAt(isolation, 'authorityRpcPublicKeyDigest')) {
    findings.push({ code: 'E2E_GENERATION_RUNTIME_PROVENANCE_AUTHORITY_MISMATCH', ref: 'authorityPublicKeyDigest' })
  }
  return { valid: findings.length === 0, findings }
}

export interface SemanticAuditFinding { code: string; artifactId: string; ref: string }

export type DecisionReceiptVerifier = (
  receipt: DecisionReceipt,
  binding: DecisionReceiptVerificationBinding,
) => boolean

/** 独立从本代 scope/diff 事实重建版本化 subject，并验证专用 Authority receipt。 */
export function auditDecisionReceipts(
  artifacts: SemanticArtifact[],
  verifier?: DecisionReceiptVerifier,
): { valid: boolean; findings: SemanticAuditFinding[] } {
  const findings: SemanticAuditFinding[] = []
  const byType = new Map(artifacts.map((artifact) => [artifact.artifactType, artifact]))
  check('scope', byType.get('acceptance-scope'), 'scopeDecision')
  check('lineage', byType.get('prd-diff'), 'lineageReview')
  checkCoverageDispositions(byType.get('coverage-universe'), byType.get('requirement-model'))
  return { valid: findings.length === 0, findings }

  function check(kind: 'scope' | 'lineage', artifact: SemanticArtifact | undefined, field: string): void {
    if (!artifact || !isPlainObject(artifact.content)) {
      findings.push({ code: 'E2E_GENERATION_DECISION_SUBJECT_INVALID', artifactId: artifact?.artifactId ?? kind, ref: field })
      return
    }
    const decision = objectAt(artifact.content, field)
    if (stringAt(decision, 'status') === 'pending') return
    let subjectDigest: string
    try {
      const subject = kind === 'scope'
        ? projectScopeDecisionSubject(artifact.content)
        : projectLineageDecisionSubject(artifact.content)
      subjectDigest = digestDecisionSubject(subject)
    } catch {
      findings.push({ code: 'E2E_GENERATION_DECISION_SUBJECT_INVALID', artifactId: artifact.artifactId, ref: field })
      return
    }
    const binding: DecisionReceiptVerificationBinding = {
      kind,
      decisionId: stringAt(decision, 'decisionId'),
      decisionStatus: stringAt(decision, 'status') as 'approved' | 'rejected',
      decisionSubjectDigest: subjectDigest,
    }
    if (!verifier) {
      findings.push({ code: 'E2E_GENERATION_DECISION_VERIFIER_UNAVAILABLE', artifactId: artifact.artifactId, ref: field })
      return
    }
    try {
      if (!verifier(objectAt(decision, 'receipt') as DecisionReceipt, binding)) {
        findings.push({ code: 'E2E_GENERATION_DECISION_RECEIPT_INVALID', artifactId: artifact.artifactId, ref: field })
      }
    } catch {
      findings.push({ code: 'E2E_GENERATION_DECISION_VERIFIER_ERROR', artifactId: artifact.artifactId, ref: field })
    }
  }

  function checkCoverageDispositions(
    coverage: SemanticArtifact | undefined,
    model: SemanticArtifact | undefined,
  ): void {
    if (!coverage) return
    if (!model || !isPlainObject(coverage.content) || !isPlainObject(model.content)) {
      findings.push({ code: 'E2E_GENERATION_DECISION_SUBJECT_INVALID',
        artifactId: coverage?.artifactId ?? 'coverage-universe', ref: 'coverage-disposition' })
      return
    }
    for (const obligation of arrayAt(coverage.content, 'obligations')) {
      const disposition = objectAt(obligation, 'disposition')
      if (stringAt(disposition, 'kind') !== 'not-applicable') continue
      const receipt = objectAt(disposition, 'decisionReceipt') as DecisionReceipt
      const ref = `obligations:${stringAt(obligation, 'obligationId')}`
      let subjectDigest: string
      try {
        subjectDigest = digestDecisionSubject(projectCoverageDispositionDecisionSubject({
          obligationId: stringAt(obligation, 'obligationId'),
          requirementModelDigest: stringAt(model.content, 'modelDecisionDigest'),
          coveragePolicyDigest: stringAt(coverage.content, 'coveragePolicyDigest'),
          disposition: 'not-applicable',
          policyCode: stringAt(disposition, 'policyCode'),
          rationale: stringAt(disposition, 'rationale'),
        }))
      } catch {
        findings.push({ code: 'E2E_GENERATION_DECISION_SUBJECT_INVALID', artifactId: coverage.artifactId, ref })
        continue
      }
      const binding: DecisionReceiptVerificationBinding = {
        kind: 'coverage-disposition', decisionId: stringAt(disposition, 'decisionGrantId'),
        decisionStatus: 'approved', decisionSubjectDigest: subjectDigest,
      }
      if (!verifier) {
        findings.push({ code: 'E2E_GENERATION_DECISION_VERIFIER_UNAVAILABLE', artifactId: coverage.artifactId, ref })
        continue
      }
      try {
        if (!verifier(receipt, binding)) {
          findings.push({ code: 'E2E_GENERATION_DECISION_RECEIPT_INVALID', artifactId: coverage.artifactId, ref })
        }
      } catch {
        findings.push({ code: 'E2E_GENERATION_DECISION_VERIFIER_ERROR', artifactId: coverage.artifactId, ref })
      }
    }
  }
}

export const APPROVAL_INPUT_ARTIFACT_TYPES = [
  'project-policy', 'acceptance-scope', 'requirement-model', 'coverage-universe',
  'test-cases', 'execution-contract', 'browser-action-map',
] as const

export interface ApprovalFreshnessAuditBinding {
  currentSubject: ReadApprovalSubject | WriteApprovalSubject
  expectedCapabilities: ApprovalCapabilityRecord[]
  browserPreflight: {
    artifactDigest: string
    discoveryGrantId: string
    authorityPreflightDigest: string
  }
  runBundle: { artifactDigest: string; content: unknown }
}

/** 对 Spec 22.4 中不能由通用引用图表达的集合闭包做独立审计。 */
export function auditArtifactSemantics(
  artifacts: SemanticArtifact[],
  actualFiles: AuditableFile[],
  dependencies?: {
    verifySanitizerAttestation?(attestation: SanitizerAttestation, binding: SanitizerAttestationBinding): boolean
    verifyPrivacyReviewReceipt?(receipt: PrivacyReviewReceipt, binding: PrivacyReviewReceiptBinding): boolean
    verifyGatewayAuditSignature?(signature: ArtifactDocument['signatures'][number]): boolean
    verifyExecutionOutcomeReceipt?(receipt: ExecutionOutcomeReceipt): boolean
    verifyApprovalFreshnessReceipt?(
      receipt: ApprovalFreshnessReceipt,
      binding: ApprovalFreshnessAuditBinding,
    ): ApprovalFreshnessVerification
    verifyDecisionReceipt?: DecisionReceiptVerifier
    verifyRegressionDiscoveryAttestation?(
      attestation: RegressionDiscoveryAttestation,
      subject: RegressionDiscoverySubject,
    ): boolean
  },
): { valid: boolean; findings: SemanticAuditFinding[] } {
  const findings: SemanticAuditFinding[] = []
  const byType = new Map(artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const scope = content('acceptance-scope')
  const model = content('requirement-model')
  const coverage = content('coverage-universe')
  const cases = content('test-cases')
  const actionMap = content('browser-action-map')
  const runBundle = content('run-bundle')
  const grants = content('approval-grants')
  const v2ApprovalFacts = stringAt(grants, 'runBundleDigest') !== ''
  const browserResults = content('browser-results')
  const evidenceArtifact = content('browser-evidence')
  const gateway = content('gateway-audit')
  const leases = content('data-leases')
  const cleanup = content('cleanup-results')
  const regression = content('regression-manifest')
  const regressionAttestation = objectAt(objectAt(regression, 'listResult'), 'attestation')
  const regressionTestDomain = stringAt(regression, 'testDomain')
  const regressionProfile = stringAt(regression, 'executionProfile')
  const hasRegressionProfileFacts = regressionTestDomain !== '' || regressionProfile !== ''
    || stringAt(regressionAttestation, 'testDomain') !== ''
    || stringAt(regressionAttestation, 'executionProfile') !== ''
  if (hasRegressionProfileFacts && (regressionTestDomain !== 'prd-e2e-trusted-compiler'
    || stringAt(regressionAttestation, 'testDomain') !== regressionTestDomain
    || stringAt(regressionAttestation, 'executionProfile') !== regressionProfile)) {
    add('E2E_GENERATION_REGRESSION_PROFILE_MISMATCH', 'regression-manifest', 'testDomain/executionProfile')
  }
  const projectPolicy = content('project-policy')
  const executionContract = content('execution-contract')

  auditBrowserExecutionBinding({
    approved: arrayAt(projectPolicy, 'browserMatrix').map((item) => ({
      browserId: stringAt(item, 'browserId'), required: item.required === true,
    })),
    planned: arrayAt(executionContract, 'browserMatrix').map((item) => ({
      browserId: stringAt(item, 'browserId'),
    })),
    executed: stringsAt(browserResults, 'executedBrowserIds'),
  }).forEach((finding) => add(finding.code, 'browser-results', finding.ref))

  // 允许该低层 helper 的历史局部夹具只审计单一闭包；完整 validateGeneration 固定包含两类资产，
  // 因而一定进入 DecisionReceipt 强制复验。
  if (byType.has('acceptance-scope') && byType.has('prd-diff')) {
    auditDecisionReceipts(artifacts, dependencies?.verifyDecisionReceipt).findings
      .forEach((finding) => add(finding.code, finding.artifactId, finding.ref))
  }

  const approvedEvidencePolicyDigest = stringAt(objectAt(projectPolicy, 'evidencePolicy'), 'digest')
  const evidencePolicyDigests = [
    stringAt(executionContract, 'evidencePolicyDigest'), stringAt(evidenceArtifact, 'evidencePolicyDigest'),
    ...arrayAt(evidenceArtifact, 'artifacts').map((item) =>
      stringAt(objectAt(item, 'sanitizationRecord'), 'policyDigest')),
    ...arrayAt(evidenceArtifact, 'sanitizerProofs').map((item) =>
      stringAt(objectAt(item, 'record'), 'policyDigest')),
  ]
  if (v2ApprovalFacts && evidencePolicyDigests.some((digest) => digest !== approvedEvidencePolicyDigest)) {
    add('E2E_GENERATION_EVIDENCE_POLICY_BINDING_MISMATCH', 'browser-evidence', approvedEvidencePolicyDigest)
  }
  const approvedRuntimePolicyDigest = stringAt(objectAt(projectPolicy, 'runtimePolicy'), 'digest')
  const gatewayInstanceId = stringAt(objectAt(gateway, 'gatewayInstance'), 'instanceId')
  const gatewayCheck = arrayAt(content('browser-preflight'), 'gatewayChecks')
    .find((item) => stringAt(item, 'id') === gatewayInstanceId)
  const executedGatewayPolicyDigest = stringAt(gateway, 'policyDigest')
  if (v2ApprovalFacts && (stringAt(runBundle, 'runtimePolicyDigest') !== approvedRuntimePolicyDigest
    || stringAt(gatewayCheck ?? {}, 'digest') !== executedGatewayPolicyDigest)) {
    add('E2E_GENERATION_GATEWAY_POLICY_BINDING_MISMATCH', 'gateway-audit', approvedRuntimePolicyDigest)
  }

  if (v2ApprovalFacts) {
    const runtimeIsolation = executionContract.runtimeIsolation
    const runtimeIsolationPolicyDigest = stringAt(runBundle, 'runtimeIsolationPolicyDigest')
    const hasNonReadAction = arrayAt(executionContract, 'actionIntents')
      .some((intent) => stringAt(intent, 'effect') !== 'read')
    const productionIsolated = regressionProfile === 'production-isolated'
    const trustedReadOnly = regressionProfile === 'trusted-read-only'
    const trustedReversibleWrite = regressionProfile === 'trusted-reversible-write'
    const trustedFullPlaywright = regressionProfile === 'full-playwright'
    if ((hasNonReadAction && trustedReadOnly)
      || (!hasNonReadAction && (trustedReversibleWrite || trustedFullPlaywright))) {
      add('E2E_GENERATION_REGRESSION_PROFILE_EFFECT_MISMATCH', 'regression-manifest', regressionProfile)
    }
    if (productionIsolated) {
      if (!isPlainObject(runtimeIsolation)) {
        add('E2E_GENERATION_RUNTIME_ISOLATION_REQUIRED', 'execution-contract', 'runtimeIsolation')
      } else {
        let computed = ''
        try { computed = digestRuntimeIsolationPolicy(runtimeIsolation) } catch {}
        if (!computed || runtimeIsolationPolicyDigest !== computed) {
          add('E2E_GENERATION_RUNTIME_ISOLATION_BINDING_MISMATCH', 'run-bundle', runtimeIsolationPolicyDigest)
        }
      }
    } else if (trustedReadOnly || trustedReversibleWrite || trustedFullPlaywright) {
      if (runtimeIsolation !== null || runtimeIsolationPolicyDigest !== 'not-applicable') {
        add('E2E_GENERATION_RUNTIME_ISOLATION_UNEXPECTED', 'execution-contract', 'runtimeIsolation')
      }
    } else {
      add('E2E_COMPILER_UNATTESTED_SOURCE', 'regression-manifest', 'executionProfile')
    }
    if (!productionIsolated && !trustedReadOnly && !trustedReversibleWrite && !trustedFullPlaywright
      && (runtimeIsolation !== null || runtimeIsolationPolicyDigest !== 'not-applicable')) {
      add('E2E_GENERATION_RUNTIME_ISOLATION_UNEXPECTED', 'execution-contract', 'runtimeIsolation')
    }
  }

  const requirements = arrayAt(model, 'requirements')
  const activeRequirements = new Map(requirements
    .filter((requirement) => stringAt(requirement, 'status') === 'active')
    .map((requirement) => [stringAt(requirement, 'reqId'), requirement]))
  const obligations = arrayAt(coverage, 'obligations')
  const activeCases = arrayAt(cases, 'cases').filter((item) => stringAt(item, 'status') === 'active')
  const activeCaseIds = new Set(activeCases.map((item) => stringAt(item, 'caseId')))
  const mappings = arrayAt(actionMap, 'actions')
  const fullProgramsByAction = new Map(arrayAt(actionMap, 'fullPlaywrightPrograms')
    .map((program) => [stringAt(program, 'actionId'), program]))

  const approvalInputRefs = arrayAt(runBundle, 'allInputRefs')
  const expectedApprovalRefs = v2ApprovalFacts ? APPROVAL_INPUT_ARTIFACT_TYPES.map((type) => ({
    artifactId: `ARTIFACT-${type.toUpperCase()}`,
    digest: digestApprovalProjection(type, content(type)),
  })) : []
  if (v2ApprovalFacts && !safeCanonicalArrayEquals(approvalInputRefs, expectedApprovalRefs, 'artifactId')) {
    add('E2E_GENERATION_RUN_BUNDLE_INPUT_REFS_INVALID', 'run-bundle', 'allInputRefs')
  }
  const executionSecretRefs = arrayAt(content('execution-contract'), 'identities')
    .map((identity) => stringAt(identity, 'secretRef'))
  if (v2ApprovalFacts && !canonicalArrayEquals(stringsAt(runBundle, 'secretRefs'), executionSecretRefs, '')) {
    add('E2E_GENERATION_RUN_BUNDLE_SECRET_REFS_INVALID', 'run-bundle', 'secretRefs')
  }
  const actionIntents = arrayAt(content('execution-contract'), 'actionIntents')
  const actionIntentPairs = actionIntents.map((item) => `${stringAt(item, 'actionId')}\0${stringAt(item, 'effect')}`)
  const actionMapPairs = mappings.map((item) => `${stringAt(item, 'actionId')}\0${stringAt(item, 'effect')}`)
  if (v2ApprovalFacts && !canonicalArrayEquals(actionIntentPairs, actionMapPairs, '')) {
    add('E2E_GENERATION_EXECUTION_ACTION_INTENTS_INVALID', 'execution-contract', 'actionIntents')
  }

  const scheduledCaseIds = new Set(arrayAt(runBundle, 'schedule').map((item) => stringAt(item, 'caseId')))
  const scheduledActors = new Set(activeCases.filter((item) => scheduledCaseIds.has(stringAt(item, 'caseId')))
    .map((item) => stringAt(item, 'actor')))
  const observedActor = stringAt(content('browser-preflight'), 'observedActor')
  const executionRoles = new Set(arrayAt(content('execution-contract'), 'identities')
    .flatMap((identity) => stringsAt(identity, 'roleIds')))
  if (v2ApprovalFacts && (scheduledActors.size !== 1
    || !scheduledActors.has(observedActor) || !executionRoles.has(observedActor))) {
    add('E2E_GENERATION_ACTOR_BINDING_MISMATCH', 'browser-preflight', observedActor || 'missing')
  }
  for (const testCase of v2ApprovalFacts
    ? activeCases.filter((item) => scheduledCaseIds.has(stringAt(item, 'caseId'))) : []) {
    const actor = stringAt(testCase, 'actor')
    for (const obligationId of stringsAt(testCase, 'obligationIds')) {
      const obligation = obligations.find((item) => stringAt(item, 'obligationId') === obligationId)
      const requirement = obligation
        ? activeRequirements.get(stringAt(obligation, 'reqId')) : undefined
      const obligationActor = obligation ? stringAt(obligation, 'actor') : ''
      if (!obligation || (obligationActor !== 'not-applicable' && obligationActor !== actor)
        || !requirement || !stringsAt(requirement, 'actors').includes(actor)) {
        add('E2E_GENERATION_ACTOR_TRACEABILITY_MISMATCH', 'test-cases', `${stringAt(testCase, 'caseId')}:${obligationId}`)
      }
    }
  }

  const derivedDefinitions = new Map<string, string>()
  requirements.forEach((requirement) => {
    define('REQ', stringAt(requirement, 'reqId'), 'requirement-model')
    arrayAt(requirement, 'rules').forEach((rule) => define('RULE', stringAt(rule, 'ruleId'), 'requirement-model'))
  })
  arrayAt(content('interaction-flow'), 'flows').forEach((flow) => {
    define('FLOW', stringAt(flow, 'flowId'), 'interaction-flow')
    arrayAt(flow, 'nodes').forEach((node) => define('NODE', stringAt(node, 'nodeId'), 'interaction-flow'))
  })
  obligations.forEach((obligation) => define('COV', stringAt(obligation, 'obligationId'), 'coverage-universe'))
  activeCases.forEach((testCase) => {
    define('CASE', stringAt(testCase, 'caseId'), 'test-cases')
    arrayAt(testCase, 'steps').forEach((step) => define('STEP', stringAt(step, 'stepId'), 'test-cases'))
  })
  mappings.forEach((mapping) => define('ACTION', stringAt(mapping, 'actionId'), 'browser-action-map'))

  for (const requirementId of arrayAt(scope, 'includedReqCandidates').map((item) => stringAt(item, 'reqId'))) {
    const requirement = activeRequirements.get(requirementId)
    const rules = requirement ? arrayAt(requirement, 'rules').map((rule) => stringAt(rule, 'ruleId')) : []
    const linked = obligations.filter((obligation) => stringAt(obligation, 'reqId') === requirementId)
    if (!requirement || rules.length === 0 || linked.length === 0
      || linked.some((obligation) => objectAt(obligation, 'disposition').kind === undefined)) {
      add('E2E_GENERATION_REQUIREMENT_COVERAGE_BROKEN', 'acceptance-scope', requirementId)
    }
    const linkedRuleIds = new Set(linked.flatMap((obligation) => stringsAt(obligation, 'ruleIds')))
    if (rules.some((ruleId) => !linkedRuleIds.has(ruleId))) {
      add('E2E_GENERATION_REQUIREMENT_RULE_BROKEN', 'coverage-universe', requirementId)
    }
  }

  for (const obligation of obligations) {
    const disposition = objectAt(obligation, 'disposition')
    if (disposition.kind !== 'automated') continue
    const caseIds = stringsAt(disposition, 'caseIds')
    if (caseIds.length === 0 || caseIds.some((caseId) => !activeCaseIds.has(caseId))) {
      add('E2E_GENERATION_AUTOMATED_CASE_BROKEN', 'coverage-universe', stringAt(obligation, 'obligationId'))
    }
  }

  for (const testCase of activeCases) {
    const caseId = stringAt(testCase, 'caseId')
    for (const stepId of arrayAt(testCase, 'steps').map((step) => stringAt(step, 'stepId'))) {
      const matches = mappings.filter((mapping) =>
        stringAt(mapping, 'caseId') === caseId && stringAt(mapping, 'stepId') === stepId)
      if (matches.length !== 1 || stringsAt(matches[0] ?? {}, 'oracleIds').length === 0) {
        add('E2E_GENERATION_ACTION_MAPPING_INVALID', 'browser-action-map', `${caseId}:${stepId}`)
      }
    }
  }

  const schedule = arrayAt(runBundle, 'schedule')
  const bundleCases = new Set(schedule.map((item) => stringAt(item, 'caseId')))
  const bundleActions = new Set(schedule.flatMap((item) => stringsAt(item, 'actionIds')))
  const signedCapabilities = arrayAt(runBundle, 'signedCapabilities')
  const capabilityIds = signedCapabilities.map((item) => stringAt(item, 'capabilityId'))
  const capabilityDigests = signedCapabilities.map((item) => stringAt(item, 'digest'))
  if (new Set(capabilityIds).size !== capabilityIds.length
    || new Set(capabilityDigests).size !== capabilityDigests.length) {
    add('E2E_GENERATION_CAPABILITY_DUPLICATE', 'run-bundle', 'signedCapabilities')
  }
  const requiredCapabilityIds = new Set(mappings
    .filter((mapping) => bundleActions.has(stringAt(mapping, 'actionId')))
    .flatMap((mapping) => {
      const v2 = arrayAt(mapping, 'capabilities').map((capability) => stringAt(capability, 'capabilityId'))
      return v2.length > 0 ? v2 : [stringAt(mapping, 'capabilityId')].filter(Boolean)
    }))
  for (const capabilityId of requiredCapabilityIds) {
    if (capabilityIds.filter((candidate) => candidate === capabilityId).length !== 1) {
      add('E2E_GENERATION_CAPABILITY_COVERAGE_INCOMPLETE', 'run-bundle', capabilityId)
    }
  }
  for (const capabilityId of capabilityIds) {
    if (!requiredCapabilityIds.has(capabilityId)) {
      add('E2E_GENERATION_CAPABILITY_UNKNOWN', 'run-bundle', capabilityId)
    }
  }
  const evidenceRecords = arrayAt(evidenceArtifact, 'artifacts')
  const evidenceIds = new Set(evidenceRecords.map((item) => stringAt(item, 'evidenceId')))
  const sanitizerProofs = new Map(arrayAt(evidenceArtifact, 'sanitizerProofs')
    .map((item) => [stringAt(item, 'evidenceId'), item]))
  const privacyReviews = new Map(arrayAt(evidenceArtifact, 'privacyReviews')
    .map((item) => [stringAt(item, 'evidenceId'), item]))
  const requiredEvidenceLevel = new Map(activeCases.map((item) => [
    stringAt(item, 'caseId'), stringAt(item, 'evidenceLevel'),
  ]))
  for (const caseResult of arrayAt(browserResults, 'caseResults')) {
    const caseId = stringAt(caseResult, 'caseId')
    const scheduledCase = schedule.find((item) => stringAt(item, 'caseId') === caseId)
    const caseSteps = new Set(scheduledCase ? stringsAt(scheduledCase, 'stepIds') : [])
    const caseActions = new Set(scheduledCase ? stringsAt(scheduledCase, 'actionIds') : [])
    const stepResults = arrayAt(caseResult, 'stepResults')
    const resultStepIds = stepResults.map((step) => stringAt(step, 'stepId'))
    const resultActionIds = stepResults.map((step) => stringAt(step, 'actionId'))
    const plannedPairs = mappings.filter((mapping) => stringAt(mapping, 'caseId') === caseId
      && caseSteps.has(stringAt(mapping, 'stepId')) && caseActions.has(stringAt(mapping, 'actionId')))
      .map((mapping) => `${stringAt(mapping, 'stepId')}\0${stringAt(mapping, 'actionId')}`)
    const resultPairs = stepResults.map((step) => `${stringAt(step, 'stepId')}\0${stringAt(step, 'actionId')}`)
    const status = stringAt(caseResult, 'status')
    const terminal = status === 'passed' || status === 'failed'
    const resultSetIncomplete = caseSteps.size === 0 || caseActions.size === 0
      || caseSteps.size !== caseActions.size || plannedPairs.length !== caseSteps.size
      || new Set(plannedPairs).size !== plannedPairs.length
      || resultStepIds.length !== plannedPairs.length || new Set(resultStepIds).size !== resultStepIds.length
      || new Set(resultActionIds).size !== resultActionIds.length
      || resultPairs.some((pair) => !plannedPairs.includes(pair))
    const passedDerivationInvalid = status === 'passed' && stepResults.some((step) =>
      stringAt(step, 'status') !== 'passed' || stringAt(step, 'oracleResult') !== 'passed')
    const failedDerivationInvalid = status === 'failed' && !stepResults.some((step) =>
      stringAt(step, 'status') === 'failed' || stringAt(step, 'oracleResult') === 'failed')
    if ((terminal && resultSetIncomplete) || passedDerivationInvalid || failedDerivationInvalid) {
      add('E2E_GENERATION_CASE_STATUS_DERIVATION_INVALID', 'browser-results', caseId)
    }
    for (const stepResult of stepResults) {
      const stepId = stringAt(stepResult, 'stepId')
      const actionId = stringAt(stepResult, 'actionId')
      const resultEvidence = stringsAt(stepResult, 'evidenceIds')
      const bound = mappings.some((mapping) => stringAt(mapping, 'caseId') === caseId
        && stringAt(mapping, 'stepId') === stepId && stringAt(mapping, 'actionId') === actionId)
      if (!bundleCases.has(caseId) || !caseSteps.has(stepId) || !caseActions.has(actionId) || !bound) {
        add('E2E_GENERATION_RESULT_REFERENCE_INVALID', 'browser-results', `${caseId}:${stepId}:${actionId}`)
      }
      if (['passed', 'failed'].includes(stringAt(stepResult, 'status'))
        && (stringAt(stepResult, 'actualDigest') === ''
          || stringAt(stepResult, 'oracleResult') === 'not-evaluated'
          || resultEvidence.length === 0)) {
        add('E2E_GENERATION_RESULT_INCOMPLETE', 'browser-results', `${caseId}:${stepId}`)
      }
      if (resultEvidence.some((id) => !evidenceIds.has(id))) {
        add('E2E_GENERATION_EVIDENCE_REFERENCE_BROKEN', 'browser-results', `${caseId}:${stepId}`)
      }
      const fullProgram = fullProgramsByAction.get(actionId)
      if (fullProgram !== undefined && terminal) {
        const plans = arrayAt(fullProgram, 'oracleCheckpoints')
        const checkpoints = arrayAt(stepResult, 'oracleCheckpoints')
        const receiptEvidenceIds = new Set(arrayAt(caseResult, 'executionOutcomeReceipts')
          .flatMap((receipt) => stringsAt(receipt, 'evidenceIds')))
        const valid = plans.length > 0 && checkpoints.length === plans.length
          && plans.every((plan) => checkpoints.some((checkpoint) =>
            stringAt(checkpoint, 'checkpointId') === stringAt(plan, 'checkpointId')
            && stringAt(checkpoint, 'oracleId') === stringAt(plan, 'oracleId')
            && stringAt(checkpoint, 'expectedJson') === stringAt(plan, 'expectedJson')
            && stringAt(checkpoint, 'expectedDigest') === stringAt(plan, 'expectedDigest')
            && stringsAt(checkpoint, 'evidenceIds').length > 0
            && stringsAt(checkpoint, 'evidenceIds').every((id) => receiptEvidenceIds.has(id))))
          && (status !== 'passed' || checkpoints.every((checkpoint) => stringAt(checkpoint, 'status') === 'passed'))
        if (!valid) add('E2E_GENERATION_ORACLE_CHECKPOINT_INCOMPLETE', 'browser-results',
          `${caseId}:${stepId}:${actionId}`)
      }
      for (const evidenceId of resultEvidence) {
        const evidence = evidenceRecords.find((item) => stringAt(item, 'evidenceId') === evidenceId)
        if (evidence && stringAt(evidence, 'caseId') !== caseId) {
          add('E2E_GENERATION_EVIDENCE_CASE_MISMATCH', 'browser-results', `${caseId}:${evidenceId}`)
        }
        if (evidence && evidenceLevelRank(stringAt(evidence, 'evidenceLevel'))
          < evidenceLevelRank(requiredEvidenceLevel.get(caseId) ?? '')) {
          add('E2E_GENERATION_EVIDENCE_LEVEL_INSUFFICIENT', 'browser-evidence', evidenceId)
        }
      }
    }
  }

  const actualByPath = new Map(actualFiles.map((file) => [file.relativePath, file]))
  for (const evidence of evidenceRecords) {
    const path = stringAt(evidence, 'relativePath')
    const evidenceId = stringAt(evidence, 'evidenceId')
    const sanitizationRecord = objectAt(evidence, 'sanitizationRecord')
    const sanitizerProof = sanitizerProofs.get(evidenceId)
    const actual = actualByPath.get(path)
    if (!sanitizerProof) {
      add('E2E_GENERATION_SANITIZER_PROOF_MISSING', 'browser-evidence', evidenceId)
    } else {
      const proofRecord = objectAt(sanitizerProof, 'record')
      const attestation = objectAt(sanitizerProof, 'attestation') as SanitizerAttestation
      const bytes = actual?.bytes
      const expectedBinding: SanitizerAttestationBinding | undefined = bytes ? {
        evidenceId, relativePath: path, evidenceType: stringAt(sanitizationRecord, 'evidenceType') as SanitizerAttestationBinding['evidenceType'],
        sanitizerVersion: stringAt(sanitizationRecord, 'sanitizerVersion'),
        recordDigest: digestText('sanitization-record/v1', canonicalizeJson(sanitizationRecord)),
        outputDigest: stringAt(sanitizationRecord, 'outputDigest'), policyDigest: stringAt(sanitizationRecord, 'policyDigest'),
        fileDigest: digestBytes(`generation-file:${path}`, bytes),
        sanitizedBytesDigest: digestBytes('sanitizer-output/v1', bytes),
      } : undefined
      if (canonicalizeJson(proofRecord) !== canonicalizeJson(sanitizationRecord) || !expectedBinding
        || !dependencies?.verifySanitizerAttestation) {
        add('E2E_GENERATION_SANITIZER_PROOF_MISMATCH', 'browser-evidence', evidenceId)
      } else try {
        if (!dependencies.verifySanitizerAttestation(attestation, expectedBinding)) {
          add('E2E_GENERATION_SANITIZER_PROOF_SIGNATURE_INVALID', 'browser-evidence', evidenceId)
        }
      } catch { add('E2E_GENERATION_SANITIZER_PROOF_VERIFIER_ERROR', 'browser-evidence', evidenceId) }
      if (!bytes) add('E2E_GENERATION_EVIDENCE_BYTES_MISSING', 'browser-evidence', evidenceId)
      if (expectedBinding && (stringAt(attestation, 'signedDigest') === ''
        || canonicalizeJson(Object.fromEntries(Object.entries(attestation).filter(([key]) =>
          !['schemaVersion', 'issuer', 'keyId', 'purpose', 'algorithm', 'signedDigest', 'signature'].includes(key))))
          !== canonicalizeJson(expectedBinding))) {
        add('E2E_GENERATION_SANITIZER_PROOF_BINDING_MISMATCH', 'browser-evidence', evidenceId)
      }
      const compatibility = objectAt(sanitizationRecord, 'formatCompatibility')
      const scanResult = objectAt(sanitizationRecord, 'scanResult')
      const manualReview = objectAt(sanitizationRecord, 'manualReview')
      const reviewStateValid = manualReview.required === true
        ? stringAt(manualReview, 'status') === 'pending'
        : manualReview.required === false && stringAt(manualReview, 'status') === 'not-required'
      if (stringAt(compatibility, 'status') !== 'compatible'
        || stringAt(scanResult, 'status') !== 'clean'
        || !reviewStateValid) {
        add('E2E_GENERATION_SANITIZER_PROOF_UNSAFE', 'browser-evidence', evidenceId)
      }
    }
    const privacyReview = privacyReviews.get(evidenceId)
    const reviewStatus = privacyReview ? stringAt(privacyReview, 'status') : ''
    const manualReview = objectAt(sanitizationRecord, 'manualReview')
    const attestation = sanitizerProof ? objectAt(sanitizerProof, 'attestation') : {}
    const proofDigest = digestText('sanitizer-attestation/v1', canonicalizeJson(attestation))
    if (!privacyReview) {
      add('E2E_GENERATION_PRIVACY_REVIEW_INCOMPLETE', 'browser-evidence', evidenceId)
    } else if (reviewStatus === 'not-required') {
      const expectedDerivation = digestText('privacy-review-not-required/v1', canonicalizeJson({ evidenceId,
        recordDigest: digestText('sanitization-record/v1', canonicalizeJson(sanitizationRecord)),
        sanitizerProofDigest: proofDigest, policyDigest: stringAt(sanitizationRecord, 'policyDigest'), status: 'not-required' }))
      if (manualReview.required !== false || stringAt(manualReview, 'status') !== 'not-required'
        || stringAt(privacyReview, 'derivationDigest') !== expectedDerivation) {
        add('E2E_GENERATION_PRIVACY_REVIEW_NOT_REQUIRED_INVALID', 'browser-evidence', evidenceId)
      }
    } else if (reviewStatus === 'approved' || reviewStatus === 'rejected') {
      const receipt = objectAt(privacyReview, 'receipt') as PrivacyReviewReceipt
      const binding: PrivacyReviewReceiptBinding = {
        evidenceId, relativePath: path, fileDigest: stringAt(evidence, 'digest'),
        outputDigest: stringAt(sanitizationRecord, 'outputDigest'), sanitizerProofDigest: proofDigest,
        policyDigest: stringAt(sanitizationRecord, 'policyDigest'), decision: reviewStatus,
        checkedAt: stringAt(receipt, 'checkedAt'), approver: objectAt(receipt, 'approver') as PrivacyReviewReceiptBinding['approver'],
      }
      if (manualReview.required !== true || stringAt(manualReview, 'status') !== 'pending'
        || !dependencies?.verifyPrivacyReviewReceipt) {
        add('E2E_GENERATION_PRIVACY_REVIEW_INCOMPLETE', 'browser-evidence', evidenceId)
      } else {
      try {
          if (!dependencies.verifyPrivacyReviewReceipt(receipt, binding)) {
            add('E2E_GENERATION_PRIVACY_REVIEW_SIGNATURE_INVALID', 'browser-evidence', evidenceId)
          }
      } catch {
        add('E2E_GENERATION_PRIVACY_REVIEW_VERIFIER_ERROR', 'browser-evidence', evidenceId)
      }
      }
      if (reviewStatus === 'rejected') add('E2E_GENERATION_PRIVACY_REVIEW_REJECTED', 'browser-evidence', evidenceId)
    } else {
      add('E2E_GENERATION_PRIVACY_REVIEW_INCOMPLETE', 'browser-evidence', evidenceId)
    }
    if (!isSafeRelativePath(path)) add('E2E_GENERATION_EVIDENCE_PATH_INVALID', 'browser-evidence', path)
    if (!actual) add('E2E_GENERATION_EVIDENCE_FILE_MISSING', 'browser-evidence', path)
    else {
      if (actual.digest !== stringAt(evidence, 'digest')) add('E2E_GENERATION_EVIDENCE_DIGEST_MISMATCH', 'browser-evidence', path)
      if (actual.byteLength !== numberAt(evidence, 'byteLength')) add('E2E_GENERATION_EVIDENCE_SIZE_MISMATCH', 'browser-evidence', path)
      if (actual.sanitizerOutputDigest === undefined
        || actual.sanitizerOutputDigest !== stringAt(sanitizationRecord, 'outputDigest')) {
        add('E2E_GENERATION_SANITIZER_OUTPUT_DIGEST_MISMATCH', 'browser-evidence', evidenceId)
      }
    }
  }

  const runBundleArtifact = byType.get('run-bundle')
  const runBundleBinding = stringAt(grants, 'runBundleDigest') || stringAt(grants, 'approvalSubjectDigest')
  if (runBundleBinding !== runBundleArtifact?.contentDigest) {
    add('E2E_GENERATION_APPROVAL_SUBJECT_MISMATCH', 'approval-grants', runBundleArtifact?.artifactId ?? 'run-bundle')
  }
  const grantReceipts = arrayAt(grants, 'grants')
  const receiptCapabilities = grantReceipts.flatMap((receipt) => arrayAt(receipt, 'capabilities'))
  if (stringAt(grants, 'runBundleDigest') !== ''
    && !safeCanonicalArrayEquals(receiptCapabilities, signedCapabilities, 'capabilityId')) {
    add('E2E_GENERATION_APPROVAL_CAPABILITY_MISMATCH', 'approval-grants', 'signedCapabilities')
  }
  const preflightArtifact = byType.get('browser-preflight')
  const preflight = content('browser-preflight')
  const policyArtifact = byType.get('project-policy')
  const modelArtifact = byType.get('requirement-model')
  const scopeArtifact = byType.get('acceptance-scope')
  const casesArtifact = byType.get('test-cases')
  const actionMapArtifact = byType.get('browser-action-map')
  const execution = content('execution-contract')
  for (const receiptRecord of grantReceipts) {
    const receipt = receiptRecord as unknown as ApprovalFreshnessReceipt
    const snapshot = objectAt(receiptRecord, 'executionSubjectSnapshot')
    const currentSubject = {
      ...snapshot,
      assetId: runBundleArtifact?.assetId ?? '',
      prdRevision: runBundleArtifact?.prdRevision ?? '',
      scopeDigest: digestApprovalProjection('acceptance-scope', scope),
      requirementModelDigest: digestApprovalProjection('requirement-model', model),
      coveragePolicyDigest: stringAt(coverage, 'coveragePolicyDigest'),
      universeDigest: stringAt(coverage, 'universeDigest'),
      caseDigest: digestApprovalProjection('test-cases', cases),
      actionMapDigest: digestApprovalProjection('browser-action-map', actionMap),
      policyDigest: digestApprovalProjection('project-policy', content('project-policy')),
      executionContractDigest: digestApprovalProjection('execution-contract', execution),
      runBundleProjectionDigest: digestApprovalProjection('run-bundle', runBundle),
      environment: stringAt(execution, 'environment').toLowerCase(),
      baseOrigin: stringAt(execution, 'baseOrigin'),
      actor: stringAt(preflight, 'observedActor'),
      discoveryGrantId: stringAt(preflight, 'discoveryGrantId'),
      preflightDigest: stringAt(preflight, 'authorityPreflightDigest'),
    } as ReadApprovalSubject | WriteApprovalSubject
    const binding: ApprovalFreshnessAuditBinding = {
      currentSubject,
      expectedCapabilities: arrayAt(receiptRecord, 'capabilities') as unknown as ApprovalCapabilityRecord[],
      browserPreflight: {
        artifactDigest: preflightArtifact?.contentDigest ?? '',
        discoveryGrantId: stringAt(preflight, 'discoveryGrantId'),
        authorityPreflightDigest: stringAt(preflight, 'authorityPreflightDigest'),
      },
      runBundle: { artifactDigest: runBundleArtifact?.contentDigest ?? '', content: runBundle },
    }
    if (!safeCanonicalEquals(snapshot, currentSubject)
      || stringAt(receiptRecord, 'browserPreflightArtifactDigest') !== binding.browserPreflight.artifactDigest
      || stringAt(receiptRecord, 'runBundleDigest') !== binding.runBundle.artifactDigest
      || stringAt(receiptRecord, 'runBundleDigest') !== stringAt(grants, 'runBundleDigest')) {
      add('E2E_GENERATION_APPROVAL_SUBJECT_MISMATCH', 'approval-grants', stringAt(receiptRecord, 'grantId'))
    }
    if (!dependencies?.verifyApprovalFreshnessReceipt) {
      add('E2E_GENERATION_APPROVAL_FRESHNESS_VERIFIER_UNAVAILABLE', 'approval-grants', stringAt(receiptRecord, 'grantId'))
    } else {
      try {
        const verification = dependencies.verifyApprovalFreshnessReceipt(receipt, binding)
        const verificationRecord = verification as unknown
        if (!isPlainObject(verificationRecord)
          || !hasExactKeys(verificationRecord, ['authentic', 'current', 'allowed', 'status'])
          || verificationRecord.authentic !== true || verificationRecord.current !== true
          || typeof verificationRecord.allowed !== 'boolean'
          || verificationRecord.status !== stringAt(receiptRecord, 'status')
          || verificationRecord.allowed !== (stringAt(receiptRecord, 'status') === 'valid')) {
          add('E2E_GENERATION_APPROVAL_FRESHNESS_INVALID', 'approval-grants', stringAt(receiptRecord, 'grantId'))
        }
      } catch {
        add('E2E_GENERATION_APPROVAL_FRESHNESS_VERIFIER_ERROR', 'approval-grants', stringAt(receiptRecord, 'grantId'))
      }
    }
  }
  const gatewayEvents = arrayAt(gateway, 'requestEvents')
  const gatewayReservations = arrayAt(gateway, 'capabilityReservations')
  const auditedActionIds = gatewayExecutionActionIds(gateway)
  const signedCounters = objectAt(gateway, 'signedCounters')
  const invalidReservationDigest = gatewayReservations.some((item) => {
    const reservation = {
      reservationId: stringAt(item, 'reservationId'), grantId: stringAt(item, 'grantId'),
      capabilityId: stringAt(item, 'capabilityId'), actionId: stringAt(item, 'actionId'),
      attemptId: stringAt(item, 'attemptId'),
      ...(isPlainObject(item.attemptContext) ? { attemptContext: item.attemptContext } : {}),
      status: stringAt(item, 'status'),
      ...(typeof item.outcomeDigest === 'string' ? { outcomeDigest: item.outcomeDigest } : {}),
      ...(typeof item.observation === 'string' ? { observation: item.observation } : {}),
      reservedAt: stringAt(item, 'reservedAt'),
    }
    return stringAt(item, 'digest') !== digestText('gateway-capability-reservation/v1', canonicalizeJson({
      reservation, consumed: item.consumed === true,
    }))
  })
  const expectedGatewayCounterDigest = digestText('gateway-audit-counters/v1', canonicalizeJson({
    gatewayInstance: objectAt(gateway, 'gatewayInstance'),
    policyDigest: stringAt(gateway, 'policyDigest'),
    forwarded: gatewayEvents.filter((item) => stringAt(item, 'decision') === 'forwarded').length,
    blocked: gatewayEvents.filter((item) => stringAt(item, 'decision') === 'blocked').length,
    injected: gatewayEvents.filter((item) => stringAt(item, 'decision') === 'injected').length,
    requestEvents: gatewayEvents,
    capabilityReservations: gatewayReservations,
  }))
  const gatewaySignature = objectAt(signedCounters, 'signature')
  if (gatewayEvents.some((item, index) => numberAt(item, 'sequence') !== index)
    || new Set(gatewayReservations.map((item) => stringAt(item, 'digest'))).size !== gatewayReservations.length
    || invalidReservationDigest
    || numberAt(signedCounters, 'forwarded') !== gatewayEvents.filter((item) => stringAt(item, 'decision') === 'forwarded').length
    || numberAt(signedCounters, 'blocked') !== gatewayEvents.filter((item) => stringAt(item, 'decision') === 'blocked').length
    || numberAt(signedCounters, 'injected') !== gatewayEvents.filter((item) => stringAt(item, 'decision') === 'injected').length
    || stringAt(signedCounters, 'digest') !== expectedGatewayCounterDigest
    || stringAt(gatewaySignature, 'signedDigest') !== expectedGatewayCounterDigest
    || !dependencies?.verifyGatewayAuditSignature) {
    add('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID', 'gateway-audit', 'signedCounters')
  } else {
    try {
      if (!dependencies.verifyGatewayAuditSignature(gatewaySignature as ArtifactDocument['signatures'][number])) {
        add('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID', 'gateway-audit', 'signedCounters')
      }
    } catch {
      add('E2E_GENERATION_GATEWAY_AUDIT_VERIFIER_ERROR', 'gateway-audit', 'signedCounters')
    }
  }
  const gatewaySessions = arrayAt(gateway, 'sessions')
  if (gatewaySessions.length > 0) {
    const resultsById = new Map(arrayAt(browserResults, 'caseResults')
      .map((item) => [stringAt(item, 'resultId'), item]))
    const sessionResultIds = gatewaySessions.map((session) => stringAt(session, 'resultId')).sort()
    const expectedResultIds = [...resultsById.keys()].sort()
    if (canonicalizeJson(sessionResultIds) !== canonicalizeJson(expectedResultIds)) {
      add('E2E_GENERATION_GATEWAY_SESSION_RESULT_SET_MISMATCH', 'gateway-audit', 'sessions')
    }
    for (const session of gatewaySessions) {
      const resultId = stringAt(session, 'resultId')
      const domain = stringAt(session, 'domain')
      const audit = objectAt(session, 'audit')
      const verifierMaterial = objectAt(session, 'verifierMaterial')
      const result = resultsById.get(resultId)
      const signature = objectAt(objectAt(audit, 'signedCounters'), 'signature')
      if (result === undefined || stringAt(result, 'mode') !== domain
        || canonicalizeJson(objectAt(verifierMaterial, 'gatewayInstance'))
          !== canonicalizeJson(objectAt(audit, 'gatewayInstance'))
        || !gatewayPublicationAuditInternallyValid(audit)) {
        add('E2E_GENERATION_GATEWAY_SESSION_BINDING_INVALID', 'gateway-audit', resultId)
        continue
      }
      if (!dependencies?.verifyGatewayAuditSignature) {
        add('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID', 'gateway-audit', resultId)
      } else try {
        if (!dependencies.verifyGatewayAuditSignature(signature as ArtifactDocument['signatures'][number])) {
          add('E2E_GENERATION_GATEWAY_AUDIT_SIGNATURE_INVALID', 'gateway-audit', resultId)
        }
      } catch {
        add('E2E_GENERATION_GATEWAY_AUDIT_VERIFIER_ERROR', 'gateway-audit', resultId)
      }
      if (domain === 'gateway-injection') {
        const grant = objectAt(session, 'grant')
        const capabilities = arrayAt(grant, 'capabilities')
        const reservations = arrayAt(audit, 'capabilityReservations')
        const events = arrayAt(audit, 'requestEvents')
        if (numberAt(objectAt(audit, 'signedCounters'), 'forwarded') !== 0
          || numberAt(objectAt(audit, 'signedCounters'), 'blocked') !== 0
          || numberAt(objectAt(audit, 'signedCounters'), 'injected') < 1
          || events.some((event) => stringAt(event, 'decision') !== 'injected')
          || reservations.length === 0
          || reservations.some((reservation) => stringAt(reservation, 'grantId') !== stringAt(grant, 'grantId')
            || stringAt(reservation, 'attemptId') !== stringAt(result, 'attemptId')
            || !capabilities.some((capability) =>
              stringAt(capability, 'capabilityId') === stringAt(reservation, 'capabilityId')
              && stringAt(capability, 'actionId') === stringAt(reservation, 'actionId')
              && stringAt(capability, 'transport') === 'gateway-injection'))) {
          add('E2E_GENERATION_INJECTION_SESSION_SAFETY_INVALID', 'gateway-audit', resultId)
        }
      }
    }
  }
  const executionGatewayReservations = gatewaySessions.length === 0
    ? gatewayReservations
    : gatewaySessions
      .filter((session) => stringAt(session, 'domain') === 'real-environment')
      .flatMap((session) => arrayAt(objectAt(session, 'audit'), 'capabilityReservations'))
  auditExecutionOutcomeReceipts({ browserResults, actionMap, gateway, leases, cleanup, cases, runBundle,
    context: { assetId: artifacts[0]?.assetId ?? '', generationId: artifacts[0]?.generationId ?? '',
      prdRevision: artifacts[0]?.prdRevision ?? '', runId: stringAt(runBundle, 'runId') } },
    dependencies?.verifyExecutionOutcomeReceipt, add)
  for (const actionId of bundleActions) {
    if (!auditedActionIds.has(actionId)) {
      add('E2E_GENERATION_GATEWAY_COVERAGE_INCOMPLETE', 'gateway-audit', actionId)
    }
  }
  const realBrowserResults = arrayAt(browserResults, 'caseResults')
    .filter((caseResult) => stringAt(caseResult, 'mode') === 'real-environment')
  const realAttemptIds = new Set(realBrowserResults.map((caseResult) => stringAt(caseResult, 'attemptId')))
  const executedActionIds = new Set(realBrowserResults.flatMap((caseResult) =>
    arrayAt(caseResult, 'stepResults').filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status')))
      .map((step) => stringAt(step, 'actionId'))))
  const executionByActionId = new Map(realBrowserResults.flatMap((caseResult) =>
    arrayAt(caseResult, 'stepResults').map((step) => [stringAt(step, 'actionId'), caseResult] as const)))
  const signedCapabilityIds = new Set(signedCapabilities.map((item) => stringAt(item, 'capabilityId')))
  for (const reservation of v2ApprovalFacts ? executionGatewayReservations : []) {
    const capabilityId = stringAt(reservation, 'capabilityId')
    if (!signedCapabilityIds.has(capabilityId)) {
      add('E2E_GENERATION_GATEWAY_CAPABILITY_UNKNOWN', 'gateway-audit', capabilityId)
    }
  }
  for (const mapping of v2ApprovalFacts
    ? mappings.filter((item) => executedActionIds.has(stringAt(item, 'actionId'))) : []) {
    const actionId = stringAt(mapping, 'actionId')
    for (const capability of arrayAt(mapping, 'capabilities')) {
      const capabilityId = stringAt(capability, 'capabilityId')
      const matches = executionGatewayReservations.filter((reservation) =>
        stringAt(reservation, 'capabilityId') === capabilityId
        && realAttemptIds.has(stringAt(reservation, 'attemptId')))
      if (matches.length !== 1 || stringAt(matches[0] ?? {}, 'actionId') !== actionId
        || matches[0]?.consumed !== true) {
        add('E2E_GENERATION_GATEWAY_CAPABILITY_CONSUMPTION_INVALID', 'gateway-audit', `${actionId}:${capabilityId}`)
      } else if (stringAt(mapping, 'effect') === 'reversible-write') {
        const reservation = matches[0]!
        const caseResult = executionByActionId.get(actionId) ?? {}
        const attemptContext = objectAt(reservation, 'attemptContext')
        if (stringAt(reservation, 'status') !== 'completed' || stringAt(reservation, 'outcomeDigest') === ''
          || stringAt(reservation, 'attemptId') !== stringAt(caseResult, 'attemptId')
          || stringAt(attemptContext, 'assetId') !== (runBundleArtifact?.assetId ?? '')
          || stringAt(attemptContext, 'generationId') !== (runBundleArtifact?.generationId ?? '')
          || stringAt(attemptContext, 'prdRevision') !== (runBundleArtifact?.prdRevision ?? '')
          || stringAt(attemptContext, 'runId') !== stringAt(runBundle, 'runId')
          || stringAt(attemptContext, 'caseId') !== stringAt(caseResult, 'caseId')) {
          add('E2E_GENERATION_GATEWAY_WRITE_RESERVATION_BINDING_INVALID', 'gateway-audit', `${actionId}:${capabilityId}`)
        }
      }
    }
  }
  const cleanupLeaseIds = new Set(arrayAt(cleanup, 'leaseResults').map((item) => stringAt(item, 'leaseId')))
  for (const lease of arrayAt(leases, 'leases')) {
    const leaseId = stringAt(lease, 'leaseId')
    if (!cleanupLeaseIds.has(leaseId)) add('E2E_GENERATION_CLEANUP_COVERAGE_INCOMPLETE', 'cleanup-results', leaseId)
  }
  const regressionBlockedIds = arrayAt(regression, 'blockedCases').map((item) => stringAt(item, 'caseId'))
  if (new Set(regressionBlockedIds).size !== regressionBlockedIds.length
    || regressionBlockedIds.some((caseId) => !activeCaseIds.has(caseId))) {
    add('E2E_GENERATION_REGRESSION_BLOCKED_CASE_INVALID', 'regression-manifest', regressionBlockedIds.join(','))
  }
  const executableRegressionCaseIds = [...activeCaseIds]
    .filter((caseId) => !regressionBlockedIds.includes(caseId))
  compareSets(arrayAt(regression, 'caseMappings').map((item) => stringAt(item, 'caseId')), executableRegressionCaseIds,
    'E2E_GENERATION_REGRESSION_CASE_MISMATCH', 'regression-manifest')
  compareSets(stringsAt(objectAt(regression, 'listResult'), 'caseIds'), executableRegressionCaseIds,
    'E2E_GENERATION_PLAYWRIGHT_LIST_MISMATCH', 'regression-manifest')
  auditRegressionDiscovery()

  findings.sort((left, right) => left.code.localeCompare(right.code)
    || left.artifactId.localeCompare(right.artifactId) || left.ref.localeCompare(right.ref))
  return { valid: findings.length === 0, findings }

  function content(type: string): Record<string, unknown> {
    const value = byType.get(type)?.content
    return isPlainObject(value) ? value : {}
  }
  function add(code: string, type: string, ref: string): void {
    findings.push({ code, artifactId: byType.get(type)?.artifactId ?? type, ref })
  }
  function compareSets(actual: string[], expected: string[], code: string, type: string): void {
    const left = [...new Set(actual)].sort()
    const right = [...new Set(expected)].sort()
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
      add(code, type, `${left.join(',')}!=${right.join(',')}`)
    }
  }
  function auditRegressionDiscovery(): void {
    const envelope = byType.get('regression-manifest')
    if (!envelope || envelope.schemaVersion !== '2.0.0') return
    const listResult = objectAt(regression, 'listResult')
    const parsedAttestation = RegressionDiscoveryAttestationSchema.safeParse(listResult.attestation)
    if (!parsedAttestation.success) {
      add('E2E_GENERATION_REGRESSION_DISCOVERY_ATTESTATION_INVALID', 'regression-manifest', 'listResult.attestation')
      return
    }
    const { issuer: _issuer, keyId: _keyId, purpose: _purpose, algorithm: _algorithm,
      signedDigest: _signedDigest, signature: _signature, ...unsigned } = parsedAttestation.data
    const subjectCandidate = {
      ...unsigned,
      assetId: envelope.assetId,
      generationId: envelope.generationId,
      prdRevision: envelope.prdRevision,
      templateDigest: stringAt(regression, 'templateDigest'),
      toolchain: objectAt(regression, 'toolchain'),
      sourceFiles: arrayAt(regression, 'sourceFiles'),
      caseMappings: arrayAt(regression, 'caseMappings'),
      discoveredCaseIds: stringsAt(listResult, 'caseIds'),
      blockedCases: arrayAt(regression, 'blockedCases'),
    }
    const parsedSubject = RegressionDiscoverySubjectSchema.safeParse(subjectCandidate)
    if (!parsedSubject.success) {
      add('E2E_GENERATION_REGRESSION_DISCOVERY_SUBJECT_MISMATCH', 'regression-manifest', 'subject')
      return
    }
    if (stringAt(listResult, 'digest') !== parsedSubject.data.isolation.stdoutDigest) {
      add('E2E_GENERATION_REGRESSION_DISCOVERY_STDOUT_MISMATCH', 'regression-manifest', 'listResult.digest')
    }
    const actualRegressionFiles = actualFiles.filter((file) => file.relativePath.startsWith('regression/'))
    const actualByPath = new Map(actualRegressionFiles.map((file) => [file.relativePath, file]))
    const declaredPaths = new Set(parsedSubject.data.sourceFiles.map((file) => file.relativePath))
    if (actualByPath.size !== declaredPaths.size || [...actualByPath.keys()].some((path) => !declaredPaths.has(path))) {
      add('E2E_GENERATION_REGRESSION_SOURCE_SET_MISMATCH', 'regression-manifest', 'sourceFiles')
    }
    for (const source of parsedSubject.data.sourceFiles) {
      const actual = actualByPath.get(source.relativePath)
      if (!actual?.bytes) {
        add('E2E_GENERATION_REGRESSION_SOURCE_BYTES_MISSING', 'regression-manifest', source.relativePath)
        continue
      }
      const bytes = Buffer.from(actual.bytes)
      if (bytes.byteLength !== source.byteLength
        || digestBytes(`generation-file:${source.relativePath}`, bytes) !== source.digest
        || actual.byteLength !== source.byteLength || actual.digest !== source.digest) {
        add('E2E_GENERATION_REGRESSION_SOURCE_BYTES_MISMATCH', 'regression-manifest', source.relativePath)
      }
      if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(source.relativePath)
        && findForbiddenRegressionTestDispositions(bytes.toString('utf8')).length > 0) {
        add('E2E_GENERATION_REGRESSION_FORBIDDEN_DISPOSITION', 'regression-manifest', source.relativePath)
      }
    }
    if (!dependencies?.verifyRegressionDiscoveryAttestation) {
      add('E2E_GENERATION_REGRESSION_DISCOVERY_VERIFIER_UNAVAILABLE', 'regression-manifest', 'listResult.attestation')
      return
    }
    try {
      if (!dependencies.verifyRegressionDiscoveryAttestation(parsedAttestation.data, parsedSubject.data)) {
        add('E2E_GENERATION_REGRESSION_DISCOVERY_SIGNATURE_INVALID', 'regression-manifest', 'listResult.attestation')
      }
    } catch {
      add('E2E_GENERATION_REGRESSION_DISCOVERY_VERIFIER_ERROR', 'regression-manifest', 'listResult.attestation')
    }
  }
  function define(kind: string, id: string, type: string): void {
    if (id === '') return
    const key = `${kind}:${id}`
    const owner = derivedDefinitions.get(key)
    if (owner) add('E2E_GENERATION_DUPLICATE_ID', type, `${key}:${owner}`)
    else derivedDefinitions.set(key, byType.get(type)?.artifactId ?? type)
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function gatewayExecutionClosureComplete(
  actionMap: Record<string, unknown>, runBundle: Record<string, unknown>,
  browserResults: Record<string, unknown>, gateway: Record<string, unknown>,
): boolean {
  const signedCapabilityIds = new Set(arrayAt(runBundle, 'signedCapabilities')
    .map((item) => stringAt(item, 'capabilityId')))
  const sessions = arrayAt(gateway, 'sessions')
  const reservations = sessions.length === 0
    ? arrayAt(gateway, 'capabilityReservations')
    : sessions
      .filter((session) => stringAt(session, 'domain') === 'real-environment')
      .flatMap((session) => arrayAt(objectAt(session, 'audit'), 'capabilityReservations'))
  if (reservations.some((item) => !signedCapabilityIds.has(stringAt(item, 'capabilityId')))) return false
  const realResults = arrayAt(browserResults, 'caseResults')
    .filter((caseResult) => stringAt(caseResult, 'mode') === 'real-environment')
  const realAttemptIds = new Set(realResults.map((caseResult) => stringAt(caseResult, 'attemptId')))
  const executedActionIds = new Set(realResults.flatMap((caseResult) =>
    arrayAt(caseResult, 'stepResults').filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status')))
      .map((step) => stringAt(step, 'actionId'))))
  for (const mapping of arrayAt(actionMap, 'actions').filter((item) => executedActionIds.has(stringAt(item, 'actionId')))) {
    const actionId = stringAt(mapping, 'actionId')
    for (const capability of arrayAt(mapping, 'capabilities')) {
      const matches = reservations.filter((item) =>
        stringAt(item, 'capabilityId') === stringAt(capability, 'capabilityId')
        && realAttemptIds.has(stringAt(item, 'attemptId')))
      if (matches.length !== 1 || stringAt(matches[0]!, 'actionId') !== actionId || matches[0]!.consumed !== true) return false
    }
  }
  return true
}

function gatewayExecutionActionIds(gateway: Record<string, unknown>): Set<string> {
  const sessions = arrayAt(gateway, 'sessions')
  const audits = sessions.length === 0
    ? [gateway]
    : sessions
      .filter((session) => stringAt(session, 'domain') === 'real-environment')
      .map((session) => objectAt(session, 'audit'))
  return new Set(audits.flatMap((audit) => [
    ...arrayAt(audit, 'requestEvents').map((item) => stringAt(item, 'actionId')),
    ...arrayAt(audit, 'capabilityReservations').map((item) => stringAt(item, 'actionId')),
  ]))
}

function auditExecutionOutcomeReceipts(
  sources: {
    browserResults: Record<string, unknown>
    actionMap: Record<string, unknown>
    gateway: Record<string, unknown>
    leases: Record<string, unknown>
    cleanup: Record<string, unknown>
    cases: Record<string, unknown>
    runBundle: Record<string, unknown>
    context: { assetId: string; generationId: string; prdRevision: string; runId: string }
  },
  verifyReceipt: ((receipt: ExecutionOutcomeReceipt) => boolean) | undefined,
  add: (code: string, artifactId: string, ref: string) => void,
): void {
  const effects = new Map(arrayAt(sources.actionMap, 'actions')
    .map((action) => [stringAt(action, 'actionId'), stringAt(action, 'effect')]))
  const cases = new Map(arrayAt(sources.cases, 'cases')
    .map((testCase) => [stringAt(testCase, 'caseId'), testCase]))
  const leases = new Map(arrayAt(sources.leases, 'leases')
    .map((lease) => [stringAt(lease, 'leaseId'), lease]))
  const cleanup = new Map(arrayAt(sources.cleanup, 'leaseResults')
    .map((result) => [stringAt(result, 'leaseId'), result]))
  const gatewaySessions = arrayAt(sources.gateway, 'sessions')

  for (const caseResult of arrayAt(sources.browserResults, 'caseResults')) {
    const caseId = stringAt(caseResult, 'caseId')
    const resultId = stringAt(caseResult, 'resultId')
    const sessionMatches = gatewaySessions.filter((session) =>
      stringAt(session, 'resultId') === resultId
      && stringAt(session, 'domain') === stringAt(caseResult, 'mode'))
    const resultGateway = gatewaySessions.length === 0
      ? sources.gateway
      : sessionMatches.length === 1
        ? objectAt(sessionMatches[0]!, 'audit')
        : {}
    const reservations = arrayAt(resultGateway, 'capabilityReservations')
    const events = arrayAt(resultGateway, 'requestEvents')
    const terminalWriteActions = arrayAt(caseResult, 'stepResults')
      .filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status'))
        && effects.get(stringAt(step, 'actionId')) === 'reversible-write')
    const expectedActionIds = new Set(terminalWriteActions.map((step) => stringAt(step, 'actionId')))
    const receipts = arrayAt(caseResult, 'executionOutcomeReceipts')
    for (const receipt of receipts) {
      const actionId = stringAt(receipt, 'actionId')
      if (!expectedActionIds.has(actionId)) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_UNEXPECTED', 'browser-results', `${caseId}:${actionId}`)
      }
    }
    for (const step of terminalWriteActions) {
      const actionId = stringAt(step, 'actionId')
      const matching = receipts.filter((receipt) => stringAt(receipt, 'actionId') === actionId)
      if (matching.length !== 1) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_MISSING', 'browser-results', `${caseId}:${actionId}`)
        continue
      }
      const receipt = matching[0]!
      const capability = objectAt(receipt, 'capability')
      const capabilityRecordMatches = arrayAt(sources.runBundle, 'signedCapabilities').filter((record) =>
        stringAt(record, 'capabilityId') === stringAt(receipt, 'capabilityId'))
      const capabilityRecord = capabilityRecordMatches[0] ?? {}
      const capabilityOperation = stringAt(capability, 'operation')
      if (capabilityRecordMatches.length !== 1
        || stringAt(capabilityRecord, 'actionId') !== actionId
        || !['http-request', 'full-playwright'].includes(capabilityOperation)
        || stringAt(capabilityRecord, 'operation') !== capabilityOperation
        || stringAt(capabilityRecord, 'effect') !== 'reversible-write'
        || stringAt(capabilityRecord, 'digest') !== digestText(
          'approval-capability/v1', canonicalizeJson(capability))) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_CAPABILITY_MISMATCH', 'run-bundle', `${caseId}:${actionId}`)
      }
      if (!verifyReceipt) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_VERIFIER_UNAVAILABLE', 'browser-results', `${caseId}:${actionId}`)
      } else {
        try {
          if (!verifyReceipt(receipt as unknown as ExecutionOutcomeReceipt)) {
            add('E2E_GENERATION_EXECUTION_OUTCOME_SIGNATURE_INVALID', 'browser-results', `${caseId}:${actionId}`)
          }
        } catch {
          add('E2E_GENERATION_EXECUTION_OUTCOME_VERIFIER_ERROR', 'browser-results', `${caseId}:${actionId}`)
        }
      }

      const attemptContext = objectAt(receipt, 'attemptContext')
      const stepEvidence = [...stringsAt(step, 'evidenceIds')].sort()
      const receiptEvidence = [...stringsAt(receipt, 'evidenceIds')].sort()
      const receiptGateway = objectAt(receipt, 'gateway')
      const receiptExecutionSessionId = stringAt(receiptGateway, 'executionSessionId')
      if (stringAt(receipt, 'attemptId') !== stringAt(caseResult, 'attemptId')
        || stringAt(receipt, 'status') !== stringAt(caseResult, 'status')
        || stringAt(receipt, 'effectObservation') !== stringAt(caseResult, 'effectObservation')
        || stringAt(attemptContext, 'assetId') !== sources.context.assetId
        || stringAt(attemptContext, 'generationId') !== sources.context.generationId
        || stringAt(attemptContext, 'prdRevision') !== sources.context.prdRevision
        || stringAt(attemptContext, 'runId') !== sources.context.runId
        || stringAt(attemptContext, 'caseId') !== caseId
        || !executionOutcomeEvidenceContextMatches({
          operation: capabilityOperation, actionId, executionSessionId: receiptExecutionSessionId,
          stepEvidence, receiptEvidence,
          oracleCheckpointEvidence: arrayAt(step, 'oracleCheckpoints')
            .flatMap((checkpoint) => stringsAt(checkpoint, 'evidenceIds')),
        })) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_CONTEXT_MISMATCH', 'browser-results', `${caseId}:${actionId}`)
      }

      const reservationId = stringAt(receipt, 'reservationId')
      const reservationMatches = reservations.filter((reservation) =>
        stringAt(reservation, 'reservationId') === reservationId)
      const reservation = reservationMatches[0] ?? {}
      if (reservationMatches.length !== 1
        || stringAt(reservation, 'status') !== 'completed'
        || reservation.consumed !== true
        || stringAt(reservation, 'outcomeDigest') !== stringAt(receipt, 'signedDigest')
        || stringAt(reservation, 'grantId') !== stringAt(receipt, 'grantId')
        || stringAt(reservation, 'capabilityId') !== stringAt(receipt, 'capabilityId')
        || stringAt(reservation, 'actionId') !== actionId
        || stringAt(reservation, 'attemptId') !== stringAt(receipt, 'attemptId')
        || !safeCanonicalEquals(objectAt(reservation, 'attemptContext'), attemptContext)) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_RESERVATION_MISMATCH', 'gateway-audit', `${caseId}:${actionId}`)
      }

      const gateway = receiptGateway
      const executionSessionId = receiptExecutionSessionId
      const sessionEvents = events.filter((event) =>
        stringAt(event, 'executionSessionId') === executionSessionId)
      const publishedForwarded = sessionEvents.filter((event) =>
        stringAt(event, 'decision') === 'forwarded').length
      const publishedBlocked = sessionEvents.filter((event) =>
        stringAt(event, 'decision') === 'blocked').length
      const received = numberAt(gateway, 'received')
      const forwarded = numberAt(gateway, 'forwarded')
      const blocked = numberAt(gateway, 'blocked')
      if (stringAt(gateway, 'policyDigest') !== stringAt(resultGateway, 'policyDigest')
        || (gatewaySessions.length > 0 && sessionMatches.length !== 1)
        || sessionEvents.some((event) => stringAt(event, 'actionId') !== actionId)
        || received !== forwarded + blocked
        || forwarded !== publishedForwarded || blocked !== publishedBlocked) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_GATEWAY_MISMATCH', 'gateway-audit', `${caseId}:${actionId}`)
      }

      const cleanupBinding = objectAt(receipt, 'cleanup')
      const leaseId = stringAt(cleanupBinding, 'leaseId')
      const lease = leases.get(leaseId) ?? {}
      const cleanupResult = cleanup.get(leaseId) ?? {}
      const testCase = cases.get(caseId) ?? {}
      const cleanupPlan = objectAt(cleanupResult, 'plan')
      let cleanupPlanDigest = ''
      try { cleanupPlanDigest = digestCleanupPlanDefinition(cleanupPlan as CleanupPlanDefinition) } catch {}
      if (stringAt(caseResult, 'cleanupRef') !== leaseId
        || stringAt(testCase, 'cleanupPlanId') !== stringAt(cleanupBinding, 'cleanupPlanId')
        || stringAt(lease, 'cleanupPlanDigest') !== stringAt(cleanupBinding, 'cleanupPlanDigest')
        || stringAt(cleanupPlan, 'cleanupPlanId') !== stringAt(cleanupBinding, 'cleanupPlanId')
        || stringAt(cleanupPlan, 'actionId') !== actionId
        || stringAt(cleanupPlan, 'leaseId') !== leaseId
        || cleanupPlanDigest !== stringAt(cleanupBinding, 'cleanupPlanDigest')
        || stringAt(cleanupResult, 'status') !== stringAt(cleanupBinding, 'status')
        || stringAt(cleanupResult, 'digest') !== stringAt(cleanupBinding, 'resultDigest')
        || stringAt(cleanupResult, 'leaseReceiptDigest') !== stringAt(cleanupBinding, 'leaseReceiptDigest')) {
        add('E2E_GENERATION_EXECUTION_OUTCOME_CLEANUP_MISMATCH', 'cleanup-results', `${caseId}:${actionId}`)
      }
    }
  }
}

function executionOutcomeEvidenceContextMatches(input: {
  operation: string
  actionId: string
  executionSessionId: string
  stepEvidence: string[]
  receiptEvidence: string[]
  oracleCheckpointEvidence: string[]
}): boolean {
  if (input.operation !== 'full-playwright') {
    return canonicalizeJson(input.stepEvidence) === canonicalizeJson(input.receiptEvidence)
  }
  const expectedReceiptEvidence = (['BEFORE', 'AFTER', 'CLEANUP'] as const).flatMap((stage) =>
    ['SCREENSHOT', 'DOM', 'URL', 'TRACE'].map((kind) => `${stage}-${kind}`))
  expectedReceiptEvidence.push(...input.oracleCheckpointEvidence)
  expectedReceiptEvidence.push(`GATEWAY-${input.executionSessionId}`)
  return canonicalizeJson(input.stepEvidence) === canonicalizeJson([`EVIDENCE-${input.actionId}`])
    && canonicalizeJson(input.receiptEvidence) === canonicalizeJson([...expectedReceiptEvidence].sort())
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key]
  return isPlainObject(nested) ? nested : {}
}

function gatewayPublicationAuditInternallyValid(audit: Record<string, unknown>): boolean {
  const events = arrayAt(audit, 'requestEvents')
  const reservations = arrayAt(audit, 'capabilityReservations')
  const counters = objectAt(audit, 'signedCounters')
  const invalidReservationDigest = reservations.some((item) => {
    const reservation = {
      reservationId: stringAt(item, 'reservationId'), grantId: stringAt(item, 'grantId'),
      capabilityId: stringAt(item, 'capabilityId'), actionId: stringAt(item, 'actionId'),
      attemptId: stringAt(item, 'attemptId'),
      ...(isPlainObject(item.attemptContext) ? { attemptContext: item.attemptContext } : {}),
      status: stringAt(item, 'status'),
      ...(typeof item.outcomeDigest === 'string' ? { outcomeDigest: item.outcomeDigest } : {}),
      ...(typeof item.observation === 'string' ? { observation: item.observation } : {}),
      reservedAt: stringAt(item, 'reservedAt'),
    }
    return stringAt(item, 'digest') !== digestText('gateway-capability-reservation/v1', canonicalizeJson({
      reservation, consumed: item.consumed === true,
    }))
  })
  const expectedDigest = digestText('gateway-audit-counters/v1', canonicalizeJson({
    gatewayInstance: objectAt(audit, 'gatewayInstance'), policyDigest: stringAt(audit, 'policyDigest'),
    forwarded: events.filter((item) => stringAt(item, 'decision') === 'forwarded').length,
    blocked: events.filter((item) => stringAt(item, 'decision') === 'blocked').length,
    injected: events.filter((item) => stringAt(item, 'decision') === 'injected').length,
    requestEvents: events, capabilityReservations: reservations,
  }))
  return !events.some((item, index) => numberAt(item, 'sequence') !== index)
    && new Set(reservations.map((item) => stringAt(item, 'digest'))).size === reservations.length
    && !invalidReservationDigest
    && numberAt(counters, 'forwarded') === events.filter((item) => stringAt(item, 'decision') === 'forwarded').length
    && numberAt(counters, 'blocked') === events.filter((item) => stringAt(item, 'decision') === 'blocked').length
    && numberAt(counters, 'injected') === events.filter((item) => stringAt(item, 'decision') === 'injected').length
    && stringAt(counters, 'digest') === expectedDigest
    && stringAt(objectAt(counters, 'signature'), 'signedDigest') === expectedDigest
}

function arrayAt(value: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const nested = value[key]
  return Array.isArray(nested) ? nested.filter(isPlainObject) : []
}

function stringsAt(value: Record<string, unknown>, key: string): string[] {
  const nested = value[key]
  return Array.isArray(nested) ? nested.filter((item): item is string => typeof item === 'string') : []
}

function stringAt(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : ''
}

function numberAt(value: Record<string, unknown>, key: string): number {
  return typeof value[key] === 'number' ? value[key] : Number.NaN
}

function finiteNumberAt(value: Record<string, unknown>, key: string): number {
  const candidate = numberAt(value, key)
  return Number.isFinite(candidate) ? candidate : -1
}

function evidenceLevelRank(level: string): number {
  return level === 'E3' ? 3 : level === 'E2' ? 2 : level === 'E1' ? 1 : 0
}

export interface ValidateGenerationInput {
  artifactCandidates: unknown[]
  artifactPaths: Record<string, string>
  actualFiles: AuditableFile[]
  verdictInput?: VerdictInput
  verdictInputPath?: string
  verdictDependencies?: VerdictDependencies
  runtimeProvenance?: RuntimeProvenance
  verifyAttemptEventProof?(proof: AttemptEventAuthorityProof): boolean
  verifyAuthoritySignature?(artifact: ArtifactDocument): boolean
  verifyManifestRootSignature?(
    signature: ArtifactDocument['signatures'][number],
    rootDigest: string,
  ): boolean
  verifySanitizerAttestation?(attestation: SanitizerAttestation, binding: SanitizerAttestationBinding): boolean
  verifyPrivacyReviewReceipt?(receipt: PrivacyReviewReceipt, binding: PrivacyReviewReceiptBinding): boolean
  verifyGatewayAuditSignature?(signature: ArtifactDocument['signatures'][number]): boolean
  verifyExecutionOutcomeReceipt?(receipt: ExecutionOutcomeReceipt): boolean
  verifyApprovalFreshnessReceipt?(
    receipt: ApprovalFreshnessReceipt,
    binding: ApprovalFreshnessAuditBinding,
  ): ApprovalFreshnessVerification
  verifyDecisionReceipt?: DecisionReceiptVerifier
  verifyRegressionDiscoveryAttestation?(
    attestation: RegressionDiscoveryAttestation,
    subject: RegressionDiscoverySubject,
  ): boolean
}

export interface CompleteGenerationFinding { code: string; ref: string }

const AUTHORITY_ARTIFACT_TYPES = new Set<ArtifactType>([
  'prd-manifest', 'acceptance-scope', 'execution-contract', 'approval-grants', 'run-bundle',
  'manual-results', 'generation-manifest',
])

/** 发布前唯一入口：单体 Schema、全图、文件、业务闭包、Authority 与 verdict 全部 fail-closed。 */
export function validateGeneration(input: ValidateGenerationInput): {
  valid: boolean
  findings: CompleteGenerationFinding[]
} {
  const findings: CompleteGenerationFinding[] = []
  const artifacts: ArtifactDocument[] = []
  const hasFinalReportCandidate = input.artifactCandidates.some((candidate) =>
    isPlainObject(candidate) && candidate.artifactType === 'final-report')
  const verdictInputInvalid = input.verdictInput !== undefined
    && !VerdictInputSchema.safeParse(input.verdictInput).success
  if (hasFinalReportCandidate && verdictInputInvalid) {
    add('E2E_GENERATION_VERDICT_INPUT_INVALID', 'final-report')
  }

  for (const [index, candidate] of input.artifactCandidates.entries()) {
    try {
      artifacts.push(parseArtifactDocument(candidate))
    } catch {
      add('E2E_GENERATION_ARTIFACT_SCHEMA_INVALID', String(index))
    }
  }

  const byType = new Map<ArtifactType, ArtifactDocument>()
  for (const artifact of artifacts) {
    const type = artifact.artifactType as ArtifactType
    if (byType.has(type)) add('E2E_GENERATION_ARTIFACT_TYPE_DUPLICATE', type)
    else byType.set(type, artifact)
    const expectedDigest = digestArtifactContent(
      `artifact-content/${artifact.schemaVersion}/${artifact.artifactType}`,
      artifact as unknown as Record<string, unknown>,
    )
    if (expectedDigest !== artifact.contentDigest) add('E2E_GENERATION_CONTENT_DIGEST_MISMATCH', artifact.artifactId)
    if (AUTHORITY_ARTIFACT_TYPES.has(type)) {
      if (artifact.signatures.length === 0) add('E2E_GENERATION_AUTHORITY_SIGNATURE_MISSING', artifact.artifactId)
      else if (!input.verifyAuthoritySignature) add('E2E_GENERATION_AUTHORITY_VERIFIER_UNAVAILABLE', artifact.artifactId)
      else {
        try {
          if (!input.verifyAuthoritySignature(artifact)) add('E2E_GENERATION_AUTHORITY_SIGNATURE_INVALID', artifact.artifactId)
        } catch {
          add('E2E_GENERATION_AUTHORITY_VERIFIER_ERROR', artifact.artifactId)
        }
      }
    }
  }
  for (const type of ARTIFACT_TYPES) {
    if (!byType.has(type)) add('E2E_GENERATION_ARTIFACT_TYPE_MISSING', type)
  }

  if (byType.has('final-report') || byType.has('generation-manifest')) {
    if (input.runtimeProvenance === undefined) {
      add('E2E_GENERATION_RUNTIME_PROVENANCE_HOST_MISSING', 'runtimeProvenance')
    } else {
      auditRuntimeProvenanceBinding(artifacts, input.runtimeProvenance).findings
        .forEach((finding) => add(finding.code, finding.ref))
    }
  }

  const attemptAudit = auditPersistedAttemptFacts(artifacts, input.verifyAttemptEventProof)
  attemptAudit.findings.forEach((finding) => add(finding.code, finding.ref))

  const paths = new Map(Object.entries(input.artifactPaths))
  const graphAudit = auditArtifactGraph(artifacts as AuditableArtifact[], paths)
  graphAudit.findings.forEach((finding) => add(finding.code, `${finding.artifactId}:${finding.refs.join(',')}`))

  const manifest = byType.get('generation-manifest')
  if (manifest) {
    const manifestContent = manifest.content as {
      artifacts: Array<{ artifactId: string; artifactType: string; relativePath: string; digest: string }>
      files: AuditableFile[]
      generationId: string
      fencingToken: number
      finalizationSnapshotDigest: string
      rootDigest: string
      terminalVerdict: string
      authoritySignature: ArtifactDocument['signatures'][number]
    }
    if (manifestContent.generationId !== manifest.generationId) add('E2E_GENERATION_MANIFEST_ID_MISMATCH', manifest.artifactId)
    const manifestArtifacts = new Map(manifestContent.artifacts.map((item) => [item.artifactId, item]))
    for (const artifact of artifacts) {
      if (artifact.artifactType === 'generation-manifest') continue
      const indexed = manifestArtifacts.get(artifact.artifactId)
      if (!indexed) add('E2E_GENERATION_MANIFEST_ARTIFACT_MISSING', artifact.artifactId)
      else if (indexed.artifactType !== artifact.artifactType
        || indexed.relativePath !== paths.get(artifact.artifactId)
        || indexed.digest !== artifact.contentDigest) {
        add('E2E_GENERATION_MANIFEST_ARTIFACT_MISMATCH', artifact.artifactId)
      }
    }
    for (const indexedId of manifestArtifacts.keys()) {
      if (!artifacts.some((artifact) => artifact.artifactId === indexedId)) {
        add('E2E_GENERATION_MANIFEST_ARTIFACT_UNKNOWN', indexedId)
      }
    }
    const registeredFiles = new Map(manifestContent.files.map((file) => [file.relativePath, file]))
    const actualFiles = new Map(input.actualFiles.map((file) => [file.relativePath, file]))
    for (const artifact of artifacts) {
      const path = paths.get(artifact.artifactId)
      if (!path) continue
      const registeredFile = registeredFiles.get(path)
      const actualFile = actualFiles.get(path)
      const canonicalText = canonicalizeJson(artifact)
      const canonicalDigest = digestBytes(`generation-file:${path}`, Buffer.from(canonicalText, 'utf8'))
      const canonicalLength = Buffer.byteLength(canonicalText, 'utf8')
      const selfManifest = artifact.artifactType === 'generation-manifest'
      if ((!selfManifest && (!registeredFile
          || registeredFile.digest !== canonicalDigest || registeredFile.byteLength !== canonicalLength))
        || !actualFile || actualFile.digest !== canonicalDigest || actualFile.byteLength !== canonicalLength) {
        add('E2E_GENERATION_ARTIFACT_FILE_MISMATCH', artifact.artifactId)
      }
    }
    const expectedSnapshotDigest = computeFinalizationSnapshotDigest(manifestContent.artifacts)
    if (manifestContent.finalizationSnapshotDigest !== expectedSnapshotDigest) {
      add('E2E_GENERATION_FINALIZATION_SNAPSHOT_MISMATCH', manifest.artifactId)
    }
    const expectedRootDigest = computeGenerationRootDigest(manifestContent)
    if (manifestContent.rootDigest !== expectedRootDigest) add('E2E_GENERATION_ROOT_DIGEST_MISMATCH', manifest.artifactId)
    const finalReport = byType.get('final-report')
    const finalVerdict = finalReport
      ? stringAt(finalReport.content as Record<string, unknown>, 'verdict') : ''
    if (manifestContent.terminalVerdict !== finalVerdict) {
      add('E2E_GENERATION_TERMINAL_VERDICT_MISMATCH', manifest.artifactId)
    }
    if (!input.verifyManifestRootSignature) {
      add('E2E_GENERATION_MANIFEST_ROOT_VERIFIER_UNAVAILABLE', manifest.artifactId)
    } else {
      try {
        if (!input.verifyManifestRootSignature(manifestContent.authoritySignature, expectedRootDigest)) {
          add('E2E_GENERATION_MANIFEST_ROOT_SIGNATURE_INVALID', manifest.artifactId)
        }
      } catch {
        add('E2E_GENERATION_MANIFEST_ROOT_VERIFIER_ERROR', manifest.artifactId)
      }
    }
    auditGenerationFiles(manifestContent.files, input.actualFiles).findings
      .forEach((finding) => add(finding.code, finding.relativePath))
  }

  if (byType.size === ARTIFACT_TYPES.length) {
    auditArtifactSemantics(artifacts as SemanticArtifact[], input.actualFiles, {
      verifySanitizerAttestation: input.verifySanitizerAttestation,
      verifyPrivacyReviewReceipt: input.verifyPrivacyReviewReceipt,
      verifyGatewayAuditSignature: input.verifyGatewayAuditSignature,
      verifyExecutionOutcomeReceipt: input.verifyExecutionOutcomeReceipt,
      verifyApprovalFreshnessReceipt: input.verifyApprovalFreshnessReceipt,
      verifyDecisionReceipt: input.verifyDecisionReceipt,
      verifyRegressionDiscoveryAttestation: input.verifyRegressionDiscoveryAttestation,
    }).findings
      .forEach((finding) => add(finding.code, `${finding.artifactId}:${finding.ref}`))
  }

  const finalReport = byType.get('final-report')
  if (finalReport) {
    auditFinalReportFactBinding(artifacts as SemanticArtifact[]).findings
      .forEach((finding) => add(finding.code, finding.ref))
    if (!input.verdictInput) add('E2E_GENERATION_VERDICT_INPUT_MISSING', finalReport.artifactId)
    else {
      const parsedVerdictInput = VerdictInputSchema.safeParse(input.verdictInput)
      if (!parsedVerdictInput.success) {
        if (!verdictInputInvalid) add('E2E_GENERATION_VERDICT_INPUT_INVALID', finalReport.artifactId)
      } else {
      const verdictInput = parsedVerdictInput.data
      if (verdictInput.assetId !== finalReport.assetId
        || verdictInput.generationId !== finalReport.generationId
        || verdictInput.prdRevision !== finalReport.prdRevision) {
        add('E2E_GENERATION_VERDICT_INPUT_CROSS_GENERATION', finalReport.artifactId)
      }
      const policy = byType.get('project-policy')
      const requirementModel = byType.get('requirement-model')
      const coverageUniverse = byType.get('coverage-universe')
      if (verdictInput.policyDigest !== policy?.contentDigest
        || verdictInput.requirementModelDigest !== requirementModel?.contentDigest
        || verdictInput.universeDigest !== stringAt(
          coverageUniverse?.content as Record<string, unknown> ?? {}, 'universeDigest',
        )) {
        add('E2E_GENERATION_VERDICT_INPUT_FACT_MISMATCH', finalReport.artifactId)
      }
      const expected = computeVerdict(verdictInput, createPersistedAttemptVerdictDependencies(
        attemptAudit, input.verdictDependencies?.verifyManualResult,
      ))
      const report = finalReport.content as Record<string, unknown>
      const projectPolicyContent = byType.get('project-policy')?.content as Record<string, unknown> ?? {}
      const executionContractContent = byType.get('execution-contract')?.content as Record<string, unknown> ?? {}
      const browserResultsContent = byType.get('browser-results')?.content as Record<string, unknown> ?? {}
      const parsedReportProvenance = RuntimeProvenanceSchema.safeParse(report.runtimeProvenance)
      const expectedCannotClaim = [...new Set([...expected.cannotClaim, ...deriveBrowserCannotClaim({
        approved: arrayAt(projectPolicyContent, 'browserMatrix').map((item) => ({
          browserId: stringAt(item, 'browserId'), required: item.required === true,
        })),
        planned: arrayAt(executionContractContent, 'browserMatrix').map((item) => ({
          browserId: stringAt(item, 'browserId'),
        })),
        executed: stringsAt(browserResultsContent, 'executedBrowserIds'),
      }), ...(parsedReportProvenance.success
        ? deriveRuntimeProvenanceCannotClaim(parsedReportProvenance.data)
        : [])])].sort()
      const verdictInputDigest = digestText('verdict-input/v2', canonicalizeJson(verdictInput))
      if (report.verdictInputDigest !== verdictInputDigest) {
        add('E2E_GENERATION_VERDICT_INPUT_DIGEST_MISMATCH', finalReport.artifactId)
      }
      const verdictInputPath = input.verdictInputPath ?? 'run/verdict-input.json'
      const canonicalVerdictInput = canonicalizeJson(verdictInput)
      const expectedVerdictFile = {
        digest: digestBytes(`generation-file:${verdictInputPath}`, Buffer.from(canonicalVerdictInput, 'utf8')),
        byteLength: Buffer.byteLength(canonicalVerdictInput, 'utf8'),
      }
      const manifestContent = byType.get('generation-manifest')?.content as { files?: AuditableFile[] } | undefined
      const registeredVerdictFile = manifestContent?.files?.find((file) => file.relativePath === verdictInputPath)
      const actualVerdictFile = input.actualFiles.find((file) => file.relativePath === verdictInputPath)
      if (!registeredVerdictFile || !actualVerdictFile
        || registeredVerdictFile.digest !== expectedVerdictFile.digest
        || actualVerdictFile.digest !== expectedVerdictFile.digest
        || registeredVerdictFile.byteLength !== expectedVerdictFile.byteLength
        || actualVerdictFile.byteLength !== expectedVerdictFile.byteLength) {
        add('E2E_GENERATION_VERDICT_INPUT_FILE_MISMATCH', verdictInputPath)
      }
      auditVerdictFactBinding(artifacts as SemanticArtifact[], verdictInput).findings
        .forEach((finding) => add(finding.code, finding.ref))
      const expectedComparable = {
        verdictRuleVersion: expected.verdictRuleVersion, verdict: expected.verdict,
        reasonCodes: expected.reasonCodes, cannotClaim: expectedCannotClaim,
        businessFailuresObserved: expected.businessFailuresObserved,
        advisoryFailures: expected.advisoryFailures,
        metrics: expected.metrics,
      }
      const actualComparable = {
        verdictRuleVersion: report.verdictRuleVersion, verdict: report.verdict,
        reasonCodes: report.reasonCodes, cannotClaim: report.cannotClaim,
        businessFailuresObserved: report.businessFailuresObserved,
        advisoryFailures: report.advisoryFailures,
        metrics: report.metrics,
      }
      differingPaths(expectedComparable, actualComparable)
        .forEach((path) => add('E2E_GENERATION_VERDICT_RECOMPUTE_MISMATCH', path))
      }
    }
  }

  findings.sort((left, right) => left.code.localeCompare(right.code) || left.ref.localeCompare(right.ref))
  return { valid: findings.length === 0, findings }

  function add(code: string, ref: string): void { findings.push({ code, ref }) }
}

export function auditVerdictFactBinding(
  artifacts: SemanticArtifact[],
  verdictInput: VerdictInput,
): { valid: boolean; findings: Array<{ code: string; ref: string }> } {
  const findings: Array<{ code: string; ref: string }> = []
  const byType = new Map(artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const content = (type: string): Record<string, unknown> => {
    const value = byType.get(type)?.content
    return isPlainObject(value) ? value : {}
  }
  const obligations = arrayAt(content('coverage-universe'), 'obligations').map((obligation) => {
    const disposition = objectAt(obligation, 'disposition')
    const kind = stringAt(disposition, 'kind')
    return {
      obligationId: stringAt(obligation, 'obligationId'),
      necessity: stringAt(obligation, 'necessity'),
      disposition: kind,
      ...(kind === 'automated' ? { caseIds: stringsAt(disposition, 'caseIds') } : {}),
      ...(kind === 'manual' ? { manualProcedureId: stringAt(disposition, 'manualProcedureId') } : {}),
      ...(kind === 'not-applicable' ? { notApplicableRationale: stringAt(disposition, 'rationale') } : {}),
    }
  })
  if (!canonicalArrayEquals(obligations, verdictInput.obligations, 'obligationId')) {
    add('E2E_GENERATION_VERDICT_OBLIGATIONS_MISMATCH', 'coverage-universe')
  }
  const manualResults = arrayAt(content('manual-results'), 'results')
  if (!canonicalArrayEquals(manualResults, verdictInput.manualResults, 'manualResultId')) {
    add('E2E_GENERATION_VERDICT_MANUAL_RESULTS_MISMATCH', 'manual-results')
  }
  const testCases = new Map(arrayAt(content('test-cases'), 'cases')
    .map((testCase) => [stringAt(testCase, 'caseId'), testCase]))
  const browserResults = content('browser-results')
  const runId = stringAt(browserResults, 'runId')
  const executionFacts = arrayAt(browserResults, 'caseResults').map((caseResult) => ({
    resultId: stringAt(caseResult, 'resultId'),
    caseId: stringAt(caseResult, 'caseId'),
    runId,
    obligationIds: stringsAt(testCases.get(stringAt(caseResult, 'caseId')) ?? {}, 'obligationIds'),
    status: stringAt(caseResult, 'status'),
    executionMode: stringAt(caseResult, 'mode'),
    baselineResultId: stringAt(caseResult, 'baselineResultId'),
    attemptId: stringAt(caseResult, 'attemptId'),
    eventChainDigest: stringAt(caseResult, 'eventChainDigest'),
  }))
  const verdictFacts = verdictInput.caseResults.map((caseResult) => ({
    resultId: caseResult.resultId,
    caseId: caseResult.caseId,
    runId: caseResult.runId,
    obligationIds: caseResult.obligationIds,
    status: caseResult.status,
    executionMode: caseResult.executionMode,
    baselineResultId: caseResult.baselineResultId ?? '',
    attemptId: caseResult.attemptSelection.status === 'valid' ? caseResult.attemptSelection.attemptId : '',
    eventChainDigest: caseResult.attemptSelection.status === 'valid' ? caseResult.attemptSelection.eventChainDigest : '',
  }))
  if (!canonicalArrayEquals(executionFacts, verdictFacts, 'resultId')) {
    add('E2E_GENERATION_VERDICT_CASE_RESULTS_MISMATCH', 'browser-results')
  }
  const requirements = arrayAt(content('requirement-model'), 'requirements')
    .filter((requirement) => stringAt(requirement, 'status') === 'active')
  const coverageObligations = arrayAt(content('coverage-universe'), 'obligations')
  const flows = arrayAt(content('interaction-flow'), 'flows')
  const criticalNodeIds = flows.flatMap((flow) => arrayAt(flow, 'nodes'))
    .filter((node) => stringAt(node, 'effect') !== 'read'
      || ['entry', 'exit', 'decision', 'state'].includes(stringAt(node, 'kind'))
      || stringsAt(node, 'oracleIds').length > 0)
    .map((node) => stringAt(node, 'nodeId'))
  const coveredNodeIds = new Set(coverageObligations.flatMap((item) => stringsAt(item, 'nodeIds')))
  const actors = [...new Set(requirements.flatMap((requirement) => stringsAt(requirement, 'actors')))]
  const coveredActors = new Set(coverageObligations.map((item) => stringAt(item, 'actor')).filter((actor) => actor !== 'not-applicable'))
  const transitionIds = requirements.flatMap((requirement) =>
    arrayAt(requirement, 'transitions').map((transition) => stringAt(transition, 'transitionId')))
  const coveredTransitions = new Set(coverageObligations.map((item) => stringAt(item, 'transitionId'))
    .filter((transitionId) => transitionId !== 'not-applicable'))
  const scenarioIds = [...new Set(coverageObligations.map((item) => stringAt(item, 'scenario')).filter(Boolean))]
  const semanticAudit = auditSemanticCompleteness({
    manifest: content('prd-manifest'), scope: content('acceptance-scope'),
    model: content('requirement-model'), flows: content('interaction-flow'),
    coverage: content('coverage-universe'), cases: content('test-cases'),
  })
  const expectedCoverageFacts = {
    ...semanticAudit.coverageFacts,
    criticalNodes: { covered: criticalNodeIds.filter((id) => coveredNodeIds.has(id)).length, total: criticalNodeIds.length },
    roles: { covered: actors.filter((actor) => coveredActors.has(actor)).length, total: actors.length },
    stateTransitions: { covered: transitionIds.filter((id) => coveredTransitions.has(id)).length, total: transitionIds.length },
    scenarioCategories: { covered: scenarioIds.length, total: scenarioIds.length },
  }
  if (canonicalizeJson(verdictInput.coverageFacts) !== canonicalizeJson(expectedCoverageFacts)) {
    add('E2E_GENERATION_VERDICT_COVERAGE_FACTS_MISMATCH', 'requirement-model')
  }

  const scheduledActionIds = arrayAt(content('run-bundle'), 'schedule').flatMap((item) => stringsAt(item, 'actionIds'))
  const gatewayActionIds = gatewayExecutionActionIds(content('gateway-audit'))
  const gatewayComplete = scheduledActionIds.every((actionId) => gatewayActionIds.has(actionId))
    && (stringAt(content('approval-grants'), 'runBundleDigest') === ''
      || gatewayExecutionClosureComplete(content('browser-action-map'), content('run-bundle'),
        content('browser-results'), content('gateway-audit')))
  const expectedGatewayAudit = gatewayComplete
    ? { status: 'valid', required: scheduledActionIds.length > 0, reasonCodes: [] }
    : { status: 'incomplete', required: true, reasonCodes: ['GATEWAY_ACTION_MISSING'] }
  if (canonicalizeJson(verdictInput.gatewayAudit) !== canonicalizeJson(expectedGatewayAudit)) {
    add('E2E_GENERATION_VERDICT_GATEWAY_AUDIT_MISMATCH', 'gateway-audit')
  }

  const evidenceIds = new Set(arrayAt(content('browser-evidence'), 'artifacts')
    .map((item) => stringAt(item, 'evidenceId')))
  const terminalSteps = arrayAt(browserResults, 'caseResults').flatMap((caseResult) => arrayAt(caseResult, 'stepResults'))
    .filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status')))
  const completeEvidenceSteps = terminalSteps.filter((step) => {
    const refs = stringsAt(step, 'evidenceIds')
    return refs.length > 0 && refs.every((id) => evidenceIds.has(id))
  }).length
  const expectedEvidenceAudit = completionAudit(terminalSteps.length, completeEvidenceSteps, 'EVIDENCE_STEP_MISSING')
  if (canonicalizeJson(verdictInput.evidenceAudit) !== canonicalizeJson(expectedEvidenceAudit)) {
    add('E2E_GENERATION_VERDICT_EVIDENCE_AUDIT_MISMATCH', 'browser-evidence')
  }

  const auditedLeases = arrayAt(content('data-leases'), 'leases')
  const auditedLeaseById = new Map(auditedLeases.map((lease) => [stringAt(lease, 'leaseId'), lease]))
  const auditedCleanupByLease = new Map(arrayAt(content('cleanup-results'), 'leaseResults')
    .map((item) => [stringAt(item, 'leaseId'), item]))
  const auditedTestCases = new Map(arrayAt(content('test-cases'), 'cases')
    .map((item) => [stringAt(item, 'caseId'), item]))
  const auditedDataNeeds = new Map(arrayAt(content('execution-contract'), 'dataNeeds')
    .map((item) => [stringAt(item, 'leaseId'), item]))
  const auditedActionEffects = new Map(arrayAt(content('browser-action-map'), 'actions')
    .map((item) => [stringAt(item, 'actionId'), stringAt(item, 'effect')]))
  const auditedWriteExecutions = arrayAt(content('browser-results'), 'caseResults').flatMap((caseResult) =>
    arrayAt(caseResult, 'stepResults')
      .filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status'))
        && auditedActionEffects.get(stringAt(step, 'actionId')) !== 'read')
      .map((step) => ({ caseResult, actionId: stringAt(step, 'actionId') })))
  let auditedCleanupComplete = auditedLeases.filter((lease) => {
    const leaseId = stringAt(lease, 'leaseId')
    const cleanupStatus = stringAt(auditedCleanupByLease.get(leaseId) ?? {}, 'status')
    return stringAt(lease, 'status') === 'released'
      && (cleanupStatus === 'verified-clean' || cleanupStatus === 'not-needed')
  }).length
  const auditedCleanupReasons: string[] = []
  let auditedCleanupInvalid = false
  for (const lease of auditedLeases) {
    const leaseId = stringAt(lease, 'leaseId')
    const cleanupStatus = stringAt(auditedCleanupByLease.get(leaseId) ?? {}, 'status')
    if (cleanupStatus === 'failed' || cleanupStatus === 'unknown') {
      auditedCleanupInvalid = true
      auditedCleanupReasons.push(`${cleanupStatus === 'failed' ? 'CLEANUP_LEASE_FAILED' : 'CLEANUP_LEASE_UNKNOWN'}:${leaseId}`)
    } else if (stringAt(lease, 'status') !== 'released'
      || !['verified-clean', 'not-needed'].includes(cleanupStatus)) {
      auditedCleanupReasons.push(`CLEANUP_LEASE_MISSING:${leaseId}`)
    }
  }
  for (const execution of auditedWriteExecutions) {
    const caseId = stringAt(execution.caseResult, 'caseId')
    const cleanupRef = stringAt(execution.caseResult, 'cleanupRef')
    const observation = stringAt(execution.caseResult, 'effectObservation')
    let closed = true
    if (observation === 'unknown') {
      auditedCleanupInvalid = true
      auditedCleanupReasons.push(`CLEANUP_WRITE_EFFECT_UNKNOWN:${caseId}:${execution.actionId}`)
      closed = false
    }
    if (cleanupRef === '') {
      auditedCleanupReasons.push(`CLEANUP_WRITE_REF_MISSING:${caseId}:${execution.actionId}`)
      closed = false
    } else {
      const caseNeedIds = new Set(stringsAt(auditedTestCases.get(caseId) ?? {}, 'dataNeedIds'))
      const dataNeed = auditedDataNeeds.get(cleanupRef)
      const lease = auditedLeaseById.get(cleanupRef)
      const cleanupStatus = stringAt(auditedCleanupByLease.get(cleanupRef) ?? {}, 'status')
      if (!caseNeedIds.has(cleanupRef) || !dataNeed || stringAt(dataNeed, 'mode') !== 'write' || !lease) {
        auditedCleanupReasons.push(`CLEANUP_WRITE_REF_UNKNOWN:${caseId}:${cleanupRef}`)
        closed = false
      } else if (stringAt(lease, 'status') !== 'released') {
        auditedCleanupReasons.push(`CLEANUP_WRITE_LEASE_NOT_RELEASED:${cleanupRef}`)
        closed = false
      }
      if (cleanupStatus === 'failed' || cleanupStatus === 'unknown') {
        auditedCleanupInvalid = true
        auditedCleanupReasons.push(`${cleanupStatus === 'failed' ? 'CLEANUP_WRITE_FAILED' : 'CLEANUP_WRITE_UNKNOWN'}:${cleanupRef}`)
        closed = false
      } else if (cleanupStatus !== 'verified-clean') {
        auditedCleanupReasons.push(`CLEANUP_WRITE_RESULT_MISSING:${cleanupRef}`)
        closed = false
      }
    }
    if (closed) auditedCleanupComplete += 1
  }
  const auditedCleanupTotal = auditedLeases.length + auditedWriteExecutions.length
  const auditedUniqueReasons = [...new Set(auditedCleanupReasons)].sort()
  const expectedCleanupAudit: VerdictInput['cleanupAudit'] = auditedCleanupInvalid
    ? { status: 'invalid', total: auditedCleanupTotal, complete: auditedCleanupComplete,
      reasonCodes: auditedUniqueReasons }
    : auditedCleanupComplete === auditedCleanupTotal
      ? { status: 'complete', total: auditedCleanupTotal, complete: auditedCleanupComplete, reasonCodes: [] }
      : { status: 'incomplete', total: auditedCleanupTotal, complete: auditedCleanupComplete,
        reasonCodes: auditedUniqueReasons }
  if (canonicalizeJson(verdictInput.cleanupAudit) !== canonicalizeJson(expectedCleanupAudit)) {
    add('E2E_GENERATION_VERDICT_CLEANUP_AUDIT_MISMATCH', 'cleanup-results')
  }

  // 审计侧刻意不复用 VerdictInput 派生 helper：直接从 Authority 事实独立复算，
  // 防止派生与审计共同遗漏同一字段后互相“证明”正确。
  const auditedAuthorityPending: string[] = []
  const auditedAuthoritySafety: string[] = []
  const auditedScopeDecision = objectAt(content('acceptance-scope'), 'scopeDecision')
  if (stringAt(auditedScopeDecision, 'status') === 'pending') {
    auditedAuthorityPending.push(`SCOPE:${stringAt(auditedScopeDecision, 'decisionId')}`)
  } else if (stringAt(auditedScopeDecision, 'status') === 'rejected') {
    auditedAuthoritySafety.push('SCOPE_DECISION_REJECTED')
  }
  const auditedLineageDecision = objectAt(content('prd-diff'), 'lineageReview')
  if (stringAt(auditedLineageDecision, 'status') === 'pending') {
    auditedAuthorityPending.push(`LINEAGE:${stringAt(auditedLineageDecision, 'decisionId')}`)
  } else if (stringAt(auditedLineageDecision, 'status') === 'rejected') {
    auditedAuthoritySafety.push('LINEAGE_DECISION_REJECTED')
  }
  const auditedGrants = content('approval-grants')
  for (const grant of arrayAt(auditedGrants, 'grants')) {
    const status = stringAt(grant, 'status')
    if (status === 'expired') auditedAuthoritySafety.push(`EXECUTION_GRANT_EXPIRED:${stringAt(grant, 'grantId')}`)
    if (status === 'revoked') auditedAuthoritySafety.push(`EXECUTION_GRANT_REVOKED:${stringAt(grant, 'grantId')}`)
    if (status === 'denied') auditedAuthoritySafety.push(`EXECUTION_GRANT_DENIED:${stringAt(grant, 'grantId')}`)
  }
  const pendingDecisionIds = arrayAt(content('acceptance-scope'), 'ambiguities')
    .filter((item) => stringAt(item, 'status') === 'pending')
    .map((item) => stringAt(item, 'ambiguityId')).concat(auditedAuthorityPending)
  if (!canonicalArrayEquals(pendingDecisionIds, verdictInput.pendingDecisionIds, '')) {
    add('E2E_GENERATION_VERDICT_PENDING_DECISIONS_MISMATCH', 'acceptance-scope')
  }
  const designAudit = content('design-audit')
  const expectedArtifactFindings = [...new Set([
    ...(stringAt(designAudit, 'status') === 'failed'
      ? arrayAt(designAudit, 'findings').map((item) => stringAt(item, 'code')) : []),
    ...semanticAudit.findings.map((finding) => finding.code),
  ])]
  const preflight = content('browser-preflight')
  const expectedEnvironmentFindings = stringAt(preflight, 'status') === 'failed'
    ? arrayAt(preflight, 'checks').filter((item) => stringAt(item, 'status') === 'failed')
      .map((item) => stringAt(item, 'code')) : []
  expectedEnvironmentFindings.push(
    ...arrayAt(content('acceptance-scope'), 'dependencies')
      .filter((item) => stringAt(item, 'status') === 'blocked')
      .map((item) => `SCOPE_DEPENDENCY_BLOCKED:${stringAt(item, 'dependencyId')}`),
    ...arrayAt(content('execution-contract'), 'unresolvedItems')
      .filter((item) => item.blocking === true)
      .map((item) => `EXECUTION_UNRESOLVED_BLOCKING:${stringAt(item, 'itemId')}`),
  )
  const diagnoses = arrayAt(content('diagnosis'), 'caseDiagnoses')
  const expectedSafetyFindings = diagnoses.filter((item) => stringAt(item, 'category') === 'safety')
    .map((item) => `DIAGNOSIS_SAFETY:${stringAt(item, 'caseId')}`).concat(auditedAuthoritySafety)
  const expectedAutomationFindings = diagnoses.filter((item) => stringAt(item, 'category') === 'automation')
    .map((item) => `DIAGNOSIS_AUTOMATION:${stringAt(item, 'caseId')}`)
  compareFindingSet(verdictInput.artifactFindings, expectedArtifactFindings,
    'E2E_GENERATION_VERDICT_ARTIFACT_FINDINGS_MISMATCH', 'design-audit')
  compareFindingSet(verdictInput.environmentFindings, expectedEnvironmentFindings,
    'E2E_GENERATION_VERDICT_ENVIRONMENT_FINDINGS_MISMATCH', 'browser-preflight')
  compareFindingSet(verdictInput.safetyFindings, expectedSafetyFindings,
    'E2E_GENERATION_VERDICT_SAFETY_FINDINGS_MISMATCH', 'diagnosis')
  compareFindingSet(verdictInput.automationFindings, expectedAutomationFindings,
    'E2E_GENERATION_VERDICT_AUTOMATION_FINDINGS_MISMATCH', 'diagnosis')
  compareFindingSet(verdictInput.migrationFindings, [],
    'E2E_GENERATION_VERDICT_MIGRATION_FINDINGS_MISMATCH', 'requirement-model')
  return { valid: findings.length === 0, findings }

  function add(code: string, ref: string): void { findings.push({ code, ref }) }
  function compareFindingSet(actual: string[], expected: string[], code: string, ref: string): void {
    if (!canonicalArrayEquals(actual, expected, '')) add(code, ref)
  }
}

/**
 * 从本代事实资产投影唯一的 VerdictInput。调用方不能提供裁决字段；所有会影响
 * terminal verdict 的值都由已通过 Artifact Schema 的内容确定。
 */
export function deriveVerdictInputFromArtifacts(input: {
  artifacts: SemanticArtifact[]
  assetId: string
  generationId: string
  prdRevision: string
  createdAt: string
  verifyDecisionReceipt: DecisionReceiptVerifier
}): VerdictInput {
  const decisionAudit = auditDecisionReceipts(input.artifacts, input.verifyDecisionReceipt)
  if (!decisionAudit.valid) {
    throw new E2EError({
      code: 'E2E_GENERATION_DECISION_RECEIPT_INVALID', category: 'decision', retryable: false,
      message: 'Scope/Lineage 决定未通过专用 receipt 动态验证，禁止派生 VerdictInput',
      refs: decisionAudit.findings.map((finding) => `${finding.artifactId}:${finding.ref}`),
    })
  }
  const byType = new Map(input.artifacts.map((artifact) => [artifact.artifactType, artifact]))
  const content = (type: string): Record<string, unknown> => {
    const value = byType.get(type)?.content
    return isPlainObject(value) ? value : {}
  }
  const obligations = arrayAt(content('coverage-universe'), 'obligations').map((obligation) => {
    const disposition = objectAt(obligation, 'disposition')
    const kind = stringAt(disposition, 'kind')
    return {
      obligationId: stringAt(obligation, 'obligationId'),
      necessity: stringAt(obligation, 'necessity'),
      disposition: kind,
      ...(kind === 'automated' ? { caseIds: stringsAt(disposition, 'caseIds') } : {}),
      ...(kind === 'manual' ? { manualProcedureId: stringAt(disposition, 'manualProcedureId') } : {}),
      ...(kind === 'not-applicable' ? { notApplicableRationale: stringAt(disposition, 'rationale') } : {}),
    }
  })
  const testCases = new Map(arrayAt(content('test-cases'), 'cases')
    .map((testCase) => [stringAt(testCase, 'caseId'), testCase]))
  const browserResults = content('browser-results')
  const runId = stringAt(browserResults, 'runId')
  const caseResults = [...arrayAt(browserResults, 'caseResults')]
    .sort((left, right) => stringAt(left, 'resultId').localeCompare(stringAt(right, 'resultId')))
    .map((caseResult) => ({
    resultId: stringAt(caseResult, 'resultId'),
    caseId: stringAt(caseResult, 'caseId'),
    runId,
    obligationIds: stringsAt(testCases.get(stringAt(caseResult, 'caseId')) ?? {}, 'obligationIds'),
    status: stringAt(caseResult, 'status'),
    executionMode: stringAt(caseResult, 'mode'),
    ...(stringAt(caseResult, 'baselineResultId')
      ? { baselineResultId: stringAt(caseResult, 'baselineResultId') } : {}),
    attemptSelection: {
      status: 'valid' as const,
      attemptId: stringAt(caseResult, 'attemptId'),
      eventChainDigest: stringAt(caseResult, 'eventChainDigest'),
    },
  }))
  const requirements = arrayAt(content('requirement-model'), 'requirements')
    .filter((requirement) => stringAt(requirement, 'status') === 'active')
  const coverageObligations = arrayAt(content('coverage-universe'), 'obligations')
  const flows = arrayAt(content('interaction-flow'), 'flows')
  const criticalNodeIds = flows.flatMap((flow) => arrayAt(flow, 'nodes'))
    .filter((node) => stringAt(node, 'effect') !== 'read'
      || ['entry', 'exit', 'decision', 'state'].includes(stringAt(node, 'kind'))
      || stringsAt(node, 'oracleIds').length > 0)
    .map((node) => stringAt(node, 'nodeId'))
  const coveredNodeIds = new Set(coverageObligations.flatMap((item) => stringsAt(item, 'nodeIds')))
  const actors = [...new Set(requirements.flatMap((requirement) => stringsAt(requirement, 'actors')))]
  const coveredActors = new Set(coverageObligations.map((item) => stringAt(item, 'actor'))
    .filter((actor) => actor !== 'not-applicable'))
  const transitionIds = requirements.flatMap((requirement) =>
    arrayAt(requirement, 'transitions').map((transition) => stringAt(transition, 'transitionId')))
  const coveredTransitions = new Set(coverageObligations.map((item) => stringAt(item, 'transitionId'))
    .filter((transitionId) => transitionId !== 'not-applicable'))
  const scenarioIds = [...new Set(coverageObligations.map((item) => stringAt(item, 'scenario')).filter(Boolean))]
  const semanticAudit = auditSemanticCompleteness({
    manifest: content('prd-manifest'), scope: content('acceptance-scope'),
    model: content('requirement-model'), flows: content('interaction-flow'),
    coverage: content('coverage-universe'), cases: content('test-cases'),
  })
  const scheduledActionIds = arrayAt(content('run-bundle'), 'schedule').flatMap((item) => stringsAt(item, 'actionIds'))
  const gatewayActionIds = gatewayExecutionActionIds(content('gateway-audit'))
  const gatewayComplete = scheduledActionIds.every((actionId) => gatewayActionIds.has(actionId))
    && (stringAt(content('approval-grants'), 'runBundleDigest') === ''
      || gatewayExecutionClosureComplete(content('browser-action-map'), content('run-bundle'),
        content('browser-results'), content('gateway-audit')))
  const evidenceIds = new Set(arrayAt(content('browser-evidence'), 'artifacts')
    .map((item) => stringAt(item, 'evidenceId')))
  const terminalSteps = arrayAt(browserResults, 'caseResults').flatMap((caseResult) => arrayAt(caseResult, 'stepResults'))
    .filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status')))
  const completeEvidenceSteps = terminalSteps.filter((step) => {
    const refs = stringsAt(step, 'evidenceIds')
    return refs.length > 0 && refs.every((id) => evidenceIds.has(id))
  }).length
  const cleanupAudit = deriveCleanupVerdictAudit(content)
  const designAudit = content('design-audit')
  const preflight = content('browser-preflight')
  const diagnoses = arrayAt(content('diagnosis'), 'caseDiagnoses')
  const authorityFacts = deriveAuthorityVerdictFacts(
    content, stringAt(content('browser-results'), 'finishedAt'),
  )

  return VerdictInputSchema.parse({
    schemaVersion: '2.1.0', assetId: input.assetId, generationId: input.generationId,
    verdictRuleVersion: '2.0.0',
    policyDigest: byType.get('project-policy')?.contentDigest,
    universeDigest: stringAt(content('coverage-universe'), 'universeDigest'),
    prdRevision: input.prdRevision,
    requirementModelDigest: byType.get('requirement-model')?.contentDigest,
    obligations, caseResults, manualResults: arrayAt(content('manual-results'), 'results'),
    pendingDecisionIds: arrayAt(content('acceptance-scope'), 'ambiguities')
      .filter((item) => stringAt(item, 'status') === 'pending').map((item) => stringAt(item, 'ambiguityId'))
      .concat(authorityFacts.pendingDecisionIds),
    safetyFindings: diagnoses.filter((item) => stringAt(item, 'category') === 'safety')
      .map((item) => `DIAGNOSIS_SAFETY:${stringAt(item, 'caseId')}`).concat(authorityFacts.safetyFindings),
    artifactFindings: [...new Set([
      ...(stringAt(designAudit, 'status') === 'failed'
        ? arrayAt(designAudit, 'findings').map((item) => stringAt(item, 'code')) : []),
      ...semanticAudit.findings.map((finding) => finding.code),
    ])],
    migrationFindings: [],
    environmentFindings: (stringAt(preflight, 'status') === 'failed'
      ? arrayAt(preflight, 'checks').filter((item) => stringAt(item, 'status') === 'failed')
        .map((item) => stringAt(item, 'code')) : []).concat(
      arrayAt(content('acceptance-scope'), 'dependencies')
        .filter((item) => stringAt(item, 'status') === 'blocked')
        .map((item) => `SCOPE_DEPENDENCY_BLOCKED:${stringAt(item, 'dependencyId')}`),
      arrayAt(content('execution-contract'), 'unresolvedItems')
        .filter((item) => item.blocking === true)
        .map((item) => `EXECUTION_UNRESOLVED_BLOCKING:${stringAt(item, 'itemId')}`),
    ),
    automationFindings: diagnoses.filter((item) => stringAt(item, 'category') === 'automation')
      .map((item) => `DIAGNOSIS_AUTOMATION:${stringAt(item, 'caseId')}`),
    gatewayAudit: gatewayComplete
      ? { status: 'valid', required: scheduledActionIds.length > 0, reasonCodes: [] }
      : { status: 'incomplete', required: true, reasonCodes: ['GATEWAY_ACTION_MISSING'] },
    evidenceAudit: completionAudit(terminalSteps.length, completeEvidenceSteps, 'EVIDENCE_STEP_MISSING'),
    cleanupAudit,
    coverageFacts: {
      ...semanticAudit.coverageFacts,
      criticalNodes: { covered: criticalNodeIds.filter((id) => coveredNodeIds.has(id)).length, total: criticalNodeIds.length },
      roles: { covered: actors.filter((actor) => coveredActors.has(actor)).length, total: actors.length },
      stateTransitions: { covered: transitionIds.filter((id) => coveredTransitions.has(id)).length, total: transitionIds.length },
      scenarioCategories: { covered: scenarioIds.length, total: scenarioIds.length },
    },
  })
}

function deriveAuthorityVerdictFacts(
  content: (type: string) => Record<string, unknown>,
  executionFinishedAt?: string,
): { pendingDecisionIds: string[]; safetyFindings: string[] } {
  const pendingDecisionIds: string[] = []
  const safetyFindings: string[] = []
  const scopeDecision = objectAt(content('acceptance-scope'), 'scopeDecision')
  const scopeStatus = stringAt(scopeDecision, 'status')
  if (scopeStatus === 'pending') pendingDecisionIds.push(`SCOPE:${stringAt(scopeDecision, 'decisionId')}`)
  if (scopeStatus === 'rejected') safetyFindings.push('SCOPE_DECISION_REJECTED')
  const lineageDecision = objectAt(content('prd-diff'), 'lineageReview')
  const lineageStatus = stringAt(lineageDecision, 'status')
  if (lineageStatus === 'pending') pendingDecisionIds.push(`LINEAGE:${stringAt(lineageDecision, 'decisionId')}`)
  if (lineageStatus === 'rejected') safetyFindings.push('LINEAGE_DECISION_REJECTED')
  const grants = content('approval-grants')
  void executionFinishedAt
  for (const grant of arrayAt(grants, 'grants')) {
    const status = stringAt(grant, 'status')
    if (status === 'expired') safetyFindings.push(`EXECUTION_GRANT_EXPIRED:${stringAt(grant, 'grantId')}`)
    if (status === 'revoked') safetyFindings.push(`EXECUTION_GRANT_REVOKED:${stringAt(grant, 'grantId')}`)
    if (status === 'denied') safetyFindings.push(`EXECUTION_GRANT_DENIED:${stringAt(grant, 'grantId')}`)
  }
  return { pendingDecisionIds, safetyFindings }
}

function deriveCleanupVerdictAudit(
  content: (type: string) => Record<string, unknown>,
): VerdictInput['cleanupAudit'] {
  const leases = arrayAt(content('data-leases'), 'leases')
  const leaseById = new Map(leases.map((lease) => [stringAt(lease, 'leaseId'), lease]))
  const cleanupByLease = new Map(arrayAt(content('cleanup-results'), 'leaseResults')
    .map((item) => [stringAt(item, 'leaseId'), item]))
  const testCases = new Map(arrayAt(content('test-cases'), 'cases')
    .map((item) => [stringAt(item, 'caseId'), item]))
  const dataNeeds = new Map(arrayAt(content('execution-contract'), 'dataNeeds')
    .map((item) => [stringAt(item, 'leaseId'), item]))
  const actionEffects = new Map(arrayAt(content('browser-action-map'), 'actions')
    .map((item) => [stringAt(item, 'actionId'), stringAt(item, 'effect')]))
  const writeExecutions = arrayAt(content('browser-results'), 'caseResults').flatMap((caseResult) =>
    arrayAt(caseResult, 'stepResults')
      .filter((step) => ['passed', 'failed'].includes(stringAt(step, 'status'))
        && actionEffects.get(stringAt(step, 'actionId')) !== 'read')
      .map((step) => ({ caseResult, actionId: stringAt(step, 'actionId') })))
  let complete = leases.filter((lease) => {
    const leaseId = stringAt(lease, 'leaseId')
    const cleanupStatus = stringAt(cleanupByLease.get(leaseId) ?? {}, 'status')
    return stringAt(lease, 'status') === 'released'
      && (cleanupStatus === 'verified-clean' || cleanupStatus === 'not-needed')
  }).length
  const reasons: string[] = []
  let invalid = false
  for (const lease of leases) {
    const leaseId = stringAt(lease, 'leaseId')
    const cleanupStatus = stringAt(cleanupByLease.get(leaseId) ?? {}, 'status')
    if (cleanupStatus === 'failed' || cleanupStatus === 'unknown') {
      invalid = true
      reasons.push(`${cleanupStatus === 'failed' ? 'CLEANUP_LEASE_FAILED' : 'CLEANUP_LEASE_UNKNOWN'}:${leaseId}`)
    } else if (stringAt(lease, 'status') !== 'released'
      || !['verified-clean', 'not-needed'].includes(cleanupStatus)) {
      reasons.push(`CLEANUP_LEASE_MISSING:${leaseId}`)
    }
  }
  for (const execution of writeExecutions) {
    const caseId = stringAt(execution.caseResult, 'caseId')
    const cleanupRef = stringAt(execution.caseResult, 'cleanupRef')
    let closed = true
    if (stringAt(execution.caseResult, 'effectObservation') === 'unknown') {
      invalid = true
      reasons.push(`CLEANUP_WRITE_EFFECT_UNKNOWN:${caseId}:${execution.actionId}`)
      closed = false
    }
    if (cleanupRef === '') {
      reasons.push(`CLEANUP_WRITE_REF_MISSING:${caseId}:${execution.actionId}`)
      closed = false
    } else {
      const caseNeedIds = new Set(stringsAt(testCases.get(caseId) ?? {}, 'dataNeedIds'))
      const dataNeed = dataNeeds.get(cleanupRef)
      const lease = leaseById.get(cleanupRef)
      const cleanupStatus = stringAt(cleanupByLease.get(cleanupRef) ?? {}, 'status')
      if (!caseNeedIds.has(cleanupRef) || !dataNeed || stringAt(dataNeed, 'mode') !== 'write' || !lease) {
        reasons.push(`CLEANUP_WRITE_REF_UNKNOWN:${caseId}:${cleanupRef}`)
        closed = false
      } else if (stringAt(lease, 'status') !== 'released') {
        reasons.push(`CLEANUP_WRITE_LEASE_NOT_RELEASED:${cleanupRef}`)
        closed = false
      }
      if (cleanupStatus === 'failed' || cleanupStatus === 'unknown') {
        invalid = true
        reasons.push(`${cleanupStatus === 'failed' ? 'CLEANUP_WRITE_FAILED' : 'CLEANUP_WRITE_UNKNOWN'}:${cleanupRef}`)
        closed = false
      } else if (cleanupStatus !== 'verified-clean') {
        reasons.push(`CLEANUP_WRITE_RESULT_MISSING:${cleanupRef}`)
        closed = false
      }
    }
    if (closed) complete += 1
  }
  const total = leases.length + writeExecutions.length
  const reasonCodes = [...new Set(reasons)].sort()
  if (invalid) return { status: 'invalid', total, complete, reasonCodes }
  return complete === total
    ? { status: 'complete', total, complete, reasonCodes: [] }
    : { status: 'incomplete', total, complete, reasonCodes }
}

export type CleanupResultsMigration =
  | { status: 'migrated'; schemaVersion: '2.0.0'; content: { leaseResults: Array<{
    leaseId: string; status: 'not-needed' | 'failed'; digest: string
  }> } }
  | { status: 'migration-required'; findings: Array<{ code: string; ref: string }> }

/** v1→v2 安全迁移：released 不等价于 verified-clean，绝不猜测清理证明。 */
export function migrateCleanupResultsV1(candidate: unknown): CleanupResultsMigration {
  if (!isPlainObject(candidate) || !Array.isArray(candidate.leaseResults)) {
    return { status: 'migration-required', findings: [{ code: 'CLEANUP_V1_INVALID', ref: 'cleanup-results' }] }
  }
  const migrated: Array<{ leaseId: string; status: 'not-needed' | 'failed'; digest: string }> = []
  const findings: Array<{ code: string; ref: string }> = []
  for (const item of candidate.leaseResults) {
    if (!isPlainObject(item)) {
      findings.push({ code: 'CLEANUP_V1_INVALID', ref: 'leaseResults' })
      continue
    }
    const leaseId = stringAt(item, 'leaseId')
    const status = stringAt(item, 'status')
    const digest = stringAt(item, 'digest')
    if (status === 'not-applicable') migrated.push({ leaseId, status: 'not-needed', digest })
    else if (status === 'cleanup-failed') migrated.push({ leaseId, status: 'failed', digest })
    else findings.push({ code: 'CLEANUP_V1_VERIFICATION_REQUIRED', ref: `${leaseId}:${status}` })
  }
  return findings.length > 0
    ? { status: 'migration-required', findings: findings.sort((a, b) => a.ref.localeCompare(b.ref)) }
    : { status: 'migrated', schemaVersion: '2.0.0', content: { leaseResults: migrated } }
}

export type ApprovalGrantsMigrationResult =
  | { status: 'already-current'; schemaVersion: '2.0.0' }
  | { status: 'migration-required'; findings: Array<{ code: string; ref: string }> }

/** v1 只有自声明摘要和扁平 metadata，无法证明真实 Grant/当前撤销状态，禁止猜测迁移。 */
export function migrateApprovalGrantsV1(candidate: unknown): ApprovalGrantsMigrationResult {
  if (isPlainObject(candidate) && candidate.schemaVersion === '2.0.0') {
    return { status: 'already-current', schemaVersion: '2.0.0' }
  }
  return {
    status: 'migration-required',
    findings: [{ code: 'APPROVAL_GRANTS_V1_FRESHNESS_PROOF_UNAVAILABLE', ref: 'approval-grants' }],
  }
}

export function migrateBrowserPreflightV1(candidate: unknown): ApprovalGrantsMigrationResult {
  return rejectUnsafeV1(candidate, 'BROWSER_PREFLIGHT_V1_AUTHORITY_BINDING_UNAVAILABLE', 'browser-preflight')
}

export function migrateBrowserActionMapV1(candidate: unknown): ApprovalGrantsMigrationResult {
  return rejectUnsafeV1(candidate, 'BROWSER_ACTION_MAP_V1_CAPABILITY_OPERATION_UNAVAILABLE', 'browser-action-map')
}

export function migrateRunBundleV1(candidate: unknown): ApprovalGrantsMigrationResult {
  return rejectUnsafeV1(candidate, 'RUN_BUNDLE_V1_CAPABILITY_BINDING_UNAVAILABLE', 'run-bundle')
}

export function migrateProjectPolicyV1(candidate: unknown): ApprovalGrantsMigrationResult {
  return rejectUnsafeV1(candidate, 'PROJECT_POLICY_V1_RUNTIME_POLICY_UNAVAILABLE', 'project-policy')
}

function rejectUnsafeV1(candidate: unknown, code: string, ref: string): ApprovalGrantsMigrationResult {
  return isPlainObject(candidate) && candidate.schemaVersion === '2.0.0'
    ? { status: 'already-current', schemaVersion: '2.0.0' }
    : { status: 'migration-required', findings: [{ code, ref }] }
}

function completionAudit(total: number, complete: number, reasonCode: string): VerdictInput['evidenceAudit'] {
  return complete === total
    ? { status: 'complete', total, complete, reasonCodes: [] }
    : { status: 'incomplete', total, complete, reasonCodes: [reasonCode] }
}

function canonicalArrayEquals(left: unknown[], right: unknown[], key: string): boolean {
  const sort = (values: unknown[]) => [...values].sort((first, second) => {
    if (key === '') return canonicalizeJson(first).localeCompare(canonicalizeJson(second))
    const leftKey = isPlainObject(first) ? stringAt(first, key) : ''
    const rightKey = isPlainObject(second) ? stringAt(second, key) : ''
    return leftKey.localeCompare(rightKey)
  })
  return canonicalizeJson(sort(left)) === canonicalizeJson(sort(right))
}

/**
 * 生产调用入口。调用方必须持有 asset lock，并在成功后原子发布同一个不可变 staging 目录。
 * 文件通过 no-follow fd 读取，审计期间若发生写入会 fail-closed。
 */
export async function validateGenerationDirectory(
  generationRoot: string,
  input: Omit<ValidateGenerationInput, 'actualFiles'>,
): Promise<ReturnType<typeof validateGeneration>> {
  const actualFiles = await collectGenerationFiles(generationRoot)
  return validateGeneration({ ...input, actualFiles })
}

export async function collectGenerationFiles(generationRoot: string): Promise<AuditableFile[]> {
  const root = await realpath(generationRoot)
  const files: AuditableFile[] = []
  await walk(root)
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  async function walk(directory: string): Promise<void> {
    assertInsideRoot(root, directory)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw unsafeFile('E2E_GENERATION_SYMLINK_FORBIDDEN', absolutePath)
      if (entry.isDirectory()) {
        const resolved = await realpath(absolutePath)
        assertInsideRoot(root, resolved)
        await walk(resolved)
        continue
      }
      if (!entry.isFile()) throw unsafeFile('E2E_GENERATION_SPECIAL_FILE_FORBIDDEN', absolutePath)
      const resolved = await realpath(absolutePath)
      assertInsideRoot(root, resolved)
      const relativePath = relative(root, resolved).split(sep).join('/')
      if (!isSafeRelativePath(relativePath)) throw unsafeFile('E2E_GENERATION_FILE_PATH_INVALID', relativePath)
      const noFollow = constants.O_NOFOLLOW ?? 0
      const handle = await open(resolved, constants.O_RDONLY | noFollow)
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile()) throw unsafeFile('E2E_GENERATION_SPECIAL_FILE_FORBIDDEN', relativePath)
        const bytes = await handle.readFile()
        const after = await handle.stat({ bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== after.size) {
          throw unsafeFile('E2E_GENERATION_FILE_CHANGED_DURING_AUDIT', relativePath)
        }
        files.push({
          relativePath,
          digest: digestBytes(`generation-file:${relativePath}`, bytes),
          sanitizerOutputDigest: digestBytes('sanitizer-output/v1', bytes),
          bytes,
          byteLength: bytes.byteLength,
        })
      } finally {
        await handle.close()
      }
    }
  }
}

function assertInsideRoot(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw unsafeFile('E2E_GENERATION_PATH_ESCAPE', candidate)
  }
}

function unsafeFile(code: string, ref: string): E2EError {
  return new E2EError({ code, category: 'artifact', message: `Generation 文件不安全：${ref}`, retryable: false, refs: [ref] })
}

export function computeFinalizationSnapshotDigest(
  artifacts: Array<{ artifactId: string; artifactType: string; relativePath: string; digest: string }>,
): string {
  const facts = artifacts
    .filter((artifact) => artifact.artifactType !== 'final-report')
    .sort(compareManifestRecord)
  return digestText('generation-finalization-snapshot/v1', canonicalizeJson(facts))
}

export function computeGenerationRootDigest(content: {
  generationId: string
  fencingToken: number
  finalizationSnapshotDigest: string
  artifacts: Array<{ artifactId: string; artifactType: string; relativePath: string; digest: string }>
  files: AuditableFile[]
  terminalVerdict: string
}): string {
  return digestText('generation-root/v1', canonicalizeJson({
    generationId: content.generationId,
    fencingToken: content.fencingToken,
    finalizationSnapshotDigest: content.finalizationSnapshotDigest,
    artifacts: [...content.artifacts].sort(compareManifestRecord),
    files: [...content.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    terminalVerdict: content.terminalVerdict,
  }))
}

function compareManifestRecord(
  left: { artifactId: string; relativePath: string },
  right: { artifactId: string; relativePath: string },
): number {
  return left.artifactId.localeCompare(right.artifactId) || left.relativePath.localeCompare(right.relativePath)
}

function differingPaths(expected: unknown, actual: unknown, path = ''): string[] {
  if (Object.is(expected, actual)) return []
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return [path || '$']
    return expected.flatMap((value, index) => differingPaths(value, actual[index], appendPath(path, String(index))))
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    return keys.flatMap((key) => differingPaths(expected[key], actual[key], appendPath(path, key)))
  }
  return [path || '$']
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function appendPath(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}.${child}`
}
