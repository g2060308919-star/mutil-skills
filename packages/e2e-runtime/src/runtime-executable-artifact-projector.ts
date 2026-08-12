import {
  ArtifactSchemaRegistry,
  canonicalizeJson,
  digestArtifactContent,
  digestText,
  E2EError,
  type ArtifactDocument,
  type ArtifactType,
} from '@mutil-skills/e2e-contracts'
import type { ExecutableRunCompilation } from './prd-run-compiler.js'
import type { RuntimeRunSnapshot } from './run-store.js'

type ProjectedType = 'test-cases' | 'browser-action-map' | 'execution-contract' | 'run-bundle'

export interface RuntimeExecutableArtifactProjection {
  artifacts: Record<ProjectedType, ArtifactDocument>
  closure: {
    cases: Array<{ caseId: string; actionIds: string[]; oracleIds: string[] }>
  }
  runBundleRecipe: {
    schedule: Array<{ ordinal: number; caseId: string; stepIds: string[]; actionIds: string[] }>
    attemptPlans: Array<{ caseId: string; slots: number }>
  }
  regressionRecipe: { caseIds: string[]; blockedCases: ExecutableRunCompilation['blockedCases'] }
  projectionDigest: string
}

export function projectRuntimeExecutableArtifacts(input: {
  snapshot: RuntimeRunSnapshot
  compilation: ExecutableRunCompilation
  actionMapRevision?: number
  createdAt: string
  engineVersion: string
}): RuntimeExecutableArtifactProjection {
  if (input.compilation.executableCases.some((testCase) =>
    testCase.actions.some((action) => action.effect === 'reversible-write'))) {
    throw projectorError('E2E_RUNTIME_EXECUTABLE_WRITE_PROJECTION_INCOMPLETE')
  }
  const obligations = coverageObligations(input.snapshot)
  const obligationByCase = new Map<string, string[]>()
  for (const obligation of obligations) {
    if (obligation.disposition.kind !== 'automated') continue
    for (const caseId of obligation.disposition.caseIds) obligationByCase.set(caseId, [
      ...(obligationByCase.get(caseId) ?? []), obligation.obligationId,
    ])
  }
  const schedule = input.compilation.executableCases.map((testCase, ordinal) => ({
    ordinal, caseId: testCase.caseId,
    stepIds: testCase.actions.map((_, actionIndex) => stepId(testCase.caseId, actionIndex)),
    actionIds: testCase.actions.map((action) => action.actionId),
  }))
  const testCasesContent = {
    cases: input.compilation.executableCases.map((testCase) => ({
      caseId: testCase.caseId, revision: 1,
      obligationIds: [...(obligationByCase.get(testCase.caseId) ?? [])].sort(),
      title: testCase.caseId, actor: 'ACTOR', necessity: 'required' as const, preconditions: [], dataNeedIds: [],
      steps: testCase.actions.map((action, actionIndex) => ({
        stepId: stepId(testCase.caseId, actionIndex), ordinal: actionIndex,
        semanticAction: action.kind, semanticTarget: locatorSummary(action.locatorCandidates),
        oracles: testCase.oracles.filter((oracle) => oracle.actionId === action.actionId)
          .map((oracle) => ({ oracleId: oracle.oracleId, statement: oracleStatement(oracle) })),
        evidenceKinds: unique(testCase.oracles.filter((oracle) => oracle.actionId === action.actionId)
          .flatMap((oracle) => oracle.evidenceKinds)),
      })), mode: 'real-environment' as const, effect: 'read' as const, evidenceLevel: 'E1' as const,
      cleanupPlanId: 'not-applicable' as const, timeoutMs: Math.max(...testCase.actions.map((action) => action.timeout.timeoutMs)),
      retryPolicy: testCase.actions.some((action) => action.timeout.retry === 'read-only-max-2')
        ? 'read-automation-max-2' as const : 'none' as const,
      status: 'active' as const,
    })),
    caseSetDigest: digestText('runtime-executable-case-set/v1', canonicalizeJson({
      compilerDigest: input.compilation.compilerDigest,
      caseIds: input.compilation.executableCases.map((testCase) => testCase.caseId),
    })),
  }
  const pagePolicies = uniqueBy(input.compilation.executableCases.map((testCase) => testCase.pageIdentityPolicy),
    (policy) => canonicalizeJson(policy))
  const pageIdByPolicy = new Map(pagePolicies.map((policy, index) => [canonicalizeJson(policy), `PAGE-${index + 1}`]))
  const observedRequests = input.snapshot.targetProbe?.diagnostics.observedResources ?? []
  const firstActionId = input.compilation.executableCases[0]!.actions[0]!.actionId
  const readHttpRequests = observedRequests.map((request, index) => ({
    requestId: `REQUEST-DISCOVERED-${String(index + 1).padStart(4, '0')}`,
    method: request.method,
    url: request.url,
    headers: [],
    bodyDigest: digestText('runtime-http-signed-payload/v1', canonicalizeJson({ kind: 'no-body' })),
    redirectPolicy: { mode: 'deny' as const },
  }))
  const requestIds = readHttpRequests.map((request) => request.requestId)
  const browserActionMapContent = {
    actionMapRevision: input.actionMapRevision ?? 1,
    pageIdentities: pagePolicies.map((policy, index) => ({
      pageId: `PAGE-${index + 1}`, origin: policy.url.origin,
      assertionDigest: digestText('runtime-page-identity/v1', canonicalizeJson(policy)),
    })),
    actions: input.compilation.executableCases.flatMap((testCase) => testCase.actions.map((action, actionIndex) => ({
      caseId: testCase.caseId, stepId: stepId(testCase.caseId, actionIndex), actionId: action.actionId,
      pageIdentityId: pageIdByPolicy.get(canonicalizeJson(testCase.pageIdentityPolicy))!,
      locatorCandidates: action.locatorCandidates.map(projectLocator),
      playwrightAction: `declarative-browser/${action.kind}/v1`,
      waits: [{ kind: 'bounded', timeoutMs: action.timeout.timeoutMs }],
      oracleIds: testCase.oracles.filter((oracle) => oracle.actionId === action.actionId)
        .map((oracle) => oracle.oracleId), effect: action.effect,
      capabilities: [
        ...(action.actionId === firstActionId || action.kind === 'navigate'
          ? [{ operation: 'local-navigation' as const, capabilityId: `PENDING-${action.actionId}-NAV` }] : []),
        { operation: 'dom-read' as const, capabilityId: `PENDING-${action.actionId}-DOM` },
        { operation: 'screenshot' as const, capabilityId: `PENDING-${action.actionId}-SHOT` },
        ...(action.actionId === firstActionId && requestIds.length > 0
          ? [{ operation: 'http-request' as const, capabilityId: `PENDING-${action.actionId}-HTTP` }] : []),
      ], requestIds: action.actionId === firstActionId ? requestIds : [],
    }))), unmappedSteps: [], discoveredRisks: [], executionProfile: 'declarative-browser' as const,
  }
  const executionContractContent = {
    environment: 'RUNTIME-TARGET', baseOrigin: input.snapshot.targetProbe
      ? new URL(input.snapshot.targetProbe.observedUrl).origin : pagePolicies[0]!.url.origin,
    browserMatrix: [{ browserId: 'CHROME', channel: 'chrome', viewportId: 'DEFAULT' }], identities: [],
    caseQueue: schedule.map(({ ordinal, caseId }) => ({ ordinal, caseId })),
    actionIntents: input.compilation.executableCases.flatMap((testCase) => testCase.actions.map((action) => ({
      actionId: action.actionId, effect: action.effect,
      intentDigest: digestText('runtime-declarative-action-intent/v1', canonicalizeJson(action)),
      requestIds: action.actionId === firstActionId ? requestIds : [],
    }))), readHttpRequests, dataNeeds: [], manualProcedures: [],
    evidencePolicyDigest: digestText('runtime-declarative-evidence-policy/v1', 'screenshot,dom,url,network,console'),
    runtimeIsolation: null, unresolvedItems: [], executionProfile: 'declarative-browser' as const,
    declarativeExecutionBinding: withoutBindingDigest(input.compilation.normalizedBinding),
  }
  const coverageArtifact = requiredArtifact(input.snapshot, 'coverage-universe')
  const projectPolicyArtifact = requiredArtifact(input.snapshot, 'project-policy')
  const projectPolicyContent = projectPolicyArtifact.content as { runtimePolicy: { digest: string } }
  const testCases = artifact(input, 'test-cases', '1.0.0', testCasesContent, {
    dependencies: [dependency(coverageArtifact)],
    graph: { defines: input.compilation.executableCases.flatMap((testCase, caseIndex) => [
      { kind: 'CASE', id: testCase.caseId },
      ...testCase.actions.map((_, actionIndex) => ({ kind: 'STEP', id: stepId(testCase.caseId, actionIndex) })),
      ...testCase.oracles.map((oracle) => ({ kind: 'ORACLE', id: oracle.oracleId })),
    ]), references: [] },
  })
  const browserActionMap = artifact(input, 'browser-action-map', '2.1.0', browserActionMapContent, {
    dependencies: [dependency(testCases)],
    graph: { defines: [
      ...input.compilation.executableCases.flatMap((testCase) =>
        testCase.actions.map((action) => ({ kind: 'ACTION', id: action.actionId }))),
      ...pagePolicies.map((_, index) => ({ kind: 'PAGE', id: `PAGE-${index + 1}` })),
    ], references: input.compilation.executableCases.flatMap((testCase) => [
      { kind: 'CASE', id: testCase.caseId },
      ...testCase.actions.map((_, actionIndex) => ({ kind: 'STEP', id: stepId(testCase.caseId, actionIndex) })),
      ...testCase.oracles.map((oracle) => ({ kind: 'ORACLE', id: oracle.oracleId })),
    ]) },
  })
  const executionContract = artifact(input, 'execution-contract', '1.2.0', executionContractContent, {
    dependencies: [dependency(testCases), dependency(browserActionMap), dependency(projectPolicyArtifact)],
    graph: { defines: input.compilation.executableCases.flatMap((testCase) =>
      testCase.actions.map((action) => ({ kind: 'ACTION_INTENT', id: action.actionId }))),
    references: input.compilation.executableCases.flatMap((testCase) => [
      { kind: 'CASE', id: testCase.caseId },
      ...testCase.actions.map((action) => ({ kind: 'ACTION', id: action.actionId })),
    ]) },
  })
  const runBundleContent = {
    runId: input.snapshot.runId,
    allInputRefs: [testCases, browserActionMap, executionContract].map((item) => ({
      artifactId: item.artifactId, digest: item.contentDigest,
    })),
    schedule,
    attemptPlans: schedule.map(({ caseId }) => ({ caseId, slots: 1 })),
    signedCapabilities: [], secretRefs: [],
    runtimePolicyDigest: projectPolicyContent.runtimePolicy.digest,
    runtimeIsolationPolicyDigest: 'not-applicable' as const,
  }
  const runBundle = artifact(input, 'run-bundle', '2.0.0', runBundleContent, {
    dependencies: [dependency(testCases), dependency(browserActionMap), dependency(executionContract),
      dependency(projectPolicyArtifact)],
    graph: { defines: [{ kind: 'RUN', id: input.snapshot.runId }],
      references: schedule.flatMap((item) => [
        { kind: 'CASE', id: item.caseId },
        ...item.stepIds.map((id) => ({ kind: 'STEP', id })),
        ...item.actionIds.map((id) => ({ kind: 'ACTION', id })),
      ]) },
  })
  const artifacts = { 'test-cases': testCases, 'browser-action-map': browserActionMap,
    'execution-contract': executionContract, 'run-bundle': runBundle }
  const closure = { cases: input.compilation.executableCases.map((testCase) => ({
    caseId: testCase.caseId,
    actionIds: testCase.actions.map((action) => action.actionId),
    oracleIds: testCase.oracles.map((oracle) => oracle.oracleId),
  })) }
  const recipe = {
    artifacts, closure,
    runBundleRecipe: { schedule, attemptPlans: schedule.map(({ caseId }) => ({ caseId, slots: 1 })) },
    regressionRecipe: { caseIds: schedule.map(({ caseId }) => caseId), blockedCases: input.compilation.blockedCases },
  }
  return { ...recipe, projectionDigest: digestText(
    'runtime-executable-artifact-projection/v1', canonicalizeJson(recipe),
  ) }
}

