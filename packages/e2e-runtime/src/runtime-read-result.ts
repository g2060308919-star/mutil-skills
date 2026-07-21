import { canonicalizeJson, E2EError } from '@mutil-skills/e2e-contracts'
import type { ReadOnlyCaseResult } from '@mutil-skills/e2e-playwright-runtime'
import { z } from 'zod'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ObservedPageIdentitySchema = z.object({
  url: z.string(), title: z.string(), headings: z.array(z.string()),
  role: z.string().optional(), ariaSignals: z.array(z.string()).optional(),
}).strict()
const EvidenceSummarySchema = z.object({
  kind: z.enum(['screenshot', 'dom', 'gateway-audit']),
  byteLength: z.number().int().nonnegative(),
  digest: DigestSchema,
}).strict()
const ReadOnlyCaseResultSchema = z.object({
  caseId: SafeIdSchema,
  actionId: SafeIdSchema,
  status: z.enum(['passed', 'failed', 'input-blocked', 'environment-blocked', 'safety-blocked']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
  expected: z.array(z.string()),
  actual: z.array(z.string()),
  observedIdentity: ObservedPageIdentitySchema.optional(),
  evidence: z.array(EvidenceSummarySchema),
  reservationIds: z.array(SafeIdSchema).optional(),
  outcomeDigest: DigestSchema.optional(),
}).strict()
const GatewayAuditSummarySchema = z.object({
  received: z.number().int().nonnegative(),
  forwarded: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  byIntent: z.record(z.number().int().nonnegative()),
}).strict().superRefine((audit, context) => {
  if (audit.forwarded + audit.blocked !== audit.received) context.addIssue({
    code: 'custom', message: 'Gateway audit 计数未闭合',
  })
})

export interface RuntimeReadExecutionRecord {
  attemptId: string
  caseId: string
  actionId: string
  status: ReadOnlyCaseResult['status']
  result: ReadOnlyCaseResult
  gatewayAudit: { received: number; forwarded: number; blocked: number; byIntent: Record<string, number> }
  gatewayAuditDigest: string
}

export const RuntimeReadExecutionRecordSchema = z.object({
  attemptId: SafeIdSchema,
  caseId: SafeIdSchema,
  actionId: SafeIdSchema,
  status: ReadOnlyCaseResultSchema.shape.status,
  result: ReadOnlyCaseResultSchema,
  gatewayAudit: GatewayAuditSummarySchema,
  gatewayAuditDigest: DigestSchema,
}).strict().superRefine((record, context) => {
  if (record.caseId !== record.result.caseId || record.actionId !== record.result.actionId
    || record.status !== record.result.status) context.addIssue({
    code: 'custom', message: '只读执行记录与结果绑定不一致',
  })
}).transform((record, context) => {
  try { return JSON.parse(canonicalizeJson(record)) as RuntimeReadExecutionRecord }
  catch (cause) {
    context.addIssue({ code: 'custom', message: '只读执行记录必须是 canonical JSON' })
    return z.NEVER
  }
})

export function parseRuntimeReadExecutionRecord(value: unknown): RuntimeReadExecutionRecord {
  const parsed = RuntimeReadExecutionRecordSchema.safeParse(value)
  if (!parsed.success) throw new E2EError({
    code: 'E2E_RUNTIME_READ_RESULT_INVALID', category: 'artifact',
    message: '持久化只读执行结果不合法', retryable: false, cause: parsed.error,
  })
  return parsed.data as RuntimeReadExecutionRecord
}
