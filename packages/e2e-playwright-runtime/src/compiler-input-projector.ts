import {
  CompilerInputV1Schema,
  E2EError,
  ApprovalFreshnessReceiptSchema,
  digestApprovalProjection,
  digestArtifactContent,
  parseArtifactDocument,
  type ArtifactDocument,
  type CompilerInputV1,
  type DeclarativeExecutableCase,
  type RegressionBlockedCase,
} from '@mutil-skills/e2e-contracts'
import {
  getProjectorTrustBinding,
  type TrustedCompilerProjectorTrust,
} from './trusted-compiler-trust.js'

const REQUIRED_TYPES = [
  'prd-manifest',
  'prd-diff',
  'acceptance-scope',
  'project-policy',
  'requirement-model',
  'coverage-universe',
  'test-cases',
  'browser-action-map',
  'execution-contract',
  'run-bundle',
  'approval-grants',
] as const

const trustedInputs = new WeakMap<object, CompilerInputV1>()

export interface TrustedCompilerInput {}

export interface ProjectCompilerInputFromArtifactsRequest {
  artifacts: unknown[]
  playwrightVersion: string
  trust: TrustedCompilerProjectorTrust
}

export function projectCompilerInputFromArtifacts(
  request: ProjectCompilerInputFromArtifactsRequest,
): TrustedCompilerInput {
  assertExactRequest(request)
  const trust = getProjectorTrustBinding(request.trust)
  if (!trust) throw projectorError('E2E_COMPILER_TRUST_INVALID', 'Projector 缺少受信 Host 启动期固定的信任根')
  const verifyArtifactSignature = trust.verifyArtifact
  const documents = request.artifacts.map((candidate) => parseCompilerArtifact(candidate, verifyArtifactSignature))
  const byType = new Map<string, ArtifactDocument>()
  for (const document of documents) {
    if (!REQUIRED_TYPES.includes(document.artifactType as (typeof REQUIRED_TYPES)[number])) {
      throw projectorError(hasCodeLikeField(document)
        ? 'E2E_COMPILER_CODE_FIELD_REJECTED' : 'E2E_COMPILER_INPUT_INVALID',
      `Compiler 不接受 ${document.artifactType} Artifact`)
    }
    if (byType.has(document.artifactType)) {
      throw projectorError('E2E_COMPILER_INPUT_INVALID', `Artifact 类型重复：${document.artifactType}`)
    }
    byType.set(document.artifactType, document)
  }
  for (const type of REQUIRED_TYPES) {
    if (!byType.has(type)) throw projectorError('E2E_COMPILER_INPUT_INVALID', `缺少 Compiler Artifact：${type}`)
  }
  const prdManifest = required(byType, 'prd-manifest')
  const prdDiff = required(byType, 'prd-diff')
  const acceptanceScope = required(byType, 'acceptance-scope')
  const projectPolicy = required(byType, 'project-policy')
  const requirementModel = required(byType, 'requirement-model')
  const coverageUniverse = required(byType, 'coverage-universe')
  const testCases = required(byType, 'test-cases')
  const actionMap = required(byType, 'browser-action-map')
  const executionContract = required(byType, 'execution-contract')
  const runBundle = required(byType, 'run-bundle')
  const approvalGrants = required(byType, 'approval-grants')
  assertSameGeneration(documents)
  if (documents.some((document) => document.assetId !== trust.readiness.assetId
    || document.generationId !== trust.readiness.generationId
    || document.prdRevision !== trust.readiness.prdRevision)) {
    throw projectorError('E2E_COMPILER_READINESS_MISMATCH', 'Artifact 不属于 Host 启动期批准的 generation')
  }
  if (prdManifest.contentDigest !== trust.readiness.prdManifestArtifactDigest
    || prdDiff.contentDigest !== trust.readiness.prdDiffArtifactDigest
    || acceptanceScope.contentDigest !== trust.readiness.acceptanceScopeArtifactDigest
    || digestApprovalProjection('acceptance-scope', acceptanceScope.content) !== trust.readiness.scopeDigest) {
    throw projectorError('E2E_COMPILER_READINESS_MISMATCH', 'Compiler PRD、lineage 或 scope Artifact 未绑定 Engine readiness')
  }
  const approvalFreshnessReceipt = assertApprovalProjection({ projectPolicy, requirementModel, coverageUniverse, testCases,
    actionMap, executionContract, runBundle, approvalGrants }, trust.verifyApprovalFreshness, trust.readiness.scopeDigest)

  const coverageContent = record(coverageUniverse.content)
  const casesContent = record(testCases.content)
  const actionMapContent = record(actionMap.content)
  const executionContent = record(executionContract.content)
  const obligations = records(coverageContent.obligations)
  const activeCases = records(casesContent.cases)
    .filter((testCase) => testCase.status === 'active')
    .sort(byId('caseId'))
  const mappings = records(actionMapContent.actions)
  const unmappedSteps = records(actionMapContent.unmappedSteps)
  const queueIds = records(executionContent.caseQueue).map((item) => text(item.caseId))
  const intents = records(executionContent.actionIntents)
  const dataNeeds = records(executionContent.dataNeeds)
  const executableCases: DeclarativeExecutableCase[] = []
  const blockedCases: RegressionBlockedCase[] = []

  if (new Set(queueIds).size !== queueIds.length
    || queueIds.length !== activeCases.length
    || activeCases.some((testCase) => !queueIds.includes(text(testCase.caseId)))) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Execution Contract caseQueue 必须与 active Case 精确闭合')
  }

  for (const testCase of activeCases) {
    const caseId = text(testCase.caseId)
    const effect = text(testCase.effect)
    const steps = records(testCase.steps).sort((left, right) => number(left.ordinal) - number(right.ordinal))
    const unmapped = unmappedSteps.filter((item) => text(item.caseId) === caseId)
    if (effect === 'irreversible' || effect === 'unknown') {
      blockedCases.push({ caseId, reasonCode: 'E2E_COMPILER_EFFECT_NOT_ALLOWED' })
      continue
    }
    if (unmapped.length > 0) {
      blockedCases.push({ caseId, reasonCode: text(unmapped[0]!.reasonCode) })
      continue
    }
    const obligationIds = strings(testCase.obligationIds)
    const trace = projectRequirementTrace(caseId, obligationIds, obligations)
    const actions = [] as DeclarativeExecutableCase['actions']
    for (const step of steps) {
      const stepId = text(step.stepId)
      const matches = mappings.filter((mapping) =>
        text(mapping.caseId) === caseId && text(mapping.stepId) === stepId)
      if (matches.length !== 1) {
        throw projectorError('E2E_COMPILER_INPUT_INVALID', `Case ${caseId} Step ${stepId} 必须有且只有一个 Action mapping`)
      }
      const mapping = matches[0]!
      const actionId = text(mapping.actionId)
      const matchingIntents = intents.filter((intent) => text(intent.actionId) === actionId)
      if (text(mapping.effect) !== effect || matchingIntents.length !== 1
        || text(matchingIntents[0]!.effect) !== effect) {
        throw projectorError('E2E_COMPILER_INPUT_INVALID', `Action ${actionId} effect 与 Execution Contract 不一致`)
      }
      const oracles = records(step.oracles)
      if (oracles.length === 0) throw projectorError('E2E_COMPILER_INPUT_INVALID', `Step ${stepId} 缺少 Oracle`)
      if (effect === 'read') {
        actions.push({ kind: 'assertText', actionId, target: text(step.semanticTarget),
          expected: text(oracles[0]!.statement) })
      } else {
        const leaseIds = strings(testCase.dataNeedIds)
        const matchingLeases = dataNeeds.filter((need) => leaseIds.includes(text(need.leaseId)) && need.mode === 'write')
        const cleanupPlanId = text(testCase.cleanupPlanId)
        const preconditions = strings(testCase.preconditions)
        const locatorCandidates = records(mapping.locatorCandidates)
          .sort((left, right) => number(right.confidence) - number(left.confidence))
        if (leaseIds.length !== 1 || matchingLeases.length !== 1 || cleanupPlanId === 'not-applicable'
          || preconditions.length === 0 || locatorCandidates.length === 0) {
          throw projectorError('E2E_COMPILER_INPUT_INVALID', `Case ${caseId} 缺少可逆写 Lease、Cleanup、前置状态或语义定位`)
        }
        actions.push({ kind: 'reversibleWrite', actionId,
          buttonName: semanticLocatorValue(text(locatorCandidates[0]!.value)),
          beforeText: preconditions[0]!, afterText: text(oracles[0]!.statement),
          dataLeaseId: leaseIds[0]!, cleanupPlanId })
      }
    }
    executableCases.push({ caseId, title: text(testCase.title), reqIds: trace.reqIds,
      ruleIds: trace.ruleIds, obligationIds: [...obligationIds].sort(),
      mode: testCase.mode === 'fault-injection' ? 'fault-injection' : 'real-environment', actions })
  }

  const input = CompilerInputV1Schema.parse({
    schemaVersion: 'compiler-input/v1',
    assetId: projectPolicy.assetId,
    generationId: projectPolicy.generationId,
    runId: text(record(runBundle.content).runId),
    prdRevision: projectPolicy.prdRevision,
    scopeDigest: trust.readiness.scopeDigest,
    lineageDecisionDigest: trust.readiness.lineageDecisionDigest,
    contractsVersion: trust.readiness.contractsVersion,
    environmentId: text(executionContent.environment),
    baseOrigin: text(executionContent.baseOrigin),
    approvalDigest: approvalGrants.contentDigest,
    approvalFreshnessReceipt,
    policyDigest: projectPolicy.contentDigest,
    playwrightVersion: request.playwrightVersion,
    cases: executableCases,
    blockedCases: blockedCases.sort(byId('caseId')),
  })
  const token = Object.freeze({})
  trustedInputs.set(token, structuredClone(input))
  return token
}

