import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { describe, expect, test } from 'vitest'
import {
  auditStableRuntimeActivation,
  issueVerifiedTufGovernance,
} from '../src/stable-activation-audit.js'
import { OPERATIONAL_PERFORMANCE_PHASES } from '../src/operational-performance-proof.js'
import { PRODUCTION_BENCHMARK_PHASES } from '../src/production-performance-proof.js'
import type { SignedRuntimeTarget, TrustedMetadataSet } from '../src/runtime-update-trust.js'

const D = (character: string) => `sha256:${character.repeat(64)}`
const NOW = new Date('2026-08-09T00:00:00.000Z')
const COMMIT = 'a'.repeat(40)
const keys = ['KEY-1', 'KEY-2', 'KEY-3'].map((keyId) => ({ keyId,
  ...generateKeyPairSync('ed25519') }))

describe('生产 stable 激活审计', () => {
  test('只有 verified TUF governance、签名 target policy 与六类 2-of-3 证据闭合才 ready', () => {
    const input = validInput()
    expect(auditStableRuntimeActivation(input)).toMatchObject({ ready: true, runtimeVersion: '0.7.0',
      installationDigest: D('3'), sourceCommit: COMMIT, environmentId: 'STAGING-1',
      metadataVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } })
  })

  test('拒绝未由 TUF 适配层签发的治理对象、伪签名和跨 target 证据', () => {
    const input = validInput()
    expect(() => auditStableRuntimeActivation({ ...input,
      governance: { ...input.governance } }))
      .toThrow(/E2E_STABLE_ACTIVATION_GOVERNANCE_INVALID/)
    const forged = structuredClone(input.evidence)
    forged[0].signatures[0].signature = 'A'.repeat(86) + '=='
    forged[0].signatures[1].signature = 'A'.repeat(86) + '=='
    expect(() => auditStableRuntimeActivation({ ...input, evidence: forged }))
      .toThrow(/E2E_STABLE_ACTIVATION_PROOF_SIGNATURE_INVALID/)
    const rebound = structuredClone(input.evidence)
    rebound[0].payload.installationDigest = D('9')
    expect(() => auditStableRuntimeActivation({ ...input, evidence: rebound }))
      .toThrow(/E2E_STABLE_ACTIVATION_PROOF_BINDING_MISMATCH/)
    const substituted = structuredClone(input.evidence)
    substituted[0].artifact = { ...substituted[0].artifact, proof: 'substituted' }
    expect(() => auditStableRuntimeActivation({ ...input, evidence: substituted }))
      .toThrow(/E2E_STABLE_ACTIVATION_ARTIFACT_DIGEST_MISMATCH/)
  })

  test('即使 envelope 重新签名，也拒绝语义不完整或内部 proof digest 被替换的 artifact', () => {
    const input = validInput()
    const incomplete = structuredClone(input.evidence)
    incomplete[0].artifact.phases = {}
    resign(incomplete[0])
    expect(() => auditStableRuntimeActivation({ ...input, evidence: incomplete }))
      .toThrow(/E2E_STABLE_ACTIVATION_GATE_PROOF_INVALID/)

    const substituted = structuredClone(input.evidence)
    substituted[1].artifact.proofDigest = D('f')
    resign(substituted[1])
    expect(() => auditStableRuntimeActivation({ ...input, evidence: substituted }))
      .toThrow(/E2E_STABLE_ACTIVATION_PROOF_DIGEST_MISMATCH/)
  })
})

function validInput() {
  const targetValue = target()
  return {
    metadata: metadata(), target: targetValue, updateStart: NOW, environment: environment(),
    governance: issueVerifiedTufGovernance({
      root: { keyIds: ['ROOT-1', 'ROOT-2', 'ROOT-3'], threshold: 2 },
      targets: { keyIds: ['TARGETS-1', 'TARGETS-2', 'TARGETS-3'], threshold: 2 },
      rootMetadataDigest: D('4'),
    }),
    evidence: [
      'production-performance', 'b2b-runtime-coverage', 'operational-runtime',
      'registry-golden', 'revocation-drill', 'lkg-recovery-drill',
    ].map((proofType, index) => evidence(proofType, String.fromCharCode(97 + index))),
  }
}

