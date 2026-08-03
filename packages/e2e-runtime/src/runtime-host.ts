import {
  InjectionApprovalSubjectSchema,
  ArtifactSchemaRegistry,
  RuntimeDoctorReportSchema,
  RuntimeCreateRunResultSchema,
  RuntimeCompilePrdRunResultSchema,
  RuntimeAcceptanceReviewResultSchema,
  AcceptanceReviewSchema,
  RuntimePreparePrdUnderstandingResultSchema,
  RuntimeResponseEnvelopeSchema,
  RuntimeStatusResultSchema,
  SignedGrantSchema,
  canonicalizeJson,
  digestArtifactContent,
  digestBytes,
  deriveExecutionResultId,
  digestText,
  E2EError,
  projectLineageDecisionSubject,
  projectScopeDecisionSubject,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
  type ArtifactDocument,
  type ArtifactType,
  type ApprovalGrantSubject,
  type ApprovalMode,
  type DecisionReceipt,
  type DecisionSubject,
  type DataLease,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type SignedGrant,
  type WorkflowNode,
  PrdUnderstandingContractMachineViewSchema,
} from '@mutil-skills/e2e-contracts'
import { randomUUID } from 'node:crypto'
import {
  computePrdRevision,
  createWorkflow,
  invalidatePreflightForTargetChange,
  transitionWorkflow,
} from '@mutil-skills/e2e-engine'
import { runtimeErrorResponse } from './protocol.js'
import { assertSameProjectIdentity, resolveProjectIdentity } from './project-identity.js'
import type { RuntimeInstallation } from './runtime-discovery.js'
import type { RuntimeDoctorReport } from './runtime-doctor.js'
import {
  RuntimeRunStore,
  type RuntimeExecutionOwner,
  type RuntimeRunLock,
  type RuntimeRunSnapshot,
} from './run-store.js'
import { SecureProjectFileReader } from './secure-project-files.js'
import {
  computeRuntimeApprovalSubjectDigest,
  type RuntimeAuthorityHost,
} from './authority-host.js'
import {
  bindManualResultDraftToRuntimeSnapshot,
  bindManualResultToRuntimeSnapshot,
} from './runtime-manual-results.js'
import { persistFinalizedApprovalOutcome } from './finalized-approval-outcome.js'
import {
  assertRuntimeReadSnapshotReady,
  executeRuntimeInjection,
  executeRuntimeFullPlaywright,
  executeScheduledRuntimeFullPlaywrightCases,
  executeRuntimeRead,
  executeRuntimeWrite,
  type RuntimeInjectionExecutorCapability,
  type RuntimeFullPlaywrightExecutorCapability,
  type RuntimeReadExecutionOutput,
  type RuntimeReadExecutorCapability,
  type RuntimeWriteExecutorCapability,
} from './trusted-action-runner.js'
import {
  finalizeRuntimePreflight,
  prepareRuntimePreflight,
  runtimePreflightAttemptId,
  RuntimePreflightPreparationSchema,
  type RuntimePreflightCapability,
} from './runtime-preflight.js'
import {
  recoverRuntimeProductionWrite,
  type RuntimeWriteProductionCapability,
} from './runtime-write-production.js'
import type { ProjectPublisher } from './project-publisher.js'
import {
  executeRuntimeGenerationFinalization,
  type RuntimeGenerationFinalizationCapability,
} from './runtime-generation-finalizer.js'
import {
  quarantineRuntimeEvidence,
  type RuntimeEvidenceQuarantineCapability,
  type RuntimeQuarantinedEvidenceFacts,
} from './runtime-evidence-quarantine.js'
import {
  sealRuntimeFinalizationMaterial,
  type RuntimeFinalizationMaterialSealerCapability,
} from './runtime-finalization-material-sealer.js'
import { createRuntimeOwnedResourceMarker } from './write-attempt.js'
import {
  approvalModeFromTrustedFacts,
  assertCurrentLocalApprovalConfirmation,
  createPendingLocalApprovalConfirmation,
  localConfirmationReceiptDigest,
  localManualConfirmationSubjectDigest,
  PrdSourceBundleSnapshotSchema,
  PrdUnderstandingContractFactSchema,
  PrdUnderstandingPreparedFactSchema,
  type PendingLocalApprovalConfirmation,
} from './local-approval-confirmations.js'
import { projectLocalApproval } from './local-approval-projection.js'
import { bindRuntimeExecutionGrantArtifacts } from './runtime-execution-artifact-binder.js'
import {
  assertPrdUnderstandingCandidate,
  assertPrdUnderstandingLinkedCandidate,
  preparePrdUnderstandingProjection,
} from './prd-understanding-validator.js'
import { compilePrdRun } from './prd-run-compiler.js'
import { createCaseSchedule } from './multi-case-scheduler.js'
import type { StandaloneEvidencePublisher } from './standalone-evidence-publisher.js'
import {
  AcceptanceReviewReceiptSchema,
  buildAcceptanceReview,
  confirmAcceptanceReview,
} from './acceptance-review.js'
import { createRunHandle } from './run-handle.js'
import {
  classifyRunCondition,
  hasPreviewReadonlyOnlyCases,
  projectRunStage,
} from './run-condition.js'
import { createTargetContractFact } from './target-contract.js'
import {
  isTargetProbeRetryableReason,
  runTargetProbe,
  selectTargetProbePolicy,
  type TargetProbeCapability,
} from './target-probe.js'
import type { RunStatusPublisher } from './run-status-publisher.js'
import { assertCompiledCaseProjection } from './compiled-case-projection.js'

const EXTERNAL_SEMANTIC_ARTIFACT_TYPES = new Set<ArtifactType>([
  'project-policy', 'prd-request', 'prd-manifest', 'prd-diff', 'semantic-generation', 'acceptance-scope',
  'requirement-model', 'interaction-flow', 'coverage-universe', 'test-cases', 'design-audit',
  'execution-contract', 'browser-action-map', 'regression-manifest',
])

export interface RuntimeHostDependencies {
  installation: RuntimeInstallation
  doctor(): Promise<RuntimeDoctorReport>
  runStore: RuntimeRunStore
  now(): Date
  approvalMode?: ApprovalMode
  projectFileReader?: SecureProjectFileReader
  reserveExecutionLeases?(input: {
    runId: string
    leases: Array<{
      leaseId: string
      resourceKey: string
      resourceFingerprint: string
      ttlMs: number
    }>
  }): Promise<DataLease[]>
  authorityHostFactory?: () => Promise<Partial<Pick<RuntimeAuthorityHost,
    'requestApproval' | 'recoverApproval' | 'acknowledgeFinalization'
    | 'prepareManualResult' | 'requestManualResultRole' | 'recoverManualResultRole'>>>
  localAuthorityHostFactory?: () => Promise<Partial<Pick<RuntimeAuthorityHost,
    'requestApproval' | 'recoverApproval' | 'acknowledgeFinalization'
    | 'prepareManualResult' | 'requestManualResultRole' | 'recoverManualResultRole'>>>
  presentUserPresenceUrl?(url: string): void | Promise<void>
  readExecutor?: RuntimeReadExecutorCapability
  writeExecutor?: RuntimeWriteExecutorCapability
  injectionExecutor?: RuntimeInjectionExecutorCapability
  fullPlaywrightExecutor?: RuntimeFullPlaywrightExecutorCapability
  preflightExecutor?: RuntimePreflightCapability
  targetProbe?: TargetProbeCapability
  runStatusPublisher?: Pick<RunStatusPublisher, 'publish'>
  writeProduction?: RuntimeWriteProductionCapability
  projectPublisherFactory?: (projectRoot: string) => Pick<ProjectPublisher, 'renderActiveReport'>
  standaloneEvidencePublisher?: Pick<StandaloneEvidencePublisher, 'publishRuntimeState'>
  generationFinalizer?: RuntimeGenerationFinalizationCapability
  finalizationMaterialSealer?: RuntimeFinalizationMaterialSealerCapability
  evidenceQuarantine?: RuntimeEvidenceQuarantineCapability
}

export class E2ERuntimeHost {
  constructor(private readonly dependencies: RuntimeHostDependencies) {}

  async handle(
    request: RuntimeRequestEnvelope,
    requestBytes: string | Uint8Array,
  ): Promise<RuntimeResponseEnvelope> {
    let requestDigest: string
    let requestWasPending = false
    try {
      requestDigest = runtimeRequestDigest(request, requestBytes)
    } catch (error) {
      return this.errorResponse(request.requestId, asRuntimeError(error))
    }

    try {
      const reservation = await this.dependencies.runStore.beginRequest(request.requestId, requestDigest)
      if (reservation.kind === 'replay') {
        return RuntimeResponseEnvelopeSchema.parse(reservation.response)
      }
      requestWasPending = reservation.kind === 'pending'
      // open-approval 的 pending 状态有独立的 Authority finalization recovery
      // 协议，必须重新进入该协议以取回已经持久化的同一 Grant；其他命令
      // 不得把 pending 当成首次请求重放。execute-run 尤其只能显式 resume。
      if (reservation.kind === 'pending'
        && request.command !== 'open-approval'
        && request.command !== 'confirm-approval'
        && request.command !== 'compile-prd-run'
        && request.command !== 'confirm-acceptance-review'
        && request.command !== 'configure-target'
        && request.command !== 'probe-target'
        && request.command !== 'submit-candidate'
        && request.command !== 'run-preflight'
        && request.command !== 'execute-run'
        && request.command !== 'resume-run'
        && request.command !== 'finalize-run'
        && request.command !== 'prepare-manual-result'
        && request.command !== 'finalize-manual-result-role') {
        return this.errorResponse(request.requestId, runtimeHostError(
          'E2E_RUNTIME_REQUEST_PENDING',
          'safety',
          '同一请求仍处于 pending，Runtime 拒绝重复执行',
        ))
      }
    } catch (error) {
      return this.errorResponse(request.requestId, asRuntimeError(error))
    }

    try {
      if (request.command === 'doctor') {
        const response = await this.doctorResponse(request)
        return await this.completeGlobalResponse(request.requestId, requestDigest, response)
      }
      if (request.command === 'create-run') return await this.createRun(request, requestDigest)
      if (request.command === 'prepare-prd-understanding') {
        return await this.preparePrdUnderstanding(request, requestDigest)
      }
      if (request.command === 'compile-prd-run') {
        return await this.compilePrdRun(request, requestDigest)
      }
      if (request.command === 'get-acceptance-review') {
        return await this.getAcceptanceReview(request, requestDigest)
      }
      if (request.command === 'confirm-acceptance-review') {
        return await this.confirmAcceptanceReview(request, requestDigest)
      }
      if (request.command === 'configure-target') {
        return await this.configureTarget(request, requestDigest)
      }
      if (request.command === 'probe-target') {
        return await this.probeTarget(request, requestDigest)
      }
      if (request.command === 'get-status') return await this.getStatus(request, requestDigest)
      if (request.command === 'submit-candidate') return await this.submitCandidate(request, requestDigest)
      if (request.command === 'open-approval') return await this.openApproval(request, requestDigest)
      if (request.command === 'confirm-approval') return await this.confirmApproval(request, requestDigest)
      if (request.command === 'prepare-manual-result') {
        return await this.prepareManualResult(request, requestDigest, requestWasPending)
      }
      if (request.command === 'finalize-manual-result-role') {
        return await this.finalizeManualResultRole(request, requestDigest, requestWasPending)
      }
      if (request.command === 'run-preflight') {
        return await this.runPreflight(request, requestDigest, requestWasPending)
      }
      if (request.command === 'execute-run') {
        return await this.executeRun(request, requestDigest, requestWasPending)
      }
      if (request.command === 'resume-run') return await this.resumeRun(request, requestDigest)
      if (request.command === 'render-report') return await this.renderReport(request, requestDigest)
      if (request.command === 'finalize-run') {
        return await this.finalizeRun(request, requestDigest, requestWasPending)
      }
      throw blockedError('E2E_RUNTIME_COMMAND_NOT_READY')
    } catch (error) {
      const response = this.errorResponse(request.requestId, asRuntimeError(error))
      if (error instanceof E2EError && (
        error.code === 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING'
        || error.code === 'E2E_RUNTIME_MANUAL_RESULT_PERSISTENCE_PENDING'
        || error.code === 'E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED'
        || error.code === 'E2E_RUNTIME_APPROVAL_RECOVERY_BINDING_CHANGED'
        || error.code === 'E2E_RUNTIME_READ_EXECUTION_CRASHED'
        || error.code === 'E2E_RUNTIME_EXECUTION_CRASHED'
        || error.code === 'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED'
        || error.code === 'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED'
        || error.code === 'E2E_RUNTIME_EXECUTION_PENDING_STATE_INVALID'
        || error.code === 'E2E_RUNTIME_FINALIZATION_RECOVERY_REQUIRED'
        || error.code === 'E2E_RUNTIME_FINALIZATION_PENDING_STATE_INVALID'
      )) {
        return response
      }
      try {
        return await this.completeGlobalResponse(request.requestId, requestDigest, response)
      } catch (persistenceError) {
        return this.errorResponse(request.requestId, runtimeHostError(
          'E2E_RUNTIME_REPLAY_PERSISTENCE_FAILED',
          'safety',
          '请求结果无法原子写入 replay ledger，Runtime 已阻止继续处理',
          persistenceError,
        ))
      }
    }
  }

  private async doctorResponse(
    request: Extract<RuntimeRequestEnvelope, { command: 'doctor' }>,
  ): Promise<RuntimeResponseEnvelope> {
    return this.successResponse(request.requestId, RuntimeDoctorReportSchema.parse(
      await this.dependencies.doctor(),
    ))
  }

  private async createRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'create-run' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const reader = this.projectFileReader()
    const identity = await resolveProjectIdentity(request.projectRoot, reader)
    const runId = runIdForRequest(request.requestId)
    const doctor = RuntimeDoctorReportSchema.parse(await this.dependencies.doctor())
    if (!doctor.ready) {
      throw runtimeHostError(
        'E2E_RUNTIME_NOT_READY',
        'environment',
        'Runtime Doctor 尚未证明基础运行能力就绪',
      )
    }

