import {
  AcceptanceReviewSchema,
  canonicalizeJson,
  digestText,
  E2EError,
  type AcceptanceReview,
} from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const AcceptanceReviewReceiptSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  reviewDigest: DigestSchema,
  approver: z.literal('local-caller'),
  approvalMode: z.literal('local-confirmation'),
  identityVerified: z.literal(false),
  separationOfDutiesVerified: z.literal(false),
  confirmedAt: z.string().datetime(),
  receiptDigest: DigestSchema,
}).strict()

export type AcceptanceReviewReceipt = z.infer<typeof AcceptanceReviewReceiptSchema>

export function confirmAcceptanceReview(input: {
  review: AcceptanceReview
  expectedReviewDigest: string
  confirmedAt: string
}): AcceptanceReviewReceipt {
  const review = AcceptanceReviewSchema.parse(input.review)
  if (review.reviewDigest !== input.expectedReviewDigest) {
    throw reviewError('E2E_ACCEPTANCE_REVIEW_DIGEST_MISMATCH')
  }
  const material = {
    schemaVersion: '1.0.0' as const,
    reviewDigest: review.reviewDigest,
    approver: 'local-caller' as const,
    approvalMode: 'local-confirmation' as const,
    identityVerified: false as const,
    separationOfDutiesVerified: false as const,
    confirmedAt: input.confirmedAt,
  }
  return AcceptanceReviewReceiptSchema.parse({
    ...material,
    receiptDigest: digestText('e2e-acceptance-review-receipt/v1', canonicalizeJson(material)),
  })
}

interface Clause {
  clauseId: string
  sourceId: string
  sourceSpan: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  originalText: string
}

interface ScopeDisposition {
  clauseId: string
  disposition: 'modeled' | 'excluded' | 'not-applicable' | 'ambiguous'
  requirementIds?: string[]
}

interface Requirement {
  reqId: string
  contractNodeIds?: string[]
  rules: Array<{ ruleId: string; oracleIds: string[] }>
  observableOutcomes: Array<{ oracleId: string; ruleId: string }>
}

interface Obligation {
  reqId: string
  clauseIds: string[]
  ruleIds: string[]
  oracleIds: string[]
  disposition: { kind: string; caseIds?: string[] }
}

/**
 * 从 Runtime 已严格冻结的资产构建不可由 Skill 改写的验收语义视图。
 * 本模块不产生新需求；任一已建模 Clause 链路不完整都 fail closed。
 */
export function buildAcceptanceReview(snapshot: RuntimeRunSnapshot): AcceptanceReview {
  const plan = snapshot.compiledPrdRun
  if (plan === undefined) throw reviewError('E2E_ACCEPTANCE_REVIEW_COMPILED_PLAN_REQUIRED')

  const clauses = readArray<Clause>(snapshot, 'prd-manifest', 'clauses')
  const dispositions = readArray<ScopeDisposition>(snapshot, 'acceptance-scope', 'clauseDispositions')
  const requirements = readArray<Requirement>(snapshot, 'requirement-model', 'requirements')
  const obligations = readArray<Obligation>(snapshot, 'coverage-universe', 'obligations')
  const ambiguities = readArray<{ question: string; status: string }>(
    snapshot, 'acceptance-scope', 'ambiguities', true,
  )
  const dispositionByClause = uniqueMap(dispositions, (item) => item.clauseId)
  const requirementById = uniqueMap(requirements, (item) => item.reqId)

  const links = clauses.map((clause) => {
    const disposition = dispositionByClause.get(clause.clauseId)
    if (disposition === undefined) throw reviewError('E2E_ACCEPTANCE_REVIEW_DISPOSITION_REQUIRED')
    const requirementIds = disposition.disposition === 'modeled'
      ? uniqueSorted(disposition.requirementIds ?? []) : []
    const selectedRequirements = requirementIds.map((reqId) => {
      const requirement = requirementById.get(reqId)
      if (requirement === undefined) throw reviewError('E2E_ACCEPTANCE_REVIEW_CHAIN_INCOMPLETE')
      return requirement
    })
    const ruleIds = uniqueSorted(selectedRequirements.flatMap((requirement) =>
      requirement.rules.map((rule) => rule.ruleId)))
    const oracleIds = uniqueSorted(selectedRequirements.flatMap((requirement) =>
      requirement.observableOutcomes.map((oracle) => oracle.oracleId)))
    const caseIds = new Set<string>()
    const contractNodeIds = new Set(selectedRequirements.flatMap((requirement) =>
      requirement.contractNodeIds ?? []))
    for (const testCase of plan.cases) {
      if (testCase.contractNodeIds.some((nodeId) => contractNodeIds.has(nodeId))) {
        caseIds.add(testCase.caseId)
      }
    }
    for (const obligation of obligations) {
      if (!obligation.clauseIds.includes(clause.clauseId)
        && !requirementIds.includes(obligation.reqId)) continue
      if (obligation.disposition.kind === 'automated') {
        for (const caseId of obligation.disposition.caseIds ?? []) caseIds.add(caseId)
      }
    }
    if (disposition.disposition === 'modeled'
      && (requirementIds.length === 0 || ruleIds.length === 0
        || oracleIds.length === 0 || caseIds.size === 0)) {
      throw reviewError('E2E_ACCEPTANCE_REVIEW_CHAIN_INCOMPLETE')
    }
    return {
      clauseId: clause.clauseId,
      sourceSpan: { sourceId: clause.sourceId, ...clause.sourceSpan },
      sourceText: clause.originalText,
      disposition: disposition.disposition,
      requirementIds,
      ruleIds,
      oracleIds,
      caseIds: [...caseIds],
    }
  })
  if (links.length !== dispositions.length) {
    throw reviewError('E2E_ACCEPTANCE_REVIEW_DISPOSITION_REQUIRED')
  }
  const draft = {
    schemaVersion: '1.0.0' as const,
    runId: snapshot.runId,
    contractProjectionDigest: plan.contractProjectionDigest,
    compilerDigest: plan.compilerDigest,
    links,
    includedClauseIds: links.filter((link) => link.disposition === 'modeled')
      .map((link) => link.clauseId),
    excludedClauseIds: links.filter((link) => link.disposition === 'excluded'
      || link.disposition === 'not-applicable').map((link) => link.clauseId),
    unresolvedItems: ambiguities.filter((item) => item.status === 'pending')
      .map((item) => item.question),
  }
  return AcceptanceReviewSchema.parse({
    ...draft,
    reviewDigest: digestText('e2e-acceptance-review/v1', canonicalizeJson(draft)),
  })
}

function readArray<T>(
  snapshot: RuntimeRunSnapshot,
  artifactType: string,
  field: string,
  optional = false,
): T[] {
  const artifact = snapshot.frozenArtifacts[artifactType]
  const content: unknown = artifact?.content
  if (!record(content)) {
    if (optional) return []
    throw reviewError('E2E_ACCEPTANCE_REVIEW_ARTIFACT_REQUIRED')
  }
  const value = content[field]
  if (!Array.isArray(value)) {
    if (optional) return []
    throw reviewError('E2E_ACCEPTANCE_REVIEW_ARTIFACT_REQUIRED')
  }
  return value as T[]
}

function uniqueMap<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const value = key(item)
    if (result.has(value)) throw reviewError('E2E_ACCEPTANCE_REVIEW_CHAIN_AMBIGUOUS')
    result.set(value, item)
  }
  return result
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort()
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reviewError(code: string): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false })
}