function artifact(input: { snapshot: RuntimeRunSnapshot; createdAt: string; engineVersion: string },
  type: ProjectedType, schemaVersion: string, content: unknown, topology: {
    dependencies: ArtifactDocument['dependencies']
    graph: ArtifactDocument['graph']
  } = { dependencies: [], graph: { defines: [], references: [] } }): ArtifactDocument {
  const value: Record<string, unknown> = {
    artifactId: `ARTIFACT-${type.toUpperCase()}`, artifactType: type, schemaVersion,
    engineVersion: input.engineVersion, assetId: input.snapshot.assetId,
    prdRevision: input.snapshot.artifactDigests['prd-source'], generationId: input.snapshot.runId,
    createdAt: input.createdAt, contentDigest: '', signatures: [], dependencies: topology.dependencies,
    graph: topology.graph, content,
  }
  value.contentDigest = digestArtifactContent(`artifact-content/${schemaVersion}/${type}`, value)
  const parsed = ArtifactSchemaRegistry[type].safeParse(value)
  if (!parsed.success) throw projectorError('E2E_RUNTIME_EXECUTABLE_ARTIFACT_INVALID', parsed.error)
  return parsed.data as ArtifactDocument
}

function requiredArtifact(snapshot: RuntimeRunSnapshot, type: ArtifactType): ArtifactDocument {
  const parsed = ArtifactSchemaRegistry[type].safeParse(snapshot.frozenArtifacts[type])
  if (!parsed.success) throw projectorError(`E2E_RUNTIME_EXECUTABLE_${type.toUpperCase().replaceAll('-', '_')}_REQUIRED`, parsed.error)
  return parsed.data as ArtifactDocument
}

