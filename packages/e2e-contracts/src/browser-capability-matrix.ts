import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const TextSchema = z.string().min(1).max(64 * 1024)

const EntrySchema = z.object({
  capabilityId: IdSchema,
  status: z.enum(['supported', 'partial', 'unsupported', 'fail-closed', 'unverified-on-real-project']),
  boundary: TextSchema,
  compilerSemantics: TextSchema,
  componentProofDigest: DigestSchema.optional(),
  realProjectProofDigest: DigestSchema.optional(),
  failureClassification: TextSchema,
  timeoutCancellation: TextSchema,
  oracleEvidence: z.array(IdSchema).max(100),
  cleanup: TextSchema,
  retryRecovery: TextSchema,
  verifiedHosts: z.array(TextSchema).max(100),
  verifiedChrome: z.array(TextSchema).max(100),
}).strict().superRefine((entry, context) => {
  if (entry.status === 'supported'
    && (entry.componentProofDigest === undefined || entry.realProjectProofDigest === undefined
      || entry.verifiedHosts.length === 0 || entry.verifiedChrome.length === 0)) context.addIssue({
    code: 'custom', message: 'supported 能力必须绑定组件、真实项目 proof 和已验证环境',
  })
})

const MatrixBodyObjectSchema = z.object({
  schemaVersion: z.literal('browser-capability-matrix/v1'),
  matrixVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  runnerIdentityDigest: DigestSchema,
  entries: z.array(EntrySchema).min(1).max(10_000),
  generatedAt: z.string().datetime(),
}).strict()
const MatrixBodySchema = MatrixBodyObjectSchema.superRefine((matrix, context) => {
  const ids = matrix.entries.map((entry) => entry.capabilityId)
  if (new Set(ids).size !== ids.length) context.addIssue({
    code: 'custom', path: ['entries'], message: 'capabilityId 必须唯一',
  })
})

export type BrowserCapabilityMatrixBodyV1 = z.infer<typeof MatrixBodySchema>
export function computeBrowserCapabilityMatrixDigest(body: BrowserCapabilityMatrixBodyV1): string {
  return digestText('browser-capability-matrix/v1', canonicalizeJson(body))
}
export const BrowserCapabilityMatrixV1Schema = MatrixBodyObjectSchema.extend({ matrixDigest: DigestSchema })
  .strict().superRefine((matrix, context) => {
    const { matrixDigest, ...body } = matrix
    if (matrixDigest !== computeBrowserCapabilityMatrixDigest(body)) context.addIssue({
      code: 'custom', path: ['matrixDigest'], message: 'Capability Matrix 摘要不匹配',
    })
  })

export type BrowserCapabilityMatrixV1 = z.infer<typeof BrowserCapabilityMatrixV1Schema>
