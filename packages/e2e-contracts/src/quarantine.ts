import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

export const SealedEvidenceEnvelopeSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  keyId: z.string().min(1).max(256),
  algorithm: z.literal('AES-256-GCM'),
  iv: Base64Schema,
  authTag: Base64Schema,
  ciphertext: Base64Schema,
  aadDigest: DigestSchema,
}).strict()

export const QuarantineEvidenceRecordSchema = z.object({
  relativePath: z.string().min(1).max(4096),
  pathDigest: DigestSchema,
  ciphertextFile: z.string().min(1).max(512),
  plaintextDigest: DigestSchema,
  byteLength: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict()

export const QuarantineRunManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  runId: z.string().min(1).max(128),
  keyId: z.string().min(1).max(256),
  status: z.enum(['open', 'privacy-unlocked']),
  privacyUnlock: z.object({
    grantId: z.string().min(1),
    approverSubject: z.string().min(1),
    expiresAt: z.string().datetime(),
  }).strict().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  files: z.array(QuarantineEvidenceRecordSchema),
}).strict().superRefine((manifest, context) => {
  if (manifest.status === 'open' && manifest.privacyUnlock !== undefined) {
    context.addIssue({ code: 'custom', message: 'open manifest cannot contain privacyUnlock', path: ['privacyUnlock'] })
  }
  if (manifest.status === 'privacy-unlocked' && manifest.privacyUnlock === undefined) {
    context.addIssue({ code: 'custom', message: 'privacy-unlocked manifest requires privacyUnlock', path: ['privacyUnlock'] })
  }
})

export type SealedEvidenceEnvelope = z.infer<typeof SealedEvidenceEnvelopeSchema>
export type QuarantineEvidenceRecord = z.infer<typeof QuarantineEvidenceRecordSchema>
export type QuarantineRunManifest = z.infer<typeof QuarantineRunManifestSchema>

export interface QuarantineActor {
  subject: string
  roles: Array<'e2e-runner' | 'e2e-sanitizer' | 'e2e-publisher' | 'privacy-approver' | 'e2e-privacy-admin'>
}

export interface QuarantineAuditEvent {
  sequence: number
  runId: string
  actorSubject: string
  actorRoles: string[]
  action: 'create' | 'write' | 'read' | 'decrypt' | 'destroy' | 'expire' | 'recovery-unlock' | 'recovery-destroy'
  decision: 'allowed' | 'denied'
  reasonCode: string
  targetDigest?: string
  timestamp: string
  previousChainDigest: string
  eventDigest: string
}

export interface PrivacyUnlockGrant {
  grantId: string
  issuer: string
  keyId: string
  proofScope: 'local-os-user'
  runId: string
  quarantineKeyId: string
  approver: { subject: string; roles: string[] }
  issuedAt: string
  expiresAt: string
  signature: string
}
