import { z } from 'zod'
import { canonicalizeJson, digestText } from './common.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
const BrowserVersionSchema = z.string().regex(/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/)

export const SupportedHostCapabilitySchema = z.object({
  status: z.enum(['executed', 'unsupported', 'failed', 'not-executed']),
  reasonCode: z.string().min(1).max(256),
  proofDigest: DigestSchema,
}).strict()

const SupportedHostProofBodySchema = z.object({
  schemaVersion: z.literal('supported-host-proof/v1'),
  host: z.object({ platform: z.string().min(1), arch: z.string().min(1), nodeVersion: SemverSchema }).strict(),
  chrome: z.object({
    channel: z.enum(['chrome', 'chromium']).nullable(), version: BrowserVersionSchema.nullable(),
    source: z.enum(['system-chrome', 'managed-chromium']).nullable(), executableDigest: DigestSchema.nullable(),
    capability: SupportedHostCapabilitySchema,
  }).strict(),
  capabilities: z.object({
    sandbox: SupportedHostCapabilitySchema,
    loopback: SupportedHostCapabilitySchema,
    process: SupportedHostCapabilitySchema,
    filesystem: SupportedHostCapabilitySchema,
    profileIsolation: SupportedHostCapabilitySchema,
    gatewayCanary: SupportedHostCapabilitySchema,
  }).strict(),
  executionEntry: z.object({
    kind: z.literal('public-full-journey'), status: z.enum(['executed', 'failed', 'not-executed']),
    proofDigest: DigestSchema,
  }).strict(),
  conclusion: z.object({
    status: z.enum(['supported', 'unverified', 'unsupported']), gateEligible: z.boolean(),
    reasonCodes: z.array(z.string().min(1).max(256)),
  }).strict(),
}).strict()

export type SupportedHostProofBodyV1 = z.infer<typeof SupportedHostProofBodySchema>

export function computeSupportedHostProofDigest(body: SupportedHostProofBodyV1): string {
  return digestText('supported-host-proof/v1', canonicalizeJson(body))
}

export const SupportedHostProofV1Schema = SupportedHostProofBodySchema.extend({
  proofDigest: DigestSchema,
}).strict().superRefine((proof, context) => {
  const { proofDigest, ...body } = proof
  if (proofDigest !== computeSupportedHostProofDigest(body)) context.addIssue({
    code: 'custom', path: ['proofDigest'], message: 'Supported Host proofDigest 未绑定全部宿主事实',
  })
  const statuses = [proof.chrome.capability, ...Object.values(proof.capabilities)]
  const eligible = statuses.every((item) => item.status === 'executed')
    && proof.chrome.channel !== null && proof.chrome.version !== null
    && proof.chrome.source !== null && proof.chrome.executableDigest !== null
    && proof.executionEntry.status === 'executed'
  if (proof.conclusion.gateEligible !== eligible
    || (eligible && proof.conclusion.status !== 'supported')
    || (!eligible && proof.conclusion.status === 'supported')) context.addIssue({
    code: 'custom', path: ['conclusion'], message: '支持结论必须由全部实际执行的宿主能力证明驱动',
  })
})

export type SupportedHostProofV1 = z.infer<typeof SupportedHostProofV1Schema>
