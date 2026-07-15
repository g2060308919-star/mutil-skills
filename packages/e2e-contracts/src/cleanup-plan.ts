import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const UniqueIdsSchema = z.array(SafeIdSchema).min(1).max(10_000)
  .refine((values) => new Set(values).size === values.length, 'ID 必须唯一')

export const CleanupPlanDefinitionSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  cleanupPlanId: SafeIdSchema,
  actionId: SafeIdSchema,
  leaseId: SafeIdSchema,
  executorId: SafeIdSchema,
  cleanupRequestIntentIds: UniqueIdsSchema,
  verificationProbes: z.array(z.object({
    probeId: SafeIdSchema,
    kind: z.enum(['resource-state', 'http-response', 'browser-observation']),
    expectedDigest: DigestSchema,
  }).strict()).min(1).max(10_000)
    .refine((values) => new Set(values.map((value) => value.probeId)).size === values.length,
      'cleanup verification probeId 必须唯一'),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000),
}).strict()

export function digestCleanupPlanDefinition(plan: CleanupPlanDefinition): string {
  return digestText('cleanup-plan-definition/v1', canonicalizeJson(CleanupPlanDefinitionSchema.parse(plan)))
}

export type CleanupPlanDefinition = z.infer<typeof CleanupPlanDefinitionSchema>
