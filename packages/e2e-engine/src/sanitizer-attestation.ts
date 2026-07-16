import {
  SanitizerAttestationBindingSchema, SanitizerAttestationSchema, SanitizerPolicySchema,
  SanitizerVerifierMaterialSchema, canonicalizeJson, digestBytes, digestText,
  type SanitizerAttestation, type SanitizerAttestationBinding, type SanitizerPolicy,
  type SanitizerVerifierMaterial,
} from '@mutil-skills/e2e-contracts'
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { sanitizeConsoleEvidence, sanitizeDomEvidence } from './structured-sanitizers.js'
import { sanitizeVisualEvidence, type VisualSanitizerAdapter } from './visual-sanitizer.js'
import type { PrivacyScanner } from './privacy-scanner.js'
import type { SanitizationOutcome } from './network-sanitizer.js'

export type AttestedSanitizationOutcome =
  | (Extract<SanitizationOutcome, { status: 'publishable' | 'review-required' }> & { attestation: SanitizerAttestation })
  | Extract<SanitizationOutcome, { status: 'blocked' }>

export class LocalSanitizerAuthority {
  readonly #issuer: string
  readonly #keyId: string
  readonly #policy: SanitizerPolicy
  readonly #scanner?: PrivacyScanner
  readonly #visualAdapter?: VisualSanitizerAdapter
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject

