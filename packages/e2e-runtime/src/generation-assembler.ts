import {
  canonicalizeJson,
  digestBytes,
  E2EError,
  type RuntimeProvenance,
} from '@mutil-skills/e2e-contracts'
import {
  buildCompleteGeneration,
  type BuildCompleteGenerationInput,
  type CompleteArtifactDraft,
  type CompleteGenerationAuthority,
  type CompleteGenerationBuild,
  type CompleteGenerationContext,
  type ReportPresentation,
} from '@mutil-skills/e2e-engine'
import type { GatewayPublicationAudit } from '@mutil-skills/e2e-gateway'
import type { RegressionPublicationResult } from './regression-publisher.js'
import { RuntimeExecutionBatch } from './runtime-execution-batch.js'

type FactDrafts = BuildCompleteGenerationInput['drafts']

export interface SanitizedRuntimeEvidence {
  evidenceId: string
  relativePath: string
  bytes: Uint8Array
}

export interface RuntimeCleanupResult {
  leaseId: string
  status: string
  digest: string
  [key: string]: unknown
}

export interface FinalizeRuntimeGenerationInput {
  context: CompleteGenerationContext
  semanticDrafts: Record<keyof FactDrafts, CompleteArtifactDraft>
  execution: RuntimeExecutionBatch
  gatewayAudit: GatewayPublicationAudit
  evidence: SanitizedRuntimeEvidence[]
  cleanup: RuntimeCleanupResult[]
  regression: RegressionPublicationResult
  provenance: RuntimeProvenance
  authorities: CompleteGenerationAuthority
  reportPresentation?: ReportPresentation
  verifiers?: Pick<BuildCompleteGenerationInput,
    'gatewayVerifier' | 'sanitizerVerifier' | 'privacyReviewVerifier'
    | 'regressionDiscoveryVerifier' | 'attemptProofVerifier' | 'executionOutcomeVerifier'>
}

type AssemblerDependencies = Omit<BuildCompleteGenerationInput,
  'context' | 'drafts' | 'provenance' | 'authority'> & { reportPresentation: ReportPresentation }

export class GenerationAssembler {
  constructor(private readonly dependencies: AssemblerDependencies) {}

  finalize(input: FinalizeRuntimeGenerationInput): CompleteGenerationBuild {
    assertRuntimeFactsBound(input)
    const { executionOutcomeVerifier, verdictDependencies, ...requiredDependencies } = this.dependencies
    const verifiers = input.verifiers ?? requiredDependencies
    return buildCompleteGeneration({
      context: input.context,
      provenance: input.provenance,
      drafts: input.semanticDrafts as FactDrafts,
      authority: input.authorities,
      ...requiredDependencies,
      reportPresentation: input.reportPresentation ?? this.dependencies.reportPresentation,
      ...verifiers,
      ...((input.verifiers?.executionOutcomeVerifier ?? executionOutcomeVerifier) === undefined ? {} : {
        executionOutcomeVerifier: input.verifiers?.executionOutcomeVerifier ?? executionOutcomeVerifier,
      }),
      ...(verdictDependencies === undefined ? {} : { verdictDependencies }),
    })
  }
}

function assertRuntimeFactsBound(input: FinalizeRuntimeGenerationInput): void {
  const drafts = input.semanticDrafts as FactDrafts
  const runBundle = record(drafts['run-bundle']?.content)
  const browserResults = record(drafts['browser-results']?.content)
  if (!(input.execution instanceof RuntimeExecutionBatch)
    || input.execution.runId !== runBundle.runId
    || input.execution.runId !== browserResults.runId) {
    throw assemblerError('E2E_GENERATION_ASSEMBLER_EXECUTION_UNBOUND')
  }
  input.execution.digest()
  if (canonicalizeJson(input.gatewayAudit) !== canonicalizeJson(drafts['gateway-audit']?.content)) {
    throw assemblerError('E2E_GENERATION_ASSEMBLER_GATEWAY_UNBOUND')
  }

  const evidenceContent = record(drafts['browser-evidence']?.content)
  const evidenceRecords = array(evidenceContent.artifacts)
  const evidenceFiles = drafts['browser-evidence']?.files ?? []
  if (input.evidence.length !== evidenceRecords.length || input.evidence.length !== evidenceFiles.length) {
    throw assemblerError('E2E_GENERATION_ASSEMBLER_EVIDENCE_INCOMPLETE')
  }
  for (const item of input.evidence) {
    const expectedDigest = digestBytes(`generation-file:${item.relativePath}`, item.bytes)
    const recordValue = evidenceRecords.find((candidate) => candidate.evidenceId === item.evidenceId
      && candidate.relativePath === item.relativePath)
    const file = evidenceFiles.find((candidate) => candidate.relativePath === item.relativePath)
    if (recordValue?.digest !== expectedDigest || recordValue.byteLength !== item.bytes.byteLength
      || file === undefined || !Buffer.from(file.base64, 'base64').equals(Buffer.from(item.bytes))) {
      throw assemblerError('E2E_GENERATION_ASSEMBLER_EVIDENCE_UNBOUND')
    }
  }

  const cleanup = array(record(drafts['cleanup-results']?.content).leaseResults)
  if (canonicalizeJson([...input.cleanup].sort(byLeaseId)) !== canonicalizeJson([...cleanup].sort(byLeaseId))) {
    throw assemblerError('E2E_GENERATION_ASSEMBLER_CLEANUP_UNBOUND')
  }

  const regression = record(drafts['regression-manifest']?.content)
  const listResult = record(regression.listResult)
  const regressionFiles = drafts['regression-manifest']?.files ?? []
  if (canonicalizeJson(listResult.attestation) !== canonicalizeJson(input.regression.discoveryAttestation)
    || input.regression.compilerInputDigest !== input.regression.discoveryAttestation.compilerInputDigest
    || input.regression.sourceSetDigest !== input.regression.discoveryAttestation.sourceSetDigest
    || canonicalizeJson(input.regression.caseIds) !== canonicalizeJson(listResult.caseIds)
    || input.regression.verifierMaterial === undefined
    || canonicalizeJson(regression.discoveryVerifierMaterial) !== canonicalizeJson(input.regression.verifierMaterial)
    || input.regression.files.length !== regressionFiles.length) {
    throw assemblerError('E2E_GENERATION_ASSEMBLER_REGRESSION_UNBOUND')
  }
  for (const file of input.regression.files) {
    const expected = regressionFiles.find((candidate) => candidate.relativePath === file.relativePath)
    if (expected === undefined || !Buffer.from(expected.base64, 'base64').equals(Buffer.from(file.bytes))) {
      throw assemblerError('E2E_GENERATION_ASSEMBLER_REGRESSION_UNBOUND')
    }
  }
}

function record(value: unknown): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw assemblerError('E2E_GENERATION_ASSEMBLER_FACT_MISSING')
  }
  return value as Record<string, any>
}

function array(value: unknown): Array<Record<string, any>> {
  if (!Array.isArray(value)) throw assemblerError('E2E_GENERATION_ASSEMBLER_FACT_MISSING')
  return value as Array<Record<string, any>>
}

function byLeaseId(left: Record<string, any>, right: Record<string, any>): number {
  return String(left.leaseId).localeCompare(String(right.leaseId))
}

function assemblerError(code: string): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false })
}
