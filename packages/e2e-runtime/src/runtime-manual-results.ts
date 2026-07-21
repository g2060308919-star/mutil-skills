import {
  ManualResultDraftSchema,
  ManualResultSchema,
  type ManualResult,
  type ManualResultDraft,
} from '@mutil-skills/e2e-contracts'
import { E2EError } from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

export const MAX_TRUSTED_MANUAL_RESULTS = 10_000

/**
 * 在进入可信事实集合前，将 Authority 签发的结果重新绑定到当前冻结 Run。
 * Authority 验签由调用方负责；此处负责防止跨 Run/代/资产/合同重绑定。
 */
export function bindManualResultToRuntimeSnapshot(
  snapshot: RuntimeRunSnapshot,
  candidate: unknown,
  now: Date,
): ManualResult {
  const parsed = ManualResultSchema.safeParse(candidate)
  if (!parsed.success) throw bindingError('ManualResult 未通过严格契约')
  const result = parsed.data
  const { authorityProof: _authorityProof, ...draft } = result
  validateManualResultDraftBinding(snapshot, draft, now)
  if (Date.parse(result.authorityProof.executorPresence.expiresAt) <= now.getTime()
    || Date.parse(result.authorityProof.reviewerPresence.expiresAt) <= now.getTime()) {
    throw bindingError('ManualResult user-presence proof 已过期')
  }
  return structuredClone(result)
}

export function bindManualResultDraftToRuntimeSnapshot(
  snapshot: RuntimeRunSnapshot,
  candidate: unknown,
  now: Date,
): ManualResultDraft {
  const parsed = ManualResultDraftSchema.safeParse(candidate)
  if (!parsed.success) throw bindingError('ManualResult draft 未通过严格契约')
  validateManualResultDraftBinding(snapshot, parsed.data, now)
  return structuredClone(parsed.data)
}

function validateManualResultDraftBinding(
  snapshot: RuntimeRunSnapshot,
  result: ManualResultDraft,
  now: Date,
): void {
  const model = snapshot.frozenArtifacts['requirement-model']
  const coverage = snapshot.frozenArtifacts['coverage-universe']
  const cases = snapshot.frozenArtifacts['test-cases']
  const execution = snapshot.frozenArtifacts['execution-contract']
  if (model === undefined || coverage === undefined || cases === undefined || execution === undefined) {
    throw bindingError('ManualResult 缺少当前 Run 的冻结模型、覆盖、Case 或执行合同')
  }
  const currentPrdRevision = snapshot.artifactDigests['prd-source']
  if (result.runId !== snapshot.runId || result.generationId !== snapshot.runId
    || result.runtimeInstallationDigest !== snapshot.runtimeInstallationDigest
    || result.assetId !== snapshot.assetId || result.prdRevision !== currentPrdRevision
    || result.requirementModelDigest !== model.contentDigest
    || model.assetId !== snapshot.assetId || model.prdRevision !== result.prdRevision
    || model.generationId !== result.generationId
    || [coverage, cases, execution].some((artifact) => artifact.assetId !== snapshot.assetId
      || artifact.prdRevision !== result.prdRevision || artifact.generationId !== result.generationId)) {
    throw bindingError('ManualResult 与当前 Run/代/资产/PRD/模型不一致')
  }
  if (Date.parse(result.finishedAt) > now.getTime() || Date.parse(result.expiresAt) <= now.getTime()) {
    throw bindingError('ManualResult draft 尚未完成或已经过期')
  }

  const coverageContent = record(coverage.content)
  const coverageObligations = array(coverageContent.obligations)
  const selectedObligations = result.obligationIds.map((obligationId) => {
    const matches = coverageObligations.filter((candidate) => record(candidate).obligationId === obligationId)
    if (matches.length !== 1) throw bindingError(`ManualResult obligation 不存在或不唯一: ${obligationId}`)
    const obligation = record(matches[0])
    const disposition = record(obligation.disposition)
    if (disposition.kind !== 'manual' || disposition.manualProcedureId !== result.manualProcedureId) {
      throw bindingError(`ManualResult obligation 未绑定同一 manual procedure: ${obligationId}`)
    }
    return obligation
  })
  if (selectedObligations.length !== result.obligationIds.length) {
    throw bindingError('ManualResult obligation 集合不完整')
  }

  const executionContent = record(execution.content)
  const procedures = array(executionContent.manualProcedures).map(record)
    .filter((procedure) => procedure.manualProcedureId === result.manualProcedureId)
  if (procedures.length !== 1 || typeof procedures[0]!.instructionDigest !== 'string'
    || result.steps.some((step) => step.instructionDigest !== procedures[0]!.instructionDigest)) {
    throw bindingError('ManualResult steps 未精确绑定冻结 manual procedure instructions')
  }

  const caseContent = record(cases.content)
  const frozenCases = array(caseContent.cases).map(record)
  const resultObligationIds = new Set(result.obligationIds)
  const coveredByCases = new Set<string>()
  for (const caseId of result.caseIds) {
    const matches = frozenCases.filter((candidate) => candidate.caseId === caseId)
    if (matches.length !== 1 || matches[0]!.status !== 'active') {
      throw bindingError(`ManualResult case 不存在、不唯一或非 active: ${caseId}`)
    }
    const caseObligations = array(matches[0]!.obligationIds)
      .filter((value): value is string => typeof value === 'string')
    const intersection = caseObligations.filter((obligationId) => resultObligationIds.has(obligationId))
    if (intersection.length === 0) throw bindingError(`ManualResult case 未关联任何结果 obligation: ${caseId}`)
    for (const obligationId of intersection) coveredByCases.add(obligationId)
  }
  if (coveredByCases.size !== resultObligationIds.size) {
    throw bindingError('ManualResult case 集合未覆盖全部 obligation')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bindingError('冻结 ManualResult 绑定资产结构非法')
  }
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw bindingError('冻结 ManualResult 绑定资产数组非法')
  return value
}

function bindingError(message: string): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_MANUAL_RESULT_BINDING_INVALID', category: 'safety',
    retryable: false, message,
  })
}
