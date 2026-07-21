import {
  CompilerInputV1Schema,
  E2EError,
  ApprovalFreshnessReceiptSchema,
  canonicalizeJson,
  digestApprovalProjection,
  digestArtifactContent,
  digestCleanupPlanDefinition,
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
import ts from 'typescript'

export const TRUSTED_TYPESCRIPT_VERSION = ts.version

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
  nodeVersion: string
  typescriptVersion: string
  trust: TrustedCompilerProjectorTrust
}

export function projectCompilerInputFromArtifacts(
  request: ProjectCompilerInputFromArtifactsRequest,
): TrustedCompilerInput {
  assertExactRequest(request)
  if (request.typescriptVersion !== TRUSTED_TYPESCRIPT_VERSION) {
    throw projectorError('E2E_COMPILER_TYPESCRIPT_VERSION_MISMATCH',
      '请求的 TypeScript parser 版本与可信编译器实际 parser 不一致')
  }
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
  let approvalFreshnessReceipt: ReturnType<typeof ApprovalFreshnessReceiptSchema.parse>
  try {
    approvalFreshnessReceipt = assertApprovalProjection({ projectPolicy, requirementModel, coverageUniverse, testCases,
      actionMap, executionContract, runBundle, approvalGrants }, trust.verifyApprovalFreshness, trust.readiness.scopeDigest)
  } catch (cause) {
    if (cause instanceof E2EError) throw cause
    throw projectorError('E2E_COMPILER_INPUT_INVALID', '审批投影未通过严格嵌套 Schema 校验', cause)
  }

  const coverageContent = record(coverageUniverse.content)
  const casesContent = record(testCases.content)
  const actionMapContent = record(actionMap.content)
  const executionContent = record(executionContract.content)
  const actionMapProfile = optionalText(actionMapContent.executionProfile)
  const executionProfile = optionalText(executionContent.executionProfile)
  if (actionMapProfile !== executionProfile) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Action Map 与 Execution Contract executionProfile 不一致')
  }
  const fullPlaywright = executionProfile === 'full-playwright'
  const actionMapPrograms = optionalRecords(actionMapContent.fullPlaywrightPrograms)
  const executionPrograms = optionalRecords(executionContent.fullPlaywrightPrograms)
  if (fullPlaywright && (actionMapPrograms.length === 0
    || canonicalizeJson(actionMapPrograms) !== canonicalizeJson(executionPrograms))) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'full Playwright program 必须在 Action Map 与 Execution Contract 逐字闭合')
  }
  const obligations = records(coverageContent.obligations)
  const activeCases = records(casesContent.cases)
    .filter((testCase) => testCase.status === 'active')
    .sort(byId('caseId'))
  const mappings = records(actionMapContent.actions)
  const unmappedSteps = records(actionMapContent.unmappedSteps)
  const queueIds = records(executionContent.caseQueue).map((item) => text(item.caseId))
  const intents = records(executionContent.actionIntents)
  const dataNeeds = records(executionContent.dataNeeds)
  const cleanupPlans = optionalRecords(executionContent.writeCleanupPlans)
  const runBundleContent = record(runBundle.content)
  const schedules = records(runBundleContent.schedule)
  const signedCapabilities = records(runBundleContent.signedCapabilities)
  const executableCases: DeclarativeExecutableCase[] = []
  const blockedCases: RegressionBlockedCase[] = []

  if (new Set(queueIds).size !== queueIds.length
    || queueIds.length !== activeCases.length
    || activeCases.some((testCase) => !queueIds.includes(text(testCase.caseId)))) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Execution Contract caseQueue 必须与 active Case 精确闭合')
  }
  if (fullPlaywright) {
    assertExactFullPlaywrightConsumption({ activeCases, mappings, programs: executionPrograms, intents,
      cleanupPlans, signedCapabilities, schedules, receipt: approvalFreshnessReceipt })
    assertRunScheduleClosure(activeCases, mappings, schedules)
    assertFullPlaywrightApprovalClosure({ programs: executionPrograms, mappings, intents,
      cleanupPlans, signedCapabilities, receipt: approvalFreshnessReceipt })
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
      if (fullPlaywright) {
        const program = executionPrograms.find((candidate) => text(candidate.actionId) === actionId)
        const leaseIds = strings(testCase.dataNeedIds)
        const cleanupPlanId = text(testCase.cleanupPlanId)
        const mappingCapabilities = records(mapping.capabilities)
        if (!program || text(program.caseId) !== caseId || text(program.stepId) !== stepId
          || effect !== 'reversible-write' || leaseIds.length !== 1
          || text(program.dataLeaseId) !== leaseIds[0] || text(program.cleanupPlanId) !== cleanupPlanId
          || number(program.timeoutMs) !== number(testCase.timeoutMs)
          || mappingCapabilities.length !== 1
          || text(mappingCapabilities[0]!.operation) !== 'full-playwright'
          || strings(mapping.requestIds).length !== 0 || strings(matchingIntents[0]!.requestIds).length !== 0) {
          throw projectorError('E2E_COMPILER_INPUT_INVALID', `Action ${actionId} full Playwright 绑定不闭合`)
        }
        actions.push({ kind: 'fullPlaywright', actionId,
          source: text(program.source), sourceDigest: text(program.sourceDigest),
          cleanupSource: text(program.cleanupSource), cleanupSourceDigest: text(program.cleanupSourceDigest),
          dataLeaseId: text(program.dataLeaseId), cleanupPlanId: text(program.cleanupPlanId),
          timeoutMs: number(program.timeoutMs), cleanupTimeoutMs: number(cleanupPlanFor(program, cleanupPlans).timeoutMs) })
      } else if (effect === 'read') {
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
    nodeVersion: request.nodeVersion,
    ...(fullPlaywright ? { executionProfile: 'full-playwright' as const } : {}),
    cases: executableCases,
    blockedCases: blockedCases.sort(byId('caseId')),
  })
  const token = Object.freeze({})
  trustedInputs.set(token, structuredClone(input))
  return token
}

