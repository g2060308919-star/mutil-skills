import {
  E2EError,
  ArtifactSignatureSchema,
  RelativePathSchema,
  type ArtifactSignature,
  canonicalizeJson,
  digestBytes,
  digestText,
  type FinalVerdict,
} from '@mutil-skills/e2e-contracts'
import { join } from 'node:path'
import { SafeAssetSession } from './safe-asset-session.js'

export interface PublishGenerationInput {
  assetId: string
  generationId: string
  terminalVerdict: FinalVerdict
  files: Record<string, string | Uint8Array>
  faultAt?: ArtifactFaultPoint
}

export interface PreparedGeneration {
  terminalVerdict: FinalVerdict
  files: Record<string, string | Uint8Array>
}

export interface PublishPreparedGenerationInput {
  assetId: string
  generationId: string
  prepare(input: { fencingToken: number }): PreparedGeneration | Promise<PreparedGeneration>
  faultAt?: ArtifactFaultPoint
}

type AtomicCrashStage = 'temp-fsync' | 'rename' | 'parent-fsync'
type AtomicWriteTarget =
  | 'fencing'
  | 'validation-refs'
  | 'journal-preparing'
  | 'journal-staged'
  | 'journal-generation-durable'
  | 'journal-pointer-written'
  | 'journal-pointer-selected'
  | 'journal-committed'
  | 'journal-aborted'
  | 'gc-active-a'
  | 'gc-active-b'
  | 'gc-selector'
  | 'gc-journal-preparing'
  | 'gc-journal-committed'
  | 'gc-delete-journal-preparing'
  | 'gc-delete-journal-committed'

export type ArtifactFaultPoint =
  | 'after-journal-preparing'
  | 'after-staging-durable'
  | 'after-generation-durable'
  | 'tamper-fencing-before-pointer'
  | 'tamper-fencing-before-selector'
  | 'after-pointer-written'
  | 'after-pointer-selected'
  | 'after-journal-committed'
  | 'disk-full-during-files'
  | 'permission-denied-before-manifest'
  | 'crash-after-file-fsync'
  | 'crash-after-file-parent-fsync'
  | 'crash-after-manifest-fsync'
  | 'crash-after-manifest-parent-fsync'
  | 'crash-after-staging-fsync'
  | 'crash-after-generation-rename'
  | 'crash-after-generations-fsync'
  | 'crash-after-pointer-temp-fsync'
  | 'crash-after-pointer-rename'
  | 'crash-after-pointer-parent-fsync'
  | 'crash-after-selector-temp-fsync'
  | 'crash-after-selector-rename'
  | 'crash-after-selector-parent-fsync'
  | 'after-gc-first-slot'
  | 'after-gc-journal-committed'
  | 'tamper-gc-reference-before-delete'
  | 'crash-during-gc-delete'
  | `crash-after-${AtomicWriteTarget}-${AtomicCrashStage}`

type JournalPhase = 'preparing' | 'staged' | 'generation-durable' | 'pointer-written' | 'pointer-selected' | 'committed' | 'aborted'

interface ArtifactJournal {
  transactionId: string
  generationId: string
  generationDigest: string
  previousActive: { generationId: string; generationDigest: string; epoch: number } | null
  targetSlot: 'a' | 'b'
  fencingToken: number
  phase: JournalPhase
  startedAt: string
  updatedAt: string
}

interface GenerationManifest {
  generationId: string
  terminalVerdict: FinalVerdict
  fencingToken: number
  files: Array<{ path: string; digest: string; byteLength: number }>
  generationDigest: string
  authoritySignature: ArtifactSignature
}

interface ActivePointer {
  epoch: number
  generationId: string
  generationDigest: string
  terminalVerdict: FinalVerdict
  previousGenerationId: string | null
  previousGenerationDigest: string | null
  fencingToken: number
  authoritySignature: ArtifactSignature
}

interface ValidationReferences {
  generationIds: string[]
  fencingToken: number
  authoritySignature: ArtifactSignature
}

export interface ArtifactStoreAuthority {
  auditStagedGeneration(input: StagedGenerationAuditInput): Promise<void>
  signDigest(digest: string): ArtifactSignature
  verifySignature(signature: ArtifactSignature): boolean
}

export interface StagedGenerationAuditInput {
  assetId: string
  generationId: string
  terminalVerdict: FinalVerdict
  fencingToken: number
  stagingPath: string
  files: ReadonlyArray<{ path: string; digest: string; byteLength: number }>
  readFile(relativePath: string): Promise<Uint8Array>
}

export interface ActiveGeneration extends ActivePointer {
  generationPath: string
}

export class LocalArtifactStore {
  constructor(readonly root: string, readonly authority: ArtifactStoreAuthority) {}

  async publish(input: PublishGenerationInput): Promise<ActiveGeneration> {
    return await this.publishPrepared({
      assetId: input.assetId,
      generationId: input.generationId,
      prepare: () => ({ terminalVerdict: input.terminalVerdict, files: input.files }),
      faultAt: input.faultAt,
    })
  }

