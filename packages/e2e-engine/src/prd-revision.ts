import {
  E2EError,
  canonicalizeJson,
  digestBytes,
  digestRecords,
  digestText,
  type DigestRecord,
} from '@mutil-skills/e2e-contracts'

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024
const MAX_ATTACHMENTS = 100

export interface PrdAttachmentInput {
  sourceId: string
  fileName: string
  mediaType: string
  bytes: Uint8Array
}

export interface PrdRevisionSnapshot {
  prdRevision: string
  normalizedPrdDigest: string
  sourceIdentityDigest: string
  attachments: Array<{
    sourceId: string
    fileName: string
    mediaType: string
    byteLength: number
    contentDigest: string
    metadataDigest: string
  }>
}

export function computePrdRevision(input: {
  normalizedPrd: string
  sourceIdentity: { sourceId: string; version: string; kind: string }
  attachments: PrdAttachmentInput[]
}): PrdRevisionSnapshot {
  validateInput(input)
  const normalizedPrd = input.normalizedPrd.normalize('NFC').replace(/\r\n?/g, '\n')
  const normalizedPrdBytes = Buffer.from(normalizedPrd, 'utf8')
  const attachments = input.attachments.map((attachment) => {
      const metadata = {
        sourceId: attachment.sourceId,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        byteLength: attachment.bytes.byteLength,
      }
      const metadataText = canonicalizeJson(metadata)
      return {
        ...metadata,
        contentDigest: digestBytes('attachment-bytes/v1', attachment.bytes),
        metadataDigest: digestBytes('attachment-metadata/v1', Buffer.from(metadataText, 'utf8')),
      }
  })
  const attachmentManifest = canonicalizeJson(attachments.map((attachment) => ({
    sourceId: attachment.sourceId,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    byteLength: attachment.byteLength,
    contentDigest: attachment.contentDigest,
  })))
  const sourceIdentityText = canonicalizeJson(input.sourceIdentity)
  const records: DigestRecord[] = [
    {
      domain: 'normalized-prd/v1',
      digest: digestText('normalized-prd/v1', normalizedPrd),
      length: normalizedPrdBytes.byteLength,
    },
    {
      domain: 'attachment-manifest/v1',
      digest: digestBytes('attachment-manifest/v1', Buffer.from(attachmentManifest, 'utf8')),
      length: Buffer.byteLength(attachmentManifest, 'utf8'),
    },
    ...attachments.map((attachment): DigestRecord => ({
      domain: `attachment-bytes/v1:${attachment.sourceId}`,
      digest: attachment.contentDigest,
      length: attachment.byteLength,
    })),
    {
      domain: 'source-identity/v1',
      digest: digestBytes('source-identity/v1', Buffer.from(sourceIdentityText, 'utf8')),
      length: Buffer.byteLength(sourceIdentityText, 'utf8'),
    },
  ]
  return {
    prdRevision: digestRecords(records),
    normalizedPrdDigest: records[0]!.digest,
    sourceIdentityDigest: records.at(-1)!.digest,
    attachments,
  }
}

export function diffPrdRevision(input: {
  previous: PrdRevisionSnapshot
  current: PrdRevisionSnapshot
  entities: Array<{ entityId: string; sourceIds: string[] }>
}): {
  previousRevision: string
  currentRevision: string
  changedSourceIds: string[]
  impactedEntityIds: string[]
  stableEntityIds: string[]
  scopeReapprovalRequired: boolean
} {
  const entityIds = input.entities.map((entity) => entity.entityId)
  if (new Set(entityIds).size !== entityIds.length) throw revisionError('E2E_PRD_ENTITY_ID_DUPLICATE', '实体 ID 必须唯一')
  const previous = new Map(input.previous.attachments.map((attachment) => [attachment.sourceId, attachment]))
  const current = new Map(input.current.attachments.map((attachment) => [attachment.sourceId, attachment]))
  const sourceIds = [...new Set([...previous.keys(), ...current.keys()])].sort()
  const changedSourceIds = sourceIds.filter((sourceId) => {
    const left = previous.get(sourceId)
    const right = current.get(sourceId)
    return !left || !right || left.contentDigest !== right.contentDigest || left.metadataDigest !== right.metadataDigest
  })
  if (input.previous.normalizedPrdDigest !== input.current.normalizedPrdDigest) changedSourceIds.unshift('PRD-BODY')
  if (input.previous.sourceIdentityDigest !== input.current.sourceIdentityDigest) changedSourceIds.push('SOURCE-IDENTITY')
  const changed = new Set(changedSourceIds)
  const globalSourceChanged = changed.has('PRD-BODY') || changed.has('SOURCE-IDENTITY')
  const impactedEntityIds = input.entities
    .filter((entity) => globalSourceChanged || entity.sourceIds.some((sourceId) => changed.has(sourceId)))
    .map((entity) => entity.entityId)
    .sort()
  const impacted = new Set(impactedEntityIds)
  const stableEntityIds = entityIds.filter((entityId) => !impacted.has(entityId)).sort()
  return {
    previousRevision: input.previous.prdRevision,
    currentRevision: input.current.prdRevision,
    changedSourceIds: [...new Set(changedSourceIds)],
    impactedEntityIds,
    stableEntityIds,
    scopeReapprovalRequired: input.previous.prdRevision !== input.current.prdRevision,
  }
}

function validateInput(input: {
  normalizedPrd: string
  sourceIdentity: { sourceId: string; version: string; kind: string }
  attachments: PrdAttachmentInput[]
}): void {
  if (typeof input.normalizedPrd !== 'string' || input.normalizedPrd.length === 0) {
    throw revisionError('E2E_PRD_TEXT_REQUIRED', 'PRD 正文必须是非空 UTF-8 文本')
  }
  if (!isSafeId(input.sourceIdentity.sourceId) || input.sourceIdentity.version === '' || input.sourceIdentity.kind === '') {
    throw revisionError('E2E_PRD_SOURCE_IDENTITY_INVALID', '来源身份不完整')
  }
  if (input.attachments.length > MAX_ATTACHMENTS) throw revisionError('E2E_PRD_ATTACHMENT_LIMIT', '附件数量超限')
  const sourceIds = input.attachments.map((attachment) => attachment.sourceId)
  if (new Set(sourceIds).size !== sourceIds.length) throw revisionError('E2E_PRD_ATTACHMENT_ID_DUPLICATE', '附件 sourceId 必须唯一')
  let totalBytes = 0
  for (const attachment of input.attachments) {
    if (!isSafeId(attachment.sourceId) || attachment.fileName === '' || attachment.mediaType === '') {
      throw revisionError('E2E_PRD_ATTACHMENT_METADATA_INVALID', '附件元数据不完整')
    }
    if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw revisionError('E2E_PRD_ATTACHMENT_SIZE_LIMIT', '单个附件必须是不超过 50MB 的原始 bytes')
    }
    totalBytes += attachment.bytes.byteLength
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw revisionError('E2E_PRD_ATTACHMENT_TOTAL_LIMIT', '附件总大小超过 200MB')
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/.test(value)
}

function revisionError(code: string, message: string): E2EError {
  return new E2EError({ code, category: 'source', message, retryable: false })
}
