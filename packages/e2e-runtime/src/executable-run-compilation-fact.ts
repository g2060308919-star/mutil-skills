import { canonicalizeJson, digestText } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

const ExecutableRunCompilationFactDraftSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  compilerDigest: DigestSchema,
  projectionDigest: DigestSchema,
  planCompilerDigest: DigestSchema,
  targetProbeDigest: DigestSchema,
  bindingDigest: DigestSchema,
  artifactDigests: z.object({
    'test-cases': DigestSchema,
    'browser-action-map': DigestSchema,
    'execution-contract': DigestSchema,
  }).strict(),
  executableCaseIds: z.array(z.string().regex(/^CASE-[A-Za-z0-9._:-]+$/)).min(1).max(10_000),
}).strict()

export const ExecutableRunCompilationFactSchema = ExecutableRunCompilationFactDraftSchema.extend({
  factDigest: DigestSchema,
}).strict().superRefine((fact, context) => {
  const { factDigest: _factDigest, ...draft } = fact
  if (factDigest(draft) !== fact.factDigest) context.addIssue({
    code: 'custom', path: ['factDigest'], message: '可执行编译事实摘要不闭合',
  })
})

export type ExecutableRunCompilationFact = z.infer<typeof ExecutableRunCompilationFactSchema>

export function createExecutableRunCompilationFact(
  input: Omit<z.input<typeof ExecutableRunCompilationFactDraftSchema>, 'schemaVersion'>,
): ExecutableRunCompilationFact {
  const draft = ExecutableRunCompilationFactDraftSchema.parse({ schemaVersion: '1.0.0', ...input })
  return ExecutableRunCompilationFactSchema.parse({ ...draft, factDigest: factDigest(draft) })
}

function factDigest(value: z.infer<typeof ExecutableRunCompilationFactDraftSchema>): string {
  return digestText('e2e-executable-run-compilation-fact/v1', canonicalizeJson(value))
}
