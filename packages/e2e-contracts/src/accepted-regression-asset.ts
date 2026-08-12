import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'
import { PageIdentityPolicySchema } from './e2e-flow.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9._:/-]+$/)
const ReasonSchema = z.object({
  code: z.string().regex(/^E2E_[A-Z0-9_]+$/),
  ref: z.string().min(1).max(4096),
}).strict()

export const RegressionAssetValiditySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('valid') }).strict(),
  z.object({ status: z.literal('probe-required'), reasons: z.array(ReasonSchema).min(1).max(1000) }).strict(),
  z.object({
    status: z.literal('review-required'), reasons: z.array(ReasonSchema).min(1).max(1000),
    diff: z.object({
      changedBindings: z.array(z.enum([
        'source', 'understanding', 'semantic-plan', 'target', 'actor-data', 'runtime', 'browser-capability',
      ])).min(1).max(16),
      previousDigest: DigestSchema,
      currentDigest: DigestSchema,
    }).strict(),
  }).strict(),
  z.object({ status: z.literal('execution-blocked'), reasons: z.array(ReasonSchema).min(1).max(1000) }).strict(),
])

const HumanAmendmentRecordSchema = z.object({
  amendmentId: SafeIdSchema,
  actor: z.string().min(1).max(512),
  reason: z.string().min(1).max(64 * 1024),
  changedAt: z.string().datetime(),
  previousAssetDigest: DigestSchema,
  amendmentDigest: DigestSchema,
}).strict()

const AcceptedRegressionAssetBodySchema = z.object({
  schemaVersion: z.literal('accepted-regression-asset/v1'),
  assetId: SafeIdSchema,
  version: z.number().int().positive(),
  sourceRevision: DigestSchema,
  understandingDigest: DigestSchema,
  semanticPlanDigest: DigestSchema,
  acceptanceReviewReceiptDigest: DigestSchema,
  executableCompilationDigest: DigestSchema,
  targetIdentityContract: z.object({
    baseOrigin: z.string().url(),
    environmentLabel: z.string().min(1).max(512),
    allowedNavigationOrigins: z.array(z.string().url()).min(1).max(256),
    pageIdentityPolicyDigest: DigestSchema,
  }).strict(),
  actorDataContractDigest: DigestSchema,
  runtimeCompatibility: z.object({
    packageName: z.literal('@mutil-skills/e2e-runtime'),
    range: z.string().regex(/^(?:\^|~|>=)?\d+\.\d+\.\d+$/),
  }).strict(),
  browserCapabilities: z.array(SafeIdSchema).min(1).max(256)
    .refine((values) => new Set(values).size === values.length, '浏览器能力必须唯一'),
  humanAmendments: z.array(HumanAmendmentRecordSchema).max(10_000),
  createdAt: z.string().datetime(),
}).strict()

export type AcceptedRegressionAssetBodyV1 = z.infer<typeof AcceptedRegressionAssetBodySchema>

export function computeAcceptedRegressionAssetDigest(body: AcceptedRegressionAssetBodyV1): string {
  return digestText('accepted-regression-asset/v1', canonicalizeJson(body))
}

export const AcceptedRegressionAssetV1Schema = AcceptedRegressionAssetBodySchema.extend({
  assetDigest: DigestSchema,
}).strict().superRefine((asset, context) => {
  const { assetDigest, ...body } = asset
  if (assetDigest !== computeAcceptedRegressionAssetDigest(body)) context.addIssue({
    code: 'custom', path: ['assetDigest'], message: '回归资产摘要未绑定全部冻结事实',
  })
})

export type AcceptedRegressionAssetV1 = z.infer<typeof AcceptedRegressionAssetV1Schema>
export type RegressionAssetValidity = z.infer<typeof RegressionAssetValiditySchema>

// 保留导出以供 Runtime 在构建最小 Target identity 时复用同一严格策略，而不复制 schema。
export const RegressionPageIdentityPolicySchema = PageIdentityPolicySchema
