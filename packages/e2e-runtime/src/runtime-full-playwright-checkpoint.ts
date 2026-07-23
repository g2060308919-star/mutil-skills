import { createArtifactSignatureVerifier, SqliteSnapshotStore } from '@mutil-skills/e2e-authority'
import {
  ArtifactSignatureSchema,
  canonicalizeJson,
  digestText,
  type ArtifactAuthorityVerifierMaterial,
  type ArtifactSignature,
} from '@mutil-skills/e2e-contracts'
import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const TerminalSchema = z.enum(['completed', 'unknown', 'terminal-failed'])
const MAX_CHECKPOINT_BYTES = 512 * 1024

const ReceiptSchema = z.object({
  schemaVersion: z.literal('1.0.0'), purpose: z.literal('full-playwright-terminal-receipt/v1'),
  attemptId: SafeIdSchema, revision: z.number().int().positive(),
  authorityPublicKeyDigest: DigestSchema, terminalIntentDigest: DigestSchema, bindingDigest: DigestSchema,
  terminal: TerminalSchema, checkpointDigest: DigestSchema, signature: ArtifactSignatureSchema,
}).strict()

const CheckpointCoreSchema = z.object({
  schemaVersion: z.literal('1.0.0'), attemptId: SafeIdSchema, revision: z.number().int().positive(),
  authorityPublicKeyDigest: DigestSchema, terminalIntentDigest: DigestSchema,
  bindingDigest: DigestSchema, terminal: TerminalSchema, recovery: z.record(z.unknown()),
  createdAt: z.string().datetime(),
}).strict()

const CheckpointSchema = CheckpointCoreSchema.extend({
  checkpointDigest: DigestSchema, receipt: ReceiptSchema,
}).strict().superRefine((checkpoint, context) => {
  const core = { schemaVersion: checkpoint.schemaVersion, attemptId: checkpoint.attemptId,
    revision: checkpoint.revision, authorityPublicKeyDigest: checkpoint.authorityPublicKeyDigest,
    terminalIntentDigest: checkpoint.terminalIntentDigest, bindingDigest: checkpoint.bindingDigest,
    terminal: checkpoint.terminal, recovery: checkpoint.recovery, createdAt: checkpoint.createdAt }
  if (checkpoint.checkpointDigest !== digestText('full-playwright-terminal-checkpoint/v1', canonicalizeJson(core))) {
    context.addIssue({ code: 'custom', path: ['checkpointDigest'], message: 'checkpoint digest mismatch' })
  }
  if (checkpoint.receipt.attemptId !== checkpoint.attemptId
    || checkpoint.receipt.revision !== checkpoint.revision
    || checkpoint.receipt.authorityPublicKeyDigest !== checkpoint.authorityPublicKeyDigest
    || checkpoint.receipt.terminalIntentDigest !== checkpoint.terminalIntentDigest
    || checkpoint.receipt.bindingDigest !== checkpoint.bindingDigest
    || checkpoint.receipt.terminal !== checkpoint.terminal
    || checkpoint.receipt.checkpointDigest !== checkpoint.checkpointDigest
    || checkpoint.receipt.signature.signedDigest !== checkpoint.checkpointDigest) {
    context.addIssue({ code: 'custom', path: ['receipt'], message: 'terminal receipt binding mismatch' })
  }
})

const StoreSchema = z.object({
  schemaVersion: z.literal('1.0.0'), authorityPublicKeyDigest: DigestSchema,
  entries: z.array(CheckpointSchema).max(128),
}).strict()

export type RuntimeFullPlaywrightCheckpoint = z.infer<typeof CheckpointSchema>

export class RuntimeFullPlaywrightCheckpointStore {
  readonly #store: SqliteSnapshotStore
  readonly #now: () => Date
  readonly #maxEntries: number
  readonly #signDigest: (digest: string) => ArtifactSignature
  readonly #authorityPublicKeyDigest: string
  readonly #verifySignature: (signature: ArtifactSignature) => boolean

