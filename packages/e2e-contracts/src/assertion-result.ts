import { z } from 'zod'
import { canonicalizeJson } from './common.js'
import { digestOracleCheckpointValue } from './compiler-input.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CanonicalJsonSchema = z.string().min(1).max(64 * 1024).refine((value) => {
  try { return canonicalizeJson(JSON.parse(value)) === value } catch { return false }
}, 'Assertion value 必须是规范 JSON')

const AssertionValueV1Schema = z.object({
  canonicalJson: CanonicalJsonSchema,
  digest: DigestSchema,
}).strict().superRefine((value, context) => {
  if (value.digest !== digestOracleCheckpointValue(value.canonicalJson)) context.addIssue({
    code: 'custom', path: ['digest'], message: 'Assertion value digest 不匹配',
  })
})

export const AssertionResultV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  checkpointId: SafeIdSchema,
  oracleId: SafeIdSchema,
  expected: AssertionValueV1Schema,
  actual: AssertionValueV1Schema,
  status: z.enum(['passed', 'failed']),
  evidenceRefs: z.array(SafeIdSchema).min(1).max(10_000)
    .refine((values) => new Set(values).size === values.length, 'Assertion evidenceRef 必须唯一'),
}).strict().superRefine((value, context) => {
  if ((value.expected.digest === value.actual.digest) !== (value.status === 'passed')) context.addIssue({
    code: 'custom', path: ['status'], message: 'Assertion status 与 expected/actual 不一致',
  })
})

export interface OracleCheckpointProjectionSource {
  checkpointId: string
  oracleId: string
  expectedJson: string
  actualJson: string
  expectedDigest: string
  actualDigest: string
  status: 'passed' | 'failed'
  evidenceIds: string[]
}

export function projectAssertionResultV1(
  checkpoint: OracleCheckpointProjectionSource,
): AssertionResultV1 {
  return AssertionResultV1Schema.parse({
    schemaVersion: '1.0.0', checkpointId: checkpoint.checkpointId, oracleId: checkpoint.oracleId,
    expected: { canonicalJson: checkpoint.expectedJson, digest: checkpoint.expectedDigest },
    actual: { canonicalJson: checkpoint.actualJson, digest: checkpoint.actualDigest },
    status: checkpoint.status, evidenceRefs: [...checkpoint.evidenceIds],
  })
}

export type AssertionResultV1 = z.infer<typeof AssertionResultV1Schema>
