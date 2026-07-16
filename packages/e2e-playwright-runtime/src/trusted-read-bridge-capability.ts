import type { ControlledReadBridgeSnapshot, ControlledReadExecution } from './controlled-read-bridge.js'
import type { TrustedCompilerRunSession } from './trusted-compiler-execution.js'

export interface TrustedCompilerControlledReadBridgeHandle {
  close(): Promise<void>
  snapshot(): ControlledReadBridgeSnapshot
  executions(): ControlledReadExecution[]
}

export interface TrustedCompilerReadBridgeBinding {
  session: TrustedCompilerRunSession
  endpoint: string
  runGate: string
}

const bindings = new WeakMap<object, TrustedCompilerReadBridgeBinding>()

export function registerTrustedCompilerControlledReadBridge(
  handle: TrustedCompilerControlledReadBridgeHandle,
  binding: TrustedCompilerReadBridgeBinding,
): void {
  bindings.set(handle as object, binding)
}

export function getTrustedCompilerControlledReadBridgeBinding(
  value: unknown,
): TrustedCompilerReadBridgeBinding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const binding = bindings.get(value)
  return binding ? { ...binding, session: binding.session } : undefined
}