function assertExactFullPlaywrightConsumption(input: {
  activeCases: Record<string, unknown>[]
  mappings: Record<string, unknown>[]
  programs: Record<string, unknown>[]
  intents: Record<string, unknown>[]
  cleanupPlans: Record<string, unknown>[]
  signedCapabilities: Record<string, unknown>[]
  schedules: Record<string, unknown>[]
  receipt: ReturnType<typeof ApprovalFreshnessReceiptSchema.parse>
}): void {
  const activePairs = input.activeCases.flatMap((testCase) => records(testCase.steps).map((step) =>
    `${text(testCase.caseId)}\0${text(step.stepId)}`))
  const mappingPairs = input.mappings.map((mapping) => `${text(mapping.caseId)}\0${text(mapping.stepId)}`)
  if (!sameUniqueStrings(activePairs, mappingPairs)) throw projectorError(
    'E2E_COMPILER_INPUT_INVALID', 'full Playwright mapping 未与 active case/step 全量一一闭合')

  const expectedTuples = input.mappings.map(tupleKey)
  const programTuples = input.programs.map(tupleKey)
  const scheduleTuples = input.schedules.flatMap((schedule) => {
    const stepIds = strings(schedule.stepIds)
    const actionIds = strings(schedule.actionIds)
    if (stepIds.length !== actionIds.length) return ['__schedule-cardinality-invalid__']
    return stepIds.map((stepId, index) => `${text(schedule.caseId)}\0${stepId}\0${actionIds[index]}`)
  })
  if (!sameUniqueStrings(expectedTuples, programTuples) || !sameUniqueStrings(expectedTuples, scheduleTuples)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID',
      'full Playwright program/schedule 未按 (caseId,stepId,actionId) 全量一一消费')
  }

  const expectedActionIds = input.mappings.map((mapping) => text(mapping.actionId))
  const actionSets = [
    input.intents.map((intent) => text(intent.actionId)),
    input.cleanupPlans.map((plan) => text(plan.actionId)),
    input.signedCapabilities.map((capability) => text(capability.actionId)),
    input.receipt.capabilities.map((capability) => capability.actionId),
    input.receipt.executionSubjectSnapshot.actions.map((action) => action.actionId),
  ]
  if (!allUnique(expectedActionIds) || actionSets.some((ids) => !sameUniqueStrings(expectedActionIds, ids))) {
    throw approvalError('full Playwright intent/cleanup/capability/approval Action 集未全量一一消费')
  }
  for (const program of input.programs) {
    const actionId = text(program.actionId)
    const plan = input.cleanupPlans.find((candidate) => text(candidate.actionId) === actionId)
    const mapping = input.mappings.find((candidate) => text(candidate.actionId) === actionId)
    if (!plan || text(plan.cleanupPlanId) !== text(program.cleanupPlanId)
      || records(mapping?.capabilities).length !== 1) {
      throw projectorError('E2E_COMPILER_INPUT_INVALID', `full Playwright Action ${actionId} 未唯一消费 cleanup/capability`)
    }
  }
}

function cleanupPlanFor(program: Record<string, unknown>, cleanupPlans: Record<string, unknown>[]): Record<string, unknown> {
  const matches = cleanupPlans.filter((candidate) => text(candidate.actionId) === text(program.actionId)
    && text(candidate.cleanupPlanId) === text(program.cleanupPlanId))
  if (matches.length !== 1) throw projectorError(
    'E2E_COMPILER_INPUT_INVALID', `full Playwright Action ${text(program.actionId)} cleanup budget 未唯一绑定`)
  return matches[0]!
}

