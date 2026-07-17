import {
  ArtifactSchemaRegistry,
  ArtifactTypeSchema,
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
  const allowed = new Set(['signed-discovery-grant', 'signed-execution-grant', 'browser-preflight'])
  if (Object.keys(facts).length > allowed.size) context.addIssue({ code: 'custom', message: '可信执行事实数量超限' })
  for (const [key, value] of Object.entries(facts)) {
    if (!allowed.has(key)) {
      context.addIssue({ code: 'custom', path: [key], message: '未知可信执行事实类型' })
      continue
    }
    if (key === 'browser-preflight') {
      const preflight = BrowserPreflightFactSchema.safeParse(value)
      if (!preflight.success) context.addIssue({ code: 'custom', path: [key], message: 'Browser preflight 事实结构非法' })
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
})

const RuntimeRunSnapshotSchema = z.object({
  schemaVersion: z.literal('1.1.0'),
  runId: RunIdSchema,
  assetId: AssetIdSchema,
  projectIdentityDigest: DigestSchema,
  runtimeInstallationDigest: DigestSchema,
  runRevision: z.number().int().nonnegative().default(0),
  executionAttempt: RuntimeExecutionAttemptSchema.optional(),
  preflightAttempt: RuntimePreflightAttemptSchema.optional(),
  workflow: WorkflowStateSchema,
  pendingDecision: PendingWorkflowDecisionSchema.optional(),
  artifactDigests: z.record(DigestSchema),
  frozenArtifacts: FrozenArtifactsSchema,
  trustedExecutionFacts: TrustedExecutionFactsSchema,
  requestResponses: z.record(z.object({
    requestDigest: DigestSchema,
    response: z.unknown(),
  }).strict()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.preflightAttempt !== undefined
    && (snapshot.workflow.current !== 'discovery-approved'
      || snapshot.preflightAttempt.revision !== snapshot.runRevision)) {
    context.addIssue({
      code: 'custom', path: ['preflightAttempt'],
      message: 'preflight attempt 必须绑定 discovery-approved 与当前 revision',
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
})

export function migrateRuntimeRunSnapshot(input: unknown): RuntimeRunSnapshot {
  const sourceVersion = schemaVersionOf(input)
  let candidate = input
  if (sourceVersion !== '1.1.0') {
    if (sourceVersion === '1.0.0'
      && (input as { workflow?: { current?: unknown } }).workflow?.current !== 'created') {
      throw migrationRequired(sourceVersion, new Error('历史 Run 缺少可执行冻结资产，禁止猜测恢复'))
    }
    const migrator = RuntimeStateMigrationRegistry[sourceVersion]
    if (migrator === undefined) throw migrationRequired(sourceVersion)
    candidate = migrator(input as Readonly<Record<string, unknown>>)
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