  async publishPrepared(input: PublishPreparedGenerationInput): Promise<ActiveGeneration> {
    validateId(input.assetId, 'assetId')
    validateId(input.generationId, 'generationId')
    const assetRoot = this.assetRoot(input.assetId)
    const session = await SafeAssetSession.acquire(assetRoot)

    let lastJournal: ArtifactJournal | undefined
    try {
      await cleanupAtomicTemps(session)
      const generationsRoot = 'generations'
      const previous = await this.readActiveSession(input.assetId, session)
      if (!previous && await hasPublicationState(session)) {
        // 先经由 no-follow helper 验证 generations 的真实类型，避免把符号链接攻击误报为普通恢复错误。
        await session.mkdir(generationsRoot)
        throw artifactError(
          'E2E_ARTIFACT_NO_RELIABLE_GENERATION',
          `Asset ${input.assetId} 已有持久化状态，但没有可靠 active generation`,
        )
      }
      const fencingToken = await this.nextFencingToken(session, previous?.fencingToken ?? 0, input.faultAt)
      const prepared = await input.prepare({ fencingToken })
      await session.mkdir(generationsRoot)
      const selected = await readSelectedSlot(session)
      const targetSlot: 'a' | 'b' = selected === 'a' ? 'b' : 'a'
      const startedAt = new Date().toISOString()
      const journalBase = {
        transactionId: input.generationId,
        generationId: input.generationId,
        generationDigest: digestText('generation-pending/v1', input.generationId),
        previousActive: previous ? {
          generationId: previous.generationId, generationDigest: previous.generationDigest, epoch: previous.epoch,
        } : null,
        targetSlot,
        fencingToken,
        startedAt,
      }
      lastJournal = { ...journalBase, phase: 'preparing', updatedAt: startedAt }
      await this.writeJournal(session, lastJournal, input.faultAt, 'journal-preparing')
      if (input.faultAt?.startsWith('crash-after-journal-aborted-')) {
        throw artifactError('E2E_ARTIFACT_PERMISSION_DENIED', '为 aborted journal kill-point 注入发布失败')
      }
      injectFault(input.faultAt, 'after-journal-preparing')
      const staging = `${generationsRoot}/.staging-${input.generationId}`
      const generationRelativePath = `${generationsRoot}/${input.generationId}`
      await session.removeTree(staging)
      await session.mkdir(staging)

      const files = [] as GenerationManifest['files']
      for (const [relativePath, content] of Object.entries(prepared.files).sort(([left], [right]) => left.localeCompare(right))) {
        validateRelativePath(relativePath)
        if (relativePath === '.publication-integrity.json') {
          throw artifactError('E2E_ARTIFACT_PATH_RESERVED', '调用方不能写事务层保留文件')
        }
        const target = `${staging}/${relativePath}`
        await session.writeNew(target, content, helperCrashPoint(
          input.faultAt, 'crash-after-file-fsync', 'crash-after-file-parent-fsync',
        ))
        const bytes = Buffer.from(content)
        files.push({
          path: relativePath,
          digest: digestBytes(`generation-file:${relativePath}`, bytes),
          byteLength: bytes.byteLength,
        })
      }
      const manifestCore = { generationId: input.generationId, terminalVerdict: prepared.terminalVerdict, fencingToken, files }
      const generationDigest = digestText('generation-manifest/v1', canonicalizeJson(manifestCore))
      await this.authority.auditStagedGeneration({
        assetId: input.assetId,
        generationId: input.generationId,
        terminalVerdict: prepared.terminalVerdict,
        fencingToken,
        stagingPath: join(assetRoot, staging),
        files,
        readFile: async (relativePath) => {
          if (!files.some((file) => file.path === relativePath)) {
            throw artifactError('E2E_ARTIFACT_AUDIT_PATH_UNREGISTERED', `审计尝试读取未登记文件：${relativePath}`)
          }
          return await session.read(`${staging}/${relativePath}`)
        },
      })
      const manifest: GenerationManifest = {
        ...manifestCore, generationDigest, authoritySignature: this.authority.signDigest(generationDigest),
      }
      await session.writeNew(`${staging}/.publication-integrity.json`, prettyJson(manifest), helperCrashPoint(
        input.faultAt, 'crash-after-manifest-fsync', 'crash-after-manifest-parent-fsync',
      ))
      await session.syncDirectory(staging,
        input.faultAt === 'crash-after-staging-fsync' ? 'after-directory-fsync' : undefined)
      await assertGenerationFileClosure(session, staging, manifest)
      lastJournal = {
        ...journalBase, generationDigest: manifest.generationDigest, phase: 'staged', updatedAt: new Date().toISOString(),
      }
      await this.writeJournal(session, lastJournal, input.faultAt, 'journal-staged')
      injectFault(input.faultAt, 'after-staging-durable')
      await session.rename(staging, generationRelativePath,
        input.faultAt === 'crash-after-generation-rename' ? 'after-rename' : undefined)
      await session.syncDirectory(generationsRoot,
        input.faultAt === 'crash-after-generations-fsync' ? 'after-directory-fsync' : undefined)
      lastJournal = {
        ...journalBase, generationDigest: manifest.generationDigest,
        phase: 'generation-durable', updatedAt: new Date().toISOString(),
      }
      await this.writeJournal(session, lastJournal, input.faultAt, 'journal-generation-durable')
      injectFault(input.faultAt, 'after-generation-durable')
      if (input.faultAt === 'tamper-fencing-before-pointer') {
        await session.writeAtomic('fencing-counter', `${fencingToken + 1}\n`)
      }
      await this.assertCurrentFencingToken(session, fencingToken)
      const pointer = this.signPointer({
        epoch: (previous?.epoch ?? 0) + 1,
        generationId: input.generationId,
        generationDigest: manifest.generationDigest,
        terminalVerdict: prepared.terminalVerdict,
        previousGenerationId: previous?.generationId ?? null,
        previousGenerationDigest: previous?.generationDigest ?? null,
        fencingToken,
      })
      await session.writeAtomic(`active-${targetSlot}.json`, prettyJson(pointer), atomicCrashPoint(
        input.faultAt,
        'crash-after-pointer-temp-fsync', 'crash-after-pointer-rename', 'crash-after-pointer-parent-fsync',
      ))
      lastJournal = {
        ...journalBase, generationDigest: manifest.generationDigest,
        phase: 'pointer-written', updatedAt: new Date().toISOString(),
      }
      await this.writeJournal(session, lastJournal, input.faultAt, 'journal-pointer-written')
      injectFault(input.faultAt, 'after-pointer-written')
      if (input.faultAt === 'tamper-fencing-before-selector') {
        await session.writeAtomic('fencing-counter', `${fencingToken + 1}\n`)
      }
      await this.assertCurrentFencingToken(session, fencingToken)
      await session.writeAtomic('active-slot', `${targetSlot}\n`, atomicCrashPoint(
        input.faultAt,
        'crash-after-selector-temp-fsync', 'crash-after-selector-rename', 'crash-after-selector-parent-fsync',
      ))
      lastJournal = {
        ...journalBase, generationDigest: manifest.generationDigest,
        phase: 'pointer-selected', updatedAt: new Date().toISOString(),
      }
      await this.writeJournal(session, lastJournal, input.faultAt, 'journal-pointer-selected')
      injectFault(input.faultAt, 'after-pointer-selected')
      lastJournal = {
        ...journalBase, generationDigest: manifest.generationDigest,
        phase: 'committed', updatedAt: new Date().toISOString(),
      }
      await this.writeJournal(session, lastJournal, input.faultAt, 'journal-committed')
      injectFault(input.faultAt, 'after-journal-committed')
      await this.runGcSession(input.assetId, session, [], fencingToken, input.faultAt)
      const committed = await this.readActiveSession(input.assetId, session)
      if (!committed) throw artifactError('E2E_ARTIFACT_COMMIT_LOST', 'GC 后无法读取已提交 generation')
      return committed
    } catch (error) {
      if (isCrashFault(input.faultAt) && error instanceof E2EError && error.code === 'E2E_ARTIFACT_HELPER_EXITED') {
        throw artifactError('E2E_ARTIFACT_FAULT_INJECTED', `在 ${input.faultAt} 模拟进程崩溃`, error)
      }
      if (lastJournal && error instanceof E2EError && error.code !== 'E2E_ARTIFACT_FAULT_INJECTED') {
        try {
          await this.writeJournal(
            session,
            { ...lastJournal, phase: 'aborted', updatedAt: new Date().toISOString() },
            input.faultAt,
            'journal-aborted',
          )
        } catch (abortError) {
          if (input.faultAt?.startsWith('crash-after-journal-aborted-')
            && abortError instanceof E2EError && abortError.code === 'E2E_ARTIFACT_HELPER_EXITED') {
            throw artifactError('E2E_ARTIFACT_FAULT_INJECTED', `在 ${input.faultAt} 模拟进程崩溃`, abortError)
          }
        }
      }
      throw error
    } finally {
      await session.close()
    }
  }

