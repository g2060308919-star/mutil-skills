import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import {
  checkRuntimeInstallationRevocation,
  type RuntimeUpdateState,
  type SignedRuntimeTarget,
} from './runtime-update-trust.js'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const Commit = z.string().regex(/^[a-f0-9]{40}$/)
const Pointer = z.object({ runtimeVersion: z.string(), installationDigest: Digest }).strict().nullable()
const MetadataFacts = z.object({
  versions: z.object({ root: z.number().int().positive(), timestamp: z.number().int().positive(),
    snapshot: z.number().int().positive(), targets: z.number().int().positive() }).strict(),
  digests: z.object({ root: Digest, timestamp: Digest, snapshot: Digest, targets: Digest }).strict(),
}).strict()

export const RuntimeRevocationDrillArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'), proofType: z.literal('revocation-drill'), environmentId: Id,
  sourceCommit: Commit, runtimeVersion: z.string(), installationDigest: Digest,
  metadataBefore: MetadataFacts, metadataAfter: MetadataFacts,
  newRunDefaultBefore: Pointer, newRunDefaultAfter: Pointer, lkgBefore: Pointer, lkgAfter: Pointer,
  revocationReasonCode: Id, newRunBlocked: z.boolean(), existingRunBlocked: z.boolean(),
  metadataAdvanced: z.boolean(), passed: z.boolean(), proofDigest: Digest,
}).strict()

export const RuntimeLkgRecoveryDrillArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'), proofType: z.literal('lkg-recovery-drill'), environmentId: Id,
  sourceCommit: Commit, runtimeVersion: z.string(), installationDigest: Digest,
  metadataBefore: MetadataFacts, metadataAfter: MetadataFacts,
  newRunDefaultBefore: Pointer, newRunDefaultAfter: Pointer, lkgBefore: Pointer, lkgAfter: Pointer,
  existingRunInstallationDigestBefore: Digest, existingRunInstallationDigestAfter: Digest,
  metadataHighwaterPreserved: z.boolean(), lkgPromoted: z.boolean(), existingRunBindingPreserved: z.boolean(),
  passed: z.boolean(), proofDigest: Digest,
}).strict()

export function createRuntimeRevocationDrillArtifact(input: {
  before: RuntimeUpdateState; after: RuntimeUpdateState; target: SignedRuntimeTarget
  environmentId: string; sourceCommit: string; observedAt: Date
}): z.infer<typeof RuntimeRevocationDrillArtifactSchema> {
  const target = input.target.custom
  const revocation = checkRuntimeInstallationRevocation(input.after, target.installationDigest, input.observedAt)
  const metadataAdvanced = input.after.metadata.targets.version > input.before.metadata.targets.version
    && input.after.metadata.timestamp.version >= input.before.metadata.timestamp.version
    && input.after.metadata.snapshot.version >= input.before.metadata.snapshot.version
  const pointerCleared = [input.after.newRunDefault, input.after.lkg]
    .every((pointer) => pointer?.installationDigest !== target.installationDigest)
  const draft = {
    schemaVersion: '1.0.0' as const, proofType: 'revocation-drill' as const,
    environmentId: input.environmentId, sourceCommit: input.sourceCommit,
    runtimeVersion: target.runtimeVersion, installationDigest: target.installationDigest,
    metadataBefore: metadataFacts(input.before), metadataAfter: metadataFacts(input.after),
    newRunDefaultBefore: input.before.newRunDefault, newRunDefaultAfter: input.after.newRunDefault,
    lkgBefore: input.before.lkg, lkgAfter: input.after.lkg,
    revocationReasonCode: target.revocationReasonCode ?? 'REVOCATION_REASON_MISSING',
    newRunBlocked: revocation.revoked, existingRunBlocked: revocation.revoked,
    metadataAdvanced, passed: target.revoked && revocation.status === 'revocation-checked'
      && revocation.revoked && metadataAdvanced && pointerCleared,
  }
  return RuntimeRevocationDrillArtifactSchema.parse({ ...draft,
    proofDigest: digestText('e2e-runtime-revocation-drill-proof/v1', canonicalizeJson(draft)) })
}

export function createRuntimeLkgRecoveryDrillArtifact(input: {
  before: RuntimeUpdateState; after: RuntimeUpdateState; environmentId: string; sourceCommit: string
  existingRunInstallationDigestBefore: string; existingRunInstallationDigestAfter: string
}): z.infer<typeof RuntimeLkgRecoveryDrillArtifactSchema> {
  if (input.before.lkg === null) throw drillError('E2E_RUNTIME_LKG_DRILL_LKG_MISSING')
  const metadataHighwaterPreserved = canonicalizeJson(metadataFacts(input.before))
    === canonicalizeJson(metadataFacts(input.after))
  const lkgPromoted = input.after.newRunDefault?.installationDigest === input.before.lkg.installationDigest
    && input.after.newRunDefault.runtimeVersion === input.before.lkg.runtimeVersion
  const existingRunBindingPreserved = input.existingRunInstallationDigestBefore
    === input.existingRunInstallationDigestAfter
  const draft = {
    schemaVersion: '1.0.0' as const, proofType: 'lkg-recovery-drill' as const,
    environmentId: input.environmentId, sourceCommit: input.sourceCommit,
    runtimeVersion: input.before.lkg.runtimeVersion, installationDigest: input.before.lkg.installationDigest,
    metadataBefore: metadataFacts(input.before), metadataAfter: metadataFacts(input.after),
    newRunDefaultBefore: input.before.newRunDefault, newRunDefaultAfter: input.after.newRunDefault,
    lkgBefore: input.before.lkg, lkgAfter: input.after.lkg,
    existingRunInstallationDigestBefore: input.existingRunInstallationDigestBefore,
    existingRunInstallationDigestAfter: input.existingRunInstallationDigestAfter,
    metadataHighwaterPreserved, lkgPromoted, existingRunBindingPreserved,
    passed: metadataHighwaterPreserved && lkgPromoted && existingRunBindingPreserved,
  }
  return RuntimeLkgRecoveryDrillArtifactSchema.parse({ ...draft,
    proofDigest: digestText('e2e-runtime-lkg-recovery-drill-proof/v1', canonicalizeJson(draft)) })
}

function metadataFacts(state: RuntimeUpdateState) {
  return {
    versions: { root: state.metadata.root.version, timestamp: state.metadata.timestamp.version,
      snapshot: state.metadata.snapshot.version, targets: state.metadata.targets.version },
    digests: { root: state.metadata.root.digest, timestamp: state.metadata.timestamp.digest,
      snapshot: state.metadata.snapshot.digest, targets: state.metadata.targets.digest },
  }
}

function drillError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', retryable: false, message: code })
}
