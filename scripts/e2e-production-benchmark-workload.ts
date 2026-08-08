import {
  RequirementModelSchema,
  canonicalizeJson,
  deriveExecutionResultId,
  digestBytes,
  digestOracleCheckpointValue,
  digestPrdUnderstandingProjection,
  digestPrdUnderstandingQuote,
  digestText,
  projectAssertionResultV1,
  type DeclarativePrdRunDesign,
  type PrdUnderstandingProjection,
  type RequirementModel,
  type VerdictInput,
} from '@mutil-skills/e2e-contracts'
import {
  LocalArtifactStore,
  buildCompleteGeneration,
  buildCoverageUniverse,
  computeVerdict,
} from '@mutil-skills/e2e-engine'
import { renderCompleteReport } from '@mutil-skills/e2e-report'
import { Buffer } from 'node:buffer'
import { realpath } from 'node:fs/promises'
import { compilePrdRun } from '../packages/e2e-runtime/src/prd-run-compiler.js'
import { createCaseSchedule } from '../packages/e2e-runtime/src/multi-case-scheduler.js'
import { createPersistedRuntimeFinalizationMaterial } from '../packages/e2e-runtime/src/production-finalization-material-provider.js'
import type { ProductionBenchmarkPhase } from '../packages/e2e-runtime/src/production-performance-proof.js'
import { createArtifactStoreAuthority } from '../packages/e2e-engine/test/artifact-store-authority.js'
import { completeGenerationFixture } from '../packages/e2e-engine/test/complete-generation.fixture.js'

const COUNTS = { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 } as const
const createdAt = '2026-08-08T00:00:00.000Z'

export interface ProductionBenchmarkWorkload {
  fixtureDigest: string
  fixtureCounts: typeof COUNTS
  run(phase: ProductionBenchmarkPhase, ordinal: number): Promise<{
    outputBytes: number
    facts: typeof COUNTS
  }>
  close(): Promise<void>
}