  async readActive(assetId: string): Promise<ActiveGeneration | undefined> {
    validateId(assetId, 'assetId')
    const assetRoot = this.assetRoot(assetId)
    const session = await SafeAssetSession.acquire(assetRoot)
    try {
      await cleanupAtomicTemps(session)
      return await this.readActiveSession(assetId, session)
    } finally {
      await session.close()
    }
  }

  private async readActiveSession(assetId: string, session: SafeAssetSession): Promise<ActiveGeneration | undefined> {
    const assetRoot = this.assetRoot(assetId)
    const selected = await readSelectedSlot(session)
    const slotOrder = selected === 'a' ? ['a', 'b'] : selected === 'b' ? ['b', 'a'] : ['a', 'b']
    const valid: ActiveGeneration[] = []
    const parsedPointers: ActivePointer[] = []
    for (const slot of slotOrder) {
      const text = await session.readOptionalText(`active-${slot}.json`)
      if (!text) continue
      try {
        const pointer = this.parseAndVerifyPointer(JSON.parse(text))
        parsedPointers.push(pointer)
        const generationRelativePath = `generations/${pointer.generationId}`
        const generationPath = join(assetRoot, generationRelativePath)
        if (await validateGeneration(session, generationRelativePath, pointer, this.authority)) {
          const generation = { ...pointer, generationPath }
          if (slot === selected) return generation
          valid.push(generation)
        }
      } catch {
        continue
      }
    }
    const fallback = valid.sort((left, right) => right.epoch - left.epoch)[0]
    if (fallback) return fallback
    for (const pointer of parsedPointers) {
      if (!pointer.previousGenerationId || !pointer.previousGenerationDigest) continue
      const previous = await readValidGeneration(
        session,
        `generations/${pointer.previousGenerationId}`,
        pointer.previousGenerationId,
        pointer.previousGenerationDigest,
        this.authority,
      )
      if (previous) {
        const previousPointer = this.signPointer({
          epoch: Math.max(0, pointer.epoch - 1),
          generationId: pointer.previousGenerationId,
          generationDigest: pointer.previousGenerationDigest,
          terminalVerdict: previous.terminalVerdict,
          previousGenerationId: null,
          previousGenerationDigest: null,
          fencingToken: previous.fencingToken,
        })
        return {
          ...previousPointer,
          generationPath: join(assetRoot, 'generations', pointer.previousGenerationId),
        }
      }
    }
    return undefined
  }