function evidence(proofType: string, character: string) {
  const artifact = artifactFor(proofType, character)
  const payload = { schemaVersion: '1.0.0', proofType, runtimeVersion: '0.7.0',
    installationDigest: D('3'), sourceCommit: COMMIT, environmentId: 'STAGING-1',
    artifactDigest: digestText('e2e-stable-evidence-artifact/v1', canonicalizeJson(artifact)),
    passed: true, gateEligible: true }
  const bytes = Buffer.from(canonicalizeJson(payload), 'utf8')
  return { artifact, payload, signatures: keys.slice(0, 2).map((key) => ({
    keyId: key.keyId, signature: sign(null, bytes, key.privateKey).toString('base64'),
  })) }
}

function resign(envelope: ReturnType<typeof evidence>): void {
  envelope.payload.artifactDigest = digestText(
    'e2e-stable-evidence-artifact/v1', canonicalizeJson(envelope.artifact),
  )
  const bytes = Buffer.from(canonicalizeJson(envelope.payload), 'utf8')
  envelope.signatures = keys.slice(0, 2).map((key) => ({ keyId: key.keyId,
    signature: sign(null, bytes, key.privateKey).toString('base64') }))
}

function artifactFor(proofType: string, character: string): Record<string, unknown> {
  if (proofType === 'production-performance') {
    const phase = { samples: 20, successfulSamples: 20, failures: 0, failureRate: 0,
      failureReasonCodes: [], p50Ms: 1, p95Ms: 2, p99Ms: 2, maxMs: 2, peakRssBytes: 1,
      outputBytes: { p50: 1, p95: 1, p99: 1, max: 1 }, budgetMs: 10, budgetPassed: true }
    return proof('e2e-production-performance-proof/v2', { schemaVersion: '2.0.0', fixtureDigest: D(character),
      fixtureCounts: { requirements: 500, rules: 2_000, obligations: 5_000, cases: 1_000 },
      warmupSamples: 3, sampleCount: 20,
      runner: { runnerId: 'stable-1', stableResources: true, platform: 'darwin', arch: 'arm64', node: 'v24',
        cpuModel: 'Apple M1 Pro', cpuCount: 10, totalMemoryBytes: 17_179_869_184 },
      phases: Object.fromEntries(PRODUCTION_BENCHMARK_PHASES.map((name) => [name, phase])),
      passed: true, gateEligible: true })
  }
  if (proofType === 'b2b-runtime-coverage') {
    return proof('e2e-b2b-coverage-proof/v1', { schemaVersion: '1.0.0', corpusDigest: D(character),
      executionsDigest: D(character), scenarioCount: 12, categoryCount: 12, capabilitySupportRate: 100,
      endToEndSuccessRate: 100, weightedCoverage: 100, falseNegativeRate: 0, flakyRate: 0,
      categoryResults: Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
        [`category-${index}`, { passed: 1, total: 1, passRate: 100, minimumPassRate: 1 }])),
      failures: [], passed: true, gateEligible: true, gateIneligibleReasons: [] })
  }
  if (proofType === 'operational-runtime') {
    const phase = { samples: 20, failures: 0, p50Ms: 1, p95Ms: 2, maxMs: 2, budgetMs: 10,
      budgetPassed: true, reasonCodes: [], sampleDigest: D(character), baselineDeltaPercent: -80 }
    return proof('e2e-operational-performance-proof/v1', { schemaVersion: '1.0.0',
      runner: { runnerId: 'stable-1', stableResources: true, platform: 'darwin', arch: 'arm64', node: 'v24',
        cpuModel: 'Apple M1 Pro', cpuCount: 10, totalMemoryBytes: 17_179_869_184,
        baselineDigest: D(character) }, sampleCount: 20,
      phases: Object.fromEntries(OPERATIONAL_PERFORMANCE_PHASES.map((name) => [name, phase])),
      flakyRate: 0, diagnosticRate: 100, artifactRetentionVerified: true, passed: true,
      gateEligible: true, gateIneligibleReasons: [] })
  }
  if (proofType === 'registry-golden') {
    return proof('e2e-registry-golden-proof/v1', { schemaVersion: '1.0.0', proofType,
      runtimeVersion: '0.7.0', installationDigest: D('3'), sourceCommit: COMMIT, packageCount: 14,
      mode: 'registry', skippedTests: 0, packageSource: 'npm-registry',
      matrix: [22, 24].flatMap((nodeMajor) => ['arm64', 'x64'].map((archValue) => ({
        platform: archValue === 'arm64' ? 'darwin' : 'linux', arch: archValue, nodeMajor,
        passed: true, resultDigest: D(character) }))),
      passed: true, gateEligible: true })
  }
  const metadataBefore = metadataFacts(1, character)
  if (proofType === 'revocation-drill') {
    return proof('e2e-runtime-revocation-drill-proof/v1', { schemaVersion: '1.0.0', proofType,
      environmentId: 'STAGING-1', sourceCommit: COMMIT, runtimeVersion: '0.7.0', installationDigest: D('3'),
      metadataBefore, metadataAfter: metadataFacts(2, character), newRunDefaultBefore: pointer(),
      newRunDefaultAfter: null, lkgBefore: pointer(), lkgAfter: null, revocationReasonCode: 'SECURITY-REVOKED',
      newRunBlocked: true, existingRunBlocked: true, metadataAdvanced: true, passed: true })
  }
  return proof('e2e-runtime-lkg-recovery-drill-proof/v1', { schemaVersion: '1.0.0', proofType,
    environmentId: 'STAGING-1', sourceCommit: COMMIT, runtimeVersion: '0.7.0', installationDigest: D('3'),
    metadataBefore, metadataAfter: metadataBefore, newRunDefaultBefore: null, newRunDefaultAfter: pointer(),
    lkgBefore: pointer(), lkgAfter: pointer(), existingRunInstallationDigestBefore: D('9'),
    existingRunInstallationDigestAfter: D('9'), metadataHighwaterPreserved: true, lkgPromoted: true,
    existingRunBindingPreserved: true, passed: true })
}

