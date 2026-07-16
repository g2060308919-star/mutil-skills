import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const LoopbackEndpointSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      context.addIssue({ code: 'custom', message: '隔离端点必须是无凭证、无路径的 127.0.0.1 HTTP origin' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: '隔离端点不是有效 URL' })
  }
})

const SortedUniqueDigestsSchema = z.array(DigestSchema).min(1).max(32)
  .refine((values) => new Set(values).size === values.length, '可执行文件摘要必须唯一')
  .refine((values) => values.join('\0') === [...values].sort().join('\0'), '可执行文件摘要必须排序')

const SortedUniqueEndpointsSchema = z.array(LoopbackEndpointSchema).min(1).max(32)
  .refine((values) => new Set(values).size === values.length, '隔离端点必须唯一')
  .refine((values) => values.join('\0') === [...values].sort().join('\0'), '隔离端点必须排序')

export const ProductionIsolationBackendSchema = z.enum([
  'linux-bwrap', 'kubernetes', 'macos-app-sandbox',
])
export type ProductionIsolationBackend = z.infer<typeof ProductionIsolationBackendSchema>

export const RuntimeIsolationPolicySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  sourceDigest: DigestSchema,
  allowedBackends: z.array(ProductionIsolationBackendSchema).min(1).max(3)
    .refine((values) => new Set(values).size === values.length, '隔离后端必须唯一')
    .refine((values) => values.join('\0') === [...values].sort().join('\0'), '隔离后端必须排序'),
  gatewayEndpoint: LoopbackEndpointSchema,
  allowedEndpoints: SortedUniqueEndpointsSchema,
  allowedExecutableDigests: SortedUniqueDigestsSchema,
  limits: z.object({
    cpuTimeMs: z.number().int().positive(),
    memoryBytes: z.number().int().min(64 * 1024 * 1024),
    diskBytes: z.number().int().min(16 * 1024 * 1024),
    wallTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1000),
  }).strict().refine((limits) => limits.cpuTimeMs <= limits.wallTimeMs,
    'CPU 时间上限不得超过 wall time 上限'),
  authorityRpcPublicKeyDigest: DigestSchema,
  isolationAuthorityPublicKeyDigest: DigestSchema,
}).strict().refine((policy) => policy.allowedEndpoints.includes(policy.gatewayEndpoint), {
  path: ['allowedEndpoints'], message: '允许端点必须包含 Gateway 端点',
})

export type RuntimeIsolationPolicy = z.infer<typeof RuntimeIsolationPolicySchema>

export function digestRuntimeIsolationPolicy(candidate: unknown): string {
  const policy = RuntimeIsolationPolicySchema.parse(candidate)
  return digestText('runtime-isolation-policy/v1', canonicalizeJson(policy))
}
