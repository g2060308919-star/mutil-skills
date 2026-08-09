import { createPublicKey, verify } from 'node:crypto'
import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import { PRODUCTION_BENCHMARK_PHASES } from './production-performance-proof.js'
import { OPERATIONAL_PERFORMANCE_PHASES } from './operational-performance-proof.js'
import { RegistryGoldenArtifactSchema } from './registry-golden-proof.js'
import {
  RuntimeLkgRecoveryDrillArtifactSchema,
  RuntimeRevocationDrillArtifactSchema,
} from './stable-activation-drills.js'
import {
  StableActivationPolicySchema,
  advanceTrustedMetadata,
  validateRuntimeTarget,
  type RuntimeTargetEnvironment,
  type SignedRuntimeTarget,
  type TrustedMetadataSet,
} from './runtime-update-trust.js'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ProofType = z.enum([
  'production-performance', 'b2b-runtime-coverage', 'operational-runtime',
  'registry-golden', 'revocation-drill', 'lkg-recovery-drill',
])
const StableEvidencePayloadSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  proofType: ProofType,
  runtimeVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
  installationDigest: Digest,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  environmentId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  artifactDigest: Digest,
  passed: z.literal(true),
  gateEligible: z.literal(true),
}).strict()
const StableEvidenceEnvelopeSchema = z.object({
  artifact: z.unknown(),
  payload: StableEvidencePayloadSchema,
  signatures: z.array(z.object({
    keyId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }).strict()).min(2).max(8),
}).strict()

const PerformancePhaseSchema = z.object({
  samples: z.number().int().min(20), successfulSamples: z.number().int().min(20), failures: z.literal(0),
  failureRate: z.literal(0), failureReasonCodes: z.array(z.never()).length(0),
  p50Ms: z.number().nonnegative(), p95Ms: z.number().nonnegative(), p99Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(), peakRssBytes: z.number().int().positive(),
  outputBytes: z.object({ p50: z.number().nonnegative(), p95: z.number().nonnegative(),
    p99: z.number().nonnegative(), max: z.number().nonnegative() }).strict(),
  budgetMs: z.number().positive(), budgetPassed: z.literal(true),
}).strict()
const ProductionPerformanceArtifactSchema = z.object({
  schemaVersion: z.literal('2.0.0'), fixtureDigest: Digest,
  fixtureCounts: z.object({ requirements: z.number().int().min(500), rules: z.number().int().min(2_000),
    obligations: z.number().int().min(5_000), cases: z.number().int().min(1_000) }).strict(),
  warmupSamples: z.number().int().min(3), sampleCount: z.number().int().min(20),
  runner: z.object({ runnerId: z.string().min(1), stableResources: z.literal(true), platform: z.string().min(1),
    arch: z.string().min(1), node: z.string().min(1), cpuModel: z.string().min(1),
    cpuCount: z.number().int().positive(), totalMemoryBytes: z.number().int().positive() }).strict(),
  phases: z.record(PerformancePhaseSchema), passed: z.literal(true), gateEligible: z.literal(true), proofDigest: Digest,
}).strict()
const B2BArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'), corpusDigest: Digest, executionsDigest: Digest,
  scenarioCount: z.number().int().min(12), categoryCount: z.number().int().min(12),
  capabilitySupportRate: z.number().min(90), endToEndSuccessRate: z.literal(100), weightedCoverage: z.number().min(90),
  falseNegativeRate: z.literal(0), flakyRate: z.literal(0), categoryResults: z.record(z.object({
    passed: z.number().int().positive(), total: z.number().int().positive(), passRate: z.literal(100),
    minimumPassRate: z.number().min(0.5).max(1),
  }).strict()), failures: z.array(z.never()).length(0), passed: z.literal(true), gateEligible: z.literal(true),
  gateIneligibleReasons: z.array(z.never()).length(0), proofDigest: Digest,
}).strict()
const OperationalPhaseSchema = z.object({
  samples: z.number().int().min(20), failures: z.literal(0), p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(), maxMs: z.number().nonnegative(), budgetMs: z.number().positive(),
  budgetPassed: z.literal(true), reasonCodes: z.array(z.never()).length(0), sampleDigest: Digest,
  baselineDeltaPercent: z.number().finite(),
}).strict()
const OperationalArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'), runner: z.object({ runnerId: z.string().min(1), stableResources: z.literal(true),
    platform: z.string().min(1), arch: z.string().min(1), node: z.string().min(1), cpuModel: z.string().min(1),
    cpuCount: z.number().int().positive(), totalMemoryBytes: z.number().int().positive(),
    baselineDigest: Digest }).strict(),
  sampleCount: z.number().int().min(20), phases: z.record(OperationalPhaseSchema), flakyRate: z.literal(0),
  diagnosticRate: z.literal(100), artifactRetentionVerified: z.literal(true), passed: z.literal(true),
  gateEligible: z.literal(true), gateIneligibleReasons: z.array(z.never()).length(0), proofDigest: Digest,
}).strict()
export interface VerifiedTufGovernance {
  readonly root: { readonly keyIds: readonly string[]; readonly threshold: number }
  readonly targets: { readonly keyIds: readonly string[]; readonly threshold: number }
  readonly rootMetadataDigest: string
}
const verifiedGovernance = new WeakSet<object>()

