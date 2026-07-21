import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'
import { RuntimeFixedHttpRequestSchema, RuntimeHttpReadProbeSchema } from './runtime-http-action.js'

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
  runtimeHttpCleanup: z.object({
    request: RuntimeFixedHttpRequestSchema,
    verificationProbe: RuntimeHttpReadProbeSchema,
  }).strict().optional(),
}).strict().superRefine((plan, context) => {
  if (plan.runtimeHttpCleanup === undefined) return
  if (plan.cleanupRequestIntentIds.length !== 1
    || plan.cleanupRequestIntentIds[0] !== plan.runtimeHttpCleanup.request.intentId) {
    context.addIssue({
      code: 'custom', message: 'runtime HTTP cleanup request 必须与唯一 cleanupRequestIntentId 闭合',
      path: ['cleanupRequestIntentIds'],
    })
  }
  if (plan.verificationProbes.length !== 1
    || plan.verificationProbes[0]?.probeId !== plan.runtimeHttpCleanup.verificationProbe.requestId
    || plan.verificationProbes[0]?.kind !== 'http-response'
    || plan.verificationProbes[0]?.expectedDigest !== plan.runtimeHttpCleanup.verificationProbe.expectedResponseBodyDigest) {
    context.addIssue({
      code: 'custom', message: 'runtime HTTP cleanup verification probe 必须与 plan 摘要闭合',
      path: ['verificationProbes'],
    })
  }
})

export function digestCleanupPlanDefinition(plan: CleanupPlanDefinition): string {
  return digestText('cleanup-plan-definition/v1', canonicalizeJson(CleanupPlanDefinitionSchema.parse(plan)))
}

export type CleanupPlanDefinition = z.infer<typeof CleanupPlanDefinitionSchema>
