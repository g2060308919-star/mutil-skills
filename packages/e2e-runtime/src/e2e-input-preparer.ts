import {
  ActorDataIntentV1Schema,
  PrdUnderstandingContractHeaderSchema,
  canonicalizeJson,
  digestBytes,
  digestText,
  E2EError,
  type RuntimeRequestEnvelope,
} from '@mutil-skills/e2e-contracts'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'
import { resolveProjectIdentity } from './project-identity.js'
import { SecureProjectFileReader, type SecureProjectRootBinding } from './secure-project-files.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const SafeAssetPathSegmentSchema = SafeIdSchema.refine(
  (value) => value !== '.' && value !== '..',
  'assetId 不能是路径导航段',
)
const OriginSchema = z.object({
  kind: z.enum(['file', 'url', 'text']), ref: z.string().min(1).max(8_192),
}).strict()
const SourceTextSchema = z.string().min(1).max(1024 * 1024).refine(
  (value) => Buffer.byteLength(value, 'utf8') <= 1024 * 1024,
  'UTF-8 bytes 不得超过 1 MiB',
)
const RuntimePolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('offline') }).strict(),
  z.object({ mode: z.literal('stable') }).strict(),
  z.object({ mode: z.literal('pinned'), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    installationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }).strict(),
])

export const E2EInputDraftSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  assetId: SafeAssetPathSegmentSchema,
  prd: z.object({ text: SourceTextSchema, origin: OriginSchema }).strict(),
  understandingContract: z.object({
    text: SourceTextSchema,
    header: PrdUnderstandingContractHeaderSchema,
  }).strict(),
  runtimePolicy: RuntimePolicySchema.optional(),
  supportingSources: z.array(z.object({
    sourceId: SafeIdSchema,
    text: SourceTextSchema,
    mediaType: z.string().min(1).max(256),
    origin: OriginSchema,
  }).strict()).max(100).default([]),
  actorDataIntents: z.array(ActorDataIntentV1Schema).max(1000).default([]),
}).strict().superRefine((value, context) => {
  const sourceBytes = Buffer.byteLength(value.prd.text, 'utf8')
    + value.supportingSources.reduce((total, source) => total + Buffer.byteLength(source.text, 'utf8'), 0)
  if (sourceBytes > 8 * 1024 * 1024) context.addIssue({
    code: 'custom', path: ['supportingSources'],
    message: 'PRD 与 supporting sources 总量不得超过 8 MiB',
  })
  const intentIds = value.actorDataIntents.map((intent) => intent.intentId)
  if (new Set(intentIds).size !== intentIds.length) context.addIssue({
    code: 'custom', path: ['actorDataIntents'], message: 'intentId 必须唯一',
  })
})

export type E2EInputDraft = z.input<typeof E2EInputDraftSchema>
type CreateRunPayload = Extract<RuntimeRequestEnvelope, { command: 'create-run' }>['payload']

export interface PreparedE2EInput {
  schemaVersion: '1.0.0'
  intakeId: string
  projectRoot: string
  create: CreateRunPayload
}

/** 把 Skill 已理解并确认的来源 bytes 封装成 Runtime 可冻结的内部输入，不生成需求语义。 */
export class E2EInputPreparer {
  constructor(private readonly projectRoot: string) {}