/** 仅供已经由 tuf-js refresh 后读取同一 root bytes 的内部适配层签发。 */
export function issueVerifiedTufGovernance(candidate: unknown): VerifiedTufGovernance {
  const role = z.object({
    keyIds: z.array(z.string().min(1).max(256)).length(3), threshold: z.literal(2),
  }).strict()
  const parsed = z.object({ root: role, targets: role, rootMetadataDigest: Digest }).strict()
    .superRefine((value, context) => {
      for (const item of [value.root, value.targets]) {
        if (new Set(item.keyIds).size !== item.keyIds.length) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'TUF role key IDs 必须唯一' })
        }
      }
    }).safeParse(candidate)
  if (!parsed.success) throw activationError('E2E_STABLE_ACTIVATION_GOVERNANCE_INVALID')
  const value = Object.freeze({
    root: Object.freeze({ ...parsed.data.root, keyIds: Object.freeze([...parsed.data.root.keyIds]) }),
    targets: Object.freeze({ ...parsed.data.targets, keyIds: Object.freeze([...parsed.data.targets.keyIds]) }),
    rootMetadataDigest: parsed.data.rootMetadataDigest,
  })
  verifiedGovernance.add(value)
  return value
}

export interface StableActivationAudit {
  schemaVersion: '1.0.0'
  ready: boolean
  runtimeVersion: string
  installationDigest: string
  sourceCommit: string
  environmentId: string
  metadataVersions: { root: number; timestamp: number; snapshot: number; targets: number }
  proofDigests: string[]
  operationalOwners: { metadata: string; emergency: string }
  auditDigest: string
}

export function auditStableRuntimeActivation(input: {
  metadata: TrustedMetadataSet
  target: SignedRuntimeTarget
  governance: VerifiedTufGovernance
  updateStart: Date
  environment: RuntimeTargetEnvironment
  evidence: unknown[]
}): StableActivationAudit {
  if (!verifiedGovernance.has(input.governance)
    || input.governance.rootMetadataDigest !== input.metadata.root.digest) {
    throw activationError('E2E_STABLE_ACTIVATION_GOVERNANCE_INVALID')
  }
  const state = advanceTrustedMetadata(undefined, input.metadata, input.updateStart)
  const target = validateRuntimeTarget(input.target, { ...input.environment, channel: 'stable' })
  const policy = StableActivationPolicySchema.safeParse(target.custom.activationPolicy)
  if (!policy.success) throw activationError('E2E_STABLE_ACTIVATION_POLICY_MISSING')
  const expectedTypes = ProofType.options
  const envelopes = input.evidence.map((candidate) => StableEvidenceEnvelopeSchema.safeParse(candidate))
  if (envelopes.length !== expectedTypes.length || envelopes.some((item) => !item.success)) {
    throw activationError('E2E_STABLE_ACTIVATION_GATE_PROOF_INVALID')
  }
  const parsed = envelopes.map((item) => item.success ? item.data : neverEvidence())
  if (new Set(parsed.map((item) => item.payload.proofType)).size !== expectedTypes.length
    || expectedTypes.some((type) => !parsed.some((item) => item.payload.proofType === type))) {
    throw activationError('E2E_STABLE_ACTIVATION_GATE_PROOF_INVALID')
  }
  for (const envelope of parsed) verifyEvidenceEnvelope(envelope, policy.data, target)
  const proofDigests = parsed.sort((left, right) => left.payload.proofType.localeCompare(right.payload.proofType))
    .map((item) => digestText('e2e-stable-evidence-envelope/v1', canonicalizeJson(item)))
  const draft = {
    schemaVersion: '1.0.0' as const, ready: true,
    runtimeVersion: target.custom.runtimeVersion,
    installationDigest: target.custom.installationDigest,
    sourceCommit: policy.data.sourceCommit,
    environmentId: policy.data.environmentId,
    metadataVersions: {
      root: state.metadata.root.version, timestamp: state.metadata.timestamp.version,
      snapshot: state.metadata.snapshot.version, targets: state.metadata.targets.version,
    },
    proofDigests,
    operationalOwners: policy.data.operationalOwners,
  }
  return { ...draft, auditDigest: digestText('e2e-stable-activation-audit/v1', canonicalizeJson(draft)) }
}

