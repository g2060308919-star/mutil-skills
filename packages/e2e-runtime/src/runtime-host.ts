import {
  ArtifactSchemaRegistry,
  RuntimeDoctorReportSchema,
  RuntimeResponseEnvelopeSchema,
  canonicalizeJson,
  digestArtifactContent,
  digestBytes,
  digestText,
  E2EError,
  type ArtifactDocument,
  type ArtifactType,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type WorkflowNode,
} from '@mutil-skills/e2e-contracts'
import {
  computePrdRevision,
  createWorkflow,
  transitionWorkflow,
} from '@mutil-skills/e2e-engine'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { runtimeErrorResponse } from './protocol.js'
import { resolveProjectIdentity, type ProjectIdentity } from './project-identity.js'
import type { RuntimeInstallation } from './runtime-discovery.js'
import type { RuntimeDoctorReport } from './runtime-doctor.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from './run-store.js'

export interface RuntimeHostDependencies {
  installation: RuntimeInstallation
  doctor(): Promise<RuntimeDoctorReport>
  runStore: RuntimeRunStore
  now(): Date
}

export class E2ERuntimeHost {
  constructor(private readonly dependencies: RuntimeHostDependencies) {}

  async handle(
    request: RuntimeRequestEnvelope,
    requestBytes?: string | Uint8Array,
  ): Promise<RuntimeResponseEnvelope> {
    let requestDigest: string | undefined
    try {
      requestDigest = runtimeRequestDigest(request, requestBytes)
      if (request.command === 'doctor') return await this.doctorResponse(request)
      if (request.command === 'create-run') return await this.createRun(request, requestDigest)
      if (request.command === 'get-status') return await this.getStatus(request, requestDigest)
      if (request.command === 'submit-candidate') return await this.submitCandidate(request, requestDigest)
      throw blockedError('E2E_RUNTIME_COMMAND_NOT_READY')
    } catch (error) {
      const response = this.errorResponse(request.requestId, asRuntimeError(error))
      if (requestDigest !== undefined) await this.persistErrorReplay(request, requestDigest, response)
      return response
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
    const identity = await resolveProjectIdentity(request.projectRoot)
    const runId = runIdForRequest(request.requestId)
    const lock = await this.dependencies.runStore.acquireRunLock(identity.digest, runId)
    try {
      const replay = await this.dependencies.runStore.getRecordedResponse(
        identity.digest, runId, request.requestId, requestDigest,
      )
      if (replay !== undefined) return RuntimeResponseEnvelopeSchema.parse(replay)

      const existing = await this.dependencies.runStore.getRun(identity.digest, runId)
      if (existing !== undefined) {
        const recovered = this.successResponse(request.requestId, createRunResult(existing))
        await this.dependencies.runStore.recordResponse(
          identity.digest, runId, request.requestId, requestDigest, recovered,
        )
        return recovered
      }

      const doctor = RuntimeDoctorReportSchema.parse(await this.dependencies.doctor())
      if (!doctor.ready) {
        throw runtimeHostError(
          'E2E_RUNTIME_NOT_READY',
          'environment',
          'Runtime Doctor 尚未证明基础运行能力就绪',
        )
      }

      const prdBytes = await readBoundProjectFile(identity, request.payload.prdSource.path)
      const projectPolicyBytes = await readBoundProjectFile(identity, request.payload.projectPolicyPath)
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
      await this.dependencies.runStore.createRun(snapshot)
      const response = this.successResponse(request.requestId, createRunResult(snapshot))
      await this.dependencies.runStore.recordResponse(
        identity.digest, runId, request.requestId, requestDigest, response,
      )
      return response
    } finally {
      await lock.close()
    }
  }

  private async getStatus(
    request: Extract<RuntimeRequestEnvelope, { command: 'get-status' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot)
    const lock = await this.dependencies.runStore.acquireRunLock(identity.digest, request.payload.runId)
    try {
      const replay = await this.dependencies.runStore.getRecordedResponse(
        identity.digest, request.payload.runId, request.requestId, requestDigest,
      )
      if (replay !== undefined) return RuntimeResponseEnvelopeSchema.parse(replay)
      const snapshot = await this.requireRun(identity.digest, request.payload.runId)
      const response = this.successResponse(request.requestId, statusResult(snapshot))
      await this.dependencies.runStore.recordResponse(
        identity.digest, snapshot.runId, request.requestId, requestDigest, response,
      )
      return response
    } finally {
      await lock.close()
    }
  }

  private async submitCandidate(
    request: Extract<RuntimeRequestEnvelope, { command: 'submit-candidate' }>,
    requestDigest: string,
  ): Promise<RuntimeResponseEnvelope> {
    const identity = await resolveProjectIdentity(request.projectRoot)
    const lock = await this.dependencies.runStore.acquireRunLock(identity.digest, request.payload.runId)
    try {
      const replay = await this.dependencies.runStore.getRecordedResponse(
        identity.digest, request.payload.runId, request.requestId, requestDigest,
      )
      if (replay !== undefined) return RuntimeResponseEnvelopeSchema.parse(replay)
      const snapshot = await this.requireRun(identity.digest, request.payload.runId)
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
      const updated = await this.dependencies.runStore.updateRun(
        identity.digest,
        snapshot.runId,
        (current) => ({
          ...current,
          workflow: transition.state,
          artifactDigests: {
            ...current.artifactDigests,
            [request.payload.artifactType]: candidate.contentDigest,
          },
          updatedAt: this.dependencies.now().toISOString(),
        }),
        'candidate-accepted',
      )
      const response = this.successResponse(request.requestId, {
        runId: updated.runId,
        workflow: updated.workflow,
        acceptedArtifact: {
          artifactType: request.payload.artifactType,
          contentDigest: candidate.contentDigest,
        },
      })
      await this.dependencies.runStore.recordResponse(
        identity.digest, updated.runId, request.requestId, requestDigest, response,
      )
      return response
    } finally {
      await lock.close()
    }
  }

  private async requireRun(projectIdentityDigest: string, runId: string): Promise<RuntimeRunSnapshot> {
    const snapshot = await this.dependencies.runStore.getRun(projectIdentityDigest, runId)
    if (snapshot === undefined) {
      throw runtimeHostError('E2E_RUNTIME_RUN_NOT_FOUND', 'input', '当前项目身份下不存在该 Run')
    }
    if (snapshot.runtimeInstallationDigest !== this.dependencies.installation.installationDigest) {
      throw runtimeHostError(
        'E2E_RUNTIME_INSTALLATION_BINDING_MISMATCH',
        'environment',
        'Run 绑定的 active Runtime generation 已改变',
      )
    }
    return snapshot
  }

  private async persistErrorReplay(
    request: RuntimeRequestEnvelope,
    requestDigest: string,
    response: RuntimeResponseEnvelope,
  ): Promise<void> {
    if (request.command === 'doctor') return
    try {
      const identity = await resolveProjectIdentity(request.projectRoot)
      const runId = request.command === 'create-run'
        ? runIdForRequest(request.requestId)
        : request.payload.runId
      const lock = await this.dependencies.runStore.acquireRunLock(identity.digest, runId)
      try {
        await this.dependencies.runStore.recordResponse(
          identity.digest, runId, request.requestId, requestDigest, response,
        )
      } finally {
        await lock.close()
      }
    } catch {
      // The original fail-closed response wins; journal/lock failures must not be hidden by replay bookkeeping.
    }
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

async function readBoundProjectFile(identity: ProjectIdentity, inputPath: string): Promise<Buffer> {
  const candidate = isAbsolute(inputPath) ? inputPath : resolve(identity.realRoot, inputPath)
  const resolved = await realpath(candidate)
  const fromRoot = relative(identity.realRoot, resolved)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)
    || (await lstat(candidate)).isSymbolicLink()) {
    throw runtimeHostError(
      'E2E_RUNTIME_PROJECT_FILE_OUTSIDE_ROOT',
      'safety',
      'PRD 与 project policy 必须是项目真实根目录内的普通文件',
    )
  }
  const bytes = await readFile(resolved)
  return bytes
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
  requestBytes?: string | Uint8Array,
): string {
  if (requestBytes === undefined) {
    return digestText('e2e-runtime-request/v1', canonicalizeJson(request))
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