function proof(domain: string, draft: Record<string, unknown>): Record<string, unknown> {
  return { ...draft, proofDigest: digestText(domain, canonicalizeJson(draft)) }
}
function pointer() { return { runtimeVersion: '0.7.0', installationDigest: D('3') } }
function metadataFacts(version: number, character: string) {
  return { versions: { root: version, timestamp: version, snapshot: version, targets: version },
    digests: { root: D(character), timestamp: D(character), snapshot: D(character), targets: D(character) } }
}

function metadata(): TrustedMetadataSet {
  return {
    root: { version: 1, digest: D('4'), expires: '2027-08-09T00:00:00.000Z' },
    timestamp: { version: 1, digest: D('5'), expires: '2026-08-10T00:00:00.000Z' },
    snapshot: { version: 1, digest: D('6'), expires: '2026-08-16T00:00:00.000Z' },
    targets: { version: 1, digest: D('7'), expires: '2026-09-08T00:00:00.000Z' },
  }
}
function target(): SignedRuntimeTarget {
  return { name: 'stable/e2e-runtime-0.7.0.tgz', length: 1,
    hashes: { sha512: Buffer.alloc(64, 1).toString('hex') }, custom: {
      schemaVersion: '1.0.0', packageName: '@mutil-skills/e2e-runtime', runtimeVersion: '0.7.0',
      protocolMajor: 1, channel: 'stable', npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      registryUrl: 'https://registry.npmjs.org/stable/e2e-runtime-0.7.0.tgz', contentDigest: D('1'),
      executableDigest: D('2'), installationDigest: D('3'),
      supportedNode: [{ major: 24, minimumPatch: '24.0.0' }],
      supportedPlatforms: [{ platform: 'darwin', arch: 'arm64' }], minimumBootstrapVersion: '0.6.0',
      revoked: false, revocationReasonCode: null,
      activationPolicy: { schemaVersion: '1.0.0', environmentId: 'STAGING-1', sourceCommit: COMMIT,
        evidenceThreshold: 2, evidenceKeys: keys.map((key) => ({ keyId: key.keyId,
          publicKeySpki: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })),
        operationalOwners: { metadata: 'release-team', emergency: 'security-oncall' } },
    } }
}
function environment() {
  return { channel: 'stable' as const, nodeVersion: '24.18.0', platform: 'darwin' as const,
    arch: 'arm64' as const, protocolMajor: 1, bootstrapVersion: '0.6.0',
    allowedRegistryOrigins: ['https://registry.npmjs.org'] }
}
