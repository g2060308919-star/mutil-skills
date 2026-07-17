import { canonicalizeJson } from '@mutil-skills/e2e-contracts'
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  MAX_SECRET_BYTES,
  MAX_SECRET_ENTRIES,
  MAX_SECRET_SNAPSHOT_BYTES,
  SECRET_DIGEST_PATTERN,
  SECRET_REF_PATTERN,
  SECRET_RUN_ID_PATTERN,
  isSecretProviderId,
  secretFailure,
  type SecretProviderId,
} from './secret-contract.js'

const STATE_VERSION = '1.0.0'
const MAC = /^hmac-sha256:[a-f0-9]{64}$/
const ATTEMPT = /^[A-Za-z0-9-]{16,64}$/

export interface EncryptedSecretValue {
  nonce: string
  ciphertext: string
  tag: string
}

export interface AvailableSecretEntry {
  version: number
  providerId: SecretProviderId
  status: 'available'
  encrypted: EncryptedSecretValue
}

export interface ConsumedSecretEntry {
  version: number
  providerId: SecretProviderId
  status: 'consumed'
  terminalAt: string
}

export interface AbandonedSecretEntry {
  version: number
  providerId: Exclude<SecretProviderId, 'interactive'>
  status: 'abandoned'
  attemptId: string
  createdAt: string
  expiresAt: string
  terminalAt: string
}

export interface ResolvingSecretEntry {
  version: number
  providerId: Exclude<SecretProviderId, 'interactive'>
  status: 'resolving'
  attemptId: string
  createdAt: string
  expiresAt: string
}

export type PersistedSecretEntry = AvailableSecretEntry | ConsumedSecretEntry
  | AbandonedSecretEntry | ResolvingSecretEntry

export interface SecretRunState {
  projectIdentityDigest: string
  runId: string
  wrappedDataKey: EncryptedSecretValue
  entries: Record<string, PersistedSecretEntry>
}

export interface SecretStatePayload {
  capacity: { maxEntries: number; maxSnapshotBytes: number }
  runs: Record<string, SecretRunState>
}

interface SecretStateEnvelope {
  schemaVersion: typeof STATE_VERSION
  revision: number
  payload: SecretStatePayload
  mac: string
}

export function secretRunKey(projectIdentityDigest: string, runId: string): string {
  return `${projectIdentityDigest}\0${runId}`
}

export function initialSecretState(macKey: Buffer): string {
  return serializeSecretState({
    capacity: { maxEntries: MAX_SECRET_ENTRIES, maxSnapshotBytes: MAX_SECRET_SNAPSHOT_BYTES },
    runs: {},
  }, 1, macKey)
}

export function parseSecretState(
  raw: string,
  databaseRevision: number,
  wrappingKey: Buffer,
  macKey: Buffer,
): SecretStatePayload {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_SNAPSHOT_BYTES) throw integrityFailure()
    let candidate: unknown
    try { candidate = JSON.parse(raw) } catch { throw integrityFailure() }
    if (!record(candidate) || !exact(candidate, ['mac', 'payload', 'revision', 'schemaVersion'])
      || candidate.schemaVersion !== STATE_VERSION || candidate.revision !== databaseRevision
      || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1
      || typeof candidate.mac !== 'string' || !MAC.test(candidate.mac)
      || !record(candidate.payload)) throw integrityFailure()
    const unsigned = {
      schemaVersion: STATE_VERSION,
      revision: candidate.revision as number,
      payload: candidate.payload,
    }
    const expectedMac = computeMac(unsigned, macKey)
    try {
      const supplied = Buffer.from((candidate.mac as string).slice('hmac-sha256:'.length), 'hex')
      try {
        if (supplied.byteLength !== expectedMac.byteLength || !timingSafeEqual(supplied, expectedMac)) {
          throw integrityFailure()
        }
      } finally { supplied.fill(0) }
    } finally { expectedMac.fill(0) }
    const payload = parsePayload(candidate.payload)
    verifyPayloadCryptography(payload, wrappingKey)
    return payload
  } catch (error) {
    if (isIntegrityFailure(error)) throw error
    throw integrityFailure()
  }
}

