import {
  CleanupPlanDefinitionSchema,
  canonicalizeJson,
  digestCleanupPlanDefinition,
  type CleanupPlanDefinition,
} from '@mutil-skills/e2e-contracts'
import type { ReversibleWriteCaseResult } from './write-runner.js'

export interface CleanupExecutionInput {
  result: ReversibleWriteCaseResult
  outcomeDigest: string
}

export interface CleanupExecutionResult {
  status: 'verified-clean' | 'failed' | 'unknown'
  resultDigest: string
  leaseReceiptDigest: string
}

export type TrustedCleanupExecutor = (
  input: CleanupExecutionInput,
) => Promise<CleanupExecutionResult>

interface RegisteredPlan {
  definition: CleanupPlanDefinition
  digest: string
  execute: TrustedCleanupExecutor
}

export class LocalCleanupPlanRegistry {
  readonly #plans = new Map<string, RegisteredPlan>()

  private constructor() {}

  static create(): LocalCleanupPlanRegistry {
    return new LocalCleanupPlanRegistry()
  }

  register(input: {
    definition: CleanupPlanDefinition
    execute: TrustedCleanupExecutor
  }): { definition: CleanupPlanDefinition; digest: string } {
    const definition = CleanupPlanDefinitionSchema.parse(input.definition)
    if (typeof input.execute !== 'function') throw new Error('E2E_CLEANUP_EXECUTOR_INVALID')
    const digest = digestCleanupPlanDefinition(definition)
    const existing = this.#plans.get(definition.cleanupPlanId)
    if (existing) {
      if (existing.digest !== digest || existing.execute !== input.execute) {
        throw new Error('E2E_CLEANUP_PLAN_IMMUTABLE')
      }
      return { definition: structuredClone(existing.definition), digest: existing.digest }
    }
    this.#plans.set(definition.cleanupPlanId, {
      definition: structuredClone(definition), digest, execute: input.execute,
    })
    return { definition: structuredClone(definition), digest }
  }

  assertBinding(input: {
    cleanupPlanId: string
    cleanupPlanDigest: string
    actionId: string
    leaseId: string
  }): CleanupPlanDefinition {
    const registered = this.#plans.get(input.cleanupPlanId)
    if (!registered
      || registered.digest !== input.cleanupPlanDigest
      || registered.definition.actionId !== input.actionId
      || registered.definition.leaseId !== input.leaseId) {
      throw new Error('E2E_CLEANUP_PLAN_BINDING_MISMATCH')
    }
    return structuredClone(registered.definition)
  }

  async execute(input: {
    cleanupPlanId: string
    cleanupPlanDigest: string
    actionId: string
    leaseId: string
    execution: CleanupExecutionInput
  }): Promise<CleanupExecutionResult> {
    const definition = this.assertBinding(input)
    const registered = this.#plans.get(definition.cleanupPlanId)!
    const result = await registered.execute(input.execution)
    const snapshot = JSON.parse(canonicalizeJson(result)) as CleanupExecutionResult
    if (!['verified-clean', 'failed', 'unknown'].includes(snapshot.status)
      || !/^sha256:[a-f0-9]{64}$/.test(snapshot.resultDigest)
      || !/^sha256:[a-f0-9]{64}$/.test(snapshot.leaseReceiptDigest)
      || Object.keys(snapshot as unknown as Record<string, unknown>).sort().join('\0')
        !== ['leaseReceiptDigest', 'resultDigest', 'status'].join('\0')) {
      throw new Error('E2E_CLEANUP_EXECUTION_RESULT_INVALID')
    }
    return snapshot
  }
}