    const prdBytes = await reader.readFile(identity, request.payload.prdSource.path)
    const understandingContractBytes = await reader.readFile(
      identity, request.payload.understandingContract.source.path,
    )
    const projectPolicyBytes = await reader.readFile(identity, request.payload.projectPolicyPath)
    const normalizedPrd = decodeUtf8(prdBytes, 'PRD')
    const normalizedUnderstandingContract = decodeUtf8(
      understandingContractBytes, 'understand-prd requirements contract',
    )
    const understandingContractMachineView = assertUnderstandingContractHeader(
      normalizedUnderstandingContract, request.payload.understandingContract.header,
    )
    if (Buffer.byteLength(normalizedPrd, 'utf8') > 1024 * 1024) {
      throw runtimeHostError(
        'E2E_RUNTIME_PRD_SEMANTIC_REVIEW_TOO_LARGE', 'input',
        'PRD 原文超过单次语义确认上限 1 MiB；请拆分 PRD 后重试',
      )
    }
    if (understandingContractBytes.byteLength > 1024 * 1024) throw runtimeHostError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_TOO_LARGE', 'input',
      'understand-prd requirements contract 超过 1 MiB',
    )
    const understandingContractSourceDigest = digestBytes(
      'e2e-prd-understanding-contract-source/v1', understandingContractBytes,
    )
    const supportingSources: Array<{
      sourceId: string
      kind: 'file'
      path: string
      mediaType: string
      origin: { kind: 'file' | 'url' | 'text'; ref: string }
      relevance: 'necessary-dependency'
      bytes: Buffer
      normalizedText: string
    }> = []
    let sourceBundleByteLength = prdBytes.byteLength
    for (const source of request.payload.supportingSources ?? []) {
      const bytes = await reader.readFile(identity, source.path)
      const normalizedText = decodeUtf8(bytes, `PRD supporting source ${source.sourceId}`)
      if (Buffer.byteLength(normalizedText, 'utf8') > 1024 * 1024) throw runtimeHostError(
        'E2E_RUNTIME_PRD_SEMANTIC_REVIEW_TOO_LARGE', 'input',
        `Supporting source ${source.sourceId} 超过 1 MiB`,
      )
      sourceBundleByteLength += bytes.byteLength
      if (sourceBundleByteLength > 8 * 1024 * 1024) throw runtimeHostError(
        'E2E_RUNTIME_PRD_SOURCE_BUNDLE_TOO_LARGE', 'input',
        'PRD 与 supporting sources 冻结总量超过 8 MiB；请仅保留执行所需来源',
      )
      supportingSources.push({ ...source, bytes: Buffer.from(bytes), normalizedText })
    }
    const sourceIds = supportingSources.map((source) => source.sourceId)
    if (sourceIds.includes('PRD-BODY') || new Set(sourceIds).size !== sourceIds.length) {
      throw runtimeHostError(
        'E2E_RUNTIME_PRD_SOURCE_ID_INVALID', 'input',
        'Supporting sourceId 必须唯一且不得使用保留值 PRD-BODY',
      )
    }
    const prdRevision = computePrdRevision({
      normalizedPrd,
      sourceIdentity: { sourceId: 'PRD-BODY', version: '1', kind: 'file' },
      attachments: supportingSources.map((source) => ({
        sourceId: source.sourceId, fileName: source.path, mediaType: source.mediaType, bytes: source.bytes,
      })),
    }).prdRevision
    const timestamp = this.dependencies.now().toISOString()
    const snapshot: RuntimeRunSnapshot = {
      schemaVersion: '1.8.0',
      runId,
      assetId: request.payload.assetId,
      projectIdentityDigest: identity.digest,
      runtimeInstallationDigest: this.dependencies.installation.installationDigest,
      runRevision: 0,
      workflow: createWorkflow(),
      artifactDigests: {
        'prd-source': prdRevision,
        'project-policy-source': digestBytes('e2e-project-policy-source/v1', projectPolicyBytes),
      },
      frozenArtifacts: {},
      trustedExecutionFacts: {
        'approval-mode': this.dependencies.approvalMode ?? 'webauthn',
        'prd-source-snapshot': {
          schemaVersion: '1.0.0', sourceRef: request.payload.prdSource.path,
          normalizedText: normalizedPrd,
          normalizedDigest: digestText('e2e-prd-normalized-source/v1', normalizedPrd),
          byteLength: prdBytes.byteLength,
        },
        'prd-source-bundle': {
          schemaVersion: '1.0.0', sourceRevision: prdRevision,
          sources: [{
            sourceId: 'PRD-BODY', kind: 'file', sourceRef: request.payload.prdSource.path,
            mediaType: 'text/markdown', normalizedText: normalizedPrd,
            origin: request.payload.prdSource.origin, relevance: 'target',
            normalizedDigest: digestText('e2e-prd-understanding-source/v1', normalizedPrd),
            byteLength: prdBytes.byteLength,
          }, ...supportingSources.map((source) => ({
            sourceId: source.sourceId, kind: 'file' as const, sourceRef: source.path,
            mediaType: source.mediaType, normalizedText: source.normalizedText,
            origin: source.origin, relevance: source.relevance,
            normalizedDigest: digestText('e2e-prd-understanding-source/v1', source.normalizedText),
            byteLength: source.bytes.byteLength,
          }))],
        },
        'prd-understanding-contract': {
          schemaVersion: '1.0.0', header: request.payload.understandingContract.header,
          sourceRef: request.payload.understandingContract.source.path,
          sourceDigest: understandingContractSourceDigest,
          byteLength: understandingContractBytes.byteLength,
          normalizedText: normalizedUnderstandingContract,
          machineView: understandingContractMachineView,
        },
      },
      writeAttempts: {},
      executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
      requestResponses: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const response = this.successResponse(request.requestId, createRunResult(snapshot))
    return await this.withRunLock(identity.digest, runId, async (lock) => {
      const outcome = await this.dependencies.runStore.createRunOutcome(
        snapshot,
        request.requestId,
        requestDigest,
        response,
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async getStatus(
    request: Extract<RuntimeRequestEnvelope, { command: 'get-status' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const beforeRead = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (beforeRead === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(beforeRead)
      const projectedStatus = RuntimeStatusResultSchema.parse(
        statusResult(beforeRead, this.dependencies.now()),
      )
      await this.dependencies.runStatusPublisher?.publish(projectedStatus)
      const outcome = await this.dependencies.runStore.readRunOutcome(
        identity.digest,
        request.payload.runId,
        request.requestId,
        requestDigest,
        (snapshot) => {
          this.requireInstallation(snapshot)
          if (snapshot.workflow.eventChainDigest !== beforeRead.workflow.eventChainDigest
            || (snapshot.runRevision ?? 0) !== (beforeRead.runRevision ?? 0)) {
            throw runtimeHostError(
              'E2E_RUNTIME_STATUS_SNAPSHOT_CHANGED', 'safety',
              '状态工作区发布期间 Run 快照已变化',
            )
          }
          return this.successResponse(request.requestId, projectedStatus)
        },
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async preparePrdUnderstanding(
    request: Extract<RuntimeRequestEnvelope, { command: 'prepare-prd-understanding' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (snapshot === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(snapshot)
      if (snapshot.workflow.current !== 'created') throw runtimeHostError(
        'E2E_RUNTIME_UNDERSTANDING_PREPARE_STATE_MISMATCH', 'input',
        'understand-prd execution projection 只能在 created 状态准备',
      )
      const understanding = preparePrdUnderstandingProjection(request.payload.projection, snapshot)
      const existing = PrdUnderstandingPreparedFactSchema.safeParse(
        snapshot.trustedExecutionFacts['prd-understanding-prepared'],
      )
      if (existing.success
        && canonicalizeJson(existing.data.projection) !== canonicalizeJson(understanding)) {
        throw runtimeHostError(
          'E2E_RUNTIME_UNDERSTANDING_ALREADY_PREPARED', 'input',
          '同一 Run 的 requirements contract 只能准备一个不可变 execution projection',
        )
      }
      const response = this.successResponse(request.requestId, RuntimePreparePrdUnderstandingResultSchema.parse({
        runId: snapshot.runId,
        sourceRevision: snapshot.artifactDigests['prd-source'],
        understanding: existing.success ? existing.data.projection : understanding,
      }))
      const fact = existing.success ? existing.data : {
        schemaVersion: '1.0.0' as const,
        contractSourceDigest: understanding.contractSourceDigest,
        preparedAt: this.dependencies.now().toISOString(),
        projection: understanding,
      }
      const outcome = await this.dependencies.runStore.updateRunOutcome(
        identity.digest, snapshot.runId, request.requestId, requestDigest,
        (current) => ({
          snapshot: {
            ...current,
            trustedExecutionFacts: {
              ...current.trustedExecutionFacts,
              'prd-understanding-prepared': fact,
            },
            updatedAt: this.dependencies.now().toISOString(),
          },
          response,
        }),
        'prd-understanding-prepared',
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async compilePrdRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'compile-prd-run' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (snapshot === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(snapshot)
      if (snapshot.workflow.current !== 'created') throw runtimeHostError(
        'E2E_RUNTIME_PRD_RUN_COMPILE_STATE_MISMATCH',
        'input',
        'PRD Run 只能在 created 状态且 requirements projection 已冻结后编译',
      )
      const prepared = PrdUnderstandingPreparedFactSchema.safeParse(
        snapshot.trustedExecutionFacts['prd-understanding-prepared'],
      )
      if (!prepared.success) throw runtimeHostError(
        'E2E_RUNTIME_PRD_UNDERSTANDING_NOT_PREPARED',
        'input',
        '缺少 Runtime 冻结的唯一 requirements projection',
      )
      let plan: ReturnType<typeof compilePrdRun>
      try {
        plan = compilePrdRun({
          understanding: prepared.data.projection,
          design: request.payload.design,
        })
      } catch (cause) {
        const code = safeExecutionCauseCode(cause)
        if (code?.startsWith('E2E_RUNTIME_PRD_RUN_') === true) {
          throw runtimeHostError(code, 'input', '声明式设计未与 requirements contract 完整闭合')
        }
        throw cause
      }
      if (snapshot.compiledPrdRun !== undefined
        && canonicalizeJson(snapshot.compiledPrdRun) !== canonicalizeJson(plan)) {
        throw runtimeHostError(
          'E2E_RUNTIME_PRD_RUN_ALREADY_COMPILED',
          'input',
          '同一 Run 已绑定不同声明式设计，禁止替换编译计划',
        )
      }
      const persistedPlan = snapshot.compiledPrdRun ?? plan
      const schedule = snapshot.caseSchedule ?? createCaseSchedule(
        persistedPlan,
        this.dependencies.now().toISOString(),
      )
      if (schedule.compilerDigest !== persistedPlan.compilerDigest) throw runtimeHostError(
        'E2E_RUNTIME_CASE_SCHEDULE_BINDING_INVALID',
        'artifact',
        '持久 Case 调度与编译计划摘要不一致',
      )
      const response = this.successResponse(request.requestId, RuntimeCompilePrdRunResultSchema.parse({
        runId: snapshot.runId,
        compilerDigest: persistedPlan.compilerDigest,
        caseCount: persistedPlan.cases.length,
        review: {
          contractProjectionDigest: persistedPlan.contractProjectionDigest,
          caseIds: persistedPlan.cases.map((testCase) => testCase.caseId),
          mappedAcceptanceCount: new Set(persistedPlan.cases.flatMap((testCase) =>
            testCase.oracles.map((oracle) =>
              `${oracle.contractNodeId}\u0000${oracle.acceptanceCriterion}`,
            ),
          )).size,
          oracleCount: persistedPlan.cases.reduce(
            (total, testCase) => total + testCase.oracles.length, 0,
          ),
        },
        unresolvedItems: [],
        nextRequiredDecision: 'scope',
      }))
      const outcome = await this.dependencies.runStore.updateRunOutcome(
        identity.digest,
        snapshot.runId,
        request.requestId,
        requestDigest,
        (current) => ({
          snapshot: {
            ...current,
            compiledPrdRun: persistedPlan,
            caseSchedule: schedule,
            updatedAt: this.dependencies.now().toISOString(),
          },
          response,
        }),
        'prd-run-compiled',
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async getAcceptanceReview(
    request: Extract<RuntimeRequestEnvelope, { command: 'get-acceptance-review' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const outcome = await this.dependencies.runStore.readRunOutcome(
        identity.digest, request.payload.runId, request.requestId, requestDigest,
        (snapshot) => {
          this.requireInstallation(snapshot)
          const review = buildAcceptanceReview(snapshot)
          const receipt = AcceptanceReviewReceiptSchema.safeParse(
            snapshot.trustedExecutionFacts['acceptance-review-receipt'],
          )
          const confirmed = receipt.success && receipt.data.reviewDigest === review.reviewDigest
          return this.successResponse(request.requestId, RuntimeAcceptanceReviewResultSchema.parse({
            review,
            confirmation: confirmed
              ? { status: 'confirmed', receiptDigest: receipt.data.receiptDigest }
              : { status: 'required' },
          }))
        },
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async confirmAcceptanceReview(
    request: Extract<RuntimeRequestEnvelope, { command: 'confirm-acceptance-review' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (snapshot === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(snapshot)
      const review = buildAcceptanceReview(snapshot)
      const receipt = confirmAcceptanceReview({
        review,
        expectedReviewDigest: request.payload.reviewDigest,
        confirmedAt: this.dependencies.now().toISOString(),
      })
      const response = this.successResponse(request.requestId, RuntimeAcceptanceReviewResultSchema.parse({
        review,
        confirmation: { status: 'confirmed', receiptDigest: receipt.receiptDigest },
      }))
      return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
        identity.digest, snapshot.runId, request.requestId, requestDigest,
        (current) => {
          const currentReview = buildAcceptanceReview(current)
          if (currentReview.reviewDigest !== review.reviewDigest) throw runtimeHostError(
            'E2E_ACCEPTANCE_REVIEW_CHANGED', 'safety', '确认落盘前验收语义链已变化',
          )
          return {
            snapshot: {
              ...current,
              trustedExecutionFacts: {
                ...current.trustedExecutionFacts,
                'acceptance-review': AcceptanceReviewSchema.parse(review),
                'acceptance-review-receipt': receipt,
              },
              updatedAt: this.dependencies.now().toISOString(),
            },
            response,
          }
        },
        'acceptance-review-confirmed', lock,
      ))
    })
  }

  private async configureTarget(
    request: Extract<RuntimeRequestEnvelope, { command: 'configure-target' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const target = createTargetContractFact(request.payload.targetContract)
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (snapshot === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(snapshot)
      const normalConfiguration = ['created', 'source-frozen', 'awaiting-scope-approval', 'scope-approved',
        'modeled', 'coverage-audited'].includes(snapshot.workflow.current)
      const pageIdentityRecoveryState = snapshot.workflow.current === 'preflight-readonly'
        && snapshot.preflightBlocker?.reasonCode === 'E2E_RUNTIME_PAGE_MISMATCH'
        && snapshot.targetContract !== undefined
        && snapshot.targetContract.contractDigest !== target.contractDigest
      if (pageIdentityRecoveryState
        && !isPageIdentityOnlyTargetRevision(snapshot.targetContract!, target)) {
        throw runtimeHostError(
          'E2E_TARGET_PAGE_IDENTITY_ONLY_REVISION_REQUIRED', 'input',
          '页面身份恢复仅允许修改 pageIdentityPolicy；目标地址、环境标签和允许导航源必须保持不变',
        )
      }
      const recoverablePageIdentityRevision = pageIdentityRecoveryState
        && isPageIdentityOnlyTargetRevision(snapshot.targetContract!, target)
      if (!normalConfiguration && !recoverablePageIdentityRevision) throw runtimeHostError(
        'E2E_TARGET_CONFIGURATION_STATE_MISMATCH', 'input',
        '目标配置必须在 Discovery 授权前完成；仅页面身份不匹配可显式修订并失效下游资产',
      )
      const invalidation = recoverablePageIdentityRevision
        ? targetChangeInvalidationSummary(snapshot)
        : undefined
      const response = this.successResponse(request.requestId, {
        runId: snapshot.runId, target,
        ...(invalidation === undefined ? {} : { invalidation }),
      })
      return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
        identity.digest, snapshot.runId, request.requestId, requestDigest,
        (current) => {
          if (recoverablePageIdentityRevision) return {
            snapshot: invalidateTargetDependentSnapshot(
              current, target, invalidation!, this.dependencies.now().toISOString(),
              this.dependencies.installation.version,
            ),
            response,
          }
          if (current.targetContract?.contractDigest === target.contractDigest) return {
            snapshot: { ...current, updatedAt: this.dependencies.now().toISOString() }, response,
          }
          const { targetProbe: _invalidatedProbe, ...withoutProbe } = current
          return {
            snapshot: {
              ...withoutProbe,
              runRevision: (current.runRevision ?? 0) + 1,
              targetContract: target,
              updatedAt: this.dependencies.now().toISOString(),
            },
            response,
          }
        },
        'target-contract-configured', lock,
      ))
    })
  }

  private async probeTarget(
    request: Extract<RuntimeRequestEnvelope, { command: 'probe-target' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const capability = this.dependencies.targetProbe
    if (capability === undefined) throw blockedError('E2E_TARGET_PROBE_NOT_READY')
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    if (initial.targetContract === undefined) throw runtimeHostError(
      'E2E_TARGET_CONTRACT_REQUIRED', 'input', '请先配置 TargetContract',
    )
    if (initial.compiledPrdRun === undefined) throw runtimeHostError(
      'E2E_TARGET_PROBE_CASES_REQUIRED', 'input',
      'Target Probe 必须在 prepare-prd-understanding 与 compile-prd-run 完成后执行',
    )
    const previousProbe = initial.targetProbe?.targetContractDigest
      === initial.targetContract.contractDigest ? initial.targetProbe : undefined
    const probePolicy = selectTargetProbePolicy({
      previewReadonlyOnly: hasPreviewReadonlyOnlyCases(initial),
      ...(previousProbe === undefined ? {} : { previous: previousProbe }),
    })
    const targetProbe = await runTargetProbe(capability, {
      runId: initial.runId,
      target: initial.targetContract,
      probedAt: this.dependencies.now().toISOString(),
      strategy: probePolicy.strategy,
      attempt: probePolicy.attempt,
    })
    return await this.withRunLock(identity.digest, initial.runId, async (lock) => {
      const current = await this.dependencies.runStore.getRun(identity.digest, initial.runId)
      if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      if ((current.runRevision ?? 0) !== (initial.runRevision ?? 0)
        || current.targetContract?.contractDigest !== initial.targetContract?.contractDigest) {
        throw runtimeHostError(
          'E2E_TARGET_PROBE_FENCED', 'safety', 'Target Probe 运行期间 Run 或目标配置已变化',
        )
      }
      const response = this.successResponse(request.requestId, {
        runId: current.runId, targetProbe,
      })
      return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
        identity.digest, current.runId, request.requestId, requestDigest,
        (snapshot) => ({
          snapshot: {
            ...snapshot,
            runRevision: (snapshot.runRevision ?? 0) + 1,
            targetProbe,
            updatedAt: this.dependencies.now().toISOString(),
          },
          response,
        }),
        'target-probed', lock,
      ))
    })
  }

  private async renderReport(
    request: Extract<RuntimeRequestEnvelope, { command: 'render-report' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const publisherFactory = this.dependencies.projectPublisherFactory
    if (publisherFactory === undefined) throw blockedError('E2E_RUNTIME_REPORT_NOT_READY')
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (snapshot === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(snapshot)
      const publication = await publisherFactory(identity.realRoot).renderActiveReport({
        assetId: snapshot.assetId,
        expectedGenerationId: snapshot.runId,
        expectedProjectIdentityDigest: identity.digest,
      })
      let standaloneReportRoot: string | undefined
      if (runtimeUsesFullPlaywright(snapshot)) {
        const standalone = this.dependencies.standaloneEvidencePublisher
        if (standalone === undefined) {
          throw blockedError('E2E_RUNTIME_STANDALONE_EVIDENCE_NOT_READY')
        }
        const cases = Object.values(snapshot.executionResults?.realEnvironment ?? {}).map((result) => {
          const attempts = Object.values(snapshot.writeAttempts ?? {})
            .filter((attempt) => attempt.actionId === result.actionId)
          if (attempts.length !== 1) throw runtimeHostError(
            'E2E_RUNTIME_EVIDENCE_ATTEMPT_BINDING_INVALID',
            'artifact',
            '执行结果必须唯一绑定一个持久 WriteAttempt 才能发布原始证据',
          )
          return {
            caseId: result.caseId,
            actionId: result.actionId,
            attemptId: attempts[0]!.attemptId,
          }
        })
        standaloneReportRoot = await standalone.publishRuntimeState({
          assetId: snapshot.assetId,
          runId: snapshot.runId,
          generationDigest: publication.active.generationDigest,
          ...(request.payload.outputRoot === undefined
            ? {} : { outputRoot: request.payload.outputRoot }),
          rendered: publication.rendered,
          cases,
        })
      }
      const response = this.successResponse(request.requestId, {
        runId: snapshot.runId,
        assetId: snapshot.assetId,
        generationId: publication.active.generationId,
        generationDigest: publication.active.generationDigest,
        terminalVerdict: publication.active.terminalVerdict,
        report: publication.rendered,
        ...(standaloneReportRoot === undefined ? {} : { standaloneReportRoot }),
      })
      const outcome = await this.dependencies.runStore.readRunOutcome(
        identity.digest,
        snapshot.runId,
        request.requestId,
        requestDigest,
        (current) => {
          this.requireInstallation(current)
          if (current.assetId !== snapshot.assetId || current.runId !== snapshot.runId) {
            throw runtimeHostError(
              'E2E_RUNTIME_REPORT_BINDING_CHANGED', 'safety',
              '报告读取期间 Run 绑定发生变化',
            )
          }
          return response
        },
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async finalizeRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'finalize-run' }>,
    requestDigest: string,
    requestWasPending: boolean,
  ): Promise<RuntimeResponseEnvelope> {
    const finalizer = this.dependencies.generationFinalizer
    if (finalizer === undefined) throw blockedError('E2E_RUNTIME_FINALIZER_NOT_READY')
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const attemptId = `FINALIZE-${digestText('runtime-finalization-attempt/v1', canonicalizeJson({
      projectIdentityDigest: identity.digest,
      runId: request.payload.runId,
      requestId: request.requestId,
      requestDigest,
    })).slice('sha256:'.length)}`
    let prepared: RuntimeRunSnapshot
    let recovery = false
    prepared = await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const current = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(current)
      if (current.finalizationAttempt !== undefined) {
        const attempt = current.finalizationAttempt
        if (!requestWasPending || current.workflow.current !== 'finalizing'
          || attempt.requestId !== request.requestId
          || attempt.requestDigest !== requestDigest
          || attempt.attemptId !== attemptId) throw runtimeHostError(
          'E2E_RUNTIME_FINALIZATION_PENDING_STATE_INVALID', 'safety',
          'pending finalize-run 与持久 finalization attempt 不闭合',
        )
        recovery = true
        return current
      }
      if (requestWasPending || current.workflow.current !== 'diagnosing') throw runtimeHostError(
        'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH', 'input', 'finalize-run 仅允许 diagnosing Run',
      )
      const finalizationMaterial = current.trustedExecutionFacts['finalization-material']
        ?? (this.dependencies.finalizationMaterialSealer === undefined ? undefined
          : await sealRuntimeFinalizationMaterial(this.dependencies.finalizationMaterialSealer, current))
      return await this.dependencies.runStore.recordFinalizationAttempt({
        projectIdentityDigest: identity.digest,
        runId: current.runId,
        requestId: request.requestId,
        requestDigest,
        attemptId,
        startedAt: this.dependencies.now().toISOString(),
        expectedRevision: current.runRevision ?? 0,
        expectedWorkflowDigest: current.workflow.eventChainDigest,
        ...(finalizationMaterial === undefined ? {} : { finalizationMaterial }),
        toFinalizing: (snapshot) => ({
          ...snapshot,
          workflow: transitionWorkflow({
            state: snapshot.workflow,
            next: 'finalizing',
            reason: 'trusted generation finalization prepared',
            timestamp: this.dependencies.now().toISOString(),
            engineVersion: this.dependencies.installation.version,
          }).state,
        }),
        lock,
      })
    })

    let result: Awaited<ReturnType<typeof executeRuntimeGenerationFinalization>>
    try {
      result = await executeRuntimeGenerationFinalization(finalizer, {
        projectRoot: identity.realRoot,
        snapshot: prepared,
        attemptId,
        requestDigest,
        recovery,
      })
    } catch (cause) {
      const causeCode = safeExecutionCauseCode(cause)
      throw runtimeHostError(
        'E2E_RUNTIME_FINALIZATION_RECOVERY_REQUIRED', 'safety',
        `finalization 可能已发布但 Run outcome 尚未闭合；必须以同一请求恢复且不得重复执行副作用${
          causeCode === undefined ? '' : `；内部错误码 ${causeCode}`}`,
        cause,
      )
    }

    try {
      return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
        const response = this.successResponse(request.requestId, {
          runId: prepared.runId,
          assetId: prepared.assetId,
          ...result,
        })
        const outcome = await this.dependencies.runStore.updateRunOutcome(
          identity.digest,
          prepared.runId,
          request.requestId,
          requestDigest,
          (current) => {
            this.requireInstallation(current)
            if (current.finalizationAttempt?.attemptId !== attemptId
              || current.finalizationAttempt.requestId !== request.requestId
              || current.finalizationAttempt.requestDigest !== requestDigest
              || current.workflow.current !== 'finalizing') throw runtimeHostError(
              'E2E_RUNTIME_FINALIZATION_FENCED', 'safety', 'finalization completion 已陈旧',
            )
            const publicationReady = transitionWorkflow({
              state: current.workflow,
              next: 'publication-ready',
              reason: `active generation ${result.generationDigest} verified`,
              timestamp: this.dependencies.now().toISOString(),
              engineVersion: this.dependencies.installation.version,
            }).state
            const terminal = transitionWorkflow({
              state: publicationReady,
              next: result.terminalVerdict,
              reason: `publication committed with ${result.terminalVerdict}`,
              timestamp: this.dependencies.now().toISOString(),
              engineVersion: this.dependencies.installation.version,
              commitVerified: true,
            }).state
            const { finalizationAttempt: _completed, ...withoutAttempt } = current
            return {
              snapshot: {
                ...withoutAttempt,
                workflow: terminal,
                publication: {
                  ...result,
                  committedAt: this.dependencies.now().toISOString(),
                },
                updatedAt: this.dependencies.now().toISOString(),
              },
              response,
            }
          },
          'generation-publication-committed',
          lock,
        )
        return RuntimeResponseEnvelopeSchema.parse(outcome)
      })
    } catch (cause) {
      const causeCode = safeExecutionCauseCode(cause)
      throw runtimeHostError(
        'E2E_RUNTIME_FINALIZATION_RECOVERY_REQUIRED', 'safety',
        `active generation 已复读但 Run outcome 未原子闭合；请以同一请求恢复${
          causeCode === undefined ? '' : `；内部错误码 ${causeCode}`}`, cause,
      )
    }
  }

  private async submitCandidate(
    request: Extract<RuntimeRequestEnvelope, { command: 'submit-candidate' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    if (!EXTERNAL_SEMANTIC_ARTIFACT_TYPES.has(request.payload.artifactType)) {
      throw runtimeHostError(
        'E2E_RUNTIME_TRUSTED_FACT_EXTERNAL_WRITE_FORBIDDEN',
        'safety',
        'browser-preflight、执行结果、审计、证据、清理与报告只能由 Runtime 内部可信能力写入',
      )
    }
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (snapshot === undefined) {
        throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      }
      this.requireInstallation(snapshot)
      if (request.payload.expectedState !== snapshot.workflow.current) {
        throw runtimeHostError(
          'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH',
          'input',
          'expectedState 只能作为当前状态的并发前置条件，不能指定 next state',
        )
      }

      const candidate = parseCandidate(request.payload.artifactType, request.payload.candidate)
      const expectedDigest = digestArtifactContent(
        `artifact-content/${candidate.schemaVersion}/${candidate.artifactType}`,
        candidate as unknown as Record<string, unknown>,
      )
      if (candidate.contentDigest !== expectedDigest) {
        throw runtimeHostError(
          'E2E_RUNTIME_CANDIDATE_DIGEST_MISMATCH',
          'artifact',
          'Candidate contentDigest 与 Runtime 重算结果不一致',
        )
      }
      if (candidate.assetId !== snapshot.assetId
        || candidate.prdRevision !== snapshot.artifactDigests['prd-source']
        || candidate.generationId !== snapshot.runId) {
        throw runtimeHostError(
          'E2E_RUNTIME_CANDIDATE_BINDING_MISMATCH',
          'artifact',
          'Candidate assetId、prdRevision 或 generationId 未绑定当前 Run',
        )
      }
      if (request.payload.artifactType === 'prd-request') {
        assertPrdUnderstandingCandidate(candidate, snapshot)
      }
      assertPrdUnderstandingLinkedCandidate(request.payload.artifactType, candidate, snapshot)
      if (request.payload.artifactType === 'test-cases' && snapshot.compiledPrdRun !== undefined) {
        assertCompiledCaseProjection(
          snapshot.compiledPrdRun,
          ArtifactSchemaRegistry['test-cases'].parse(candidate).content,
        )
      }

      const existing = snapshot.frozenArtifacts[request.payload.artifactType]
      if (existing !== undefined && canonicalizeJson(existing) !== canonicalizeJson(candidate)) {
        throw runtimeHostError(
          'E2E_RUNTIME_CANDIDATE_ALREADY_FROZEN',
          'artifact',
          '同一 Run 中已冻结的 Artifact 类型不得被不同候选覆盖',
        )
      }

      const next = nextWorkflowNode(snapshot.workflow.current, request.payload.artifactType)
      const bindingAsset = snapshot.workflow.current === 'binding-draft'
        && (request.payload.artifactType === 'test-cases'
          || request.payload.artifactType === 'execution-contract')
      const supplementalAsset = isSupplementalCandidate(
        snapshot.workflow.current, request.payload.artifactType,
      )
      if (next === undefined && !bindingAsset && !supplementalAsset) {
        throw blockedError(missingCapabilityCode(snapshot.workflow.current))
      }
      const frozenArtifacts = {
        ...snapshot.frozenArtifacts,
        [request.payload.artifactType]: candidate,
      }
      assertSemanticStagePrerequisites(request.payload.artifactType, frozenArtifacts)
      const bindingComplete = bindingAsset
        && frozenArtifacts['test-cases'] !== undefined
        && frozenArtifacts['execution-contract'] !== undefined

      let reservedLeases: DataLease[] = []
      let workflow = snapshot.workflow
      if (next !== undefined) {
        workflow = transitionWorkflow({
          state: workflow,
          next,
          reason: `accepted candidate ${request.payload.artifactType}:${candidate.contentDigest}`,
          timestamp: this.dependencies.now().toISOString(),
          engineVersion: this.dependencies.installation.version,
        }).state
      } else if (bindingComplete) {
        const leaseRequests = executionContractWriteLeaseRequests(frozenArtifacts)
        if (leaseRequests.length > 0) {
          if (this.dependencies.reserveExecutionLeases === undefined) {
            throw blockedError('E2E_RUNTIME_LEASE_AUTHORITY_NOT_READY')
          }
          reservedLeases = await this.dependencies.reserveExecutionLeases({
            runId: snapshot.runId,
            leases: leaseRequests.map((lease) => ({ ...lease, ttlMs: 10 * 60_000 })),
          })
          assertReservedExecutionLeases(snapshot.runId, leaseRequests, reservedLeases, this.dependencies.now())
          workflow = transitionWorkflow({
            state: workflow,
            next: 'lease-reserved',
            reason: `atomically reserved ${reservedLeases.length} execution lease(s)`,
            timestamp: this.dependencies.now().toISOString(),
            engineVersion: this.dependencies.installation.version,
          }).state
        }
        workflow = transitionWorkflow({
          state: workflow,
          next: 'awaiting-execution-approval',
          reason: `accepted binding candidate ${request.payload.artifactType}:${candidate.contentDigest}`,
          timestamp: this.dependencies.now().toISOString(),
          engineVersion: this.dependencies.installation.version,
        }).state
      }

      const updated: RuntimeRunSnapshot = {
        ...snapshot,
        workflow,
        artifactDigests: {
          ...snapshot.artifactDigests,
          [request.payload.artifactType]: candidate.contentDigest,
          ...(request.payload.artifactType === 'prd-request' ? {
            'prd-understanding-projection': ArtifactSchemaRegistry['prd-request']
              .parse(candidate).content.understanding.projectionDigest,
          } : {}),
        },
        frozenArtifacts,
        updatedAt: this.dependencies.now().toISOString(),
      }
      const outcome = await this.dependencies.runStore.updateRunOutcome(
        identity.digest,
        request.payload.runId,
        request.requestId,
        requestDigest,
        (current) => {
          if (canonicalizeJson(current) !== canonicalizeJson(snapshot)) {
            throw runtimeHostError(
              'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH', 'safety',
              '租约预留后 Run 快照发生并发变化；须以同一请求恢复',
            )
          }
          return {
            snapshot: updated,
            response: this.successResponse(request.requestId, {
              runId: updated.runId,
              workflow: updated.workflow,
              acceptedArtifact: {
                artifactType: request.payload.artifactType,
                contentDigest: candidate.contentDigest,
              },
              reservedLeases,
            }),
          }
        },
        'candidate-accepted',
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
    })
  }

  private async openApproval(
    request: Extract<RuntimeRequestEnvelope, { command: 'open-approval' }>,
    requestDigest: string,
    confirmed?: PendingLocalApprovalConfirmation,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    if (request.payload.approvalType === 'discovery') {
      assertTargetReady(initial)
      assertAcceptanceReviewConfirmed(initial)
    }
    requireApprovalType(initial, request.payload.approvalType)
    assertRuntimeGrantSubject(initial, request.payload.approvalType, request.payload.grantSubject)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(
      initial,
      request.payload.approvalType,
      request.payload.grantSubject,
    )
    const approvalMode = approvalModeFromTrustedFacts(initial.trustedExecutionFacts)
    if (confirmed !== undefined) {
      const webAuthnSemanticConfirmation = approvalMode === 'webauthn'
        && confirmed.approvalType === 'execution'
        && confirmed.summary.semanticReview !== undefined
      if (approvalMode !== 'local-confirmation' && !webAuthnSemanticConfirmation) {
        throw confirmationHostError('E2E_LOCAL_CONFIRMATION_MODE_MISMATCH')
      }
      assertCurrentLocalApprovalConfirmation(confirmed, {
        confirmationId: confirmed.confirmationId, subjectDigest,
        projectIdentityDigest: identity.digest,
        runtimeInstallationDigest: initial.runtimeInstallationDigest,
        workflowState: initial.workflow.current, now: this.dependencies.now(),
      })
    } else if (approvalMode === 'local-confirmation'
      || (approvalMode === 'webauthn' && request.payload.approvalType === 'execution')) {
      const provisionalExpiry = new Date(this.dependencies.now().getTime() + 10 * 60_000).toISOString()
      const projected = projectLocalApproval({
        snapshot: initial, approvalType: request.payload.approvalType,
        subjectDigest, grantSubject: request.payload.grantSubject, expiresAt: provisionalExpiry,
      })
      if (approvalMode === 'local-confirmation' && projected.disposition.kind === 'blocked') {
        throw confirmationHostError(projected.disposition.reasonCode)
      }
      if (projected.disposition.kind === 'confirmation-required'
        || (approvalMode === 'webauthn' && request.payload.approvalType === 'execution')) {
        const confirmation = createPendingLocalApprovalConfirmation({
          approvalType: request.payload.approvalType, subjectDigest,
          projectIdentityDigest: identity.digest,
          runtimeInstallationDigest: initial.runtimeInstallationDigest,
          workflowState: initial.workflow.current, summary: projected.summary,
          grantSubject: request.payload.grantSubject, now: this.dependencies.now(),
        })
        return await this.withRunLock(identity.digest, initial.runId, async (lock) => {
          const current = await this.dependencies.runStore.getRun(identity.digest, initial.runId)
          if (current === undefined
            || computeRuntimeApprovalSubjectDigest(current, request.payload.approvalType,
              request.payload.grantSubject) !== subjectDigest) {
            throw confirmationHostError('E2E_RUNTIME_APPROVAL_SUBJECT_CHANGED')
          }
          return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
            identity.digest, initial.runId, request.requestId, requestDigest,
            (snapshot) => ({
              snapshot: {
                ...snapshot,
                trustedExecutionFacts: {
                  ...snapshot.trustedExecutionFacts,
                  'pending-local-approval': confirmation,
                },
                updatedAt: this.dependencies.now().toISOString(),
              },
              response: this.successResponse(request.requestId, {
                status: 'confirmation-required', approvalMode,
                confirmationId: confirmation.confirmationId, subjectDigest,
                expiresAt: confirmation.expiresAt, summary: confirmation.summary,
              }),
            }),
            'local-approval-confirmation-created', lock,
          ))
        })
      }
    }
    const authorityHostFactory = approvalMode === 'local-confirmation'
      ? this.dependencies.localAuthorityHostFactory
      : this.dependencies.authorityHostFactory
    if (authorityHostFactory === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const authorityHost = await authorityHostFactory()
    if (authorityHost.requestApproval === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const approvalBinding = request.payload.grantSubject === undefined ? undefined : {
      runId: initial.runId,
      approvalType: request.payload.approvalType as 'discovery' | 'execution',
      subjectDigest,
      installationDigest: initial.runtimeInstallationDigest,
    }
    let finalizedDecision: DecisionReceipt | undefined
    const validateCurrent = (current: RuntimeRunSnapshot | undefined): RuntimeRunSnapshot => {
      if (current === undefined) throw runtimeHostError(
        'E2E_RUNTIME_RUN_NOT_FOUND', 'input', '审批返回前 Run 已不存在',
      )
      this.requireInstallation(current)
      requireApprovalType(current, request.payload.approvalType)
      assertRuntimeGrantSubject(current, request.payload.approvalType, request.payload.grantSubject)
      if (computeRuntimeApprovalSubjectDigest(
        current, request.payload.approvalType, request.payload.grantSubject,
      ) !== subjectDigest) throw runtimeHostError(
        'E2E_RUNTIME_APPROVAL_SUBJECT_CHANGED', 'safety', '审批返回前 Run approval subject 已改变',
      )
      return current
    }
    const persistFinalized = async (
      current: RuntimeRunSnapshot,
      lock: RuntimeRunLock,
      sessionId: string,
      finalized?: {
        grant: SignedGrant
        approvalBinding: { runId: string; approvalType: 'discovery' | 'execution'; subjectDigest: string; installationDigest: string }
      },
    ): Promise<RuntimeResponseEnvelope> => {
      const signedFactDigest = finalized !== undefined
        ? digestText('local-approved-grant/v1', canonicalizeJson(finalized.grant))
        : finalizedDecision?.signedDigest ?? digestText('approval-completed/v1', canonicalizeJson({
          runId: current.runId, approvalType: request.payload.approvalType, subjectDigest, sessionId,
        }))
      const receiptDigest = confirmed === undefined ? signedFactDigest : localConfirmationReceiptDigest({
        confirmation: confirmed, signedFactDigest,
      })
      const response = this.successResponse(request.requestId, {
        status: 'approved', approvalMode, receiptDigest,
        runId: current.runId, approvalType: request.payload.approvalType, subjectDigest, sessionId,
        ...(finalized === undefined ? {} : {
          signedGrant: finalized.grant, approvalBinding: finalized.approvalBinding,
        }),
      })
      const persist = async () => {
        if (finalized === undefined) {
          if (request.payload.approvalType !== 'scope' && request.payload.approvalType !== 'lineage') {
            return RuntimeResponseEnvelopeSchema.parse(
            await this.dependencies.runStore.readRunOutcome(
              identity.digest, current.runId, request.requestId, requestDigest, () => response, lock,
            ),
            )
          }
          const decisionArtifactType = request.payload.approvalType === 'scope'
            ? 'acceptance-scope' : 'prd-diff'
          if (current.frozenArtifacts[decisionArtifactType] === undefined) {
            if (request.payload.approvalType !== 'scope') return RuntimeResponseEnvelopeSchema.parse(
              await this.dependencies.runStore.readRunOutcome(
                identity.digest, current.runId, request.requestId, requestDigest, () => response, lock,
              ),
            )
            return RuntimeResponseEnvelopeSchema.parse(
              await this.dependencies.runStore.updateRunOutcome(
                identity.digest, current.runId, request.requestId, requestDigest,
                (snapshot) => ({ snapshot: clearLocalConfirmation({ ...snapshot,
                  workflow: transitionWorkflow({
                    state: snapshot.workflow, next: 'scope-approved',
                    reason: 'scope user-presence approval completed',
                    timestamp: this.dependencies.now().toISOString(),
                    engineVersion: this.dependencies.installation.version,
                  }).state,
                  updatedAt: this.dependencies.now().toISOString(),
                }, confirmed), response }),
                'scope-approval-completed', lock,
              ),
            )
          }
          if (finalizedDecision === undefined) throw runtimeHostError(
            'E2E_RUNTIME_DECISION_RECEIPT_MISSING', 'safety',
            'scope/lineage 用户在场完成后缺少 Authority DecisionReceipt',
          )
          return RuntimeResponseEnvelopeSchema.parse(
            await this.dependencies.runStore.updateRunOutcome(
              identity.digest, current.runId, request.requestId, requestDigest,
              (snapshot) => {
                const decided = applyRuntimeDecisionReceipt(
                  snapshot, request.payload.approvalType as 'scope' | 'lineage', finalizedDecision!,
                )
                return {
                snapshot: clearLocalConfirmation({
                  ...snapshot,
                  frozenArtifacts: {
                    ...snapshot.frozenArtifacts,
                    [decided.artifact.artifactType]: decided.artifact,
                  },
                  artifactDigests: {
                    ...snapshot.artifactDigests,
                    [decided.artifact.artifactType]: decided.artifact.contentDigest,
                  },
                  workflow: request.payload.approvalType === 'scope' ? transitionWorkflow({
                    state: snapshot.workflow, next: 'scope-approved',
                    reason: 'scope user-presence approval completed',
                    timestamp: this.dependencies.now().toISOString(),
                    engineVersion: this.dependencies.installation.version,
                  }).state : snapshot.workflow,
                  updatedAt: this.dependencies.now().toISOString(),
                }, confirmed),
                response: this.successResponse(request.requestId, {
                  ...((response.result ?? {}) as Record<string, unknown>),
                  decisionReceipt: finalizedDecision,
                  decidedArtifactDigest: decided.artifact.contentDigest,
                }),
              }},
              `${request.payload.approvalType}-approval-completed`, lock,
            ),
          )
        }
        const factType = request.payload.approvalType === 'discovery'
          ? 'signed-discovery-grant' as const
          : 'signed-execution-grant' as const
        const capability = await this.dependencies.runStore.authorizeTrustedFactWrite(
          identity.digest, current.runId, lock,
        )
        return RuntimeResponseEnvelopeSchema.parse(
          await this.dependencies.runStore.writeTrustedFactOutcome({
            capability, requestId: request.requestId, requestDigest,
            factType, fact: finalized.grant, response,
            update: (snapshot) => {
              const approvedSnapshot = factType === 'signed-execution-grant'
                && 'runBundleProjectionDigest' in finalized.grant.subject
                ? bindRuntimeExecutionGrantArtifacts({
                  snapshot,
                  grant: finalized.grant,
                  createdAt: this.dependencies.now().toISOString(),
                  engineVersion: this.dependencies.installation.version,
                })
                : snapshot
              if (factType === 'signed-execution-grant'
                && confirmed?.summary.semanticReview !== undefined) {
                approvedSnapshot.trustedExecutionFacts['prd-semantic-confirmation'] = {
                  schemaVersion: '1.0.0',
                  confirmationId: confirmed.confirmationId,
                  subjectDigest: confirmed.subjectDigest,
                  reviewDigest: confirmed.summary.semanticReview.reviewDigest,
                  confirmedAt: this.dependencies.now().toISOString(),
                  semanticReview: structuredClone(confirmed.summary.semanticReview),
                }
              }
              return clearLocalConfirmation({
                ...approvedSnapshot,
                workflow: transitionWorkflow({
                  state: approvedSnapshot.workflow,
                  next: factType === 'signed-discovery-grant' ? 'discovery-approved' : 'execution-approved',
                  reason: `${request.payload.approvalType} grant finalized`,
                  timestamp: this.dependencies.now().toISOString(),
                  engineVersion: this.dependencies.installation.version,
                  ...(factType === 'signed-execution-grant' ? { executionGrantValid: true } : {}),
                }).state,
                updatedAt: this.dependencies.now().toISOString(),
              }, confirmed)
            },
          }),
        )
      }
      if (finalized === undefined) return await persist()
      return await persistFinalizedApprovalOutcome({
        persist,
        acknowledge: async () => {
          await authorityHost.acknowledgeFinalization?.({
            finalizationId: request.requestId, requestDigest,
            grantId: finalized.grant.grantId, approvalBinding: finalized.approvalBinding,
          })
        },
        persistencePending: (cause) => runtimeHostError(
          'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING', 'safety',
          `Authority 已最终化 Grant，但 Run Store outcome 尚未持久化；请求保持 pending 并可恢复；内部错误码 ${safeExecutionCauseCode(cause) ?? 'E2E_RUNTIME_PERSISTENCE_FAILURE'}`,
          cause,
        ),
      })
    }

    if (approvalBinding !== undefined && authorityHost.recoverApproval !== undefined) {
      const currentIdentity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
      assertSameProjectIdentity(identity, currentIdentity)
      let recovered = false
      try {
        const replay = await this.withRunLock(identity.digest, initial.runId, async (lock) => {
          assertSameProjectIdentity(
            identity,
            await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
          )
          const current = validateCurrent(await this.dependencies.runStore.getRun(identity.digest, initial.runId))
          const finalized = await authorityHost.recoverApproval!({
            finalizationId: request.requestId, requestDigest,
            grantSubject: request.payload.grantSubject!, approvalBinding,
          })
          if (finalized === undefined) return undefined
          recovered = true
          assertSameProjectIdentity(
            identity,
            await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
          )
          return await persistFinalized(current, lock, finalized.sessionId, finalized)
        })
        if (replay !== undefined) return replay
      } catch (cause) {
        if (recovered
          && !(cause instanceof E2EError && cause.code === 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING')) {
          throw runtimeHostError(
            'E2E_RUNTIME_APPROVAL_RECOVERY_BINDING_CHANGED', 'safety',
            '恢复 Grant 后 Run 绑定已改变；请求保持 pending 且未写入 outcome', cause,
          )
        }
        throw cause
      }
    }

    const session = await authorityHost.requestApproval({
      runId: initial.runId, approvalType: request.payload.approvalType, subjectDigest,
      installationDigest: initial.runtimeInstallationDigest,
      ...(approvalBinding === undefined ? {} : { finalizationId: request.requestId, requestDigest }),
    })
    if (approvalMode === 'webauthn') await this.dependencies.presentUserPresenceUrl?.(session.url)
    await session.wait()
    const decisionArtifactType = request.payload.approvalType === 'scope'
      ? 'acceptance-scope' : request.payload.approvalType === 'lineage' ? 'prd-diff' : undefined
    if (decisionArtifactType !== undefined && initial.frozenArtifacts[decisionArtifactType] !== undefined) {
      if (session.finalizeDecision === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
      const decision = runtimeDecisionSubject(
        initial, request.payload.approvalType as 'scope' | 'lineage',
      )
      finalizedDecision = await session.finalizeDecision(decision)
    }
    let currentIdentity
    try { currentIdentity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader()) }
    catch (cause) {
      throw runtimeHostError(
        'E2E_RUNTIME_PROJECT_IDENTITY_CHANGED', 'safety',
        'WebAuthn callback 返回前项目身份已不可重新验证', cause,
      )
    }
    assertSameProjectIdentity(identity, currentIdentity)
    return await this.withRunLock(identity.digest, initial.runId, async (lock) => {
      assertSameProjectIdentity(
        identity,
        await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
      )
      const current = validateCurrent(await this.dependencies.runStore.getRun(identity.digest, initial.runId))
      if (request.payload.grantSubject !== undefined && session.finalize === undefined) {
        throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
      }
      const finalized = request.payload.grantSubject === undefined
        ? undefined : await session.finalize!(request.payload.grantSubject)
      assertSameProjectIdentity(
        identity,
        await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
      )
      return await persistFinalized(current, lock, session.sessionId, finalized)
    })
  }

  private async confirmApproval(
    request: Extract<RuntimeRequestEnvelope, { command: 'confirm-approval' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const claimed = await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const current = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (current === undefined) throw confirmationHostError('E2E_RUNTIME_RUN_NOT_FOUND')
      this.requireInstallation(current)
      const mode = approvalModeFromTrustedFacts(current.trustedExecutionFacts)
      const pending = current.trustedExecutionFacts['pending-local-approval']
      const webAuthnSemanticConfirmation = mode === 'webauthn'
        && typeof pending === 'object' && pending !== null
        && (pending as { approvalType?: unknown }).approvalType === 'execution'
        && typeof (pending as { summary?: unknown }).summary === 'object'
        && (pending as { summary?: { semanticReview?: unknown } }).summary?.semanticReview !== undefined
      if (mode !== 'local-confirmation' && !webAuthnSemanticConfirmation) {
        throw confirmationHostError('E2E_LOCAL_CONFIRMATION_MODE_MISMATCH')
      }
      const parsed = assertCurrentLocalApprovalConfirmation(
        current.trustedExecutionFacts['pending-local-approval'], {
          confirmationId: request.payload.confirmationId,
          subjectDigest: request.payload.subjectDigest,
          projectIdentityDigest: identity.digest,
          runtimeInstallationDigest: current.runtimeInstallationDigest,
          workflowState: current.workflow.current,
          now: this.dependencies.now(),
        },
      )
      const currentDigest = parsed.manualResult === undefined
        ? computeRuntimeApprovalSubjectDigest(current, parsed.approvalType, parsed.grantSubject)
        : localManualConfirmationSubjectDigest({
          runId: current.runId, ...parsed.manualResult, workflowState: current.workflow.current,
        })
      if (currentDigest !== parsed.subjectDigest) {
        throw confirmationHostError('E2E_RUNTIME_APPROVAL_SUBJECT_CHANGED')
      }
      return await this.dependencies.runStore.claimLocalApprovalConfirmation({
        projectIdentityDigest: identity.digest, runId: current.runId,
        confirmationId: parsed.confirmationId,
        requestId: request.requestId, requestDigest,
        claimedAt: this.dependencies.now().toISOString(), lock,
      })
    })
    if (claimed.manualResult !== undefined) {
      const synthetic = {
        ...request, command: 'finalize-manual-result-role' as const,
        payload: { runId: request.payload.runId, ...claimed.manualResult },
      } as Extract<RuntimeRequestEnvelope, { command: 'finalize-manual-result-role' }>
      return await this.finalizeManualResultRole(synthetic, requestDigest, true, claimed)
    }
    const synthetic = {
      ...request,
      command: 'open-approval' as const,
      payload: {
        runId: request.payload.runId,
        approvalType: claimed.approvalType,
        ...(claimed.grantSubject === undefined ? {} : { grantSubject: claimed.grantSubject }),
      },
    } as Extract<RuntimeRequestEnvelope, { command: 'open-approval' }>
    return await this.openApproval(synthetic, requestDigest, claimed)
  }

  private async prepareManualResult(
    request: Extract<RuntimeRequestEnvelope, { command: 'prepare-manual-result' }>,
    requestDigest: string,
    _requestWasPending: boolean,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    requireManualResultWorkflow(initial)
    const approvalMode = approvalModeFromTrustedFacts(initial.trustedExecutionFacts)
    const authorityHostFactory = approvalMode === 'local-confirmation'
      ? this.dependencies.localAuthorityHostFactory : this.dependencies.authorityHostFactory
    if (authorityHostFactory === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const authorityHost = await authorityHostFactory()
    if (authorityHost.prepareManualResult === undefined) {
      throw blockedError('E2E_MANUAL_RESULT_AUTHORITY_NOT_READY')
    }
    const draft = bindManualResultDraftToRuntimeSnapshot(initial, request.payload.draft, this.dependencies.now())
    const prepared = await authorityHost.prepareManualResult({ draft,
      finalizationId: request.requestId, requestDigest })
    assertSameProjectIdentity(
      identity,
      await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
    )
    return await this.withRunLock(identity.digest, initial.runId, async (lock) => {
      const current = await this.dependencies.runStore.getRun(identity.digest, initial.runId)
      if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(current)
      requireManualResultWorkflow(current)
      bindManualResultDraftToRuntimeSnapshot(current, draft, this.dependencies.now())
      const response = this.successResponse(request.requestId, {
        runId: current.runId,
        manualResultId: prepared.manualResultId,
        draftDigest: prepared.draftDigest,
        nextRole: prepared.nextRole,
      })
      try {
        return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.readRunOutcome(
          identity.digest, current.runId, request.requestId, requestDigest, () => response, lock,
        ))
      } catch (cause) {
        throw manualResultPersistenceError(cause)
      }
    })
  }

  private async finalizeManualResultRole(
    request: Extract<RuntimeRequestEnvelope, { command: 'finalize-manual-result-role' }>,
    requestDigest: string,
    requestWasPending: boolean,
    confirmed?: PendingLocalApprovalConfirmation,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    requireManualResultWorkflow(initial)
    const approvalMode = approvalModeFromTrustedFacts(initial.trustedExecutionFacts)
    const subjectDigest = localManualConfirmationSubjectDigest({
      runId: initial.runId, manualResultId: request.payload.manualResultId,
      draftDigest: request.payload.draftDigest, role: request.payload.role,
      workflowState: initial.workflow.current,
    })
    if (approvalMode === 'local-confirmation' && confirmed === undefined) {
      const projected = projectLocalApproval({
        snapshot: initial, approvalType: `manual-${request.payload.role}`,
        subjectDigest, expiresAt: new Date(this.dependencies.now().getTime() + 10 * 60_000).toISOString(),
      })
      if (projected.disposition.kind === 'blocked') {
        throw confirmationHostError(projected.disposition.reasonCode)
      }
      const confirmation = createPendingLocalApprovalConfirmation({
        approvalType: `manual-${request.payload.role}`, subjectDigest,
        projectIdentityDigest: identity.digest,
        runtimeInstallationDigest: initial.runtimeInstallationDigest,
        workflowState: initial.workflow.current, summary: projected.summary,
        manualResult: {
          manualResultId: request.payload.manualResultId,
          draftDigest: request.payload.draftDigest, role: request.payload.role,
        },
        now: this.dependencies.now(),
      })
      return await this.withRunLock(identity.digest, initial.runId, async (lock) =>
        RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
          identity.digest, initial.runId, request.requestId, requestDigest,
          (snapshot) => ({
            snapshot: { ...snapshot, trustedExecutionFacts: {
              ...snapshot.trustedExecutionFacts, 'pending-local-approval': confirmation,
            }, updatedAt: this.dependencies.now().toISOString() },
            response: this.successResponse(request.requestId, {
              status: 'confirmation-required', approvalMode: 'local-confirmation',
              confirmationId: confirmation.confirmationId, subjectDigest,
              expiresAt: confirmation.expiresAt, summary: confirmation.summary,
            }),
          }),
          'local-manual-confirmation-created', lock,
        )))
    }
    if (confirmed !== undefined) assertCurrentLocalApprovalConfirmation(confirmed, {
      confirmationId: confirmed.confirmationId, subjectDigest,
      projectIdentityDigest: identity.digest,
      runtimeInstallationDigest: initial.runtimeInstallationDigest,
      workflowState: initial.workflow.current, now: this.dependencies.now(),
    })
    const authorityHostFactory = approvalMode === 'local-confirmation'
      ? this.dependencies.localAuthorityHostFactory : this.dependencies.authorityHostFactory
    if (authorityHostFactory === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const authorityHost = await authorityHostFactory()
    if (authorityHost.requestManualResultRole === undefined
      && authorityHost.recoverManualResultRole === undefined) {
      throw blockedError('E2E_MANUAL_RESULT_AUTHORITY_NOT_READY')
    }
    const persist = async (finalized: {
      status: 'awaiting-reviewer'; manualResultId: string; draftDigest: string; nextRole: 'reviewer'
    } | { status: 'issued'; result: import('@mutil-skills/e2e-contracts').ManualResult }) => {
      assertSameProjectIdentity(
        identity,
        await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
      )
      return await this.withRunLock(identity.digest, initial.runId, async (lock) => {
        const current = await this.dependencies.runStore.getRun(identity.digest, initial.runId)
        if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
        this.requireInstallation(current)
        requireManualResultWorkflow(current)
        const response = this.successResponse(request.requestId, {
          runId: current.runId, manualResultId: request.payload.manualResultId,
          role: request.payload.role, approvalMode, ...finalized,
        })
        if (finalized.status === 'awaiting-reviewer') {
          try {
            return RuntimeResponseEnvelopeSchema.parse(confirmed === undefined
              ? await this.dependencies.runStore.readRunOutcome(
                identity.digest, current.runId, request.requestId, requestDigest, () => response, lock,
              )
              : await this.dependencies.runStore.updateRunOutcome(
                identity.digest, current.runId, request.requestId, requestDigest,
                (snapshot) => ({ snapshot: clearLocalConfirmation(snapshot, confirmed), response }),
                'manual-result-role-confirmed', lock,
              ))
          } catch (cause) {
            throw manualResultPersistenceError(cause)
          }
        }
        try {
          const capability = await this.dependencies.runStore.authorizeTrustedFactWrite(
            identity.digest, current.runId, lock,
          )
          const persisted = RuntimeResponseEnvelopeSchema.parse(
            await this.dependencies.runStore.appendTrustedManualResultOutcome({
              capability, requestId: request.requestId, requestDigest,
              result: finalized.result, response,
              update: (snapshot) => clearLocalConfirmation(snapshot, confirmed),
            }),
          )
          return persisted
        } catch (cause) {
          throw manualResultPersistenceError(cause)
        }
      })
    }
    if (authorityHost.recoverManualResultRole !== undefined) {
      const recovered = await authorityHost.recoverManualResultRole({
        manualResultId: request.payload.manualResultId,
        draftDigest: request.payload.draftDigest, role: request.payload.role,
        finalizationId: request.requestId, requestDigest,
        installationDigest: initial.runtimeInstallationDigest,
      })
      if (recovered !== undefined) return await persist(recovered)
    }
    // ledger 已精确绑定同一 requestDigest；Authority 无完成记录表示崩溃发生在角色签署前，
    // 可以重新打开一次用户在场会话，但绝不能伪造已完成结果。
    void requestWasPending
    if (authorityHost.requestManualResultRole === undefined) {
      throw blockedError('E2E_MANUAL_RESULT_AUTHORITY_NOT_READY')
    }
    const session = await authorityHost.requestManualResultRole({
      runId: initial.runId,
      manualResultId: request.payload.manualResultId,
      draftDigest: request.payload.draftDigest,
      role: request.payload.role,
      installationDigest: initial.runtimeInstallationDigest,
      finalizationId: request.requestId,
      requestDigest,
    })
    if (approvalMode === 'webauthn') await this.dependencies.presentUserPresenceUrl?.(session.url)
    await session.wait()
    if (session.finalizeManualResultRole === undefined) {
      throw blockedError('E2E_MANUAL_RESULT_AUTHORITY_NOT_READY')
    }
    assertSameProjectIdentity(
      identity,
      await resolveProjectIdentity(request.projectRoot, this.projectFileReader()),
    )
    const finalized = await session.finalizeManualResultRole!()
    return await persist(finalized)
  }

  private async runPreflight(
    request: Extract<RuntimeRequestEnvelope, { command: 'run-preflight' }>,
    requestDigest: string,
    _requestWasPending: boolean,
  ): Promise<RuntimeResponseEnvelope> {
    const executor = this.dependencies.preflightExecutor
    if (executor === undefined) throw blockedError('E2E_RUNTIME_PREFLIGHT_EXECUTOR_NOT_READY')
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    let initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    assertTargetReady(initial)
    assertAcceptanceReviewConfirmed(initial)
    const isRetry = initial.workflow.current === 'preflight-readonly'
      && initial.preflightBlocker !== undefined
      && initial.trustedExecutionFacts['browser-preflight'] === undefined
    if (initial.workflow.current !== 'discovery-approved' && !isRetry) throw runtimeHostError(
      'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH', 'input',
      'run-preflight 仅允许 discovery-approved 或带可恢复阻断的 preflight-readonly Run',
    )
    let durablePreparation = initial.preflightAttempt !== undefined
    let result: Awaited<ReturnType<typeof finalizeRuntimePreflight>>
    if (initial.preflightAttempt !== undefined) {
      if (initial.preflightAttempt.requestId !== request.requestId
        || initial.preflightAttempt.requestDigest !== requestDigest) throw runtimeHostError(
        'E2E_RUNTIME_PREFLIGHT_ATTEMPT_MISMATCH', 'safety',
        '持久 preflight preparation 不属于当前请求，拒绝恢复',
      )
      const preparation = RuntimePreflightPreparationSchema.parse(initial.preflightAttempt.preparation)
      try {
        result = await finalizeRuntimePreflight(executor, initial, preparation)
      } catch (cause) {
        throw runtimeHostError(
          'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED', 'safety',
          '持久 preflight preparation 尚未完成；请用相同请求重试恢复', cause,
        )
      }
    } else {
      const prepared = await prepareRuntimePreflight(executor, initial, runtimePreflightAttemptId({
        runId: initial.runId, requestId: request.requestId, requestDigest,
      }))
      if (prepared.kind === 'completed') {
        result = prepared.result
      } else {
        try {
          initial = await this.withRunLock(identity.digest, initial.runId, async (lock) =>
            await this.dependencies.runStore.recordPreflightPreparation({
              projectIdentityDigest: identity.digest,
              runId: initial.runId,
              requestId: request.requestId,
              requestDigest,
              startedAt: this.dependencies.now().toISOString(),
              preparation: prepared.preparation,
              expectedRevision: initial.runRevision ?? 0,
              expectedWorkflowDigest: initial.workflow.eventChainDigest,
              lock,
            }))
        } catch (cause) {
          throw runtimeHostError(
            'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED', 'safety',
            'Discovery reservation 可能已创建但 preparation 尚未落盘；请用相同请求恢复', cause,
          )
        }
        durablePreparation = true
        try {
          result = await finalizeRuntimePreflight(executor, initial, prepared.preparation)
        } catch (cause) {
          throw runtimeHostError(
            'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED', 'safety',
            'preflight preparation 已持久化但 Authority 尚未完成；请用相同请求重试恢复', cause,
          )
        }
      }
    }

    try {
      return await this.withRunLock(identity.digest, initial.runId, async (lock) => {
        const current = await this.dependencies.runStore.getRun(identity.digest, initial.runId)
        if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
        if (durablePreparation) {
          if (current.preflightAttempt?.requestId !== request.requestId
            || current.preflightAttempt.requestDigest !== requestDigest
            || current.preflightAttempt.revision !== current.runRevision) throw runtimeHostError(
            'E2E_RUNTIME_PREFLIGHT_FENCED', 'safety', '持久 preflight preparation 已改变，拒绝落入陈旧结果',
          )
        } else if ((current.runRevision ?? 0) !== (initial.runRevision ?? 0)
          || current.workflow.eventChainDigest !== initial.workflow.eventChainDigest) throw runtimeHostError(
          'E2E_RUNTIME_PREFLIGHT_FENCED', 'safety', '预检期间 Run revision 已改变，拒绝落入陈旧结果',
        )
        const timestamp = this.dependencies.now().toISOString()
        const entered = current.workflow.current === 'discovery-approved'
          ? transitionWorkflow({
            state: current.workflow, next: 'preflight-readonly',
            reason: `browser preflight ${result.output.status}`,
            timestamp,
            engineVersion: this.dependencies.installation.version,
          }).state
          : current.workflow
        const recoverableBlocker = result.output.status === 'input-blocked'
          || result.output.status === 'environment-blocked'
          ? {
            status: result.output.status,
            reasonCode: result.output.reasonCode!,
            blockedAt: timestamp,
            attemptCount: (current.preflightBlocker?.attemptCount ?? 0) + 1,
            resumeState: 'preflight-readonly' as const,
          }
          : undefined
        const finalWorkflow = result.output.status === 'safety-blocked' ? transitionWorkflow({
          state: entered,
          next: 'safety-blocked',
          reason: result.output.reasonCode ?? 'browser preflight blocked',
          timestamp,
          engineVersion: this.dependencies.installation.version,
        }).state : entered
        const response = this.successResponse(request.requestId, {
          runId: current.runId, status: result.output.status,
          ...(result.output.reasonCode === undefined ? {} : { reasonCode: result.output.reasonCode }),
          workflow: finalWorkflow,
          ...(result.fact === undefined ? {} : { preflightFact: result.fact }),
        })
        if (result.fact !== undefined) {
          const capability = await this.dependencies.runStore.authorizeTrustedFactWrite(
            identity.digest, current.runId, lock,
          )
          return RuntimeResponseEnvelopeSchema.parse(
            await this.dependencies.runStore.writeTrustedFactOutcome({
              capability, requestId: request.requestId, requestDigest,
              factType: 'browser-preflight', fact: result.fact, response,
              update: (snapshot) => {
                const {
                  preflightAttempt: _completedPreflight,
                  preflightBlocker: _completedBlocker,
                  ...withoutPreflight
                } = snapshot
                return {
                  ...withoutPreflight, workflow: finalWorkflow,
                  updatedAt: timestamp,
                }
              },
            }),
          )
        }
        return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
          identity.digest, current.runId, request.requestId, requestDigest,
          (snapshot) => {
            const {
              preflightAttempt: _completedPreflight,
              preflightBlocker: _previousBlocker,
              ...withoutPreflight
            } = snapshot
            return {
              snapshot: {
                ...withoutPreflight, runRevision: (snapshot.runRevision ?? 0) + 1,
                workflow: finalWorkflow,
                ...(recoverableBlocker === undefined ? {} : { preflightBlocker: recoverableBlocker }),
                updatedAt: timestamp,
              },
              response,
            }
          },
          'trusted-browser-preflight-blocked', lock,
        ))
      })
    } catch (cause) {
      if (!durablePreparation) throw cause
      throw runtimeHostError(
        'E2E_RUNTIME_PREFLIGHT_RECOVERY_REQUIRED', 'safety',
        'Authority preflight 已完成但可信事实尚未原子落盘；请用相同请求恢复', cause,
      )
    }
  }

  private async executeRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'execute-run' }>,
    requestDigest: string,
    requestWasPending: boolean,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const preview = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
    if (preview !== undefined && preview.workflow.current === 'compiled'
      && runtimeUsesFullPlaywright(preview)
      && (preview.caseSchedule?.cases.length ?? 0) > 1) {
      return await this.executeMultiCaseFullPlaywrightRun(
        request,
        requestDigest,
        requestWasPending,
        identity.digest,
      )
    }
    const startLock = await this.dependencies.runStore.acquireRunLock(identity.digest, request.payload.runId)
    let started: Awaited<ReturnType<RuntimeRunStore['beginExecutionAttempt']>> | undefined
    let executionMode: 'read' | 'write' | 'injection' | 'full-playwright' | undefined
    let startError: unknown
    try {
      const current = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(current)
      if (requestWasPending && current.workflow.current === 'running-real'
        && current.executionAttempt?.requestId === request.requestId) throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED', 'safety',
        '原 execute-run 已持久化 running attempt；必须显式 resume-run reconcile，禁止自动重放',
      )
      if (requestWasPending && (current.workflow.current !== 'compiled'
        || current.executionAttempt !== undefined)) throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_PENDING_STATE_INVALID', 'safety',
        'pending execute-run 与 Run workflow/attempt 不闭合，Runtime 拒绝推测或重放',
      )
      if (current.workflow.current !== 'compiled') throw runtimeHostError(
        'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH', 'input', 'execute-run 仅允许 compiled Run',
      )
      executionMode = runtimeExecutionMode(current)
      if (executionMode === 'read') {
        if (this.dependencies.readExecutor === undefined) throw blockedError('E2E_RUNTIME_READ_EXECUTOR_NOT_READY')
        assertRuntimeReadSnapshotReady(current)
      } else if (executionMode === 'write') {
        if (this.dependencies.writeExecutor === undefined) throw blockedError('E2E_RUNTIME_WRITE_EXECUTOR_NOT_READY')
      } else if (executionMode === 'full-playwright') {
        if (this.dependencies.fullPlaywrightExecutor === undefined) {
          throw blockedError('E2E_RUNTIME_FULL_PLAYWRIGHT_EXECUTOR_NOT_READY')
        }
      } else if (this.dependencies.injectionExecutor === undefined) {
        throw blockedError('E2E_RUNTIME_INJECTION_EXECUTOR_NOT_READY')
      } else {
        const { caseId } = runtimeSingleActionBinding(current)
        const hasPassedRealCase = Object.values(current.executionResults?.realEnvironment ?? {})
          .some((result) => result.caseId === caseId && result.status === 'passed')
        if (!hasPassedRealCase) {
          throw runtimeHostError('E2E_RUNTIME_INJECTION_REAL_RESULT_REQUIRED', 'safety',
            '同一 Case 尚无已持久化的真实环境 passed 结果，禁止执行故障注入')
        }
      }
      started = await this.dependencies.runStore.beginExecutionAttempt({
        projectIdentityDigest: identity.digest, runId: current.runId,
        requestId: request.requestId, requestDigest,
        startedAt: this.dependencies.now().toISOString(), lock: startLock,
        toRunning: (snapshot) => ({
          ...snapshot,
          workflow: transitionWorkflow({
            state: snapshot.workflow, next: 'running-real', reason: `trusted ${executionMode} execution started`,
            timestamp: this.dependencies.now().toISOString(),
            engineVersion: this.dependencies.installation.version,
          }).state,
          updatedAt: this.dependencies.now().toISOString(),
        }),
      })
    } catch (error) { startError = error }
    let releaseError: unknown
    try { await startLock.close() } catch (error) { releaseError = error }
    if (startError !== undefined) {
      if (releaseError !== undefined) throw new AggregateError([startError, releaseError])
      throw startError
    }
    if (started === undefined) throw runtimeHostError(
      'E2E_RUNTIME_EXECUTION_START_MISSING', 'internal', 'execution attempt 启动结果缺失',
    )
    if (releaseError !== undefined) {
      let ownerReleaseError: unknown
      try { await started.owner.release() } catch (error) { ownerReleaseError = error }
      throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED', 'safety',
        'execution attempt 已持久化，但 mutation lease 释放失败；必须显式 resume-run reconcile',
        ownerReleaseError === undefined ? releaseError : new AggregateError([releaseError, ownerReleaseError]),
      )
    }

    if (executionMode === undefined) throw runtimeHostError(
      'E2E_RUNTIME_EXECUTION_MODE_MISSING', 'internal', 'execution mode 未闭合持久 attempt',
    )
    if (executionMode === 'write' || executionMode === 'full-playwright') {
      const binding = runtimeWriteAttemptBinding(started.snapshot)
      try {
        const lock = await this.dependencies.runStore.acquireRunLock(identity.digest, request.payload.runId)
        try {
          await this.dependencies.runStore.prepareWriteAttempt({
            projectIdentityDigest: identity.digest,
            runId: started.snapshot.runId,
            requestId: request.requestId,
            requestDigest,
            attemptId: started.attempt.attemptId,
            actionId: binding.actionId,
            lease: binding.lease,
            executionFencingToken: started.attempt.fencingToken,
            ownerMarker: createRuntimeOwnedResourceMarker({
              runtimeInstallationDigest: started.snapshot.runtimeInstallationDigest,
              projectIdentityDigest: identity.digest,
              runId: started.snapshot.runId,
              attemptId: started.attempt.attemptId,
              ownerNonce: `OWNER-${randomUUID()}`,
            }),
            preparedAt: this.dependencies.now().toISOString(),
            lock,
          })
          const prepared = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
          if (prepared === undefined) throw runtimeHostError(
            'E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'WriteAttempt 准备后 Run 不存在',
          )
          started = { ...started, snapshot: prepared }
        } finally { await lock.close() }
      } catch (cause) {
        let releaseCause: unknown
        try { await started.owner.release() } catch (error) { releaseCause = error }
        throw runtimeHostError(
          'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED', 'safety',
          '写副作用前 WriteAttempt 未能持久闭合；禁止开始 Browser/Gateway 执行',
          releaseCause === undefined ? cause : new AggregateError([cause, releaseCause]),
        )
      }
    }
    let execution: Awaited<ReturnType<typeof executeRuntimeRead>>
      | Awaited<ReturnType<typeof executeRuntimeWrite>>
      | Awaited<ReturnType<typeof executeRuntimeFullPlaywright>>
      | Awaited<ReturnType<typeof executeRuntimeInjection>>
    try {
      execution = await executeWithOwnerHeartbeat(started.owner, async () => executionMode === 'read'
        ? await executeRuntimeRead(this.dependencies.readExecutor!, {
          snapshot: started!.snapshot, attemptId: started!.attempt.attemptId,
        })
        : executionMode === 'write'
          ? await executeRuntimeWrite(this.dependencies.writeExecutor!, {
            snapshot: started!.snapshot, attemptId: started!.attempt.attemptId,
          })
          : executionMode === 'full-playwright'
            ? await executeRuntimeFullPlaywright(this.dependencies.fullPlaywrightExecutor!, {
              snapshot: started!.snapshot, attemptId: started!.attempt.attemptId,
            })
          : await executeRuntimeInjection(this.dependencies.injectionExecutor!, {
            snapshot: started!.snapshot, attemptId: started!.attempt.attemptId,
          }))
    } catch (cause) {
      let releaseCause: unknown
      try { await started.owner.release() } catch (error) { releaseCause = error }
      const causeCode = safeExecutionCauseCode(cause)
      throw runtimeHostError(
        executionMode === 'read' ? 'E2E_RUNTIME_READ_EXECUTION_CRASHED' : 'E2E_RUNTIME_EXECUTION_CRASHED', 'safety',
        `可信执行器异常退出；Run 保持 running-real fenced attempt 等待显式恢复${
          causeCode === undefined ? '' : `；内部错误码 ${causeCode}`}`,
        releaseCause === undefined ? cause : new AggregateError([cause, releaseCause]),
      )
    }
    if (executionMode === 'write' || executionMode === 'full-playwright') {
      const write = execution as Awaited<ReturnType<typeof executeRuntimeWrite>>
      try {
        const lock = await this.dependencies.runStore.acquireRunLock(identity.digest, request.payload.runId)
        try {
          let record = await this.dependencies.runStore.getWriteAttempt(
            identity.digest, started.snapshot.runId, started.attempt.attemptId,
          )
          if (record === undefined) throw runtimeHostError(
            'E2E_RUNTIME_WRITE_ATTEMPT_NOT_FOUND', 'safety', 'Write executor 返回后缺少持久 attempt',
          )
          if (record.state === 'prepared') record = await this.dependencies.runStore.observeWriteReservation({
            projectIdentityDigest: identity.digest, runId: started.snapshot.runId,
            attemptId: started.attempt.attemptId,
            reservationId: write.gatewayCommit.reservationId,
            observedAt: this.dependencies.now().toISOString(),
            expectedRecordDigest: record.recordDigest,
            lock,
          })
          if (record.state === 'reservation-observed') record = await this.dependencies.runStore.prepareWriteOutcome({
            projectIdentityDigest: identity.digest, runId: started.snapshot.runId,
            attemptId: started.attempt.attemptId,
            outcomeDigest: write.gatewayCommit.outcomeReceiptDigest,
            receiptDigest: write.gatewayCommit.reservationReceiptDigest,
            preparedAt: this.dependencies.now().toISOString(),
            lock,
          })
          if (record.state === 'outcome-prepared') await this.dependencies.runStore.commitWriteOutcome({
            projectIdentityDigest: identity.digest, runId: started.snapshot.runId,
            attemptId: started.attempt.attemptId,
            outcomeDigest: write.gatewayCommit.outcomeReceiptDigest,
            receiptDigest: write.gatewayCommit.reservationReceiptDigest,
            committedAt: this.dependencies.now().toISOString(),
            expectedRecordDigest: record.recordDigest,
            lock,
          })
        } finally { await lock.close() }
      } catch (cause) {
        let releaseCause: unknown
        try { await started.owner.release() } catch (error) { releaseCause = error }
        throw runtimeHostError(
          'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED', 'safety',
          'Authority write outcome 已返回但 Run Store 尚未闭合；必须显式恢复且禁止重试写动作',
          releaseCause === undefined ? cause : new AggregateError([cause, releaseCause]),
        )
      }
    }
    let quarantinedEvidence: RuntimeQuarantinedEvidenceFacts | undefined
    const ephemeralEvidence = executionMode === 'read'
      ? (execution as RuntimeReadExecutionOutput).evidence
      : executionMode === 'write' || executionMode === 'full-playwright'
        ? (execution as Awaited<ReturnType<typeof executeRuntimeWrite>>).evidence
        : (execution as Awaited<ReturnType<typeof executeRuntimeInjection>>).evidence
    if (ephemeralEvidence !== undefined && this.dependencies.evidenceQuarantine === undefined) {
      ephemeralEvidence.screenshot.fill(0)
      ephemeralEvidence.dom.fill(0)
      let releaseCause: unknown
      try { await started.owner.release() } catch (error) { releaseCause = error }
      throw runtimeHostError(
        'E2E_RUNTIME_EVIDENCE_QUARANTINE_NOT_READY', 'safety',
        '执行产生了原始证据，但 Runtime 未装配 Git 外加密 Quarantine；拒绝持久化执行完成',
        releaseCause,
      )
    }
    if (ephemeralEvidence !== undefined) {
      try {
        quarantinedEvidence = await quarantineRuntimeEvidence(this.dependencies.evidenceQuarantine!, {
          runId: started.snapshot.runId,
          attemptId: started.attempt.attemptId,
          evidence: ephemeralEvidence,
        })
      } catch (cause) {
        let releaseCause: unknown
        try { await started.owner.release() } catch (error) { releaseCause = error }
        throw runtimeHostError(
          'E2E_RUNTIME_EVIDENCE_QUARANTINE_FAILED', 'safety',
          '原始证据未能先写入 Git 外加密 Quarantine；拒绝持久化执行完成',
          releaseCause === undefined ? cause : new AggregateError([cause, releaseCause]),
        )
      } finally {
        ephemeralEvidence.screenshot.fill(0)
        ephemeralEvidence.dom.fill(0)
      }
    }
    const next = execution.status === 'environment-blocked' ? 'environment-blocked'
      : execution.status === 'safety-blocked' ? 'safety-blocked' : 'diagnosing'
    const finalWorkflow = transitionWorkflow({
      state: started.snapshot.workflow, next,
      reason: `trusted ${executionMode} execution ${execution.status}`,
      timestamp: this.dependencies.now().toISOString(),
      engineVersion: this.dependencies.installation.version,
    }).state
    const readExecution = executionMode === 'read' ? execution as RuntimeReadExecutionOutput : undefined
    const writeExecution = executionMode === 'write' || executionMode === 'full-playwright'
      ? execution as Awaited<ReturnType<typeof executeRuntimeWrite>> : undefined
    const persistedWriteExecution = writeExecution === undefined ? undefined
      : omitEphemeralWriteEvidence(writeExecution)
    const injectionExecution = executionMode === 'injection'
      ? execution as Awaited<ReturnType<typeof executeRuntimeInjection>> : undefined
    const persistedInjectionExecution = injectionExecution === undefined ? undefined
      : omitEphemeralInjectionEvidence(injectionExecution)
    const response = this.successResponse(request.requestId, readExecution !== undefined ? {
      runId: started.snapshot.runId, status: readExecution.status, result: readExecution.result,
      gatewayAudit: readExecution.gatewayAudit, gatewayAuditDigest: readExecution.gatewayAuditDigest,
      ...(readExecution.evidence === undefined ? {} : {
        evidence: {
          screenshot: {
            byteLength: readExecution.evidence.screenshot.byteLength,
            digest: digestBytes('runtime-evidence/screenshot/v1', readExecution.evidence.screenshot),
          },
          dom: {
            byteLength: readExecution.evidence.dom.byteLength,
            digest: digestBytes('runtime-evidence/dom-bytes/v1', readExecution.evidence.dom),
          },
        },
      }),
      loadedGeneratedSourceFiles: [], workflow: finalWorkflow,
    } : {
      runId: started.snapshot.runId, status: execution.status,
      result: persistedWriteExecution ?? persistedInjectionExecution ?? execution,
      loadedGeneratedSourceFiles: [], workflow: finalWorkflow,
    })
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) =>
      RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.completeExecutionAttempt({
        projectIdentityDigest: identity.digest, runId: started.snapshot.runId,
        requestId: request.requestId, requestDigest, attempt: started.attempt, owner: started.owner,
        response, lock,
        complete: (snapshot) => ({
          ...snapshot,
          ...((quarantinedEvidence !== undefined || readExecution?.finalizationFacts !== undefined
            || writeExecution?.finalizationFacts !== undefined
            || injectionExecution?.finalizationFacts !== undefined) ? {
            trustedExecutionFacts: {
              ...snapshot.trustedExecutionFacts,
              ...(injectionExecution !== undefined && quarantinedEvidence !== undefined ? {
                'quarantined-evidence': mergeDomainTrustedFact(
                  snapshot, 'quarantined-evidence', 'gatewayInjection',
                  injectionExecution.resultId, quarantinedEvidence,
                ),
              } : quarantinedEvidence === undefined ? {} : {
                'quarantined-evidence': quarantinedEvidence,
              }),
              ...(persistedWriteExecution?.finalizationFacts === undefined ? {} : {
                'finalization-execution-facts': persistedWriteExecution.finalizationFacts,
              }),
              ...(readExecution?.finalizationFacts === undefined ? {} : {
                'finalization-execution-facts': readExecution.finalizationFacts,
              }),
              ...(persistedInjectionExecution?.finalizationFacts === undefined ? {} : {
                'finalization-execution-facts': mergeDomainTrustedFact(
                  snapshot, 'finalization-execution-facts', 'gatewayInjection',
                  persistedInjectionExecution.resultId,
                  persistedInjectionExecution.finalizationFacts,
                ),
              }),
            },
          } : {}),
          ...(readExecution !== undefined ? { executionResults: {
            readEnvironment: { ...(snapshot.executionResults?.readEnvironment ?? {}),
              [readExecution.result.actionId]: {
                attemptId: started.attempt.attemptId,
                caseId: readExecution.result.caseId,
                actionId: readExecution.result.actionId,
                status: readExecution.status,
                result: readExecution.result,
                gatewayAudit: readExecution.gatewayAudit,
                gatewayAuditDigest: readExecution.gatewayAuditDigest,
              } },
            realEnvironment: { ...(snapshot.executionResults?.realEnvironment ?? {}) },
            gatewayInjection: { ...(snapshot.executionResults?.gatewayInjection ?? {}) },
          } } : persistedWriteExecution !== undefined ? { executionResults: {
            readEnvironment: { ...(snapshot.executionResults?.readEnvironment ?? {}) },
            realEnvironment: { ...(snapshot.executionResults?.realEnvironment ?? {}),
              [persistedWriteExecution.actionId]: persistedWriteExecution },
            gatewayInjection: { ...(snapshot.executionResults?.gatewayInjection ?? {}) },
          } } : persistedInjectionExecution !== undefined ? { executionResults: {
            readEnvironment: { ...(snapshot.executionResults?.readEnvironment ?? {}) },
            realEnvironment: { ...(snapshot.executionResults?.realEnvironment ?? {}) },
            gatewayInjection: { ...(snapshot.executionResults?.gatewayInjection ?? {}),
              [persistedInjectionExecution.actionId]: persistedInjectionExecution },
          } } : {}),
          workflow: finalWorkflow, updatedAt: this.dependencies.now().toISOString(),
        }),
      })))
  }

  private async executeMultiCaseFullPlaywrightRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'execute-run' | 'resume-run' }>,
    requestDigest: string,
    requestWasPending: boolean,
    projectIdentityDigest: string,
    resumeAttemptId?: string,
  ): Promise<RuntimeResponseEnvelope> {
    if (this.dependencies.fullPlaywrightExecutor === undefined) {
      throw blockedError('E2E_RUNTIME_FULL_PLAYWRIGHT_EXECUTOR_NOT_READY')
    }
    const startLock = await this.dependencies.runStore.acquireRunLock(
      projectIdentityDigest,
      request.payload.runId,
    )
    let started: Awaited<ReturnType<RuntimeRunStore['beginExecutionAttempt']>> | undefined
    try {
      const current = await this.dependencies.runStore.getRun(
        projectIdentityDigest,
        request.payload.runId,
      )
      if (current === undefined) throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      this.requireInstallation(current)
      if (resumeAttemptId !== undefined) {
        const scheduleCase = current.caseSchedule?.cases.find((item) =>
          item.state === 'running' && item.attemptId === resumeAttemptId)
        if (current.workflow.current !== 'running-real'
          || current.executionAttempt === undefined
          || scheduleCase === undefined
          || current.caseSchedule?.currentCaseId !== scheduleCase.caseId) {
          throw runtimeHostError(
            'E2E_RUNTIME_CASE_SCHEDULE_RECOVERY_MISMATCH',
            'safety',
            'resume-run 未绑定当前 running Case 与 execution attempt',
          )
        }
        started = await this.dependencies.runStore.resumeExecutionAttempt({
          projectIdentityDigest,
          runId: current.runId,
          expectedAttemptId: current.executionAttempt.attemptId,
          lock: startLock,
        })
      } else if (requestWasPending && current.workflow.current === 'running-real'
        && current.executionAttempt?.requestId === request.requestId) throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED',
        'safety',
        '多 Case execute-run 已持久化 running attempt；必须显式 resume-run，禁止重放',
      )
      if (resumeAttemptId === undefined && (current.workflow.current !== 'compiled'
        || current.caseSchedule === undefined
        || current.compiledPrdRun === undefined)) throw runtimeHostError(
        'E2E_RUNTIME_CASE_SCHEDULE_NOT_READY',
        'artifact',
        '多 Case 执行需要 Runtime 编译计划和持久 schedule',
      )
      if (resumeAttemptId === undefined) started = await this.dependencies.runStore.beginExecutionAttempt({
        projectIdentityDigest,
        runId: current.runId,
        requestId: request.requestId,
        requestDigest,
        startedAt: this.dependencies.now().toISOString(),
        lock: startLock,
        toRunning: (snapshot) => ({
          ...snapshot,
          workflow: transitionWorkflow({
            state: snapshot.workflow,
            next: 'running-real',
            reason: 'trusted multi-case full-playwright execution started',
            timestamp: this.dependencies.now().toISOString(),
            engineVersion: this.dependencies.installation.version,
          }).state,
          updatedAt: this.dependencies.now().toISOString(),
        }),
      })
    } finally {
      await startLock.close()
    }
    if (started === undefined) throw runtimeHostError(
      'E2E_RUNTIME_EXECUTION_START_MISSING',
      'internal',
      '多 Case execution attempt 启动结果缺失',
    )
    const executionRequestId = started.attempt.requestId
    const executionRequestDigest = started.attempt.requestDigest
    if (executionRequestDigest === undefined) throw runtimeHostError(
      'E2E_RUNTIME_EXECUTION_REQUEST_DIGEST_MISSING',
      'safety',
      '旧 execution attempt 缺少 requestDigest，不能自动恢复多 Case',
    )
    const attemptIds = started.snapshot.caseSchedule!.cases.map((item) =>
      item.attemptId ?? `ATTEMPT-${randomUUID()}`)
    let result: Awaited<ReturnType<typeof executeScheduledRuntimeFullPlaywrightCases>>
    try {
      result = await executeWithOwnerHeartbeat(started.owner, async () =>
        await executeScheduledRuntimeFullPlaywrightCases(
          this.dependencies.fullPlaywrightExecutor!,
          {
            snapshot: started!.snapshot,
            schedule: started!.snapshot.caseSchedule!,
            attemptIds,
            ...(resumeAttemptId === undefined ? {} : { resumeAttemptId }),
            now: () => this.dependencies.now().toISOString(),
            persistSchedule: async (schedule) => {
              const lock = await this.dependencies.runStore.acquireRunLock(
                projectIdentityDigest,
                request.payload.runId,
              )
              try {
                await this.dependencies.runStore.checkpointCaseSchedule({
                  projectIdentityDigest,
                  runId: request.payload.runId,
                  attempt: started!.attempt,
                  owner: started!.owner,
                  schedule,
                  eventKind: 'multi-case-started',
                  updatedAt: this.dependencies.now().toISOString(),
                  lock,
                })
              } finally {
                await lock.close()
              }
            },
            prepareCase: async ({ projection, attemptId }) => {
              const lock = await this.dependencies.runStore.acquireRunLock(
                projectIdentityDigest,
                request.payload.runId,
              )
              try {
                await this.dependencies.runStore.prepareWriteAttempt({
                  projectIdentityDigest,
                  runId: request.payload.runId,
                  requestId: executionRequestId,
                  requestDigest: executionRequestDigest,
                  attemptId,
                  actionId: projection.actionId,
                  lease: {
                    leaseId: projection.capability.dataLeaseId,
                    fencingToken: projection.capability.fencingToken,
                    targetFingerprintDigest: projection.targetFingerprint,
                  },
                  executionFencingToken: started!.attempt.fencingToken,
                  ownerMarker: createRuntimeOwnedResourceMarker({
                    runtimeInstallationDigest: started!.snapshot.runtimeInstallationDigest,
                    projectIdentityDigest,
                    runId: request.payload.runId,
                    attemptId,
                    ownerNonce: `OWNER-${randomUUID()}`,
                  }),
                  preparedAt: this.dependencies.now().toISOString(),
                  lock,
                })
                const snapshot = await this.dependencies.runStore.getRun(
                  projectIdentityDigest,
                  request.payload.runId,
                )
                if (snapshot === undefined) throw runtimeHostError(
                  'E2E_RUNTIME_RUN_NOT_FOUND',
                  'input',
                  'Case WriteAttempt 准备后 Run 不存在',
                )
                return snapshot
              } finally {
                await lock.close()
              }
            },
            completeCase: async ({ schedule, attemptId, output }) => {
              const persistedOutput = omitEphemeralWriteEvidence(output)
              let quarantined: RuntimeQuarantinedEvidenceFacts | undefined
              if (output.evidence !== undefined) {
                if (this.dependencies.evidenceQuarantine === undefined) {
                  throw blockedError('E2E_RUNTIME_EVIDENCE_QUARANTINE_NOT_READY')
                }
                try {
                  quarantined = await quarantineRuntimeEvidence(
                    this.dependencies.evidenceQuarantine,
                    {
                      runId: request.payload.runId,
                      attemptId,
                      evidence: output.evidence,
                    },
                  )
                } finally {
                  output.evidence.screenshot.fill(0)
                  output.evidence.dom.fill(0)
                }
              }
              const lock = await this.dependencies.runStore.acquireRunLock(
                projectIdentityDigest,
                request.payload.runId,
              )
              try {
                let record = await this.dependencies.runStore.getWriteAttempt(
                  projectIdentityDigest,
                  request.payload.runId,
                  attemptId,
                )
                if (record === undefined) throw runtimeHostError(
                  'E2E_RUNTIME_WRITE_ATTEMPT_NOT_FOUND',
                  'safety',
                  '多 Case executor 返回后缺少持久 WriteAttempt',
                )
                if (record.state === 'prepared') {
                  record = await this.dependencies.runStore.observeWriteReservation({
                    projectIdentityDigest,
                    runId: request.payload.runId,
                    attemptId,
                    reservationId: output.gatewayCommit.reservationId,
                    observedAt: this.dependencies.now().toISOString(),
                    expectedRecordDigest: record.recordDigest,
                    lock,
                  })
                }
                if (record.state === 'reservation-observed') {
                  record = await this.dependencies.runStore.prepareWriteOutcome({
                    projectIdentityDigest,
                    runId: request.payload.runId,
                    attemptId,
                    outcomeDigest: output.gatewayCommit.outcomeReceiptDigest,
                    receiptDigest: output.gatewayCommit.reservationReceiptDigest,
                    preparedAt: this.dependencies.now().toISOString(),
                    lock,
                  })
                }
                if (record.state === 'outcome-prepared') {
                  await this.dependencies.runStore.commitWriteOutcome({
                    projectIdentityDigest,
                    runId: request.payload.runId,
                    attemptId,
                    outcomeDigest: output.gatewayCommit.outcomeReceiptDigest,
                    receiptDigest: output.gatewayCommit.reservationReceiptDigest,
                    committedAt: this.dependencies.now().toISOString(),
                    expectedRecordDigest: record.recordDigest,
                    lock,
                  })
                }
                await this.dependencies.runStore.checkpointCaseSchedule({
                  projectIdentityDigest,
                  runId: request.payload.runId,
                  attempt: started!.attempt,
                  owner: started!.owner,
                  schedule,
                  eventKind: 'multi-case-completed',
                  updatedAt: this.dependencies.now().toISOString(),
                  update: (snapshot) => ({
                    ...snapshot,
                    executionResults: {
                      readEnvironment: { ...(snapshot.executionResults?.readEnvironment ?? {}) },
                      realEnvironment: {
                        ...(snapshot.executionResults?.realEnvironment ?? {}),
                        [persistedOutput.actionId]: persistedOutput,
                      },
                      gatewayInjection: { ...(snapshot.executionResults?.gatewayInjection ?? {}) },
                    },
                    trustedExecutionFacts: {
                      ...snapshot.trustedExecutionFacts,
                      ...(quarantined === undefined ? {} : {
                        'quarantined-evidence': mergeDomainTrustedFact(
                          snapshot,
                          'quarantined-evidence',
                          'realEnvironment',
                          deriveExecutionResultId(persistedOutput.caseId, 'real-environment'),
                          quarantined,
                        ),
                      }),
                      ...(persistedOutput.finalizationFacts === undefined ? {} : {
                        'finalization-execution-facts': mergeDomainTrustedFact(
                          snapshot,
                          'finalization-execution-facts',
                          'realEnvironment',
                          deriveExecutionResultId(persistedOutput.caseId, 'real-environment'),
                          persistedOutput.finalizationFacts,
                        ),
                      }),
                    },
                  }),
                  lock,
                })
              } finally {
                await lock.close()
              }
            },
          },
        ))
    } catch (cause) {
      const causeCode =
        safeExecutionCauseCode(cause) ?? 'E2E_RUNTIME_EXECUTION_CAUSE_UNAVAILABLE'
      let releaseCause: unknown
      try {
        await started.owner.release()
      } catch (error) {
        releaseCause = error
      }
      throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED',
        'safety',
        `多 Case 执行未闭合（${causeCode}）；已持久化 cursor，必须显式恢复且不得重放 terminal Case`,
        releaseCause === undefined ? cause : new AggregateError([cause, releaseCause]),
      )
    }
    if (result.schedule.status !== 'terminal') {
      let releaseCause: unknown
      try {
        await started.owner.release()
      } catch (error) {
        releaseCause = error
      }
      throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_RECOVERY_REQUIRED',
        'safety',
        '多 Case 执行停在 Cleanup/恢复边，禁止进入最终化',
        releaseCause,
      )
    }
    const next = result.schedule.cases.some((testCase) => testCase.state === 'safety-blocked')
      ? 'safety-blocked'
      : result.schedule.cases.some((testCase) => testCase.state === 'unable')
        ? 'environment-blocked'
        : 'diagnosing'
    const executionStatus = result.schedule.cases.every((testCase) => testCase.state === 'passed')
      ? 'passed'
      : result.schedule.cases.some((testCase) => testCase.state === 'safety-blocked')
        ? 'safety-blocked'
        : result.schedule.cases.some((testCase) => testCase.state === 'unable')
          ? 'environment-blocked'
          : 'failed'
    const finalWorkflow = transitionWorkflow({
      state: started.snapshot.workflow,
      next,
      reason: 'trusted multi-case full-playwright execution completed',
      timestamp: this.dependencies.now().toISOString(),
      engineVersion: this.dependencies.installation.version,
    }).state
    const response = this.successResponse(executionRequestId, {
      runId: request.payload.runId,
      status: executionStatus,
      cases: result.outputs.map((output) => omitEphemeralWriteEvidence(output)),
      schedule: result.schedule,
      loadedGeneratedSourceFiles: [],
      workflow: finalWorkflow,
    })
    const lock = await this.dependencies.runStore.acquireRunLock(
      projectIdentityDigest,
      request.payload.runId,
    )
    try {
      const completed = RuntimeResponseEnvelopeSchema.parse(
        await this.dependencies.runStore.completeExecutionAttempt({
          projectIdentityDigest,
          runId: request.payload.runId,
          requestId: executionRequestId,
          requestDigest: executionRequestDigest,
          attempt: started.attempt,
          owner: started.owner,
          response,
          lock,
          complete: (snapshot) => ({
            ...snapshot,
            workflow: finalWorkflow,
            updatedAt: this.dependencies.now().toISOString(),
          }),
        }),
      )
      if (resumeAttemptId === undefined) return completed
      return await this.completeGlobalResponse(
        request.requestId,
        requestDigest,
        this.successResponse(request.requestId, {
          runId: request.payload.runId,
          recoveredAttemptId: resumeAttemptId,
          status: executionStatus,
          cases: result.outputs.map((output) => omitEphemeralWriteEvidence(output)),
          schedule: result.schedule,
        }),
      )
    } finally {
      await lock.close()
    }
  }

  private async resumeRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'resume-run' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const decision = parseResumeDecision(request.payload.decision)
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    if (decision.kind === 'recover-write-attempt') {
      const production = this.dependencies.writeProduction
      if (production === undefined) throw blockedError('E2E_RUNTIME_WRITE_RECOVERY_NOT_READY')
      const snapshot = await this.dependencies.runStore.getRun(identity.digest, request.payload.runId)
      let recoverFullPlaywright = false
      try { recoverFullPlaywright = snapshot !== undefined
        && runtimeExecutionMode(snapshot) === 'full-playwright' } catch { /* legacy recovery */ }
      const recoverMultiCase = recoverFullPlaywright
        && (snapshot?.caseSchedule?.cases.length ?? 0) > 1
      if (recoverFullPlaywright && this.dependencies.fullPlaywrightExecutor === undefined) {
        throw blockedError('E2E_RUNTIME_FULL_PLAYWRIGHT_EXECUTOR_NOT_READY')
      }
      const result = await recoverRuntimeProductionWrite(production, { projectIdentityDigest: identity.digest,
        runId: request.payload.runId, attemptId: decision.expectedAttemptId })
      if (recoverMultiCase && result.status === 'recovered') {
        return await this.executeMultiCaseFullPlaywrightRun(
          request,
          requestDigest,
          false,
          identity.digest,
          decision.expectedAttemptId,
        )
      }
      const fullPlaywrightTerminal = recoverFullPlaywright && !recoverMultiCase
        ? await executeRuntimeFullPlaywright(this.dependencies.fullPlaywrightExecutor!, {
          snapshot: snapshot!, attemptId: decision.expectedAttemptId,
        }) : undefined
      const response = this.successResponse(request.requestId, {
        runId: request.payload.runId, recoveredAttemptId: decision.expectedAttemptId, ...result,
        ...(fullPlaywrightTerminal === undefined ? {} : { fullPlaywrightTerminal: omitEphemeralWriteEvidence(
          fullPlaywrightTerminal,
        ) }),
      })
      return await this.completeGlobalResponse(request.requestId, requestDigest, response)
    }
    return await this.withRunLock(identity.digest, request.payload.runId, async (lock) => {
      const reconciled = await this.dependencies.runStore.reconcileExecutionAttempt({
        projectIdentityDigest: identity.digest, runId: request.payload.runId,
        expectedAttemptId: decision.expectedAttemptId,
        reconcileRequestId: request.requestId, reconcileRequestDigest: requestDigest,
        runtimeVersion: this.dependencies.installation.version,
        installationDigest: this.dependencies.installation.installationDigest,
        lock,
      })
      return RuntimeResponseEnvelopeSchema.parse(reconciled.response)
    })
  }

  private async readLockedRun(
    projectIdentityDigest: string,
    runId: string,
  ): Promise<RuntimeRunSnapshot> {
    return await this.withRunLock(projectIdentityDigest, runId, async () => {
      const snapshot = await this.dependencies.runStore.getRun(projectIdentityDigest, runId)
      if (snapshot === undefined) {
        throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', 'Run 不存在')
      }
      return snapshot
    })
  }

  private async withRunLock<T>(
    projectIdentityDigest: string,
    runId: string,
    operation: (lock: RuntimeRunLock) => Promise<T>,
  ): Promise<T> {
    const lock = await this.dependencies.runStore.acquireRunLock(projectIdentityDigest, runId)
    try {
      return await operation(lock)
    } finally {
      await lock.close()
    }
  }

  private requireInstallation(snapshot: RuntimeRunSnapshot): void {
    if (snapshot.runtimeInstallationDigest !== this.dependencies.installation.installationDigest) {
      throw runtimeHostError(
        'E2E_RUNTIME_INSTALLATION_BINDING_MISMATCH',
        'environment',
        'Run 绑定的 active Runtime generation 已改变',
      )
    }
  }

  private async completeGlobalResponse(
    requestId: string,
    requestDigest: string,
    response: RuntimeResponseEnvelope,
  ): Promise<RuntimeResponseEnvelope> {
    return RuntimeResponseEnvelopeSchema.parse(
      await this.dependencies.runStore.completeGlobalRequest(
        requestId,
        requestDigest,
        response,
      ),
    )
  }

  private projectFileReader(): SecureProjectFileReader {
    return this.dependencies.projectFileReader ?? new SecureProjectFileReader()
  }

  private successResponse(requestId: string, result: unknown): RuntimeResponseEnvelope {
    return RuntimeResponseEnvelopeSchema.parse({
      schemaVersion: '1.0.0',
      requestId,
      runtime: runtimeIdentity(this.dependencies.installation),
      ok: true,
      result,
    })
  }

  private errorResponse(requestId: string, error: E2EError): RuntimeResponseEnvelope {
    const response = runtimeErrorResponse(
      requestId,
      error,
      runtimeIdentity(this.dependencies.installation),
    )
    if (error.code === 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED' && response.error !== undefined) {
      return RuntimeResponseEnvelopeSchema.parse({
        ...response,
        error: { ...response.error, category: 'migration', terminalState: 'migration-required' },
      })
    }
    return RuntimeResponseEnvelopeSchema.parse(response)
  }

}