  private constructor(options: {
    issuer: string; keyId: string; policy: SanitizerPolicy; scanner?: PrivacyScanner
    visualAdapter?: VisualSanitizerAdapter
  }, privateKey: KeyObject, publicKey: KeyObject) {
    this.#issuer = options.issuer
    this.#keyId = options.keyId
    this.#policy = structuredClone(SanitizerPolicySchema.parse(options.policy))
    this.#scanner = options.scanner ? Object.freeze({
      version: options.scanner.version, scan: options.scanner.scan.bind(options.scanner),
    }) : undefined
    this.#visualAdapter = options.visualAdapter ? Object.freeze({
      version: options.visualAdapter.version,
      supportedFormats: Object.freeze([...options.visualAdapter.supportedFormats]),
      sanitize: options.visualAdapter.sanitize.bind(options.visualAdapter),
    }) : undefined
    this.#privateKey = privateKey
    this.#publicKey = publicKey
  }

  static create(options: {
    issuer: string; keyId: string; policy: SanitizerPolicy; scanner?: PrivacyScanner
    visualAdapter?: VisualSanitizerAdapter
  }): LocalSanitizerAuthority {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(options.issuer) || !/^[A-Za-z0-9._:-]{1,256}$/.test(options.keyId)) {
      throw new Error('E2E_SANITIZER_AUTHORITY_ID_INVALID')
    }
    const keys = generateKeyPairSync('ed25519')
    return new LocalSanitizerAuthority(options, keys.privateKey, keys.publicKey)
  }

  sanitizeDom(input: { evidenceId: string; relativePath: string; raw: Uint8Array }): AttestedSanitizationOutcome {
    return this.#attest(input, sanitizeDomEvidence({ raw: input.raw, policy: this.#policy, scanner: this.#scanner }))
  }

  sanitizeConsole(input: { evidenceId: string; relativePath: string; raw: Uint8Array }): AttestedSanitizationOutcome {
    return this.#attest(input, sanitizeConsoleEvidence({ raw: input.raw, policy: this.#policy, scanner: this.#scanner }))
  }

  sanitizeVisual(input: {
    evidenceId: string; relativePath: string; raw: Uint8Array; evidenceType: 'screenshot' | 'video'
  }): AttestedSanitizationOutcome {
    return this.#attest(input, sanitizeVisualEvidence({ raw: input.raw, evidenceType: input.evidenceType,
      policy: this.#policy, scanner: this.#scanner, adapter: this.#visualAdapter }))
  }

  #attest(input: { evidenceId: string; relativePath: string }, outcome: SanitizationOutcome): AttestedSanitizationOutcome {
    if (outcome.status === 'blocked') return outcome
    const bytes = Buffer.from(outcome.bytes)
    const recordDigest = digestText('sanitization-record/v1', canonicalizeJson(outcome.record))
    const binding = SanitizerAttestationBindingSchema.parse({
      evidenceId: input.evidenceId, relativePath: input.relativePath,
      evidenceType: outcome.record.evidenceType, sanitizerVersion: outcome.record.sanitizerVersion,
      recordDigest, outputDigest: outcome.record.outputDigest, policyDigest: outcome.record.policyDigest,
      fileDigest: digestBytes(`generation-file:${input.relativePath}`, bytes),
      sanitizedBytesDigest: digestBytes('sanitizer-output/v1', bytes),
    })
    const signedDigest = digestText('sanitizer-attestation-binding/v1', canonicalizeJson(binding))
    const attestation = SanitizerAttestationSchema.parse({ ...binding, schemaVersion: '1.0.0',
      issuer: this.#issuer, keyId: this.#keyId, purpose: 'sanitizer-attestation/v1', algorithm: 'Ed25519', signedDigest,
      signature: sign(null, sanitizerProofPayload(this.#issuer, this.#keyId, signedDigest), this.#privateKey).toString('base64url') })
    return { ...outcome, bytes, attestation }
  }

  get verifierMaterial(): SanitizerVerifierMaterial {
    const spki = this.#publicKey.export({ type: 'spki', format: 'der' })
    return SanitizerVerifierMaterialSchema.parse({ schemaVersion: '1.0.0', issuer: this.#issuer, keyId: this.#keyId,
      purpose: 'sanitizer-attestation/v1', algorithm: 'Ed25519', publicKeySpkiBase64: spki.toString('base64'),
      publicKeyDigest: digestBytes('sanitizer-public-key/v1', spki) })
  }
}

export function createSanitizerAttestationVerifier(
  candidateMaterial: SanitizerVerifierMaterial,
  expectedPublicKeyDigest: string,
): (attestation: SanitizerAttestation, binding: SanitizerAttestationBinding) => boolean {
  const parsed = SanitizerVerifierMaterialSchema.safeParse(candidateMaterial)
  if (!parsed.success || parsed.data.publicKeyDigest !== expectedPublicKeyDigest) return () => false
  let publicKey: KeyObject
  try {
    const spki = Buffer.from(parsed.data.publicKeySpkiBase64, 'base64')
    if (digestBytes('sanitizer-public-key/v1', spki) !== parsed.data.publicKeyDigest) return () => false
    publicKey = createPublicKey({ key: spki, type: 'spki', format: 'der' })
  } catch { return () => false }
  return (candidate, expected) => {
    const attestation = SanitizerAttestationSchema.safeParse(candidate)
    const binding = SanitizerAttestationBindingSchema.safeParse(expected)
    if (!attestation.success || !binding.success) return false
    const { schemaVersion: _schemaVersion, issuer, keyId, purpose, algorithm, signedDigest, signature,
      ...actualBinding } = attestation.data
    if (issuer !== parsed.data.issuer || keyId !== parsed.data.keyId || purpose !== parsed.data.purpose
      || algorithm !== parsed.data.algorithm || canonicalizeJson(actualBinding) !== canonicalizeJson(binding.data)) return false
    const expectedDigest = digestText('sanitizer-attestation-binding/v1', canonicalizeJson(binding.data))
    if (signedDigest !== expectedDigest) return false
    try { return verify(null, sanitizerProofPayload(issuer, keyId, signedDigest), publicKey, Buffer.from(signature, 'base64url')) }
    catch { return false }
  }
}

function sanitizerProofPayload(issuer: string, keyId: string, signedDigest: string): Buffer {
  return Buffer.from(canonicalizeJson({ purpose: 'sanitizer-attestation/v1', issuer, keyId, signedDigest }))
}