  async recover(assetId: string): Promise<ActiveGeneration | undefined> {
    validateId(assetId, 'assetId')
    const assetRoot = this.assetRoot(assetId)
    const session = await SafeAssetSession.acquire(assetRoot)
    try {
      await cleanupAtomicTemps(session)
      const active = await this.readActiveSession(assetId, session)
      const journal = await readJournal(session)
      if (active && journal && ['pointer-written', 'pointer-selected'].includes(journal.phase)
        && journal.generationId === active.generationId
        && journal.generationDigest === active.generationDigest) {
        await this.writeJournal(session, { ...journal, phase: 'committed', updatedAt: new Date().toISOString() })
      }
      if (active) {
        const fencingToken = await this.nextFencingToken(session, active.fencingToken)
        await this.runGcSession(assetId, session, [], fencingToken)
        return await this.readActiveSession(assetId, session)
      }
      const hasState = await hasPublicationState(session)
      if (hasState) throw artifactError('E2E_ARTIFACT_NO_RELIABLE_GENERATION', `Asset ${assetId} 没有可靠 generation`)
      return undefined
    } finally {
      await session.close()
    }
  }

  async gc(
    assetId: string,
    validatingGenerationIds: string[] = [],
    faultAt?: ArtifactFaultPoint,
  ): Promise<void> {
    validateId(assetId, 'assetId')
    validatingGenerationIds.forEach((generationId) => validateId(generationId, 'validatingGenerationId'))
    const session = await SafeAssetSession.acquire(this.assetRoot(assetId))
    try {
      await cleanupAtomicTemps(session)
      const active = await this.readActiveSession(assetId, session)
      if (!active) {
        if (await hasPublicationState(session)) {
          throw artifactError('E2E_ARTIFACT_NO_RELIABLE_GENERATION', `Asset ${assetId} 没有可靠 generation`)
        }
        return
      }
      const fencingToken = await this.nextFencingToken(session, active.fencingToken, faultAt)
      await this.writeValidationReferences(session, validatingGenerationIds, fencingToken, faultAt)
      await this.runGcSession(assetId, session, validatingGenerationIds, fencingToken, faultAt)
    } catch (error) {
      if (isCrashFault(faultAt) && error instanceof E2EError && error.code === 'E2E_ARTIFACT_HELPER_EXITED') {
        throw artifactError('E2E_ARTIFACT_FAULT_INJECTED', `在 ${faultAt} 模拟 GC 进程崩溃`, error)
      }
      throw error
    } finally {
      await session.close()
    }
  }

  async setValidationReferences(assetId: string, generationIds: string[]): Promise<void> {
    validateId(assetId, 'assetId')
    generationIds.forEach((generationId) => validateId(generationId, 'validatingGenerationId'))
    const session = await SafeAssetSession.acquire(this.assetRoot(assetId))
    try {
      await cleanupAtomicTemps(session)
      const active = await this.readActiveSession(assetId, session)
      if (!active) throw artifactError('E2E_ARTIFACT_NO_RELIABLE_GENERATION', `Asset ${assetId} 没有可靠 generation`)
      const fencingToken = await this.nextFencingToken(session, active.fencingToken)
      await this.writeValidationReferences(session, generationIds, fencingToken)
    } finally {
      await session.close()
    }
  }

  /** 按已持久化且签名的 validation references 执行 GC，不允许调用参数覆盖引用事实。 */
  async gcUsingPersistedValidationReferences(assetId: string): Promise<void> {
    validateId(assetId, 'assetId')
    const session = await SafeAssetSession.acquire(this.assetRoot(assetId))
    try {
      await cleanupAtomicTemps(session)
      const active = await this.readActiveSession(assetId, session)
      if (!active) throw artifactError(
        'E2E_ARTIFACT_NO_RELIABLE_GENERATION', `Asset ${assetId} 没有可靠 generation`,
      )
      const references = await this.readValidationReferences(session)
      const fencingToken = await this.nextFencingToken(session, active.fencingToken)
      await this.runGcSession(assetId, session, references, fencingToken)
    } finally {
      await session.close()
    }
  }

  private assetRoot(assetId: string): string {
    return join(this.root, '.biztest', 'assets', assetId)
  }

  private async nextFencingToken(
    session: SafeAssetSession,
    minimum: number,
    faultAt?: ArtifactFaultPoint,
  ): Promise<number> {
    const path = 'fencing-counter'
    const stored = await session.readOptionalText(path)
    const current = stored === undefined ? 0 : Number(stored.trim())
    if ((stored !== undefined && !/^[1-9]\d*\n?$/.test(stored))
      || !Number.isSafeInteger(current) || current < minimum || current >= Number.MAX_SAFE_INTEGER) {
      throw artifactError(
        'E2E_ARTIFACT_FENCING_COUNTER_INVALID',
        `Fencing counter 无效或发生回退：current=${String(current)}，minimum=${minimum}`,
      )
    }
    const next = current + 1
    await session.writeAtomic(path, `${next}\n`, namedAtomicCrashPoint(faultAt, 'fencing'))
    return next
  }

  private async assertCurrentFencingToken(session: SafeAssetSession, expected: number): Promise<void> {
    const stored = await session.readOptionalText('fencing-counter')
    if (stored === undefined || !/^[1-9]\d*\n?$/.test(stored)
      || Number(stored.trim()) !== expected) {
      throw artifactError(
        'E2E_ARTIFACT_STALE_WRITER',
        `提交前 fencing token 已变化：expected=${expected}，actual=${stored?.trim() ?? 'missing'}`,
      )
    }
  }