const TARGET_INDEPENDENT_ARTIFACTS = new Set<ArtifactType>([
  'project-policy', 'prd-request', 'prd-manifest', 'prd-diff', 'semantic-generation',
  'acceptance-scope', 'requirement-model', 'interaction-flow', 'coverage-universe',
  'test-cases', 'design-audit', 'execution-contract',
])

const TARGET_DEPENDENT_TRUSTED_FACTS = new Set([
  'pending-local-approval', 'signed-discovery-grant', 'browser-preflight',
  'signed-execution-grant', 'prd-semantic-confirmation', 'manual-results-by-id',
  'finalization-execution-facts', 'quarantined-evidence', 'finalization-material',
])

function isPageIdentityOnlyTargetRevision(
  previous: NonNullable<RuntimeRunSnapshot['targetContract']>,
  next: NonNullable<RuntimeRunSnapshot['targetContract']>,
): boolean {
  const withoutPageIdentity = (target: NonNullable<RuntimeRunSnapshot['targetContract']>) => ({
    schemaVersion: target.contract.schemaVersion,
    targetUrl: target.contract.targetUrl,
    baseOrigin: target.contract.baseOrigin,
    environmentLabel: target.contract.environmentLabel,
    allowedNavigationOrigins: target.contract.allowedNavigationOrigins,
  })
  return canonicalizeJson(withoutPageIdentity(previous)) === canonicalizeJson(withoutPageIdentity(next))
}

