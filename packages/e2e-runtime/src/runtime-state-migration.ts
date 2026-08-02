import {
  ArtifactSchemaRegistry,
  ArtifactTypeSchema,
  CompiledPrdRunPlanSchema,
  ManualResultSchema,
  SignedGrantSchema,
  AssetIdSchema,
  canonicalizeJson,
  E2EError,
  WorkflowStateSchema,
} from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import type { RuntimeRunSnapshot } from './run-store.js'
import {
  BrowserPreflightFactSchema,
  RuntimePreflightPreparationSchema,
} from './runtime-preflight.js'
import { RuntimeWriteAttemptRecordSchema } from './write-attempt.js'
import { parseRuntimeInjectionExecutionOutput, parseRuntimeWriteExecutionOutput } from './runtime-execution-batch.js'
import { RuntimeReadExecutionRecordSchema } from './runtime-read-result.js'
import {
  PendingLocalApprovalConfirmationSchema,
  PrdSemanticConfirmationSchema,
  PrdSourceBundleSnapshotSchema,
  PrdSourceSnapshotSchema,
  PrdUnderstandingContractFactSchema,
  PrdUnderstandingPreparedFactSchema,
} from './local-approval-confirmations.js'
import {
  createLegacySingleCaseSchedule,
  parseCaseSchedule,
  type RuntimeCaseSchedule,
} from './multi-case-scheduler.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const RunIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const PendingWorkflowDecisionSchema = z.object({
  decisionId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  resumeState: WorkflowStateSchema.shape.current,
  pausedSequence: z.number().int().positive(),
  pausedChainDigest: DigestSchema,
  pauseEventDigest: DigestSchema,
  reason: z.string().min(1),
  pendingDigest: DigestSchema,
}).strict()
const RuntimeExecutionAttemptSchema = z.object({
  attemptId: z.string().uuid().transform((value) => `ATTEMPT-${value}`).or(
    z.string().regex(/^ATTEMPT-[a-f0-9-]{36}$/),
  ),
  requestId: RunIdSchema,
  requestDigest: DigestSchema.optional(),
  fencingToken: z.number().int().positive(),
  revision: z.number().int().positive(),
  startedAt: z.string().datetime(),
}).strict()
const RuntimePreflightAttemptSchema = z.object({
  requestId: RunIdSchema,
  requestDigest: DigestSchema,
  revision: z.number().int().positive(),
  startedAt: z.string().datetime(),
  preparation: RuntimePreflightPreparationSchema,
}).strict()

export const MAX_FROZEN_ARTIFACT_BYTES = 2 * 1024 * 1024
export const MAX_FROZEN_ARTIFACT_TOTAL_BYTES = 16 * 1024 * 1024

const CanonicalJsonRecordSchema = z.record(z.unknown()).superRefine((records, context) => {
  let totalBytes = 0
  for (const [key, value] of Object.entries(records)) {
    try {
      const bytes = Buffer.byteLength(canonicalizeJson(value), 'utf8')
      totalBytes += bytes
      if (bytes > MAX_FROZEN_ARTIFACT_BYTES) context.addIssue({
        code: 'custom', path: [key], message: '单项冻结资产超过容量上限',
      })
    } catch {
      context.addIssue({ code: 'custom', path: [key], message: '冻结资产必须是 canonical JSON' })
    }
  }
  if (totalBytes > MAX_FROZEN_ARTIFACT_TOTAL_BYTES) context.addIssue({
    code: 'custom', message: '冻结资产总量超过容量上限',
  })
})

const FrozenArtifactsSchema = CanonicalJsonRecordSchema.superRefine((records, context) => {
  for (const [key, value] of Object.entries(records)) {
    const artifactType = ArtifactTypeSchema.safeParse(key)
    if (!artifactType.success) {
      context.addIssue({ code: 'custom', path: [key], message: '冻结资产 key 不是已知 artifactType' })
      continue
    }
    const parsed = ArtifactSchemaRegistry[artifactType.data].safeParse(value)
    if (!parsed.success || parsed.data.artifactType !== key) context.addIssue({
      code: 'custom', path: [key], message: '冻结资产未通过对应的严格 Artifact schema',
    })
  }
})