  private async writeJournal(
    session: SafeAssetSession,
    value: ArtifactJournal,
    faultAt?: ArtifactFaultPoint,
    target?: AtomicWriteTarget,
  ): Promise<void> {
    const checksum = digestText('artifact-journal/v1', canonicalizeJson(value))
    await session.writeAtomic(
      'journal.json',
      prettyJson({ ...value, checksum }),
      target ? namedAtomicCrashPoint(faultAt, target) : undefined,
    )
  }

  private async writeValidationReferences(
    session: SafeAssetSession,
    generationIds: string[],
    fencingToken: number,
    faultAt?: ArtifactFaultPoint,
  ): Promise<void> {
    const payload = { generationIds: [...new Set(generationIds)].sort(), fencingToken }
    const digest = digestText('artifact-validation-references/v1', canonicalizeJson(payload))
    const value: ValidationReferences = {
      ...payload,
      authoritySignature: this.authority.signDigest(digest),
    }
    await session.writeAtomic(
      'validation-refs.json', prettyJson(value), namedAtomicCrashPoint(faultAt, 'validation-refs'),
    )
  }

  private async runGcSession(
    assetId: string,
    session: SafeAssetSession,
    validatingGenerationIds: string[],
    fencingToken: number,
    faultAt?: ArtifactFaultPoint,
  ): Promise<void> {
    const active = await this.readActiveSession(assetId, session)
    if (!active) return
    await this.assertCurrentFencingToken(session, fencingToken)
    const persistedValidationIds = await this.readValidationReferences(session)
    const protectedValidationIds = [...new Set([...persistedValidationIds, ...validatingGenerationIds])].sort()
    const selected = await readSelectedSlot(session) ?? 'a'
    const startedAt = new Date().toISOString()
    const journal: ArtifactJournal = {
      transactionId: `GC-${active.generationId}-${fencingToken}`,
      generationId: active.generationId,
      generationDigest: active.generationDigest,
      previousActive: null,
      targetSlot: selected,
      fencingToken,
      phase: 'preparing',
      startedAt,
      updatedAt: startedAt,
    }
    await this.writeJournal(session, journal, faultAt, 'gc-journal-preparing')
    const pointer = this.signPointer({
      epoch: active.epoch,
      generationId: active.generationId,
      generationDigest: active.generationDigest,
      terminalVerdict: active.terminalVerdict,
      previousGenerationId: null,
      previousGenerationDigest: null,
      fencingToken,
    })
    await this.assertCurrentFencingToken(session, fencingToken)
    await session.writeAtomic(
      'active-a.json', prettyJson(pointer), namedAtomicCrashPoint(faultAt, 'gc-active-a'),
    )
    injectFault(faultAt, 'after-gc-first-slot')
    await this.assertCurrentFencingToken(session, fencingToken)
    await session.writeAtomic(
      'active-b.json', prettyJson(pointer), namedAtomicCrashPoint(faultAt, 'gc-active-b'),
    )
    await this.assertCurrentFencingToken(session, fencingToken)
    await session.writeAtomic(
      'active-slot', `${selected}\n`, namedAtomicCrashPoint(faultAt, 'gc-selector'),
    )
    const committedJournal = { ...journal, phase: 'committed' as const, updatedAt: new Date().toISOString() }
    await this.writeJournal(session, committedJournal, faultAt, 'gc-journal-committed')
    injectFault(faultAt, 'after-gc-journal-committed')
    if (faultAt === 'tamper-gc-reference-before-delete') {
      await session.writeAtomic('active-a.json', '{"tampered":true}\n')
    }

    const protectedIds = new Set([active.generationId, ...protectedValidationIds])
    let precedingTransactionId = committedJournal.transactionId
    for (const entry of await session.list('generations')) {
      let candidateGenerationId = entry
      if (entry.startsWith('.staging-')) {
        candidateGenerationId = entry.slice('.staging-'.length)
      }
      validateId(candidateGenerationId, 'generation directory')
      if (protectedIds.has(candidateGenerationId)) continue

      await this.verifyGcReferencesBeforeDelete(
        session, active, selected, fencingToken, precedingTransactionId, protectedValidationIds,
      )
      await this.assertCurrentFencingToken(session, fencingToken)
      const deleteStartedAt = new Date().toISOString()
      const deleteJournal: ArtifactJournal = {
        ...journal,
        transactionId: `GC-${active.generationId}-${fencingToken}-DELETE-${candidateGenerationId}`,
        phase: 'preparing',
        startedAt: deleteStartedAt,
        updatedAt: deleteStartedAt,
      }
      await this.writeJournal(session, deleteJournal, faultAt, 'gc-delete-journal-preparing')
      await this.assertCurrentFencingToken(session, fencingToken)
      await session.removeTree(
        `generations/${entry}`,
        faultAt === 'crash-during-gc-delete' ? 'after-remove-fsync' : undefined,
      )
      const deleteCommitted = { ...deleteJournal, phase: 'committed' as const, updatedAt: new Date().toISOString() }
      await this.writeJournal(session, deleteCommitted, faultAt, 'gc-delete-journal-committed')
      precedingTransactionId = deleteCommitted.transactionId
    }
    await session.syncDirectory('generations')
  }

