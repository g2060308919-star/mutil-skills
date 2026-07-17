import {
  SignedGrantSchema,
  canonicalizeJson,
  digestText,
  E2EError,
  type SignedDiscoveryGrant,
} from '@mutil-skills/e2e-contracts'
import { z } from 'zod'
import type { RuntimeRunSnapshot } from './run-store.js'

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const BrowserPreflightFactSchema = z.object({
  runId: SafeIdSchema,
  discoveryGrantId: SafeIdSchema,
  reservationId: SafeIdSchema,
  preflightDigest: DigestSchema,
  status: z.literal('ready'),
  observedIdentityDigest: DigestSchema,
  browserMeasurementDigest: DigestSchema,
  browserClosureDigest: DigestSchema,
  browserExecutableDigest: DigestSchema,
  gatewaySessionMeasurementDigest: DigestSchema,
  gatewayPolicyDigest: DigestSchema,
  gatewayAuditDigest: DigestSchema,
  canaryProofDigest: DigestSchema,
  authorityOutcomeDigest: DigestSchema,
  authorityReceiptDigest: DigestSchema,
}).strict()

export type BrowserPreflightFact = z.infer<typeof BrowserPreflightFactSchema>

export interface RuntimePreflightBackendOutput {
  status: 'ready' | 'input-blocked' | 'environment-blocked' | 'safety-blocked'
  reasonCode?: string
  reservationId?: string
  preflightDigest?: string
  observedIdentity?: { url: string; title: string; headings: string[]; role?: string; ariaSignals?: string[] }
  browserMeasurement?: {
    browserMeasurementDigest: string
    browserClosureDigest: string
    browserExecutableDigest: string
    gatewaySessionMeasurementDigest: string
    canaryProofDigest: string
  }
  gatewayPolicyDigest?: string
  gatewayAuditDigest?: string
  authorityOutcomeDigest?: string
  authorityReceiptDigest?: string
}

const ObservedIdentitySchema = z.object({
  url: z.string(), title: z.string(), headings: z.array(z.string()),
  role: z.string().optional(), ariaSignals: z.array(z.string()).optional(),
}).strict()
const BrowserMeasurementSchema = z.object({
  browserMeasurementDigest: DigestSchema, browserClosureDigest: DigestSchema,
  browserExecutableDigest: DigestSchema, gatewaySessionMeasurementDigest: DigestSchema,
  canaryProofDigest: DigestSchema,
}).strict()
const RuntimePreflightOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'), reservationId: SafeIdSchema, preflightDigest: DigestSchema,
    observedIdentity: ObservedIdentitySchema, browserMeasurement: BrowserMeasurementSchema,
    gatewayPolicyDigest: DigestSchema, authorityOutcomeDigest: DigestSchema,
    authorityReceiptDigest: DigestSchema, gatewayAuditDigest: DigestSchema,
  }).strict(),
  z.object({
    status: z.enum(['input-blocked', 'environment-blocked', 'safety-blocked']),
    reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
    reservationId: SafeIdSchema.optional(), preflightDigest: DigestSchema.optional(),
    observedIdentity: ObservedIdentitySchema.optional(),
  }).strict(),
])

export const RuntimePreflightPreparationSchema = z.object({
  capabilityId: SafeIdSchema,
  output: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ready'), reservationId: SafeIdSchema,
      observedIdentity: ObservedIdentitySchema, browserMeasurement: BrowserMeasurementSchema,
      gatewayPolicyDigest: DigestSchema, gatewayAuditDigest: DigestSchema,
    }).strict(),
    z.object({
      status: z.enum(['input-blocked', 'environment-blocked', 'safety-blocked']),
      reasonCode: z.string().regex(/^E2E_[A-Z0-9_]+$/),
      reservationId: SafeIdSchema.optional(), observedIdentity: ObservedIdentitySchema.optional(),
    }).strict(),
  ]),
}).strict()

export type RuntimePreflightPreparation = z.infer<typeof RuntimePreflightPreparationSchema>

type RuntimePreflightBackend = (input: {
  snapshot: RuntimeRunSnapshot
  grant: SignedDiscoveryGrant
  attemptId: string
}) => Promise<RuntimePreflightBackendOutput>

interface StagedRuntimePreflightBackend {
  prepare(input: {
    snapshot: RuntimeRunSnapshot
    grant: SignedDiscoveryGrant
    attemptId: string
  }): Promise<RuntimePreflightPreparation>
  finalize(input: {
    snapshot: RuntimeRunSnapshot
    grant: SignedDiscoveryGrant
    preparation: RuntimePreflightPreparation
  }): Promise<RuntimePreflightBackendOutput>
}

declare const runtimePreflightCapabilityBrand: unique symbol
export interface RuntimePreflightCapability {
  readonly [runtimePreflightCapabilityBrand]: true
}

const runtimePreflightCapabilities = new WeakMap<object, RuntimePreflightBackend | StagedRuntimePreflightBackend>()

/** 仅供 Runtime 内部生产装配层签发；Host 不能接受裸 callback 或 caller fact。 */
export function authorizeRuntimePreflight(
  backend: RuntimePreflightBackend | StagedRuntimePreflightBackend,
): RuntimePreflightCapability {
  const capability = Object.freeze({}) as RuntimePreflightCapability
  runtimePreflightCapabilities.set(capability, backend)
  return capability
}

export async function prepareRuntimePreflight(
  capability: RuntimePreflightCapability,
  snapshot: RuntimeRunSnapshot,
  attemptId: string,
): Promise<
  | { kind: 'completed'; result: { output: RuntimePreflightBackendOutput; fact?: BrowserPreflightFact } }
  | { kind: 'prepared'; preparation: RuntimePreflightPreparation }