const TrustedExecutionFactsSchema = z.record(z.unknown()).superRefine((facts, context) => {
  const allowed = new Set([
    'signed-discovery-grant', 'signed-execution-grant', 'browser-preflight',
    'finalization-material', 'finalization-execution-facts', 'quarantined-evidence',
    'manual-results-by-id',
    'approval-mode', 'pending-local-approval', 'prd-source-snapshot', 'prd-source-bundle',
    'prd-understanding-contract', 'prd-understanding-prepared', 'prd-semantic-confirmation',
  ])
  if (Object.keys(facts).length > allowed.size) context.addIssue({ code: 'custom', message: '可信执行事实数量超限' })
  let trustedFactBytes = 0
  for (const [key, value] of Object.entries(facts)) {
    try {
      const bytes = Buffer.byteLength(canonicalizeJson(value), 'utf8')
      trustedFactBytes += bytes
      if (bytes > 10 * 1024 * 1024) context.addIssue({
        code: 'custom', path: [key], message: '单项可信执行事实超过 10 MiB',
      })
    } catch {
      context.addIssue({ code: 'custom', path: [key], message: '可信执行事实必须是 canonical JSON' })
    }
    if (!allowed.has(key)) {
      context.addIssue({ code: 'custom', path: [key], message: '未知可信执行事实类型' })
      continue
    }
    if (key === 'approval-mode') {
      if (value !== 'local-confirmation' && value !== 'webauthn') context.addIssue({
        code: 'custom', path: [key], message: '审批模式非法',
      })
      continue
    }
    if (key === 'pending-local-approval') {
      if (!PendingLocalApprovalConfirmationSchema.safeParse(value).success) context.addIssue({
        code: 'custom', path: [key], message: '待确认本地审批结构非法',
      })
      continue
    }
    if (key === 'prd-source-snapshot') {
      if (!PrdSourceSnapshotSchema.safeParse(value).success) context.addIssue({
        code: 'custom', path: [key], message: 'PRD 原文快照结构非法',
      })
      continue
    }
    if (key === 'prd-source-bundle') {
      if (!PrdSourceBundleSnapshotSchema.safeParse(value).success) context.addIssue({
        code: 'custom', path: [key], message: 'PRD Source Bundle 快照结构非法',
      })
      continue
    }
    if (key === 'prd-understanding-contract') {
      if (!PrdUnderstandingContractFactSchema.safeParse(value).success) context.addIssue({
        code: 'custom', path: [key], message: 'understand-prd 契约冻结事实结构非法',
      })
      continue
    }
    if (key === 'prd-understanding-prepared') {
      if (!PrdUnderstandingPreparedFactSchema.safeParse(value).success) context.addIssue({
        code: 'custom', path: [key], message: 'understand-prd prepared fact 结构非法',
      })
      continue
    }
    if (key === 'prd-semantic-confirmation') {
      if (!PrdSemanticConfirmationSchema.safeParse(value).success) context.addIssue({
        code: 'custom', path: [key], message: 'PRD 语义确认事实结构非法',
      })
      continue
    }
    if (key === 'browser-preflight') {
      const preflight = BrowserPreflightFactSchema.safeParse(value)
      if (!preflight.success) context.addIssue({ code: 'custom', path: [key], message: 'Browser preflight 事实结构非法' })
      continue
    }
    if (key === 'finalization-material') {
      if (!isPersistedFinalizationMaterialEnvelope(value)) context.addIssue({
        code: 'custom', path: [key], message: 'Production finalization material envelope 非法',
      })
      continue
    }
    if (key === 'finalization-execution-facts') {
      if (!isFinalizationExecutionFacts(value)) context.addIssue({
        code: 'custom', path: [key], message: 'Production execution finalization facts 非法',
      })
      continue
    }
    if (key === 'quarantined-evidence') {
      if (!isQuarantinedEvidenceFacts(value)) context.addIssue({
        code: 'custom', path: [key], message: 'Quarantine evidence facts 非法',
      })
      continue
    }
    if (key === 'manual-results-by-id') {
      if (!isTrustedManualResultSet(value)) context.addIssue({
        code: 'custom', path: [key], message: '可信 ManualResult 集合非法或 key 错绑',
      })
      continue
    }
    const parsed = SignedGrantSchema.safeParse(value)
    const isDiscovery = parsed.success
      && parsed.data.approvalContext.approvalType === 'discovery'
      && 'expectedPageIdentity' in parsed.data.subject
    // `signed-execution-grant` 是 Runtime 的通用执行审批事实槽；具体 Runner
    // （read/write/websocket/SSE/injection）必须在投影时再收窄 Grant 类型。
    // 若在持久层把它误收窄成 ReadGrant，会破坏既有受控执行协议。
    const isExecution = parsed.success
      && parsed.data.approvalContext.approvalType === 'execution'
    if ((key === 'signed-discovery-grant' && !isDiscovery)
      || (key === 'signed-execution-grant' && !isExecution)) {
      context.addIssue({ code: 'custom', path: [key], message: '可信 Grant 事实类型不匹配' })
    }
  }
  if (trustedFactBytes > 16 * 1024 * 1024) context.addIssue({
    code: 'custom', message: '可信执行事实总量超过 16 MiB',
  })
})

