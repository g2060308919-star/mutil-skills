import {
  AssetIdSchema,
  canonicalizeJson,
  E2EError,
  WorkflowStateSchema,
} from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import type { RuntimeRunSnapshot } from './run-store.js'

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

const RuntimeRunSnapshotSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runId: RunIdSchema,
  assetId: AssetIdSchema,
  projectIdentityDigest: DigestSchema,
  runtimeInstallationDigest: DigestSchema,
  workflow: WorkflowStateSchema,
  pendingDecision: PendingWorkflowDecisionSchema.optional(),
  artifactDigests: z.record(DigestSchema),
  requestResponses: z.record(z.object({
    requestDigest: DigestSchema,
    response: z.unknown(),
  }).strict()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export type RuntimeStateMigrator = (snapshot: Readonly<Record<string, unknown>>) => Record<string, unknown>

/** Explicitly empty for the first release; future same-major steps must be registered by source version. */
export const RuntimeStateMigrationRegistry: Readonly<Record<string, RuntimeStateMigrator>> = Object.freeze({})

export function migrateRuntimeRunSnapshot(input: unknown): RuntimeRunSnapshot {
  const sourceVersion = schemaVersionOf(input)
  if (sourceVersion !== '1.0.0') throw migrationRequired(sourceVersion)

  const parsed = RuntimeRunSnapshotSchema.safeParse(input)
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
