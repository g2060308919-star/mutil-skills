import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Commit = z.string().regex(/^[a-f0-9]{40}$/)
const ExactVersion = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)
export const RegistryGoldenMatrixEntrySchema = z.object({
  platform: z.enum(['darwin', 'linux']), arch: z.enum(['arm64', 'x64']),
  nodeMajor: z.union([z.literal(22), z.literal(24)]), passed: z.literal(true),
  resultDigest: Digest,
}).strict()
export const RegistryGoldenArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'), proofType: z.literal('registry-golden'), runtimeVersion: ExactVersion,
  installationDigest: Digest, sourceCommit: Commit, packageCount: z.literal(14),
  mode: z.literal('registry'), skippedTests: z.literal(0), packageSource: z.literal('npm-registry'),
  matrix: z.array(RegistryGoldenMatrixEntrySchema).length(4),
  passed: z.literal(true), gateEligible: z.literal(true), proofDigest: Digest,
}).strict()
export type RegistryGoldenArtifact = z.infer<typeof RegistryGoldenArtifactSchema>

const requiredMatrix = ['darwin/arm64/node22', 'darwin/arm64/node24',
  'linux/x64/node22', 'linux/x64/node24'] as const

export function createRegistryGoldenArtifact(input: {
  runtimeVersion: string; installationDigest: string; sourceCommit: string
  results: Array<{ platform: 'darwin' | 'linux'; arch: 'arm64' | 'x64'; nodeMajor: 22 | 24
    result: unknown }>
}): RegistryGoldenArtifact {
  const matrix = input.results.map((item) => {
    const result = parseGoldenResult(item.result)
    return { platform: item.platform, arch: item.arch, nodeMajor: item.nodeMajor, passed: true as const,
      resultDigest: digestText('e2e-registry-golden-result/v1', canonicalizeJson(result)) }
  }).sort((left, right) => matrixKey(left).localeCompare(matrixKey(right)))
  if (matrix.map(matrixKey).join(',') !== [...requiredMatrix].sort().join(',')) {
    throw registryError('E2E_REGISTRY_GOLDEN_MATRIX_INCOMPLETE')
  }
  const draft = { schemaVersion: '1.0.0' as const, proofType: 'registry-golden' as const,
    runtimeVersion: input.runtimeVersion, installationDigest: input.installationDigest,
    sourceCommit: input.sourceCommit, packageCount: 14 as const, mode: 'registry' as const,
    skippedTests: 0 as const, packageSource: 'npm-registry' as const,
    matrix, passed: true as const, gateEligible: true as const }
  return RegistryGoldenArtifactSchema.parse({ ...draft,
    proofDigest: digestText('e2e-registry-golden-proof/v1', canonicalizeJson(draft)) })
}

function parseGoldenResult(candidate: unknown): {
  ok: true; mode: 'registry'; skippedTests: 0; packageSource: 'npm-registry'
} {
  const parsed = z.object({ ok: z.literal(true), mode: z.literal('registry'), skippedTests: z.literal(0),
    packageSource: z.literal('npm-registry') }).passthrough().safeParse(candidate)
  if (!parsed.success) throw registryError('E2E_REGISTRY_GOLDEN_RESULT_INVALID')
  return { ok: true, mode: 'registry', skippedTests: 0, packageSource: 'npm-registry' }
}
function matrixKey(value: { platform: string; arch: string; nodeMajor: number }): string {
  return `${value.platform}/${value.arch}/node${value.nodeMajor}`
}
function registryError(code: string): E2EError {
  return new E2EError({ code, category: 'automation', retryable: false, message: code })
}
