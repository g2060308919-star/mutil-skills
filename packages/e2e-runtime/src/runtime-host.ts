import {
  ArtifactSchemaRegistry,
  RuntimeDoctorReportSchema,
  RuntimeResponseEnvelopeSchema,
  canonicalizeJson,
  digestArtifactContent,
  digestBytes,
  digestText,
  E2EError,
  canonicalGrantApprovalSubjectDigest,
  canonicalGrantApprovalType,
  type ArtifactDocument,
  type ArtifactType,
  type ApprovalGrantSubject,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type WorkflowNode,
} from '@mutil-skills/e2e-contracts'
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
  type RuntimeRunLock,
  type RuntimeRunSnapshot,
} from './run-store.js'
import { SecureProjectFileReader } from './secure-project-files.js'
import {
  computeRuntimeApprovalSubjectDigest,
  type RuntimeAuthorityHost,
} from './authority-host.js'
import { persistFinalizedApprovalOutcome } from './finalized-approval-outcome.js'

export interface RuntimeHostDependencies {
  installation: RuntimeInstallation
  doctor(): Promise<RuntimeDoctorReport>
  runStore: RuntimeRunStore
  now(): Date
  projectFileReader?: SecureProjectFileReader
  authorityHostFactory?: () => Promise<Pick<RuntimeAuthorityHost, 'requestApproval'>
    & Partial<Pick<RuntimeAuthorityHost, 'recoverApproval' | 'acknowledgeFinalization'>>>
  presentUserPresenceUrl?(url: string): void | Promise<void>
}

export class E2ERuntimeHost {
  constructor(private readonly dependencies: RuntimeHostDependencies) {}

  async handle(
    request: RuntimeRequestEnvelope,
    requestBytes: string | Uint8Array,
  ): Promise<RuntimeResponseEnvelope> {
    let requestDigest: string
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
      throw blockedError('E2E_RUNTIME_COMMAND_NOT_READY')
    } catch (error) {
      const response = this.errorResponse(request.requestId, asRuntimeError(error))
      if (error instanceof E2EError && (
        error.code === 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING'
        || error.code === 'E2E_APPROVAL_FINALIZATION_RECOVERY_REQUIRED'
        || error.code === 'E2E_RUNTIME_APPROVAL_RECOVERY_BINDING_CHANGED'
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
      schemaVersion: '1.0.0',
      runId,
      assetId: request.payload.assetId,
      projectIdentityDigest: identity.digest,
      runtimeInstallationDigest: this.dependencies.installation.installationDigest,
      workflow: createWorkflow(),
      artifactDigests: {
        'prd-source': prdRevision,
        'project-policy-source': digestBytes('e2e-project-policy-source/v1', projectPolicyBytes),
      },
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

  private async submitCandidate(
    request: Extract<RuntimeRequestEnvelope, { command: 'submit-candidate' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
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

          const next = nextWorkflowNode(snapshot.workflow.current, request.payload.artifactType)
          if (next === undefined) {
            throw blockedError(missingCapabilityCode(snapshot.workflow.current))
          }
          const transition = transitionWorkflow({
            state: snapshot.workflow,
            next,
            reason: `accepted candidate ${request.payload.artifactType}:${candidate.contentDigest}`,
            timestamp: this.dependencies.now().toISOString(),
            engineVersion: this.dependencies.installation.version,
          })
          const updated: RuntimeRunSnapshot = {
            ...snapshot,
            workflow: transition.state,
            artifactDigests: {
              ...snapshot.artifactDigests,
              [request.payload.artifactType]: candidate.contentDigest,
            },
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
        grant: { grantId: string }
        approvalBinding: { runId: string; approvalType: 'discovery' | 'execution'; subjectDigest: string; installationDigest: string }
      },
    ): Promise<RuntimeResponseEnvelope> => {
      const response = this.successResponse(request.requestId, {
        runId: current.runId, approvalType: request.payload.approvalType, subjectDigest, sessionId,
        ...(finalized === undefined ? {} : {
          signedGrant: finalized.grant, approvalBinding: finalized.approvalBinding,
        }),
      })
      const persist = async () => RuntimeResponseEnvelopeSchema.parse(
        await this.dependencies.runStore.readRunOutcome(
          identity.digest, current.runId, request.requestId, requestDigest, () => response, lock,
        ),
      )
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

function nextWorkflowNode(current: WorkflowNode, artifactType: ArtifactType): WorkflowNode | undefined {
  const edge = CANDIDATE_EDGES[current]
  return edge?.artifactType === artifactType ? edge.next : undefined
}

const CANDIDATE_EDGES: Partial<Record<WorkflowNode, { artifactType: ArtifactType; next: WorkflowNode }>> = {
  created: { artifactType: 'prd-request', next: 'source-frozen' },
  'source-frozen': { artifactType: 'acceptance-scope', next: 'awaiting-scope-approval' },
  'scope-approved': { artifactType: 'requirement-model', next: 'modeled' },
  modeled: { artifactType: 'coverage-universe', next: 'coverage-audited' },
  'discovery-approved': { artifactType: 'browser-preflight', next: 'preflight-readonly' },
  'preflight-readonly': { artifactType: 'browser-action-map', next: 'binding-draft' },
  'execution-approved': { artifactType: 'regression-manifest', next: 'compiled' },
  diagnosing: { artifactType: 'diagnosis', next: 'finalizing' },
  finalizing: { artifactType: 'generation-manifest', next: 'publication-ready' },
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
    diagnosing: ['privacy'],
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

function asRuntimeError(error: unknown): E2EError {
  if (error instanceof E2EError) return error
  return runtimeHostError(
    'E2E_RUNTIME_INTERNAL_ERROR',
    'internal',
    'Runtime Host 处理请求时发生内部错误',
    error,
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