export async function createProductionBenchmarkWorkload(input: {
  artifactRoot: string
}): Promise<ProductionBenchmarkWorkload> {
  const source = createSourceFixture()
  const fixtureDigest = digestText('e2e-production-benchmark-fixture/v1', canonicalizeJson(source))

  // 每个被测阶段的上游输入都在计时前构造，避免把 fixture 生成成本混入生产模块耗时。
  const compiledPlan = compilePrdRun({ understanding: source.understanding, design: source.design })
  const requirementModel = RequirementModelSchema.parse(source.requirementModel)
  const coverage = buildCoverageUniverse({
    model: requirementModel,
    modelDigest: source.modelDigest,
    confirmedModelDigest: source.modelDigest,
    nodes: [],
    policy: source.coveragePolicy,
    dispositionFor: (candidate) => ({
      kind: 'automated',
      caseIds: [caseId(ruleOrdinal(candidate.ruleIds[0]!))],
    }),
  })
  if (coverage.obligations.length !== COUNTS.obligations) {
    throw new Error(`E2E_PRODUCTION_BENCHMARK_OBLIGATION_COUNT_INVALID:${coverage.obligations.length}`)
  }
  const checkpointSources = coverage.obligations.map((obligation, index) => {
    const value = canonicalizeJson({ satisfied: true, ordinal: index + 1 })
    return {
      checkpointId: `CHECKPOINT-${index + 1}`,
      oracleId: obligation.oracleIds[0]!,
      expectedJson: value,
      actualJson: value,
      expectedDigest: digestOracleCheckpointValue(value),
      actualDigest: digestOracleCheckpointValue(value),
      status: 'passed' as const,
      evidenceIds: [`EVIDENCE-${index + 1}`],
    }
  })
  const verdictInput = createVerdictInput(coverage.obligations, source.modelDigest, coverage.universeDigest)
  const verdict = computeVerdict(verdictInput, { verifyAttemptSelection: () => true })
  if (verdict.verdict !== 'accepted') throw new Error(`E2E_PRODUCTION_BENCHMARK_VERDICT_INVALID:${verdict.verdict}`)
  const finalizationFixture = completeGenerationFixture()
  const finalizationMaterialInput = {
    runId: 'RUN-BENCHMARK',
    attemptId: 'ATTEMPT-BENCHMARK',
    artifacts: buildCompleteGeneration(finalizationFixture).artifacts
      .filter((artifact) => !['final-report', 'generation-manifest'].includes(artifact.artifactType))
      .map((artifact) => ({ artifact, relativePath: `run/${artifact.artifactType}.json` })),
    execution: {
      runId: 'RUN-BENCHMARK', attemptId: 'ATTEMPT-BENCHMARK',
      realEnvironmentResults: [], injectionResults: [],
    },
    gatewayAudit: { status: 'valid', forwarded: 0, blocked: 0 },
    evidence: checkpointSources.map((checkpoint, index) => {
      const relativePath = `evidence/checkpoint-${index + 1}.json`
      const bytes = Buffer.from(checkpoint.actualJson)
      return {
        evidenceId: checkpoint.evidenceIds[0]!, relativePath,
        quarantinePath: `sanitized/checkpoint-${index + 1}.json`,
        byteLength: bytes.byteLength,
        digest: digestBytes(`generation-file:${relativePath}`, bytes),
      }
    }),
    cleanup: [],
    provenance: finalizationFixture.provenance,
    reportPresentation: finalizationFixture.reportPresentation,
    verifierMaterials: {},
  }
  const reportArtifact = createScaleReportArtifact(coverage, verdictInput, verdict)
  const rendered = renderCompleteReport(reportArtifact)
  const publicationFiles = {
    'requirements/requirement-model.json': `${canonicalizeJson(requirementModel)}\n`,
    'run/compiled-prd-run.json': `${canonicalizeJson(compiledPlan)}\n`,
    'run/coverage-universe.json': `${canonicalizeJson(coverage)}\n`,
    'run/verdict.json': `${canonicalizeJson(verdict)}\n`,
    'run/final-report.json': rendered.json,
    'run/final-report.html': rendered.html,
  }
  const store = new LocalArtifactStore(await realpath(input.artifactRoot), createArtifactStoreAuthority())

  return {
    fixtureDigest,
    fixtureCounts: COUNTS,
    async run(phase, ordinal) {
      let output: unknown
      switch (phase) {
        case 'compiler':
          output = compilePrdRun({ understanding: source.understanding, design: source.design })
          break
        case 'requirement-graph':
          output = RequirementModelSchema.parse(source.requirementModel)
          break
        case 'coverage-audit':
          output = buildCoverageUniverse({
            model: requirementModel,
            modelDigest: source.modelDigest,
            confirmedModelDigest: source.modelDigest,
            nodes: [],
            policy: source.coveragePolicy,
            dispositionFor: (candidate) => ({
              kind: 'automated', caseIds: [caseId(ruleOrdinal(candidate.ruleIds[0]!))],
            }),
          })
          break
        case 'case-schedule':
          output = createCaseSchedule(compiledPlan, createdAt)
          break
        case 'checkpoint-finalization':
          output = {
            assertions: checkpointSources.map(projectAssertionResultV1),
            material: createPersistedRuntimeFinalizationMaterial(finalizationMaterialInput),
          }
          break
        case 'engine-verdict':
          output = computeVerdict(verdictInput, { verifyAttemptSelection: () => true })
          break
        case 'report-render':
          output = renderCompleteReport(reportArtifact)
          break
        case 'artifact-publication': {
          const active = await store.publish({
            assetId: 'ASSET-BENCHMARK',
            generationId: `GEN-BENCHMARK-${ordinal + 1}`,
            terminalVerdict: 'accepted',
            files: publicationFiles,
          })
          output = { generationId: active.generationId, files: Object.keys(publicationFiles) }
          break
        }
      }
      return {
        outputBytes: phase === 'artifact-publication'
          ? Object.values(publicationFiles).reduce((total, value) => total + Buffer.byteLength(value), 0)
          : Buffer.byteLength(canonicalizeJson(output)),
        facts: COUNTS,
      }
    },
    async close() {
      // LocalArtifactStore 不保留常驻 handle；目录生命周期由 worker/调用方管理。
    },
  }
}