> {
  const backend = runtimePreflightCapabilities.get(capability)
  if (!backend) throw preflightError('E2E_RUNTIME_PREFLIGHT_CAPABILITY_INVALID')
  if (!SafeIdSchema.safeParse(attemptId).success) {
    throw preflightError('E2E_RUNTIME_PREFLIGHT_ATTEMPT_ID_INVALID')
  }
  const grant = requireDiscoveryGrant(snapshot)
  if (typeof backend === 'function') {
    const output = parsePreflightOutput(await backend({
      snapshot: structuredClone(snapshot), grant, attemptId,
    }))
    return { kind: 'completed', result: buildPreflightResult(snapshot, grant, output) }
  }
  const parsed = RuntimePreflightPreparationSchema.safeParse(await backend.prepare({
    snapshot: structuredClone(snapshot), grant, attemptId,
  }))
  if (!parsed.success) throw preflightError('E2E_RUNTIME_PREFLIGHT_PREPARATION_INVALID', parsed.error)
  return { kind: 'prepared', preparation: structuredClone(parsed.data) }
}

export async function finalizeRuntimePreflight(
  capability: RuntimePreflightCapability,
  snapshot: RuntimeRunSnapshot,
  preparation: RuntimePreflightPreparation,
): Promise<{ output: RuntimePreflightBackendOutput; fact?: BrowserPreflightFact }> {
  const backend = runtimePreflightCapabilities.get(capability)
  if (!backend || typeof backend === 'function') {
    throw preflightError('E2E_RUNTIME_PREFLIGHT_RECOVERY_UNSUPPORTED')
  }
  const grant = requireDiscoveryGrant(snapshot)
  const parsedPreparation = RuntimePreflightPreparationSchema.safeParse(preparation)
  if (!parsedPreparation.success) throw preflightError(
    'E2E_RUNTIME_PREFLIGHT_PREPARATION_INVALID', parsedPreparation.error,
  )
  const output = parsePreflightOutput(await backend.finalize({
    snapshot: structuredClone(snapshot), grant,
    preparation: structuredClone(parsedPreparation.data),
  }))
  return buildPreflightResult(snapshot, grant, output)
}

export async function executeRuntimePreflight(
  capability: RuntimePreflightCapability,
  snapshot: RuntimeRunSnapshot,
): Promise<{ output: RuntimePreflightBackendOutput; fact?: BrowserPreflightFact }> {
  const prepared = await prepareRuntimePreflight(capability, snapshot, `PREFLIGHT-${snapshot.runId}`)
  if (prepared.kind === 'completed') return prepared.result
  return await finalizeRuntimePreflight(capability, snapshot, prepared.preparation)
}

export function runtimePreflightAttemptId(input: {
  runId: string
  requestId: string
  requestDigest: string
}): string {
  return `PREFLIGHT-${digestText('runtime-preflight-attempt/v1', canonicalizeJson(input)).slice('sha256:'.length)}`
}

function requireDiscoveryGrant(snapshot: RuntimeRunSnapshot): SignedDiscoveryGrant {
  const parsedGrant = SignedGrantSchema.safeParse(snapshot.trustedExecutionFacts['signed-discovery-grant'])
  if (!parsedGrant.success || !('expectedPageIdentity' in parsedGrant.data.subject)
    || parsedGrant.data.approvalContext.runId !== snapshot.runId
    || parsedGrant.data.approvalContext.installationDigest !== snapshot.runtimeInstallationDigest) {
    throw preflightError('E2E_RUNTIME_DISCOVERY_GRANT_FACT_REQUIRED')
  }
  return parsedGrant.data as SignedDiscoveryGrant
}

function parsePreflightOutput(rawOutput: unknown): RuntimePreflightBackendOutput {
  const parsedOutput = RuntimePreflightOutputSchema.safeParse(rawOutput)
  if (!parsedOutput.success) throw preflightError(
    'E2E_RUNTIME_PREFLIGHT_OUTPUT_INVALID', parsedOutput.error,
  )
  return parsedOutput.data as RuntimePreflightBackendOutput
}

function buildPreflightResult(
  snapshot: RuntimeRunSnapshot,
  grant: SignedDiscoveryGrant,
  output: RuntimePreflightBackendOutput,
): { output: RuntimePreflightBackendOutput; fact?: BrowserPreflightFact } {
  if (output.status !== 'ready') return { output: structuredClone(output) }
  const observed = ObservedIdentitySchema.safeParse(output.observedIdentity)
  const measurement = BrowserMeasurementSchema.safeParse(output.browserMeasurement)
  const fact = BrowserPreflightFactSchema.safeParse({
    runId: snapshot.runId,
    discoveryGrantId: grant.grantId,
    reservationId: output.reservationId,
    preflightDigest: output.preflightDigest,
    status: output.status,
    observedIdentityDigest: observed.success
      ? digestText('observed-page-identity/v1', canonicalizeJson(observed.data)) : undefined,
    ...(measurement.success ? measurement.data : {}),
    gatewayPolicyDigest: output.gatewayPolicyDigest,
    gatewayAuditDigest: output.gatewayAuditDigest,
    authorityOutcomeDigest: output.authorityOutcomeDigest,
    authorityReceiptDigest: output.authorityReceiptDigest,
  })
  if (!fact.success
    || fact.data.gatewaySessionMeasurementDigest !== measurement.data?.gatewaySessionMeasurementDigest) {
    throw preflightError('E2E_RUNTIME_PREFLIGHT_OUTPUT_INVALID')
  }
  return { output: structuredClone(output), fact: fact.data }
}

function preflightError(code: string, cause?: unknown): E2EError {
  return new E2EError({
    code, category: 'safety', message: `${code}: Runtime browser preflight 未通过可信边界校验`,
    retryable: false, cause,
  })
}