function targetChangeInvalidationSummary(snapshot: RuntimeRunSnapshot): {
  reason: 'target-contract-changed'
  preservedAssets: string[]
  invalidatedAssets: string[]
} {
  return {
    reason: 'target-contract-changed',
    preservedAssets: [
      ...Object.keys(snapshot.frozenArtifacts).filter((key) =>
        TARGET_INDEPENDENT_ARTIFACTS.has(key as ArtifactType)),
      'prd-source-bundle', 'compiled-prd-run', 'acceptance-review-confirmation',
    ].filter((value, index, values) => values.indexOf(value) === index).sort(),
    invalidatedAssets: [
      'target-probe', 'signed-discovery-grant', 'browser-preflight',
      'browser-action-map', 'signed-execution-grant', 'execution-results', 'final-report',
    ],
  }
}

function invalidateTargetDependentSnapshot(
  snapshot: RuntimeRunSnapshot,
  target: RuntimeRunSnapshot['targetContract'],
  invalidation: ReturnType<typeof targetChangeInvalidationSummary>,
  timestamp: string,
  engineVersion: string,
): RuntimeRunSnapshot {
  const frozenArtifacts = Object.fromEntries(Object.entries(snapshot.frozenArtifacts)
    .filter(([type]) => TARGET_INDEPENDENT_ARTIFACTS.has(type as ArtifactType)))
  const artifactDigests = Object.fromEntries(Object.entries(snapshot.artifactDigests)
    .filter(([type]) => type === 'prd-source' || type === 'project-policy-source'
      || TARGET_INDEPENDENT_ARTIFACTS.has(type as ArtifactType)))
  const trustedExecutionFacts = Object.fromEntries(Object.entries(snapshot.trustedExecutionFacts)
    .filter(([type]) => !TARGET_DEPENDENT_TRUSTED_FACTS.has(type)))
  trustedExecutionFacts['target-contract-invalidation'] = {
    schemaVersion: '1.0.0', ...invalidation,
    previousTargetContractDigest: snapshot.targetContract?.contractDigest,
    nextTargetContractDigest: target?.contractDigest,
    invalidatedAt: timestamp,
  }
  const workflow = invalidatePreflightForTargetChange({
    state: snapshot.workflow,
    reason: 'target-contract-changed: invalidate browser-bound assets and grants',
    timestamp,
    engineVersion,
  }).state
  const {
    targetProbe: _targetProbe,
    preflightAttempt: _preflightAttempt,
    preflightBlocker: _preflightBlocker,
    executionAttempt: _executionAttempt,
    finalizationAttempt: _finalizationAttempt,
    publication: _publication,
    pendingDecision: _pendingDecision,
    ...preserved
  } = snapshot
  return {
    ...preserved,
    runRevision: (snapshot.runRevision ?? 0) + 1,
    targetContract: target,
    workflow,
    artifactDigests,
    frozenArtifacts,
    trustedExecutionFacts,
    writeAttempts: {},
    executionResults: { readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} },
    updatedAt: timestamp,
  }
}