function createSourceFixture(): {
  understanding: PrdUnderstandingProjection
  design: DeclarativePrdRunDesign
  requirementModel: RequirementModel
  modelDigest: string
  coveragePolicy: { policyVersion: '1.0.0'; ruleScenarios: {
    business: string[]; validation: string[]
  }; pairwiseSeed: number }
} {
  const nodes = Array.from({ length: COUNTS.requirements }, (_, requirementIndex) => {
    const ordinal = requirementIndex + 1
    const quote = `Requirement ${ordinal} must expose ten observable outcomes.`
    return {
      nodeId: `REQ-${ordinal}`,
      kind: 'REQ' as const,
      statement: quote,
      provenance: { kind: 'source-fact' as const, anchors: [{
        sourceId: 'PRD',
        sourceSpan: {
          startLine: ordinal, startColumn: 1, endLine: ordinal, endColumn: quote.length + 1,
        },
        quote,
        quoteDigest: digestPrdUnderstandingQuote(quote),
      }] },
      responsibility: 'PRODUCT',
      upstreamNodeIds: [],
      downstreamNodeIds: [],
      acceptanceCriteria: Array.from({ length: 10 }, (_, index) =>
        `REQ-${ordinal} observable outcome ${index + 1}`),
    }
  })
  const projectionDraft = {
    schemaVersion: '1.0.0' as const,
    contractId: 'CONTRACT-BENCHMARK',
    contractVersion: 1,
    contractStatus: 'confirmed-by-caller' as const,
    contractSourceDigest: digestText('benchmark-contract/v1', 'contract'),
    sourceRevision: digestText('benchmark-source/v1', 'source'),
    sources: [{
      sourceId: 'PRD', kind: 'file' as const, ref: 'benchmark-prd.md',
      origin: { kind: 'file' as const, ref: 'benchmark-prd.md' },
      relevance: 'target' as const,
      digest: digestText('benchmark-prd/v1', 'prd'), byteLength: 100_000,
    }],
    nodes,
    pendingQuestions: [],
    route: {
      skillName: 'e2e' as const,
      steps: nodes.map((node, index) => ({
        stepId: `STEP-${index + 1}`,
        inputNodeIds: [node.nodeId],
        output: 'E2E Cases',
        constraints: [],
        dependencyStepIds: [],
        completionCondition: `${node.nodeId} criteria executed`,
      })),
    },
    authorization: {
      status: 'confirmed-by-caller' as const,
      contractVersion: 1,
      confirmedAt: createdAt,
      authorizedNodeIds: nodes.map((node) => node.nodeId),
    },
  }
  const understanding = {
    ...projectionDraft,
    projectionDigest: digestPrdUnderstandingProjection(projectionDraft),
  } as PrdUnderstandingProjection
  const design: DeclarativePrdRunDesign = {
    schemaVersion: '1.0.0',
    cases: Array.from({ length: COUNTS.cases }, (_, caseIndex) => {
      const requirementIndex = Math.floor(caseIndex / 2)
      const node = nodes[requirementIndex]!
      const criterionOffset = caseIndex % 2 * 5
      return {
        caseKey: `case-${caseIndex + 1}`,
        title: `Benchmark Case ${caseIndex + 1}`,
        actor: 'BENCHMARK-ACTOR',
        contractNodeIds: [node.nodeId],
        failurePolicy: 'continue' as const,
        actions: [{
          actionKey: 'observe', kind: 'full-playwright' as const,
          effect: 'read' as const, statement: 'Observe requirement outcomes',
        }],
        oracles: Array.from({ length: 5 }, (_, oracleIndex) => ({
          oracleKey: `oracle-${oracleIndex + 1}`,
          actionKey: 'observe',
          contractNodeId: node.nodeId,
          acceptanceCriterion: node.acceptanceCriteria[criterionOffset + oracleIndex]!,
        })),
      }
    }),
  }
  const modelDigest = digestText('requirement-model/v1', 'production-benchmark-confirmed-model')
  const requirementModel: RequirementModel = {
    modelRevision: 1,
    requirements: Array.from({ length: COUNTS.requirements }, (_, requirementIndex) => {
      const reqOrdinal = requirementIndex + 1
      const rules = Array.from({ length: 4 }, (_, localRuleIndex) => {
        const ruleIndex = requirementIndex * 4 + localRuleIndex
        const ordinal = ruleIndex + 1
        return {
          ruleId: `RULE-${ordinal}`,
          category: ruleIndex < 1_000 ? 'business' as const : 'validation' as const,
          statement: `Rule ${ordinal} is observable`,
          sourceRefs: [`prd:${reqOrdinal}`],
          certainty: 'explicit' as const,
          oracleIds: [`ORACLE-${ordinal}`],
        }
      })
      return {
        reqId: `REQ-${reqOrdinal}`, revision: 1, title: `Requirement ${reqOrdinal}`,
        actors: ['BENCHMARK-ACTOR'], entities: [`ENTITY-${reqOrdinal}`], preconditions: [],
        rules, states: [], transitions: [],
        observableOutcomes: rules.map((rule) => ({
          oracleId: rule.oracleIds[0]!, ruleId: rule.ruleId,
          statement: `${rule.ruleId} outcome visible`, sourceRefs: rule.sourceRefs,
        })),
        applicability: [], sourceRefs: [`prd:${reqOrdinal}`], status: 'active' as const,
      }
    }),
    coupledDimensions: [], applicabilityRules: [], modelDecisionDigest: modelDigest,
  }
  return {
    understanding,
    design,
    requirementModel,
    modelDigest,
    coveragePolicy: {
      policyVersion: '1.0.0',
      ruleScenarios: {
        business: ['happy-path', 'negative'],
        validation: ['valid', 'invalid', 'boundary'],
      },
      pairwiseSeed: 20260808,
    },
  }
}

