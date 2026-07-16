import { createHash } from 'node:crypto'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
export const AssetIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/)
  .refine((value) => value.split('/').every((part) => part !== '.' && part !== '..'), 'assetId 包含非法段')
export const RelativePathSchema = z.string().min(1).max(2048)
  .regex(/^(?!\/)(?!.*\\)(?!.*:)(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!(?:.*\/)?(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?(?:\/|$))[^\0/]+(?:\/[^\0/]+)*$/)

export const ArtifactDependencySchema = z.object({
  artifactId: SafeIdSchema,
  artifactType: SafeIdSchema,
  schemaVersion: SemverSchema,
  relativePath: RelativePathSchema,
  digest: DigestSchema,
}).strict()

export const ArtifactSignatureSchema = z.object({
  issuer: z.string().min(1),
  keyId: z.string().min(1),
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1),
}).strict()
export type ArtifactSignature = z.infer<typeof ArtifactSignatureSchema>

export const ArtifactAuthorityVerifierMaterialSchema = z.object({
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('artifact-authority-signature/v1'),
  algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024),
  publicKeyDigest: DigestSchema,
}).strict()
export type ArtifactAuthorityVerifierMaterial = z.infer<typeof ArtifactAuthorityVerifierMaterialSchema>

export const ArtifactEnvelopeSchema = z.object({
  artifactId: SafeIdSchema,
  artifactType: SafeIdSchema,
  schemaVersion: SemverSchema,
  engineVersion: SemverSchema,
  assetId: AssetIdSchema,
  prdRevision: DigestSchema,
  generationId: SafeIdSchema,
  createdAt: z.string().datetime(),
  contentDigest: DigestSchema,
  signatures: z.array(ArtifactSignatureSchema),
  dependencies: z.array(ArtifactDependencySchema),
}).strict()

export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>

export type E2EErrorCategory =
  | 'validation'
  | 'source'
  | 'decision'
  | 'input'
  | 'environment'
  | 'safety'
  | 'automation'
  | 'business'
  | 'evidence'
  | 'artifact'
  | 'internal'

export interface E2EErrorInput {
  code: string
  category: E2EErrorCategory
  message: string
  retryable: boolean
  refs?: string[]
  cause?: unknown
}

export class E2EError extends Error {
  readonly code: string
  readonly category: E2EErrorCategory
  readonly retryable: boolean
  readonly refs: string[]

  constructor(input: E2EErrorInput) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = 'E2EError'
    this.code = input.code
    this.category = input.category
    this.retryable = input.retryable
    this.refs = [...(input.refs ?? [])]
  }
}

export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value, new Set())
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidJson('JSON 数字必须是有限值')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw invalidJson(`不支持的 JSON 值类型：${typeof value}`)
  }
  if (ancestors.has(value)) throw invalidJson('JSON 不能包含循环引用')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeCanonical(item, ancestors)).join(',')}]`
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidJson('JSON 对象必须是普通对象')
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${serializeCanonical(nested, ancestors)}`)
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function digestBytes(domain: string, bytes: Uint8Array): string {
  if (domain.length === 0 || domain.includes('\0')) {
    throw new E2EError({
      code: 'E2E_DIGEST_DOMAIN_INVALID',
      category: 'validation',
      message: '摘要 domain 必须非空且不能包含 NUL',
      retryable: false,
    })
  }
  const prefix = Buffer.from(`BIZTEST\0${domain}\0${bytes.byteLength}\0`, 'utf8')
  const hash = createHash('sha256').update(prefix).update(bytes).digest('hex')
  return `sha256:${hash}`
}

export function digestText(domain: string, text: string): string {
  const normalized = text.normalize('NFC').replace(/\r\n?/g, '\n')
  return digestBytes(domain, Buffer.from(normalized, 'utf8'))
}

export function digestCanonicalGrantApprovalSubject(
  approvalType: 'discovery' | 'execution',
  subject: unknown,
): string {
  return digestText('e2e-canonical-approval-subject/v1', canonicalizeJson({
    kind: 'grant-subject', approvalType, subject,
  }))
}

export interface DigestRecord {
  domain: string
  digest: string
  length: number
}

export function digestRecords(records: DigestRecord[]): string {
  for (const record of records) {
    if (!DigestSchema.safeParse(record.digest).success || !Number.isSafeInteger(record.length) || record.length < 0) {
      throw new E2EError({
        code: 'E2E_DIGEST_RECORD_INVALID',
        category: 'validation',
        message: '摘要记录包含无效 digest 或 length',
        retryable: false,
      })
    }
  }
  return digestBytes('digest-records/v1', Buffer.from(canonicalizeJson(records), 'utf8'))
}

export function digestArtifactContent(domain: string, artifact: Record<string, unknown>): string {
  const content = { ...artifact }
  delete content.contentDigest
  delete content.signatures
  return digestBytes(domain, Buffer.from(canonicalizeJson(content), 'utf8'))
}

function invalidJson(message: string): E2EError {
  return new E2EError({
    code: 'E2E_CANONICAL_JSON_INVALID',
    category: 'validation',
    message,
    retryable: false,
  })
}
