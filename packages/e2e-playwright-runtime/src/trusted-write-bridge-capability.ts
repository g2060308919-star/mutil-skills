import type { ExecutionOutcomeVerifierMaterial } from '@mutil-skills/e2e-contracts'
import type { TrustedCompilerRunSession } from './trusted-compiler-execution.js'

export interface TrustedCompilerControlledWriteBridgeHandle { close(): Promise<void> }
export interface TrustedCompilerBridgeBinding {
  session: TrustedCompilerRunSession
  endpoint: string
  runGate: string
  executionOutcomeVerifierMaterial: ExecutionOutcomeVerifierMaterial
}

const bindings = new WeakMap<object, TrustedCompilerBridgeBinding>()

export function registerTrustedCompilerControlledWriteBridge(
  handle: TrustedCompilerControlledWriteBridgeHandle,
  binding: TrustedCompilerBridgeBinding,
): void {
  bindings.set(handle as object, binding)
}

export function getTrustedCompilerControlledWriteBridgeBinding(
  value: unknown,
): TrustedCompilerBridgeBinding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const binding = bindings.get(value)
  return binding ? { ...binding, session: binding.session,
    executionOutcomeVerifierMaterial: structuredClone(binding.executionOutcomeVerifierMaterial) } : undefined
}
