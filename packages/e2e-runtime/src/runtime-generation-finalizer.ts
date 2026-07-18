import { E2EError, type FinalVerdict } from '@mutil-skills/e2e-contracts'
import type { RuntimeRunSnapshot } from './run-store.js'

declare const runtimeGenerationFinalizationCapabilityBrand: unique symbol

export interface RuntimeGenerationFinalizationCapability {
  readonly [runtimeGenerationFinalizationCapabilityBrand]: true
}

export interface RuntimeGenerationFinalizationResult {
  generationId: string
  generationDigest: string
  terminalVerdict: FinalVerdict
  activeReadbackDigest: string
  quarantineDispositionDigest: string
}

export interface RuntimeGenerationFinalizationInput {
  projectRoot: string
  snapshot: RuntimeRunSnapshot
  attemptId: string
  requestDigest: string
  recovery: boolean
}

type FinalizeOperation = (
  input: RuntimeGenerationFinalizationInput,
) => Promise<RuntimeGenerationFinalizationResult>

const capabilities = new WeakMap<object, FinalizeOperation>()

export function authorizeRuntimeGenerationFinalizer(
  operation: FinalizeOperation,
): RuntimeGenerationFinalizationCapability {
  const capability = Object.freeze({}) as RuntimeGenerationFinalizationCapability
  capabilities.set(capability, operation)
  return capability
}

export async function executeRuntimeGenerationFinalization(
  capability: RuntimeGenerationFinalizationCapability,
  input: RuntimeGenerationFinalizationInput,
): Promise<RuntimeGenerationFinalizationResult> {
  const operation = capabilities.get(capability)
  if (operation === undefined) throw finalizerError('E2E_RUNTIME_FINALIZER_CAPABILITY_UNTRUSTED')
  const result = await operation({ ...input, snapshot: structuredClone(input.snapshot) })
  if (result.generationId !== input.snapshot.runId
    || !digest(result.generationDigest)
    || !digest(result.activeReadbackDigest)
    || !digest(result.quarantineDispositionDigest)
    || !['accepted', 'rejected', 'incomplete', 'input-blocked', 'environment-blocked',
      'safety-blocked', 'automation-blocked'].includes(result.terminalVerdict)) {
    throw finalizerError('E2E_RUNTIME_FINALIZATION_RESULT_INVALID')
  }
  return structuredClone(result)
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function finalizerError(code: string): E2EError {
  return new E2EError({ code, category: 'artifact', message: code, retryable: false })
}