  private async verifyGcReferencesBeforeDelete(
    session: SafeAssetSession,
    active: ActiveGeneration,
    selected: 'a' | 'b',
    fencingToken: number,
    transactionId: string,
    expectedValidationIds: string[],
  ): Promise<void> {
    try {
      const rereadSelected = await readSelectedSlot(session)
      const pointerTexts = await Promise.all([
        session.readOptionalText('active-a.json'),
        session.readOptionalText('active-b.json'),
      ])
      const pointers = pointerTexts.map((text) => text ? this.parseAndVerifyPointer(JSON.parse(text)) : undefined)
      const referencesStable = rereadSelected === selected && pointers.every((pointer) => pointer
        && pointer.generationId === active.generationId
        && pointer.generationDigest === active.generationDigest
        && pointer.previousGenerationId === null
        && pointer.previousGenerationDigest === null
        && pointer.fencingToken === fencingToken)
      const generationValid = pointers[0]
        ? await validateGeneration(session, `generations/${active.generationId}`, pointers[0], this.authority)
        : false
      const rereadJournal = await readJournal(session)
      const journalStable = rereadJournal?.transactionId === transactionId
        && rereadJournal.phase === 'committed'
        && rereadJournal.generationId === active.generationId
        && rereadJournal.generationDigest === active.generationDigest
        && rereadJournal.previousActive === null
        && rereadJournal.fencingToken === fencingToken
      const rereadValidationIds = await this.readValidationReferences(session)
      const validationStable = canonicalizeJson(rereadValidationIds) === canonicalizeJson(expectedValidationIds)
      if (!referencesStable || !generationValid || !journalStable || !validationStable) {
        throw artifactError('E2E_ARTIFACT_GC_REFERENCE_CHANGED', 'GC 删除前签名引用发生变化')
      }
    } catch (error) {
      if (error instanceof E2EError && error.code === 'E2E_ARTIFACT_GC_REFERENCE_CHANGED') throw error
      throw artifactError('E2E_ARTIFACT_GC_REFERENCE_CHANGED', 'GC 删除前无法重新验证签名引用', error)
    }
  }

  private async readValidationReferences(session: SafeAssetSession): Promise<string[]> {
    const text = await session.readOptionalText('validation-refs.json')
    if (!text) return []
    try {
      const candidate = JSON.parse(text) as Record<string, unknown>
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || !hasExactKeys(candidate, ['generationIds', 'fencingToken', 'authoritySignature'])
        || !Array.isArray(candidate.generationIds)
        || candidate.generationIds.some((value) => typeof value !== 'string')
        || !Number.isSafeInteger(candidate.fencingToken) || (candidate.fencingToken as number) < 1) {
        throw new Error('invalid validation reference fields')
      }
      const generationIds = candidate.generationIds as string[]
      generationIds.forEach((generationId) => validateId(generationId, 'validatingGenerationId'))
      if (new Set(generationIds).size !== generationIds.length
        || canonicalizeJson(generationIds) !== canonicalizeJson([...generationIds].sort())) {
        throw new Error('validation references must be unique and sorted')
      }
      const signature = ArtifactSignatureSchema.parse(candidate.authoritySignature)
      const digest = digestText('artifact-validation-references/v1', canonicalizeJson({
        generationIds,
        fencingToken: candidate.fencingToken,
      }))
      if (signature.signedDigest !== digest || !this.authority.verifySignature(signature)) {
        throw new Error('invalid validation reference signature')
      }
      return generationIds
    } catch (error) {
      throw artifactError('E2E_ARTIFACT_VALIDATION_REFERENCES_INVALID', 'Validation 引用无效', error)
    }
  }

  private signPointer(pointer: Omit<ActivePointer, 'authoritySignature'>): ActivePointer {
    const digest = digestText('active-pointer/v1', canonicalizeJson(pointer))
    return { ...pointer, authoritySignature: this.authority.signDigest(digest) }
  }

  private parseAndVerifyPointer(candidate: unknown): ActivePointer {
    const pointer = parseActivePointer(candidate)
    const { authoritySignature, ...payload } = pointer
    const digest = digestText('active-pointer/v1', canonicalizeJson(payload))
    if (authoritySignature.signedDigest !== digest || !this.authority.verifySignature(authoritySignature)) {
      throw artifactError('E2E_ARTIFACT_POINTER_SIGNATURE_INVALID', 'Active pointer Authority 签名无效')
    }
    return pointer
  }
}

async function validateGeneration(
  session: SafeAssetSession,
  path: string,
  pointer: ActivePointer,
  authority: ArtifactStoreAuthority,
): Promise<boolean> {
  const manifest = await readValidGeneration(session, path, pointer.generationId, pointer.generationDigest, authority)
  return manifest !== undefined && pointer.fencingToken >= manifest.fencingToken
}

async function assertGenerationFileClosure(
  session: SafeAssetSession,
  path: string,
  manifest: GenerationManifest,
): Promise<void> {
  const manifestText = prettyJson(manifest)
  const expected = new Map(manifest.files.map((file) => [file.path, {
    byteLength: file.byteLength,
    digest: file.digest,
  }]))
  expected.set('.publication-integrity.json', {
    byteLength: Buffer.byteLength(manifestText),
    digest: digestBytes('generation-file:.publication-integrity.json', Buffer.from(manifestText)),
  })

  for (let pass = 0; pass < 2; pass += 1) {
    const actual = await session.listFiles(path)
    if (actual.length !== expected.size || actual.some((file) => {
      const registered = expected.get(file.path)
      return !registered || registered.byteLength !== file.byteLength
    })) {
      throw artifactError('E2E_ARTIFACT_FILE_CLOSURE_INVALID', 'Generation 存在缺失、未登记或大小不符的文件')
    }
    for (const file of actual) {
      const registered = expected.get(file.path)
      if (!registered) throw artifactError('E2E_ARTIFACT_FILE_CLOSURE_INVALID', `未登记文件：${file.path}`)
      const content = await session.read(`${path}/${file.path}`)
      if (digestBytes(`generation-file:${file.path}`, content) !== registered.digest) {
        throw artifactError('E2E_ARTIFACT_FILE_CLOSURE_INVALID', `文件摘要不匹配：${file.path}`)
      }
    }
  }
}