function dependency(artifact: ArtifactDocument): ArtifactDocument['dependencies'][number] {
  return { artifactId: artifact.artifactId, artifactType: artifact.artifactType,
    schemaVersion: artifact.schemaVersion, relativePath: `artifacts/${artifact.artifactType}.json`,
    digest: artifact.contentDigest }
}

function coverageObligations(snapshot: RuntimeRunSnapshot): Array<{
  obligationId: string
  disposition: { kind: string; caseIds: string[] }
}> {
  const parsed = ArtifactSchemaRegistry['coverage-universe'].safeParse(snapshot.frozenArtifacts['coverage-universe'])
  if (!parsed.success) throw projectorError('E2E_RUNTIME_EXECUTABLE_COVERAGE_REQUIRED', parsed.error)
  return parsed.data.content.obligations.map((item) => ({ obligationId: item.obligationId,
    disposition: { kind: item.disposition.kind, caseIds: item.disposition.kind === 'automated'
      ? item.disposition.caseIds : [] } }))
}

function stepId(caseId: string, index: number) { return `STEP-${caseId}-${String(index + 1).padStart(4, '0')}` }
function locatorSummary(locators: Array<Record<string, unknown>>) { return canonicalizeJson(locators[0] ?? { kind: 'page' }) }
function oracleStatement(oracle: Record<string, unknown>) { return canonicalizeJson(oracle) }
function projectLocator(locator: Record<string, unknown>) {
  if (locator.kind === 'role') return { strategy: 'role', value: `${locator.role}:${locator.name}`, confidence: 1 }
  if (locator.kind === 'css') return { strategy: 'css', value: String(locator.selector), confidence: 1 }
  return { strategy: String(locator.kind), value: String(locator.value), confidence: 1 }
}
function unique<T>(values: T[]): T[] { return [...new Set(values)] }
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()]
}
function withoutBindingDigest(binding: ExecutableRunCompilation['normalizedBinding']) {
  const { bindingDigest: _bindingDigest, ...candidate } = binding
  return candidate
}
function projectorError(code: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false, cause })
}