function parseCandidate(artifactType: ArtifactType, input: unknown): ArtifactDocument {
  const parsed = ArtifactSchemaRegistry[artifactType].safeParse(input)
  if (!parsed.success) {
    throw runtimeHostError(
      'E2E_RUNTIME_CANDIDATE_INVALID',
      'artifact',
      `Candidate 不符合 ${artifactType} 的固定 Artifact schema`,
      parsed.error,
    )
  }
  return parsed.data as ArtifactDocument
}

interface ExecutionWriteLeaseRequest {
  leaseId: string
  resourceKey: string
  resourceFingerprint: string
}

function executionContractWriteLeaseRequests(
  frozenArtifacts: Record<string, ArtifactDocument>,
): ExecutionWriteLeaseRequest[] {
  const source = frozenArtifacts['execution-contract']
  if (source === undefined) throw runtimeHostError(
    'E2E_RUNTIME_EXECUTION_CONTRACT_REQUIRED', 'artifact', '缺少冻结 Execution Contract',
  )
  const parsed = ArtifactSchemaRegistry['execution-contract'].parse(source)
  const requests = parsed.content.dataNeeds
    .filter((need) => need.mode === 'write')
    .map((need) => ({
      leaseId: need.leaseId,
      resourceKey: need.resourceKey,
      resourceFingerprint: need.resourceFingerprint,
    }))
  const leaseIds = new Set(requests.map((request) => request.leaseId))
  const resourceKeys = new Set(requests.map((request) => request.resourceKey))
  if (leaseIds.size !== requests.length || resourceKeys.size !== requests.length) {
    throw runtimeHostError(
      'E2E_RUNTIME_EXECUTION_LEASE_SET_INVALID', 'artifact',
      'Execution Contract 写 dataNeeds 不得重复 leaseId 或 resourceKey',
    )
  }
  return requests
}