  private constructor(input: {
    statePath: string; forbiddenRoots: string[]; now: () => Date; maxEntries: number
    signDigest(digest: string): ArtifactSignature
    artifactAuthority: { material: ArtifactAuthorityVerifierMaterial; expectedPublicKeyDigest: string }
  }) {
    if (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 1 || input.maxEntries > 128) {
      throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_LIMIT_INVALID')
    }
    this.#authorityPublicKeyDigest = input.artifactAuthority.expectedPublicKeyDigest
    this.#verifySignature = createArtifactSignatureVerifier(input.artifactAuthority.material,
      input.artifactAuthority.expectedPublicKeyDigest)
    this.#store = new SqliteSnapshotStore(input.statePath, 'runtime-full-playwright-terminal/v1', {
      forbiddenRoots: input.forbiddenRoots,
    })
    this.#store.initialize(canonicalizeJson({ schemaVersion: '1.0.0',
      authorityPublicKeyDigest: this.#authorityPublicKeyDigest, entries: [] }))
    this.#now = input.now
    this.#maxEntries = input.maxEntries
    this.#signDigest = input.signDigest
    const snapshot = this.#readTransaction()
    this.#store.rollback()
    if (snapshot.authorityPublicKeyDigest !== this.#authorityPublicKeyDigest) {
      throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_AUTHORITY_MISMATCH')
    }
  }

  static open(input: {
    statePath: string
    forbiddenRoots: string[]
    now?: () => Date
    maxEntries?: number
    signDigest(digest: string): ArtifactSignature
    artifactAuthority: { material: ArtifactAuthorityVerifierMaterial; expectedPublicKeyDigest: string }
  }): RuntimeFullPlaywrightCheckpointStore {
    return new RuntimeFullPlaywrightCheckpointStore({ ...input, now: input.now ?? (() => new Date()),
      maxEntries: input.maxEntries ?? 128 })
  }

  async put(input: {
    attemptId: string
    terminalIntentDigest: string
    bindingDigest: string
    terminal: 'completed' | 'unknown' | 'terminal-failed'
    recovery: Record<string, unknown>
  }): Promise<RuntimeFullPlaywrightCheckpoint> {
    let inputJson: string
    try { inputJson = canonicalizeJson(input) } catch (cause) {
      throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_SCHEMA_INVALID', cause)
    }
    if (Buffer.byteLength(inputJson, 'utf8') > MAX_CHECKPOINT_BYTES) {
      throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_SIZE_INVALID')
    }
    return await this.#store.runExclusive(async () => {
      const snapshot = this.#readTransaction()
      const sameAttempt = snapshot.entries.find((entry) => entry.attemptId === input.attemptId)
      if (sameAttempt) {
        const existingInput = { attemptId: sameAttempt.attemptId,
          terminalIntentDigest: sameAttempt.terminalIntentDigest, bindingDigest: sameAttempt.bindingDigest,
          terminal: sameAttempt.terminal, recovery: sameAttempt.recovery }
        if (canonicalizeJson(existingInput) !== inputJson) {
          const transitionAllowed = sameAttempt.terminal === 'terminal-failed'
            && ['terminal-failed', 'completed', 'unknown'].includes(input.terminal)
            && sameAttempt.terminalIntentDigest === input.terminalIntentDigest
            && sameAttempt.bindingDigest === input.bindingDigest
          if (!transitionAllowed) {
            this.#store.rollback()
            throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_CONFLICT')
          }
        } else {
          this.#store.rollback()
          return structuredClone(sameAttempt)
        }
      }
      const createdAt = this.#now().toISOString()
      const core = CheckpointCoreSchema.parse({
        schemaVersion: '1.0.0', ...input, revision: (sameAttempt?.revision ?? 0) + 1,
        authorityPublicKeyDigest: this.#authorityPublicKeyDigest, createdAt,
      })
      const checkpointDigest = digestText('full-playwright-terminal-checkpoint/v1', canonicalizeJson(core))
      const signature = ArtifactSignatureSchema.parse(this.#signDigest(checkpointDigest))
      const receipt = ReceiptSchema.parse({ schemaVersion: '1.0.0',
        purpose: 'full-playwright-terminal-receipt/v1', attemptId: input.attemptId,
        revision: core.revision, authorityPublicKeyDigest: this.#authorityPublicKeyDigest,
        terminalIntentDigest: input.terminalIntentDigest, bindingDigest: input.bindingDigest,
        terminal: input.terminal, checkpointDigest, signature })
      const checkpoint = CheckpointSchema.parse({ ...core, checkpointDigest, receipt })
      if (sameAttempt) snapshot.entries[snapshot.entries.indexOf(sameAttempt)] = checkpoint
      else snapshot.entries.push(checkpoint)
      snapshot.entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.attemptId.localeCompare(right.attemptId))
      while (snapshot.entries.length > this.#maxEntries) {
        const completed = snapshot.entries.findIndex((entry) => entry.terminal === 'completed')
        if (completed < 0) {
          this.#store.rollback()
          throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_CAPACITY_EXHAUSTED')
        }
        snapshot.entries.splice(completed, 1)
      }
      this.#store.commit(canonicalizeJson(StoreSchema.parse(snapshot)))
      return structuredClone(checkpoint)
    })
  }

  async find(attemptId: string, bindingDigest: string): Promise<RuntimeFullPlaywrightCheckpoint | undefined> {
    return await this.#store.runExclusive(async () => {
      const snapshot = this.#readTransaction()
      this.#store.rollback()
      const found = snapshot.entries.find((entry) => entry.attemptId === attemptId)
      if (found && found.bindingDigest !== bindingDigest) {
        throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_BINDING_MISMATCH')
      }
      return found ? structuredClone(found) : undefined
    })
  }

  async list(): Promise<RuntimeFullPlaywrightCheckpoint[]> {
    return await this.#store.runExclusive(async () => {
      const snapshot = this.#readTransaction()
      this.#store.rollback()
      return structuredClone(snapshot.entries)
    })
  }

  close(): void { this.#store.close() }

  #readTransaction(): z.infer<typeof StoreSchema> {
    try {
      const snapshot = StoreSchema.parse(JSON.parse(this.#store.begin()))
      if (snapshot.authorityPublicKeyDigest !== this.#authorityPublicKeyDigest) {
        throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_AUTHORITY_MISMATCH')
      }
      for (const entry of snapshot.entries) {
        if (entry.authorityPublicKeyDigest !== this.#authorityPublicKeyDigest
          || entry.receipt.authorityPublicKeyDigest !== this.#authorityPublicKeyDigest
          || !this.#verifySignature(entry.receipt.signature)) {
          throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_SIGNATURE_INVALID')
        }
      }
      return snapshot
    }
    catch (cause) {
      this.#store.rollback()
      if (isCheckpointError(cause)) throw cause
      throw checkpointError('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_STATE_INVALID', cause)
    }
  }
}

function isCheckpointError(value: unknown): value is Error & { code: string } {
  return value instanceof Error && typeof (value as { code?: unknown }).code === 'string'
    && (value as unknown as { code: string }).code.startsWith('E2E_RUNTIME_FULL_PLAYWRIGHT_CHECKPOINT_')
}

function checkpointError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code })
}
