import { canonicalizeJson, digestText, E2EError } from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import { TargetContractFactSchema, type TargetContractFact } from './target-contract.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const BoundedDiagnosticTextSchema = z.string().max(4_096)
const TargetProbeResourceSchema = z.object({
  url: z.string().url(),
  resourceType: z.string().min(1).max(64),
}).strict()
const TargetProbeFailedRequestSchema = TargetProbeResourceSchema.extend({
  method: z.string().min(1).max(16),
  errorText: BoundedDiagnosticTextSchema,
}).strict()

export const TargetProbeStrategySchema = z.enum([
  'resource-closure', 'application-ready', 'dom-identity',
])
export type TargetProbeStrategy = z.infer<typeof TargetProbeStrategySchema>

const emptyDiagnostics = {
  strategy: 'resource-closure' as const,
  attempt: 1,
  domPresent: false,
  visibleTextSummary: '',
  consoleErrors: [] as string[],
  failedRequests: [] as Array<z.infer<typeof TargetProbeFailedRequestSchema>>,
  pendingResources: [] as Array<z.infer<typeof TargetProbeResourceSchema>>,
  persistentConnections: [] as Array<z.infer<typeof TargetProbeResourceSchema>>,
  advisories: [] as string[],
  resourceSummary: {
    observedCount: 0, approvedCount: 0, pendingCount: 0,
    persistentConnectionCount: 0, closureComplete: true,
  },
}

export const TargetProbeDiagnosticsSchema = z.object({
  strategy: TargetProbeStrategySchema.default('resource-closure'),
  attempt: z.number().int().positive().max(100).default(1),
  domPresent: z.boolean(),
  visibleTextSummary: BoundedDiagnosticTextSchema,
  consoleErrors: z.array(BoundedDiagnosticTextSchema).max(20),
  failedRequests: z.array(TargetProbeFailedRequestSchema).max(50),
  pendingResources: z.array(TargetProbeResourceSchema).max(256),
  persistentConnections: z.array(TargetProbeResourceSchema).max(50).default([]),
  advisories: z.array(z.string().regex(/^E2E_[A-Z0-9_]+$/)).max(20).default([]),
  resourceSummary: z.object({
    observedCount: z.number().int().nonnegative(),
    approvedCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    persistentConnectionCount: z.number().int().nonnegative().default(0),
    closureComplete: z.boolean(),
  }).strict(),
}).strict()
export type TargetProbeDiagnostics = z.infer<typeof TargetProbeDiagnosticsSchema>

export function selectTargetProbePolicy(input: {
  previewReadonlyOnly: boolean
  previous?: Pick<TargetProbeFact, 'reasonCode' | 'diagnostics'>
}): { strategy: TargetProbeStrategy; attempt: number } {
  const attempt = Math.min((input.previous?.diagnostics.attempt ?? 0) + 1, 100)
  if (input.previewReadonlyOnly) {
    return { strategy: attempt === 1 ? 'application-ready' : 'dom-identity', attempt }
  }
  if (input.previous !== undefined && [
    'E2E_TARGET_PROBE_RESOURCE_CLOSURE_LIMIT',
    'E2E_TARGET_PROBE_RESOURCE_TIMEOUT',
    'E2E_TARGET_PROBE_EXPECTED_PERSISTENT_CONNECTION',
  ].includes(input.previous.reasonCode ?? '')) {
    return { strategy: attempt === 2 ? 'application-ready' : 'dom-identity', attempt }
  }
  return { strategy: 'resource-closure', attempt }
}

const TargetProbeBackendOutputSchema = z.object({
  status: z.enum(['ready', 'environment-blocked', 'page-identity-mismatch']),
  reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/).optional(),
  observedUrl: z.string().url(),
  observedTitle: z.string().max(4_096),
  identityMatched: z.boolean(),
  diagnostics: TargetProbeDiagnosticsSchema.optional(),
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
  diagnostics: TargetProbeDiagnosticsSchema.default(emptyDiagnostics),
  probedAt: z.string().datetime(),
  diagnosticDigest: DigestSchema,
}).strict()

export type TargetProbeFact = z.infer<typeof TargetProbeFactSchema>
type TargetProbeBackendOutput = z.infer<typeof TargetProbeBackendOutputSchema>
type TargetProbeBackend = (input: {
  runId: string
  contract: TargetContractFact['contract']
  strategy: TargetProbeStrategy
  attempt: number
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
  input: {
    runId: string
    target: TargetContractFact
    probedAt: string
    strategy?: TargetProbeStrategy
    attempt?: number
  },
): Promise<TargetProbeFact> {
  const backend = capabilities.get(capability)
  if (backend === undefined) throw probeError('E2E_TARGET_PROBE_CAPABILITY_INVALID')
  const target = TargetContractFactSchema.parse(input.target)
  const strategy = TargetProbeStrategySchema.parse(input.strategy ?? 'resource-closure')
  const attempt = z.number().int().positive().max(100).parse(input.attempt ?? 1)
  const output = TargetProbeBackendOutputSchema.parse(await backend({
    runId: input.runId, contract: target.contract, strategy, attempt,
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
    diagnostics: TargetProbeDiagnosticsSchema.parse({
      ...emptyDiagnostics,
      ...output.diagnostics,
      strategy,
      attempt,
      resourceSummary: {
        ...emptyDiagnostics.resourceSummary,
        ...output.diagnostics?.resourceSummary,
      },
    }),
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