function isTrustedManualResultSet(value: unknown): boolean {
  if (!plain(value) || Object.keys(value).length > 10_000) return false
  return Object.entries(value).every(([manualResultId, candidate]) => {
    const parsed = ManualResultSchema.safeParse(candidate)
    return parsed.success && parsed.data.manualResultId === manualResultId
  })
}

function isPersistedFinalizationMaterialEnvelope(value: unknown): boolean {
  if (!plain(value)) return false
  return Object.keys(value).sort().join('\0') === [
    'artifacts', 'attemptId', 'cleanup', 'evidence', 'execution', 'gatewayAudit', 'materialDigest',
    'provenance', 'reportPresentation', 'runId', 'schemaVersion', 'verifierMaterials',
  ].sort().join('\0')
    && value.schemaVersion === '1.0.0'
    && typeof value.materialDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.materialDigest)
    && Array.isArray(value.artifacts) && Array.isArray(value.cleanup) && Array.isArray(value.evidence)
    && plain(value.execution) && plain(value.verifierMaterials)
}

function isFinalizationExecutionFacts(value: unknown): boolean {
  if (!plain(value)) return false
  if (isDomainFactContainer(value)) {
    return Object.values(value.realEnvironment).every(isFinalizationExecutionFacts)
      && Object.values(value.gatewayInjection).every(isFinalizationExecutionFacts)
  }
  const keys = Object.keys(value).sort().join('\0')
  const writeKeys = [
    'browserMeasurements', 'cleanup', 'executionOutcomeReceipt', 'executionOutcomeVerifierMaterial',
    'gatewayAudit', 'gatewayAuditVerifierMaterial', 'isolationMeasurements',
  ].sort().join('\0')
  const boundWriteKeys = [
    'browserMeasurements', 'cleanup', 'executionGrant', 'executionOutcomeReceipt',
    'executionOutcomeVerifierMaterial', 'gatewayAudit', 'gatewayAuditVerifierMaterial',
    'isolationMeasurements',
  ].sort().join('\0')
  const readKeys = [
    'browserMeasurements', 'gatewayAudit', 'gatewayAuditVerifierMaterial', 'isolationMeasurements',
  ].sort().join('\0')
  const injectionKeys = [
    'browserMeasurements', 'executionGrant', 'gatewayAudit', 'gatewayAuditVerifierMaterial',
    'isolationMeasurements',
  ].sort().join('\0')
  return (keys === writeKeys || keys === boundWriteKeys || keys === readKeys || keys === injectionKeys)
    && Object.values(value).every(plainJsonTree)
}