async function readValidGeneration(
  session: SafeAssetSession,
  path: string,
  generationId: string,
  generationDigest: string,
  authority: ArtifactStoreAuthority,
): Promise<GenerationManifest | undefined> {
  try {
    validateId(generationId, 'generationId')
    const manifestText = await session.readOptionalText(`${path}/.publication-integrity.json`)
    if (!manifestText) return undefined
    const manifest = parseGenerationManifest(JSON.parse(manifestText))
    if (manifest.generationId !== generationId || manifest.generationDigest !== generationDigest) return undefined
    const { generationDigest: storedDigest, authoritySignature, ...manifestCore } = manifest
    const expectedDigest = digestText('generation-manifest/v1', canonicalizeJson(manifestCore))
    if (storedDigest !== expectedDigest || authoritySignature.signedDigest !== expectedDigest
      || !authority.verifySignature(authoritySignature)) return undefined
    await assertGenerationFileClosure(session, path, manifest)
    return manifest
  } catch {
    return undefined
  }
}

function parseGenerationManifest(candidate: unknown): GenerationManifest {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw artifactError('E2E_ARTIFACT_MANIFEST_INVALID', 'Generation manifest 不是对象')
  }
  const manifest = candidate as Record<string, unknown>
  const signature = ArtifactSignatureSchema.safeParse(manifest.authoritySignature)
  if (!hasExactKeys(manifest, [
    'generationId', 'terminalVerdict', 'fencingToken', 'files', 'generationDigest', 'authoritySignature',
  ])
    || typeof manifest.generationId !== 'string'
    || !isFinalVerdict(manifest.terminalVerdict)
    || !Number.isSafeInteger(manifest.fencingToken) || (manifest.fencingToken as number) < 1
    || !Array.isArray(manifest.files) || !isDigest(manifest.generationDigest)
    || !signature.success) {
    throw artifactError('E2E_ARTIFACT_MANIFEST_INVALID', 'Generation manifest 字段无效')
  }
  validateId(manifest.generationId, 'generationId')
  const seen = new Set<string>()
  const files = manifest.files.map((candidateFile) => {
    if (!candidateFile || typeof candidateFile !== 'object' || Array.isArray(candidateFile)) {
      throw artifactError('E2E_ARTIFACT_MANIFEST_INVALID', 'Generation manifest file 不是对象')
    }
    const file = candidateFile as Record<string, unknown>
    if (!hasExactKeys(file, ['path', 'digest', 'byteLength']) || typeof file.path !== 'string' || !isDigest(file.digest)
      || !Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0) {
      throw artifactError('E2E_ARTIFACT_MANIFEST_INVALID', 'Generation manifest file 字段无效')
    }
    validateRelativePath(file.path)
    if (file.path === '.publication-integrity.json' || seen.has(file.path)) {
      throw artifactError('E2E_ARTIFACT_MANIFEST_INVALID', `Generation manifest file 重复或自引用：${file.path}`)
    }
    seen.add(file.path)
    return { path: file.path, digest: file.digest, byteLength: file.byteLength as number }
  })
  return {
    generationId: manifest.generationId,
    terminalVerdict: manifest.terminalVerdict,
    fencingToken: manifest.fencingToken as number,
    files,
    generationDigest: manifest.generationDigest,
    authoritySignature: signature.data,
  }
}

function validateId(value: string, field: string): void {
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value)) throw artifactError('E2E_ARTIFACT_ID_INVALID', `${field} 格式无效`)
}

function validateRelativePath(path: string): void {
  if (!RelativePathSchema.safeParse(path).success) {
    throw artifactError('E2E_ARTIFACT_PATH_INVALID', `Artifact 路径无效：${path}`)
  }
}

async function readSelectedSlot(session: SafeAssetSession): Promise<'a' | 'b' | undefined> {
  const selected = (await session.readOptionalText('active-slot'))?.trim()
  return selected === 'a' || selected === 'b' ? selected : undefined
}

function injectFault(actual: ArtifactFaultPoint | undefined, expected: ArtifactFaultPoint): void {
  if (actual === expected) throw artifactError('E2E_ARTIFACT_FAULT_INJECTED', `在 ${expected} 注入故障`)
}

function helperCrashPoint(
  actual: ArtifactFaultPoint | undefined,
  afterFileFsync: ArtifactFaultPoint,
  afterParentFsync: ArtifactFaultPoint,
): string | undefined {
  if (actual === 'disk-full-during-files' && afterFileFsync === 'crash-after-file-fsync') return 'raise-enospc'
  if (actual === 'permission-denied-before-manifest'
    && afterFileFsync === 'crash-after-manifest-fsync') return 'raise-eacces'
  if (actual === afterFileFsync) return 'after-file-fsync'
  if (actual === afterParentFsync) return 'after-parent-fsync'
  return undefined
}

function atomicCrashPoint(
  actual: ArtifactFaultPoint | undefined,
  afterTempFsync: ArtifactFaultPoint,
  afterRename: ArtifactFaultPoint,
  afterParentFsync: ArtifactFaultPoint,
): string | undefined {
  if (actual === afterTempFsync) return 'after-temp-fsync'
  if (actual === afterRename) return 'after-rename'
  if (actual === afterParentFsync) return 'after-parent-fsync'
  return undefined
}

