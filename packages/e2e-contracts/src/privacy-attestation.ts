import { z } from 'zod'
import { ArtifactSignatureSchema, RelativePathSchema } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)

export const SanitizerAttestationBindingSchema = z.object({
  evidenceId: SafeIdSchema,
  relativePath: RelativePathSchema,
  evidenceType: z.enum(['dom', 'screenshot', 'network', 'console', 'trace', 'video']),
  sanitizerVersion: SemverSchema,
  recordDigest: DigestSchema,
  outputDigest: DigestSchema,
  policyDigest: DigestSchema,
  fileDigest: DigestSchema,
  sanitizedBytesDigest: DigestSchema,
}).strict()

export const SanitizerAttestationSchema = SanitizerAttestationBindingSchema.extend({
  schemaVersion: z.literal('1.0.0'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('sanitizer-attestation/v1'),
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(4096),
}).strict()

export const SanitizerVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('sanitizer-attestation/v1'),
  algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024),
  publicKeyDigest: DigestSchema,
}).strict()

export const PrivacyReviewReceiptBindingSchema = z.object({
  evidenceId: SafeIdSchema,
  relativePath: RelativePathSchema,
  fileDigest: DigestSchema,
  outputDigest: DigestSchema,
  sanitizerProofDigest: DigestSchema,
  policyDigest: DigestSchema,
  decision: z.enum(['approved', 'rejected']),
  checkedAt: z.string().datetime({ offset: true }),
  approver: z.object({ subject: SafeIdSchema, roles: z.array(SafeIdSchema).min(1).max(64) }).strict(),
}).strict()

export const PrivacyReviewReceiptSchema = PrivacyReviewReceiptBindingSchema.extend({
  schemaVersion: z.literal('1.0.0'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('privacy-review-receipt/v1'),
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(4096),
}).strict()

export const PrivacyReviewVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'), issuer: SafeIdSchema, keyId: SafeIdSchema,
  purpose: z.literal('privacy-review-receipt/v1'), algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024), publicKeyDigest: DigestSchema,
}).strict()

export type SanitizerAttestationBinding = z.infer<typeof SanitizerAttestationBindingSchema>
export type SanitizerAttestation = z.infer<typeof SanitizerAttestationSchema>
export type SanitizerVerifierMaterial = z.infer<typeof SanitizerVerifierMaterialSchema>
export type PrivacyReviewReceiptBinding = z.infer<typeof PrivacyReviewReceiptBindingSchema>
export type PrivacyReviewReceipt = z.infer<typeof PrivacyReviewReceiptSchema>
export type PrivacyReviewVerifierMaterial = z.infer<typeof PrivacyReviewVerifierMaterialSchema>
