import {
  InjectionApprovalSubjectSchema,
  ArtifactSchemaRegistry,
  RuntimeDoctorReportSchema,
  RuntimeResponseEnvelopeSchema,
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
  type DecisionReceipt,
  type DecisionSubject,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type SignedGrant,
  type WorkflowNode,
} from '@mutil-skills/e2e-contracts'
import { randomUUID } from 'node:crypto'
import {
  computePrdRevision,
  createWorkflow,
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
import { bindManualResultDraftToRuntimeSnapshot } from './runtime-manual-results.js'
import { persistFinalizedApprovalOutcome } from './finalized-approval-outcome.js'
import {
  assertRuntimeReadSnapshotReady,
  executeRuntimeInjection,
  executeRuntimeRead,
  executeRuntimeWrite,
  type RuntimeInjectionExecutorCapability,
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
  projectFileReader?: SecureProjectFileReader
  authorityHostFactory?: () => Promise<Partial<Pick<RuntimeAuthorityHost,
    'requestApproval' | 'recoverApproval' | 'acknowledgeFinalization'
    | 'prepareManualResult' | 'requestManualResultRole' | 'recoverManualResultRole'>>>
  presentUserPresenceUrl?(url: string): void | Promise<void>
  readExecutor?: RuntimeReadExecutorCapability
  writeExecutor?: RuntimeWriteExecutorCapability
  injectionExecutor?: RuntimeInjectionExecutorCapability
  preflightExecutor?: RuntimePreflightCapability
  writeProduction?: RuntimeWriteProductionCapability
  projectPublisherFactory?: (projectRoot: string) => Pick<ProjectPublisher, 'renderActiveReport'>
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
      if (request.command === 'get-status') return await this.getStatus(request, requestDigest)
      if (request.command === 'submit-candidate') return await this.submitCandidate(request, requestDigest)
      if (request.command === 'open-approval') return await this.openApproval(request, requestDigest)
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
    const projectPolicyBytes = await reader.readFile(identity, request.payload.projectPolicyPath)
    const prdRevision = computePrdRevision({
      normalizedPrd: decodeUtf8(prdBytes, 'PRD'),
      sourceIdentity: { sourceId: 'PRD-BODY', version: '1', kind: 'file' },
      attachments: [],
    }).prdRevision
    const timestamp = this.dependencies.now().toISOString()
    const snapshot: RuntimeRunSnapshot = {
      schemaVersion: '1.4.0',
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
      trustedExecutionFacts: {},
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
      const outcome = await this.dependencies.runStore.readRunOutcome(
        identity.digest,
        request.payload.runId,
        request.requestId,
        requestDigest,
        (snapshot) => {
          this.requireInstallation(snapshot)
          return this.successResponse(request.requestId, statusResult(snapshot))
        },
        lock,
      )
      return RuntimeResponseEnvelopeSchema.parse(outcome)
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
      const response = this.successResponse(request.requestId, {
        runId: snapshot.runId,
        assetId: snapshot.assetId,
        generationId: publication.active.generationId,
        generationDigest: publication.active.generationDigest,
        terminalVerdict: publication.active.terminalVerdict,
        report: publication.rendered,
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
      throw runtimeHostError(
        'E2E_RUNTIME_FINALIZATION_RECOVERY_REQUIRED', 'safety',
        'finalization 可能已发布但 Run outcome 尚未闭合；必须以同一请求恢复且不得重复执行副作用',
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
      throw runtimeHostError(
        'E2E_RUNTIME_FINALIZATION_RECOVERY_REQUIRED', 'safety',
        'active generation 已复读但 Run outcome 未原子闭合；请以同一请求恢复', cause,
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
      const outcome = await this.dependencies.runStore.updateRunOutcome(
        identity.digest,
        request.payload.runId,
        request.requestId,
        requestDigest,
        (snapshot) => {
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

          const existing = snapshot.frozenArtifacts[request.payload.artifactType]
          if (existing !== undefined
            && canonicalizeJson(existing) !== canonicalizeJson(candidate)) {
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
          const nextAfterBinding = bindingAsset
            && frozenArtifacts['test-cases'] !== undefined
            && frozenArtifacts['execution-contract'] !== undefined
            ? 'awaiting-execution-approval' as const : undefined
          const workflow = next === undefined && nextAfterBinding === undefined
            ? snapshot.workflow
            : transitionWorkflow({
                state: snapshot.workflow,
                next: next ?? nextAfterBinding!,
                reason: `accepted candidate ${request.payload.artifactType}:${candidate.contentDigest}`,
                timestamp: this.dependencies.now().toISOString(),
                engineVersion: this.dependencies.installation.version,
              }).state
          const updated: RuntimeRunSnapshot = {
            ...snapshot,
            workflow,
            artifactDigests: {
              ...snapshot.artifactDigests,
              [request.payload.artifactType]: candidate.contentDigest,
            },
            frozenArtifacts,
            updatedAt: this.dependencies.now().toISOString(),
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
  ): Promise<RuntimeResponseEnvelope> {
    const authorityHostFactory = this.dependencies.authorityHostFactory
    if (authorityHostFactory === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const authorityHost = await authorityHostFactory()
    if (authorityHost.requestApproval === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    requireApprovalType(initial, request.payload.approvalType)
    assertRuntimeGrantSubject(initial, request.payload.approvalType, request.payload.grantSubject)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(
      initial,
      request.payload.approvalType,
      request.payload.grantSubject,
    )
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
      const response = this.successResponse(request.requestId, {
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
                (snapshot) => ({ snapshot: { ...snapshot,
                  workflow: transitionWorkflow({
                    state: snapshot.workflow, next: 'scope-approved',
                    reason: 'scope user-presence approval completed',
                    timestamp: this.dependencies.now().toISOString(),
                    engineVersion: this.dependencies.installation.version,
                  }).state,
                  updatedAt: this.dependencies.now().toISOString(),
                }, response }),
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
                snapshot: {
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
                },
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
            update: (snapshot) => ({
              ...snapshot,
              workflow: transitionWorkflow({
                state: snapshot.workflow,
                next: factType === 'signed-discovery-grant' ? 'discovery-approved' : 'execution-approved',
                reason: `${request.payload.approvalType} grant finalized`,
                timestamp: this.dependencies.now().toISOString(),
                engineVersion: this.dependencies.installation.version,
                ...(factType === 'signed-execution-grant' ? { executionGrantValid: true } : {}),
              }).state,
              updatedAt: this.dependencies.now().toISOString(),
            }),
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
          'Authority 已最终化 Grant，但 Run Store outcome 尚未持久化；请求保持 pending 并可恢复', cause,
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
    await this.dependencies.presentUserPresenceUrl?.(session.url)
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

  private async prepareManualResult(
    request: Extract<RuntimeRequestEnvelope, { command: 'prepare-manual-result' }>,
    requestDigest: string,
    _requestWasPending: boolean,
  ): Promise<RuntimeResponseEnvelope> {
    const authorityHostFactory = this.dependencies.authorityHostFactory
    if (authorityHostFactory === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const authorityHost = await authorityHostFactory()
    if (authorityHost.prepareManualResult === undefined) {
      throw blockedError('E2E_MANUAL_RESULT_AUTHORITY_NOT_READY')
    }
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    requireManualResultWorkflow(initial)
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
  ): Promise<RuntimeResponseEnvelope> {
    const authorityHostFactory = this.dependencies.authorityHostFactory
    if (authorityHostFactory === undefined) throw blockedError('E2E_RUNTIME_AUTHORITY_NOT_READY')
    const authorityHost = await authorityHostFactory()
    if (authorityHost.requestManualResultRole === undefined
      && authorityHost.recoverManualResultRole === undefined) {
      throw blockedError('E2E_MANUAL_RESULT_AUTHORITY_NOT_READY')
    }
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    const initial = await this.readLockedRun(identity.digest, request.payload.runId)
    this.requireInstallation(initial)
    requireManualResultWorkflow(initial)
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
          role: request.payload.role, ...finalized,
        })
        if (finalized.status === 'awaiting-reviewer') {
          try {
            return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.readRunOutcome(
              identity.digest, current.runId, request.requestId, requestDigest, () => response, lock,
            ))
          } catch (cause) {
            throw manualResultPersistenceError(cause)
          }
        }
        try {
          const capability = await this.dependencies.runStore.authorizeTrustedFactWrite(
            identity.digest, current.runId, lock,
          )
          return RuntimeResponseEnvelopeSchema.parse(
            await this.dependencies.runStore.appendTrustedManualResultOutcome({
              capability, requestId: request.requestId, requestDigest,
              result: finalized.result, response,
            }),
          )
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
    await this.dependencies.presentUserPresenceUrl?.(session.url)
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
    if (initial.workflow.current !== 'discovery-approved') throw runtimeHostError(
      'E2E_RUNTIME_WORKFLOW_STATE_MISMATCH', 'input', 'run-preflight 仅允许 discovery-approved Run',
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
        const entered = transitionWorkflow({
          state: current.workflow, next: 'preflight-readonly', reason: `browser preflight ${result.output.status}`,
          timestamp: this.dependencies.now().toISOString(),
          engineVersion: this.dependencies.installation.version,
        }).state
        const finalWorkflow = result.output.status === 'ready' ? entered : transitionWorkflow({
          state: entered,
          next: result.output.status,
          reason: result.output.reasonCode ?? 'browser preflight blocked',
          timestamp: this.dependencies.now().toISOString(),
          engineVersion: this.dependencies.installation.version,
        }).state
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
                const { preflightAttempt: _completedPreflight, ...withoutPreflight } = snapshot
                return {
                  ...withoutPreflight, workflow: finalWorkflow,
                  updatedAt: this.dependencies.now().toISOString(),
                }
              },
            }),
          )
        }
        return RuntimeResponseEnvelopeSchema.parse(await this.dependencies.runStore.updateRunOutcome(
          identity.digest, current.runId, request.requestId, requestDigest,
          (snapshot) => {
            const { preflightAttempt: _completedPreflight, ...withoutPreflight } = snapshot
            return {
              snapshot: {
                ...withoutPreflight, runRevision: (snapshot.runRevision ?? 0) + 1,
                workflow: finalWorkflow, updatedAt: this.dependencies.now().toISOString(),
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
    const startLock = await this.dependencies.runStore.acquireRunLock(identity.digest, request.payload.runId)
    let started: Awaited<ReturnType<RuntimeRunStore['beginExecutionAttempt']>> | undefined
    let executionMode: 'read' | 'write' | 'injection' | undefined
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
    if (executionMode === 'write') {
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
          : await executeRuntimeInjection(this.dependencies.injectionExecutor!, {
            snapshot: started!.snapshot, attemptId: started!.attempt.attemptId,
          }))
    } catch (cause) {
      let releaseCause: unknown
      try { await started.owner.release() } catch (error) { releaseCause = error }
      throw runtimeHostError(
        executionMode === 'read' ? 'E2E_RUNTIME_READ_EXECUTION_CRASHED' : 'E2E_RUNTIME_EXECUTION_CRASHED', 'safety',
        '可信执行器异常退出；Run 保持 running-real fenced attempt 等待显式恢复',
        releaseCause === undefined ? cause : new AggregateError([cause, releaseCause]),
      )
    }
    if (executionMode === 'write') {
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
      : executionMode === 'write'
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
    const writeExecution = executionMode === 'write'
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
                  snapshot, 'quarantined-evidence', injectionExecution.resultId, quarantinedEvidence,
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
                  snapshot, 'finalization-execution-facts', persistedInjectionExecution.resultId,
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

  private async resumeRun(
    request: Extract<RuntimeRequestEnvelope, { command: 'resume-run' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const decision = parseResumeDecision(request.payload.decision)
    const identity = await resolveProjectIdentity(request.projectRoot, this.projectFileReader())
    if (decision.kind === 'recover-write-attempt') {
      const production = this.dependencies.writeProduction
      if (production === undefined) throw blockedError('E2E_RUNTIME_WRITE_RECOVERY_NOT_READY')
      const result = await recoverRuntimeProductionWrite(production, { projectIdentityDigest: identity.digest,
        runId: request.payload.runId, attemptId: decision.expectedAttemptId })
      const response = this.successResponse(request.requestId, {
        runId: request.payload.runId, recoveredAttemptId: decision.expectedAttemptId, ...result,
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

function runtimeExecutionMode(snapshot: RuntimeRunSnapshot): 'read' | 'write' | 'injection' {
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
  const actions = typeof content === 'object' && content !== null && !Array.isArray(content)
    ? (content as Record<string, unknown>).actions : undefined
  if (!Array.isArray(actions) || actions.length !== 1 || typeof actions[0] !== 'object'
    || actions[0] === null || Array.isArray(actions[0])) throw runtimeHostError(
    'E2E_RUNTIME_ACTION_SET_UNSUPPORTED', 'safety', 'execute-run 只接受唯一冻结 action',
  )
  return (actions[0] as Record<string, unknown>).effect === 'reversible-write' ? 'write' : 'read'
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
    && candidate.transport === 'http' && candidate.effect === 'reversible-write')
  if (capabilities.length !== 1) throw runtimeHostError(
    'E2E_RUNTIME_WRITE_CAPABILITY_BINDING_MISMATCH', 'safety', '写 action 未唯一绑定 HTTP capability',
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
  return {
    runId: snapshot.runId,
    assetId: snapshot.assetId,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    generationId: snapshot.runId,
    prdRevision: snapshot.artifactDigests['prd-source'],
    workflow: snapshot.workflow,
  }
}

function statusResult(snapshot: RuntimeRunSnapshot): Record<string, unknown> {
  return {
    runId: snapshot.runId,
    assetId: snapshot.assetId,
    projectIdentityDigest: snapshot.projectIdentityDigest,
    runtimeInstallationDigest: snapshot.runtimeInstallationDigest,
    generationId: snapshot.runId,
    prdRevision: snapshot.artifactDigests['prd-source'],
    workflow: snapshot.workflow,
    artifactDigests: snapshot.artifactDigests,
    ...(snapshot.pendingDecision === undefined ? {} : { pendingDecision: snapshot.pendingDecision }),
  }
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
  return requestId.length <= 252
    ? `RUN-${requestId}`
    : `RUN-${digestText('e2e-runtime-run-id/v1', requestId).slice('sha256:'.length, 'sha256:'.length + 32)}`
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
  injectionResultId: string,
  injectionFact: unknown,
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
  container.gatewayInjection[injectionResultId] = structuredClone(injectionFact)
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

function blockedError(code: string): E2EError {
  return runtimeHostError(
    code,
    'automation',
    '该命令需要的审批、Authority 或执行事实尚不可用',
  )
}
