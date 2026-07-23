import { z } from 'zod'
import { AssetIdSchema, RelativePathSchema, canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const UniqueCaseIdsSchema = z.array(SafeIdSchema).min(1).max(100_000)
  .refine((ids) => new Set(ids).size === ids.length, 'caseId 不得重复')

export const RegressionSourceFileSchema = z.object({
  relativePath: RelativePathSchema,
  digest: DigestSchema,
  byteLength: z.number().int().nonnegative(),
  mediaType: z.enum(['application/json', 'text/markdown', 'text/typescript']),
}).strict()

export const RegressionCaseMappingSchema = z.object({
  caseId: SafeIdSchema,
  relativePath: RelativePathSchema,
  testTitle: z.string().min(1).max(4096),
}).strict()

export const RegressionBlockedCaseSchema = z.object({
  caseId: SafeIdSchema,
  reasonCode: SafeIdSchema,
}).strict()
export const RegressionBlockedCasesSchema = z.array(RegressionBlockedCaseSchema).max(100_000)
  .refine((items) => new Set(items.map((item) => item.caseId)).size === items.length,
    'blockedCases caseId 不得重复')
  .refine((items) => items.map((item) => item.caseId).join('\0')
    === [...items].sort((left, right) => left.caseId.localeCompare(right.caseId))
      .map((item) => item.caseId).join('\0'), 'blockedCases 必须按 caseId 排序')

export const RegressionToolchainV2Schema = z.object({
  nodeVersion: SemverSchema,
  playwrightVersion: SemverSchema,
  compilerDigest: DigestSchema,
  playwrightCliDigest: DigestSchema,
}).strict()

export const RegressionToolchainV2_1Schema = RegressionToolchainV2Schema.extend({
  typescriptVersion: SemverSchema,
}).strict()

export const RegressionToolchainSchema = z.union([RegressionToolchainV2Schema, RegressionToolchainV2_1Schema])

const RegressionDiscoverySubjectCommonShape = {
  testDomain: z.literal('prd-e2e-trusted-compiler'),
  executionProfile: z.enum([
    'trusted-read-only', 'trusted-reversible-write', 'production-isolated', 'full-playwright',
  ]),
  assetId: AssetIdSchema,
  generationId: SafeIdSchema,
  prdRevision: DigestSchema,
  compilerVersion: SemverSchema,
  templateVersion: SemverSchema,
  contractsVersion: SemverSchema,
  environmentId: SafeIdSchema,
  approvalDigest: DigestSchema,
  policyDigest: DigestSchema,
  templateDigest: DigestSchema,
  compilerInputDigest: DigestSchema,
  sourceFiles: z.array(RegressionSourceFileSchema).min(1).max(100_000),
  caseMappings: z.array(RegressionCaseMappingSchema).min(1).max(100_000),
  isolation: z.object({
    command: z.tuple([
      z.literal('node'), z.literal('@playwright/test/cli'), z.literal('test'),
      z.literal('--list'), z.literal('--reporter=json'),
    ]),
    exitCode: z.literal(0),
    stdoutDigest: DigestSchema,
  }).strict(),
  discoveredCaseIds: UniqueCaseIdsSchema,
  blockedCases: RegressionBlockedCasesSchema,
  sourceSetDigest: DigestSchema,
}

const RegressionDiscoverySubjectV2ObjectSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  ...RegressionDiscoverySubjectCommonShape,
  toolchain: RegressionToolchainV2Schema,
}).strict()

const RegressionDiscoverySubjectV2_1ObjectSchema = z.object({
  schemaVersion: z.literal('2.1.0'),
  ...RegressionDiscoverySubjectCommonShape,
  toolchain: RegressionToolchainV2_1Schema,
}).strict()

const RegressionDiscoverySubjectObjectSchema = z.discriminatedUnion('schemaVersion', [
  RegressionDiscoverySubjectV2ObjectSchema,
  RegressionDiscoverySubjectV2_1ObjectSchema,
])