function isQuarantinedEvidenceFacts(value: unknown): boolean {
  if (plain(value) && isDomainFactContainer(value)) {
    return Object.values(value.realEnvironment).every(isQuarantinedEvidenceFacts)
      && Object.values(value.gatewayInjection).every(isQuarantinedEvidenceFacts)
  }
  if (!plain(value) || Object.keys(value).sort().join('\0')
    !== ['attemptId', 'records', 'runId', 'schemaVersion'].sort().join('\0')
    || value.schemaVersion !== '1.0.0' || typeof value.runId !== 'string'
    || typeof value.attemptId !== 'string' || !Array.isArray(value.records)
    || value.records.length !== 2) return false
  const types = new Set<string>()
  for (const record of value.records) {
    if (!plain(record) || Object.keys(record).sort().join('\0')
      !== ['byteLength', 'evidenceType', 'plaintextDigest', 'quarantinePath'].sort().join('\0')
      || !['screenshot', 'dom'].includes(String(record.evidenceType))
      || typeof record.quarantinePath !== 'string' || record.quarantinePath.startsWith('/')
      || record.quarantinePath.includes('\\') || record.quarantinePath.split('/').some((part) => !part || part === '.' || part === '..')
      || typeof record.plaintextDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.plaintextDigest)
      || typeof record.byteLength !== 'number' || !Number.isSafeInteger(record.byteLength)
      || record.byteLength < 0) return false
    types.add(String(record.evidenceType))
  }
  return types.size === 2
}

function isDomainFactContainer(value: Record<string, unknown>): value is Record<string, unknown> & {
  schemaVersion: '2.0.0'; realEnvironment: Record<string, unknown>; gatewayInjection: Record<string, unknown>
} {
  return Object.keys(value).sort().join('\0')
    === ['gatewayInjection', 'realEnvironment', 'schemaVersion'].sort().join('\0')
    && value.schemaVersion === '2.0.0' && plain(value.realEnvironment) && plain(value.gatewayInjection)
    && [...Object.keys(value.realEnvironment), ...Object.keys(value.gatewayInjection)]
      .every((key) => /^RESULT-(?:REAL|INJECTION)-[a-f0-9]{64}$/.test(key))
}

function plainJsonTree(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => plainJsonTree(item, depth + 1))
  return plain(value) && Object.values(value).every((item) => plainJsonTree(item, depth + 1))
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

const WriteAttemptsSchema = z.record(RuntimeWriteAttemptRecordSchema).superRefine((attempts, context) => {
  if (Object.keys(attempts).length > 1_024) context.addIssue({
    code: 'custom', message: 'WriteAttempt 数量超过上限',
  })
  for (const [attemptId, record] of Object.entries(attempts)) {
    if (attemptId !== record.attemptId) context.addIssue({
      code: 'custom', path: [attemptId], message: 'WriteAttempt key 与 attemptId 不一致',
    })
  }
})

const RuntimeExecutionResultsSchema = z.object({
  readEnvironment: z.record(RuntimeReadExecutionRecordSchema).superRefine((results, context) => {
    for (const [actionId, value] of Object.entries(results)) {
      if (value.actionId !== actionId) context.addIssue({
        code: 'custom', path: [actionId], message: '只读环境结果 key 与 actionId 错绑',
      })
    }
  }),
  realEnvironment: z.record(z.unknown()).superRefine((results, context) => {
    for (const [actionId, value] of Object.entries(results)) {
      try { if (parseRuntimeWriteExecutionOutput(value).actionId !== actionId) throw new Error('action mismatch') }
      catch { context.addIssue({ code: 'custom', path: [actionId], message: '真实环境结果不合法或 key 错绑' }) }
    }
  }),
  gatewayInjection: z.record(z.unknown()).superRefine((results, context) => {
    for (const [actionId, value] of Object.entries(results)) {
      try { if (parseRuntimeInjectionExecutionOutput(value).actionId !== actionId) throw new Error('action mismatch') }
      catch { context.addIssue({ code: 'custom', path: [actionId], message: '注入结果不合法或 key 错绑' }) }
    }
  }),
}).strict().default({ readEnvironment: {}, realEnvironment: {}, gatewayInjection: {} })

const RuntimeFinalizationAttemptSchema = z.object({
  attemptId: RunIdSchema,
  requestId: RunIdSchema,
  requestDigest: DigestSchema,
  revision: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
}).strict()

