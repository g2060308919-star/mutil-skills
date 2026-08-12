import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const TextSchema = z.string().min(1).max(64 * 1024)

const BenchmarkProofBodySchema = z.object({
  schemaVersion: z.literal('e2e-benchmark-proof/v1'),
  proofKind: z.enum(['prd-gold', 'browser-capability', 'real-project', 'full-product-journey']),
  proofId: IdSchema,
  runnerIdentityDigest: DigestSchema,
  corpusDigest: DigestSchema,
  application: z.object({
    applicationId: IdSchema,
    stack: TextSchema,
    sourceRevision: DigestSchema,
    targetOrigin: z.string().url(),
    startupCommandDigest: DigestSchema,
  }).strict(),
  components: z.array(z.object({
    component: z.enum(['browser-product', 'backend', 'database', 'idp', 'external-service']),
    mode: z.enum(['real', 'substituted', 'not-in-scope']),
    claim: z.enum(['verified', 'not-verified', 'not-executed', 'unsupported']),
    reason: TextSchema,
  }).strict()).min(1).max(100),
  scenarios: z.array(z.object({
    scenarioId: IdSchema,
    status: z.enum(['passed', 'failed', 'not-executed', 'unsupported', 'environment-blocked']),
    oracleStatus: z.enum(['passed', 'failed', 'not-observed']),
    evidenceDigests: z.array(DigestSchema).max(10_000),
    attemptIds: z.array(IdSchema).min(1).max(100),
    negativeControlDetected: z.boolean(),
  }).strict()).min(1).max(10_000),
  gate: z.object({
    eligible: z.boolean(),
    passed: z.boolean(),
    reasons: z.array(IdSchema).max(1000),
  }).strict(),
  generatedAt: z.string().datetime(),
}).strict()

export type E2EBenchmarkProofBodyV1 = z.infer<typeof BenchmarkProofBodySchema>
export function computeE2EBenchmarkProofDigest(body: E2EBenchmarkProofBodyV1): string {
  return digestText('e2e-benchmark-proof/v1', canonicalizeJson(body))
}

export const E2EBenchmarkProofV1Schema = BenchmarkProofBodySchema.extend({
  proofDigest: DigestSchema,
}).strict().superRefine((proof, context) => {
  const { proofDigest, ...body } = proof
  if (proofDigest !== computeE2EBenchmarkProofDigest(body)) context.addIssue({
    code: 'custom', path: ['proofDigest'], message: 'Benchmark proof 摘要不匹配',
  })
  const ineligibleComponents = proof.components.filter((item) =>
    item.claim === 'verified' && item.mode !== 'real')
  const scenarioFailures = proof.scenarios.filter((item) => item.status !== 'passed'
    || item.oracleStatus !== 'passed' || !item.negativeControlDetected || item.evidenceDigests.length === 0)
  if (ineligibleComponents.length > 0 && proof.gate.eligible) context.addIssue({
    code: 'custom', path: ['gate', 'eligible'],
    message: '替代组件不得声明 verified 并进入真实 gate',
  })
  if (proof.gate.passed && (!proof.gate.eligible || scenarioFailures.length > 0)) context.addIssue({
    code: 'custom', path: ['gate', 'passed'], message: '只有 eligible 且 Oracle/负缺陷/证据完整时才能通过',
  })
})

export type E2EBenchmarkProofV1 = z.infer<typeof E2EBenchmarkProofV1Schema>