function assertReservedExecutionLeases(
  runId: string,
  requests: ExecutionWriteLeaseRequest[],
  leases: DataLease[],
  now: Date,
): void {
  if (leases.length !== requests.length) throw runtimeHostError(
    'E2E_RUNTIME_EXECUTION_LEASE_BINDING_MISMATCH', 'safety',
    'Authority 返回的 Lease 数量与冻结 Execution Contract 不一致',
  )
  const byId = new Map(leases.map((lease) => [lease.leaseId, lease]))
  if (byId.size !== leases.length) throw runtimeHostError(
    'E2E_RUNTIME_EXECUTION_LEASE_BINDING_MISMATCH', 'safety', 'Authority 返回重复 Lease',
  )
  for (const request of requests) {
    const lease = byId.get(request.leaseId)
    if (lease === undefined || lease.runId !== runId || lease.status !== 'active'
      || lease.resourceKey !== request.resourceKey
      || lease.resourceFingerprint !== request.resourceFingerprint
      || lease.exclusive !== true
      || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken <= 0
      || now.getTime() >= Date.parse(lease.expiresAt)) {
      throw runtimeHostError(
        'E2E_RUNTIME_EXECUTION_LEASE_BINDING_MISMATCH', 'safety',
        'Authority 返回的 Lease 未与当前 Run、资源或指纹闭合',
      )
    }
  }
}

function requireManualResultWorkflow(snapshot: RuntimeRunSnapshot): void {
  if (!['execution-approved', 'compiled', 'diagnosing'].includes(snapshot.workflow.current)) {
    throw runtimeHostError(
      'E2E_RUNTIME_MANUAL_RESULT_WORKFLOW_INVALID', 'input',
      'ManualResult 只允许在执行合同已批准且 finalization 尚未开始的 Run 中签署',
    )
  }
}

function parseResumeDecision(input: unknown):
  | { kind: 'reconcile-stale-read'; expectedAttemptId: string }
  | { kind: 'recover-write-attempt'; expectedAttemptId: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw runtimeHostError(
    'E2E_RUNTIME_RESUME_DECISION_INVALID', 'input', 'resume-run 需要严格 reconcile-stale-read 决定',
  )
  const record = input as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== ['expectedAttemptId', 'kind'].join('\0')
    || !['reconcile-stale-read', 'recover-write-attempt'].includes(record.kind as string)
    || typeof record.expectedAttemptId !== 'string'
    || (record.kind === 'reconcile-stale-read'
      ? !/^ATTEMPT-[a-f0-9-]{36}$/.test(record.expectedAttemptId)
      : !/^[A-Za-z0-9._:-]{1,256}$/.test(record.expectedAttemptId))) throw runtimeHostError(
    'E2E_RUNTIME_RESUME_DECISION_INVALID', 'input', 'resume-run 决定字段、kind 或 expectedAttemptId 非法',
  )
  return { kind: record.kind as 'reconcile-stale-read' | 'recover-write-attempt',
    expectedAttemptId: record.expectedAttemptId }
}

function runtimeExecutionMode(snapshot: RuntimeRunSnapshot): 'read' | 'write' | 'injection' | 'full-playwright' {
  const grant = snapshot.trustedExecutionFacts['signed-execution-grant']
  if (typeof grant === 'object' && grant !== null && !Array.isArray(grant)) {
    const capabilities = (grant as Record<string, unknown>).capabilities
    if (Array.isArray(capabilities) && capabilities.some((capability) => typeof capability === 'object'
      && capability !== null && (capability as Record<string, unknown>).transport === 'gateway-injection')) {
      return 'injection'
    }
  }
  const actionMap = snapshot.frozenArtifacts['browser-action-map']
  const content = actionMap?.content
  if (typeof content === 'object' && content !== null && !Array.isArray(content)
    && (content as Record<string, unknown>).executionProfile === 'full-playwright') return 'full-playwright'
  const actions = typeof content === 'object' && content !== null && !Array.isArray(content)
    ? (content as Record<string, unknown>).actions : undefined
  if (!Array.isArray(actions) || actions.length !== 1 || typeof actions[0] !== 'object'
    || actions[0] === null || Array.isArray(actions[0])) throw runtimeHostError(
    'E2E_RUNTIME_ACTION_SET_UNSUPPORTED', 'safety', 'execute-run 只接受唯一冻结 action',
  )
  return (actions[0] as Record<string, unknown>).effect === 'reversible-write' ? 'write' : 'read'
}

function runtimeUsesFullPlaywright(snapshot: RuntimeRunSnapshot): boolean {
  const content = snapshot.frozenArtifacts['execution-contract']?.content
  return typeof content === 'object' && content !== null && !Array.isArray(content)
    && (content as Record<string, unknown>).executionProfile === 'full-playwright'
}

function runtimeSingleActionBinding(snapshot: RuntimeRunSnapshot): { caseId: string; actionId: string } {
  const actions = (snapshot.frozenArtifacts['browser-action-map']?.content as { actions?: unknown })?.actions
  const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined
  const caseId = typeof action === 'object' && action !== null ? (action as { caseId?: unknown }).caseId : undefined
  const actionId = typeof action === 'object' && action !== null ? (action as { actionId?: unknown }).actionId : undefined
  if (typeof caseId !== 'string' || typeof actionId !== 'string') throw runtimeHostError(
    'E2E_RUNTIME_ACTION_SET_UNSUPPORTED', 'safety', '执行结果分域要求唯一冻结 caseId/actionId',
  )
  return { caseId, actionId }
}

