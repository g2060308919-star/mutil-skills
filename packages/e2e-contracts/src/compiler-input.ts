import { z } from 'zod'
import { AssetIdSchema, canonicalizeJson, digestText } from './common.js'
import { RegressionBlockedCasesSchema } from './regression-discovery.js'
import { ApprovalFreshnessReceiptSchema } from './approval-freshness.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const NonEmptyTextSchema = z.string().min(1).max(16 * 1024)

export const AssertTextCompilerActionSchema = z.object({
  kind: z.literal('assertText'),
  actionId: SafeIdSchema,
  target: NonEmptyTextSchema,
  expected: NonEmptyTextSchema,
}).strict()

export const ReversibleWriteCompilerActionSchema = z.object({
  kind: z.literal('reversibleWrite'),
  actionId: SafeIdSchema,
  buttonName: NonEmptyTextSchema,
  beforeText: NonEmptyTextSchema,
  afterText: NonEmptyTextSchema,
  dataLeaseId: SafeIdSchema,
  cleanupPlanId: SafeIdSchema,
}).strict()

export const CompilerActionSchema = z.discriminatedUnion('kind', [
  AssertTextCompilerActionSchema,
  ReversibleWriteCompilerActionSchema,
])

export const DeclarativeExecutableCaseSchema = z.object({
  caseId: SafeIdSchema,
  title: NonEmptyTextSchema,
  reqIds: z.array(SafeIdSchema).min(1).max(10_000),
  ruleIds: z.array(SafeIdSchema).min(1).max(10_000),
  obligationIds: z.array(SafeIdSchema).min(1).max(10_000),
  mode: z.enum(['real-environment', 'fault-injection']),
  actions: z.array(CompilerActionSchema).min(1).max(10_000),
}).strict().superRefine((testCase, context) => {
  for (const key of ['reqIds', 'ruleIds', 'obligationIds'] as const) {
    if (!isUnique(testCase[key])) {
      context.addIssue({ code: 'custom', message: `${key} 不得重复`, path: [key] })
    }
    if (!isSorted(testCase[key])) {
      context.addIssue({ code: 'custom', message: `${key} 必须按稳定 ID 排序`, path: [key] })
    }
  }
  const actionIds = testCase.actions.map((action) => action.actionId)
  if (!isUnique(actionIds)) {
    context.addIssue({ code: 'custom', message: '同一 Case 的 actionId 不得重复', path: ['actions'] })
  }
})

export const CompilerInputV1Schema = z.object({
  schemaVersion: z.literal('compiler-input/v1'),
  assetId: AssetIdSchema,
  generationId: SafeIdSchema,
  runId: SafeIdSchema,
  prdRevision: DigestSchema,
  scopeDigest: DigestSchema,
  lineageDecisionDigest: DigestSchema,
  contractsVersion: SemverSchema,
  environmentId: SafeIdSchema,
  baseOrigin: z.string().url(),
  approvalDigest: DigestSchema,
  approvalFreshnessReceipt: ApprovalFreshnessReceiptSchema,
  policyDigest: DigestSchema,
  playwrightVersion: SemverSchema,
  cases: z.array(DeclarativeExecutableCaseSchema).min(1).max(100_000),
  blockedCases: RegressionBlockedCasesSchema,
}).strict().superRefine((input, context) => {
  const caseIds = input.cases.map((testCase) => testCase.caseId)
  if (!isUnique(caseIds)) {
    context.addIssue({ code: 'custom', message: '可执行 caseId 不得重复', path: ['cases'] })
  }
  if (!isSorted(caseIds)) {
    context.addIssue({ code: 'custom', message: '可执行 Case 必须按 caseId 排序', path: ['cases'] })
  }
  const executableIds = new Set(caseIds)
  if (input.blockedCases.some((blocked) => executableIds.has(blocked.caseId))) {
    context.addIssue({ code: 'custom', message: '可执行 Case 与 blocked Case 必须互斥', path: ['blockedCases'] })
  }
  const actionKinds = new Set(input.cases.flatMap((testCase) =>
    testCase.actions.map((action) => action.kind)))
  if (actionKinds.size > 1) {
    context.addIssue({ code: 'custom', message: '同一密封项目不得混合只读与可逆写模板', path: ['cases'] })
  }
})

export type CompilerAction = z.infer<typeof CompilerActionSchema>
export type AssertTextCompilerAction = z.infer<typeof AssertTextCompilerActionSchema>
export type ReversibleWriteCompilerAction = z.infer<typeof ReversibleWriteCompilerActionSchema>
export type DeclarativeExecutableCase = z.infer<typeof DeclarativeExecutableCaseSchema>
export type CompilerInputV1 = z.infer<typeof CompilerInputV1Schema>

export function computeCompilerInputDigest(input: CompilerInputV1): string {
  const parsed = CompilerInputV1Schema.parse(input)
  return digestText('regression-compiler-input/v2', canonicalizeJson(parsed))
}

function isUnique(values: string[]): boolean {
  return new Set(values).size === values.length
}

function isSorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value)
}
