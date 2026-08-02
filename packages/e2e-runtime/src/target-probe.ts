import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import { TargetContractFactSchema, type TargetContractFact } from './target-contract.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

const TargetProbeBackendOutputSchema = z.object({
  status: z.enum(['ready', 'environment-blocked', 'page-identity-mismatch']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
  observedUrl: z.string().url(),
  observedTitle: z.string().max(4_096),
  identityMatched: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.status === 'ready') !== value.identityMatched) context.addIssue({
    code: 'custom', path: ['identityMatched'], message: 'ready 必须与页面身份命中闭合',
  })
  if (value.status !== 'ready' && value.reasonCode === undefined) context.addIssue({
    code: 'custom', path: ['reasonCode'], message: '阻断诊断必须有 reasonCode',
  })
})

export const TargetProbeFactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  trust: z.literal('untrusted-diagnostic'),
  runId: SafeIdSchema,
  targetContractDigest: DigestSchema,
  status: z.enum(['ready', 'environment-blocked', 'page-identity-mismatch']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
  observedUrl: z.string().url(),
  observedTitle: z.string().max(4_096),
  identityMatched: z.boolean(),
  probedAt: z.string().datetime(),
  diagnosticDigest: DigestSchema,
}).strict()

export type TargetProbeFact = z.infer<typeof TargetProbeFactSchema>
type TargetProbeBackendOutput = z.infer<typeof TargetProbeBackendOutputSchema>
type TargetProbeBackend = (input: {
  runId: string
  contract: TargetContractFact['contract']
}) => Promise<TargetProbeBackendOutput>

declare const targetProbeCapabilityBrand: unique symbol
export interface TargetProbeCapability { readonly [targetProbeCapabilityBrand]: true }
const capabilities = new WeakMap<object, TargetProbeBackend>()

export function authorizeTargetProbe(backend: TargetProbeBackend): TargetProbeCapability {
  const capability = Object.freeze({}) as TargetProbeCapability
  capabilities.set(capability, backend)
  return capability
}

export async function runTargetProbe(
  capability: TargetProbeCapability,
  input: { runId: string; target: TargetContractFact; probedAt: string },
): Promise<TargetProbeFact> {
  const backend = capabilities.get(capability)
  if (backend === undefined) throw probeError('E2E_TARGET_PROBE_CAPABILITY_INVALID')
  const target = TargetContractFactSchema.parse(input.target)
  const output = TargetProbeBackendOutputSchema.parse(await backend({
    runId: input.runId, contract: target.contract,
  }))
  const observedOrigin = new URL(output.observedUrl).origin
  if (!target.contract.allowedNavigationOrigins.includes(observedOrigin)) {
    throw probeError('E2E_TARGET_PROBE_ORIGIN_MISMATCH')
  }
  const material = {
    schemaVersion: '1.0.0' as const,
    trust: 'untrusted-diagnostic' as const,
    runId: input.runId,
    targetContractDigest: target.contractDigest,
    ...output,
    probedAt: input.probedAt,
  }
  return TargetProbeFactSchema.parse({
    ...material,
    diagnosticDigest: digestText('e2e-target-probe-diagnostic/v1', canonicalizeJson(material)),
  })
}

function probeError(code: string): E2EError {
  return new E2EError({ code, category: 'safety', message: code, retryable: false })
}