function refineRegressionDiscoverySubject(subject: z.infer<typeof RegressionDiscoverySubjectObjectSchema>, context: z.RefinementCtx): void {
  if (subject.schemaVersion === '2.0.0' && subject.executionProfile === 'full-playwright') {
    context.addIssue({ code: 'custom', message: 'full-playwright 必须使用含 parser binding 的 2.1.0 Subject',
      path: ['schemaVersion'] })
  }
  const sourcePaths = subject.sourceFiles.map((file) => file.relativePath)
  const mappingCases = subject.caseMappings.map((mapping) => mapping.caseId)
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    context.addIssue({ code: 'custom', message: 'sourceFiles 路径不得重复', path: ['sourceFiles'] })
  }
  if (new Set(mappingCases).size !== mappingCases.length) {
    context.addIssue({ code: 'custom', message: 'caseMappings caseId 不得重复', path: ['caseMappings'] })
  }
  const sourceSet = new Set(sourcePaths)
  for (const [index, mapping] of subject.caseMappings.entries()) {
    if (!sourceSet.has(mapping.relativePath)) {
      context.addIssue({ code: 'custom', message: 'Case 映射必须指向已证明源码', path: ['caseMappings', index, 'relativePath'] })
    }
  }
  const discovered = [...subject.discoveredCaseIds].sort()
  const mapped = [...mappingCases].sort()
  if (discovered.length !== mapped.length || discovered.some((id, index) => id !== mapped[index])) {
    context.addIssue({ code: 'custom', message: 'discoveredCaseIds 必须与 caseMappings.caseId 完全一致', path: ['discoveredCaseIds'] })
  }
  const blockedIds = subject.blockedCases.map((item) => item.caseId)
  if (new Set(blockedIds).size !== blockedIds.length) {
    context.addIssue({ code: 'custom', message: 'blockedCases caseId 不得重复', path: ['blockedCases'] })
  }
  if (blockedIds.some((caseId) => mappingCases.includes(caseId))) {
    context.addIssue({ code: 'custom', message: 'blocked Case 不得进入 mapping 或 Playwright discovery', path: ['blockedCases'] })
  }
  if (subject.sourceSetDigest !== computeRegressionSourceSetDigest(subject.sourceFiles)) {
    context.addIssue({ code: 'custom', message: 'sourceSetDigest 必须由完整 sourceFiles 重算', path: ['sourceSetDigest'] })
  }
}

export function computeRegressionSourceSetDigest(sourceFiles: z.infer<typeof RegressionSourceFileSchema>[]): string {
  return digestText('regression-source-set/v1', canonicalizeJson([...sourceFiles]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))))
}

export const RegressionDiscoverySubjectSchema = RegressionDiscoverySubjectObjectSchema
  .superRefine(refineRegressionDiscoverySubject)

const RegressionDiscoveryAttestationShape = {
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('regression-discovery-attestation/v2'),
  algorithm: z.literal('Ed25519'),
  signedDigest: DigestSchema,
  signature: z.string().min(1).max(4096),
}

const RegressionDiscoveryAttestationObjectSchema = z.discriminatedUnion('schemaVersion', [
  RegressionDiscoverySubjectV2ObjectSchema.extend(RegressionDiscoveryAttestationShape).strict(),
  RegressionDiscoverySubjectV2_1ObjectSchema.extend(RegressionDiscoveryAttestationShape).strict(),
])

export const RegressionDiscoveryAttestationSchema = RegressionDiscoveryAttestationObjectSchema
  .superRefine(refineRegressionDiscoverySubject)

export const RegressionDiscoveryVerifierMaterialSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  issuer: SafeIdSchema,
  keyId: SafeIdSchema,
  purpose: z.literal('regression-discovery-attestation/v2'),
  algorithm: z.literal('Ed25519'),
  publicKeySpkiBase64: z.string().min(1).max(16 * 1024),
  publicKeyDigest: DigestSchema,
}).strict()

export type RegressionSourceFile = z.infer<typeof RegressionSourceFileSchema>
export type RegressionCaseMapping = z.infer<typeof RegressionCaseMappingSchema>
export type RegressionBlockedCase = z.infer<typeof RegressionBlockedCaseSchema>
export type RegressionToolchain = z.infer<typeof RegressionToolchainSchema>
export type RegressionDiscoverySubject = z.infer<typeof RegressionDiscoverySubjectSchema>
export type RegressionDiscoveryAttestation = z.infer<typeof RegressionDiscoveryAttestationSchema>
export type RegressionDiscoveryVerifierMaterial = z.infer<typeof RegressionDiscoveryVerifierMaterialSchema>

export function findForbiddenRegressionTestDispositions(source: string): string[] {
  const pattern = /\btest\s*\.\s*(skip|fixme|fail|only|todo)\b|\btest\s*\.\s*describe\s*\.\s*(skip|fixme|only)\b/g
  const found = new Set<string>()
  for (const match of source.matchAll(pattern)) found.add(match[1] ?? match[2] ?? 'unknown')
  return [...found].sort()
}