function tupleKey(value: Record<string, unknown>): string {
  return `${text(value.caseId)}\0${text(value.stepId)}\0${text(value.actionId)}`
}

function allUnique(values: string[]): boolean {
  return new Set(values).size === values.length
}

function sameUniqueStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const leftValues = new Set(left)
  if (leftValues.size !== left.length || new Set(right).size !== right.length) return false
  return right.every((value) => leftValues.has(value))
}

function assertFullPlaywrightApprovalClosure(input: {
  programs: Record<string, unknown>[]
  mappings: Record<string, unknown>[]
  intents: Record<string, unknown>[]
  cleanupPlans: Record<string, unknown>[]
  signedCapabilities: Record<string, unknown>[]
  receipt: ReturnType<typeof ApprovalFreshnessReceiptSchema.parse>
}): void {
  if (input.receipt.grantType !== 'reversible-write'
    || input.programs.length !== input.mappings.length || input.programs.length !== input.intents.length
    || input.programs.length !== input.cleanupPlans.length
    || canonicalizeJson(sortRecords(input.signedCapabilities, 'actionId'))
      !== canonicalizeJson(sortRecords(input.receipt.capabilities as unknown as Record<string, unknown>[], 'actionId'))) {
    throw approvalError('full Playwright capability/program/cleanup 集不闭合')
  }
  const subjectActions = input.receipt.executionSubjectSnapshot.actions
  for (const program of input.programs) {
    const actionId = text(program.actionId)
    const mapping = input.mappings.find((candidate) => text(candidate.actionId) === actionId)
    const mappingCapability = mapping && records(mapping.capabilities)[0]
    const receiptCapability = input.receipt.capabilities.find((candidate) => candidate.actionId === actionId)
    const subjectAction = subjectActions.find((candidate) => candidate.actionId === actionId)
    const cleanupPlan = input.cleanupPlans.find((candidate) => text(candidate.cleanupPlanId) === text(program.cleanupPlanId))
    if (!mappingCapability || !receiptCapability || !subjectAction || !cleanupPlan
      || text(mappingCapability.capabilityId) !== receiptCapability.capabilityId
      || receiptCapability.operation !== 'full-playwright' || receiptCapability.effect !== 'reversible-write'
      || !('transport' in subjectAction) || subjectAction.transport !== 'browser-local'
      || subjectAction.operation !== 'full-playwright'
      || subjectAction.programDigest !== text(program.sourceDigest)
      || subjectAction.cleanupProgramDigest !== text(program.cleanupSourceDigest)
      || subjectAction.dataLeaseId !== text(program.dataLeaseId)
      || subjectAction.cleanupPlanDigest !== digestCleanupPlanDefinition(cleanupPlan as never)
      || canonicalizeJson(subjectAction.requests) !== canonicalizeJson(records(program.networkRequests))) {
      throw approvalError(`full Playwright Action ${actionId} 未与 approval/capability/cleanup/request 闭合`)
    }
  }
}

function assertRunScheduleClosure(
  activeCases: Record<string, unknown>[],
  mappings: Record<string, unknown>[],
  schedules: Record<string, unknown>[],
): void {
  if (schedules.length !== activeCases.length) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Run Bundle schedule 必须与 active Case 闭合')
  }
  for (const testCase of activeCases) {
    const caseId = text(testCase.caseId)
    const schedule = schedules.find((candidate) => text(candidate.caseId) === caseId)
    const stepIds = records(testCase.steps).sort((left, right) => number(left.ordinal) - number(right.ordinal))
      .map((step) => text(step.stepId))
    const actionIds = stepIds.map((stepId) => {
      const matches = mappings.filter((mapping) => text(mapping.caseId) === caseId && text(mapping.stepId) === stepId)
      return matches.length === 1 ? text(matches[0]!.actionId) : ''
    })
    if (!schedule || canonicalizeJson(strings(schedule.stepIds)) !== canonicalizeJson(stepIds)
      || canonicalizeJson(strings(schedule.actionIds)) !== canonicalizeJson(actionIds)) {
      throw projectorError('E2E_COMPILER_INPUT_INVALID', `Run Bundle schedule 未绑定 ${caseId} 的 step/action`)
    }
  }
}

function sortRecords(values: Record<string, unknown>[], key: string): Record<string, unknown>[] {
  return [...values].sort(byId(key))
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
    || Object.keys(request).sort().join('\0') !== ['artifacts', 'nodeVersion', 'playwrightVersion', 'trust', 'typescriptVersion'].sort().join('\0')
    || !Array.isArray(request.artifacts)) {
    throw projectorError('E2E_COMPILER_INPUT_INVALID', 'Projector 只接受 artifacts 与固定 Node/Playwright 版本')
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

function optionalRecords(value: unknown): Record<string, unknown>[] {
  return value === undefined ? [] : records(value)
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

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value)
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