function verifyEvidenceEnvelope(
  envelope: z.infer<typeof StableEvidenceEnvelopeSchema>,
  policy: z.infer<typeof StableActivationPolicySchema>,
  target: SignedRuntimeTarget,
): void {
  const payload = envelope.payload
  const artifactDigest = digestText(
    'e2e-stable-evidence-artifact/v1', canonicalizeJson(envelope.artifact),
  )
  if (payload.artifactDigest !== artifactDigest) {
    throw activationError('E2E_STABLE_ACTIVATION_ARTIFACT_DIGEST_MISMATCH')
  }
  verifyStableArtifact(payload.proofType, envelope.artifact, payload)
  if (payload.runtimeVersion !== target.custom.runtimeVersion
    || payload.installationDigest !== target.custom.installationDigest
    || payload.sourceCommit !== policy.sourceCommit
    || payload.environmentId !== policy.environmentId) {
    throw activationError('E2E_STABLE_ACTIVATION_PROOF_BINDING_MISMATCH')
  }
  const keys = new Map(policy.evidenceKeys.map((item) => [item.keyId, item.publicKeySpki]))
  const message = Buffer.from(canonicalizeJson(payload), 'utf8')
  let valid = 0
  const seen = new Set<string>()
  for (const signature of envelope.signatures) {
    const encoded = keys.get(signature.keyId)
    if (encoded === undefined || seen.has(signature.keyId)) continue
    seen.add(signature.keyId)
    try {
      const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
      if (verify(null, message, key, Buffer.from(signature.signature, 'base64'))) valid += 1
    } catch {
      // 无效 key/signature 只计为未通过；阈值检查统一 fail closed。
    }
  }
  if (valid < policy.evidenceThreshold) {
    throw activationError('E2E_STABLE_ACTIVATION_PROOF_SIGNATURE_INVALID')
  }
}

function verifyStableArtifact(
  proofType: z.infer<typeof ProofType>,
  artifact: unknown,
  payload: z.infer<typeof StableEvidencePayloadSchema>,
): void {
  let parsed: Record<string, unknown>
  let domain: string
  if (proofType === 'production-performance') {
    parsed = strictArtifact(ProductionPerformanceArtifactSchema, artifact)
    exactPhaseSet(parsed.phases, PRODUCTION_BENCHMARK_PHASES)
    domain = 'e2e-production-performance-proof/v2'
  } else if (proofType === 'b2b-runtime-coverage') {
    parsed = strictArtifact(B2BArtifactSchema, artifact)
    if (Object.values(parsed.categoryResults as Record<string, { passed: number; total: number }>)
      .some((result) => result.passed !== result.total)) invalidArtifact()
    domain = 'e2e-b2b-coverage-proof/v1'
  } else if (proofType === 'operational-runtime') {
    parsed = strictArtifact(OperationalArtifactSchema, artifact)
    exactPhaseSet(parsed.phases, OPERATIONAL_PERFORMANCE_PHASES)
    domain = 'e2e-operational-performance-proof/v1'
  } else if (proofType === 'registry-golden') {
    parsed = strictArtifact(RegistryGoldenArtifactSchema, artifact)
    if (parsed.runtimeVersion !== payload.runtimeVersion
      || parsed.installationDigest !== payload.installationDigest
      || parsed.sourceCommit !== payload.sourceCommit) invalidArtifact()
    domain = 'e2e-registry-golden-proof/v1'
  } else if (proofType === 'revocation-drill') {
    parsed = strictArtifact(RuntimeRevocationDrillArtifactSchema, artifact)
    if (!parsed.passed || !parsed.newRunBlocked || !parsed.existingRunBlocked || !parsed.metadataAdvanced
      || parsed.environmentId !== payload.environmentId || parsed.sourceCommit !== payload.sourceCommit
      || parsed.runtimeVersion !== payload.runtimeVersion || parsed.installationDigest !== payload.installationDigest) {
      invalidArtifact()
    }
    domain = 'e2e-runtime-revocation-drill-proof/v1'
  } else {
    parsed = strictArtifact(RuntimeLkgRecoveryDrillArtifactSchema, artifact)
    if (!parsed.passed || !parsed.metadataHighwaterPreserved || !parsed.lkgPromoted
      || !parsed.existingRunBindingPreserved || parsed.environmentId !== payload.environmentId
      || parsed.sourceCommit !== payload.sourceCommit || parsed.runtimeVersion !== payload.runtimeVersion
      || parsed.installationDigest !== payload.installationDigest) invalidArtifact()
    domain = 'e2e-runtime-lkg-recovery-drill-proof/v1'
  }
  const { proofDigest, ...draft } = parsed
  if (proofDigest !== digestText(domain, canonicalizeJson(draft))) {
    throw activationError('E2E_STABLE_ACTIVATION_PROOF_DIGEST_MISMATCH')
  }
}

function strictArtifact<T extends z.ZodTypeAny>(schema: T, artifact: unknown): Record<string, unknown> {
  const parsed = schema.safeParse(artifact)
  if (!parsed.success) invalidArtifact()
  return parsed.data as Record<string, unknown>
}

function exactPhaseSet(candidate: unknown, expected: readonly string[]): void {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
    || Object.keys(candidate).sort().join(',') !== [...expected].sort().join(',')) invalidArtifact()
}

function invalidArtifact(): never {
  throw activationError('E2E_STABLE_ACTIVATION_GATE_PROOF_INVALID')
}

function neverEvidence(): never {
  throw activationError('E2E_STABLE_ACTIVATION_GATE_PROOF_INVALID')
}

function activationError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', retryable: false, message: code })
}