const RuntimePublicationRecordSchema = z.object({
  generationId: RunIdSchema,
  generationDigest: DigestSchema,
  terminalVerdict: z.string().min(1),
  activeReadbackDigest: DigestSchema,
  quarantineDispositionDigest: DigestSchema,
  committedAt: z.string().datetime(),
}).strict()

const RuntimeRunSnapshotSchema = z.object({
  schemaVersion: z.literal('1.8.0'),
  runId: RunIdSchema,
  assetId: AssetIdSchema,
  projectIdentityDigest: DigestSchema,
  runtimeInstallationDigest: DigestSchema,
  runRevision: z.number().int().nonnegative().default(0),
  executionAttempt: RuntimeExecutionAttemptSchema.optional(),
  preflightAttempt: RuntimePreflightAttemptSchema.optional(),
  preflightBlocker: z.object({
    status: z.enum(['input-blocked', 'environment-blocked']),
    reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
    blockedAt: z.string().datetime(),
    attemptCount: z.number().int().positive(),
    resumeState: z.literal('preflight-readonly'),
  }).strict().optional(),
  finalizationAttempt: RuntimeFinalizationAttemptSchema.optional(),
  publication: RuntimePublicationRecordSchema.optional(),
  workflow: WorkflowStateSchema,
  pendingDecision: PendingWorkflowDecisionSchema.optional(),
  artifactDigests: z.record(DigestSchema),
  frozenArtifacts: FrozenArtifactsSchema,
  trustedExecutionFacts: TrustedExecutionFactsSchema,
  compiledPrdRun: CompiledPrdRunPlanSchema.optional(),
  caseSchedule: z.custom<RuntimeCaseSchedule>((value) => {
    try {
      parseCaseSchedule(value)
      return true
    } catch {
      return false
    }
  }, 'Case schedule 必须通过摘要和状态不变量校验').optional(),
  writeAttempts: WriteAttemptsSchema,
  executionResults: RuntimeExecutionResultsSchema,
  requestResponses: z.record(z.object({
    requestDigest: DigestSchema,
    response: z.unknown(),
  }).strict()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.preflightAttempt !== undefined
    && (!['discovery-approved', 'preflight-readonly'].includes(snapshot.workflow.current)
      || snapshot.preflightAttempt.revision !== snapshot.runRevision)) {
    context.addIssue({
      code: 'custom', path: ['preflightAttempt'],
      message: 'preflight attempt 必须绑定可执行预检的 workflow 与当前 revision',
    })
  }
  if (snapshot.preflightBlocker !== undefined
    && snapshot.workflow.current !== 'preflight-readonly') {
    context.addIssue({
      code: 'custom', path: ['preflightBlocker'],
      message: '可恢复预检阻断只能绑定 preflight-readonly',
    })
  }
  if (snapshot.finalizationAttempt !== undefined
    && (snapshot.workflow.current !== 'finalizing'
      || snapshot.finalizationAttempt.revision !== snapshot.runRevision)) {
    context.addIssue({
      code: 'custom', path: ['finalizationAttempt'],
      message: 'finalization attempt 必须绑定 finalizing 与当前 revision',
    })
  }
  for (const [artifactType, artifact] of Object.entries(snapshot.frozenArtifacts)) {
    if (snapshot.artifactDigests[artifactType] !== (artifact as { contentDigest?: unknown }).contentDigest) {
      context.addIssue({
        code: 'custom', path: ['frozenArtifacts', artifactType],
        message: '冻结资产 contentDigest 必须与 artifactDigests 同 key 闭合',
      })
    }
  }
  for (const artifactType of Object.keys(snapshot.artifactDigests)) {
    if (ArtifactTypeSchema.safeParse(artifactType).success
      && snapshot.frozenArtifacts[artifactType] === undefined) {
      context.addIssue({
        code: 'custom', path: ['artifactDigests', artifactType],
        message: '语义 Artifact digest 必须有同 key 冻结正文',
      })
    }
  }
})

export type RuntimeStateMigrator = (snapshot: Readonly<Record<string, unknown>>) => Record<string, unknown>

