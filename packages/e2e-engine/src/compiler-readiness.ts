import {
  digestApprovalProjection,
  digestArtifactContent,
  parseArtifactDocument,
  type ArtifactDocument,
  type ArtifactSignature,
} from '@mutil-skills/e2e-contracts'
import { auditDecisionReceipts, type DecisionReceiptVerifier } from './generation-audit.js'

export interface TrustedCompilerReadiness {}

export interface CreateTrustedCompilerReadinessRequest {
  artifacts: unknown[]
  contractsVersion: string
  verifyArtifactSignature(signature: ArtifactSignature): boolean
  verifyDecisionReceipt: DecisionReceiptVerifier
}

export interface TrustedCompilerReadinessBinding {
  assetId: string
  generationId: string
  prdRevision: string
  scopeDigest: string
  lineageDecisionDigest: string
  contractsVersion: string
  prdManifestArtifactDigest: string
  prdDiffArtifactDigest: string
  acceptanceScopeArtifactDigest: string
}

const REQUIRED_TYPES = ['prd-manifest', 'prd-diff', 'acceptance-scope'] as const
const bindings = new WeakMap<object, TrustedCompilerReadinessBinding>()

/**
 * Engine readiness 闸门：只在 PRD、lineage、scope 与 Contracts major 全部闭合后密封能力。
 * 调用方随后只能传递 opaque capability，不能用若干裸字符串替代本次审批结论。
 */
export function createTrustedCompilerReadiness(
  request: CreateTrustedCompilerReadinessRequest,
): TrustedCompilerReadiness {
  if (!request || typeof request !== 'object'
    || Object.keys(request).sort().join('\0')
      !== ['artifacts', 'contractsVersion', 'verifyArtifactSignature', 'verifyDecisionReceipt'].join('\0')
    || !Array.isArray(request.artifacts)
    || typeof request.verifyArtifactSignature !== 'function'
    || typeof request.verifyDecisionReceipt !== 'function') {
    throw new Error('E2E_COMPILER_READINESS_INPUT_INVALID')
  }
  const major = /^([0-9]+)\.[0-9]+\.[0-9]+$/.exec(request.contractsVersion)?.[1]
  if (major !== '2') throw new Error('E2E_COMPILER_READINESS_CONTRACTS_MAJOR_UNSUPPORTED')

  const documents = request.artifacts.map((candidate) => verifyArtifact(candidate, request.verifyArtifactSignature))
  const byType = new Map<string, ArtifactDocument>()
  for (const document of documents) {
    if (!REQUIRED_TYPES.includes(document.artifactType as (typeof REQUIRED_TYPES)[number])
      || byType.has(document.artifactType)) {
      throw new Error('E2E_COMPILER_READINESS_ARTIFACT_SET_INVALID')
    }
    byType.set(document.artifactType, document)
  }
  if (byType.size !== REQUIRED_TYPES.length) throw new Error('E2E_COMPILER_READINESS_ARTIFACT_SET_INVALID')
  const manifest = byType.get('prd-manifest')!
  const diff = byType.get('prd-diff')!
  const scope = byType.get('acceptance-scope')!
  if ([diff, scope].some((artifact) => artifact.assetId !== manifest.assetId
    || artifact.generationId !== manifest.generationId || artifact.prdRevision !== manifest.prdRevision)) {
    throw new Error('E2E_COMPILER_READINESS_GENERATION_MISMATCH')
  }
  const manifestContent = record(manifest.content)
  const diffContent = record(diff.content)
  const scopeContent = record(scope.content)
  if (manifestContent.assetId !== manifest.assetId || manifestContent.revision !== manifest.prdRevision
    || diffContent.currentRevision !== manifest.prdRevision
    || record(diffContent.lineageReview).status !== 'approved'
    || record(scopeContent.scopeDecision).status !== 'approved') {
    throw new Error('E2E_COMPILER_READINESS_PRD_OR_DECISION_INVALID')
  }
  const decisionAudit = auditDecisionReceipts([manifest, diff, scope], request.verifyDecisionReceipt)
  if (!decisionAudit.valid) {
    throw new Error(`E2E_COMPILER_READINESS_DECISION_INVALID:${decisionAudit.findings.map((finding) => finding.code).join(',')}`)
  }
  const lineageReceipt = record(record(diffContent.lineageReview).receipt)
  const readiness = Object.freeze({})
  bindings.set(readiness, {
    assetId: manifest.assetId,
    generationId: manifest.generationId,
    prdRevision: manifest.prdRevision,
    scopeDigest: digestApprovalProjection('acceptance-scope', scope.content),
    lineageDecisionDigest: text(lineageReceipt.signedDigest),
    contractsVersion: request.contractsVersion,
    prdManifestArtifactDigest: manifest.contentDigest,
    prdDiffArtifactDigest: diff.contentDigest,
    acceptanceScopeArtifactDigest: scope.contentDigest,
  })
  return readiness
}

export function inspectTrustedCompilerReadiness(value: unknown): TrustedCompilerReadinessBinding | undefined {
  return value && typeof value === 'object'
    ? structuredClone(bindings.get(value as object))
    : undefined
}

function verifyArtifact(
  candidate: unknown,
  verifySignature: (signature: ArtifactSignature) => boolean,
): ArtifactDocument {
  const artifact = parseArtifactDocument(candidate)
  const contentDigest = digestArtifactContent(
    `artifact-content/${artifact.schemaVersion}/${artifact.artifactType}`,
    artifact as unknown as Record<string, unknown>,
  )
  if (artifact.contentDigest !== contentDigest || artifact.signatures.length !== 1
    || artifact.signatures[0]!.signedDigest !== contentDigest
    || !verifySignature(artifact.signatures[0]!)) {
    throw new Error('E2E_COMPILER_READINESS_ARTIFACT_NOT_VERIFIED')
  }
  return artifact
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E2E_COMPILER_READINESS_CONTENT_INVALID')
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('E2E_COMPILER_READINESS_CONTENT_INVALID')
  }
  return value
}
