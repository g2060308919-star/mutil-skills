import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

export const TrustedCompilerExecutionFactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  // 1.0.0 历史事实缺少此字段，读取时保持兼容；所有新执行事实必须由 Runtime 显式写入。
  executionProfile: z.enum([
    'trusted-read-only', 'trusted-reversible-write', 'production-isolated', 'full-playwright',
  ]).optional(),
  runId: SafeIdSchema,
  compilerInputDigest: DigestSchema,
  sourceSetDigest: DigestSchema,
  approvalDigest: DigestSchema,
  browserExecutableDigest: DigestSchema,
  gatewayProxyEndpointDigest: DigestSchema,
  exitCode: z.number().int().nonnegative(),
  stdoutDigest: DigestSchema,
  stderrDigest: DigestSchema,
  caseResults: z.array(z.object({
    caseId: SafeIdSchema,
    status: z.enum(['passed', 'failed']),
  }).strict()).min(1).max(100_000),
}).strict().superRefine((fact, context) => {
  const ids = fact.caseResults.map((item) => item.caseId)
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    context.addIssue({ code: 'custom', message: '执行事实 caseId 必须唯一并稳定排序', path: ['caseResults'] })
  }
  if ((fact.exitCode === 0) !== fact.caseResults.every((item) => item.status === 'passed')) {
    context.addIssue({ code: 'custom', message: 'exitCode 与 Case 终态不一致', path: ['exitCode'] })
  }
})

export type TrustedCompilerExecutionFact = z.infer<typeof TrustedCompilerExecutionFactSchema>