/** 仅供同包 Compiler/Discovery 消费；不会从 package root 导出。 */
export function inspectTrustedCompilerInput(value: TrustedCompilerInput): CompilerInputV1 {
  const input = trustedInputs.get(value as object)
  if (!input) throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Input 不是可信 Projector 产物')
  return structuredClone(input)
}

function parseCompilerArtifact(
  candidate: unknown,
  verifyArtifactSignature: (signature: ArtifactDocument['signatures'][number]) => boolean,
): ArtifactDocument {
  try {
    const artifact = parseArtifactDocument(candidate)
    const actualDigest = digestArtifactContent(
      `artifact-content/${artifact.schemaVersion}/${artifact.artifactType}`,
      artifact as unknown as Record<string, unknown>,
    )
    if (actualDigest !== artifact.contentDigest) {
      throw projectorError('E2E_COMPILER_ARTIFACT_NOT_VERIFIED', `Artifact 内容摘要无效：${artifact.artifactType}`)
    }
    if (artifact.signatures.length !== 1 || artifact.signatures[0]!.signedDigest !== artifact.contentDigest
      || !verifyArtifactSignature(artifact.signatures[0]!)) {
      throw projectorError('E2E_COMPILER_ARTIFACT_NOT_VERIFIED', `Artifact Authority 签名无效：${artifact.artifactType}`)
    }
    return artifact
  } catch (cause) {
    if (cause instanceof E2EError && cause.code === 'E2E_COMPILER_ARTIFACT_NOT_VERIFIED') throw cause
    const code = hasCodeLikeField(candidate) ? 'E2E_COMPILER_CODE_FIELD_REJECTED' : 'E2E_COMPILER_INPUT_INVALID'
    throw projectorError(code, 'Compiler Artifact 未通过严格 Schema 校验', cause)
  }
}