function runtimeWriteAttemptBinding(snapshot: RuntimeRunSnapshot): {
  actionId: string
  lease: { leaseId: string; fencingToken: number; targetFingerprintDigest: string }
} {
  const { actionId } = runtimeSingleActionBinding(snapshot)
  const parsed = SignedGrantSchema.safeParse(snapshot.trustedExecutionFacts['signed-execution-grant'])
  if (!parsed.success || parsed.data.approvalContext.runId !== snapshot.runId
    || parsed.data.approvalContext.installationDigest !== snapshot.runtimeInstallationDigest) {
    throw runtimeHostError('E2E_RUNTIME_WRITE_GRANT_REQUIRED', 'safety', '写恢复记录需要严格绑定当前 Run 的 Grant')
  }
  const capabilities = parsed.data.capabilities.filter((candidate) => candidate.actionId === actionId
    && (candidate.transport === 'http' || candidate.transport === 'browser-local')
    && candidate.effect === 'reversible-write')
  if (capabilities.length !== 1) throw runtimeHostError(
    'E2E_RUNTIME_WRITE_CAPABILITY_BINDING_MISMATCH', 'safety', '写 action 未唯一绑定 HTTP/full capability',
  )
  const capability = capabilities[0] as typeof capabilities[0] & {
    dataLeaseId?: unknown; fencingToken?: unknown; requests?: Array<{ targetFingerprint?: unknown }>
  }
  const fingerprints = [...new Set((capability.requests ?? []).map((request) => request.targetFingerprint))]
  if (typeof capability.dataLeaseId !== 'string'
    || typeof capability.fencingToken !== 'number' || !Number.isSafeInteger(capability.fencingToken)
    || capability.fencingToken < 1 || fingerprints.length !== 1
    || typeof fingerprints[0] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fingerprints[0])) {
    throw runtimeHostError(
      'E2E_RUNTIME_WRITE_LEASE_BINDING_INVALID', 'safety', '写 capability 的 Lease/target fingerprint 未唯一闭合',
    )
  }
  return { actionId, lease: { leaseId: capability.dataLeaseId,
    fencingToken: capability.fencingToken, targetFingerprintDigest: fingerprints[0] } }
}

function nextWorkflowNode(current: WorkflowNode, artifactType: ArtifactType): WorkflowNode | undefined {
  const edge = CANDIDATE_EDGES[current]
  return edge?.artifactType === artifactType ? edge.next : undefined
}

function runtimeDecisionSubject(
  snapshot: RuntimeRunSnapshot,
  approvalType: 'scope' | 'lineage',
): { decisionId: string; decisionSubject: DecisionSubject } {
  const artifactType = approvalType === 'scope' ? 'acceptance-scope' : 'prd-diff'
  const artifact = snapshot.frozenArtifacts[artifactType]
  if (artifact === undefined) throw runtimeHostError(
    'E2E_RUNTIME_APPROVAL_SUBJECT_INVALID', 'input', `${artifactType} 尚未冻结`,
  )
  const content = artifact.content as Record<string, unknown>
  const decision = content[approvalType === 'scope' ? 'scopeDecision' : 'lineageReview']
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)
    || (decision as Record<string, unknown>).status !== 'pending'
    || typeof (decision as Record<string, unknown>).decisionId !== 'string') {
    throw runtimeHostError(
      'E2E_RUNTIME_APPROVAL_SUBJECT_INVALID', 'input', `${artifactType} 不含 pending decision`,
    )
  }
  return {
    decisionId: (decision as Record<string, unknown>).decisionId as string,
    decisionSubject: approvalType === 'scope'
      ? projectScopeDecisionSubject(artifact.content)
      : projectLineageDecisionSubject(artifact.content),
  }
}

function applyRuntimeDecisionReceipt(
  snapshot: RuntimeRunSnapshot,
  approvalType: 'scope' | 'lineage',
  receipt: DecisionReceipt,
): { artifact: ArtifactDocument } {
  const { decisionId } = runtimeDecisionSubject(snapshot, approvalType)
  if (receipt.kind !== approvalType || receipt.decisionId !== decisionId
    || receipt.decisionStatus !== 'approved') throw runtimeHostError(
    'E2E_RUNTIME_DECISION_RECEIPT_INVALID', 'safety', 'DecisionReceipt 与冻结审批主题不闭合',
  )
  const artifactType = approvalType === 'scope' ? 'acceptance-scope' : 'prd-diff'
  const source = snapshot.frozenArtifacts[artifactType]!
  const decisionKey = approvalType === 'scope' ? 'scopeDecision' : 'lineageReview'
  const updated: Record<string, unknown> = {
    ...structuredClone(source),
    content: {
      ...(structuredClone(source.content) as Record<string, unknown>),
      [decisionKey]: { decisionId, status: 'approved', receipt },
    },
    contentDigest: '',
    signatures: [],
  }
  // project* 已在 receipt 签发前投影；这里再次调用以拒绝内容结构漂移。
  if (approvalType === 'scope') projectScopeDecisionSubject(updated.content)
  else projectLineageDecisionSubject(updated.content)
  updated.contentDigest = digestArtifactContent(
    `artifact-content/${source.schemaVersion}/${artifactType}`, updated,
  )
  return { artifact: ArtifactSchemaRegistry[artifactType].parse(updated) as ArtifactDocument }
}

const CANDIDATE_EDGES: Partial<Record<WorkflowNode, { artifactType: ArtifactType; next: WorkflowNode }>> = {
  created: { artifactType: 'prd-request', next: 'source-frozen' },
  'source-frozen': { artifactType: 'acceptance-scope', next: 'awaiting-scope-approval' },
  'scope-approved': { artifactType: 'requirement-model', next: 'modeled' },
  modeled: { artifactType: 'coverage-universe', next: 'coverage-audited' },
  'preflight-readonly': { artifactType: 'browser-action-map', next: 'binding-draft' },
  'execution-approved': { artifactType: 'regression-manifest', next: 'compiled' },
}

const SUPPLEMENTAL_CANDIDATES: Partial<Record<WorkflowNode, ReadonlySet<ArtifactType>>> = {
  created: new Set(['project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation']),
  'source-frozen': new Set(['project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation']),
  'awaiting-scope-approval': new Set(['project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation']),
  'scope-approved': new Set(['interaction-flow', 'design-audit']),
  modeled: new Set(['interaction-flow', 'design-audit']),
}

function isSupplementalCandidate(current: WorkflowNode, artifactType: ArtifactType): boolean {
  return SUPPLEMENTAL_CANDIDATES[current]?.has(artifactType) === true
}

function assertSemanticStagePrerequisites(
  artifactType: ArtifactType,
  frozenArtifacts: Partial<Record<ArtifactType, ArtifactDocument>>,
): void {
  const required = artifactType === 'acceptance-scope'
    ? ['project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation'] as const
    : artifactType === 'coverage-universe'
      ? ['requirement-model', 'interaction-flow', 'design-audit'] as const
      : []
  const missing = required.filter((type) => frozenArtifacts[type] === undefined)
  if (missing.length > 0) throw runtimeHostError(
    'E2E_RUNTIME_STAGE_PREREQUISITES_MISSING', 'artifact',
    `提交 ${artifactType} 前必须先冻结同阶段资产：${missing.join(', ')}`,
  )
}

function missingCapabilityCode(current: WorkflowNode): string {
  if (current === 'awaiting-scope-approval' || current === 'awaiting-execution-approval') {
    return 'E2E_RUNTIME_APPROVAL_NOT_READY'
  }
  if (current === 'binding-draft' || current === 'lease-reserved') {
    return 'E2E_RUNTIME_AUTHORITY_NOT_READY'
  }
  return 'E2E_RUNTIME_COMMAND_NOT_READY'
}

function requireApprovalType(snapshot: RuntimeRunSnapshot, approvalType: string): void {
  const allowed: Partial<Record<WorkflowNode, string[]>> = {
    'awaiting-scope-approval': ['scope', 'lineage'],
    'coverage-audited': ['discovery'],
    'awaiting-execution-approval': ['execution'],
    diagnosing: ['privacy', 'execution'],
    finalizing: ['privacy'],
  }
  if (!allowed[snapshot.workflow.current]?.includes(approvalType)) {
    throw runtimeHostError(
      'E2E_RUNTIME_APPROVAL_TYPE_MISMATCH',
      'safety',
      `approvalType ${approvalType} 不适用于当前 workflow ${snapshot.workflow.current}`,
    )
  }
}

function assertAcceptanceReviewConfirmed(snapshot: RuntimeRunSnapshot): void {
  const requiresReview = snapshot.compiledPrdRun?.cases.some((testCase) =>
    testCase.executionLane !== undefined) === true
  if (!requiresReview) return
  const review = buildAcceptanceReview(snapshot)
  const receipt = AcceptanceReviewReceiptSchema.safeParse(
    snapshot.trustedExecutionFacts['acceptance-review-receipt'],
  )
  if (!receipt.success || receipt.data.reviewDigest !== review.reviewDigest) {
    throw runtimeHostError(
      'E2E_ACCEPTANCE_REVIEW_CONFIRMATION_REQUIRED',
      'input',
      '请先展示并确认 PRD 原文→Requirement→Rule→Oracle→Case 验收链路',
    )
  }
}

function assertTargetReady(snapshot: RuntimeRunSnapshot): void {
  const requiresTarget = snapshot.targetContract !== undefined
    || snapshot.compiledPrdRun?.cases.some((testCase) => testCase.executionLane !== undefined) === true
  if (!requiresTarget) return
  if (snapshot.targetContract === undefined) throw runtimeHostError(
    'E2E_TARGET_CONTRACT_REQUIRED', 'input', '请先配置 TargetContract',
  )
  if (snapshot.targetProbe === undefined
    || snapshot.targetProbe.targetContractDigest !== snapshot.targetContract.contractDigest) {
    throw runtimeHostError(
      'E2E_TARGET_PROBE_REQUIRED', 'environment',
      '请先使用受控浏览器执行无副作用 Target Probe',
    )
  }
  if (snapshot.targetProbe.status !== 'ready') throw runtimeHostError(
    snapshot.targetProbe.reasonCode ?? 'E2E_TARGET_PROBE_BLOCKED',
    'environment',
    'Target Probe 未证明页面可达且身份匹配',
  )
}

function assertRuntimeGrantSubject(
  snapshot: RuntimeRunSnapshot,
  approvalType: string,
  subject: ApprovalGrantSubject | undefined,
): void {
  const grantsCapability = approvalType === 'discovery' || approvalType === 'execution'
  if (!grantsCapability) {
    if (subject !== undefined) throw runtimeHostError(
      'E2E_RUNTIME_APPROVAL_SUBJECT_INVALID', 'input', '非 Grant 审批不得携带 grantSubject',
    )
    return
  }
  if (subject === undefined || canonicalGrantApprovalType(subject) !== approvalType
    || subject.assetId !== snapshot.assetId
    || subject.prdRevision !== snapshot.artifactDigests['prd-source']
    || ('actions' in subject && Array.isArray(subject.actions)
      && subject.actions.some((action: Record<string, unknown>) =>
        'runId' in action && action.runId !== snapshot.runId))) {
    throw runtimeHostError(
      'E2E_RUNTIME_APPROVAL_SUBJECT_INVALID',
      'safety',
      'grantSubject 必须严格绑定当前 Run、PRD revision 与 approvalType',
    )
  }
  if (approvalType === 'discovery' && snapshot.targetContract !== undefined
    && ('expectedPageIdentity' in subject)
    && (subject.baseOrigin !== snapshot.targetContract.contract.baseOrigin
      || subject.environment !== snapshot.targetContract.contract.environmentLabel
      || subject.expectedPageIdentity.url !== snapshot.targetContract.contract.targetUrl
      || canonicalizeJson(subject.expectedPageIdentity.policy)
        !== canonicalizeJson(snapshot.targetContract.contract.pageIdentityPolicy))) {
    throw runtimeHostError(
      'E2E_TARGET_ENVIRONMENT_MISMATCH', 'safety',
      'Discovery subject 必须引用唯一 TargetContract 的环境和页面身份',
    )
  }
  if (snapshot.workflow.current === 'diagnosing' && approvalType === 'execution'
    && !InjectionApprovalSubjectSchema.safeParse(subject).success) {
    throw runtimeHostError(
      'E2E_RUNTIME_APPROVAL_SUBJECT_INVALID',
      'safety',
      '真实环境执行后的二次 execution 审批只能是故障注入 Grant',
    )
  }
}

function createRunResult(snapshot: RuntimeRunSnapshot): Record<string, unknown> {
  const sourceBundle = PrdSourceBundleSnapshotSchema.parse(
    snapshot.trustedExecutionFacts['prd-source-bundle'],
  )
  return RuntimeCreateRunResultSchema.parse({
    runId: snapshot.runId,
    assetId: snapshot.assetId,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    generationId: snapshot.runId,
    prdRevision: snapshot.artifactDigests['prd-source'],
    sourceRevision: snapshot.artifactDigests['prd-source'],
    understandingContractDigest: (snapshot.trustedExecutionFacts['prd-understanding-contract'] as {
      sourceDigest: string
    }).sourceDigest,
    sourceBundle: sourceBundle.sources.map((source) => ({
      sourceId: source.sourceId, kind: source.kind, ref: source.sourceRef,
      mediaType: source.mediaType, origin: source.origin, relevance: source.relevance,
      digest: source.normalizedDigest, byteLength: source.byteLength,
    })),
    workflow: snapshot.workflow,
  })
}

function statusResult(snapshot: RuntimeRunSnapshot, now: Date): Record<string, unknown> {
  const projection = runtimeStatusProjection(snapshot, now)
  const targetInvalidation = targetInvalidationProjection(snapshot)
  const acceptanceReview = acceptanceReviewForStatus(snapshot)
  const receipt = AcceptanceReviewReceiptSchema.safeParse(
    snapshot.trustedExecutionFacts['acceptance-review-receipt'],
  )
  const reviewConfirmed = acceptanceReview !== undefined && receipt.success
    && receipt.data.reviewDigest === acceptanceReview.reviewDigest
  const targetProbeBlocker = snapshot.targetProbe !== undefined
    && snapshot.targetProbe.status !== 'ready'
    ? snapshot.targetProbe.reasonCode ?? 'E2E_TARGET_PROBE_BLOCKED' : undefined
  return RuntimeStatusResultSchema.parse({
    runId: snapshot.runId,
    assetId: snapshot.assetId,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    runtimeInstallationDigest: snapshot.runtimeInstallationDigest,
    generationId: snapshot.runId,
    prdRevision: snapshot.artifactDigests['prd-source'],
    workflow: snapshot.workflow,
    artifactDigests: snapshot.artifactDigests,
    handle: createRunHandle(snapshot),
    stage: projectRunStage(snapshot.workflow.current),
    condition: classifyRunCondition(snapshot),
    ...(snapshot.targetContract === undefined ? {} : { target: snapshot.targetContract }),
    ...(snapshot.targetProbe === undefined ? {} : { targetProbe: snapshot.targetProbe }),
    preservedAssets: targetInvalidation?.preservedAssets ?? [
      ...Object.keys(snapshot.artifactDigests).sort(),
      ...(snapshot.compiledPrdRun === undefined ? [] : ['compiled-prd-run']),
    ],
    invalidatedAssets: targetInvalidation?.invalidatedAssets ?? [],
    semanticCases: (snapshot.compiledPrdRun?.cases ?? []).map((testCase) => ({
      caseId: testCase.caseId,
      title: testCase.title,
      actor: testCase.actor,
      contractNodeIds: testCase.contractNodeIds,
      oracleIds: testCase.oracles.map((oracle) => oracle.oracleId),
      ...(testCase.executionLane === undefined ? {} : { executionLane: testCase.executionLane }),
      ...(testCase.fixture === undefined ? {} : { fixture: testCase.fixture }),
      ...(testCase.locatorCandidates === undefined
        ? {} : { locatorCandidates: testCase.locatorCandidates }),
      ...(testCase.pageIdentityPolicy === undefined
        ? {} : { pageIdentityPolicy: testCase.pageIdentityPolicy }),
      bindingStatus: targetProbeBlocker !== undefined || snapshot.preflightBlocker !== undefined ? 'blocked'
        : snapshot.trustedExecutionFacts['browser-preflight'] !== undefined
          && snapshot.frozenArtifacts['browser-action-map'] !== undefined ? 'ready' : 'pending',
      ...(targetProbeBlocker !== undefined
        ? { blockerReasonCode: targetProbeBlocker }
        : snapshot.preflightBlocker === undefined
          ? {} : { blockerReasonCode: snapshot.preflightBlocker.reasonCode }),
    })),
    remediation: runtimeRemediation(snapshot, acceptanceReview, reviewConfirmed),
    ...projection,
    ...(acceptanceReview === undefined ? {} : {
      acceptanceReview,
      acceptanceReviewConfirmation: reviewConfirmed
        ? { status: 'confirmed', receiptDigest: receipt.data.receiptDigest }
        : { status: 'required' },
    }),
    ...(snapshot.preflightBlocker === undefined
      ? {} : { preflightBlocker: snapshot.preflightBlocker }),
    ...(snapshot.pendingDecision === undefined ? {} : { pendingDecision: snapshot.pendingDecision }),
  })
}

function targetInvalidationProjection(snapshot: RuntimeRunSnapshot): {
  preservedAssets: string[]
  invalidatedAssets: string[]
} | undefined {
  const candidate = snapshot.trustedExecutionFacts['target-contract-invalidation']
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  const record = candidate as Record<string, unknown>
  if (record.reason !== 'target-contract-changed'
    || !Array.isArray(record.preservedAssets)
    || !record.preservedAssets.every((value) => typeof value === 'string')
    || !Array.isArray(record.invalidatedAssets)
    || !record.invalidatedAssets.every((value) => typeof value === 'string')) return undefined
  return {
    preservedAssets: [...record.preservedAssets] as string[],
    invalidatedAssets: [...record.invalidatedAssets] as string[],
  }
}

function runtimeRemediation(
  snapshot: RuntimeRunSnapshot,
  acceptanceReview: ReturnType<typeof acceptanceReviewForStatus>,
  reviewConfirmed: boolean,
): string[] {
  if (snapshot.targetProbe !== undefined && snapshot.targetProbe.status !== 'ready') {
    const retryable = hasPreviewReadonlyOnlyCases(snapshot)
      && isTargetProbeRetryableReason(snapshot.targetProbe.reasonCode)
    return [
      `目标探测在 ${snapshot.targetProbe.diagnostics.strategy} 策略下被 ${snapshot.targetProbe.reasonCode ?? 'E2E_TARGET_PROBE_BLOCKED'} 阻断；页面 URL、标题、DOM、Console、失败请求和待处理资源已保留。`,
      retryable
        ? '对同一 Run 执行 retry；Runtime 会按 reasonCode 维持或切换只读探测策略，无需重建 PRD、Case 或审批资产。'
        : snapshot.targetProbe.reasonCode === 'E2E_RUNTIME_PAGE_MISMATCH'
          ? '请修订 TargetContract 的页面身份策略后在同一 Run 重新探测；不得靠降低策略绕过身份不匹配。'
          : '请修复页面脚本、资源闭包或目标环境后在同一 Run 重新探测；含写操作和非资源类错误不会降低策略。',
      'Target Probe 未执行任何业务动作；只有可信 Preflight 通过后才允许进入业务执行。',
    ]
  }
  if (snapshot.preflightBlocker !== undefined) return [
    `修复 ${snapshot.preflightBlocker.reasonCode} 后对同一 Run 重新执行 run-preflight，无需重建需求资产。`,
  ]
  if (acceptanceReview !== undefined && !reviewConfirmed) return [
    '请先展示 AcceptanceReview 的 PRD 原文到 Case 映射，再使用 reviewDigest 确认。',
  ]
  return []
}

const STATUS_COMMAND_BY_STATE: Partial<Record<WorkflowNode,
{ command: import('@mutil-skills/e2e-contracts').RuntimeStatusNextEdge['command']; missing: string[] }>> = {
  created: { command: 'submit-candidate', missing: ['prd-request'] },
  'source-frozen': { command: 'submit-candidate', missing: [
    'project-policy', 'prd-manifest', 'prd-diff', 'semantic-generation', 'acceptance-scope',
  ] },
  'awaiting-scope-approval': { command: 'open-approval', missing: ['scope-or-lineage-decision'] },
  'scope-approved': { command: 'submit-candidate', missing: [
    'interaction-flow', 'design-audit', 'requirement-model',
  ] },
  modeled: { command: 'submit-candidate', missing: [
    'interaction-flow', 'design-audit', 'coverage-universe',
  ] },
  'coverage-audited': { command: 'open-approval', missing: ['discovery-approval'] },
  'discovery-approved': { command: 'run-preflight', missing: ['browser-preflight'] },
  'preflight-readonly': { command: 'submit-candidate', missing: ['browser-action-map'] },
  'binding-draft': { command: 'submit-candidate', missing: ['test-cases', 'execution-contract'] },
  'lease-reserved': { command: 'open-approval', missing: ['execution-approval'] },
  'awaiting-execution-approval': { command: 'open-approval', missing: ['execution-approval'] },
  'execution-approved': { command: 'submit-candidate', missing: ['regression-manifest'] },
  compiled: { command: 'execute-run', missing: ['trusted-browser-execution'] },
  'running-real': { command: 'resume-run', missing: ['execution-recovery-decision'] },
  'running-injection': { command: 'resume-run', missing: ['execution-recovery-decision'] },
  diagnosing: { command: 'finalize-run', missing: [] },
  finalizing: { command: 'finalize-run', missing: ['same-finalization-request'] },
  'pending-decision': { command: 'resume-run', missing: ['authority-decision'] },
  accepted: { command: 'render-report', missing: [] },
  rejected: { command: 'render-report', missing: [] },
  incomplete: { command: 'render-report', missing: [] },
}