  async prepare(input: E2EInputDraft): Promise<PreparedE2EInput> {
    const draft = E2EInputDraftSchema.parse(input)
    const reader = new SecureProjectFileReader()
    const rootBinding = await reader.inspectProjectRoot(this.projectRoot)
    const root = rootBinding.realRoot
    await ensurePrivateDirectories(root, ['.biztest'])
    await ensureProjectIdentity(root)
    await resolveProjectIdentity(root, reader)

    const projectPolicy = await readProjectPolicySnapshot(root, rootBinding, reader)
      ?? Buffer.from('{}\n', 'utf8')
    const intakeDigest = digestText('e2e-input-draft/v1', canonicalizeJson({
      draft,
      projectPolicyDigest: digestBytes('e2e-input-project-policy/v1', projectPolicy),
    }))
    const intakeId = `INTAKE-${intakeDigest.slice(7, 31).toUpperCase()}`
    const segments = ['.biztest', 'e2e-intake', draft.assetId, intakeId]
    const intakeRoot = await ensurePrivateDirectories(root, segments)
    await Promise.all([
      writeImmutable(intakeRoot, 'prd.md', draft.prd.text),
      writeImmutable(intakeRoot, 'requirements-contract.md', draft.understandingContract.text),
      writeImmutable(intakeRoot, 'project-policy.json', projectPolicy),
      ...draft.supportingSources.map((source, index) =>
        writeImmutable(intakeRoot, `supporting-${String(index + 1).padStart(3, '0')}.txt`, source.text)),
    ])
    const path = (name: string): string => relative(root, join(intakeRoot, name)).split(sep).join('/')
    const payload: CreateRunPayload = {
      assetId: draft.assetId,
      prdSource: { kind: 'file', path: path('prd.md'), origin: draft.prd.origin },
      understandingContract: {
        header: draft.understandingContract.header,
        source: { kind: 'file', path: path('requirements-contract.md') },
      },
      projectPolicyPath: path('project-policy.json'),
      ...(draft.runtimePolicy === undefined ? {} : { runtimePolicy: draft.runtimePolicy }),
      supportingSources: draft.supportingSources.map((source, index) => ({
        sourceId: source.sourceId, kind: 'file',
        path: path(`supporting-${String(index + 1).padStart(3, '0')}.txt`),
        mediaType: source.mediaType, origin: source.origin,
        relevance: 'necessary-dependency',
      })),
      actorDataIntents: draft.actorDataIntents,
    }
    return { schemaVersion: '1.0.0', intakeId, projectRoot: root, create: payload }
  }
}

async function ensureProjectIdentity(root: string): Promise<void> {
  const path = join(root, '.biztest', 'project.json')
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw intakeError(
      'E2E_INPUT_PROJECT_IDENTITY_UNSAFE', '.biztest/project.json 不是普通文件',
    )
    return
  }
  const value = `${JSON.stringify({
    schemaVersion: '1.0.0', projectId: `E2E-${randomUUID()}`,
  }, null, 2)}\n`
  try {
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  await secureExistingFile(path, undefined, 'E2E_INPUT_PROJECT_IDENTITY_UNSAFE',
    '.biztest/project.json 不是普通文件')
}

async function ensurePrivateDirectories(root: string, segments: string[]): Promise<string> {
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing === undefined) {
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
    }
    const info = await lstat(current)
    const wrongOwner = typeof process.getuid === 'function'
      && String(info.uid) !== String(process.getuid())
    if (!info.isDirectory() || info.isSymbolicLink() || wrongOwner) throw intakeError(
      'E2E_INPUT_PATH_UNSAFE', `接入目录不安全：${segment}`,
    )
    await chmod(current, 0o700)
  }
  return current
}

async function writeImmutable(root: string, name: string, data: string | Uint8Array): Promise<void> {
  const path = join(root, name)
  try {
    await writeFile(path, data, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  await secureExistingFile(path, data, 'E2E_INPUT_SNAPSHOT_CONFLICT',
    `同一 intake 文件已存在不同内容：${name}`)
}

async function readProjectPolicySnapshot(
  root: string,
  binding: SecureProjectRootBinding,
  reader: SecureProjectFileReader,
): Promise<Buffer | undefined> {
  const policyPath = join(root, '.biztest', 'project-policy.json')
  const existing = await lstat(policyPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing === undefined) return undefined
  return await reader.readFile(binding, '.biztest/project-policy.json', 1024 * 1024)
}

async function secureExistingFile(
  path: string,
  expectedData: string | Uint8Array | undefined,
  code: string,
  message: string,
): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    const wrongOwner = typeof process.getuid === 'function'
      && String(info.uid) !== String(process.getuid())
    if (!info.isFile() || info.nlink !== 1 || wrongOwner
      || (expectedData !== undefined
        && !Buffer.from(await handle.readFile()).equals(Buffer.from(expectedData)))) {
      throw intakeError(code, message)
    }
    await handle.chmod(0o600)
  } catch (error) {
    if (error instanceof E2EError) throw error
    throw intakeError(code, message)
  } finally {
    await handle?.close()
  }
}

function intakeError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'input', message: `${code}: ${message}`, retryable: false })
}
