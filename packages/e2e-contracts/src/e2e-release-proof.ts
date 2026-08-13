import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ReleaseProofBodySchema = z.object({
  schemaVersion: z.literal('e2e-release-proof/v1'),
  mode: z.enum(['pack', 'registry']), revision: z.string().min(7).max(128), worktreeClean: z.boolean(),
  phases: z.array(z.object({
    phase: z.string().min(1), status: z.enum(['passed', 'failed']),
    startedAt: z.string().datetime(), finishedAt: z.string().datetime(), evidenceDigest: DigestSchema,
  }).strict()),
  tarballs: z.array(z.object({
    packageName: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    fileName: z.string().min(1), digest: DigestSchema,
  }).strict()),
  packageClosure: z.array(z.string().min(1)),
  golden: z.object({ workspace: z.enum(['passed', 'failed']),
    registry: z.enum(['passed', 'failed', 'not-applicable']) }).strict(),
  skippedTests: z.number().int().nonnegative(),
  hostProof: z.object({ proofDigest: DigestSchema, gateEligible: z.boolean() }).strict(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  conclusion: z.object({ gateEligible: z.boolean(), reasonCodes: z.array(z.string().min(1)) }).strict(),
}).strict()

export type E2EReleaseProofBodyV1 = z.infer<typeof ReleaseProofBodySchema>

export function computeE2EReleaseProofDigest(body: E2EReleaseProofBodyV1): string {
  return digestText('e2e-release-proof/v1', canonicalizeJson(body))
}

export const E2EReleaseProofV1Schema = ReleaseProofBodySchema.extend({ proofDigest: DigestSchema })
  .strict().superRefine((proof, context) => {
    const { proofDigest, ...body } = proof
    if (proofDigest !== computeE2EReleaseProofDigest(body)) context.addIssue({
      code: 'custom', path: ['proofDigest'], message: 'Release proofDigest 未绑定全部发布事实',
    })
    const eligible = proof.worktreeClean && proof.tarballs.length > 0 && proof.packageClosure.length > 0
      && proof.skippedTests === 0 && proof.hostProof.gateEligible
      && proof.phases.every((phase) => phase.status === 'passed') && proof.golden.workspace === 'passed'
      && (proof.mode === 'pack' || proof.golden.registry === 'passed')
    if (proof.conclusion.gateEligible !== eligible) context.addIssue({
      code: 'custom', path: ['conclusion'], message: '发布结论必须由 clean、零 skip、Host 与 Golden 事实驱动',
    })
  })

export type E2EReleaseProofV1 = z.infer<typeof E2EReleaseProofV1Schema>