function runtimeStatusProjection(snapshot: RuntimeRunSnapshot, now: Date): {
  state: WorkflowNode
  nextEdge: import('@mutil-skills/e2e-contracts').RuntimeStatusNextEdge | null
  verifiedDigests: Record<string, string>
  minimumMissingInput: string[]
} {
  const current = snapshot.workflow.current
  const prepared = PrdUnderstandingPreparedFactSchema.safeParse(
    snapshot.trustedExecutionFacts['prd-understanding-prepared'],
  )
  const contract = PrdUnderstandingContractFactSchema.safeParse(
    snapshot.trustedExecutionFacts['prd-understanding-contract'],
  )
  const acceptanceReview = acceptanceReviewForStatus(snapshot)
  const acceptanceReceipt = AcceptanceReviewReceiptSchema.safeParse(
    snapshot.trustedExecutionFacts['acceptance-review-receipt'],
  )
  const needsAcceptanceConfirmation = acceptanceReview !== undefined
    && (!acceptanceReceipt.success
      || acceptanceReceipt.data.reviewDigest !== acceptanceReview.reviewDigest)
  const requiresTarget = snapshot.targetContract !== undefined
    || snapshot.compiledPrdRun?.cases.some((testCase) => testCase.executionLane !== undefined) === true
  const targetProbeReady = snapshot.targetProbe?.status === 'ready'
    && snapshot.targetProbe.targetContractDigest === snapshot.targetContract?.contractDigest
  const intent = current === 'created' && !prepared.success
    ? { command: 'prepare-prd-understanding' as const, missing: ['prd-understanding-prepared'] }
    : current === 'created' && snapshot.compiledPrdRun === undefined
      ? { command: 'compile-prd-run' as const, missing: ['declarative-prd-run-design'] }
    : requiresTarget && snapshot.targetContract === undefined
    ? { command: 'configure-target' as const, missing: ['target-contract'] }
    : requiresTarget && !targetProbeReady
      ? { command: 'probe-target' as const, missing: ['target-probe-ready'] }
    : needsAcceptanceConfirmation
      ? { command: 'get-acceptance-review' as const, missing: ['acceptance-review-confirmation'] }
    : current === 'preflight-readonly' && snapshot.preflightBlocker !== undefined
    ? {
      command: 'run-preflight' as const,
      missing: [`browser-preflight-retry:${snapshot.preflightBlocker.reasonCode}`],
    }
    : STATUS_COMMAND_BY_STATE[current]
  const missing = current === 'diagnosing'
    ? runtimeFinalizationMissingInputs(snapshot, now)
    : snapshot.preflightBlocker !== undefined
      ? intent?.missing ?? []
      : intent?.missing.filter((item) => snapshot.artifactDigests[item] === undefined) ?? []
  return {
    state: current,
    nextEdge: intent === undefined ? null : {
      command: intent.command,
      from: current,
      expectedState: current,
    },
    verifiedDigests: {
      runtimeInstallation: snapshot.runtimeInstallationDigest,
      workflowEventChain: snapshot.workflow.eventChainDigest,
      ...(contract.success ? { 'prd-understanding-contract': contract.data.sourceDigest } : {}),
      ...(prepared.success
        ? { 'prd-understanding-projection': prepared.data.projection.projectionDigest } : {}),
      ...(snapshot.compiledPrdRun === undefined
        ? {} : { 'compiled-prd-run': snapshot.compiledPrdRun.compilerDigest }),
      ...(snapshot.caseSchedule === undefined
        ? {} : { 'case-schedule': snapshot.caseSchedule.scheduleDigest }),
      ...snapshot.artifactDigests,
    },
    minimumMissingInput: missing,
  }
}

function acceptanceReviewForStatus(snapshot: RuntimeRunSnapshot) {
  const requiresReview = snapshot.compiledPrdRun?.cases.some((testCase) =>
    testCase.executionLane !== undefined) === true
  if (!requiresReview) return undefined
  const ready = snapshot.frozenArtifacts['prd-manifest'] !== undefined
    && snapshot.frozenArtifacts['acceptance-scope'] !== undefined
    && snapshot.frozenArtifacts['requirement-model'] !== undefined
    && snapshot.frozenArtifacts['coverage-universe'] !== undefined
  return ready ? buildAcceptanceReview(snapshot) : undefined
}

const FINALIZATION_EXTERNAL_TYPES = [
  'project-policy', 'prd-request', 'prd-manifest', 'prd-diff', 'semantic-generation',
  'acceptance-scope', 'requirement-model', 'interaction-flow', 'coverage-universe',
  'test-cases', 'design-audit', 'execution-contract', 'browser-action-map',
  'regression-manifest',
] as const satisfies readonly ArtifactType[]

function runtimeFinalizationMissingInputs(snapshot: RuntimeRunSnapshot, now: Date): string[] {
  if (snapshot.trustedExecutionFacts['finalization-material'] !== undefined) return []
  const missing = FINALIZATION_EXTERNAL_TYPES
    .filter((type) => snapshot.frozenArtifacts[type] === undefined)
    .map((type) => `artifact:${type}`)
  if (missing.length > 0) return missing

  const reads = Object.values(snapshot.executionResults?.readEnvironment ?? {})
  const writes = Object.values(snapshot.executionResults?.realEnvironment ?? {})
  const injections = Object.values(snapshot.executionResults?.gatewayInjection ?? {})
  if (reads.length > 0 && writes.length > 0) missing.push('mixed-real-execution-result-domains')
  if (reads.length === 0 && writes.length === 0) missing.push('real-execution-result')
  if (reads.length > 1) missing.push('exactly-one-read-execution-result')
  if (reads.length === 1) {
    if (injections.length > 0) missing.push('write-baseline-for-injection')
    for (const fact of [
      'browser-preflight', 'signed-discovery-grant', 'signed-execution-grant',
      'finalization-execution-facts', 'quarantined-evidence',
    ]) {
      if (snapshot.trustedExecutionFacts[fact] === undefined) missing.push(`trusted-fact:${fact}`)
    }
  }
  if (writes.length > 0) {
    for (const candidate of writes) {
      const write = runtimeRecord(candidate)
      if (write?.finalizationFacts === undefined) missing.push('trusted-fact:write-finalization-facts')
      const cleanup = runtimeRecord(write?.cleanup)
      if (cleanup === undefined || !['verified-clean', 'failed', 'unknown'].includes(String(cleanup.status))) {
        missing.push('write-cleanup-terminal-result')
      }
    }
    if (snapshot.caseSchedule !== undefined
      && (snapshot.caseSchedule.status !== 'terminal'
        || snapshot.caseSchedule.cases.filter((item) => item.attemptId !== undefined).length !== writes.length)) {
      missing.push('multi-case-schedule-terminal-binding')
    }
  }
  if (injections.length > 1) missing.push('exactly-one-injection-result')
  if (injections.length === 1) {
    const injection = runtimeRecord(injections[0])
    if (writes.length !== 1) missing.push('real-write-baseline-for-injection')
    if (injection?.finalizationFacts === undefined) missing.push('trusted-fact:injection-finalization-facts')
  }
  missing.push(...runtimeManualResultMissingInputs(snapshot, now))
  return [...new Set(missing)].sort()
}

function runtimeManualResultMissingInputs(snapshot: RuntimeRunSnapshot, now: Date): string[] {
  try {
    const coverage = runtimeRecord(snapshot.frozenArtifacts['coverage-universe']?.content)
    const execution = runtimeRecord(snapshot.frozenArtifacts['execution-contract']?.content)
    if (coverage === undefined || execution === undefined) return ['manual-result-binding-artifacts']
    const obligations = runtimeRecords(coverage.obligations)
      .filter((obligation) => runtimeRecord(obligation.disposition)?.kind === 'manual')
    const procedures = runtimeRecords(execution.manualProcedures)
    const raw = snapshot.trustedExecutionFacts['manual-results-by-id']
    const resultMap = raw === undefined ? {} : runtimeRecord(raw)
    if (resultMap === undefined) return ['manual-results-valid']
    if (obligations.length === 0 && procedures.length === 0 && Object.keys(resultMap).length === 0) return []
    if (obligations.length === 0 || procedures.length === 0 || Object.keys(resultMap).length === 0) {
      return obligations.length === 0 ? ['manual-obligation-definition']
        : obligations.map((obligation) => `manual-result:${String(obligation.obligationId)}`)
    }
    const procedureIds = procedures.map((procedure) => String(procedure.manualProcedureId))
    if (new Set(procedureIds).size !== procedureIds.length) return ['manual-procedures-unique']
    const results = Object.entries(resultMap).map(([manualResultId, candidate]) => {
      const result = bindManualResultToRuntimeSnapshot(snapshot, candidate, now)
      if (result.manualResultId !== manualResultId) throw new Error('manual result key mismatch')
      return result
    })
    const obligationIds = new Set(obligations.map((obligation) => String(obligation.obligationId)))
    const missing: string[] = []
    for (const obligation of obligations) {
      const disposition = runtimeRecord(obligation.disposition)
      const obligationId = String(obligation.obligationId)
      const procedureId = String(disposition?.manualProcedureId)
      const matches = results.filter((result) => result.obligationIds.includes(obligationId))
      if (!procedureIds.includes(procedureId)) missing.push(`manual-procedure:${procedureId}`)
      if (matches.length !== 1 || matches[0]?.manualProcedureId !== procedureId) {
        missing.push(`manual-result:${obligationId}`)
      }
    }
    if (results.some((result) => result.obligationIds.some((id) => !obligationIds.has(id)))) {
      missing.push('manual-result-binding')
    }
    return missing
  } catch {
    return ['manual-results-valid']
  }
}

function runtimeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function runtimeRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(runtimeRecord).filter((item): item is Record<string, unknown> => item !== undefined)
    : []
}

function assertUnderstandingContractHeader(
  source: string,
  header: {
    schemaVersion: '1.0.0'
    contractId: string
    contractVersion: number
    contractStatus: 'confirmed-by-caller'
    authorization: { status: 'confirmed-by-caller'; contractVersion: number; confirmedAt: string }
  },
): import('@mutil-skills/e2e-contracts').PrdUnderstandingContractMachineView {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '---') throw runtimeHostError(
    'E2E_RUNTIME_UNDERSTANDING_CONTRACT_HEADER_INVALID', 'input',
    'requirements contract 必须以严格 YAML front matter 开始',
  )
  const closing = lines.indexOf('---', 1)
  if (closing < 2) throw runtimeHostError(
    'E2E_RUNTIME_UNDERSTANDING_CONTRACT_HEADER_INVALID', 'input',
    'requirements contract 缺少闭合 YAML front matter',
  )
  const actual = new Map<string, string>()
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw runtimeHostError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_HEADER_INVALID', 'input',
      'requirements contract front matter 仅允许 key: value',
    )
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (actual.has(key) || value.length === 0) throw runtimeHostError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_HEADER_INVALID', 'input',
      'requirements contract front matter 的 key 必须唯一且值非空',
    )
    actual.set(key, value)
  }
  const expected = new Map([
    ['schemaVersion', header.schemaVersion],
    ['contractId', header.contractId],
    ['contractVersion', String(header.contractVersion)],
    ['contractStatus', header.contractStatus],
    ['confirmationStatus', header.authorization.status],
    ['confirmationContractVersion', String(header.authorization.contractVersion)],
    ['confirmedAt', header.authorization.confirmedAt],
  ])
  if (actual.size !== expected.size
    || [...expected].some(([key, value]) => actual.get(key) !== value)) {
    throw runtimeHostError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_HEADER_MISMATCH', 'input',
      'create-run Header 与 requirements contract 冻结原文不一致',
    )
  }
  const markerStart = '<!-- e2e-contract-machine-view:v1\n'
  const markerEnd = '\n-->'
  const start = source.indexOf(markerStart, lines.slice(0, closing + 1).join('\n').length)
  const end = start < 0 ? -1 : source.indexOf(markerEnd, start + markerStart.length)
  if (start < 0 || end < 0 || source.indexOf(markerStart, start + 1) >= 0) throw runtimeHostError(
    'E2E_RUNTIME_UNDERSTANDING_CONTRACT_MACHINE_VIEW_INVALID', 'input',
    'requirements contract 必须包含唯一 e2e-contract-machine-view:v1',
  )
  let candidate: unknown
  try {
    candidate = JSON.parse(source.slice(start + markerStart.length, end))
  } catch (cause) {
    throw runtimeHostError(
      'E2E_RUNTIME_UNDERSTANDING_CONTRACT_MACHINE_VIEW_INVALID', 'input',
      'requirements contract machine view 必须是严格 JSON', cause,
    )
  }
  const parsed = PrdUnderstandingContractMachineViewSchema.safeParse(candidate)
  if (!parsed.success) throw runtimeHostError(
    'E2E_RUNTIME_UNDERSTANDING_CONTRACT_MACHINE_VIEW_INVALID', 'input',
    'requirements contract machine view 未通过严格 schema', parsed.error,
  )
  return parsed.data
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw runtimeHostError('E2E_RUNTIME_PROJECT_FILE_UTF8_INVALID', 'input', `${label} 必须是 UTF-8`, cause)
  }
}

function runtimeRequestDigest(
  request: RuntimeRequestEnvelope,
  requestBytes: string | Uint8Array,
): string {
  if (requestBytes === undefined) {
    throw runtimeHostError(
      'E2E_RUNTIME_REQUEST_BYTES_REQUIRED',
      'input',
      'Runtime Host 必须接收 parser 实际消费的原始 request bytes',
    )
  }
  const bytes = typeof requestBytes === 'string' ? Buffer.from(requestBytes, 'utf8') : requestBytes
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw runtimeHostError(
      'E2E_RUNTIME_REQUEST_BYTES_INVALID',
      'input',
      '原始 request bytes 必须是与 parsed request 相同的 UTF-8 JSON',
      cause,
    )
  }
  if (canonicalizeJson(parsed) !== canonicalizeJson(request)) {
    throw runtimeHostError(
      'E2E_RUNTIME_REQUEST_BYTES_MISMATCH',
      'input',
      '原始 request bytes 与 parsed request 不一致',
    )
  }
  return digestBytes('e2e-runtime-request-bytes/v1', bytes)
}

function runIdForRequest(requestId: string): string {
  const candidate = `RUN-${requestId}`
  if (requestId.length <= 252 && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(candidate)) return candidate
  const digest = digestText('e2e-runtime-run-id/v1', requestId)
    .slice('sha256:'.length, 'sha256:'.length + 32)
    .toUpperCase()
  return `RUN-${digest}`
}

function runtimeIdentity(installation: RuntimeInstallation): RuntimeResponseEnvelope['runtime'] {
  return {
    version: installation.version,
    installationDigest: installation.installationDigest,
  }
}

function omitEphemeralWriteEvidence(
  output: Awaited<ReturnType<typeof executeRuntimeWrite>>,
): Awaited<ReturnType<typeof executeRuntimeWrite>> {
  const { evidence: _evidence, ...persisted } = output
  return structuredClone(persisted) as Awaited<ReturnType<typeof executeRuntimeWrite>>
}

function omitEphemeralInjectionEvidence(
  output: Awaited<ReturnType<typeof executeRuntimeInjection>>,
): Awaited<ReturnType<typeof executeRuntimeInjection>> {
  const { evidence: _evidence, ...persisted } = output
  return structuredClone(persisted) as Awaited<ReturnType<typeof executeRuntimeInjection>>
}

function mergeDomainTrustedFact(
  snapshot: RuntimeRunSnapshot,
  key: 'finalization-execution-facts' | 'quarantined-evidence',
  domain: 'realEnvironment' | 'gatewayInjection',
  resultId: string,
  fact: unknown,
): Record<string, unknown> {
  const existing = snapshot.trustedExecutionFacts[key]
  const container = isDomainTrustedFact(existing)
    ? structuredClone(existing)
    : { schemaVersion: '2.0.0' as const, realEnvironment: {}, gatewayInjection: {} }
  if (!isDomainTrustedFact(existing) && existing !== undefined) {
    const realResults = Object.values(snapshot.executionResults?.realEnvironment ?? {})
    if (realResults.length !== 1) throw runtimeHostError(
      'E2E_RUNTIME_TRUSTED_FACT_DOMAIN_MIGRATION_AMBIGUOUS', 'safety',
      '旧单域可信事实无法唯一绑定到 real resultId',
    )
    const real = realResults[0]!
    const resultId = deriveExecutionResultId(real.caseId, 'real-environment')
    container.realEnvironment[resultId] = key === 'finalization-execution-facts'
      ? real.finalizationFacts ?? existing : existing
  }
  container[domain][resultId] = structuredClone(fact)
  return container
}

function isDomainTrustedFact(value: unknown): value is {
  schemaVersion: '2.0.0'
  realEnvironment: Record<string, unknown>
  gatewayInjection: Record<string, unknown>
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === '2.0.0'
    && typeof (value as Record<string, unknown>).realEnvironment === 'object'
    && (value as Record<string, unknown>).realEnvironment !== null
    && typeof (value as Record<string, unknown>).gatewayInjection === 'object'
    && (value as Record<string, unknown>).gatewayInjection !== null
}

async function executeWithOwnerHeartbeat<T>(
  owner: RuntimeExecutionOwner,
  operation: () => Promise<T>,
): Promise<T> {
  let heartbeatError: unknown
  let pendingHeartbeat = Promise.resolve()
  const timer = setInterval(() => {
    pendingHeartbeat = pendingHeartbeat.then(async () => {
      if (heartbeatError !== undefined) return
      try { await owner.renew() } catch (error) { heartbeatError = error }
    })
  }, owner.heartbeatIntervalMs)
  timer.unref?.()
  try {
    const result = await operation()
    await pendingHeartbeat
    if (heartbeatError !== undefined) throw heartbeatError
    return result
  } finally { clearInterval(timer) }
}

function asRuntimeError(error: unknown): E2EError {
  if (error instanceof E2EError) return error
  return runtimeHostError(
    'E2E_RUNTIME_INTERNAL_ERROR',
    'internal',
    'Runtime Host 处理请求时发生内部错误',
    error,
  )
}

function clearLocalConfirmation(
  snapshot: RuntimeRunSnapshot,
  confirmed: PendingLocalApprovalConfirmation | undefined,
): RuntimeRunSnapshot {
  if (confirmed === undefined) return snapshot
  const { ['pending-local-approval']: _consumed, ...trustedExecutionFacts } = snapshot.trustedExecutionFacts
  return { ...snapshot, trustedExecutionFacts }
}

function confirmationHostError(code: string): E2EError {
  return runtimeHostError(code, 'safety', '本地确认缺失、失效或与当前可信 Run 不一致')
}

function manualResultPersistenceError(cause: unknown): E2EError {
  // 绑定、过期、容量、重复及状态损坏等显式安全错误必须终态化，不能伪装成可恢复 I/O。
  if (cause instanceof E2EError) return cause
  return runtimeHostError(
    'E2E_RUNTIME_MANUAL_RESULT_PERSISTENCE_PENDING',
    'safety',
    'Authority 已完成 ManualResult 操作，但 Run Store outcome 尚未确认持久化；请求保持 pending 并可按原字节恢复',
    cause,
  )
}

function runtimeHostError(
  code: string,
  category: 'input' | 'environment' | 'safety' | 'automation' | 'artifact' | 'internal',
  message: string,
  cause?: unknown,
): E2EError {
  return new E2EError({ code, category, message: `${code}: ${message}`, retryable: false, cause })
}

/** 只公开固定格式错误码，避免把浏览器、文件路径、环境变量或网络响应带入 RPC。 */
function safeExecutionCauseCode(cause: unknown): string | undefined {
  // Packed workspaces can load more than one @mutil-skills/e2e-contracts instance, so an
  // E2EError created across that package boundary is not guaranteed to satisfy instanceof.
  // Only project the fixed-format code; never expose the foreign error message or stack.
  if (typeof cause === 'object' && cause !== null && 'code' in cause
    && typeof cause.code === 'string' && /^E2E_[A-Z0-9_]+$/.test(cause.code)) {
    // Resource settlement deliberately wraps the operation error and every cleanup error.
    // Prefer the nested fixed code so operators can distinguish the execution failure that
    // triggered cleanup from the generic settlement wrapper without leaking raw messages.
    if (cause.code === 'E2E_RUNTIME_CLEANUP_FAILED' && 'cause' in cause) {
      const nested = safeExecutionCauseCode(cause.cause)
      if (nested !== undefined) return nested
    }
    return cause.code
  }
  if (cause instanceof AggregateError) {
    for (const error of cause.errors) {
      const code = safeExecutionCauseCode(error)
      if (code !== undefined) return code
    }
  }
  return undefined
}

function blockedError(code: string): E2EError {
  return runtimeHostError(
    code,
    'automation',
    '该命令需要的审批、Authority 或执行事实尚不可用',
  )
}