export function serializeSecretState(payload: SecretStatePayload, revision: number, macKey: Buffer): string {
  const unsigned = { schemaVersion: STATE_VERSION, revision, payload }
  const macBytes = computeMac(unsigned, macKey)
  let mac: string
  try { mac = `hmac-sha256:${macBytes.toString('hex')}` } finally { macBytes.fill(0) }
  const serialized = canonicalizeJson({ ...unsigned, mac })
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SECRET_SNAPSHOT_BYTES) {
    throw secretFailure('E2E_SECRET_STATE_CAPACITY_EXCEEDED', 'Secret snapshot 超过 4MiB 上限')
  }
  return serialized
}

export function wrapRunDataKey(
  wrappingKey: Buffer,
  dataKey: Buffer,
  projectIdentityDigest: string,
  runId: string,
): EncryptedSecretValue {
  return encryptBytes(wrappingKey, dataKey, dataKeyAad(projectIdentityDigest, runId))
}

export function unwrapRunDataKey(
  wrappingKey: Buffer,
  wrapped: EncryptedSecretValue,
  projectIdentityDigest: string,
  runId: string,
): Buffer {
  return decryptBytes(wrappingKey, wrapped, dataKeyAad(projectIdentityDigest, runId), 32)
}

export function encryptSecret(
  dataKey: Buffer,
  plaintext: Buffer,
  runId: string,
  secretRef: string,
  providerId: SecretProviderId,
): EncryptedSecretValue {
  return encryptBytes(dataKey, plaintext, secretAad(runId, secretRef, providerId))
}

export function decryptSecret(
  dataKey: Buffer,
  encrypted: EncryptedSecretValue,
  runId: string,
  secretRef: string,
  providerId: SecretProviderId,
): Buffer {
  return decryptBytes(dataKey, encrypted, secretAad(runId, secretRef, providerId), MAX_SECRET_BYTES)
}

export function countSecretEntries(payload: SecretStatePayload): number {
  return Object.values(payload.runs).reduce((sum, run) => sum + Object.keys(run.entries).length, 0)
}

function parsePayload(value: Record<string, unknown>): SecretStatePayload {
  if (!exact(value, ['capacity', 'runs']) || !record(value.capacity)
    || !exact(value.capacity, ['maxEntries', 'maxSnapshotBytes'])
    || value.capacity.maxEntries !== MAX_SECRET_ENTRIES
    || value.capacity.maxSnapshotBytes !== MAX_SECRET_SNAPSHOT_BYTES
    || !record(value.runs) || Object.keys(value.runs).length > MAX_SECRET_ENTRIES) throw integrityFailure()
  let total = 0
  for (const [composite, rawRun] of Object.entries(value.runs)) {
    if (!record(rawRun) || !exact(rawRun, ['entries', 'projectIdentityDigest', 'runId', 'wrappedDataKey'])
      || typeof rawRun.projectIdentityDigest !== 'string' || !SECRET_DIGEST_PATTERN.test(rawRun.projectIdentityDigest)
      || typeof rawRun.runId !== 'string' || !SECRET_RUN_ID_PATTERN.test(rawRun.runId)
      || composite !== secretRunKey(rawRun.projectIdentityDigest, rawRun.runId)
      || !validEncrypted(rawRun.wrappedDataKey, 32) || !record(rawRun.entries)) throw integrityFailure()
    for (const [secretRef, rawEntry] of Object.entries(rawRun.entries)) {
      total += 1
      if (total > MAX_SECRET_ENTRIES || !SECRET_REF_PATTERN.test(secretRef) || !record(rawEntry)
        || !Number.isSafeInteger(rawEntry.version) || (rawEntry.version as number) < 1
        || !isSecretProviderId(rawEntry.providerId) || typeof rawEntry.status !== 'string') throw integrityFailure()
      if (rawEntry.status === 'available') {
        if (!exact(rawEntry, ['encrypted', 'providerId', 'status', 'version'])
          || !validEncrypted(rawEntry.encrypted, MAX_SECRET_BYTES)) throw integrityFailure()
      } else if (rawEntry.status === 'consumed') {
        if (!exact(rawEntry, ['providerId', 'status', 'terminalAt', 'version'])
          || !timestamp(rawEntry.terminalAt)) throw integrityFailure()
      } else if (rawEntry.status === 'resolving') {
        if (!exact(rawEntry, ['attemptId', 'createdAt', 'expiresAt', 'providerId', 'status', 'version'])
          || rawEntry.providerId === 'interactive' || !ATTEMPT.test(String(rawEntry.attemptId))
          || !timestamp(rawEntry.createdAt) || !timestamp(rawEntry.expiresAt)
          || Date.parse(String(rawEntry.expiresAt)) <= Date.parse(String(rawEntry.createdAt))) throw integrityFailure()
      } else if (rawEntry.status === 'abandoned') {
        if (!exact(rawEntry, ['attemptId', 'createdAt', 'expiresAt', 'providerId', 'status', 'terminalAt', 'version'])
          || rawEntry.providerId === 'interactive' || !ATTEMPT.test(String(rawEntry.attemptId))
          || !timestamp(rawEntry.createdAt) || !timestamp(rawEntry.expiresAt)
          || !timestamp(rawEntry.terminalAt)) throw integrityFailure()
      } else throw integrityFailure()
    }
  }
  return value as unknown as SecretStatePayload
}