function assertExactRequest(request: ProjectCompilerInputFromArtifactsRequest): void {
  if (!request || typeof request !== 'object'
    || Object.keys(request).sort().join('\0') !== ['artifacts', 'playwrightVersion', 'trust'].join('\0')
    || !Array.isArray(request.artifacts)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Projector 只接受 artifacts 与固定 Playwright 版本')
  }
}

function assertSameGeneration(documents: ArtifactDocument[]): void {
  const first = documents[0]
  if (!first || documents.some((document) => document.assetId !== first.assetId
    || document.generationId !== first.generationId || document.prdRevision !== first.prdRevision)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Artifact 必须属于同一 Asset、generation 和 PRD revision')
  }
}

function assertApprovalProjection(input: {
  projectPolicy: ArtifactDocument
  requirementModel: ArtifactDocument
  coverageUniverse: ArtifactDocument
  testCases: ArtifactDocument
  actionMap: ArtifactDocument
  executionContract: ArtifactDocument
  runBundle: ArtifactDocument
  approvalGrants: ArtifactDocument
}, verifyApprovalFreshness: (receipt: ReturnType<typeof ApprovalFreshnessReceiptSchema.parse>) => boolean,
scopeDigest: string): ReturnType<typeof ApprovalFreshnessReceiptSchema.parse> {
  const approval = record(input.approvalGrants.content)
  const grants = records(approval.grants)
  if (grants.length !== 1) throw approvalError('Compiler 只接受一个当前 Execution Approval receipt')
  const parsed = ApprovalFreshnessReceiptSchema.safeParse(grants[0])
  if (!parsed.success) throw projectorError(
    'E2E_COMPILER_APPROVAL_RECEIPT_INVALID', 'Approval freshness receipt 不符合严格 Schema',
  )
  if (!verifyApprovalFreshness(parsed.data)) throw projectorError(
    'E2E_COMPILER_APPROVAL_SIGNATURE_INVALID', 'Approval freshness receipt 签名无效',
  )
  if (parsed.data.status !== 'valid') throw projectorError(
    'E2E_COMPILER_APPROVAL_NOT_CURRENT', 'Approval freshness receipt 已过期或撤销',
  )
  if (approval.runBundleDigest !== parsed.data.runBundleDigest
    || input.runBundle.contentDigest !== parsed.data.runBundleDigest) throw projectorError(
    'E2E_COMPILER_APPROVAL_RUN_BUNDLE_INVALID', 'Approval freshness receipt 未绑定 Run Bundle',
  )
  const receipt = parsed.data
  const subject = receipt.executionSubjectSnapshot
  if (subject.scopeDigest !== scopeDigest) throw approvalError('Approval subject 未绑定 Host readiness scopeDigest')
  if (subject.runBundleProjectionDigest !== digestApprovalProjection('run-bundle', input.runBundle.content)) {
    throw approvalError('Approval subject 未绑定已签名 Run Bundle 投影')
  }
  const coverage = record(input.coverageUniverse.content)
  const execution = record(input.executionContract.content)
  const expected = {
    assetId: input.projectPolicy.assetId,
    prdRevision: input.projectPolicy.prdRevision,
    requirementModelDigest: digestApprovalProjection('requirement-model', input.requirementModel.content),
    coveragePolicyDigest: text(coverage.coveragePolicyDigest),
    universeDigest: text(coverage.universeDigest),
    caseDigest: digestApprovalProjection('test-cases', input.testCases.content),
    actionMapDigest: digestApprovalProjection('browser-action-map', input.actionMap.content),
    policyDigest: digestApprovalProjection('project-policy', input.projectPolicy.content),
    executionContractDigest: digestApprovalProjection('execution-contract', input.executionContract.content),
    environment: text(execution.environment).toLowerCase(),
    baseOrigin: text(execution.baseOrigin),
  }
  for (const [key, value] of Object.entries(expected)) {
    if (subject[key as keyof typeof subject] !== value) throw approvalError(`Approval subject 未绑定 ${key}`)
  }
  const contractActionIds = new Set(records(execution.actionIntents).map((intent) => text(intent.actionId)))
  const actionMapContent = record(input.actionMap.content)
  const unmappedPairs = new Set(records(actionMapContent.unmappedSteps)
    .map((item) => `${text(item.caseId)}\0${text(item.stepId)}`))
  const mappedActionIds = new Set(records(actionMapContent.actions)
    .filter((action) => !unmappedPairs.has(`${text(action.caseId)}\0${text(action.stepId)}`))
    .map((action) => text(action.actionId)))
  const capabilityActionIds = new Set(receipt.capabilities.map((capability) => capability.actionId))
  const approvedActionIds = new Set(subject.actions.map((action) => action.actionId))
  if (![...mappedActionIds].every((actionId) => contractActionIds.has(actionId))
    || !sameSet(approvedActionIds, mappedActionIds) || !sameSet(capabilityActionIds, mappedActionIds)) {
    throw approvalError('Approval actions、Capabilities 与 Execution Contract 不闭合')
  }
  const checkedAt = Date.parse(receipt.checkedAt)
  const expiresAt = Date.parse(receipt.expiresAt)
  const artifactTime = Date.parse(input.approvalGrants.createdAt)
  if (!(checkedAt <= artifactTime && artifactTime < expiresAt)) {
    throw approvalError('Approval receipt 在 Artifact 生成时不新鲜')
  }
  return receipt
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function approvalError(message: string): E2EError {
  return projectorError('E2E_COMPILER_APPROVAL_BINDING_INVALID', message)
}

function projectRequirementTrace(caseId: string, obligationIds: string[], obligations: Record<string, unknown>[]): {
  reqIds: string[]; ruleIds: string[]
} {
  const selected = obligationIds.map((obligationId) => obligations.find((item) => text(item.obligationId) === obligationId))
  if (selected.some((item) => !item)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', `Case ${caseId} 引用了不存在的 obligation`)
  }
  for (const obligation of selected as Record<string, unknown>[]) {
    const disposition = record(obligation.disposition)
    if (disposition.kind !== 'automated' || !strings(disposition.caseIds).includes(caseId)) {
      throw projectorError('E2E_COMPILER_INPUT_INVALID', `Case ${caseId} 与 obligation 自动化处置不闭合`)
    }
  }
  return {
    reqIds: [...new Set((selected as Record<string, unknown>[]).map((item) => text(item.reqId)))].sort(),
    ruleIds: [...new Set((selected as Record<string, unknown>[]).flatMap((item) => strings(item.ruleIds)))].sort(),
  }
}

function semanticLocatorValue(value: string): string {
  const separator = value.indexOf(':')
  return separator < 0 ? value : value.slice(separator + 1)
}

function required(byType: Map<string, ArtifactDocument>, type: string): ArtifactDocument {
  return byType.get(type)!
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Artifact 字段必须是对象')
  }
  return value as Record<string, unknown>
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Artifact 字段必须是对象数组')
  }
  return value as Record<string, unknown>[]
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Artifact 字段必须是字符串数组')
  }
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Artifact 缺少非空字符串字段')
  }
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Compiler Artifact 缺少有限数值字段')
  }
  return value
}

function byId(key: string): (left: Record<string, unknown>, right: Record<string, unknown>) => number
function byId<T extends { [key: string]: unknown }>(key: string): (left: T, right: T) => number
function byId(key: string) {
  return (left: Record<string, unknown>, right: Record<string, unknown>) => text(left[key]).localeCompare(text(right[key]))
}

function hasCodeLikeField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCodeLikeField)
  if (!value || typeof value !== 'object') return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.some(([key, nested]) => ['sourceFiles', 'bytes', 'source', 'config', 'hook', 'fixture',
    'reporter', 'imports', 'playwrightCaseIds'].includes(key) || hasCodeLikeField(nested))
}

function projectorError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'input', message: `${code}: ${message}`, retryable: false, cause })
}