function createVerdictInput(
  obligations: Awaited<ReturnType<typeof buildCoverageUniverse>>['obligations'],
  requirementModelDigest: string,
  universeDigest: string,
): VerdictInput {
  const obligationsByCase = new Map<string, string[]>()
  for (const obligation of obligations) {
    const id = obligation.disposition.kind === 'automated' ? obligation.disposition.caseIds[0]! : ''
    const existing = obligationsByCase.get(id) ?? []
    existing.push(obligation.obligationId)
    obligationsByCase.set(id, existing)
  }
  return {
    schemaVersion: '2.1.0', assetId: 'ASSET-BENCHMARK', generationId: 'GEN-BENCHMARK',
    verdictRuleVersion: '2.0.0', policyDigest: digestText('benchmark/v1', 'policy'),
    universeDigest, prdRevision: digestText('benchmark/v1', 'prd'), requirementModelDigest,
    obligations: obligations.map((obligation) => ({
      obligationId: obligation.obligationId,
      necessity: 'required',
      disposition: 'automated',
      caseIds: obligation.disposition.kind === 'automated' ? obligation.disposition.caseIds : [],
    })),
    caseResults: Array.from({ length: COUNTS.cases }, (_, index) => {
      const id = caseId(index + 1)
      return {
        resultId: deriveExecutionResultId(id, 'real-environment'),
        caseId: id,
        runId: 'RUN-BENCHMARK',
        obligationIds: obligationsByCase.get(id) ?? [],
        status: 'passed' as const,
        executionMode: 'real-environment' as const,
        attemptSelection: {
          status: 'valid' as const,
          attemptId: `ATTEMPT-${index + 1}`,
          eventChainDigest: digestText('benchmark-attempt/v1', id),
        },
      }
    }),
    manualResults: [], pendingDecisionIds: [], safetyFindings: [], artifactFindings: [],
    migrationFindings: [], environmentFindings: [], automationFindings: [],
    gatewayAudit: { status: 'valid', required: true, reasonCodes: [] },
    evidenceAudit: { status: 'complete', total: COUNTS.cases, complete: COUNTS.cases, reasonCodes: [] },
    cleanupAudit: { status: 'complete', total: 0, complete: 0, reasonCodes: [] },
    coverageFacts: {
      prdClauses: { covered: COUNTS.requirements, total: COUNTS.requirements },
      requirementDesign: { covered: COUNTS.requirements, total: COUNTS.requirements },
      rules: { covered: COUNTS.rules, total: COUNTS.rules },
      oracles: { covered: COUNTS.rules, total: COUNTS.rules },
      cases: { covered: COUNTS.cases, total: COUNTS.cases },
      criticalNodes: { covered: 0, total: 0 }, roles: { covered: 1, total: 1 },
      stateTransitions: { covered: 0, total: 0 }, scenarioCategories: { covered: 5, total: 5 },
    },
  }
}