function namedAtomicCrashPoint(
  actual: ArtifactFaultPoint | undefined,
  target: AtomicWriteTarget,
): string | undefined {
  if (actual === `crash-after-${target}-temp-fsync`) return 'after-temp-fsync'
  if (actual === `crash-after-${target}-rename`) return 'after-rename'
  if (actual === `crash-after-${target}-parent-fsync`) return 'after-parent-fsync'
  return undefined
}

function isCrashFault(value: ArtifactFaultPoint | undefined): boolean {
  return value?.startsWith('crash-') ?? false
}

function parseActivePointer(candidate: unknown): ActivePointer {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw artifactError('E2E_ARTIFACT_POINTER_INVALID', 'Active pointer 不是对象')
  }
  const pointer = candidate as Record<string, unknown>
  const keys = [
    'epoch', 'generationId', 'generationDigest', 'terminalVerdict', 'previousGenerationId',
    'previousGenerationDigest', 'fencingToken', 'authoritySignature',
  ]
  if (Object.keys(pointer).sort().join('\0') !== keys.sort().join('\0')
    || !Number.isSafeInteger(pointer.epoch) || (pointer.epoch as number) < 1
    || !Number.isSafeInteger(pointer.fencingToken) || (pointer.fencingToken as number) < 1
    || typeof pointer.generationId !== 'string' || typeof pointer.generationDigest !== 'string'
    || !isDigest(pointer.generationDigest) || !isFinalVerdict(pointer.terminalVerdict)
    || !ArtifactSignatureSchema.safeParse(pointer.authoritySignature).success) {
    throw artifactError('E2E_ARTIFACT_POINTER_INVALID', 'Active pointer 字段无效')
  }
  validateId(pointer.generationId, 'generationId')
  const previousId = pointer.previousGenerationId
  const previousDigest = pointer.previousGenerationDigest
  if ((previousId === null) !== (previousDigest === null)
    || (previousId !== null && (typeof previousId !== 'string' || typeof previousDigest !== 'string' || !isDigest(previousDigest)))) {
    throw artifactError('E2E_ARTIFACT_POINTER_INVALID', 'Active pointer previous 引用无效')
  }
  if (typeof previousId === 'string') validateId(previousId, 'previousGenerationId')
  return pointer as unknown as ActivePointer
}

async function readJournal(session: SafeAssetSession): Promise<ArtifactJournal | undefined> {
  const text = await session.readOptionalText('journal.json')
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !hasExactKeys(parsed, [
      'transactionId', 'generationId', 'generationDigest', 'previousActive', 'targetSlot',
      'fencingToken', 'phase', 'startedAt', 'updatedAt', 'checksum',
    ])) return undefined
    const { checksum, ...payload } = parsed
    const phases: JournalPhase[] = [
      'preparing', 'staged', 'generation-durable', 'pointer-written', 'pointer-selected', 'committed', 'aborted',
    ]
    if (typeof checksum !== 'string'
      || checksum !== digestText('artifact-journal/v1', canonicalizeJson(payload))
      || !phases.includes(payload.phase as JournalPhase)) return undefined
    if (typeof payload.transactionId !== 'string' || typeof payload.generationId !== 'string'
      || !isDigest(payload.generationDigest) || !Number.isSafeInteger(payload.fencingToken)
      || (payload.fencingToken as number) < 1 || !['a', 'b'].includes(payload.targetSlot as string)
      || typeof payload.startedAt !== 'string' || typeof payload.updatedAt !== 'string'
      || Number.isNaN(Date.parse(payload.startedAt)) || Number.isNaN(Date.parse(payload.updatedAt))
      || !isValidPreviousActive(payload.previousActive)) return undefined
    validateId(payload.transactionId, 'transactionId')
    validateId(payload.generationId, 'generationId')
    return payload as unknown as ArtifactJournal
  } catch {
    return undefined
  }
}

function isValidPreviousActive(candidate: unknown): boolean {
  if (candidate === null) return true
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const previous = candidate as Record<string, unknown>
  if (!hasExactKeys(previous, ['generationId', 'generationDigest', 'epoch'])
    || typeof previous.generationId !== 'string' || !isDigest(previous.generationDigest)
    || !Number.isSafeInteger(previous.epoch) || (previous.epoch as number) < 1) return false
  try {
    validateId(previous.generationId, 'previousGenerationId')
    return true
  } catch {
    return false
  }
}

function hasExactKeys(candidate: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(candidate).sort().join('\0') === [...keys].sort().join('\0')
}

async function hasPublicationState(session: SafeAssetSession): Promise<boolean> {
  const entries = await session.list()
  return entries.some((entry) => entry === 'journal.json' || entry === 'active-a.json'
    || entry === 'active-b.json' || entry === 'active-slot' || entry === 'generations'
    || entry === 'validation-refs.json')
}

async function cleanupAtomicTemps(session: SafeAssetSession): Promise<void> {
  for (const entry of await session.list()) {
    if (/^\.next-[a-f0-9]{32}$/.test(entry)) await session.removeTree(entry)
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isFinalVerdict(value: unknown): value is FinalVerdict {
  return typeof value === 'string' && [
    'accepted', 'rejected', 'incomplete', 'pending-decision', 'safety-blocked',
    'artifact-blocked', 'migration-required', 'environment-blocked', 'automation-blocked',
  ].includes(value)
}


function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function artifactError(code: string, message: string, cause?: unknown): E2EError {
  return new E2EError({ code, category: 'artifact', message, retryable: false, cause })
}