export const RuntimeStateMigrationRegistry: Readonly<Record<string, RuntimeStateMigrator>> = Object.freeze({
  '1.0.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.1.0',
    frozenArtifacts: {},
    trustedExecutionFacts: {},
    runRevision: 0,
  }),
  '1.1.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.2.0',
    writeAttempts: {},
  }),
  '1.2.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.3.0',
    executionResults: snapshot.executionResults ?? { realEnvironment: {}, gatewayInjection: {} },
  }),
  '1.3.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.4.0',
    executionResults: {
      readEnvironment: {},
      realEnvironment: {},
      gatewayInjection: {},
      ...(snapshot.executionResults as Record<string, unknown> | undefined),
    },
  }),
  '1.4.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.5.0',
    trustedExecutionFacts: {
      ...(snapshot.trustedExecutionFacts as Record<string, unknown> | undefined),
      'approval-mode': (snapshot.trustedExecutionFacts as Record<string, unknown> | undefined)?.['approval-mode']
        ?? 'webauthn',
    },
  }),
  '1.5.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.6.0',
  }),
  '1.6.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.7.0',
    ...legacySingleCaseSchedule(snapshot),
  }),
  '1.7.0': (snapshot) => ({
    ...snapshot,
    schemaVersion: '1.8.0',
  }),
})

export function migrateRuntimeRunSnapshot(input: unknown): RuntimeRunSnapshot {
  const sourceVersion = schemaVersionOf(input)
  let candidate = input
  if (sourceVersion === '1.0.0'
    && (input as { workflow?: { current?: unknown } }).workflow?.current !== 'created') {
    throw migrationRequired(sourceVersion, new Error('历史 Run 缺少可执行冻结资产，禁止猜测恢复'))
  }
  let candidateVersion = sourceVersion
  const visited = new Set<string>()
  while (candidateVersion !== '1.8.0') {
    if (visited.has(candidateVersion)) throw migrationRequired(sourceVersion)
    visited.add(candidateVersion)
    const migrator = RuntimeStateMigrationRegistry[candidateVersion]
    if (migrator === undefined) throw migrationRequired(sourceVersion)
    candidate = migrator(candidate as Readonly<Record<string, unknown>>)
    candidateVersion = schemaVersionOf(candidate)
  }

  const parsed = RuntimeRunSnapshotSchema.safeParse(candidate)
  if (!parsed.success) {
    throw migrationRequired(sourceVersion, parsed.error)
  }
  try {
    return RuntimeRunSnapshotSchema.parse(JSON.parse(canonicalizeJson(parsed.data))) as RuntimeRunSnapshot
  } catch (cause) {
    throw migrationRequired(sourceVersion, cause)
  }
}

function legacySingleCaseSchedule(
  snapshot: Readonly<Record<string, unknown>>,
): { caseSchedule: RuntimeCaseSchedule } | Record<string, never> {
  if (snapshot.caseSchedule !== undefined) return {}
  const frozenArtifacts = snapshot.frozenArtifacts
  if (!plain(frozenArtifacts)) return {}
  const testCases = frozenArtifacts['test-cases']
  if (!plain(testCases) || !plain(testCases.content)) return {}
  const cases = testCases.content.cases
  if (!Array.isArray(cases) || cases.length !== 1 || !plain(cases[0])) return {}
  const testCase = cases[0]
  if (typeof testCase.caseId !== 'string' || typeof testCase.actor !== 'string') return {}
  return {
    caseSchedule: createLegacySingleCaseSchedule({
      caseId: testCase.caseId,
      actor: testCase.actor,
      failurePolicy: testCase.necessity === 'required' ? 'stop-required' : 'continue',
    }, typeof snapshot.createdAt === 'string' ? snapshot.createdAt : new Date(0).toISOString()),
  }
}

function schemaVersionOf(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    throw migrationRequired('missing')
  }
  const schemaVersion = (input as Record<string, unknown>).schemaVersion
  if (typeof schemaVersion !== 'string') throw migrationRequired('missing')
  return schemaVersion
}

function migrationRequired(schemaVersion: string, cause?: unknown): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED',
    category: 'artifact',
    message: `E2E_RUNTIME_STATE_MIGRATION_REQUIRED: Run snapshot ${schemaVersion} 需要显式迁移器`,
    retryable: false,
    cause,
  })
}