function createScaleReportArtifact(
  coverage: ReturnType<typeof buildCoverageUniverse>,
  verdictInput: VerdictInput,
  verdict: ReturnType<typeof computeVerdict>,
) {
  const artifact = structuredClone(buildCompleteGeneration(completeGenerationFixture()).artifacts
    .find((item) => item.artifactType === 'final-report')!) as any
  const baseCase = artifact.content.caseDetails[0]
  artifact.content.coverageUniverse = {
    universeDigest: coverage.universeDigest,
    obligations: coverage.obligations.map((obligation) => ({
      obligationId: obligation.obligationId,
      title: `${obligation.ruleIds[0]} ${obligation.scenario}`,
      necessity: 'required',
      disposition: 'automated',
      caseIds: obligation.disposition.caseIds,
    })),
  }
  artifact.content.caseDetails = verdictInput.caseResults.map((result, index) => ({
    ...structuredClone(baseCase),
    resultId: result.resultId,
    caseId: result.caseId,
    title: `Benchmark Case ${index + 1}`,
  }))
  artifact.content.realResults = verdictInput.caseResults.map((result) => ({
    id: result.resultId,
    digest: digestText('benchmark-result/v1', result.resultId),
  }))
  artifact.content.injectionResults = []
  artifact.content.traceabilityMatrix = coverage.obligations.map((obligation, index) => ({
    reqId: obligation.reqId,
    ruleId: obligation.ruleIds[0]!,
    obligationId: obligation.obligationId,
    caseId: obligation.disposition.kind === 'automated'
      ? obligation.disposition.caseIds[0]!
      : caseId(index + 1),
    stepId: 'STEP-1',
    evidenceId: `EVIDENCE-${index + 1}`,
    evidencePath: 'evidence/case-1.json',
  }))
  artifact.content.regressionDetails.caseIds = verdictInput.caseResults.map((result) => result.caseId)
  artifact.content.metrics = verdict.metrics
  artifact.content.verdictInputDigest = digestText('benchmark-verdict-input/v1', canonicalizeJson(verdictInput))
  artifact.content.verdict = verdict.verdict
  artifact.content.reasonCodes = verdict.reasonCodes
  return artifact
}

function ruleOrdinal(ruleId: string): number {
  const ordinal = Number(ruleId.slice('RULE-'.length))
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('E2E_PRODUCTION_BENCHMARK_RULE_ID_INVALID')
  return ordinal
}

function caseId(ordinal: number): string {
  return `CASE-${String((ordinal - 1) % COUNTS.cases + 1).padStart(4, '0')}`
}
