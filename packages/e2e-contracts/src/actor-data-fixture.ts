import { z } from 'zod'

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/)
const Text = z.string().min(1).max(4096)
const SensitiveKey = /(?:^|[-_])(password|passwd|secret|token|access[-_]?token|cookie[-_]?value|authorization)(?:$|[-_])/i

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(64 * 1024),
  z.array(JsonValueSchema).max(10_000),
  z.record(z.string().min(1).max(256), JsonValueSchema).superRefine((value, context) => {
    for (const key of Object.keys(value)) if (SensitiveKey.test(key)) context.addIssue({
      code: 'custom', path: [key], message: 'initialState 禁止包含明文敏感字段',
    })
  }),
]))

export const ActorDataRequirementV1Schema = z.object({
  schemaVersion: z.literal('actor-data-requirement/v1'),
  requirementId: Id, caseId: Id, actor: Text, role: Text,
  tenant: Text.optional(), environment: Text, targetIdentity: Id,
  credentialRef: Id.optional(),
  dataNeeds: z.array(z.object({
    needId: Id, resourceType: Text, initialState: JsonValueSchema,
    access: z.enum(['read', 'reversible-write']),
    seedStrategy: z.enum(['existing', 'allocate', 'idempotent-seed']),
    cleanupExpectation: z.enum(['none', 'restore', 'delete']),
  }).strict()).min(1).max(1000),
}).strict()

export const ProvisionedFixtureV1Schema = z.object({
  schemaVersion: z.literal('provisioned-fixture/v1'),
  provisionId: Id, runId: Id, attemptId: Id, requirementId: Id, caseId: Id,
  environment: Text, targetIdentity: Id,
  accountBinding: z.object({ actor: Text, role: Text, tenant: Text.optional(),
    accountRef: Id, credentialRef: Id.optional() }).strict(),
  resources: z.array(z.object({
    needId: Id, logicalResourceKey: Text, namespacedResourceKey: Text,
    leaseId: Id, cleanupPlanRef: Id, reloadOracleRefs: z.array(Id).max(100),
    adapterIdentity: Id, expiresAt: z.string().datetime(),
  }).strict()).min(1).max(1000),
  expiresAt: z.string().datetime(),
}).strict()

export const FixtureResidualSchema = z.object({
  namespacedResourceKey: Text, ownerRunId: Id, ownerAttemptId: Id,
  adapterIdentity: Id, lastAction: Text, remediation: Text,
}).strict()

export const FixtureCleanupOutcomeSchema = z.object({
  schemaVersion: z.literal('fixture-cleanup-outcome/v1'),
  provisionId: Id, status: z.enum(['cleaned', 'failed', 'unknown']),
  reloadVerified: z.boolean(), leaseRetired: z.boolean(),
  residuals: z.array(FixtureResidualSchema).max(1000),
}).strict().superRefine((value, context) => {
  if (value.status === 'cleaned' && (!value.reloadVerified || !value.leaseRetired || value.residuals.length > 0)) {
    context.addIssue({ code: 'custom', message: 'cleaned 要求 Reload、Lease 与 residual 全部收敛' })
  }
})

export const FixtureRecoveryOutcomeSchema = z.object({
  schemaVersion: z.literal('fixture-recovery-outcome/v1'),
  provisionId: Id, status: z.enum(['recovered', 'residual', 'manual-required']),
  replayedUncertainWrite: z.literal(false),
  inspectedResourceKeys: z.array(Text).max(1000),
  residuals: z.array(FixtureResidualSchema).max(1000),
}).strict()

export type ActorDataRequirementV1 = z.infer<typeof ActorDataRequirementV1Schema>
export type ProvisionedFixtureV1 = z.infer<typeof ProvisionedFixtureV1Schema>
export type FixtureCleanupOutcome = z.infer<typeof FixtureCleanupOutcomeSchema>
export type FixtureRecoveryOutcome = z.infer<typeof FixtureRecoveryOutcomeSchema>