function verifyPayloadCryptography(payload: SecretStatePayload, wrappingKey: Buffer): void {
  for (const run of Object.values(payload.runs)) {
    const dataKey = unwrapRunDataKey(
      wrappingKey, run.wrappedDataKey, run.projectIdentityDigest, run.runId,
    )
    try {
      if (dataKey.byteLength !== 32) throw integrityFailure()
      for (const [secretRef, entry] of Object.entries(run.entries)) {
        if (entry.status !== 'available') continue
        const plaintext = decryptSecret(dataKey, entry.encrypted, run.runId, secretRef, entry.providerId)
        try {
          if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_SECRET_BYTES) throw integrityFailure()
        } finally { plaintext.fill(0) }
      }
    } finally { dataKey.fill(0) }
  }
}

function encryptBytes(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedSecretValue {
  const nonce = randomBytes(12)
  let ciphertext: Buffer | undefined
  let tag: Buffer | undefined
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    tag = cipher.getAuthTag()
    return {
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: tag.toString('base64url'),
    }
  } finally {
    nonce.fill(0); aad.fill(0); ciphertext?.fill(0); tag?.fill(0)
  }
}

function decryptBytes(
  key: Buffer,
  encrypted: EncryptedSecretValue,
  aad: Buffer,
  maximum: number,
): Buffer {
  let nonce: Buffer | undefined
  let ciphertext: Buffer | undefined
  let tag: Buffer | undefined
  try {
    nonce = decodeBase64Url(encrypted.nonce, 12)
    ciphertext = decodeBase64Url(encrypted.ciphertext, maximum)
    tag = decodeBase64Url(encrypted.tag, 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } finally {
    nonce?.fill(0); ciphertext?.fill(0); tag?.fill(0); aad.fill(0)
  }
}

function validEncrypted(value: unknown, maximum: number): value is EncryptedSecretValue {
  if (!record(value) || !exact(value, ['ciphertext', 'nonce', 'tag'])
    || typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string'
    || typeof value.tag !== 'string') return false
  let nonce: Buffer | undefined
  let ciphertext: Buffer | undefined
  let tag: Buffer | undefined
  try {
    nonce = decodeBase64Url(value.nonce, 12)
    ciphertext = decodeBase64Url(value.ciphertext, maximum)
    tag = decodeBase64Url(value.tag, 16)
    return nonce.byteLength === 12 && ciphertext.byteLength >= 1 && ciphertext.byteLength <= maximum
      && tag.byteLength === 16
  } catch { return false }
  finally { nonce?.fill(0); ciphertext?.fill(0); tag?.fill(0) }
}

function decodeBase64Url(value: string, maximum: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3) + 2) {
    throw integrityFailure()
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength > maximum || decoded.toString('base64url') !== value) {
    decoded.fill(0)
    throw integrityFailure()
  }
  return decoded
}

function computeMac(unsigned: unknown, key: Buffer): Buffer {
  return createHmac('sha256', key).update(canonicalizeJson(unsigned), 'utf8').digest()
}

function secretAad(runId: string, secretRef: string, providerId: SecretProviderId): Buffer {
  return Buffer.from(canonicalizeJson({ runId, secretRef, providerId }), 'utf8')
}

function dataKeyAad(projectIdentityDigest: string, runId: string): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: 'e2e-secret-data-key/v1', projectIdentityDigest, runId,
  }), 'utf8')
}

function timestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function exact(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function integrityFailure(): ReturnType<typeof secretFailure> {
  return secretFailure('E2E_SECRET_STATE_INTEGRITY_FAILED', 'Secret state schema、revision、MAC 或密文认证失败')
}

function isIntegrityFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'E2E_SECRET_STATE_INTEGRITY_FAILED'
}
